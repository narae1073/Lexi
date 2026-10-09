import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createTranslator, DEFAULT_APP_LANGUAGE, type AppLanguage, type Translator } from '../../i18n'
import type { SupportedLanguageCode } from '../../lib/languages'
import { DEFAULT_THEME, getTheme, isThemeId, type ThemeId } from '../../features/settings/themes'
import {
  DEFAULT_DOCUMENT_SORT,
  DEFAULT_SORT_DIRECTION,
  documentSortOrDefault,
  directionOrDefault,
  flipDirection,
  type DocumentSort,
  type SortDirection,
} from '../../features/reader/documentSort'
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from '../../lib/paginate'
import { DEFAULT_READER_PAGE_WORDS, pageWordsOrDefault } from '../../features/reader/pageBreak'

/** 표시 안 한 단어의 옅은 정도 (%) — 0 이면 본문색 그대로, 클수록 옅다 */
export const UNMARKED_DIM_MIN = 0
export const UNMARKED_DIM_MAX = 70
export const UNMARKED_DIM_DEFAULT = 34

export function clampUnmarkedDim(value: number): number {
  if (!Number.isFinite(value)) return UNMARKED_DIM_DEFAULT
  return Math.min(UNMARKED_DIM_MAX, Math.max(UNMARKED_DIM_MIN, Math.round(value)))
}

/**
 * 화면 전체 글자 크기 배율 (%).
 *
 * 루트 font-size 를 바꾸면 Tailwind 의 rem 단위 유틸리티가 전부 같이 커지므로
 * 본문뿐 아니라 여백·테두리·아이콘까지 같은 비율로 늘어난다 — 배율만 조절하는
 * 앱이라면 이 방법이 가장 안전하다. 브라우저의 기본 글자 크기 설정도 함께
 * 곱해지므로 사용자가 정한 크기를 존중한다.
 */
export const TEXT_SCALE_MIN = 85
export const TEXT_SCALE_MAX = 160
export const TEXT_SCALE_STEP = 5
export const TEXT_SCALE_DEFAULT = 100

/** 저장된 값이 슬라이더 눈금에 없는 값이어도 눈금 위로 올려 snaps — 손잡이가 어긋나지 않게 */
/** 고를 수 있는 단어장 페이지 크기만 받아들인다 — 깨진 저장을 스스로 고쳐야 한다 */
export function pageSizeOrDefault(value: number): number {
  return (PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_PAGE_SIZE
}

export function clampTextScale(value: number): number {
  if (!Number.isFinite(value)) return TEXT_SCALE_DEFAULT
  const clamped = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, value))
  return Math.round(clamped / TEXT_SCALE_STEP) * TEXT_SCALE_STEP
}

/** 즐겨찾기 별 스티커의 크기 — 단어 글자의 % */
export const STAR_SIZE_MIN = 40
export const STAR_SIZE_MAX = 120
export const STAR_SIZE_STEP = 5
export const STAR_SIZE_DEFAULT = 65

export function clampStarSize(value: number): number {
  if (!Number.isFinite(value)) return STAR_SIZE_DEFAULT
  const clamped = Math.min(STAR_SIZE_MAX, Math.max(STAR_SIZE_MIN, value))
  return Math.round(clamped / STAR_SIZE_STEP) * STAR_SIZE_STEP
}

/** 즐겨찾기 별 스티커의 색 — 스티커는 노란 별이 정석이다 */
export const STAR_COLOR_DEFAULT = '#eab308'

export function sanitizeStarColor(value: unknown): string {
  if (typeof value !== 'string') return STAR_COLOR_DEFAULT
  const hex = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase()
  }
  return STAR_COLOR_DEFAULT
}

