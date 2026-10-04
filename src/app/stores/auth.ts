import { create } from 'zustand'

import { supabase } from '../../lib/supabase/client'
import type { User } from '@supabase/supabase-js'

export type AuthState = {
  /** 로그인한 사용자. 없으면 로컬 전용으로 동작한다 */
  user: User | null
  /** 세션을 확인하는 중인지 — 이때 로그아웃 화면을 잠깐 보여주지 않는다 */
  restoring: boolean
  /** 로그인 링크를 보냈는지 (매직링크) */
  linkSent: boolean
  /** 사람이 읽을 수 있는 오류. 로그인 실패를 조용히 삼키면 안 된다 */
  error: string | null
  restore: () => Promise<void>
  sendMagicLink: (email: string) => Promise<boolean>
  signInWithGoogle: () => Promise<boolean>
  signOut: () => Promise<void>
  clearError: () => void
}

/**
 * 로그인하지 않아도 앱은 완전히 동작한다.
 *
 * 이 앱의 약속은 "텍스트를 넣어 배우는 것" 이고, 계정은 그 학습을 기기 사이에서
 * 이어가는 수단일 뿐이다. 로그인 화면에서 막히면 사용자는 앱을 쓸 수 없게 된다.
 */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  restoring: true,
  linkSent: false,
  error: null,

  /** 세션 변화는 밖(onAuthChanged) 에서 구독한다 — 여기서는 초기 확인만 한다 */
  restore: async () => {
    if (!supabase) {
      set({ restoring: false })
      return
    }
    try {
      const { data } = await supabase.auth.getSession()
      set({ user: data.session?.user ?? null, restoring: false })
    } catch {
      // 세션 확인이 실패해도 앱은 계속 쓸 수 있다 — 로컬 전용으로 물러난다
      set({ user: null, restoring: false })
    }
  },

  sendMagicLink: async (email) => {
    if (!supabase) return false
    set({ error: null, linkSent: false })

    const redirectTo = new URL('/settings', window.location.origin).toString()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    })

    if (error) {
      set({ error: error.message })
      return false
    }
    set({ linkSent: true })
    return true
  },

  signInWithGoogle: async () => {
    if (!supabase) return false
    set({ error: null })

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: new URL('/settings', window.location.origin).toString(),
        // 이 앱은 Google 계정의 이름·사진을 쓰지 않는다. 최소만 받는다.
        scopes: 'email profile',
      },
    })

    if (error) {
      set({ error: error.message })
      return false
    }
    // 성공하면 브라우저가 Google 로 이동하므로 여기서 끝난다
    return true
  },

  signOut: async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    set({ user: null, linkSent: false, error: null })
  },

  clearError: () => set({ error: null, linkSent: false }),
}))

/**
 * 세션이 바뀔 때마다 알려 준다.
 *
 * 로그인·로그아웃 어느 쪽이든 즉시 알아야 동기화가 맞물린다.
 * onAuthStateChange 는 AuthenticatorStateChangeData 를 동기적으로 넘겨야 하고,
 * 거기서 await 하면 교착이 걸린다 — 콜백 안에서는 상태만 만진다.
 *
 * 반환값은 구독 해제 함수다.
 */
export function onAuthChanged(handler: (user: User | null) => void): () => void {
  if (!supabase) return () => {}
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    handler(session?.user ?? null)
  })
  return () => data.subscription.unsubscribe()
}
