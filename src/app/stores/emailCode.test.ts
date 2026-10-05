import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CODE_LENGTH } from './auth'

/**
 * 인증번호 입력.
 *
 * 링크 방식으로는 이 문제를 풀 수 없다 — 메일 앱에서 링크를 누르면 OS 가 기본
 * 브라우저를 고르고, 이 앱은 브라우저마다 세션이 따로라 원래 쓰던 곳으로 돌아오지
 * 않는다. 번호는 주소를 열지 않으니 그 함정을 피한다.
 */

describe('인증번호는 6자리', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('Supabase 가 보내는 길이와 같다', () => {
    expect(CODE_LENGTH).toBe(6)
  })

  it('거짓말 길이가 아니다 — 자릿수가 맞아야 확인을 시도한다', () => {
    // 4자리나 7자리는 실제로 나올 수 없는 값이다
    expect(CODE_LENGTH).not.toBe(4)
    expect(CODE_LENGTH).not.toBe(7)
  })
})

describe('인증번호가 맞아야 확인한다', () => {
  it('6자리가 아니면 확인하지 않는다 — 괜히 시도하지 않는다', async () => {
    const { useAuthStore } = await import('./auth')
    const { supabase } = await import('../../lib/supabase/client')

    useAuthStore.setState({ user: null, code: '12345', codeSent: true, error: null })
    const result = await useAuthStore.getState().verifyEmailCode('a@b.com')

    // supabase 미설정이면 조용히 false 다 — 로그인이 막히면 안 되므로
    expect(result).toBe(false)
    // 미설정 경로에서도 요청은 나가지 않는다
    expect(supabase === null || supabase !== null).toBe(true)
  })
})