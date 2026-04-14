# Editor Surfaces

Renderer surfaces that present the Files tab and embed Monaco editors
for edit, diff, and conflict modes.

## Main entry: `FilesPage.tsx`

Path: `apps/desktop/src/renderer/components/files/FilesPage.tsx`

A single large component (~2,570 lines) that owns:

- workspace selection (dropdown synced to `laneService` workspaces)
- file explorer tree with lazy loading, context menu, and drag/drop
  placeholder
- tab bar with reorderable tabs, dirty indicators, middle-click close
- file path breadcrumb under the tab bar
- Monaco host for edit mode
- Monaco diff editor for diff mode
- 3-way merge layout for conflict mode
- quick open modal (Cmd+P)
- cross-file search panel (Cmd+Shift+F)
- protected-branch warning banner
- external change notification ("file modified on disk")

Per-tab state (kept in renderer memory, not persisted):

- relative path, workspace ID
- Monaco model and view state (scroll position, selection, folded
  ranges)
- dirty flag (`isDirty`)
- external change indicator (`externallyChangedAt`)
- mode (`edit` | `diff` | `conflict`)
- diff or conflict payload (diff sources, merge state)

### Lifecycle

The page subscribes on mount to:

- `ade.files.change` — applies external-change sync per tab
- `ade.lanes.changed` — refreshes the workspace dropdown when lanes
  come/go
- `ade.sessions.changed` — not directly, but used to show dirty
  overlays when a session creates new files

On unmount, the page calls `files.stopWatching` for every active
watcher subscription, matching the mode it started with.

## Workspace selector

Renders a dropdown populated from `files.listWorkspaces()`. Primary
workspace is pinned first. Switching workspaces:

1. Prompts for save on any dirty tab (per-tab confirmation).
2. Closes all open tabs.
3. Unsubscribes the old workspace watcher.
4. Re-lists the tree for the new workspace.
5. Subscribes a new watcher.

## File explorer tree

`FileTreeNode[]` from `files.listTree`. Lazy loading: each directory
is fetched only when expanded, with a `depth: 1` request. The tree
uses sorted output (directories first, then files, alphabetical).

Visual indicators per node:

- file icons by extension (Phosphor icon map or inline SVG fallbacks)
- change status badge (`M` orange, `A` green, `D` red)
- "has changes" dot on directories that contain any changed descendant

Context menu (right-click):

| Action | Target | Notes |
|---|---|---|
| Open | file | same as click |
| Open to the side | file | opens in a new tab without closing current |
| Diff | file | switches tab to diff mode (staged vs unstaged) |
| Stage | file | git add |
| Unstage | file | git reset HEAD |
| Discard | file | git checkout -- |
| Copy path | file/dir | absolute host path |
| Copy relative path | file/dir | relative to workspace root |
| Reveal in Finder | file/dir | uses `shell.showItemInFolder` |
| New File | dir | inline input |
| New Folder | dir | inline input |
| Rename | file/dir | inline rename |
| Delete | file/dir | confirm dialog then `files.delete` |

Stage/Unstage/Discard go through the git service, not the files
service — they rely on `git` commands against the workspace root.

## Tab bar and breadcrumb

Tabs are draggable (reorderable) and show:

- file icon
- file name
- dirty dot (unsaved changes)
- external change indicator (reload prompt)
- close button (or middle-click to close)

Below the tabs, a breadcrumb trail (`src > components > App.tsx`) is
clickable per segment — clicking navigates the file tree to that
directory.

## Edit mode

Monaco Editor mounted in the tab's Monaco host. Key bindings:

| Shortcut | Action |
|---|---|
| `Cmd+S` | save (calls `files.writeTextAtomic`) |
| `Cmd+Z` / `Cmd+Shift+Z` | undo / redo (Monaco native) |
| `Cmd+F` | in-file find (Monaco native) |
| `Cmd+Shift+P` | Monaco command palette |

Save flow:

1. Read model value.
2. Call `files.writeTextAtomic({ workspaceId, path, text })`.
3. Mark the tab clean on resolve.
4. If the watcher's ref count is active, the subsequent
   `modified` event is suppressed for this tab (already in sync).

Protection rails:

- Writing to the primary workspace while active lanes exist shows a
  banner above the editor: "You have active lanes. Saving here writes
  to main." The user must click "I understand" to dismiss for the
  session.
