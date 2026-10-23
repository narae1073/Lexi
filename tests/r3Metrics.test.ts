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
    ]) {
      expect(snapshot).toHaveProperty(key)
    }

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
  })
})
