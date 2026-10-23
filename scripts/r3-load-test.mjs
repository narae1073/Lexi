/**
 * Blocking R3 refresh load gate.
 *
 *   node scripts/r3-load-test.mjs --users 4 --edits 100 --concurrency 4
 *
 * Measures `replace_word_occurrences` end to end against the local seed:
 *
 *   effective: every edited document gets one real row change and one refresh;
 *   no-op:     the same document is pushed again unchanged.
 *
 * Fails (exit 1) on any error/deadlock/retry, on any source/projection write in
 * the no-op phase, when effective p95 >= 100 ms or p99 >= 250 ms, or when the
 * projection disagrees with the source aggregate. Smoke mode checks the
 * structural invariants only and is not the gate.
 *
 * Local only: `resolveLocalConfig` refuses every non-loopback URL.
 */

import {
  EMAIL_PREFIX,
  adminListUsers,
  emitResult,
  log,
  newRunId,
  parseFlags,
  passwordFrom,
  positiveInt,
  psql,
  psqlJson,
  resolveLocalConfig,
  seedUserIndex,
  signIn,
  sleep,
  sqlLiteral,
  summarize,
  uuidList,
  writeResult,
} from './r3-load-common.mjs'

const P95_LIMIT_MS = 100
const P99_LIMIT_MS = 250

// The full gate may not run on a smaller fixture. Smoke mode is the explicit
// non-gating escape hatch. These are the fixture's documented scale contract.
const REQUIRED_USERS = 4
const REQUIRED_OCCURRENCES_PER_USER = 200_000
const REQUIRED_DOCUMENTS_PER_USER = 1_112
const REQUIRED_WORD_STATES_PER_USER = 23_200

const USAGE = `Usage: node scripts/r3-load-test.mjs [options]
  --users N          seed users to push as (default 4; full mode requires >= 4)
  --edits N          effective document edits to measure (default 100)
  --concurrency N    concurrent in-flight pushes (default 4)
  --warmup N         unmeasured edits per user (default 1, 0 in --smoke)
  --smoke            structural checks only; fixture scale, p95 and p99 are not gated
  --url URL          local Supabase API URL (loopback only)
  --db-container C   local Postgres container (default supabase_db_<project>)
  --password P       test-user password
  --help             print this help

Full mode requires the 4 x 200,000 fixture:
  4 users, 800,000 occurrences, 4,448 documents, 92,800 word states.`

function parseLoadFlags(argv) {
  const flags = parseFlags(argv)
  const smoke = Boolean(flags.smoke)
  const warmup = flags.warmup === undefined ? (smoke ? 0 : 1) : Number(flags.warmup)
  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new Error(`--warmup must be a non-negative integer (got ${flags.warmup})`)
  }
  return {
    flags,
    users: positiveInt(flags, 'users', 4),
    edits: positiveInt(flags, 'edits', 100),
    concurrency: positiveInt(flags, 'concurrency', 4),
    smoke,
    warmup,
  }
}

async function runPool(items, concurrency, worker) {
  let next = 0
  const width = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        await worker(items[index], index)
      }
    }),
  )
}

async function fetchDocumentRows(config, documentId) {
  const query = new URLSearchParams({
    select: 'language_code,lemma,surface,char_start,char_end,sentence,occurrences_count',
    document_id: `eq.${documentId}`,
    order: 'lemma.asc,surface.asc',
    limit: '1000',
  })
  const rows = await restGet(config, `/rest/v1/word_occurrences?${query}`)
  if (!Array.isArray(rows)) throw new Error(`Occurrence fetch for ${documentId} was not an array`)
  if (rows.length >= 1000) {
    throw new Error(
      `Occurrence fetch for ${documentId} returned ${rows.length} rows; ` +
        'the fixture expects fewer than 1,000 so the payload is complete.',
    )
  }
  return rows
}

