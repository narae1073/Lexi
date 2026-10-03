import { describe, expect, it } from 'vitest'

import { collectSurfaceUsages, resolveLemmasFromWords, resolveSurfaceLemmas } from './surfaceLemma'

const word = (text: string, sentenceInitial = false) => ({ text, sentenceInitial })

describe('표기 → lemma 매핑', () => {
  it('한 표기만 쓰이면 그대로 정규화한다', () => {
    const m = resolveLemmasFromWords([word('Houses'), word('Houses', true)])
    expect(m.get('Houses')).toBe('houses')
  })

  it('문장 첫머리 전용 대문자는 소문자 표기로 합쳐진다', () => {
    // The 는 첫머리에만 나오고 the 는 중간에도 나온다 → 같은 단어
    const m = resolveLemmasFromWords([word('The', true), word('the'), word('the')])
    expect(m.get('The')).toBe('the')
    expect(m.get('the')).toBe('the')
  })

  it('중간 위치에도 나온 대문자 표기는 다른 단어로 분리한다', () => {
    // US(국가) 와 us(대명사) — 대소문자만 다른 게 아니라 다른 단어다
    const m = resolveLemmasFromWords([word('US'), word('us'), word('US', true)])
    expect(m.get('US')).toBe('US')
    expect(m.get('us')).toBe('us')
  })

  it('US 가 문장 첫머리에만 나오면 소문자로 합쳐진다 (한계 — 문맥 판단 불가)', () => {
    const m = resolveLemmasFromWords([word('Us', true), word('us'), word('us')])
    expect(m.get('Us')).toBe('us')
  })

  it('소유격은 원형과 같은 단어로 본다', () => {
    const m = resolveLemmasFromWords([word("John's"), word('John'), word('John', true)])
    // 소유격 표기는 벗겨내고, 고유명사 대소문자는 유지된다
    expect(m.get("John's")).toBe('John')
    expect(m.get('John')).toBe('John')
  })

  it('문서 안에서 구별이 증명된 고유명사만 대소문자를 유지한다', () => {
    // Apple 과 apple 이 함께 있으면 증명된다
    const both = resolveLemmasFromWords([word('Apple'), word('apple')])
    expect(both.get('Apple')).toBe('Apple')
    expect(both.get('apple')).toBe('apple')
  })

  it('증명이 없으면 접는다 — 문서를 넘나들며 상태가 쪼개지지 않도록', () => {
    const alone = resolveLemmasFromWords([word('Apple'), word('Apple', true)])
    expect(alone.get('Apple')).toBe('apple')
  })

  it('서로 다른 단어면 대소문자를 접지 않는다 (판정이 무의미해지지 않게)', () => {
    const m = resolveLemmasFromWords([word('May'), word('may'), word('May', true)])
    // May 가 중간에도 나온다고 가정하면 별개 단어
    expect(m.get('May')).toBe('May')
    expect(m.get('may')).toBe('may')
  })

  it('소유격은 원형의 대소문자를 따른다', () => {
    const m = resolveLemmasFromWords([word("Apple's"), word('Apple'), word('apple')])
    expect(m.get("Apple's")).toBe('Apple')
  })

  it('빈 입력도 안전하다', () => {
    expect(resolveLemmasFromWords([]).size).toBe(0)
  })
})

describe('collectSurfaceUsages', () => {
  it('표기별 출현 횟수와 첫머리 밖 출현 횟수를 센다', () => {
    const usages = collectSurfaceUsages([
      word('The', true),
      word('The', true),
      word('The'),
      word('the'),
    ])
    const the = usages.find((u) => u.surface === 'The')!
    const lower = usages.find((u) => u.surface === 'the')!
    expect(the).toEqual({ surface: 'The', count: 3, nonInitialCount: 1 })
    expect(lower).toEqual({ surface: 'the', count: 1, nonInitialCount: 1 })
  })
})

describe('resolveSurfaceLemmas 직접 호출', () => {
  it('문장 첫머리 전용 대문자는 소문자 그룹으로 접힌다', () => {
    const m = resolveSurfaceLemmas([
      { surface: 'May', count: 1, nonInitialCount: 0 },
      { surface: 'may', count: 2, nonInitialCount: 2 },
    ])
    expect(new Set([m.get('May'), m.get('may')])).toEqual(new Set(['may']))
  })
})