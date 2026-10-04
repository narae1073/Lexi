import { describe, expect, it } from 'vitest'

import type { Segment, Sentence } from '../../types'
import {
  DEFAULT_READER_PAGE_WORDS,
  isOnPage,
  pageOfSentence,
  pageWordsOrDefault,
  planPages,
  READER_PAGE_WORDS,
  type DocumentPage,
} from './pageBreak'
import { tokenize } from './tokenizer'

/** sentences 를 본문 문자열로부터 만든다 — 오프셋이 진짜 오프셋이어야 한다 */
function sentencesOf(text: string): Sentence[] {
  const out: Sentence[] = []
  const re = /[^.!?\n]+[.!?]?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ index: out.length, text: m[0], start: m.index, end: m.index + m[0].length })
  }
  return out
}

/**
 * 세그먼트 끝 위치.
 *
 * 실제 토크나이저는 마침표와 공백을 한 세그먼트로 묶어 두 칸을 차지한다.
 * 그래서 문장 시작은 마침표 '뒤' 다 — 이 차이가 쪽 경계 글자 유실의 원인이었다.
 */
function segmentEndsOf(text: string, sentences: Sentence[]): number[] {
  const ends: number[] = []
  let cursor = 0
  for (const sentence of sentences) {
    // 문장 앞의 구분 문자·공백을 한 세그먼트로 본다
    if (sentence.start > cursor) {
      cursor = sentence.start + 1
      ends.push(cursor)
    }
    cursor = sentence.end
    ends.push(cursor)
  }
  if (cursor < text.length) ends.push(text.length)
  return [...new Set(ends)].sort((a, b) => a - b)
}

/** 문장마다 단어를 counts 개씩 넣는다 */
function withWords(sentences: Sentence[], counts: number[]): number[] {
  return sentences.map((_, i) => counts[i] ?? 0)
}

const TEXT = 'One two three. Four five six. Seven eight nine. Ten eleven twelve.'
const SENTENCES = sentencesOf(TEXT) // 4 문장, 문장마다 3 단어

