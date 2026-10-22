#!/usr/bin/env node
/**
 * Verify the deployed Lexi origin sends the security and cache headers that
 * deploy/nginx-lexi.conf is supposed to produce.
 *
 *   node scripts/verify-headers.mjs [origin]
 *   node scripts/verify-headers.mjs https://app.achijaser.date
 *
 * Default origin: https://app.achijaser.date
 *
 * Checks GET /, /sw.js, /manifest.webmanifest, and one content-hashed asset
 * discovered from the shell HTML (falling back to the service-worker precache
 * manifest). Every target must carry HSTS, X-Content-Type-Options,
 * Referrer-Policy, Permissions-Policy, X-Frame-Options, and the full CSP —
 * including the asset, which is where nginx add_header inheritance usually
 * gets lost. Cache rules: shell/service-worker/manifest no-cache, hashed
 * assets immutable for a year.
 *
 * Cloudflare is in front of the origin. If it caches /sw.js or
 * /manifest.webmanifest, the cf-cache-status check fails and a Cache Rule
 * bypass must be added before deploys stop lingering.
 *
 * Exit code: 0 only when every check passes.
 */
const DEFAULT_ORIGIN = 'https://app.achijaser.date'
const TIMEOUT_MS = 15_000

const CSP_DIRECTIVES = new Map([
  ['default-src', ["'self'"]],
  ['base-uri', ["'self'"]],
  ['form-action', ["'self'"]],
  ['frame-ancestors', ["'none'"]],
  ['object-src', ["'none'"]],
  ['img-src', ["'self'", 'data:']],
  ['font-src', ["'self'"]],
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['script-src', ["'self'", "'wasm-unsafe-eval'"]],
  ['worker-src', ["'self'", 'blob:']],
  ['connect-src', ["'self'", 'https://gwsrowpbcqwtpciknayl.supabase.co']],
])

const PERMISSIONS = ['camera', 'microphone', 'geolocation', 'payment']

const HASHED_ASSET = /\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/

const results = []
const warnings = []
const targets = []

function track(target) {
  if (!targets.includes(target)) targets.push(target)
}

function pass(target, name, detail = '') {
  track(target)
  results.push({ target, name, ok: true, detail })
}

function fail(target, name, detail = '') {
  track(target)
  results.push({ target, name, ok: false, detail })
}

function warn(target, name, detail = '') {
  track(target)
  warnings.push({ target, name, detail })
}

function parseDirectives(value) {
  const out = new Map()
  for (const part of value.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (!tokens.length) continue
    const name = tokens.shift().toLowerCase()
    out.set(name, tokens)
  }
  return out
}

function parseCacheControl(value) {
  const out = new Map()
  for (const part of value.split(',')) {
    const [rawName, ...rest] = part.trim().split('=')
    if (!rawName) continue
    let entry = rest.join('=').trim()
    if (entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1)
    out.set(rawName.trim().toLowerCase(), entry)
  }
  return out
}

function parsePermissions(value) {
  const out = new Map()
  for (const part of value.split(',')) {
    const [rawName, ...rest] = part.trim().split('=')
    if (!rawName) continue
    out.set(rawName.trim().toLowerCase(), rest.join('=').replace(/\s+/g, ''))
  }
  return out
}

function checkHsts(target, headers) {
  const value = headers.get('strict-transport-security')
  if (value === null) return fail(target, 'strict-transport-security', 'missing')
  // HSTS is semicolon-separated and uses name=value, unlike CSP's name values.
  const directives = new Map()
  for (const part of value.split(';')) {
    const chunk = part.trim()
    if (!chunk) continue
    const [name, ...rest] = chunk.split('=')
    directives.set(name.trim().toLowerCase(), rest.join('=').trim())
  }
  const maxAge = Number(directives.get('max-age'))
  const problems = []
  if (maxAge !== 31536000) problems.push(`max-age is ${Number.isFinite(maxAge) ? maxAge : 'missing'}, expected 31536000`)
  if (!directives.has('includesubdomains')) problems.push('includeSubDomains missing')
  if (problems.length) fail(target, 'strict-transport-security', `${problems.join('; ')} — got "${value}"`)
  else pass(target, 'strict-transport-security', value)
}

function checkSimple(target, headers, name, expected, matches) {
  const value = headers.get(name)
  if (value === null) return fail(target, name, `missing (expected "${expected}")`)
  if (!matches(value)) return fail(target, name, `expected "${expected}", got "${value}"`)
  pass(target, name, value)
}

