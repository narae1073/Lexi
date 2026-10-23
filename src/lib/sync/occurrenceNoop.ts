import type { WordOccurrence } from '../../app/stores/occurrences'

/**
 * 두 등장 기록 목록이 **내용상** 같은지.
 *
 * 문서를 다시 열 때마다 기록을 그대로 다시 쓰면, 사용자에게 보일 변화가 없는데도
 * IndexedDB 행이 모두 지워졌다 새로 들어가고 동기화는 그 문서를 '바뀐 것' 으로
 * 보낸다. 문서가 많을수록 이 헛일이 커진다.
 *
 * 그래서 저장 여부는 **의미 있는 내용**으로만 정한다:
 * - 문서·언어·lemma·표기·횟수·문자 위치·예문은 내용이다.
 * - `recordedAt` 은 마지막 계산 시각, `documentTitle` 은 표시용 사본이라
 *   제목만 바뀐 것을 등장 기록의 변경으로 보지 않는다.
 *
 * 두 목록의 순서는 저장 순서에 따라 달라질 수 있으므로
 * `(documentId, languageCode, lemma)` 로 정렬한 뒤 비교한다.
 */
export function sameOccurrenceRecords(
  existing: readonly WordOccurrence[],
  next: readonly WordOccurrence[],
): boolean {
  if (existing.length !== next.length) return false
  const a = [...existing].sort(compareRecords)
  const b = [...next].sort(compareRecords)
  return a.every((record, i) => sameRecord(record, b[i]))
}

function compareRecords(a: WordOccurrence, b: WordOccurrence): number {
  return (
    compareText(a.documentId, b.documentId) ||
    compareText(a.languageCode, b.languageCode) ||
    compareText(a.lemma, b.lemma)
  )
}

function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function sameRecord(a: WordOccurrence, b: WordOccurrence): boolean {
  return (
    a.documentId === b.documentId &&
    a.languageCode === b.languageCode &&
    a.lemma === b.lemma &&
    a.count === b.count &&
    a.charStart === b.charStart &&
    a.charEnd === b.charEnd &&
    a.sentence === b.sentence &&
    sameSurfaces(a.surfaces, b.surfaces)
  )
}

/** 표기 목록은 집합이다 — 들어온 순서는 뜻이 없다 */
function sameSurfaces(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((surface, i) => surface === right[i])
}
