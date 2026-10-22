import { describe, expect, it } from 'vitest'

import { readJsonBody } from './http'

/**
 * 본문 상한은 Content-Length 를 믿지 않는다.
 * 헤더가 없거나 거짓이어도 실제 스트림 바이트로 막아야 한다.
 */

const MAX = 64

function post(body?: BodyInit | null, headers?: HeadersInit): Request {
  return new Request('http://localhost/functions/test', { method: 'POST', body, headers })
}

describe('readJsonBody', () => {
  it('정상 JSON 을 파싱한다', async () => {
    const body = JSON.stringify({ text: '안녕' })
    const req = post(body)
    req.headers.set('content-length', String(new TextEncoder().encode(body).byteLength))

    await expect(readJsonBody(req, MAX)).resolves.toEqual({
      ok: true,
      value: { text: '안녕' },
    })
  })

  it('Content-Length 가 없어도 스트림에서 정상 JSON 을 읽는다', async () => {
    const req = post(JSON.stringify({ ok: true }))
    req.headers.delete('content-length')

    await expect(readJsonBody(req, MAX)).resolves.toEqual({
      ok: true,
      value: { ok: true },
    })
  })

  it('선언된 Content-Length 가 상한을 넘으면 읽지 않고 413 이다', async () => {
    const req = post('{}', { 'content-length': String(MAX + 1) })

    await expect(readJsonBody(req, MAX)).resolves.toEqual({
      ok: false,
      status: 413,
      error: 'request body too large',
    })
  })

  it('헤더가 없어도 실제 본문이 상한을 넘으면 413 이다', async () => {
    const req = post('x'.repeat(MAX + 1))
    req.headers.delete('content-length')

    await expect(readJsonBody(req, MAX)).resolves.toEqual({
      ok: false,
      status: 413,
      error: 'request body too large',
    })
  })

  it('선언된 길이가 작아도 실제 본문이 크면 413 이다', async () => {
    const req = post('x'.repeat(MAX + 1), { 'content-length': '2' })

    await expect(readJsonBody(req, MAX)).resolves.toEqual({
      ok: false,
      status: 413,
      error: 'request body too large',
    })
  })

  it.each(['nope', '-1', '1.5', '1e3'])(
    '잘못된 Content-Length(%s) 는 400 이다',
    async (length) => {
      const req = post('{}', { 'content-length': length })

      await expect(readJsonBody(req, MAX)).resolves.toEqual({
        ok: false,
        status: 400,
        error: 'invalid content-length',
      })
    },
  )

  it('깨진 JSON 은 400 이다', async () => {
    const req = post('{')

    await expect(readJsonBody(req, MAX)).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'invalid JSON body',
    })
  })

  it('본문이 없으면 400 이다', async () => {
    const req = post()

    await expect(readJsonBody(req, MAX)).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'empty request body',
    })
  })
})
