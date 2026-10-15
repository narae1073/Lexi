# Folder Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the folder chips row with a drill-down folder browser plus select-mode bulk move/trash.

**Architecture:** Pure tree helpers first, then a `moveFolder` store action, then the `DocumentList` rewrite (navigation shell → select mode → tree picker), deleting `FolderChips.tsx`/`MoveToFolder.tsx`, ending with an e2e rewrite of the folders suite.

**Tech Stack:** React + react-router + zustand, existing `Popover`, vitest, e2e harness (`e2e/run-all.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-15-folder-navigation-design.md`

## Global Constraints

- `documents.updated_at` is "last opened" — `moveToFolder(ids, folderId|null)` never touches `updatedAt`; folder moves stamp only folder-side timestamps.
- No new migration (`parent_id` already exists); `SYNCED_STORES` already includes folders.
- Empty-folder/empty-list messages render inside the main render — never an early `return` that removes navigation.
- Drill-down position is in-app state (keep the existing `browsingFolderId` pattern), not a URL route.
- Ticking a folder and its own descendant: the descendant's tick is ignored (rides along).
- Selection survives filter/sort changes; hidden-but-ticked items still move/trash.
- Trashing a folder = soft-delete with reparenting (no dialog); no recursive delete, no document loss.
- e2e: `ctx.clickText()` is exact-match (use includes-based helpers); list-row helpers see title/meta only; new synced tables must exist in `memoryServer()` (folders already added — do not regress).

## Review Focus

- Orphan folder (live folder whose `parentId` points at a tombstone) must surface at root, not vanish — pinned by Task 1 test.
- Nested ticks must not flatten the tree — pinned by Task 1 test.
- Picker must lock the moved folders AND all their descendants (loop prevention) — pinned by Task 7 e2e.
- Empty root with folders must stay browsable (no compose redirect, no bare early-return) — pinned by Task 5 e2e.
- Bulk bar must show the live ticked count (hidden-but-ticked items still apply) — pinned by Task 6 e2e.

---

### Task 1: Tree helpers (pure)

**Files:**
- Modify: `src/features/reader/folderTree.ts`
- Test: `src/features/reader/folderTree.test.ts` (new)

**Interfaces:**
- Consumes: `Folder` from `../../types`; existing `liveFolders`, `childrenOf`, `ancestorsOf`.
- Produces:
  - `descendantsOf(folders: Folder[], folderId: string): Folder[]`
  - `visibleRoots(folders: Folder[]): Folder[]`
  - `pruneNestedTicks(folders: Folder[], tickedFolderIds: readonly string[]): string[]`

**Semantics (exact):** `descendantsOf` = all live transitive children (BFS over `childrenOf`, runaway guard like `ancestorsOf`). `visibleRoots` = `childrenOf(live, null)` plus live folders whose `parentId` is set but whose parent is not live (orphan fallback; order: true roots in `createdAt` order as today, orphans after). `pruneNestedTicks` = input order, dropping any id that is a descendant of another ticked id (via `descendantsOf`); unknown ids pass through untouched.

- [ ] **Step 1: Write the failing test** in `src/features/reader/folderTree.test.ts`: a root P with child C and grandchild G plus an orphan O (parentId → tombstoned id) — assert `descendantsOf(all, P.id)` contains C and G, `visibleRoots(all)` contains P and O but not C/G, and `pruneNestedTicks(all, [P.id, C.id, G.id])` equals `[P.id]`.
- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/reader/folderTree.test.ts`
Expected: FAIL (file/functions not defined)

- [ ] **Step 3: Implement the three functions** in `src/features/reader/folderTree.ts` per Semantics above.
- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/reader/folderTree.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/reader/folderTree.ts src/features/reader/folderTree.test.ts
git commit -m "feat: folder tree helpers for nesting (descendants, visible roots, nested-tick prune)"
```

---

### Task 2: `moveFolder` store action

**Files:**
- Modify: `src/app/stores/folders.ts`
- Test: `src/app/stores/folders.test.ts` (append)

**Interfaces:**
- Consumes: `descendantsOf` from `../../features/reader/folderTree`; existing `idbPut`, `now()` pattern.
- Produces: `moveFolder: (id: string, parentId: string | null) => Promise<boolean>` on `FoldersState` (returned `true` = reparented, `false` = refused/no-op).

**Semantics (exact):** Refuse (`false`, no write) when the folder is missing, `parentId === id`, target is a descendant of `id` (`descendantsOf` on live folders), or target id is missing/tombstoned (non-null target must be live). No-op `false` when `parentId` unchanged. Else write `{ ...folder, parentId, updatedAt: now() }` to IndexedDB + set state. Never touches any document.

- [ ] **Step 1: Write the failing tests** in `src/app/stores/folders.test.ts`: create P with child C; `moveFolder(C.id, null)` → `true`, parentId null; `moveFolder(P.id, C.id)` → `false` (cycle); `moveFolder(P.id, P.id)` → `false` (self); `moveFolder(C.id, <tombstoned id>)` → `false`; moving a folder leaves member documents' `updatedAt` byte-identical.
- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/stores/folders.test.ts`
Expected: FAIL (`moveFolder` not defined)

- [ ] **Step 3: Implement `moveFolder`** in `src/app/stores/folders.ts` per Semantics above.
- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/stores/folders.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/folders.ts src/app/stores/folders.test.ts
git commit -m "feat: folders store can reparent a folder with cycle guard"
```

---

### Task 3: i18n keys

**Files:**
- Modify: `src/i18n/locales/en.ts` (in `list:`, next to existing folder keys ~line 51-61), `src/i18n/locales/ko.ts` (mirror block ~line 50-60)
- Test: `src/i18n/i18n.test.ts` (existing parity test — no new test needed)

**Interfaces:**
- Consumes: nothing. Produces these exact `list.*` keys (en / ko):
  - `selectDocuments`: `Select documents` / `문서 고르기`
  - `moveSelectedToFolder`: `Move selected to a folder` / `고른 항목을 폴더로 옮기기`
  - `moveSelectedToTrash`: `Move selected to trash` / `고른 항목을 휴지통에 버리기`
  - `cancelSelect`: `Cancel` / `취소`
  - `newSubfolder`: `New subfolder` / `새 하위 폴더`
  - `selectedCount`: `{count} selected` / `{count}개 선택함`
  - `backButton`: `Back` / `뒤로`
  - `moveLocked`: `Included in this move` / `이번 이동에 포함됨`

- [ ] **Step 1: Add the eight keys** to `en.ts` `list` block and mirror them in `ko.ts`.
- [ ] **Step 2: Run the parity test**

Run: `npx vitest run src/i18n/i18n.test.ts`
Expected: PASS (same key sets in both dicts)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (new keys are valid `TranslationKey`s)

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/en.ts src/i18n/locales/ko.ts
git commit -m "feat: i18n keys for folder navigation and select mode"
```

---

### Task 4: Extract `FolderMenu` popover

**Files:**
- Create: `src/features/reader/FolderMenu.tsx`
- Test: none new (covered by Task 8 e2e: rename + delete via row ⋯)

**Interfaces:**
- Consumes: `Folder` type; `useFoldersStore` `rename`/`deleteFolder`; `Popover`; `t('list.folderNamePlaceholder' | 'list.renameFolder' | 'list.deleteFolder')`.
- Produces: `FolderMenu({ folder, anchor, onClose }: { folder: Folder; anchor: HTMLElement; onClose: () => void })` — byte-for-byte behavior of today's `FolderMenuPopover` inside `FolderChips.tsx` (rename input Enter-commit/Esc-close, Rename disabled when blank-or-unchanged, Delete without confirmation).

- [ ] **Step 1: Create `FolderMenu.tsx`** by moving `FolderMenuPopover` out of `FolderChips.tsx` unchanged (rename export to `FolderMenu`); `FolderChips.tsx` imports it so Phase-1 UI still works.
- [ ] **Step 2: Verify no behavior change**

Run: `npm run typecheck && npm run lint`
Expected: PASS, and `git diff` on FolderChips shows only the import + usage change.

- [ ] **Step 3: Commit**

```bash
git add src/features/reader/FolderMenu.tsx src/features/reader/FolderChips.tsx
git commit -m "refactor: extract FolderMenu popover for reuse in folder rows"
```

---

### Task 5: Navigation shell (drill-down, rows, create, empty states)

**Files:**
- Modify: `src/features/reader/DocumentList.tsx`, `src/app/App.tsx` (route guard ~line 144-147)
- Test: e2e (Task 8); unit: none (no component-test harness in repo)

**Interfaces:**
- Consumes: `childrenOf`, `visibleRoots` (Task 1); `useFoldersStore` folders/create; `FolderMenu` (Task 4); existing language/sort/trash pipeline untouched.
- Produces: header variants (root: `All documents` + `Select documents` button; inside: `← Back` + folder name + `Select documents`), in-app `browsingFolderId` state with parent-step-back on vanished folder, folder-rows-then-doc-rows (direct children only), bottom create row (`New folder` at root / `New subfolder` inside, parent = current folder).

**Semantics (exact):**
- Position stays in-app state. Invalid `browsingFolderId` (folder gone) resolves to its nearest live ancestor via `parentId` chain, else null. Back = current folder's `parentId`; hidden at root.
- Folder rows navigate on tap; doc rows link `/read/:id` as today; folder ⋯ opens `FolderMenu` (tapping ⋯ never navigates); ⋯ hidden while selecting (Task 6).
- Create box: Enter/blur commit, Esc cancel, blank rejected; new folder navigates into itself.
- `App.tsx`: compose-redirect requires `documents.length === 0 && trashedCount === 0 && folders.length === 0`. `DocumentList`'s bare `documents.length === 0` early return additionally requires zero live folders; otherwise render the full shell (header + folder rows + create row + in-list empty message).

- [ ] **Step 1: Rewrite `DocumentList.tsx`** per Semantics above (remove `FolderChips` + per-row `MoveToFolder` usage; keep files on disk until Task 8).
- [ ] **Step 2: Adjust the `App.tsx` route guard** per Semantics above.
- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/features/reader/DocumentList.tsx src/app/App.tsx
git commit -m "feat: drill-down folder browser replaces chips row"
```

---

### Task 6: Select mode + bulk trash

**Files:**
- Modify: `src/features/reader/DocumentList.tsx`
- Test: e2e (Task 8)

**Interfaces:**
- Consumes: `pruneNestedTicks` (Task 1); `useDocumentsStore` `trash`; `useFoldersStore` `deleteFolder`; keys `list.selectDocuments|moveSelectedToFolder|moveSelectedToTrash|cancelSelect|selectedCount` (Task 3).
- Produces: select mode per spec §Select mode.

**Semantics (exact):** `Select documents` → disappears; checkboxes on every row; bulk bar (`Move selected to a folder`, `Move selected to trash`, live `selectedCount`, `Cancel`) replaces it; Esc exits. Row tap toggles (`tickedDocIds`/`tickedFolderIds` — two sets); nothing navigates; ⋯ hidden. `Move selected to trash`: every ticked doc → `trash(id)`; pruned ticked folders → `deleteFolder(id)` (soft-delete, reparent). Then exit select mode. No confirmation dialog.

- [ ] **Step 1: Implement select mode + bulk trash** in `DocumentList.tsx` per Semantics above (`Move selected to a folder` button rendered but wired in Task 7 — give it a `disabled`-free placeholder that opens nothing yet is NOT allowed; instead Task 6 must render the button opening the picker shell from Task 7 — so implement Task 7's `FolderPicker` mounting point here and fill it in Task 7).
- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/features/reader/DocumentList.tsx
git commit -m "feat: select mode with bulk trash"
```

---

### Task 7: Tree picker + bulk move

**Files:**
- Create: `src/features/reader/FolderPicker.tsx`
- Modify: `src/features/reader/DocumentList.tsx`
- Test: e2e (Task 8) + existing `moveToFolder` store tests (no `updatedAt` change — already pinned)

**Interfaces:**
- Consumes: `childrenOf`, `descendantsOf`, `visibleRoots` (Task 1); `moveFolder` (Task 2); `moveToFolder` (documents store); keys `list.moveTo|noFolder|moveLocked` + Task 3 keys.
- Produces: `FolderPicker({ anchor, anchorKey, lockedIds, onPick, onClose })` where `lockedIds: readonly string[]`, `onPick: (id: string | null) => void`.

**Semantics (exact):** Tree from Root, top-level = `visibleRoots`, chevron expands each folder's `childrenOf`; current branch expanded by default. `No folder` entry at top → `onPick(null)`. Every id in `lockedIds` plus its `descendantsOf` renders with `aria-disabled="true"` + `moveLocked` title and is not clickable. Bulk move: docs → `moveToFolder([...tickedDocIds], target)`; folders → each pruned id → `moveFolder(id, target)`; then exit select mode. `lockedIds` passed by the list = pruned ticked folder ids (descendants computed inside the picker).

- [ ] **Step 1: Create `FolderPicker.tsx`** per Semantics above.
- [ ] **Step 2: Wire bulk move** in `DocumentList.tsx` (mount picker beside the `Move selected to a folder` button from Task 6).
- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run src/app/stores/folders.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/features/reader/FolderPicker.tsx src/features/reader/DocumentList.tsx
git commit -m "feat: tree move picker with loop lock and bulk move"
```

---

### Task 8: Cleanup + e2e rewrite + full verification

**Files:**
- Delete: `src/features/reader/FolderChips.tsx`, `src/features/reader/MoveToFolder.tsx`
- Modify: `e2e/specs/33-folders.spec.mjs` (rewrite — chips API is gone)
- Test: `npm run verify`, `npm run e2e -- 33` then the green set from handover (`01 07 15 18 26 30 31 32 33`)

**Interfaces:** none new. Old spec helpers (`pickChip`, `clickMove` on `button[aria-label="Move to folder"]`, `button[aria-label="Folder actions"]` on chips) no longer exist — rewrite with includes-based row/header helpers.

**Semantics (exact):** Spec covers: create top-level folder via bottom `New folder` (lands inside, empty message in-render with Back visible); create doc, select-mode move doc into folder; drill in/out (Back one level); nested subfolder create; picker loop-lock (ticked folder + descendant `aria-disabled`); folder ⋯ rename; folder ⋯ delete reparents doc to parent; bulk trash of a ticked folder reparents (nothing lost); no per-row Move button exists; refresh keeps folders (in-app position resets to root — assert folders listed at root after reload); empty root with folders stays browsable (guard with a fresh profile holding folders but zero docs only if harness supports it — otherwise assert the zero-doc-with-folders render path via a folders-only setup).

- [ ] **Step 1: Delete the two dead components**; fix any remaining imports.
- [ ] **Step 2: Rewrite `33-folders.spec.mjs`** per Semantics above.
- [ ] **Step 3: Run the folders e2e**

Run: `npm run e2e -- 33`
Expected: all checks pass.

- [ ] **Step 4: Run full verification**

Run: `npm run verify`
Expected: green (typecheck + oxlint + 635+ unit + build + RLS).

- [ ] **Step 5: Run the neighboring e2e suites** (`01 07 15 18 26 30 31 32`) to catch list regressions.

Run: `npm run e2e -- 01` (repeat per suite per harness syntax)
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: folder navigation with select-mode bulk actions (closes folders Phase 2+3)"
```

---

## Self-Review

1. **Spec coverage:** every spec Goal maps to a task (1→helpers, 2→Task 2/5/8 delete+reparent, 3→Task 5 create-in-place, 4→Task 6, 5→Task 7). User decisions (in-app state, nested-tick ignore, hidden ticks apply, soft-delete trash, no header ⋯, empty-root reachability, orphan fallback, ticked-count display) each have an owning task. No gaps.
2. **Step scan:** each step names one action + checkable result; code bodies appear only where signatures leave a real choice (Semantics blocks), and those quote the spec's exact values.
3. **Type consistency:** `descendantsOf`/`visibleRoots`/`pruneNestedTicks`/`moveFolder`/`FolderMenu`/`FolderPicker` signatures are identical everywhere they are referenced.
4. **Review Focus:** five items listed, each pinned to an owning task's test.
5. **Proportion:** plan states decisions and exact names/values only; bodies live with implementers. Not a transcript.
