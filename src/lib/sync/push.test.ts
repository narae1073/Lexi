import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  STORES,
  idbDelete,
  idbGetAll,
  idbPut,
  readDirtyKeys,
  replaceOccurrences,
  type StoreName,
} from '../../lib/storage/localDb'
import type { Document } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import { LEGACY_PURGE_AT } from '../storage/purged'
import { push, syncOnce, type PullWatermarks, type PushWatermarks } from './sync'
import { memoryServer, type Server } from './testMemoryServer'

const USER = 'user-1'

const legacyStorage = (() => {
  const map = new Map<string, string>()
  const storage = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => {
      map.clear()
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  }
  ;(globalThis as { localStorage?: Storage }).localStorage = storage as unknown as Storage
  return storage
})()

const doc = (id: string, over: Partial<Document> = {}): Document => ({
  id,
  title: `Title ${id}`,
  languageCode: 'fr',
  rawText: 'Le petit renard.',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  ...over,
})

/** A document row already on the server, as pulled by `pull`. */
const serverDocument = (id: string) => ({
  id,
  user_id: USER,
  title: `Title ${id}`,
  language_code: 'fr',
  raw_text: 'Le petit renard.',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
  deleted_at: null,
  folder_id: null,
  folder_updated_at: null,
  server_updated_at: '2026-10-02T00:00:00.000Z',
})

const wordState = (lemma: string) => ({
  languageCode: 'fr',
  lemma,
  status: 'known' as const,
  seenCount: 1,
  firstSeenAt: '2026-10-02T00:00:00.000Z',
  lastSeenAt: '2026-10-05T00:00:00.000Z',
  favorite: false,
  favoriteUpdatedAt: '2026-10-02T00:00:00.000Z',
  starAngle: 0,
  starColor: '#eab308',
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
  sentence: '',
  documentTitle: `Title ${documentId}`,
  recordedAt: 1,
  ...over,
})

/** Remove every row (and the sync-meta dirty journal) between tests. */
async function clearStore(store: StoreName) {
  for (const row of await idbGetAll<Record<string, unknown>>(store)) {
    let key: IDBValidKey
    if (store === STORES.wordStates) key = [row.languageCode as string, row.lemma as string]
    else if (store === STORES.wordOccurrences) key = [row.documentId as string, row.lemma as string]
    else if (store === STORES.documentMeta) key = row.documentId as string
    else if (store === STORES.documentTombstones) key = row.documentId as string
    else key = row.id as string
    await idbDelete(store, key, { silent: true })
  }
}

const sync = (
  server: Server,
  options: { since?: PullWatermarks; push?: PushWatermarks } = {},
) => syncOnce({ userId: USER, languages: ['fr'], db: server.client, ...options })

type PushFn = (input: Record<string, unknown>) => Promise<{
  succeededKeys: Array<{ store: StoreName; key: string; revision: number }>
}>
/** The public surface returns a per-table result after this task; cast keeps the
 * RED run focused on behaviour rather than a missing type. */
const pushRows = push as unknown as PushFn

beforeEach(async () => {
  legacyStorage.clear()
  await clearStore(STORES.documents)
  await clearStore(STORES.folders)
  await clearStore(STORES.wordStates)
  await clearStore(STORES.wordOccurrences)
  await clearStore(STORES.documentTombstones)
  await clearStore(STORES.documentMeta)
})

