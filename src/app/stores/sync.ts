import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'

import { useAuthStore } from './auth'
import { useDocumentsStore } from './documents'
import { useFoldersStore } from './folders'
import { useLanguagesStore } from './languages'
import { useOccurrencesStore } from './occurrences'
import { useWordStatesStore } from './wordStates'
import { createSyncScheduler } from './syncScheduler'
import { markSynced, statusKind, NOTICE_MS, type StatusKind, type SyncNotice } from './syncVisibility'
import { hasLocalLearningData, ensureLocalSyncMeta, onLocalWrite, STORES } from '../../lib/storage/localDb'
import {
  ensureLocalOwner,
  readLocalOwner,
  writeLocalOwner,
  type LocalOwner,
  type OwnerStorage,
} from '../../lib/storage/accountOwner'
import { supabase } from '../../lib/supabase/client'
import type { LanguageCode } from '../../types'
import {
  SyncDeferredError,
  SyncUnavailable,
  syncOnce,
  type SyncReport,
} from '../../lib/sync/sync'
import { readStoredSyncState, writeStoredSyncState } from '../../lib/sync/syncState'
import { createSingleFlight, type SingleFlight } from '../../lib/sync/singleFlight'

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

/**
 * Where incremental sync stands — persisted in `src/lib/sync/syncState.ts`
 * as version 2.
 *
 * `pull` is the server's watermark; `push` is compared against this device's
 * clock. Version 1 (a single `pushedAt`) reads as absent — the first cycle
 * after the upgrade does one full pull and full push.
 */

/**
 * The reserved sync-meta record owns the local epoch. Reading it must never
 * fail an otherwise successful sync: when the local database cannot be read,
 * the previously stored epoch stays until the next cycle can refresh it.
 */
async function readLocalEpochSafely(fallback: string): Promise<string> {
  try {
    return (await ensureLocalSyncMeta()).epoch
  } catch {
    return fallback
  }
}

export type SyncState = {
  status: SyncStatus
  lastSyncedAt: string | null
  error: string | null
  /**
   * 이 기기의 소유자를 확인했는가.
   *
   * 확인 전에는 화면이 동기화 여부를 말하지 않는다 — 아직 모르는 것을 아는 척하면
   * 남의 기록을 보여 줄 수 있다. 소유자 확인이 끝나야 참이 된다.
   */
  accountReady: boolean
  /**
   * 소유자 확인이 끝난 계정. `null` 은 로그아웃 상태를 확인했다는 뜻이다.
   *
   * `accountReady` 만으로는 부족하다. A 로 확인이 끝난 뒤 B 가 로그인하면, 효과가
   * `accountReady` 를 거짓으로 되돌리기 전까지 한 번은 A 의 화면이 B 에게 보인다.
   * 어느 사용자에 대한 준비인지 함께 기억해야 그 한 번을 막을 수 있다.
   */
  readyForUserId: string | null
  /** 다른 계정의 기록이 이 기기에 남아 있어 동기화가 막혔다 */
  accountBlocked: boolean
  /** 아직 주인 없는 기기 기록을 계정으로 넘겨받을지 물어야 한다 */
  claimNeeded: boolean
  /** 계정에 묶지 않고 이 기기에서만 쓴다 — 사용자가 고른 결정일 수도 있다 */
  localOnly: boolean
  /** 사람이 누르는 즉시 돌린다 */
  syncNow: () => Promise<void>
  /** 로그인·앱 시작·온라인 복귀 때 조용히 돌린다 (실패해도 조용히) */
  syncQuietly: () => Promise<void>
  /** 주인 없는 기기 기록을 지금 계정으로 넘겨받는다 */
  claimLocalData: (userId: string) => void
  /** 이 기기에서만 쓰기로 정한다 — 다시 묻지 않는다 */
  keepLocalOnly: () => void
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
  /**
   * 마지막 동기화가 무엇을 했는지 — 사람이 읽을 수 있는 기록.
   *
   * 기계가 아니라 사람이 보라고 만드는 자리다. 기기마다 진도가 다른 것을 설명하라는
   * 질문에 답하려면 '이 기기가 서버에 무엇을 보냈고 무엇을 받았는지' 가 화면에 있어야
   * 한다 — 없으면 추측만 된다.
   */
  report: SyncReport | null
}