function checkPermissions(target, headers) {
  const value = headers.get('permissions-policy')
  if (value === null) return fail(target, 'permissions-policy', 'missing')
  const directives = parsePermissions(value)
  const problems = []
  for (const feature of PERMISSIONS) {
    if (directives.get(feature) !== '()') problems.push(`${feature} must be disabled with ()`)
  }
  if (problems.length) fail(target, 'permissions-policy', `${problems.join('; ')} — got "${value}"`)
  else pass(target, 'permissions-policy', value)
}

function checkCsp(target, headers) {
  const value = headers.get('content-security-policy')
  if (value === null) return fail(target, 'content-security-policy', 'missing')
  const directives = parseDirectives(value)
  const problems = []
  for (const [name, expected] of CSP_DIRECTIVES) {
    const actual = directives.get(name)
    if (!actual) {
      problems.push(`${name} missing`)
      continue
    }
    if (actual.join(' ') !== expected.join(' ')) {
      problems.push(`${name} is "${actual.join(' ')}", expected "${expected.join(' ')}"`)
    }
  }
  if (problems.length) fail(target, 'content-security-policy', problems.join('; '))
  else pass(target, 'content-security-policy', 'all required directives match')

  for (const name of directives.keys()) {
    if (!CSP_DIRECTIVES.has(name)) warn(target, 'CSP extra directive', `${name} is not in the approved CSP`)
  }
}

function checkSecurity(target, headers) {
  checkHsts(target, headers)
  checkSimple(target, headers, 'x-content-type-options', 'nosniff', (v) => v.trim().toLowerCase() === 'nosniff')
  checkSimple(target, headers, 'referrer-policy', 'strict-origin-when-cross-origin', (v) => v.trim().toLowerCase() === 'strict-origin-when-cross-origin')
  checkPermissions(target, headers)
  checkSimple(target, headers, 'x-frame-options', 'DENY', (v) => v.trim().toLowerCase() === 'deny')
  checkCsp(target, headers)
}

function checkNoCache(target, headers) {
  const value = headers.get('cache-control')
  if (value === null) return fail(target, 'cache-control', 'missing (expected no-cache)')
  const directives = parseCacheControl(value)
  if (!directives.has('no-cache')) {
    fail(target, 'cache-control', `expected no-cache, got "${value}"`)
  } else {
    pass(target, 'cache-control', value)
  }

  const maxAgeRaw = directives.get('max-age')
  if (maxAgeRaw === undefined) return
  const maxAge = Number(maxAgeRaw)
  if (maxAge === 14400) {
    fail(target, 'cache-control max-age', '14400 is still present — this is the stale service-worker config')
  } else if (Number.isFinite(maxAge) && maxAge > 0) {
    warn(target, 'cache-control max-age', `${maxAge} is present alongside no-cache`)
  }
}

function checkImmutable(target, headers) {
  const value = headers.get('cache-control')
  if (value === null) return fail(target, 'cache-control', 'missing (expected immutable)')
  const directives = parseCacheControl(value)
  if (!directives.has('immutable')) {
    fail(target, 'cache-control', `expected immutable, got "${value}"`)
  } else {
    pass(target, 'cache-control', value)
  }

  const maxAgeRaw = directives.get('max-age')
  const maxAge = Number(maxAgeRaw)
  if (maxAgeRaw === undefined || !Number.isFinite(maxAge) || maxAge < 31536000) {
    fail(target, 'cache-control max-age', `expected max-age >= 31536000, got "${maxAgeRaw ?? 'missing'}"`)
  } else {
    pass(target, 'cache-control max-age', `${maxAge} (>= 31536000)`)
  }
}

function checkStatus(target, response) {
  if (response.status !== 200) fail(target, 'status', `expected 200, got ${response.status}`)
  else pass(target, 'status', '200')
}

function checkNotHtml(target, response) {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.toLowerCase().includes('text/html')) {
    fail(target, 'content-type', `"${contentType}" — SPA fallback likely served index.html instead of this file`)
  }
}

function checkCloudflare(target, headers) {
  const status = headers.get('cf-cache-status')
  if (status === null) return
  const normalized = status.trim().toUpperCase()
  if (normalized === 'HIT' || normalized === 'STALE') {
    fail(
      target,
      'cloudflare cache',
      `cf-cache-status: ${status} — Cloudflare is holding this response; add a Cache Rule bypass for /sw.js and /manifest.webmanifest`,
    )
  } else {
    pass(target, 'cloudflare cache', `cf-cache-status: ${status}`)
  }
}

