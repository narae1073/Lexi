import type { WordOccurrence } from '../../app/stores/occurrences'
import type { Document, Folder } from '../../types'
import type { DocumentTombstone } from '../storage/purged'
import {
  STORES,
  SYNC_META_KEY,
  normalizeLocalSyncMeta,
  openLocalDatabase,
  type StoreName,
} from '../storage/localDb'
import {
  mergeDocuments,
  mergeFolders,
  mergeTombstones,
  mergeWordStates,
  normalizeWordState,
  type StoredWordState,
  type WordStateRecord,
} from './merge'

/**
 * Content key for one occurrence row.
 *
 * The whole content matters, not just the lemma: a sentence, position, or
 * count can change while the word stays in the same place. `surfaces` are
 * expanded by the caller, one key per surface.
 */
export function occurrenceContentKey(
  lemma: string,
  surface: string,
  charStart: number,
  charEnd: number,
  sentence: string,
  count: number,
): string {
  return `${lemma}\u0000${surface}\u0000${charStart}\u0000${charEnd}\u0000${sentence}\u0000${count}`
}

function occurrenceKeysByDocument(
  records: readonly WordOccurrence[],
): Map<string, Set<string>> {
  const byDocument = new Map<string, Set<string>>()
  for (const record of records) {
    const keys = byDocument.get(record.documentId) ?? new Set<string>()
    for (const surface of record.surfaces) {
      keys.add(
        occurrenceContentKey(
          record.lemma,
          surface,
          record.charStart,
          record.charEnd,
          record.sentence,
          record.count,
        ),
      )
    }
    byDocument.set(record.documentId, keys)
  }
  return byDocument
}

function sameOccurrenceKeys(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): boolean {
  const leftSize = left?.size ?? 0
  const rightSize = right?.size ?? 0
  if (leftSize !== rightSize) return false
  if (left === undefined) return true
  for (const key of left) {
    if (right === undefined || !right.has(key)) return false
  }
  return true
}

/**
 * Documents whose occurrence rows actually differ between the merge result and
 * the local snapshot.
 *
 * A sync plans from a read taken before the write transaction. The merge result
 * still names every document it touched, but most of them are unchanged — a
 * no-change sync, or an overlap re-read of a document that was only opened,
 * would otherwise rewrite rows that are already correct. The write set is the
 * difference, per document, over the full row content.
 *
 * A document whose local rows exist and whose merged rows are gone is included
 * with no merged rows: the caller clears it instead of leaving stale keys.
 */
export function changedLocalOccurrenceDocuments(
  merged: readonly WordOccurrence[],
  local: readonly WordOccurrence[],
  onlyDocumentIds?: ReadonlySet<string>,
): string[] {
  const mergedKeys = occurrenceKeysByDocument(merged)
  const localKeys = occurrenceKeysByDocument(local)
  const documentIds = new Set([...mergedKeys.keys(), ...localKeys.keys()])

  const changed: string[] = []
  for (const documentId of documentIds) {
    if (onlyDocumentIds !== undefined && !onlyDocumentIds.has(documentId)) continue
    if (sameOccurrenceKeys(mergedKeys.get(documentId), localKeys.get(documentId))) continue
    changed.push(documentId)
  }
  return changed
}

export type WriteLocalOptions = {
  /** Document ids whose occurrence rows must be replaced, including empty lists. */
  occurrenceDocumentIds: ReadonlySet<string>
  /** The revision captured before planning; if it changed, skip occurrence writes. */
  expectedRevision?: number
}

export type WriteLocalResult = {
  documents: number
  folders: number
  wordStates: number
  tombstones: number
  occurrences: number
}

const WRITE_STORES: StoreName[] = [
  STORES.documents,
  STORES.folders,
  STORES.wordStates,
  STORES.wordOccurrences,
  STORES.documentTombstones,
  STORES.documentMeta,
]

/**
 * Stable JSON for equality checks.
 *
 * Object key order depends on how a row was built (a merge result and a stored
 * row can hold the same values in a different order), so a plain
 * `JSON.stringify` comparison would report a change that is not there. Values
 * `undefined` are dropped exactly as JSON would drop them.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? 'null' : canonicalJson(item)))
      .join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

/** Old document rows have no folder stamp — read them the way `readLocal` does. */
function normalizedDocument(doc: Document): Document {
  return {
    ...doc,
    folderId: doc.folderId ?? null,
    folderUpdatedAt: doc.folderUpdatedAt ?? doc.updatedAt,
  }
}

function groupOccurrences(occurrences: WordOccurrence[]): Map<string, WordOccurrence[]> {
  const byDocument = new Map<string, WordOccurrence[]>()
  for (const record of occurrences) {
    const list = byDocument.get(record.documentId)
    if (list) list.push(record)
    else byDocument.set(record.documentId, [record])
  }
  return byDocument
}

/**
 * Writes a merge result back to the local database, one transaction.
 *
 * **Every incoming row is merged with the row that is stored right now.** A
 * sync plans from a read taken earlier; a user write may have landed since.
 * Writing the plan straight back would quietly restore the old values, so the
 * newest write is kept and only a genuine change is stored.
 *
 * Everything happens in ONE readwrite transaction: the stored rows, the
 * occurrence replacement, and the reserved sync-meta revision all live in the
 * same snapshot. User writes serialize against this transaction, so there is no
 * read-check-then-write window for them to slip through.
 *
 * The write is silent — received rows are not local changes, so nothing is
 * notified and no revision is bumped.
 */
