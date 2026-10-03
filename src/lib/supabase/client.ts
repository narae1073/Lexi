import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { Database } from './database.types'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Phase 1은 로컬(IndexedDB) 우선이라 Supabase 미설정 상태로도 앱이 떠야 한다.
 * 계정 동기화(Phase 6) 전까지는 항상 null일 수 있다.
 */
export const isSupabaseConfigured = Boolean(url && anonKey)

export const supabase: SupabaseClient<Database> | null = isSupabaseConfigured
  ? createClient<Database>(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null

export function requireSupabase(): SupabaseClient<Database> {
  if (!supabase) {
    throw new Error(
      'Supabase 미설정: .env.local 에 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 를 설정하세요.',
    )
  }
  return supabase
}