/** 깨진 저장은 0쪽으로 — 복원할 때 쪽 수에 맞춰 다시 당긴다 */
export function sanitizeReaderPage(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

type SettingsState = {
  /** 사용자가 명시적으로 고른 앱 언어. null 이면 기기 설정을 따른다. */
  appLanguage: AppLanguage | null
  /** null 이면 시스템 설정을 따른다 */
  theme: ThemeId | null
  /** 표시 안 한 단어를 본문색에서 얼마나 뺄지 (%, 클수록 옅다) */
  unmarkedDim: number
  /** 화면 전체 글자 크기 배율 (%) */
  textScale: number
  /** 단어장 한 페이지에 보여줄 단어 수 */
  wordbookPageSize: number
  /** 문서 목록 정렬 기준 */
  documentSort: DocumentSort
  /** 정렬 방향 — 기준마다 따로 들고 있다 */
  documentSortDir: Record<DocumentSort, SortDirection>
  /** 문서 본문 한 쪽에 담을 단어 수 */
  readerPageWords: number
  /** 즐겨찾기 별 스티커의 크기 — 단어 글자의 % */
  favoriteStarSize: number
  /** 즐겨찾기 별 스티커의 색 */
  favoriteStarColor: string
  /**
   * 문서별로 읽던 쪽. 새로고침해도 그 자리에서 이어 읽는다.
   *
   * 쪽은 기기·화면 설정에 따라 달라지므로 계정 동기화 대상이 아니다 — 이 기기의
   * localStorage 에만 둔다. 복원할 때는 쪽 수를 보고 범위를 벗어나면 당긴다.
   */
  readerPageByDocument: Record<string, number>
  setAppLanguage: (language: AppLanguage | null) => void
  setTheme: (theme: ThemeId | null) => void
  setUnmarkedDim: (value: number) => void
  setTextScale: (value: number) => void
  setWordbookPageSize: (value: number) => void
  setDocumentSort: (value: DocumentSort) => void
  setDocumentSortDir: (sort: DocumentSort, value: SortDirection) => void
  toggleDocumentSortDir: (sort: DocumentSort) => void
  setReaderPageWords: (value: number) => void
  setReaderPage: (documentId: string, page: number) => void
  setFavoriteStarSize: (value: number) => void
  setFavoriteStarColor: (value: string) => void
  resolvedAppLanguage: () => AppLanguage
  resolvedTheme: () => ThemeId
}

function detectDeviceLanguage(): AppLanguage {
  if (typeof navigator === 'undefined') return DEFAULT_APP_LANGUAGE
  return navigator.language.toLowerCase().startsWith('ko') ? 'ko' : DEFAULT_APP_LANGUAGE
}

function detectPreferredTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  return prefersDark ? 'black' : DEFAULT_THEME
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      appLanguage: null,
      theme: null,
      unmarkedDim: UNMARKED_DIM_DEFAULT,
      textScale: TEXT_SCALE_DEFAULT,
      wordbookPageSize: DEFAULT_PAGE_SIZE,
      documentSort: DEFAULT_DOCUMENT_SORT,
      documentSortDir: { ...DEFAULT_SORT_DIRECTION },
      readerPageWords: DEFAULT_READER_PAGE_WORDS,
      readerPageByDocument: {},
      favoriteStarSize: STAR_SIZE_DEFAULT,
      favoriteStarColor: STAR_COLOR_DEFAULT,
      setAppLanguage: (appLanguage) => set({ appLanguage }),
      setTheme: (theme) => set({ theme }),
      setUnmarkedDim: (value) => set({ unmarkedDim: clampUnmarkedDim(value) }),
      setTextScale: (value) => set({ textScale: clampTextScale(value) }),
      // 매번 고를 필요는 없지만, 지정한 뒤에 다음번에도 남아 있어야 한다
      setWordbookPageSize: (value) => set({ wordbookPageSize: pageSizeOrDefault(value) }),
      setDocumentSort: (value) => set({ documentSort: documentSortOrDefault(value) }),
      setDocumentSortDir: (sort, value) => {
        const safe = documentSortOrDefault(sort)
        set((s) => ({
          documentSortDir: {
            ...s.documentSortDir,
            [safe]: directionOrDefault(safe, value),
          },
        }))
      },
      toggleDocumentSortDir: (sort) => {
        const safe = documentSortOrDefault(sort)
        set((s) => ({
          documentSortDir: {
            ...s.documentSortDir,
            [safe]: flipDirection(directionOrDefault(safe, s.documentSortDir[safe])),
          },
        }))
      },
      setReaderPageWords: (value) => set({ readerPageWords: pageWordsOrDefault(value) }),
      setFavoriteStarSize: (value) => set({ favoriteStarSize: clampStarSize(value) }),
      setFavoriteStarColor: (value) => set({ favoriteStarColor: sanitizeStarColor(value) }),
      setReaderPage: (documentId, page) =>
        set((s) => ({
          readerPageByDocument: {
            ...s.readerPageByDocument,
            [documentId]: sanitizeReaderPage(page),
          },
        })),
      resolvedAppLanguage: () => get().appLanguage ?? detectDeviceLanguage(),
      resolvedTheme: () => get().theme ?? detectPreferredTheme(),
    }),
    {
      name: 'lexi.settings',
    },
  ),
)

/**
 * 테마를 문서에 반영한다.
 * data-theme 는 CSS 변수 선택자이고, theme-color 는 PWA 브라우저 UI 색이다.
 */
export function useApplyTheme() {
  const theme = useSettingsStore((s) => s.theme)
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme)
  const unmarkedDim = useSettingsStore((s) => s.unmarkedDim)

  const id = useMemo(() => theme ?? resolvedTheme(), [theme, resolvedTheme])

  useEffect(() => {
    const safeId = isThemeId(id) ? id : DEFAULT_THEME
    document.documentElement.dataset.theme = safeId

    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', getTheme(safeId)?.chromeColor ?? '#ffffff')
  }, [id])

  // 표시 안 한 단어의 옅은 정도 — index.css 의 color-mix 가 이 값을 읽는다
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--unmarked-dim',
      `${clampUnmarkedDim(unmarkedDim)}%`,
    )
  }, [unmarkedDim])
}

/**
 * 글자 크기 배율을 문서에 반영한다.
 *
 * html { font-size } 하나만 바꾸면 화면 전체가 같은 비율로 늘어난다.
 * 100% 일 때는 값을 아예 건드리지 않아 기본값과 똑같이 둔다.
 */
export function useApplyTextScale() {
  const textScale = useSettingsStore((s) => s.textScale)

  useEffect(() => {
    const scale = clampTextScale(textScale)
    const root = document.documentElement
    if (scale === TEXT_SCALE_DEFAULT) root.style.removeProperty('font-size')
    else root.style.fontSize = `${scale}%`
  }, [textScale])
}

/**
 * 앱 UI 언어의 번역 함수를 돌려준다.
 * 선택이 바뀌면 <html lang> 도 같이 맞춰야 스크린리더가 올바른 언어로 읽는다.
 */
export function useTranslation(): Translator {
  const appLanguage = useSettingsStore((s) => s.appLanguage)
  const resolved = useSettingsStore((s) => s.resolvedAppLanguage)

  const language = useMemo(() => appLanguage ?? resolved(), [appLanguage, resolved])

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  return useMemo(() => createTranslator(language), [language])
}

/** 언어 이름을 현재 앱 언어로 부른다 (화이트리스트 밖 코드는 그대로 통과) */
export function useLanguageName(): (code: SupportedLanguageCode) => string {
  const t = useTranslation()
  return useCallback((code: SupportedLanguageCode) => t(`languageNames.${code}`), [t])
}