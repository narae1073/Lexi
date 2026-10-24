import {
  STORES,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  openLocalDatabase,
} from './localDb'
import type { WordStatus } from '../../types'

export const WORD_STATE_EVENT_PREFIX = '__lexi_word_state_event__:'
const WORD_STATE_BASELINE_PREFIX = '__lexi_word_state_baseline__:'

export type WordStateEventSource = 'quiz' | 'reader' | 'wordbook' | 'sync' | 'baseline'

/**
 * One effective status change. Stored as a reserved `documentMeta` row so the
 * local database does not need a v8 upgrade.
 *
 * The shape deliberately maps one-to-one to a future append-only server table:
 * only `user_id` is added on promotion.
 */
export type WordStateEvent = {
  documentId: string
  version: 1
  id: string
  languageCode: string
  lemma: string
  oldStatus: WordStatus | null
  newStatus: WordStatus | null
  source: WordStateEventSource
  occurredAt: string
}

type BaselineMarker = {
  documentId: string
  version: 1
  languageCode: string
  occurredAt: string
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

function isEvent(row: unknown, languageCode?: string): row is WordStateEvent {
  if (typeof row !== 'object' || row === null) return false
  const value = row as Partial<WordStateEvent>
  return (
    typeof value.documentId === 'string' &&
    value.documentId.startsWith(WORD_STATE_EVENT_PREFIX) &&
    value.version === 1 &&
    typeof value.id === 'string' &&
    typeof value.languageCode === 'string' &&
    (languageCode === undefined || value.languageCode === languageCode) &&
    typeof value.lemma === 'string' &&
    typeof value.occurredAt === 'string'
  )
}

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A chart listener must not break a word-state write.
    }
  }
}

export function subscribeWordStateEvents(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function appendWordStateEvent(input: {
  languageCode: string
  lemma: string
  oldStatus: WordStatus | null
  newStatus: WordStatus | null
  source: WordStateEventSource
  occurredAt?: string
}): Promise<void> {
  if (input.oldStatus === input.newStatus) return
  const id = uuid()
  const event: WordStateEvent = {
    documentId: `${WORD_STATE_EVENT_PREFIX}${id}`,
    version: 1,
    id,
    languageCode: input.languageCode,
    lemma: input.lemma,
    oldStatus: input.oldStatus,
    newStatus: input.newStatus,
    source: input.source,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  }
  await idbPut(STORES.documentMeta, event)
  notify()
}

export async function readWordStateEvents(languageCode: string): Promise<WordStateEvent[]> {
  const rows = await idbGetAll<unknown>(STORES.documentMeta)
  return rows
    .filter((row): row is WordStateEvent => isEvent(row, languageCode))
    .sort((a, b) => {
      const byTime = Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id)
    })
}

/**
 * Seed one baseline event per currently marked word. The marker is stored in
 * the same local-only store; clearing site data removes both, so the graph
 * starts again from the reset point with the then-current word states.
 */
export async function ensureWordStateBaseline(
  languageCode: string,
  states: ReadonlyArray<{ lemma: string; status?: WordStatus }>,
  now = new Date().toISOString(),
): Promise<void> {
  const markerId = `${WORD_STATE_BASELINE_PREFIX}${languageCode}`
  if ((await idbGet(STORES.documentMeta, markerId)) !== undefined) return

  const baselineAt = new Date(Date.parse(now) - 1).toISOString()
  const rows: Array<WordStateEvent | BaselineMarker> = []
  for (const state of states) {
    if (state.status !== 'known' && state.status !== 'unsure' && state.status !== 'unknown') {
      continue
    }
    const id = uuid()
    rows.push({
      documentId: `${WORD_STATE_EVENT_PREFIX}${id}`,
      version: 1,
      id,
      languageCode,
      lemma: state.lemma,
      oldStatus: null,
      newStatus: state.status,
      source: 'baseline',
      occurredAt: baselineAt,
    })
  }
  rows.push({
    documentId: markerId,
    version: 1,
    languageCode,
    occurredAt: baselineAt,
  })

  const db = await openLocalDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORES.documentMeta, 'readwrite')
    const store = transaction.objectStore(STORES.documentMeta)
    for (const row of rows) store.put(row)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  notify()
}

/** The local store is deleted/reset wholesale; this is only for tests. */
export async function clearWordStateEvents(languageCode: string): Promise<void> {
  const rows = await idbGetAll<unknown>(STORES.documentMeta)
  for (const row of rows) {
    if (isEvent(row, languageCode)) {
      await idbDelete(STORES.documentMeta, row.documentId)
    }
  }
  await idbDelete(STORES.documentMeta, `${WORD_STATE_BASELINE_PREFIX}${languageCode}`)
}
