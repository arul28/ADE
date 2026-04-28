# Files and Editor

An IDE-style file explorer and Monaco editor surface integrated into
ADE. Shared workspace selection, atomic writes, file watching with
reference-counted chokidar subscriptions, and two specialized view
modes (diff and conflict).

This feature sits at the boundary between the filesystem and everything
else: context packs use it to discover docs, the chat surface links
back to it for "open this file", and lanes surface files by worktree.

## Source file map

Main process:

- `apps/desktop/src/main/services/files/fileService.ts` — directory
  listing, atomic writes, quick open, cross-file search, path safety.
  ~620 lines.
- `apps/desktop/src/main/services/files/fileWatcherService.ts` —
  chokidar wrapper with per-sender ref counting, debounced events,
  idle watcher close. ~270 lines.
- `apps/desktop/src/main/services/files/fileSearchIndexService.ts` —
  in-memory file-name index keyed per workspace and per
  `includeIgnored` mode, incrementally updated from watcher events.
  ~335 lines.
- `apps/desktop/src/main/services/files/fileService.test.ts` and
  `fileWatcherService.test.ts` — unit coverage.
- `apps/desktop/src/main/services/diffs/` — diff computation for diff
  mode (staged vs working tree, commit-to-commit).
- `apps/desktop/src/main/services/conflicts/conflictService.ts` —
  used by conflict mode for 3-way merge data.

Shared types and IPC:

- `apps/desktop/src/shared/types/files.ts` — `FilesWorkspace`,
  `FileTreeNode`, `FileContent`, `FilesQuickOpenItem`,
  `FilesSearchTextMatch`, the IPC arg shapes.
