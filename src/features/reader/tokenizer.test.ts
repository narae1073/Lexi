import { describe, expect, it } from 'vitest'

import { normalizeLemma, segmentAt, tokenize } from './tokenizer'

const words = (lang: string, text: string) =>
  tokenize(text, lang)
    .segments.filter((s) => s.type === 'word')
    .map((s) => s.text)

describe('단어 분절 — 영어', () => {
  it('공백·구두점을 단어에서 제외한다', () => {
    expect(words('en', 'Hello, world!')).toEqual(['Hello', 'world'])
  })

  it('어절 내부의 아포스트로피와 하이픈을 유지한다', () => {
    expect(words('en', "Don't stop; it's well-known.")).toEqual([
      "Don't",
      'stop',
      "it's",
      'well-known',
    ])
  })

  it('하이픈 뒤가 대문자면 고유명사로 끊는다', () => {
    expect(words('en', 'Jean-Luc Picard')).toEqual(['Jean', 'Luc', 'Picard'])
  })

  it('하이픈 뒤가 소문자면 한 어절로 붙인다', () => {
    expect(words('en', 'a well-known fact')).toEqual(['a', 'well-known', 'fact'])
  })

  it('문자와 숫자를 함께 다룬다', () => {
    expect(words('en', 'COVID-19 hit in 2020')).toEqual(['COVID-19', 'hit', 'in', '2020'])
  })

  it('세그먼트가 원문 전체를 빈틈없이 덮는다', () => {
    const text = 'Hello, world!  Don’t stop.'
    const { segments } = tokenize(text, 'en')
    expect(segments.map((s) => s.text).join('')).toBe(text)
    expect(segments.at(0)?.start).toBe(0)
    expect(segments.at(-1)?.end).toBe(text.length)
  })
})

describe('문장 분절', () => {
  it('종결어 뒤에서 끊고 닫는 기호는 문장에 포함한다', () => {
    const { sentences } = tokenize('He said "stop." Then he left.', 'en')
    expect(sentences).toHaveLength(2)
    expect(sentences[0].text).toBe('He said "stop."')
    expect(sentences[1].text).toBe(' Then he left.')
  })

  it('소수점과 약어를 문장 경계로 오인하지 않는다', () => {
    const { sentences } = tokenize('Pi is 3.14 and Dr. Smith agrees.', 'en')
    expect(sentences).toHaveLength(1)
  })

  it('CJK 종결어(。！？)를 인식한다', () => {
    const { sentences } = tokenize('これはペンです。次の文もあります。', 'ja')
    expect(sentences).toHaveLength(2)
    expect(sentences[0].text).toBe('これはペンです。')
    expect(sentences[1].text).toBe('次の文もあります。')
  })

  it('빈 줄도 문장을 나눈다', () => {
    const { sentences } = tokenize('One two.\n\nThree four.', 'en')
    expect(sentences).toHaveLength(2)
  })

  it('빈 텍스트에서 예외 없이 빈 배열을 낸다', () => {
    expect(tokenize('', 'en')).toEqual({ segments: [], sentences: [] })
    expect(tokenize('   \n  ', 'en').segments.every((s) => s.type === 'text')).toBe(true)
  })
})

describe('분절 — 비공백 언어', () => {
  it('일본어를 단어 단위로 나눈다', () => {
    const tokens = words('ja', '私は猫が好きです')
    expect(tokens.length).toBeGreaterThan(1)
    expect(tokens.join('')).toBe('私は猫が好きです')
  })

  it('한국어는 어절(공백) 단위로 나눈다', () => {
    expect(words('ko', '한국어 공부하기')).toEqual(['한국어', '공부하기'])
  })
})

describe('원형 정규화', () => {
  it('소문자로 접는다', () => {
    expect(normalizeLemma('Ubiquitous')).toBe('ubiquitous')
  })

  it('소유격을 제거한다', () => {
    expect(normalizeLemma("John's")).toBe('john')
  })

  it('축약형 it’s 는 접히지 않는다', () => {
    expect(normalizeLemma("it's")).toBe("it's")
  })

  it('v1 정책대로 복수형은 접지 않는다 (사전 연동 전 보류)', () => {
    expect(normalizeLemma('books')).toBe('books')
  })
})

describe('오프셋 탐색', () => {
  const text = 'Alpha beta gamma'
  const { segments } = tokenize(text, 'en')

  it('단어 안에 있는 오프셋은 그 단어를 찾는다', () => {
    expect(segmentAt(segments, 8)).toMatchObject({ type: 'word', text: 'beta' })
  })

  it('공백 오프셋은 단어를 찾지 않는다', () => {
    expect(segmentAt(segments, 5)).toBeUndefined()
  })

  it('문자열 재조립 결과가 원문과 동일하다', () => {
    expect(segments.map((s) => s.text).join('')).toBe(text)
  })
})