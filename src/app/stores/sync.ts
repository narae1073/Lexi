import { useCallback, useEffect } from 'react'
import { create } from 'zustand'

import { useAuthStore, onAuthChanged } from './auth'
import { useDocumentsStore } from './documents'
import { useLanguagesStore } from './languages'
import { useOccurrencesStore } from './occurrences'
import { useWordStatesStore } from './wordStates'
import { supabase } from '../../lib/supabase/client'
import { SyncUnavailable, pushOccurrences, readLocal, syncOnce } from '../../lib/sync/sync'

export type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'

type SyncState = {
  status: SyncStatus
  lastSyncedAt: string | null
  error: string | null
  /** 사람이 누르는 즉시 돌린다 */
  syncNow: () => Promise<void>
  /** 로그인·앱 시작·온라인 복귀 때 조용히 돌린다 (실패해도 조용히) */
  syncQuietly: () => Promise<void>
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

    set({ status: 'synced', lastSyncedAt: new Date().toISOString(), error: null })
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
