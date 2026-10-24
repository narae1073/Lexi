# R3 — Scale & Data Usage Design

**Status:** Accepted; implementation complete, production release pending explicit approval
**Date:** 2026-10-24
**Scope:** Lexi R3, building on the completed and deployed R2 sync model.

## Decision update — 2026-10-24

The following decisions are settled and supersede earlier “proposed” or
“remaining decision” language in this document:

- **Q1(a) — 116k is a worst-case upper bound; keep the 64 MB soft cap.** The
  116k figure was derived by linear extrapolation from the production ratio
  (3,237 distinct lemmas / 5,571 occurrence rows = 0.581; 200,000 × 0.581 =
  116,000), not from Heaps’ law. Natural-language vocabulary growth is
  sublinear; the 25k-lemma release fixture is an intentional synthetic model,
  not a linear extrapolation. The 64 MB cap remains; a worst-case 116k
  projection may require a second pass, which conditional auto-resume makes
  invisible on Wi-Fi/unmetered networks. A genuine 116k stress fixture remains
  an optional verification spike, not a release prerequisite.
- **Q2 — conditional auto-resume is approved.** On Wi-Fi/unmetered, a paused
  projection resumes silently; on metered/`saveData`, the prompt remains a
  data-consent gate. Paused state survives reload/app restart and resumes on
  app open/online/visibility. Background Fetch is not used.
- **Q2 — paused banner restoration is P1.** Persisting and restoring the paused
  projection state after reload is now a release prerequisite, not polish.
- **Q4 — IndexedDB v7 is accepted.** Local data is preserved by the additive
  v6→v7 upgrade. R2 cannot reopen a v7 database; post-deploy rollback means
  forward-fix, not code rollback. Server rollback remains possible.
- The 64 MB/10 MB/25 MB caps, client-derived document progress, security-definer
  refresh mechanism, and the 200k local seed/load gate are accepted decisions.

## Intent

Make large accounts usable without turning opening a document into a full-content/full-occurrence re-download, while keeping the **entire wordbook available offline immediately after the first wordbook sync on a new device**.

The chosen interpretation of “entire wordbook” is:

- every lemma the user has encountered;
- every context sentence stored for those lemmas;
- status, star, note, counts, and quiz-relevant state;
- available offline after the initial wordbook projection completes.

Document text and per-document occurrence detail are allowed to load when a document is opened.

## Goals

- A new device can show the complete wordbook without downloading every raw occurrence or every document body.
- Opening a document does not make other devices download its text or occurrences unless the content or occurrence version changed.
- The 200,000-row hard failure is replaced by a recoverable byte-budgeted, resumable initial sync.
- Incremental pulls use indexes and `EXPLAIN` verifies them.
- Wordbook search, document progress, and word-state updates remain responsive at 200k occurrence rows.
- Local response cache has a size cap and eviction policy; dictionary downloads are prompted and the WASM runtime is available offline.
- Tombstones are pushed through a once/queued path rather than being re-sent indefinitely.
- Local-only operation, existing learning semantics, and the known/unsure/unknown rules are unchanged.

## Non-goals

- R4 CI, staging, monitoring, or generated-type automation.
- R5 account export/delete or privacy policy work.
- Full offline reading of every document on a brand-new device.
- Lazy loading of wordbook entries or context sentences.
- Changing the quiz spacing rules, cloze rules, or status semantics.
- Production deployment without explicit approval.

## Anti-goals

- A first sync that downloads every `word_occurrences` row for the account.
- A wordbook that only shows a summary until the user opens each word.
- Silent deletion or eviction of local learning data to satisfy a byte cap.
- Reworking R2’s write/merge safety guarantees.
- Coupling the wordbook projection to a single client renderer.

## Measured baseline

Measurements were read-only against production or against a throwaway local benchmark schema that was dropped. No production writes were made.

### Production

