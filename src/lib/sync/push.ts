import type { SupabaseClient } from '@supabase/supabase-js'

import type { WordOccurrence } from '../../app/stores/occurrences'
import type { Document, Folder } from '../../types'
import {
  STORES,
  clearDirtyIfRevision,
  idbGet,
  idbGetAllByIndex,
  type StoreName,
} from '../storage/localDb'
import type { DocumentTombstone } from '../storage/purged'
import type { Database } from '../supabase/database.types'
import {
  documentMetadataToRow,
  documentTombstoneToRow,
  documentToRow,
  folderToRow,
  wordStateToRow,
} from './mapping'
import { normalizeWordState, type StoredWordState, type WordStateRecord } from './merge'
import type { DirtyKey, PushResult, PushTable, SyncFailure } from './types'

/**
 * Server push with per-table and per-row failure isolation.
 *
 * One rejected row must not hide the rest of the cycle: progress (`word_states`)
 * goes even when a document row is rejected, and a poison row inside a chunk is
 * isolated by retrying the chunk row by row. Nothing here throws for row or
 * table failures — the caller gets `failures` and advances only the tables that
 * fully succeeded.
 */

/** A table's local pending store; `languages` has none. */
export const PUSH_STORE_BY_TABLE: Partial<Record<PushTable, StoreName>> = {
  documents: 'documents',
  folders: 'folders',
  wordStates: 'wordStates',
  tombstones: 'documentTombstones',
  occurrences: 'wordOccurrences',
}

const PUSH_TABLE_BY_STORE: Partial<Record<StoreName, PushTable>> = {
  documents: 'documents',
  folders: 'folders',
  wordStates: 'wordStates',
  documentTombstones: 'tombstones',
  wordOccurrences: 'occurrences',
}

/** Dirty-key encoding for a word state, matching `localDb`'s journal. */
export function wordStatePushKey(
  record: Pick<WordStateRecord, 'languageCode' | 'lemma'>,
): string {
  return `${record.languageCode}\u0000${record.lemma}`
}

const WRITE_CHUNK = 500
const DOCUMENT_CHUNK = 100

/** One request's row count stays under the server body limit. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const parts: T[][] = []
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size))
  return parts
}

function uniqueRows<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const row of rows) {
    const key = keyOf(row)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  return unique
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

type SendResult = { error: { message: string } | null }

type Outcome = {
  failures: SyncFailure[]
  failedTables: Set<PushTable>
  succeededKeys: DirtyKey[]
  succeededStores: Set<StoreName>
  settledKeys: Set<string>
  pushedRows: number
}

function newOutcome(): Outcome {
  return {
    failures: [],
    failedTables: new Set(),
    succeededKeys: [],
    succeededStores: new Set(),
    settledKeys: new Set(),
    pushedRows: 0,
  }
}

type DirtyIndex = Map<PushTable, Map<string, DirtyKey>>

function indexDirtyKeys(dirtyKeys: readonly DirtyKey[] = []): DirtyIndex {
  const index: DirtyIndex = new Map()
  for (const dirty of dirtyKeys) {
    const table = PUSH_TABLE_BY_STORE[dirty.store]
    if (!table) continue
    let byKey = index.get(table)
    if (!byKey) {
      byKey = new Map()
      index.set(table, byKey)
    }
    byKey.set(dirty.key, dirty)
  }
  return index
}

/**
 * Records one row as sent. A dirty journal entry is cleared only at the exact
 * revision that was pushed — a newer write keeps its own entry.
 */
async function markSucceeded<T>(
  outcome: Outcome,
  rows: readonly T[],
  keyOf: (row: T) => string,
  dirtyByKey: Map<string, DirtyKey> | undefined,
): Promise<void> {
  outcome.pushedRows += rows.length
  if (!dirtyByKey) return

  const clears: Array<Promise<boolean>> = []
  for (const row of rows) {
    const dirty = dirtyByKey.get(keyOf(row))
    if (!dirty) continue
    const id = `${dirty.store}\u0000${dirty.key}\u0000${dirty.revision}`
    if (!outcome.settledKeys.has(id)) {
      outcome.settledKeys.add(id)
      outcome.succeededKeys.push(dirty)
    }
    clears.push(clearDirtyIfRevision(dirty.store, dirty.key, dirty.revision))
  }
  await Promise.all(clears)
}

function recordFailure(outcome: Outcome, table: PushTable, key: string, message: string): void {
  outcome.failedTables.add(table)
  outcome.failures.push({ table, key, message })
}