async function restGet(config, path) {
  const response = await fetch(`${config.url}${path}`, {
    headers: {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
    },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

async function fetchDocuments(config, userId, needed) {
  const query = new URLSearchParams({
    select: 'id,title',
    user_id: `eq.${userId}`,
    deleted_at: 'is.null',
    order: 'id.asc',
    limit: String(Math.min(1000, Math.max(1, needed))),
  })
  const rows = await restGet(config, `/rest/v1/documents?${query}`)
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`No documents found for seed user ${userId}; run the seed first`)
  }
  return rows
}

async function pushOccurrences(config, token, documentId, rows) {
  const response = await fetch(`${config.url}/rest/v1/rpc/replace_word_occurrences`, {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_document_id: documentId, p_rows: rows }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }
  const serialized = JSON.stringify(payload ?? '')
  return {
    ok: response.ok,
    status: response.status,
    code: payload?.code ?? null,
    message: payload?.message ?? (response.ok ? null : String(payload ?? response.statusText)),
    deadlock: payload?.code === '40P01' || /deadlock detected/i.test(serialized),
  }
}

function targetFor(rows, userIndex, ordinal) {
  const firstByLemma = new Map()
  const lemmas = []
  for (const row of rows) {
    if (!firstByLemma.has(row.lemma)) {
      firstByLemma.set(row.lemma, row)
      lemmas.push(row.lemma)
    }
  }
  if (lemmas.length === 0) throw new Error('Document has no occurrence rows')
  // Sample a stable subset of the document's distinct lemmas. Every user has
  // the same 25k-lemma pool, so a target is shared across users even when it is
  // cold; hot lemmas appear in up to ~22 documents. The index varies per
  // user/edit so concurrent pushes do not all target the same lemma.
  const window = Math.min(97, lemmas.length)
  const lemma = lemmas[((userIndex * 7 + ordinal * 13) % window + window) % window]
  return { lemma, row: firstByLemma.get(lemma), candidateLemmas: lemmas.length }
}

function editedOccurrence(row, token) {
  // Strip a harness tag from an earlier run so repeated gates on the same
  // fixture cannot grow a sentence past the 5,000-character constraint.
  const previous = row.sentence.replace(/\s+\[(?:r3e|r3w)-[^\]]*\]$/, '')
  const candidate = `${previous} [${token}]`
  const sentence =
    candidate.length <= 4800
      ? candidate
      : `We saw the ${row.surface} in an edited passage. [${token}]`
  const charStart = sentence.indexOf(row.surface)
  return {
    ...row,
    sentence,
    char_start: charStart < 0 ? 0 : charStart,
    char_end: charStart < 0 ? row.surface.length : charStart + row.surface.length,
  }
}

function effectivePayload(rows, target, token) {
  return rows.map((row) => (row === target.row ? editedOccurrence(row, token) : row))
}

async function measurePush(config, token, documentId, rows) {
  const started = performance.now()
  try {
    const outcome = await pushOccurrences(config, token, documentId, rows)
    return { ...outcome, durationMs: performance.now() - started }
  } catch (error) {
    return {
      ok: false,
      status: null,
      code: null,
      message: error.message ?? String(error),
      deadlock: false,
      durationMs: performance.now() - started,
    }
  }
}

function fingerprintSql(userIds) {
  return `
    select jsonb_build_object(
      'occurrences', (
        select md5(string_agg(o.id::text || ':' || o.xmin::text, ',' order by o.id))
        from public.word_occurrences o
        where o.user_id = any(${uuidList(userIds)})
      ),
      'projection', (
        select md5(string_agg(
          e.user_id::text || ':' || e.language_code || ':' || e.lemma || ':' || e.xmin::text,
          ',' order by e.user_id, e.language_code, e.lemma
        ))
        from public.wordbook_entries e
        where e.user_id = any(${uuidList(userIds)})
      ),
      'documents', (
        select md5(string_agg(
          d.id::text || ':' || d.xmin::text || ':' || d.server_updated_at::text,
          ',' order by d.id
        ))
        from public.documents d
        where d.user_id = any(${uuidList(userIds)})
      )
    );
  `
}

