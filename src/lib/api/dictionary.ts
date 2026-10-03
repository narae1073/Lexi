import { FunctionsHttpError } from '@supabase/supabase-js'
import { create } from 'zustand'

import { supabase } from '../supabase/client'
import type { LanguageCode } from '../../types'

export type DictionarySense = {
  definition: string
  tags: string[]
  examples: string[]
}

export type DictionaryPart = {
  partOfSpeech: string
  senses: DictionarySense[]
}

/**
 * 사전 조회 결과 하나.
 * surface 는 클릭한 표기 자체의 항목, base 는 그 표기의 기본형 항목이다.
 * 예) 영어 running → [running 항목, run 기본형 항목]
 */
export type DictionarySection = {
  form: string
  role: 'surface' | 'base'
  phonetics: string[]
  parts: DictionaryPart[]
  source: { url: string; license: string }
}

export type DictionaryEntry = {
  found: boolean
  lemma: string
  /** 기본형으로 해석된 표기 (예: 속는다 → 속다) */
  matchedForm?: string | null
  languageCode: LanguageCode
  sections: DictionarySection[]
  cached: boolean
}

export class DictionaryError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'DictionaryError'
    this.status = status
  }
}

type DictionaryState = {
  entries: Record<string, DictionaryEntry>
  inFlight: Map<string, Promise<DictionaryEntry>>
  lookup: (languageCode: LanguageCode, lemma: string, surface?: string) => Promise<DictionaryEntry>
}

const keyOf = (languageCode: LanguageCode, lemma: string) => `${languageCode}::${lemma}`

export const useDictionaryStore = create<DictionaryState>((set, get) => ({
  entries: {},
  inFlight: new Map(),

  lookup: (languageCode, lemma, surface) => {
    const word = lemma.trim().toLowerCase()
    const key = keyOf(languageCode, word)

    const existing = get().inFlight.get(key)
    if (existing) return existing

    const request = (async () => {
      if (!supabase) throw new DictionaryError('Supabase is not configured')

      const { data, error } = await supabase.functions.invoke<DictionaryEntry>('dictionary', {
        // surface 를 함께 보내야 독일어처럼 명사를 대문자로 쓰는 언어를 조회할 수 있다
        body: { languageCode, lemma: word, surface: surface?.trim() },
      })

      if (error) {
        const status = error instanceof FunctionsHttpError ? error.context.status : undefined
        throw new DictionaryError(error.message, status)
      }
      if (!data) throw new DictionaryError('empty response from dictionary')
      return data
    })()

    set((s) => {
      const inFlight = new Map(s.inFlight)
      inFlight.set(key, request)
      return { inFlight }
    })

    return request
      .then((entry) => {
        set((s) => ({ entries: { ...s.entries, [key]: entry } }))
        return entry
      })
      .finally(() => {
        set((s) => {
          const inFlight = new Map(s.inFlight)
          inFlight.delete(key)
          return { inFlight }
        })
      })
  },
}))