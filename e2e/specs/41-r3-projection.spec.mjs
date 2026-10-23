/**
 * R3 release gate: first projection sync, resumability, offline wordbook, lazy
 * document content, metadata-only list, and no duplicate occurrence writes.
 *
 * This is an authenticated end-to-end flow against the **local** Supabase
 * stack (the helper refuses non-loopback URLs). It seeds a small account, signs
 * in by injecting the same session the GoTrue password grant returns, and then
 * drives the built app in headless Chrome.
 *
 * Requirements:
 *   - `supabase start` (or an equivalent local stack) is running;
 *   - `.env.local` points the build at that local API (see `.env.example`);
 *   - `npm run e2e -- r3-projection` after a build.
 *
 * The first cycle is deliberately paused by the server's one-minute page quota
 * after one projection page. That is the interruption: the page rows and their
 * cursor must be stored, the UI must explain the pause, and the next cycle must
 * send the stored cursor so the projection resumes instead of restarting.
 */

import {
  DEFAULT_PASSWORD,
  PROJECTION_LANGUAGE,
  clearProjectionQuota,
  deleteTestUser,
  installProbes,
  navigate,
  prepareTestUser,
  projectionRequests,
  psql,
  readProjectionState,
  requests,
  rpcWrites,
  searchWordbook,
  seedPageQuota,
  sqlLiteral,
  startSession,
  storeCount,
  storeRows,
  tableReads,
  tableWrites,
  waitForAppReady,
  waitForProjectionComplete,
} from '../r3-helpers.mjs'

const EMAIL = 'r3-e2e-projection@lexi.test'
const LONG_COUNT = 600
const MEDIUM_COUNT = 400
const SHORT_COUNT = 200
const KNOWN_LEMMA = 'r3word0001'
const SEARCH_LEMMA = 'r3word0002'
const LONG_TITLE = 'Long passage'
const MEDIUM_TITLE = 'Medium passage'
const SHORT_TITLE = 'Short passage'

function sleep(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function wordAt(index) {
  return `r3word${String(index).padStart(4, '0')}`
}

/**
 * Builds three documents whose character lengths are distinct and known, plus
 * one occurrence per word and one pre-existing known word state.
 *
 * `raw_text` is stored on the server, but the metadata-only list pull never
 * asks for it. The list can still show the length from `char_count` and sort by
 * it without downloading a body.
 */
function fixtureSql(userId) {
  const documents = []
  let nextWord = 1
  for (const [title, count] of [
    [LONG_TITLE, LONG_COUNT],
    [MEDIUM_TITLE, MEDIUM_COUNT],
    [SHORT_TITLE, SHORT_COUNT],
  ]) {
    const words = []
    const occurrences = []
    for (let index = 0; index < count; index += 1) {
      const lemma = wordAt(nextWord)
      nextWord += 1
      const sentence = `We read ${lemma} in this local passage.`
      const charStart = sentence.indexOf(lemma)
      words.push(lemma)
      occurrences.push({ lemma, sentence, charStart, charEnd: charStart + lemma.length })
    }
    documents.push({ title, rawText: `${words.join(' ')}.`, occurrences })
  }

  const documentValues = documents
    .map(
      (doc) =>
        `(gen_random_uuid(), ${sqlLiteral(userId)}::uuid, ${sqlLiteral(doc.title)}, 'en', ` +
        `${sqlLiteral(doc.rawText)}, now() - interval '2 hours', now() - interval '2 hours')`,
    )
    .join(',\n')

  const occurrenceStatements = documents
    .map(
      (doc) => `
      insert into public.word_occurrences
        (user_id, document_id, language_code, lemma, surface, char_start, char_end, sentence)
      select ${sqlLiteral(userId)}::uuid, d.id, 'en', row.lemma, row.lemma,
             row.char_start, row.char_end, row.sentence
      from public.documents d
      cross join (values
        ${doc.occurrences
          .map(
            (row) =>
              `(${sqlLiteral(row.lemma)}, ${row.charStart}, ${row.charEnd}, ${sqlLiteral(row.sentence)})`,
          )
          .join(',\n')}
      ) as row(lemma, char_start, char_end, sentence)
      where d.user_id = ${sqlLiteral(userId)}::uuid
        and d.title = ${sqlLiteral(doc.title)};`,
    )
    .join('\n')

  return `
  begin;

  insert into public.user_languages (user_id, language_code)
  values (${sqlLiteral(userId)}::uuid, 'en')
  on conflict do nothing;

  insert into public.documents (id, user_id, title, language_code, raw_text, created_at, updated_at)
  values
  ${documentValues};

  ${occurrenceStatements}

  insert into public.word_states
    (user_id, language_code, lemma, status, seen_count, first_seen_at, last_seen_at)
  values
    (${sqlLiteral(userId)}::uuid, 'en', ${sqlLiteral(KNOWN_LEMMA)}, 'known', 1, now(), now())
  on conflict (user_id, language_code, lemma)
  do update set status = excluded.status;

  select public.refresh_wordbook_pairs((
    select jsonb_agg(
             jsonb_build_object(
               'userId', ${sqlLiteral(userId)}::uuid,
               'languageCode', 'en',
               'lemma', lemma
             )
             order by lemma
           )
    from (
      select distinct lemma
      from public.word_occurrences
      where user_id = ${sqlLiteral(userId)}::uuid
    ) lemmas
  ));

  commit;
  `
}

function wordbookCounts(ctx) {
  return ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find((b) => /\\d/.test(b.innerText));
    return row ? [...row.parentElement.children].map((c) => (c.innerText.match(/(\\d+)/)?.[1] ?? '0')) : [];
  })()`)
}

async function waitForWordbookRows(ctx, timeoutMs = 30_000) {
  await ctx.waitFor(`document.querySelectorAll('[data-wordbook-lemma]').length > 0`, 'wordbook rows', timeoutMs)
}

/** The first tab is ★; the list under test lives in "Not marked". */
async function gotoUnmarkedTab(ctx) {
  await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find((b) => /\\d/.test(b.innerText));
    const tab = row && [...row.parentElement.children].find((c) => /^Not marked/.test(c.innerText.trim()));
    if (tab) tab.click();
    return true;
  })()`)
  await sleep(300)
}

