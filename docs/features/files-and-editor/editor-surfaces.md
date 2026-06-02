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
- context-menu actions for open, rename, delete, copy path, and reveal
- status bar with branch, group, open-tab, and dirty counts

The component accepts `preferredLaneId`, `embedded`, and `active`. The
`active` prop gates IPC loading and keybindings for inactive project tabs.
`preferredLaneId` selects a lane workspace when Files is mounted from Work.
`embedded` compacts the Work-sidebar mount without introducing a separate
implementation path.

Module-level caches keep workspaces and root trees warm across route
remounts:

- `workspacesCacheByProject` keyed by project root
- `rootTreeCacheByKey` keyed by `projectRoot::workspaceId`

Editor state is kept per `filesSessionKey(projectRoot, laneId)` through
`useEditorGroupsStore`.

## Workspace Selector

The standalone route renders `WorkspacePicker`; embedded Work Files omits the
picker chrome and preselects the active lane worktree. Switching workspaces:

1. Resolves the new workspace id.
2. Loads the root tree and git decorations.
3. Switches the editor-group session key.
4. Leaves file service and preload contracts unchanged.

The main-process file service remains the source of truth for read-only
policy, trust checks, and workspace roots.

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
and unmount. Do not dispose models on tab switch, theme change, read-only
toggle, or group move.

Dirty tracking is based on Monaco alternative version ids. A save writes
through `files.writeTextAtomic`, updates the model baseline, invalidates the
content cache, and refreshes git decorations.

## Viewers

Viewer selection lives in `v2/viewerRegistry.ts`. The shell can force special
viewer kinds such as `diff` or `conflict`; normal file viewers are selected
from path extension and file metadata.

Supported viewers:

- `CodeViewer` for editable text and Monaco-backed source files
- `MarkdownViewer`
- `ImageViewer`
- `CsvViewer`
- `PdfViewer`
- `LargeTextViewer` for streamed large text
- `BinaryViewer`
- `DiffViewer`, backed by `window.ade.diff` and `AdeDiffViewer`

Large text uses `readFileRange` for follow-up chunks. Unsupported binary
content remains non-editable.

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
- **Primary checkout writes.** Read-only and primary-workspace policy is
  enforced by the file service and preload boundary; renderer affordances are
  only presentation.
- **Large files.** Oversized text opens as read-only streamed content. Do not
  force large files through the editable Monaco viewer.
- **Tab ordering.** Editor group order lives in renderer memory for the
  session key. Persisting it across full reloads belongs to future
  editor-state work.

## Cross-Links

- Main-process services and watcher:
  [file-watcher-and-trust.md](./file-watcher-and-trust.md)
- Files tab entry from the app shell:
  `apps/desktop/src/renderer/components/app/App.tsx`
- Conflict resolution data: `apps/desktop/src/main/services/conflicts/`
- Diff data: `apps/desktop/src/main/services/diffs/`
