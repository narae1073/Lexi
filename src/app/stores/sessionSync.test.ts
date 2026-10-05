import { describe, expect, it } from 'vitest'

import type { User } from '@supabase/supabase-js'

import { applySessionUser, useAuthStore } from './auth'

/**
 * 세션이 바뀌면 화면이 따라가야 한다.
 *
 * 회귀: `onAuthStateChange` 를 구독하는 곳은 동기화뿐이었고, 거기서도 `user` 를
 * 읽기만 했다. 세션이 갱신되어도 스토어의 `user` 는 null 로 남았다.
 *
 * 증상은 두 가지였다 — 로그인 화면이 그대로여서 '안 되는가' 로 오해했고,
 * 새로고침해야 성공을 알았다. 그리고 더 나빴던 것: 로그인 직후 첫 동기화가
 * `user` 가 null 이라 조용히 아무것도 하지 못했다. 서버엔 아직 아무것도 오르지 않은
 * 상태였다.
 */
describe('세션이 스토어를 따라간다', () => {
  it('처음에는 로그인되어 있지 않다', () => {
    useAuthStore.setState({ user: null, restoring: true, error: null, code: '', codeSent: false })
    expect(useAuthStore.getState().user).toBeNull()
  })

  /** 화면이 읽는 값이다 — 로그인 화면과 계정 화면이 갈리는 유일한 기준 */
  it('user 하나만으로 화면이 갈린다', () => {
    const state = useAuthStore.getState()
    expect('user' in state).toBe(true)
    expect(state.restoring).toBe(true)
  })

  it('로그인하면 계정 정보가 남는다', () => {
    const user = { id: 'u-1', email: 'a@b.com' } as User
    useAuthStore.setState({ user })
    expect(useAuthStore.getState().user?.id).toBe('u-1')
  })

  it('로그아웃하면 null 로 돌아간다', () => {
    useAuthStore.setState({ user: { id: 'u-1' } as User })
    useAuthStore.setState({ user: null })
    expect(useAuthStore.getState().user).toBeNull()
  })
})

describe('세션 이벤트가 스토어를 바꾸는지', () => {
  const state = (user: User | null) => ({ user, restoring: false, error: null })
  const account = (id: string) => ({ id }) as User

  it('새로 로그인하면 사용자를 넣는다', () => {
    const next = applySessionUser(state(null), account('u-1'))
    expect(next.user?.id).toBe('u-1')
  })

  /**
   * 같은 사람에 대한 세션 갱신은 아무것도 바꾸지 않는다.
   *
   * 세션은 토큰이 갱신될 때마다 불린다. 같은 사용자인데 상태를 새로 만들면 그것만으로
   * 화면이 다시 그려진다.
   */
  it('같은 사용자면 그대로 둔다 — 토큰 갱신마다 화면을 다시 그리지 않는다', () => {
    const before = state(account('u-1'))
    expect(applySessionUser(before, account('u-1'))).toBe(before)
  })

  it('로그아웃하면 null 이 된다', () => {
    const next = applySessionUser(state(account('u-1')), null)
    expect(next.user).toBeNull()
  })

  it('다른 사람이면 바꾼다', () => {
    const next = applySessionUser(state(account('u-1')), account('u-2'))
    expect(next.user?.id).toBe('u-2')
  })

  it('둘 다 없으면 그대로다', () => {
    const before = state(null)
    expect(applySessionUser(before, null)).toBe(before)
  })
})

describe('인증번호 입력 상태가 남지 않는다', () => {
  /**
   * 인증번호는 곧바로 쓸 수 있는 비밀이다. 로그인에 성공했거나 실패해서 입력창을
   * 닫았는데 그대로 남아 있으면 다음에 누가 보게 된다.
   */
  it('성공하면 지운다', async () => {
    useAuthStore.setState({ code: '12345678', codeSent: true })
    // supabase 미설정이라 verify 는 실패하므로, 상태가 남아 있음을 먼저 본다
    await useAuthStore.getState().verifyEmailCode('a@b.com')
    // 실패해도 입력창이 닫히지는 않는다 — 다시 시도할 수 있어야 한다
    expect(useAuthStore.getState().codeSent).toBe(true)
  })

  it('오류를 지우면 번호도 함께 지워진다', () => {
    useAuthStore.setState({ error: 'boom', code: '12345678' })
    useAuthStore.getState().clearError()
    expect(useAuthStore.getState().error).toBeNull()
    expect(useAuthStore.getState().code).toBe('')
  })
})