# Folder Navigation — Design (2026-10-15)

## Intent and why

Replace the document list's folder **chips row** (Phase 1: flat, root-only filter) with a
**drill-down folder browser** plus **select-mode bulk actions**, covering folders
Phases 2 (nesting) and 3 (multi-select) from the handover.

Why: nesting makes a flat chips row crowded and unusable; the user wants a
file-manager-like flow that works identically with mouse and touch. Drag-and-drop
was explicitly cut — "Select documents" is the only entry point for moving things.

User-described flow that this design implements:

- Top level: top-level folders + unorganized documents. Tap a folder (e.g. Folder A).
- `/Folder A`: items inside Folder A, subfolders (e.g. Subfolder A-1), Back button.
  Tap Subfolder A-1.
- `/Folder A/Subfolder A-1`: only documents and subfolders inside Subfolder A-1.
  Tap a document to open it.

## Goals

1. **Drill-down navigation, one folder per screen.**
   - Root screen: header `All documents`; list = top-level folder rows first, then
     documents with no folder (`folderId == null`, tombstoned-folder docs count as
     unfiled via existing `folderOfDocument` rule).
   - Inside a folder: header `← Back · <folder name>`; list = direct subfolders
     first, then direct documents. **Direct children only** — nothing from deeper
     levels is surfaced.
   - Folder rows navigate on tap; document rows open the reader (`/read/:id`) as today.
   - Back steps up exactly one level; hidden at root (nothing to go back to).
   - Empty-folder message renders **inside the main render** (never an early return
     that removes navigation — the e2e-33 trap).
