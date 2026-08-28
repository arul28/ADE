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

File listing, atomic writes, the file-name index and content search, and the
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

A window is not limited to the machine it is bound to. Every
`window.ade.files.*` method takes an optional trailing **machine pin**
(`OpenProjectBinding | null`) that addresses one machine explicitly —
see [Which machine answers a file call](#which-machine-answers-a-file-call).

## Source file map

Runtime services back the canonical implementation. The desktop
`apps/desktop/src/main/services/files/` files below stay as fallback
targets for the legacy IPC path.

- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts`
  — local runtime project registration, file action dispatch, and event
  polling; file actions use a bounded per-call timeout before the
  desktop IPC handler timeout can fire.
- `apps/desktop/src/main/services/ipc/runtimeBridge.ts`,
  `apps/desktop/src/main/services/remoteRuntime/remoteConnectionPool.ts`,
  `apps/desktop/src/main/services/remoteRuntime/remoteConnectionService.ts`,
  and `apps/ade-cli/src/multiProjectRpcServer.ts` — bridge the runtime
  event stream to bound desktop windows. A `replay: false` subscription
  returns the runtime's current cursor, so a remote Files tab can begin
  watching live changes without replaying stale runtime events.
- `apps/desktop/src/main/services/remoteRuntime/runtimeRpcClient.ts` —
  JSON-RPC client used by both local and remote runtime transports,
  including per-call timeout overrides for file actions and event
  polling.
- `apps/desktop/src/main/services/files/fileService.ts` — directory
  listing, paginated child loading, Git status decorations, range reads,
  blame, atomic writes, quick open, content search, path safety. Its
  decoration response is capped (see [Git status overlay](#git-status-overlay)),
  and its read path collapses what used to be up to three opens into one: above
  the 1 MiB text cap it reads a single 256 KB prefix, in the 256 KB–1 MiB band
  it sniffs an 8 KB prefix first so a 900 KB video is not read whole and thrown
  away, and at or below 256 KB it reads the file once and sniffs its own head.
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
  the file-**name** index (keyed per workspace and per `includeIgnored`
  mode, incrementally updated from watcher events) plus the two-tier
  content search that backs `searchText`. The index holds no file
  contents; `git grep` is the first tier and a streaming JS scan the
  second. See [Quick open and content search](#quick-open-and-content-search).
- `apps/desktop/src/main/services/files/fileService.test.ts` and
  `fileWatcherService.test.ts` — unit coverage.
- `apps/desktop/src/main/services/diffs/` — diff computation for diff
  mode (staged vs working tree, commit-to-commit).
- `apps/desktop/src/main/services/conflicts/conflictService.ts` —
  used by conflict mode for 3-way merge data.
- `apps/desktop/src/main/services/editors/editorDetection.ts`,
  `openPathInEditor.ts`, `editorProcessEnv.ts` — detect installed
  editors from `EDITOR_TARGETS` and open a local workspace/file in one,
  or mint an SSH remote editor URL. See
  [Opening in an external editor](#opening-in-an-external-editor).

Shared types and IPC:

- `apps/desktop/src/shared/types/files.ts` — `FilesWorkspace`,
  `FileTreeNode`, `FilesListTreeChildrenResult`, `FileContent`,
  `FilesReadFileRangeResult`, `FilesGitStatusEvent`,
  `FilesGitBlameResult`, `FilesQuickOpenItem`, `FilesSearchTextMatch`,
  `FilesOpenExternalPathResult`, and the IPC arg shapes.
- `apps/desktop/src/shared/editorTargets.ts` — `EDITOR_TARGETS`,
  `EditorTarget`, `OpenPathTarget`, `OpenInTarget`, remote SSH URL
  builders, and `resolveOpenInTarget` / `canOfferOpenIn`. Consumed by
  main-process editor launch and by lane/session **Open in** menus.
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
  Also `appGetInstalledEditors` / `appOpenPathInEditor`
  (`ade.app.getInstalledEditors`, `ade.app.openPathInEditor`) for
  detected-editor launch.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.files` and
  `window.ade.diff` (`getChanges`, `getFile`, `getFilePatch`; changes
  list is short-cached per lane). Every `files` method except
  `openExternalPath` takes an optional trailing machine pin, routed by
  `callPinnedFileActionOr`.

Renderer:

- `apps/desktop/src/renderer/components/files/FilesTab.tsx` — shared
  route/sidebar entry point. It always renders the workbench and forwards
  router-state chat/review file targets as workspace-relative paths, preserving
  the lane id and source position for local and remote-bound projects. Router
  state is validated rather than trusted: `openPathType` selects a tree reveal
  instead of an editor open, `searchQuery` opens the search panel instead of a
  file, and `filesPin` is accepted only when it really is an
  `OpenProjectBinding` (a `local` binding needs `displayName`; a `remote` one
  needs `targetId` / `projectId` / `runtimeName`), so a malformed history entry
  cannot aim file calls at a machine that does not exist.
- `apps/desktop/src/renderer/components/files/v2/FilesWorkbench.tsx` —
  Files tab shell: workspace chrome, activity bar, explorer, editor
  groups, Monaco edit host, diff/conflict surfaces, quick open, text
  search, trust warnings, persisted recent-file
  pruning, project-level open-tab state across lane/workspace switches,
  dirty-buffer publishing for agent reads, optional Git-decoration
  fallback, and file-type viewers. Accepts optional
  `preferredLaneId` and `embedded` props so the same component can mount inside
  the Work right-edge sidebar. It also owns the **machine pin**: the amber
  machine chip, the "Back to this computer" control, the pinned-machine
  liveness read, and the release of caches written under a pinned key.
- `apps/desktop/src/renderer/components/files/v2/pinnedFilesApi.ts` —
  `createPinnedFilesApi(pin)` returns the whole Files API with one machine
  already bound to it, cached per binding key so its identity changes exactly
  when the machine does. The workbench hands that object to `useFilesTree`,
  `EditorGroups`, `useFileContent`, `streamFileBytes`, and every viewer;
  nothing under the workbench calls `window.ade.files` directly.
- `apps/desktop/src/renderer/components/files/v2/useFilesTree.ts` — the
  explorer tree as a hook: listing, paging, expansion, per-path serialized
  tree ops, and git decorations, driven by (workspace, machine) alone. The
  file watcher deliberately stayed in `FilesWorkbench` because it refreshes
  the tree *and* reloads open editor tabs.
- `apps/desktop/src/renderer/components/files/v2/FilesSearchPanel.tsx` — the
  single Files search surface, rendered in three places (explorer sidebar,
  centred modal, Work tools pane). Also owns the "Include ignored files"
  preference (`getFilesSearchIncludeIgnored` / `setFilesSearchIncludeIgnored`)
  and the shared `Backdrop` / `SEARCH_PANEL_SURFACE` chrome that
  `overlays.tsx` re-uses.
- `apps/desktop/src/renderer/components/files/v2/filesOpenRequests.ts` —
  one-shot module channel that carries "open this path in the Work tools-pane
  Files panel" from a chat click to the embedded workbench. Holds one pending
  request across the gap between the click and the panel mounting; the
  consumer clears the hold so a later mount cannot re-open it.
- `apps/desktop/src/renderer/components/ui/OpenInSubmenu.tsx` — shared
  **Open in** submenu used by lane and session context menus. Probes
  `window.ade.app.getInstalledEditors`, filters to
  `supportsRemote` when an SSH `remote` is set, and calls
  `window.ade.app.openPathInEditor`. Projectless chats never mount
  this menu.
- `apps/desktop/src/renderer/components/files/FilesExplorer.tsx` —
  virtualized file tree (`@tanstack/react-virtual`), inline rename/create,
  create/rename/delete controls, and context-menu wiring; git status coloring
  uses helpers from `filePresentation.tsx`. It renders the search field and a
  `searchResults` slot; with a non-empty query the results replace the tree
  entirely, so the old client-side filter over whatever slice of the tree
  happened to be loaded is skipped.
- `apps/desktop/src/renderer/components/files/filePresentation.tsx` —
  file-type icons and `changeStatus*` helpers shared with the explorer.
- `apps/desktop/src/renderer/components/files/monacoModelRegistry.ts`
  and `treeHelpers.ts` — reusable Monaco model lifetime tracking and
  tree/decorations helpers used by the workbench. `treeHelpers` also
  owns the incremental-tree utilities (`loadedDirectoryChildrenCount`,
  `mergeTreePreservingLoadedChildren`, `appendTreeNodeChildren`) so
  watcher refreshes re-list only the already-loaded window.
- `apps/desktop/src/renderer/components/files/v2/filesTreeCache.ts` —
  bounded module-level workspace-roster and explorer-tree caches
  (node/byte-accounted LRU with per-key pinning for mounted explorers;
  `FILES_TREE_CACHE_NODE_BUDGET`, `FILES_TREE_CACHE_BYTE_BUDGET`,
  `FILES_ROSTER_CACHE_MAX_PROJECTS`, `filesProjectCacheKey`,
  `pinCachedTree` / `unpinCachedTree`, `releaseFilesProjectCaches`).
- `apps/desktop/src/renderer/components/files/v2/` — VS Code-style
  workbench shell: editor groups, preview/pinned tabs, split/move
  support, project-scoped tab-scope persistence, warm empty state,
  the search panel, the create prompt (`overlays.tsx`, which now holds
  `CreatePromptModal` and the shared modal chrome only), and
  viewers for code, markdown, sandboxed HTML, image, audio/video playback, CSV/TSV,
  PDF, Office-document fallback, large text, binary, and diffs.
  `v2/viewerRegistry.ts` decides both which viewer renders a file and
  whether a tab is editable (`tabIsTextEditable` = editable viewer kind
  AND a full, non-binary text payload). The markdown Preview↔Source and
  HTML Preview↔Source and CSV Table↔Source viewers share
  `viewers/ViewerModeToggle.tsx` for the
  toggle pill and `viewers/viewerModeMemory.ts` to remember each tab's
  last mode across viewer remounts (e.g. the reload after a save).
- `apps/desktop/src/renderer/components/shared/AdeDiffViewer.tsx` —
  shared read-only diff chrome (`@pierre/diffs` `MultiFileDiff` /
  `PatchDiff` with split/unified, wrap, line numbers); editable working-tree
  diffs delegate to `MonacoDiffView`. Also used from `LaneDiffPane`,
  `ChatFileChangesPanel`, and `PrDetailPane`.
- `apps/desktop/src/renderer/components/files/v2/*.test.ts(x)` and
  `apps/desktop/src/renderer/components/files/monacoModelRegistry.test.ts`
  — renderer workbench state and model-lifetime tests, including
  `filesTreeCache.test.ts` (cache budgets / pinning / eviction),
  `viewerRegistry.test.ts` (viewer + editability resolution),
  `ViewerHost.test.tsx` (payload-driven `readOnly`),
  `EditorGroup.test.tsx` (clean-model save guard), and
  `FilesSearchPanel.test.tsx` (independent name/content requests, the
  include-ignored toggle, keyboard navigation).
- `apps/ios/ADE/Views/Files/FilesRootScreen.swift` — mobile Files
  root with workspace picker, live file tree/read, a magnifying-glass
  button that opens the search page, and live file-action gating from
  sync policy.
- `apps/ios/ADE/Views/Files/FilesSearchScreen.swift` — full-screen
  unified search page (desktop `FilesSearchPanel` parity): one query
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
  diff and conflict views, the search panel, keyboard
  shortcuts, context menu.

## Which machine answers a file call

A file lives on the disk of the machine that owns the lane, so a read or a
write is a per-machine fact exactly like a chat, a terminal, or a PR record.
Every `window.ade.files.*` method therefore takes an optional **second
positional argument**, a machine pin (`OpenProjectBinding | null`):

- **Absent or `null`** — the machine this project tab is bound to. Byte for
  byte the pre-pin path: the remote-runtime route first, then the strict
  local-runtime route, then the legacy in-process IPC fallback, and the
  project-transition guard still applies.
- **A binding** — that machine, whatever the tab is bound to. A pinned call is
  explicitly targeted work, so it bypasses the transition guard (which only
  protects the ambiguous *active* binding) and has no local IPC fallback.

Reads and writes both honour it. A file belonging to a chat on another machine
opens **fully editable** without rebinding the window: `writeText`,
`writeTextAtomic`, `createFile`, `createDirectory`, `rename`, `delete`,
`watchChanges`, and `stopWatching` all land on the machine that owns the bytes.

Two deliberate exceptions:

- `openExternalPath` takes **no** pin. The path comes from this machine's
  Finder, open-file dialog, or drag/drop, so it only exists on this disk, and
  no runtime exposes a `file` action for it.
- `external-local:*` workspaces **drop** a supplied pin. They are registered
  only in this process's file service and their root path is meaningful only on
  this disk, so a caller that pins every file call uniformly still gets the
  correct local behaviour.

Coverage is the whole point, not a nicety: a Files workspace id **is** a lane
id, and lane rows sync across machines, so the same id resolves on both. An
unpinned write while pinned elsewhere does not fail — it silently writes to
this machine's worktree for that lane. That is why the renderer binds the
machine once in `pinnedFilesApi.ts` and passes the resulting object down,
rather than threading a `pin` argument through a dozen call sites: the object's
identity changes exactly when the machine does, so effects that hold it (the
file watcher above all) unsubscribe from the machine they subscribed to before
subscribing to the new one. A ref would have lied — a callback built before the
pin arrived would read the current value, and a chokidar watcher could be left
running on a remote host with nothing left to stop it.

In the UI a pin is entered by clicking a file in a chat on another machine, not
by choosing a machine. The workbench shows the amber machine chip
(`LaneMachineMarker`) with "Files on this machine. Edits save there." — or, if
that machine has gone offline, why the tree stopped answering — plus one
obvious way out, **Back to this computer**. Picking any workspace from the
bound machine clears the pin too.

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

The v2 workbench keeps one project-level editor session whose tab ids include
both `workspaceId` and path. Switching the explorer workspace changes the tree
being browsed, but it does not close tabs or discard dirty buffers from another
lane/worktree. Selecting an already-open tab from a different workspace moves
the explorer back to that tab's workspace so the tree, mutation controls, and
file actions stay aligned.

Workspace ids are not portable across binding identities. The module-level
workspace and root-tree caches are keyed by `bindingKey::projectRoot` (where
`bindingKey` is `local` or `remote:<targetId>`), so a local and a remote
session for the same path keep separate caches. Editor sessions, however, are
keyed by project root alone, so a local↔remote rebind keeps tabs and dirty
buffers open. Because a remote host lists workspaces under its own machine's
lane UUIDs, a persisted tab's `workspaceId` can be stale after a rebind. After
each `listWorkspaces`, `remapTabWorkspaces` repairs those tabs — matching by
`laneId` to the corresponding host workspace, else falling back to the primary
workspace — recomputing composite tab ids, deduping collisions to the
authoritative tab, and leaving `external-local:*` tabs untouched. Live Monaco
models follow via `registry.rekey`, and dirty/reload state is migrated with the
new ids. See [editor-surfaces.md](./editor-surfaces.md) for the full remap and
rekey rules.

## Editor modes

Three modes, each driven by a tab's internal state (no service-side
mode concept):