describe('planPages', () => {
  it('지정한 단어 수에 맞춰 문장 경계에서 자른다', () => {
    const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 6, segmentEndsOf(TEXT, SENTENCES))
    expect(pages).toHaveLength(2)
    expect(pages[0].wordCount).toBe(6)
    expect(pages[1].wordCount).toBe(6)
    expect(pages[0].sentenceTo).toBe(2)
    expect(pages[1].sentenceFrom).toBe(2)
  })

  it('쪽들의 문자 범위가 원문 전체를 빈틈없이 덮는다', () => {
    const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 4, segmentEndsOf(TEXT, SENTENCES))
    expect(pages[0].start).toBe(0)
    expect(pages.at(-1)!.end).toBe(TEXT.length)
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i].start).toBe(pages[i - 1].end)
    }
  })

  it('중간에서 끊기지 않는다 — 각 쪽은 문장 경계에서 시작하고 끝난다', () => {
    const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 4, segmentEndsOf(TEXT, SENTENCES))
    for (const page of pages) {
      const startsAtSentence = SENTENCES.some((s) => s.start === page.start)
      const endsAtSentence = page.end === TEXT.length || SENTENCES.some((s) => s.end === page.end)
      expect(startsAtSentence).toBe(true)
      expect(endsAtSentence).toBe(true)
    }
  })

  it('몇 단어인지와 상관없이 모든 문장이 정확히 한 쪽에 있다', () => {
    for (const size of [1, 2, 3, 4, 5, 7, 12, 100]) {
      const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), size, segmentEndsOf(TEXT, SENTENCES))
      const seen = new Set<number>()
      for (const page of pages) {
        for (let i = page.sentenceFrom; i < page.sentenceTo; i++) seen.add(i)
      }
      expect(seen.size).toBe(SENTENCES.length)
      // 두 쪽에 동시에 담기면 안 된다
      for (const page of pages) {
        expect(page.sentenceFrom).toBeLessThan(page.sentenceTo)
      }
    }
  })

  it('예산을 넘어도 첫 문장은 자기 쪽을 만든다 — 0 쪽이 되거나 문장이 사라지지 않는다', () => {
    const text = 'First one. A much much longer sentence than the page can hold. Well.'
    const sentences = sentencesOf(text)
    // 첫 문장 1 단어, 둘째 99 단어 → 둘째는 예산을 넘고도 자기 쪽이 되어야 한다
    const pages = planPages(text, sentences, withWords(sentences, [1, 99]), 10, segmentEndsOf(text, sentences))
    expect(pages[0].wordCount).toBe(1)
    expect(pages[1].sentenceFrom).toBe(1)
    expect(pages[1].wordCount).toBe(99)
    // 겉돌다가 문장을 잃어서는 안 된다
    const seen = pages.flatMap((p) => Array.from({ length: p.sentenceTo - p.sentenceFrom }, (_, i) => p.sentenceFrom + i))
    expect(seen).toEqual(sentences.map((x) => x.index))
  })

  it('문장이 하나뿐이면 한 쪽이다', () => {
    const one = SENTENCES.slice(0, 1)
    const pages = planPages(TEXT, one, withWords(one, [3]), 1, segmentEndsOf(TEXT, one))
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ start: 0, end: TEXT.length, sentenceFrom: 0, sentenceTo: 1 })
  })

  it('문장이 하나도 없으면 빈 본문을 한 쪽으로 본다', () => {
    const blank = '   \n  '
    const pages = planPages(blank, [], [], 10, segmentEndsOf(blank, []))
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ start: 0, end: blank.length, wordCount: 0 })
  })

  it('첫 문장 앞의 글자는 첫 쪽에, 마지막 뒤의 글자는 마지막 쪽에 붙는다', () => {
    const text = '\n\n  Leading. Trailing.\n\n'
    const sentences = sentencesOf(text)
    const pages = planPages(text, sentences, withWords(sentences, [1, 1]), 1, segmentEndsOf(text, sentences))
    expect(pages[0].start).toBe(0)
    expect(pages.at(-1)!.end).toBe(text.length)
  })

  it('쪽 수가 0 이거나 음수여도 한 쪽 이상은 나온다', () => {
    expect(planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 0, segmentEndsOf(TEXT, SENTENCES)).length).toBeGreaterThanOrEqual(1)
    expect(planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), -5, segmentEndsOf(TEXT, SENTENCES)).length).toBeGreaterThanOrEqual(1)
  })

  it('각 쪽의 단어 순번이 이어진다 — 10–20 쪽, 21–40 쪽 이처럼', () => {
    const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 6, segmentEndsOf(TEXT, SENTENCES))
    expect(pages.map((p) => [p.from, p.to])).toEqual([
      [1, 6],
      [7, 12],
    ])
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i].from).toBe(pages[i - 1].to + 1)
    }
  })

  it('쪽 번호가 순서대로 매겨진다', () => {
    const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 3, segmentEndsOf(TEXT, SENTENCES))
    expect(pages.map((p) => p.index)).toEqual(pages.map((_, i) => i))
  })
})

describe('isOnPage', () => {
  const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 6, segmentEndsOf(TEXT, SENTENCES))

  // 첫 쪽 = 문장 0·1, 둘째 쪽 = 문장 2·3
  const firstSentence = { start: SENTENCES[0].start, end: SENTENCES[0].end }
  const thirdSentence = { start: SENTENCES[2].start, end: SENTENCES[2].end }

  it('문장이 둘째 쪽에 있으면 첫 쪽이 아니다', () => {
    expect(isOnPage(firstSentence, pages[0])).toBe(true)
    expect(isOnPage(thirdSentence, pages[0])).toBe(false)
  })

  it('문장이 둘째 쪽에 있으면 둘째 쪽이다', () => {
    expect(isOnPage(thirdSentence, pages[1])).toBe(true)
  })

  it('어느 쪽에도 걸리지 않으면 어느 쪽에도 아니다', () => {
    const straddling = { start: pages[0].end - 1, end: pages[1].start + 1 }
    expect(isOnPage(straddling, pages[0])).toBe(false)
    expect(isOnPage(straddling, pages[1])).toBe(false)
  })
})

