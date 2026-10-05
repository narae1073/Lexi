import { describe, expect, it } from 'vitest'

import { resolveLemmasFromWords } from './surfaceLemma'
import { isCapitalisedPosition, tokenize } from './tokenizer'

/** 문서에서 실제로 쓰인 표기 → 대표 lemma 를 뽑는다 */
const lemmasOf = (text: string, languageCode: 'fr' | 'en' = 'fr') => {
  const { segments, sentences } = tokenize(text, languageCode)
  const words = segments
    .filter((s) => s.type === 'word')
    .map((s) => ({
      text: s.text,
      sentenceInitial: isCapitalisedPosition(text, sentences, s.start, s.sentenceIndex),
    }))
  const mapping = resolveLemmasFromWords(words, languageCode)
  return new Map(words.map((w) => [w.text, mapping.get(w.text)]))
}

/**
 * 문장 첫 단어의 대문자와 고유명사를 어떻게 가르냐.
 *
 * 눈에 보이는 차이는 하나뿐이다 — 위치다. 첫머리 대문자는 **위치에서** 오고,
 * 고유명사 대문자는 **어디서나** 온다. 그래서 문서 안에서 대문자가 어디에 나오느냐가
 * 유일한 신호로 남는다.
 */
describe('문장 첫 단어의 대문자와 고유명사', () => {
  it('Pour 와 pour 는 한 단어다 — 첫머리 대문자는 철자 규칙일 뿐', () => {
    const map = lemmasOf('Pour comprendre. Je veux pour comprendre.')
    expect(map.get('Pour')).toBe('pour')
    expect(map.get('pour')).toBe('pour')
  })

  it('소문자 표기가 전혀 없어도 접는다 — 쪼개는 것보다 낫다', () => {
    const map = lemmasOf('Pour comprendre. Pour comprendre.')
    expect(map.get('Pour')).toBe('pour')
  })

  /**
   * 위치에서 온 대문자는 첫머리만 아니다.
   *
   * 문장 안에서도 대문자를 강제하는 문자가 있다 — 콜론, 세미콜론, 여는 괄호,
   * 여는 따옴표, 대시. 이 `Pour` 는 첫 단어도 고유명사도 아니다.
   * 이걸 문장 중간으로 세면 `Pour` 와 `pour` 가 갈라지고 같은 말이 두 단어가 된다.
   */
  it('콜론 뒤의 대문자는 위치에서 온 것이다', () => {
    const map = lemmasOf('Voici : Pour comprendre. Je veux pour comprendre.')
    expect(map.get('Pour')).toBe(map.get('pour'))
  })

  it('여는 따옴표 뒤도 같다', () => {
    const map = lemmasOf('« Pour comprendre » dit-il. Je veux pour comprendre.')
    expect(map.get('Pour')).toBe(map.get('pour'))
  })

  it('여는 괄호 뒤도 같다', () => {
    const map = lemmasOf('(Pour comprendre) Je veux pour comprendre.')
    expect(map.get('Pour')).toBe(map.get('pour'))
  })

  it('대시 뒤도 같다', () => {
    const map = lemmasOf('A – Pour comprendre. Je veux pour comprendre.')
    expect(map.get('Pour')).toBe(map.get('pour'))
  })

  /**
   * 고유명사는 어디서든 대문자이므로 분리된다.
   *
   * `Paris` 가 문장 중간에도 나온다 — 위치에서 온 대문자가 아니라는 증거다.
   */
  it('고유명사는 분리된다', () => {
    const map = lemmasOf('Paris est belle. Je vais à Paris.')
    expect(map.get('Paris')).toBe('Paris')
  })

  it('US 와 us 도 분리된다 — 위치 신호가 그대로 살아 있다', () => {
    // US 가 문장 중간에도 나오는 것이 증거다 — 첫머리 대문자만이라면 pour 처럼 접힌다
    const map = lemmasOf('US and us differ. The US economy grew.', 'en')
    expect(map.get('US')).toBe('US')
    expect(map.get('us')).toBe('us')
  })

  /** 이 넓히기로 US/us 가 갈라지지 않아야 한다 — 여기가 위험하다 */
  it('콜론 뒤 US 라도 us 와 합치지 않는다 — 문장 중간 출현이 증거다', () => {
    const map = lemmasOf('The US: it grew. Tell us about the US.', 'en')
    expect(map.get('US')).toBe('US')
  })

  /**
   * 남는 모호함 — 문서 판단으로는 불가능하다.
   *
   * 문장 한가운데에서 대문자로만 쓰인 단어는 고유명사로 본다. 저자가 대문자를
   * 습관적으로 남긴 것인지 고유명사인지 구하려면 사전 조회가 필요한데, 화면을 그릴
   * 때마다 네트워크를 호출할 수는 없다. 이 앱은 '쪼개서 세는 것보다 합치는 편이
   * 낫다' 는 쪽으로 기른다 — 진짜 고유명사만 쪼개진다.
   */
  it('문장 한가운데의 대문자는 고유명사로 본다 — 남는 모호함', () => {
    const map = lemmasOf('il dit Pour comprendre. je veux pour comprendre.')
    expect(map.get('Pour')).toBe('Pour')
  })
})

describe('대문자를 유발하는 위치 판정', () => {
  const positionOf = (text: string, surface: string, languageCode: 'fr' | 'en' = 'fr') => {
    const { segments, sentences } = tokenize(text, languageCode)
    const word = segments.find((s) => s.type === 'word' && s.text === surface)
    if (word?.type !== 'word') throw new Error(`단어를 찾지 못함: ${surface}`)
    return isCapitalisedPosition(text, sentences, word.start, word.sentenceIndex)
  }

  it('문장 첫 단어', () => {
    expect(positionOf('Un deux. Trois quatre.', 'Un')).toBe(true)
  })

  it('문장 한가운데', () => {
    expect(positionOf('Un deux. Trois quatre.', 'deux')).toBe(false)
  })

  it('콜론 뒤', () => {
    expect(positionOf('Voici : Pour.', 'Pour')).toBe(true)
  })

  it('여는 따옴표 뒤', () => {
    expect(positionOf('« Pour. »', 'Pour')).toBe(true)
  })

  it('여는 괄호 뒤', () => {
    expect(positionOf('(Pour. )', 'Pour')).toBe(true)
  })

  /**
   * 닫는 괄호 뒤는 첫머리로 세지 않는다 — 남는 한계다.
   *
   * '(앞에서 본 대로) Pour …' 처럼 문장이 괄호 뒤에서 사실상 다시 시작하는데,
   * 문장 경계는 마침표에서만 세므로 놓친다. 보수적으로 '고유명사일 수 있다' 고 두어
   * 분리한다 — 쪼개는 쪽이 더 위험하지 않으므로.
   */
  it('닫는 괄호 뒤는 세지 않는다 — 남는 한계', () => {
    expect(positionOf('(a) Pour.', 'Pour')).toBe(false)
  })

  it('문장 끝 단어 뒤에 붙은 것은 첫 단어가 아니다', () => {
    expect(positionOf('un deux trois', 'trois')).toBe(false)
  })
})