import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  STORES,
  SYNC_META_KEY,
  idbGet,
  idbGetAll,
  idbPut,
  onLocalWrite,
} from '../../lib/storage/localDb'
import type { Document, Folder } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { putDocumentContent, readDocumentContent } from '../storage/documentContent'
import { writeLocal } from './sync'

/**
 * 같은 것을 다시 쓰지 않는다.
 *
 * 회귀: 동기화는 병합 결과를 통째로 되돌려 썼다. 그대로면 매번 모든 문서와 단어 상태를
 * 다시 저장하고, 저장이 곧 '아직 서버에 못 갔다' 는 신호가 되어 동기화가 영영
 * '밀렸다' 고 알렸다 — 실제로는 다 올라간 뒤에도 'Not synced yet' 이 사라지지 않았다.
 */
describe('병합 결과를 되돌려 쓸 때', () => {
  const T2 = '2026-01-02T00:00:00.000Z'

  const word = (over: Record<string, unknown> = {}) => ({
    languageCode: 'en',
    lemma: 'run',
    seenCount: 2,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-02T00:00:00.000Z',
    status: 'known' as const,
    favorite: false,
    favoriteUpdatedAt: '2026-01-01T00:00:00.000Z',
    starAngle: 0,
    starColor: '#eab308',
    knownPresses: 0,
    unsurePresses: 0,
    unknownPresses: 0,
    ...over,
  })

  const doc = (over: Partial<Document> = {}): Document => ({
    id: 'doc-1',
    title: 'Untitled',
    languageCode: 'en',
    rawText: 'I run daily.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: T2,
    ...over,
  })

  const occurrence = (over: Partial<WordOccurrence> = {}): WordOccurrence => ({
    documentId: 'doc-1',
    languageCode: 'en',
    lemma: 'run',
    surfaces: ['run'],
    count: 1,
    recordedAt: 1,
    charStart: 0,
    charEnd: 3,
    sentence: '새 문장',
    documentTitle: 'Untitled',
    ...over,
  })

  const noOptions = { occurrenceDocumentIds: new Set<string>() }

  beforeEach(async () => {
    await idbPut(STORES.documents, doc())
    await idbPut(STORES.wordStates, word())
  })

  it('같은 것을 다시 쓰지 않는다 — 조용해야 할 곳에 시끄러움을 두지 않는다', async () => {
    const writes: string[] = []
    const off = onLocalWrite((store) => writes.push(store))
    await writeLocal([doc()], [word()], [], [], [], noOptions)
    await Promise.resolve()
    off()

    expect(writes).toEqual([])
  })

  it('제목이 바뀌었으면 저장은 하되 알리지 않는다 — 동기화가 쓴 것이다', async () => {
    const writes: string[] = []
    const off = onLocalWrite((store) => writes.push(store))
    await writeLocal([doc({ title: '새 제목' })], [word()], [], [], [], noOptions)
    await Promise.resolve()
    off()

    // 저장은 됐다
    expect((await idbGet<Document>(STORES.documents, 'doc-1'))?.title).toBe('새 제목')
    // 그러나 사용자가 저장한 것으로 세지 않는다 — 받은 것이 '밀린 변경' 이 되면 안 된다
    expect(writes).toEqual([])
  })

  it('단어 상태가 바뀌었으면 저장은 하되 알리지 않는다', async () => {
    const writes: string[] = []
    const off = onLocalWrite((store) => writes.push(store))
    await writeLocal([doc()], [word({ status: 'unsure' })], [], [], [], noOptions)
    await Promise.resolve()
    off()

    expect((await idbGet<{ status: string }>(STORES.wordStates, ['en', 'run']))?.status).toBe('unsure')
    expect(writes).toEqual([])
  })

  it('사용자가 직접 저장하면 알린다 — 조용한 것은 동기화뿐이다', async () => {
    const writes: string[] = []
    const off = onLocalWrite((store) => writes.push(store))
    await idbPut(STORES.documents, doc({ title: '직접 고침' }))
    await Promise.resolve()
    off()

    expect(writes).toContain(STORES.documents)
  })

  it('다른 기기에서 받은 상태도 비교해 쓸지 정한다 — 같으면 쓰지 않는다', async () => {
    const stored = await idbGet<Record<string, unknown>>(STORES.wordStates, ['en', 'run'])
    expect(stored?.status).toBe('known')

    // 서버에서 같은 값이 돌아왔다
    await writeLocal([doc()], [word()], [], [], [], noOptions)
    const after = await idbGet<Record<string, unknown>>(STORES.wordStates, ['en', 'run'])
    expect(after).toEqual(stored)
  })

  it('여러 번 동기화해도 저장은 늘지 않는다 — 같은 내용을 반복해서 밀어 넣지 않는다', async () => {
    const seen: string[] = []
    const off = onLocalWrite((store) => seen.push(store))
    for (let i = 0; i < 5; i++) {
      await writeLocal([doc()], [word()], [], [], [], noOptions)
      await Promise.resolve()
    }
    off()

    expect(seen).toEqual([])
  })

  it('동기화 중 다시 계산한 문서의 등장 기록은 건드리지 않는다', async () => {
    await idbPut(STORES.wordOccurrences, occurrence())

    // The sync plan holds the old rows, but an empty occurrence set replaces nothing
    const result = await writeLocal([], [], [occurrence({ sentence: '옛 문장' })], [], [], noOptions)

    const stored = await idbGet<{ sentence: string }>(STORES.wordOccurrences, ['doc-1', 'run'])
    expect(stored?.sentence).toBe('새 문장')
    expect(result.occurrences).toBe(0)
  })
})

