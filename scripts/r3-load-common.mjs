/**
 * Shared plumbing for the R3 local load fixture.
 *
 * The seed and the load runner are destructive and expensive, so every entry
 * point in this file refuses to run against anything but a loopback Supabase.
 * They never read `.env.local` (which points at production); an explicit
 * `SUPABASE_URL`/`LOCAL_SUPABASE_URL` or `--url` is required to override the
 * default local stack at http://127.0.0.1:54321.
 *
 * Results go to stdout as JSON, diagnostics to stderr, and the same JSON is
 * written under /tmp/opencode/r3-<kind>-<timestamp>.json.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createReadStream, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const EMAIL_PREFIX = 'r3-load-'
export const DEFAULT_PASSWORD = 'r3-load-password-2026'
export const DEFAULT_URL = 'http://127.0.0.1:54321'
export const RESULT_DIR = '/tmp/opencode'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SUPABASE_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'supabase')
const CONFIG_TOML = join(REPO_ROOT, 'supabase', 'config.toml')

/** Throws unless `value` is a loopback Supabase URL. */
export function assertLocalSupabaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid Supabase URL: ${value}`)
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host)

  if (!loopback) {
    throw new Error(
      `Refusing non-local Supabase URL ${value} (host ${host}). ` +
        'This fixture writes hundreds of thousands of rows and may only target ' +
        '127.0.0.1, localhost, or ::1.',
    )
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported Supabase URL protocol: ${url.protocol}`)
  }

  return url
}

export function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const key = arg.slice(2)
    if (key === 'clean' || key === 'smoke' || key === 'help') {
      flags[key] = true
      continue
    }
    const eq = key.indexOf('=')
    if (eq !== -1) {
      flags[key.slice(0, eq)] = key.slice(eq + 1)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    flags[key] = value
    i += 1
  }
  return flags
}

export function positiveInt(flags, name, fallback) {
  const raw = flags[name] ?? fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer (got ${raw})`)
  }
  return value
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

function readStatusJson() {
  const result = spawnSync(SUPABASE_BIN, ['status', '-o', 'json'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      'Could not read `supabase status -o json`. Start the local stack ' +
        '(`supabase start`) or pass SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.',
    )
  }
  return JSON.parse(result.stdout)
}

let cachedStatus

export function resolveLocalConfig(flags = {}) {
  const rawUrl = flags.url ?? process.env.SUPABASE_URL ?? process.env.LOCAL_SUPABASE_URL ?? DEFAULT_URL
  const url = assertLocalSupabaseUrl(rawUrl).toString().replace(/\/$/, '')

  cachedStatus ??= readStatusJson()
  const anonKey = flags['anon-key'] ?? process.env.SUPABASE_ANON_KEY ?? cachedStatus.ANON_KEY
  const serviceKey =
    flags['service-key'] ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? cachedStatus.SERVICE_ROLE_KEY

  if (!anonKey || !serviceKey) {
    throw new Error(
      'Missing local anon/service keys. Start the local stack or set ' +
        'SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.',
    )
  }

  const container =
    flags['db-container'] ??
    process.env.R3_DB_CONTAINER ??
    `supabase_db_${projectIdFromConfig()}`

  const inspect = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', container], {
    encoding: 'utf8',
  })
  if (inspect.status !== 0 || inspect.stdout.trim() !== 'true') {
    throw new Error(
      `Local database container ${container} is not running. ` +
        'Start the local Supabase stack or pass --db-container.',
    )
  }

  return {
    url,
    anonKey,
    serviceKey,
    dbContainer: container,
    projectId: projectIdFromConfig(),
  }
}

export function passwordFrom(flags) {
  return flags.password ?? process.env.R3_LOAD_PASSWORD ?? DEFAULT_PASSWORD
}

export function seedEmail(index) {
  return `${EMAIL_PREFIX}${index}@lexi.test`
}

export function seedUserIndex(email) {
  const match = /^r3-load-(\d+)@/.exec(email ?? '')
  return match ? Number(match[1]) : null
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'null'
  return `'${String(value).replaceAll("'", "''")}'`
}

