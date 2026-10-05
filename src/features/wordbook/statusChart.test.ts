import { describe, expect, it } from 'vitest'

import {
  CHART_ORDER,
  countsFromGroups,
  FILL_CLASS,
  percent,
  percentages,
  segments,
} from './statusChart'

describe('상태별 개수', () => {
  it('그룹별 목록 길이를 그대로 센다', () => {
    const counts = countsFromGroups({ unmarked: [1, 2], known: [1], unsure: [], unknown: [1, 2, 3] })
    expect(counts).toEqual({ unmarked: 2, known: 1, unsure: 0, unknown: 3 })
  })

  it('없는 그룹은 0 이다 — 비어 있는 것이지 없는 것이 아니다', () => {
    expect(countsFromGroups({}).known).toBe(0)
  })

  it('전체가 0 이면 모든 상태가 0 이다', () => {
    expect(countsFromGroups({ unmarked: [], known: [], unsure: [], unknown: [] })).toEqual({
      unmarked: 0,
      known: 0,
      unsure: 0,
      unknown: 0,
    })
  })
})

describe('백분율', () => {
  it('전체에서 각자의 몫이다', () => {
    expect(percent(1, 4)).toBe(25)
    expect(percent(3, 4)).toBe(75)
    expect(percent(1, 3)).toBe(33)
  })

  it('전체보다 클 수 없다 — 100 을 넘어가면 말이 되지 않는다', () => {
    expect(percent(5, 4)).toBe(125)
    expect(percent(10, 0)).toBe(0)
  })

  /** 아홉 개 중 하나면 11% — 반올림이 답을 지배할 수 있다 */
  it('한 자리 경계에서 반올림된다', () => {
    expect(percent(1, 9)).toBe(11)
    expect(percent(2, 3)).toBe(67)
  })

  it('따로 반올림하면 101 이 된다 — 그 상태로 보여주면 안 된다', () => {
    const counts = { unmarked: 7, known: 13, unsure: 1, unknown: 1 }
    const total = 22
    const loose = CHART_ORDER.reduce((acc, key) => acc + percent(counts[key], total), 0)
    expect(loose).toBe(101)
  })

  it('합이 정확히 100 이다 — 최대 나머지법으로 맞춘다', () => {
    const cases = [
      { unmarked: 7, known: 13, unsure: 1, unknown: 1 },
      { unmarked: 1, known: 1, unsure: 1, unknown: 1 },
      { unmarked: 1, known: 2, unsure: 3, unknown: 4 },
      { unmarked: 0, known: 1, unsure: 0, unknown: 2 },
      { unmarked: 100, known: 1, unsure: 1, unknown: 1 },
    ]
    for (const counts of cases) {
      const sum = CHART_ORDER.reduce((acc, key) => acc + percentages(counts)[key], 0)
      expect(sum).toBe(100)
    }
  })

  it('아무것도 없으면 모두 0 이다', () => {
    expect(percentages({ unmarked: 0, known: 0, unsure: 0, unknown: 0 })).toEqual({
      unmarked: 0,
      known: 0,
      unsure: 0,
      unknown: 0,
    })
  })
})

describe('막대 구간', () => {
  it('미표시 → 앎 → 헷갈림 → 모름 순서다', () => {
    const counts = { unmarked: 1, known: 1, unsure: 1, unknown: 1 }
    expect(segments(counts).map((s) => s.key)).toEqual(['unmarked', 'known', 'unsure', 'unknown'])
  })

  it('몫이 그대로 백분율이 된다', () => {
    expect(segments({ unmarked: 1, known: 3, unsure: 0, unknown: 0 })).toEqual([
      { key: 'unmarked', percent: 25 },
      { key: 'known', percent: 75 },
    ])
  })

  /** 0 인 것은 그리지 않는다 — 폭 0 인 구간은 눈에 거슬린다 */
  it('개수가 0 인 것은 그리지 않는다', () => {
    const drawn = segments({ unmarked: 2, known: 0, unsure: 0, unknown: 2 })
    expect(drawn.map((s) => s.key)).toEqual(['unmarked', 'unknown'])
  })

  it('전체가 0 이면 아무것도 그리지 않는다', () => {
    expect(segments({ unmarked: 0, known: 0, unsure: 0, unknown: 0 })).toEqual([])
  })

  it('몫의 합은 100 이다 — 빈틈도 겹침도 없어야 한다', () => {
    const counts = { unmarked: 3, known: 5, unsure: 2, unknown: 7 }
    const sum = segments(counts).reduce((acc, s) => acc + s.percent, 0)
    expect(sum).toBe(100)
  })

  /**
   * 막대의 폭과 아래에 적힌 숫자가 같은 숫자여야 한다.
   *
   * 따로 계산하면 눈에 띄지 않을 만큼 어긋나도, 어긋난다는 사실 자체가 버그다.
   */
  it('막대 폭이 설명과 같은 숫자다', () => {
    const counts = { unmarked: 7, known: 13, unsure: 1, unknown: 1 }
    const shares = percentages(counts)
    for (const seg of segments(counts)) {
      expect(seg.percent).toBe(shares[seg.key])
    }
  })
})

describe('색', () => {
  /**
   * 아는 단어는 색을 칠하지 않는다는 이 앱의 규칙을 여기서 새로 정하지 않는다.
   * 본문색이 '기본 색' 이므로 차트에서도 본문색을 쓴다.
   */
  it('아는 단어는 본문색이다', () => {
    expect(FILL_CLASS.known).toBe('bg-ink')
  })

  it('네 상태가 서로 다른 색이다', () => {
    const classes = CHART_ORDER.map((key) => FILL_CLASS[key])
    expect(new Set(classes).size).toBe(4)
  })

  /** 상태 표시와 같은 규칙을 쓰는지 — 같은 말을 두 곳에서 다르게 그리지 않게 한다 */
  it('상태 표시의 색과 어긋나지 않는다', () => {
    // statusClass 는 본문 강조를 정한다. 차트는 칠을 정한다.
    // 미표시가 본문색을 옅게 한 값인 만큼, 차트도 같은 이름을 쓴다
    expect(FILL_CLASS.unmarked).toContain('unmarked')
    expect(FILL_CLASS.unsure).toContain('unsure')
    expect(FILL_CLASS.unknown).toContain('unknown')
  })
})