describe('per-table push isolation', () => {
  it('keeps syncing word states when one document row fails', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc('doc-1'))
    await idbPut(STORES.documents, doc('doc-2'))
    await idbPut(STORES.wordStates, wordState('été'))
    server.rejectUpsert('documents', (row) => row.id === 'doc-2')

    const report = await sync(server)

    expect(report.failures.some((failure) => failure.table === 'documents')).toBe(true)
    expect(server.rows('word_states')).toHaveLength(1)
    expect(report.pushWatermarks.wordStates).toBeDefined()
    expect(report.pushWatermarks.documents).toBeUndefined()
    expect(report.succeededStores).toContain('wordStates')
    expect(report.succeededStores).not.toContain('documents')
  })

  it('isolates one poison row inside a chunk', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc('doc-1'))
    await idbPut(STORES.documents, doc('doc-2'))
    server.rejectUpsert('documents', (row) => row.id === 'doc-2')

    const report = await sync(server)

    const stored = server.rows('documents').map((row) => row.id)
    expect(stored).toContain('doc-1')
    expect(stored).not.toContain('doc-2')
    // The chunk failed, then each row was retried on its own.
    expect(server.upsertCalls('documents')).toBe(3)
    expect(report.failures).toContainEqual(
      expect.objectContaining({ table: 'documents', key: 'doc-2' }),
    )
    expect(report.pushWatermarks.documents).toBeUndefined()

    // A failed row stays in the dirty journal for the next cycle.
    expect(await readDirtyKeys()).toContainEqual(
      expect.objectContaining({ store: 'documents', key: 'doc-2' }),
    )
  })

  it('continues to the next occurrence document after one RPC fails', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc('doc-1'))
    await idbPut(STORES.documents, doc('doc-2'))
    await idbPut(STORES.wordOccurrences, occurrence('doc-1', 'chat'))
    await idbPut(STORES.wordOccurrences, occurrence('doc-2', 'lune'))
    server.rejectRpc('replace_word_occurrences', (args) => args.p_document_id === 'doc-1')

    const report = await sync(server)

    expect(server.rpcCalls('replace_word_occurrences')).toBe(2)
    expect(
      server.rows('word_occurrences').filter((row) => row.document_id === 'doc-1'),
    ).toHaveLength(0)
    expect(
      server.rows('word_occurrences').filter((row) => row.document_id === 'doc-2'),
    ).toHaveLength(1)
    expect(report.failures).toContainEqual(
      expect.objectContaining({ table: 'occurrences', key: 'doc-1' }),
    )
    expect(report.pushWatermarks.occurrences).toBeUndefined()
    expect(report.succeededStores).not.toContain('wordOccurrences')
  })

  it('retries a failed table without re-sending successful tables', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc('doc-1'))
    await idbPut(STORES.documents, doc('doc-2'))
    await idbPut(STORES.wordStates, wordState('été'))
    server.rejectUpsert('documents', (row) => row.id === 'doc-2')

    const first = await sync(server)
    expect(first.failures.some((failure) => failure.table === 'documents')).toBe(true)
    const wordCalls = server.upsertCalls('word_states')
    expect(wordCalls).toBeGreaterThan(0)

    server.rejectUpsert('documents', null)
    const second = await sync(server, { push: first.pushWatermarks })

    expect(server.rows('documents').map((row) => row.id)).toContain('doc-2')
    expect(second.failures).toEqual([])
    expect(second.pushWatermarks.documents).toBeDefined()
    // The successful word table was not sent again.
    expect(server.upsertCalls('word_states')).toBe(wordCalls)
  })
})

describe('dirty keys are the clock-safe fallback', () => {
  it('pushes dirty keys even when their timestamp is at/below the table watermark', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc('doc-1'))
    const first = await sync(server)
    expect(server.rows('documents')[0]?.title).toBe('Title doc-1')

    // A local edit whose stamp stays below the future table watermark. Only the
    // dirty journal can select it.
    await idbPut(
      STORES.documents,
      doc('doc-1', { title: 'Edited locally', updatedAt: '2026-10-03T00:00:00.000Z' }),
    )
    expect(await readDirtyKeys()).toContainEqual(
      expect.objectContaining({ store: 'documents', key: 'doc-1' }),
    )

    const second = await sync(server, {
      push: { ...first.pushWatermarks, documents: '2027-01-01T00:00:00.000Z' },
    })

    expect(server.rows('documents')[0]?.title).toBe('Edited locally')
    expect(second.failures).toEqual([])
    expect(await readDirtyKeys()).not.toContainEqual(
      expect.objectContaining({ store: 'documents', key: 'doc-1' }),
    )
  })

  it('keeps a dirty key dirty when the pushed revision is stale', async () => {
    const server = memoryServer()
    const row = doc('doc-1')
    await idbPut(STORES.documents, row)
    const firstDirty = (await readDirtyKeys()).find(
      (dirty) => dirty.store === 'documents' && dirty.key === 'doc-1',
    )
    if (!firstDirty) throw new Error('dirty key missing')

    const first = await pushRows({
      userId: USER,
      db: server.client,
      languages: [],
      documents: [row],
      words: [],
      folders: [],
      tombstones: [],
      dirtyKeys: [firstDirty],
    })
    expect(first.succeededKeys).toEqual([firstDirty])
    expect(await readDirtyKeys()).not.toContainEqual(
      expect.objectContaining({ store: 'documents', key: 'doc-1' }),
    )

    // A newer write lands after the push was planned: revision moves on.
    const edited = doc('doc-1', { title: 'Newer edit', updatedAt: '2026-10-03T00:00:00.000Z' })
    await idbPut(STORES.documents, edited)
    const newerDirty = (await readDirtyKeys()).find(
      (dirty) => dirty.store === 'documents' && dirty.key === 'doc-1',
    )
    if (!newerDirty) throw new Error('newer dirty key missing')
    expect(newerDirty.revision).toBeGreaterThan(firstDirty.revision)

    // Push reports the stale key it actually sent, but clearing at the stale
    // revision must not remove the newer journal entry.
    const stale = await pushRows({
      userId: USER,
      db: server.client,
      languages: [],
      documents: [edited],
      words: [],
      folders: [],
      tombstones: [],
      dirtyKeys: [firstDirty],
    })
    expect(stale.succeededKeys).toEqual([firstDirty])
    expect(await readDirtyKeys()).toContainEqual(
      expect.objectContaining({ store: 'documents', key: 'doc-1', revision: newerDirty.revision }),
    )
  })
})

