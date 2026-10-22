import { describe, expect, it } from 'vitest'

import { sha256Hex } from './hash'

/**
 * SHA-256 은 직접 구현하지 않고 Web Crypto 에 맡긴다.
 * 그래도 입력 인코딩(UTF-8)과 16진수 표기(소문자·0 채움)는 우리 몫이라
 * 알려진 벡터로 못 박아 둔다.
 */
describe('sha256Hex', () => {
  it('빈 문자열의 알려진 벡터', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('"abc" 의 알려진 벡터', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('긴 영문 문장의 알려진 벡터', async () => {
    expect(await sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    )
  })

  it('비ASCII 는 UTF-8 바이트로 해싱한다', async () => {
    expect(await sha256Hex('안녕하세요')).toBe(
      '2c68318e352971113645cbc72861e1ec23f48d5baa5f9b405fed9dddca893eb4',
    )
  })

  it('항상 64자리 소문자 16진수다 — 0으로 시작해도 줄이지 않는다', async () => {
    const hex = await sha256Hex('abc')
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('한 글자만 달라도 결과가 달라진다', async () => {
    expect(await sha256Hex('hello')).not.toBe(await sha256Hex('hellp'))
  })
})
