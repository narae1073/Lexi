import { describe, expect, it } from 'vitest'

import type { Sentence } from '../../types'
import {
  DEFAULT_READER_PAGE_WORDS,
  isOnPage,
  pageOfSentence,
  pageWordsOrDefault,
  planPages,
  READER_PAGE_WORDS,
} from './pageBreak'

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

/** 문장마다 단어를 counts 개씩 넣는다 */
function withWords(sentences: Sentence[], counts: number[]): number[] {
  return sentences.map((_, i) => counts[i] ?? 0)
}

const TEXT = 'One two three. Four five six. Seven eight nine. Ten eleven twelve.'
const SENTENCES = sentencesOf(TEXT) // 4 문장, 문장마다 3 단어

describe('planPages', () => {
  it('지정한 단어 수에 맞춰 문장 경계에서 자른다', () => {
    const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 6)
    expect(pages).toHaveLength(2)
    expect(pages[0].wordCount).toBe(6)
    expect(pages[1].wordCount).toBe(6)
    expect(pages[0].sentenceTo).toBe(2)
    expect(pages[1].sentenceFrom).toBe(2)
  })

  it('쪽들의 문자 범위가 원문 전체를 빈틈없이 덮는다', () => {
    const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 4)
    expect(pages[0].start).toBe(0)
    expect(pages.at(-1)!.end).toBe(TEXT.length)
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i].start).toBe(pages[i - 1].end)
    }
  })

  it('중간에서 끊기지 않는다 — 각 쪽은 문장 경계에서 시작하고 끝난다', () => {
    const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 4)
    for (const page of pages) {
      const startsAtSentence = SENTENCES.some((s) => s.start === page.start)
      const endsAtSentence = page.end === TEXT.length || SENTENCES.some((s) => s.end === page.end)
      expect(startsAtSentence).toBe(true)
      expect(endsAtSentence).toBe(true)
    }
  })

  it('몇 단어인지와 상관없이 모든 문장이 정확히 한 쪽에 있다', () => {
    for (const size of [1, 2, 3, 4, 5, 7, 12, 100]) {
      const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), size)
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
    const pages = planPages(text, sentences, withWords(sentences, [1, 99]), 10)
    expect(pages[0].wordCount).toBe(1)
    expect(pages[1].sentenceFrom).toBe(1)
    expect(pages[1].wordCount).toBe(99)
    // 겉돌다가 문장을 잃어서는 안 된다
    const seen = pages.flatMap((p) => Array.from({ length: p.sentenceTo - p.sentenceFrom }, (_, i) => p.sentenceFrom + i))
    expect(seen).toEqual(sentences.map((x) => x.index))
  })

  it('문장이 하나뿐이면 한 쪽이다', () => {
    const pages = planPages(TEXT, SENTENCES.slice(0, 1), withWords(SENTENCES.slice(0, 1), [3]), 1)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ start: 0, end: TEXT.length, sentenceFrom: 0, sentenceTo: 1 })
  })

  it('문장이 하나도 없으면 빈 본문을 한 쪽으로 본다', () => {
    const blank = '   \n  '
    const pages = planPages(blank, [], [], 10)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ start: 0, end: blank.length, wordCount: 0 })
  })

  it('첫 문장 앞의 글자는 첫 쪽에, 마지막 뒤의 글자는 마지막 쪽에 붙는다', () => {
    const text = '\n\n  Leading. Trailing.\n\n'
    const sentences = sentencesOf(text)
    const pages = planPages(text, sentences, withWords(sentences, [1, 1]), 1)
    expect(pages[0].start).toBe(0)
    expect(pages.at(-1)!.end).toBe(text.length)
  })

  it('쪽 수가 0 이거나 음수여도 한 쪽 이상은 나온다', () => {
    expect(planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 0).length).toBeGreaterThanOrEqual(1)
    expect(planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), -5).length).toBeGreaterThanOrEqual(1)
  })

  it('각 쪽의 단어 순번이 이어진다 — 10–20 쪽, 21–40 쪽 이처럼', () => {
    const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 6)
    expect(pages.map((p) => [p.from, p.to])).toEqual([
      [1, 6],
      [7, 12],
    ])
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i].from).toBe(pages[i - 1].to + 1)
    }
  })

  it('쪽 번호가 순서대로 매겨진다', () => {
    const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 3)
    expect(pages.map((p) => p.index)).toEqual(pages.map((_, i) => i))
  })
})

describe('isOnPage', () => {
  const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 6)

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
  const pages = planPages(TEXT, SENTENCES, withWords(SENTENCES, [3, 3, 3, 3]), 6)

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
