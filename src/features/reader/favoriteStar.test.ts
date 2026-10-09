import { describe, expect, it } from 'vitest'

import { randomStarAngle, randomStarColor, STAR_COLORS } from './favoriteStar'

describe('randomStarAngle', () => {
  /** 렌더할 때마다 뽑으면 별이 덜덜 떨린다 — 뽑는のは 붙일 때·바꿀 때뿐이다 */
  it('±25도 안에 든다', () => {
    for (let i = 0; i < 200; i++) {
      const tilt = randomStarAngle()
      expect(tilt).toBeGreaterThanOrEqual(-25)
      expect(tilt).toBeLessThanOrEqual(25)
      expect(Number.isInteger(tilt)).toBe(true)
    }
  })

  it('여러 번 뽑으면 다르게 나온다 — 같은 단어도 매번 다른 별이다', () => {
    const tilts = new Set(Array.from({ length: 30 }, () => randomStarAngle()))
    expect(tilts.size).toBeGreaterThan(1)
  })
})

describe('randomStarColor', () => {
  it('스티커 팔레트 안에서 뽑는다', () => {
    for (let i = 0; i < 50; i++) {
      expect(STAR_COLORS).toContain(randomStarColor())
    }
  })

  /** 눌렀는데 같은 색이 나오면 버튼이 고장 난 것처럼 보인다 */
  it('지금 색은 빼고 뽑는다', () => {
    for (const color of STAR_COLORS) {
      for (let i = 0; i < 20; i++) {
        expect(randomStarColor(color)).not.toBe(color)
      }
    }
  })
})
