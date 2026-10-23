/**
 * Deterministic local fixture for the R3 wordbook-projection load gate.
 *
 *   node scripts/seed-r3-load.mjs --users 4 --occurrences 200000 --documents 1112 --clean
 *
 * Every user gets one folder, 1,112 documents, 200,000 occurrence rows, and
 * 23,200 word states. Data is generated from fixed seeds, so a rerun with
 * --clean removes the same `r3-load-*` users (cascade) and recreates identical
 * row ids.
 *
 * Local only: `assertLocalSupabaseUrl` rejects every host except loopback.
 * Auth users are created through the local GoTrue admin API with the service
 * role key; bulk rows go through the local Postgres container with COPY.
 */

import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EMAIL_PREFIX,
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  deterministicUuid,
  emitResult,
  log,
  parseFlags,
  passwordFrom,
  positiveInt,
  psql,
  psqlFile,
  psqlJson,
  resolveLocalConfig,
  seedEmail,
  seedUserIndex,
  sqlLiteral,
  uuidList,
  writeResult,
} from './r3-load-common.mjs'

const HOT_POOL = 5_000
const COLD_POOL = 20_000
const LEMMA_POOL = HOT_POOL + COLD_POOL
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const STAR_COLORS = ['#eab308', '#ef4444', '#3b82f6', '#22c55e', '#a855f7', '#f97316']

const USAGE = `Usage: node scripts/seed-r3-load.mjs [options]
  --users N          local auth users to create (default 4)
  --occurrences N    occurrence rows per user (default 200000)
  --documents N      documents per user (default 1112)
  --states N         word states per user (default 23200, capped by lemmas)
  --clean            delete the r3-load-* users and cascade their rows first
  --url URL          local Supabase API URL (loopback only)
  --db-container C   local Postgres container (default supabase_db_<project>)
  --password P       test-user password
  --help             print this help`

// Pronounceable synthetic lemmas: three CV syllables give 25,000 distinct
// forms, close to the production distribution without shipping a word list.
const ONSETS = [
  'b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm',
  'n', 'p', 'r', 's', 't', 'v', 'w', 'y', 'z', 'br',
  'dr', 'fr', 'gr', 'tr', 'st',
]
const RIMES = [
  'a', 'e', 'i', 'o', 'u', 'ai', 'ea', 'ee', 'oa', 'oo',
  'ou', 'an', 'en', 'in', 'on', 'un', 'ar', 'er', 'ir', 'or',
]

function syllable(code) {
  const onset = ONSETS[code % ONSETS.length]
  const rime = RIMES[Math.floor(code / ONSETS.length) % RIMES.length]
  return onset + rime
}

const LEMMAS = (() => {
  const names = []
  for (let id = 0; id < LEMMA_POOL; id += 1) {
    const a = Math.floor(id / 2500)
    const b = Math.floor((id % 2500) / 50)
    const c = id % 50
    names.push(syllable(a * 20 + b) + syllable(c * 10 + a) + syllable(b * 5 + c))
  }
  if (new Set(names).size !== names.length) {
    throw new Error('Lemma generator produced a collision; refusing deterministic fixture')
  }
  return names
})()

function lemmaAt(id) {
  return LEMMAS[id]
}

function rowsPerDocument(occurrences, documents, docIndex) {
  const base = Math.floor(occurrences / documents)
  const remainder = occurrences % documents
  return base + (docIndex < remainder ? 1 : 0)
}

/**
 * The lemma plan for one document. 60% hot lemmas (shared by every user and
 * many documents), 40% cold lemmas, and ~10% extra surface rows for the same
 * lemma so a document has more rows than distinct lemmas, like production.
 */
function planDocument(docIndex, rowCount) {
  const distinctCount = Math.max(1, Math.min(rowCount, Math.floor(rowCount * 0.9)))
  const duplicateCount = rowCount - distinctCount
  const hotCount = Math.min(HOT_POOL, Math.max(1, Math.round(distinctCount * 0.6)))
  const coldCount = Math.min(COLD_POOL, distinctCount - hotCount)
  const hotStart = (docIndex * hotCount) % HOT_POOL
  const coldStart = (docIndex * coldCount) % COLD_POOL

  const hot = Array.from({ length: hotCount }, (_, j) => (hotStart + j) % HOT_POOL)
  const cold = Array.from(
    { length: coldCount },
    (_, j) => HOT_POOL + ((coldStart + j) % COLD_POOL),
  )

  return { distinct: [...hot, ...cold], duplicateCount }
}

