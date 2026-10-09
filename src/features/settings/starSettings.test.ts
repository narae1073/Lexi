import { describe, expect, it } from 'vitest'

import {
  clampStarSize,
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

  it('눈금에 없는 값이 저장돼 있어도 최소·최대를 넘지 않는다', () => {
    expect(clampStarSize(STAR_SIZE_MIN - 3)).toBe(STAR_SIZE_MIN)
    expect(clampStarSize(STAR_SIZE_MAX + 3)).toBe(STAR_SIZE_MAX)
  })
})
