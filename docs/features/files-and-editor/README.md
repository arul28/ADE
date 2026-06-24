# Files and Editor

An IDE-style file explorer and Monaco editor surface integrated into
ADE. Shared workspace selection, atomic writes, file watching with
reference-counted chokidar subscriptions, Monaco model reuse, streaming
large-file previews, and specialized view modes (diff, conflict, and the
flagged v2 workbench shell).

This feature sits at the boundary between the filesystem and everything
else: context packs use it to discover docs, the chat surface links
back to it for "open this file", and lanes surface files by worktree.

## Where this runs

File listing, atomic writes, the cross-file search index, and the
chokidar-backed file watcher all run inside the **active runtime**
for the window's project binding — the local ADE daemon for
local-bound windows and the SSH-attached remote runtime for
remote-bound windows. The Monaco editor in the renderer is purely
client-side; every byte it reads or writes flows through
`window.ade.files.*` in `apps/desktop/src/preload/preload.ts`, which
routes file actions through the remote runtime first, then through the
strict local-runtime route for local-bound windows. It only falls
through to the legacy in-process IPC handlers when no runtime route is
available, for example before a project binding exists or in tests /
diagnostic harnesses that run without a runtime pool. Watcher events
arrive over the runtime's event stream
(category `"runtime"`) and are dispatched into renderer subscribers
through the same preload pump that powers lane / pty / process
events. Remote-bound desktop windows therefore browse and edit files
on the remote machine; the file tree, search results, and watcher
events all reflect the remote worktree.

## Source file map

Runtime services back the canonical implementation. The desktop
`apps/desktop/src/main/services/files/` files below stay as fallback
targets for the legacy IPC path.

- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts`
  — local runtime project registration, file action dispatch, and event
  polling; file actions use a bounded per-call timeout before the
  desktop IPC handler timeout can fire.
- `apps/desktop/src/main/services/remoteRuntime/runtimeRpcClient.ts` —
  JSON-RPC client used by both local and remote runtime transports,
  including per-call timeout overrides for file actions and event
  polling.
- `apps/desktop/src/main/services/files/fileService.ts` — directory
  listing, paginated child loading, Git status decorations, range reads,
  blame, atomic writes, quick open, cross-file search, path safety.
- `apps/desktop/src/main/services/files/externalFilesWorkspaceRegistry.ts`
  — local-only registry for files or folders opened from outside the active
  project through Finder / OS open-file events or renderer drag-and-drop.
- `apps/desktop/src/main/services/files/fileWatcherService.ts` —
  chokidar wrapper with per-sender ref counting, debounced events,
  idle watcher close, plus `stopAllForWorkspace(workspaceId)` and
  `countActiveForWorkspace(workspaceId)` helpers used by the lane
  delete pipeline to tear down watchers as a discrete teardown step
  before the worktree is removed. ~290 lines.
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
  `FileTreeNode`, `FilesListTreeChildrenResult`, `FileContent`,
  `FilesReadFileRangeResult`, `FilesGitStatusEvent`,
  `FilesGitBlameResult`, `FilesQuickOpenItem`, `FilesSearchTextMatch`,
  `FilesOpenExternalPathResult`, and the IPC arg shapes.
- `apps/desktop/src/shared/types/git.ts` (and related shared types) —
  `FileDiff`, `FilePatch`, and other shapes returned by `diffService`
  for the diff viewer.
- `apps/desktop/src/shared/ipc.ts` — channels `ade.files.*` and
  `ade.diff.getChanges` / `ade.diff.getFile` / `ade.diff.getFilePatch`
  (lane-scoped diff lists and per-file payloads).
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — handler
  registrations (`filesListWorkspaces`, `filesListTree`,
  `filesListTreeChildren`, `filesRefreshGitDecorations`,
  `filesReadFile`, `filesReadFileRange`, `filesGitBlame`,
  `filesWriteTextAtomic`, `filesWriteText`, `filesCreateFile`,
  `filesCreateDirectory`, `filesRename`, `filesDelete`, `filesQuickOpen`,
  `filesSearchText`, `filesWatchChanges`, `filesStopWatching`,
  `filesOpenExternalPath`, plus
  `diffGetChanges`, `diffGetFile`, `diffGetFilePatch`).

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.files` and
  `window.ade.diff` (`getChanges`, `getFile`, `getFilePatch`; changes
  list is short-cached per lane).

Renderer:

