import { STORES, idbGet, idbPut } from '../storage/localDb'

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
 *   - Anything unreadable is read as "incomplete" rather than resumed. A full
 *     re-pull is idempotent; resuming from a half-written cursor is not.
 */

export type ProjectionCursor = { languageCode: string; lemma: string }

export type ProjectionState = {
  complete: boolean
  snapshot: string | null
  cursor: ProjectionCursor | null
  hydratedAt: string | null
}

export type ProjectionStateMap = Record<string, ProjectionState>

/**
 * `documentId` prefix of the reserved per-account record. The rest is the
 * account id so two accounts on one device never share a cursor.
 */
export const PROJECTION_STATE_KEY_PREFIX = '__lexi_projection_state__:'

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

/**
 * One language's state, or the incomplete default when the stored value is not
 * a usable record. `complete` is only true when it was stored as a boolean
 * true; a truthy string cannot mark a language complete.
 */
function normalizeProjectionState(value: unknown): ProjectionState {
  if (!isRecord(value)) return emptyProjectionState()

  const snapshot = isTimestamp(value.snapshot) ? value.snapshot : null
  const cursor = normalizeCursor(value.cursor)
  // The cursor is only meaningful under the snapshot it was produced from.
  if (snapshot === null) {
    return { complete: false, snapshot: null, cursor: null, hydratedAt: null }
  }

  return {
    complete: value.complete === true,
    snapshot,
    cursor,
    hydratedAt: isTimestamp(value.hydratedAt) ? value.hydratedAt : null,
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

/**
 * Reads every language's projection state for one account.
 *
 * A missing or unreadable record yields `{}`; callers treat every language as
 * incomplete, which is exactly the R2 upgrade path.
 */
export async function readProjectionState(userId: string): Promise<ProjectionStateMap> {
  const stored = await idbGet<unknown>(STORES.documentMeta, projectionStateKey(userId))
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
 * Replaces one account's projection state map.
 *
 * `documentMeta` is a device-local store, so this write does not bump the sync
 * revision, create a dirty key, or signal a local user write. Callers pass the
 * whole map: snapshot, cursor, and completeness are persisted atomically with
 * respect to the other languages.
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
