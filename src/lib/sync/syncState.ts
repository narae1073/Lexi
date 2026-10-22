import type { PushWatermarks, StoredSyncState } from './types'

/**
 * Per-user sync state persisted in localStorage.
 *
 * `pull` is the server's watermark, `push` the client's — the two clocks are
 * compared against different time bases, so they are kept apart. Version 2
 * adds per-table push watermarks and the local epoch; a version 1 entry reads
 * as absent so the first cycle after the upgrade is one full pull and push.
 */
const SYNC_STATE_KEY = 'lexi.syncState'
const SYNC_STATE_VERSION = 2

function storedSyncStateStorage(): Storage | undefined {
  return (globalThis as { localStorage?: Storage }).localStorage
}

/** Parses one user's entry; anything but a well-formed version 2 record is absent. */
function parseStoredSyncState(value: unknown): StoredSyncState | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Partial<StoredSyncState>
  if (row.version !== SYNC_STATE_VERSION) return null
  if (typeof row.localEpoch !== 'string' || row.localEpoch === '') return null
  return {
    version: SYNC_STATE_VERSION,
    pull: row.pull ?? {},
    push: row.push ?? {},
    localEpoch: row.localEpoch,
    lastSyncedAt: typeof row.lastSyncedAt === 'string' ? row.lastSyncedAt : undefined,
  }
}

/**
 * Reads one user's stored sync state.
 *
 * Version 1 (single `pushedAt`) and malformed entries return null — callers
 * treat that as "no state" and do a full pull and full push.
 */
export function readStoredSyncState(userId: string): StoredSyncState | null {
  try {
    const target = storedSyncStateStorage()
    const raw = target?.getItem(SYNC_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parseStoredSyncState(parsed[userId])
  } catch {
    return null
  }
}

/** Persists one user's sync state, leaving other users' entries untouched. */
export function writeStoredSyncState(userId: string, state: StoredSyncState): void {
  try {
    const target = storedSyncStateStorage()
    if (!target) return
    const raw = target.getItem(SYNC_STATE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, StoredSyncState>) : {}
    parsed[userId] = state
    target.setItem(SYNC_STATE_KEY, JSON.stringify(parsed))
  } catch (error) {
    console.error('동기화 워터마크 저장 실패', error)
  }
}

/**
 * Clears all push watermarks when the local clock sits before any of them.
 *
 * A rolled-back clock would make "rows touched after the watermark" skip local
 * changes forever, so every push watermark in the future clears all of them
 * and the next sync re-pushes regardless of timestamps. Unparseable values are
 * ignored — an unreadable watermark is not evidence of a rollback. Pull
 * watermarks use the server clock and are never cleared here.
 */
export function clearPushOnClockRollback(
  push: PushWatermarks,
  now = Date.now(),
): { push: PushWatermarks; rolledBack: boolean } {
  const rolledBack = Object.values(push).some((iso) => {
    if (typeof iso !== 'string') return false
    const at = Date.parse(iso)
    return !Number.isNaN(at) && at > now
  })
  return rolledBack ? { push: {}, rolledBack: true } : { push, rolledBack: false }
}
