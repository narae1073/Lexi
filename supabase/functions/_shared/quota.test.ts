import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { enforceQuota, makeQuotaLimits, quotaWindowStart, type QuotaLimit } from './quota'

/**
 * 쿼터 계산은 순수 함수로 둔다. DB/RPC 는 7b 가 붙이고, 여기서는
 * "무엇을 몇 번까지" 와 "거부되면 즉시 멈춘다" 만 검증한다.
 */

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex')

describe('quotaWindowStart', () => {
  it('한 시간 창의 시작으로 내린다', () => {
    const hour = 3600
    const start = 1_700_000_000_000
    const aligned = Math.floor(start / 3_600_000) * 3_600_000

    expect(quotaWindowStart(start, hour)).toBe(aligned)
    expect(quotaWindowStart(aligned, hour)).toBe(aligned)
    expect(quotaWindowStart(aligned + 3_599_999, hour)).toBe(aligned)
    expect(quotaWindowStart(aligned + 3_600_000, hour)).toBe(aligned + 3_600_000)
  })

  it('하루 창도 같은 규칙이다', () => {
    const day = 86_400
    const now = 1_700_000_000_000

    expect(quotaWindowStart(now, day) % 86_400_000).toBe(0)
    expect(quotaWindowStart(now, day)).toBe(Math.floor(now / 86_400_000) * 86_400_000)
  })
})

describe('makeQuotaLimits', () => {
  it('translate 는 설치 200/h, IP 100/h, 전역 10000/day 다', async () => {
    const limits = await makeQuotaLimits('translate', 'install-1', '203.0.113.7')

    expect(limits).toEqual([
      {
        bucket: sha256('translate:install:install-1'),
        limit: 200,
        windowSeconds: 3600,
      },
      {
        bucket: sha256('translate:ip:203.0.113.7'),
        limit: 100,
        windowSeconds: 3600,
      },
      {
        bucket: sha256('translate:global'),
        limit: 10000,
        windowSeconds: 86400,
      },
    ])
  })

  it('dictionary 는 설치 600/h, IP 300/h, 전역 30000/day 다', async () => {
    const limits = await makeQuotaLimits('dictionary', 'install-2', '198.51.100.9')

    expect(limits).toEqual([
      {
        bucket: sha256('dictionary:install:install-2'),
        limit: 600,
        windowSeconds: 3600,
      },
      {
        bucket: sha256('dictionary:ip:198.51.100.9'),
        limit: 300,
        windowSeconds: 3600,
      },
      {
        bucket: sha256('dictionary:global'),
        limit: 30000,
        windowSeconds: 86400,
      },
    ])
  })

  it('IP 가 비어 있으면 unknown 으로 묶는다', async () => {
    const empty = await makeQuotaLimits('translate', 'install-1', '')
    const spaces = await makeQuotaLimits('translate', 'install-1', '   ')

    const unknown = sha256('translate:ip:unknown')
    expect(empty[1].bucket).toBe(unknown)
    expect(spaces[1].bucket).toBe(unknown)
  })

  it('버킷은 원문을 담지 않는다', async () => {
    const ip = '203.0.113.7'
    const limits = await makeQuotaLimits('translate', 'install-1', ip)

    expect(limits.every((l) => /^[0-9a-f]{64}$/.test(l.bucket))).toBe(true)
    expect(limits.map((l) => l.bucket).join(' ')).not.toContain(ip)
  })
})

describe('enforceQuota', () => {
  const limits: QuotaLimit[] = [
    { bucket: 'a', limit: 10, windowSeconds: 60 },
    { bucket: 'b', limit: 20, windowSeconds: 3600 },
    { bucket: 'c', limit: 30, windowSeconds: 86400 },
  ]

  it('모든 버킷을 순서대로 소비하고 통과하면 true 다', async () => {
    const consume = vi.fn(async () => true)

    await expect(enforceQuota(consume, limits)).resolves.toBe(true)

    expect(consume.mock.calls).toEqual([
      ['a', 10, 60],
      ['b', 20, 3600],
      ['c', 30, 86400],
    ])
  })

  it('하나라도 거부되면 즉시 false 로 멈춘다', async () => {
    const consume = vi.fn(async (bucket: string) => bucket !== 'b')

    await expect(enforceQuota(consume, limits)).resolves.toBe(false)

    expect(consume).toHaveBeenCalledTimes(2)
    expect(consume.mock.calls.map(([bucket]) => bucket)).toEqual(['a', 'b'])
  })

  it('소비 중 오류는 삼키지 않는다', async () => {
    // 호출자가 503 으로 바꿔야 하므로 여기서 false 로 숨기면 안 된다.
    const boom = new Error('rpc unavailable')
    const consume = vi.fn(async () => {
      throw boom
    })

    await expect(enforceQuota(consume, limits)).rejects.toBe(boom)
  })
})
