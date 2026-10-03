/**
 * 테마 목록.
 *
 * 실제 색 값은 index.css 의 [data-theme] 블록이 갖고 있다 (FOUC 없이 정적 CSS).
 * 이 파일은 선택 UI 에 필요한 메타데이터만 담는다.
 *
 * 새 테마를 추가할 때: index.css 에 [data-theme='id'] 블록 + 아래 목록 항목.
 * themes.test.ts 가 둘의 id 가 어긋나지 않는지 검사한다.
 */

export type ThemeId =
  | 'white'
  | 'sepia'
  | 'matcha'
  | 'latte'
  | 'black'
  | 'monaspace'
  | 'dracula'
  | 'monokai'
  | 'tokyo-night'
  | 'nord'

export type Theme = {
  id: ThemeId
  /** 선택 UI 표기 (앱 언어와 무관하게 고유어 유지) */
  label: string
  dark: boolean
  /** 미리보기용 색 — 실제 렌더링 색과 최대한 맞춘다 */
  swatch: { bg: string; bar: string; dot: string }
  /** PWA 브라우저 UI 에 쓰이는 색 (theme-color meta) */
  chromeColor: string
}

export const THEMES: readonly Theme[] = [
  {
    id: 'white',
    label: 'White',
    dark: false,
    swatch: { bg: '#f7f8fa', bar: '#2563eb', dot: '#9ca3af' },
    chromeColor: '#f7f8fa',
  },
  {
    id: 'sepia',
    label: 'Sepia',
    dark: false,
    swatch: { bg: '#f2e8d5', bar: '#a5622a', dot: '#8a7660' },
    chromeColor: '#f2e8d5',
  },
  {
    id: 'matcha',
    label: 'Matcha',
    dark: false,
    swatch: { bg: '#eaf2e2', bar: '#4f8a3d', dot: '#74806a' },
    chromeColor: '#eaf2e2',
  },
  {
    id: 'latte',
    label: 'Latte',
    dark: false,
    swatch: { bg: '#efeef9', bar: '#7c5cd6', dot: '#7e7a93' },
    chromeColor: '#efeef9',
  },
  {
    id: 'black',
    label: 'Black',
    dark: true,
    swatch: { bg: '#0d0d0f', bar: '#22d3ee', dot: '#9a9aa2' },
    chromeColor: '#0d0d0f',
  },
  {
    id: 'monaspace',
    label: 'Monaspace',
    dark: true,
    swatch: { bg: '#121213', bar: '#4ec9b0', dot: '#a1a1aa' },
    chromeColor: '#121213',
  },
  {
    id: 'dracula',
    label: 'Dracula',
    dark: true,
    swatch: { bg: '#282a36', bar: '#bd93f9', dot: '#ff79c6' },
    chromeColor: '#282a36',
  },
  {
    id: 'monokai',
    label: 'Monokai',
    dark: true,
    swatch: { bg: '#272822', bar: '#a6e22e', dot: '#f92672' },
    chromeColor: '#272822',
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    dark: true,
    swatch: { bg: '#1a1b26', bar: '#7aa2f7', dot: '#f7768e' },
    chromeColor: '#1a1b26',
  },
  {
    id: 'nord',
    label: 'Nord',
    dark: true,
    swatch: { bg: '#2e3440', bar: '#88c0d0', dot: '#bf616a' },
    chromeColor: '#2e3440',
  },
] as const

export const DEFAULT_THEME: ThemeId = 'white'

const BY_ID = new Map<string, Theme>(THEMES.map((t) => [t.id, t]))

export function getTheme(id: string): Theme | undefined {
  return BY_ID.get(id)
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && BY_ID.has(value)
}