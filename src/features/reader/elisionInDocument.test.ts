import { describe, expect, it } from 'vitest'

import { resolveLemmasFromWords } from './surfaceLemma'
import { normalizeLemma, tokenize } from './tokenizer'

/**
 * 문서에서 실제로 쓰인 표기 → 대표 lemma 를 그대로 뽑는다.
 *
 * 문장 첫머리 여부를 제대로 계산해야 한다 — false 를 하드코딩하면 대문자 표기가
 * 전부 '문장 중간에도 나온 대문자' 로 판정되어 US/us 규칙이 끼어든다.
 */
const lemmasOf = (text: string, languageCode: 'fr' | 'en' = 'fr') => {
  const { segments } = tokenize(text, languageCode)
  const seenInSentence = new Set<number>()
  const words = segments
    .filter((s) => s.type === 'word')
    .map((s) => {
      const sentenceInitial = !seenInSentence.has(s.sentenceIndex)
      seenInSentence.add(s.sentenceIndex)
      return { text: s.text, sentenceInitial }
    })

  const mapping = resolveLemmasFromWords(words, languageCode)
  return new Map(words.map((w) => [w.text, mapping.get(w.text)]))
}

/**
 * 프랑스어 축약이 실제 문서에서 어떻게 잡히는가.
 *
 * 표기는 그대로 두고 대표 단어만 접어야 한다 — 배우는 사람은 d'a prints 는 d'été 를
 * 보아야 하고, 사전에는 été 를 물어야 한다.
 */
describe('프랑스어 문서에서 축약', () => {
  it("d'été 는 été 로 인식된다", () => {
    const map = lemmasOf("J'aime d'été et l'eau.")
    expect(map.get("d'été")).toBe('été')
    expect(map.get("l'eau")).toBe('eau')
  })

  it('축약이 아니면 그대로 둔다', () => {
    const map = lemmasOf('le chat dort et la maison est grande.')
    expect(map.get('chat')).toBe('chat')
    expect(map.get('dort')).toBe('dort')
    expect(map.get('grande')).toBe('grande')
  })

  /**
   * 같은 문서에 둘이 있으면 한 단어로 세어야 한다.
   *
   * 따로 세면 "ete" 를 두 번 배우게 되고, 같은 단어를 표시해도 다른 쪽은 그대로다.
   */
  it('축약형과 원형을 한 단어로 본다', () => {
    const map = lemmasOf("L'été est chaud et d'été arrive.")
    expect(map.get("L'été")).toBe(map.get("d'été"))
  })

  /**
   * 고유명사는 접지 않는다 — 이름이 망가지면 안 된다.
   *
   * 소문자로 내려간 결과는 이 앱이 원래 하던 일이다 (문장 첫머리 대문자). 중요한 것은
   * 아포스트로피 앞의 조사가 이름에 붙어 남는다는 것이다 — Artagnan 으로 접으면
   * 사람 이름이 훼손된다.
   */
  it('고유명사는 접지 않는다', () => {
    const map = lemmasOf("D'Artagnan est arrivé.")
    expect(map.get("D'Artagnan")).toBe("d'artagnan")
  })


  it('문장 첫머리여도 접는다 — 첫머리 대문자는 철자 규칙일 뿐이다', () => {
    const map = lemmasOf("D'abord, l'école commence.")
    // 정규화는 먼저 소문자로 내린다
    expect(map.get("D'abord")).toBe('abord')
    expect(map.get("l'école")).toBe('école')
  })

  it('토큰은 하나다 — 화면에는 원래 쓴 모습이 보인다', () => {
    const { segments } = tokenize("J'aime d'été.", 'fr')
    const words = segments.filter((s) => s.type === 'word').map((s) => s.text)
    expect(words).toContain("d'été")
    expect(words).not.toContain("d'")
  })

  it('프랑스어가 아닌 언어는 손대지 않는다', () => {
    // 영어 d' 는 축약이 아니다 — 그대로 둔다
    expect(normalizeLemma("don't", 'en')).toBe("don't")
  })
})