| Measure | Value |
|---|---:|
| Users with data | 1 |
| Documents | 31 (26 active, 5 trashed) |
| Word occurrences | 5,571 across 30 documents |
| Word states | 2,981 |
| Folders / tombstones | 1 / 0 |
| Average occurrences per document | 172 (max 433) |
| Distinct lemmas | 3,237; 5,163 lemma/document pairs |
| Full raw-pull JSON | occurrences 1.70 MB, states 1.55 MB, documents 89 KB |
| Full wordbook projection | 3,237 entries, 1.36 MB, 5,163 contexts |

Production currently has heavy occurrence churn: 28.9M inserts and 28.9M deletes for 5,571 live rows. This is likely test traffic, but R3 load tests must not run against production and the production occurrence indexes may need maintenance.

### 200k-row model

| Measure | 200k occurrences |
|---|---:|
| Full raw-pull JSON | ~120 MB (occurrences 61 MB, states ~56 MB, documents ~3 MB) |
| Full wordbook projection | ~49 MB (116k entries, ~24 MB of contexts) |
| Raw-pull pages at 1,000 rows | ~309 |
| Fresh server table size | 63.9 MB (35 MB heap, 28.8 MB indexes) |
| Client wordbook build from occurrences | 1.61 s |
| Client document progress from occurrences | 188 ms |
| Client heap delta | ~59 MB |
| Server wordbook aggregate | 102 ms |
| Server document-progress aggregate | 109 ms |
| Server joined wordbook aggregate | 172 ms |

The exact model used 1,112 documents, 116,000 lemmas, and 200,000 occurrence rows. Client timings are single-threaded Node measurements, not a mobile-device guarantee.

**How 116k was derived.** It is a linear worst-case extrapolation, not a
vocabulary-saturation model: production has 3,237 distinct lemmas across
5,571 occurrence rows, or 0.581 lemmas per row; 200,000 × 0.581 ≈ 116,000.
Applying Heaps’ law with β≈0.5–0.6 to the same starting point yields roughly
19k–28k lemmas at 200k occurrences. The release fixture intentionally uses
`HOT_POOL = 5,000` + `COLD_POOL = 20,000` = **25,000 distinct lemmas/user**,
with 60% hot/40% cold per document and ~10% surface duplicates; it was not
derived from the production ratio. The accepted 64 MB cap is therefore sized
for the natural-language range and is only a soft two-pass case for the linear
worst-case model when auto-resume is available.

### Current cache and dictionary cost

- Japanese dictionary zip: 10.5 MB.
- Chinese dictionary zip: 7.25 MB.
- Lindera WASM: 1.89 MB.
- Service worker precache: 787.85 KiB; it does not include the dictionary zips or the WASM file.
- `responseCache` is pruned only after 90 days and has no size cap or LRU.

## Approaches considered

### A. Complete wordbook projection + lazy document content (chosen)

Server builds a derived, syncable wordbook projection. The first sync downloads the complete projection. Document text and occurrence rows are fetched per document when opened. Document progress is derived from the projection.

**Trade-off:** Requires a derived server table, refresh logic, and an IndexedDB schema change, but cuts the 200k first-sync payload from ~120 MB to ~49 MB and removes the client-side wordbook aggregation cliff.

### B. Full raw occurrence mirror

Keep the current occurrence model, add byte budgeting/resume, and download all occurrences/states on a new device.

**Trade-off:** Simpler server model and full offline document data, but ~120 MB at 200k, ~309 pages, and the client still builds the wordbook from 200k rows. Rejected.

### C. Projection first, optional full-document prefetch

Download the complete wordbook projection first, then optionally prefetch document bodies/occurrences.

**Trade-off:** Fastest complete wordbook and good offline reading, but adds a second byte/eviction policy and more lifecycle complexity. Rejected for R3 unless a later requirement adds full offline documents.

## Architecture

### Server data model

#### `wordbook_entries` (derived, server-owned)

One row per `(user_id, language_code, lemma)`.

Required columns:

