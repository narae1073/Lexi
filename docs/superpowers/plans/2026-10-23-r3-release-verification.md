# R3 release verification — 2026-10-23

**Status:** implementation and local verification complete; full e2e is green
(**622/622**) and the local translation-provider key is configured. **Not
released.** No production migration, deployment, or production data change was
performed.

## Settled release decisions — 2026-10-24

- **Q1(a):** 116k is a linear worst-case upper bound, not a Heaps-law model.
  The 25k-lemma release fixture is intentional. The 64 MB soft projection cap
  stays; a worst-case 116k projection may require a second pass, and approved
  conditional auto-resume makes that invisible on Wi-Fi/unmetered networks.
  A genuine 116k stress fixture is an optional verification spike, not a
  release prerequisite.
- **Q2:** conditional auto-resume is approved. Wi-Fi/unmetered resumes silently;
  metered/`saveData` prompts. Paused state must be restored from device-local
  metadata after reload/restart and is now a **P1** requirement.
- **Q4:** IndexedDB v7 is accepted. Local data is preserved by the v6→v7
  upgrade. **R2 cannot reopen a v7 database.** Post-deploy frontend rollback is
  a forward-fix, not a code rollback; server rollback remains possible.

### v7 release boundary

> R3 uses IndexedDB v7. R2 cannot open a v7 database after R3 has opened it.
> Local learning data is preserved by the v7 migration; server rollback remains
> possible, but post-deploy frontend rollback is a forward-fix, not a code
> rollback.

- Plan: `/home/achi/.opencode/plan/2026-10-23-r3-scale-data-usage.md`
- Branch: `r3-scale-data-usage`
- R3 scale/pre-public work HEAD: `044a642`
- Original gates commit: `7296c83`
- First review-fix commit: `81f5998`
- Final whole-branch review-fix commit: `5634367`
- Verified tree: the local working tree after the conditional auto-resume and
  paused-state restoration implementation (commit handled separately)

The only Supabase target used below was the local stack at
`http://127.0.0.1:54321` (project `translator`). `.env.local` is git-ignored and
points the build and RLS verifier at loopback. The seed/load/metrics scripts
and the R3 e2e helper refuse non-loopback Supabase URLs.

## Prerequisites and run order

Run against a fresh or already-seeded local stack, **in this order**:

```bash
npm run dict:all          # local Lindera ja/zh zips for specs 28/29
# load CC-CEDICT once for spec 29 (local DB only; see note)
npm run r3:seed -- --users 4 --occurrences 200000 --documents 1112 --clean
npm run e2e               # spec 42 requires the 200k fixture above
npm run r3:load -- --users 4 --edits 100 --concurrency 4
node scripts/r3-metrics.mjs
```

The 200k seed is a prerequisite for the **full** e2e run because spec 42 signs
in as `r3-load-0@lexi.test`. `dict:all` is required by specs 28/29. Spec 29 also
uses the local `cc_cedict` table; the full MDBG dump was loaded locally with
`dict:load-zh` (`CC_CEDICT_FILE` avoided the unreachable MDBG IPv6 endpoint).
No production dictionary or Supabase project was touched.

`e2e/specs/28-japanese.spec.mjs` and `29-chinese.spec.mjs` set the R3
auto-download preference (`lexi.dictionary.autoDownload=true`) before opening
the document. The product still asks by default for real users; the e2e specs
opt in because they test tokenization, not consent.

## Required commands

