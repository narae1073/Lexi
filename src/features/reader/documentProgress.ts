import type { WordOccurrence } from '../../app/stores/occurrences'
import type { WordStatus, WordState } from '../../types'

/**
 * 문서별 진도.
 *
 * 상태 바와 같은 기준을 쓴다 — 중복을 뺀 서로 다른 단어 수 대비 표시한 비율.
 * 등장 횟수로 세면 "the" 가 백 번 나와 진도를 끌어올려 숫자가 거짓말을 한다.
 */
export type DocumentProgress = {
  /** 서로 다른 단어 수 */
  total: number
  /** 그중 상태를 표시한 단어 수 */
  marked: number
  /** 0~100. 반올림 */
  percent: number
}

type StatusLookup = (lemma: string) => WordState | undefined

/**
 * 한 문서의 진도를 낸다.
 *
 * total 이 0 이면 percent 도 0 이다. 아직 이 기기에서 그 문서를 열어 보지
 * 않았다면 모르는 것이지 0% 가 아니다 — 호출자는 total 로 구분해 표시한다.
 */
export function documentProgress(
  occurrences: WordOccurrence[],
  statusOf: StatusLookup,
): DocumentProgress {
  const lemmas = new Set<string>()
  let marked = 0

  for (const occurrence of occurrences) {
    if (lemmas.has(occurrence.lemma)) continue
    lemmas.add(occurrence.lemma)
    if (statusOf(occurrence.lemma)?.status) marked += 1
  }

  return {
    total: lemmas.size,
    marked,
    percent: lemmas.size === 0 ? 0 : Math.round((marked / lemmas.size) * 100),
  }
}

/** 등장 기록을 문서별로 모은다 — 목록에서 한 번만 쓰인다 */
export function groupByDocument(occurrences: WordOccurrence[]): Map<string, WordOccurrence[]> {
  const grouped = new Map<string, WordOccurrence[]>()
  for (const occurrence of occurrences) {
    const list = grouped.get(occurrence.documentId)
    if (list) list.push(occurrence)
    else grouped.set(occurrence.documentId, [occurrence])
  }
  return grouped
}

/**
 * Status overrides a progress worker still needs.
 *
 * The worker's rebuilt dataset already carries each projection row's status.
 * Only a local tap made after that rebuild differs; sending the whole language
 * again would copy tens of thousands of statuses for one edit.
 */
export function changedStatuses(
  current: Readonly<Record<string, { status?: WordStatus | null } | undefined>>,
  rebuilt: ReadonlyMap<string, WordStatus | 'unmarked'>,
): Record<string, WordStatus | 'unmarked'> {
  const overrides: Record<string, WordStatus | 'unmarked'> = {}
  for (const [key, state] of Object.entries(current)) {
    const status = state?.status ?? 'unmarked'
    if (rebuilt.get(key) !== status) overrides[key] = status
  }
  return overrides
}