describe('pageOfSentence', () => {
  const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 6, segmentEndsOf(TEXT, SENTENCES))

  it('문장이 어느 쪽에 있는지 알려준다', () => {
    expect(pageOfSentence(0, pages)).toBe(0)
    expect(pageOfSentence(1, pages)).toBe(0)
    expect(pageOfSentence(2, pages)).toBe(1)
    expect(pageOfSentence(3, pages)).toBe(1)
  })

  it('범위 밖 문장은 -1 이다', () => {
    expect(pageOfSentence(99, pages)).toBe(-1)
    expect(pageOfSentence(-1, pages)).toBe(-1)
  })
})

describe('pageWordsOrDefault', () => {
  it('고를 수 있는 값만 받아들인다', () => {
    for (const value of READER_PAGE_WORDS) {
      expect(pageWordsOrDefault(value)).toBe(value)
    }
  })

  it('깨진 저장은 스스로 고쳐야 한다', () => {
    expect(pageWordsOrDefault(0)).toBe(DEFAULT_READER_PAGE_WORDS)
    expect(pageWordsOrDefault(Number.NaN)).toBe(DEFAULT_READER_PAGE_WORDS)
    expect(pageWordsOrDefault(137)).toBe(DEFAULT_READER_PAGE_WORDS)
  })
})


/**
 * 실제 토크나이저를 태운 회귀 테스트.
 *
 * 가짜 문장 배열로는 이 버그를 잡을 수 없었다. 토크나이저는 마침표와 공백을
 * 한 세그먼트로 묶어 두 칸을 차지하는데, 문장 시작은 마침표 '뒤' 다. 그래서
 * 쪽 경계를 문장 시작에 두면 그 세그먼트가 앞쪽 끝을 넘고 뒤쪽 시작을 미쳐
 * 어느 쪽에도 렌더되지 않았다. 사용자에게는 "마침표가 안 보인다" 로 보였다.
 */
