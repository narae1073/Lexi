import {
  RESERVED_DOCUMENT_META_PREFIX,
  STORES,
  idbGet,
  idbPut,
  openLocalDatabase,
} from '../storage/localDb'

/**
 * Per-account, per-language wordbook projection resume state.
 *
 * This is device-local bookkeeping: it lives in a reserved `documentMeta`
 * record, never in `lexi.syncState`. A device that upgrades from R2 therefore
 * keeps its version 2 sync state, pull snapshot, and push watermarks; the only
 * visible effect is that every enrolled language is marked incomplete and the
 * projection is downloaded once.
 *
 * Correctness rules:
 *   - The snapshot and the cursor are written together. A resume must use the
 *     snapshot the cursor was produced under, otherwise rows that moved after
 *     the new snapshot could be skipped.
 *   - A cursor may only move after the page it names has been stored locally.
 *     The pull helper documents the same ordering.
 *   - Per-language progress uses {@link updateProjectionState}, which reads and
 *     writes the record in one IndexedDB transaction. A read-modify-write in
 *     two transactions (readProjectionState then writeProjectionState) can
 *     drop another language's cursor and must not be used for progress.
 *   - Anything unreadable is read as "incomplete" rather than resumed. A full
 *     re-pull is idempotent; resuming from a half-written cursor is not.
 */

export type ProjectionCursor = { languageCode: string; lemma: string }

/**
 * Why a projection pass stopped before finishing.
 *
 * `bytes` and `quota` are the normal resumable pauses. `state` means the server
 * rejected the cursor and the next cycle must restart the pass from its
 * snapshot. `offline` and `error` describe a pull that could not reach the
 * server; they have no retry window and wait for a lifecycle event.
 */
export type ProjectionPauseReason = 'bytes' | 'quota' | 'state' | 'offline' | 'error'

export type ProjectionPause = {
  reason: ProjectionPauseReason
  pausedAt: string
  /** Quota retry time, or the short state-restart delay. Null when event-driven. */
  nextAttemptAt: string | null
  quotaBucket: 'page' | 'sync' | null
  retryAfterSeconds: number | null
}

export type ProjectionState = {
  complete: boolean
  snapshot: string | null
  cursor: ProjectionCursor | null
  hydratedAt: string | null
  /**
   * Server-issued read session for a reusable full pass. A cache clear gets a
   * new session but can reuse the same charged snapshot.
   */
  sessionId?: string
  /** Present only while this language is paused; absent once it completes. */
  pause?: ProjectionPause
}

export type ProjectionStateMap = Record<string, ProjectionState>

/**
 * `documentId` prefix of the reserved per-account record. The rest is the
 * account id so two accounts on one device never share a cursor.
 */
export const PROJECTION_STATE_KEY_PREFIX = `${RESERVED_DOCUMENT_META_PREFIX}projection_state__:`

/** Record format version of the reserved `documentMeta` entry. */
export const PROJECTION_STATE_VERSION = 1

export function projectionStateKey(userId: string): string {
  return `${PROJECTION_STATE_KEY_PREFIX}${userId}`
}

export function emptyProjectionState(): ProjectionState {
  return { complete: false, snapshot: null, cursor: null, hydratedAt: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value))
}

function normalizeCursor(value: unknown): ProjectionCursor | null {
  if (!isRecord(value)) return null
  if (typeof value.languageCode !== 'string' || value.languageCode === '') return null
  if (typeof value.lemma !== 'string' || value.lemma === '') return null
  return { languageCode: value.languageCode, lemma: value.lemma }
}

const PAUSE_REASONS = new Set<ProjectionPauseReason>([
  'bytes',
  'quota',
  'state',
  'offline',
  'error',
])

/**
 * Bad pause metadata is dropped, not turned into "complete". The snapshot and
 * cursor remain usable, so a corrupt notice cannot force a re-download.
 */
