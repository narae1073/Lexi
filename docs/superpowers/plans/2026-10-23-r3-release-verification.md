# R3 release verification — 2026-10-23

**Status:** implementation and local verification complete. **Not released.**
No production migration, deployment, or production data change was performed.

- Plan: `/home/achi/.opencode/plan/2026-10-23-r3-scale-data-usage.md`
- Branch: `r3-scale-data-usage`
- Pre-verification HEAD: `044a642` (`fix(sync): validate projection pass codes and harden R3 metrics gates`)
- Release verification commit: `9cd065b` (this document and the R3 e2e gates)

The only Supabase target used below was the local stack at
`http://127.0.0.1:54321` (project `translator`). `.env.local` pointed the build
and the RLS verifier at that loopback URL; it is git-ignored and not part of the
release. `scripts/r3-seed`/`r3-load`/`r3-metrics` refuse non-loopback hosts.

## Required commands

| Command | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc -b`, exit 0 |
| `npm run lint` | PASS | `oxlint`, exit 0; only the pre-existing Wordbook `preserve-manual-memoization` warnings |
| `npm run test` | PASS | 94 files, **1202 tests** |
| `npm run build` | PASS | `vite build`, PWA generated, 20 precache entries (2,701.19 KiB) |
| `npm run verify:rls` | PASS | local anon/forged-JWT reads and writes denied; `dictionary_entries` read allowed |
| `npm run e2e` | **573 / 579** | R3 specs 41 and 42 pass; 6 pre-existing external failures listed below |
| `npm run r3:seed -- --users 4 --occurrences 200000 --documents 1112 --clean` | PASS | 4 users, 800,000 occurrences, 4,448 documents, 92,800 word states, 100,000 projection rows, 0 tombstones, 0 queued refreshes |
| `npm run r3:load -- --users 4 --edits 100 --concurrency 4` | **PASS** | no errors, deadlocks, retries, or no-op writes |

### Local SQL suite

```
occurrence_noop_diff   PASS
wordbook_projection    PASS
wordbook_refresh       PASS
projection_reads       exit 0
projection_quota       exit 0
npm run test:quota-concurrency  pass (seeded 200; concurrent [200,429]; PT429; third 429)
```

## 200k client timings (spec 42)

Fixture: 4 users × 200,000 occurrences × 1,112 documents; 25,000 projected
lemmas per user.

| Measurement | Result | Budget |
|---|---:|---:|
| First full projection sync | 8,528 ms | — |
| Projection pages | 26 (1,000 rows each) | 1000 rows/page |
| Wordbook first render | **583.5 ms** | < 2,500 ms |
| Worker rebuild | **553.5 ms** | < 2,500 ms |
| Wordbook search | **23.1 ms** | < 200 ms |
| Status toggle (visible) | **24.4 ms** | < 100 ms |
| Document progress computation | **17.9 ms** for 1,112 documents | < 100 ms |
| Client progress calls | 14.9 ms, 18.0 ms | — |
| Occurrence re-download during UI interaction | 0 requests | 0 |

The first sync read **no** `word_occurrences` and no full `word_states` rows,
and stored 25,000 / 25,000 projection rows locally before any document body was
opened.

## 4-user refresh load gate (final run)

```
effective edits: 100
p50 23.49 ms   p95 35.29 ms   p99 56.27 ms   max 61.09 ms
warm-up p95: 71.85 ms (1 excluded edit/user)
errors 0   deadlocks 0   retries 0
no-op phase: 100/100 succeeded, 0 projection writes, 0 document writes,
             source/projection/document fingerprints unchanged
