import { describe, expect, it } from 'vitest'

import { computePopoverPosition } from './position'

const VIEWPORT = { width: 390, height: 844 }

/** DOMRect 없이 좌표만 만든다 — 계산은 top·bottom·left·width 만 본다 */
const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect

/** 화면 아래쪽에 있는 단어 — 위로는 공간이 넉넉하고 아래는 좁다 */
const LOW_ANCHOR = rect(20, 700, 60, 20)

describe('팝오버 자리', () => {
  it('위로도 아래로도 들어가면 아래를 고른다 — 손이 있는 쪽이 자연스럽다', () => {
    const pos = computePopoverPosition(rect(20, 300, 60, 20), { width: 300, height: 100 }, VIEWPORT)
    expect(pos.placement).toBe('bottom')
  })

  /**
   * 사전이 오기 전에는 한 줄짜리 로딩 상태로 자리를 정한다.
   *
   * 로딩 높이로는 아래에 들어가니 아래로 열리고, 사전이 차면서 아래로 늘어나 화면을
   * 넘긴다. 높이가 커진 뒤의 자리를 다시 재야 한다.
   */
  it('아래가 좁으면 위로 연다', () => {
    const pos = computePopoverPosition(LOW_ANCHOR, { width: 300, height: 420 }, VIEWPORT)
    expect(pos.placement).toBe('top')
  })

  it('로딩 높이로는 아래로 열리고, 내용이 차면 뒤집힌다', () => {
    const loading = computePopoverPosition(LOW_ANCHOR, { width: 300, height: 24 }, VIEWPORT)
    const loaded = computePopoverPosition(LOW_ANCHOR, { width: 300, height: 420 }, VIEWPORT)
    expect(loading.placement).toBe('bottom')
    expect(loaded.placement).toBe('top')
  })

  /**
   * 양쪽 모두 모자라면 여백이 더 있는 쪽을 고른다.
   *
   * 어느 쪽으로도 다 못 들어가면 고르는 의미가 적다 — 더 많은 쪽을 고르고,
   * 화면 안에 들어오도록 위치를 밀어 넣는다.
   */
  it('양쪽 모두 모자라면 여백이 넓은 쪽을 고르고 화면 안에 넣는다', () => {
    // 위 284px, 아래 508px 뿐이고 높이 600px 인 경우
    const anchor = rect(20, 300, 60, 20)
    const pos = computePopoverPosition(anchor, { width: 300, height: 600 }, VIEWPORT)
    expect(pos.placement).toBe('bottom')
    expect(pos.top).toBeGreaterThanOrEqual(8)
    expect(pos.top + 600).toBeLessThanOrEqual(VIEWPORT.height - 8 + 1)
  })

  it('아래가 더 좁으면 여백이 넓은 위를 고른다', () => {
    // 위 484px, 아래 308px
    const anchor = rect(20, 500, 60, 20)
    const pos = computePopoverPosition(anchor, { width: 300, height: 600 }, VIEWPORT)
    expect(pos.placement).toBe('top')
    expect(pos.top).toBeGreaterThanOrEqual(8)
  })

  it('높이가 화면보다 크면 위에서 아래로 화면 안에 놓는다', () => {
    const anchor = rect(20, 400, 60, 20)
    const pos = computePopoverPosition(anchor, { width: 300, height: 2000 }, VIEWPORT)
    expect(pos.top).toBeGreaterThanOrEqual(8)
    expect(pos.top).toBeLessThanOrEqual(VIEWPORT.height - 8)
  })

  it('가로가 넘으면 화면 안에 밀어 넣는다', () => {
    const anchor = rect(360, 300, 60, 20)
    const pos = computePopoverPosition(anchor, { width: 300, height: 100 }, VIEWPORT)
    expect(pos.left).toBeGreaterThanOrEqual(8)
    expect(pos.left + 300).toBeLessThanOrEqual(VIEWPORT.width - 8 + 1)
  })

  it('같은 자리를 계속 계산하면 같은 값을 낸다 — 출렁이면 사용자가 못 읽는다', () => {
    const a = computePopoverPosition(LOW_ANCHOR, { width: 300, height: 420 }, VIEWPORT)
    const b = computePopoverPosition(LOW_ANCHOR, { width: 300, height: 420 }, VIEWPORT)
    expect(a).toEqual(b)
  })
})