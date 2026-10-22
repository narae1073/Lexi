import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { clearPushOnClockRollback, readStoredSyncState, writeStoredSyncState } from './syncState'
import type { StoredSyncState } from './types'

/**
 * This project has no jsdom — localStorage-using modules are tested against a
 * storage stub that keeps the Storage contract (same approach as purged.test.ts).
 */
class MemoryStorage {
  #map = new Map<string, string>()

  getItem(key: string) {
    return this.#map.has(key) ? this.#map.get(key)! : null
  }

  setItem(key: string, value: string) {
    this.#map.set(key, String(value))
  }

  removeItem(key: string) {
    this.#map.delete(key)
  }

  clear() {
    this.#map.clear()
  }

  key(index: number) {
    return [...this.#map.keys()][index] ?? null
  }

  get length() {
    return this.#map.size
  }
}

beforeAll(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage
})

const state = (over: Partial<StoredSyncState> = {}): StoredSyncState => ({
  version: 2,
  pull: { snapshot: '2026-10-22T00:00:00.000Z' },
  push: {},
  localEpoch: 'epoch-1',
  lastSyncedAt: '2026-10-22T00:01:00.000Z',
  ...over,
})

/**
 * Stored sync state is version 2: snapshot pull watermark, per-table push
 * watermarks, and the local epoch. Version 1 entries read as absent so the
 * first cycle after the upgrade is one full pull and full push.
 */
describe('stored sync state version 2', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('treats v1 sync state as absent', () => {
    localStorage.setItem(
      'lexi.syncState',
      JSON.stringify({
        u1: { version: 1, pull: {}, pushedAt: '2026-10-22T00:00:00.000Z' },
      }),
    )
    expect(readStoredSyncState('u1')).toBeNull()
  })

  it('round-trips a v2 state for a user', () => {
    writeStoredSyncState('u1', state())
    expect(readStoredSyncState('u1')).toEqual(state())
  })

  it('keeps each user state separate', () => {
    writeStoredSyncState('u1', state())
    writeStoredSyncState('u2', state({ localEpoch: 'epoch-2' }))

    expect(readStoredSyncState('u1')?.localEpoch).toBe('epoch-1')
    expect(readStoredSyncState('u2')?.localEpoch).toBe('epoch-2')
  })

  it('returns null when nothing is stored', () => {
    expect(readStoredSyncState('u1')).toBeNull()
  })

  it('returns null for corrupted JSON', () => {
    localStorage.setItem('lexi.syncState', 'not json')
    expect(readStoredSyncState('u1')).toBeNull()
  })

  it('returns null for an unknown version', () => {
    localStorage.setItem(
      'lexi.syncState',
      JSON.stringify({ u1: { version: 3, pull: {}, push: {}, localEpoch: 'e' } }),
    )
    expect(readStoredSyncState('u1')).toBeNull()
  })

  it('returns null for a user with no entry', () => {
    writeStoredSyncState('u1', state())
    expect(readStoredSyncState('u2')).toBeNull()
  })
})

/**
 * A clock rollback would make "rows touched after the watermark" skip local
 * changes forever, so any push watermark in the future clears all of them and
 * the next sync re-pushes regardless of timestamps.
 */
describe('clearPushOnClockRollback', () => {
  it('clears all push watermarks when now is before any stored watermark', () => {
    const result = clearPushOnClockRollback(
      { documents: '2026-10-26T00:00:00.000Z' },
      Date.parse('2026-10-25T00:00:00.000Z'),
    )
    expect(result.rolledBack).toBe(true)
    expect(result.push).toEqual({})
  })

  it('clears every table when only one watermark is in the future', () => {
    const result = clearPushOnClockRollback(
      {
        documents: '2026-10-24T00:00:00.000Z',
        wordStates: '2026-10-27T00:00:00.000Z',
      },
      Date.parse('2026-10-26T00:00:00.000Z'),
    )
    expect(result.rolledBack).toBe(true)
    expect(result.push).toEqual({})
  })

  it('keeps watermarks when every stored watermark is in the past', () => {
    const push = {
      documents: '2026-10-24T00:00:00.000Z',
      wordStates: '2026-10-25T00:00:00.000Z',
    }
    const result = clearPushOnClockRollback(push, Date.parse('2026-10-26T00:00:00.000Z'))
    expect(result.rolledBack).toBe(false)
    expect(result.push).toEqual(push)
  })

  it('treats an empty push map as not rolled back', () => {
    expect(clearPushOnClockRollback({}, Date.parse('2026-10-26T00:00:00.000Z'))).toEqual({
      push: {},
      rolledBack: false,
    })
  })

  it('ignores watermarks that do not parse as timestamps', () => {
    const result = clearPushOnClockRollback(
      { documents: 'not-a-date' },
      Date.parse('2026-10-26T00:00:00.000Z'),
    )
    expect(result.rolledBack).toBe(false)
    expect(result.push).toEqual({ documents: 'not-a-date' })
  })

  it('uses Date.now() when now is omitted', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(clearPushOnClockRollback({ wordStates: future }).rolledBack).toBe(true)
  })
})
