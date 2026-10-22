import { describe, expect, it } from 'vitest'

import { appearsInSentence, buildChoices, pickDistractors, type QuizChoice } from './quizChoices'

const entry = (
  lemma: string,
  status: 'known' | 'unsure' | 'unknown' | 'unmarked' = 'unmarked',
  surfaces: string[] = [lemma],
) => ({ lemma, status, surfaces })

const choice = (lemma: string): QuizChoice => ({ lemma, label: lemma })

/** 재현 가능한 난수 — 같은 씨앗이면 같은 순서가 나온다 */
function mulberry(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('문장에 나오는 표기인가', () => {
  it('낱말로 나오면 참이다', () => {
    expect(appearsInSentence('The cat sat on the mat.', 'cat')).toBe(true)
    expect(appearsInSentence('The cat sat on the mat.', 'mat')).toBe(true)
  })

  it('다른 낱말의 일부면 거짓이다', () => {
    expect(appearsInSentence('The cat sat on the mat.', 'at')).toBe(false)
  })

  it('대소문자를 가리지 않는다', () => {
    expect(appearsInSentence('The Cat sat.', 'cat')).toBe(true)
  })

  it('띄어쓰기가 없는 언어는 그대로 찾는다', () => {
    expect(appearsInSentence('私は猫が好きです。', '猫')).toBe(true)
    expect(appearsInSentence('私は猫が好きです。', '犬')).toBe(false)
  })
})

describe('오답 후보 고르기', () => {
  const entries = [
    entry('cat', 'known'),
    entry('dog', 'unsure'),
    entry('run', 'unknown'),
    entry('mat', 'unmarked'),
    entry('bird', 'unmarked'),
  ]
  const sentence = 'The cat sat on the mat.'

  it('정답 단어는 뺀다', () => {
    const picked = pickDistractors(entries, 'cat', sentence, { count: 8, rng: mulberry(1) })
    expect(picked.map((c) => c.lemma)).not.toContain('cat')
  })

  it('문장에 이미 나온 단어는 뺀다', () => {
    const picked = pickDistractors(entries, 'cat', sentence, { count: 8, rng: mulberry(1) })
    expect(picked.map((c) => c.lemma)).not.toContain('mat')
  })

  it('이번 세션 단어를 먼저 쓴다', () => {
    const picked = pickDistractors(entries, 'cat', sentence, {
      count: 2,
      sessionLemmas: new Set(['bird']),
      rng: mulberry(2),
    })
    expect(picked[0]?.lemma).toBe('bird')
  })

  it('표시한 단어를 미표시 단어보다 먼저 쓴다', () => {
    const picked = pickDistractors(entries, 'cat', sentence, { count: 2, rng: mulberry(3) })
    expect(picked.map((c) => c.lemma).sort()).toEqual(['dog', 'run'])
  })

  it('같은 표기는 하나만 담는다 — 대소문자 무시', () => {
    const picked = pickDistractors(
      [entry('US', 'unsure'), entry('us', 'unsure')],
      'cat',
      'A sentence.',
      { count: 2, rng: mulberry(4) },
    )
    expect(picked).toHaveLength(1)
  })

  it('가진 것보다 많이 요청하면 가진 만큼만 준다', () => {
    const picked = pickDistractors([entry('dog')], 'cat', 'A sentence.', {
      count: 5,
      rng: mulberry(5),
    })
    expect(picked).toHaveLength(1)
  })

  it('원래 목록을 건드리지 않는다', () => {
    const before = entries.map((e) => e.lemma)
    pickDistractors(entries, 'cat', sentence, { count: 2, rng: mulberry(6) })
    expect(entries.map((e) => e.lemma)).toEqual(before)
  })
})

describe('선택지 만들기', () => {
  const correct: QuizChoice = { lemma: 'cat', label: 'cat' }

  it('정답 + 오답 두 개를 만든다', () => {
    const choices = buildChoices(correct, [choice('dog'), choice('run')], 2, mulberry(1))
    expect(choices).toHaveLength(3)
    expect(choices?.map((c) => c.lemma).sort()).toEqual(['cat', 'dog', 'run'])
  })

  it('오답이 모자라면 만들지 않는다 — 세 단추로 되돌아간다', () => {
    expect(buildChoices(correct, [choice('dog')], 2)).toBeNull()
    expect(buildChoices(correct, [], 2)).toBeNull()
  })

  it('정답과 같은 표기는 오답으로 쓰지 않는다', () => {
    const choices = buildChoices(
      correct,
      [{ lemma: 'Cat', label: 'Cat' }, choice('dog'), choice('run')],
      2,
      mulberry(2),
    )
    expect(choices?.map((c) => c.lemma).sort()).toEqual(['cat', 'dog', 'run'])
  })

  it('정답은 항상 들어 있다', () => {
    const choices = buildChoices(correct, [choice('dog'), choice('run')], 2, mulberry(3))
    expect(choices?.some((c) => c.lemma === 'cat')).toBe(true)
  })
})
