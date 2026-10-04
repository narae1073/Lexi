import { describe, expect, it } from 'vitest'

import type { WordOccurrence } from '../../app/stores/occurrences'
import type { WordStatus } from '../../types'
import { documentProgress, groupByDocument } from './documentProgress'

function occ(over: Partial<WordOccurrence> & { lemma: string }): WordOccurrence {
  return {
    documentId: 'doc-1',
    languageCode: 'en',
    surfaces: [over.lemma],
    count: 1,
    recordedAt: 0,
    charStart: 0,
    charEnd: 1,
    sentence: 'x',
    documentTitle: 't',
    ...over,
  }
}

/** 표시된 lemma 집합을 만들어 조회 함수를 만든다 */
const markedIn = (marked: Record<string, WordStatus>) => (lemma: string) =>
  marked[lemma] ? ({ status: marked[lemma] } as never) : undefined

describe('documentProgress', () => {
  it('중복을 뺀 서로 다른 단어 수를 센다', () => {
    // the 가 5번 나와도 배워야 할 단어는 하나다
    const progress = documentProgress(
      [occ({ lemma: 'the' }), occ({ lemma: 'the' }), occ({ lemma: 'the' }), occ({ lemma: 'cat' })],
      markedIn({}),
    )
    expect(progress.total).toBe(2)
  })

  it('세 가지 상태를 모두 표시한 것으로 센다', () => {
    const progress = documentProgress(
      [occ({ lemma: 'a' }), occ({ lemma: 'b' }), occ({ lemma: 'c' })],
      markedIn({ a: 'known', b: 'unsure', c: 'unknown' }),
    )
    expect(progress).toMatchObject({ total: 3, marked: 3, percent: 100 })
  })

  it('비율을 백분율로 낸다', () => {
    const progress = documentProgress(
      [occ({ lemma: 'a' }), occ({ lemma: 'b' }), occ({ lemma: 'c' }), occ({ lemma: 'd' })],
      markedIn({ a: 'known' }),
    )
    expect(progress).toMatchObject({ total: 4, marked: 1, percent: 25 })
  })

  it('반올림한다', () => {
    const rows = Array.from({ length: 3 }, (_, i) => occ({ lemma: `w${i}` }))
    const progress = documentProgress(rows, markedIn({ w0: 'known' }))
    expect(progress.percent).toBe(33)
  })

  it('표시한 것이 없으면 0% 다', () => {
    const progress = documentProgress([occ({ lemma: 'a' })], markedIn({}))
    expect(progress).toMatchObject({ total: 1, marked: 0, percent: 0 })
  })

  it('기록이 없는 문장은 total 0 — 모르는 것이지 0% 가 아니다', () => {
    const progress = documentProgress([], markedIn({}))
    expect(progress).toMatchObject({ total: 0, marked: 0, percent: 0 })
  })

  it('같은 단어가 여러 문서에 있으면 문서마다 따로 센다', () => {
    const a = documentProgress([occ({ lemma: 'x', documentId: 'a' })], markedIn({ x: 'known' }))
    const b = documentProgress([occ({ lemma: 'x', documentId: 'b' })], markedIn({}))
    expect(a.percent).toBe(100)
    expect(b.percent).toBe(0)
  })
})

describe('groupByDocument', () => {
  it('문서별로 모은다', () => {
    const grouped = groupByDocument([
      occ({ lemma: 'a', documentId: 'd1' }),
      occ({ lemma: 'b', documentId: 'd2' }),
      occ({ lemma: 'c', documentId: 'd1' }),
    ])
    expect(grouped.get('d1')).toHaveLength(2)
    expect(grouped.get('d2')).toHaveLength(1)
  })

  it('빈 목록이면 빈 맵', () => {
    expect(groupByDocument([]).size).toBe(0)
  })
})
