import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  STORES,
  clearDirtyIfRevision,
  idbDelete,
  idbGetAll,
  idbPut,
  readDirtyKeys,
  type StoreName,
} from '../storage/localDb'
import type { Document } from '../../types'
import { clearPushOnClockRollback } from './syncState'
import { syncOnce, type PushWatermarks } from './sync'
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

/** One day ahead of this run — always "the future", so it cannot date-rot. */
const FUTURE = new Date(Date.now() + 86_400_000).toISOString()

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
  options: { push?: PushWatermarks } = {},
) => syncOnce({ userId: USER, languages: ['fr'], db: server.client, ...options })

beforeEach(async () => {
  legacyStorage.clear()
  await clearStore(STORES.documents)
  await clearStore(STORES.folders)
  await clearStore(STORES.wordStates)
  await clearStore(STORES.wordOccurrences)
  await clearStore(STORES.documentTombstones)
  await clearStore(STORES.documentMeta)
})

/**
 * A clock rollback must not strand local rows behind a future watermark. The
 * dirty-key union is what keeps a write that lands during the same cycle from
 * being skipped once the watermark advances past its timestamp.
 */
describe('clock rollback guard', () => {
  it('clears all push watermarks when now is before any stored watermark', () => {
    const result = clearPushOnClockRollback(
      { documents: '2026-10-26T00:00:00.000Z' },
      Date.parse('2026-10-25T00:00:00.000Z'),
    )
    expect(result.rolledBack).toBe(true)
    expect(result.push).toEqual({})
  })

  it('pushes a local change whose timestamp is older than the pre-rollback watermark', async () => {
    const server = memoryServer()
    // The local row is older than the future watermark and was written by an
    // older build, so it has no dirty entry: only clearing the push watermarks
    // can make it eligible.
    await idbPut(
      STORES.documents,
      doc('doc-1', { updatedAt: '2026-10-03T00:00:00.000Z' }),
      { silent: true },
    )

    const report = await sync(server, { push: { documents: FUTURE } })

    expect(server.rows('documents').map((row) => row.id)).toContain('doc-1')
    expect(report.failures).toEqual([])
    expect(report.warnings).toContain('clock-rollback')
    // The cycle advanced from the cleared map, not from the future watermark.
    expect(report.pushWatermarks.documents).not.toBe(FUTURE)
  })

  it('pushes an in-flight dirty write even after the watermark advanced past its timestamp', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc('doc-1'))

    // Sync A pushes the first version and advances push.documents to its start.
    const first = await sync(server)
    expect(first.failures).toEqual([])
    const advanced = first.pushWatermarks.documents
    if (advanced === undefined) throw new Error('documents watermark missing')

    // A write lands after A planned its batch, but with a timestamp older than
    // the watermark A just advanced to. Its first revision is an in-flight one.
    await idbPut(
      STORES.documents,
      doc('doc-1', { title: 'In-flight edit', updatedAt: '2026-10-03T00:00:00.000Z' }),
    )
    const inFlight = (await readDirtyKeys()).find(
      (dirty) => dirty.store === 'documents' && dirty.key === 'doc-1',
    )
    if (!inFlight) throw new Error('in-flight dirty key missing')

    // A newer write moves the journal on. Clearing at the older revision is a
    // stale clear and must not remove the live entry.
    await idbPut(
      STORES.documents,
      doc('doc-1', { title: 'Newer in-flight edit', updatedAt: '2026-10-03T00:00:00.000Z' }),
    )
    expect(await clearDirtyIfRevision('documents', 'doc-1', inFlight.revision)).toBe(false)
    expect(await readDirtyKeys()).toContainEqual(
      expect.objectContaining({ store: 'documents', key: 'doc-1' })
    )

    // Sync B still sees a cumulative watermark that is later than the row's
    // timestamp; only the dirty key can select it.
    expect(Date.parse(advanced)).toBeGreaterThan(
      Date.parse('2026-10-03T00:00:00.000Z'),
    )
    const second = await sync(server, { push: first.pushWatermarks })

    const stored = server.rows('documents').find((row) => row.id === 'doc-1')
    expect(stored?.title).toBe('Newer in-flight edit')
    expect(second.failures).toEqual([])
    // No rollback happened, so the guard adds no warning to this cycle.
    expect(second.warnings).toEqual([])
    expect(await readDirtyKeys()).not.toContainEqual(
      expect.objectContaining({ store: 'documents', key: 'doc-1' })
    )
  })
})
