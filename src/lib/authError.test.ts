import { describe, expect, it } from 'vitest'

import { authErrorKey, authErrorKeyOrMessage } from './authError'

describe('authErrorKey', () => {
  it('기본 메일 서버의 발송량 제한을 알아본다 — 실제로 만난 문장', () => {
    expect(authErrorKey('Email rate limit exceeded')).toBe('rateLimit')
  })

  it('다른 모양의 같은 원인도 받아들인다', () => {
    for (const message of [
      'Email rate limit exceeded',
      'email rate limit',
      'Too many email requests. Please wait',
      'rate limit exceeded',
    ]) {
      expect(authErrorKey(message)).toBe('rateLimit')
    }
  })

  it('가입 차단과 미확인 메일도 구분한다', () => {
    expect(authErrorKey('Signups not allowed for this instance')).toBe('notAllowed')
    expect(authErrorKey('Email not confirmed')).toBe('notConfirmed')
  })

  it('모르는 오류는 null — 원문을 그대로 보여준다', () => {
    expect(authErrorKey('Invalid login credentials')).toBeNull()
  })

  it('오류가 없으면 null', () => {
    expect(authErrorKey(null)).toBeNull()
    expect(authErrorKey(undefined)).toBeNull()
    expect(authErrorKey('')).toBeNull()
  })
})

describe('authErrorKeyOrMessage', () => {
  it('아는 오류는 키를, 모르는 오류는 원문을 돌려준다', () => {
    expect(authErrorKeyOrMessage('Email rate limit exceeded')).toBe('rateLimit')
    expect(authErrorKeyOrMessage('Invalid login credentials')).toBe('Invalid login credentials')
    expect(authErrorKeyOrMessage(null)).toBeNull()
  })
})