- **Edit** — Monaco with read/write semantics, syntax highlighting,
  Cmd+S saves atomically. Markdown / `.md` / `.mdx` tabs open in a
  Preview↔Source toggle; Source mounts the same editable Monaco host.
  CSV/TSV tabs open in a Table↔Source toggle; Source is offered only
  when the payload loaded completely (a partial streamed CSV keeps the
  read-only table so a truncated buffer can never be saved back).
  Editability is a viewer capability (`viewerRegistry.tabIsTextEditable`):
  every text-backed viewer that mounts Monaco over a full text payload is
  editable immediately — there is no trust toggle, enable-editing step,
  read-only default, or per-workspace gate. The only read-only states are
  honest boundaries: partial/streamed oversized text (`largeText` viewer),
  binary/base64 payloads, and real filesystem or remote-write failures,
  which surface as errors instead of silent no-ops.
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

A change event carries an optional `origin`. The web adapter stamps
`origin: "self"` on the events it synthesizes for its own writes, and the
workbench treats a self-originated `modified` as neither a cache invalidation
nor a tab reload — the editor already holds those bytes and primed the cache,
and on a slow relay the echo of your own save could otherwise clobber the
buffer.

Two shapes of event get special handling. An event with neither `path` nor
`oldPath` is a path-less "something moved" hint — the web adapter's CRR
invalidation fans one out per workspace — so it queues a full refresh throttled
to one every `FULL_REFRESH_MIN_INTERVAL_MS = 5_000`, rather than paying a
workspace list plus root listing plus git sweep per hint. And an event whose
path is the empty string means the workspace root, which is distinct from the
field being absent; conflating the two meant root-level changes never
refreshed. A plain `modified` event no longer re-lists the tree at all, since a
content-only change cannot alter the listing; it only queues a decoration
refresh.

