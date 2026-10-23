import type { SupabaseClient } from '@supabase/supabase-js'

import type { WordOccurrence } from '../../app/stores/occurrences'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import type { Document, LanguageCode } from '../../types'
import {
  STORES,
  idbGet,
  idbGetAllByIndex,
  replaceOccurrences,
} from '../storage/localDb'
import {
  putDocumentContent,
  readDocumentContent,
  type DocumentContentRecord,
} from '../storage/documentContent'
import { supabase } from '../supabase/client'
import type { Database } from '../supabase/database.types'

/**
 * Lazy document content and open-time touch (R3, task 9).
 *
 * The list pull carries document metadata only. Opening a document resolves its
 * text from one of three places, in order:
 *
 *   1. the local `documentContent` copy, when its version still matches the
 *      document's `contentUpdatedAt` — reopening costs no request;
 *   2. the document row itself, for a document created on this device or an R2
 *      local row that has always held its text;
 *   3. the server, through `get_document_payload` (text + occurrences +
 *      versions). Above the 10 MB soft cap the response would be too large, so
 *      the text is read page by page with `get_document_content_page` instead.
 *
 * Paged text deliberately carries no occurrence rows. R3's decision for a
 * synced document is that the wordbook projection is authoritative: the
 * wordbook is one row per lemma and does not need a document's rows, and a
 * document whose occurrence payload crossed the cap keeps whatever rows the
 * incremental pull already delivered. There is no occurrence paging endpoint.
 * Task 10 owns showing per-document progress for such a document from the
 * projection instead of the local occurrence rows.
 *
 * Opening is not a content edit. Only `touch_document` is called: no document
 * upsert, no `raw_text` write, no occurrence recomputation. The payload's
 * occurrence rows are stored silently the first time a synced document's text
 * is fetched — unless this device already recomputed that document, in which
 * case the local computation is newer and must not be overwritten.
 */

/** Soft cap for one document's content/occurrence payload. */
export const DOCUMENT_PAYLOAD_BYTE_BUDGET = 10 * 1024 * 1024

/** Characters requested per paged content fetch (~1 MB in the worst UTF-8 case). */
export const DOCUMENT_CONTENT_PAGE_CHARS = 262_144

/** Guard against a server that never reports `done`. */
const MAX_CONTENT_PAGES = 10_000

/** Attempts per page: a failed page is retried from the same offset. */
const PAGE_ATTEMPTS = 2

/** One server occurrence row in the payload shape. */
export type DocumentPayloadOccurrence = {
  languageCode: LanguageCode
  lemma: string
  surface: string
  charStart: number
  charEnd: number
  sentence: string
  occurrencesCount: number
}

/** `get_document_payload` after shape normalization. */
export type DocumentPayload = {
  rawText: string
  contentUpdatedAt: string | null
  occurrencesUpdatedAt: string | null
  occurrences: DocumentPayloadOccurrence[]
}

/** One stored document text — the shape the reader needs. */
export type DocumentContent = DocumentContentRecord

/** A recoverable/unrecoverable content failure the reader can show. */
export class DocumentContentError extends Error {
  /** The user can retry the same action; nothing was stored. */
  readonly recoverable: boolean

  constructor(message: string, { recoverable = true, cause }: { recoverable?: boolean; cause?: unknown } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DocumentContentError'
    this.recoverable = recoverable
  }
}

export type OpenDocumentOptions = {
  document: Document
  /** Tests pass a stand-in; the app uses the configured client. */
  db?: SupabaseClient<Database>
  /** Injected for deterministic tests. */
  openedAt?: string
  /** Skip the server touch (content-only reads, tests). */
  touch?: boolean
  /** Ignore the local copy and fetch again. */
  force?: boolean
  /** Override the soft payload cap (tests only). */
  payloadByteBudget?: number
  /** Override the page size in characters (tests only). */
  pageChars?: number
}

