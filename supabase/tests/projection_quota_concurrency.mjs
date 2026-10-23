/**
 * Concurrent projection daily-limit test (R3, task 13 review).
 *
 *   node supabase/tests/projection_quota_concurrency.mjs
 *
 * This is an integration test for the per-user advisory lock in
 * `consume_projection_sync`. It does not use dblink (unavailable to the
 * non-superuser `postgres` role in the local stack); it drives the real
 * PostgREST endpoint with two simultaneous first-page requests.
 *
 * With one daily unit already spent:
 *   - exactly one of two concurrent new snapshots may start;
 *   - the other must receive HTTP 429 / SQLSTATE PT429;
 *   - a third snapshot afterwards must also be denied.
 *
 * Local only: a non-loopback URL is refused. The test creates one confirmed
 * user through the local admin API and deletes it before exiting.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const DEFAULT_URL = 'http://127.0.0.1:54321'
const DEFAULT_PASSWORD = 'projection-quota-test-2026'

function assertLocalUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid Supabase URL: ${raw}`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  if (!loopback) {
    throw new Error(`Refusing non-local target ${raw}; this test may only use the local stack.`)
  }
  return url.toString().replace(/\/$/, '')
}

function statusKeys() {
  const result = spawnSync(
    'node_modules/.bin/supabase',
    ['status', '-o', 'json'],
    { encoding: 'utf8', timeout: 60_000 },
  )
  if (result.status !== 0 || !result.stdout) {
    throw new Error('Could not read `supabase status -o json`. Start the local stack first.')
  }
  return JSON.parse(result.stdout)
}

async function jsonFetch(url, options, expectedStatus) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error(`Expected HTTP ${expectedStatus}, got ${response.status}: ${text}`)
  }
  return { status: response.status, body }
}

async function main() {
  const base = assertLocalUrl(process.env.SUPABASE_URL ?? DEFAULT_URL)
  const status = statusKeys()
  const anon = process.env.SUPABASE_ANON_KEY ?? status.ANON_KEY
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? status.SERVICE_ROLE_KEY
  if (!anon || !service) throw new Error('Missing local anon/service keys.')

  const adminHeaders = {
    apikey: service,
    Authorization: `Bearer ${service}`,
    'Content-Type': 'application/json',
  }
  const email = `projection-quota-${randomUUID()}@example.test`
  const created = await jsonFetch(
    `${base}/auth/v1/admin/users`,
    {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email, password: DEFAULT_PASSWORD, email_confirm: true }),
    },
    200,
  )
  const userId = created.body.id

  try {
    const session = await jsonFetch(
      `${base}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: DEFAULT_PASSWORD }),
      },
      200,
    )
    const token = session.body.access_token
    const rpcHeaders = {
      apikey: anon,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    const snapshot = (offsetMinutes) =>
      new Date(Date.now() + offsetMinutes * 60_000).toISOString()

    const firstPage = (at) =>
      jsonFetch(`${base}/rest/v1/rpc/get_wordbook_projection_page`, {
        method: 'POST',
        headers: rpcHeaders,
        body: JSON.stringify({
          p_language_code: 'fr',
          p_after_lemma: null,
          p_snapshot: at,
          p_updated_since: null,
          p_limit: 10,
        }),
      })

    // One daily unit spent before the race.
    const seeded = await firstPage(snapshot(-10))
    if (seeded.status !== 200) {
      throw new Error(`seeding pass failed: HTTP ${seeded.status} ${JSON.stringify(seeded.body)}`)
    }

    // Two different new snapshots at the same time; only one may take the last
    // daily unit.
    const [a, b] = await Promise.all([firstPage(snapshot(-5)), firstPage(snapshot(-4))])
    const allowed = [a, b].filter((result) => result.status === 200).length
    const denied = [a, b].filter((result) => result.status === 429).length
    const deniedCodes = [a, b]
      .filter((result) => result.status === 429)
      .map((result) => result.body?.code)

    if (allowed !== 1 || denied !== 1 || deniedCodes.some((code) => code !== 'PT429')) {
      throw new Error(
        `concurrent starts were not serialized: ${JSON.stringify({
          allowed,
          denied,
          deniedCodes,
          statuses: [a.status, b.status],
          bodies: [a.body, b.body],
        })}`,
      )
    }

    // Both daily units are now spent; a third new snapshot is denied.
    const third = await firstPage(snapshot(-3))
    if (third.status !== 429 || third.body?.code !== 'PT429') {
      throw new Error(`third daily start was not denied: HTTP ${third.status} ${JSON.stringify(third.body)}`)
    }

    console.log(
      JSON.stringify(
        {
          kind: 'projection-quota-concurrency',
          pass: true,
          userId,
          seededStatus: seeded.status,
          concurrent: [a.status, b.status],
          deniedCodes,
          thirdStatus: third.status,
        },
        null,
        2,
      ),
    )
  } finally {
    await fetch(`${base}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