describe('실제 토크나이저와 함께 — 글자가 하나도 사라지지 않아야 한다', () => {
  const CASES: [string, string][] = [
    ['en', 'First one two. Second one two. Third one two. Fourth one two.'],
    ['en', 'Reading is the quiet habit. The Apple store is busy today. Small daily minutes beat one long weekend.'],
    ['ko', '나는 매일 글을 읽습니다. 읽는 습관이 중요합니다. Honesty is the best policy.'],
    ['ja', '毎朝コーヒーを飲みます。文章を書くのが好きです。日本語は楽しい。'],
    ['de', 'Das Haus ist groß. Die Straße ist lang. Guten Morgen! Wie geht es dir?'],
    ['fr', "Le chat dort. Un très long phrase qui ne finit pas. Après tout, c'est bien."],
    ['es', 'El gato y la luna. Había una vez un gato pequeño que vivía en un tejado.'],
    ['en', `Line one.
Line two.

Line three with   spaces.
Line four!`],
  ]

  function pagesOf(languageCode: string, text: string, wordsPerPage: number) {
    const { segments, sentences } = tokenize(text, languageCode)
    const counts = sentences.map((sentence) =>
      segments.reduce(
        (n, s) => (s.type === 'word' && s.sentenceIndex === sentence.index ? n + 1 : n),
        0,
      ),
    )
    return {
      pages: planPages(text, sentences, counts, wordsPerPage, segments.map((s) => s.end)),
      segments,
    }
  }

  const visibleText = (pages: DocumentPage[], segments: Segment[]) =>
    pages.map((page) => segments.filter((s) => isOnPage(s, page)).map((s) => s.text).join(''))

  for (const [languageCode, text] of CASES) {
    for (const wordsPerPage of [1, 2, 5, 13, 1000]) {
      it(`${languageCode} · 한 쪽 ${wordsPerPage}단어 — ${JSON.stringify(text.slice(0, 22))}`, () => {
        const { pages, segments } = pagesOf(languageCode, text, wordsPerPage)

        // 쪽들이 원문 전체를 빈틈없이 덮는다
        expect(pages[0].start).toBe(0)
        expect(pages.at(-1)!.end).toBe(text.length)
        for (let i = 1; i < pages.length; i++) {
          expect(pages[i].start).toBe(pages[i - 1].end)
        }

        // ★ 표시되는 글자를 다 합치면 원문과 정확히 같아야 한다
        expect(visibleText(pages, segments).join('')).toBe(text)

        // 경계가 세그먼트를 가로지르지 않는다 — 가로지르면 글자가 사라진다
        for (const page of pages) {
          for (const segment of segments) {
            const inside = segment.start >= page.start && segment.end <= page.end
            const before = segment.end <= page.start
            const after = segment.start >= page.end
            expect(inside || before || after).toBe(true)
          }
        }
      })
    }
  }

  it('문장 끝의 마침표가 마지막 쪽에 남는다', () => {
    const text = 'First one two. Second one two. Third one two. Fourth one two.'
    const { pages, segments } = pagesOf('en', text, 6)
    expect(pages).toHaveLength(2)

    const firstPageText = segments.filter((s) => isOnPage(s, pages[0])).map((s) => s.text).join('')

    // 쪽이 마침표에서 끊기지 않는다 — 회귀: '. ' 가 어느 쪽에도 렌더되지 않았다
    expect(firstPageText.trimEnd().endsWith('two.')).toBe(true)
    expect(firstPageText).not.toBe('First one two. Second one two')

    // 마침표와 그 뒤 공백은 앞쪽 쪽에 함께 남는다
    expect(pages[0].end).toBe(text.indexOf('Third'))
    expect(text.slice(pages[0].end - 2, pages[0].end)).toBe('. ')
  })

  /**
   * 세그먼트 끝을 **모두** 넘겨야 한다.
   *
   * 단어 세그먼트만 넘기면 마침표와 공백 세그먼트가 빠져 있어, 경계를 밀 때
   * 다음 문장의 첫 단어 뒤로 밀려 그 단어가 렌더되지 않는다.
   * e2e 가 이걸 잡았다 — 쪽 2 가 'Repeat' 없이 ' that choice tomorrow.' 로 시작했다.
   */
  it('단어 세그먼트만 넘기면 다음 문장의 첫 단어가 사라진다 — 그래서 전부 넘긴다', () => {
    const text = 'First one two. Second one two. Third one two. Fourth one two.'
    const { segments, sentences } = tokenize(text, 'en')
    const counts = sentences.map((s) =>
      segments.reduce((n, x) => (x.type === 'word' && x.sentenceIndex === s.index ? n + 1 : n), 0),
    )

    const wordsOnly = planPages(text, sentences, counts, 6, segments
      .filter((x) => x.type === 'word')
      .map((x) => x.end))
    const allEnds = planPages(text, sentences, counts, 6, segments.map((x) => x.end))

    const firstWordOf = (pages: DocumentPage[], index: number) =>
      segments.find((x) => isOnPage(x, pages[index]) && x.type === 'word')?.text

    expect(firstWordOf(wordsOnly, 1)).not.toBe('Third')
    expect(firstWordOf(allEnds, 1)).toBe('Third')
  })

  it('뒤쪽 쪽의 문자 오프셋이 원문과 일치한다 — 문장 번역이 옆 문장을 잡지 않는다', () => {
    const text = 'First one two. Second one two. Third one two. Fourth one two.'
    const { pages, segments } = pagesOf('en', text, 6)
    const second = pages[1]

    const container = segments.filter((s) => isOnPage(s, second)).map((s) => s.text).join('')

    // 쪽 안에서 몇 번째 글자인지 + 쪽 시작 = 원문 오프셋.
    // 어긋나면 문장 번역이 옆 문장을 잡는다 — 이게 쪽 경계 버그의 두 번째 얼굴이다.
    for (const word of ['Third', 'one', 'Fourth']) {
      expect(second.start + container.indexOf(word)).toBe(text.indexOf(word, second.start - 1))
    }
    // 쪽 본문은 원문 그 구간과 정확히 같다
    expect(container).toBe(text.slice(second.start))
  })
})