2. **Per-folder-row ⋯ menu (rename / delete).**
   - Each folder row carries its own ⋯ button opening the existing rename/delete
     popover (moved off the deleted chips). Tapping ⋯ must not navigate.
   - Delete = today's soft-delete: tombstone, direct child folders + member docs
     reparent to the deleted folder's parent. No recursive delete, no document loss.
   - If the folder currently being viewed disappears (deleted from its parent view
     on this device, or via sync from another device), the screen steps back up
     to its parent. If at root with no valid folder, show root. (There is no ⋯
     for the current folder in the header — rename/delete of a folder happens
     from its parent view's row ⋯.)
3. **In-place folder creation.**
   - `+ New folder` at the bottom of the root list creates a top-level folder.
   - Inside a folder, `+ New subfolder` creates a child of the current folder.
   - Inline create: Enter/blur commits, Esc cancels, blank names rejected (existing
     `FolderChips` behavior, relocated). Creating navigates into the new folder.
4. **Select mode for bulk move / trash.**
   - Header carries `Select documents` beside `All documents` (root) or beside the
     folder name (inside). Pressing it:
     - `Select documents` disappears; checkboxes appear beside every folder and
       document title; `Move selected to a folder` + `Move selected to trash` +
       `Cancel` appear where the button was (Esc also exits).
     - Tapping any row toggles its checkbox; nothing navigates while selecting.
       The row ⋯ is hidden in select mode.
     - `Cancel` (or Esc) leaves select mode with no changes.
   - `Move selected to trash`: documents go through the existing reversible `trash()`;
     ticked folders soft-delete per goal 2 (contents reparent up, nothing lost;
     semantics ratified by the user). No confirmation dialog for bulk trash —
     consistent with single-folder delete (nothing is lost, so no brake needed).
   - Ticking both a folder and its own descendant: the descendant's tick is
     ignored — it rides along inside its parent (user decision). The tree is
     never silently flattened.
   - Selection survives language-filter/sort changes mid-selection, and
     hidden-but-ticked items are still moved/trashed (user decision). The bulk
     bar should therefore show the live ticked count so invisible items aren't
     a surprise.
   - No long-press entry, no per-row Move button (the old `MoveToFolder` row button
     is removed).
5. **Tree move picker.**
   - `Move selected to a folder` opens a small popover beside (or over) the button
     showing the **full folder tree from Root down**, expandable **level by level**
     (chevron per folder) starting at root.
   - `No folder` entry at the top frees items (documents → unfiled; folders →
     top level).
   - Folders being moved **and all their descendants** render but are **not
     selectable** (loop prevention; use existing `ancestorsOf()` in `folderTree.ts`).
     Moving a folder carries its whole contents with it.
   - Picker is single-target: one destination applies to the whole selection.

## Non-goals

- Drag-and-drop anywhere (cut by user decision).
- Long-press (~500ms) select entry (cut; `Select documents` button only).
- Per-row Move button (removed).
- Folder reparenting outside select-mode move (no separate "move this folder" UI).
- Manual folder ordering (stays `createdAt`).
- Recursive delete / folder trash-restore UI.
- Breadcrumb jump-to-any-level (Back is strictly one level up).
- New migration (none needed; `parent_id` already exists).

## Anti-goals (failure even if it technically works)

- Trapping the user in an empty folder with no way out.
- A move changing "last opened" (`documents.updated_at`) or list/sort order.
- Creating a folder loop (folder inside itself or its own descendant).
- Losing documents on folder delete/trash.
- Rows navigating while in select mode.
- Picker allowing a tombstoned folder as destination.

## Constraints (load-bearing — do not break)

- `documents.updated_at` **is** "last opened" (list dates + Recently-opened sort).
  `moveToFolder(ids, folderId|null)` must never touch `updatedAt`; folder moves stamp
  only `folder_updated_at` (migration `set_updated_at()` + `greatest()` guards).
- Merge resolves content by `updatedAt`, folder by `folderUpdatedAt`, separately
  (`folderWinnerOf`); `changedFolders()` + `documentsToPush` compare folder fields;
  **folders push before documents** (FK). See `src/lib/sync/sync.ts`.
- `DB_VERSION = 5` folders store already in `SYNCED_STORES`; tombstones stay in
  IndexedDB for merge, `load()` exposes live folders only.
- `childrenOf(folders, parentId)`, `liveFolders`, `ancestorsOf` (with runaway-loop
  guard) already exist in `src/features/reader/folderTree.ts` — reuse them.
- `moveToFolder` already accepts an id array — single and bulk share one path.
- `verify:rls` doesn't cover new tables; no schema change here so nothing new needed.
- e2e harness: `memoryServer()` in `twoDevices.test.ts` must include every synced
  table (folders already added); `ctx.clickText()` is exact-match; list-row helpers
  see title/meta only; paste in e2e = dispatched `ClipboardEvent`.
- Deploy order (when it ships): migration first, then frontend — no migration in
  this change, so normal frontend deploy; user tests on deployed origin, hard-refresh
  twice (service-worker lag).

## Decided details (as the user decided them)

- Chips row (`FolderChips.tsx`) goes away entirely; folders appear only as rows.
- Root header = `All documents` + `Select documents`; folder header =
  `Back + folder name` + `Select documents`.
- In-list order: folder rows first, then document rows.
- Select mode covers folders too: ticking a folder moves/trashes the folder itself
  with all contents. Loop guard blocks moving a parent into itself or its subfolder.
- Trashing a ticked folder = soft-delete (reparent), confirmed by user.
- Rename/Delete placement: per-row ⋯ (builder was asked to recommend; user accepted).
- Picker expands level by level from Root (not a flat list of all folders).
- Picker keeps `No folder`; folder creation is NOT offered inside the picker.
- Language filter, sort controls, trash-count link stay as-is and keep applying
  within the current folder view (folder → language → sort pipeline unchanged).
- Drill-down position is **in-app state** (like today's `browsingFolderId`), not a
  URL route (user decision). Refresh lands back at root; browser/system back exits
  the list rather than stepping up a folder.
- Empty root with folders: the `+ New folder` row, folder rows, and
  `Select documents` stay reachable when there are 0 live documents — the bare
  "no documents" early return and the redirect to compose must not fire while
  folders exist (my call; otherwise folders become unreachable dead-ends).
- Orphan folders (live folder whose `parentId` points at a tombstoned folder after
  a sync race) surface as root-level rows — the `folderOfDocument` analog for
  folders (my call; otherwise they are invisible but synced).

## Left to the builder

- Exact header/row/picker styling, chevron vs ▸/▾ glyphs, popover anchoring
  (beside vs over the button), and whether `+ New folder` is a list row or a header
  action — list-bottom row is the suggested default.
- Folder-row secondary text (e.g. "N docs" counts): suggested but optional.
- New-folder inline input reuse vs rewrite of the `FolderChips` create box.
- Whether the picker auto-expands the current folder's branch on open (suggested: yes).
- Exact i18n key names for new strings (`All documents`, `Select documents`,
  `Move selected to a folder`, `Move selected to trash`, `New subfolder`,
  `emptyFolder`, picker labels); follow existing `list.*` keys.
- e2e coverage: extend the folder suites (notably the empty-folder navigation
  regression, select-mode move/trash, picker loop-lock) following existing helpers.
- `FolderChips.tsx` removal vs repurposing of `FolderMenuPopover` (suggested: keep
  the popover, delete the chips) and removal of per-row `MoveToFolder` button
  (suggested: reuse its destination-pick logic inside the bulk picker).

## Current code pointers

- `src/features/reader/DocumentList.tsx` — chips row, folder filter, row Move button,
  empty-state placement (keep in main render).
- `src/features/reader/FolderChips.tsx` — inline create + ⋯ menu popover to relocate.
- `src/features/reader/MoveToFolder.tsx` — row button (remove) + destination list
  (evolve into tree picker; currently root folders only).
- `src/features/reader/folderTree.ts` — `liveFolders`, `childrenOf`, `ancestorsOf`.
- `src/app/stores/folders.ts` — CRUD; `create(name, parentId?)` already takes a parent.
- `src/app/stores/documents.ts` — `moveToFolder(ids, folderId|null)`, `trash()`.
