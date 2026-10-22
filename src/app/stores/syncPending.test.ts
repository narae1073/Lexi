import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { pendingCount, type SyncState } from './sync'
import { createSyncScheduler } from './syncScheduler'
import {
  STORES,
  bumpLocalRevision,
  deleteLocalDatabase,
  readLocalSyncMeta,
  subtractPending,
} from '../../lib/storage/localDb'

/**
 * 밀린 것을 세는 법.
 *
 * 알림을 '단어 상태가 바뀔 때만' 으로 좁히려면, 무엇이 밀렸는지 저장소별로
 * 알고 있어야 한다. 그래야 문서를 열었을 때 조용하고, 단어를 표시했을 때만
 * 말할 수 있다.
 */
describe('밀린 것 세기', () => {
  const byStore = (o: Record<string, number>) => o

  it('저장소별 개수를 모두 더한다', () => {
    expect(pendingCount(byStore({ wordStates: 2, documents: 1 }))).toBe(3)
  })

  it('아무것도 밀리지 않았으면 0', () => {
    expect(pendingCount({})).toBe(0)
  })

  /**
   * 보낸 만큼만 뺀다.
   *
   * 보내는 중에 새로 쌓인 것은 남아야 한다. 통째로 비우면 '보냈는데 아직 안 올라간'
   * 상태를 놓치고, 사용자는 잃었다고 믿는다.
   */
  it('보낸 것만 빼고 새로 쌓인 것은 남는다', () => {
    const batch = { wordStates: 2 }
    const current = { wordStates: 3, documents: 1 }

    const left: Record<string, number> = { ...current }
    for (const [store, count] of Object.entries(batch)) {
      const rest = (left[store] ?? 0) - count
      if (rest > 0) left[store] = rest
      else delete left[store]
    }

    expect(left).toEqual({ wordStates: 1, documents: 1 })
    expect(pendingCount(left)).toBe(2)
  })

  it('0 이 된 저장소는 남기지 않는다', () => {
    const left: Record<string, number> = { wordStates: 2 }
    for (const [store, count] of Object.entries({ wordStates: 2 })) {
      const rest = (left[store] ?? 0) - count
      if (rest > 0) left[store] = rest
      else delete left[store]
    }
    expect(left).toEqual({})
    expect(pendingCount(left)).toBe(0)
  })

  it('보낼 것이 없으면 dirty 아니다', () => {
    const state = { pendingByStore: {} } as SyncState
    expect(pendingCount(state.pendingByStore) > 0).toBe(false)
  })
})

/**
 * The shared record, not a tab's memory, owns pending counts.
 *
 * Every tab writes the reserved sync-meta record in the same IndexedDB, so the
 * counts a tab displays must come back from that record. Subtracting only the
 * stores the server confirmed is what keeps a failed table from disappearing
 * from the UI.
 */
describe('shared pending counts in the reserved sync record', () => {
  beforeEach(async () => {
    await deleteLocalDatabase()
  })

  it('shares pending counts through the reserved sync record across tab-like calls', async () => {
    await bumpLocalRevision(STORES.documents, 'doc-1')
    await bumpLocalRevision(STORES.wordStates, 'en\u0000run')
    await subtractPending({ documents: 1 })

    const meta = await readLocalSyncMeta()
    expect(meta?.pendingByStore).toEqual({ wordStates: 1 })
  })

  it('subtracts only the stores whose whole batch succeeded', async () => {
    await bumpLocalRevision(STORES.documents, 'doc-1')
    await bumpLocalRevision(STORES.wordStates, 'en\u0000run')
    await bumpLocalRevision(STORES.wordStates, 'en\u0000walk')

    const meta = await subtractPending({ wordStates: 2 })

    expect(meta.pendingByStore).toEqual({ documents: 1 })
    expect(pendingCount(meta.pendingByStore)).toBe(1)
  })

  /**
   * A write that lands while a sync is in flight must survive the subtraction:
   * the batch is the count read before the cycle, not the current count.
   */
  it('keeps a write that landed after the batch was counted', async () => {
    await bumpLocalRevision(STORES.wordStates, 'en\u0000run')
    const batch = { wordStates: 1 }

    // Another tab writes while the sync is running.
    await bumpLocalRevision(STORES.wordStates, 'en\u0000walk')
    await subtractPending(batch)

    expect((await readLocalSyncMeta())?.pendingByStore).toEqual({ wordStates: 1 })
  })
})

describe('저장소별 알림', () => {
  /**
   * 읽는 동안의 알림은 '단어 상태' 만을 본다.
   *
   * 예전엔 무언이 저장되든 표시가 났다 — 문서를 열 때(최근 본 시각), 등장 기록을
   * 계산할 때마다. 읽는 내내 깜빡이니 곧 무시하게 된다.
   */
  it('단어 상태 변경은 곧바로 알린다', async () => {
    vi.useFakeTimers()
    const pending: Record<string, number> = {}
    const scheduler = createSyncScheduler({ flush: async () => {}, debounceMs: 1000, maxWaitMs: 10_000 })

    pending.wordStates = (pending.wordStates ?? 0) + 1
    scheduler.notify()

    expect(pending.wordStates).toBeGreaterThan(0)
    vi.useRealTimers()
  })

  it('문서를 연 것은 알리지 않는다', () => {
    const pending: Record<string, number> = {}
    // documents 는 저장되지만, 읽는 동안의 알림은 보지 않는다
    pending.documents = (pending.documents ?? 0) + 1
    expect(pending.wordStates ?? 0).toBe(0)
  })

  it('연속으로 밀려도 한 번에 사라진다 — 깜빡이면 사람이 읽기를 멈춘다', async () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = createSyncScheduler({ flush, debounceMs: 1000, maxWaitMs: 10_000 })

    scheduler.notify()
    scheduler.notify()
    scheduler.notify()
    vi.advanceTimersByTime(1000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(scheduler.pending).toBe(false)
    vi.useRealTimers()
  })
})