type RowPlan<T> = {
  table: PushTable
  rows: readonly T[]
  keyOf: (row: T) => string
  chunkSize: number
  send: (part: T[]) => PromiseLike<SendResult>
}

async function attempt<T>(plan: RowPlan<T>, part: T[]): Promise<string | null> {
  try {
    const { error } = await plan.send(part)
    return error === null ? null : error.message
  } catch (error) {
    return errorMessage(error)
  }
}

/**
 * Sends one table in chunks. A rejected chunk is retried row by row so one
 * poison row cannot take its chunk-mates down.
 */
async function pushPlan<T>(
  plan: RowPlan<T>,
  dirtyByKey: Map<string, DirtyKey> | undefined,
  outcome: Outcome,
): Promise<void> {
  for (const part of chunk(uniqueRows(plan.rows, plan.keyOf), plan.chunkSize)) {
    const chunkError = await attempt(plan, part)
    if (chunkError === null) {
      await markSucceeded(outcome, part, plan.keyOf, dirtyByKey)
      continue
    }

    if (part.length === 1) {
      recordFailure(outcome, plan.table, plan.keyOf(part[0]), chunkError)
      continue
    }

    for (const row of part) {
      const rowError = await attempt(plan, [row])
      if (rowError === null) {
        await markSucceeded(outcome, [row], plan.keyOf, dirtyByKey)
      } else {
        recordFailure(outcome, plan.table, plan.keyOf(row), rowError)
      }
    }
  }
}

export type PushInput = {
  userId: string
  db: SupabaseClient<Database>
  languages: string[]
  documents: Document[]
  words: WordStateRecord[]
  folders: Folder[]
  tombstones: DocumentTombstone[]
  /** Journal entries whose current rows are among the candidates. */
  dirtyKeys?: readonly DirtyKey[]
}

/**
 * Sends every table, isolating failures, and reports what fully went through.
 *
 * Order matters: tombstones first (a deletion must not be undone), then progress,
 * then folders before documents because a document's folder id is a foreign key.
 */
export async function push({
  userId,
  db,
  languages,
  documents,
  words,
  folders,
  tombstones,
  dirtyKeys = [],
}: PushInput): Promise<PushResult> {
  const outcome = newOutcome()
  const dirty = indexDirtyKeys(dirtyKeys)
  const dirtyFor = (table: PushTable) => dirty.get(table)

  // Tombstone upsert and the matching document delete are one logical push: if
  // either part fails, the tombstone stays pending and is retried.
  await pushPlan(
    {
      table: 'tombstones',
      rows: tombstones,
      keyOf: (tombstone) => tombstone.documentId,
      chunkSize: DOCUMENT_CHUNK,
      send: async (part) => {
        const { error } = await db
          .from('document_tombstones')
          .upsert(part.map((tombstone) => documentTombstoneToRow(userId, tombstone)), {
            onConflict: 'user_id,document_id',
          })
        if (error) return { error }
        return db
          .from('documents')
          .delete()
          .eq('user_id', userId)
          .in(
            'id',
            part.map((tombstone) => tombstone.documentId),
          )
      },
    },
    dirtyFor('tombstones'),
    outcome,
  )

  // Progress first — a failed document row must never hold it back.
  await pushPlan(
    {
      table: 'wordStates',
      rows: words,
      keyOf: wordStatePushKey,
      chunkSize: WRITE_CHUNK,
      send: (part) =>
        db.from('word_states').upsert(
          part.map((word) => wordStateToRow(userId, word)),
          { onConflict: 'user_id,language_code,lemma' },
        ),
    },
    dirtyFor('wordStates'),
    outcome,
  )

  // Folders before documents (foreign key).
  await pushPlan(
    {
      table: 'folders',
      rows: folders,
      keyOf: (folder) => folder.id,
      chunkSize: WRITE_CHUNK,
      send: (part) =>
        db.from('folders').upsert(
          part.map((folder) => folderToRow(userId, folder)),
          { onConflict: 'id' },
        ),
    },
    dirtyFor('folders'),
    outcome,
  )

  /**
   * Documents split by whether this device holds their text.
   *
   * A metadata-only row must never carry `raw_text`: an empty string would erase
   * the server's text for a document that was only renamed, moved, or trashed on
   * a device that never opened it. The metadata batch therefore omits the
   * column entirely and updates the row that already exists.
   */
  const documentsWithContent = documents.filter((doc) => doc.hasContent !== false)
  const metadataOnlyDocuments = documents.filter((doc) => doc.hasContent === false)

  await pushPlan(
    {
      table: 'documents',
      rows: documentsWithContent,
      keyOf: (doc) => doc.id,
      chunkSize: DOCUMENT_CHUNK,
      send: (part) =>
        db.from('documents').upsert(
          part.map((doc) => documentToRow(userId, doc)),
          { onConflict: 'id' },
        ),
    },
    dirtyFor('documents'),
    outcome,
  )

  await pushPlan(
    {
      table: 'documents',
      rows: metadataOnlyDocuments,
      keyOf: (doc) => doc.id,
      chunkSize: DOCUMENT_CHUNK,
      send: (part) =>
        db.from('documents').upsert(
          // The generated Insert type makes raw_text mandatory (a full row). A
          // metadata-only upsert deliberately omits it; PostgREST updates only
          // the keys it receives, so the existing text is left untouched.
          part.map(
            (doc) => documentMetadataToRow(userId, doc),
          ) as Database['public']['Tables']['documents']['Insert'][],
          { onConflict: 'id' },
        ),
    },
    dirtyFor('documents'),
    outcome,
  )

  await pushPlan(
    {
      table: 'languages',
      rows: languages,
      keyOf: (language) => language,
      chunkSize: WRITE_CHUNK,
      send: (part) =>
        db.from('user_languages').upsert(
          part.map((languageCode) => ({ user_id: userId, language_code: languageCode })),
          { onConflict: 'user_id,language_code', ignoreDuplicates: true },
        ),
    },
    undefined,
    outcome,
  )

  const succeeded = new Set<PushTable>()
  for (const table of ['tombstones', 'wordStates', 'folders', 'documents', 'languages'] as const) {
    if (outcome.failedTables.has(table)) continue
    succeeded.add(table)
    const store = PUSH_STORE_BY_TABLE[table]
    if (store !== undefined) outcome.succeededStores.add(store)
  }

  return {
    failures: outcome.failures,
    succeeded,
    succeededStores: outcome.succeededStores,
    succeededKeys: outcome.succeededKeys,
    pushedRows: outcome.pushedRows,
  }
}

