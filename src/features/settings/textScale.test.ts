import { describe, expect, it } from 'vitest'

import {
  clampTextScale,
  TEXT_SCALE_DEFAULT,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
} from '../../app/stores/settings'

describe('clampTextScale', () => {
  it('범위 안의 값은 그대로 둔다', () => {
    expect(clampTextScale(85)).toBe(85)
    expect(clampTextScale(100)).toBe(100)
    expect(clampTextScale(160)).toBe(160)
  })

  it('범위를 벗어나면 안으로 당긴다', () => {
    expect(clampTextScale(10)).toBe(TEXT_SCALE_MIN)
    expect(clampTextScale(400)).toBe(TEXT_SCALE_MAX)
  })

  it('수가 아니면 기본값으로 되돌린다 — 깨진 저장을 스스로 고쳐야 한다', () => {
    expect(clampTextScale(Number.NaN)).toBe(TEXT_SCALE_DEFAULT)
    expect(clampTextScale(Number.NaN)).not.toBe(clampTextScale(0))
  })

  it('슬라이더 눈금 위로 올린다 — 손잡이가 어긋나지 않게', () => {
    for (const raw of [86, 91.4, 133, 157.6]) {
      expect(clampTextScale(raw) % TEXT_SCALE_STEP).toBe(0)
    }
    expect(clampTextScale(91.4)).toBe(90)
    expect(clampTextScale(133)).toBe(135)
  })

  it('눈금에 없는 값이 저장돼 있어도 최소·최대를 넘지 않는다', () => {
    expect(clampTextScale(TEXT_SCALE_MIN - 3)).toBe(TEXT_SCALE_MIN)
    expect(clampTextScale(TEXT_SCALE_MAX + 3)).toBe(TEXT_SCALE_MAX)
  })
})
