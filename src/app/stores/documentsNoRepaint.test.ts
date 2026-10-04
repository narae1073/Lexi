import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbPut } from '../../lib/storage/localDb'
import type { Document } from '../../types'
import type { WordOccurrence } from './occurrences'
import { sameDocuments, useDocumentsStore } from './documents'
import { sameOccurrences } from './occurrences'

const doc = (id: string, extra: Partial<Document> = {}): Document => ({
  id,
  title: id,
  languageCode: 'en',
  rawText: 'Hello world',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...extra,
})

/**
 * 목록이 다시 그려지지 않는지.
 *
 * 동기화가 자주 돌면 적재가 자주 일어난다. 그때마다 '불러오는 중' 으로 비웠다면
 * 화면이 계속 깜빡인다 — 데이터를 이미 갖고 있으면서 없는 것처럼 보이는 셈이다.
 */
describe('문서 목록 다시 그리지 않기', () => {
  it("첫 적재에서만 '불러오는 중' 을 보인다", async () => {
    useDocumentsStore.setState({ documents: [], ready: false, loading: false })
    const seen: boolean[] = []
    const stop = useDocumentsStore.subscribe((s) => seen.push(s.loading))

    await useDocumentsStore.getState().load()
    stop()

    expect(seen).toContain(true)
    expect(useDocumentsStore.getState().ready).toBe(true)
  })

  it("이미 문서를 보여 주고 있으면 '불러오는 중' 으로 비우지 않는다", async () => {
    const docs = [doc('a')]
    await idbPut(STORES.documents, docs[0])
    useDocumentsStore.setState({ documents: docs, ready: true, loading: false })

    const seen: boolean[] = []
    const stop = useDocumentsStore.subscribe((s) => seen.push(s.loading))

    await useDocumentsStore.getState().load()
    stop()

    // 중간에 한 번이라도 true 가 되면 화면이 깜빡인다
    expect(seen).not.toContain(true)
    expect(useDocumentsStore.getState().documents).toHaveLength(1)
  })

  it('내용이 같으면 같은 배열을 둔다 — 새로 그려도 보일 변화가 없다', async () => {
    const docs = [doc('a'), doc('b')]
    for (const d of docs) await idbPut(STORES.documents, d)
    useDocumentsStore.setState({ documents: docs, ready: true })

    const before = useDocumentsStore.getState().documents
    await useDocumentsStore.getState().load()
    expect(useDocumentsStore.getState().documents).toBe(before)
  })

  it('내용이 바뀌었으면 새 배열을 넣는다', async () => {
    await idbPut(STORES.documents, doc('a', { title: '새 제목' }))
    useDocumentsStore.setState({ documents: [doc('a', { title: '옛 제목' })], ready: true })

    await useDocumentsStore.getState().load()
    expect(useDocumentsStore.getState().documents[0].title).toBe('새 제목')
  })
})

describe('등장 기록 같은지 비교', () => {
  const occurrence = (over: Partial<WordOccurrence> = {}): WordOccurrence => ({
    documentId: 'a',
    languageCode: 'en',
    lemma: 'run',
    surfaces: ['run'],
    count: 1,
    charStart: 0,
    charEnd: 3,
    sentence: 'I run daily.',
    documentTitle: 'Untitled',
    recordedAt: 1,
    ...over,
  })

  it('내용이 같으면 같다', () => {
    expect(sameOccurrences([occurrence()], [occurrence()])).toBe(true)
  })

  it('아직 읽지 않았고 비어 있으면 같다', () => {
    expect(sameOccurrences(undefined, [])).toBe(true)
  })

  it('개수가 다르면 다르다 — 게이지 길이가 바뀐다', () => {
    expect(sameOccurrences([occurrence()], [occurrence(), occurrence({ lemma: 'walk' })])).toBe(false)
  })

  it('같은 lemma 여도 문서가 다르면 다르다', () => {
    expect(sameOccurrences([occurrence()], [occurrence({ documentId: 'b' })])).toBe(false)
  })

  it('등장 횟수가 다르면 다르다', () => {
    expect(sameOccurrences([occurrence()], [occurrence({ count: 2 })])).toBe(false)
  })

  it('기록 시각이 다르면 다르다 — 예문이 바뀔 수 있다', () => {
    expect(sameOccurrences([occurrence()], [occurrence({ recordedAt: 2 })])).toBe(false)
  })

  it('제목이 다르면 다르다 — 목록과 단어장에 함께 보인다', () => {
    expect(sameOccurrences([occurrence()], [occurrence({ documentTitle: '새 제목' })])).toBe(false)
  })

  it('순서가 다르면 다르다 — 본문 순서로 보인다', () => {
    expect(
      sameOccurrences([occurrence({ lemma: 'a' }), occurrence({ lemma: 'b' })], [
        occurrence({ lemma: 'b' }),
        occurrence({ lemma: 'a' }),
      ]),
    ).toBe(false)
  })
})

describe('문서 목록 같은지 비교', () => {
  it('같은 배열은 같다', () => {
    const docs = [doc('a')]
    expect(sameDocuments(docs, docs)).toBe(true)
  })

  it('내용이 같으면 새 배열이라도 같다', () => {
    expect(sameDocuments([doc('a')], [doc('a')])).toBe(true)
  })

  it('순서가 다르면 다르다 — 정렬이 바뀌면 그려야 한다', () => {
    expect(sameDocuments([doc('a'), doc('b')], [doc('b'), doc('a')])).toBe(false)
  })

  it('개수가 다르면 다르다', () => {
    expect(sameDocuments([doc('a')], [doc('a'), doc('b')])).toBe(false)
  })

  it('제목이 다르면 다르다', () => {
    expect(sameDocuments([doc('a', { title: '하나' })], [doc('a', { title: '둘' })])).toBe(false)
  })

  it('본문이 다르면 다르다', () => {
    expect(sameDocuments([doc('a', { rawText: '짧게' })], [doc('a', { rawText: '길게' })])).toBe(false)
  })

  it('최근 본 시각이 다르면 다르다 — 목록 순서가 바뀐다', () => {
    expect(
      sameDocuments(
        [doc('a', { updatedAt: '2026-01-01T00:00:00.000Z' })],
        [doc('a', { updatedAt: '2026-02-01T00:00:00.000Z' })],
      ),
    ).toBe(false)
  })

  it('휴지통 상태가 다르면 다르다 — 목록에서 사라져야 한다', () => {
    expect(
      sameDocuments(
        [doc('a', { deletedAt: null })],
        [doc('a', { deletedAt: '2026-02-01T00:00:00.000Z' })],
      ),
    ).toBe(false)
  })

  it('deletedAt 이 없는 것과 null 은 같은 것으로 본다 — 둘 다 살아 있는 문서다', () => {
    const withoutKey = doc('a')
    const withNull = { ...doc('a'), deletedAt: null }
    expect(sameDocuments([withoutKey], [withNull])).toBe(true)
  })

  it('빈 목록끼리는 같다', () => {
    expect(sameDocuments([], [])).toBe(true)
  })
})

beforeEach(async () => {
  const { idbDelete } = await import('../../lib/storage/localDb')
  for (const id of ['a', 'b', 'c']) {
    await idbDelete(STORES.documents, id).catch(() => {})
  }
})