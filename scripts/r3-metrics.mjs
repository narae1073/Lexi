#!/usr/bin/env node
/**
 * R3 pre-public metrics snapshot — READ-ONLY.
 *
 *   node scripts/r3-metrics.mjs
 *   node scripts/r3-metrics.mjs --json --out /tmp/opencode/r3-metrics.json
 *   node scripts/r3-metrics.mjs --help
 *
 * This script never writes to the database. Every SQL statement runs inside a
 * read-only transaction (`begin read only; ...; commit;`), so an accidental
 * write fails instead of touching a target. It reads:
 *
 *   - pg_stat_statements     refresh and projection-pull statement timing
 *   - pg_stat_user_tables    rows written by the projection hot path
 *   - pg_stat_database       deadlocks
 *   - pg_stat_activity       connections
 *   - pg_class / pg_stats    projection table and index bytes, row width
 *   - projection_usage       pull pages/rows, resumes, 429s, finished passes (24h)
 *   - projection_sync_passes complete-sync starts (2/day limit, first-sync)
 *   - the newest /tmp/opencode/r3-load-*.json only when it is < 24h old, for
 *     true refresh p50/p95/p99 and no-op suppression. Stale artifacts are
 *     reported but never used, so an old green run cannot mask a regression.
 *
 * Pre-public dashboard (one row per run; keep 30 days)
 *   refresh p50/p95/p99 ms | no-op attempts/writes | rows touched |
 *   deadlocks | projection table/index bytes | 24h pull pages/bytes/resumes/429s |
 *   24h first-sync completion | 24h egress per new device | DB CPU/connections.
 *   Every section names its window; cumulative statistics are labelled
 *   `since stats reset` rather than mixed with the 24h counters.
 *
 * Alerts (all are published in the JSON `alerts` array)
 *   1. refresh p95 >= 100 ms or p99 >= 250 ms        (R3 load gate)
 *   2. deadlocks > 0
 *   3. no-op phase wrote a projection or document row
 *   4. pull bytes per page > 1 MB                     (page-size target)
 *   5. 429s > 1% of pages (once there are >= 100 pages)
 *   6. first-sync completion < 90% (once >= 20 started users)
 *   7. egress per new device > 64 MB                   (soft projection budget)
 *   8. DB CPU >= 80% or connections >= 80% of max_connections
 *   9. projection has no rows while documents exist    (row count, not size)
 *
 * Fail-closed reporting: each source is recorded in `sources`; a failed or
 * missing required source sets `incomplete: true` and makes every dependent
 * alert `status: "unknown"`, `ok: null` instead of a green pass. `sources-
 * complete` fails explicitly. Sample-size gates report `insufficient`.
 *
 * The limits this snapshot watches: 60 projection pages per user per minute
 * and 2 complete projection syncs per user per UTC day
 * (supabase/migrations/20261028000001_projection_quota.sql and
 * 20261028000002_projection_quota_state.sql).
 *
 * A non-loopback URL is refused unless `--allow-remote` is passed explicitly.
 * Remote runs also need `--database-url` (and a psql client); the local default
 * uses the `supabase_db_<project>` Docker container.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CONFIG_TOML = join(REPO_ROOT, 'supabase', 'config.toml')
const DEFAULT_URL = 'http://127.0.0.1:54321'
const DEFAULT_RESULT_DIR = '/tmp/opencode'

export const PAGE_LIMIT_PER_MINUTE = 60
export const COMPLETE_SYNCS_PER_DAY = 2
const REFRESH_P95_LIMIT_MS = 100
const REFRESH_P99_LIMIT_MS = 250
const PAGE_BYTE_TARGET = 1024 * 1024
const PROJECTION_EGRESS_BUDGET = 64 * 1024 * 1024

const USAGE = `Usage: node scripts/r3-metrics.mjs [options]

Read-only R3 metrics snapshot. Defaults to the local Supabase stack.

  --url URL            Supabase API URL to report (default ${DEFAULT_URL})
  --db-container NAME  local Postgres container (default supabase_db_<project>)
  --database-url URL   remote Postgres URL; requires --allow-remote
  --allow-remote       explicitly allow a non-loopback target
  --result-dir DIR     where r3-load-*.json runs are read (default ${DEFAULT_RESULT_DIR})
  --out FILE           also write the JSON snapshot to FILE
  --self-test          emit a synthetic healthy snapshot without touching any database
  --self-test-incomplete  emit a snapshot with failed sources + a stale load result
  --help               print this help

Read-only guarantee
  Every query runs in a READ ONLY transaction. This script has no write path.

Dashboard fields
  refresh.p50Ms/p95Ms/p99Ms, noopSuppression, rowsTouched, deadlocks,
  storage.projectionBytes/projectionIndexBytes, pull.bytes/pages/resumes/
  rateLimited429, firstSync, egressPerNewDevice, database.cpuPercent/
  connections.

Alerts
  p95 >= ${REFRESH_P95_LIMIT_MS} ms, p99 >= ${REFRESH_P99_LIMIT_MS} ms, any deadlock, a no-op write,
  > ${PAGE_BYTE_TARGET} bytes/page, 429s > 1% of pages, first-sync completion < 90%,
  egress/new device > ${Math.round(PROJECTION_EGRESS_BUDGET / 1024 / 1024)} MB, DB CPU or connections >= 80%, and an empty
  projection while documents exist.

Limits watched: ${PAGE_LIMIT_PER_MINUTE} projection pages/user/minute and
${COMPLETE_SYNCS_PER_DAY} complete projection syncs/user/day.
`

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const key = arg.slice(2)
    if (
      key === 'help' ||
      key === 'allow-remote' ||
      key === 'self-test' ||
      key === 'self-test-incomplete'
    ) {
      flags[key] = true
      continue
    }
    const equals = key.indexOf('=')
    if (equals !== -1) {
      flags[key.slice(0, equals)] = key.slice(equals + 1)
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    flags[key] = value
    index += 1
  }
  return flags
}

function projectIdFromConfig() {
  try {
    const text = readFileSync(CONFIG_TOML, 'utf8')
    const match = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(text)
    if (match) return match[1]
  } catch {
    // Fall through to the compose-style default.
  }
  return 'translator'
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}

/**
 * Refuses a production/non-local target unless the operator opted in.
 *
 * `--allow-remote` is intentionally not implied by anything else: one flag,
 * one explicit decision, and the resulting snapshot records that it was used.
 */