- `apps/desktop/src/renderer/components/files/FilesTab.tsx` — shared
  route/sidebar entry point. It always renders the workbench.
- `apps/desktop/src/renderer/components/files/v2/FilesWorkbench.tsx` —
  Files tab shell: workspace chrome, activity bar, explorer, editor
  groups, Monaco edit host, diff/conflict surfaces, quick open, text
  search, trust warnings, read-only workspace gating, persisted recent-file
  pruning, dirty-buffer publishing for agent reads, optional Git-decoration
  fallback, and file-type viewers. Accepts optional
  `preferredLaneId` and `embedded` props so the same component can mount inside
  the Work right-edge sidebar.
- `apps/desktop/src/renderer/components/files/FilesExplorer.tsx` —
  virtualized file tree (`@tanstack/react-virtual`), inline rename/create,
  explorer search, mutation-disabled create buttons for read-only workspaces,
  and context-menu wiring; git status coloring uses helpers from
  `filePresentation.tsx`.
- `apps/desktop/src/renderer/components/files/filePresentation.tsx` —
  file-type icons and `changeStatus*` helpers shared with the explorer.
- `apps/desktop/src/renderer/components/files/monacoModelRegistry.ts`
  and `treeHelpers.ts` — reusable Monaco model lifetime tracking and
  tree/decorations helpers used by the workbench.
- `apps/desktop/src/renderer/components/files/v2/` — VS Code-style
  workbench shell: editor groups, preview/pinned tabs, split/move
  support, warm empty state, search/create overlays, and
  viewers for code, markdown, image, audio/video playback, CSV/TSV,
  PDF, Office-document fallback, large text, binary, and diffs.
- `apps/desktop/src/renderer/components/shared/AdeDiffViewer.tsx` —
  shared read-only diff chrome (`@pierre/diffs` `MultiFileDiff` /
  `PatchDiff` with split/unified, wrap, line numbers); editable working-tree
  diffs delegate to `MonacoDiffView`. Also used from `LaneDiffPane`,
  `ChatFileChangesPanel`, and `PrDetailPane`.
- `apps/desktop/src/renderer/components/files/v2/*.test.ts` and
  `apps/desktop/src/renderer/components/files/monacoModelRegistry.test.ts`
  — renderer workbench state and model-lifetime tests.
- `apps/ios/ADE/Views/Files/FilesRootScreen.swift` — mobile Files
  root with workspace picker, live file tree/read, a magnifying-glass
  button that opens the search page, and live file-action gating from
  sync policy.
- `apps/ios/ADE/Views/Files/FilesSearchScreen.swift` — full-screen
  unified search page (desktop `SearchOverlay` parity): one query
  searches file names (`quickOpen`) and contents (`searchText`)
  together, name matches first under "Files" and content hits grouped
  per file with collapsible line previews. Replaced the inline
  `FilesQueryCard` quick-open / text-search cards and their first-40
  result caps.
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
| `external` | Explicit local open | Ephemeral local-only roots created from OS open-file events or drag/drop. |

`laneService.getFilesWorkspaces()` produces the list;
`resolveWorkspaceById(workspaceId)` does the reverse lookup and is used
on every lane-backed file-scoped IPC call. `external` workspaces are
registered by `externalFilesWorkspaceRegistry.ts` and have stable
`external-local:<hash>` ids for the lifetime of the local runtime. If the
opened absolute path is already inside a known project/worktree workspace,
`files.openExternalPath` returns that existing workspace instead of creating
an external root.

The renderer always shows the active workspace name prominently so the
user never edits primary when they meant to edit a lane worktree.
External tabs also show the full host path in the status bar and path-copy
menus so it is clear when a file comes from outside the project.

## Editor modes

Three modes, each driven by a tab's internal state (no service-side
mode concept):

- **Edit** — Monaco with read/write semantics, syntax highlighting,
  Cmd+S saves atomically. Markdown / `.md` / `.mdx` tabs add a per-tab
  preview toggle (Eye icon in the tab toolbar) that swaps the Monaco
  host for a lazily-imported `PlanMarkdown` renderer. The preference is
  per tab and persisted in the page's per-session state alongside the
  open tab list and active path.
- **Diff** — `AdeDiffViewer` backed by `diffService`. Read-only views
  use `@pierre/diffs`; editable working-tree views use `MonacoDiffView`.
  Sources: staged vs working tree, HEAD vs working tree, or
  commit-to-commit.
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
not silently clobber work. Dirty Monaco buffers are also published into
the renderer dirty-buffer map for the active workspace so agent file
reads can see unsaved editor-only text.

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

