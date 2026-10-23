import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  DB_VERSION,
  STORES,
  SYNC_META_KEY,
  deleteLocalDatabase,
  ensureLocalSyncMeta,
  idbCount,
  idbGet,
  idbGetAllByIndex,
  onLocalWrite,
  openLocalDatabase,
  readLocalSyncMeta,
} from './localDb'
import type { StoreName } from './localDb'
import { clearDocumentContent, putDocumentContent, readDocumentContent } from './documentContent'
import { deleteWordbookEntry, putWordbookEntries, readWordbookEntries } from './wordbookEntries'
import type { WordbookEntryInput } from './wordbookEntries'

const DB_NAME = 'lexi'
/** The database version Release 2 shipped; the upgrade must start from it. */
const V6_VERSION = 6

/**
 * IndexedDB v7 is the one-way frontend boundary for R3: the synced wordbook
 * projection and lazy document content need stores the v6 schema does not
 * have, and a version bump is the only way to add them. An existing device
 * must keep every learning row; an older frontend can no longer open the
 * database afterwards (server rollback stays possible).
 */
describe('IndexedDB v7 upgrade', () => {
  beforeEach(async () => {
    await deleteLocalDatabase()
  })

  it('is version 7 and declares the projection and content stores', async () => {
    expect(DB_VERSION).toBe(7)

    const db = await openLocalDatabase()
    expect(db.version).toBe(7)
    expect(Array.from(db.objectStoreNames)).toEqual(
      expect.arrayContaining([STORES.wordbookEntries, STORES.documentContent]),
    )
  })

  it('upgrades a v6 database without losing learning data', async () => {
    await seedV6Database()
    // The reserved sync meta proves the upgrade does not reset device
    // bookkeeping (epoch, revision, pending, dirty keys).
    await openLocalDatabase()

    expect(await idbGet(STORES.documents, 'doc-1')).toMatchObject({ title: 'Legacy' })
    expect(await idbGet(STORES.wordStates, ['en', 'run'])).toMatchObject({ status: 'known' })
    expect(await idbGet(STORES.wordOccurrences, ['doc-1', 'run'])).toMatchObject({ count: 2 })
    expect(await idbGet(STORES.folders, 'folder-1')).toMatchObject({ name: 'Legacy folder' })
    expect(await idbGet(STORES.wordStates, ['fr', 'courir'])).toMatchObject({ status: 'unsure' })

    expect(await readLocalSyncMeta()).toMatchObject({
      epoch: 'epoch-legacy',
      revision: 4,
      pendingByStore: { documents: 1 },
      dirty: { documents: { 'doc-1': 4 } },
    })

    // The new stores are created empty: a v6 device has no projection or
    // content copy yet, and inventing rows here would be worse than a pull.
    expect(await idbCount(STORES.wordbookEntries)).toBe(0)
    expect(await idbCount(STORES.documentContent)).toBe(0)
  })

  it('keeps every v6 store row addressable after the upgrade', async () => {
    await seedV6Database()
    const db = await openLocalDatabase()

    const v6Stores = [
      STORES.documents,
      STORES.folders,
      STORES.wordStates,
      STORES.wordOccurrences,
      STORES.responseCache,
      STORES.documentMeta,
      STORES.documentTombstones,
    ]
    for (const store of v6Stores) {
      expect(db.objectStoreNames.contains(store)).toBe(true)
    }
    expect(await idbCount(STORES.responseCache)).toBe(1)
    expect(await idbCount(STORES.documentMeta)).toBe(1)
    expect(await idbCount(STORES.documentTombstones)).toBe(1)
  })

  it('creates the documented keys and indexes for the new stores', async () => {
    const db = await openLocalDatabase()
    const transaction = db.transaction(
      [STORES.wordbookEntries, STORES.documentContent],
      'readonly',
    )

    const projection = transaction.objectStore(STORES.wordbookEntries)
    expect(projection.keyPath).toEqual(['languageCode', 'lemma'])
    expect(Array.from(projection.indexNames).sort()).toEqual(['languageCode', 'lemma'])

    const content = transaction.objectStore(STORES.documentContent)
    expect(content.keyPath).toBe('documentId')
    expect(Array.from(content.indexNames)).toEqual([])
  })

  it('refuses to open a v7 database from the v6 frontend', async () => {
    await openLocalDatabase()

    // The accepted rollback boundary: an R2 build must fail loudly instead of
    // silently deleting or recreating the database.
    await expect(openRaw(V6_VERSION)).rejects.toMatchObject({ name: 'VersionError' })
    // The failed open must not have touched the database.
    const db = await openLocalDatabase()
    expect(db.version).toBe(7)
  })
})

