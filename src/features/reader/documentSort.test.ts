import { describe, expect, it } from 'vitest'

import type { Document } from '../../types'
import {
  DEFAULT_DOCUMENT_SORT,
  DEFAULT_SORT_DIRECTION,
  directionOrDefault,
  documentLength,
  documentSortOrDefault,
  flipDirection,
  isDocumentSort,
  isSortDirection,
  sortDocuments,
  type DocumentSort,
  type SortDirection,
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

  /**
   * 회귀: 기본 방향이 전부 같다면 알파벳 순이 Z→A 로 시작한다.
   * '그대로' 의 뜻이 기준마다 다르다 — 최신이 먼저 vs A 가 먼저.
   */
  it('기준마다 자연스러운 기본 방향이 다르다', () => {
    expect(DEFAULT_SORT_DIRECTION).toEqual({
      recent: 'desc',
      longest: 'desc',
      created: 'desc',
      alpha: 'asc',
    })
  })

  it('방향을 뒤집으면 순서가 정확히 반대가 된다', () => {
    // 주 키가 모두 달라야 뒤집기가 정확히 반대가 된다 — 동률은 별도 검��로 맡긴다
    const list = [
      doc('a', {
        title: 'Apple',
        updatedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        rawText: 'xxxxx',
      }),
      doc('b', {
        title: 'Zebra',
        updatedAt: '2026-02-01T00:00:00.000Z',
        createdAt: '2026-03-01T00:00:00.000Z',
        rawText: 'x',
      }),
      doc('c', {
        title: 'Mango',
        updatedAt: '2026-03-01T00:00:00.000Z',
        createdAt: '2026-02-01T00:00:00.000Z',
        rawText: 'xxxxxxx',
      }),
    ]

    for (const criterion of ['recent', 'longest', 'created', 'alpha'] as const) {
      const natural = ids(sortDocuments(list, criterion))
      const flipped = ids(sortDocuments(list, criterion, flipDirection(DEFAULT_SORT_DIRECTION[criterion])))
      expect(flipped).toEqual([...natural].reverse())
    }
  })

  it('이름 순을 뒤집으면 Z→A 가 된다', () => {
    const list = [doc('a', { title: 'Apple' }), doc('b', { title: 'Mango' }), doc('c', { title: 'Zebra' })]
    expect(ids(sortDocuments(list, 'alpha'))).toEqual(['a', 'b', 'c'])
    expect(ids(sortDocuments(list, 'alpha', 'desc'))).toEqual(['c', 'b', 'a'])
  })

  it('최근 본 순을 뒤집으면 오래 본 것이 먼저 온다', () => {
    const list = [
      doc('old', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      doc('new', { updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(ids(sortDocuments(list, 'recent'))).toEqual(['new', 'old'])
    expect(ids(sortDocuments(list, 'recent', 'asc'))).toEqual(['old', 'new'])
  })

  /**
   * 동률은 방향을 뒤집어도 같다.
   *
   * 뒤집어서 함께 뒤집으면 같은 값끼리의 순서가 입력에 따라 달라져 화면이 출렁이고,
   * '정렬했는데 왜 순서가 바뀌지' 하는 이유가 된다.
   */
  it('동률인 항목은 방향을 뒤집어도 같은 순서다', () => {
    const list = [doc('a', { title: 'Apple' }), doc('b', { title: 'Zebra' }), doc('c', { title: 'Mango' })]
    const asc = ids(sortDocuments(list, 'recent', 'asc'))
    const desc = ids(sortDocuments(list, 'recent', 'desc'))
    expect(asc).toEqual(['a', 'c', 'b'])
    expect(desc).toEqual(['a', 'c', 'b'])

    // 입력 순서가 달라도 결과는 같다
    expect(ids(sortDocuments([...list].reverse(), 'recent', 'desc'))).toEqual(desc)
  })

  it('방향을 주지 않으면 그 기준의 기본 방향을 쓴다', () => {
    const list = [doc('a', { title: 'Apple' }), doc('b', { title: 'Zebra' })]
    expect(ids(sortDocuments(list, 'alpha'))).toEqual(ids(sortDocuments(list, 'alpha', 'asc')))
    expect(ids(sortDocuments(list, 'recent'))).toEqual(ids(sortDocuments(list, 'recent', 'desc')))
  })

  it('모르는 방향은 기본값으로 되돌린다 — 깨진 저장을 스스로 고쳐야 한다', () => {
    expect(directionOrDefault('recent', 'sideways')).toBe('desc')
    expect(directionOrDefault('alpha', undefined)).toBe('asc')
    expect(isSortDirection('asc')).toBe(true)
    expect(isSortDirection('up')).toBe(false)
    expect(flipDirection('asc')).toBe('desc')
    expect(flipDirection('desc')).toBe('asc')
  })

  it('뒤집기를 두 번 하면 원래로 돌아온다', () => {
    for (const d of ['asc', 'desc'] as SortDirection[]) {
      expect(flipDirection(flipDirection(d))).toBe(d)
    }
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