/**
 * The newest write wins.
 *
 * A sync plans its merge from a read taken before the write transaction. A user
 * write that lands in between must not be rolled back to the stale plan — the
 * stored row is merged with the incoming one again inside the transaction.
 */
describe('newest-write guard', () => {
  const T1 = '2026-01-01T00:00:00.000Z'
  const T2 = '2026-01-02T00:00:00.000Z'

  const options = (over: Partial<{ occurrenceDocumentIds: ReadonlySet<string>; expectedRevision: number }> = {}) => ({
    occurrenceDocumentIds: new Set<string>(),
    ...over,
  })

  const doc = (over: Partial<Document> = {}): Document => ({
    id: 'doc-1',
    title: 'Untitled',
    languageCode: 'en',
    rawText: 'I run daily.',
    createdAt: T1,
    updatedAt: T2,
    ...over,
  })

  const word = (over: Record<string, unknown> = {}) => ({
    languageCode: 'en',
    lemma: 'run',
    seenCount: 2,
    firstSeenAt: T1,
    lastSeenAt: T2,
    status: 'known' as const,
    favorite: false,
    favoriteUpdatedAt: T1,
    starAngle: 0,
    starColor: '#eab308',
    knownPresses: 0,
    unsurePresses: 0,
    unknownPresses: 0,
    ...over,
  })

  const folder = (over: Partial<Folder> & { id: string }): Folder => ({
    name: over.id,
    parentId: null,
    createdAt: T1,
    updatedAt: T1,
    ...over,
  })

  const occurrence = (over: Partial<WordOccurrence> = {}): WordOccurrence => ({
    documentId: 'doc-1',
    languageCode: 'en',
    lemma: 'run',
    surfaces: ['run'],
    count: 1,
    recordedAt: 1,
    charStart: 0,
    charEnd: 3,
    sentence: 'local newer',
    documentTitle: 'Untitled',
    ...over,
  })

  beforeEach(async () => {
    await idbPut(STORES.documents, doc())
    await idbPut(STORES.wordStates, word())
  })

  it('does not overwrite a newer local document with a stale sync row', async () => {
    await idbPut(STORES.documents, { ...doc(), title: 'local newer', updatedAt: T2 })

    const result = await writeLocal(
      [{ ...doc(), title: 'stale', updatedAt: T1 }],
      [],
      [],
      [],
      [],
      options(),
    )

    expect((await idbGet<Document>(STORES.documents, 'doc-1'))?.title).toBe('local newer')
    expect(result.documents).toBe(0)
  })

  it('keeps a newer local word state and folder', async () => {
    await idbPut(STORES.wordStates, {
      ...word(),
      lastSeenAt: T2,
      status: 'known',
      favorite: true,
      favoriteUpdatedAt: T2,
      note: 'local note',
      noteUpdatedAt: T2,
    })
    await idbPut(STORES.folders, folder({ id: 'folder-1', name: 'Local', updatedAt: T2 }))

    const result = await writeLocal(
      [],
      [
        word({
          lastSeenAt: T1,
          status: 'unsure',
          favorite: false,
          favoriteUpdatedAt: T1,
          note: 'stale note',
          noteUpdatedAt: T1,
        }),
      ],
      [],
      [folder({ id: 'folder-1', name: 'Stale', updatedAt: T1 })],
      [],
      options(),
    )

    const storedWord = await idbGet<Record<string, unknown>>(STORES.wordStates, ['en', 'run'])
    expect(storedWord?.status).toBe('known')
    expect(storedWord?.favorite).toBe(true)
    expect(storedWord?.note).toBe('local note')
    expect((await idbGet<Folder>(STORES.folders, 'folder-1'))?.name).toBe('Local')
    expect(result.wordStates).toBe(0)
    expect(result.folders).toBe(0)
  })

  it('does not overwrite an earlier local tombstone with a later incoming one', async () => {
    await idbPut(STORES.documentTombstones, { documentId: 'doc-purged', purgedAt: T1 })

    const result = await writeLocal(
      [],
      [],
      [],
      [],
      [{ documentId: 'doc-purged', purgedAt: T2 }],
      options(),
    )

    expect(
      (await idbGet<{ purgedAt: string }>(STORES.documentTombstones, 'doc-purged'))?.purgedAt,
    ).toBe(T1)
    expect(result.tombstones).toBe(0)
  })

  it('removes the cached document body when a remote tombstone arrives', async () => {
    await putDocumentContent('doc-purged', {
      rawText: 'A body the user deleted.',
      contentUpdatedAt: T1,
      occurrencesUpdatedAt: T1,
    })

    await writeLocal(
      [],
      [],
      [],
      [],
      [{ documentId: 'doc-purged', purgedAt: T2 }],
      options(),
    )

    expect(await readDocumentContent('doc-purged')).toBeUndefined()
  })

  it('writes a genuinely newer incoming row', async () => {
    await idbPut(STORES.documents, { ...doc(), title: 'stored', updatedAt: T1 })
    await idbPut(STORES.wordStates, word({ lastSeenAt: T1, status: 'known' }))
    await idbPut(STORES.folders, folder({ id: 'folder-1', name: 'Old', updatedAt: T1 }))

    const result = await writeLocal(
      [{ ...doc(), title: 'incoming newer', updatedAt: T2 }],
      [word({ lastSeenAt: T2, status: 'unsure' })],
      [],
      [folder({ id: 'folder-1', name: 'New', updatedAt: T2 })],
      [{ documentId: 'doc-purged-new', purgedAt: T2 }],
      options(),
    )

    expect((await idbGet<Document>(STORES.documents, 'doc-1'))?.title).toBe('incoming newer')
    expect((await idbGet<{ status: string }>(STORES.wordStates, ['en', 'run']))?.status).toBe(
      'unsure',
    )
    expect((await idbGet<Folder>(STORES.folders, 'folder-1'))?.name).toBe('New')
    expect(
      (await idbGet<{ purgedAt: string }>(STORES.documentTombstones, 'doc-purged-new'))?.purgedAt,
    ).toBe(T2)
    expect(result.documents).toBe(1)
    expect(result.wordStates).toBe(1)
    expect(result.folders).toBe(1)
    expect(result.tombstones).toBe(1)
  })

  it('does not write when merged values equal stored values', async () => {
    await idbPut(STORES.folders, folder({ id: 'folder-1', name: 'Same', updatedAt: T2 }))

    const writes: string[] = []
    const off = onLocalWrite((store) => writes.push(store))
    const result = await writeLocal(
      [doc()],
      [word()],
      [],
      [folder({ id: 'folder-1', name: 'Same', updatedAt: T2 })],
      [],
      options(),
    )
    await Promise.resolve()
    off()

    expect(writes).toEqual([])
    expect(result.documents).toBe(0)
    expect(result.wordStates).toBe(0)
    expect(result.folders).toBe(0)
    expect(result.tombstones).toBe(0)
    expect(result.occurrences).toBe(0)
  })

  it('skips all occurrence replacement when expectedRevision changed', async () => {
    await idbPut(STORES.wordOccurrences, occurrence({ sentence: 'local newer' }))
    // Seed the meta after every user write — the occurrence put bumps the revision
    await idbPut(STORES.documentMeta, {
      documentId: SYNC_META_KEY,
      epoch: 'test-epoch',
      revision: 5,
      pendingByStore: {},
      dirty: {},
    })

    const result = await writeLocal(
      [],
      [],
      [occurrence({ sentence: 'stale' })],
      [],
      [],
      options({ occurrenceDocumentIds: new Set(['doc-1']), expectedRevision: 4 }),
    )

    const stored = await idbGet<{ sentence: string }>(STORES.wordOccurrences, ['doc-1', 'run'])
    expect(stored?.sentence).toBe('local newer')
    expect(result.occurrences).toBe(0)
  })

  it('replaces occurrences when expectedRevision still matches', async () => {
    await idbPut(STORES.wordOccurrences, occurrence({ sentence: 'old' }))
    // Seed the meta after every user write — the occurrence put bumps the revision
    await idbPut(STORES.documentMeta, {
      documentId: SYNC_META_KEY,
      epoch: 'test-epoch',
      revision: 5,
      pendingByStore: {},
      dirty: {},
    })

    const result = await writeLocal(
      [],
      [],
      [occurrence({ sentence: 'new' })],
      [],
      [],
      options({ occurrenceDocumentIds: new Set(['doc-1']), expectedRevision: 5 }),
    )

    const stored = await idbGet<{ sentence: string }>(STORES.wordOccurrences, ['doc-1', 'run'])
    expect(stored?.sentence).toBe('new')
    expect(result.occurrences).toBe(1)
  })
})

/**
 * 실제로 저장이 안 늘었는지 — 신호 대신 저장소 자체를 본다.
 */
describe('되돌려 쓴 뒤에도 저장소가 그대로다', () => {
  const noOptions = { occurrenceDocumentIds: new Set<string>() }

  it('문서 개수가 늘지 않는다', async () => {
    const before = await idbGetAll<Document>(STORES.documents)
    await writeLocal(
      [
        {
          id: 'doc-1',
          title: 'Untitled',
          languageCode: 'en',
          rawText: 'I run daily.',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      [],
      [],
      [],
      [],
      noOptions,
    )
    const after = await idbGetAll<Document>(STORES.documents)
    expect(after).toHaveLength(before.length)
  })
})