function normalizePause(value: unknown): ProjectionPause | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.reason !== 'string' || !PAUSE_REASONS.has(value.reason as ProjectionPauseReason)) {
    return undefined
  }
  if (!isTimestamp(value.pausedAt)) return undefined

  const nextAttemptAt =
    value.nextAttemptAt === null || value.nextAttemptAt === undefined
      ? null
      : isTimestamp(value.nextAttemptAt)
        ? value.nextAttemptAt
        : undefined
  if (nextAttemptAt === undefined) return undefined

  const quotaBucket =
    value.quotaBucket === null || value.quotaBucket === undefined
      ? null
      : value.quotaBucket === 'page' || value.quotaBucket === 'sync'
        ? value.quotaBucket
        : undefined
  if (quotaBucket === undefined) return undefined

  const retryAfterSeconds =
    value.retryAfterSeconds === null || value.retryAfterSeconds === undefined
      ? null
      : typeof value.retryAfterSeconds === 'number' &&
          Number.isFinite(value.retryAfterSeconds) &&
          value.retryAfterSeconds >= 0
        ? value.retryAfterSeconds
        : undefined
  if (retryAfterSeconds === undefined) return undefined

  return {
    reason: value.reason as ProjectionPauseReason,
    pausedAt: value.pausedAt,
    nextAttemptAt,
    quotaBucket,
    retryAfterSeconds,
  }
}

/**
 * One language's state, or the incomplete default when the stored value is not
 * a usable record. `complete` is only true when it was stored as a boolean
 * true; a truthy string cannot mark a language complete.
 */
function normalizeProjectionState(value: unknown): ProjectionState {
  if (!isRecord(value)) return emptyProjectionState()

  const snapshot = isTimestamp(value.snapshot) ? value.snapshot : null
  const cursor = normalizeCursor(value.cursor)
  const pause = normalizePause(value.pause)
  const paused = pause === undefined ? {} : { pause }
  const sessionId =
    typeof value.sessionId === 'string' && value.sessionId !== ''
      ? { sessionId: value.sessionId }
      : {}
  // The cursor is only meaningful under the snapshot it was produced from.
  if (snapshot === null) {
    return {
      complete: false,
      snapshot: null,
      cursor: null,
      hydratedAt: null,
      ...paused,
      ...sessionId,
    }
  }

  return {
    complete: value.complete === true,
    snapshot,
    cursor,
    hydratedAt: isTimestamp(value.hydratedAt) ? value.hydratedAt : null,
    ...paused,
    ...sessionId,
  }
}

function normalizeForLanguage(value: unknown, languageCode: string): ProjectionState {
  const state = normalizeProjectionState(value)
  // A cursor for a different language can only come from a corrupt record.
  if (state.cursor !== null && state.cursor.languageCode !== languageCode) {
    state.cursor = null
  }
  return state
}

function normalizeMap(state: Record<string, ProjectionState>): ProjectionStateMap {
  const normalized: ProjectionStateMap = {}
  for (const [languageCode, entry] of Object.entries(state)) {
    if (languageCode === '' || entry === undefined || entry === null) continue
    normalized[languageCode] = normalizeForLanguage(entry, languageCode)
  }
  return normalized
}

function parseStoredState(stored: unknown, userId: string): ProjectionStateMap {
  if (!isRecord(stored) || stored.documentId !== projectionStateKey(userId)) return {}
  if (stored.version !== PROJECTION_STATE_VERSION) return {}
  if (!isRecord(stored.state)) return {}

  const state: ProjectionStateMap = {}
  for (const [languageCode, entry] of Object.entries(stored.state)) {
    if (languageCode === '') continue
    state[languageCode] = normalizeForLanguage(entry, languageCode)
  }
  return state
}

/**
 * Reads every language's projection state for one account.
 *
 * A missing or unreadable record yields `{}`; callers treat every language as
 * incomplete, which is exactly the R2 upgrade path.
 */
export async function readProjectionState(userId: string): Promise<ProjectionStateMap> {
  return parseStoredState(
    await idbGet<unknown>(STORES.documentMeta, projectionStateKey(userId)),
    userId,
  )
}

