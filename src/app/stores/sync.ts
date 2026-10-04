import { useCallback, useEffect } from 'react'
import { create } from 'zustand'

import { useAuthStore, onAuthChanged } from './auth'
import { useDocumentsStore } from './documents'
import { useLanguagesStore } from './languages'
import { useOccurrencesStore } from './occurrences'
import { useWordStatesStore } from './wordStates'
import { createSyncScheduler } from './syncScheduler'
import { onLocalWrite } from '../../lib/storage/localDb'
import { supabase } from '../../lib/supabase/client'
import { SyncUnavailable, pushOccurrences, readLocal, syncOnce } from '../../lib/sync/sync'

export type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'

/**
 * 연속해서 여러 번 바꿔도 서버에는 한 번만 보낸다.
 *
 * 단어를 하나 표시할 때마다 왕복하면 느리고 服务器를 많이 먹는다. 사람은 1초 안에
 * 서너 개를 표시하는데, 그 사이에 보낼 필요가 없다.
 */
const SYNC_DEBOUNCE_MS = 1_200

/** 아무리 자주 눌러도 이만큼 지나면 한 번은 보낸다 — 미루기만 하다가 끝내지 않게 */
const SYNC_MAX_WAIT_MS = 10_000

type SyncState = {
  status: SyncStatus
  lastSyncedAt: string | null
  error: string | null
  /** 사람이 누르는 즉시 돌린다 */
  syncNow: () => Promise<void>
  /** 로그인·앱 시작·온라인 복귀 때 조용히 돌린다 (실패해도 조용히) */
  syncQuietly: () => Promise<void>
  /**
   * 이 기기에 저장된 것이 서버보다 앞서 있는지.
   *
   * 진도를 잃어버린 이유를 그대로 나타낸다 — 저장은 끝났는데 아무도 서버에
   * 알리지 않았다. 창을 X 로 닫으면 다시 열 때까지 그 상태가 유지된다.
   */
  dirty: boolean
  /** 저장은 끝났지만 아직 서버에 반영되지 않은 changes 수 — 화면에 보여줄 수 있게 */
  pendingWrites: number
}

/**
 * 계정 동기화 상태.
 *
 * 로그인하지 않은 상태는 'local' 다 — 오류가 아니라 정상이다.
 * 계정은 학습을 기기 사이에서 이어가는 수단일 뿐, 앱을 쓰는 데 필수가 아니다.
 */
export const useSyncStore = create<SyncState>((set) => ({
  status: 'local',
  lastSyncedAt: null,
  error: null,
  dirty: false,
  pendingWrites: 0,

  syncNow: async () => {
    if (!useAuthStore.getState().user) return
    await run(set)
  },

  syncQuietly: async () => {
    if (!useAuthStore.getState().user) return
    try {
      await run(set)
    } catch {
      // 조용히 돌리는 경로에서는 실패해도 사용자를 막지 않는다.
      // 다시 켜졌을 때 온라인 복귀 훅이 재시도한다.
    }
  },
}))

type Setter = (partial: Partial<SyncState>) => void

async function run(set: Setter) {
  const user = useAuthStore.getState().user
  if (!user) return

  set({ status: 'syncing', error: null })

  try {
    const languages = useLanguagesStore.getState().enrolled
    await syncOnce({ userId: user.id, languages })

    // 받은 내용을 화면 스토어에 불어넣는다 — 안 하면 기록은 있어도 안 보인다
    const documents = useDocumentsStore.getState()
    await documents.load()

    const wordStates = useWordStatesStore.getState()
    await Promise.all(languages.map((code) => wordStates.loadLanguage(code)))

    const occurrences = useOccurrencesStore.getState()
    await Promise.all(languages.map((code) => occurrences.loadLanguage(code)))

    // 기록이 없는/옛 기록인 문서의 재계산은 App 이 문서 목록에 반응해 맡는다.
    // 여기서 다시 부르면 같은 계산을 두 번 한다.

    // 등장 기록은 문서를 열 때 다시 쓰인다 — 지금 있는 것만 서버로 보낸다
    const local = await readLocal()
    await pushOccurrences(user.id, local.occurrences)

    set({
      status: 'synced',
      lastSyncedAt: new Date().toISOString(),
      error: null,
      // 다 밀었다 — 이제 서버와 같다
      dirty: false,
      pendingWrites: 0,
    })
  } catch (error) {
    // Supabase 미설정은 설정 안내가 따로 있으므로 여기서 다루지 않는다
    if (error instanceof SyncUnavailable) {
      set({ status: 'local', error: null })
      return
    }
    set({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 앱이 시작할 때 한 번만 붙인다.
 *
 * 로그인·로그아웃, 네트워크 복귀에 맞춰 자동으로 돌린다. 앱을 열었다 닫았다
 * 반복할 때마다 서버와 이 기기가 맞아야 하므로, 트리거를 빠뜨리면 조용히
 * 어긋난 채로 남는다.
 */
export function useCloudSync() {
  const user = useAuthStore((s) => s.user)
  const restore = useAuthStore((s) => s.restore)
  const syncQuietly = useSyncStore((s) => s.syncQuietly)

  useEffect(() => {
    void restore()
  }, [restore])

  /**
   * 무언가를 바꿨으면 곧바로 서버로 보낸다.
   *
   * 예전에는 로그인·앱 시작·온라인 복귀에만 돌았다. 그래서 진도는 이 기기의
   * IndexedDB 에만 남았다 — 창을 X 로 닫으면 서버는 마지막으로 열었을 때 상태를
   * 알고 있었다. 새로고침해야 '제대로 반영된' 것처럼 보였던 이유가 이것이다.
   */
  useEffect(() => {
    if (!user) return

    const scheduler = createSyncScheduler({
      flush: syncQuietly,
      debounceMs: SYNC_DEBOUNCE_MS,
      maxWaitMs: SYNC_MAX_WAIT_MS,
    })

    const unsubscribe = onLocalWrite(() => {
      // 저장은 끝났는데 서버는 아직 모른다 — 이 순간이 바로 '진도가 사라진' 상태다
      useSyncStore.setState((s) => ({ dirty: true, pendingWrites: s.pendingWrites + 1 }))
      scheduler.notify()
    })

    const syncDirty = () => {
      if (!scheduler.pending) return
      scheduler.flushNow()
    }

    // 창을 닫을 때는 미뤄 둔 시간을 기다리지 않는다 — 지금 보낸다.
    // pagehide 는 beforeunload 보다 믿을 만하다: bfcache 로 들어갈 때도 불리고,
    // 휴대전화에서 X 를 눌러도 난다.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') syncDirty()
    }

    window.addEventListener('pagehide', syncDirty)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      unsubscribe()
      window.removeEventListener('pagehide', syncDirty)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      scheduler.dispose()
    }
  }, [user, syncQuietly])

  useEffect(() => onAuthChanged(() => {
    // 로그인·로그아웃 어느 쪽이든 곧바로 반영한다
    void syncQuietly()
  }), [syncQuietly])

  useEffect(() => {
    if (!user) return
    void syncQuietly()
  }, [user, syncQuietly])

  useEffect(() => {
    if (!user) return
    const online = () => void syncQuietly()
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [user, syncQuietly])
}

/** 로그인 화면·설정에서 쓰는 편의 훅 */
export function useSyncNow(): () => void {
  const syncNow = useSyncStore((s) => s.syncNow)
  return useCallback(() => void syncNow(), [syncNow])
}

export const isSyncConfigured = supabase !== null
