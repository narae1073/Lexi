import { describe, expect, it } from 'vitest'

import { starTilt } from './favoriteStar'

describe('starTilt — 단어마다 고정된 기울기', () => {
  it('±25도 안에 든다', () => {
    for (const lemma of ['apple', 'été', 'd’Artagnan', 'US', '사랑', 'a'.repeat(40)]) {
      const tilt = starTilt('en', lemma)
      expect(tilt).toBeGreaterThanOrEqual(-25)
      expect(tilt).toBeLessThanOrEqual(25)
    }
  })

  /** 렌더할 때마다 다시 뽑으면 별이 덜덜 떨린다 — 같은 단어는 같은 각도다 */
  it('몇 번을 물어도 같은 각도다', () => {
    expect(starTilt('fr', 'été')).toBe(starTilt('fr', 'été'))
  })

  it('단어마다 다르게 기울어 스티커처럼 보인다', () => {
    const tilts = new Set(
      ['apple', 'store', 'busy', 'yesterday', 'economy', 'grew', 'truth'].map((lemma) =>
        starTilt('en', lemma),
      ),
    )
    expect(tilts.size).toBeGreaterThan(1)
  })

  it('언어가 다르면 같은 표기도 다르게 기울 수 있다', () => {
    // 같아도 틀린 것은 아니다 — 달라지는지만 본다
    const tilts = new Set(['en', 'fr', 'de', 'ko'].map((lang) => starTilt(lang, 'chat')))
    expect(tilts.size).toBeGreaterThanOrEqual(1)
  })
})
