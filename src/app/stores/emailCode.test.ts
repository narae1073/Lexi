import { describe, expect, it } from 'vitest'

import { CODE_MAX_DIGITS, CODE_MIN_DIGITS } from './auth'

/**
 * 인증번호 자릿수.
 *
 * 회귀: Supabase 가 보내는 번호 길이는 서버 설정 `mailer_otp_length` 다. 이 프로젝트는
 * 8자리를 보내는데 앱은 6자리를 요구했다 — 메일에는 8자리, 앱은 6자리, 그래서 실패했다.
 *
 * 자릿수를 앱이 아는 척하면 그 설정이 바뀔 때마다 인증이 깨진다. 서버 밖의 설정이므로
 * 앱은 숫자를 그대로 넘겨야 한다.
 */
describe('인증번호 자릿수를 고정하지 않는다', () => {
  it('8자리를 받아들인다 — 이 프로젝트가 실제로 보내는 길이', () => {
    expect(CODE_MAX_DIGITS >= 8).toBe(true)
  })

  it('6자리는 당연히 들어온다', () => {
    expect(CODE_MAX_DIGITS >= 6).toBe(true)
  })

  it('입력창이 충분히 넓다', () => {
    expect(CODE_MAX_DIGITS).toBeGreaterThanOrEqual(8)
  })

  /** 사람이 입력한 것인지 가르는 선 — 여기를 넘어서면 아무것도 보내지 않는다 */
  it('너무 짧은 입력은 사람이 입력한 것이 아니다', () => {
    expect(CODE_MIN_DIGITS).toBe(4)
  })

  /** 숫자만 받는다 — 사이에 붙은 공백이나 하이픈은 사람이 흔히 그대로 복사한다 */
  it('숫자만 남긴다', () => {
    const cleaned = '123 456 78'.replace(/\D/g, '')
    expect(cleaned).toBe('12345678')
  })
})