/**
 * Replaces occurrence rows one document at a time. A failed document is
 * recorded and the loop continues; only a fully clean table advances.
 *
 * `onlyDocumentIds` is authoritative: a document listed there with no records
 * still sends `p_rows: []`, which clears its server rows. Only an omitted or
 * empty list means "nothing to do" — never skip a listed live document just
 * because `records` is empty.
 */
export async function pushOccurrences(
  _userId: string,
  records: WordOccurrence[],
  db: SupabaseClient<Database>,
  onlyDocumentIds?: readonly string[],
  dirtyKeys: readonly DirtyKey[] = [],
): Promise<PushResult> {
  const byDocument = new Map<string, WordOccurrence[]>()
  for (const record of records) {
    const list = byDocument.get(record.documentId)
    if (list) list.push(record)
    else byDocument.set(record.documentId, [record])
  }

  // An explicit list is the push plan: keep every listed document, including a
  // live one whose current row set is empty. Without a list, push what has rows.
  const documentIds = onlyDocumentIds
    ? [...new Set(onlyDocumentIds)]
    : [...byDocument.keys()]

  const dirtyByDocument = new Map<string, DirtyKey>()
  for (const dirty of dirtyKeys) {
    if (dirty.store === 'wordOccurrences') dirtyByDocument.set(dirty.key, dirty)
  }

  const failures: SyncFailure[] = []
  const succeededKeys: DirtyKey[] = []
  let pushedRows = 0

  for (const documentId of documentIds) {
    const local = byDocument.get(documentId) ?? []
    const rows = local.flatMap((record) =>
      record.surfaces.map((surface) => ({
        language_code: record.languageCode,
        lemma: record.lemma,
        surface,
        char_start: record.charStart,
        char_end: record.charEnd,
        sentence: record.sentence,
        occurrences_count: record.count,
      })),
    )

    try {
      const { error } = await db.rpc('replace_word_occurrences', {
        p_document_id: documentId,
        p_rows: rows,
      })
      if (error) throw error
      pushedRows += rows.length

      const dirty = dirtyByDocument.get(documentId)
      if (dirty) {
        succeededKeys.push(dirty)
        await clearDirtyIfRevision(dirty.store, dirty.key, dirty.revision)
      }
    } catch (error) {
      failures.push({ table: 'occurrences', key: documentId, message: errorMessage(error) })
    }
  }

  if (failures.length > 0) {
    return {
      failures,
      succeeded: new Set(),
      succeededStores: new Set(),
      succeededKeys,
      pushedRows,
    }
  }

  const store = PUSH_STORE_BY_TABLE.occurrences
  return {
    failures,
    succeeded: new Set<PushTable>(['occurrences']),
    succeededStores: new Set(store === undefined ? [] : [store]),
    succeededKeys,
    pushedRows,
  }
}

