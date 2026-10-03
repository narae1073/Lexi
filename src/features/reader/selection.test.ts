import { describe, expect, it } from 'vitest'

import { sentenceAt, sentencesInRange, joinSentences } from './selection'
import { computeSentences } from './tokenizer'

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