# R3 release verification — 2026-10-23

**Status:** implementation and local verification complete; **4 external e2e
checks fail without a local translation provider**. **Not released.**
No production migration, deployment, or production data change was performed.

- Plan: `/home/achi/.opencode/plan/2026-10-23-r3-scale-data-usage.md`
- Branch: `r3-scale-data-usage`
- R3 scale/pre-public work HEAD: `044a642`
- Original gates commit: `7296c83`
- Review-fix commit: `81f5998` (adds the C1/I1–I5 fixes below)
- Verified tree: the review-fix commit above, plus its follow-up evidence commit

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
| `npm run test` | PASS | 94 files, **1206 tests** |
| `npm run build` | PASS | PWA generated; 20 precache entries (2,701.22 KiB) |
| `npm run verify:rls` | PASS | local anon/forged-JWT reads and writes denied; `dictionary_entries` read allowed |
| `npm run e2e` | **596 / 600** | specs 41 = 38/38, 42 = 18/18, 28 = 7/7, 29 = 8/8; 4 external failures below |
| `npm run r3:seed -- --users 4 --occurrences 200000 --documents 1112 --clean` | PASS | 4 users, 800,000 occurrences, 4,448 documents, 92,800 word states, 100,000 projection rows |
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

## 200k client timings (spec 42, final run)

Fixture: 4 users × 200,000 occurrences × 1,112 documents; 25,000 projected
lemmas per user.

| Measurement | Result | Budget |
|---|---:|---:|
| App start through first projection completion | 8,433 ms | — |
| Projection pass itself (snapshot → hydrated) | **3,345 ms** | — |
| Projection pages | **26** (exactly the bounded sequence for 25,000 rows) | 1,000 rows/page |
| Wordbook first render | **657.6 ms** | < 2,500 ms |
| Worker rebuild | **533.6 ms** | < 2,500 ms |
| Wordbook search | **16.6 ms** | < 200 ms |
| Status toggle (visible) | **20.7 ms** | < 100 ms |
| Document progress computation | **16.8 ms** for 1,112 documents | < 100 ms |
| Document progress status-override path | **41.4 ms** with 1 override | < 100 ms |
| Occurrence re-download during UI interaction | 0 requests | 0 |

The first sync read **no** `word_occurrences` and no full `word_states` rows,
and stored 25,000 / 25,000 projection rows locally before any document body was
opened. The synthetic second-device flow in spec 41 also downloaded zero
occurrence rows and zero document bodies.

## 4-user refresh load gate (final run)

```
effective edits: 100
p50 24.28 ms   p95 31.22 ms   p99 33.59 ms   max 39.62 ms
warm-up p95: 72.23 ms (1 excluded edit/user)
errors 0   deadlocks 0   retries 0
no-op phase: 100/100 succeeded, 0 projection writes, 0 document writes,
             source/projection/document fingerprints unchanged
consistency: 100,000 live entries, 0 mismatches, 0 refresh-queue rows
fixture: 4 users, 800,000 occurrences, 4,448 documents, 92,800 word states
PASS
```

Gate limits: p95 < 100 ms, p99 < 250 ms. Result artifact:
`/tmp/opencode/r3-load-2026-10-23T18-57-12-701Z-66cf0c3a.json`.

## Projection bytes and egress

From `node scripts/r3-metrics.mjs` (read-only, local target; `incomplete: false`):

```
projection table bytes       258,252,800
projection + indexes         305,029,120  (100,000 rows, 4 users)
per-user projection storage   76,257,280  (~72.7 MiB per 25,000-row user)
average row width             818 B
24h pull pages                27
24h pull rows                 25,000
bytes per page                757,407  (< 1 MB target)
egress per new device         20,450,000 B (~19.5 MiB) for 25,000 rows
egress budget                  64 MiB
```

Per-user storage is the total projection + index bytes divided by the four
fixture users. Egress is a separate measure: `projection_usage` row counts over
24 h multiplied by the `pg_stats` row width (`bytesEstimated: true`). The
percentile and no-op figures come from the fresh load artifact above.

## Rate limits, resumability, and quota behavior

Spec 41 drives the real server quota:

1. The account's page bucket is set one request below the 60/minute limit. The
   helper waits for a fresh epoch minute if seeded after second 40, widening the
   margin so a reload cannot roll into an empty bucket.
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
The full Vitest suite (1206 tests) passes.

## E2E flow evidence (spec 41, 38/38)

- First sync: 0 `word_occurrences` table reads, 0 full `word_states` reads;
  projection pages are requested only after metadata and all carry one
  snapshot, `p_limit=1000`, and `p_updated_since=null`.
- Interruption/resume: cursor persisted and re-sent; 1,200/1,200 rows stored.
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

## Full e2e failure classification (4)

`npm run e2e` → **596/600**. All four remaining failures are **external**:
the local Edge Function has no `GOOGLE_TRANSLATE_API_KEY` (no production key
used), and the function returns HTTP 500 before its translation call.

| Spec | Failure | Classification |
|---|---|---|
| `03-sentence-translation` (2) | `Translation service error (500)` | external: local translate provider unconfigured |
| `13-offline` (1) | stored sentence translation fails | external: same missing local provider |
| `34-quiz` (1) | context translation timeout | external: same missing local provider |

The R2 baseline was 560/560 on the production-backed configuration. This run
uses 600 checks (hardened R3 specs) and a local-only backend; the four failures
are not evidence of an R3 regression and are not a green full gate. Specs 28
and 29 were R3-caused failures in the first review run (the new ask-by-default
dictionary prompt blocked `Runtime.evaluate`); they now pass 7/7 and 8/8 with
the auto-download preference, and are **not** classified as external failures.

No assertion or threshold was weakened to hide any failure.

## Release checklist

- [x] Projection first sync carries no occurrence or full word-state download.
- [x] Projection pages resume from a stored cursor after a 429 interruption.
- [x] Offline wordbook and search work from the projection.
- [x] Lazy document content: one payload fetch, local reopen, no occurrence push,
      no source-table read on open or wordbook open.
- [x] Metadata-only exact length and longest sort come from `char_count`.
- [x] 200k account UI budgets met (first render, search, status, progress,
      progress status override).
- [x] 4 × 200k refresh gate PASS with zero deadlocks/no-op writes.
- [x] v7 upgrade and local SQL/RLS/quota checks pass.
- [x] Metrics snapshot complete with egress and page-byte evidence.
- [x] Fixture status restored after spec 42.
- [ ] **Production migration — NOT PERFORMED.**
- [ ] **Production deployment — NOT PERFORMED.**
- [ ] **Production data change — NOT PERFORMED.**

Release requires explicit user approval before any `supabase db push`, migration,
or frontend deployment. This document records verification only.