export type DirtyCandidates = {
  documents: Document[]
  folders: Folder[]
  words: WordStateRecord[]
  tombstones: DocumentTombstone[]
  occurrences: WordOccurrence[]
  occurrenceDocumentIds: string[]
  /** Keys whose row no longer exists — they are resolved without a push. */
  resolved: DirtyKey[]
}

export type DirtyCandidateContext = {
  /** Documents purged on either side; their server rows go with the tombstone. */
  tombstoneIds?: ReadonlySet<string>
}

/**
 * Loads the **current** local row for every dirty key.
 *
 * A key whose row was deleted (purged document, removed folder) is resolved:
 * there is nothing to send, so the journal entry can be cleared. The union with
 * timestamp-selected rows then makes a write that landed at/below the watermark
 * impossible to skip.
 *
 * Occurrence keys are the exception: an empty local row set on a live document
 * is still a meaningful push — "replace this document's occurrences with
 * nothing" — and must reach the server so stale rows disappear elsewhere. A
 * tombstoned document is resolved instead: the tombstone push deletes its
 * occurrence rows already.
 */
export async function loadDirtyCandidates(
  dirtyKeys: readonly DirtyKey[],
  { tombstoneIds = new Set<string>() }: DirtyCandidateContext = {},
): Promise<DirtyCandidates> {
  const documents: Document[] = []
  const folders: Folder[] = []
  const words: WordStateRecord[] = []
  const tombstones: DocumentTombstone[] = []
  const occurrences: WordOccurrence[] = []
  const occurrenceDocumentIds: string[] = []
  const resolved: DirtyKey[] = []
  const seen = new Set<string>()

  for (const dirty of dirtyKeys) {
    const id = `${dirty.store}\u0000${dirty.key}`
    if (seen.has(id)) continue
    seen.add(id)

    if (dirty.store === 'documents') {
      const row = await idbGet<Document>(STORES.documents, dirty.key)
      if (row === undefined) resolved.push(dirty)
      else documents.push(row)
      continue
    }

    if (dirty.store === 'folders') {
      const row = await idbGet<Folder>(STORES.folders, dirty.key)
      if (row === undefined) resolved.push(dirty)
      else folders.push(row)
      continue
    }

    if (dirty.store === 'wordStates') {
      const separator = dirty.key.indexOf('\u0000')
      if (separator < 0) {
        resolved.push(dirty)
        continue
      }
      const languageCode = dirty.key.slice(0, separator)
      const lemma = dirty.key.slice(separator + 1)
      const row = await idbGet<StoredWordState>(STORES.wordStates, [languageCode, lemma])
      if (row === undefined) resolved.push(dirty)
      else words.push(normalizeWordState(row))
      continue
    }

    if (dirty.store === 'wordOccurrences') {
      const rows = await idbGetAllByIndex<WordOccurrence>(
        STORES.wordOccurrences,
        'documentId',
        dirty.key,
      )
      if (rows.length > 0) {
        occurrences.push(...rows)
        occurrenceDocumentIds.push(dirty.key)
        continue
      }

      // No local rows. The push unit is the document, so an empty row set is
      // still a replace — but only when the document is live on this device.
      if (tombstoneIds.has(dirty.key)) {
        // The tombstone push deletes the server rows; nothing left to send.
        resolved.push(dirty)
        continue
      }
      const document = await idbGet<Document>(STORES.documents, dirty.key)
      if (document === undefined) {
        // Without a local document there is no evidence it is live, and an
        // empty replace would delete rows another device may still need.
        resolved.push(dirty)
        continue
      }
      occurrenceDocumentIds.push(dirty.key)
      continue
    }

    if (dirty.store === 'documentTombstones') {
      const row = await idbGet<DocumentTombstone>(STORES.documentTombstones, dirty.key)
      if (row === undefined) resolved.push(dirty)
      else tombstones.push(row)
    }
  }

  return {
    documents,
    folders,
    words,
    tombstones,
    occurrences,
    occurrenceDocumentIds,
    resolved,
  }
}