function occurrenceRows(docIndex, plan) {
  const rows = []
  for (let j = 0; j < plan.distinct.length; j += 1) {
    const lemmaId = plan.distinct[j]
    const lemma = lemmaAt(lemmaId)
    const count = 1 + ((lemmaId * 7 + docIndex) % 4)
    rows.push(occurrenceRow(docIndex, lemmaId, lemma, count, false))
    if (j < plan.duplicateCount) {
      rows.push(occurrenceRow(docIndex, lemmaId, lemma, count, true))
    }
  }
  return rows
}

function occurrenceRow(docIndex, lemmaId, lemma, count, inflected) {
  const surface = inflected ? `${lemma}s` : lemma
  const unit = lemmaId % 97
  const sentence = inflected
    ? `They noted the ${surface} near passage ${docIndex + 1} of unit ${unit}.`
    : `We saw the ${surface} while reading passage ${docIndex + 1} of unit ${unit}.`
  const charStart = sentence.indexOf(surface)
  if (charStart < 0) throw new Error(`Generated sentence does not contain ${surface}`)
  return {
    language_code: 'en',
    lemma,
    surface,
    char_start: charStart,
    char_end: charStart + surface.length,
    sentence,
    occurrences_count: count,
  }
}

function documentText(docIndex) {
  const words = []
  for (let i = 0; i < 220; i += 1) {
    words.push(lemmaAt((docIndex * 31 + i * 7) % LEMMA_POOL))
  }
  return `${words.join(' ')}.`
}

