/**
 * Lazy local document content (IndexedDB v7).
 *
 * R3 stops downloading document bodies with the document list. A document row
 * carries metadata (`charCount`, version stamps); its `raw_text` is fetched the
 * first time the document is opened and kept here, so reopening is offline and
 * costs no request.
 *
 * A content row is a disposable device-local copy of server text. Writing or
 * clearing one never bumps the local sync revision, never adds a pending count
 * or dirty key, and never emits a local-write signal (the store is not part of
 * `SYNCED_STORES`). Losing it only means the next open fetches again.
 */

import { STORES, idbDelete, idbGet, idbPut } from './localDb'

/** The part of a document payload this store keeps. */
export type DocumentContentPayload = {
  rawText: string
  /** Server watermark of the text; a change means the copy is stale. */
  contentUpdatedAt: string | null
  /** Server watermark of the occurrence rows; not used to refetch text. */
  occurrencesUpdatedAt: string | null
}

/** One stored document text. */
export type DocumentContentRecord = DocumentContentPayload & {
  documentId: string
}

/** The stored text for a document, or undefined when it was never loaded. */
export function readDocumentContent(documentId: string): Promise<DocumentContentRecord | undefined> {
  return idbGet<DocumentContentRecord>(STORES.documentContent, documentId)
}

/**
 * Stores a freshly fetched document text, replacing any older copy.
 *
 * Callers pass the version stamps that came with the text: they are what a
 * later open compares to decide whether the copy is still current.
 */
export async function putDocumentContent(
  documentId: string,
  payload: DocumentContentPayload,
): Promise<DocumentContentRecord> {
  if (typeof documentId !== 'string' || documentId === '') {
    throw new Error('document content needs a documentId')
  }
  if (typeof payload.rawText !== 'string') {
    throw new Error('document content needs rawText')
  }

  const record: DocumentContentRecord = {
    documentId,
    rawText: payload.rawText,
    contentUpdatedAt: payload.contentUpdatedAt ?? null,
    occurrencesUpdatedAt: payload.occurrencesUpdatedAt ?? null,
  }
  await idbPut(STORES.documentContent, record)
  return record
}

/**
 * Drops the stored text of one document.
 *
 * Used when a document is deleted or its text must be fetched again; the
 * metadata row itself is untouched.
 */
export async function clearDocumentContent(documentId: string): Promise<void> {
  await idbDelete(STORES.documentContent, documentId)
}
