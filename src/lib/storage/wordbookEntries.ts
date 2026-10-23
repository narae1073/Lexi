/**
 * Local wordbook projection read model (IndexedDB v7).
 *
 * The server owns `wordbook_entries`: one derived row per `(language, lemma)`
 * with counts, contexts, and the state fields a device needs to render the
 * wordbook offline. This module stores that projection on the device so the
 * wordbook no longer depends on every occurrence row being present.
 *
 * These rows are a device-local copy of derived data, not learning data:
 * writing or deleting them never bumps the local sync revision, never adds a
 * pending count or dirty key, and never emits a local-write signal (the store
 * is not part of `SYNCED_STORES`).
 *
 * ## Applying server pages (Task 8)
 *
 * - Use {@link mergeWordbookEntries} for projection pulls — never the plain
 *   {@link putWordbookEntries}. The merge reads the dirty word-state journal
 *   and writes the page **in one transaction**, so a local edit can land before
 *   the page (the merge sees it and skips the key) or after it (the edit's own
 *   projection update wins). Splitting the check from the write reopens the
 *   read-check-write race that silently reverts local edits.
 * - Hydrate local word states only for the keys the merge did not skip, and do
 *   that in its own transaction that re-checks the dirty journal (or before the
 *   merge). `skipped` describes the journal at merge time, not later.
 * - Before a manual full resync, call {@link clearWordbookEntries} for the
 *   language: full pages exclude soft-deleted rows, so rows absent from the new
 *   page can only be removed by clearing first. Serializing full and
 *   incremental pulls per language is also Task 8's obligation; a delayed full
 *   page must never be applied after an incremental page.
 * - A full resync is only clean while no local word state is dirty for that
 *   language: a cleared key with a dirty state is skipped by the merge (there is
 *   no local row to protect, but writing the server's state fields would revert
 *   the edit). Run manual resyncs after pending edits are pushed, or have
 *   Task 8 re-seed those entries from the local word state.
 *
 * ## Local-only mode (Task 11)
 *
 * Local mode has no server page to merge, so it uses
 * {@link putWordbookEntries} to produce the same record shape directly from
 * local rows.
 */

import type { WordStatus } from '../../types'
import {
  STORES,
  SYNC_META_KEY,
  idbDelete,
  idbDeleteByIndex,
  idbGetAllByIndex,
  normalizeLocalSyncMeta,
  openLocalDatabase,
  wordStateDirtyKey,
} from './localDb'

/** One sentence where the lemma appeared, tied to the document it came from. */
export type WordbookEntryContext = {
  documentId: string
  sentence: string
}

/**
 * One projection row as stored on this device.
 *
 * Mirrors the server projection in local camelCase, dropping `user_id` (the
 * database itself belongs to one account) and `deleted_at` (a soft-deleted row
 * removes the local entry instead of being stored).
 */
export type WordbookEntryRecord = {
  languageCode: string
  lemma: string
  surfaces: string[]
  contexts: WordbookEntryContext[]
  occurrenceCount: number
  documentCount: number
  status: WordStatus | null
  isFavorite: boolean
  starAngle: number
  starColor: string
  seenCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  favoriteUpdatedAt: string | null
  knownPresses: number
  unsurePresses: number
  unknownPresses: number
  note: string | null
  noteUpdatedAt: string | null
  /** Server watermark of this row; lets a later merge tell newer from older. */
  serverUpdatedAt: string | null
}

/**
 * A row handed to {@link putWordbookEntries} or {@link mergeWordbookEntries}.
 *
 * `deletedAt` is the server's soft-deletion watermark. The server keeps the
 * row so an incremental pull can propagate the removal; locally it means
 * "delete the entry", never "store a deleted entry". A deletion is applied
 * even when the key has a dirty local word state: the word no longer occurs in
 * any document, so the projection row is gone regardless of the edit.
 */
export type WordbookEntryInput = WordbookEntryRecord & {
  deletedAt?: string | null
}

/** The composite identity of one projection entry. */
export type WordbookEntryKey = {
  languageCode: string
  lemma: string
}

/** What one page did, in the terms Task 8 needs for hydration. */
export type WordbookMergeResult = {
  /** Live rows stored. */
  written: number
  /** Rows removed because the server soft-deleted them. */
  deleted: number
  /** Rows kept untouched because a dirty local word state owns the key. */
  skipped: WordbookEntryKey[]
}

type PageResult = WordbookMergeResult

/**
 * All live entries for one language.
 *
 * Reads through the `languageCode` index, so a language with 100k entries
 * does not scan the other languages. Ordering is not part of the contract:
 * the wordbook sorts and searches in its worker (Task 10).
 */
export function readWordbookEntries(languageCode: string): Promise<WordbookEntryRecord[]> {
  return idbGetAllByIndex<WordbookEntryRecord>(
    STORES.wordbookEntries,
    'languageCode',
    languageCode,
  )
}

/**
 * Stores rows without any dirty-key guard, in one transaction.
 *
 * Use this for local-only construction and tests. A projection pull must use
 * {@link mergeWordbookEntries}: this function would overwrite a key whose local
 * word state has not been pushed yet.
 *
 * Resolves with the number of live rows written (deletions are not counted).
 */