export function resolveTarget(flags) {
  const rawUrl = flags.url ?? process.env.SUPABASE_URL ?? DEFAULT_URL
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid Supabase URL: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported Supabase URL protocol: ${url.protocol}`)
  }

  const allowRemote = flags['allow-remote'] === true
  const localUrl = isLoopbackHost(url.hostname)
  if (!localUrl && !allowRemote) {
    throw new Error(
      `Refusing non-local/production target ${rawUrl}. ` +
        'Pass --allow-remote explicitly when you really mean it.',
    )
  }

  const databaseUrl = flags['database-url']
  if (databaseUrl) {
    let parsed
    try {
      parsed = new URL(databaseUrl)
    } catch {
      throw new Error('Invalid --database-url')
    }
    if (!isLoopbackHost(parsed.hostname) && !allowRemote) {
      throw new Error(
        `Refusing non-local/production database ${parsed.hostname}. ` +
          'Pass --allow-remote explicitly when you really mean it.',
      )
    }
  } else if (!localUrl) {
    throw new Error(
      'A remote target needs --database-url. The Docker psql shortcut only ' +
        'works against the local stack.',
    )
  }

  return {
    url: url.toString().replace(/\/$/, ''),
    local: localUrl,
    allowRemote,
    databaseUrl: databaseUrl ?? null,
    dbContainer:
      flags['db-container'] ??
      process.env.R3_DB_CONTAINER ??
      `supabase_db_${projectIdFromConfig()}`,
  }
}

function readOnly(sql) {
  const statement = sql.trim().replace(/;+$/, '')
  return `begin read only;\n${statement};\ncommit;`
}

function psqlLocal(container, sql, label) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-X',
      '-q',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      readOnly(sql),
    ],
    { encoding: 'utf8', timeout: 60_000 },
  )
  if (result.status !== 0) {
    throw new Error(`psql failed for ${label}: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

function psqlRemote(databaseUrl, sql, label) {
  const result = spawnSync(
    'psql',
    ['--dbname', databaseUrl, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', readOnly(sql)],
    { encoding: 'utf8', timeout: 60_000 },
  )
  if (result.error) {
    throw new Error(
      `Remote metrics need a psql client on PATH (${result.error.code ?? result.error.message}).`,
    )
  }
  if (result.status !== 0) {
    throw new Error(`psql failed for ${label}: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

function queryJson(target, sql, label) {
  try {
    const output =
      target.databaseUrl === null
        ? psqlLocal(target.dbContainer, sql, label)
        : psqlRemote(target.databaseUrl, sql, label)
    // `-q -t -A` leaves command tags out, but a future psql may still print
    // BEGIN/COMMIT. Pick the JSON line rather than assuming it is last.
    const line = output
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('{') || entry.startsWith('['))
    return line ? JSON.parse(line) : null
  } catch (error) {
    return { __error: error instanceof Error ? error.message : String(error) }
  }
}

function failed(value) {
  return value === null || value === undefined || typeof value.__error === 'string'
}

function readContainerCpu(container) {
  const result = spawnSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.CPUPerc}}', container],
    { encoding: 'utf8', timeout: 15_000 },
  )
  if (result.status !== 0) return null
  const value = Number.parseFloat(result.stdout.replace('%', '').trim())
  return Number.isFinite(value) ? value : null
}

function latestLoadResult(resultDir) {
  try {
    const files = readdirSync(resultDir)
      .filter((name) => /^r3-load-.*\.json$/.test(name))
      .map((name) => ({ name, path: join(resultDir, name), at: statSync(join(resultDir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    if (files.length === 0) return null

    // Prefer the newest non-smoke run: smoke checks structure only and is not
    // a performance gate. Fall back to the newest smoke run, labelled as such.
    let fallback = null
    for (const file of files) {
      try {
        const parsed = JSON.parse(readFileSync(file.path, 'utf8'))
        if (parsed.smoke !== true) return { ...parsed, path: file.path }
        fallback ??= { ...parsed, path: file.path }
      } catch {
        // Ignore an unreadable artifact and try the next one.
      }
    }
    return fallback
  } catch {
    return null
  }
}

export function collectRaw(target, resultDir = DEFAULT_RESULT_DIR) {
  const refresh = queryJson(
    target,
    `select json_build_object(
       'calls', coalesce(sum(calls), 0),
       'meanMs', case when coalesce(sum(calls), 0) > 0
                      then sum(total_exec_time) / sum(calls) else 0 end,
       'stddevMs', coalesce(max(stddev_exec_time), 0),
       'maxMs', coalesce(max(max_exec_time), 0)
     ) as value
     from pg_stat_statements
     where query ~* 'refresh_wordbook|replace_word_occurrences'`,
    'refresh timing',
  )

  const statements = queryJson(
    target,
    `select json_build_object(
       'calls', coalesce(sum(calls), 0),
       'rows', coalesce(sum(rows), 0)
     ) as value
     from pg_stat_statements
     where query ~* '^\\s*select'
       and query ~* 'get_wordbook_projection_page'`,
    'projection pull statements',
  )

  const rowsTouched = queryJson(
    target,
    `select json_build_object(
       'documents', coalesce((select n_tup_ins + n_tup_upd + n_tup_del
                              from pg_stat_user_tables
                              where schemaname = 'public' and relname = 'documents'), 0),
       'wordOccurrences', coalesce((select n_tup_ins + n_tup_upd + n_tup_del
                                    from pg_stat_user_tables
                                    where schemaname = 'public' and relname = 'word_occurrences'), 0),
       'wordbookEntries', coalesce((select n_tup_ins + n_tup_upd + n_tup_del
                                    from pg_stat_user_tables
                                    where schemaname = 'public' and relname = 'wordbook_entries'), 0)
     ) as value`,
    'rows touched',
  )

  const deadlocks = queryJson(
    target,
    `select json_build_object(
       'database', coalesce(sum(deadlocks), 0)
     ) as value
     from pg_stat_database
     where datname = current_database()`,
    'deadlocks',
  )

  const storage = queryJson(
    target,
    `select json_build_object(
       'projectionBytes', coalesce(pg_total_relation_size('public.wordbook_entries'), 0),
       'projectionIndexBytes', coalesce(pg_indexes_size('public.wordbook_entries'), 0),
       'rowWidthBytes', coalesce(
         (select sum(avg_width) from pg_stats
          where schemaname = 'public' and tablename = 'wordbook_entries'),
         (select coalesce(avg(pg_column_size(t)), 0)::bigint
          from public.wordbook_entries t),
         0
       ),
       'projectionRows', coalesce((select count(*) from public.wordbook_entries), 0),
       'documents', coalesce((select count(*) from public.documents), 0)
     ) as value`,
    'projection storage',
  )

  const usage = queryJson(
    target,
    `select json_build_object(
       'pages', coalesce(sum(count) filter (where bucket = 'projection_page'), 0),
       'rows', coalesce(sum(count) filter (where bucket = 'projection_rows'), 0),
       'resumes', coalesce(sum(count) filter (where bucket = 'projection_page_resume'), 0),
       'denied', coalesce(sum(count) filter (where bucket = 'projection_quota_denied'), 0),
       'deniedSync', coalesce(sum(count) filter (where bucket = 'projection_quota_denied_sync'), 0),
       'completeSyncs', 0,
       'completedPasses', coalesce(sum(count) filter (where bucket = 'projection_sync_complete'), 0),
       'startedUsers', coalesce((
         select count(distinct user_id) from public.projection_usage
         where bucket = 'projection_page'
           and window_start >= now() - interval '24 hours'
       ), 0),
       'completedUsers', coalesce((
         select count(distinct user_id) from public.projection_usage
         where bucket = 'projection_sync_complete'
           and window_start >= now() - interval '24 hours'
       ), 0)
     ) as value
     from public.projection_usage
     where window_start >= now() - interval '24 hours'`,
    'projection usage',
  )

  const syncPasses = queryJson(
    target,
    `select json_build_object(
       'completeSyncs', coalesce((
         select count(distinct snapshot) from public.projection_sync_passes
         where started_at >= now() - interval '24 hours'
       ), 0),
       'startedUsers', coalesce((
         select count(distinct user_id) from public.projection_sync_passes
         where started_at >= now() - interval '24 hours'
       ), 0)
     ) as value`,
    'projection sync passes',
  )

  const users = queryJson(
    target,
    `select json_build_object(
       'total', coalesce((select count(*) from auth.users), 0)
     ) as value`,
    'users',
  )

  const connections = queryJson(
    target,
    `select json_build_object(
       'connections', count(*),
       'activeConnections', count(*) filter (where state = 'active'),
       'maxConnections', current_setting('max_connections')::int
     ) as value
     from pg_stat_activity`,
    'connections',
  )

  return {
    capturedAt: new Date().toISOString(),
    refresh: failed(refresh) ? { __error: refresh?.__error } : refresh,
    statements: failed(statements) ? { __error: statements?.__error } : statements,
    rowsTouched: failed(rowsTouched) ? { __error: rowsTouched?.__error } : rowsTouched,
    deadlocks: failed(deadlocks) ? { __error: deadlocks?.__error } : deadlocks,
    storage: failed(storage) ? { __error: storage?.__error } : storage,
    usage: failed(usage) ? { __error: usage?.__error } : usage,
    syncPasses: failed(syncPasses) ? { __error: syncPasses?.__error } : syncPasses,
    users: failed(users) ? { __error: users?.__error } : users,
    connections: failed(connections) ? { __error: connections?.__error } : connections,
    cpuPercent: target.local ? readContainerCpu(target.dbContainer) : null,
    load: latestLoadResult(resultDir),
  }
}

/** Clamp every snapshot number to a finite, non-negative value. */
function nonNegative(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return number
}

function rounded(value) {
  return Math.round(nonNegative(value) * 100) / 100
}

function refreshPercentiles(raw, loadUsable) {
  const loadSummary = raw.load?.effective?.summary
  if (loadUsable && typeof loadSummary?.p50 === 'number' && Number.isFinite(loadSummary.p50)) {
    return {
      available: true,
      p50Ms: rounded(loadSummary.p50),
      p95Ms: rounded(loadSummary.p95),
      p99Ms: rounded(loadSummary.p99),
      calls: nonNegative(raw.load?.effective?.attempts),
      meanMs: rounded(loadSummary.mean),
      maxMs: rounded(loadSummary.max),
      estimated: false,
      source: `fresh load result ${String(raw.load?.path ?? '')}${raw.load?.smoke === true ? ' (smoke; not a gate)' : ''}`,
    }
  }

  const calls = nonNegative(raw.refresh?.calls)
  const mean = nonNegative(raw.refresh?.meanMs)
  const stddev = nonNegative(raw.refresh?.stddevMs)
  const max = nonNegative(raw.refresh?.maxMs)
  const p95 = Math.min(max > 0 ? max : Number.POSITIVE_INFINITY, mean + 1.645 * stddev)
  const p99 = Math.min(max > 0 ? max : Number.POSITIVE_INFINITY, mean + 2.326 * stddev)
  return {
    available: calls > 0,
    p50Ms: rounded(mean),
    p95Ms: rounded(p95 === Number.POSITIVE_INFINITY ? mean : p95),
    p99Ms: rounded(p99 === Number.POSITIVE_INFINITY ? mean : p99),
    calls,
    meanMs: rounded(mean),
    maxMs: rounded(max),
    estimated: true,
    source:
      calls > 0
        ? 'pg_stat_statements (mean/stddev/max; run r3:load for true percentiles)'
        : 'unavailable (no fresh load result and no refresh samples)',
  }
}

function sectionStatus(raw, name) {
  const value = raw[name]
  if (value === null || value === undefined) return { ok: false, error: `${name} missing` }
  if (typeof value.__error === 'string') return { ok: false, error: value.__error }
  return { ok: true, error: null }
}

export function buildSnapshot(raw, target) {
  const sources = {}
  const addSource = (name, { required = true, ok = true, error = null } = {}) => {
    sources[name] = { ok: Boolean(ok), required, error }
    return sources[name]
  }

  for (const name of [
    'refresh',
    'statements',
    'rowsTouched',
    'deadlocks',
    'storage',
    'usage',
    'syncPasses',
    'users',
    'connections',
  ]) {
    const status = sectionStatus(raw, name)
    addSource(name, status)
  }

  const cpuAvailable = typeof raw.cpuPercent === 'number' && Number.isFinite(raw.cpuPercent)
  addSource('cpu', {
    required: false,
    ok: cpuAvailable,
    error: cpuAvailable ? null : 'CPU unavailable (remote target or docker stats failed)',
  })

  const load = raw.load ?? null
  const loadAt = load ? Date.parse(load.completedAt ?? load.startedAt ?? '') : Number.NaN
  const loadAgeHours = Number.isFinite(loadAt) ? (Date.now() - loadAt) / 3_600_000 : null
  const loadStale = load === null || loadAgeHours === null || loadAgeHours > 24
  const loadSummary = load?.effective?.summary
  const loadUsable =
    load !== null &&
    !loadStale &&
    typeof loadSummary?.p50 === 'number' &&
    Number.isFinite(loadSummary.p50)
  const loadSource = addSource('loadResult', {
    required: false,
    ok: loadUsable,
    error:
      load === null
        ? 'no r3-load result'
        : loadStale
          ? 'stale r3-load result (>24h); ignored for percentiles and no-op checks'
          : 'r3-load result has no percentile summary',
  })
  loadSource.stale = load === null ? false : loadStale
  loadSource.used = loadUsable
  loadSource.path = load?.path ?? null
  loadSource.ageHours = loadAgeHours === null ? null : rounded(loadAgeHours)

  const refresh = refreshPercentiles(raw, loadUsable)
  if (!refresh.available) {
    sources.refresh.ok = false
    sources.refresh.error =
      'no refresh samples (pg_stat_statements empty and no fresh load result)'
  }

  const storage = raw.storage ?? {}
  const usage = raw.usage ?? {}
  const rowWidth = nonNegative(storage.rowWidthBytes)
  const pages = nonNegative(usage.pages)
  const pullRows = nonNegative(usage.rows)
  const pullBytes = rounded(pullRows * rowWidth)
  const bytesPerPage = pages > 0 ? rounded(pullBytes / pages) : 0
  const resumes = nonNegative(usage.resumes)
  const denied = nonNegative(usage.denied) + nonNegative(usage.deniedSync)
  const startedUsers =
    nonNegative(raw.syncPasses?.startedUsers) || nonNegative(usage.startedUsers)
  const completedUsers = nonNegative(usage.completedUsers)
  const completeSyncs =
    nonNegative(raw.syncPasses?.completeSyncs) || nonNegative(usage.completeSyncs)
  const totalUsers = nonNegative(raw.users?.total)
  const newDevices = completedUsers
  const egressPerNewDevice = newDevices > 0 ? rounded(pullBytes / newDevices) : 0

  const noopAttempts = nonNegative(load?.noop?.attempts)
  const noopProjectionWrites = nonNegative(load?.noop?.writes?.projectionWrites)
  const noopDocumentWrites = nonNegative(load?.noop?.writes?.documentsWrites)
  const loadDeadlocks = loadUsable
    ? nonNegative(load?.effective?.deadlocks) + nonNegative(load?.noop?.deadlocks)
    : 0
  const databaseDeadlocks = nonNegative(raw.deadlocks?.database)
  const connections = nonNegative(raw.connections?.connections)
  const activeConnections = nonNegative(raw.connections?.activeConnections)
  const maxConnections = nonNegative(raw.connections?.maxConnections)
  const projectionBytes = nonNegative(storage.projectionBytes)
  const projectionIndexBytes = nonNegative(storage.projectionIndexBytes)
  const projectionRows = nonNegative(storage.projectionRows)
  const documents = nonNegative(storage.documents)

  const incomplete = Object.values(sources).some((source) => !source.ok)
  const incompleteCount = Object.values(sources).filter((source) => !source.ok).length

  const alerts = []
  const addAlert = (name, dependsOn, compute, message) => {
    const missing = dependsOn.filter((source) => !sources[source]?.ok)
    if (missing.length > 0) {
      alerts.push({
        name,
        status: 'unknown',
        ok: null,
        dependsOn,
        missing,
        message,
      })
      return
    }
    const result = compute()
    alerts.push({
      name,
      status: result.status ?? (result.ok ? 'pass' : 'fail'),
      ok: result.ok,
      value: result.value,
      threshold: result.threshold,
      note: result.note,
      dependsOn,
      message,
    })
  }

  addAlert(
    'sources-complete',
    [],
    () => ({ ok: !incomplete, value: incompleteCount, threshold: 0 }),
    'every metrics source responded (optional failures also make the snapshot incomplete)',
  )
  addAlert(
    'refresh-p95',
    ['refresh'],
    () => ({ ok: refresh.p95Ms < REFRESH_P95_LIMIT_MS, value: refresh.p95Ms, threshold: REFRESH_P95_LIMIT_MS }),
    `refresh p95 stays below ${REFRESH_P95_LIMIT_MS} ms`,
  )
  addAlert(
    'refresh-p99',
    ['refresh'],
    () => ({ ok: refresh.p99Ms < REFRESH_P99_LIMIT_MS, value: refresh.p99Ms, threshold: REFRESH_P99_LIMIT_MS }),
    `refresh p99 stays below ${REFRESH_P99_LIMIT_MS} ms`,
  )
  addAlert(
    'deadlocks',
    ['deadlocks'],
    () => ({
      ok: databaseDeadlocks === 0 && loadDeadlocks === 0,
      value: databaseDeadlocks + loadDeadlocks,
      threshold: 0,
      note: loadUsable ? undefined : 'load-run deadlocks unavailable (no fresh load result)',
    }),
    'no deadlocks in the database snapshot or a fresh load run',
  )
  addAlert(
    'noop-suppression',
    ['loadResult'],
    () => ({
      ok: noopAttempts > 0 && noopProjectionWrites === 0 && noopDocumentWrites === 0,
      value: noopProjectionWrites + noopDocumentWrites,
      threshold: 0,
      note: noopAttempts === 0 ? 'no no-op attempts in the fresh load run' : undefined,
    }),
    'a fresh no-op phase must not write projection or document rows',
  )
  addAlert(
    'page-bytes',
    ['usage', 'storage'],
    () =>
      pages === 0
        ? { status: 'insufficient', ok: null, value: 0, threshold: PAGE_BYTE_TARGET, note: 'no pages in the 24h window' }
        : { ok: bytesPerPage <= PAGE_BYTE_TARGET, value: bytesPerPage, threshold: PAGE_BYTE_TARGET },
    'pull bytes per page stays within the 1 MB page target',
  )
  addAlert(
    'rate-limit-share',
    ['usage'],
    () =>
      pages < 100
        ? { status: 'insufficient', ok: null, value: pages > 0 ? denied / pages : 0, threshold: 0.01, note: 'fewer than 100 pages in the 24h window' }
        : { ok: denied / pages <= 0.01, value: denied / pages, threshold: 0.01 },
    '429s stay below 1% of pages',
  )
  addAlert(
    'first-sync-completion',
    ['usage', 'syncPasses', 'users'],
    () =>
      startedUsers < 20
        ? { status: 'insufficient', ok: null, value: startedUsers > 0 ? completedUsers / startedUsers : 0, threshold: 0.9, note: 'fewer than 20 started users in the 24h window' }
        : { ok: completedUsers / startedUsers >= 0.9, value: completedUsers / startedUsers, threshold: 0.9 },
    'at least 90% of started accounts finish a first projection',
  )
  addAlert(
    'egress-per-new-device',
    ['usage', 'storage'],
    () =>
      newDevices === 0
        ? { status: 'insufficient', ok: null, value: 0, threshold: PROJECTION_EGRESS_BUDGET, note: 'no completed first syncs in the 24h window' }
        : { ok: egressPerNewDevice <= PROJECTION_EGRESS_BUDGET, value: egressPerNewDevice, threshold: PROJECTION_EGRESS_BUDGET },
    'a new device stays within the 64 MB projection budget',
  )
  addAlert(
    'database-cpu',
    ['cpu'],
    () => ({ ok: nonNegative(raw.cpuPercent) < 80, value: nonNegative(raw.cpuPercent), threshold: 80 }),
    'DB container CPU stays below 80%',
  )
  addAlert(
    'connections',
    ['connections'],
    () =>
      maxConnections === 0
        ? { status: 'unknown', ok: null, value: connections, threshold: 0, note: 'max_connections unavailable' }
        : { ok: connections / maxConnections < 0.8, value: connections / maxConnections, threshold: 0.8 },
    'connections stay below 80% of max_connections',
  )
  addAlert(
    'projection-present',
    ['storage'],
    () => ({
      ok: !(documents > 0 && projectionRows === 0),
      value: projectionRows,
      threshold: 1,
      note: documents === 0 ? 'no documents to project' : undefined,
    }),
    'every account with documents has projection rows',
  )

  return {
    kind: 'metrics',
    readOnly: true,
    incomplete,
    generatedAt: String(raw.capturedAt ?? new Date().toISOString()),
    target: {
      url: target.url,
      database:
        target.databaseUrl === null ? `docker:${target.dbContainer}` : 'remote --database-url',
      local: target.local,
      allowRemote: target.allowRemote,
    },
    windows: {
      refresh: 'fresh load result (<24h), else pg_stat_statements since reset',
      pull: '24h projection_usage counters',
      firstSync: '24h',
      rowsTouched: 'since pg_stat_statements/user-table stats reset',
      deadlocks: 'since stats reset',
      storage: 'current',
      database: 'current gauge',
    },
    sources,
    limits: {
      pagesPerMinute: PAGE_LIMIT_PER_MINUTE,
      completeSyncsPerDay: COMPLETE_SYNCS_PER_DAY,
    },
    refresh,
    loadRun: {
      available: load !== null,
      path: load?.path ?? null,
      ageHours: loadAgeHours === null ? null : rounded(loadAgeHours),
      stale: load !== null ? loadStale : false,
      used: loadUsable,
    },
    noopSuppression: {
      attempts: noopAttempts,
      projectionWrites: noopProjectionWrites,
      documentWrites: noopDocumentWrites,
      suppressed: Math.max(0, noopAttempts - noopProjectionWrites),
      source: loadUsable
        ? String(load?.path ?? 'fresh load result')
        : 'unavailable (no fresh r3-load result)',
      window: 'fresh load run (<24h)',
    },
    rowsTouched: {
      documents: nonNegative(raw.rowsTouched?.documents),
      wordOccurrences: nonNegative(raw.rowsTouched?.wordOccurrences),
      wordbookEntries: nonNegative(raw.rowsTouched?.wordbookEntries),
      total:
        nonNegative(raw.rowsTouched?.documents) +
        nonNegative(raw.rowsTouched?.wordOccurrences) +
        nonNegative(raw.rowsTouched?.wordbookEntries),
      window: 'since stats reset',
    },
    deadlocks: {
      database: databaseDeadlocks,
      loadRun: loadDeadlocks,
      total: databaseDeadlocks + loadDeadlocks,
      window: 'database since stats reset; load run fresh (<24h)',
    },
    storage: {
      projectionBytes,
      projectionIndexBytes,
      projectionTableBytes: Math.max(0, projectionBytes - projectionIndexBytes),
      projectionRows,
      documents,
      rowWidthBytes: rowWidth,
      window: 'current',
    },
    pull: {
      window: '24h',
      bytes: pullBytes,
      pages,
      rows: pullRows,
      resumes,
      rateLimited429: denied,
      completeSyncs,
      completedPasses: nonNegative(usage.completedPasses),
      bytesPerPage,
      bytesEstimated: true,
      source: 'projection_usage (24h) x pg_stats row width; pg_stat_statements is shown separately',
      statements: {
        window: 'since pg_stat_statements reset',
        calls: nonNegative(raw.statements?.calls),
        rows: nonNegative(raw.statements?.rows),
      },
    },
    firstSync: {
      window: '24h',
      completedUsers,
      startedUsers,
      totalUsers,
      ratio: startedUsers > 0 ? Math.min(1, completedUsers / startedUsers) : 0,
    },
    egressPerNewDevice: {
      window: '24h',
      bytesPerNewDevice: egressPerNewDevice,
      newDevices,
      basis:
        '24h projection row bytes (projection_rows x pg_stats row width) divided by accounts that completed a full pass in the same 24h window',
    },
    database: {
      cpuPercent: rounded(raw.cpuPercent),
      connections,
      activeConnections,
      maxConnections,
      connectionUtilization: maxConnections > 0 ? rounded(connections / maxConnections) : 0,
      window: 'current gauge',
    },
    alerts,
  }
}

function syntheticRaw() {
  return {
    capturedAt: '2026-10-28T00:00:00.000Z',
    refresh: { calls: 100, meanMs: 40, stddevMs: 10, maxMs: 100 },
    statements: { calls: 1000, rows: 500_000 },
    rowsTouched: { documents: 100, wordOccurrences: 200_000, wordbookEntries: 100_000 },
    deadlocks: { database: 0 },
    storage: {
      projectionBytes: 113 * 1024 * 1024,
      projectionIndexBytes: 20 * 1024 * 1024,
      rowWidthBytes: 830,
      projectionRows: 100_000,
      documents: 1000,
    },
    usage: {
      pages: 1000,
      rows: 200_000,
      resumes: 100,
      denied: 2,
      deniedSync: 0,
      completeSyncs: 10,
      completedPasses: 4,
      startedUsers: 4,
      completedUsers: 4,
    },
    syncPasses: { completeSyncs: 10, startedUsers: 4 },
    users: { total: 4 },
    connections: { connections: 10, activeConnections: 2, maxConnections: 100 },
    cpuPercent: 12,
    load: {
      path: 'self-test-load',
      completedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      effective: {
        attempts: 100,
        deadlocks: 0,
        summary: { p50: 24, p95: 65, p99: 68, mean: 26, max: 70 },
      },
      noop: {
        attempts: 100,
        deadlocks: 0,
        writes: { projectionWrites: 0, documentsWrites: 0 },
      },
    },
  }
}

function saveOut(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`)
}

function syntheticIncompleteRaw() {
  return {
    ...syntheticRaw(),
    refresh: { __error: 'permission denied for table pg_stat_statements' },
    storage: { __error: 'relation "public.wordbook_entries" does not exist' },
    cpuPercent: null,
    load: {
      path: 'self-test-stale-load',
      completedAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      effective: {
        attempts: 100,
        deadlocks: 0,
        summary: { p50: 24, p95: 65, p99: 68, mean: 26, max: 70 },
      },
      noop: {
        attempts: 100,
        deadlocks: 0,
        writes: { projectionWrites: 0, documentsWrites: 0 },
      },
    },
  }
}

function selfTestTarget() {
  return {
    url: DEFAULT_URL,
    local: true,
    allowRemote: false,
    databaseUrl: null,
    dbContainer: 'self-test',
  }
}

function main(argv) {
  const flags = parseArgs(argv)
  if (flags.help) {
    process.stdout.write(USAGE)
    return 0
  }

  if (flags['self-test']) {
    const snapshot = buildSnapshot(syntheticRaw(), selfTestTarget())
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
    return 0
  }

  if (flags['self-test-incomplete']) {
    const snapshot = buildSnapshot(syntheticIncompleteRaw(), selfTestTarget())
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
    return 0
  }

  const target = resolveTarget(flags)
  const resultDir = flags['result-dir'] ?? DEFAULT_RESULT_DIR
  const raw = collectRaw(target, resultDir)
  const snapshot = buildSnapshot(raw, target)
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
  if (flags.out) saveOut(flags.out, snapshot)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
