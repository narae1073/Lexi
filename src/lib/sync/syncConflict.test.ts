import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as localDb from '../storage/localDb'
import {
  STORES,
  deleteLocalDatabase,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  readLocalRevision,
} from '../storage/localDb'
import type { Document } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { SyncDeferredError, syncOnce, writeLocal } from './sync'
import { memoryServer, type Server } from './testMemoryServer'

const T1 = '2026-10-01T00:00:00.000Z'
const T2 = '2026-10-02T00:00:00.000Z'

const doc = (over: Partial<Document> = {}): Document => ({
  id: 'doc-1',
  title: 'local',
  languageCode: 'fr',
  rawText: 'Le chat dort.',
  createdAt: T1,
  updatedAt: T1,
  ...over,
})

const occurrence = (over: Partial<WordOccurrence> = {}): WordOccurrence => ({
  documentId: 'doc-1',
  languageCode: 'fr',
  lemma: 'chat',
  surfaces: ['chat'],
  count: 1,
  recordedAt: 1,
  charStart: 0,
  charEnd: 4,
  sentence: 'Le chat dort.',
  documentTitle: 'local',
  ...over,
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function addRemoteDocument(server: Server, over: Record<string, unknown> = {}) {
  server.add('documents', {
    id: 'doc-1',
    user_id: 'user-1',
    title: 'remote',
    language_code: 'fr',
    raw_text: 'Le chat dort.',
    created_at: T1,
    updated_at: T1,
    deleted_at: null,
    folder_id: null,
    folder_updated_at: null,
    server_updated_at: T1,
    ...over,
  })
}

const sync = (server: Server) =>
  syncOnce({ userId: 'user-1', languages: ['fr'], db: server.client })

/**
 * Holds the pull after it has fetched a page, so a local write can land while
 * the server read is still in flight.
 */
async function startGatedSync(server: Server) {
  const entered = deferred()
  const release = deferred()
  let announced = false
  server.afterPage(async () => {
    if (!announced) {
      announced = true
      entered.resolve()
    }
    await release.promise
  })

  const run = sync(server)
  await entered.promise
  return { run, release }
}

beforeEach(async () => {
  await deleteLocalDatabase()
})

describe('revision conflict detection', () => {
  it('preserves a local write made while the pull is in flight', async () => {
    const server = memoryServer()
    addRemoteDocument(server, { title: 'remote', updated_at: T1 })
    await idbPut(STORES.documents, doc({ title: 'before', updatedAt: T1 }))

    const { run, release } = await startGatedSync(server)
    await idbPut(STORES.documents, doc({ title: 'local during pull', updatedAt: T2 }))
    release.resolve()
    await run

    expect((await idbGet<Document>(STORES.documents, 'doc-1'))?.title).toBe(
      'local during pull',
    )
  })

  it('replans occurrence content changed while the pull is in flight', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc({ title: 'local' }))
    await idbPut(
      STORES.wordOccurrences,
      occurrence({ lemma: 'chat', surfaces: ['chat'], sentence: 'stale local' }),
    )
    /**
     * The pull carries an occurrence row for a document this device already has
     * without naming that document in its document list. The merge keeps local
     * rows it does not replace, but a stale plan still sees the remote row as a
     * content change and rewrites the whole document — so only the re-read and
     * replan can preserve a row the user added during the pull.
     */
    server.add('word_occurrences', {
      id: 1,
      user_id: 'user-1',
      document_id: 'doc-1',
      language_code: 'fr',
      lemma: 'chat',
      surface: 'chat',
      char_start: 0,
      char_end: 4,
      sentence: 'remote',
      occurrences_count: 1,
    })

    const { run, release } = await startGatedSync(server)
    // A real user write: adding a second occurrence for the same document.
    await idbPut(
      STORES.wordOccurrences,
      occurrence({
        lemma: 'chien',
        surfaces: ['chien'],
        charStart: 10,
        charEnd: 15,
        sentence: 'local during pull',
      }),
    )
    release.resolve()
    await run

    const rows = await idbGetAll<WordOccurrence>(STORES.wordOccurrences)
    // The stale plan would replace doc-1 with just the remote chat row and the
    // new chien row would disappear.
    expect(rows.map((row) => row.lemma).sort()).toEqual(['chat', 'chien'])
    expect(rows.find((row) => row.lemma === 'chien')?.sentence).toBe('local during pull')
  })

  it('defers without writing or advancing watermarks when writes keep landing', async () => {
    const server = memoryServer()
    addRemoteDocument(server)
    await idbPut(STORES.documents, doc({ title: 'only local' }))
    const revisionBefore = await readLocalRevision()

    // Two separate local writes are observed: the first forces the re-read,
    // the second lands while that re-read is being planned.
    const revisions = [revisionBefore + 1, revisionBefore + 2, revisionBefore + 3]
    const spy = vi
      .spyOn(localDb, 'readLocalRevision')
      .mockImplementation(async () => revisions.shift() ?? revisionBefore + 4)

    try {
      await expect(sync(server)).rejects.toBeInstanceOf(SyncDeferredError)
    } finally {
      spy.mockRestore()
    }

    // Nothing from the stale plan was written and no watermark was produced.
    expect((await idbGet<Document>(STORES.documents, 'doc-1'))?.title).toBe('only local')
    expect(server.upsertCalls('documents')).toBe(0)
    // The revision itself did not move because the sync wrote nothing.
    expect(await localDb.readLocalRevision()).toBe(revisionBefore)
  })
})

