import { FunctionsHttpError } from '@supabase/supabase-js'
import { create } from 'zustand'

import { supabase } from '../supabase/client'
import { cacheKey, fetchOrCached } from './offlineCache'
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
  /** 서버에 닿지 못해 이 기기에 저장돼 있던 결과인지 */
  offline?: boolean
}

export class DictionaryError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'DictionaryError'
    this.status = status
  }
}

/** 서버가 답하지 못했다는 신호 */
const transportStatus = (error: unknown): number | undefined =>
  error instanceof DictionaryError ? error.status : undefined

type DictionaryState = {
  entries: Record<string, DictionaryEntry>
  inFlight: Map<string, Promise<DictionaryEntry>>
  lookup: (languageCode: LanguageCode, lemma: string, surface?: string) => Promise<DictionaryEntry>
}

/**
 * 캐시·중복 요청 키.
 *
 * 반드시 한 곳에서 계산해야 한다. 패널이 원본 lemma 으로 키를 만들고 스토어가
 * 소문자로 키를 만들면, 표 대문자 단어(독일어 명사 등)는 결과가 도착해도
 * 패널이 캐시를 못 찾아 "찾는 중" 에서 멈춘다.
 */
export function dictionaryKey(languageCode: LanguageCode, lemma: string): string {
  return `${languageCode}::${lemma.trim().toLowerCase()}`
}

export const useDictionaryStore = create<DictionaryState>((set, get) => ({
  entries: {},
  inFlight: new Map(),

  lookup: (languageCode, lemma, surface) => {
    const word = lemma.trim().toLowerCase()
    const key = dictionaryKey(languageCode, word)

    // 이미 있으면 다시 물어보지 않는다 — 표 대문자 표기와 소문자 표기가
    // 같은 단어로 수렴하므로 캐시 적중률을 떨어뜨리면 안 된다
    const cached = get().entries[key]
    if (cached) return Promise.resolve(cached)

    const existing = get().inFlight.get(key)
    if (existing) return existing

    const request = (async () => {
      // 클라이언트를 지역 변수로 잡아 둔다 — 중첩 함수 안에서는 narrowing 이 풀린다
      const client = supabase
      if (!client) throw new DictionaryError('Supabase is not configured')

      const { value, fromCache } = await fetchOrCached<DictionaryEntry>(
        // surface 를 키에 넣어야 표 대문자 표기가 다른 결과를 섞지 않는다
        cacheKey(`d:${key}`, surface ?? ''),
        async () => {
          const { data, error } = await client.functions.invoke<DictionaryEntry>('dictionary', {
            // surface 를 함께 보내야 독일어처럼 명사를 대문자로 쓰는 언어를 조회할 수 있다
            body: { languageCode, lemma: word, surface: surface?.trim() },
          })

          if (error) {
            const status = error instanceof FunctionsHttpError ? error.context.status : undefined
            throw new DictionaryError(error.message, status)
          }
          if (!data) throw new DictionaryError('empty response from dictionary')
          return data
        },
        transportStatus,
      )

      return fromCache ? { ...value, offline: true } : value
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