import { describe, expect, it } from 'vitest'

import type { WordOccurrence } from '../../app/stores/occurrences'
import type { WordState, WordStatus } from '../../types'
import { buildWordbook, filterByStarColors, groupByStatus, wordbookGroupOrDefault } from './buildWordbook'
import type { WordbookEntry } from './buildWordbook'

const occurrence = (over: Partial<WordOccurrence> & { lemma: string }): WordOccurrence => ({
  documentId: 'doc-1',
  languageCode: 'en',
  surfaces: [over.lemma],
  count: 1,
  recordedAt: 1000,
  charStart: 0,
  charEnd: over.lemma.length,
  sentence: 'A sentence.',
  documentTitle: 'Doc 1',
  ...over,
})

const state = (lemma: string, status: WordStatus): WordState => ({
  lemma,
  languageCode: 'en',
  status,
  seenCount: 1,
  firstSeenAt: '2026-01-01',
  lastSeenAt: '2026-01-01',
  favorite: false,
  starAngle: 0,
  starColor: '#eab308',
})

describe('buildWordbook', () => {
  it('등장 기록이 없으면 빈 목록', () => {
    expect(buildWordbook({ languageCode: 'en', occurrences: [] })).toEqual([])
  })

  it('상태가 없는 단어는 미표시 그룹이다', () => {
    const entries = buildWordbook({
      languageCode: 'en',
      occurrences: [occurrence({ lemma: 'cat' })],
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('unmarked')
  })

  it('상태를 붙여 그룹을 나눈다', () => {
    const byKey = {
      'en::cat': state('cat', 'known'),
      'en::dog': state('dog', 'unsure'),
      'en::fox': state('fox', 'unknown'),
    }
    const entries = buildWordbook({
      languageCode: 'en',
      occurrences: [
        occurrence({ lemma: 'cat' }),
        occurrence({ lemma: 'dog' }),
        occurrence({ lemma: 'fox' }),
      ],
      byKey,
    })
    const grouped = groupByStatus(entries)
    expect(grouped.known.map((e) => e.lemma)).toEqual(['cat'])
    expect(grouped.unsure.map((e) => e.lemma)).toEqual(['dog'])
    expect(grouped.unknown.map((e) => e.lemma)).toEqual(['fox'])
    expect(grouped.unmarked).toHaveLength(0)
  })

  /**
   * ★ 탭 — 상태와 독립이라 상태 탭에 있으면서 ★ 탭에도 있다.
   *
   * 별을 뗀 단어는 ★ 탭에서 빠져야 하고, 상태를 바꾸지 않아도 ★ 탭에 들어간다.
   */
  it('별표한 단어는 상태 탭과 ★ 탭에 함께 있다', () => {
    const byKey = {
      'en::cat': { ...state('cat', 'known'), favorite: true },
      'en::dog': state('dog', 'unsure'),
    }
    const entries = buildWordbook({
      languageCode: 'en',
      occurrences: [occurrence({ lemma: 'cat' }), occurrence({ lemma: 'dog' })],
      byKey,
    })
    const grouped = groupByStatus(entries)
    expect(grouped.known.map((e) => e.lemma)).toEqual(['cat'])
    expect(grouped.favorite.map((e) => e.lemma)).toEqual(['cat'])
    expect(grouped.unsure.map((e) => e.lemma)).toEqual(['dog'])
  })

  /** 별 색은 상태 행에서 온다 — ★ 탭의 색 필터가 쓰는 근거 */
  it('별 색을 항목에 실어 보낸다', () => {
    const byKey = {
      'en::cat': { ...state('cat', 'known'), favorite: true, starColor: '#ef4444' },
      'en::dog': { ...state('dog', 'unsure'), favorite: true, starColor: '#3b82f6' },
    }
    const entries = buildWordbook({
      languageCode: 'en',
      occurrences: [occurrence({ lemma: 'cat' }), occurrence({ lemma: 'dog' })],
      byKey,
    })
    const colors = new Map(entries.map((e) => [e.lemma, e.starColor]))
    expect(colors.get('cat')).toBe('#ef4444')
    expect(colors.get('dog')).toBe('#3b82f6')
  })

  describe('filterByStarColors', () => {
    /** 별 기능 이전의 기록 — 색이 없다 */
    const entry = (lemma: string, starColor?: string): WordbookEntry => {
      const byKey: Record<string, WordState> = starColor
        ? { [`en::${lemma}`]: { ...state(lemma, 'known'), favorite: true, starColor } }
        : {}
      return buildWordbook({
        languageCode: 'en',
        occurrences: [occurrence({ lemma })],
        byKey,
      })[0]
    }
    const cat = entry('cat', '#ef4444')
    const dog = entry('dog', '#3b82F6')
    const bare = entry('bird')

    it('켠 색이 없으면 걸러지지 않는다', () => {
      expect(filterByStarColors([cat, dog], [])).toEqual([cat, dog])
    })

    it('켠 색 하나로 좁힌다 — 대소문자는 같은 색이다', () => {
      expect(filterByStarColors([cat, dog], ['#EF4444']).map((e) => e.lemma)).toEqual(['cat'])
    })

    it('여러 색을 겹쳐 켠다', () => {
      expect(
        filterByStarColors([cat, dog], ['#ef4444', '#3b82f6']).map((e) => e.lemma),
      ).toEqual(['cat', 'dog'])
    })

    it('색 없는 행은 켠 색이 있으면 빠진다', () => {
      expect(filterByStarColors([cat, bare], ['#ef4444']).map((e) => e.lemma)).toEqual(['cat'])
    })
  })

  it('같은 lemma 의 여러 문서 기록을 하나로 합친다', () => {
    const entries = buildWordbook({
      languageCode: 'en',
      occurrences: [
        occurrence({ lemma: 'cat', documentId: 'd1', count: 3, recordedAt: 1000 }),
        occurrence({ lemma: 'cat', documentId: 'd2', count: 2, recordedAt: 2000, documentTitle: 'Doc 2' }),
      ],
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].count).toBe(5)
    expect(entries[0].documentCount).toBe(2)
  })

  it('예문은 가장 최근 기록의 것을 쓴다', () => {
    const entries = buildWordbook({
      languageCode: 'en',
      occurrences: [
        occurrence({ lemma: 'cat', documentId: 'old', sentence: 'Old sentence.', recordedAt: 1000 }),
        occurrence({ lemma: 'cat', documentId: 'new', sentence: 'New sentence.', recordedAt: 5000 }),
      ],
    })
    expect(entries[0].sentence).toBe('New sentence.')
    expect(entries[0].documentId).toBe('new')
  })

  it('표기를 여러 개 합쳐 담는다', () => {
    const entries = buildWordbook({
      languageCode: 'en',
      occurrences: [
        occurrence({ lemma: 'apple', surfaces: ['apple'] }),
        occurrence({ lemma: 'apple', documentId: 'd2', surfaces: ['Apple'] }),
      ],
    })
    expect(entries[0].surfaces.sort()).toEqual(['Apple', 'apple'])
  })

  it('문서 필터가 있으면 그 문서의 단어만 남는다', () => {
    const entries = buildWordbook({
      languageCode: 'en',
      occurrences: [
        occurrence({ lemma: 'cat', documentId: 'd1' }),
        occurrence({ lemma: 'dog', documentId: 'd2' }),
      ],
      documentId: 'd2',
    })
    expect(entries.map((e) => e.lemma)).toEqual(['dog'])
  })

  it('검색이 표기와 원형 모두를 본다', () => {
    const occurrences = [occurrence({ lemma: 'Apple', surfaces: ['Apple', 'apple'] })]
    expect(buildWordbook({ languageCode: 'en', occurrences, query: 'app' })).toHaveLength(1)
    expect(buildWordbook({ languageCode: 'en', occurrences, query: 'zzz' })).toHaveLength(0)
  })

  it('US 와 us 는 별개 항목으로 남는다', () => {
    const entries = buildWordbook({
      languageCode: 'en',
      occurrences: [
        occurrence({ lemma: 'US' }),
        occurrence({ lemma: 'us' }),
      ],
    })
    expect(entries.map((e) => e.lemma).sort()).toEqual(['US', 'us'])
  })

  it('statusOf 로 조회 함수를 넘길 수 있다', () => {
    const entries = buildWordbook({
      languageCode: 'ko',
      occurrences: [occurrence({ lemma: '고양이', languageCode: 'ko' })],
      statusOf: (lang, lemma) => (lang === 'ko' && lemma === '고양이' ? state('고양이', 'known') : undefined),
    })
    expect(entries[0].status).toBe('known')
  })
})

describe('wordbookGroupOrDefault', () => {
  it('다섯 탭은 그대로 둔다', () => {
    for (const group of ['favorite', 'known', 'unsure', 'unknown', 'unmarked']) {
      expect(wordbookGroupOrDefault(group)).toBe(group)
    }
  })

  it('이상한 값은 ★ 탭으로 — 처음 여는 자리와 같다', () => {
    expect(wordbookGroupOrDefault('all')).toBe('favorite')
    expect(wordbookGroupOrDefault(null)).toBe('favorite')
    expect(wordbookGroupOrDefault(undefined)).toBe('favorite')
  })
})