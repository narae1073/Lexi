import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbGet, idbGetAll, idbPut } from '../../lib/storage/localDb'
import type { Document } from '../../types'
import { onLocalWrite } from '../../lib/storage/localDb'
import { writeLocal } from './sync'

/**
 * 같은 것을 다시 쓰지 않는다.
 *
 * 회귀: 동기화는 병합 결과를 통째로 되돌려 썼다. 그대로면 매번 모든 문서와 단어 상태를
 * 다시 저장하고, 저장이 곧 '아직 서버에 못 갔다' 는 신호가 되어 동기화가 영영
 * '밀렸다' 고 알렸다 — 실제로는 다 올라간 뒤에도 'Not synced yet' 이 사라지지 않았다.
 */
describe('병합 결과를 되돌려 쓸 때', () => {
  const word = (over: Record<string, unknown> = {}) => ({
    languageCode: 'en',
    lemma: 'run',
    seenCount: 2,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-02T00:00:00.000Z',
    status: 'known' as const,
    ...over,
  })

  const doc = (over: Partial<Document> = {}): Document => ({
    id: 'doc-1',
    title: 'Untitled',
    languageCode: 'en',
    rawText: 'I run daily.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  })

  beforeEach(async () => {
    await idbPut(STORES.documents, doc())
    await idbPut(STORES.wordStates, word())
  })

  it('같은 것을 다시 쓰지 않는다 — 조용해야 할 곳에 시끄러움을 두지 않는다', async () => {
    const writes: string[] = []
    const off = onLocalWrite((store) => writes.push(store))
    await writeLocal([doc()], [word()], [])
    await Promise.resolve()
    off()

    expect(writes).toEqual([])
  })

  it('제목이 바뀌었으면 문서는 쓴다', async () => {
    const writes: string[] = []
    const off = onLocalWrite((store) => writes.push(store))
    await writeLocal([doc({ title: '새 제목' })], [word()], [])
    await Promise.resolve()
    off()

    expect(writes).toContain(STORES.documents)
  })

  it('단어 상태가 바뀌었으면 단어 상태를 쓴다', async () => {
    const writes: string[] = []
    const off = onLocalWrite((store) => writes.push(store))
    await writeLocal([doc()], [word({ status: 'unsure' })], [])
    await Promise.resolve()
    off()

    expect(writes).toContain(STORES.wordStates)
  })

  it('다른 기기에서 받은 상태도 비교해 쓸지 정한다 — 같으면 쓰지 않는다', async () => {
    const stored = await idbGet<Record<string, unknown>>(STORES.wordStates, ['en', 'run'])
    expect(stored?.status).toBe('known')

    // 서버에서 같은 값이 돌아왔다
    await writeLocal([doc()], [word()], [])
    const after = await idbGet<Record<string, unknown>>(STORES.wordStates, ['en', 'run'])
    expect(after).toEqual(stored)
  })

  it('여러 번 동기화해도 저장은 늘지 않는다 — 같은 내용을 반복해서 밀어 넣지 않는다', async () => {
    const seen: string[] = []
    const off = onLocalWrite((store) => seen.push(store))
    for (let i = 0; i < 5; i++) {
      await writeLocal([doc()], [word()], [])
      await Promise.resolve()
    }
    off()

    expect(seen).toEqual([])
  })
})

/**
 * 실제로 저장이 안 늘었는지 — 신호 대신 저장소 자체를 본다.
 */
describe('되돌려 쓴 뒤에도 저장소가 그대로다', () => {
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
    )
    const after = await idbGetAll<Document>(STORES.documents)
    expect(after).toHaveLength(before.length)
  })
})