describe('local wordbook projection store', () => {
  beforeEach(async () => {
    await deleteLocalDatabase()
  })

  it('round-trips entries per language', async () => {
    await putWordbookEntries([
      entry(),
      entry({ lemma: 'walk', surfaces: ['walked'] }),
      entry({ languageCode: 'fr', lemma: 'courir' }),
    ])

    const english = await readWordbookEntries('en')
    expect(english.map((row) => row.lemma).sort()).toEqual(['run', 'walk'])
    expect(english.find((row) => row.lemma === 'run')).toMatchObject({
      languageCode: 'en',
      surfaces: ['run'],
      occurrenceCount: 3,
      documentCount: 2,
      note: 'note',
    })
    await expect(readWordbookEntries('de')).resolves.toEqual([])
  })

  it('replaces an existing entry instead of duplicating it', async () => {
    await putWordbookEntries([entry({ note: 'old', occurrenceCount: 1 })])
    await putWordbookEntries([entry({ note: 'new', occurrenceCount: 9 })])

    const rows = await readWordbookEntries('en')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ lemma: 'run', note: 'new', occurrenceCount: 9 })
  })

  it('removes a soft-deleted projection row instead of storing it', async () => {
    await putWordbookEntries([entry(), entry({ lemma: 'walk' })])

    // The server keeps a tombstone row so an incremental pull can propagate the
    // removal. It must delete the local entry, never become a phantom entry.
    await putWordbookEntries([entry({ deletedAt: '2026-10-23T00:00:00.000Z' })])

    await expect(readWordbookEntries('en')).resolves.toMatchObject([{ lemma: 'walk' }])
  })

  it('deletes one lemma without touching other languages or lemmas', async () => {
    await putWordbookEntries([
      entry(),
      entry({ lemma: 'walk' }),
      entry({ languageCode: 'fr', lemma: 'run' }),
    ])

    await deleteWordbookEntry('en', 'run')

    expect((await readWordbookEntries('en')).map((row) => row.lemma)).toEqual(['walk'])
    expect((await readWordbookEntries('fr')).map((row) => row.lemma)).toEqual(['run'])
  })

  it('serves the lemma index across languages', async () => {
    await putWordbookEntries([
      entry(),
      entry({ languageCode: 'fr', lemma: 'run' }),
      entry({ lemma: 'walk' }),
    ])

    const byLemma = await idbGetAllByIndex<{ languageCode: string }>(
      STORES.wordbookEntries,
      'lemma',
      'run',
    )
    expect(byLemma.map((row) => row.languageCode).sort()).toEqual(['en', 'fr'])
  })

  it('rejects a row that cannot be keyed', async () => {
    await expect(putWordbookEntries([entry({ lemma: '' })])).rejects.toThrow('lemma')
  })
})