describe('expectedRevision occurrence interlock', () => {
  it('does not overwrite occurrences when the revision changed before writeLocal', async () => {
    await idbPut(STORES.documents, doc())
    await idbPut(STORES.wordOccurrences, occurrence({ sentence: 'local sentinel' }))
    const revision = await readLocalRevision()

    const result = await writeLocal(
      [doc({ title: 'remote', updatedAt: T2 })],
      [],
      [occurrence({ sentence: 'stale plan' })],
      [],
      [],
      {
        occurrenceDocumentIds: new Set(['doc-1']),
        expectedRevision: revision - 1,
      },
    )

    expect(
      (await idbGet<{ sentence: string }>(STORES.wordOccurrences, ['doc-1', 'chat']))
        ?.sentence,
    ).toBe('local sentinel')
    expect(result.occurrences).toBe(0)
  })

  it('serializes a user write against writeLocal without losing either value', async () => {
    await idbPut(STORES.documents, doc({ title: 'before', updatedAt: T1 }))
    await idbPut(STORES.wordOccurrences, occurrence({ sentence: 'local sentinel' }))
    const expectedRevision = await readLocalRevision()

    // Queue the user write first: IndexedDB commits it before writeLocal's
    // transaction, which is the race the expectedRevision check must survive.
    const userWrite = idbPut(
      STORES.documents,
      doc({ title: 'user newer', updatedAt: T2 }),
    )
    const result = await writeLocal(
      [doc({ title: 'stale plan', updatedAt: T1 })],
      [],
      [occurrence({ sentence: 'stale plan' })],
      [],
      [],
      {
        occurrenceDocumentIds: new Set(['doc-1']),
        expectedRevision,
      },
    )
    await userWrite

    expect((await idbGet<Document>(STORES.documents, 'doc-1'))?.title).toBe('user newer')
    expect(
      (await idbGet<{ sentence: string }>(STORES.wordOccurrences, ['doc-1', 'chat']))
        ?.sentence,
    ).toBe('local sentinel')
    expect(result.occurrences).toBe(0)
  })
})

describe('in-flight purge protection', () => {
  it('does not resurrect a document whose local tombstone appeared at transaction entry', async () => {
    await idbPut(STORES.documents, doc())
    await idbPut(STORES.wordOccurrences, occurrence({ sentence: 'local sentinel' }))
    // The plan was made before this purge; the pull still names doc-1.
    await idbPut(STORES.documentTombstones, { documentId: 'doc-1', purgedAt: T2 })
    await idbDelete(STORES.documents, 'doc-1')
    const revision = await readLocalRevision()

    const result = await writeLocal(
      [doc({ title: 'remote', updatedAt: T2 })],
      [],
      [occurrence({ sentence: 'stale plan' })],
      [],
      [],
      {
        occurrenceDocumentIds: new Set(['doc-1']),
        expectedRevision: revision,
      },
    )

    expect(await idbGet<Document>(STORES.documents, 'doc-1')).toBeUndefined()
    expect(
      (await idbGet<{ sentence: string }>(STORES.wordOccurrences, ['doc-1', 'chat']))
        ?.sentence,
    ).toBe('local sentinel')
    expect(result.documents).toBe(0)
    expect(result.occurrences).toBe(0)
  })

  it('does not resurrect a document purged after the sync planned its pull', async () => {
    const server = memoryServer()
    addRemoteDocument(server, { title: 'remote', updated_at: T2 })
    await idbPut(STORES.documents, doc({ title: 'local', updatedAt: T1 }))
    await idbPut(STORES.wordOccurrences, occurrence({ sentence: 'local sentinel' }))

    const { run, release } = await startGatedSync(server)
    // Hard purge while the snapshot is already in flight.
    await idbPut(STORES.documentTombstones, { documentId: 'doc-1', purgedAt: T2 })
    await idbDelete(STORES.documents, 'doc-1')
    await idbDelete(STORES.wordOccurrences, ['doc-1', 'chat'])
    release.resolve()
    await run

    expect(await idbGet<Document>(STORES.documents, 'doc-1')).toBeUndefined()
    expect(
      await idbGetAll<WordOccurrence>(STORES.wordOccurrences),
    ).toHaveLength(0)
    expect(
      await idbGet<{ documentId: string }>(STORES.documentTombstones, 'doc-1'),
    ).toBeDefined()
  })
})
