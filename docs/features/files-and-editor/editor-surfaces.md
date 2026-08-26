# Editor Surfaces

Renderer surfaces that present the Files tab and embed Monaco editors for
edit, diff, and conflict-oriented file workflows.

## Main Entry: `FilesTab.tsx`

Path: `apps/desktop/src/renderer/components/files/FilesTab.tsx`

`FilesTab` is the shared entry point for the standalone Files route and the
embedded Work sidebar. It renders `FilesWorkbench` unconditionally.

It also reads the router state a chat click leaves behind and hands it down as
a single `FilesNavigationOpenRequest`: `openFilePath` / `laneId` /
`startLine` / `startColumn` as before, plus `openPathType: "directory"` (reveal
in the tree instead of opening an editor tab), `searchQuery` (open the search
panel with that query, for a name that matched several files), and `filesPin`
(the machine that owns the file). Router state is untrusted, so `filesPin` is
accepted only when it is genuinely an `OpenProjectBinding` — a `local` binding
must carry `displayName`, a `remote` one `targetId`, `projectId`, and
`runtimeName`, because the machine chip reads those unguarded.

## Workbench Shell: `FilesWorkbench.tsx`

Path: `apps/desktop/src/renderer/components/files/v2/FilesWorkbench.tsx`

`FilesWorkbench` owns the VS Code-style shell:

- the machine pin, and the Files API bound to it
- workspace resolution from `files.listWorkspaces()`
- cached root tree loading and git decorations (delegated to `useFilesTree`)
- the reusable `FilesExplorer` tree
- editor groups with preview and pinned tabs
- split editor groups and tab move/drop behavior
- the unified `FilesSearchPanel`, in the sidebar column and as a centred modal
- file and directory creation prompts
- context-menu actions for open, rename, delete, copy full/relative path,
  copy name, and reveal (`openPathInEditor` with `target: "finder"`).
  Lane/session **Open in** (detected VS Code / Zed / …) is a separate
  submenu — see [README.md](./README.md#opening-in-an-external-editor).
- status bar with branch, group, open-tab, dirty counts, and the active
  full path

The component accepts `preferredLaneId`, `embedded`, and `active`. The
`active` prop gates IPC loading and keybindings for inactive project tabs.
`preferredLaneId` selects a lane workspace when Files is mounted from Work.
`embedded` compacts the Work-sidebar mount without introducing a separate
implementation path.

### Machine pin and the bound Files API

`machinePin` is the machine this workbench is reading from when that is *not*
the machine the project tab is bound to. It is set by a navigation request that
came from a chat on another machine and cleared by **Back to this computer** or
by picking a workspace from the bound machine. Everything downstream keys off
`projectBinding = machinePin ?? boundProjectBinding` and
`projectRootPath = machinePin?.rootPath ?? boundProjectRootPath`, so the
workspace roster, the tree caches, and every read and write follow the pin
without the window rebinding.

`createPinnedFilesApi(machinePin)` (`v2/pinnedFilesApi.ts`) produces the Files
API with that machine already attached, cached per binding key so its identity
changes exactly when the machine does. That object — not `window.ade.files` —
is what `useFilesTree`, `EditorGroups`, `EditorGroup`, `ViewerHost`,
`useFileContent`, `streamFileBytes`, and every viewer receive. Viewers **must**
use it: a workspace id is a lane id, lane rows sync across machines, so an
unpinned read or write resolves the local worktree for that lane and silently
succeeds against the wrong disk.

Two consequences worth remembering:

- The workbench publishes nothing into the dirty-buffer map while pinned (that
  map is machine-less and feeds local agent reads), and resumes only once the
  roster has been re-listed for the bound machine.
- Roster and tree caches written under a pinned cache key are released on
  unpin, in a `queueMicrotask` so the release lands after `useFilesTree`'s
  `unpinCachedTree` cleanup — `filesTreeCache` refuses to release a still-pinned
  entry. `App.tsx` cannot do this itself: it derives cache keys from a
  surface's own binding and never sees a key produced by a pin chosen in here.

### Tree state: `useFilesTree`

`v2/useFilesTree.ts` owns tree state, root listing, directory paging,
expansion, and git decorations — the one genuinely closed unit in the
workbench, driven by (workspace, machine) alone. It also owns the per-path
serialization queue that keeps a watcher refresh from shrinking a window a
load-more just grew, and the `decorationsTruncated` flag behind the "Some git
decorations hidden" strip.

The file watcher deliberately did **not** move with it: that effect refreshes
the tree *and* reloads open editor tabs, so it is coordination between two
layers rather than part of either. Callback identities in the hook are
preserved exactly as they were inline, because the watcher subscription is
keyed on them — a widened dependency there costs a real chokidar tear-down and
re-subscribe, not just a re-render.

Module-level caches in `v2/filesTreeCache.ts` keep workspaces and root
trees warm across route remounts. Both are keyed by the **binding
identity** — `filesProjectCacheKey` joins a `bindingKey` of `local` or
`remote:<targetId>` to the project root path as
`"<bindingKey>::<projectRoot>"` — so a local session and a remote
session for the same on-disk path never pollute each other's cached
workspace list or tree:

- the workspace roster cache, keyed by `projectCacheKey` (bounded LRU)
- the explorer tree cache, keyed by `projectCacheKey::workspaceId`
  (node/byte-accounted LRU; mounted workbenches pin their rendered tree
  and warm-project-surface eviction releases a project's entries)

Editor state is kept per `filesSessionKey(projectRoot, laneId)` through
`useEditorGroupsStore`. Editor sessions are keyed by project root
(not binding), so open tabs and dirty buffers survive a local↔remote
rebind of the same path; the tab workspace-remap pass (below) repairs
any stale workspace ids the rebind leaves behind.

`files.listWorkspaces()` is retried on failure with a capped backoff
(`1s → 2s → 5s → 10s`, then steady at 10s) instead of being swallowed,
so a Files tab opened before a remote runtime finishes connecting
recovers its workspace list on its own once the host answers.

### Restored-tab workspace remap

Restored tabs carry the `workspaceId` they were persisted with, but
those ids are not portable across binding identities: connecting to a
remote host lists workspaces whose ids are the **host machine's** lane
UUIDs, so a locally-persisted tab's `workspaceId` is stale against the
freshly listed set. After every successful `listWorkspaces`, the
workbench calls `store.remapTabWorkspaces(sessionKey, mapper)`. The
mapper keeps any tab whose `workspaceId` is still present (or is an
`external-local:*` id — those are local-only and deliberately
untouched) and otherwise remaps by `laneId` to the matching host
workspace, falling back to the primary workspace (or the first host
workspace). Composite tab ids (`workspaceId::path`) are recomputed;
collisions with an authoritative tab dedupe to the authoritative copy;
`activeTabId` and `recentTabIds` are rewritten to the surviving ids.
The workbench then migrates the live editor state to the new ids:
Monaco models are moved with `registry.rekey`, and the dirty-tab set,
per-tab reload tokens, and dirty-buffer revision follow the remap.

## Workspace Selector

The standalone route renders `WorkspacePicker`; embedded Work Files omits the
picker chrome and preselects the active lane worktree. Switching workspaces:

1. Resolves the new workspace id.
2. Loads the root tree and git decorations.
3. Switches the editor-group session key.
4. Leaves file service and preload contracts unchanged.

The main-process file service remains the source of truth for path
safety and workspace roots. There is no read-only / view-only workspace
policy: every resolved workspace is editable, and whether a tab shows
editable Monaco is decided purely by viewer capability plus payload
(`viewerRegistry.tabIsTextEditable`): code, markdown Source, and CSV
Source tabs edit whenever the full text payload loaded; image/pdf/
large-text/binary viewers are naturally read-only, and a partial
streamed payload stays read-only so a truncated buffer can never be
saved back.

## File Explorer Tree

Implementation: `FilesExplorer.tsx` over `FileTreeNode[]` from
`files.listTree`.

Lazy loading uses `files.listTreeChildren` when a directory is expanded,
following `nextOffset` until all children are loaded or the renderer hits its
safety cap. `listTree` and `listTreeChildren` share filtering and ordering:
volatile `.ade` runtime paths and `.git` are hidden, ignored files respect
`includeIgnored`, and directories sort before files.

Visual indicators per node:

- file icons by extension via `filePresentation.tsx`
- change status coloring from git decorations
- directory change dots for descendants with changes

Context-menu actions are built in `FilesWorkbench` and rendered by
`v2/ContextMenu.tsx`. The menu clamps to the viewport before opening.

The explorer owns the search *field* but not the search: it renders whatever
the workbench passes as `searchResults` in place of the tree while the query is
non-empty, and skips its own flatten/filter pass entirely. The old
`onOpenQuickOpen` / `onOpenContentSearch` / `onSearchSubmit` /
`singleRowHeader` props are gone along with the separate Quick Open and Content
Search buttons.

## Editor Groups

Implementation:

- `v2/editorGroupsStore.ts` for immutable group/tab operations
- `v2/EditorGroups.tsx` for the group grid
- `v2/EditorGroup.tsx` for one group, tab strip, diff toggle, and active tab
- `v2/ViewerHost.tsx` for resolving and rendering the active viewer

Tabs can be preview or pinned. Opening a file from single click creates or
reuses a preview tab; activation/edit/save promotes it. Tabs can be closed,
closed-other-tabs, split into a new group, or moved between groups by drag.

The active group's active tab is the status-bar source for path, language,
branch, and dirty state.

## Monaco Model Lifecycle

`monacoModelRegistry.ts` keeps one Monaco text model per
workspace-relative path. Switching tabs calls `editor.setModel(existing)`
instead of dispose/recreate, preserving tokenization and undo stacks.

Callers dispose models on tab close, rename/delete cleanup, workspace switch,
and unmount. Do not dispose models on tab switch, theme change, or group move.

`registry.rekey(oldKey, newKey)` moves a cached model to a new tab id in
place so the live buffer, undo stack, and dirty baseline follow a tab-id
remap (see the restored-tab workspace remap above) instead of being
disposed and reloaded. On a key collision the dirty buffer wins: if the
incoming entry has unsaved edits and the resident one does not, the
resident is disposed and replaced; otherwise the incoming entry is
discarded.

Dirty tracking is based on Monaco alternative version ids. A save writes
through the files write bridge, updates the model baseline, invalidates the
content cache, and refreshes git decorations. Every editable-viewer tab is
saveable — the save button and the `Cmd+S` / `Ctrl+S` handler are gated on
`viewerIsEditable(viewerKind)` (code, markdown Source, and CSV Source),
not on `viewerKind === "code"`. When no mounted editor API is present the
fallback save path only writes a *dirty* model: a clean parked model may be
stale (external edits reload the tab content, not the model), so saving a
clean tab must never revert an external change. The group-level save handler
also catches `Cmd+S` / `Ctrl+S` while a code tab is in diff mode, saving the
hidden Monaco model without forcing the user back to edit mode.

## Viewers

Viewer selection lives in `v2/viewerRegistry.ts`. The shell can force special
viewer kinds such as `diff` or `conflict`; normal file viewers are selected
from path extension and file metadata.

Supported viewers:

- `CodeViewer` for editable text and Monaco-backed source files
- `MarkdownViewer` — Preview↔Source toggle; Source mounts the editable
  `CodeViewer`, and Preview renders the dirty buffer only when the tab has
  unsaved edits (otherwise the authoritative file payload)
- `ImageViewer`
- `MediaViewer` for audio/video files Chromium can play, with a renderer-side
  size cap before it builds a Blob URL
- `CsvViewer` — virtualized sortable/filterable table with a Table↔Source
  toggle; Source is offered only when the payload round-trips as text
  (`!readOnly`), so a partial streamed CSV stays a read-only table
- `PdfViewer`
- `LargeTextViewer` for streamed large text
- `DocumentViewer` for Office-style documents; it shows type/path metadata
  and opens the file in the OS default app for full editing/viewing
- `BinaryViewer`
- `DiffViewer`, backed by `window.ade.diff` and `AdeDiffViewer`

Large text and media/document previews use `readFileRange` for follow-up
chunks, through the `PinnedFilesApi` on `ViewerProps.files` rather than
`window.ade.files` — a viewer that reaches for the global would read the wrong
machine's disk whenever a pin is active. Unsupported binary content remains
non-editable.

## Search Panel And Create Prompt

`v2/FilesSearchPanel.tsx` is the only Files search surface. One component,
two variants:

- `variant="sidebar"` — rendered into `FilesExplorer`'s `searchResults` slot,
  driven by the search field in the explorer header. Keys are handled by a
  document listener reading a ref-backed snapshot, because the field lives
  outside the panel's subtree. It stays open after an open, so several hits can
  be opened in a row.
- `variant="overlay"` — the centred modal, with its own focused input. It is a
  one-shot pick and dismisses on open; every exit clears the shared query, so
  the search does not keep running behind a closed modal.

Both mounts share the workbench's `searchQuery`, and the sidebar copy is
suppressed while the modal is open so the same workspace is never searched
twice. Both are handed the workbench's `machinePin`, so searching a pinned
machine's workspace runs on that machine.

Names (`quickOpen`, 120 ms debounce) and contents (`searchText`, 250 ms
debounce) are independent requests; the panel also owns the persisted
"Include ignored files" toggle. See
[README.md](./README.md#the-search-ui) for the full behaviour.

`v2/overlays.tsx` now holds only `CreatePromptModal` (new file / new directory
prompts) and re-exports the shared `Backdrop` / panel surface from
`FilesSearchPanel`.

`Cmd+P` / `Ctrl+P` and `Cmd+Shift+F` / `Ctrl+Shift+F` both open the search
modal. File hits open directly; content hits call `setPendingReveal` so the
next `CodeViewer` mount jumps to the matching line.

## Embedded Files In Work

`WorkSidebar` mounts `FilesTab` with `preferredLaneId={laneId}`,
`embedded={true}`, and `pin={runtimePin}`. The embedded layout keeps the same
service calls, editor groups, viewers, tree behavior, and search as the
standalone route, but uses a narrower explorer column, compact explorer
controls, and no workspace picker.

`FilesTab` / `FilesWorkbench` take an optional `pin` — the machine the files
live on, for hosts that already know it is not this tab's machine (the Work
tools pane, following its chat). Null keeps the historical behavior: the tab's
bound machine. The prop seeds `FilesWorkbench`'s `machinePin` state, and a
host-supplied pin wins whenever it changes; identity is compared by binding key
so an equal binding rebuilt each render does not thrash the roster. Navigation
requests still repin as they did before — the prop only supplies the starting
machine.

The embedded mount is also the **only** listener on the
`v2/filesOpenRequests.ts` channel: a filename clicked in a chat on this machine,
in that chat's own lane, opens here next to the conversation rather than
throwing the user into the Files tab. `TerminalsPage` subscribes separately just
to switch the Work sidebar to Files — the request itself waits in the channel
until this workbench mounts and drains it, and the mount that takes it clears
the channel's hold so a later mount cannot replay it. Everything else (another
lane, another machine, a chat outside `/work`) routes to the Files tab through
router state instead, so the destination stays deep-linkable.

The embedded mount shares Work's right-edge sidebar. Keep context menus,
overlays, and editor controls clamped to the renderer viewport so they remain
usable in the narrower column.

## Keyboard Shortcuts

Registered through the global keybinding service
(`apps/desktop/src/main/services/keybindings/`) and Files-local handlers:

| Shortcut | Action |
|---|---|
| `Cmd+S` / `Ctrl+S` | save |
| `Cmd+P` / `Ctrl+P` | search/open |
| `Cmd+Shift+F` / `Ctrl+Shift+F` | search/open |
| `Cmd+W` / `Ctrl+W` | close current tab |
| `Cmd+Tab` / `Ctrl+Tab` | next tab |
| `Cmd+\` / `Ctrl+\` | toggle file explorer |
| `Cmd+Shift+E` | focus file explorer |
| `F2` | rename in explorer |

## Gotchas

- **External change plus dirty tab.** File watcher events must not overwrite
  unsaved Monaco models. Surface the external change and require an explicit
  user choice.
- **Primary checkout writes.** The primary repo root and lane worktrees are
  freely editable — there is no edit-protection gate on file writes. Path-safety
  and trust policy is still enforced by the file service and preload boundary;
  renderer affordances are only presentation.
- **Large files.** Oversized text opens as read-only streamed content. Do not
  force large files through the editable Monaco viewer. Media playback has a
  fixed byte cap so large videos are handed off instead of loaded into
  renderer memory.
- **Session warmth.** Editor group order lives in renderer memory for the
  session key. Recent files are persisted in local storage per session key,
  bounded to the warm empty-state list, and pruned on rename/delete/tree
  refresh so stale root-level paths do not linger.

## Cross-Links

- Main-process services and watcher:
  [file-watcher-and-trust.md](./file-watcher-and-trust.md)
- Files tab entry from the app shell:
  `apps/desktop/src/renderer/components/app/App.tsx`
- Conflict resolution data: `apps/desktop/src/main/services/conflicts/`
- Diff data: `apps/desktop/src/main/services/diffs/`
