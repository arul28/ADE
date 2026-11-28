# Files and Editor

An IDE-style file explorer and Monaco editor: workspace selection, atomic
writes, reference-counted file watching, Monaco model reuse, streamed
large-file previews, document viewers, and diff and conflict modes. Chat links
open files in it, and lanes show their files through it.

Detail docs:

- [file-watcher-and-trust.md](./file-watcher-and-trust.md): the watcher, path safety, the preload trust boundary, external-change sync.
- [editor-surfaces.md](./editor-surfaces.md): Monaco host, tabs, diff and conflict views, search panel, shortcuts, context menu.

## Source file map

Paths are under `apps/desktop/src/`. Runtime services are the real
implementation; `main/services/files/` also serves the legacy IPC fallback.

| File | Owns |
|---|---|
| `main/services/files/fileService.ts` | Listing and paged children, git decorations, reads and range reads, blame, atomic writes, quick open, content search, path safety. |
| `main/services/files/fileSearchIndexService.ts` | The file-**name** index, the opt-in directory map, two-tier content search. |
| `main/services/files/fileWatcherService.ts`, `fileWatchLedger.ts`, `main/services/shared/treeWatcher.ts` | Ref-counted watchers per sender, the ledger of outstanding watches, `watchTree`. |
| `main/services/files/externalFilesWorkspaceRegistry.ts` | Local-only registry of files and folders opened from the OS or dropped in. |
| `main/services/diffs/`, `main/services/conflicts/conflictService.ts` | Diff mode; 3-way merge data. |
| `main/services/editors/` (`editorDetection.ts`, `openPathInEditor.ts`, `editorProcessEnv.ts`, `editorWindowsInstall.ts`) | External editor detection and launch. |
| `main/services/lanes/laneService.ts` | `getFilesWorkspaces`, `resolveWorkspaceById`. |
| `main/services/ipc/runtimeBridge.ts`, `remoteRuntime/runtimeRpcClient.ts`, `localRuntime/localRuntimeConnectionPool.ts` | Runtime routing and event streams for file actions. |
| `shared/adeCloud/accountReader.ts`, `shared/adeCloud/binding.ts`, `shared/github/directClient.ts` | File reads from GitHub with no computer awake. |
| `shared/types/files.ts`, `shared/editorTargets.ts`, `shared/types/git.ts` | File DTOs, editor catalog and Open-in resolution, diff shapes. |
| `preload/preload.ts` | `window.ade.files` and `window.ade.diff`; every `files` method except `openExternalPath` takes a trailing pin (`callPinnedFileActionOr`). |

Renderer (`renderer/components/files/`):

| File | Owns |
|---|---|
| `FilesTab.tsx` | Route entry; validates router state (`openPathType`, `searchQuery`, `filesPin` only if a well-formed `OpenProjectBinding`). |
| `v2/FilesWorkbench.tsx` | The shell: chrome, explorer, editor groups, Monaco host, diff/conflict, search, viewers, the machine pin, dirty-buffer publishing. Embeds in the Work tools pane (`embedded`, one surface under 520 px). |
| `v2/pinnedFilesApi.ts` | `createPinnedFilesApi(pin)`, the Files API bound to one machine. Nothing under the workbench calls `window.ade.files` directly. |
| `v2/useFilesTree.ts`, `FilesExplorer.tsx`, `treeHelpers.ts`, `v2/filesTreeCache.ts` | Explorer tree, virtualized list, tree helpers, bounded caches. |
| `v2/FilesSearchPanel.tsx` | The one search surface. |
| `v2/filesOpenRequests.ts` | One-shot "open in the Work tools-pane Files panel". |
| `v2/monacoLoader.ts`, `monacoModelRegistry.ts` | Monaco init and themes; model lifetime. |
| `v2/viewerRegistry.ts`, `v2/viewers/` (incl. `office/`, `OoxmlPreviewShell.tsx`) | Viewer choice, `tabIsTextEditable`, the viewers (code, markdown, HTML, image, Mermaid, font, media, CSV, PDF, Office, large text, binary, diff). |
| `v2/useFileContent.ts` | Cache-first open with revalidation. |
| `renderer/components/shared/AdeDiffViewer.tsx`, `diffWhitespace.ts` | Read-only diff chrome (also in Lanes, chat and PRs). |
| `renderer/components/ui/OpenInSubmenu.tsx` | The shared **Open in** submenu. |
| `renderer/components/chat/chatWorkspacePaths.tsx`, `terminals/terminalPathLinks.ts` | Opening a path from chat, tool rows or terminals. |

