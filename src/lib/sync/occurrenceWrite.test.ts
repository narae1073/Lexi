import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  STORES,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  type StoreName,
} from '../../lib/storage/localDb'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import type { WordOccurrence } from '../../app/stores/occurrences'
import type { Document } from '../../types'
import {
  changedLocalOccurrenceDocuments,
  syncOnce,
  type PullWatermarks,
} from './sync'
import { memoryServer, type Server } from './testMemoryServer'

const USER = 'user-1'
/** Snapshot of the first sync — the second sync's five-minute overlap still sees it. */
const T1 = '2026-10-05T00:00:00.000Z'
const T2 = '2026-10-10T00:00:00.000Z'
/** A push clock after the changes — these tests are about local writes, not pushes. */
const PUSHED_AT = '2026-12-01T00:00:00.000Z'

const doc = (id: string): Document => ({
  id,
  title: `Title ${id}`,
  languageCode: 'fr',
  rawText: `Texte ${id}.`,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
})

const occurrence = (
  documentId: string,
  lemma: string,
  over: Partial<WordOccurrence> = {},
): WordOccurrence => ({
  documentId,
  languageCode: 'fr',
  lemma,
  surfaces: [lemma],
  count: 1,
  charStart: 0,
  charEnd: lemma.length,
  sentence: `Sentence ${documentId}.`,
  documentTitle: `Title ${documentId}`,
  recordedAt: Date.parse('2026-10-01T00:00:00.000Z'),
  ...over,
})

const remoteDoc = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: USER,
  title: `Title ${id}`,
  language_code: 'fr',
  raw_text: `Texte ${id}.`,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  deleted_at: null,
  folder_id: null,
  folder_updated_at: null,
  server_updated_at: T1,
  ...over,
})

let nextOccurrenceId = 1

const remoteOccurrence = (
  documentId: string,
  lemma: string,
  over: Record<string, unknown> = {},
) => ({
  id: nextOccurrenceId++,
  user_id: USER,
  document_id: documentId,
  language_code: 'fr',
  lemma,
  surface: lemma,
  char_start: 0,
  char_end: lemma.length,
  sentence: `Sentence ${documentId}.`,
  occurrences_count: 1,
  ...over,
})

/**
 * R3's first sync reads no occurrences; the wordbook projection replaces that
 * pull. These cases exercise the incremental occurrence path, so they start
 * from a snapshot before every fixture row.
 */
const BEFORE = { snapshot: '2026-09-01T00:00:00.000Z' }

const sync = (
  server: Server,
  options: { since?: PullWatermarks; pushedAt?: string } = {},
) =>
  syncOnce({
    userId: USER,
    languages: ['fr'],
    db: server.client,
    since: BEFORE,
    ...options,
  })

const LOCAL_STORES: StoreName[] = [
  STORES.documents,
  STORES.folders,
  STORES.wordStates,
  STORES.wordOccurrences,
  STORES.documentTombstones,
  STORES.documentMeta,
]

/** Key of a stored row, so a test can empty every local store between cases. */
function keyOf(store: StoreName, row: Record<string, unknown>): IDBValidKey {
  if (store === STORES.wordStates) return [row.languageCode, row.lemma] as IDBValidKey
  if (store === STORES.wordOccurrences) return [row.documentId, row.lemma] as IDBValidKey
  if (store === STORES.documentMeta) return row.documentId as IDBValidKey
  return row.id as IDBValidKey
}

async function clearLocal() {
  for (const store of LOCAL_STORES) {
    for (const row of await idbGetAll<Record<string, unknown>>(store)) {
      await idbDelete(store, keyOf(store, row), { silent: true })
    }
  }
}

beforeEach(async () => {
  nextOccurrenceId = 1
  await clearLocal()
})