export type OpenedDocument = {
  documentId: string
  rawText: string
  contentUpdatedAt: string | null
  occurrencesUpdatedAt: string | null
  /** True when this call fetched from the server. */
  fetched: boolean
  /** True when the text came through the paged path. */
  paged: boolean
  /** The open timestamp applied locally; null when no touch was requested. */
  lastOpenedAt: string | null
}

/** Rough serialized size, the same measure the pull budgets use. */
export function payloadBytes(value: unknown): number {
  const json = JSON.stringify(value)
  if (typeof Blob !== 'undefined') return new Blob([json]).size
  return new TextEncoder().encode(json).length
}

/**
 * Would a full payload cross the soft cap?
 *
 * UTF-8 can take four bytes per character, so a document is paged when even
 * that worst case is over the budget. A missing `charCount` (an old local row)
 * never pages: its text is already local.
 */
export function shouldPageDocument(
  document: Document,
  byteBudget: number = DOCUMENT_PAYLOAD_BYTE_BUDGET,
): boolean {
  if (typeof document.charCount !== 'number' || document.charCount <= 0) return false
  return document.charCount * 4 > byteBudget
}

/** Same instant, tolerating `+00:00` vs `.000Z`. Both null means "same". */
export function sameContentVersion(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left === right) return true
  if (left === null || left === undefined || right === null || right === undefined) return false
  const a = Date.parse(left)
  const b = Date.parse(right)
  return !Number.isNaN(a) && !Number.isNaN(b) && a === b
}