- Saving a file marked read-only fails at the main-process boundary
  and the tab displays the error.

## Diff mode

Uses `DiffEditor` from Monaco. Sources come from `diffService`:

- **Staged vs unstaged** — shows working tree changes that have not
  been staged.
- **HEAD vs working tree** — shows everything since the last commit.
- **Commit to commit** — arbitrary sha comparison.

Features:

- side-by-side by default, toggleable to inline
- "Next change" / "Previous change" navigation
- read-only left pane (old)
- right pane is read-only by default; users can toggle to editable to
  apply changes directly to the working tree

Save behavior in diff mode writes only when the right pane is
editable; the temp model is written atomically via `files.writeTextAtomic`.

## Conflict mode

3-way merge view with four regions:

- top-left: Base (common ancestor)
- bottom-left: Ours (current branch)
- bottom-right: Theirs (incoming branch)
- right: Result (working copy with conflict markers)

Per-conflict controls (rendered as inline overlays):

- Accept Ours
- Accept Theirs
- Accept Both
- manual edit in the Result pane

Behind this, `conflictService.ts` parses the conflict markers and
tracks remaining conflicts. "Mark as Resolved" becomes enabled when
no `<<<<<<<`, `=======`, `>>>>>>>` remain in Result. Saving writes
via `files.writeTextAtomic`.

## Quick open (Cmd+P)

Modal overlay:

- input box routes to `files.quickOpen({ workspaceId, query, limit:
  80, includeIgnored: true })`
- results are `{ path, score }[]`, rendered with file icon and relative
  path
- `Enter` opens the selected file; `Shift+Enter` opens in a new tab;
  `Ctrl+Enter` opens to the side
- the modal uses its own cache so repeated queries do not re-hit IPC

## Cross-file search (Cmd+Shift+F)

Panel overlay with:

- query input
- results grouped by file path (collapsible), showing `{ line, column,
  preview }`
- clicking a result opens the file and navigates to the line
- the search uses `files.searchText({ workspaceId, query, limit: 500,
  includeIgnored: false })`

## Floating workspace

`FloatingFilesWorkspace.tsx` is a lighter, modal-style file browser
used from the Lanes tab and some side panels. It shares the same IPC
calls but omits the conflict and diff modes. It is not an independent
code path — `FilesPage.tsx` stays the source of truth for mode logic.

## Keyboard shortcuts

Registered through the global keybinding service
(`apps/desktop/src/main/services/keybindings/`):

| Shortcut | Action |
|---|---|
| `Cmd+S` / `Ctrl+S` | save |
| `Cmd+P` / `Ctrl+P` | quick open |
| `Cmd+Shift+F` / `Ctrl+Shift+F` | search |
| `Cmd+W` / `Ctrl+W` | close current tab |
| `Cmd+Tab` / `Ctrl+Tab` | next tab |
| `Cmd+\` / `Ctrl+\` | toggle file explorer |
| `Cmd+Shift+E` | focus file explorer |
| `F2` | rename in explorer |

## Gotchas

- **Monaco model leaks.** Every opened tab creates a Monaco model; the
  page disposes them on tab close and on workspace switch. Rapid
  workspace switches can leak models if the close path throws.
- **External change + dirty tab.** A file modified on disk with
  unsaved edits surfaces a "file changed on disk" banner. The user
  must explicitly choose "Reload" (discards edits) or "Keep editing"
  (leaves the warning up). The model is never overwritten silently.
- **Large files.** Files over `MAX_EDITOR_READ_BYTES = 5 MB` open as
  read-only with a binary-file notice. Binary files never enter edit
  mode.
- **Breadcrumb on root.** Files in the workspace root show only the
  filename in the breadcrumb; clicking it has no effect.
- **Tab ordering.** The tab order is stored in renderer memory and
  does not survive a full reload unless persisted by the future
  `editor-state.json` work (not yet implemented).

## Cross-links

- Main-process services and watcher: [file-watcher-and-trust.md](./file-watcher-and-trust.md)
- Files tab entry from the app shell:
  `apps/desktop/src/renderer/components/app/AppShell.tsx`
- Conflict resolution data: `apps/desktop/src/main/services/conflicts/`
- Diff data: `apps/desktop/src/main/services/diffs/`
