# Editor Surfaces

Renderer surfaces that present the Files tab and embed Monaco editors for
edit, diff, and conflict-oriented file workflows.

## Main Entry: `FilesTab.tsx`

Path: `apps/desktop/src/renderer/components/files/FilesTab.tsx`

`FilesTab` is the shared entry point for the standalone Files route and the
embedded Work sidebar. It renders `FilesWorkbench` unconditionally.

## Workbench Shell: `FilesWorkbench.tsx`

Path: `apps/desktop/src/renderer/components/files/v2/FilesWorkbench.tsx`

`FilesWorkbench` owns the VS Code-style shell:

- workspace resolution from `files.listWorkspaces()`
- cached root tree loading and git decorations
- the reusable `FilesExplorer` tree
- editor groups with preview and pinned tabs
- split editor groups and tab move/drop behavior
- unified quick-open and content-search overlay
- file and directory creation prompts
- context-menu actions for open, rename, delete, copy full/relative path,
  copy name, and reveal
- status bar with branch, group, open-tab, dirty counts, and the active
  full path

The component accepts `preferredLaneId`, `embedded`, and `active`. The
`active` prop gates IPC loading and keybindings for inactive project tabs.
`preferredLaneId` selects a lane workspace when Files is mounted from Work.
`embedded` compacts the Work-sidebar mount without introducing a separate
implementation path.

Module-level caches keep workspaces and root trees warm across route
remounts. Both are keyed by the **binding identity** — a `bindingKey`
of `local` or `remote:<targetId>` joined to the project root path as
`projectCacheKey = "<bindingKey>::<projectRoot>"` — so a local session
and a remote session for the same on-disk path never pollute each
other's cached workspace list or tree:

- `workspacesCacheByProject` keyed by `projectCacheKey`
- `rootTreeCacheByKey` keyed by `projectCacheKey::workspaceId`

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
safety, trust checks, and workspace roots. There is no read-only /
view-only workspace policy: every resolved workspace is editable, and
whether a tab shows editable Monaco is decided purely by viewer kind
(code tabs edit; image/pdf/large-text viewers are naturally read-only).

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
content cache, and refreshes git decorations. Every `code`-viewer tab is
saveable — the save button and the `Cmd+S` / `Ctrl+S` handler are gated on
`viewerKind === "code"` alone, with no editability check. The group-level
save handler also catches `Cmd+S` / `Ctrl+S` while a code tab is in diff
mode, saving the hidden Monaco model without forcing the user back to edit
mode.

## Viewers

Viewer selection lives in `v2/viewerRegistry.ts`. The shell can force special
viewer kinds such as `diff` or `conflict`; normal file viewers are selected
from path extension and file metadata.

Supported viewers:

- `CodeViewer` for editable text and Monaco-backed source files
- `MarkdownViewer`
- `ImageViewer`
- `MediaViewer` for audio/video files Chromium can play, with a renderer-side
  size cap before it builds a Blob URL
- `CsvViewer`
- `PdfViewer`
- `LargeTextViewer` for streamed large text
- `DocumentViewer` for Office-style documents; it shows type/path metadata
  and opens the file in the OS default app for full editing/viewing
- `BinaryViewer`
- `DiffViewer`, backed by `window.ade.diff` and `AdeDiffViewer`

Large text and media/document previews use `readFileRange` for follow-up
chunks. Unsupported binary content remains non-editable.

## Search And Create Overlays

`v2/overlays.tsx` provides:

- `SearchOverlay`, a unified quick-open plus text-search surface
- `CreatePromptModal` for new file and new directory prompts

`Cmd+P` / `Ctrl+P` and `Cmd+Shift+F` / `Ctrl+Shift+F` both open the search
overlay. File hits open directly; content hits call `setPendingReveal` so the
next `CodeViewer` mount jumps to the matching line.

## Embedded Files In Work

`WorkSidebar` mounts `FilesTab` with `preferredLaneId={laneId}` and
`embedded={true}`. The embedded layout keeps the same service calls, editor
groups, viewers, and tree behavior as the standalone route, but uses a
narrower explorer column and compact explorer controls.

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