iOS: `apps/ios/ADE/Views/Files/` (`FilesRootScreen.swift`,
`FilesSearchScreen.swift`, `FilesDetailScreen.swift`).

## Gotchas

- **The tree lists with `includeIgnored: true`** (dotfiles show) but filters volatile `.ade` paths. Search defaults to `includeIgnored: false`. Watcher refcounts are per mode: pair each start with its stop in the same mode.
- **While a machine pin is active, the workbench publishes nothing to the dirty-buffer map.** The map is keyed by absolute path with no machine, and one person's computers often share paths, so a local agent would read (and write back) another machine's unsaved text.
- **HTML preview is inert**: `srcDoc` in an empty-sandbox iframe with a strict CSP; no scripts, forms, navigation or fetches.
- **`listTree` and `listTreeChildren` share filtering and order** (skip `.git` and volatile `.ade`, folders first, page with `nextOffset`). A folder loads one 2,000-entry page (`TREE_PAGE_SIZE`) with "Load more…".
- **Monaco models are reused per path** and disposed only on close, rename/delete, workspace switch or unmount; never on tab switch, theme change or group move.
- **Runtime-bound file calls are strict**: a failure shows in the tab and never retries against the main process. A pinned call has no fallback.
- **Files are freely editable on a computer.** `is_edit_protected` governs only lane deletion. `isReadOnlyByDefault` is `true` only for an account-answered lane.
- **Switching workspace is navigation, not a discard.** Dirty tabs stay open.
- **`listWorkspaces` retries** (`WORKSPACE_LIST_RETRY_DELAYS_MS`: 1, 2, 5, 10 s, then steady), so a tab opened before a remote runtime connects fills in.
- **Lane worktrees resolve through `laneService`**, never straight from `.ade/worktrees/`.
- **Remote Open in uses SSH URLs.** Do not spawn `code` on a remote path or widen `openExternalUrl` to editor schemes.

## Where this runs

Listing, writes, the name index, content search and the watcher run in the
window's active runtime (local daemon or remote runtime); Monaco runs only in
the renderer. Every byte goes through `window.ade.files.*`: the remote route,
then the strict local-runtime route; legacy IPC answers only with no runtime
route. Watcher events arrive on the runtime event stream. A remote window
browses and edits the remote worktree.

## Which machine answers a file call

A file lives on the machine that owns the lane. Every `window.ade.files.*`
method takes an optional trailing machine pin:

- **Absent or `null`**: the tab's machine, with the project-transition guard.
- **A binding**: that machine; no transition guard and no local IPC fallback.

Reads and writes follow the pin, so a file of a chat on another machine opens
fully editable without rebinding the window. Exceptions: `openExternalPath`
takes no pin, and `external-local:*` workspaces drop one.

A workspace id is a lane id, and lane ids sync, so an unpinned write while the
workbench shows another machine would silently write here. The renderer binds
the machine once in `pinnedFilesApi.ts` and passes the object down; its
identity changes exactly when the machine does, so the watcher unsubscribes
from the old machine first. Do not replace it with a ref.

The workspace picker groups lanes by machine; picking another machine's lane
pins the workbench without rebinding the tab, with a machine chip and a way
back.

## With no computer awake

A DAEX Cloud tab, or a pin of a cloud computer this window has no connection
to (`cloud-saved:<machineKey>`), is an **account-answered pin**
(`isAccountAnsweredPin`). Its file calls go to the account reader, so a read
never wakes a computer:

