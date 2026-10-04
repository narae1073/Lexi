/**
 * 로그인 오류를 사람이 읽을 수 있는 말로 바꾼다.
 *
 * Supabase 는 원인을 알 수 없는 영어 문장("Email rate limit exceeded")을 그대로
 * 넘겨온다. 무엇을 해야 하는지 모른 채로 그 문장을 붙잡고 있으면 사용자는
 * 아무것도 시도하지 않는다. 여기서 무엇을 고쳐야 하는지까지 말해 준다.
 */

const RULES: { match: RegExp; key: 'rateLimit' | 'notAllowed' | 'notConfirmed' | 'tooMany' }[] = [
  {
    // Supabase 기본 메일 서버가 시간당 발송량을 넘긴 경우.
    // 기본 서버는 팀 멤버 주소로만 보내므로 커스텀 SMTP 없이 기다려도 해결되지 않는다.
    // Supabase 가 이 상황을 표현하는 문장은 여러 모양이다
    match: /email rate limit|rate limit exceeded|too many email/i,
    key: 'rateLimit',
  },
  { match: /signups? (are )?not allowed|not allowed to sign up/i, key: 'notAllowed' },
  { match: /email not confirmed/i, key: 'notConfirmed' },
  { match: /too many (requests|attempts)/i, key: 'tooMany' },
]

export function authErrorKey(message: string | null | undefined): string | null {
  if (!message) return null
  for (const rule of RULES) {
    if (rule.match.test(message)) return rule.key
  }
  return null
}

/** 번역 키를 돌려준다 — 없으면 원래 메시지를 그대로 쓴다 */
export function authErrorKeyOrMessage(message: string | null | undefined): string | null {
  if (!message) return null
  return authErrorKey(message) ?? message
}