- `user_id`, `language_code`, `lemma`
- `surfaces`: distinct surfaces for the lemma
- `contexts`: JSON array of `{ documentId, sentence }` for every stored context
- `occurrence_count`: the sum of **one count per `(document_id, lemma)`**, not one per surface row
- `document_count`: distinct documents
- `status`, `is_favorite`, `star_angle`, `star_color`
- `seen_count`, `first_seen_at`, `last_seen_at`
- `favorite_updated_at`
- `known_presses`, `unsure_presses`, `unknown_presses`
- `note`, `note_updated_at`
- `server_updated_at`
- `deleted_at` for soft deletion of a projection entry

The table is derived from `word_occurrences`, `word_states`, and documents. It is not client-writable. RLS is `auth.uid() = user_id`.

Indexes:

- primary key `(user_id, language_code, lemma)`
- `(user_id, server_updated_at, language_code, lemma)` for incremental pages

Contexts store `documentId`, not document title, so a title rename does not rewrite every affected wordbook row. The client resolves titles from document metadata.

Aggregation rules must match the existing local wordbook semantics:

- `word_occurrences` has one row per `(document, lemma, surface)` and repeats `occurrences_count` on each surface row. `occurrence_count` must take the count once per `(document, lemma)` and then sum across documents.
- `contexts` are distinct `(documentId, sentence)` values for the lemma; empty sentences are excluded. The client may deduplicate identical sentence text for display, but document progress still needs the document association.
- `surfaces` are distinct across the lemma's rows.
- `status` is nullable. A word state may exist without an occurrence; it is not part of the wordbook projection until an occurrence exists.

`deleted_at` is required because an incremental pull must propagate removals. A projection entry whose last occurrence disappears is soft-deleted and carries a new `server_updated_at`; clients remove it. If the lemma reappears, the row is revived.

#### Document version columns

Add to `documents`:

- `last_opened_at`: updated by opening a document; does not imply content or occurrence change.
- `content_updated_at`: changes when `raw_text` or `language_code` changes.
- `occurrences_updated_at`: changes when the document’s occurrence rows change.
- `char_count`: `char_length(raw_text)`, maintained by the server on insert/content update, so document length and the “longest” sort work without downloading content.

Existing rows are backfilled:

- `last_opened_at = updated_at` at migration time.
- `content_updated_at = created_at` unless the migration can prove a later content change.
- `occurrences_updated_at = updated_at` at migration time.
- `char_count = char_length(raw_text)`.

`updated_at` remains for R2 compatibility and existing metadata/resolution rules. The R3 client treats `last_opened_at` as the source for “recently opened” and does not use an open to infer content change.

`documents` metadata pull excludes `raw_text` and includes the version columns and `char_count`. `raw_text` is fetched only by the document-content endpoint.

The R3 document merge and push rules change accordingly:

- Metadata merge never overwrites locally loaded content.
- A metadata-only document is never treated as a content edit merely because `rawText` is absent.
- `documentToRow` includes `raw_text` only on content writes; metadata updates use a separate RPC or metadata-only payload.
- `DocumentList` uses `charCount` for length display and sorting; it does not require `rawText`.

Indexes:

- `documents (user_id, server_updated_at, id)`
- equivalent `(user_id, server_updated_at, id)` indexes for `folders`, `word_states`, and `document_tombstones`

The R3 plan must run `EXPLAIN` for each incremental pull query and record the plan.

#### Projection refresh

The projection is server-owned and must be updated on every mutation path:

- `replace_word_occurrences` refreshes entries for the union of old and new lemmas of that document.
- `word_states` insert/update/delete refreshes the matching entry if it exists.
- document deletion removes/updates entries for the deleted document’s lemmas.
- backfill/rebuild is possible from source tables.

The implementation may use statement-level triggers with transition tables or explicit functions called from the existing RPCs. Whichever is chosen, tests must cover:

- occurrence replacement with changed rows;
- occurrence replacement with no rows;
- document deletion and cascade;
- status/favorite/note/press changes;
- title rename without rewriting contexts;
- two documents contributing the same lemma;
- a word state with no occurrence (not in the wordbook projection).

