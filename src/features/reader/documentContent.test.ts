import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Document } from '../../types'
import { deleteLocalDatabase } from '../../lib/storage/localDb'
import { readDocumentContent } from '../../lib/storage/documentContent'
import { openDocumentContent } from '../../lib/sync/content'
import { memoryServer } from '../../lib/sync/testMemoryServer'
import { mayRecomputeOccurrences } from './documentContent'
import { documentLength, sortDocuments } from './documentSort'

const T0 = '2026-10-01T00:00:00.000Z'
const T1 = '2026-10-02T00:00:00.000Z'
const TEXT = 'Le chat dort.'

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

function seedDocument() {
  return {
    id: 'doc-1',
    user_id: 'user-1',
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
  }
}

beforeEach(async () => {
  await deleteLocalDatabase()
})

describe('metadata-only documents in the list', () => {
  it('measure by charCount without text, and sort by longest', () => {
    const short = metadataDocument({ id: 'short', title: 'short', charCount: 12 })
    const long = metadataDocument({ id: 'long', title: 'long', charCount: 5000 })

    expect(documentLength(short)).toBe(12)
    expect(documentLength(long)).toBe(5000)
    expect(sortDocuments([short, long], 'longest').map((doc) => doc.id)).toEqual([
      'long',
      'short',
    ])
  })

  it('fall back to the text length for a document this device holds', () => {
    const local = metadataDocument({ rawText: 'ab', hasContent: true, charCount: undefined })
    expect(documentLength(local)).toBe(2)
  })
})

describe('opening a synced document', () => {
  it('fetches the text once and reopens from the local copy', async () => {
    const server = memoryServer()
    server.add('documents', seedDocument())

    const first = await openDocumentContent({
      document: metadataDocument(),
      db: server.client,
      openedAt: T1,
    })

    expect(first.rawText).toBe(TEXT)
    expect(server.rpcCalls('get_document_payload')).toBe(1)
    await expect(readDocumentContent('doc-1')).resolves.toMatchObject({ rawText: TEXT })

    const second = await openDocumentContent({
      document: metadataDocument(),
      db: server.client,
      openedAt: T1,
    })

    expect(second.rawText).toBe(TEXT)
    expect(second.fetched).toBe(false)
    expect(server.rpcCalls('get_document_payload')).toBe(1)
    // Opening is touch-only: no document upsert ever carries the text.
    expect(server.upsertCalls('documents')).toBe(0)
    expect(server.rpcCalls('touch_document')).toBe(2)
  })

  it('records the open without pretending it edited the document', async () => {
    const server = memoryServer()
    server.add('documents', seedDocument())
    const before = { ...server.rows('documents')[0]! }

    await openDocumentContent({
      document: metadataDocument(),
      db: server.client,
      openedAt: '2026-10-03T00:00:00.000Z',
    })

    const after = server.rows('documents')[0]!
    expect(after.last_opened_at).toBe('2026-10-03T00:00:00.000Z')
    expect(after.content_updated_at).toBe(before.content_updated_at)
    expect(after.occurrences_updated_at).toBe(before.occurrences_updated_at)
    expect(after.updated_at).toBe(before.updated_at)
    expect(after.raw_text).toBe(TEXT)
  })
})

describe('recomputing occurrences', () => {
  it('stays off for a synced document and on for a document authored here', () => {
    expect(mayRecomputeOccurrences(metadataDocument())).toBe(false)
    expect(mayRecomputeOccurrences(metadataDocument({ hasContent: true, rawText: TEXT }))).toBe(true)
    // Rows written before the lazy-content release always hold their text.
    expect(mayRecomputeOccurrences(metadataDocument({ hasContent: undefined, rawText: TEXT }))).toBe(
      true,
    )
  })
})
