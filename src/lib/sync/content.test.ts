import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import { useOccurrencesStore } from '../../app/stores/occurrences'
import type { Document, Folder } from '../../types'
import {
  deleteLocalDatabase,
  idbGet,
  idbGetAllByIndex,
  idbPut,
  readDirtyKeys,
  readLocalSyncMeta,
  STORES,
} from '../storage/localDb'
import { readDocumentContent, putDocumentContent } from '../storage/documentContent'
import { putWordbookEntries, readWordbookEntries } from '../storage/wordbookEntries'
import { DOCUMENT_METADATA_COLUMNS, documentMetadataFromRow } from './mapping'
import { mergeDocuments } from './merge'
import { fetchAll } from './pull'
import { syncOnce } from './sync'
import { memoryServer, type Server } from './testMemoryServer'
import {
  DOCUMENT_PAYLOAD_BYTE_BUDGET,
  openDocumentContent,
  payloadBytes,
  sameContentVersion,
  shouldPageDocument,
} from './content'

const USER = 'user-1'
const T0 = '2026-10-01T00:00:00.000Z'
const T1 = '2026-10-02T00:00:00.000Z'
const T2 = '2026-10-03T00:00:00.000Z'
const TEXT = 'Le chat dort.'

class MemoryStorage {
  #map = new Map<string, string>()

  getItem(key: string) {
    return this.#map.has(key) ? this.#map.get(key)! : null
  }

  setItem(key: string, value: string) {
    this.#map.set(key, String(value))
  }

  removeItem(key: string) {
    this.#map.delete(key)
  }

  clear() {
    this.#map.clear()
  }

  key(index: number) {
    return [...this.#map.keys()][index] ?? null
  }

  get length() {
    return this.#map.size
  }
}

const storage = new MemoryStorage()

function serverDocument(over: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    user_id: USER,
    title: 'Le chat',
    language_code: 'fr',
    raw_text: TEXT,
    created_at: T0,
    updated_at: T1,
    deleted_at: null,
    folder_id: null,
    folder_updated_at: null,
    server_updated_at: T1,
    last_opened_at: null,
    content_updated_at: T1,
    occurrences_updated_at: T1,
    char_count: Array.from(TEXT).length,
    ...over,
  }
}

/** A metadata-only document, the shape the list pull produces. */
function metadataDocument(over: Partial<Document> = {}): Document {
  return {
    id: 'doc-1',
    title: 'Le chat',
    languageCode: 'fr',
    rawText: '',
    charCount: Array.from(TEXT).length,
    hasContent: false,
    contentUpdatedAt: T1,
    occurrencesUpdatedAt: T1,
    lastOpenedAt: null,
    createdAt: T0,
    updatedAt: T1,
    ...over,
  }
}

function seed(server: Server, over: Record<string, unknown> = {}) {
  server.add('documents', serverDocument(over))
}

beforeEach(async () => {
  ;(globalThis as { localStorage?: Storage }).localStorage = storage as unknown as Storage
  storage.clear()
  await deleteLocalDatabase()
})