/** 합쳐진 밀린 개수 */
export function pendingCount(byStore: Record<string, number>): number {
  return Object.values(byStore).reduce((sum, n) => sum + n, 0)
}

/**
 * 소유자와 지금 계정만으로 동기화 범위를 정한다.
 *
 * `resolveAccountScope` 는 기기 데이터까지 보지만, 문 앞에서는 그것으로 충분하다 —
 * 동기화는 이미 이 기기에 있는 것만 다루므로 '넘겨받을지' 와 '막혔는지' 만 갈리면 된다.
 * 특히 `kept: true` 는 사용자가 이미 내린 결정이므로 넘겨받기(claim)로 되돌리지 않는다.
 */
export function ownerSyncState(
  owner: LocalOwner | null,
  userId: string | null,
): { canSync: boolean; accountBlocked: boolean; claimNeeded: boolean; localOnly: boolean } {
  if (userId === null) {
    return { canSync: false, accountBlocked: false, claimNeeded: false, localOnly: true }
  }

  if (owner === null) {
    return { canSync: false, accountBlocked: false, claimNeeded: true, localOnly: true }
  }

  if (owner.kind === 'user') {
    return owner.userId === userId
      ? { canSync: true, accountBlocked: false, claimNeeded: false, localOnly: false }
      : { canSync: false, accountBlocked: true, claimNeeded: false, localOnly: true }
  }

  if (owner.kept === true) {
    return { canSync: false, accountBlocked: false, claimNeeded: false, localOnly: true }
  }

  return { canSync: false, accountBlocked: false, claimNeeded: true, localOnly: true }
}

/**
 * 지금 화면이 이 사용자의 준비된 상태를 보여도 되는가.
 *
 * 소유자 확인이 끝났더라도 그 확인이 **지금 로그인한 사용자**의 것이어야 한다.
 * A 의 확인이 끝난 직후 B 로 바뀌면, 효과가 상태를 되돌리기 전 한 번의 렌더가
 * 남는다 — 그 한 번에 A 의 문서·단어장이 보이면 공유 기기의 경계가 무너진다.
 */
export function isAccountGateReady(
  accountReady: boolean,
  readyForUserId: string | null,
  currentUserId: string | null,
): boolean {
  return accountReady && readyForUserId === currentUserId
}

/**
 * 이 계정이 지금 동기화해도 되는가.
 *
 * 저장된 소유자를 읽지 못하거나 망가졌으면 거짓이다 — 모르는 것을 추측해서 남의
 * 기록을 올리지 않는다. 저장소를 주입할 수 있게 둔 것은 시험과 SSR 을 위해서다.
 */
export function canSyncForUser(userId: string, storage?: OwnerStorage): boolean {
  return ownerSyncState(readLocalOwner(storage), userId).canSync
}

/**
 * 소유자 초기화를 호출 순서대로 하나씩 실행한다.
 *
 * `ensureLocalOwner` 는 IndexedDB 를 읽은 **뒤에** 소유자를 쓴다. 로그아웃 초기화와
 * 로그인 초기화가 겹치면, 늦게 끝난 쪽이 나중에 시작한 계정을 덮어쓸 수 있다 —
 * 그러면 기기 데이터가 주인 없는 것으로 남아 다음 계정이 넘겨받게 된다.
 *
 * 그래서 초기화 자체를 직렬화한다. 먼저 시작한 초기화가 끝난 뒤에 다음 초기화가
 * 소유자를 읽으므로, 마지막으로 시작한 계정이 언제나 최종 소유자가 된다. 호출자가
 * `cancelled` 로 화면 반영을 막는 것과 별개로, 저장된 값도 순서를 지킨다.
 *
 * 저장소·기기 데이터 확인을 주입할 수 있게 둔 것은 시험을 위해서다.
 */
