import { describe, expect, it } from 'vitest'

import {
  clampStarSize,
  sanitizeStarColor,
  STAR_COLOR_DEFAULT,
  STAR_SIZE_DEFAULT,
  STAR_SIZE_MAX,
  STAR_SIZE_MIN,
  STAR_SIZE_STEP,
} from '../../app/stores/settings'

describe('clampStarSize', () => {
  it('범위 안의 값은 그대로 둔다', () => {
    expect(clampStarSize(40)).toBe(40)
    expect(clampStarSize(65)).toBe(65)
    expect(clampStarSize(120)).toBe(120)
  })

  it('범위를 벗어나면 안으로 당긴다', () => {
    expect(clampStarSize(1)).toBe(STAR_SIZE_MIN)
    expect(clampStarSize(400)).toBe(STAR_SIZE_MAX)
  })

  it('수가 아니면 기본값으로 되돌린다', () => {
    expect(clampStarSize(Number.NaN)).toBe(STAR_SIZE_DEFAULT)
  })

  it('슬라이더 눈금 위로 올린다', () => {
    for (const raw of [41, 63, 118]) {
      expect(clampStarSize(raw) % STAR_SIZE_STEP).toBe(0)
    }
  })
})

describe('sanitizeStarColor', () => {
  it('여섯 자리 hex 는 그대로 둔다', () => {
    expect(sanitizeStarColor('#eab308')).toBe('#eab308')
  })

  it('세 자리는 여섯 자리로 편다', () => {
    expect(sanitizeStarColor('#fb0')).toBe('#ffbb00')
  })

  it('이상한 값은 기본값으로 되돌린다 — 깨진 저장을 스스로 고쳐야 한다', () => {
    expect(sanitizeStarColor('red')).toBe(STAR_COLOR_DEFAULT)
    expect(sanitizeStarColor('#gggggg')).toBe(STAR_COLOR_DEFAULT)
    expect(sanitizeStarColor(null)).toBe(STAR_COLOR_DEFAULT)
    expect(sanitizeStarColor(undefined)).toBe(STAR_COLOR_DEFAULT)
  })
})
