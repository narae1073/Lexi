import { create } from 'zustand'
import { FunctionsHttpError } from '@supabase/supabase-js'

import { supabase } from '../supabase/client'
import type { AppLanguage } from '../../i18n'

export type TranslateResult = {
  translatedText: string
  cached: boolean
  /** 원문과 목표 언어가 같아 번역이 불필요한 경우 */
  identity: boolean
}

type TranslateState = {
  /** `${source}:${target}:${hash-ish}` — 같은 문장은 한 번만 요청한다 */
  inFlight: Map<string, Promise<TranslateResult>>
  translate: (text: string, source: AppLanguage | string, target: string) => Promise<TranslateResult>
  clear: () => void
}

export class TranslateError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'TranslateError'
    this.status = status
  }
}

function cacheKey(text: string, source: string, target: string): string {
  // 매우 긴 문장은 어차피 캐시 적중률이 낮으니 길이만으로 구분해 키 크기를 제한한다
  return `${source}:${target}:${text.length}:${text.slice(0, 120)}`
}

const MAX_CHARS = 5000

export const useTranslateStore = create<TranslateState>((set, get) => ({
  inFlight: new Map(),

  clear: () => set({ inFlight: new Map() }),

  translate: async (text, source, target) => {
    const trimmed = text.trim()
    if (trimmed.length === 0) throw new TranslateError('empty text')
    if (trimmed.length > MAX_CHARS) throw new TranslateError('text too long')

    const key = cacheKey(trimmed, source, target)
    const existing = get().inFlight.get(key)
    if (existing) return existing

    const request = (async () => {
      if (!supabase) throw new TranslateError('Supabase is not configured')

      const { data, error } = await supabase.functions.invoke<TranslateResult>('translate', {
        body: { sourceLanguage: source, targetLanguage: target, text: trimmed },
      })

      if (error) {
        // 함수에서 4xx/5xx 를 돌려준 경우 상태 코드를 그대로 살려서 UI 가 구분한다
        const status = error instanceof FunctionsHttpError ? error.context.status : undefined
        throw new TranslateError(error.message, status)
      }
      if (!data?.translatedText) throw new TranslateError('empty response from translate')
      return data
    })()

    set((s) => ({ inFlight: new Map(s.inFlight).set(key, request) }))

    try {
      return await request
    } finally {
      set((s) => {
        const next = new Map(s.inFlight)
        next.delete(key)
        return { inFlight: next }
      })
    }
  },
}))