let ownerInitialization: Promise<void> = Promise.resolve()

export function initializeLocalOwner(
  userId: string | null,
  options: { storage?: OwnerStorage; hasLocalData?: () => Promise<boolean> } = {},
): Promise<LocalOwner> {
  const run = ownerInitialization.then(() =>
    ensureLocalOwner(userId, {
      storage: options.storage,
      hasLocalData: options.hasLocalData ?? hasLocalLearningData,
    }),
  )

  // 실패해도 다음 초기화는 자기 차례를 얻어야 한다 — 사슬은 항상 이어 둔다
  ownerInitialization = run.then(
    () => undefined,
    () => undefined,
  )

  return run
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
  accountReady: false,
  readyForUserId: null,
  accountBlocked: false,
  claimNeeded: false,
  localOnly: true,
  dirty: false,
  pendingByStore: {},
  notice: null,
  report: null,

  syncNow: async () => {
    const user = useAuthStore.getState().user
    // 소유자가 이 계정이 아니면 서버에 아무것도 보내지 않는다. 버튼을 눌렀어도
    // 남의 기록을 올릴 수는 없다 — 기기 범위로 물러난다.
    if (!user || !canSyncForUser(user.id)) {
      set({ status: 'local', error: null })
      return
    }
    // 사람이 누른 것이다 — 결과를 알려야 한다
    useSyncStore.setState({ notice: { until: Date.now() + NOTICE_MS, synced: false } })
    await run(set)
  },

  syncQuietly: async () => {
    const user = useAuthStore.getState().user
    if (!user || !canSyncForUser(user.id)) {
      set({ status: 'local', error: null })
      return
    }
    try {
      await run(set)
    } catch {
      // 조용히 돌리는 경로에서는 실패해도 사용자를 막지 않는다.
      // 다시 켜졌을 때 온라인 복귀 훅이 재시도한다.
    }
  },

  claimLocalData: (userId) => {
    // 화면이 다른 계정으로 바뀌었는데 예전 화면의 버튼이 늦게 눌릴 수 있다
    if (useAuthStore.getState().user?.id !== userId) return

    const owner = readLocalOwner()
    // 다른 계정의 표시는 넘겨받을 수 없다 — 그 기록은 그 계정의 것이다
    if (owner !== null && owner.kind !== 'local') return

    writeLocalOwner({ kind: 'user', userId })
    set({ claimNeeded: false, localOnly: false, accountBlocked: false })
    void useSyncStore.getState().syncQuietly()
  },

  keepLocalOnly: () => {
    const current = useSyncStore.getState()
    // 넘겨받기를 묻는 상태에서만 의미가 있고, 막힌 상태에는 이 출구가 없다
    if (!current.claimNeeded || current.accountBlocked) return

    writeLocalOwner({ kind: 'local', kept: true })
    set({
      claimNeeded: false,
      localOnly: true,
      accountBlocked: false,
      status: 'local',
      error: null,
    })
  },
}))

type Setter = (partial: Partial<SyncState> | ((s: SyncState) => Partial<SyncState>)) => void

/**
 * 동기화는 한 번에 하나만.
 *
 * 로그인·앱 시작·온라인 복귀·수동 동기화·저장 직후가 겹칠 수 있다. 겹치면 같은
 * 행을 두 번 읽고 쓰고, 밀린 개수를 두 번 뺀다. 실행 중에 들어온 요청은 버리지
 * 않고 끝난 뒤 한 번 더 돈다.
 */
let exclusive: SingleFlight | null = null

/** Wait until the active sync and any queued rerun have both finished. */
export function waitForSyncIdle(): Promise<void> {
  return exclusive?.whenIdle() ?? Promise.resolve()
}

