import type { Sentence } from '../../types'

/**
 * 드래그로 선택한 문자 구간을 문장 단위로 넓힌다 (PLAN.md §5.4).
 *
 * 선택이 어느 한 문장 중간에서 시작하거나 끝나도 그 문장 전체를 다룬다 —
 * plan.txt 6줄의 "문장 선택"은 단어 몇 개가 아니라 문장 한 줄 전체를 뜻한다.
 */

export type SelectionRange = { start: number; end: number }

/** 선택 구간과 겹치는 문장 인덱스 목록. 겹치는 문장은 항상 연속이다. */
export function sentencesInRange(sentences: Sentence[], range: SelectionRange): number[] {
  const indexes: number[] = []
  for (const sentence of sentences) {
    if (sentence.end <= range.start) continue
    if (sentence.start >= range.end) break
    indexes.push(sentence.index)
  }
  return indexes
}

/** 선택 구간이 걸쳐 있는 문장들을 이어 붙인 원문. */
export function joinSentences(sentences: Sentence[], range: SelectionRange): string {
  const indexes = sentencesInRange(sentences, range)
  if (indexes.length === 0) return ''
  const first = sentences.find((s) => s.index === indexes[0])
  const last = sentences.find((s) => s.index === indexes[indexes.length - 1])
  if (!first || !last) return ''
  return sentences
    .filter((s) => s.index >= first.index && s.index <= last.index)
    .map((s) => s.text)
    .join('')
}

/** 문자 오프셋를 포함하는 문장 하나 */
export function sentenceAt(sentences: Sentence[], offset: number): Sentence | undefined {
  return sentences.find((s) => offset >= s.start && offset < s.end)
}