/**
 * 문자열의 SHA-256 을 소문자 16진수 64자리로 돌려준다.
 *
 * Web Crypto 를 쓴다 — 직접 구현한 해시는 검증 부담만 늘고 얻을 게 없다.
 * 입력은 UTF-8 로 인코딩되므로 같은 문자열이면 플랫폼과 무관하게 같은 값이 나온다.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