function assetFromHtml(html) {
  const found = []
  for (const match of html.matchAll(/(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
    const raw = match[1] ?? match[2]
    let url
    try {
      url = new URL(raw, base)
    } catch {
      continue
    }
    if (url.origin !== baseOrigin || !HASHED_ASSET.test(url.pathname)) continue
    found.push(url.pathname + url.search)
  }
  return found.find((path) => path.includes('.js')) ?? found[0] ?? null
}

function assetFromServiceWorker(text) {
  const found = []
  for (const match of text.matchAll(/(?:["'(])(\/?assets\/[A-Za-z0-9._~/-]+-[A-Za-z0-9_-]{6,}\.(?:js|css))/g)) {
    const path = match[1].startsWith('/') ? match[1] : `/${match[1]}`
    if (!found.includes(path)) found.push(path)
  }
  return found.find((path) => path.includes('.js')) ?? found[0] ?? null
}

async function fetchTarget(target, accept) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(new URL(target, base), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept,
        'user-agent': 'lexi-header-verifier/1.0 (+https://app.achijaser.date)',
      },
    })
  } catch (error) {
    fail(target, 'request', error.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : error.message)
    return null
  } finally {
    clearTimeout(timer)
  }
}

function printResults() {
  for (const target of targets) {
    const rows = results.filter((row) => row.target === target)
    if (!rows.length) continue
    console.log(`\n${target}`)
    for (const row of rows) {
      const label = row.ok ? 'PASS' : 'FAIL'
      console.log(`  ${label}  ${row.name}${row.detail ? ` — ${row.detail}` : ''}`)
    }
  }

  if (warnings.length) {
    console.log('\nWarnings')
    for (const row of warnings) console.log(`  WARN  ${row.target} ${row.name} — ${row.detail}`)
  }

  const failures = results.filter((row) => !row.ok).length
  console.log(`\n${results.length - failures} passed, ${failures} failed`)
  if (failures > 0) {
    console.log('FAIL: the deployed headers do not match deploy/nginx-lexi.conf.')
    process.exitCode = 1
  } else {
    console.log('PASS: all security-header and cache rules match.')
  }
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/verify-headers.mjs [origin]')
  console.log(`Default origin: ${DEFAULT_ORIGIN}`)
  process.exit(0)
}

const rawOrigin = args.find((arg) => !arg.startsWith('-')) ?? process.env.VERIFY_ORIGIN ?? DEFAULT_ORIGIN
let base
try {
  const parsed = new URL(rawOrigin)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('origin must use http or https')
  }
  base = parsed.origin
} catch (error) {
  console.error(`Invalid origin "${rawOrigin}": ${error.message}`)
  process.exit(2)
}
const baseOrigin = new URL(base).origin

console.log(`Verifying ${base}`)
console.log('Required on every target: HSTS, nosniff, referrer, permissions, XFO, full CSP.')

const root = await fetchTarget('/', 'text/html,application/xhtml+xml')
let html = ''
if (root) {
  checkStatus('/', root)
  checkSecurity('/', root.headers)
  checkNoCache('/', root.headers)
  html = await root.text().catch(() => '')
}

const sw = await fetchTarget('/sw.js', 'text/javascript,application/javascript,*/*')
let swText = ''
if (sw) {
  checkStatus('/sw.js', sw)
  checkSecurity('/sw.js', sw.headers)
  checkNoCache('/sw.js', sw.headers)
  checkNotHtml('/sw.js', sw)
  checkCloudflare('/sw.js', sw.headers)
  swText = await sw.text().catch(() => '')
}

const manifest = await fetchTarget('/manifest.webmanifest', 'application/manifest+json,*/*')
if (manifest) {
  checkStatus('/manifest.webmanifest', manifest)
  checkSecurity('/manifest.webmanifest', manifest.headers)
  checkNoCache('/manifest.webmanifest', manifest.headers)
  checkNotHtml('/manifest.webmanifest', manifest)
  checkCloudflare('/manifest.webmanifest', manifest.headers)
  await manifest.body?.cancel()
}

const assetPath = assetFromHtml(html) ?? assetFromServiceWorker(swText)
if (!assetPath) {
  fail('/', 'hashed asset discovery', 'no /assets/*-hash.js|css reference found in / or /sw.js')
} else {
  const asset = await fetchTarget(assetPath, '*/*')
  if (asset) {
    checkStatus(assetPath, asset)
    checkSecurity(assetPath, asset.headers)
    checkImmutable(assetPath, asset.headers)
    checkNotHtml(assetPath, asset)
    await asset.body?.cancel()
  }
}

printResults()