describe('local document content store', () => {
  beforeEach(async () => {
    await deleteLocalDatabase()
  })

  it('round-trips the text and version stamps', async () => {
    const payload = {
      rawText: 'The quick brown fox',
      contentUpdatedAt: '2026-10-23T00:00:00.000Z',
      occurrencesUpdatedAt: '2026-10-23T01:00:00.000Z',
    }
    await putDocumentContent('doc-1', payload)

    await expect(readDocumentContent('doc-1')).resolves.toEqual({
      documentId: 'doc-1',
      ...payload,
    })
  })

  it('returns undefined for content that was never loaded', async () => {
    await expect(readDocumentContent('missing')).resolves.toBeUndefined()
  })

  it('overwrites an older copy when content is fetched again', async () => {
    await putDocumentContent('doc-1', {
      rawText: 'old',
      contentUpdatedAt: '2026-10-22T00:00:00.000Z',
      occurrencesUpdatedAt: '2026-10-22T00:00:00.000Z',
    })
    await putDocumentContent('doc-1', {
      rawText: 'new',
      contentUpdatedAt: '2026-10-23T00:00:00.000Z',
      occurrencesUpdatedAt: '2026-10-22T00:00:00.000Z',
    })

    await expect(readDocumentContent('doc-1')).resolves.toMatchObject({
      rawText: 'new',
      contentUpdatedAt: '2026-10-23T00:00:00.000Z',
    })
    expect(await idbCount(STORES.documentContent)).toBe(1)
  })

  it('clears one document and leaves the rest', async () => {
    await putDocumentContent('doc-1', {
      rawText: 'one',
      contentUpdatedAt: null,
      occurrencesUpdatedAt: null,
    })
    await putDocumentContent('doc-2', {
      rawText: 'two',
      contentUpdatedAt: null,
      occurrencesUpdatedAt: null,
    })

    await clearDocumentContent('doc-1')

    await expect(readDocumentContent('doc-1')).resolves.toBeUndefined()
    await expect(readDocumentContent('doc-2')).resolves.toMatchObject({ rawText: 'two' })
  })
})

/**
 * Projection and content copies are device-local: they are derived from the
 * server (or, in local-only mode, from local rows) and can be downloaded again.
 * Writing them must not look like a user edit — no revision bump, no pending
 * count, no dirty key, no sync signal.
 */
describe('device-local projection and content writes', () => {
  beforeEach(async () => {
    await deleteLocalDatabase()
  })

  it('never bump the sync revision, pending counts, dirty keys, or signal', async () => {
    await ensureLocalSyncMeta()
    const seen: StoreName[] = []
    const off = onLocalWrite((store) => seen.push(store))

    await putWordbookEntries([entry(), entry({ lemma: 'walk' })])
    await putDocumentContent('doc-1', {
      rawText: 'text',
      contentUpdatedAt: '2026-10-23T00:00:00.000Z',
      occurrencesUpdatedAt: null,
    })
    await deleteWordbookEntry('en', 'run')
    await clearDocumentContent('doc-1')
    await Promise.resolve()

    expect(seen).toEqual([])
    const meta = await readLocalSyncMeta()
    expect(meta?.revision).toBe(0)
    expect(meta?.pendingByStore).toEqual({})
    expect(meta?.dirty).toEqual({})
    off()
  })
})

function entry(over: Partial<WordbookEntryInput> = {}): WordbookEntryInput {
  return {
    languageCode: 'en',
    lemma: 'run',
    surfaces: ['run'],
    contexts: [{ documentId: 'doc-1', sentence: 'I run.' }],
    occurrenceCount: 3,
    documentCount: 2,
    status: 'known',
    isFavorite: false,
    starAngle: 0,
    starColor: '#eab308',
    seenCount: 2,
    firstSeenAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-02T00:00:00.000Z',
    favoriteUpdatedAt: null,
    knownPresses: 1,
    unsurePresses: 0,
    unknownPresses: 0,
    note: 'note',
    noteUpdatedAt: '2026-10-02T00:00:00.000Z',
    serverUpdatedAt: '2026-10-23T00:00:00.000Z',
    ...over,
  }
}

