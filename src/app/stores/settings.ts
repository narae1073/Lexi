import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createTranslator, DEFAULT_APP_LANGUAGE, type AppLanguage, type Translator } from '../../i18n'
import type { SupportedLanguageCode } from '../../lib/languages'
import { DEFAULT_THEME, getTheme, isThemeId, type ThemeId } from '../../features/settings/themes'

type SettingsState = {
  /** 사용자가 명시적으로 고른 앱 언어. null 이면 기기 설정을 따른다. */
  appLanguage: AppLanguage | null
  /** null 이면 시스템 설정을 따른다 */
  theme: ThemeId | null
  setAppLanguage: (language: AppLanguage | null) => void
  setTheme: (theme: ThemeId | null) => void
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
      setAppLanguage: (appLanguage) => set({ appLanguage }),
      setTheme: (theme) => set({ theme }),
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

  const id = useMemo(() => theme ?? resolvedTheme(), [theme, resolvedTheme])

  useEffect(() => {
    const safeId = isThemeId(id) ? id : DEFAULT_THEME
    document.documentElement.dataset.theme = safeId

    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', getTheme(safeId)?.chromeColor ?? '#ffffff')
  }, [id])
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