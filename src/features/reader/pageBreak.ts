import type { Sentence } from '../../types'

/**
 * 문서를 쪽으로 나누기 (plan.txt 7줄).
 *
 * 몇 글자씩 잘라 붙이면 문장이 중간에서 끊겨 학습할 때 성가시다.
 * 문장 경계에서만 자르되, 원문의 문자 오프셋은 그대로 보존한다 —
 * 그래야 단어 상태 조회와 문장 번역이 어느 쪽에서 해도 같은 오프셋을 쓴다.
 */
export type DocumentPage = {
  /** 0 부터 */
  index: number
  /** 원문 기준 시작 문자 오프셋 */
  start: number
  /** 원문 기준 끝 문자 오프셋 (exclusive) */
  end: number
  sentenceFrom: number
  sentenceTo: number
  /** 이 쪽에 담긴 단어 수 (등장 횟수) */
  wordCount: number
  /** 이 쪽 첫 단어의 문서 내 순번 (1 부터) */
  from: number
  /** 이 쪽 마지막 단어의 문서 내 순번 */
  to: number
}

/** 한 쪽에 몇 단어까지 담을지 선택지 */
export const READER_PAGE_WORDS = [50, 100, 200, 300, 500] as const
export const DEFAULT_READER_PAGE_WORDS = 100

export function pageWordsOrDefault(value: number): number {
  return (READER_PAGE_WORDS as readonly number[]).includes(value) ? value : DEFAULT_READER_PAGE_WORDS
}

/**
 * 쪽 배치를 계산한다.
 *
 * pages 는 [0, rawText.length) 를 빈틈없이 덮는다 — 세그먼트를 쪽별로 걸러
 * 렌더해도 어느 글자도 빠지지 않고, 어느 쪽에도 중복되지 않는다.
 *
 * wordsPerSentence[i] 는 sentences[i] 에 들어 있는 단어 수다. 문장 사이에
 * 걸친 여백이 있는 경우 그 여백은 앞쪽 쪽이 끝까지 삼킨다.
 */
export function planPages(
  rawText: string,
  sentences: Sentence[],
  wordsPerSentence: readonly number[],
  wordsPerPage: number,
  wordStarts: readonly number[],
): DocumentPage[] {
  const size = Math.max(1, Math.floor(wordsPerPage))
  const pages: DocumentPage[] = []

  /** 경계가 단어 안에 들어가면 그 단어 앞으로 되돌린다 — 단어는 자르지 않는다 */
  const snap = (boundary: number): number => {
    // wordStarts 는 오름차순이므로, boundary 보다 작은 가장 큰 값이 그 단어의 시작
    let before = 0
    for (const start of wordStarts) {
      if (start < boundary) before = start
      else break
    }
    return boundary > before ? boundary : before
  }

  let start = 0
  let sentenceFrom = 0
  let words = 0
  let seen = 0

  for (let i = 0; i < sentences.length; i++) {
    const count = wordsPerSentence[i] ?? 0
    const wouldBe = words + count

    if (i > sentenceFrom && wouldBe > size) {
      const boundary = Math.max(start, snap(sentences[i].start))
      pages.push({
        index: 0,
        start,
        end: boundary,
        sentenceFrom,
        sentenceTo: i,
        wordCount: words,
        from: seen + 1,
        to: seen + words,
      })
      start = boundary
      sentenceFrom = i
      seen += words
      words = count
    } else {
      words = wouldBe
    }
  }

  pages.push({
    index: 0,
    start,
    end: rawText.length,
    sentenceFrom,
    sentenceTo: sentences.length,
    wordCount: words,
    from: words === 0 ? 0 : seen + 1,
    to: seen + words,
  })

  return pages.map((page, index) => ({ ...page, index }))
}

/**
 * 이 쪽에서 렌더할 텍스트.
 *
 * 경계가 텍스트 세그먼트 안에 있을 수 있으므로 잘라서 돌려준다.
 * 그래야 마침표는 앞쪽 쪽에 남고, 문장을 여는 부호는 그 문장에 남는다.
 * 단어 세그먼트는 경계에 걸리지 않으므로 항상 통째로 나온다.
 */
export function textOfPage<T extends { start: number; end: number; text: string }>(
  segments: T[],
  page: DocumentPage,
): T[] {
  return segments
    // 경계에 걸치면 양쪽에 나타난다 — 이 쪽에서 보여 줄 부분만 잘라 준다
    .filter((s) => s.end > page.start && s.start < page.end)
    .map((s) => ({
      ...s,
      text: s.text.slice(
        Math.max(0, page.start - s.start),
        Math.min(s.text.length, page.end - s.start),
      ),
    }))
    .filter((s) => s.text.length > 0)
}

/**
 * 이 쪽에 들어가는 세그먼트인가.
 *
 * 경계가 세그먼트 안에 있을 수 있으므로 '걸친다' 도 포함한다.
 * 표시할 글자는 textOfPage 가 잘라 준다.
 */
export function isOnPage(segment: { start: number; end: number }, page: DocumentPage): boolean {
  return segment.end > page.start && segment.start < page.end
}

/** 문장 번호로 그 문장이 어느 쪽에 있는지 — 없으면 -1 */
export function pageOfSentence(sentenceIndex: number, pages: DocumentPage[]): number {
  return pages.findIndex(
    (page) => sentenceIndex >= page.sentenceFrom && sentenceIndex < page.sentenceTo,
  )
}