The preferred implementation is a small set of `security definer` refresh functions called by statement-level triggers with transition tables on `word_occurrences` and `word_states`, plus the existing `replace_word_occurrences` RPC. This covers old R2 clients that still write through the RPC as well as R3 clients. The exact trigger placement belongs in the executable plan, but it must update the projection in the same transaction as the source write.

#### Word-state source of truth and merge

`word_states` remains the write source and the field-level merge source. `wordbook_entries` is a derived read model and carries the timestamps needed to preserve R2 merge behavior:

- status: `last_seen_at`
- stars: `favorite_updated_at`
- notes: `note_updated_at`
- seen count: `seen_count` / `first_seen_at`
- presses: per-press counters

R3 does **not** replace field-level merge with last-row-wins. A pulled projection entry merges into local word state using the same winner rules as `mergeWordStates`, and a locally dirty key wins until its push is acknowledged.

Hydration from a full projection is silent: it must not increment pending counts, create dirty keys, or look like user writes. After hydration, the word-state push watermark is initialized to the projection snapshot (or the corresponding sync cycle) so a new device does not re-push 100k hydrated states. Only local user edits enter the dirty journal.

#### Projection completeness and upgrade behavior

`pull.snapshot` is not sufficient to decide that the wordbook projection exists. A device may have R2 watermarks but no projection, and a newly enrolled language may appear after the first sync.

Store a local, per-account/per-language projection state in device-local metadata (for example, a reserved `documentMeta` key):

- `complete: boolean`
- `snapshot: string | null`
- `cursor: { languageCode, lemma } | null`
- `hydratedAt: string | null`

This state does not bump `SYNC_STATE_VERSION` and does not clear R2 push watermarks.

On R3 upgrade or new-language enrollment:

1. Keep the existing local wordbook built from local occurrences visible while the projection downloads.
2. Mark that language incomplete and run a full projection pull with its own snapshot.
3. Do not advance the global document/occurrence pull watermark based on projection pages.
4. When complete, mark the language complete and begin incremental wordbook pulls from that projection snapshot.
5. If interrupted, resume from the cursor and snapshot; do not restart or delete local entries.

A new device with no local wordbook shows a wordbook-preparation state for each language until its projection completes.

#### New read endpoints

- `get_document_payload(p_document_id)` or equivalent: returns `raw_text`, `content_updated_at`, and occurrence rows needed for the document. The plan may split content and occurrences into two endpoints for byte budgeting.
- `touch_document(p_document_id, p_opened_at)`: updates only `last_opened_at`; never sends or rewrites `raw_text`.
- `sync_snapshot` remains the pull watermark source and keeps the R2 semantics.

All endpoints remain `security invoker` where possible and use RLS as the boundary. Authenticated-only grants are explicit.

### Sync protocol

#### First sync

1. Pull languages, document metadata (no `raw_text`), folders, tombstones.
2. Pull the complete `wordbook_entries` projection for all enrolled languages, paged by `(language_code, lemma)` with a projection snapshot upper bound.
3. Hydrate local word states silently from the projection entries so the reader can show statuses.
4. Do not pull raw occurrences or full `word_states` for a new device.
5. Show a progress screen while each language's projection downloads.

The projection is complete after step 2 for a language; that is the point at which that language's wordbook is offline-complete. A user with multiple enrolled languages sees each language become available independently.

The full projection includes only live entries (`deleted_at is null`). Incremental pulls include soft-deleted entries so clients can remove phantoms.

#### Incremental sync

- Pull changed document metadata by `(user_id, server_updated_at, id)`.
- Pull changed `wordbook_entries` by `(user_id, server_updated_at, language_code, lemma)`, including soft-deleted rows.
- Wordbook entries are the read model for wordbook, quiz contexts, and the word-state display on R3 clients. R3 does not pull the full `word_states` table.
- Do not pull document content or occurrences merely because `last_opened_at` changed.
- When a document is opened:
  - Compare local `content_updated_at` and `occurrences_updated_at` with the metadata.
  - Fetch only the content/occurrences that are missing or stale.
  - Do not recompute and re-push occurrences merely because the app was reloaded.