/**
 * Replaces one account's projection state map.
 *
 * Use this for an explicit reset or a one-shot import of a whole map. For
 * normal per-language progress use {@link updateProjectionState}: replacing
 * the map from a stale read drops any language another writer advanced.
 *
 * `documentMeta` is a device-local store, so this write does not bump the sync
 * revision, create a dirty key, or signal a local user write.
 */
export async function writeProjectionState(
  userId: string,
  state: Record<string, ProjectionState>,
): Promise<void> {
  await idbPut(STORES.documentMeta, {
    documentId: projectionStateKey(userId),
    version: PROJECTION_STATE_VERSION,
    state: normalizeMap(state),
  })
}

/**
 * Reads, updates, and writes one language's state in a single IndexedDB
 * transaction.
 *
 * This is the only safe way to advance a cursor or mark a language complete
 * when several languages may be downloading: the other languages' entries are
 * read and written back inside the same readwrite transaction, so IndexedDB's
 * transaction serialization prevents a lost update. `update` must be
 * synchronous — an `await` inside it would end the transaction.
 *
 * Returns the normalized next state for the language.
 */
export async function updateProjectionState(
  userId: string,
  languageCode: string,
  update: (current: ProjectionState) => ProjectionState,
): Promise<ProjectionState> {
  const key = projectionStateKey(userId)
  const db = await openLocalDatabase()

  return new Promise<ProjectionState>((resolve, reject) => {
    const transaction = db.transaction(STORES.documentMeta, 'readwrite')
    const store = transaction.objectStore(STORES.documentMeta)
    const getReq = store.get(key)
    let next: ProjectionState | undefined
    let failure: unknown

    getReq.onsuccess = () => {
      try {
        const state = parseStoredState(getReq.result, userId)
        const current = normalizeForLanguage(state[languageCode], languageCode)
        next = normalizeForLanguage(update(current), languageCode)
        state[languageCode] = next
        store.put({
          documentId: key,
          version: PROJECTION_STATE_VERSION,
          state,
        })
      } catch (error) {
        failure = error
        transaction.abort()
      }
    }
    getReq.onerror = () => {}

    transaction.oncomplete = () => {
      if (next === undefined) {
        reject(new Error('projection state transaction completed without an update'))
        return
      }
      resolve(next)
    }
    transaction.onerror = () => {}
    transaction.onabort = () =>
      reject(failure ?? transaction.error ?? new Error('projection state update was aborted'))
  })
}

/**
 * Records an event-driven pause (offline/error) for resumable languages.
 *
 * Only a language that already started a full pass (`snapshot !== null`) and
 * is still unfinished gets the marker. A brand-new language that has not read
 * its first page is "not downloaded yet", not "paused". An existing quota or
 * byte pause is more specific and is left untouched.
 */
export async function markProjectionFailure(
  userId: string,
  reason: 'offline' | 'error',
): Promise<void> {
  const states = await readProjectionState(userId)
  const pausedAt = new Date().toISOString()
  for (const [languageCode, state] of Object.entries(states)) {
    if (state.complete || state.snapshot === null || state.pause !== undefined) continue
    await updateProjectionState(userId, languageCode, (current) => {
      if (current.complete || current.snapshot === null || current.pause !== undefined) {
        return current
      }
      return {
        ...current,
        pause: {
          reason,
          pausedAt,
          nextAttemptAt: null,
          quotaBucket: null,
          retryAfterSeconds: null,
        },
      }
    })
  }
}

/**
 * The state of one language, defaulting to incomplete.
 *
 * Reading through this helper is what turns an absent map (R2, a new account,
 * or a newly enrolled language) into the expected "not downloaded yet" state
 * instead of `undefined`.
 */
export function projectionStateFor(
  state: ProjectionStateMap,
  languageCode: string,
): ProjectionState {
  const entry = state[languageCode]
  if (entry === undefined) return emptyProjectionState()
  return normalizeForLanguage(entry, languageCode)
}
