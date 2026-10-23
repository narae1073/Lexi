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
 */

import type { WordStatus } from '../../types'
import { STORES, idbDelete, idbGetAllByIndex, openLocalDatabase } from './localDb'

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
 * A row handed to {@link putWordbookEntries}.
 *
 * `deletedAt` is the server's soft-deletion watermark. The server keeps the
 * row so an incremental pull can propagate the removal; locally it means
 * "delete the entry", never "store a deleted entry".
 */
export type WordbookEntryInput = WordbookEntryRecord & {
  deletedAt?: string | null
}

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
 * Applies one page of projection rows in a single transaction.
 *
 * Upserts live rows by `(languageCode, lemma)` and removes rows the server
 * marked deleted, so a page can express "changed" and "gone" together. The
 * whole page is validated before the transaction opens: a row that cannot be
 * keyed rejects the call instead of leaving a half-applied page.
 *
 * Resolves with the number of live rows written (deletions are not counted).
 */
export async function putWordbookEntries(
  rows: readonly WordbookEntryInput[],
): Promise<number> {
  if (rows.length === 0) return 0
  for (const row of rows) {
    if (typeof row.languageCode !== 'string' || row.languageCode === '') {
      throw new Error('wordbook entry has no languageCode and cannot be keyed')
    }
    if (typeof row.lemma !== 'string' || row.lemma === '') {
      throw new Error('wordbook entry has no lemma and cannot be keyed')
    }
  }

  const db = await openLocalDatabase()
  return new Promise<number>((resolve, reject) => {
    const transaction = db.transaction(STORES.wordbookEntries, 'readwrite')
    const store = transaction.objectStore(STORES.wordbookEntries)
    let written = 0

    for (const row of rows) {
      // Never store the soft-deletion marker: a deleted entry must not linger
      // as a phantom word in the wordbook.
      const { deletedAt, ...record } = row
      if (deletedAt) {
        store.delete([record.languageCode, record.lemma])
        continue
      }
      store.put(record)
      written += 1
    }

    transaction.oncomplete = () => resolve(written)
    // A failed request aborts the transaction on its own — onabort rejects
    transaction.onerror = () => {}
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('wordbook projection write was aborted'))
  })
}

/** Removes one entry, for example when the server reports it soft-deleted. */
export async function deleteWordbookEntry(languageCode: string, lemma: string): Promise<void> {
  await idbDelete(STORES.wordbookEntries, [languageCode, lemma])
}