- A local tokenizer/lemma-version change may intentionally create a new occurrence version; that is a content/occurrence change, not an open.

Word-state writes still use the existing `word_states` push path. The server updates the projection through the refresh path. A local edit updates the local entry optimistically; the next wordbook pull returns the canonical row. Dirty local state keys are not overwritten by a pull until their push is acknowledged.

#### Projection snapshot state machine

The wordbook projection has its own snapshot and cursor; it does not share the document pull watermark.

- A full projection pull reads rows with `server_updated_at <= projectionSnapshot` and pages by `(language_code, lemma)`.
- The cursor and snapshot are persisted together. An interrupted pull resumes with the same snapshot and advances only after the complete language is stored.
- After completion, incremental wordbook pulls start at `projectionSnapshot` with the normal overlap. Rows changed after the snapshot are picked up by the incremental pull, even if their lemma sorts before the completed cursor.
- Incremental document/wordbook pulls may continue while a language projection is incomplete, but they must not remove or mark that language's projection complete.
- A manual full resync resets projection state explicitly; an ordinary R2→R3 upgrade does not clear push watermarks.

#### Byte budget and resumability

- Remove the global `MAX_ROWS = 200_000` hard failure.
- Page by bytes as well as rows; target a small page budget (roughly 1 MB) and store a resumable cursor with the snapshot.
- Initial wordbook projection has an accepted soft cap of 64 MB uncompressed. A worst-case 116k projection may need a second pass; a natural-language account near the 25k fixture is covered by one pass.
- Per-document content/occurrence fetch has an accepted soft cap of 10 MB and a paged/resumable path for larger documents.
- A failed or interrupted projection resumes from its cursor; it does not restart and does not delete local data.
- No byte cap may silently evict learning data. Cache eviction applies only to disposable response/dictionary caches.

#### Conditional auto-resume (approved)

Paused projections resume without a manual “2-pass/days” decision:

- **Wi-Fi / unmetered:** resume silently from the persisted snapshot and cursor on app open, `online`, or visibility; no button.
- **Metered / `saveData` / slow effective connection:** show the prompt and require consent before continuing.
- **Reload/app restart:** restore the paused language state immediately from device-local metadata and resume silently where the network allows.
- Use app lifecycle/network events plus the existing sync scheduler; do **not** depend on Background Fetch, which is unreliable on iOS.
- Auto-resume is client-side; the server pass-state/quota contract already supports same-snapshot resume. No new server endpoint is required.
- Persist the paused state in the reserved `documentMeta` projection record per account/language: `reason` (`bytes`/`quota`/`offline`/`error`), `pausedAt`, optional `nextAttemptAt`, `quotaBucket`, and `retryAfterSeconds`, alongside the existing `complete`, `snapshot`, `cursor`, and `hydratedAt`.
- Paused-state restoration is a **P1** release requirement (promoted from P3), because it is the prerequisite for continuous auto-resume after reload.
- Required tests: reload while paused; cold app restart; `online`/visibility resume; Wi-Fi/unmetered silent; cellular/`saveData` prompt; quota-window retry; no duplicate pass or daily unit; no server re-report.

#### Responsiveness targets

Reference device: a mid-range Android phone (Pixel 6 class) in Chrome with 4× CPU throttling, plus a desktop sanity run. Targets for the 200k fixture:

- wordbook first usable: **< 2.5 s** after the projection is locally available;
- wordbook search/filter: **< 200 ms**;
- document progress refresh: **< 100 ms**;
- status toggle to visible update: **< 100 ms**;
- scrolling and typing stay responsive at 60 fps.

If client-derived document progress misses the 100 ms target, add a compact server-side document-progress projection or a local progress cache; that is a fallback, not the default.

### Local data

Add IndexedDB stores:

- `wordbookEntries`: keyed by `languageCode\0lemma`; stores the complete projection and is the read model for both synced and local-only accounts.
- `documentContent`: keyed by document id; stores `rawText`, `contentUpdatedAt`, and optional occurrence rows or a content-loaded marker.
- Optional derived progress cache if the worker benchmark requires it.
- Reserved device-local projection metadata per user/language; this is not synced.