## Quick open and content search

`FileSearchIndexService` maintains a flat list of file paths per
`workspaceId::mode` key (where `mode` is `default` or `all`). The
index is built lazily on the first quick-open call and kept in sync
with the watcher:

- `add`, `unlink`, `rename` events incrementally update the list
- `addDir` / `unlinkDir` events invalidate the subtree
- `fileService.quickOpen({ workspaceId, query, limit, includeIgnored })`
  runs a scoring pass over the matching index. An empty query is a valid
  browse: it returns shallowest-paths-first (`scoreBrowseDepth`) instead of
  an empty list, which is what the composer `@` menu, TUI palette, iOS, and
  web clients rely on for the pre-typing state — all four funnel into this
  one service, so no caller-side empty-query guards should be reintroduced

The index is a **name** index. Entries carry `path` / `lowerPath` / `size` /
`mtimeMs` and nothing else: retaining decoded lines cost hundreds of megabytes
of heap (80 MiB of raw bytes becomes millions of small JS strings) and crashed
the app once "include ignored files" widened the pile. Content search reads,
scans, and discards.

`fileService.searchText({ workspaceId, query, limit, includeIgnored })` is
two-tier:

1. **`git grep`**, whenever the workspace root is inside a git work tree (the
   `rev-parse --is-inside-work-tree` answer is cached per workspace root and
   dropped on the same signals that drop the name index). It is roughly 5×
   faster than the walk below on a mid-size repo and needs no name index at
   all, so a query that matches nothing no longer costs a tree walk plus a read
   of every file. The run is streamed and stopped the moment `limit` matches
   are in hand, with a 10 s timeout. Flags: `-F` so the query is literal (users
   type `foo.ts(`, and a regex parse error must never reach them), `-i`, `-I`,
   `-n`, `-z`, `--untracked`, and `-m <limit>` per file. Exclusions are pushed
   into git as pathspecs rather than filtered out of the output, so one
   `node_modules` cannot flood the stream; the parsed results are filtered too,
   as the correctness backstop. Records are parsed by `parseGitGrepRecord`,
   which accepts NUL-delimited path *and* line (modern git), NUL path with a
   colon line (older git), and the plain `path:line:text` shape.