export function uuidList(ids) {
  return `array[${ids.map((id) => `${sqlLiteral(id)}::uuid`).join(', ')}]::uuid[]`
}

function spawnPsql(config, input, { fromFile = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        config.dbContainer,
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-t',
        '-A',
        '-F',
        '\t',
        '-f',
        '-',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`psql failed (exit ${code}): ${stderr.trim() || stdout.trim()}`))
    })

    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error)
    })

    if (fromFile) {
      const stream = createReadStream(input)
      stream.on('error', reject)
      stream.pipe(child.stdin)
    } else {
      child.stdin.end(input)
    }
  })
}

export async function psql(config, sql) {
  const { stdout } = await spawnPsql(config, sql)
  return stdout
}

/** Streams a possibly large SQL/COPY script from a file into psql. */
export async function psqlFile(config, file) {
  const { stdout } = await spawnPsql(config, file, { fromFile: true })
  return stdout
}

export async function psqlJson(config, sql) {
  const stdout = (await psql(config, sql)).trim()
  if (!stdout) return null
  const lastLine = stdout.split('\n').filter(Boolean).at(-1)
  return JSON.parse(lastLine)
}

export function restHeaders(config, token, extra = {}) {
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${token ?? config.serviceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

export async function restJson(config, path, { method = 'GET', token, body, timeout = 30_000 } = {}) {
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: restHeaders(config, token),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!response.ok) {
    const detail =
      data && typeof data === 'object'
        ? `${data.code ?? ''} ${data.message ?? data.error ?? JSON.stringify(data)}`.trim()
        : String(data ?? response.statusText)
    throw new Error(`HTTP ${response.status} ${path}: ${detail}`)
  }
  return data
}

export async function adminListUsers(config) {
  const users = []
  for (let page = 1; page < 100; page += 1) {
    const data = await restJson(config, `/auth/v1/admin/users?page=${page}&per_page=1000`)
    const batch = data?.users ?? []
    users.push(...batch)
    if (batch.length < 1000) break
  }
  return users
}

export async function adminCreateUser(config, { email, password, index }) {
  return restJson(config, '/auth/v1/admin/users', {
    method: 'POST',
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { r3_load: true, r3_load_index: index },
    },
  })
}

export async function adminDeleteUser(config, id) {
  try {
    await restJson(config, `/auth/v1/admin/users/${id}`, { method: 'DELETE' })
  } catch (error) {
    if (String(error.message).includes('HTTP 404')) return
    throw error
  }
}

export async function signIn(config, email, password) {
  const data = await restJson(config, '/auth/v1/token?grant_type=password', {
    method: 'POST',
    token: config.anonKey,
    body: { email, password },
    timeout: 30_000,
  })
  if (!data?.access_token) throw new Error(`Sign-in returned no access token for ${email}`)
  return data.access_token
}

/** Deterministic RFC-4122-shaped UUID (version 5 nibble) for fixture rows. */
export function deterministicUuid(...parts) {
  const hex = createHash('sha256')
    .update(['lexi-r3-load', ...parts].join(':'))
    .digest('hex')
    .slice(0, 32)
    .split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return [
    hex.slice(0, 8).join(''),
    hex.slice(8, 12).join(''),
    hex.slice(12, 16).join(''),
    hex.slice(16, 20).join(''),
    hex.slice(20, 32).join(''),
  ].join('-')
}

export function newRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
}

export function summarize(durations) {
  if (durations.length === 0) {
    return { count: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null }
  }
  const sorted = [...durations].sort((a, b) => a - b)
  const at = (percent) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)]
  const sum = sorted.reduce((total, value) => total + value, 0)
  return {
    count: sorted.length,
    min: round(sorted[0]),
    mean: round(sum / sorted.length),
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    max: round(sorted[sorted.length - 1]),
  }
}

export function round(value) {
  return Math.round(value * 100) / 100
}

export async function writeResult(kind, result) {
  await mkdir(RESULT_DIR, { recursive: true })
  const path = join(RESULT_DIR, `r3-${kind}-${newRunId()}.json`)
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
  return path
}

export function emitResult(result) {
  console.log(JSON.stringify(result, null, 2))
}

export function log(message) {
  console.error(message)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