The existing `documents` store remains metadata for synced accounts; for local-only accounts it may continue to carry the full document as it does today. The reader resolves content through the content store and falls back to the existing document store for local-only data.

#### Local-only mode

Local-only accounts have no server projection. R3 builds `wordbookEntries` locally from local occurrences and word states in a worker, using the same aggregation rules as the server:

- initial build on first use and after a full local import;
- incremental update when a document’s occurrences change, a word state changes, a document is deleted, or the tokenizer/lemma version changes;
- no cloud dependency and no loss of the complete offline wordbook.

The existing `buildWordbook` logic is retained as the semantic reference and worker aggregation code, but the UI reads `wordbookEntries` in both modes. Tests compare synced projection semantics against the local builder for the same source data.

IndexedDB version 7 is **accepted** for the new stores. The additive v6→v7 upgrade preserves existing stores, rows, and sync metadata; this is covered by `src/lib/storage/localDbV7.test.ts`. **Rollback boundary:** an R2 frontend cannot open a v7 database after R3 has opened it. R3 is therefore a one-way frontend release with server rollback still possible; post-deploy frontend rollback means forward-fix, not code rollback. The alternative separate-database/store strategy is not selected.

### UI

- `Wordbook` renders from `wordbookEntries`; no full occurrence scan or `buildWordbook` aggregate on the main thread.
- Wordbook search and sorting run in a worker or over a precomputed sorted index; pagination remains.
- `DocumentList` progress is derived from wordbook contexts/document ids, memoized and worker-backed. If the 200k benchmark misses responsiveness targets, add a compact per-document progress projection.
- A paused projection banner is restored from device-local metadata after reload; it is not dependent on an in-memory sync report surviving the page lifecycle.
- On Wi-Fi/unmetered, a paused projection resumes silently; on metered/`saveData`, the prompt remains visible until consent.
- `ReaderView` fetches content/occurrences on open, shows a loading state only for the missing document, and never blocks the wordbook or document list.
- Quiz uses contexts already present in the wordbook projection; no context fetch is required for a new device.
- Document list rendering is paginated/virtualized for large accounts.

### Cache, dictionary, and WASM

- Add a bounded LRU/size policy to `responseCache` (accepted 25 MB) in addition to age pruning.
- Before downloading Japanese/Chinese dictionaries, prompt with the exact size and respect Wi-Fi/`saveData` preferences.
- Precache the Lindera WASM runtime with the service worker so offline dictionary use does not depend on a prior browser cache.
- Dictionary zips may remain on-demand and are stored in OPFS after download.

### Tombstones

Keep the existing watermark/dirty-key machinery, but make the push path explicitly once/queued:

- A tombstone is sent only while it is pending/unsent.
- The tombstone and document deletion are acknowledged as one logical operation.
- Legacy epoch-0 tombstones remain a documented special case.
- Tests must show a second sync does not re-send an acknowledged tombstone.

## Risks

- **Projection staleness:** the derived table must be refreshed on every mutation path; a missed trigger produces a wordbook that disagrees with source data.
- **First-sync size:** ~49 MB at 200k is still significant on mobile; compression, progress UI, and resumability are part of the feature, not polish.
- **Upgrade download:** an existing R2 account still downloads the full projection after upgrading. This is expected, but it is a one-time 49 MB cost and needs first-class progress and resume behavior.
- **IndexedDB rollback:** accepted one-way v7 boundary; R2 cannot reopen the database. Post-deploy frontend rollback is forward-fix, not code rollback.
- **Server refresh cost:** recomputing affected lemmas after occurrence replacement must stay within the request budget.
- **Dual mode:** local-only wordbook and synced projection wordbook must stay semantically identical.
- **Word-state hydration:** a hydrated server state must not look like an unsynced local edit; otherwise a new device re-pushes the whole wordbook state.
- **Document deletion:** cascade paths must update the projection before or after deletion without leaving orphan contexts.
- **Large documents:** a single document can still exceed a per-document byte cap; the failure must be recoverable and explained.