- `apps/desktop/src/shared/ipc.ts` — channels `ade.files.*`.
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — handler
  registrations (`filesListWorkspaces`, `filesListTree`, `filesReadFile`,
  `filesWriteTextAtomic`, `filesWriteText`, `filesCreateFile`,
  `filesCreateDirectory`, `filesRename`, `filesDelete`, `filesQuickOpen`,
  `filesSearchText`, `filesWatchChanges`, `filesStopWatching`).

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.files` surface.

Renderer:

- `apps/desktop/src/renderer/components/files/FilesPage.tsx` — entire
  Files tab in a single ~2,570-line component. File explorer, Monaco
  editor host, tab bar, diff mode, conflict mode, quick open, text
  search, workspace switcher, trust warnings.
- `apps/desktop/src/renderer/components/files/FilesPage.test.tsx` —
  renderer tests.
- `apps/desktop/src/renderer/components/app/FloatingFilesWorkspace.tsx`
  — an alternative lightweight floating view used from the Lanes tab
  and side panels.
- `apps/ios/ADE/Views/Files/FilesRootScreen.swift` — mobile Files
  root with workspace picker, quick-open and text-search cards, capped
  visible result lists (first 40) with refine-search copy when more
  matches exist, and live file-action gating from sync policy.
- `apps/ios/ADE/Views/Files/FilesDetailScreen.swift` and
  `FilesRootComponents.swift` — mobile file preview/detail chrome and
  proof-artifact/file-result rows.

Lane integration:

- `apps/desktop/src/main/services/lanes/laneService.ts` —
  `getFilesWorkspaces`, `resolveWorkspaceById`. Provides the list of
  available workspaces (primary + lane worktrees + attached) to
  `fileService`.

## Detail docs

- [file-watcher-and-trust.md](./file-watcher-and-trust.md) — the
  watcher service, path safety invariants, the preload trust boundary,
  and how external-change sync reaches open tabs.
- [editor-surfaces.md](./editor-surfaces.md) — Monaco host, tab bar,
  diff and conflict views, quick open, cross-file search, keyboard
  shortcuts, context menu.

## Workspace model

A **workspace** is a directory the Files tab can browse. Three kinds
exist:

| Kind | Source | Notes |
|---|---|---|
| `primary` | Repository root | Always present. |
| `worktree` | `.ade/worktrees/<lane>` | One per active lane. `laneId` set. |
| `attached` | User-provided path | External worktrees the user linked in. |

`laneService.getFilesWorkspaces()` produces the list;
`resolveWorkspaceById(workspaceId)` does the reverse lookup and is used
on every file-scoped IPC call.

The renderer always shows the active workspace name prominently so the
user never edits primary when they meant to edit a lane worktree.

## Editor modes

Three modes, each driven by a tab's internal state (no service-side
mode concept):

- **Edit** — Monaco with read/write semantics, syntax highlighting,
  Cmd+S saves atomically.
- **Diff** — side-by-side Monaco diff viewer. Read-only by default,
  optionally editable on the right pane. Sources: staged vs working
  tree, HEAD vs working tree, or commit-to-commit. Driven by
  `diffService`.
- **Conflict** — 3-way merge. Base / Ours / Theirs / Result panes.
  Interactive "Accept Ours", "Accept Theirs", "Accept Both". Resolves
  via `conflictService`.

## Atomic saves

`fileService.writeTextAtomic` uses `secureWriteTextAtomicWithinRoot`:

1. Write content to a temp file in the same directory as the target.
2. `fs.rename` the temp file onto the target.

This avoids partial-write races that break dev servers watching the
file. `writeText` (non-atomic) is also available for callers that
prefer a direct write (used internally for quick fixes where the
atomic guarantee is not needed).

Both writers go through `resolvePathWithinRoot` so they refuse to write
outside the workspace root and refuse any path that traverses `.git`.

## File watching

`fileWatcherService` wraps a single `chokidar` instance per
`workspaceId + senderId` key. It supports two ignore profiles:

- **default** — ignores `.git/`, `node_modules/`, `.ade/`
- **include ignored** — ignores only `.git/`

Both profiles share the same chokidar instance when possible. The
watcher tracks `defaultRefCount` and `includeIgnoredRefCount`; adding a
subscription in `include ignored` mode will tear down and restart the
watcher if the mode changed. When all ref counts hit zero, an idle
timer (`IDLE_WATCHER_CLOSE_MS = 15_000`) schedules a soft close.

Events are debounced per file key for 140 ms, so a build tool writing
hundreds of files gets coalesced. Volatile `.ade/` paths (transcripts,
the SQLite DB, caches, ADE CLI config files) are filtered out even when
`includeIgnored` is true — see
[file-watcher-and-trust.md](./file-watcher-and-trust.md) for the full
list.

The renderer listens on `ade.files.change` for `created`, `modified`,
`deleted`, `renamed` events. Open tabs that are clean (no unsaved
edits) reload automatically; dirty tabs do not, so external changes do
not silently clobber work.

## Quick open and cross-file search

`FileSearchIndexService` maintains a flat list of file paths per
`workspaceId::mode` key (where `mode` is `default` or `all`). The
index is built lazily on the first quick-open call and kept in sync
with the watcher:

- `add`, `unlink`, `rename` events incrementally update the list
- `addDir` / `unlinkDir` events invalidate the subtree
- `fileService.quickOpen({ workspaceId, query, limit, includeIgnored })`
  runs a scoring pass over the matching index
- `fileService.searchText({ workspaceId, query, limit, includeIgnored })`
  streams text matches using `ripgrep` fallback if available, otherwise
  a node-side line scanner

Quick open results are `{ path, score }`. Text-search matches are
`{ path, line, column, preview }`.

## Git status overlay

File tree listings include a `changeStatus`: `'M' | 'A' | 'D' | null`.
The status map is cached per workspace root for 5 seconds
(`GIT_STATUS_CACHE_TTL_MS`) and populated by a single `git status
--porcelain=v2` call. `inferDirectoryStatus` walks the map to decide
whether a directory should show the "has changes" dot.

## Trust boundary

The preload bridge (`apps/desktop/src/preload/preload.ts`) exposes
only the `window.ade.files` surface; nothing from `node:fs` or
`node:path` leaks into the renderer. All path resolution happens in
the main process through `resolvePathWithinRoot`, which refuses
`..` escapes, null bytes, and `.git` internals.

For deeper detail on the watcher + trust boundary, see
[file-watcher-and-trust.md](./file-watcher-and-trust.md).

## Gotchas

- The file tree is always listed with `includeIgnored: true` in the
  renderer, so dotfiles and `node_modules` show up by default. Pair
  callers that pass `includeIgnored: false` (search indexing,
  watcher default mode) with the corresponding start/stop pair — the
  watcher refcounts are per-mode.
- `fileService.readFile` has a 5 MB read cap
  (`MAX_EDITOR_READ_BYTES`). Files over the cap return a truncated
  `FileContent` with the binary flag set; Monaco will render a warning
  instead of the content.
- `writeTextAtomic` creates a temp file in the target's directory. If
  the directory has no write permission, the operation throws, which
  surfaces as an IPC rejection at the editor tab.
- File watcher subscriptions are per sender (BrowserWindow /
  webContents). Closing a window calls `stopAllForSender` to tear
  down every subscription for that window.
- Lane worktrees are resolved through `laneService`, not directly from
  `.ade/worktrees/`. A lane deleted out-of-band will make its
  workspace disappear from the list on next refresh.

## Cross-links

- Lane worktrees feed the workspace list: [../lanes/](../lanes/)
- Processes and tests can monitor the workspace for changes via the
  watcher — see [../terminals-and-sessions/](../terminals-and-sessions/)
  for the transcript and log story.