async function openDocumentByTitle(ctx, title) {
  await ctx.waitFor(`!!document.querySelector('a[href="/"]')`, 'document list')
  await navigate(ctx, '/')
  await ctx.waitFor(
    `!![...document.querySelectorAll('a[href^="/read/"]')].find((a) => a.innerText.includes(${JSON.stringify(title)}))`,
    `document link ${title}`,
  )
  await ctx.page.evaluate(`(() => {
    const link = [...document.querySelectorAll('a[href^="/read/"]')]
      .find((a) => a.innerText.includes(${JSON.stringify(title)}));
    if (!link) return false;
    link.click();
    return true;
  })()`)
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, `reader ${title}`, 30_000)
}

export async function run(ctx) {
  const prepared = await prepareTestUser(EMAIL)
  const { config, user, session } = prepared

  try {
    await psql(config, fixtureSql(user.id))
    // One page is allowed; the second page request is denied with PT429.
    await seedPageQuota(config, user.id, 59)

    await ctx.resetOrigin()
    await installProbes(ctx)
    await startSession(ctx, { config, session })

    // ── first cycle: projection only, then a recoverable quota pause ──────
    await waitForAppReady(ctx)
    const firstLog = await requests(ctx)
    const firstPages = projectionRequests(firstLog)

    ctx.check(
      'first sync reads no word_occurrences rows',
      tableReads(firstLog, 'word_occurrences').length === 0,
      `${tableReads(firstLog, 'word_occurrences').length} requests`,
    )
    ctx.check(
      'first sync reads no full word_states rows',
      tableReads(firstLog, 'word_states').length === 0,
      `${tableReads(firstLog, 'word_states').length} requests`,
    )
    ctx.check(
      'first sync requests projection pages only after metadata',
      firstPages.length >= 2,
      `${firstPages.length} projection requests`,
    )
    ctx.check(
      'first page started at the first lemma',
      firstPages[0]?.params?.p_after_lemma === null,
      JSON.stringify(firstPages[0]?.params ?? null),
    )

    const paused = await ctx.page.evaluate(`(() => {
      const node = document.querySelector('[data-list-paused]');
      return node ? node.innerText : null;
    })()`)
    ctx.check(
      'quota denial pauses the download instead of failing the sync',
      /server limit|quota|paused/i.test(paused ?? ''),
      (paused ?? '(no pause banner)').replace(/\n/g, ' | ').slice(0, 90),
    )

    const interrupted = await readProjectionState(ctx, user.id)
    const interruptedLanguage = interrupted?.state?.[PROJECTION_LANGUAGE]
    ctx.check(
      'interrupted pass stores a cursor under its snapshot',
      interruptedLanguage?.complete === false &&
        typeof interruptedLanguage?.snapshot === 'string' &&
        typeof interruptedLanguage?.cursor?.lemma === 'string',
      JSON.stringify(interruptedLanguage ?? null),
    )

    // The cursor names rows that are already on the device.
    const storedRows = await storeRows(ctx, 'wordbookEntries')
    ctx.check(
      'rows from the first page are stored before the cursor',
      storedRows.length >= 1000,
      `${storedRows.length} projection rows`,
    )

    // ── resume: the retry uses the stored cursor ──────────────────────────
    await clearProjectionQuota(config, user.id)
    await waitForProjectionComplete(ctx, user.id, PROJECTION_LANGUAGE, 180_000)
    const completeState = await readProjectionState(ctx, user.id)
    ctx.check(
      'projection completes after the rate-limit window',
      completeState?.state?.[PROJECTION_LANGUAGE]?.complete === true,
      JSON.stringify(completeState?.state?.[PROJECTION_LANGUAGE] ?? null),
    )

    const resumedLog = await requests(ctx)
    const resumedPages = projectionRequests(resumedLog)
    const cursor = interruptedLanguage?.cursor?.lemma
    ctx.check(
      'resumed sync asks for the stored cursor, not lemma 0',
      resumedPages.some((page) => page.params?.p_after_lemma === cursor),
      `cursor ${JSON.stringify(cursor)}; requests ${JSON.stringify(
        resumedPages.map((page) => page.params?.p_after_lemma ?? null),
      )}`,
    )

    const finalRows = await storeRows(ctx, 'wordbookEntries')
    ctx.check(
      'the whole projection is on the device',
      finalRows.length === LONG_COUNT + MEDIUM_COUNT + SHORT_COUNT,
      `${finalRows.length} rows`,
    )

    // ── wordbook: status hydrated from the projection, search works ───────
    await navigate(ctx, '/wordbook')
    await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, 'wordbook')
    await gotoUnmarkedTab(ctx)
    await waitForWordbookRows(ctx)
    const counts = await wordbookCounts(ctx)
    ctx.check(
      'every projected word reaches the wordbook',
      Number(counts[4] ?? 0) + Number(counts[1] ?? 0) + Number(counts[2] ?? 0) + Number(counts[3] ?? 0) ===
        LONG_COUNT + MEDIUM_COUNT + SHORT_COUNT,
      counts.join(' | '),
    )
    ctx.check(
      'word state hydrated from the projection without a word_states pull',
      Number(counts[1] ?? 0) >= 1,
      counts.join(' | '),
    )

    await searchWordbook(ctx, SEARCH_LEMMA)
    await ctx.waitFor(
      `[...document.querySelectorAll('[data-wordbook-lemma]')].some((node) => node.innerText === ${JSON.stringify(SEARCH_LEMMA)})`,
      'wordbook search',
    )
    ctx.check('wordbook search finds a projected lemma', true, SEARCH_LEMMA)

    // ── metadata-only list: length and longest sort without a body ────────
    await navigate(ctx, '/')
    await ctx.waitFor(`!!document.querySelector('select[aria-label]')`, 'document list controls')
    const beforeOpenContent = await storeCount(ctx, 'documentContent')
    const countsOnList = await ctx.page.evaluate(`(() =>
      [...document.querySelectorAll('a[href^="/read/"]')].map((a) => a.innerText)
    )()`)
    ctx.check(
      'metadata-only documents show their server character count',
      countsOnList.length === 3 &&
        countsOnList.every((text) => /\d+ characters|\d+ chars|글자/.test(text)),
      countsOnList.map((text) => text.replace(/\n/g, ' | ').slice(0, 60)).join(' / '),
    )
    ctx.check(
      'no document body was downloaded to build the list',
      beforeOpenContent === 0,
      `${beforeOpenContent} content rows`,
    )

    await ctx.page.evaluate(`(() => {
      const select = [...document.querySelectorAll('select')]
        .find((node) => [...node.options].some((option) => option.value === 'longest'));
      if (!select) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'longest');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    await sleep(400)
    const sortedTitles = await ctx.page.evaluate(`(() =>
      [...document.querySelectorAll('a[href^="/read/"]')].map((a) => a.innerText.split('\\n')[0])
    )()`)
    ctx.check(
      'longest sort uses metadata char counts',
      sortedTitles[0] === LONG_TITLE &&
        sortedTitles[1] === MEDIUM_TITLE &&
        sortedTitles[2] === SHORT_TITLE,
      sortedTitles.join(' > '),
    )

    // ── lazy content: one payload fetch, reopen is local ──────────────────
    await openDocumentByTitle(ctx, MEDIUM_TITLE)
    const body = await ctx.bodyText()
    ctx.check('opening a metadata-only document loads its text', /r3word0601/.test(body), body.slice(0, 80))
    const afterFirstOpen = await storeCount(ctx, 'documentContent')
    ctx.check('the opened body is stored on the device', afterFirstOpen === 1, `${afterFirstOpen} content rows`)

    const payloadAfterFirstOpen = (await requests(ctx)).filter((entry) =>
      entry.url.includes('/rpc/get_document_payload'),
    ).length
    ctx.check('opening fetches the document payload once', payloadAfterFirstOpen === 1, `${payloadAfterFirstOpen} calls`)

    await navigate(ctx, '/')
    await openDocumentByTitle(ctx, MEDIUM_TITLE)
    await sleep(800)
    const payloadAfterReopen = (await requests(ctx)).filter((entry) =>
      entry.url.includes('/rpc/get_document_payload'),
    ).length
    ctx.check(
      'reopening uses the local body (no second payload fetch)',
      payloadAfterReopen === payloadAfterFirstOpen,
      `${payloadAfterFirstOpen} → ${payloadAfterReopen}`,
    )

    // Let the post-open sync debounce finish, then look for occurrence writes.
    await sleep(3500)
    const afterOpenLog = await requests(ctx)
    const occurrenceWrites =
      tableWrites(afterOpenLog, 'word_occurrences').length +
      tableWrites(afterOpenLog, 'wordOccurrences').length +
      rpcWrites(afterOpenLog, 'replace_word_occurrences').length
    ctx.check(
      'opening/reopening never pushes occurrence rows',
      occurrenceWrites === 0,
      `${occurrenceWrites} occurrence writes`,
    )
    ctx.check(
      'opening touches only metadata (no document upsert)',
      tableWrites(afterOpenLog, 'documents').length === 0,
      `${tableWrites(afterOpenLog, 'documents').length} document writes`,
    )

    // ── offline: the wordbook is projection-backed ────────────────────────
    await navigate(ctx, '/wordbook')
    await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, 'wordbook')
    await gotoUnmarkedTab(ctx)
    await waitForWordbookRows(ctx)
    await ctx.goOffline(true)
    ctx.check('network is actually offline', await ctx.page.evaluate('navigator.onLine === false'))
    await ctx.reload()
    await ctx.waitFor(`!!document.querySelector('a[href="/wordbook"]')`, 'offline shell', 30_000)
    await navigate(ctx, '/wordbook')
    await waitForWordbookRows(ctx, 30_000)
    const offlineCounts = await wordbookCounts(ctx)
    ctx.check(
      'wordbook opens offline from the projection',
      Number(offlineCounts[4] ?? 0) + Number(offlineCounts[1] ?? 0) + Number(offlineCounts[2] ?? 0) + Number(offlineCounts[3] ?? 0) ===
        LONG_COUNT + MEDIUM_COUNT + SHORT_COUNT,
      offlineCounts.join(' | '),
    )
    await searchWordbook(ctx, SEARCH_LEMMA)
    await ctx.waitFor(
      `[...document.querySelectorAll('[data-wordbook-lemma]')].some((node) => node.innerText === ${JSON.stringify(SEARCH_LEMMA)})`,
      'offline wordbook search',
    )
    ctx.check('offline wordbook search works', true, SEARCH_LEMMA)
    await ctx.goOffline(false)

    // ── second device: wordbook without document text ─────────────────────
    await ctx.resetOrigin()
    await startSession(ctx, { config, session })
    await waitForAppReady(ctx)
    await waitForProjectionComplete(ctx, user.id, PROJECTION_LANGUAGE, 180_000)

    const secondContent = await storeCount(ctx, 'documentContent')
    const secondOccurrences = await storeCount(ctx, 'wordOccurrences')
    const secondRows = await storeRows(ctx, 'wordbookEntries')
    ctx.check(
      'a new device gets the projection on its first sync',
      secondRows.length === LONG_COUNT + MEDIUM_COUNT + SHORT_COUNT,
      `${secondRows.length} rows`,
    )
    ctx.check(
      'the new device has no document bodies before opening one',
      secondContent === 0,
      `${secondContent} content rows`,
    )
    ctx.check(
      'the new device downloads no occurrence rows',
      secondOccurrences === 0,
      `${secondOccurrences} occurrence rows`,
    )

    await navigate(ctx, '/wordbook')
    await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, 'wordbook')
    await gotoUnmarkedTab(ctx)
    await waitForWordbookRows(ctx)
    const secondCounts = await wordbookCounts(ctx)
    ctx.check(
      'the new device wordbook is complete without document text',
      Number(secondCounts[4] ?? 0) + Number(secondCounts[1] ?? 0) + Number(secondCounts[2] ?? 0) + Number(secondCounts[3] ?? 0) ===
        LONG_COUNT + MEDIUM_COUNT + SHORT_COUNT,
      secondCounts.join(' | '),
    )

    // Clean up the session's user so a rerun starts from the same state.
    await ctx.page.evaluate(`localStorage.clear(); true`)
    await deleteTestUser(config, user.id)
  } catch (error) {
    await deleteTestUser(config, user.id).catch(() => {})
    throw error
  }
}

export const meta = { email: EMAIL, password: DEFAULT_PASSWORD }