describe('metadata-only documents', () => {
  it('carry the server length, no text, and no local content', () => {
    const doc = documentMetadataFromRow({
      ...serverDocument({ char_count: 1234 }),
      raw_text: undefined,
    } as never)

    expect(doc.rawText).toBe('')
    expect(doc.hasContent).toBe(false)
    expect(doc.charCount).toBe(1234)
    expect(doc.contentUpdatedAt).toBe(T1)
    expect(doc.lastOpenedAt).toBeNull()
  })

  it('fall back to the row text length when an older row has no char_count', () => {
    const doc = documentMetadataFromRow({
      ...serverDocument({ char_count: undefined }),
    } as never)
    expect(doc.charCount).toBe(Array.from(TEXT).length)
  })

  it('are pulled with an explicit column list that omits raw_text', async () => {
    const server = memoryServer()
    seed(server)

    expect(DOCUMENT_METADATA_COLUMNS.split(',')).not.toContain('raw_text')

    const rows = await fetchAll<Record<string, unknown>>(
      server.client,
      'documents',
      USER,
      'id',
      DOCUMENT_METADATA_COLUMNS,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('raw_text')
    expect(rows[0]).toMatchObject({
      id: 'doc-1',
      char_count: Array.from(TEXT).length,
    })
  })

  it('are not recomputed as a content edit — a metadata merge keeps loaded text', () => {
    const local: Document = {
      ...metadataDocument(),
      rawText: TEXT,
      hasContent: true,
      contentUpdatedAt: T1,
      updatedAt: T0,
    }
    const remote = metadataDocument({ title: 'Renamed elsewhere', updatedAt: T2 })

    const [merged] = mergeDocuments([local], [remote])
    expect(merged?.rawText).toBe(TEXT)
    expect(merged?.hasContent).toBe(true)
    expect(merged?.title).toBe('Renamed elsewhere')
  })

  it('drop the local copy when the server text version moved — the next open refetches', () => {
    const local: Document = {
      ...metadataDocument(),
      rawText: TEXT,
      hasContent: true,
      contentUpdatedAt: T1,
    }
    const remote = metadataDocument({ contentUpdatedAt: T2, updatedAt: T2 })

    const [merged] = mergeDocuments([local], [remote])
    expect(merged?.hasContent).toBe(false)
    expect(merged?.rawText).toBe('')
    expect(merged?.contentUpdatedAt).toBe(T2)
  })

  it('never push raw_text as part of a metadata-only document', async () => {
    const server = memoryServer(0, T2)
    seed(server)

    const first = await syncOnce({
      userId: USER,
      languages: ['fr'],
      db: server.client,
    })

    const pulled = await idbGet<Document>(STORES.documents, 'doc-1')
    expect(pulled?.hasContent).toBe(false)
    expect(pulled?.rawText).toBe('')
    // Pulling the list never fetched the text.
    expect(server.rpcCalls('get_document_payload')).toBe(0)
    expect(server.upsertCalls('documents')).toBe(0)

    // A rename on a device that never opened the document. Its stamp is after
    // the first cycle's push watermark so it is a candidate on the next one.
    const renamedAt = new Date(Date.now() + 60_000).toISOString()
    const renamed: Document = {
      ...(pulled as Document),
      title: 'Renamed here',
      updatedAt: renamedAt,
    }
    await idbPut(STORES.documents, renamed)

    const second = await syncOnce({
      userId: USER,
      languages: ['fr'],
      db: server.client,
      since: first.watermarks,
    })

    expect(second.failures).toEqual([])
    const row = server.rows('documents')[0]
    expect(row?.title).toBe('Renamed here')
    // The metadata batch omitted raw_text; the server's text survived.
    expect(row?.raw_text).toBe(TEXT)
    expect(row?.char_count).toBe(Array.from(TEXT).length)
    expect(server.rpcCalls('get_document_payload')).toBe(0)
  })

  it('moves a metadata-only document with an update and keeps its server text', async () => {
    const server = memoryServer(0, T2)
    seed(server)

    const first = await syncOnce({
      userId: USER,
      languages: ['fr'],
      db: server.client,
    })
    const pulled = await idbGet<Document>(STORES.documents, 'doc-1')
    expect(pulled?.hasContent).toBe(false)

    const movedAt = new Date(Date.now() + 60_000).toISOString()
    const folder: Folder = {
      id: 'folder-fr',
      name: 'French',
      parentId: null,
      createdAt: movedAt,
      updatedAt: movedAt,
    }
    await idbPut(STORES.folders, folder)
    await idbPut(STORES.documents, {
      ...(pulled as Document),
      folderId: folder.id,
      folderUpdatedAt: movedAt,
    })

    const second = await syncOnce({
      userId: USER,
      languages: ['fr'],
      db: server.client,
      since: first.watermarks,
    })

    expect(second.failures).toEqual([])
    expect(server.rows('documents')[0]?.folder_id).toBe(folder.id)
    // The move updates metadata only; the server's body survives untouched.
    expect(server.rows('documents')[0]?.raw_text).toBe(TEXT)
    expect(server.updateCalls('documents')).toBeGreaterThan(0)
    expect(server.upsertCalls('documents')).toBe(0)
  })

  it('keeps a metadata-only update pending when the server row is gone', async () => {
    const server = memoryServer(0, T2)
    seed(server)

    const first = await syncOnce({
      userId: USER,
      languages: ['fr'],
      db: server.client,
    })
    const pulled = await idbGet<Document>(STORES.documents, 'doc-1')
    server.rows('documents').splice(0)

    await idbPut(STORES.documents, {
      ...(pulled as Document),
      title: 'Renamed after deletion',
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    })

    const second = await syncOnce({
      userId: USER,
      languages: ['fr'],
      db: server.client,
      since: first.watermarks,
    })

    expect(second.failures).toContainEqual(
      expect.objectContaining({
        table: 'documents',
        key: 'doc-1',
        message: 'document metadata update matched no server row',
      }),
    )
    expect(await readDirtyKeys()).toContainEqual(
      expect.objectContaining({ store: 'documents', key: 'doc-1' }),
    )
  })
})

describe('opening a document', () => {
  it('fetches once, stores the text, and does not fetch again on reopen', async () => {
    const server = memoryServer()
    seed(server)

    const first = await openDocumentContent({
      document: metadataDocument(),
      db: server.client,
      openedAt: T2,
    })

    expect(first.rawText).toBe(TEXT)
    expect(first.fetched).toBe(true)
    expect(server.rpcCalls('get_document_payload')).toBe(1)
    await expect(readDocumentContent('doc-1')).resolves.toMatchObject({
      rawText: TEXT,
      contentUpdatedAt: T1,
    })

    const second = await openDocumentContent({
      document: metadataDocument(),
      db: server.client,
      openedAt: T2,
    })

    expect(second.rawText).toBe(TEXT)
    expect(second.fetched).toBe(false)
    expect(server.rpcCalls('get_document_payload')).toBe(1)
  })

  it('refetches when the content version changed', async () => {
    const server = memoryServer()
    seed(server)
    await openDocumentContent({ document: metadataDocument(), db: server.client })

    const row = server.rows('documents')[0]!
    row.raw_text = 'Le chien dort.'
    row.content_updated_at = T2
    row.char_count = Array.from('Le chien dort.').length

    const reopened = await openDocumentContent({
      document: metadataDocument({
        contentUpdatedAt: T2,
        charCount: Array.from('Le chien dort.').length,
      }),
      db: server.client,
    })

    expect(reopened.rawText).toBe('Le chien dort.')
    expect(server.rpcCalls('get_document_payload')).toBe(2)
    await expect(readDocumentContent('doc-1')).resolves.toMatchObject({
      rawText: 'Le chien dort.',
      contentUpdatedAt: T2,
    })
  })

  it('does not refetch text when only the occurrence version changed', async () => {
    const server = memoryServer()
    seed(server)
    await openDocumentContent({ document: metadataDocument(), db: server.client })

    const reopened = await openDocumentContent({
      // A document opened elsewhere may have new occurrence rows, but the text
      // is the same — the content version is what decides a text fetch.
      document: metadataDocument({
        occurrencesUpdatedAt: T2,
        lastOpenedAt: T2,
        updatedAt: T2,
      }),
      db: server.client,
    })

    expect(reopened.rawText).toBe(TEXT)
    expect(reopened.fetched).toBe(false)
    expect(server.rpcCalls('get_document_payload')).toBe(1)
  })

  it('uses a cached body newer than the metadata row without refetching', async () => {
    const server = memoryServer()
    seed(server)
    // Another tab already fetched a newer revision; this device's metadata row
    // still carries the older version. Refetching would be a needless request
    // and could replace the newer body with an older one.
    await putDocumentContent('doc-1', {
      rawText: 'Newer local body',
      contentUpdatedAt: T2,
      occurrencesUpdatedAt: T2,
    })

    const opened = await openDocumentContent({
      document: metadataDocument({ contentUpdatedAt: T1 }),
      db: server.client,
      openedAt: T2,
    })

    expect(opened.rawText).toBe('Newer local body')
    expect(opened.fetched).toBe(false)
    expect(server.rpcCalls('get_document_payload')).toBe(0)
    expect(server.rpcCalls('get_document_content_page')).toBe(0)
  })

  it('calls touch_document only — no document upsert and no raw_text write', async () => {
    const server = memoryServer()
    seed(server)
    const before = { ...server.rows('documents')[0]! }

    await openDocumentContent({
      document: metadataDocument(),
      db: server.client,
      openedAt: T2,
    })

    expect(server.rpcCalls('touch_document')).toBe(1)
    expect(server.upsertCalls('documents')).toBe(0)
    const after = server.rows('documents')[0]!
    expect(after.raw_text).toBe(TEXT)
    expect(after.char_count).toBe(before.char_count)
    expect(after.last_opened_at).toBe(T2)
  })

  it('a touch changes neither content_updated_at nor occurrences_updated_at', async () => {
    const server = memoryServer()
    seed(server, { occurrences_updated_at: T0 })
    const before = { ...server.rows('documents')[0]! }

    await openDocumentContent({
      document: metadataDocument(),
      db: server.client,
      openedAt: T2,
    })

    const after = server.rows('documents')[0]!
    expect(after.content_updated_at).toBe(before.content_updated_at)
    expect(after.occurrences_updated_at).toBe(before.occurrences_updated_at)
    expect(after.updated_at).toBe(before.updated_at)
    expect(after.last_opened_at).toBe(T2)
    expect(after.last_opened_at).not.toBe(before.last_opened_at)
  })

  it('does not overwrite a newer local copy with an older fetch', async () => {
    const server = memoryServer()
    seed(server, { content_updated_at: T1 })
    // A newer copy is already stored (another tab fetched it first).
    await putDocumentContent('doc-1', {
      rawText: 'Newer local copy',
      contentUpdatedAt: T2,
      occurrencesUpdatedAt: null,
    })

    const opened = await openDocumentContent({
      document: metadataDocument({ contentUpdatedAt: null }),
      db: server.client,
      force: true,
    })

    expect(opened.rawText).toBe('Newer local copy')
    await expect(readDocumentContent('doc-1')).resolves.toMatchObject({
      rawText: 'Newer local copy',
      contentUpdatedAt: T2,
    })
  })

  it('does not replace a newer local copy from the document-row path', async () => {
    await putDocumentContent('doc-1', {
      rawText: 'Newer local copy',
      contentUpdatedAt: T2,
      occurrencesUpdatedAt: null,
    })

    const opened = await openDocumentContent({
      // A local row whose own text version is older than the stored copy.
      document: metadataDocument({ hasContent: true, rawText: 'Older row text' }),
      touch: false,
    })

    expect(opened.rawText).toBe('Newer local copy')
    await expect(readDocumentContent('doc-1')).resolves.toMatchObject({
      rawText: 'Newer local copy',
      contentUpdatedAt: T2,
    })
  })

  it('hydrates server occurrence rows when a bare lemmaVersion stamp has no evidence', async () => {
    const server = memoryServer()
    seed(server)
    server.add('word_occurrences', {
      id: 1,
      user_id: USER,
      document_id: 'doc-1',
      language_code: 'fr',
      lemma: 'chat',
      surface: 'chat',
      char_start: 3,
      char_end: 7,
      sentence: TEXT,
      occurrences_count: 3,
    })
    // An older build's app-start refresh stamped the version but never wrote
    // rows and left no occurrence timestamp.
    await idbPut(STORES.documentMeta, { documentId: 'doc-1', lemmaVersion: LEMMA_VERSION })

    await openDocumentContent({
      document: metadataDocument(),
      db: server.client,
      touch: false,
    })

    const rows = await idbGetAllByIndex<{ lemma: string; count: number }>(
      STORES.wordOccurrences,
      'documentId',
      'doc-1',
    )
    expect(rows.map((row) => row.lemma)).toEqual(['chat'])
    expect(rows[0]?.count).toBe(3)
    // Hydration is a received row, not a local edit.
    const meta = await readLocalSyncMeta()
    expect(meta?.revision ?? 0).toBe(0)
    expect(await readDirtyKeys()).toEqual([])
  })

  it('keeps rows this device really computed instead of hydrating over them', async () => {
    const server = memoryServer()
    seed(server)
    server.add('word_occurrences', {
      id: 1,
      user_id: USER,
      document_id: 'doc-1',
      language_code: 'fr',
      lemma: 'chat',
      surface: 'chat',
      char_start: 3,
      char_end: 7,
      sentence: TEXT,
      occurrences_count: 3,
    })
    await idbPut(STORES.wordOccurrences, {
      documentId: 'doc-1',
      languageCode: 'fr',
      lemma: 'chat',
      surfaces: ['chat'],
      count: 1,
      recordedAt: 1,
      charStart: 3,
      charEnd: 7,
      sentence: 'Local sentence',
      documentTitle: 'Le chat',
    })
    await idbPut(STORES.documentMeta, {
      documentId: 'doc-1',
      lemmaVersion: LEMMA_VERSION,
      occurrencesUpdatedAt: T2,
    })

    await openDocumentContent({
      document: metadataDocument(),
      db: server.client,
      touch: false,
    })

    const rows = await idbGetAllByIndex<{ sentence: string; count: number }>(
      STORES.wordOccurrences,
      'documentId',
      'doc-1',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sentence).toBe('Local sentence')
    expect(rows[0]?.count).toBe(1)
  })
})

describe('app-start occurrence refresh', () => {
  it('never recomputes or clears a metadata-only document', async () => {
    const doc = metadataDocument()
    await idbPut(STORES.documents, doc)
    await idbPut(STORES.wordOccurrences, {
      documentId: 'doc-1',
      languageCode: 'fr',
      lemma: 'chat',
      surfaces: ['chat'],
      count: 3,
      recordedAt: 1,
      charStart: 3,
      charEnd: 7,
      sentence: TEXT,
      documentTitle: 'Le chat',
    })

    // The fixture writes above are user writes; the refresh must add nothing.
    const dirtyBefore = await readDirtyKeys()

    const recomputed = await useOccurrencesStore.getState().refreshStaleDocuments([doc])

    expect(recomputed).toBe(0)
    const rows = await idbGetAllByIndex<{ lemma: string }>(
      STORES.wordOccurrences,
      'documentId',
      'doc-1',
    )
    expect(rows.map((row) => row.lemma)).toEqual(['chat'])
    // No computation record, no stamp, no extra dirty push.
    expect(await idbGet(STORES.documentMeta, 'doc-1')).toBeUndefined()
    expect(await readDirtyKeys()).toEqual(dirtyBefore)
  })
})

describe('the 10 MB soft cap', () => {
  it('pages a document whose worst-case body crosses the budget', () => {
    expect(shouldPageDocument(metadataDocument({ charCount: 100 }))).toBe(false)
    expect(
      shouldPageDocument(
        metadataDocument({ charCount: Math.ceil(DOCUMENT_PAYLOAD_BYTE_BUDGET / 4) + 1 }),
      ),
    ).toBe(true)
    expect(payloadBytes({ rawText: 'abc' })).toBeGreaterThan(0)
  })

  it('reads the text page by page and stores it like a one-shot fetch', async () => {
    const long = 'Le chat dort. '.repeat(20)
    const server = memoryServer()
    seed(server, { raw_text: long, char_count: Array.from(long).length })

    const opened = await openDocumentContent({
      document: metadataDocument({
        charCount: Array.from(long).length,
        // Force the paged path even for this small fixture.
        contentUpdatedAt: T1,
      }),
      db: server.client,
      payloadByteBudget: 10,
      pageChars: 20,
    })

    expect(opened.rawText).toBe(long)
    expect(opened.paged).toBe(true)
    expect(server.rpcCalls('get_document_payload')).toBe(0)
    expect(server.rpcCalls('get_document_content_page')).toBeGreaterThan(1)
    await expect(readDocumentContent('doc-1')).resolves.toMatchObject({
      rawText: long,
      contentUpdatedAt: T1,
    })
  })

  /**
   * R3 decision for paged content: a document whose occurrence payload would
   * exceed the cap is read page by page for its text, and its occurrence rows
   * stay where they already are. The wordbook is the projection (one row per
   * lemma, independent of document text), so opening such a document neither
   * needs nor may write per-document occurrence rows. Task 10 owns showing
   * per-document progress from the projection for these documents.
   */
  it('leaves the wordbook projection and occurrence rows untouched', async () => {
    const long = 'Le chat dort. '.repeat(20)
    const server = memoryServer()
    seed(server, { raw_text: long, char_count: Array.from(long).length })
    await putWordbookEntries([
      {
        languageCode: 'fr',
        lemma: 'chat',
        surfaces: ['chat'],
        contexts: [],
        occurrenceCount: 20,
        documentCount: 1,
        status: 'known',
        isFavorite: false,
        starAngle: 0,
        starColor: '#eab308',
        seenCount: 1,
        firstSeenAt: T1,
        lastSeenAt: T1,
        favoriteUpdatedAt: null,
        knownPresses: 0,
        unsurePresses: 0,
        unknownPresses: 0,
        note: null,
        noteUpdatedAt: null,
        serverUpdatedAt: T1,
      },
    ])

    const opened = await openDocumentContent({
      document: metadataDocument({ charCount: Array.from(long).length }),
      db: server.client,
      payloadByteBudget: 10,
      pageChars: 20,
    })

    expect(opened.paged).toBe(true)
    expect(opened.rawText).toBe(long)
    // The wordbook still answers from the projection.
    const entries = await readWordbookEntries('fr')
    expect(entries.map((entry) => entry.lemma)).toEqual(['chat'])
    // The paged path does not fabricate per-document occurrence rows.
    expect(
      await idbGetAllByIndex(STORES.wordOccurrences, 'documentId', 'doc-1'),
    ).toEqual([])
    expect(await idbGet(STORES.documentMeta, 'doc-1')).toBeUndefined()
  })

  it('reports a recoverable error when a page cannot be read', async () => {
    const server = memoryServer()
    seed(server, { raw_text: 'Le chat dort.' })
    server.rejectRpc('get_document_content_page', () => true)

    await expect(
      openDocumentContent({
        document: metadataDocument({ charCount: 4_000_000 }),
        db: server.client,
        payloadByteBudget: 10,
        pageChars: 5,
      }),
    ).rejects.toMatchObject({ name: 'DocumentContentError', recoverable: true })
  })
})

describe('content versions', () => {
  it('compare server and browser timestamp formats as instants', () => {
    expect(sameContentVersion('2026-10-02T00:00:00+00:00', '2026-10-02T00:00:00.000Z')).toBe(
      true,
    )
    expect(sameContentVersion(null, null)).toBe(true)
    expect(sameContentVersion(T1, T2)).toBe(false)
    expect(sameContentVersion(null, T1)).toBe(false)
  })
})