2. **A streaming JS scan** over the name index, for workspaces that are not git
   work trees (a folder opened from Finder) and for any run where git was
   missing, failed, or timed out. Each file is read, scanned, and released;
   files over `MAX_TEXT_FILE_BYTES` (1 MB) and files with a NUL byte are
   skipped, and the loop yields cooperatively.

`GitGrepOutcome` distinguishes three results, and only one of them retires the
fast tier:

| Outcome | Meaning | Effect |
|---|---|---|
| `answered` | exit 0 (matches) or 1 (no matches), or the limit was reached | returned as-is; exit 1 is a complete, correct answer |
| `unfinished` | the 10 s timeout fired, or the process was killed from outside (`code == null`) | falls through to tier 2 this once; says nothing about future runs |
| `unusable` | spawn threw, `error` fired, or git refused the invocation (e.g. `-m` needs git ≥ 2.38 → exit 129, bad pathspec → 128) | the tier is retired for that workspace until the index is invalidated |

Three divergences between the tiers are deliberate and worth knowing, because
they mean the same query can return slightly different sets:

- `git grep` also searches files **above** `MAX_TEXT_FILE_BYTES`, which the JS
  scan skips so one enormous file cannot be read whole.
- `git grep` also searches **tracked-but-gitignored** files.
- `git grep` does **not** descend into submodules. `--recurse-submodules` would
  fix that but git rejects it outright alongside `--untracked` (exit 128), and
  untracked files matter far more here — a file an agent just wrote is the
  common case, a submodule is not.

