import { describe, expect, it } from 'vitest'

import type { Document } from '../../types'
import {
  DEFAULT_DOCUMENT_SORT,
  documentLength,
  documentSortOrDefault,
  isDocumentSort,
  sortDocuments,
  type DocumentSort,
} from './documentSort'

function doc(id: string, over: Partial<Document> = {}): Document {
  return {
    id,
    title: id,
    languageCode: 'en',
    rawText: 'x',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

const ids = (docs: Document[]) => docs.map((d) => d.id)

const same = {
  a: doc('a'),
  b: doc('b'),
}

describe('문서 정렬', () => {
  it('최근 본 시각 순 — 최신이 먼저', () => {
    const list = sortDocuments(
      [doc('old', { updatedAt: '2026-01-01T00:00:00.000Z' }), doc('new', { updatedAt: '2026-02-01T00:00:00.000Z' })],
      'recent',
    )
    expect(ids(list)).toEqual(['new', 'old'])
  })

  it('만든 날 순 — 늦게 만든 것이 먼저', () => {
    const list = sortDocuments(
      [doc('early', { createdAt: '2026-01-01T00:00:00.000Z' }), doc('late', { createdAt: '2026-03-01T00:00:00.000Z' })],
      'created',
    )
    expect(ids(list)).toEqual(['late', 'early'])
  })

  it('글자 많은 순 — 긴 것이 먼저', () => {
    const list = sortDocuments([doc('short', { rawText: 'ab' }), doc('long', { rawText: 'x'.repeat(500) })], 'longest')
    expect(ids(list)).toEqual(['long', 'short'])
  })

  it('글자 수를 셀 때 앞뒤 공백을 제외한다', () => {
    expect(documentLength(doc('a', { rawText: '  hello  ' }))).toBe(5)
    expect(documentLength(doc('a', { rawText: '   ' }))).toBe(0)
  })

  it('알파벳 순', () => {
    const list = sortDocuments([doc('c', { title: 'Cat' }), doc('a', { title: 'apple' }), doc('b', { title: 'Bird' })], 'alpha')
    expect(ids(list)).toEqual(['a', 'b', 'c'])
  })

  it('알파벳은 대소문자를 가리지 않는다 — 같은 알파벳이 붙으면 순서가 달라져 보기에 답답하다', () => {
    const list = sortDocuments([doc('x', { title: 'zebra' }), doc('y', { title: 'Apple' })], 'alpha')
    expect(ids(list)).toEqual(['y', 'x'])
  })

  /**
   * 회귀: '최근 본 시각' 이 전부 같은 값일 때 순서가 매번 달라져 화면이 출렁인다.
   * 시각으로 갈릴 수 없으면 제목으로 갈린다.
   */
  it('시각이 같으면 제목으로 갈린다 — 화면이 출렁이지 않는다', () => {
    const sameTime = [doc('b', { title: 'Beta' }), doc('a', { title: 'Alpha' })]
    expect(ids(sortDocuments(sameTime, 'recent'))).toEqual(['a', 'b'])
    expect(ids(sortDocuments([...sameTime].reverse(), 'recent'))).toEqual(['a', 'b'])
  })

  it('원본 배열을 건드리지 않는다', () => {
    const original = [doc('b'), doc('a')]
    const copy = [...original]
    sortDocuments(original, 'alpha')
    expect(original).toEqual(copy)
  })

  it('빈 목록·문서 하나여도 죽지 않는다', () => {
    expect(sortDocuments([], 'recent')).toEqual([])
    expect(sortDocuments([same.a], 'longest')).toEqual([same.a])
  })

  it('모르는 기준은 기본값으로 되돌린다 — 깨진 저장을 스스로 고쳐야 한다', () => {
    expect(documentSortOrDefault('nope')).toBe(DEFAULT_DOCUMENT_SORT)
    expect(documentSortOrDefault(undefined)).toBe(DEFAULT_DOCUMENT_SORT)
    expect(ids(sortDocuments([doc('b'), doc('a')], 'nope' as DocumentSort))).toEqual(
      ids(sortDocuments([doc('b'), doc('a')], DEFAULT_DOCUMENT_SORT)),
    )
  })

  it('기준 이름을 아는지 확인한다', () => {
    expect(isDocumentSort('recent')).toBe(true)
    expect(isDocumentSort('alpha')).toBe(true)
    expect(isDocumentSort('oldest')).toBe(false)
  })
})