File tree listings include a `changeStatus`. The status map is cached
per workspace root for 5 seconds (`GIT_STATUS_CACHE_TTL_MS`) and
populated by a single `git status --porcelain=v2` call. The first tree
paint should not block on a fresh status scan: renderers can call
`files.refreshGitDecorations({ forceFresh: true })` after the structure
loads and apply the returned flat file statuses plus ancestor directory
rollups without refetching the tree. Remote runtimes that do not expose the
optional `file.refreshGitDecorations` action are treated as decoration-missing,
not tree-load failures; the remote connection pool returns an empty decoration
set with an optional-action hint.

## Large-file and range reads

`files.readFile` returns inline text up to 1 MB, inline image previews
up to 1 MB, and small unsupported binary payloads up to 256 KB. When a
text-like file is larger than the editor limit, the service returns a
UTF-8-safe first chunk with `isPartial`, `rangeStart`, `rangeEnd`, and
`nextOffset`. Viewers stream the rest with `files.readFileRange`.

`readFileRange` uses byte offsets, clamps each request, and trims
non-final UTF-8 responses to a complete code-point boundary so chunks
can be concatenated without corrupting text. Binary/image/PDF range
responses, plus audio/video and Office-document ranges, are base64-encoded
per range; consumers must treat each range as independently decodable bytes
and advance only by `nextOffset`.

## Trust boundary

The preload bridge (`apps/desktop/src/preload/preload.ts`) exposes
`window.ade.files` and `window.ade.diff`; nothing from `node:fs` or
`node:path` leaks into the renderer. All path resolution for file
writes and workspace roots happens server-side — inside the active
ADE runtime for runtime-routed calls and inside the desktop main
process for the fallback IPC path — through `resolvePathWithinRoot`,
which refuses `..` escapes, null bytes, and `.git` internals. Remote
runtimes apply the same path-safety primitives on the remote host, so
the trust boundary still holds when the renderer is browsing files on
a remote machine.

`files.openExternalPath` is intentionally local-only. It registers an
absolute path that the user explicitly opened from Finder / the OS or dropped
into the desktop renderer. A remote-bound desktop window continues to route
normal workspace reads/writes to the remote runtime, but `external-local:*`
workspace ids are handled by the local desktop process so arbitrary local
files can open beside remote project tabs without pretending they belong to
the remote filesystem.

For deeper detail on the watcher + trust boundary, see
[file-watcher-and-trust.md](./file-watcher-and-trust.md).

## Gotchas

- The file tree is listed with `includeIgnored: true` in the renderer,
  so dotfiles show up by default, but volatile ADE runtime paths such
  as `.ade/worktrees/`, `.ade/cache/`, transcripts, secrets, and the
  SQLite DB are still filtered out. Pair callers that pass
  `includeIgnored: false` (search indexing, watcher default mode) with
  the corresponding start/stop pair — the watcher refcounts are
  per-mode.
- `fileService.readFile` sends inline text previews up to 1 MB, inline
  image previews up to 1 MB, and small unsupported binary payloads up
  to 256 KB. Oversized text returns a partial first chunk and streams
  through `readFileRange`; oversized images and unsupported binaries
  still return `contentOmitted`.
- `listTree` and `listTreeChildren` must share filtering and ordering:
  skip `.git`, skip volatile `.ade` runtime paths, honor
  `includeIgnored`, sort directories before files, and paginate via
  `nextOffset` rather than silently dropping entries.
- Monaco models are reused per path and disposed on tab close,
  rename/delete cleanup, workspace switch, or unmount. Do not dispose
  them on ordinary tab switches, theme changes, read-only toggles, or
  v2 group moves.
- `writeTextAtomic` creates a temp file in the target's directory. If
  the directory has no write permission, the operation throws, which
  surfaces as an IPC rejection at the editor tab.
- Runtime-bound file calls are strict: a timeout or connection failure
  from a bound local/remote runtime surfaces to the tab instead of
  retrying against the desktop main process, which could point at a
  different host or workspace.
- `FilesWorkspace.isReadOnlyByDefault` is enforced in the renderer as well as
  the service layer: Monaco opens read-only, create / rename / delete controls
  are disabled, and mutation attempts surface `This workspace is read-only.`
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