describe('changed-only occurrence writes', () => {
  it('writes no occurrence rows when an incremental sync has no remote changes — even across the overlap re-read', async () => {
    const server = memoryServer(1000, T1)
    server.add('documents', remoteDoc('doc-1'))
    server.add('word_occurrences', remoteOccurrence('doc-1', 'chat'))

    const first = await sync(server)
    expect(first.localWrites.occurrences).toBe(1)

    let documentReads = 0
    server.afterPage((table) => {
      if (table === 'documents') documentReads += 1
    })

    const second = await sync(server, { since: first.watermarks, pushedAt: PUSHED_AT })

    // The document stamp equals the previous snapshot, so the overlap pulls it again.
    expect(documentReads).toBeGreaterThan(0)
    expect(second.localWrites.occurrences).toBe(0)
  })

  it('clears local occurrence rows when a changed remote document now has none', async () => {
    const server = memoryServer(1000, T1)
    server.add('documents', remoteDoc('doc-1'))
    server.add('word_occurrences', remoteOccurrence('doc-1', 'chat'))

    const first = await sync(server)
    expect(await idbGetAll(STORES.wordOccurrences)).toHaveLength(1)

    // The document changes on the server and its occurrence rows are gone.
    server.rows('word_occurrences').length = 0
    const remote = server.rows('documents')[0]
    if (!remote) throw new Error('server document is missing')
    remote.updated_at = '2026-10-09T00:00:00.000Z'
    remote.server_updated_at = T2
    server.setSnapshot(T2)

    const second = await sync(server, { since: first.watermarks, pushedAt: PUSHED_AT })

    expect(second.localWrites.occurrences).toBe(1)
    expect(await idbGetAll(STORES.wordOccurrences)).toHaveLength(0)
  })

  for (const [label, lemmaVersion] of [
    ['without documentMeta', undefined],
    ['with old documentMeta', -1],
  ] as const) {
    it(`clears local occurrence rows on a full pull when the server-owned document has none (${label})`, async () => {
      const server = memoryServer(1000, T1)
      // A full pull treats every fetched remote document as authoritative — even
      // one the server owns with no occurrence rows at all.
      server.add('documents', remoteDoc('doc-1'))

      await idbPut(STORES.documents, doc('doc-1'))
      if (lemmaVersion !== undefined) {
        await idbPut(STORES.documentMeta, { documentId: 'doc-1', lemmaVersion })
      }
      await idbPut(STORES.wordOccurrences, {
        ...occurrence('doc-1', 'chat'),
        sentinel: 'stale',
      })

      const report = await sync(server)

      // Exactly one replacement: the stale row is gone rather than rewritten.
      expect(report.localWrites.occurrences).toBe(1)
      expect(await idbGet(STORES.wordOccurrences, ['doc-1', 'chat'])).toBeUndefined()
      expect(await idbGetAll(STORES.wordOccurrences)).toHaveLength(0)
    })
  }

  it('replaces occurrences for changed remote documents only — unrelated rows stay untouched', async () => {
    const server = memoryServer(1000, T1)
    server.add('documents', remoteDoc('doc-1'))
    server.add('documents', remoteDoc('doc-2'))
    server.add('word_occurrences', remoteOccurrence('doc-1', 'chat'))
    server.add('word_occurrences', remoteOccurrence('doc-2', 'lune'))

    const first = await sync(server)
    expect(await idbGetAll(STORES.wordOccurrences)).toHaveLength(2)

    // Mark the document that must not change; a rewrite would drop the marker.
    const untouched = await idbGet<WordOccurrence>(STORES.wordOccurrences, ['doc-2', 'lune'])
    if (!untouched) throw new Error('untouched occurrence is missing')
    await idbPut(STORES.wordOccurrences, { ...untouched, sentinel: 'keep' })

    // Only doc-1 changes on the server.
    const changedOccurrence = server
      .rows('word_occurrences')
      .find((row) => row.document_id === 'doc-1')
    if (!changedOccurrence) throw new Error('changed occurrence is missing')
    changedOccurrence.sentence = 'Changed sentence.'
    const changedDocument = server.rows('documents').find((row) => row.id === 'doc-1')
    if (!changedDocument) throw new Error('changed document is missing')
    changedDocument.updated_at = '2026-10-09T00:00:00.000Z'
    changedDocument.server_updated_at = T2
    server.setSnapshot(T2)

    const second = await sync(server, { since: first.watermarks, pushedAt: PUSHED_AT })

    expect(second.localWrites.occurrences).toBe(1)
    const local = await idbGetAll<WordOccurrence & { sentinel?: string }>(
      STORES.wordOccurrences,
    )
    expect(local.find((row) => row.documentId === 'doc-1')?.sentence).toBe('Changed sentence.')
    expect(local.find((row) => row.documentId === 'doc-2')?.sentinel).toBe('keep')
  })

  it('does not rewrite occurrences when a document was pulled only because it was opened', async () => {
    const server = memoryServer(1000, T1)
    server.add('documents', remoteDoc('doc-1'))
    server.add('word_occurrences', remoteOccurrence('doc-1', 'chat'))

    const first = await sync(server)
    expect(first.localWrites.occurrences).toBe(1)

    // Opened on another device: the document stamp changes, the content does not.
    const remote = server.rows('documents')[0]
    if (!remote) throw new Error('server document is missing')
    remote.updated_at = '2026-10-09T00:00:00.000Z'
    remote.server_updated_at = T2
    server.setSnapshot(T2)

    const second = await sync(server, { since: first.watermarks, pushedAt: PUSHED_AT })

    expect(second.localWrites.occurrences).toBe(0)
    const local = await idbGetAll<WordOccurrence>(STORES.wordOccurrences)
    expect(local[0]?.sentence).toBe('Sentence doc-1.')
  })

  it('does not write occurrences for a document recomputed on this device', async () => {
    const server = memoryServer(1000, T1)
    server.add('documents', remoteDoc('doc-1'))
    // The server still carries content from the old lemma rules.
    server.add('word_occurrences', remoteOccurrence('doc-1', 'chat', { sentence: 'Old rule.' }))

    await idbPut(STORES.documents, doc('doc-1'))
    await idbPut(STORES.documentMeta, { documentId: 'doc-1', lemmaVersion: LEMMA_VERSION })
    await idbPut(
      STORES.wordOccurrences,
      occurrence('doc-1', 'chat', { sentence: 'Current rule.' }),
    )

    const report = await sync(server)

    expect(report.localWrites.occurrences).toBe(0)
    const local = await idbGetAll<WordOccurrence>(STORES.wordOccurrences)
    expect(local).toHaveLength(1)
    expect(local[0]?.sentence).toBe('Current rule.')
  })
})