describe('occurrence keys with no local rows', () => {
  const staleOccurrence = (documentId: string) => ({
    id: 1,
    user_id: USER,
    document_id: documentId,
    language_code: 'fr',
    lemma: 'chat',
    surface: 'chat',
    char_start: 0,
    char_end: 4,
    sentence: '옛 문장',
    occurrences_count: 1,
  })

  it('clears server rows for a live document with an empty replacement', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc('doc-1'))
    // This device recomputed the document under the current rules and found
    // nothing to record; the server still holds rows from an older pass.
    await idbPut(STORES.documentMeta, { documentId: 'doc-1', lemmaVersion: LEMMA_VERSION })
    await replaceOccurrences<WordOccurrence>('doc-1', [])
    expect(await readDirtyKeys()).toContainEqual(
      expect.objectContaining({ store: 'wordOccurrences', key: 'doc-1' }),
    )
    server.add('word_occurrences', staleOccurrence('doc-1'))

    // Incremental pull: the stale row is not re-read this cycle, so the dirty
    // journal is the only thing that selects the document for a push.
    const report = await sync(server, { since: { snapshot: '2026-10-30T00:00:00.000Z' } })

    expect(report.failures).toEqual([])
    expect(server.rpcCalls('replace_word_occurrences')).toBe(1)
    expect(
      server.rows('word_occurrences').filter((row) => row.document_id === 'doc-1'),
    ).toHaveLength(0)
    expect(await readDirtyKeys()).not.toContainEqual(
      expect.objectContaining({ store: 'wordOccurrences', key: 'doc-1' }),
    )
  })

  it('does not send an empty replacement for a tombstoned document', async () => {
    const server = memoryServer()
    server.add('documents', serverDocument('doc-1'))
    server.add('word_occurrences', staleOccurrence('doc-1'))
    await idbPut(STORES.documents, doc('doc-1'))
    await idbPut(
      STORES.documentTombstones,
      { documentId: 'doc-1', purgedAt: '2026-10-10T00:00:00.000Z' },
      { silent: true },
    )
    await replaceOccurrences<WordOccurrence>('doc-1', [])

    const report = await sync(server)

    expect(report.failures).toEqual([])
    // The tombstone push deletes the document; its rows go with it server-side,
    // so no empty occurrence RPC is sent.
    expect(server.rpcCalls('replace_word_occurrences')).toBe(0)
    expect(server.rows('documents')).toHaveLength(0)
    expect(server.rows('document_tombstones').map((row) => row.document_id)).toContain('doc-1')
    expect(await readDirtyKeys()).not.toContainEqual(
      expect.objectContaining({ store: 'wordOccurrences', key: 'doc-1' }),
    )
  })
})

describe('legacy tombstones stay pushable', () => {
  const FUTURE = '2027-01-01T00:00:00.000Z'

  it('pushes a localStorage-only legacy purge despite a later tombstones watermark', async () => {
    const server = memoryServer()
    server.add('documents', serverDocument('doc-1'))
    localStorage.setItem('lexi.purged', JSON.stringify(['doc-1']))

    const report = await sync(server, { push: { tombstones: FUTURE } })

    expect(server.count('documents')).toBe(0)
    expect(server.rows('document_tombstones').map((row) => row.document_id)).toContain('doc-1')
    expect(report.failures).toEqual([])
    expect(report.pushWatermarks.tombstones).toBeDefined()
  })

  it('keeps an epoch-0 tombstone already in IndexedDB eligible without a dirty key', async () => {
    const server = memoryServer()
    server.add('documents', serverDocument('doc-1'))
    // An older build promoted the legacy purge silently: no dirty journal entry.
    await idbPut(
      STORES.documentTombstones,
      { documentId: 'doc-1', purgedAt: LEGACY_PURGE_AT },
      { silent: true },
    )
    expect(await readDirtyKeys()).not.toContainEqual(
      expect.objectContaining({ store: 'documentTombstones', key: 'doc-1' }),
    )

    const report = await sync(server, { push: { tombstones: FUTURE } })

    expect(server.count('documents')).toBe(0)
    expect(server.rows('document_tombstones').map((row) => row.document_id)).toContain('doc-1')
    expect(report.failures).toEqual([])
    expect(report.pushWatermarks.tombstones).toBeDefined()
  })
})
