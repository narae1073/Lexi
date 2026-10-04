import { describe, expect, it } from 'vitest'

import { PAGE_SIZES, pageCountOf, pageWindow, paginate } from './paginate'

const numbersIn = (window: (number | 'gap')[]) => window.filter((w) => typeof w === 'number')

describe('paginate', () => {
  const items = Array.from({ length: 37 }, (_, i) => i + 1)

  it('한 페이지만 채워 보여준다', () => {
    const page = paginate(items, 1, 10)
    expect(page.items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(page.pageCount).toBe(4)
    expect(page.from).toBe(1)
    expect(page.to).toBe(10)
  })

  it('마지막 페이지가 남아 있는 개수만큼 담는다', () => {
    const page = paginate(items, 4, 10)
    expect(page.items).toEqual([31, 32, 33, 34, 35, 36, 37])
    expect(page.from).toBe(31)
    expect(page.to).toBe(37)
  })

  it('이전·다음 존재 여부를 알려준다', () => {
    expect(paginate(items, 1, 10)).toMatchObject({ hasPrev: false, hasNext: true })
    expect(paginate(items, 2, 10)).toMatchObject({ hasPrev: true, hasNext: true })
    expect(paginate(items, 4, 10)).toMatchObject({ hasPrev: true, hasNext: false })
  })

  it('목록이 줄었으면 마지막 페이지를 당긴다', () => {
    // 상태를 바꿔 항목이 사라져 4쪽이 없어졌을 때 — 빈 페이지를 보여주지 않는다
    const page = paginate([1, 2, 3], 4, 10)
    expect(page.page).toBe(1)
    expect(page.items).toEqual([1, 2, 3])
    expect(page.hasNext).toBe(false)
  })

  it('범위를 벗어난 페이지를 당긴다', () => {
    expect(paginate(items, 0, 10).page).toBe(1)
    expect(paginate(items, -5, 10).page).toBe(1)
    expect(paginate(items, 99, 10).page).toBe(4)
    expect(paginate(items, Number.NaN, 10).page).toBe(1)
  })

  it('빈 목록도 한 페이지로 본다 — 0 页 을 사용자에게 보여주지 않는다', () => {
    const page = paginate([], 1, 10)
    expect(page.pageCount).toBe(1)
    expect(page.items).toEqual([])
    expect(page.from).toBe(0)
    expect(page.to).toBe(0)
    expect(page.hasPrev).toBe(false)
    expect(page.hasNext).toBe(false)
  })

  it('페이지 크기가 0 이거나 음수여도 죽지 않는다', () => {
    expect(paginate(items, 1, 0).items).toHaveLength(1)
    expect(paginate(items, 1, -10).items).toHaveLength(1)
    expect(pageCountOf(37, 0)).toBe(1)
  })

  it('나눗셈이 정확히 맞는다 — 크기가 항수를 이루지 않아도 빠지는 항목이 없다', () => {
    for (const size of PAGE_SIZES) {
      const pages = pageCountOf(items.length, size)
      const seen = Array.from({ length: pages }, (_, i) => paginate(items, i + 1, size).items.length)
      expect(seen.reduce((a, b) => a + b, 0)).toBe(37)
    }
  })
})

describe('pageWindow', () => {
  it('페이지가 적으면 전부 보여준다', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it('첫 쪽과 마지막 쪽은 항상 보인다', () => {
    const window = pageWindow(1, 40)
    expect(window[0]).toBe(1)
    expect(window.at(-1)).toBe(40)
  })

  it('가운데가 길면 … 로 접는다', () => {
    const window = pageWindow(20, 40)
    expect(window).toContain('gap')
    expect(numbersIn(window)).toHaveLength(7)
  })

  it('어느 쪽 끝에 있어도 보이는 번호 수가 늘지 않는다', () => {
    for (const page of [1, 2, 3, 20, 38, 39, 40]) {
      expect(numbersIn(pageWindow(page, 40)).length).toBeLessThanOrEqual(7)
    }
  })

  it('첫 쪽 근처면 앞쪽을 채우고, 뒤쪽만 접는다', () => {
    const window = pageWindow(1, 40)
    expect(window[0]).toBe(1)
    expect(window[1]).toBe(2)
    // … 가 남는 곳은 뒤쪽이어야 한다
    expect(window.indexOf('gap')).toBeGreaterThan(1)
  })

  it('현재 페이지는 항상 보인다', () => {
    for (const page of [1, 2, 3, 20, 38, 39, 40]) {
      expect(pageWindow(page, 40)).toContain(page)
    }
  })

  it('번호는 빠짐없이 정렬되어 있고 … 는 늘 한 개씩만', () => {
    for (const page of [1, 2, 20, 39, 40]) {
      const window = pageWindow(page, 40)
      const gaps = window.filter((w) => w === 'gap')
      expect(gaps.length).toBeLessThanOrEqual(2)
      const numbers = numbersIn(window)
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
      // … 가 두 번 연속으로 나오지 않는다
      expect(window.some((w, i) => w === 'gap' && window[i + 1] === 'gap')).toBe(false)
    }
  })

  it('페이지 하나일 때는 그 번호만', () => {
    expect(pageWindow(1, 1)).toEqual([1])
  })
})
