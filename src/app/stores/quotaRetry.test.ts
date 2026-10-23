import { describe, expect, it } from 'vitest'

import { quotaRetryDelayMs } from './sync'
import type { SyncReport } from '../../lib/sync/types'

const SIX_HOURS = 6 * 60 * 60 * 1000

function report(over: Partial<SyncReport> = {}): SyncReport {
  return {
    projectionPausedReason: 'quota',
    projectionQuotaRetryAfterSeconds: 42,
    ...over,
  } as unknown as SyncReport
}

describe('quota retry backoff', () => {
  it('waits the server retry window plus a small boundary buffer', () => {
    expect(quotaRetryDelayMs(report())).toBe(43_000)
  })

  it('caps a day-long complete-sync window so it is rechecked sooner', () => {
    expect(quotaRetryDelayMs(report({ projectionQuotaRetryAfterSeconds: 86_400 }))).toBe(SIX_HOURS)
  })

  it('schedules nothing when the pause was not a quota or has no window', () => {
    expect(quotaRetryDelayMs(null)).toBeNull()
    expect(quotaRetryDelayMs(report({ projectionPausedReason: 'bytes' }))).toBeNull()
    expect(quotaRetryDelayMs(report({ projectionQuotaRetryAfterSeconds: null }))).toBeNull()
    expect(quotaRetryDelayMs(report({ projectionQuotaRetryAfterSeconds: 0 }))).toBeNull()
    expect(
      quotaRetryDelayMs(report({ projectionQuotaRetryAfterSeconds: Number.NaN })),
    ).toBeNull()
  })
})
