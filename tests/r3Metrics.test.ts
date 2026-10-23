import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const SCRIPT = 'scripts/r3-metrics.mjs'

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
  })
}

function numbers(value: unknown, path = '$'): Array<[string, number]> {
  if (typeof value === 'number') return [[path, value]]
  if (Array.isArray(value)) return value.flatMap((entry, index) => numbers(entry, `${path}[${index}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      numbers(entry, `${path}.${key}`),
    )
  }
  return []
}

describe('r3 metrics snapshot', () => {
  it('documents the pre-public dashboard and alerts in --help', () => {
    const result = run(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/read-only/i)
    expect(result.stdout).toMatch(/dashboard/i)
    expect(result.stdout).toMatch(/alert/i)
    expect(result.stdout).toMatch(/60/)
    expect(result.stdout).toMatch(/2/)
  })

  it('refuses a non-local target unless --allow-remote is passed', () => {
    const result = run(['--url', 'https://abcdefghijklmnop.supabase.co'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/refus/i)
    expect(result.stderr).not.toMatch(/ECONNREFUSED/)
  })

  it('emits a complete, non-negative snapshot without touching a database in self-test mode', () => {
    const result = run(['--self-test'])
    expect(result.status).toBe(0)

    const snapshot = JSON.parse(result.stdout) as Record<string, unknown>
    expect(snapshot.readOnly).toBe(true)
    expect(snapshot.kind).toBe('metrics')
    expect(snapshot.incomplete).toBe(false)

    for (const key of [
      'refresh',
      'noopSuppression',
      'rowsTouched',
      'deadlocks',
      'storage',
      'pull',
      'firstSync',
      'egressPerNewDevice',
      'database',
      'sources',
      'windows',
      'loadRun',
      'alerts',
    ]) {
      expect(snapshot).toHaveProperty(key)
    }

    const pull = snapshot.pull as Record<string, unknown>
    expect(pull.window).toBe('24h')
    expect((snapshot.egressPerNewDevice as Record<string, unknown>).window).toBe('24h')

    const measured = numbers(snapshot)
    expect(measured.length).toBeGreaterThan(20)
    for (const [path, value] of measured) {
      expect(Number.isFinite(value), `${path} is not finite`).toBe(true)
      expect(value, `${path} is negative`).toBeGreaterThanOrEqual(0)
    }

    const refresh = snapshot.refresh as Record<string, number>
    for (const percentile of ['p50Ms', 'p95Ms', 'p99Ms']) {
      expect(refresh).toHaveProperty(percentile)
    }

    // A healthy, non-smoke, non-stale load must not carry a failure message.
    const sources = snapshot.sources as Record<string, { ok: boolean; error: string | null }>
    expect(sources.loadResult.ok).toBe(true)
    expect(sources.loadResult.error).toBeNull()
    expect((snapshot.loadRun as Record<string, unknown>).used).toBe(true)
  })

  it('never uses a fresh smoke load for the refresh gate', () => {
    const result = run(['--self-test-smoke'])
    expect(result.status).toBe(0)

    const snapshot = JSON.parse(result.stdout) as {
      loadRun: { smoke: boolean; nonGating: boolean; used: boolean }
      sources: Record<string, { ok: boolean; error: string | null }>
      alerts: Array<{ name: string; status: string; ok: boolean | null }>
    }

    expect(snapshot.loadRun.smoke).toBe(true)
    expect(snapshot.loadRun.nonGating).toBe(true)
    expect(snapshot.loadRun.used).toBe(false)
    expect(snapshot.sources.loadResult.ok).toBe(false)
    expect(snapshot.sources.loadResult.error).toMatch(/smoke/i)

    const p95 = snapshot.alerts.find((alert) => alert.name === 'refresh-p95')
    expect(p95?.status).toBe('unknown')
    expect(p95?.ok).toBeNull()
  })

  it('marks failed sources and dependent alerts unknown instead of green', () => {
    const result = run(['--self-test-incomplete'])
    expect(result.status).toBe(0)

    const snapshot = JSON.parse(result.stdout) as {
      incomplete: boolean
      sources: Record<string, { ok: boolean; error: string | null; stale?: boolean; used?: boolean }>
      alerts: Array<{ name: string; status: string; ok: boolean | null }>
    }

    expect(snapshot.incomplete).toBe(true)
    expect(snapshot.sources.storage.ok).toBe(false)
    expect(snapshot.sources.refresh.ok).toBe(false)
    expect(snapshot.sources.loadResult.ok).toBe(false)
    expect(snapshot.sources.loadResult.stale).toBe(true)
    expect(snapshot.sources.loadResult.used).toBe(false)
    // A null query result is an explicit failure, not an undefined-but-green
    // section.
    expect(snapshot.sources.deadlocks.ok).toBe(false)
    expect(snapshot.sources.deadlocks.error).toBe('query returned no result')

    const byName = new Map(snapshot.alerts.map((alert) => [alert.name, alert]))
    expect(byName.get('sources-complete')?.status).toBe('fail')
    expect(byName.get('projection-present')?.status).toBe('unknown')
    expect(byName.get('projection-present')?.ok).toBeNull()
    expect(byName.get('refresh-p95')?.status).toBe('unknown')
    expect(byName.get('noop-suppression')?.status).toBe('unknown')
    expect(byName.get('deadlocks')?.status).toBe('unknown')
  })
})
