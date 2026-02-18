# UI Framework Architecture

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-11

This document describes the renderer application architecture, including the technology stack, component organization, state management, theming system, and layout patterns used in the ADE desktop interface.

---

## Table of Contents

- [Overview](#overview)
- [Design Decisions](#design-decisions)
- [Technical Details](#technical-details)
  - [Technology Stack](#technology-stack)
  - [Theme System](#theme-system)
  - [App Shell Layout](#app-shell-layout)
  - [State Management](#state-management)
  - [Component Architecture](#component-architecture)
  - [Layout System](#layout-system)
  - [Terminal Rendering](#terminal-rendering)
  - [Code Editing and Diff Views](#code-editing-and-diff-views)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Component Inventory](#component-inventory)
- [Integration Points](#integration-points)
- [Implementation Status](#implementation-status)

---

## Overview

The ADE renderer is a single-page React application running inside Electron's BrowserWindow. It provides the visual interface for managing lanes, terminals, configuration, history, packs, conflicts, and pull requests. The application is designed for developer productivity: dense information display, keyboard-driven navigation, fast rendering of terminal output, and responsive resizable pane layouts.

The renderer has zero direct access to the file system, process management, or git operations. All system interactions are mediated through the preload bridge (see [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) for the IPC security model).

---

## Design Decisions

### Why React Over Svelte or Solid?

React has the largest ecosystem of production-quality components needed for ADE: xterm.js bindings, Monaco Editor integration, React Flow for graph visualization, and Radix UI for accessible primitives. The team has deep React expertise, and React 18's concurrent features (Suspense, transitions) provide good UX for data-heavy interfaces. Svelte and Solid offer performance advantages but lack the mature component ecosystem ADE requires.

### Why Zustand Over Redux or Jotai?

Zustand provides a minimal, boilerplate-free state management solution that scales well for ADE's needs. Redux adds significant ceremony (actions, reducers, middleware) that is unnecessary for ADE's relatively flat state shape. Jotai's atom-based model is powerful but encourages fragmented state that can be harder to reason about for a team. Zustand's single-store model with slice patterns provides the right balance of simplicity and capability.

### Why Tailwind CSS Over CSS Modules or Styled Components?

Tailwind enables rapid UI development with consistent design tokens (spacing, colors, typography) and built-in dark mode support via the `dark:` variant. CSS Modules require more boilerplate and make responsive design verbose. Styled Components add runtime overhead for CSS-in-JS evaluation. Tailwind's utility-first approach with `cn()` (a `clsx` + `tailwind-merge` helper) produces minimal CSS bundles and predictable styling.

### Why Radix UI Over Headless UI or Custom Components?

Radix provides unstyled, accessible primitive components (dialogs, dropdowns, tabs, tooltips) that handle complex accessibility requirements (focus management, keyboard navigation, screen reader announcements) out of the box. Building these from scratch is error-prone and time-consuming. Headless UI is a viable alternative but has a smaller component library. Radix's composable API integrates cleanly with Tailwind styling.

### Why Two Themes Instead of Arbitrary Theming?

Two carefully designed themes (light and dark) provide a better user experience than arbitrary color customization. Each theme is holistically designed: colors, contrast ratios, shadow depths, and accent tones are tuned to work together. Arbitrary theming risks accessibility issues (poor contrast), visual inconsistency, and significantly increased testing surface. Two themes keep the design system manageable while covering the primary user preferences.

---

## Technical Details

### Technology Stack

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| UI framework | React | 18.3 | Component rendering and lifecycle |
| Language | TypeScript | Strict mode | Type safety across the renderer |
| Routing | React Router | 7.13 | Client-side page navigation |
| State | Zustand | Latest | Global state management |
| Styling | Tailwind CSS | 4.x | Utility-first CSS framework |
| Primitives | Radix UI | Latest | Accessible UI component primitives |
| Icons | Lucide React | Latest | Consistent icon library |
| Terminal | xterm.js | Latest | Full terminal emulation |
| Code editor | Monaco Editor | Latest | Code editing and diff views |
| Graph canvas | React Flow | Latest | Node/edge visualization for workspace graph |
| Pane layout | react-resizable-panels | Latest | Resizable split pane layouts |

### Theme System

ADE ships with two themes, toggled via a button in the TopBar and persisted in localStorage.

#### Clean Paper (Light Theme)

The light theme evokes a clean, professional aesthetic inspired by well-typeset documents.

- **Background**: Warm ivory (`#FAFAF8`) with subtle paper texture
- **Surface**: White (`#FFFFFF`) with light shadow elevation
- **Text**: Charcoal (`#1A1A1A`) for primary, slate gray for secondary
- **Accents**: Muted blue for interactive elements, green for success states
- **Borders**: Light gray (`#E5E5E3`) with 1px width
- **Typography**: Sans-serif body text with serif accents for headings
- **Terminal**: Light background with dark text, pastel ANSI colors

#### Bloomberg Terminal (Dark Theme)

The dark theme draws inspiration from professional financial terminals: dense, high-contrast, and information-rich.

- **Background**: Deep charcoal (`#0A0A0A`) to near-black
- **Surface**: Dark gray (`#1A1A1A`) with subtle border separation
- **Text**: Off-white (`#E5E5E5`) for primary, muted gray for secondary
- **Accents**: Amber (`#F5A623`) for highlights, green (`#00D084`) for active states
- **Borders**: Dark gray (`#2A2A2A`) with 1px width
- **Typography**: Monospace-heavy, compact line heights
- **Terminal**: Black background with bright ANSI colors, amber cursor

#### Implementation

Themes are implemented using a combination of Tailwind's `dark:` variant and CSS custom properties:

```css
/* CSS custom properties for theme tokens */
:root {
  --color-surface: #FFFFFF;
  --color-surface-elevated: #FAFAF8;
  --color-text-primary: #1A1A1A;
  --color-text-secondary: #6B7280;
  --color-accent: #3B82F6;
  --color-border: #E5E5E3;
}

.dark {
  --color-surface: #1A1A1A;
  --color-surface-elevated: #0A0A0A;
  --color-text-primary: #E5E5E5;
  --color-text-secondary: #9CA3AF;
  --color-accent: #F5A623;
  --color-border: #2A2A2A;
}
```

The `dark` class is toggled on the `<html>` element. Components use both Tailwind `dark:` variants for simple cases and CSS custom properties for complex color tokens.

**Theme toggle** (Zustand store action):

```typescript
toggleTheme: () => {
  set((state) => {
    const next = state.theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem("ade-theme", next);
    return { theme: next };
  });
};
```

### App Shell Layout

The application shell provides a fixed navigation structure with a route-based content area.

```
┌──────────────────────────────────────────────────────────┐
│  TopBar                                                   │
│  ┌──────────────────────────────────────────────────────┐│
│  │ Project Name    [Open Repo] [Open .ade] [Theme] [⋮] ││
│  └──────────────────────────────────────────────────────┘│
├──────┬───────────────────────────────────────────────────┤
│      │                                                    │
│  50px│            Main Content Area                       │
│  Icon│                                                    │
│  Rail│     Route-based page rendering:                    │
│      │     /lanes     → LanesPage                        │
│  ┌──┐│     /terminals → TerminalsPage                    │
│  │🔀││     /history   → HistoryPage                      │
│  ├──┤│     /packs     → PacksPage                        │
│  │📺││     /conflicts → ConflictsPage                    │
│  ├──┤│     /prs       → PRsPage                          │
│  │📜││     /settings  → SettingsPage                     │
│  ├──┤│     /          → ProjectHomePage                  │
│  │📦││                                                    │
│  ├──┤│                                                    │
│  │⚡││                                                    │
│  ├──┤│                                                    │
│  │📋││                                                    │
│  ├──┤│                                                    │
│  │⚙│ │                                                    │
│  └──┘│                                                    │
│      │                                                    │
└──────┴───────────────────────────────────────────────────┘
```

**TopBar**: Fixed height (48px). Displays the current project name, action buttons (Open Repo in file manager, Open `.ade/` directory, theme toggle), and an overflow menu for additional actions.

**Left Rail**: Fixed width (50px). Icon-only navigation with tooltip labels on hover. Each icon represents a top-level route. The active tab is highlighted with the accent color. Navigation tabs (top to bottom):

1. Lanes (branch icon)
2. Terminals (monitor icon)
3. History (scroll icon)
4. Packs (package icon)
5. Conflicts (zap icon)
6. Pull Requests (git-pull-request icon)
7. Settings (settings icon)
8. Project Home (home icon)

**Main Content Area**: Fills remaining space. Renders the active route's page component. Pages manage their own internal layout (split panes, lists, detail views).

### State Management

Global application state is managed through a single Zustand store (`appStore`).

```typescript
interface AppState {
  // Data
  project: ProjectInfo | null;
  lanes: LaneSummary[];
  selectedLaneId: string | null;
  focusedSessionId: string | null;
  theme: "dark" | "light";

  // Actions
  setProject: (project: ProjectInfo | null) => void;
  setLanes: (lanes: LaneSummary[]) => void;
  selectLane: (laneId: string | null) => void;
  focusSession: (sessionId: string | null) => void;
  setTheme: (theme: "dark" | "light") => void;
  toggleTheme: () => void;
  refreshProject: () => Promise<void>;
  refreshLanes: () => Promise<void>;
  openRepo: () => Promise<void>;
}
```

**Design principles for the store**:

- **Flat structure**: No deeply nested state. Normalized data with ID references.
- **Async actions**: `refreshProject` and `refreshLanes` invoke IPC calls and update state with results.
- **Derived state**: Computed in components using selectors (e.g., `selectedLane = lanes.find(l => l.id === selectedLaneId)`).
- **No middleware**: State is simple enough that middleware (logging, persistence) is unnecessary.

**Additional Zustand stores** (planned or existing):

- **DockLayoutState**: Pane size preferences for resizable layouts. Persisted to SQLite `kv` table.
- **TerminalState**: Active terminal sessions, focused terminal ID, scroll positions.

### Component Architecture

Components are organized by feature domain, with shared primitives in a `ui/` directory.

```
src/renderer/components/
├── app/                    # App shell components
│   ├── App.tsx            # Root component (router, store provider)
│   ├── AppShell.tsx       # Shell layout (TopBar + Rail + Content)
│   ├── TopBar.tsx         # Top navigation bar
│   ├── TabNav.tsx         # Left rail navigation
│   └── TabButton.tsx      # Individual tab button
│
├── lanes/                  # Lane management
│   ├── LanesPage.tsx      # Top-level lanes route
│   ├── LaneList.tsx       # Lane list sidebar
│   ├── LaneRow.tsx        # Individual lane list item
│   ├── LaneDetail.tsx     # Lane detail panel
│   ├── LaneInspector.tsx  # Lane metadata inspector
│   ├── LaneTerminalsPanel.tsx  # Terminals within a lane
│   ├── MonacoDiffView.tsx # Diff viewer using Monaco
│   └── TilingLayout.tsx   # Tiling window manager for lane content
│
├── terminals/              # Terminal management
│   ├── TerminalsPage.tsx  # Top-level terminals route
│   ├── TerminalView.tsx   # Single terminal (xterm.js wrapper)
│   └── SessionDeltaCard.tsx # Session change summary card
│
├── project/                # Project overview
│   └── ProjectHomePage.tsx # Project dashboard
│
├── history/                # Operation history
│   └── HistoryPage.tsx    # History timeline
│
├── packs/                  # Pack management
│   ├── PackViewer.tsx     # Pack content viewer
│   └── PackFreshnessIndicator.tsx # Visual freshness indicator
│
├── conflicts/              # Conflict resolution
│   └── ConflictsPage.tsx  # Conflict resolution interface
│
├── prs/                    # Pull request management
│   └── PRsPage.tsx        # PR management interface
│
├── graph/                  # Workspace graph
│   └── WorkspaceGraphPage.tsx  # React Flow graph canvas
│
├── files/                  # Files tab
│   └── FilesPage.tsx      # File tree, editor, search
│
├── onboarding/             # Onboarding & settings
│   ├── OnboardingWizard.tsx  # First-run setup wizard
│   └── SettingsPage.tsx   # Settings interface
│
└── ui/                     # Shared primitives
    ├── Button.tsx         # Styled button variants
    ├── Chip.tsx           # Status chip/badge
    ├── EmptyState.tsx     # Empty state placeholder
    ├── PaneHeader.tsx     # Section header for panes
    ├── SplitPane.tsx      # Two-pane resizable layout
    ├── Kbd.tsx            # Keyboard shortcut display
    └── cn.ts              # Tailwind class merge utility
```

**Component conventions**:

- Components are function components with TypeScript interfaces for props.
- Components receive data via props or Zustand selectors, never direct IPC calls.
- Side effects (IPC calls, subscriptions) are handled in `useEffect` hooks or Zustand actions.
- Components are colocated with their styles (Tailwind classes in JSX).

### Layout System

Resizable pane layouts are implemented using `react-resizable-panels`.

**Example: LanesPage layout**:

```
┌──────────────┬───────────────────────────────────────┐
│              │                                        │
│  LaneList    │           LaneDetail                   │
│  (sidebar)   │                                        │
│              │  ┌────────────────────────────────────┐│
│  - Lane 1    │  │ LaneInspector (metadata)           ││
│  - Lane 2*   │  ├────────────────────────────────────┤│
│  - Lane 3    │  │ LaneTerminalsPanel (terminals)     ││
│              │  │                                    ││
│              │  │ ┌──────┐ ┌──────┐ ┌──────┐       ││
│              │  │ │ Term │ │ Term │ │ Term │       ││
│              │  │ │  1   │ │  2   │ │  3   │       ││
│              │  │ └──────┘ └──────┘ └──────┘       ││
│              │  └────────────────────────────────────┘│
└──────────────┴───────────────────────────────────────┘
```

**Size persistence**: Pane sizes are saved to the SQLite `kv` table whenever the user resizes a pane. On app restart, saved sizes are restored. The key format is `layout.<pageId>.<paneId>`.

**Responsive behavior**: Pane minimum sizes prevent collapsing to unusable widths. The sidebar has a minimum of 200px and a maximum of 400px. The detail pane fills remaining space.

### Terminal Rendering

Terminal rendering uses xterm.js with several addons for enhanced functionality.

**Architecture**:

```
Main Process                    Renderer Process
┌──────────────┐               ┌──────────────────────┐
│ PTY Service  │               │ TerminalView.tsx      │
│              │  IPC events   │                       │
│ node-pty     │ ─────────────>│ xterm.js Terminal     │
│ (real PTY)   │  "pty.data"   │  + FitAddon          │
│              │               │  + WebLinksAddon      │
│              │  IPC invoke   │                       │
│              │ <─────────────│ User input → pty.write│
└──────────────┘               └──────────────────────┘
```

**Addons**:

| Addon | Purpose |
|-------|---------|
| FitAddon | Automatically resizes terminal to fit container dimensions |
| WebLinksAddon | Makes URLs in terminal output clickable |

**Theme integration**: Terminal color schemes are derived from the active theme. The Bloomberg Terminal theme uses bright ANSI colors with an amber cursor. The Clean Paper theme uses pastel ANSI colors with a dark cursor.

**Performance**: Terminal data is streamed from the main process via IPC events (`pty.data`). The renderer writes data directly to the xterm.js terminal instance. No intermediate buffering or processing in the renderer ensures minimal latency.

### Code Editing and Diff Views

Monaco Editor is used for code display and diff visualization within ADE.

**Use cases**:

- **MonacoDiffView**: Side-by-side diff viewer for pack changes, conflict resolution previews, and proposal reviews.
- **Read-only code display**: Syntax-highlighted code viewing for file contents in pack viewer.

**Configuration**:

```typescript
const editorOptions: monaco.editor.IEditorOptions = {
  readOnly: true,              // ADE does not edit files via Monaco
  minimap: { enabled: false }, // Save space in pane layouts
  lineNumbers: "on",
  scrollBeyondLastLine: false,
  wordWrap: "on",
  theme: isDark ? "vs-dark" : "vs", // Synced with ADE theme
};
```

Monaco is loaded asynchronously to avoid blocking the initial render. The editor instance is created when the component mounts and disposed when it unmounts to prevent memory leaks.

### Keyboard Shortcuts

ADE provides keyboard-driven navigation for power users.

**Global shortcuts** (work anywhere in the app):

| Shortcut | Action |
|----------|--------|
| `Cmd+1` through `Cmd+7` | Switch to tab 1-7 in the left rail |
| `Cmd+,` | Open Settings |
| `Cmd+Shift+T` | Toggle theme |

**List navigation** (in LaneList, process lists, etc.):

| Shortcut | Action |
|----------|--------|
| `j` | Move selection down |
| `k` | Move selection up |
| `Enter` | Open/expand selected item |
| `Escape` | Clear selection / close panel |

**Process/session shortcuts** (when a process or session is focused):

| Shortcut | Action |
|----------|--------|
| `s` | Start process/session |
| `x` | Stop process/session |
| `r` | Restart process/session |

**Implementation**: Keyboard shortcuts are handled via `useEffect` hooks that listen for `keydown` events on the appropriate DOM elements. Global shortcuts use the `window` listener. List shortcuts use the list container element. Shortcuts are disabled when an input element is focused (to avoid conflicts with text entry).

---

## Integration Points

### IPC Bridge (Preload)

The renderer communicates with the main process exclusively through the typed IPC bridge exposed via `window.ade`. See [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) for the full IPC allowlist.

Key IPC interactions for the UI:

| IPC Channel | Direction | Purpose |
|-------------|-----------|---------|
| `project:get` | Invoke | Load project metadata on startup |
| `lanes:list` | Invoke | Fetch lane summaries for LaneList |
| `lanes:create` | Invoke | Create a new lane |
| `pty:spawn` | Invoke | Start a new terminal session |
| `pty:write` | Invoke | Send user input to terminal |
| `pty:kill` | Invoke | Terminate a terminal session |
| `pty.data` | Event | Stream terminal output to xterm.js |
| `lanes.changed` | Event | Refresh lane list when lanes change |
| `config:get` | Invoke | Load configuration for settings page |

### State Management (Zustand)

The Zustand `appStore` is the single source of truth for global UI state. Components subscribe to specific slices of state using selectors to minimize re-renders.

### Configuration Service

The Settings page reads and writes configuration through IPC calls to the `projectConfigService` in the main process. The trust dialog is rendered in the renderer but triggers trust confirmation through IPC.

### PTY Service

Terminal rendering depends on the PTY service in the main process. The `TerminalView` component manages the lifecycle of xterm.js instances and their connection to PTY sessions via IPC events.

### SQLite (kvDb)

Layout preferences and theme state are persisted through IPC calls to the `kvDb` service. The renderer never accesses SQLite directly.

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| React + TypeScript setup | Done | Strict mode enabled |
| React Router (client-side routing) | Done | All routes defined |
| Zustand appStore | Done | Core state shape implemented |
| Tailwind CSS 4.x integration | Done | Utility classes throughout |
| Clean Paper theme (light) | Done | CSS custom properties + `dark:` variants |
| Bloomberg Terminal theme (dark) | Done | CSS custom properties + `dark:` variants |
| App shell (TopBar + Rail + Content) | Done | Fixed layout with icon navigation |
| Left rail navigation (TabNav) | Done | 8 tabs with icon + tooltip |
| LanesPage (list + detail + inspector) | Done | Resizable pane layout |
| LaneList, LaneRow | Done | Keyboard navigation (j/k) |
| LaneDetail, LaneInspector | Done | Metadata display |
| LaneTerminalsPanel | Done | Terminal grid within lane |
| TilingLayout | Done | Tiling window manager for panes |
| TerminalsPage | Done | Terminal list and viewer |
| TerminalView (xterm.js) | Done | FitAddon + WebLinksAddon |
| MonacoDiffView | Done | Side-by-side diff rendering |
| ProjectHomePage | Done | Project overview dashboard |
| HistoryPage | Done | Operation timeline |
| PackViewer | Done | Pack content display |
| PackFreshnessIndicator | Done | Visual freshness badge |
| SessionDeltaCard | Done | Session change summary |
| ConflictsPage | Done | Conflict prediction radar, pairwise matrix, proposal review (Phase 5+) |
| PRsPage | Done | GitHub PR creation, status tracking, check/review indicators (Phase 7) |
| WorkspaceGraphPage | Done | React Flow canvas with lane nodes, edge relationships (Phase 7) |
| FilesPage | Done | File tree, Monaco editor, multi-tab, quick-open, text search (Phase 3) |
| OnboardingWizard | Done | First-run setup wizard with provider selection (Phase 8) |
| SettingsPage | Done | Configuration display and editing |
| Shared UI primitives (Button, Chip, etc.) | Done | Consistent component library |
| `cn()` utility | Done | `clsx` + `tailwind-merge` helper |
| react-resizable-panels integration | Done | Pane sizes persisted |
| Layout persistence (SQLite kv) | Done | Sizes saved/restored on restart |
| React Flow integration | Done | Workspace graph with full React Flow canvas (Phase 7) |
| Advanced keyboard shortcuts | Done | Scope-based keybindingsService with configurable definitions (Phase 8) |
| Accessibility audit | Not started | Radix provides base a11y |
| Performance profiling | Not started | No bottlenecks identified yet |

**Overall status**: The UI is comprehensive with all pages implemented, including the app shell, navigation, themes, state management, pane layouts, terminal rendering, Monaco diff views, conflict resolution, PR management, workspace graph (React Flow), files tab, onboarding wizard, and scope-based keyboard shortcuts. Accessibility audit and performance profiling are NOT YET STARTED.