Quick open results are `{ path, score }`. Text-search matches are
`{ path, line, column, preview }` (preview clipped to 240 chars). Because git's
case folding is not JavaScript's, a column that cannot be relocated in the
matched line reports column 1 — the line is right, only the caret is
approximate.

## The search UI

`v2/FilesSearchPanel.tsx` is the one search surface. It backs three mounts:
the explorer sidebar column, the centred modal, and the Work tools pane —
which previously had no search at all. There is no separate overlay component:
the modal renders `FilesSearchPanel` with `variant="overlay"` off the same
`searchQuery` state the sidebar uses, and only one of the two mounts is live at
a time so the same workspace is never searched twice.

Names and contents are **two independent debounced requests**, not one
`Promise.all`. Names come from the in-memory index and land first
(`quickOpen`, 120 ms debounce, limit 30); contents fill in behind them
(`searchText`, 250 ms debounce, limit 300) and never clear what is already on
screen. Freshness is tracked by a `searchKey` of
`[workspaceId, includeIgnored, query]`: results whose key no longer matches stay
visible (no flicker) but do not count as an answer, which is also how
"Searching…" is derived.

An **"Include ignored files"** toggle sits in the panel toolbar, defaults
**off**, and persists under a single global localStorage key
(`ade.files.search.includeIgnored`). Both the old call sites hardcoded
`includeIgnored: true`, which is why searching a repo used to return
`node_modules` hits nobody asked for. The key is deliberately not
per-workspace: "do I want ignored files in my results" is a preference about
how the user searches, not a property of a lane, and a per-workspace key wrote
a new entry for every lane ever searched with nothing pruning archived ones.