/** True when `right` is a strictly later version than `left`. */
function isNewerVersion(left: string | null | undefined, right: string | null | undefined): boolean {
  if (right === null || right === undefined) return false
  if (left === null || left === undefined) return true
  const a = Date.parse(left)
  const b = Date.parse(right)
  return !Number.isNaN(a) && !Number.isNaN(b) && b > a
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeOccurrence(value: unknown): DocumentPayloadOccurrence | null {
  const row = asRecord(value)
  if (row === null) return null
  const lemma = asString(row.lemma)
  const surface = asString(row.surface)
  if (lemma === '' || surface === '') return null
  return {
    languageCode: asString(row.languageCode ?? row.language_code) as LanguageCode,
    lemma,
    surface,
    charStart: asNumber(row.charStart ?? row.char_start),
    charEnd: asNumber(row.charEnd ?? row.char_end),
    sentence: asString(row.sentence),
    occurrencesCount: Math.max(asNumber(row.occurrencesCount ?? row.occurrences_count, 1), 1),
  }
}

/** The payload as the reader uses it, whatever JSON shape the server returned. */
export function normalizeDocumentPayload(value: unknown): DocumentPayload | null {
  const row = asRecord(value)
  if (row === null) return null
  if (typeof row.rawText !== 'string') return null
  const occurrences = Array.isArray(row.occurrences)
    ? row.occurrences
        .map(normalizeOccurrence)
        .filter((occurrence): occurrence is DocumentPayloadOccurrence => occurrence !== null)
    : []
  return {
    rawText: row.rawText,
    contentUpdatedAt: typeof row.contentUpdatedAt === 'string' ? row.contentUpdatedAt : null,
    occurrencesUpdatedAt:
      typeof row.occurrencesUpdatedAt === 'string' ? row.occurrencesUpdatedAt : null,
    occurrences,
  }
}

/** Reads one document's full payload; null when it is missing or not owned. */
export async function fetchDocumentPayload(
  db: SupabaseClient<Database>,
  documentId: string,
): Promise<DocumentPayload | null> {
  try {
    const { data, error } = await db.rpc('get_document_payload', {
      p_document_id: documentId,
    })
    if (error) throw new DocumentContentError(error.message)
    return normalizeDocumentPayload(data)
  } catch (error) {
    if (error instanceof DocumentContentError) throw error
    throw new DocumentContentError('문서 본문을 받지 못했습니다', { cause: error })
  }
}

/** One page of document text. */
export type DocumentContentPage = {
  rawText: string
  contentUpdatedAt: string | null
  charCount: number
  nextOffset: number
  done: boolean
}

function normalizeContentPage(value: unknown): DocumentContentPage | null {
  const row = asRecord(value)
  if (row === null) return null
  if (typeof row.rawText !== 'string') return null
  return {
    rawText: row.rawText,
    contentUpdatedAt: typeof row.contentUpdatedAt === 'string' ? row.contentUpdatedAt : null,
    charCount: asNumber(row.charCount),
    nextOffset: asNumber(row.nextOffset),
    done: row.done === true,
  }
}

/** Reads one page; null when the document is missing or not owned. */
export async function fetchDocumentContentPage(
  db: SupabaseClient<Database>,
  documentId: string,
  afterChar: number,
  pageChars: number = DOCUMENT_CONTENT_PAGE_CHARS,
): Promise<DocumentContentPage | null> {
  try {
    const { data, error } = await db.rpc('get_document_content_page', {
      p_document_id: documentId,
      p_after_char: afterChar,
      p_max_chars: pageChars,
    })
    if (error) throw new DocumentContentError(error.message)
    return normalizeContentPage(data)
  } catch (error) {
    if (error instanceof DocumentContentError) throw error
    throw new DocumentContentError('문서 본문을 받지 못했습니다', { cause: error })
  }
}

export type PagedContent = {
  rawText: string
  contentUpdatedAt: string | null
  charCount: number
  pages: number
}

/**
 * Reads a whole document through the paged endpoint.
 *
 * A page request that fails is retried from the same offset — pages are pure
 * reads keyed by character offset, so retrying cannot duplicate text. If the
 * content version changes between pages the partial text is discarded and the
 * error is recoverable: the next open starts a fresh read instead of joining
 * two revisions.
 */
export async function fetchDocumentTextPaged(
  db: SupabaseClient<Database>,
  documentId: string,
  { pageChars = DOCUMENT_CONTENT_PAGE_CHARS }: { pageChars?: number } = {},
): Promise<PagedContent> {
  let offset = 0
  let text = ''
  let version: string | null | undefined
  let charCount = 0

  for (let pageIndex = 0; pageIndex < MAX_CONTENT_PAGES; pageIndex += 1) {
    let page: DocumentContentPage | null = null
    let lastError: unknown
    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt += 1) {
      try {
        page = await fetchDocumentContentPage(db, documentId, offset, pageChars)
        lastError = undefined
        break
      } catch (error) {
        lastError = error
      }
    }
    if (lastError !== undefined) {
      throw new DocumentContentError('문서 본문을 받다가 멈췄습니다 — 다시 시도해 주세요', {
        cause: lastError,
      })
    }
    if (page === null) {
      throw new DocumentContentError('문서를 찾을 수 없습니다', { recoverable: false })
    }

    if (version === undefined) version = page.contentUpdatedAt
    else if (!sameContentVersion(version, page.contentUpdatedAt)) {
      throw new DocumentContentError('읽는 동안 문서 본문이 바뀌었습니다 — 다시 열어 주세요')
    }

    charCount = page.charCount
    text += page.rawText
    if (page.done || page.nextOffset <= offset || page.rawText === '') {
      return { rawText: text, contentUpdatedAt: version, charCount: Math.max(charCount, text.length), pages: pageIndex + 1 }
    }
    offset = page.nextOffset
  }

  throw new DocumentContentError('문서가 너무 커서 한 번에 읽지 못했습니다 — 다시 시도해 주세요')
}

