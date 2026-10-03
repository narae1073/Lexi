import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { SUPPORTED_LANGUAGES } from '../../lib/languages'
import type { LanguageCode } from '../../types'

type LanguagesState = {
  enrolled: LanguageCode[]
  /** 온보딩에서 언어를 1개 이상 골랐는지. false면 앱 시작 시 선택 화면으로 보낸다 (plan.txt 5줄). */
  ready: boolean
  toggle: (code: LanguageCode) => void
  reset: () => void
}

export const useLanguagesStore = create<LanguagesState>()(
  persist(
    (set) => ({
      enrolled: [],
      ready: false,
      toggle: (code) =>
        set((state) => {
          const known = SUPPORTED_LANGUAGES.some((l) => l.code === code)
          if (!known) return state
          const enrolled = state.enrolled.includes(code)
            ? state.enrolled.filter((c) => c !== code)
            : [...state.enrolled, code]
          return { enrolled, ready: enrolled.length > 0 }
        }),
      reset: () => set({ enrolled: [], ready: false }),
    }),
    { name: 'lexi.languages' },
  ),
)