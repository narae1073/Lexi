import { create } from 'zustand'
import { FunctionsHttpError } from '@supabase/supabase-js'

import { sha256Hex } from '../hash'
import { supabase } from '../supabase/client'
import { cacheKey, fetchOrCached } from './offlineCache'
import { readOrCreateInstallId } from './installId'
import type { AppLanguage } from '../../i18n'

export type TranslateResult = {
  translatedText: string
  cached: boolean
  /** 원문과 목표 언어가 같아 번역이 불필요한 경우 */
  identity: boolean
  /** 서버에 닿지 못해 이 기기에 저장돼 있던 결과를 쓴 경우 */
  offline?: boolean
}

type TranslateState = {
  /** `t2:${source}:${target}:${sha256}` — 같은 문장은 한 번만 요청한다 */
  inFlight: Map<string, Promise<TranslateResult>>
  translate: (text: string, source: AppLanguage | string, target: string) => Promise<TranslateResult>
}

export class TranslateError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'TranslateError'
    this.status = status
  }
}

/**
 * 번역 캐시 키.
 *
 * 예전에는 `길이 + 앞 120자` 였는데, 같은 길이에 앞부분이 같은 두 문장이
 * 같은 번역을 공유하는 충돌이 있었다. 전체 내용의 SHA-256 을 쓴다.
 * `t2:` 접두사는 예전 키와 섞이지 않게 하려는 것이다 — 옛 충돌 키는
 * 자동으로 무효가 된다.
 */
export async function translationCacheKey(
  text: string,
  source: string,
  target: string,
): Promise<string> {
  return `t2:${source}:${target}:${await sha256Hex(text.trim())}`
}

/** 버가 답하지 못했다는 신호 */
const transportStatus = (error: unknown): number | undefined =>
  error instanceof TranslateError ? error.status : undefined

const MAX_CHARS = 5000

export const useTranslateStore = create<TranslateState>((set, get) => ({
  inFlight: new Map(),

  translate: async (text, source, target) => {
    const trimmed = text.trim()
    if (trimmed.length === 0) throw new TranslateError('empty text')
    if (trimmed.length > MAX_CHARS) throw new TranslateError('text too long')

    const key = await translationCacheKey(trimmed, source, target)
    const existing = get().inFlight.get(key)
    if (existing) return existing

    const request = (async () => {
      // 클라이언트를 지역 변수로 잡아 둔다 — 중첩 함수 안에서는 narrowing 이 풀린다
      const client = supabase
      if (!client) throw new TranslateError('Supabase is not configured')

      const { value, fromCache } = await fetchOrCached<TranslateResult>(
        cacheKey(key),
        async () => {
          const { data, error } = await client.functions.invoke<TranslateResult>('translate', {
            body: { sourceLanguage: source, targetLanguage: target, text: trimmed },
            // 계정 없이도 기기 단위 쿼터를 셀 수 있게 설치 ID 를 함께 보낸다
            headers: { 'x-lexi-install': readOrCreateInstallId() },
          })

          if (error) {
            // 함수에서 4xx/5xx 를 돌려준 경우 상태 코드를 그대로 살려서 UI 가 구분한다
            const status = error instanceof FunctionsHttpError ? error.context.status : undefined
            throw new TranslateError(error.message, status)
          }
          if (!data?.translatedText) throw new TranslateError('empty response from translate')
          return data
        },
        transportStatus,
      )

      return fromCache ? { ...value, offline: true } : value
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