/** The payload's rows grouped the way local occurrence rows are kept. */
export function occurrencesFromPayload(
  document: Document,
  payload: DocumentPayload,
): WordOccurrence[] {
  const grouped = new Map<string, WordOccurrence>()
  for (const row of payload.occurrences) {
    const existing = grouped.get(row.lemma)
    if (existing === undefined) {
      grouped.set(row.lemma, {
        documentId: document.id,
        languageCode: row.languageCode || document.languageCode,
        lemma: row.lemma,
        surfaces: [row.surface],
        count: row.occurrencesCount,
        recordedAt: Date.parse(payload.occurrencesUpdatedAt ?? document.updatedAt),
        charStart: row.charStart,
        charEnd: row.charEnd,
        sentence: row.sentence,
        documentTitle: document.title,
      })
      continue
    }
    if (!existing.surfaces.includes(row.surface)) existing.surfaces.push(row.surface)
    existing.charStart = Math.min(existing.charStart, row.charStart)
    existing.charEnd = Math.max(existing.charEnd, row.charEnd)
    existing.count = Math.max(existing.count, row.occurrencesCount)
  }
  return [...grouped.values()].sort((a, b) => a.charStart - b.charStart)
}

function requireClient(db?: SupabaseClient<Database>): SupabaseClient<Database> {
  if (db !== undefined) return db
  if (supabase !== null) return supabase
  throw new DocumentContentError('동기화가 설정되어 있지 않아 문서 본문을 받을 수 없습니다', {
    recoverable: false,
  })
}

/** Calls `touch_document`; opening is recorded without pretending it edited text. */
export async function touchDocument(
  db: SupabaseClient<Database>,
  documentId: string,
  openedAt: string,
): Promise<void> {
  const { error } = await db.rpc('touch_document', {
    p_document_id: documentId,
    p_opened_at: openedAt,
  })
  if (error) throw new DocumentContentError(error.message)
}

/**
 * Stores the payload's occurrence rows for a document this device has not
 * recomputed. Replacing local rows is silent: received rows are not edits and
 * must never enter the push journal.
 */
async function hydrateOccurrences(
  document: Document,
  payload: DocumentPayload,
): Promise<void> {
  if (payload.occurrences.length === 0) return
  const meta = await idbGet<{ lemmaVersion?: number; occurrencesUpdatedAt?: string }>(
    STORES.documentMeta,
    document.id,
  ).catch(() => undefined)

  /**
   * A current `lemmaVersion` alone is not proof that this device computed the
   * document. An older build's app-start refresh could stamp the version on a
   * metadata-only document without ever writing rows, and its empty result then
   * left no `occurrencesUpdatedAt`. Skipping hydration on that stamp would make
   * every later open refuse the server's rows. Require actual evidence: local
   * rows exist, or the computation recorded when it wrote them.
   */
  if (meta !== undefined && meta.lemmaVersion === LEMMA_VERSION) {
    const localRows = await idbGetAllByIndex<WordOccurrence>(
      STORES.wordOccurrences,
      'documentId',
      document.id,
    ).catch(() => [] as WordOccurrence[])
    const computedHere = localRows.length > 0 || meta.occurrencesUpdatedAt !== undefined
    if (computedHere) return
  }

  const records = occurrencesFromPayload(document, payload)
  if (records.length === 0) return
  await replaceOccurrences(document.id, records, { silent: true }).catch(() => {})
}

function openedFromRecord(
  record: DocumentContentRecord,
  options: { fetched: boolean; paged: boolean; lastOpenedAt: string | null },
): OpenedDocument {
  return {
    documentId: record.documentId,
    rawText: record.rawText,
    contentUpdatedAt: record.contentUpdatedAt,
    occurrencesUpdatedAt: record.occurrencesUpdatedAt,
    fetched: options.fetched,
    paged: options.paged,
    lastOpenedAt: options.lastOpenedAt,
  }
}

/**
 * Opens a document: resolves its text (fetching once when needed) and records
 * the open with `touch_document` alone.
 */
