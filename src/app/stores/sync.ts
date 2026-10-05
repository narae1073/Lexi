import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'

import { useAuthStore } from './auth'
import { useDocumentsStore } from './documents'
import { useLanguagesStore } from './languages'
import { useOccurrencesStore } from './occurrences'
import { useWordStatesStore } from './wordStates'
import { createSyncScheduler } from './syncScheduler'
import { markSynced, statusKind, NOTICE_MS, type StatusKind, type SyncNotice } from './syncVisibility'
import { onLocalWrite } from '../../lib/storage/localDb'
import { STORES } from '../../lib/storage/localDb'
import { supabase } from '../../lib/supabase/client'
import type { LanguageCode } from '../../types'
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

export type SyncState = {
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
  /**
   * 저장은 끝났지만 아직 서버에 반영되지 않은 변화 — 저장소별 개수.
   *
   * 개수로 두는 이유: 보내는 중에 새로 쌓인 것과, 이번에 보낸 것을 구분해야 한다.
   * 성공했을 때 '보낸 것'만큼만 빼야 남은 것이 정확히 남는다.
   */
  pendingByStore: Record<string, number>
  /**
   * 말할 시간. 자동 동기화는 조용히 하되, 사람이 한 행동의 결과는 잠깐 알려 준다.
   *
   * 단어 상태를 바꾸거나 '지금 동기화' 를 눌렀을 때만 생기고, 저장이 끝나면 곧 조용해진다.
   */
  notice: SyncNotice | null
}