/** Opens a database at `version`, with the v6 schema when it must be created. */
function openRaw(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version)
    request.onupgradeneeded = () => {
      createV6Schema(request.result)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Recreates the Release 2 schema and seeds one row per learning store.
 *
 * Written out instead of reusing the current `onupgradeneeded` on purpose: the
 * test must describe the database a real R2 device has, not whatever the code
 * happens to create today.
 */
async function seedV6Database(): Promise<void> {
  const request = indexedDB.open(DB_NAME, V6_VERSION)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => createV6Schema(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      [
        STORES.documents,
        STORES.folders,
        STORES.wordStates,
        STORES.wordOccurrences,
        STORES.responseCache,
        STORES.documentMeta,
        STORES.documentTombstones,
      ],
      'readwrite',
    )
    const updatedAt = '2026-10-01T00:00:00.000Z'

    transaction.objectStore(STORES.documents).put({
      id: 'doc-1',
      title: 'Legacy',
      languageCode: 'en',
      rawText: 'I run.',
      createdAt: updatedAt,
      updatedAt,
      deletedAt: null,
      folderId: null,
      folderUpdatedAt: updatedAt,
    })
    transaction.objectStore(STORES.folders).put({
      id: 'folder-1',
      name: 'Legacy folder',
      parentId: null,
      createdAt: updatedAt,
      updatedAt,
    })
    transaction.objectStore(STORES.wordStates).put({
      languageCode: 'en',
      lemma: 'run',
      status: 'known',
      seenCount: 2,
      firstSeenAt: updatedAt,
      lastSeenAt: updatedAt,
      favorite: true,
      favoriteUpdatedAt: updatedAt,
      starAngle: 0,
      starColor: '#eab308',
      knownPresses: 1,
      unsurePresses: 0,
      unknownPresses: 0,
      note: null,
      noteUpdatedAt: null,
    })
    transaction.objectStore(STORES.wordStates).put({
      languageCode: 'fr',
      lemma: 'courir',
      status: 'unsure',
      seenCount: 1,
      firstSeenAt: updatedAt,
      lastSeenAt: updatedAt,
      favorite: false,
      favoriteUpdatedAt: null,
      starAngle: 0,
      starColor: '#eab308',
      knownPresses: 0,
      unsurePresses: 1,
      unknownPresses: 0,
      note: null,
      noteUpdatedAt: null,
    })
    transaction.objectStore(STORES.wordOccurrences).put({
      documentId: 'doc-1',
      lemma: 'run',
      languageCode: 'en',
      surfaces: ['run'],
      count: 2,
      charStart: 2,
      charEnd: 5,
      sentence: 'I run.',
      documentTitle: 'Legacy',
      recordedAt: 1,
    })
    transaction.objectStore(STORES.responseCache).put({
      key: 'dict:run',
      value: { lemma: 'run' },
      cachedAt: Date.parse(updatedAt),
    })
    transaction.objectStore(STORES.documentMeta).put({
      documentId: SYNC_META_KEY,
      epoch: 'epoch-legacy',
      revision: 4,
      pendingByStore: { documents: 1 },
      dirty: { documents: { 'doc-1': 4 } },
    })
    transaction.objectStore(STORES.documentTombstones).put({
      documentId: 'doc-gone',
      purgedAt: updatedAt,
    })

    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })

  db.close()
}

/** The stores and indexes Release 2 created, in the order it created them. */
function createV6Schema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORES.documents)) {
    const s = db.createObjectStore(STORES.documents, { keyPath: 'id' })
    s.createIndex('updatedAt', 'updatedAt')
  }
  if (!db.objectStoreNames.contains(STORES.folders)) {
    const s = db.createObjectStore(STORES.folders, { keyPath: 'id' })
    s.createIndex('updatedAt', 'updatedAt')
    s.createIndex('parentId', 'parentId')
  }
  if (!db.objectStoreNames.contains(STORES.wordStates)) {
    const s = db.createObjectStore(STORES.wordStates, { keyPath: ['languageCode', 'lemma'] })
    s.createIndex('languageCode', 'languageCode')
  }
  if (!db.objectStoreNames.contains(STORES.documentMeta)) {
    db.createObjectStore(STORES.documentMeta, { keyPath: 'documentId' })
  }
  if (!db.objectStoreNames.contains(STORES.responseCache)) {
    const s = db.createObjectStore(STORES.responseCache, { keyPath: 'key' })
    s.createIndex('cachedAt', 'cachedAt')
  }
  if (!db.objectStoreNames.contains(STORES.wordOccurrences)) {
    const s = db.createObjectStore(STORES.wordOccurrences, {
      keyPath: ['documentId', 'lemma'],
    })
    s.createIndex('languageCode', 'languageCode')
    s.createIndex('lemma', 'lemma')
    s.createIndex('documentId', 'documentId')
  }
  if (!db.objectStoreNames.contains(STORES.documentTombstones)) {
    db.createObjectStore(STORES.documentTombstones, { keyPath: 'documentId' })
  }
}
