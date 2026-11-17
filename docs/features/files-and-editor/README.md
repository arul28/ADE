# Files and Editor

An IDE-style file explorer and Monaco editor in ADE: shared workspace
selection, atomic writes, file watching with reference-counted
subscriptions, Monaco model reuse, streamed large-file previews, and diff and
conflict modes. Context packs use it to find docs, chat links open files in
it, and lanes show their files through it.

## Where this runs

File listing, atomic writes, the file-name index, content search and the file
watcher run inside the **active runtime** of the window's project binding:
the local ADE daemon for a local window, the remote runtime for a remote
window. Monaco runs only in the renderer. Every byte it reads or writes goes
through `window.ade.files.*` (`apps/desktop/src/preload/preload.ts`): the
remote-runtime route first, then the strict local-runtime route. The legacy
in-process IPC handlers answer only when no runtime route exists (before a
project binding, or in tests). Watcher events arrive on the runtime event
stream (category `"runtime"`) through the same preload pump as lane, PTY and
process events. A remote window therefore browses and edits the remote
worktree.

Every `window.ade.files.*` method takes an optional trailing **machine pin**
(`OpenProjectBinding | null`). See
[Which machine answers a file call](#which-machine-answers-a-file-call).

An ADE Cloud lane whose computer is at rest is read from GitHub, with no
computer awake. See [With no computer awake](#with-no-computer-awake).

Git ignore lookups split paths at submodules and query each submodule, so one
nested path does not discard the rest of a batch. Failed lookups are not
cached. Chat editor links that use `cursor://` or `vscode://` open the file in
ADE.

## Source file map

Paths are under `apps/desktop/src/` unless they say otherwise. Runtime
services are the real implementation; `main/services/files/` also serves the
legacy IPC fallback.

Main process and runtime:

- `main/services/localRuntime/localRuntimeConnectionPool.ts`: local runtime
  project registration, file action dispatch and event polling, with a bounded
  per-call timeout for file actions.
- `main/services/ipc/runtimeBridge.ts`,
  `main/services/remoteRuntime/remoteConnectionPool.ts`,
  `main/services/remoteRuntime/remoteConnectionService.ts`,
  `apps/ade-cli/src/multiProjectRpcServer.ts`: bridge the runtime event stream
  to bound windows. A `replay: false` subscription returns the current cursor,
  so a remote Files tab watches live changes without stale events.
- `main/services/remoteRuntime/runtimeRpcClient.ts`: the JSON-RPC client for
  local and remote runtimes, with per-call timeouts for file actions and event
  polling.
- `main/services/files/fileService.ts`: listing, paged children, Git status
  decorations (capped, see [Git status overlay](#git-status-overlay)), range
  reads, blame, atomic writes, quick open, content search, path safety. One
  open per read: above the 1 MiB text cap it reads one 256 KB prefix; from
  256 KB to 1 MiB it sniffs an 8 KB prefix first; at or below 256 KB it reads
  the file once.
- `main/services/files/externalFilesWorkspaceRegistry.ts`: local-only registry
  of files and folders opened from Finder, OS open-file events or drag and
  drop.
- `main/services/shared/treeWatcher.ts`: `watchTree`, under the file watcher
  and the automation file trigger (see [File watching](#file-watching)).
- `main/services/files/fileWatchLedger.ts`: the watches a client still holds,
  so the stops a vanished page never sent can be sent for it.
- `main/services/files/fileWatcherService.ts`: `watchTree` wrapper with
  per-sender ref counts, debounced events, idle close,
  `stopAllForWorkspace(workspaceId)` and `countActiveForWorkspace` (the lane
  delete pipeline stops watchers before it removes a worktree).
- `main/services/files/fileSearchIndexService.ts`: the file-**name** index
  (per workspace and `includeIgnored` mode, updated from watcher events), the
  opt-in directory map, and the two-tier content search behind `searchText`.
- `main/services/files/fileService.test.ts`, `fileWatcherService.test.ts`:
  unit coverage.
- `main/services/diffs/`: diff computation for diff mode.
- `main/services/conflicts/conflictService.ts`: 3-way merge data for conflict
  mode.
- `main/services/editors/editorDetection.ts`, `openPathInEditor.ts`,
  `editorProcessEnv.ts`, `editorWindowsInstall.ts`: detect installed editors
  and open a local path or an SSH remote URL in one (see
  [Opening in an external editor](#opening-in-an-external-editor)).
- `main/services/lanes/laneService.ts`: `getFilesWorkspaces`,
  `resolveWorkspaceById`.

ADE Cloud reads (no computer awake):

- `shared/adeCloud/accountReader.ts`: answers file calls for an
  account-answered pin from GitHub (`listContents`, `getFileContent` at the
  lane's branch), with read-only workspaces. `githubReadSentence` gives the
  "Connect GitHub" and "branch isn't on GitHub yet" sentences.
- `shared/adeCloud/binding.ts`: `isAdeCloudBinding`, `isAccountAnsweredPin`.
- `shared/github/directClient.ts`: the GitHub App calls those reads use.
- `renderer/webclient/adapter/federated.ts`, `renderer/webclient/adapter/files.ts`:
  the web client's routing to the account reader.

Shared types and IPC:

- `shared/types/files.ts`: `FilesWorkspace`, `FileTreeNode`,
  `FilesListTreeChildrenResult`, `FileContent`, `FilesReadFileRangeResult`,
  `FilesGitStatusEvent`, `FilesGitBlameResult`, `FilesQuickOpenItem`,
  `FilesSearchTextMatch`, `FilesOpenExternalPathResult`, IPC args.
- `shared/editorTargets.ts`: `EDITOR_TARGETS`, `OpenPathTarget`,
  `OpenInTarget`, remote SSH URL builders, `resolveOpenInTarget`,
  `canOfferOpenIn`.
- `shared/types/git.ts`: `FileDiff`, `FilePatch` and the other diff shapes.
- `shared/ipc.ts`: `ade.files.*`, `ade.diff.getChanges`, `ade.diff.getFile`,
  `ade.diff.getFilePatch`.
- `main/services/ipc/registerIpc.ts`: the `files*` and `diff*` handlers, plus
  `appGetInstalledEditors` and `appOpenPathInEditor`.
- `preload/preload.ts`: `window.ade.files` and `window.ade.diff` (the changes
  list is short-cached per lane). Every `files` method except
  `openExternalPath` takes a trailing machine pin, routed by
  `callPinnedFileActionOr`.

Renderer (`renderer/components/files/`):

- `FilesTab.tsx`: route entry. It renders the workbench and forwards chat file
  targets from router state. It validates that state: `openPathType` reveals in
  the tree, `searchQuery` opens search, and `filesPin` is accepted only when it
  is a well-formed `OpenProjectBinding`.
- `v2/FilesWorkbench.tsx`: the shell (workspace chrome, explorer, editor
  groups, Monaco host, diff and conflict surfaces, quick open, search, trust
  warnings, recent files, project-level tabs across lane switches, dirty-buffer
  publishing, viewers). `preferredLaneId` and `embedded` let it mount in the
  Work tools pane; embedded, it uses one `workToolChrome` row and below
  `EMBEDDED_SINGLE_SURFACE_PX` (520) shows one surface at a time. It owns the
  machine pin (the machine chip, "Back to this computer", liveness, cache
  release) and the read-only state of an account-answered lane.
- `v2/pinnedFilesApi.ts`: `createPinnedFilesApi(pin)`, the Files API bound to
  one machine, cached per binding key. Nothing under the workbench calls
  `window.ade.files` directly.
- `v2/useFilesTree.ts`: the explorer tree (listing, paging, expansion,
  serialized tree ops, decorations, `rootStatus`), keyed by workspace and
  machine. The watcher stays in the workbench because it also reloads tabs.
- `v2/FilesSearchPanel.tsx`: the one search surface (sidebar, modal, Work
  tools pane), the "Include ignored files" preference, and the shared
  `Backdrop` / `SEARCH_PANEL_SURFACE` chrome.
- `v2/filesOpenRequests.ts`: one-shot channel for "open this path in the Work
  tools-pane Files panel".
- `FilesExplorer.tsx`: virtualized tree, inline rename and create, the search
  field and its results slot, the "Loading files…" and "Couldn't load the
  files" states, and `readOnlyReason`.
- `filePresentation.tsx`: file icons, `changeStatus*` helpers,
  `MonochromeFileIconsContext`.
- `v2/monacoLoader.ts`: memoized Monaco init and the `ade-dark` /
  `ade-light` themes (literal colours, because the themes are defined once).
- `monacoModelRegistry.ts`, `treeHelpers.ts`: Monaco model lifetime, and tree
  helpers (`loadedDirectoryChildrenCount`,
  `mergeTreePreservingLoadedChildren`, `appendTreeNodeChildren`).
- `v2/filesTreeCache.ts`: bounded roster and tree caches (node and byte LRU,
  per-key pinning, `releaseFilesProjectCaches`).
- `v2/`: editor groups, preview and pinned tabs, splits, tab persistence, the
  create prompt (`overlays.tsx`), and the viewers (code, markdown, sandboxed
  HTML, image, Mermaid, font, audio and video, CSV/TSV, PDF, `.xlsx`, `.pptx`,
  `.docx`, legacy Office, large text, binary, diff). `v2/viewerRegistry.ts`
  picks the viewer and `tabIsTextEditable`. `viewers/ViewerModeToggle.tsx` and
  `viewers/viewerModeMemory.ts` hold the Preview/Source style toggles.
- `v2/viewers/office/`: the OOXML readers (`ooxmlZip.ts`, `ooxmlXml.ts`,
  `xlsx.ts`, `pptx.ts`, `docx.ts`, `ooxmlMedia.ts`, `ooxmlError.ts`).
- `v2/viewers/OoxmlPreviewShell.tsx`: shared size check, capped stream,
  dynamic parse, cancel and failure card for the Office viewers.
- `v2/viewers/WordViewer.tsx`, `WordBlocks.tsx`, `FontViewer.tsx`,
  `fontInfo.ts`, `MermaidViewer.tsx`, `usePanZoom.ts`, `ZoomControls.tsx`,
  `DocumentSurface.tsx`: the Word, font and Mermaid viewers, shared pan and
  zoom, and the "no in-app preview" card.
- `renderer/components/shared/AdeDiffViewer.tsx`: read-only diff chrome
  (`@pierre/diffs`, split or unified, **Ignore whitespace**); editable diffs use
  `MonacoDiffView`. Also used by `LaneDiffPane`, `ChatFileChangesPanel`,
  `PrDetailPane`. `diffWhitespace.ts` owns the whitespace rule. The toggle
  persists under `ade:diff:ignoreWhitespace:<persistKey>`.
- `renderer/components/ui/OpenInSubmenu.tsx`: the shared **Open in** submenu.
- `v2/*.test.ts(x)`: `viewerRegistry.test.ts`, `EditorGroup.test.tsx`,
  `FilesSearchPanel.test.tsx` and the workbench tests.

iOS (`apps/ios/ADE/Views/Files/`): `FilesRootScreen.swift` (workspace picker,
tree, search button, action gating), `FilesSearchScreen.swift` (one query for
names and contents), `FilesDetailScreen.swift` and `FilesRootComponents.swift`.

## Detail docs

- [file-watcher-and-trust.md](./file-watcher-and-trust.md): the watcher, path
  safety, the preload trust boundary, external-change sync.
- [editor-surfaces.md](./editor-surfaces.md): Monaco host, tabs, diff and
  conflict views, search panel, shortcuts, context menu.

## Which machine answers a file call

A file lives on the disk of the machine that owns the lane. Every
`window.ade.files.*` method takes an optional second argument, a machine pin:

- **Absent or `null`**: the machine the project tab is bound to, through the
  remote route, the local route, then the IPC fallback. The project-transition
  guard applies.
- **A binding**: that machine. A pinned call bypasses the transition guard and
  has no local IPC fallback.

Reads and writes both follow the pin. A file of a chat on another machine
opens fully editable without rebinding the window: `writeText`,
`writeTextAtomic`, `createFile`, `createDirectory`, `rename`, `delete`,
`watchChanges`, `stopWatching` and `onChange` go to the machine that owns the
bytes.

Two exceptions:

- `openExternalPath` takes no pin. Its path exists only on this disk.
- `external-local:*` workspaces drop a pin. A pinned `onChange` still forwards
  this process's loose-folder events.

A workspace id is a lane id, and lane rows sync, so the same id resolves on
every machine. An unpinned write while the workbench is pinned elsewhere
writes silently to this machine's worktree. For that reason the renderer binds
the machine once in `pinnedFilesApi.ts` and passes the object down. Its
identity changes exactly when the machine does, so the watcher unsubscribes
from the old machine before it subscribes to the new one. Do not replace it
with a ref: a callback built before the pin arrived would read the new value,
and a watcher could stay on a remote host with nothing to stop it.

The workspace picker groups lanes by machine. Picking a lane on another
machine pins the workbench to it without rebinding the tab. The machine chip
and a way back stay visible. An offline owner stays identifiable while its
file actions are unavailable. On an ADE Cloud tab, a lane that the account
workspace list already has shows once, not again under its computer.

## With no computer awake

An ADE Cloud tab, or a lane pin of a cloud computer this window has no
connection to (`cloud-saved:<machineKey>`), is an **account-answered pin**
(`isAccountAnsweredPin`). Its file calls go to the account reader, never to a
computer, so a read never wakes one:

- The tree and the file contents come from GitHub at the lane's branch,
  through the account's GitHub App sign-in. A file over the reader's text cap
  opens as "too large".
- Every workspace is read-only (`isReadOnlyByDefault: true`). New file and New
  folder stay visible but do nothing. Their tooltip says: "Read-only: these
  are the files on GitHub. Wake the lane's computer to change them." The empty
  tree hides its New file link.
- A read failure is the reader's sentence in the error banner, with Refresh
  and dismiss and no "Report…": "Connect GitHub to your ADE account to see
  this repository's files with no computer on.", "This lane has no branch on
  GitHub yet…", "The branch … isn't on GitHub yet…", or "ADE reads files with
  no computer on only for repositories on GitHub."
- The explorer shows "Loading files…" while the root lists, and "Couldn't load
  the files" with Retry when it fails, never an empty tree.
- Writes, search and the watcher are not answered by the reader. Waking the
  lane's computer (any "do" action) moves the pin back to the computer.

## Workspace model

A **workspace** is a directory the Files tab can browse:

| Kind | Source | Notes |
|---|---|---|
| `primary` | Repository root | Always present. |
| `worktree` | `.ade/worktrees/<lane>` | One per active lane. `laneId` set. |
| `attached` | A path the user linked | External worktrees. |
| `external` | An explicit local open | Local-only roots from OS open-file events or drag and drop. |

`laneService.getFilesWorkspaces()` builds the list. `resolveWorkspaceById`
does the reverse lookup on every lane-backed file call. `external` workspaces
have stable `external-local:<hash>` ids for the life of the local runtime. An
opened path inside a known workspace returns that workspace instead.

The renderer always shows the active workspace name. External tabs show the
full host path in the status bar and copy menus.

The workbench keeps one project-level editor session; tab ids include the
`workspaceId` and the path. Switching the explorer workspace does not close
tabs or drop dirty buffers. Selecting a tab of another workspace moves the
explorer to that workspace.

Workspace ids are not portable across binding identities. The workspace and
root-tree caches are keyed by `bindingKey::projectRoot` (`local` or
`remote:<targetId>`). Editor sessions are keyed by project root only, so a
local↔remote rebind keeps tabs and dirty buffers. After each `listWorkspaces`,
`remapTabWorkspaces` repairs stale tab workspace ids (by `laneId`, else the
primary workspace), recomputes tab ids, dedupes collisions and leaves
`external-local:*` tabs alone. Monaco models follow through `registry.rekey`.
See [editor-surfaces.md](./editor-surfaces.md).

## Editor modes

A tab's own state picks the mode; the service has no mode concept.

- **Edit**: Monaco, read and write, Cmd+S saves atomically. Markdown,
  `.md` and `.mdx` open in Preview↔Source. CSV/TSV open in Table↔Source;
  Source shows only for a complete payload, so a truncated buffer is never
  saved. Editability is `viewerRegistry.tabIsTextEditable` (an editable viewer
  over a full text payload). There is no trust toggle and no per-workspace
  gate. A tab is read-only only for partial large text, binary payloads, an
  account-answered lane, or a real write failure (which shows as an error).
- **Diff**: `AdeDiffViewer` over `diffService`; editable working-tree diffs
  use `MonacoDiffView`. Scopes: **Branch**, **Uncommitted**, **Staged**, or a
  commit.
- **Conflict**: 3-way merge (Base, Ours, Theirs, Result) with Accept Ours,
  Accept Theirs and Accept Both, through `conflictService`.

### Branch scope

`DiffMode` `branch` is what a lane committed since its base: the file at
merge-base(base, HEAD) against HEAD. Uncommitted edits are the `unstaged` and
`staged` modes, so the two never overlap. `diffService.getBranchChanges` lists
files with line counts. A second ask shares an in-flight read only before that
read starts git; after that a new read starts, so a later commit is never
missed. A single-file patch looks up the rename first. `getFileDiff` and
`getFilePatch` take `mode: "branch"` too.

The base is the lane's compare base (its open PR's base, else the default
branch). The primary lane compares with its upstream, else `origin/<base>`. A
base that does not resolve, or no common history, is an error ("The base
branch "x" was not found."), never an empty diff.

An older host reads an unknown mode as `unstaged`. Clients offer Branch only
after `git.getBranchChanges` answers (the `diff` action domain,
`diff.getBranchChanges` on the web); iOS checks the advertised command. The
Git pane (`LaneGitActionsPane`) shows **Uncommitted changes**, **Committed on
this branch** (hidden on a host without branch diffs) and **History**. CLI:
`ade diff changes --lane <id> --mode branch --text`.

## Atomic saves

`fileService.writeTextAtomic` (`secureWriteTextAtomicWithinRoot`) writes a
temp file in the target's directory, then renames it onto the target, so a dev
server never sees a partial file. `writeText` writes directly. Both resolve
through `resolvePathWithinRoot`: no writes outside the workspace root and none
into `.git`.

## File watching

`fileWatcherService` keeps one tree watcher per `workspaceId + senderId`, with
two ignore profiles:

- **default**: ignores `.git/`, `node_modules/`, `.ade/`.
- **include ignored**: ignores only `.git/`.

The profiles share one watcher where possible (`defaultRefCount`,
`includeIgnoredRefCount`); a mode change restarts it. At zero references an
idle timer (`IDLE_WATCHER_CLOSE_MS = 15_000`) closes it.

`watchTree` reports chokidar's events (`add`, `change`, `unlink`, `addDir`,
`unlinkDir`) on every platform:

- Linux uses chokidar.
- macOS and Windows use one recursive native watch per root. The event says
  where to look; the path is read again and compared with a tree snapshot. Do
  not switch to chokidar's native mode: it opens one watch per directory, and
  closing thousands of them blocks the event loop.
- A file replaced by a directory of the same name is a delete plus creates.
- On Windows, an event with no file name (dropped events) re-reads the whole
  tree, and the root's parent is watched too so a deleted and recreated root
  is watched again.
- `scripts/perf/service/tree-watcher-parity.mts` compares the watchers;
  `docs/perf/windows-baseline.md` has the Windows numbers.

A watch is one reference; a stop releases one. A page that goes away without
its cleanup never sends its stops, so `fileWatchLedger.ts` tracks outstanding
references: the runtime bridge sends the missing stops when a page navigates,
loses its renderer or closes, and the brain releases a connection's watches
when the connection closes.

Events are debounced per file for 140 ms. Volatile `.ade/` paths
(transcripts, the database, caches, CLI config) are filtered even with
`includeIgnored` (list in [file-watcher-and-trust.md](./file-watcher-and-trust.md)).

The renderer listens on `ade.files.change` (`created`, `modified`, `deleted`,
`renamed`):

- A clean open tab reloads. A dirty tab does not.
- Dirty Monaco buffers are published to the dirty-buffer map of the active
  workspace, so agent file reads see unsaved text.
- An event with `origin: "self"` (the web adapter's echo of its own write) is
  neither a cache invalidation nor a reload.
- An event with neither `path` nor `oldPath` is a "something moved" hint: it
  queues a full refresh, at most one every `FULL_REFRESH_MIN_INTERVAL_MS`
  (5,000).
- An empty-string path means the workspace root, not a missing path.
- A plain `modified` event does not re-list the tree; it queues a decoration
  refresh.

## Quick open and content search

`FileSearchIndexService` keeps a flat list of file paths per
`workspaceId::mode` (`default` or `all`). It builds lazily on the first quick
open and follows the watcher: `add`, `unlink` and `rename` update it;
`addDir` and `unlinkDir` invalidate the subtree.

`fileService.quickOpen({ workspaceId, query, limit, includeIgnored })` scores
the index. An empty query is a valid browse: it returns the shallowest paths
first (`scoreBrowseDepth`). The composer `@` menu, iOS and the web rely on it;
do not add empty-query guards in callers.

**Folders are indexed, and opt-in.** Directories live in their own map, apart
from `files`, so content scans never see them. The full walk and `upsertFile`
record them, and they leave on the same subtree rule as files. `quickOpen`
returns them only with `includeDirectories: true`, marked
`FilesQuickOpenItem.isDirectory`. Only the composer `@` menu opts in (it
inserts a pointer chip; a folder has no bytes to attach). The flag is part of
the quick-open cache key.

The index is a **name** index: `path`, `lowerPath`, `size`, `mtimeMs`. Do not
keep file contents in it; decoded lines cost hundreds of megabytes. Content
search reads, scans and discards.

`fileService.searchText({ workspaceId, query, limit, includeIgnored })` has two
tiers:

1. **`git grep`**, when the root is inside a git work tree (the answer is
   cached per root). It streams, stops at `limit`, and times out at 10 s.
   Flags: `-F` (the query is literal), `-i`, `-I`, `-n`, `-z`, `--untracked`,
   `-m <limit>`. Exclusions go to git as pathspecs and are filtered again
   after parsing. `parseGitGrepRecord` reads the modern NUL format, the older
   NUL-path format and plain `path:line:text`.
2. **A streaming JS scan** over the name index, for non-git folders and for
   runs where git was missing, failed or timed out. It skips files over
   `MAX_TEXT_FILE_BYTES` (1 MB) and files with a NUL byte, and yields.

| `GitGrepOutcome` | Meaning | Effect |
|---|---|---|
| `answered` | exit 0 or 1, or the limit was reached | returned as is |
| `unfinished` | the timeout fired, or the process was killed (`code == null`) | tier 2 this once |
| `unusable` | spawn failed, or git refused the call (exit 129 or 128) | tier 1 retired for the workspace until the index is invalidated |

The tiers can return different sets: `git grep` also searches files over
`MAX_TEXT_FILE_BYTES` and tracked-but-ignored files, and it does not enter
submodules (`--recurse-submodules` cannot be used with `--untracked`).

Quick open returns `{ path, score }`. A text match is
`{ path, line, column, preview }` (preview up to 240 chars). When git's case
folding puts the match where JavaScript cannot find it, the column is 1.

## The search UI

`v2/FilesSearchPanel.tsx` is the one search surface: the explorer sidebar, the
centred modal (`variant="overlay"`, same `searchQuery` state) and the Work
tools pane. Only one of sidebar and modal is live, so a workspace is never
searched twice.

Names and contents are two independent debounced requests: `quickOpen` (120 ms,
limit 30) lands first; `searchText` (250 ms, limit 300) fills in behind and
never clears what is on screen. A `searchKey` of
`[workspaceId, includeIgnored, query]` marks old results: they stay visible
but do not count as an answer ("Searching…").

**Include ignored files** defaults off and persists in one global key,
`ade.files.search.includeIgnored`. It is a search preference, not a lane
property, so it is not per workspace.

Results are one keyboard list (↑/↓, Enter, Escape): name hits under "Files",
then content hits grouped per file. A line hit opens the file at that line.
The modal closes on open; the sidebar keeps its results. In the sidebar the
field lives in the explorer header, so keys come from a ref-backed snapshot.

## Opening a file from a chat

`renderer/components/chat/chatWorkspacePaths.tsx` resolves a path an agent
wrote and routes it:

- **Same machine and the chat's own lane**: the Work tools-pane Files panel,
  through `filesOpenRequests.ts`. `TerminalsPage` only reveals the panel; the
  embedded workbench drains the request when it mounts and clears the hold, so
  a later mount cannot open it again.
- **Anything else** (another lane, another machine, a chat outside `/work`):
  the Files tab through router state. A foreign machine rides as `filesPin`,
  applied before the lane lookup.

Before routing, `probeWorkspacePath` checks the token against the name index:

- A bare name resolves to its path. Several matches open search. A folder is
  revealed in the tree. A path outside the project shows a toast.
- A bare name the index does not know walks the workspace once
  (`refreshIndex`), because a new file is not indexed yet.
- A miss is not fatal for a path with `/`: the index is stale by design (built
  once, refreshed only while a Files or Git panel watches, no ignored files,
  25,000 files at most). The path opens and a real read error speaks for
  itself. Only a bare name gets the "can't find that file" toast.

The viewer is chosen by extension, so an Office file opens on its preview. See
[../chat/README.md](../chat/README.md#source-file-map) for the parsing rules.

## Opening a file from elsewhere

A path clicked in a chat, tool-call or diff row, or printed in a terminal,
opens through `useWorkspacePathOpener` (`chatWorkspacePaths.tsx`):

- An absolute path resolves to the deepest workspace root that holds it.
- A relative path resolves by its ending: one match opens, several open
  search, none shows a toast after a real read.
- Navigation carries the file in router state. `App.tsx` passes page routes
  the real location, because a route given to `<Routes>` as a string loses its
  state.

Terminal paths become links only under the pointer: `terminalPathLinks.ts`
scans the hovered row (and its wrapped rows) in one capped pass, checks the
file exists after a short rest, and links only real files. A network path
never becomes a link.

## Opening in an external editor

Lane and session menus offer **Open in** for the worktree. Detection and launch
run in the main process; the renderer names a target from `EDITOR_TARGETS`.

| Piece | Role |
|-------|------|
| `shared/editorTargets.ts` | The catalog (`vscode`, `cursor`, `zed`, JetBrains, Xcode, …), `OpenPathTarget` (`default` / `finder` / editor id), `resolveOpenInTarget`, `canOfferOpenIn`, `isRemoteEditorOpenRequest`, `buildRemoteEditorUrl`. |
| `services/editors/editorDetection.ts` | `detectInstalledEditorTargets`: macOS `open -Ra <app>`, else `which` / `where.exe` with PATH from `editorProcessEnv`, all in parallel. Targets that share one app (`zed` / `zeditor`) collapse. On Windows a miss falls through to `editorWindowsInstall.ts`. |
| `services/editors/editorWindowsInstall.ts` | Windows-only, read-only lookup beyond PATH: Program Files, `%LOCALAPPDATA%\Programs`, JetBrains and Toolbox folders, and the uninstall registry keys (`reg.exe` through `resolveTrustedWindowsTool`). Exact `DisplayName` first; a more specific editor's entry is never claimed. Paths are checked; results cache for 5 minutes; it never launches a GUI or asks for elevation. |
| `services/editors/openPathInEditor.ts` | Local: `open -a`, then a CLI spawn (Windows uses the resolved executable); `default` uses `shell.openPath`, `finder` uses `shell.showItemInFolder`. Remote SSH: mint a URL and call `openEditorExternalUrl`. |
| `ade.app.getInstalledEditors` / `ade.app.openPathInEditor` | Direct IPC. A local `rootPath` must be under a known workspace root. |
| `OpenInSubmenu` | Used by `LaneContextMenu`, `LaneActionsSubmenu`, `SessionContextMenu`, `ForeignLaneContextMenu`. |

Remote Open in is SSH only:

- VS Code family: `<scheme>://vscode-remote/ssh-remote+<host><path>`
  (`vscode`, `vscode-insiders`, `vscodium`).
- Zed: `zed://ssh/<host><path>`.

`isRemoteEditorOpenRequest` needs a hostname and `transport !== "paired"`. A
paired remote has no SSH host, so the submenu is left out. Editors with
`supportsRemote: false` leave the remote picker. The CLI allowlist
(`apps/ade-cli/src/lib/externalLinks.ts`, `openEditorExternalUrl`) accepts only
those URLs; `openExternalUrl` allows only `http(s)` and `mailto:`. Preload skips
`assertNotRemoteProjectPathAction` for a valid SSH editor open. Reveal in
Finder and Open with default app use `openPathInEditor` on a local root.
Personal chats never mount **Open in** or lane, repo or PR actions.

## Git status overlay

Tree listings carry a `changeStatus`. The status map is cached per root for
5 s (`GIT_STATUS_CACHE_TTL_MS`) from one `git status --porcelain=v2`. The first
paint does not wait for it: the renderer calls
`files.refreshGitDecorations({ forceFresh })` after the tree loads and applies
file statuses plus directory rollups without listing again. A remote runtime
without the optional `file.refreshGitDecorations` action gives an empty
decoration set, not a tree failure.

The response is bounded, because one oversized RPC payload kills the
desktop↔brain socket: at most `MAX_GIT_DECORATION_ENTRIES` (20,000) entries
and `MAX_GIT_DECORATION_BYTES` (2 MiB) estimated size. Files and directories
share the budget (files first). When a budget binds, entries go shallowest
first, and an entry that does not fit is skipped, not the end of the loop.
The response then sets `truncated`, and the explorer shows "Some git
decorations hidden (large change set)", because an undecorated file would read
as committed.

On mount, `refreshRoot` lists the tree and fetches decorations in one
`Promise.all` and applies both in one `setTree`, with `forceFresh: false`. Only
the explicit refresh forces a fresh scan.

## Cache-first open, then revalidate

`useFileContent.ts` keeps an LRU of initial `readFile` payloads by workspace and
path (`MAX_CACHE = 48`). A hit paints at once, with no round trip. Nothing on
the other side invalidates it (the web has no host watcher, and the desktop
watcher runs only while Files is active), so a cache-painted open is followed
by `revalidateOpenedFile`. It swaps the viewer only if the bytes differ
(`sameFileContent`: content, size, total size, encoding, binary and partial
flags). Rules:

- A dirty tab is skipped before the read, and dirtiness is checked again after
  it, so unsaved edits are never dropped.
- A read that throws does not prime the cache; the next explicit read shows
  the error.

## Large-file and range reads

`files.readFile` returns inline text up to 1 MB, inline image previews up to
1 MB, and small unsupported binaries up to 256 KB. A larger text file returns a
UTF-8-safe first chunk with `isPartial`, `rangeStart`, `rangeEnd` and
`nextOffset`; viewers stream the rest with `files.readFileRange`. Larger images
and unsupported binaries return `contentOmitted`.

`readFileRange` uses byte offsets, clamps each request, and trims a non-final
UTF-8 chunk to a whole code point. Binary, image, PDF, audio, video, font,
TIFF/HEIC and Office ranges are base64 per range: decode each range on its own
and advance only by `nextOffset`.

## Office previews

`.xlsx`, `.pptx` and `.docx` preview natively from the Files tab, the Work
Files panel or a chat attachment:

- A sheet: a virtualized grid with the sheet's column letters, widths and
  number formats, sheet tabs, and a row × column count.
- A deck: a slide rail and a canvas from the deck's geometry, pictures and
  tables, an Outline view, and arrow keys scoped to the viewer.
- A document: a page at its own size and margins (Letter with 1" margins when
  it has none), headings, run formatting, lists, tables with merged cells,
  raster pictures, links, page breaks, an Outline rail, and Fit / 100% / zoom.
  Links open in ADE's browser (http, https, mailto only). An external picture
  is never fetched.

The readers (`viewers/office/`) cost nothing until a file opens:

- `fflate` and the parsers load by dynamic import, off the Files startup path.
- Only the central directory is held; each part inflates on demand, and the
  cap counts arriving bytes. One budget covers the whole package. Over 25 MB
  per file, 24 MB per entry, 64 MB of parts or 12 MB per image reports "too
  large" and shows the open-externally card.
- The model is bounded: 2,000 rows × 64 columns per sheet ("showing the first
  2,000 of 5,000 rows"); 300 slides, 120 shapes per slide, 50 × 20 table cells,
  200 outline lines per slide; 20,000 blocks or 2 million characters per
  document, 500 × 100 table cells, four levels of nested tables.
- Parsing yields to the event loop, and decompression uses fflate's worker
  where there is one.

`.doc`, `.xls` and `.ppt` are OLE2 files and stay on the fallback card, which
says so. The same signature marks an encrypted OOXML package. `.xlsm` and
`.pptm` do not route to the previews. What a preview does not draw is counted
("Not shown in this preview: 2 charts, 1 picture"). A formula with no cached
result shows the formula. The classification is in the renderer
(`v2/viewerRegistry.ts`); iOS has its own handling.

## Trust boundary

The preload bridge exposes `window.ade.files` and `window.ade.diff`; nothing
from `node:fs` or `node:path` reaches the renderer. Path resolution happens in
the runtime (or the main process on the fallback path) through
`resolvePathWithinRoot`, which refuses `..` escapes, null bytes and `.git`
internals. Remote runtimes apply the same rules on their host.

`files.openExternalPath` is local only. It registers a path the user opened
from the OS or dropped into the window. `external-local:*` ids are handled by
the local process even in a remote window, take no pin, and drop a supplied
one.

A pin from router state is untrusted input: `FilesTab` accepts only a
well-formed `OpenProjectBinding`.

## Gotchas

- The tree lists with `includeIgnored: true`, so dotfiles show, but volatile
  `.ade` paths (worktrees, cache, transcripts, secrets, the database) are
  filtered. Watcher refcounts are per mode: pair each start with its stop in
  the same mode. Search defaults to `includeIgnored: false`.
- While a machine pin is active, the workbench publishes **nothing** to the
  dirty-buffer map. The map is keyed by absolute path with no machine, and one
  person's two computers often share a path, so a local agent would read (and
  write back) the remote machine's unsaved text. After the pin clears,
  publishing waits until the roster is listed again for the tab's own machine.
- HTML preview is inert: `srcDoc` in an empty-sandbox iframe with a strict CSP
  and no referrer. Scripts, forms, navigation, downloads and remote fetches
  stay off; large HTML streams as large text.
- `listTree` and `listTreeChildren` must share filtering and order: skip
  `.git` and volatile `.ade` paths, honor `includeIgnored`, folders first, and
  page with `nextOffset`.
- Expanding a folder fetches one `TREE_PAGE_SIZE` (2,000) page and shows
  "Load more…" for the rest. Watcher refreshes re-list only the loaded window
  (`loadedDirectoryChildrenCount`). Path reveals page up to
  `REVEAL_MAX_CHILDREN`.
- The roster and tree caches (`v2/filesTreeCache.ts`) are bounded LRUs.
  Mounted workbenches pin their tree, and warm project eviction in `App.tsx`
  releases a project's caches. The cache holds tree structure only, never
  Monaco models, dirty buffers or tabs.
- Monaco models are reused per path and disposed on tab close, rename or
  delete, workspace switch or unmount. Do not dispose them on tab switches,
  theme changes, read-only toggles or group moves.
- `writeTextAtomic` needs write permission on the target's directory; without
  it the editor tab gets the error.
- Runtime-bound file calls are strict: a timeout or connection failure shows
  in the tab and never retries against the main process. A pinned call has no
  fallback at all.
- Files are freely editable on a computer: no "Enable editing" step and no
  edit-protection gate. `is_edit_protected` only governs lane deletion.
  `FilesWorkspace.isReadOnlyByDefault` is `false` on a computer and `true` only
  for an account-answered lane.
- Switching workspace is navigation, not a discard. Dirty tabs stay open and
  published under their own root.
- `listWorkspaces` failures retry with backoff (1 s, 2 s, 5 s, 10 s, then
  steady), so a Files tab opened before a remote runtime connects fills in.
  `WORKSPACE_LIST_RETRY_DELAYS_MS` holds the steps.
- Watcher subscriptions are per sender; closing a window calls
  `stopAllForSender`.
- Lane worktrees resolve through `laneService`, never straight from
  `.ade/worktrees/`. A lane deleted out of band leaves the list on the next
  refresh.
- Remote **Open in** uses SSH URLs. Do not spawn `code` on a remote path, and
  do not widen `openExternalUrl` to editor schemes.
- On an account-answered lane, do not enable New file or New folder and do not
  add "Report…" to the read-failure banner: the reader's sentences are the
  expected states, not bugs.

## Cross-links

- Lanes feed the workspace list: [../lanes/](../lanes/).
- **Open in** menus: [../lanes/](../lanes/) and
  [../terminals-and-sessions/](../terminals-and-sessions/).
- History on a lane with no computer awake: [../history/](../history/).
