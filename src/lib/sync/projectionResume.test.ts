import { describe, expect, it } from 'vitest'

import {
  pauseCanResume,
  pauseRetryDelayMs,
  shouldAutoResumeProjection,
  shouldResumePausedProjection,
  type ProjectionNetwork,
} from './projectionResume'
import type { ProjectionPause, ProjectionStateMap } from './projectionState'

const wifi: ProjectionNetwork = {
  online: true,
  saveData: false,
  effectiveType: '4g',
  connectionType: 'wifi',
}

function pause(over: Partial<ProjectionPause> = {}): ProjectionPause {
  return {
    reason: 'bytes',
    pausedAt: '2026-10-27T12:00:00.000Z',
    nextAttemptAt: null,
    quotaBucket: null,
    retryAfterSeconds: null,
    ...over,
  }
}

describe('projection auto-resume network policy', () => {
  it('resumes silently on an unmetered connection', () => {
    expect(shouldAutoResumeProjection(wifi)).toBe(true)
    expect(
      shouldAutoResumeProjection({
        online: true,
        saveData: false,
        effectiveType: '4g',
        connectionType: undefined,
      }),
    ).toBe(true)
  })

  it('does not auto-resume offline, on saveData, or on a reported cellular link', () => {
    expect(shouldAutoResumeProjection({ ...wifi, online: false })).toBe(false)
    expect(shouldAutoResumeProjection({ ...wifi, saveData: true })).toBe(false)
    expect(shouldAutoResumeProjection({ ...wifi, connectionType: 'cellular' })).toBe(false)
  })

  it('treats slow effective connections as consent-required even when the link type is unknown', () => {
    for (const effectiveType of ['slow-2g', '2g', '3g']) {
      expect(shouldAutoResumeProjection({ ...wifi, effectiveType, connectionType: undefined })).toBe(
        false,
      )
    }
  })
})

describe('visibility resume decision', () => {
  const now = Date.parse('2026-10-27T12:00:30.000Z')
  const state = (value: ProjectionPause | undefined): ProjectionStateMap => ({
    fr: {
      complete: false,
      snapshot: '2026-10-27T12:00:00.000Z',
      cursor: null,
      hydratedAt: null,
      ...(value ? { pause: value } : {}),
    },
  })

  it('resumes a due pause only on an allowed connection', () => {
    expect(shouldResumePausedProjection(state(pause()), wifi, now)).toBe(true)
    expect(shouldResumePausedProjection(state(pause()), { ...wifi, saveData: true }, now)).toBe(
      false,
    )
    expect(
      shouldResumePausedProjection(
        state(pause({ reason: 'quota', nextAttemptAt: '2026-10-27T12:01:00.000Z' })),
        wifi,
        now,
      ),
    ).toBe(false)
    expect(
      shouldResumePausedProjection(
        state(pause({ reason: 'quota', nextAttemptAt: '2026-10-27T12:00:00.000Z' })),
        wifi,
        now,
      ),
    ).toBe(true)
    expect(shouldResumePausedProjection(state(undefined), wifi, now)).toBe(false)
  })
})

describe('projection pause retry timing', () => {
  const now = Date.parse('2026-10-27T12:00:30.000Z')

  it('waits for a quota window that is still open', () => {
    expect(
      pauseRetryDelayMs(
        pause({
          reason: 'quota',
          quotaBucket: 'page',
          retryAfterSeconds: 42,
          nextAttemptAt: '2026-10-27T12:01:13.000Z',
        }),
        now,
      ),
    ).toBe(43_000)
  })

  it('resumes immediately once the quota window has elapsed', () => {
    expect(
      pauseRetryDelayMs(
        pause({
          reason: 'quota',
          nextAttemptAt: '2026-10-27T12:00:00.000Z',
        }),
        now,
      ),
    ).toBe(0)
  })

  it('only offers consent once a quota or restart window has elapsed', () => {
    expect(
      pauseCanResume(
        pause({
          reason: 'quota',
          nextAttemptAt: '2026-10-27T12:01:13.000Z',
        }),
        now,
      ),
    ).toBe(false)
    expect(
      pauseCanResume(
        pause({
          reason: 'quota',
          nextAttemptAt: '2026-10-27T12:00:00.000Z',
        }),
        now,
      ),
    ).toBe(true)
    expect(pauseCanResume(pause({ reason: 'bytes' }), now)).toBe(true)
    expect(pauseCanResume(undefined, now)).toBe(true)
  })

  it('uses the persisted state-restart delay and has none for byte/offline pauses', () => {
    expect(
      pauseRetryDelayMs(
        pause({
          reason: 'state',
          nextAttemptAt: '2026-10-27T12:00:35.000Z',
        }),
        now,
      ),
    ).toBe(5_000)
    expect(pauseRetryDelayMs(pause({ reason: 'bytes' }), now)).toBeNull()
    expect(pauseRetryDelayMs(pause({ reason: 'offline' }), now)).toBeNull()
    expect(pauseRetryDelayMs(undefined, now)).toBeNull()
  })
})