- Tree and contents come from GitHub at the lane's branch through the account's GitHub App sign-in.
- Every workspace is read-only; New file / New folder explain that waking the computer allows changes.
- A read failure shows the reader's sentence (`githubReadSentence`: connect GitHub, no branch on GitHub yet, non-GitHub repo) with Refresh and no "Report…".
- Writes, search and the watcher are not answered. Any "do" action wakes the computer and moves the pin back.

## Workspace model

| Kind | Source | Notes |
|---|---|---|
| `primary` | Repository root | Always present. |
| `worktree` | `.ade/worktrees/<lane>` | One per active lane. |
| `attached` | A linked path | External worktrees. |
| `external` | An OS open or drop | Local only, `external-local:<hash>` ids. |

The workbench keeps one project-level editor session; tab ids include
`workspaceId` and path. Workspace and tree caches are keyed by
`bindingKey::projectRoot`; editor sessions by project root, so a local↔remote
rebind keeps tabs and dirty buffers. `remapTabWorkspaces` repairs stale tab
workspace ids after each `listWorkspaces`.

## Editor modes

- **Edit**: Monaco; Cmd+S saves atomically. Markdown opens Preview↔Source, CSV/TSV Table↔Source (Source only for a complete payload). A tab is read-only only for partial large text, binary, an account-answered lane, or a real write failure.
- **Diff**: `AdeDiffViewer` over `diffService`; editable working-tree diffs use `MonacoDiffView`. Scopes **Branch**, **Uncommitted**, **Staged**, or a commit.
- **Conflict**: 3-way merge with Accept Ours / Theirs / Both through `conflictService`.

**Branch scope** is what the lane committed since its compare base:
merge-base(base, HEAD) against HEAD (`diffService.getBranchChanges`).
Uncommitted edits are separate modes. A base that does not resolve is an
error, never an empty diff. Clients offer Branch only after the host answers
`getBranchChanges`. CLI: `daex diff changes --lane <id> --mode branch --text`.

**Atomic saves.** `writeTextAtomic` writes a temp file beside the target and
renames it over, so a dev server never sees a partial file. Both writers go
through `resolvePathWithinRoot`: nothing outside the root, nothing into `.git`.

## File watching

One tree watcher per `workspaceId + senderId`, with a default profile
(ignores `.git/`, `node_modules/`, `.ade/`) and an include-ignored profile
(ignores `.git/`). It closes 15 s after its last reference. Events are
debounced per file (140 ms). macOS and Windows use one recursive native watch
per root; do not switch to chokidar's native mode, which opens a watch per
directory and blocks the event loop on close. Details:
[file-watcher-and-trust.md](./file-watcher-and-trust.md).

In the renderer: a clean open tab reloads on change, a dirty one does not;
dirty buffers are published so agent reads see unsaved text; `origin: "self"`
events are ignored; a pathless event queues a full refresh (≤ 1 per 5 s); a
plain `modified` refreshes decorations only.

## Quick open and content search

`fileSearchIndexService.ts` keeps file paths per `workspaceId::mode`, built
lazily and updated from watcher events. It is a **name** index (path, size,
mtime); never keep contents in it.

- `quickOpen` scores the index. An empty query is a valid browse (shallowest first); the composer `@` menu, iOS and web rely on it, so do not add empty-query guards. Folders are a separate opt-in map (`includeDirectories: true`, used only by the composer).
- `searchText` tier 1 is `git grep` inside a git work tree (`-F -i -I -n -z --untracked`, stops at `limit`, 10 s timeout). Tier 2 is a streaming JS scan over the name index (skips files over 1 MB or with a NUL byte), used for non-git folders or when git did not finish. `GitGrepOutcome` `unusable` retires tier 1 for the workspace until the index is invalidated.
- The tiers can differ: `git grep` also searches large and tracked-but-ignored files and does not enter submodules.

## The search UI

`v2/FilesSearchPanel.tsx` serves the explorer sidebar, the centred modal and
the Work tools pane; only one of sidebar and modal is live. Names
(`quickOpen`, 120 ms, 30) and contents (`searchText`, 250 ms, 300) are separate
debounced requests; content results never clear what is on screen. **Include
ignored files** persists globally (`ade.files.search.includeIgnored`).