consistency: 100,000 live entries, 0 mismatches, 0 refresh-queue rows
fixture: 4 users, 800,000 occurrences, 4,448 documents, 92,800 word states
PASS
```

Gate limits: p95 < 100 ms, p99 < 250 ms. Result artifact:
`/tmp/opencode/r3-load-2026-10-23T17-47-56-284Z-fb635127.json`.

## Projection bytes and egress

From `node scripts/r3-metrics.mjs` (read-only, local target; `incomplete: false`):

```
projection table bytes      258,252,800
projection + indexes        304,824,320  (100,000 rows, 4 users)
average row width           818 B
24h pull pages              27
24h pull rows               25,000
bytes per page              757,407  (< 1 MB target)
egress per new device       20,450,000 B (~19.5 MiB) for 25,000 rows
egress budget                64 MiB
```

The 24h pull figures come from `projection_usage` row counts multiplied by the
`pg_stats` row width (`bytesEstimated: true`); the percentile and no-op figures
come from the fresh load artifact above.

## Rate limits, resumability, and quota behavior

Spec 41 drives the real server quota:

1. The account's page bucket is set one request below the 60/minute limit.
2. The first sync reads page 1 (1,000 rows), stores the rows, and persists
   `{snapshot, cursor: r3word1000, complete: false}`.
3. Page 2 returns `PT429`; the app shows “Wordbook download paused by the server
   limit” instead of failing the sync.
4. After the window, the automatic retry sends `p_after_lemma = "r3word1000"`
   and completes the pass.

The SQL quota test and `test:quota-concurrency` additionally verify the 60
pages/minute and 2 complete passes/day limits, the pass cursor rules, bucket
allowlists, retention, and concurrent first-page serialization (`200` + `429`).

## v7 upgrade

`npx vitest run src/lib/storage/localDbV7.test.ts src/lib/sync/projectionSync.test.ts
src/lib/sync/wordbookPull.test.ts src/lib/sync/projectionQuota.test.ts`
→ 4 files, **62 tests passed**.

`localDbV7.test.ts` includes the v6→v7 additive upgrade: every existing store
and row survives, the new `wordbookEntries` and `documentContent` stores are
created empty, and a blocked/other-tab upgrade completes without hanging.
The v7 store keys are `(languageCode, lemma)`; the full Vitest suite (1202
tests) passes.

## E2E flow evidence (spec 41)

- First sync: 0 `word_occurrences` table reads, 0 full `word_states` reads.
- Interruption/resume: cursor persisted and re-sent; 1,200/1,200 rows stored.
- Wordbook works offline after the projection; search works offline.
- Document list uses server `charCount`; longest sort is Long > Medium > Short
  without fetching a body.
- Opening a metadata-only document fetches `get_document_payload` once and
  stores one local body; reopening fetches 0 more payloads.
- Reopening pushes 0 occurrence writes and 0 document writes.
- A simulated second device (new IndexedDB + same account) gets 1,200
  projection rows, 0 local occurrence rows, and 0 document bodies; its wordbook
  is complete before any document is opened.

## Full e2e failures (environmental / pre-existing, assertions unchanged)

`npm run e2e` → 573/579. All six failures are unrelated to R3 projection:

| Spec | Failure | Cause |
|---|---|---|
| `03-sentence-translation` (2) | `Translation service error (500)` | local Edge Function has no `GOOGLE_TRANSLATE_API_KEY`; requests never reach a provider |
| `13-offline` (1) | stored sentence translation fails | same missing local translate provider |
| `28-japanese` (1) | `Runtime.evaluate` timeout | first-run Lindera extraction blocks the page longer than the harness's 30 s CDP call timeout |
| `29-chinese` (1) | `Runtime.evaluate` timeout | same, CC-CEDICT extraction |
| `34-quiz` (1) | context translation timeout | same missing local translate provider |

No assertion or threshold was weakened to hide these. They are not exercised by
tasks 1–13 and were reproduced with `.env.local` removed for spec 36; the two
quiz-loop failures found during the first full run (36/38) **were fixed** in
this change (a fresh `[]` selector snapshot in `QuizView`).

## Release checklist

- [x] Projection first sync carries no occurrence or full word-state download.
- [x] Projection pages resume from a stored cursor after a 429 interruption.
- [x] Offline wordbook and search work from the projection.
- [x] Lazy document content: one payload fetch, local reopen, no occurrence push.
- [x] Metadata-only length and longest sort come from `char_count`.
- [x] 200k account UI budgets met (first render, search, status, progress).
- [x] 4 × 200k refresh gate PASS with zero deadlocks/no-op writes.
- [x] v7 upgrade and local SQL/RLS/quota checks pass.
- [x] Metrics snapshot complete with egress and page-byte evidence.
- [ ] **Production migration — NOT PERFORMED.**
- [ ] **Production deployment — NOT PERFORMED.**
- [ ] **Production data change — NOT PERFORMED.**

Release requires explicit user approval before any `supabase db push`, migration,
or frontend deployment. This document records verification only.
