/**
 * R3 release gate: a 200k-occurrence account.
 *
 * Requires the local four-user fixture from
 * `npm run r3:seed -- --users 4 --occurrences 200000 --documents 1112 --clean`.
 * The spec signs in as the first fixture user and measures the first projection
 * sync plus the projection-backed wordbook and document progress.
 *
 * Targets come from the R3 plan: wordbook rebuild under 2.5 s, search under
 * 200 ms, a status tap under 100 ms, and document progress computation under
 * 100 ms. The harness reports the measured values either way.
 */

import {
  DEFAULT_PASSWORD,
  PROJECTION_LANGUAGE,
  adminListUsers,
  clearProjectionQuota,
  installProbes,
  measureWorkerProgress,
  navigate,
  passwordSession,
  projectionRequests,
  psql,
  psqlJson,
  readProjectionState,
  requests,
  resolveLocalConfig,
  sqlLiteral,
  startSession,
  storeRows,
  tableReads,
  waitForAppReady,
  waitForProjectionComplete,
  workerCalls,
} from '../r3-helpers.mjs'

const EMAIL = 'r3-load-0@lexi.test'

function sleep(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fixtureSummary(config, userId) {
  return psqlJson(
    config,
    `
    select jsonb_build_object(
      'documents', (select count(*) from public.documents where user_id = ${sqlLiteral(userId)}::uuid and deleted_at is null),
      'occurrences', (select count(*) from public.word_occurrences where user_id = ${sqlLiteral(userId)}::uuid),
      'projection', (select count(*) from public.wordbook_entries where user_id = ${sqlLiteral(userId)}::uuid and deleted_at is null),
      'lemma', (
        select lemma from public.wordbook_entries
        where user_id = ${sqlLiteral(userId)}::uuid and deleted_at is null
        order by lemma limit 1
      ),
      'status', (
        select status from public.wordbook_entries
        where user_id = ${sqlLiteral(userId)}::uuid and deleted_at is null
        order by lemma limit 1
      )
    );
    `,
  )
}

/** Locates the first fixture user without creating or deleting it. */
async function fixtureUser(config) {
  const users = await adminListUsers(config)
  const user = users.find((candidate) => candidate.email === EMAIL)
  if (!user) {
    throw new Error(
      `The 200k fixture user ${EMAIL} is missing. Run: ` +
        'npm run r3:seed -- --users 4 --occurrences 200000 --documents 1112 --clean',
    )
  }
  return user
}

async function wordbookCounts(ctx) {
  return ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find((b) => /\\d/.test(b.innerText));
    return row ? [...row.parentElement.children].map((c) => (c.innerText.match(/(\\d+)/)?.[1] ?? '0')) : [];
  })()`)
}

/** Clicks a wordbook status button and returns the ms until it is active. */
async function measureStatusTap(ctx, statusLabel) {
  return ctx.page.evaluate(`(async () => {
    const button = [...document.querySelectorAll('li button[aria-label]')]
      .find((node) => node.getAttribute('aria-label') === ${JSON.stringify(statusLabel)});
    if (!button) return -1;
    const started = performance.now();
    button.click();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (button.getAttribute('aria-pressed') === 'true') return performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return -2;
  })()`)
}

export async function run(ctx) {
  const config = resolveLocalConfig()
  const user = await fixtureUser(config)
  const fixture = await fixtureSummary(config, user.id)
  ctx.check(
    '200k fixture is present (4 users × 200,000 occurrences)',
    fixture?.occurrences >= 200_000 && fixture?.documents >= 1112 && fixture?.projection > 0,
    JSON.stringify(fixture),
  )

  // The fixture is shared by the refresh load gate. Resetting only this user's
  // quota/pass bookkeeping makes the spec repeatable within the same UTC day.
  await clearProjectionQuota(config, user.id)

  await ctx.resetOrigin()
  await installProbes(ctx)
  const session = await passwordSession(config, user.email, DEFAULT_PASSWORD)
  await startSession(ctx, { config, session })

  // ── first sync: projection only ────────────────────────────────────────
  const syncStarted = Date.now()
  await waitForAppReady(ctx, 300_000)
  const syncMs = Date.now() - syncStarted
  const complete = await waitForProjectionComplete(ctx, user.id, PROJECTION_LANGUAGE, 300_000)
  const passMs =
    complete?.snapshot && complete?.hydratedAt
      ? Date.parse(complete.hydratedAt) - Date.parse(complete.snapshot)
      : Number.NaN
  ctx.check(
    'projection pass completes for the 200k account',
    complete?.complete === true,
    `${JSON.stringify(complete ?? null)}; pass ${passMs.toFixed(0)} ms, ` +
      `app start to completion ${syncMs} ms`,
  )

  const firstLog = await requests(ctx)
  ctx.check(
    'large account reads no word_occurrences rows',
    tableReads(firstLog, 'word_occurrences').length === 0,
    `${tableReads(firstLog, 'word_occurrences').length} requests`,
  )
  ctx.check(
    'large account reads no full word_states rows',
    tableReads(firstLog, 'word_states').length === 0,
    `${tableReads(firstLog, 'word_states').length} requests`,
  )
  const pages = projectionRequests(firstLog)
  const expectedPages = Math.floor(fixture.projection / 1000) + 1
  const snapshots = new Set(pages.map((page) => page.params?.p_snapshot))
  ctx.check(
    'projection is downloaded in exactly the bounded page sequence',
    pages.length === expectedPages &&
      snapshots.size === 1 &&
      pages.every(
        (page) =>
          page.params?.p_limit === 1000 &&
          page.params?.p_updated_since === null &&
          page.params?.p_snapshot !== null,
      ) &&
      pages[0]?.params?.p_after_lemma === null &&
      pages.slice(1).every((page) => typeof page.params?.p_after_lemma === 'string'),
    `${pages.length} pages (expected ${expectedPages}) for ${fixture.projection} rows; ` +
      `snapshots=${JSON.stringify([...snapshots])}`,
  )

  const localRows = await storeRows(ctx, 'wordbookEntries')
  ctx.check(
    'every projected lemma is stored locally',
    localRows.length === fixture.projection,
    `${localRows.length} / ${fixture.projection}`,
  )
  const sample = localRows[0]
  ctx.check(
    'local wordbook rows carry server projection data (contexts + watermark)',
    Boolean(
      sample &&
        Array.isArray(sample.contexts) &&
        sample.contexts.length > 0 &&
        typeof sample.serverUpdatedAt === 'string' &&
        typeof sample.occurrenceCount === 'number',
    ),
    JSON.stringify(sample ? Object.keys(sample) : null),
  )

  const state = await readProjectionState(ctx, user.id)
  ctx.check(
    'projection state is complete with no resume cursor',
    state?.state?.[PROJECTION_LANGUAGE]?.complete === true &&
      state?.state?.[PROJECTION_LANGUAGE]?.cursor === null,
    JSON.stringify(state?.state?.[PROJECTION_LANGUAGE] ?? null),
  )

  // ── wordbook first render ──────────────────────────────────────────────
  await navigate(ctx, '/')
  const renderMs = await ctx.page.evaluate(`(async () => {
    const anchor = [...document.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/wordbook');
    if (!anchor) return -1;
    const started = performance.now();
    anchor.click();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (document.querySelectorAll('[data-wordbook-lemma]').length > 0) {
        return performance.now() - started;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return -2;
  })()`)
  ctx.check('wordbook first render within 2.5 s', renderMs >= 0 && renderMs < 2500, `${renderMs.toFixed(1)} ms`)

  const counts = await wordbookCounts(ctx)
  const totalVisible = counts.slice(0, 5).reduce((sum, count) => sum + Number(count), 0)
  ctx.check(
    'wordbook counts cover the projected language',
    totalVisible >= fixture.projection,
    `${totalVisible} in tabs; expected >= ${fixture.projection}`,
  )

  // Let background hydration/rebuild effects settle so the search budget
  // measures the worker's search, not an unrelated rebuild queue.
  await sleep(1200)

  // ── search within target ───────────────────────────────────────────────
  const searchMs = await ctx.page.evaluate(`(async () => {
    const input = document.querySelector('input[placeholder]');
    if (!input) return -1;
    const started = performance.now();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(fixture.lemma)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = [...document.querySelectorAll('[data-wordbook-lemma]')];
      if (rows.length > 0 && rows.length <= 5 && rows.some((row) => row.innerText === ${JSON.stringify(fixture.lemma)})) {
        return performance.now() - started;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return -2;
  })()`)
  ctx.check('wordbook search within 200 ms', searchMs >= 0 && searchMs < 200, `${searchMs.toFixed(1)} ms`)

  // ── status toggle under 100 ms ─────────────────────────────────────────
  const statusLabel = fixture.status === 'known' ? 'Do not know' : 'Know it'
  const statusMs = await measureStatusTap(ctx, statusLabel)
  ctx.check('status toggle under 100 ms', statusMs >= 0 && statusMs < 100, `${statusMs.toFixed(1)} ms`)

  // ── document progress under 100 ms (worker computation) ────────────────
  const progressStarted = Date.now()
  await ctx.navigateTo('/')
  await ctx.waitFor(`!!document.querySelector('[role="progressbar"]')`, 'document progress gauges', 60_000)
  const progressWallMs = Date.now() - progressStarted
  await sleep(800)
  const direct = await measureWorkerProgress(ctx)
  const calls = await workerCalls(ctx)
  const progressCalls = calls.filter((call) => call.type === 'progress' && Number.isFinite(call.ms))
  const rebuildCalls = calls.filter((call) => call.type === 'rebuild' && Number.isFinite(call.ms))
  const rebuildMs = rebuildCalls.length > 0 ? Math.max(...rebuildCalls.map((call) => call.ms)) : Number.NaN

  ctx.check(
    'document progress computation under 100 ms',
    direct.ms >= 0 && direct.ms < 100,
    `${direct.ms.toFixed(1)} ms for ${direct.progress} documents; client calls ` +
      `${progressCalls.map((call) => `${call.ms.toFixed(1)}(${call.statusCount ?? '—'})`).join(', ') || '(none)'} ` +
      `(UI ready ${progressWallMs} ms)`,
  )

  const overrideStatus = fixture.status === 'known' ? 'unknown' : 'known'
  const override = await measureWorkerProgress(ctx, {
    [`en::${fixture.lemma}`]: overrideStatus,
  })
  ctx.check(
    'document progress status-override path under 100 ms',
    override.ms >= 0 && override.ms < 100 && override.progress > 0,
    `${override.ms.toFixed(1)} ms for ${override.progress} documents with 1 override`,
  )
  ctx.check(
    'wordbook rebuild stays under 2.5 s',
    Number.isFinite(rebuildMs) && rebuildMs < 2500,
    `${Number.isFinite(rebuildMs) ? rebuildMs.toFixed(1) : 'n/a'} ms`,
  )

  // No new source-row download happened while measuring the UI.
  const afterUiLog = await requests(ctx)
  ctx.check(
    'UI interaction does not re-download occurrence rows',
    tableReads(afterUiLog, 'word_occurrences').length === 0,
    `${tableReads(afterUiLog, 'word_occurrences').length} requests`,
  )

  // The fixture is shared with the refresh load gate. Restore the one status
  // this spec taps so the next gate sees the documented seed state.
  await sleep(2000)
  if (fixture.status !== null) {
    await psql(
      config,
      `
      update public.word_states
      set status = ${sqlLiteral(fixture.status)}
      where user_id = ${sqlLiteral(user.id)}::uuid
        and language_code = 'en'
        and lemma = ${sqlLiteral(fixture.lemma)};
      `,
    )
  }
  const restored = await psqlJson(
    config,
    `
    select jsonb_build_object(
      'status', (
        select status from public.wordbook_entries
        where user_id = ${sqlLiteral(user.id)}::uuid
          and language_code = 'en'
          and lemma = ${sqlLiteral(fixture.lemma)}
      )
    );
    `,
  )
  ctx.check(
    'fixture status is restored after the tap',
    restored?.status === fixture.status,
    `projection status ${JSON.stringify(restored?.status)} (expected ${JSON.stringify(fixture.status)})`,
  )
}

export const meta = { email: EMAIL, fixture: 'r3-load' }
