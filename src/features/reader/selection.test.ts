import { describe, expect, it } from 'vitest'

import { sentenceAt, sentencesInRange, joinSentences } from './selection'
import { computeSentences, isSentenceInitial, tokenize } from './tokenizer'

const TEXT = 'First one. Second one! Third one? Tail without end'
const sentences = computeSentences(TEXT)

describe('문장 경계와 오프셋', () => {
  it('문장 수와 경계를 정확히 낸다', () => {
    expect(sentences.map((s) => s.text.trim())).toEqual([
      'First one.',
      'Second one!',
      'Third one?',
      'Tail without end',
    ])
  })

  it('문장 오프셋이 원문과 맞는다', () => {
    for (const s of sentences) {
      expect(TEXT.slice(s.start, s.end)).toBe(s.text)
    }
  })

  it('오프셋으로 문장을 찾는다', () => {
    expect(sentenceAt(sentences, 0)?.index).toBe(0)
    expect(sentenceAt(sentences, 11)?.index).toBe(1)
    expect(sentenceAt(sentences, TEXT.length - 1)?.index).toBe(3)
  })
})

describe('드래그 선택 → 문장', () => {
  it('문장 중간에서 시작한 선택도 그 문장 전체로 넓힌다', () => {
    const start = TEXT.indexOf('one', 0) + 1 // "First o|ne."
    expect(sentencesInRange(sentences, { start, end: start + 2 })).toEqual([0])
  })

  it('여러 문장에 걸친 선택은 그 문장들을 모두 담는다', () => {
    const start = TEXT.indexOf('First')
    const end = TEXT.indexOf('Third') + 3
    expect(sentencesInRange(sentences, { start, end })).toEqual([0, 1, 2])
  })

  it('문장을 잇는 원문을 그대로 복원한다', () => {
    const start = TEXT.indexOf('Second')
    const end = TEXT.indexOf('Third') + 3
    expect(joinSentences(sentences, { start, end }).trim()).toBe('Second one! Third one?')
  })

  it('문장과 겹치지 않는 구간은 빈 결과다', () => {
    expect(sentencesInRange(sentences, { start: 9999, end: 10000 })).toEqual([])
    expect(joinSentences(sentences, { start: 9999, end: 10000 })).toBe('')
  })

  it('CJK 문장도 같은 규칙으로 동작한다', () => {
    const cjk = 'これはペンです。次の文です。'
    const list = computeSentences(cjk)
    expect(list).toHaveLength(2)
    expect(joinSentences(list, { start: 0, end: cjk.length }).trim()).toBe(cjk)
  })
})
describe('문장 인덱스 연속성 (빈 줄 뒤 조회가 어긋나지 않게)', () => {
  it('빈 줄이 있어도 index 가 배열 위치와 일치한다', () => {
    const text = 'One two.\n\nThree four.\n\nFive.'
    const sentences = computeSentences(text)
    sentences.forEach((sentence, position) => {
      expect(sentence.index).toBe(position)
      expect(sentences[sentence.index]).toBe(sentence)
    })
  })

  it('모든 단어가 실제 문장 텍스트로 연결된다', () => {
    // 회귀 사례: 빈 줄이 있으면 sentences[word.sentenceIndex] 가 undefined 가 됐다
    const text = 'The US grew. The us differs.\nMay is warm. I may go.'
    const { segments, sentences } = tokenize(text, 'en')
    const words = segments.filter((s) => s.type === 'word')
    for (const word of words) {
      if (word.type !== 'word') continue
      const sentence = sentences[word.sentenceIndex]
      expect(sentence, `${word.text} 의 문장을 찾지 못함`).toBeDefined()
      expect(sentence.text.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('isSentenceInitial', () => {
  it('문장 첫 단어를 recognizes 한다 (앞 공백이 있어도)', () => {
    const text = 'One two. Three four.'
    const { segments, sentences } = tokenize(text, 'en')
    const words = segments.filter((s) => s.type === 'word')
    const initial = words.filter((w) => w.type === 'word' && isSentenceInitial(text, sentences, w.start, w.sentenceIndex))
    expect(initial.map((w) => (w.type === 'word' ? w.text : ''))).toEqual(['One', 'Three'])
  })

  it('문장 중간 단어는 첫 단어가 아니다', () => {
    const text = 'One two. Three four.'
    const { segments, sentences } = tokenize(text, 'en')
    const two = segments.find((s) => s.type === 'word' && s.text === 'two')
    if (two?.type !== 'word') throw new Error('없음')
    expect(isSentenceInitial(text, sentences, two.start, two.sentenceIndex)).toBe(false)
  })
})