export async function putWordbookEntries(
  rows: readonly WordbookEntryInput[],
): Promise<number> {
  validateRows(rows)
  if (rows.length === 0) return 0

  const db = await openLocalDatabase()
  return new Promise<number>((resolve, reject) => {
    const transaction = db.transaction(STORES.wordbookEntries, 'readwrite')
    const store = transaction.objectStore(STORES.wordbookEntries)
    let result: PageResult
    try {
      result = writePage(store, rows, () => false)
    } catch (error) {
      // writePage already aborted the transaction — nothing from this page
      // may commit.
      reject(error)
      return
    }

    transaction.oncomplete = () => resolve(result.written)
    // A failed request aborts the transaction on its own — onabort rejects
    transaction.onerror = () => {}
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('wordbook projection write was aborted'))
  })
}

/**
 * Applies one projection page while protecting dirty local word states.
 *
 * The dirty journal (`documentMeta`) and the projection rows are read/written
 * in the **same** readwrite transaction. Because a local word-state edit also
 * writes `documentMeta` in its transaction, the two serialize: the merge either
 * sees the dirty key (and skips it) or the edit lands afterwards and its own
 * projection update wins. There is no window between the check and the write.
 *
 * Returns the keys it skipped so the caller can leave their word states alone.
 */
export async function mergeWordbookEntries(
  rows: readonly WordbookEntryInput[],
): Promise<WordbookMergeResult> {
  validateRows(rows)
  if (rows.length === 0) return { written: 0, deleted: 0, skipped: [] }

  const db = await openLocalDatabase()
  return new Promise<WordbookMergeResult>((resolve, reject) => {
    const transaction = db.transaction(
      [STORES.documentMeta, STORES.wordbookEntries],
      'readwrite',
    )
    const metaStore = transaction.objectStore(STORES.documentMeta)
    const store = transaction.objectStore(STORES.wordbookEntries)

    let result: WordbookMergeResult | undefined
    let failure: unknown

    const metaRequest = metaStore.get(SYNC_META_KEY)
    metaRequest.onsuccess = () => {
      const meta = normalizeLocalSyncMeta(metaRequest.result)
      const dirtyStates = meta?.dirty[STORES.wordStates] ?? {}
      try {
        result = writePage(store, rows, (row) => {
          const key = wordStateDirtyKey(row.languageCode, row.lemma)
          return dirtyStates[key] !== undefined
        })
      } catch (error) {
        // writePage aborted the transaction; reject once it aborts.
        failure = error
      }
    }
    // A failed request aborts the transaction on its own — onabort rejects
    metaRequest.onerror = () => {}

    transaction.oncomplete = () => {
      if (failure !== undefined) {
        reject(failure)
        return
      }
      if (result === undefined) {
        reject(new Error('wordbook projection merge did not complete'))
        return
      }
      resolve(result)
    }
    transaction.onerror = () => {}
    transaction.onabort = () =>
      reject(
        failure ?? transaction.error ?? new Error('wordbook projection merge was aborted'),
      )
  })
}

/**
 * Removes every entry of one language in a single transaction.
 *
 * **Task 8 obligation:** call this before applying a manual full resync. A full
 * projection page contains live rows only, so it cannot express "this row is
 * gone" — without a clear, entries the new full page omits (soft-deleted
 * elsewhere) would survive as phantoms.
 */
export async function clearWordbookEntries(languageCode: string): Promise<void> {
  await idbDeleteByIndex(STORES.wordbookEntries, 'languageCode', languageCode)
}

/** Removes one entry, for example when the server reports it soft-deleted. */
export async function deleteWordbookEntry(languageCode: string, lemma: string): Promise<void> {
  await idbDelete(STORES.wordbookEntries, [languageCode, lemma])
}

/**
 * Applies a page inside an existing transaction.
 *
 * All-or-nothing: a synchronous `put` failure (unkeyable value, unclonable
 * value) aborts the transaction so previously written rows of the page cannot
 * commit while the rest are lost.
 */
function writePage(
  store: IDBObjectStore,
  rows: readonly WordbookEntryInput[],
  isProtected: (row: WordbookEntryRecord) => boolean,
): PageResult {
  const result: PageResult = { written: 0, deleted: 0, skipped: [] }
  try {
    for (const row of rows) {
      const { deletedAt, ...record } = row
      if (deletedAt) {
        store.delete([record.languageCode, record.lemma])
        result.deleted += 1
        continue
      }
      if (isProtected(record)) {
        result.skipped.push({ languageCode: record.languageCode, lemma: record.lemma })
        continue
      }
      store.put(record)
      result.written += 1
    }
  } catch (error) {
    try {
      store.transaction.abort()
    } catch {
      // The transaction may already be aborting; the original error is the
      // one the caller must see.
    }
    throw error
  }
  return result
}

/** Rejects a page that cannot be applied before any transaction opens. */
function validateRows(rows: readonly WordbookEntryInput[]): void {
  for (const row of rows) {
    if (typeof row.languageCode !== 'string' || row.languageCode === '') {
      throw new Error('wordbook entry has no languageCode and cannot be keyed')
    }
    if (typeof row.lemma !== 'string' || row.lemma === '') {
      throw new Error('wordbook entry has no lemma and cannot be keyed')
    }
  }
}
