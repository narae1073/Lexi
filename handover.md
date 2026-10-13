# Handover — Lexi (2026-10-13)

A bridge to the next session. Everything in here reflects the repo state after
this session's commits — deployed site and git agree again.

## 1. Where things stand

- **Deployed**: `app.achijaser.date` (`/var/www/lexi`, nginx + Cloudflare) — same content as git HEAD.
- **Database**: `gwsrowpbcqwtpciknayl` — all 8 migrations applied (incl. `20261013000000_folders`).
- **RLS**: standard suite passes; `folders` additionally verified (anon read 0 rows, anon write denied 42501).
- **Verification stack**: `npm run verify` (typecheck + oxlint + vitest + build + RLS), `npm run e2e [-- name]`.

Last full green run before the handover commit: unit **635/635**; e2e `01` 24/24 · `07` 32/32 ·
`18` 10/10 · `26` 14/14 · `30` 11/11 · `31` 12/12 · `32` 10/10 · `33` 10/10 · `15` 12/12.

## 2. What this session shipped (commit-by-commit)

| commit | what |
|---|---|
| `feat: 밝은 테마의 상태 색을 테마 분위기에 맞춘다` | per-theme light options for unsure/unknown tokens; legend dots fixed (`statusDotClass`) |
| `feat: 붙여넣기에서 글자 한도를 두고 붙여넣은 글의 언어를 안다` | 50,000-char cap shown as `N / 50000`; paste auto-detection (auto-switch among enrolled languages + Undo; suggestion for non-enrolled; only Undo suppresses for the session) |
| `feat: 문서 머리말에 만든 날을 둔다` | `Created {date}` in the reader header (`<time>`) |
| `feat: 단어장에서 별 색으로 즐겨찾기를 좁힌다` | ★ tab multi-select color filter (`StarColorFilter`, `filterByStarColors`) |
| `feat: 문서 목록에 폴더를 두고 언어로 좁힌다 (폴더 1단계)` | folders Phase 1 + document-list language filter (see §3) |
| `docs: 보류` | `개선사항.txt` updates + this handover |

## 3. Folders project — agreed design and remaining work

Original phases: **1 foundation ✅ → 2 nesting ⏭ → 3 multi-select/bulk ⏭ → 4 drag-and-drop ❌ cut**
(user decided: no dragging anywhere; long-press → multi-select → "Move to" plus an explicit
**"Select documents"** button in the top bar serve both desktop and touch).

### The load-bearing design idea (do not break)

`documents.updated_at` **is** "last opened" (list dates + Recently-opened sort). Moving a document
must not change it. So:

- `folder_updated_at` is a separate stamp; the migration rewrites `set_updated_at()` so a folder-only
  UPDATE stamps only that (both stamps guarded with `greatest()` so pushes can't ping-pong `updated_at`).
- `documents.moveToFolder(ids, folderId|null)` never touches `updatedAt` (ids-array = single & bulk path).
- Merge resolves **content by `updatedAt`, folder by `folderUpdatedAt`, separately** (`folderWinnerOf`).
- `changedFolders()` + `documentsToPush` compare folder fields; **folders push before documents** (FK).
- Folder delete soft-deletes and **reparents** direct children (subfolders + docs) to the deleted folder's
  parent; merge ties prefer the tombstone. No recursive delete, no document loss.

### Phase 2 — nesting (NO new migration; `parent_id` already exists)

- Create-inside-folder; expandable tree in the chips row **and** in the "Move to…" picker (the picker in
  `MoveToFolder.tsx` currently lists root folders only).
- Cycle prevention via `ancestorsOf()` in `folderTree.ts` (already has a runaway-loop guard).
- **Open decision for the user:** with depth, a flat chips row gets crowded — do we keep chips for depth-1
  plus a breadcrumb inside a folder, or go to a compact tree/sidebar?

### Phase 3 — multi-select + bulk actions

- Entry points: **"Select documents"** button in the list top bar + **long-press ~500 ms** on a row
  (cancelled on scroll/move). Checkboxes beside titles; tapping a row toggles selection (not open).
- Bulk bar: *N selected* · Move to… (reuse picker) · Move to trash (reuse reversible `trash()`) · Cancel (Esc).
- `moveToFolder` already accepts id-array, so bulk and single share one path.

## 4. Where the folders code lives

- `src/features/reader/DocumentList.tsx` — chips row, folder-aware filtering, in-list empty message.
  **The empty state must stay inside the main render** — an early `return` for "empty folder" once removed
  the chip row and trapped the user inside an empty folder (caught by e2e `33`).
- `FolderChips.tsx` — chips, inline "+ New folder" (Enter/blur commit, Esc cancel), per-chip ⋯ menu.
  Only **root** folders are chips today.
- `MoveToFolder.tsx` — row button + `Popover` menu ("No folder" + folders).
- `folderTree.ts` — pure: `liveFolders`, `childrenOf`, `folderOfDocument`, `ancestorsOf`.
- `src/app/stores/folders.ts` — CRUD; `load()` shows live folders only (tombstones stay in IndexedDB for merge).
- `src/lib/sync/sync.ts` — `mergeFolders`, `changedFolders`, `folderWinnerOf`, `push({…, folders})`;
  `readLocal` normalizes `folderUpdatedAt ?? updatedAt` for legacy rows.
- `src/lib/storage/localDb.ts` — `DB_VERSION = 5` added the `folders` store; `SYNCED_STORES` includes it.

## 5. Infrastructure gotchas learned here

- `npm run db:push` must run **from the project directory** (`npm error ENOENT /home/achi/package.json`
  happened once from `$HOME`). `npx supabase login` has already been done on this machine.
- **Deploy order: migration first, then frontend** — the new frontend reads `folders`; shipping it before
  the schema breaks sync for logged-in users. Deploy = build + `sudo cp -r dist/* /var/www/lexi` + chown.
- Hard-refresh **twice** after deploy (service worker is NetworkFirst for HTML; it may lag one load).
- The user tests on the deployed origin (`app.achijaser.date`), not localhost; sessions are origin-bound.
- `verify:rls` doesn't cover new tables — extend or check ad-hoc (anon read 0 / write 42501) per table.

## 6. e2e harness quirks (cost real time this session)

- `ctx.clickText()` is **exact match** — chips read "🇺🇸 English", so it silently no-ops; click via an
  includes()-based helper instead.
- `ctx.createDocument()` **does not set a title** (docs end up "Untitled") and assumes you're already on a
  compose screen. Assert on body words/row counts, not titles.
- List-row helpers see only title/meta text, never document body.
- Paste in e2e = dispatched `ClipboardEvent` with `DataTransfer` (`Input.insertText` doesn't fire `paste`).
- `memoryServer()` in `twoDevices.test.ts` is a hand-rolled fake — **add every new synced table to its
  `tables` map or tests hang** (happened with `folders`).

## 7. Gaps / watch-list

- Folder ordering is `createdAt` (no manual ordering); acceptable for now.
- A stale device can briefly point a document at a tombstoned folder — UI shows it as "no folder" and the
  merge self-heals on the next sync.
- Supabase CLI update available (2.120); unused.
- `개선사항.txt` remains the user's backlog of remaining ideas (quizzes, favorites tab polish, etc.).

## 8. Suggested first actions next session

1. Confirm the deployed site still serves HEAD (git = deployed now).
2. Settle the Phase 2 nesting UI question with the user (§3).
3. Implement Phase 2 (picker/tree + cycle guard), then Phase 3 (select mode + bulk bar).