function effectiveChecksSql(userIds, targets, phaseStart) {
  const values = targets
    .map(
      (target) =>
        `(${sqlLiteral(target.userId)}::uuid, ${sqlLiteral(target.documentId)}::uuid, ` +
        `${sqlLiteral(target.lemma)}, ${sqlLiteral(target.token)})`,
    )
    .join(',\n')
  const insert =
    targets.length === 0
      ? ''
      : `insert into _r3_targets values\n${values};`
  return `
    create temp table _r3_targets (
      user_id uuid not null,
      document_id uuid not null,
      lemma text not null,
      token text not null
    );
    ${insert}

    select jsonb_build_object(
      'targets', (select count(*) from _r3_targets),
      'targetsRefreshed', (
        select count(*)
        from _r3_targets t
        join public.wordbook_entries e
          on e.user_id = t.user_id
         and e.language_code = 'en'
         and e.lemma = t.lemma
        where e.server_updated_at >= ${sqlLiteral(phaseStart)}
      ),
      'sourceRowsUpdated', (
        select count(*)
        from _r3_targets t
        join public.word_occurrences o
          on o.user_id = t.user_id
         and o.document_id = t.document_id
         and o.lemma = t.lemma
        where position(t.token in o.sentence) > 0
      ),
      'projectionWrites', (
        select count(*)
        from public.wordbook_entries e
        where e.user_id = any(${uuidList(userIds)})
          and e.server_updated_at >= ${sqlLiteral(phaseStart)}
      ),
      'documentsUpdated', (
        select count(*)
        from public.documents d
        where d.user_id = any(${uuidList(userIds)})
          and d.occurrences_updated_at >= ${sqlLiteral(phaseStart)}
      ),
      'documentsServerUpdated', (
        select count(*)
        from public.documents d
        where d.user_id = any(${uuidList(userIds)})
          and d.server_updated_at >= ${sqlLiteral(phaseStart)}
      ),
      'refreshQueue', (
        select count(*)
        from public.wordbook_refresh_queue q
        where q.user_id = any(${uuidList(userIds)})
      ),
      'sharedLemmas', (
        select jsonb_build_object(
          'targetLemmas', count(*),
          'minUsersPerLemma', coalesce(min(u.users), 0),
          'minDocumentCount', min(u.document_count),
          'maxDocumentCount', max(u.document_count),
          'avgDocumentCount', round(avg(u.document_count)::numeric, 1)
        )
        from (
          select
            t.lemma,
            count(distinct e.user_id) as users,
            max(e.document_count) as document_count
          from (select distinct lemma from _r3_targets) t
          join public.wordbook_entries e
            on e.user_id = any(${uuidList(userIds)})
           and e.lemma = t.lemma
          group by t.lemma
        ) u
      )
    );
  `
}

function noopChecksSql(userIds, noopStart) {
  return `
    select jsonb_build_object(
      'projectionWrites', (
        select count(*)
        from public.wordbook_entries e
        where e.user_id = any(${uuidList(userIds)})
          and e.server_updated_at >= ${sqlLiteral(noopStart)}
      ),
      'documentsWrites', (
        select count(*)
        from public.documents d
        where d.user_id = any(${uuidList(userIds)})
          and (d.server_updated_at >= ${sqlLiteral(noopStart)}
               or d.occurrences_updated_at >= ${sqlLiteral(noopStart)})
      ),
      'refreshQueue', (
        select count(*)
        from public.wordbook_refresh_queue q
        where q.user_id = any(${uuidList(userIds)})
      )
    );
  `
}

