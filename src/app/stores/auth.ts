import { create } from 'zustand'

import { supabase } from '../../lib/supabase/client'
import type { User } from '@supabase/supabase-js'

/**
 * 인증번호 자릿수는 **고정하지 않는다.**
 *
 * Supabase 가 보내는 번호 길이는 서버 설정 `mailer_otp_length` 다. 기본은 6이지만
 * 바꾸는 곳이 있고, 이 프로젝트는 8이었다. 클라이언트가 6을 박아두면 메일은 8자리가
 * 오는데 앱은 6자리를 요구해 인증이 실패한다 — 서버 설정을 고치기 전까지는 답이 없다.
 *
 * 서버 설정은 앱 밖이다. 앱은 받은 숫자를 그대로 넘기고 서버가 맞다고 판단하게 한다.
 * 길이를 아는 척하지 않는 편이 틀렸을 때 조용히 실패하는 것보다 낫다.
 */
/** 이보다 짧으면 사람이 입력한 게 아니다 */
export const CODE_MIN_DIGITS = 4
/** 입력창이 받아들일 상한 — 안전망일 뿐, 8자리는 당연히 들어와야 한다 */
export const CODE_MAX_DIGITS = 12

export type AuthState = {
  /** 로그인한 사용자. 없으면 로컬 전용으로 동작한다 */
  user: User | null
  /** 세션을 확인하는 중인지 — 이때 로그아웃 화면을 잠깐 보여주지 않는다 */
  restoring: boolean
  /** 로그인 링크를 보냈는지 (매직링크) */
  linkSent: boolean
  /** 인증번호를 보냈는지 */
  codeSent: boolean
  /** 입력을 받은 인증번호 */
  code: string
  /** 사람이 읽을 수 있는 오류. 로그인 실패를 조용히 삼키면 안 된다 */
  error: string | null
  restore: () => Promise<void>
  sendMagicLink: (email: string) => Promise<boolean>
  sendEmailCode: (email: string) => Promise<boolean>
  verifyEmailCode: (email: string) => Promise<boolean>
  setCode: (code: string) => void
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
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  restoring: true,
  linkSent: false,
  codeSent: false,
  code: '',
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

  /**
   * 인증번호�� 보낸다 — 링크를 열지 않는다.
   *
   * **왜 이게 필요한가**
   *
   * 메일 앱에서 링크를 누르면 그 링크를 처리할 앱을 OS가 고른다. 기본 브라우저가
   * 파이어폭스면 파이어폭스로 열린다. 웹에서 그 선택을 막을 방법은 없다.
   *
   * 더 중요한 것은 **세션이 브라우저마다 다르다** 는 점이다. 이 앱은 세션을
   * localStorage 에 두므로, 링크를 연 브라우저에서만 로그인된다. 다른 브라우저에서
   * 로그인했다고 원래 쓰던 브라우저로 넘어오지 않는다.
   *
   * 번호를 직접 입력하면 주소를 한 번도 열지 않는다. 어떤 브라우저에서 시작했는지
   * 상관없이 그 브라우저에서 끝난다.
   *
   * 전제: Supabase 의 Magic Link 템플릿에 `{{ .Token }}` 이 들어 있어야 메일이
   * 링크가 아니라 6자리 번호를 담는다. 템플릿을 고치지 않으면 이 경로는 끝나지
   * 않는다 (매직 링크가 그대로 발송된다).
   */
  sendEmailCode: async (email) => {
    if (!supabase) return false
    set({ error: null, codeSent: false, code: '' })

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    })

    if (error) {
      set({ error: error.message })
      return false
    }
    set({ codeSent: true })
    return true
  },

  setCode: (code) => set({ code }),

  verifyEmailCode: async (email) => {
    if (!supabase) return false
    // 숫자만 남기고 — 자릿수는 서버가 정한다
    const token = get().code.replace(/\D/g, '')
    if (token.length < CODE_MIN_DIGITS) return false
    set({ error: null })

    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    })

    if (error) {
      set({ error: error.message })
      return false
    }
    set({ code: '', codeSent: false })
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
    set({ user: null, linkSent: false, codeSent: false, code: '', error: null })
  },

  clearError: () => set({ error: null, linkSent: false, code: '' }),
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