| Command | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc -b`, exit 0 |
| `npm run lint` | PASS | `oxlint`, exit 0; only the pre-existing Wordbook memoization warnings |
| `npm run test` | PASS | 96 files, **1233 tests** |
| `npm run build` | PASS | PWA generated; 20 precache entries |
| `npm run verify:rls` | PASS | local anon/forged-JWT reads and writes denied; direct `word_occurrences` DML denied; `dictionary_entries` read allowed |
| `npm run e2e` | **622 / 622** | specs 41 = 45/45, 42 = 18/18, 28 = 7/7, 29 = 8/8; no external failures |
| `npm run r3:seed -- --users 4 --occurrences 200000 --documents 1112 --clean` | PASS | 4 users, 800,000 occurrences, 4,448 documents, 92,800 word states, 100,000 projection rows |
| `npm run r3:load -- --users 4 --edits 100 --concurrency 4` | **PASS** | no errors, deadlocks, retries, or no-op writes |

### Local SQL suite

```
occurrence_noop_diff   PASS
wordbook_projection    PASS
wordbook_refresh       PASS
projection_reads       PASS
projection_quota       PASS
npm run test:quota-concurrency  pass (seeded 200; concurrent [200,429]; PT429; third 429)
```

`occurrence_noop_diff` now also proves authenticated/anon cannot INSERT/UPDATE/
DELETE `word_occurrences` directly while the security-definer
`replace_word_occurrences` still writes and refreshes the projection.
`projection_reads` proves the bounded page splits on ~1 MiB, returns a
single oversized row rather than dropping it, and restarts the same snapshot
from lemma 0; `wordbook_refresh` proves `delete_document` writes the tombstone
another device needs.

## 200k client timings (spec 42, final run)

Fixture: 4 users × 200,000 occurrences × 1,112 documents; 25,000 projected
lemmas per user.

| Measurement | Result | Budget |
|---|---:|---:|
| App start through first projection completion | 9,563 ms | — |
| Projection pass itself (snapshot → hydrated) | **4,277 ms** | — |
| Projection pages | **38** byte-bounded pages for 25,000 rows (37 unique cursors) | ≤1,000 rows and ~1 MiB/page |
| Wordbook first render | **599.6 ms** | < 2,500 ms |
| Worker rebuild | **601.3 ms** | < 2,500 ms |
| Wordbook search | **14.4 ms** | < 200 ms |
| Status toggle (visible) | **22.3 ms** | < 100 ms |
| Document progress computation | **17.6 ms** for 1,112 documents | < 100 ms |
| Status-override worker benchmark | **< 100 ms** (25k entries, 1 override) | < 100 ms |
| Occurrence re-download during UI interaction | 0 requests | 0 |

The page count is now byte-driven as well as row-driven: the same 25,000 rows
need 38 pages instead of the row-only minimum of 25 because a page is capped at
~1 MiB of serialized JSON. The client follows `hasMore`/`nextCursor`, so a short
byte-truncated page is never mistaken for end-of-language.

The first sync read **no** `word_occurrences` and no full `word_states` rows,
and stored 25,000 / 25,000 projection rows locally before any document body was
opened. The synthetic second-device flow in spec 41 also downloaded zero
occurrence rows and zero document bodies.

## 4-user refresh load gate (final run)

```
effective edits: 100
p50 22.00 ms   p95 30.96 ms   p99 61.05 ms   max 61.15 ms
warm-up p95: 88.38 ms (1 excluded edit/user)
errors 0   deadlocks 0   retries 0
no-op phase: 100/100 succeeded, 0 projection writes, 0 document writes,
             source/projection/document fingerprints unchanged