Results are one flat, keyboard-navigable list (↑/↓, Enter, Escape): name hits
under a "Files" header first, then content hits grouped per file with
collapsible line previews. Picking a file opens it; picking a line opens the
file and reveals that line. The modal is a one-shot pick and closes on open;
the sidebar keeps its results so several hits can be opened in a row. In the
sidebar the search field lives in the explorer header, outside the panel, so
keys are read from a ref-backed snapshot via a document listener rather than
re-subscribing on every keystroke.

## Opening a file from a chat

A path an agent writes into chat is resolved by
`renderer/components/chat/chatWorkspacePaths.tsx` and then routed to one of two
Files surfaces:

- **Same machine, and the chat's own lane** → the Work **tools-pane** Files
  panel, through the `filesOpenRequests.ts` module channel. Clicking a filename
  should open next to the conversation, not throw the user into the Files tab.
  `TerminalsPage` subscribes only to reveal the Files panel; the request itself
  waits in the channel until the embedded workbench mounts and drains it. Only
  the embedded mount listens, and it clears the channel's hold once it owns the
  request, so a later mount (after a lane or project switch) cannot re-open the
  same file unprompted.
- **Anything else** — another lane, another machine, or a chat rendered outside
  `/work` (PRs, personal chats) → the full **Files tab**, via router state, so
  the destination stays deep-linkable. A foreign machine rides along as
  `filesPin`, which the workbench applies as a machine pin *before* it looks the
  lane up, because the roster it needs is that machine's.

Before routing, the clicked token is probed against the workspace's name index
(`probeWorkspacePath`), which fixes the two silent failures users hit most:
agents write a bare filename far more often than a full path, and the old code
assumed any separator-less token sat at the workspace root. The probe resolves
a bare name to its real path, opens the search panel (`searchQuery` in router
state) when several files share that name, reveals a folder in the tree instead
of opening it as a file, and raises a toast for a path that is not inside this
project. A probe **miss is not fatal** for a path containing `/`: the index is
stale by design (built once per workspace, refreshed only from watcher events,
which run only while a Files or Git panel is open, and it excludes gitignored
files and stops at 25,000), so the file an agent just created would otherwise be
reported missing forever. Such a path is opened anyway and a real read error is
allowed to speak for itself. Only a bare name, where the index is the only thing
that can turn it into a path, gets the "can't find that file" toast.