function consistencySql(userIds) {
  return `
    with seed_users as (
      select unnest(${uuidList(userIds)}) as user_id
    ),
    per_document as (
      select
        o.user_id,
        o.language_code,
        o.lemma,
        o.document_id,
        max(o.occurrences_count)::int as occurrences_count
      from public.word_occurrences o
      where o.user_id in (select user_id from seed_users)
      group by o.user_id, o.language_code, o.lemma, o.document_id
    ),
    totals as (
      select
        user_id,
        language_code,
        lemma,
        count(*)::int as document_count,
        sum(occurrences_count)::int as occurrence_count
      from per_document
      group by user_id, language_code, lemma
    ),
    surfaces as (
      select
        o.user_id,
        o.language_code,
        o.lemma,
        array_agg(distinct o.surface order by o.surface) as surfaces
      from public.word_occurrences o
      where o.user_id in (select user_id from seed_users)
      group by o.user_id, o.language_code, o.lemma
    ),
    contexts as (
      select
        c.user_id,
        c.language_code,
        c.lemma,
        jsonb_agg(
          jsonb_build_object('documentId', c.document_id, 'sentence', c.sentence)
          order by c.document_id, c.sentence
        ) as contexts
      from (
        select distinct
          o.user_id,
          o.language_code,
          o.lemma,
          o.document_id,
          o.sentence
        from public.word_occurrences o
        where o.user_id in (select user_id from seed_users)
          and btrim(o.sentence) <> ''
      ) c
      group by c.user_id, c.language_code, c.lemma
    ),
    expected as (
      select
        t.user_id,
        t.language_code,
        t.lemma,
        t.occurrence_count,
        t.document_count,
        s.surfaces,
        coalesce(c.contexts, '[]'::jsonb) as contexts
      from totals t
      join surfaces s using (user_id, language_code, lemma)
      left join contexts c using (user_id, language_code, lemma)
    ),
    mismatches as (
      select e.user_id, e.lemma, 'mismatch' as kind
      from expected e
      left join public.wordbook_entries p
        on p.user_id = e.user_id
       and p.language_code = e.language_code
       and p.lemma = e.lemma
      where p.user_id is null
         or p.deleted_at is not null
         or p.occurrence_count is distinct from e.occurrence_count
         or p.document_count is distinct from e.document_count
         or p.surfaces is distinct from e.surfaces
         or p.contexts is distinct from e.contexts

      union all

      select p.user_id, p.lemma, 'orphan' as kind
      from public.wordbook_entries p
      where p.user_id in (select user_id from seed_users)
        and p.deleted_at is null
        and not exists (
          select 1
          from expected e
          where e.user_id = p.user_id
            and e.language_code = p.language_code
            and e.lemma = p.lemma
        )
    )
    select jsonb_build_object(
      'expectedEntries', (select count(*) from expected),
      'liveEntries', (
        select count(*) from public.wordbook_entries p
        where p.user_id in (select user_id from seed_users) and p.deleted_at is null
      ),
      'softDeletedEntries', (
        select count(*) from public.wordbook_entries p
        where p.user_id in (select user_id from seed_users) and p.deleted_at is not null
      ),
      'mismatchCount', (select count(*) from mismatches),
      'mismatches', (
        select coalesce(jsonb_agg(m), '[]'::jsonb)
        from (select * from mismatches limit 10) m
      ),
      'sourceOccurrences', (
        select count(*) from public.word_occurrences o
        where o.user_id in (select user_id from seed_users)
      ),
      'sourceDocuments', (
        select count(*) from public.documents d
        where d.user_id in (select user_id from seed_users)
      ),
      'sourceWordStates', (
        select count(*) from public.word_states ws
        where ws.user_id in (select user_id from seed_users)
      ),
      'documentsWithHash', (
        select count(*) from public.documents d
        where d.user_id in (select user_id from seed_users)
          and d.occurrences_hash is not null
      ),
      'refreshQueue', (
        select count(*) from public.wordbook_refresh_queue q
        where q.user_id in (select user_id from seed_users)
      )
    );
  `
}

