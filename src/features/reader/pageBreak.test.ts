import { describe, expect, it } from 'vitest'

import type { LanguageCode, Segment, Sentence } from '../../types'
import {
  DEFAULT_READER_PAGE_WORDS,
  isOnPage,
  pageOfSentence,
  pageWordsOrDefault,
  planPages,
  READER_PAGE_WORDS,
  textOfPage,
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
/**
 * 단어 세그먼트의 시작 위치 (오름차순).
 *
 * 실제 토크나이저를 쓰지 않고 문장만으로 근사한다. 텍스트 세그먼트는 경계에서
 * 잘릴 수 있으므로 제약이 아니다.
 */
function segmentEndsOf(_text: string, sentences: Sentence[]): number[] {
  const starts = new Set<number>()
  for (const sentence of sentences) starts.add(sentence.start)
  return [...starts].sort((a, b) => a - b)
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

  /**
   * 경계에 걸친 세그먼트는 양쪽에 걸린 것으로 본다 — 잘라서 보여 준다.
   *
   * 예전엔 '어느 쪽에도 아니다' 가 정답이었다. 그랬더니 마침표와 공백 세그먼트가
   * 통째로 사라져 쪽 끝의 마침표가 보이지 않았다.
   */
  it('경계에 걸친 세그먼트는 걸친 것으로 본다 — 양쪽에서 잘라 보여 준다', () => {
    const straddling = { start: pages[0].end - 1, end: pages[1].start + 1 }
    expect(isOnPage(straddling, pages[0])).toBe(true)
    expect(isOnPage(straddling, pages[1])).toBe(true)
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
  const CASES: [LanguageCode, string][] = [
    ['en', 'First one two. Second one two. Third one two. Fourth one two.'],
    ['en', 'Reading is the quiet habit. The Apple store is busy today. Small daily minutes beat one long weekend.'],
    ['ko', '나는 매일 글을 읽습니다. 읽는 습관이 중요합니다. Honesty is the best policy.'],
    ['ja', '毎朝コーヒーを飲みます。文章を書くのが好きです。日本語は楽しい。'],
    ['de', 'Das Haus ist groß. Die Straße ist lang. Guten Morgen! Wie geht es dir?'],
    ['fr', "Le chat dort. Un très long phrase qui ne finit pas. Après tout, c'est bien."],
    ['es', 'El gato y la luna. Había una vez un gato pequeño que vivía en un tejado.'],
    ['de', 'Der Fuchs lachte. „Jetzt habe ich ihn", sagt er glücklich. Und die beiden bleiben.'],
    ['es', 'Por fin te toqué. ¡Ahora por fin te tocaré!", dijo feliz. Y desde entonces.'],
    ['es', 'Por fin te toqué! —¡Ahora por fin te tocaré!", dijo feliz. Y desde entonces.'],
    ['en', `Line one.
Line two.

Line three with   spaces.
Line four!`],
  ]

  function pagesOf(languageCode: LanguageCode, text: string, wordsPerPage: number) {
    const { segments, sentences } = tokenize(text, languageCode)
    const counts = sentences.map((sentence) =>
      segments.reduce(
        (n, s) => (s.type === 'word' && s.sentenceIndex === sentence.index ? n + 1 : n),
        0,
      ),
    )
    return {
      pages: planPages(
        text,
        sentences,
        counts,
        wordsPerPage,
        segments.filter((s) => s.type === 'word').map((s) => s.start),
      ),
      segments,
    }
  }

  const visibleText = (pages: DocumentPage[], segments: Segment[]) =>
    pages.map((page) => textOfPage(segments, page).map((s) => s.text).join(''))

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

        // 단어 세그먼트는 경계에 걸치지 않는다 — 잘리면 클릭·상태 조회가 어긋난다.
        // 텍스트 세그먼트는 잘릴 수 있다 (마침표·공백·여는 부호).
        for (let i = 1; i < pages.length; i++) {
          const boundary = pages[i].start
          for (const segment of segments) {
            if (segment.type !== 'word') continue
            const straddles = segment.start < boundary && segment.end > boundary
            expect(straddles).toBe(false)
          }
        }

        // 어떤 문자도 두 번 나오지 않는다 — 자르되 중복시키지 않는다
        const shown = visibleText(pages, segments)
        expect(shown.join('')).toBe(text)
        for (const piece of shown) {
          expect(piece.length).toBeGreaterThan(0)
        }
      })
    }
  }

  it('문장 끝의 마침표가 마지막 쪽에 남는다', () => {
    const text = 'First one two. Second one two. Third one two. Fourth one two.'
    const { pages, segments } = pagesOf('en', text, 6)
    const sentences = tokenize(text, 'en').sentences
    expect(pages).toHaveLength(2)

    const firstPageText = textOfPage(segments, pages[0]).map((s) => s.text).join('')

    // 쪽이 마침표에서 끊기지 않는다 — 회귀: '. ' 가 어느 쪽에도 렌더되지 않았다
    expect(firstPageText.trimEnd().endsWith('two.')).toBe(true)
    expect(firstPageText).not.toBe('First one two. Second one two')

    // 경계는 문장 시작이다. 마침표는 앞쪽 쪽에 남고, 그 뒤 공백만 넘는다.
    expect(pages[0].end).toBe(sentences[2].start)
    expect(text.slice(pages[0].end - 1, pages[0].end)).toBe('.')
    const secondPageText = textOfPage(segments, pages[1]).map((s) => s.text).join('')
    expect(secondPageText.trimStart().startsWith('Third')).toBe(true)
  })

  /**
   * 경계는 문장 시작에 두되, 단어 안에 들어가면 단어 앞에서 멈춘다.
   *
   * 전 구간 경계를 세그먼트 끝으로 밀면 문장을 여는 부호(„ ¡ " ¿)가 앞쪽 쪽에
   * 남아 문장이 쪼개진다 — 사용자가 목마료와 ¡ 가 페이지에 걸쳐 나뉘어 있다고
   * 했다. 반대로 텍스트 세그먼트 끝으로 밀면 다음 문장의 첫 단어가 사라진다.
   * 그래서 경계는 문장 시작 그대로 두고, 텍스트만 잘라 보여 준다.
   */
  it('문장을 여는 부호는 그 문장에 남는다 — „ 가 앞쪽 쪽에 홀로 남지 않는다', () => {
    // 회귀: 경계를 세그먼트 끝으로 밀면서 „ 가 'Der Fuchs lachte. „' 로 남았다
    const text = 'Der Fuchs lachte. „Jetzt habe ich ihn", sagt er glücklich. Und die beiden bleiben.'
    // 첫 문장이 정확히 한 쪽 차이 나도록 — 'Der Fuchs lachte.' 가 3단어
    const { pages, segments } = pagesOf('de', text, 3)
    const pageText = pages.map((p) => textOfPage(segments, p).map((s) => s.text).join(''))

    expect(pageText[0].trimEnd()).toBe('Der Fuchs lachte.')
    expect(pageText[1].trimStart().startsWith('„Jetzt')).toBe(true)
    expect(pageText.join('')).toBe(text)
  })

  it('¡ 도 그 문장에 남는다', () => {
    const text = 'Por fin te toqué. ¡Ahora por fin te tocaré!", dijo feliz. Y desde entonces.'
    // 'Por fin te toqué.' 가 4단어
    const { pages, segments } = pagesOf('es', text, 4)
    const pageText = pages.map((p) => textOfPage(segments, p).map((s) => s.text).join(''))

    expect(pageText[0].trimEnd()).toBe('Por fin te toqué.')
    expect(pageText[1].trimStart().startsWith('¡Ahora')).toBe(true)
  })

  it('단어 안에 경계가 들어가면 단어 앞에서 멈춘다', () => {
    const text = 'First one two. Second one two. Third one two. Fourth one two.'
    const { segments, sentences } = tokenize(text, 'en')
    const counts = sentences.map((s) =>
      segments.reduce((n, x) => (x.type === 'word' && x.sentenceIndex === s.index ? n + 1 : n), 0),
    )

    const wordStarts = segments.filter((x) => x.type === 'word').map((x) => x.start)
    const good = planPages(text, sentences, counts, 6, wordStarts)

    const firstWordOf = (pages: DocumentPage[], index: number) =>
      textOfPage(segments, pages[index]).find((x) => x.type === 'word')?.text

    expect(firstWordOf(good, 1)).toBe('Third')
    expect(good.map((p) => textOfPage(segments, p).map((s) => s.text).join('')).join('')).toBe(text)
  })

  it('뒤쪽 쪽의 문자 오프셋이 원문과 일치한다 — 문장 번역이 옆 문장을 잡지 않는다', () => {
    const text = 'First one two. Second one two. Third one two. Fourth one two.'
    const { pages, segments } = pagesOf('en', text, 6)
    const second = pages[1]

    const container = textOfPage(segments, second).map((s) => s.text).join('')

    // 쪽 안에서 몇 번째 글자인지 + 쪽 시작 = 원문 오프셋.
    // 어긋나면 문장 번역이 옆 문장을 잡는다 — 이게 쪽 경계 버그의 두 번째 얼굴이다.
    for (const word of ['Third', 'one', 'Fourth']) {
      expect(second.start + container.indexOf(word)).toBe(text.indexOf(word, second.start - 1))
    }
    // 쪽 본문은 원문 그 구간과 정확히 같다
    expect(container).toBe(text.slice(second.start))
  })
})