export async function openDocumentContent({
  document: doc,
  db,
  openedAt,
  touch = true,
  force = false,
  payloadByteBudget = DOCUMENT_PAYLOAD_BYTE_BUDGET,
  pageChars = DOCUMENT_CONTENT_PAGE_CHARS,
}: OpenDocumentOptions): Promise<OpenedDocument> {
  const stamp = openedAt ?? new Date().toISOString()
  const lastOpenedAt = touch ? stamp : (doc.lastOpenedAt ?? null)

  const recordOpen = async () => {
    if (!touch) return
    try {
      await touchDocument(requireClient(db), doc.id, stamp)
    } catch {
      // Offline or a rejected touch must not make the document unreadable.
    }
  }

  const docVersion = doc.contentUpdatedAt ?? null
  const cached = await readDocumentContent(doc.id)

  // 1. A local copy whose version still matches the metadata needs no request.
  if (!force && cached !== undefined && sameContentVersion(cached.contentUpdatedAt, docVersion)) {
    await recordOpen()
    return openedFromRecord(cached, { fetched: false, paged: false, lastOpenedAt })
  }

  // 2. Text that is already in the document row: created here, or an R2 row.
  if (!force && doc.hasContent !== false) {
    // The same last-write-wins rule as a fetch: a copy with a newer version
    // must not be replaced by a row whose text is older. This can happen when
    // another tab fetched the text and the document row was not updated.
    if (
      cached !== undefined &&
      !sameContentVersion(cached.contentUpdatedAt, docVersion) &&
      !isNewerVersion(cached.contentUpdatedAt, docVersion)
    ) {
      await recordOpen()
      return openedFromRecord(cached, { fetched: false, paged: false, lastOpenedAt })
    }
    const stored = await putDocumentContent(doc.id, {
      rawText: doc.rawText,
      contentUpdatedAt: docVersion,
      occurrencesUpdatedAt: cached?.occurrencesUpdatedAt ?? null,
    })
    await recordOpen()
    return openedFromRecord(stored, { fetched: false, paged: false, lastOpenedAt })
  }

  // 3. Fetch. A huge document skips the one-shot payload entirely.
  const client = requireClient(db)
  let paged = shouldPageDocument(doc, payloadByteBudget)
  let payload: DocumentPayload

  if (paged) {
    const page = await fetchDocumentTextPaged(client, doc.id, { pageChars })
    payload = {
      rawText: page.rawText,
      contentUpdatedAt: page.contentUpdatedAt,
      /**
       * No occurrence rows on this path. The wordbook projection answers the
       * wordbook, and the incremental pull is the only writer of per-document
       * occurrence rows. Progress for these documents must come from the
       * projection (Task 10 obligation); do not infer it from an empty local
       * occurrence set.
       */
      occurrencesUpdatedAt: cached?.occurrencesUpdatedAt ?? null,
      occurrences: [],
    }
  } else {
    const fetched = await fetchDocumentPayload(client, doc.id)
    if (fetched === null) {
      throw new DocumentContentError('문서를 찾을 수 없습니다', { recoverable: false })
    }
    if (payloadBytes(fetched) > payloadByteBudget) {
      // Larger than expected: discard the one-shot body and read the text in
      // pages. The message is recoverable — retrying resumes at page 0.
      paged = true
      const page = await fetchDocumentTextPaged(client, doc.id, { pageChars })
      payload = {
        rawText: page.rawText,
        contentUpdatedAt: page.contentUpdatedAt,
        occurrencesUpdatedAt: fetched.occurrencesUpdatedAt,
        occurrences: [],
      }
    } else {
      payload = fetched
    }
  }

  // A fetch that started before a newer copy was stored must not revert it.
  const latest = await readDocumentContent(doc.id)
  if (
    latest !== undefined &&
    !sameContentVersion(latest.contentUpdatedAt, payload.contentUpdatedAt) &&
    !isNewerVersion(latest.contentUpdatedAt, payload.contentUpdatedAt)
  ) {
    await recordOpen()
    return openedFromRecord(latest, { fetched: true, paged, lastOpenedAt })
  }

  const stored = await putDocumentContent(doc.id, {
    rawText: payload.rawText,
    contentUpdatedAt: payload.contentUpdatedAt,
    occurrencesUpdatedAt: payload.occurrencesUpdatedAt,
  })
  if (!paged) await hydrateOccurrences(doc, payload)
  await recordOpen()
  return openedFromRecord(stored, { fetched: true, paged, lastOpenedAt })
}