function scaleSql(userIds) {
  return `
    with seed_users as (
      select unnest(${uuidList(userIds)}) as user_id
    ),
    per_user as (
      select
        u.user_id,
        (select count(*) from public.word_occurrences o where o.user_id = u.user_id) as occurrences,
        (select count(*) from public.documents d where d.user_id = u.user_id) as documents,
        (select count(*) from public.word_states ws where ws.user_id = u.user_id) as word_states
      from seed_users u
    )
    select jsonb_build_object(
      'perUser', (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'userId', user_id,
              'occurrences', occurrences,
              'documents', documents,
              'wordStates', word_states
            )
            order by user_id
          ),
          '[]'::jsonb
        )
        from per_user
      ),
      'minOccurrencesPerUser', (select coalesce(min(occurrences), 0) from per_user),
      'minDocumentsPerUser', (select coalesce(min(documents), 0) from per_user),
      'minWordStatesPerUser', (select coalesce(min(word_states), 0) from per_user),
      'totalOccurrences', (select coalesce(sum(occurrences), 0) from per_user),
      'totalDocuments', (select coalesce(sum(documents), 0) from per_user),
      'totalWordStates', (select coalesce(sum(word_states), 0) from per_user)
    );
  `
}

async function main() {
  const started = Date.now()
  const runId = newRunId()
  const { flags, users, edits, concurrency, smoke, warmup } = parseLoadFlags(
    process.argv.slice(2),
  )
  if (flags.help) {
    console.error(USAGE)
    return
  }
  const config = resolveLocalConfig(flags)
  const password = passwordFrom(flags)

  const allUsers = (await adminListUsers(config))
    .filter((user) => (user.email ?? '').startsWith(EMAIL_PREFIX))
    .sort((a, b) => seedUserIndex(a.email) - seedUserIndex(b.email))

  if (allUsers.length < users) {
    throw new Error(
      `Found ${allUsers.length} seed user(s) but --users ${users}. ` +
        'Run `npm run r3:seed -- --users 4 --occurrences 200000 --documents 1112 --clean` first.',
    )
  }
  const seedUsers = allUsers.slice(0, users)
  if (allUsers.length > users) {
    log(`Note: ${allUsers.length} seed users exist; using the first ${users}.`)
  }

  log(`Load gate against ${config.url} (${seedUsers.length} seed users)`)
  const tokens = new Map()
  await Promise.all(
    seedUsers.map(async (user) => {
      tokens.set(user.id, await signIn(config, user.email, password))
    }),
  )

  const baseEdits = Math.floor(edits / users)
  const remainder = edits % users
  const editsPerUser = seedUsers.map((_, index) => baseEdits + (index < remainder ? 1 : 0))
  const maxEdits = Math.max(...editsPerUser)
  const neededDocs = warmup + maxEdits

  const documentsByUser = new Map()
  for (const user of seedUsers) {
    const docs = await fetchDocuments(config, user.id, neededDocs)
    documentsByUser.set(user.id, docs)
  }

  // ── warm-up (not measured, but still a real edit) ───────────────────────
  const warmupResults = []
  if (warmup > 0) {
    const warmupTasks = []
    for (const [userIndex, user] of seedUsers.entries()) {
      const docs = documentsByUser.get(user.id)
      for (let w = 0; w < warmup; w += 1) {
        const doc = docs[w % docs.length]
        warmupTasks.push({ userIndex, user, doc, ordinal: -1 - w, warmup: true })
      }
    }
    await runPool(warmupTasks, concurrency, async (task) => {
      const rows = await fetchDocumentRows(config, task.doc.id)
      const target = targetFor(rows, task.userIndex, task.ordinal)
      const token = `r3w-${runId}-${task.userIndex}-${task.ordinal}`
      const outcome = await measurePush(
        config,
        tokens.get(task.user.id),
        task.doc.id,
        effectivePayload(rows, target, token),
      )
      warmupResults.push(outcome)
      if (!outcome.ok) {
        throw new Error(`Warm-up push failed: ${outcome.status} ${outcome.code ?? ''} ${outcome.message}`)
      }
    })
    log(`Warm-up: ${warmupResults.length} edit(s), ${summarize(warmupResults.map((r) => r.durationMs)).p95} ms p95`)
  }

  // ── effective phase ─────────────────────────────────────────────────────
  // Interleave users round-robin. With concurrency 4 and 4 users the four
  // in-flight requests belong to four different users, which is the scenario
  // the gate describes. Grouping by user would instead stack four requests on
  // the same user and measure the per-user advisory lock queue.
  const effectiveTasks = []
  const maxEditsPerUser = Math.max(...editsPerUser)
  for (let ordinal = 0; ordinal < maxEditsPerUser; ordinal += 1) {
    for (const [userIndex, user] of seedUsers.entries()) {
      if (ordinal >= editsPerUser[userIndex]) continue
      const docs = documentsByUser.get(user.id)
      effectiveTasks.push({
        userIndex,
        user,
        doc: docs[(warmup + ordinal) % docs.length],
        ordinal,
      })
    }
  }

  const effectiveResults = []
  const targets = []
  const docOwner = new Map()
  for (const task of effectiveTasks) docOwner.set(task.doc.id, task.user)
  let candidateLemmas = 0
  const phaseStart = (await psql(config, 'select clock_timestamp();')).trim()
  log(`Effective phase: ${effectiveTasks.length} edits, concurrency ${concurrency}`)

  await runPool(effectiveTasks, concurrency, async (task) => {
    let rows
    try {
      rows = await fetchDocumentRows(config, task.doc.id)
    } catch (error) {
      effectiveResults.push({
        ok: false,
        status: null,
        code: null,
        message: error.message,
        deadlock: false,
        durationMs: 0,
      })
      return
    }

    const target = targetFor(rows, task.userIndex, task.ordinal)
    candidateLemmas += target.candidateLemmas
    const token = `r3e-${runId}-${task.userIndex}-${task.ordinal}`
    targets.push({
      userId: task.user.id,
      documentId: task.doc.id,
      lemma: target.lemma,
      token,
    })

    const outcome = await measurePush(
      config,
      tokens.get(task.user.id),
      task.doc.id,
      effectivePayload(rows, target, token),
    )
    effectiveResults.push(outcome)
  })

  const effectiveDurations = effectiveResults.map((result) => result.durationMs)
  const effectiveSuccessDurations = effectiveResults
    .filter((result) => result.ok)
    .map((result) => result.durationMs)
  const effectiveErrors = effectiveResults.filter((result) => !result.ok).length
  const effectiveDeadlocks = effectiveResults.filter((result) => result.deadlock).length

  const effectiveStats = await psqlJson(
    config,
    effectiveChecksSql(seedUsers.map((user) => user.id), targets, phaseStart),
  )

  // ── no-op phase ─────────────────────────────────────────────────────────
  // Fetch each measured document's current rows after all effective edits, so
  // the payload is byte-for-byte the canonical stored set.
  const editedDocs = new Map()
  for (const task of effectiveTasks) editedDocs.set(task.doc.id, task.doc)
  const noopTasks = [...editedDocs.values()]
  const noopPayloads = new Map()
  await runPool(noopTasks, 8, async (doc) => {
    noopPayloads.set(doc.id, await fetchDocumentRows(config, doc.id))
  })

  const beforeNoop = await psqlJson(config, fingerprintSql(seedUsers.map((user) => user.id)))
  const noopStart = (await psql(config, 'select clock_timestamp();')).trim()
  const noopResults = []
  log(`No-op phase: ${noopTasks.length} identical pushes, concurrency ${concurrency}`)

  await runPool(noopTasks, concurrency, async (doc) => {
    const user = docOwner.get(doc.id)
    const outcome = await measurePush(
      config,
      tokens.get(user.id),
      doc.id,
      noopPayloads.get(doc.id),
    )
    noopResults.push(outcome)
  })

  // Stats are flushed at transaction end; give PostgREST a moment before the
  // watermark/fingerprint queries.
  await sleep(150)
  const afterNoop = await psqlJson(config, fingerprintSql(seedUsers.map((user) => user.id)))
  const noopStats = await psqlJson(config, noopChecksSql(seedUsers.map((user) => user.id), noopStart))

  const noopErrors = noopResults.filter((result) => !result.ok).length
  const noopDeadlocks = noopResults.filter((result) => result.deadlock).length
  const noopDurations = noopResults.map((result) => result.durationMs)

  // ── source/projection consistency ───────────────────────────────────────
  const consistency = await psqlJson(config, consistencySql(seedUsers.map((user) => user.id)))
  const scale = await psqlJson(config, scaleSql(seedUsers.map((user) => user.id)))

  const scaleChecks = {
    users: users >= REQUIRED_USERS,
    occurrences:
      scale.minOccurrencesPerUser >= REQUIRED_OCCURRENCES_PER_USER &&
      scale.totalOccurrences >= users * REQUIRED_OCCURRENCES_PER_USER,
    documents:
      scale.minDocumentsPerUser >= REQUIRED_DOCUMENTS_PER_USER &&
      scale.totalDocuments >= users * REQUIRED_DOCUMENTS_PER_USER,
    wordStates:
      scale.minWordStatesPerUser >= REQUIRED_WORD_STATES_PER_USER &&
      scale.totalWordStates >= users * REQUIRED_WORD_STATES_PER_USER,
  }
  const scaleOk = Object.values(scaleChecks).every(Boolean)

  const effectiveSummary = summarize(effectiveDurations)
  const effectiveSuccessSummary = summarize(effectiveSuccessDurations)
  const noopSummary = summarize(noopDurations)

  const expectedDocumentUpdates = Math.min(edits, editedDocs.size)
  const checks = {
    effectiveCount: effectiveResults.length === edits,
    effectiveAllSucceeded: effectiveErrors === 0,
    noDeadlocks: effectiveDeadlocks === 0 && noopDeadlocks === 0,
    noRetries: true,
    targetsRecorded: targets.length === edits,
    oneRefreshPerEdit: effectiveStats?.targetsRefreshed === edits,
    oneProjectionWritePerEdit: effectiveStats?.projectionWrites === edits,
    oneSourceRowPerEdit: effectiveStats?.sourceRowsUpdated === edits,
    oneDocumentWritePerEdit: effectiveStats?.documentsUpdated === expectedDocumentUpdates,
    documentServerWatermarkAdvanced:
      effectiveStats?.documentsServerUpdated === expectedDocumentUpdates,
    noRefreshQueueGrowth:
      effectiveStats?.refreshQueue === 0 && noopStats?.refreshQueue === 0,
    noopAllSucceeded: noopErrors === 0,
    noopProjectionWritesZero: noopStats?.projectionWrites === 0,
    noopDocumentWritesZero: noopStats?.documentsWrites === 0,
    noopSourceUnchanged: beforeNoop?.occurrences === afterNoop?.occurrences,
    noopProjectionUnchanged: beforeNoop?.projection === afterNoop?.projection,
    noopDocumentsUnchanged: beforeNoop?.documents === afterNoop?.documents,
    countsConsistent:
      consistency?.expectedEntries > 0 &&
      consistency?.mismatchCount === 0 &&
      consistency?.liveEntries === consistency?.expectedEntries &&
      consistency?.softDeletedEntries === 0 &&
      consistency?.refreshQueue === 0,
  }

  if (!smoke) {
    checks.fixtureUsers = scaleChecks.users
    checks.fixtureOccurrences = scaleChecks.occurrences
    checks.fixtureDocuments = scaleChecks.documents
    checks.fixtureWordStates = scaleChecks.wordStates
    checks.effectiveP95 = effectiveSummary.p95 !== null && effectiveSummary.p95 < P95_LIMIT_MS
    checks.effectiveP99 = effectiveSummary.p99 !== null && effectiveSummary.p99 < P99_LIMIT_MS
  }

  const failures = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
  const pass = failures.length === 0

  const result = {
    kind: 'load',
    pass,
    smoke,
    startedAt: new Date(started).toISOString(),
    completedAt: new Date().toISOString(),
    url: config.url,
    gate: smoke
      ? {
          enforced: false,
          mode: 'smoke',
          steadyState: false,
          warmupExcluded: warmup > 0,
          scaleAsserted: false,
          p95Ms: null,
          p99Ms: null,
          note: 'smoke mode checks structure only; fixture scale, p95 and p99 are not gated',
        }
      : {
          enforced: true,
          mode: 'steady-state',
          steadyState: warmup > 0,
          warmupExcluded: warmup > 0,
          scaleAsserted: true,
          p95Ms: P95_LIMIT_MS,
          p99Ms: P99_LIMIT_MS,
          scaleContract: {
            usersAtLeast: REQUIRED_USERS,
            occurrencesPerUser: REQUIRED_OCCURRENCES_PER_USER,
            documentsPerUser: REQUIRED_DOCUMENTS_PER_USER,
            wordStatesPerUser: REQUIRED_WORD_STATES_PER_USER,
          },
          note: 'measured effective phase after warm-up; warm-up edits are reported separately and excluded',
        },
    measurement: {
      steadyState: !smoke && warmup > 0,
      warmupExcluded: warmup > 0,
      measuredEffectiveEdits: effectiveResults.length,
      warmupEdits: warmupResults.length,
      note: smoke
        ? 'smoke mode; not a gate'
        : warmup > 0
          ? 'p95/p99 cover the measured effective phase only; warm-up is excluded'
          : 'no warm-up was requested; p95/p99 include first-request cost',
    },
    scale: {
      asserted: !smoke,
      ok: smoke ? null : scaleOk,
      required: {
        users: REQUIRED_USERS,
        occurrencesPerUser: REQUIRED_OCCURRENCES_PER_USER,
        documentsPerUser: REQUIRED_DOCUMENTS_PER_USER,
        wordStatesPerUser: REQUIRED_WORD_STATES_PER_USER,
        totalOccurrencesAtLeast: users * REQUIRED_OCCURRENCES_PER_USER,
        totalDocumentsAtLeast: users * REQUIRED_DOCUMENTS_PER_USER,
        totalWordStatesAtLeast: users * REQUIRED_WORD_STATES_PER_USER,
      },
      actual: scale,
      checks: smoke ? null : scaleChecks,
    },
    config: {
      users,
      edits,
      concurrency,
      warmupEditsPerUser: warmup,
      seedEmails: seedUsers.map((user) => user.email),
      documentsSampledMin: Math.min(
        ...[...documentsByUser.values()].map((docs) => docs.length),
      ),
    },
    effective: {
      attempts: effectiveResults.length,
      succeeded: effectiveResults.length - effectiveErrors,
      errors: effectiveErrors,
      deadlocks: effectiveDeadlocks,
      retries: 0,
      durationsMs: effectiveDurations,
      summary: effectiveSummary,
      successfulSummary: effectiveSuccessSummary,
      candidateLemmas,
      sharedLemmas: effectiveStats?.sharedLemmas ?? null,
      stats: effectiveStats,
    },
    noop: {
      attempts: noopResults.length,
      succeeded: noopResults.length - noopErrors,
      errors: noopErrors,
      deadlocks: noopDeadlocks,
      retries: 0,
      durationsMs: noopDurations,
      summary: noopSummary,
      writes: noopStats,
      fingerprintsBefore: beforeNoop,
      fingerprintsAfter: afterNoop,
    },
    warmup: {
      attempts: warmupResults.length,
      excludedFromGate: true,
      durationsMs: warmupResults.map((result) => result.durationMs),
      summary: summarize(warmupResults.map((result) => result.durationMs)),
    },
    consistency,
    checks,
    failures,
  }

  const resultPath = await writeResult('load', result)
  log(`Load result written to ${resultPath}`)
  emitResult(result)
  if (!pass) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error))
  process.exitCode = 1
})
