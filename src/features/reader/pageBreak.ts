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
  /**
   * 세그먼트의 끝 위치(오름차순).
   *
   * 없으면 쪽 경계가 문장 시작에 딱 맞아떨어져야 하는데, 실제로는 그렇지 않다.
   * 토크나이저는 마침표와 공백을 한 세그먼트로 묶어(". ") 두 칸을 차지하는데
   * 문장 시작은 마침표 **뒤**다. 경계를 문장 시작에 두르면 그 세그먼트가
   * 앞쪽 끝을 넘고 뒤쪽 시작을 미쳐 어느 쪽에도 렌더되지 않는다.
   * '. ' 가 사라지고, 게다가 뒤쪽 페이지의 문자 오프셋이 어긋나 문장 번역이
   * 옆 문장을 잡았다.
   *
   * 그래서 경계를 세그먼트 끝으로 민다.
   */
  segmentEnds: readonly number[],
): DocumentPage[] {
  const size = Math.max(1, Math.floor(wordsPerPage))
  const pages: DocumentPage[] = []

  /** 경계를 포함하는 세그먼트의 끝으로 민다 — 문장 끝의 '. ' 가 앞쪽 쪽에 남는다 */
  const snap = (boundary: number): number => {
    for (const end of segmentEnds) {
      if (end >= boundary) return end
    }
    // 세그먼트 정보가 없으면 어디까지 밀어야 안전한지 알 수 없다.
    // 경계를 그대로 쓰면 글자가 사라지므로, 본문 끝을 최악으로 삼아 경고가
    // 나게 하고(테스트가 잡아낸다) 본문이 빈 경우만 그대로 둔다.
    return rawText.length
  }

  let start = 0
  let sentenceFrom = 0
  let words = 0
  let seen = 0

  for (let i = 0; i < sentences.length; i++) {
    const count = wordsPerSentence[i] ?? 0
    const wouldBe = words + count

    // 첫 문장은 예산을 넘어도 자기 쪽을 만든다.
    // 넘긴다고 계속 넘기면 문장이 한 쪽에도 담기지 않는 상황이 생긴다.
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

  // 마지막 문장 뒤에 남은 글자(줄바꿈 등)도 마지막 쪽에 붙인다
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

/** 이 쪽에 들어가는 세그먼트인가 — 오프셋은 원문 기준이라 그대로 비교하면 된다 */
export function isOnPage(segment: { start: number; end: number }, page: DocumentPage): boolean {
  return segment.start >= page.start && segment.end <= page.end
}

/** 문장 번호로 그 문장이 어느 쪽에 있는지 — 없으면 -1 */
export function pageOfSentence(sentenceIndex: number, pages: DocumentPage[]): number {
  return pages.findIndex(
    (page) => sentenceIndex >= page.sentenceFrom && sentenceIndex < page.sentenceTo,
  )
}