describe('changedLocalOccurrenceDocuments', () => {
  it('returns nothing when the merged and local content match', () => {
    expect(
      changedLocalOccurrenceDocuments([occurrence('doc-1', 'chat')], [occurrence('doc-1', 'chat')]),
    ).toEqual([])
  })

  it('returns a document whose merged content differs', () => {
    expect(
      changedLocalOccurrenceDocuments(
        [occurrence('doc-1', 'chat', { sentence: 'new' })],
        [occurrence('doc-1', 'chat', { sentence: 'old' })],
      ),
    ).toEqual(['doc-1'])
  })

  it('returns a document whose merged rows are gone — it is cleared with an empty list', () => {
    expect(changedLocalOccurrenceDocuments([], [occurrence('doc-1', 'chat')])).toEqual([
      'doc-1',
    ])
  })

  it('returns a document that only gained merged rows', () => {
    expect(changedLocalOccurrenceDocuments([occurrence('doc-1', 'chat')], [])).toEqual([
      'doc-1',
    ])
  })

  it('limits the comparison to onlyDocumentIds', () => {
    const merged = [
      occurrence('doc-1', 'chat', { sentence: 'new' }),
      occurrence('doc-2', 'lune', { sentence: 'new' }),
    ]
    const local = [
      occurrence('doc-1', 'chat', { sentence: 'old' }),
      occurrence('doc-2', 'lune', { sentence: 'old' }),
    ]

    expect(changedLocalOccurrenceDocuments(merged, local, new Set(['doc-2']))).toEqual([
      'doc-2',
    ])
  })
})
