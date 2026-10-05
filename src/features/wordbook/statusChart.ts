import type { WordStatus } from '../../types'

export type StatusCounts = Record<WordStatus | 'unmarked', number>

/**
 * 차트와 아래 설명의 순서.
 *
 * 미표시를 먼저 둔다 — '아직 손댄 것이 가장 많다' 는 사실이 눈에 먼저 들어와야 하고,
 * 그 다음에 아는 것이 얼마나 되는지가 따라온다.
 */
export const CHART_ORDER: (WordStatus | 'unmarked')[] = ['unmarked', 'known', 'unsure', 'unknown']

/**
 * 차트에 채우는 색.
 *
 * 상태 표시와 같은 규칙을 쓴다 — 아는 단어는 색을 칠하지 않는다는 이 앱의 규칙을
 * 여기서 새로 정하지 않는다. 본문색이 '기본 색' 이므로 차트에서도 본문색을 쓴다.
 * 같은 말을 화면 두 곳에서 다르게 그리지 않게 하는 것이 요점이다.
 */
export const FILL_CLASS: Record<WordStatus | 'unmarked', string> = {
  unmarked: 'bg-unmarked',
  known: 'bg-ink',
  unsure: 'bg-status-unsure',
  unknown: 'bg-status-unknown',
}

/** 백분율 하나 — 전체가 0 이면 0 이다 */
export function percent(count: number, total: number): number {
  if (total === 0) return 0
  return Math.round((count / total) * 100)
}

/**
 * 네 개의 백분율을 **합이 정확히 100 이 되도록** 낸다.
 *
 * 따로 반올림하면 합이 101 이거나 99 가 된다 — 7/13/1/1 을 22 로 나누면 32+59+5+5=101.
 * '몫' 을 말하는 자리에서 합이 어긋나면 그것이 틀린 숫자로 읽힌다.
 *
 * 나머지가 큰 것부터 1 씩 더 준다(최대 나머지법). 그래서 막대의 폭과 아래 설명이
 * 같은 숫자에서 나올 수 있다 — 두 곳이 어긋나지 않게 하는 것이 요점이다.
 */
export function percentages(counts: StatusCounts): Record<WordStatus | 'unmarked', number> {
  const total = CHART_ORDER.reduce((sum, key) => sum + counts[key], 0)
  const result = { unmarked: 0, known: 0, unsure: 0, unknown: 0 }
  if (total === 0) return result

  const exact = CHART_ORDER.map((key) => {
    const value = (counts[key] / total) * 100
    return { key, floor: Math.floor(value), rest: value - Math.floor(value) }
  })

  let sum = exact.reduce((acc, item) => acc + item.floor, 0)
  const order = [...exact].sort((a, b) => b.rest - a.rest)
  for (const item of order) {
    if (sum >= 100) break
    result[item.key] = item.floor + 1
    sum += 1
  }
  for (const item of exact) {
    if (result[item.key] === 0 && item.floor > 0) result[item.key] = item.floor
  }
  return result
}

/** 그룹별 목록 길이에서 상태별 개수를 만든다 */
export function countsFromGroups(grouped: Record<string, unknown[]>): StatusCounts {
  const counts: StatusCounts = { unmarked: 0, known: 0, unsure: 0, unknown: 0 }
  for (const key of CHART_ORDER) counts[key] = grouped[key]?.length ?? 0
  return counts
}

/**
 * 막대에 그릴 구간.
 *
 * 폭을 백분율에서 가져온다 — 아래에 적힌 숫자와 같은 숫자여야 한다. 따로 계산하면
 * 눈에 띄지 않을 만큼 어긋나도, 어긋난다는 사실 자체가 버그다.
 */
export function segments(counts: StatusCounts): { key: WordStatus | 'unmarked'; percent: number }[] {
  const total = CHART_ORDER.reduce((sum, key) => sum + counts[key], 0)
  if (total === 0) return []
  const shares = percentages(counts)
  return CHART_ORDER.filter((key) => counts[key] > 0).map((key) => ({
    key,
    percent: shares[key],
  }))
}