## Opening a file from a chat or elsewhere

`chatWorkspacePaths.tsx` resolves a path an agent wrote:

- Same machine and the chat's own lane: the Work tools-pane Files panel (`filesOpenRequests.ts`).
- Anything else: the Files tab through router state, with a foreign machine as `filesPin`.
- `probeWorkspacePath` checks the name index first: a bare name resolves (several matches open search), a folder is revealed, a path outside the project shows a toast. The index is stale by design, so a miss on a path with `/` still opens and lets the real read error speak.

Absolute paths resolve to the deepest workspace root; relative paths by their
ending. Terminal paths become links only under the pointer
(`terminalPathLinks.ts`), after checking the file exists; network paths never
link.

## Opening in an external editor

**Open in** (lane and session menus) names a target from `EDITOR_TARGETS`
(`shared/editorTargets.ts`); detection and launch run in main.

- `editorDetection.ts`: `open -Ra` on macOS, else `which` / `where.exe`; on Windows a miss falls through to `editorWindowsInstall.ts` (read-only Program Files and registry lookup, 5-minute cache, never launches or elevates).
- `openPathInEditor.ts`: local `open -a` or a CLI spawn; `default` uses `shell.openPath`, `finder` `shell.showItemInFolder`. IPC `ade.app.getInstalledEditors` / `ade.app.openPathInEditor` require a local `rootPath` under a known workspace.
- **Remote is SSH only**: VS Code family `<scheme>://vscode-remote/ssh-remote+<host><path>`, Zed `zed://ssh/<host><path>`. `isRemoteEditorOpenRequest` needs a hostname and `transport !== "paired"`, so a paired remote gets no submenu. `openEditorExternalUrl` (`apps/ade-cli/src/lib/externalLinks.ts`) accepts only those URLs.
- Personal chats never mount **Open in**.

## Git status overlay

Tree listings carry `changeStatus` from one `git status --porcelain=v2`,
cached 5 s per root. The first paint does not wait: `refreshGitDecorations`
applies statuses and directory rollups after the tree loads. The response is
bounded (20,000 entries, ~2 MiB; shallowest first), because one oversized RPC
payload kills the desktop↔brain socket; a truncated set shows "Some git
decorations hidden (large change set)".

## Cache-first open, then revalidate

`useFileContent.ts` keeps an LRU of 48 initial `readFile` payloads. A hit
paints at once, then `revalidateOpenedFile` swaps the viewer only if the bytes
differ. A dirty tab is skipped before and after the read, so unsaved edits are
never dropped; a failed read does not prime the cache.

## Large-file and range reads

`files.readFile` returns inline text up to 1 MB, images up to 1 MB, and small
binaries up to 256 KB. Larger text returns a UTF-8-safe first chunk with
`isPartial` and `nextOffset`; viewers stream the rest with
`files.readFileRange` (byte offsets, clamped; binary formats are base64 per
range, so decode each range alone and advance only by `nextOffset`). Larger
images and binaries return `contentOmitted`.

## Office previews

`.xlsx`, `.pptx` and `.docx` preview natively (sheet grid, slide rail and
canvas, paginated document with outline). Readers in `v2/viewers/office/` load
by dynamic import, inflate parts on demand under one budget (25 MB per file,
24 MB per entry, 64 MB of parts, 12 MB per image), cap the model (2,000 × 64
cells per sheet, 300 slides, 20,000 blocks per document), and yield while
parsing. External pictures are never fetched; links open in DAEX's browser
(http, https, mailto). `.doc` / `.xls` / `.ppt` (OLE2) and encrypted packages
show the open-externally card. What a preview cannot draw is counted.

## Trust boundary

Nothing from `node:fs` or `node:path` reaches the renderer. Paths resolve in
the runtime through `resolvePathWithinRoot` (refuses `..`, null bytes, `.git`).
`files.openExternalPath` is local only and takes no pin. A pin from router
state is untrusted: `FilesTab` accepts only a well-formed `OpenProjectBinding`.
See [file-watcher-and-trust.md](./file-watcher-and-trust.md).