## Acceptance and tests

R3 is complete when:

- A new 200k account can show the complete wordbook offline after its projection sync, without downloading every occurrence or document body.
- Opening a document on device A does not make device B download its `raw_text` or occurrence rows unless content/occurrences changed.
- A second open/reload of an unchanged document does not re-push occurrences.
- Every incremental pull query has an `EXPLAIN`-verified index plan.
- The 200,001st occurrence does not hard-fail; the sync resumes or prompts by budget.
- The 200k client benchmark meets the responsiveness targets above: first wordbook < 2.5 s, search < 200 ms, progress < 100 ms, status update < 100 ms.
- An R2 device upgraded to R3 with no projection downloads the complete wordbook for each enrolled language without resetting R2 push watermarks, and keeps its existing local wordbook visible during the download.
- A newly enrolled language gets its own complete projection without re-downloading other languages.
- A projection entry whose last occurrence disappears is removed locally after an incremental pull; it does not remain as a phantom word.
- A non-dirty local word-state edit wins over a stale projection row; a hydrated server state does not create a pending push.
- A metadata-only document shows its character count and sorts correctly without content, and opening it does not re-push `raw_text`.
- A paused projection restores its banner/state after reload and auto-resumes on Wi-Fi/unmetered; metered/`saveData` still requires consent.
- The v6→v7 IndexedDB upgrade preserves all local learning data; the one-way R2 boundary is documented.
- Dictionaries prompt with size; WASM works offline; response cache is capped.
- Acknowledged tombstones are not re-sent.
- Existing unit/e2e suites pass, plus the local 200k seed/load test and the two-device manual sync check.

## Rollout

1. Add and backfill the server projection/indexes/RPCs; verify source/projection counts and RLS.
2. Keep R2 clients working against the additive schema.
3. Ship the R3 frontend behind the normal build/deploy process only after explicit approval.
4. Do not apply production migrations or deploy as part of the design/plan work.
5. Recheck live headers/RLS after any later deploy; remind the user to hard-refresh twice.

## Decisions already made

- The complete wordbook, including every context sentence, must be available offline on a new device.
- Document text and occurrence detail are lazy per document.
- Server-side derivation, not full raw occurrence sync, is the chosen path.
- The first wordbook projection is a full download, paged and resumable.
- Opening a document is not a content change.
- The projection is a derived `wordbook_entries` table with soft deletion, not a client-built aggregate.
- Wordbook projection completeness is tracked per account/language in device-local metadata; it does not bump `SYNC_STATE_VERSION` or reset R2 push watermarks.
- Required wordbook merge fields and timestamps live in the projection; field-level merge semantics are preserved.
- Document metadata includes `char_count`; metadata-only documents never trigger a content push.
- Local-only wordbook uses the same `wordbookEntries` read model, built by a worker from local occurrences.
- Hard caps are accepted: 64 MB per complete wordbook projection, 10 MB per document payload, and 25 MB response cache with LRU eviction.
- 116k is accepted as a linear worst-case upper bound; the 25k fixture is the natural-language-scale release fixture. A genuine 116k stress fixture is an optional verification spike.
- Conditional auto-resume is approved; paused-state restoration is a P1 release requirement.
- Projection refresh is transactional with source writes; the accepted mechanism is security-definer refresh functions with affected-only, deterministic, set-based updates.
- Document progress is client-derived in a worker by default, with a server progress projection as a tested fallback.
- R3 test fixtures use both the local Supabase stack and a repeatable seed script.
- IndexedDB v7 is accepted as a one-way frontend release; R2 cannot reopen the database, and post-deploy frontend rollback means forward-fix.

## Settled decisions

All earlier open decisions are closed. The remaining work is implementation/verification of the approved auto-resume and paused-state restoration, the optional 116k stress fixture, the local translation-provider e2e key, and the production release runbook. Implementation is complete; production release still requires explicit approval.