consistency: 100,000 live entries, 0 mismatches, 0 refresh-queue rows
fixture: 4 users, 800,000 occurrences, 4,448 documents, 92,800 word states
PASS
```

Gate limits: p95 < 100 ms, p99 < 250 ms. Result artifact:
`/tmp/opencode/r3-load-2026-10-23T22-05-01-466Z-03262198.json`.

## Projection bytes and egress

From `node scripts/r3-metrics.mjs` (read-only, local target; `incomplete: false`):

```
projection table bytes        85,852,160
projection + indexes         103,481,344  (100,000 rows, 4 users)
projection index bytes        17,629,184
per-user projection storage   25,870,336  (~24.7 MiB per 25,000-row user)
average row width             821 B
24h pull pages                60
24h pull rows                 39,501
resumes                       58
complete syncs                 1
bytes per page                540,505  (< 1 MB target)
egress (24h measured rows)    32,430,321 B (~30.9 MiB)
egress budget                  64 MiB per new device
```

Per-user storage is the total projection + index bytes divided by the four
fixture users. Egress is a separate measure: `projection_usage` row counts over
24 h multiplied by the `pg_stats` row width (`bytesEstimated: true`). The 24 h
window includes the spec 42 first sync and its resume accounting; a single
first-device download remains well under the 64 MiB budget. The percentile and
no-op figures come from the fresh load artifact above.

## Rate limits, resumability, and quota behavior

Spec 41 drives the real server quota:

1. The account's page bucket is set one request below the 60/minute limit. The
   helper waits for a fresh epoch minute if seeded after second 40, widening the
   margin so a reload cannot roll into an empty bucket.
2. The first sync reads page 1 (1,000 rows), stores the rows, and persists
   `{snapshot, cursor: r3word1000, complete: false}`. The snapshot is written
   before the first page, so a crash cannot strand the account on a new
   snapshot.
3. Page 2 returns `PT429`; the app shows “Wordbook download paused by the server
   limit” instead of failing the sync.
4. After the window, the helper clears **only** the page-rate counters and keeps
   `projection_sync_passes`. The retry sends the same `p_snapshot` and
   `p_after_lemma = "r3word1000"`, completes the language, and leaves exactly
   one pass row.

Deleting pass rows would make the resume test vacuous (the client would look
like it resumed but start a new pass). The spec asserts:
`count = 1`, `complete = true`, every resumed page carries the interrupted
snapshot, and the wordbook reaches all 1,200 rows.

The SQL quota test and `test:quota-concurrency` additionally verify the 60
pages/minute and 2 complete passes/day limits, the pass cursor rules, bucket
allowlists, retention, and concurrent first-page serialization (`200` + `429`).

## v7 upgrade

`npx vitest run src/lib/storage/localDbV7.test.ts src/lib/sync/projectionSync.test.ts
src/lib/sync/wordbookPull.test.ts src/lib/sync/projectionQuota.test.ts`
→ 4 files, **71 tests passed**.

`localDbV7.test.ts` includes the v6→v7 additive upgrade: every existing store
and row survives, the new `wordbookEntries` and `documentContent` stores are
created empty, and a blocked/other-tab upgrade completes without hanging.
The full Vitest suite (1233 tests) passes.

## E2E flow evidence (spec 41, 45/45)

- First sync: 0 `word_occurrences` table reads, 0 full `word_states` reads;
  projection pages are requested only after metadata and all carry one
  snapshot, `p_limit=1000`, and `p_updated_since=null`.
- Interruption/resume: cursor persisted and re-sent under the same snapshot;
  exactly one server pass row exists and is complete; 1,200/1,200 rows stored.
- Reload restores the paused banner from device-local metadata; a quota pause
  makes no projection request before its retry window.
- A cellular network makes no projection request while paused; the explicit
  Continue action resumes the same snapshot and cursor and completes one pass.
- Wordbook works offline after the projection; search works offline.
- Document list shows exact server lengths **6,600 / 4,400 / 2,200 chars**
  without fetching a body; titles are Zulu/Mike/Alpha so alphabetical order
  differs from length order. Longest sort is Zulu > Mike > Alpha.
- Opening a metadata-only document fetches `get_document_payload` once and
  stores one local body; reopening fetches 0 more payloads.
- Opening/reopening pushes 0 occurrence writes, 0 document writes, reads 0
  occurrence table rows, and triggers 0 full `word_states` reads.
- Opening the wordbook on both the first device and a simulated second device
  reads 0 occurrence rows and triggers 0 full `word_states` reads.
- The second device gets 1,200 projection rows, 0 local occurrence rows, and 0
  document bodies; its wordbook is complete before any document is opened.
- Spec 42 restores the fixture's original status after its one status tap, so
  the refresh load gate sees the documented seed state.

## Translation provider e2e

`npm run e2e` → **622/622**. The local translation-provider key is configured
for the local Edge Function, so `03-sentence-translation`, `13-offline`, and
`34-quiz` pass. No external failures remain.

Specs 28 and 29 set the R3 auto-download preference before opening a document;
they pass 7/7 and 8/8. The product still asks by default for real users.
No assertion or threshold was weakened to hide any failure.

## Final whole-branch review fixes (`5634367`)

- **Interrupted first projection:** the snapshot is persisted before the first
  page; a page-2 failure resumes the same charged snapshot from lemma 0 and
  stores every row. The server accepts that restart only for an incomplete pass
  and resets its cursor state; a completed pass still cannot rewind.
- **Incremental overlap:** `updatedSince = prior snapshot - 5 min`, while the
  stored completion watermark remains the snapshot. A late row stamped behind
  the watermark is re-read instead of being lost.
- **Incremental byte budget:** the 64 MB soft cap now pauses incremental passes
  too. They restart from the watermark, so a pause is idempotent and cannot
  skip a change behind a cursor.
- **Deleted-document content:** local purge and a remote tombstone both delete
  the `documentContent` cache row.
- **Byte-bounded page RPC:** `get_wordbook_projection_page_bounded` returns
  `{rows, hasMore, nextCursor}` under a 1 MiB / 1,000-row cap. An oversized row
  is returned alone. The old row-set RPC is a wrapper over it, so no client path
  is uncapped. The pull loop trusts `hasMore`, never `rows.length < limit`.
- **Real resume e2e:** only page counters are cleared after the 429; the pass row
  survives and the spec asserts one complete pass on the same snapshot.
- **Minor fixes:** manual-reset dirty re-seed requires a local occurrence;
  `ProjectionPassError` does not clear a zero-page fresh language; direct
  occurrence DML is revoked; `delete_document` writes a tombstone; metadata-only
  documents never push empty occurrence sets; a cached body newer than the
  metadata row wins without a refetch; document-progress e2e requires
  1,112/1,112 documents.

## Release checklist

- [x] Projection first sync carries no occurrence or full word-state download.
- [x] Projection pages resume from a stored cursor after a 429 interruption.
- [x] Interrupted first projection reuses its charged snapshot; one pass row.
- [x] Projection pages remain ≤1,000 rows and ~1 MiB via explicit hasMore.
- [x] Incremental overlap and byte budget preserve late rows without skipping.
- [x] Direct `word_occurrences` DML is denied; only the security-definer RPC writes.
- [x] `delete_document` records a tombstone, so another device cannot resurrect it.
- [x] Purge/tombstone removes cached document content.
- [x] Offline wordbook and search work from the projection.
- [x] Lazy document content: one payload fetch, local reopen, no occurrence push,
      no source-table read on open or wordbook open.
- [x] Metadata-only exact length and longest sort come from `char_count`.
- [x] 200k account UI budgets met (first render, search, status, progress),
      plus the deterministic 25k worker status-override benchmark.
- [x] 4 × 200k refresh gate PASS with zero deadlocks/no-op writes.
- [x] v7 upgrade and local SQL/RLS/quota checks pass.
- [x] Metrics snapshot complete with egress and page-byte evidence.
- [x] Fixture status restored after spec 42.
- [x] Pause reason, snapshot, cursor, quota bucket, retry window, and timestamp
      persist per account/language; the paused banner restores after reload.
- [x] Wi-Fi/unmetered resumes silently; cellular/`saveData`/slow connections
      make no projection request until explicit consent.
- [x] Quota/state retry timers re-arm from persisted metadata; byte/offline
      pauses wait for lifecycle events or consent.
- [x] Automatic sync skips paused projection lanes without blocking normal
      document/word-state sync.
- [x] No duplicate projection pass or daily unit on resume; the same snapshot
      and cursor are reused.
- [ ] **Production migration — NOT PERFORMED.**
- [ ] **Production deployment — NOT PERFORMED.**
- [ ] **Production data change — NOT PERFORMED.**

Release requires explicit user approval before any `supabase db push`, migration,
or frontend deployment. This document records verification only.