See [../chat/README.md](../chat/README.md#source-file-map) for the parsing and
resolution contract.

## Opening in an external editor

Lane and session context menus offer **Open in** for the worktree, not
the in-app Monaco tab. Detection and launch are main-process work;
the renderer only names a target from `EDITOR_TARGETS`.

| Piece | Role |
|-------|------|
| `shared/editorTargets.ts` | Catalog (`vscode`, `cursor`, `zed`, JetBrains, Xcode, …), `OpenPathTarget` (`default` / `finder` / editor id), `OpenInTarget`, `resolveOpenInTarget` / `canOfferOpenIn` / `isRemoteEditorOpenRequest`, and `buildRemoteEditorUrl`. |
| `services/editors/editorDetection.ts` | `detectInstalledEditorTargets`: macOS `open -Ra <macAppName>`, else `which` / `where.exe`, PATH augmented by `editorProcessEnv`. Duplicate macOS apps that share `macAppName` (`zed` / `zeditor`) collapse to one. |
| `services/editors/openPathInEditor.ts` | Local: `open -a` then CLI spawn; `default` uses `shell.openPath`; `finder` uses `shell.showItemInFolder`. Remote SSH: mint a URL and `openEditorExternalUrl`. |
| `ade.app.getInstalledEditors` / `ade.app.openPathInEditor` | Direct IPC (not a runtime action). Local `rootPath` must sit under a known workspace root. |
| `OpenInSubmenu` | Shared UI on `LaneContextMenu`, `LaneActionsSubmenu`, `SessionContextMenu`, and `ForeignLaneContextMenu`. |

Remote Open in is SSH-only. The main process mints:

- VS Code family: `<scheme>://vscode-remote/ssh-remote+<host><path>` (`vscode`, `vscode-insiders`, `vscodium`)
- Zed: `zed://ssh/<host><path>`

`isRemoteEditorOpenRequest` requires a hostname and `transport !== "paired"`. Paired remotes have no SSH host ADE can hand an editor, so `resolveOpenInTarget` returns `null` and the submenu is omitted. Editors with `supportsRemote: false` (Cursor, Windsurf, JetBrains, Xcode, …) drop out of the remote picker.

The CLI allowlist in `apps/ade-cli/src/lib/externalLinks.ts` (`normalizeEditorExternalUrl` / `openEditorExternalUrl`) accepts only those VS Code-family `vscode-remote` URLs and `zed://ssh/…`. Generic `openExternalUrl` still allows only `http(s)` and `mailto:`.

Preload skips `assertNotRemoteProjectPathAction` when the request is a valid SSH remote editor open — the path is not opened locally. Files-tab Reveal in Finder / Open with default app still go through `openPathInEditor` with `target: "finder"` or `"default"` against a **local** root.

Projectless personal chats must not mount **Open in**, lane, repo, or PR actions — they have no user-visible worktree. See [personal chats](../personal-chats/README.md).

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

The decoration response is bounded, because an unbounded dirty tree (an
`rm -rf`, a committed build output) produces one oversized RPC payload, and one
oversized payload kills the whole desktop↔brain socket. `fileService` caps at
`MAX_GIT_DECORATION_ENTRIES = 20_000` entries and
`MAX_GIT_DECORATION_BYTES = 2 MiB` of estimated serialized size — far under the
socket's own ceiling, so the rest of the response keeps headroom. Files and
directories share that single budget: files are capped first, directories
against what is left, since both ride the same response and independent caps
would let the pair overrun together. When either budget binds, entries are
sorted shallowest-first so the visible near-root decorations survive and the
deep tail is what is dropped, and an entry that would overrun is skipped rather
than ending the loop, so one pathological path does not forfeit the room every
shorter path after it would still fit in.

Truncation is never silent: the response sets `truncated`, and the workbench
renders a muted **"Some git decorations hidden (large change set)"** strip
under the explorer. An undecorated file would otherwise be indistinguishable
from a clean one, which reads as a false "everything is committed".

On mount, `refreshRoot` issues the tree listing and the decoration fetch in one
`Promise.all` and applies both in the same `setTree` — one round trip instead of
two, which is the dominant mount cost over a relay. That path passes
`forceFresh: false` so the host's short status cache can serve it; only the
explicit refresh action forces a fresh scan.

## Cache-first open, then revalidate

`useFileContent.ts` keeps a bounded LRU of initial `readFile` payloads keyed by
workspace and path (`MAX_CACHE = 48`). Opening a file paints from that cache
when it hits, so reopening a file you just closed or previewed costs zero round
trips — on the hosted web client, zero relay hops.

Nothing invalidates that LRU on its own from the other side: the web client has
no host-side watcher across the relay, and the desktop watcher only runs while
the Files tab is active. So a cache-painted open is followed by a background
`revalidateOpenedFile`, which re-reads and swaps the viewer only if the bytes
genuinely differ (`sameFileContent` compares content, size, total size,
encoding, and the binary/partial flags — `FileContent` carries no timestamp, so
this is exact rather than heuristic). Three rules keep it safe: a dirty tab is
checked *before* the read and skipped entirely, so unsaved edits are never
discarded and a dirty tab costs nothing; dirtiness is re-checked after the
await; and a read that throws returns without priming, because a failed read
must not poison the cache — the next explicit read surfaces the error.

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
the remote filesystem. It is also the one `files` method with no machine pin
argument, and `external-local:*` workspace ids drop a pin even when one is
supplied — see [Which machine answers a file call](#which-machine-answers-a-file-call).

A pin that arrives as router state is untrusted input like any other:
`FilesTab` accepts only a well-formed `OpenProjectBinding`, so a malformed
history entry cannot aim file calls at a machine that does not exist.

For deeper detail on the watcher + trust boundary, see
[file-watcher-and-trust.md](./file-watcher-and-trust.md).

## Gotchas

- The file tree is listed with `includeIgnored: true` in the renderer,
  so dotfiles show up by default, but volatile ADE runtime paths such
  as `.ade/worktrees/`, `.ade/cache/`, transcripts, secrets, and the
  SQLite DB are still filtered out. Pair callers that pass
  `includeIgnored: false` (search indexing, watcher default mode) with
  the corresponding start/stop pair — the watcher refcounts are
  per-mode. Search is separate from the tree: it defaults to
  `includeIgnored: false` and only widens when the user turns the toggle on.
- While a machine pin is active the workbench publishes **nothing** into the
  dirty-buffer map. That map is keyed by absolute path with no machine in the
  key, and the main process reads it to serve agent file reads on *this*
  machine — and one user's laptop and desktop routinely check the same repo out
  at the same absolute path, so publishing would hand a local agent the remote
  machine's unsaved text and let it write that back. Tabs stay editable and
  save over the wire as normal. Clearing the pin does not resume publishing in
  the same commit either: it waits until the roster has been re-listed for the
  machine the tab is actually bound to, because until then `resolveTabContext`
  still resolves the machine just left.
- `fileService.readFile` sends inline text previews up to 1 MB, inline
  image previews up to 1 MB, and small unsupported binary payloads up
  to 256 KB. Oversized text returns a partial first chunk and streams
  through `readFileRange`; oversized images and unsupported binaries
  still return `contentOmitted`.
- HTML preview is renderer-only and deliberately inert: it uses `srcDoc` in an
  empty-sandbox iframe plus a restrictive CSP/no-referrer policy. Scripts,
  forms, parent navigation, downloads, and remote resource fetches stay
  disabled; oversized HTML follows the large-text streaming path instead of
  constructing a multi-megabyte iframe document.
- `listTree` and `listTreeChildren` must share filtering and ordering:
  skip `.git`, skip volatile `.ade` runtime paths, honor
  `includeIgnored`, sort directories before files, and paginate via
  `nextOffset` rather than silently dropping entries.
- Directory expansion fetches exactly one `TREE_PAGE_SIZE` (2,000) page —
  a single IPC round trip — and renders it immediately with a "Load
  more…" row for the remainder; each load-more click appends one more
  page. Watcher-driven refreshes re-list only the already-loaded window
  (`loadedDirectoryChildrenCount`), never an arbitrary 10,000 children.
  Path reveals (external opens) are the exception and page up to
  `REVEAL_MAX_CHILDREN` so the revealed entry materializes.
- The cross-mount workspace roster and explorer tree caches live in
  `v2/filesTreeCache.ts` and are bounded: trees are node/byte-accounted
  with LRU eviction over budget, mounted workbenches pin their rendered
  tree (eviction can never desync a live explorer), and warm
  project-surface eviction in `App.tsx` releases the project's Files
  caches. Evicted trees reload through the normal `refreshRoot` path.
  The cache holds only tree structure — Monaco models, dirty buffers,
  editor groups, and open tabs are never touched by its policy.
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
  different host or workspace. A pinned call is stricter still: it names one
  machine and has no local IPC fallback at all.
- Files are freely editable. There is no "Enable editing" step and no
  per-workspace edit-protection gate: every resolved workspace — including the
  primary repo root and lanes whose `is_edit_protected = 1` — opens Monaco in
  read/write mode with create / rename / delete controls enabled on desktop and
  mobile. The `is_edit_protected` flag still exists but only governs lane
  lifecycle (delete / reparent / auto-rebase exclusion), not file editing;
  `FilesWorkspace.isReadOnlyByDefault` is now derived as constant `false`.
- Workspace switching is navigation, not a discard action. Dirty tabs remain
  open and published to the dirty-buffer map under their own workspace root
  until the user saves, closes, renames, deletes, or unloads the tab.
- `listWorkspaces` failures are retried with a capped backoff
  (`1s → 2s → 5s → 10s`, then steady) rather than swallowed, so a Files tab
  opened before a remote runtime finishes connecting fills in its workspace
  list once the host answers instead of staying empty. Individual file
  reads/writes are still strict (a bound-runtime failure surfaces to the tab).
- File watcher subscriptions are per sender (BrowserWindow /
  webContents). Closing a window calls `stopAllForSender` to tear
  down every subscription for that window.
- Lane worktrees are resolved through `laneService`, not directly from
  `.ade/worktrees/`. A lane deleted out-of-band will make its
  workspace disappear from the list on next refresh.
- **Remote Open in is SSH URLs, not local paths.** Do not spawn `code`
  against a remote worktree path on the laptop. Paired remotes
  (`transport: "paired"`) have no hostname ADE can mint into
  `vscode://` / `zed://`, so `canOfferOpenIn` is false. Do not widen
  `openExternalUrl` to those schemes — they go through
  `openEditorExternalUrl` only.

## Cross-links

- Lane worktrees feed the workspace list: [../lanes/](../lanes/)
- Lane and session **Open in** menus:
  [../lanes/](../lanes/) and
  [../terminals-and-sessions/](../terminals-and-sessions/)
- Processes and tests can monitor the workspace for changes via the
  watcher — see [../terminals-and-sessions/](../terminals-and-sessions/)
  for the transcript and log story.
