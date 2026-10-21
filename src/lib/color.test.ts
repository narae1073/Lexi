import { describe, expect, it } from 'vitest'

import { statusClass, statusDotClass, statusPillClass } from './color'

describe('statusClass', () => {
  it('아는 단어는 색을 칠하지 않는다 — 본문색 그대로 (plan.txt 4줄)', () => {
    expect(statusClass('known')).toBe('')
  })

  it('표시 안 한 단어는 옅은 색을 쓴다', () => {
    // 본문이랑 아는 단어는 같아야 하고, 표시 안 한 단어만 달라야 한다
    expect(statusClass(undefined)).toBe('text-unmarked')
    expect(statusClass(undefined)).not.toBe(statusClass('known'))
  })

  it('상태가 없는 것과 표시 안 한 을 같게 본다', () => {
    // 상태 바처럼 모르는 값을 만들어 내는 곳에서도 같은 규칙이 적용된다
    expect(statusClass('unmarked')).toBe(statusClass(undefined))
  })

  it('어렵다는 단어는 밑줄로, 모르는 단어는 진하게 표시한다', () => {
    expect(statusClass('unsure')).toContain('text-status-unsure')
    expect(statusClass('unsure')).toContain('decoration-dotted')
    expect(statusClass('unknown')).toContain('text-status-unknown')
    expect(statusClass('unknown')).not.toContain('decoration-dotted')
  })

  it('세 상태는 서로 다른 클래스를 갖는다', () => {
    const classes = (['known', 'unsure', 'unknown'] as const).map(statusClass)
    expect(new Set(classes).size).toBe(classes.length)
  })
})

describe('statusPillClass', () => {
  it('아는 단어는 색을 칠하지 않는다 — 중립 테두리와 본문색뿐', () => {
    const cls = statusPillClass('known')
    expect(cls).not.toContain('status-')
    expect(cls).toContain('text-ink')
  })

  it('헷갈림은 호박색, 모름은 빨강 — 배경까지 같은 말을 한다', () => {
    expect(statusPillClass('unsure')).toContain('text-status-unsure')
    expect(statusPillClass('unsure')).toContain('bg-status-unsure-bg')
    expect(statusPillClass('unknown')).toContain('text-status-unknown')
    expect(statusPillClass('unknown')).toContain('bg-status-unknown-bg')
  })

  it('배지에는 밑줄을 긋지 않는다 — 글자 장식이 읽기를 방해한다', () => {
    for (const status of ['known', 'unsure', 'unknown'] as const) {
      expect(statusPillClass(status)).not.toContain('underline')
      expect(statusPillClass(status)).not.toContain('decoration')
    }
  })

  it('세 상태는 서로 다른 클래스를 갖는다', () => {
    const classes = (['known', 'unsure', 'unknown'] as const).map(statusPillClass)
    expect(new Set(classes).size).toBe(classes.length)
  })
})

describe('statusDotClass', () => {
  it('아는 단어의 점은 본문색이다 — 막대(bg-ink)와 같은 말을 한다', () => {
    // statusClass 는 비어 본문색을 받는 규칙이지만, 점은 muted 글자 안에 놓여
    // muted 회색이 된다 — 그래서 점은 ink 를 직접 받는다
    expect(statusDotClass('known')).toBe('text-ink')
  })

  it('점은 밑줄·배경을 얹지 않는다 — ● 아래에 점선이 그어지지 않게', () => {
    expect(statusDotClass('unsure')).toBe('text-status-unsure')
    expect(statusDotClass('unknown')).toBe('text-status-unknown')
  })

  it('표시 안 한 점은 옅은 색이다', () => {
    expect(statusDotClass('unmarked')).toBe('text-unmarked')
    expect(statusDotClass(undefined)).toBe(statusDotClass('unmarked'))
  })

  it('네 점은 서로 다르다', () => {
    const classes = (['known', 'unsure', 'unknown', 'unmarked'] as const).map(statusDotClass)
    expect(new Set(classes).size).toBe(classes.length)
  })
})
