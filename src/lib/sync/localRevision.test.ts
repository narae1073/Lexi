import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  DB_VERSION,
  STORES,
  SYNC_META_KEY,
  bumpLocalRevision,
  clearDirtyIfRevision,
  deleteLocalDatabase,
  ensureLocalSyncMeta,
  idbDelete,
  idbGet,
  idbPut,
  onLocalWrite,
  readDirtyKeys,
  readLocalSyncMeta,
  readLocalRevision,
  replaceOccurrences,
  subtractPending,
} from '../storage/localDb'
import type { LocalSyncMeta } from './types'

/**
 * The reserved sync-meta record (Release 2 plan, "Local revision, pending, and
 * epoch") owns the local revision, per-store pending counts, the dirty-key
 * journal, and the local database epoch. Every user write bumps it inside the
 * same IndexedDB transaction as the target row; silent sync writes never bump.
 */
describe('local revision, pending counts, and epoch', () => {
  beforeEach(async () => {
    // The epoch is created with the database, so each test starts from a fresh one
    await deleteLocalDatabase()
  })

  it('bumps revision, pending, and the dirty key once per user write', async () => {
    const first = await bumpLocalRevision(STORES.documents, 'doc-1')
    const second = await bumpLocalRevision(STORES.documents, 'doc-1')

    expect(second.revision).toBe(first.revision + 1)
    expect(second.pendingByStore.documents).toBe(2)
    expect(second.dirty.documents?.['doc-1']).toBe(second.revision)
  })

  it('bumps the meta in the same transaction as a plain user write', async () => {
    await ensureLocalSyncMeta()
    await idbPut(STORES.documents, { id: 'doc-1', title: 'One' })
    await idbPut(STORES.wordStates, { languageCode: 'en', lemma: 'run' })

    const meta = await readLocalSyncMeta()
    expect(meta?.revision).toBe(2)
    expect(meta?.pendingByStore).toEqual({ documents: 1, wordStates: 1 })
    // documents/folders/tombstones use the row id; wordStates uses language\0lemma
    expect(meta?.dirty.documents?.['doc-1']).toBe(1)
    expect(meta?.dirty.wordStates?.['en\u0000run']).toBe(2)
  })

  it('marks a deleted row dirty under its store key', async () => {
    await idbPut(STORES.documents, { id: 'doc-1', title: 'One' })
    await idbDelete(STORES.documents, 'doc-1')

    const meta = await readLocalSyncMeta()
    expect(meta?.revision).toBe(2)
    expect(meta?.pendingByStore.documents).toBe(2)
    expect(meta?.dirty.documents?.['doc-1']).toBe(2)
  })

  /**
   * The revision is an interlock only if the read-modify-write of the meta
   * happens inside the write transaction. Reading the meta before opening the
   * transaction would let one bump overwrite the other and lose a count.
   */
  it('does not lose a bump when two user writes overlap', async () => {
    await Promise.all([
      idbPut(STORES.documents, { id: 'doc-1', title: 'One' }),
      idbPut(STORES.documents, { id: 'doc-2', title: 'Two' }),
    ])

    const meta = await readLocalSyncMeta()
    expect(meta?.revision).toBe(2)
    expect(meta?.pendingByStore.documents).toBe(2)
    expect(Object.keys(meta?.dirty.documents ?? {}).sort()).toEqual(['doc-1', 'doc-2'])
  })

  it('marks a user occurrence replacement dirty by document id', async () => {
    await replaceOccurrences('doc-1', [occurrence('doc-1', 'run')])

    const meta = await readLocalSyncMeta()
    expect(meta?.pendingByStore.wordOccurrences).toBe(1)
    expect(meta?.dirty.wordOccurrences?.['doc-1']).toBe(1)
  })

  it('does not bump for a silent sync write', async () => {
    const before = await ensureLocalSyncMeta()
    await idbPut(STORES.documents, { id: 'doc-1', title: 'From the server' }, { silent: true })
    await idbDelete(STORES.documents, 'doc-1', { silent: true })
    await replaceOccurrences('doc-1', [occurrence('doc-1', 'run')], { silent: true })

    expect(await readLocalRevision()).toBe(before.revision)
    expect((await readLocalSyncMeta())?.pendingByStore).toEqual({})
    expect(await readDirtyKeys()).toEqual([])
  })

  it('does not bump for device-local stores', async () => {
    const before = await ensureLocalSyncMeta()
    await idbPut(STORES.documentMeta, { documentId: 'doc-1', lemmaVersion: 3 })
    await idbPut(STORES.responseCache, { key: 'k', value: 1 })

    expect(await readLocalRevision()).toBe(before.revision)
  })

  it('notifies local-write listeners once per user write with the bumped meta', async () => {
    const events: Array<{ store: string; meta: LocalSyncMeta }> = []
    const off = onLocalWrite((store, meta) => events.push({ store, meta }))

    await idbPut(STORES.documents, { id: 'doc-1', title: 'One' })
    await idbPut(STORES.documents, { id: 'doc-1', title: 'From the server' }, { silent: true })

    off()
    expect(events).toHaveLength(1)
    expect(events[0].store).toBe(STORES.documents)
    expect(events[0].meta.revision).toBe(1)
    expect(events[0].meta.dirty.documents?.['doc-1']).toBe(1)
  })

  it('clears a dirty key only at the revision that was pushed', async () => {
    const first = await bumpLocalRevision(STORES.documents, 'doc-1')
    expect(await clearDirtyIfRevision(STORES.documents, 'doc-1', first.revision)).toBe(true)
    expect((await readDirtyKeys()).some((k) => k.key === 'doc-1')).toBe(false)

    const second = await bumpLocalRevision(STORES.documents, 'doc-1')
    // A stale clear must not remove the newer write
    expect(await clearDirtyIfRevision(STORES.documents, 'doc-1', first.revision)).toBe(false)
    expect(
      (await readDirtyKeys()).some((k) => k.key === 'doc-1' && k.revision === second.revision),
    ).toBe(true)
  })

  it('lists dirty keys across stores with the revision of the last write', async () => {
    await idbPut(STORES.documents, { id: 'doc-1', title: 'One' })
    await replaceOccurrences('doc-2', [occurrence('doc-2', 'run')])

    expect(await readDirtyKeys()).toEqual([
      { store: STORES.documents, key: 'doc-1', revision: 1 },
      { store: STORES.wordOccurrences, key: 'doc-2', revision: 2 },
    ])
  })

  it('subtracts only the batch that was sent', async () => {
    await bumpLocalRevision(STORES.documents, 'doc-1')
    await bumpLocalRevision(STORES.documents, 'doc-1')
    await bumpLocalRevision(STORES.wordStates, 'en\u0000run')

    const afterDocuments = await subtractPending({ documents: 1 })
    expect(afterDocuments.pendingByStore).toEqual({ documents: 1, wordStates: 1 })

    // Over-subtracting clamps at zero; writes that landed during the sync stay
    const afterClamp = await subtractPending({ documents: 5 })
    expect(afterClamp.pendingByStore).toEqual({ wordStates: 1 })

    // Subtracting pending never touches the revision or the dirty journal
    expect(afterClamp.revision).toBe(3)
    expect((await readDirtyKeys()).some((k) => k.store === STORES.documents)).toBe(true)
  })

  it('keeps the epoch across reloads', async () => {
    const meta = await ensureLocalSyncMeta()
    expect((await readLocalSyncMeta())?.epoch).toBe(meta.epoch)
    // A later ensure reuses the stored record — it must not mint a new epoch
    expect((await ensureLocalSyncMeta()).epoch).toBe(meta.epoch)
  })

  it('mints a new epoch after the database is recreated', async () => {
    const first = await ensureLocalSyncMeta()
    await deleteLocalDatabase()

    const second = await ensureLocalSyncMeta()
    expect(second.epoch).not.toBe(first.epoch)
    expect(second.revision).toBe(0)
    expect(second.pendingByStore).toEqual({})
  })

  it('stores the meta in documentMeta without changing the DB version', async () => {
    await ensureLocalSyncMeta()

    expect(DB_VERSION).toBe(6)
    const stored = await idbGet<LocalSyncMeta>(STORES.documentMeta, SYNC_META_KEY)
    expect(stored?.epoch).toBeDefined()

    // The database on disk is still version 6 — no upgrade, no new store, so
    // the previous frontend can keep opening a database this build has touched
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lexi')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(db.version).toBe(6)
    db.close()
  })
})

function occurrence(documentId: string, lemma: string) {
  return {
    documentId,
    languageCode: 'en' as const,
    lemma,
    surfaces: [lemma],
    count: 1,
    charStart: 0,
    charEnd: lemma.length,
    sentence: '',
    documentTitle: '',
    recordedAt: 1,
  }
}
