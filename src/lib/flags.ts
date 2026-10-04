/**
 * 켜고 끄는 기능 표식.
 *
 * 빌드 시점에 정해지는 값이라 .env 에서 읽는다. Supabase 콘솔에서 provider 를
 * 켜기 전에 배포하면 사용자가 버튼을 눌렀을 때 실패한다 — 설정이 안 된 기능을
 * 미리 보여주는 쪽이 나쁘므로 기본은 숨김이다.
 */

const TRUE = new Set(['1', 'true', 'yes', 'on'])

export function isEnabled(raw: string | undefined | null): boolean {
  if (!raw) return false
  return TRUE.has(raw.trim().toLowerCase())
}

/** Google 로그인 버튼을 보여줄지 */
export function showGoogleLogin(raw = import.meta.env.VITE_SHOW_GOOGLE_LOGIN): boolean {
  return isEnabled(raw)
}