/** 합쳐진 밀린 개수 */
export function pendingCount(byStore: Record<string, number>): number {
  return Object.values(byStore).reduce((sum, n) => sum + n, 0)
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
  pendingByStore: {},
  notice: null,

  syncNow: async () => {
    if (!useAuthStore.getState().user) return
    // 사람이 누른 것이다 — 결과를 알려야 한다
    useSyncStore.setState({ notice: { until: Date.now() + NOTICE_MS, synced: false } })
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

type Setter = (partial: Partial<SyncState> | ((s: SyncState) => Partial<SyncState>)) => void

async function run(set: Setter) {
  const user = useAuthStore.getState().user
  if (!user) return

  // 이번에 보낼 것을 기억해 둔다 — 실패하면 되돌려야 하고, 성공하면 뺀 것만
  // 빼야 보내는 중에 쌓인 것이 '밀린 것' 으로 남는다
  const batch = { ...useSyncStore.getState().pendingByStore }

  set({ status: 'syncing', error: null })

  try {
    const languages = useLanguagesStore.getState().enrolled
    const report = await syncOnce({ userId: user.id, languages })

    /**
     * 계정의 언어를 그대로 채택한다.
     *
     * 배운 언어는 계정에 묶여 있다 — 폰에서 프랑스어를 추가하고 노트북에서 보면 거기에도
     * 있어야 한다. 병합은 합집합이므로 이 기기에서 고르지 않은 언어도 함께 온다.
     *
     * 새 기기에서 로그인하면 이 순간 온보딩도 끝난 것으로 본다 — 같은 선택을 다시
     * 하지 않게 하는 것이 그 이유다.
     */
    if (report.languages.length > 0) {
      useLanguagesStore.getState().adopt(report.languages as LanguageCode[])
    }

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

    set((s) => {
      const pendingByStore: Record<string, number> = { ...s.pendingByStore }
      for (const [store, count] of Object.entries(batch)) {
        const left = (pendingByStore[store] ?? 0) - count
        if (left > 0) pendingByStore[store] = left
        else delete pendingByStore[store]
      }
      return {
        status: 'synced' as SyncStatus,
        lastSyncedAt: new Date().toISOString(),
        error: null,
        // 올라갔다고 확인해 준다 — 올라간 것을 알아야 안심한다
        notice: markSynced(s.notice, Date.now()),
        // 다 밀었다 — 이제 서버와 같다
        dirty: pendingCount(pendingByStore) > 0,
        pendingByStore,
      }
    })
  } catch (error) {
    // Supabase 미설정은 설정 안내가 따로 있으므로 여기서 다루지 않는다
    if (error instanceof SyncUnavailable) {
      // 서버를 쓰지 않는 상태다 — '밀렸다'고 하지 않는다. 오류도 아닌 정상이다
      set({ status: 'local', error: null, dirty: false, pendingByStore: {} })
      return
    }
    set({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      // 못 보냈으므로 그대로 '기기에만 있음' — 지워 버리면 진도가 사라진 것으로 보인다
      dirty: true,
      pendingByStore: batch,
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

    const unsubscribe = onLocalWrite((store) => {
      useSyncStore.setState((s) => ({
        dirty: true,
        pendingByStore: { ...s.pendingByStore, [store]: (s.pendingByStore[store] ?? 0) + 1 },
        // 단어 상태를 바꿨을 때만 말한다 — 문서를 열거나 제목을 바꾸는 것으로는
        // 알리지 않는다. 잃어버렸다고 느낀 것은 진도였고, 나머지는 조용히 보내도 된다
        notice:
          store === STORES.wordStates
            ? { until: Date.now() + NOTICE_MS, synced: false }
            : s.notice,
      }))
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

  /**
   * 로그인·로그아웃을 모두 여기서 받는다.
   *
   * 예전에는 `onAuthStateChange` 안에서 직접 돌렸다. 두 가지 문제가 있었다 —
   * 세션 이벤트를 구독하는 안에서 supabase 를 다시 부르는 것은 교착 위험이 있고,
   * 그때는 스토어의 `user` 가 아직 null 이라 첫 동기화가 아무것도 하지 못했다.
   *
   * 이제 auth 스토어가 세션을 따라가므로 `user` 가 바뀌는 것만 보면 된다.
   */
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

/**
 * 지금 무엇을 말할 것인가 — 사람이 있는 자리에서.
 *
 * 시간이 지나면 조용해진 것을 다시 그려야 '조용해지는 순간' 이 보인다. 읽는 동안의
 * 표시와 같은 규칙을 쓰되, 사람이 직접 확인하러 왔으니 실패와 밀린 것은 끝까지 말한다.
 */
export function useSyncStatus(
  status: SyncStatus,
  notice: SyncNotice | null,
  pending: number,
): StatusKind {
  // 이미 조용해진 알림. 같은 알림이면 계속 조용하다 — 새 알림이 서면 다시 말하고.
  const [expired, setExpired] = useState<SyncNotice | null>(null)
  const active = notice !== null && expired !== notice

  // 시간을 그릴 때 부르지 않는다 — 언제 조용해질지는 여기서 한 번 정하고 결과만 넘긴다
  useEffect(() => {
    if (!notice) return
    const handle = setTimeout(
      () => setExpired(notice),
      Math.max(0, notice.until - Date.now() + 50),
    )
    return () => clearTimeout(handle)
  }, [notice])

  return statusKind({ status, pending, noticeActive: active })
}

/**
 * 설정 화면용 — 무엇이 얼마나 밀렸는지 정확히 말해야 하므로 전부 센다.
 *
 * 읽는 동안의 표시와 다르다. 거긴 사용자가 일부러 확인하러 오지 않으니 조용해야 하고,
 * 여기는 온 사람이 '지금 무엇이 밀렸나' 를 묻는 곳이다.
 */
export function usePendingSummary(): { dirty: boolean; count: number } {
  const dirty = useSyncStore((s) => s.dirty)
  const byStore = useSyncStore((s) => s.pendingByStore)
  return { dirty, count: pendingCount(byStore) }
}

/** 로그인 화면·설정에서 쓰는 편의 훅 */
export function useSyncNow(): () => void {
  const syncNow = useSyncStore((s) => s.syncNow)
  return useCallback(() => void syncNow(), [syncNow])
}

export const isSyncConfigured = supabase !== null
