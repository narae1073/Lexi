import { describe, expect, it } from 'vitest'

import {
  clampUnmarkedDim,
  UNMARKED_DIM_DEFAULT,
  UNMARKED_DIM_MAX,
  UNMARKED_DIM_MIN,
} from '../../app/stores/settings'

describe('clampUnmarkedDim', () => {
  it('범위 안의 값은 그대로 둔다', () => {
    expect(clampUnmarkedDim(0)).toBe(0)
    expect(clampUnmarkedDim(34)).toBe(34)
    expect(clampUnmarkedDim(70)).toBe(70)
  })

  it('범위를 벗어나면 안으로 당긴다', () => {
    expect(clampUnmarkedDim(-20)).toBe(UNMARKED_DIM_MIN)
    expect(clampUnmarkedDim(999)).toBe(UNMARKED_DIM_MAX)
  })

  it('수가 아니면 기본값으로 되돌린다', () => {
    expect(clampUnmarkedDim(Number.NaN)).toBe(UNMARKED_DIM_DEFAULT)
    expect(clampUnmarkedDim(Number.POSITIVE_INFINITY)).toBe(UNMARKED_DIM_DEFAULT)
  })

  it('소수점은 반올림한다 — 슬라이더 값이 어긋나지 않게', () => {
    expect(clampUnmarkedDim(33.4)).toBe(33)
    expect(clampUnmarkedDim(33.6)).toBe(34)
  })
})