async function run(set: Setter): Promise<void> {
  exclusive ??= createSingleFlight(() => doRun(set))
  return exclusive()
}

async function doRun(set: Setter) {
  const user = useAuthStore.getState().user
  // 예약된 뒤에 로그아웃했거나 다른 계정으로 바뀌었을 수 있다 — 문에서 다시 확인한다
  if (!user || !canSyncForUser(user.id)) return
  const startedUserId = user.id
  const accountChanged = () => useAuthStore.getState().user?.id !== startedUserId

  // 이번에 보낼 것을 기억해 둔다 — 실패하면 되돌려야 하고, 성공하면 뺀 것만
  // 빼야 보내는 중에 쌓인 것이 '밀린 것' 으로 남는다
  const batch = { ...useSyncStore.getState().pendingByStore }
  // Version 1 reads as absent: the first cycle after the upgrade is a full
  // pull and full push (one-time cost, no local data is touched).
  const stored = readStoredSyncState(user.id)
  // 이 시각 이전에 바뀐 것은 지난 동기화가 이미 보냈다. 이번에 바뀐 것만 다음에 보낸다
  const startedAt = new Date().toISOString()

  set({ status: 'syncing', error: null })

  try {
    const languages = useLanguagesStore.getState().enrolled
    const report = await syncOnce({
      userId: user.id,
      languages,
      since: stored?.pull,
      /**
       * Per-table push watermarks arrive with the push rework; until then the
       * last successful sync's start time keeps R1's single-watermark rule
       * ("rows touched after the last sync start are pushed next time").
       */
      pushedAt: stored?.lastSyncedAt,
    })

    /**
     * 기다리는 사이 계정이 바뀌었을 수 있다.
     *
     * 이 기기의 DB 에는 이미 A 의 병합 결과가 쓰였을 수 있지만, 그것을 B 의 화면에
     * 채택하거나 B 의 워터마크로 남기면 안 된다. A 로 다시 돌아오면 같은 동기화를
     * 한 번 더 하면 되고, 그 동기화는 멱등이다.
     */
    if (accountChanged()) return

    // 성공한 뒤에만 워터마크를 옮긴다 — 실패하면 같은 구간을 다시 읽고 다시 보낸다
    writeStoredSyncState(user.id, {
      version: 2,
      pull: report.watermarks,
      // Per-table push watermarks land with the push rework; the empty map
      // means "no table watermark yet" and the lastSyncedAt bridge above keeps
      // R1's behavior in the meantime.
      push: {},
      localEpoch: await readLocalEpochSafely(stored?.localEpoch ?? ''),
      lastSyncedAt: startedAt,
    })

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
    // 읽는 사이 계정이 바뀌었으면 이 기기의 병합 결과를 새 계정 화면에 밀어 넣지 않는다.
    // 이후 읽기도, 마지막 성공 상태도 모두 이번 계정의 것이어야 한다.
    if (accountChanged()) return
    // 폴더도 다른 기기에서 온다 — 만들어진 폴더가 여기에도 나와야 한다
    await useFoldersStore.getState().load()
    if (accountChanged()) return

    /**
     * 방금 써 넣은 병합 결과를 화면에 반영한다.
     *
     * force 없이 부르면 이미 읽은 언어라 아무것도 하지 않는다 — 그러면 다른 기기에서 온
     * 진도가 IndexedDB 에만 있고 화면에 없다. 사용자가 새로고침을 한 번 더 해야 보게 된다.
     */
    const wordStates = useWordStatesStore.getState()
    await Promise.all(languages.map((code) => wordStates.loadLanguage(code, { force: true })))
    if (accountChanged()) return

    const occurrences = useOccurrencesStore.getState()
    await Promise.all(languages.map((code) => occurrences.loadLanguage(code)))
    if (accountChanged()) return

    // 기록이 없는/옛 기록인 문서의 재계산은 App 이 문서 목록에 반응해 맡는다.
    // 여기서 다시 부르면 같은 계산을 두 번 한다.

    // 마지막 확인 — 여기까지 왔어도 set 직전에 바뀔 수 있다
    if (accountChanged()) return

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
        report,
        // 다 밀었다 — 이제 서버와 같다
        dirty: pendingCount(pendingByStore) > 0,
        pendingByStore,
      }
    })
  } catch (error) {
    // 계정이 바뀐 뒤에는 이전 계정의 실패를 새 계정의 화면에 남기지 않는다
    if (accountChanged()) return

    /**
     * Local writes kept landing while this cycle planned. Nothing was written
     * and no watermark moved, so there is no error for the user to act on.
     * The write that caused the conflict already notified the debounced sync
     * scheduler, so keep the pending batch and let that retry handle it — a
     * private timer would pull again every couple of seconds during a burst.
     */
    if (error instanceof SyncDeferredError) {
      set({ status: 'local', error: null })
      return
    }

    // Supabase 미설정은 설정 안내가 따로 있으므로 여기서 다루지 않는다
    if (error instanceof SyncUnavailable) {
      // 서버를 쓰지 않는 상태다 — '밀렸다'고 하지 않는다. 오류도 아닌 정상이다
      set({ status: 'local', error: null, dirty: false, pendingByStore: {} })
      return
    }
    set({
      status: 'error',
      report: null,
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
   * 이 기기의 소유자를 먼저 정한다 — 동기화의 유일한 입구다.
   *
   * 소유자를 확인하기 전에는 `accountReady` 가 거짓이라 화면이 동기화 여부를 말하지
   * 않는다. `ensureLocalOwner` 는 IndexedDB 를 읽으므로 늦게 끝날 수 있고, 그 사이
   * 사용자가 바뀌면 예전 계정 기준의 판정을 새 계정에 적용하면 안 된다. 화면 반영은
   * `cancelled` 로, 저장된 소유자는 `initializeLocalOwner` 의 직렬화로 막는다 —
   * 늦게 끝난 초기화가 나중에 시작한 계정을 덮어쓰지 않는다.
   *
   * 계정이 바뀌면 이전 계정의 화면 상태(보고서·밀린 개수)는 지운다. 기기 기록과
   * 소유자 표시는 지우지 않는다 — 로그아웃했다고 학습 기록을 잃으면 안 된다.
   */
  useEffect(() => {
    let cancelled = false

    useSyncStore.setState({
      accountReady: false,
      readyForUserId: null,
      pendingByStore: {},
      report: null,
      dirty: false,
      lastSyncedAt: null,
      notice: null,
    })

    void (async () => {
      const userId = user?.id ?? null
      const owner = await initializeLocalOwner(userId)
      if (cancelled) return

      const scope = ownerSyncState(owner, userId)
      const next: Partial<SyncState> = {
        accountReady: true,
        // 이 확인이 어느 사용자의 것인지 함께 남긴다 — 다음 렌더에서 비교한다
        readyForUserId: userId,
        accountBlocked: scope.accountBlocked,
        claimNeeded: scope.claimNeeded,
        localOnly: scope.localOnly,
      }
      if (!scope.canSync) {
        next.status = 'local'
        next.error = null
      }
      useSyncStore.setState(next)

      if (scope.canSync) void useSyncStore.getState().syncQuietly()
    })()

    return () => {
      cancelled = true
    }
  }, [user])

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
      // 소유자가 이 계정이 아니면 '밀린 것' 으로 세지 않는다. 세면 화면이 이 기기의
      // 남의 기록을 이 계정의 진도처럼 말하게 된다 — 저장은 이미 끝났고 기기에만 있다.
      const current = useAuthStore.getState().user
      if (!current || !canSyncForUser(current.id)) {
        useSyncStore.setState({ status: 'local' })
        return
      }

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
   * 첫 동기화는 소유자 초기화 효과가 맡는다 — 여기서 또 부르면 소유자 확인 전에
   * 달려들 수 있다.
   */
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
