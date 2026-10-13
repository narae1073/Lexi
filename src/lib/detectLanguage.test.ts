import { describe, expect, it } from 'vitest'

import { detectLanguage } from './detectLanguage'

/**
 * 그 언어만의 낱말로 짠 문장들 — 실제 붙여넣을 만한 길이다.
 * 겹치는 낱말(de, que, la …)이 있으므로 이긴 쪽의 증거가 앞서야 한다.
 */
const PARAGRAPHS: Record<string, string> = {
  en: 'The weather is nice today and we went to the park together.',
  es: 'El tiempo es agradable hoy y vamos al parque con la familia.',
  fr: 'Le temps est agréable aujourd’hui et nous allons au parc avec la famille.',
  de: 'Das Wetter ist heute schön und wir gehen in den Park mit dem Hund.',
  pt: 'O tempo está agradável hoje e vamos ao parque com a família.',
}

describe('detectLanguage', () => {
  it('가나가 보이면 일본어다 — 한자가 섞여도', () => {
    expect(detectLanguage('今日はいい天気ですね。散歩に行きましょう。')).toEqual({ language: 'ja' })
  })

  it('한글이 보이면 한국어다 — 한자(漢字)가 섞여도', () => {
    expect(detectLanguage('오늘 날씨가 참 좋네요.산책을 갑시다.')).toEqual({ language: 'ko' })
  })

  it('한자만 있고 가나가 없으면 중국어다', () => {
    expect(detectLanguage('今天天气真好，我们去公园散步吧。')).toEqual({ language: 'zh' })
  })

  it('두 글자의 한자(東京)는 일본어 지명일 수도 있으므로 말하지 않는다', () => {
    expect(detectLanguage('東京タワー')).toEqual({ language: 'ja' }) // 가나가 있다
    expect(detectLanguage('東京都')).toEqual({ language: null }) // 한자뿐, 너무 짧다
  })

  it('라틴 언어는 흔한 낱말이 이기는 쪽을 말한다', () => {
    for (const [code, text] of Object.entries(PARAGRAPHS)) {
      expect(detectLanguage(text), text).toEqual({ language: code })
    }
  })

  it('이긴 쪽이 확실하게 앞서지 않으면 말하지 않는다', () => {
    // es·pt 가 점수를 비슷하게 먹는 문장 — 누가 이기는지 확신할 수 없다
    const ambiguous = 'El tiempo es bom hoje e o dia esta feliz.'
    expect(detectLanguage(ambiguous)).toEqual({ language: null })
  })

  it('반쪽짜리 글로는 말하지 않는다 — 틀린 말이 빈 말보다 나쁘다', () => {
    expect(detectLanguage('Hola')).toEqual({ language: null })
    expect(detectLanguage('The')).toEqual({ language: null })
    expect(detectLanguage('')).toEqual({ language: null })
    expect(detectLanguage('12345 67890 !!!')).toEqual({ language: null })
  })
})