export async function writeLocal(
  documents: Document[],
  wordStates: WordStateRecord[],
  occurrences: WordOccurrence[],
  folders: Folder[],
  tombstones: DocumentTombstone[] = [],
  options: WriteLocalOptions,
): Promise<WriteLocalResult> {
  const db = await openLocalDatabase()
  const result: WriteLocalResult = {
    documents: 0,
    folders: 0,
    wordStates: 0,
    tombstones: 0,
    occurrences: 0,
  }
  const occurrenceRows = groupOccurrences(occurrences)
  const tombstoneIds = new Set(tombstones.map((tombstone) => tombstone.documentId))

  return new Promise<WriteLocalResult>((resolve, reject) => {
    const transaction = db.transaction(WRITE_STORES, 'readwrite')
    const documentsStore = transaction.objectStore(STORES.documents)
    const foldersStore = transaction.objectStore(STORES.folders)
    const wordStatesStore = transaction.objectStore(STORES.wordStates)
    const occurrencesStore = transaction.objectStore(STORES.wordOccurrences)
    const tombstonesStore = transaction.objectStore(STORES.documentTombstones)
    const metaStore = transaction.objectStore(STORES.documentMeta)

    let revisionReady = false
    let revisionMatches = options.expectedRevision === undefined
    const afterRevision: Array<() => void> = []
    const whenRevisionReady = (run: () => void) => {
      if (revisionReady) run()
      else afterRevision.push(run)
    }

    /** Replaces every occurrence row of one document; an empty list clears them. */
    const replaceOccurrences = (documentId: string, rows: WordOccurrence[]) => {
      const cursorReq = occurrencesStore
        .index('documentId')
        .openCursor(IDBKeyRange.only(documentId))
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
          return
        }
        for (const row of rows) occurrencesStore.put(row)
        result.occurrences += 1
      }
      // A failed request aborts the transaction on its own — onabort rejects
      cursorReq.onerror = () => {}
    }

    /**
     * Read the revision first: occurrence replacement must not clobber rows a
     * user recomputed while this sync was planning.
     */
    const metaReq = metaStore.get(SYNC_META_KEY)
    metaReq.onsuccess = () => {
      const revision = normalizeLocalSyncMeta(metaReq.result)?.revision ?? 0
      revisionReady = true
      revisionMatches =
        options.expectedRevision === undefined || options.expectedRevision === revision

      for (const run of afterRevision.splice(0)) run()
      if (!revisionMatches) return

      for (const documentId of options.occurrenceDocumentIds) {
        // Tombstones clear their own document below; replacing twice is waste.
        if (tombstoneIds.has(documentId)) continue
        replaceOccurrences(documentId, occurrenceRows.get(documentId) ?? [])
      }
    }
    metaReq.onerror = () => {}

    for (const doc of documents) {
      // A tombstone wins over any document row in the same plan.
      if (tombstoneIds.has(doc.id)) continue
      const getReq = documentsStore.get(doc.id)
      getReq.onsuccess = () => {
        const stored = getReq.result as Document | undefined
        if (stored === undefined) {
          documentsStore.put(doc)
          result.documents += 1
          return
        }
        const storedView = normalizedDocument(stored)
        const merged = mergeDocuments([storedView], [doc])[0]
        if (sameValue(merged, storedView)) return
        documentsStore.put(merged)
        result.documents += 1
      }
      getReq.onerror = () => {}
    }

    for (const folder of folders) {
      const getReq = foldersStore.get(folder.id)
      getReq.onsuccess = () => {
        const stored = getReq.result as Folder | undefined
        const merged =
          stored === undefined ? folder : mergeFolders([stored], [folder])[0]
        if (stored !== undefined && sameValue(merged, stored)) return
        foldersStore.put(merged)
        result.folders += 1
      }
      getReq.onerror = () => {}
    }

    for (const state of wordStates) {
      const key = [state.languageCode, state.lemma]
      const getReq = wordStatesStore.get(key)
      getReq.onsuccess = () => {
        const stored = getReq.result as StoredWordState | undefined
        const storedView = stored === undefined ? undefined : normalizeWordState(stored)
        const incoming = normalizeWordState(state)
        const merged =
          storedView === undefined
            ? incoming
            : mergeWordStates([storedView], [incoming]).merged[0]
        if (storedView !== undefined && sameValue(merged, storedView)) return
        wordStatesStore.put(merged)
        result.wordStates += 1
      }
      getReq.onerror = () => {}
    }

    for (const tombstone of tombstones) {
      const getReq = tombstonesStore.get(tombstone.documentId)
      getReq.onsuccess = () => {
        const stored = getReq.result as DocumentTombstone | undefined
        // Deletion cannot be undone — the earliest purge wins.
        const merged =
          stored === undefined ? tombstone : mergeTombstones([stored], [tombstone])[0]
        if (stored === undefined || !sameValue(merged, stored)) {
          tombstonesStore.put(merged)
          result.tombstones += 1
        }

        // The tombstone wins over any document row.
        documentsStore.delete(tombstone.documentId)
        if (tombstone.documentId !== SYNC_META_KEY) {
          metaStore.delete(tombstone.documentId)
        }
        whenRevisionReady(() => {
          if (!revisionMatches) return
          replaceOccurrences(tombstone.documentId, [])
        })
      }
      getReq.onerror = () => {}
    }

    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => {
      // onabort follows with the error — do not reject twice here
    }
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('로컬 데이터베이스 트랜잭션이 중단되었습니다'))
  })
}
