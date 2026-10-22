import { describe, expect, it } from 'vitest'

import { translationCacheKey } from './translate'

/**
 * 회귀 테스트.
 *
 * 예전 키는 `길이 + 앞 120자` 였다. 같은 길이에 앞부분이 같은 두 문장은
 * 뒷부분이 아무리 달라도 같은 번역을 돌려받았다 — 다른 글의 번역이
 * 화면에 나오는, 조용하지만 치명적인 오류다.
 */

/** 200자, 앞 120자는 같고 끝만 다른 두 문장 */
const PREFIX = 'a'.repeat(120)
const TEXT_A = `${PREFIX}${'b'.repeat(80)}`
const TEXT_B = `${PREFIX}${'c'.repeat(80)}`

describe('translationCacheKey', () => {
  it('같은 문장·같은 언어면 같은 키다', async () => {
    expect(await translationCacheKey(TEXT_A, 'en', 'ko')).toBe(
      await translationCacheKey(TEXT_A, 'en', 'ko'),
    )
  })

  it('길이와 앞 120자가 같아도 뒷부분이 다르면 다른 키다', async () => {
    expect(TEXT_A).toHaveLength(200)
    expect(TEXT_B).toHaveLength(200)
    expect(TEXT_A.slice(0, 120)).toBe(TEXT_B.slice(0, 120))

    expect(await translationCacheKey(TEXT_A, 'en', 'ko')).not.toBe(
      await translationCacheKey(TEXT_B, 'en', 'ko'),
    )
  })

  it('원문 언어가 다르면 다른 키다', async () => {
    expect(await translationCacheKey(TEXT_A, 'en', 'ko')).not.toBe(
      await translationCacheKey(TEXT_A, 'de', 'ko'),
    )
  })

  it('목표 언어가 다르면 다른 키다', async () => {
    expect(await translationCacheKey(TEXT_A, 'en', 'ko')).not.toBe(
      await translationCacheKey(TEXT_A, 'en', 'ja'),
    )
  })

  it('예전 키와 섞이지 않도록 t2: 로 시작하고 전체 내용을 해싱한다', async () => {
    const key = await translationCacheKey('안녕하세요', 'ko', 'en')
    expect(key).toMatch(/^t2:ko:en:[0-9a-f]{64}$/)
    // 앞 120자만 해싱했다면 이런 키가 나올 수 없다
    expect(key).not.toContain('안녕하세요')
  })

  it('앞뒤 공백은 무시한다 — translate() 가 이미 trim 한 문장을 보낸다', async () => {
    expect(await translationCacheKey('  hello  ', 'en', 'ko')).toBe(
      await translationCacheKey('hello', 'en', 'ko'),
    )
  })
})