function csv(value) {
  if (value === null || value === undefined || value === '') return ''
  const text = value instanceof Date ? value.toISOString() : String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

async function writeLine(stream, line) {
  if (!stream.write(`${line}\n`)) await once(stream, 'drain')
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function parseSeedFlags(argv) {
  const flags = parseFlags(argv)
  return {
    flags,
    users: positiveInt(flags, 'users', 4),
    occurrences: positiveInt(flags, 'occurrences', 200_000),
    documents: positiveInt(flags, 'documents', 1112),
    states: positiveInt(flags, 'states', 23_200),
    clean: Boolean(flags.clean),
  }
}

async function main() {
  const started = Date.now()
  const { flags, users, occurrences, documents, states, clean } = parseSeedFlags(process.argv.slice(2))
  if (flags.help) {
    console.error(USAGE)
    return
  }
  if (occurrences < documents) {
    throw new Error('--occurrences must be at least --documents so every document has a row')
  }

  const config = resolveLocalConfig(flags)
  const password = passwordFrom(flags)
  log(`Seeding ${users} user(s) x ${occurrences} occurrences x ${documents} documents`)
  log(`Supabase ${config.url} (local only), database container ${config.dbContainer}`)

  // ── auth users ──────────────────────────────────────────────────────────
  const existing = await adminListUsers(config)
  const existingSeed = existing
    .filter((user) => (user.email ?? '').startsWith(EMAIL_PREFIX))
    .sort((a, b) => seedUserIndex(a.email) - seedUserIndex(b.email))

  if (clean) {
    for (const user of existingSeed) {
      log(`Deleting seed user ${user.email}`)
      await adminDeleteUser(config, user.id)
    }
  } else if (existingSeed.length > 0) {
    throw new Error(
      `Seed users already exist (${existingSeed.map((u) => u.email).join(', ')}). ` +
        'Pass --clean to remove and recreate them.',
    )
  }

  const authUsers = []
  for (let i = 0; i < users; i += 1) {
    const email = seedEmail(i)
    log(`Creating auth user ${email}`)
    const created = await adminCreateUser(config, { email, password, index: i })
    if (!created?.id) throw new Error(`Admin API did not return an id for ${email}`)
    authUsers.push({ index: i, id: created.id, email })
  }
  const userIds = authUsers.map((user) => user.id)

  // ── deterministic row plans ─────────────────────────────────────────────
  const distinctLemmas = new Set()
  const docPlans = []
  for (let docIndex = 0; docIndex < documents; docIndex += 1) {
    const rowCount = rowsPerDocument(occurrences, documents, docIndex)
    const plan = planDocument(docIndex, rowCount)
    docPlans.push({ rowCount, plan })
    for (const lemmaId of plan.distinct) distinctLemmas.add(lemmaId)
  }

  const priority = []
  for (let id = 0; id < LEMMA_POOL; id += 1) {
    if (distinctLemmas.has(id)) priority.push(id)
  }
  const stateLemmaIds = priority.slice(0, Math.min(states, priority.length))
  if (stateLemmaIds.length < states) {
    log(
      `Requested ${states} word states but the fixture only contains ` +
        `${stateLemmaIds.length} distinct lemmas; using ${stateLemmaIds.length}.`,
    )
  }

  const folderIds = authUsers.map((user) => deterministicUuid('folder', user.index))
  const documentIds = authUsers.map((user) =>
    Array.from({ length: documents }, (_, docIndex) =>
      deterministicUuid('document', user.index, docIndex),
    ),
  )

  // ── COPY script ─────────────────────────────────────────────────────────
  const workDir = await mkdtemp(join(tmpdir(), 'r3-seed-'))
  const scriptPath = join(workDir, 'seed.sql')
  log(`Writing fixture to ${scriptPath}`)
  await writeSeedScript({
    scriptPath,
    authUsers,
    documents,
    docPlans,
    documentIds,
    folderIds,
    stateLemmaIds,
  })

  log('Loading fixture with COPY...')
  const copyStarted = Date.now()
  await psqlFile(config, scriptPath)
  const copyMs = Date.now() - copyStarted
  await rm(workDir, { recursive: true, force: true })

  // COPY does not update planner statistics. Without this, refresh_wordbook_pairs
  // can choose a nested loop over 25k requested lemmas against a table the
  // planner still believes is nearly empty, turning the first refresh into a
  // multi-minute scan. Analyze the freshly loaded tables before any projection
  // work.
  log('Analyzing seeded tables...')
  const analyzeStarted = Date.now()
  await psql(
    config,
    `
    analyze public.user_languages;
    analyze public.folders;
    analyze public.documents;
    analyze public.word_states;
    analyze public.word_occurrences;
    `,
  )
  const analyzeMs = Date.now() - analyzeStarted

  // ── occurrence hash: the fixture is an already-synced document ───────────
  // The gate must measure the diff/refresh path, not the one-time first push
  // that initializes a NULL hash. Compute the exact canonical hash the RPC
  // would store.
  log('Initializing documents.occurrences_hash...')
  const hashStarted = Date.now()
  await psql(
    config,
    `
    update public.documents d
    set occurrences_hash = h.hash
    from (
      select
        o.user_id,
        o.document_id,
        public.word_occurrence_hash(
          jsonb_agg(
            jsonb_build_object(
              'language_code', o.language_code,
              'lemma', o.lemma,
              'surface', o.surface,
              'char_start', o.char_start,
              'char_end', o.char_end,
              'sentence', o.sentence,
              'occurrences_count', o.occurrences_count
            )
          )
        ) as hash
      from public.word_occurrences o
      where o.user_id = any(${uuidList(userIds)})
      group by o.user_id, o.document_id
    ) h
    where d.user_id = h.user_id
      and d.id = h.document_id;
    `,
  )
  const hashMs = Date.now() - hashStarted

  // ── projection via the production refresh path ───────────────────────────
  log('Building wordbook_entries through refresh_wordbook_pairs...')
  const projectionStarted = Date.now()
  for (const user of authUsers) {
    await psql(
      config,
      `
      select public.refresh_wordbook_pairs((
        select jsonb_agg(
                 jsonb_build_object(
                   'userId', ${sqlLiteral(user.id)}::uuid,
                   'languageCode', l.language_code,
                   'lemma', l.lemma
                 )
                 order by l.language_code, l.lemma
               )
        from (
          select distinct o.language_code, o.lemma
          from public.word_occurrences o
          where o.user_id = ${sqlLiteral(user.id)}::uuid
        ) l
      ));
      `,
    )
  }
  const projectionMs = Date.now() - projectionStarted

  // ── verification ────────────────────────────────────────────────────────
  const expected = {
    users,
    documents: users * documents,
    occurrences: users * occurrences,
    wordStates: users * stateLemmaIds.length,
    folders: users,
    tombstones: 0,
    projectionLive: users * distinctLemmas.size,
    projectionDeleted: 0,
    documentsWithHash: users * documents,
    refreshQueue: 0,
  }

  const counts = await psqlJson(
    config,
    `
    with seed_users as (
      select unnest(${uuidList(userIds)}) as user_id
    )
    select jsonb_build_object(
      'users', (select count(*) from auth.users where id in (select user_id from seed_users)),
      'documents', (select count(*) from public.documents where user_id in (select user_id from seed_users)),
      'occurrences', (select count(*) from public.word_occurrences where user_id in (select user_id from seed_users)),
      'wordStates', (select count(*) from public.word_states where user_id in (select user_id from seed_users)),
      'folders', (select count(*) from public.folders where user_id in (select user_id from seed_users)),
      'tombstones', (select count(*) from public.document_tombstones where user_id in (select user_id from seed_users)),
      'projectionLive', (
        select count(*) from public.wordbook_entries
        where user_id in (select user_id from seed_users) and deleted_at is null
      ),
      'projectionDeleted', (
        select count(*) from public.wordbook_entries
        where user_id in (select user_id from seed_users) and deleted_at is not null
      ),
      'documentsWithHash', (
        select count(*) from public.documents
        where user_id in (select user_id from seed_users) and occurrences_hash is not null
      ),
      'refreshQueue', (
        select count(*) from public.wordbook_refresh_queue
        where user_id in (select user_id from seed_users)
      ),
      'distinctLemmasPerUser', (
        select coalesce(min(n), 0) from (
          select count(distinct lemma) as n
          from public.word_occurrences
          where user_id in (select user_id from seed_users)
          group by user_id
        ) s
      ),
      'statesWithoutOccurrence', (
        select count(*)
        from public.word_states ws
        where ws.user_id in (select user_id from seed_users)
          and not exists (
            select 1 from public.word_occurrences o
            where o.user_id = ws.user_id
              and o.language_code = ws.language_code
              and o.lemma = ws.lemma
          )
      )
    );
    `,
  )

  const checks = {
    countsMatch:
      counts.users === expected.users &&
      counts.documents === expected.documents &&
      counts.occurrences === expected.occurrences &&
      counts.wordStates === expected.wordStates &&
      counts.folders === expected.folders &&
      counts.tombstones === expected.tombstones &&
      counts.projectionLive === expected.projectionLive &&
      counts.projectionDeleted === expected.projectionDeleted &&
      counts.documentsWithHash === expected.documentsWithHash &&
      counts.refreshQueue === expected.refreshQueue,
    distinctLemmasMatch: counts.distinctLemmasPerUser === distinctLemmas.size,
    statesHaveOccurrences: counts.statesWithoutOccurrence === 0,
  }
  const pass = Object.values(checks).every(Boolean)

  const result = {
    kind: 'seed',
    pass,
    startedAt: new Date(started).toISOString(),
    completedAt: new Date().toISOString(),
    url: config.url,
    dbContainer: config.dbContainer,
    config: {
      users,
      occurrencesPerUser: occurrences,
      documentsPerUser: documents,
      requestedWordStates: states,
      actualWordStatesPerUser: stateLemmaIds.length,
      distinctLemmasPerUser: distinctLemmas.size,
      emailPrefix: EMAIL_PREFIX,
    },
    users: authUsers,
    expected,
    counts,
    checks,
    timingMs: {
      total: Date.now() - started,
      copy: copyMs,
      analyze: analyzeMs,
      occurrenceHash: hashMs,
      projectionRefresh: projectionMs,
    },
  }

  const resultPath = await writeResult('seed', result)
  log(`Seed result written to ${resultPath}`)
  emitResult(result)
  if (!pass) process.exitCode = 1
}

async function writeSeedScript({
  scriptPath,
  authUsers,
  documents,
  docPlans,
  documentIds,
  folderIds,
  stateLemmaIds,
}) {
  const stream = createWriteStream(scriptPath)
  const done = once(stream, 'close')

  await writeLine(stream, 'begin;')
  await writeLine(stream, 'alter table public.word_states disable trigger word_states_refresh_insert;')
  await writeLine(stream, 'alter table public.word_states disable trigger word_states_refresh_update;')
  await writeLine(stream, 'alter table public.word_states disable trigger word_states_refresh_delete;')

  // user_languages
  await writeLine(
    stream,
    'copy public.user_languages (user_id, language_code, created_at) from stdin with (format csv);',
  )
  for (const user of authUsers) {
    await writeLine(stream, [user.id, 'en', iso(BASE_MS)].map(csv).join(','))
  }
  await writeLine(stream, '\\.')

  // folders
  await writeLine(
    stream,
    'copy public.folders (id, user_id, name, parent_id, created_at, updated_at) from stdin with (format csv);',
  )
  for (const [index, user] of authUsers.entries()) {
    await writeLine(
      stream,
      [folderIds[index], user.id, 'R3 load folder', null, iso(BASE_MS), iso(BASE_MS)].map(csv).join(','),
    )
  }
  await writeLine(stream, '\\.')

  // documents
  await writeLine(
    stream,
    'copy public.documents (id, user_id, title, language_code, raw_text, created_at, updated_at, folder_id, last_opened_at, content_updated_at, occurrences_updated_at) from stdin with (format csv);',
  )
  for (const [userIndex, user] of authUsers.entries()) {
    for (let docIndex = 0; docIndex < documents; docIndex += 1) {
      const createdAt = BASE_MS + docIndex * MINUTE
      const updatedAt = createdAt + 30_000
      const folderId = docIndex < 100 ? folderIds[userIndex] : null
      await writeLine(
        stream,
        [
          documentIds[userIndex][docIndex],
          user.id,
          `R3 load document ${String(docIndex + 1).padStart(4, '0')}`,
          'en',
          documentText(docIndex),
          iso(createdAt),
          iso(updatedAt),
          folderId,
          iso(updatedAt),
          iso(createdAt),
          iso(updatedAt),
        ]
          .map(csv)
          .join(','),
      )
    }
  }
  await writeLine(stream, '\\.')

  // word_states
  await writeLine(
    stream,
    'copy public.word_states (id, user_id, language_code, lemma, status, seen_count, first_seen_at, last_seen_at, is_favorite, favorite_updated_at, star_angle, star_color, known_presses, unsure_presses, unknown_presses, note, note_updated_at) from stdin with (format csv);',
  )
  const statuses = ['known', 'unsure', 'unknown', null]
  for (const user of authUsers) {
    for (let stateIndex = 0; stateIndex < stateLemmaIds.length; stateIndex += 1) {
      const lemmaId = stateLemmaIds[stateIndex]
      const lemma = lemmaAt(lemmaId)
      const lastSeen = BASE_MS + 2 * HOUR + stateIndex * 1000
      const note = stateIndex % 17 === 3 ? `R3 note for ${lemma}` : null
      await writeLine(
        stream,
        [
          deterministicUuid('word-state', user.index, lemmaId),
          user.id,
          'en',
          lemma,
          statuses[stateIndex % statuses.length],
          1 + (stateIndex % 12),
          iso(BASE_MS + (stateIndex % 1000) * 1000),
          iso(lastSeen),
          stateIndex % 11 === 0,
          iso(BASE_MS + 24 * HOUR),
          (stateIndex * 37) % 360,
          STAR_COLORS[stateIndex % STAR_COLORS.length],
          stateIndex % 5,
          stateIndex % 3,
          stateIndex % 7,
          note,
          note === null ? null : iso(lastSeen),
        ]
          .map(csv)
          .join(','),
      )
    }
  }
  await writeLine(stream, '\\.')

  // word_occurrences
  await writeLine(
    stream,
    'copy public.word_occurrences (user_id, document_id, language_code, lemma, surface, char_start, char_end, sentence, occurrences_count) from stdin with (format csv);',
  )
  for (const [userIndex, user] of authUsers.entries()) {
    for (let docIndex = 0; docIndex < documents; docIndex += 1) {
      const { plan } = docPlans[docIndex]
      for (const row of occurrenceRows(docIndex, plan)) {
        await writeLine(
          stream,
          [
            user.id,
            documentIds[userIndex][docIndex],
            row.language_code,
            row.lemma,
            row.surface,
            row.char_start,
            row.char_end,
            row.sentence,
            row.occurrences_count,
          ]
            .map(csv)
            .join(','),
        )
      }
    }
  }
  await writeLine(stream, '\\.')

  await writeLine(stream, 'alter table public.word_states enable trigger word_states_refresh_insert;')
  await writeLine(stream, 'alter table public.word_states enable trigger word_states_refresh_update;')
  await writeLine(stream, 'alter table public.word_states enable trigger word_states_refresh_delete;')
  await writeLine(stream, 'commit;')

  stream.end()
  await done
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error))
  process.exitCode = 1
})
