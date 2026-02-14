# Files & Editor — IDE-Style Workbench

> Last updated: 2026-02-14

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
  - [Workspace Scope](#workspace-scope)
  - [File Modes](#file-modes)
  - [Atomic Saves](#atomic-saves)
- [User Experience](#user-experience)
  - [Layout](#layout)
  - [Workspace Selector](#workspace-selector)
  - [File Explorer (Left Pane)](#file-explorer-left-pane)
  - [Editor Area (Center Pane)](#editor-area-center-pane)
  - [Safety Mechanisms](#safety-mechanisms)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [File Watching Architecture](#file-watching-architecture)
- [Data Model](#data-model)
- [Implementation Tracking](#implementation-tracking)
  - [Phase 1 — File Tree & Basic Editor (DONE)](#phase-1--file-tree--basic-editor-done)
  - [Phase 2 — Diff & Conflict Modes (DONE)](#phase-2--diff--conflict-modes-done)
  - [Phase 3 — Advanced Editor Features (DONE)](#phase-3--advanced-editor-features-done)

---

## Overview

The **Files tab** provides an IDE-like file explorer and editor for browsing and editing code across workspaces. It combines a file tree, Monaco editor, and diff views in a unified interface, allowing developers to view and modify source code without leaving ADE.

This feature matters because ADE's primary value proposition is keeping developers in a single tool. While the Lanes tab handles git operations and the Terminals tab provides shell access, the Files tab closes the loop by enabling direct code inspection and editing. Without it, developers must context-switch to an external editor for simple edits, breaking the workflow that ADE is designed to streamline.

**Current status**: This feature is **implemented and working**. The full Files tab — file explorer, Monaco editor, diff modes, conflict resolution, file watching, quick open, and cross-file search — has been built. A small number of refinement tasks remain (file-type icons, Zed styling polish).

**Design reference**: The Files tab draws heavy inspiration from [Zed](https://zed.dev)'s simple, minimal IDE interface. Zed's approach — a clean file tree, lightweight tabs, fast file switching, and a focus on keyboard-driven workflows — is the target aesthetic. The file explorer should feel snappy and uncluttered, avoiding the visual weight of VS Code's explorer. Specifically: single-click to preview, double-click to pin-open, minimal chrome around the editor, and a flat file tree with subtle indentation guides rather than heavy tree lines.

---

## Core Concepts

### Workspace Scope

The Files tab can show files from different workspaces. Each workspace corresponds to a directory on disk:

| Workspace Type | Directory | Description |
|---------------|-----------|-------------|
| **Primary** | `<repo-root>/` | The main repository directory. Always available. |
| **Lane Worktree** | `.ade/worktrees/<lane-name>/` | A worktree created by ADE for a specific lane. Only available when the lane exists. |
| **Attached Worktree** | User-specified path | An external worktree linked into ADE. |

The workspace scope is always visible in the UI to prevent accidental edits in the wrong directory. This is a critical safety feature — editing files in the primary workspace when intending to work in a lane worktree is a common source of confusion.

### File Modes

The editor supports three modes, each optimized for a different workflow:

| Mode | Description | View |
|------|-------------|------|
| **Edit** | Read/write editing of a single file. Full Monaco editor with syntax highlighting, IntelliSense hints, and save capability. | Single pane |
| **Diff** | Read-only comparison of two versions of a file. Used for staged vs. unstaged, HEAD vs. working tree, or arbitrary commit comparisons. | Side-by-side |
| **Conflict** | Three-way merge view for resolving git conflicts. Shows the base version, "ours" (current branch), and "theirs" (incoming branch) with interactive resolution controls. | Three pane |

### Atomic Saves

All file writes go through the `fileService`, which uses an atomic write strategy:

1. Write content to a temporary file in the same directory (e.g., `.file.tmp.XXXXX`).
2. Rename the temporary file to the target path.
3. This ensures that the target file is never in a partially-written state, even if the process crashes mid-write.

This approach prevents file corruption and is especially important when editing configuration files or source code that build tools may be watching.

---

## User Experience

### Layout

The Files tab uses a 2-pane layout:

```
+-------------------------------------------------------------------+
| Workspace: [Primary ▼]                                            |
+---------------------+---------------------------------------------+
| File Explorer (~25%)|  Editor Area (~75%)                         |
|                     |                                              |
| ▼ src/              |  [Tab: main.ts] [Tab: utils.ts] [x]        |
|   ▼ components/     |  ┌─────────────────────────────────────┐    |
|     ● App.tsx    M  |  │ src/components/App.tsx               │    |
|     Header.tsx      |  │─────────────────────────────────────│    |
|     Footer.tsx      |  │  1  import React from 'react';      │    |
|   ▼ utils/          |  │  2  import { Header } from './Head… │    |
|     helpers.ts      |  │  3                                   │    |
|     + newFile.ts A  |  │  4  export function App() {          │    |
|   index.ts          |  │  5    return (                       │    |
| ▼ tests/            |  │  6      <div>                        │    |
|   app.test.ts       |  │  7        <Header />                 │    |
| package.json        |  │  8      </div>                       │    |
| tsconfig.json       |  │  9    );                             │    |
|                     |  │ 10  }                                │    |
|                     |  └─────────────────────────────────────┘    |
+---------------------+---------------------------------------------+
```

**Design note**: This layout mirrors Zed's approach — a narrow, compact file tree on the left with minimal padding, and a full-width editor area with lightweight tab chrome. File tree rows should be tight (24px height) with small icons. The editor area uses Monaco but should feel as lightweight as Zed's native editor.

The pane divider is draggable for user-customized sizing.

### Workspace Selector

At the top of the Files tab, a dropdown selector controls which workspace the file explorer displays.

**Options**:
- **Primary**: The main repository root directory.
- **[Lane Name]**: One entry per active lane, showing files in that lane's worktree.
- **[Attached Name]**: One entry per attached external worktree.

Switching workspaces reloads the file tree and closes any open editor tabs (with a save prompt for unsaved changes). The workspace name is prominently displayed to reinforce which directory is active.

### File Explorer (Left Pane)

The file explorer is a tree view of files and directories in the selected workspace.

**Tree behavior**:
- Folders are expandable/collapsible with click or arrow keys.
- Files and folders are sorted: directories first, then files, both alphabetical.
- Respects `.gitignore` rules — ignored files and directories are hidden by default (with a toggle to show them).
- Supports lazy loading for large directories (only fetch children when a folder is expanded).

**Visual indicators**:
- **File icons**: Contextual icons based on file extension (TypeScript, JavaScript, JSON, YAML, Markdown, etc.).
- **Change indicators**: Files with uncommitted changes show a badge:
  - `M` (orange): Modified
  - `A` (green): Added (new file)
  - `D` (red): Deleted
- Directories containing changed files show a dot indicator.

**Right-click context menu**:

| Action | Description |
|--------|-------------|
| Open | Open file in the editor |
| Diff | Open file in diff mode (staged vs. unstaged) |
| Stage | Stage file (equivalent to `git add`) |
| Discard | Discard changes (revert to HEAD) |
| Copy Path | Copy absolute file path to clipboard |
| Copy Relative Path | Copy path relative to workspace root |
| Reveal in Finder | Open the containing directory in Finder/Explorer |
| New File | Create a new file in this directory |
| New Folder | Create a new folder in this directory |
| Rename | Rename the file or directory |
| Delete | Delete the file or directory (with confirmation) |

### Editor Area (Center Pane)

The editor area occupies the larger right portion of the layout and hosts Monaco Editor instances.

**Tab bar**:
- Multiple files can be open simultaneously as tabs.
- Each tab shows the file name and a close button.
- Unsaved files show a dot indicator on their tab.
- Tabs are reorderable by drag-and-drop.
- Middle-click to close a tab.

**File path breadcrumb**: Below the tab bar, a breadcrumb trail shows the full path from workspace root to the current file (e.g., `src > components > App.tsx`). Each segment is clickable to navigate to that directory.

**Edit mode**:
- Full Monaco Editor with:
  - Syntax highlighting for all common languages (TypeScript, JavaScript, Python, Rust, Go, Java, C/C++, YAML, JSON, Markdown, etc.)
  - Line numbers
  - Minimap (scrollbar overview)
  - Bracket matching and auto-closing
  - Indentation guides
  - Word wrap toggle
- Save: `Cmd+S` / `Ctrl+S` triggers an atomic save through `fileService`.
- Undo/Redo: Full undo history per file, per session.

**Diff mode**:
- Side-by-side view showing old (left) and new (right) versions.
- Change highlighting: Added lines in green, removed lines in red, modified lines in yellow.
- Inline diff for character-level changes within modified lines.
- Navigation: "Next Change" / "Previous Change" buttons to jump between hunks.
- Read-only by default. Can be switched to editable mode for the "new" side.

**Conflict mode (3-way merge)**:
- Three-pane layout: Base (top-left), Ours (bottom-left), Theirs (bottom-right), with a Result pane (right).
- Interactive conflict resolution: Click "Accept Ours", "Accept Theirs", or "Accept Both" per hunk.
- Manual editing in the result pane for custom resolutions.
- Conflict markers are parsed and removed as conflicts are resolved.
- "Mark as Resolved" button when all conflicts are addressed.

### Safety Mechanisms

The Files tab includes several safeguards to prevent accidental data loss:

| Mechanism | Description |
|-----------|-------------|
| **Workspace visibility** | The current workspace name is always prominently displayed, preventing edits in the wrong directory. |
| **Protected branch warnings** | If the user opens a file in the primary workspace while active lanes exist, a warning banner suggests switching to the appropriate lane. |
| **Unsaved changes indicator** | Tabs with unsaved changes show a dot. Closing a tab or switching workspaces prompts to save. |
| **Atomic saves** | File writes use the temp-file + rename strategy, preventing partial writes. |
| **External change detection** | If a file is modified externally (by another tool or terminal command) while open in the editor, a notification offers to reload the file. |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+S` / `Ctrl+S` | Save current file |
| `Cmd+P` / `Ctrl+P` | Quick open (fuzzy file search) |
| `Cmd+Shift+F` / `Ctrl+Shift+F` | Search across files |
| `Cmd+W` / `Ctrl+W` | Close current tab |
| `Cmd+Tab` / `Ctrl+Tab` | Switch between open tabs |
| `Cmd+\` / `Ctrl+\` | Toggle file explorer visibility |
| `Cmd+Shift+E` / `Ctrl+Shift+E` | Focus file explorer |
| `F2` | Rename selected file in explorer |

---

## Technical Implementation

### Services

| Service | Status | Responsibility |
|---------|--------|---------------|
| `fileService` | Exists | Atomic file writes (write to temp + rename). Used by the editor for save operations. |
| `diffService` | Exists | Diff computation for staged vs. unstaged, commit comparisons. Used by diff mode. |
| File tree listing service | **New (needed)** | Recursive directory listing with `.gitignore` support. Returns a tree structure for the file explorer. Must handle large directories efficiently via lazy loading. |
| File watching service | **New (needed)** | Watches the workspace directory for external changes using `fs.watch` or `chokidar`. Notifies the renderer when files are created, modified, or deleted, so the file tree and open editors can update. |

### IPC Channels

| Channel | Signature | Status | Description |
|---------|-----------|--------|-------------|
| `ade.files.listTree` | `(args: { rootPath: string, depth?: number }) => FileTreeNode[]` | New | List directory contents as a tree structure. Respects `.gitignore`. Supports depth limiting for lazy loading. |
| `ade.files.readFile` | `(args: { filePath: string, encoding?: string }) => FileContent` | New | Read file contents. Returns content, encoding, size, and language ID for syntax highlighting. |
| `ade.files.writeTextAtomic` | `(args: { filePath: string, content: string }) => void` | Exists | Atomically write text content to a file. |
| `ade.files.watchChanges` | `(args: { rootPath: string }) => void` | New | Start watching a directory for changes. Emits events via `ade.files.change` channel. |
| `ade.files.stopWatching` | `(args: { rootPath: string }) => void` | New | Stop watching a directory. |
| `ade.files.createFile` | `(args: { filePath: string, content?: string }) => void` | New | Create a new file. |
| `ade.files.createDirectory` | `(args: { dirPath: string }) => void` | New | Create a new directory. |
| `ade.files.rename` | `(args: { oldPath: string, newPath: string }) => void` | New | Rename a file or directory. |
| `ade.files.delete` | `(args: { path: string }) => void` | New | Delete a file or directory. |

**File change events** (streamed via `ade.files.change`):
- `created`: A new file or directory was created.
- `modified`: An existing file was modified.
- `deleted`: A file or directory was deleted.
- `renamed`: A file or directory was renamed.

**Type definitions**:

```typescript
interface FileTreeNode {
  name: string;
  path: string;          // Relative to workspace root
  type: 'file' | 'directory';
  children?: FileTreeNode[];  // Only for directories, populated on expand
  changeStatus?: 'M' | 'A' | 'D' | null;  // Git change indicator
  size?: number;         // File size in bytes
}

interface FileContent {
  content: string;
  encoding: string;      // 'utf-8', 'binary', etc.
  size: number;
  languageId: string;    // Monaco language identifier (e.g., 'typescript', 'python')
  isBinary: boolean;
}
```

### File Watching Architecture

File watching is a performance-sensitive feature that must handle large repositories without excessive resource consumption.

**Approach**:
1. Use `chokidar` (or Node.js `fs.watch` with polyfills) for cross-platform file watching.
2. Watch the workspace root recursively, but respect `.gitignore` to exclude irrelevant paths (e.g., `node_modules/`, `dist/`).
3. Debounce events (50ms window) to batch rapid changes (e.g., a build tool writing many files).
4. Only send events to the renderer for files that are either:
   - Visible in the expanded file tree, or
   - Open in an editor tab.
5. Dispose watchers when the workspace is switched or the Files tab is deactivated.

**Memory considerations**:
- Large repositories may have tens of thousands of files. The file tree service uses lazy loading — only fetching children when a directory is expanded — to avoid loading the entire tree into memory.
- File contents are not cached in main process memory. The renderer holds the Monaco model, and the main process reads from disk on demand.

---

## Data Model

The Files & Editor feature does not introduce new database tables. It operates directly on the filesystem and leverages existing services.

### Filesystem Artifacts

| Path | Description |
|------|-------------|
| `<workspace-root>/` | The directory being browsed and edited |
| `<workspace-root>/.gitignore` | Used to filter the file tree |
| `.ade/worktrees/<name>/` | Worktree directories accessible as workspace scopes |

### Editor State (Renderer-Only)

Editor state is maintained in the renderer process and is not persisted to disk or database. This includes:

| State | Description |
|-------|-------------|
| Open tabs | List of currently open file paths |
| Active tab | Which tab is focused |
| Scroll positions | Per-tab scroll offset in the editor |
| Undo history | Per-tab undo/redo stack |
| Unsaved changes | Per-tab dirty flag |
| Expanded directories | Which folders are expanded in the file tree |
| Selected workspace | Which workspace scope is active |

Future enhancement: Persist editor state to `.ade/editor-state.json` so that open tabs and scroll positions are restored when reopening the project.

---

## Implementation Tracking

### Phase 1 — File Tree & Basic Editor (DONE)

| ID | Task | Status |
|----|------|--------|
| FILES-001 | File tree listing service (respect .gitignore) | DONE |
| FILES-002 | File explorer component (tree view) | DONE |
| FILES-003 | Workspace scope selector | DONE |
| FILES-004 | File icons by type | DONE |
| FILES-005 | Change indicators in tree (M/A/D) | DONE |
| FILES-006 | Open file in Monaco editor | DONE |
| FILES-007 | Monaco syntax highlighting and theming | DONE |
| FILES-008 | File tab bar (multiple open files) | DONE |
| FILES-009 | Edit mode (read/write with save) | DONE |
| FILES-013 | File path breadcrumb | DONE |
| FILES-014 | Right-click context menu | DONE |
| FILES-015 | Unsaved changes indicator and prompt | DONE |
| FILES-018 | Atomic file save integration | DONE |

### Phase 2 — Diff & Conflict Modes (DONE)

| ID | Task | Status |
|----|------|--------|
| FILES-010 | Diff mode (staged vs unstaged) | DONE |
| FILES-011 | Diff mode (commit comparison) | DONE |
| FILES-012 | Conflict mode (3-way merge view) | DONE |
| FILES-017 | Protected branch warnings | DONE |

### Phase 3 — Advanced Editor Features (DONE)

| ID | Task | Status |
|----|------|--------|
| FILES-016 | File watching for external changes | DONE |
| FILES-019 | Search across files (Ctrl+Shift+F) | DONE |
| FILES-020 | Go to file (Ctrl+P) | DONE |
| FILES-021 | Zed-inspired file tree styling (compact rows, minimal chrome, keyboard-driven) | DONE |
