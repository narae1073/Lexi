import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DEFAULT_THEME, getTheme, isThemeId, THEMES, type ThemeId } from './themes'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')

describe('테마 목록과 CSS 는 같은 id 를 공유해야 한다', () => {
  it('모든 테마에 대응하는 [data-theme] 블록이 있다', () => {
    for (const theme of THEMES) {
      expect(css).toContain(`[data-theme='${theme.id}']`)
    }
  })

  it('CSS 에 있는 테마가 목록에도 있다', () => {
    const inCss = [...css.matchAll(/\[data-theme='([^']+)'\]/g)].map((m) => m[1])
    expect(inCss.sort()).toEqual(THEMES.map((t) => t.id).sort())
  })

  it('기본 테마가 실제로 존재한다', () => {
    expect(getTheme(DEFAULT_THEME)).toBeDefined()
  })
})

describe('토큰 무결성', () => {
  const TOKENS = [
    '--t-bg',
    '--t-surface',
    '--t-surface-hover',
    '--t-ink',
    '--t-ink-muted',
    '--t-line',
    '--t-accent',
    '--t-accent-ink',
    '--t-status-unsure',
    '--t-status-unknown',
    '--t-status-unsure-bg',
    '--t-status-unknown-bg',
  ]

  it('모든 테마가 필요한 토큰을 전부 정의한다', () => {
    const blocks = [...css.matchAll(/\[data-theme='[^']+'\]\s*\{([^}]*)\}/g)].map((m) => m[1])
    expect(blocks).toHaveLength(THEMES.length)
    for (const block of blocks) {
      for (const token of TOKENS) expect(block).toContain(token)
    }
  })

  it('어두운 테마는 color-scheme: dark 를 선언한다', () => {
    for (const theme of THEMES.filter((t) => t.dark)) {
      const block = css.match(new RegExp(`\\[data-theme='${theme.id}'\\]\\s*\\{([^}]*)\\}`))?.[1]
      expect(block).toContain('color-scheme: dark')
    }
  })

  it('밝은 테마는 color-scheme: light 를 선언한다', () => {
    for (const theme of THEMES.filter((t) => !t.dark)) {
      const block = css.match(new RegExp(`\\[data-theme='${theme.id}'\\]\\s*\\{([^}]*)\\}`))?.[1]
      expect(block).toContain('color-scheme: light')
    }
  })
})

describe('isThemeId', () => {
  it('등록된 id 를 받아들이고 나머지는 버린다', () => {
    expect(isThemeId('nord')).toBe(true)
    expect(isThemeId('solarized')).toBe(false)
    expect(isThemeId(null)).toBe(false)
    expect(isThemeId(42)).toBe(false)
  })

  it('ThemeId 는 목록에서 유도된다', () => {
    const ids: ThemeId[] = THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(THEMES.length)
  })
})