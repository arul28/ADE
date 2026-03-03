# UI Framework Architecture

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-02

This document describes the renderer architecture in `apps/desktop/src/renderer`, including routing, theme system, state model, layout patterns, and IPC integration constraints.

---

## Table of Contents

- [Overview](#overview)
- [Technology Stack](#technology-stack)
- [Theme System](#theme-system)
- [App Shell and Navigation](#app-shell-and-navigation)
- [State Management](#state-management)
- [Layout Patterns](#layout-patterns)
- [Component Organization](#component-organization)
  - [Feature Directories](#feature-directories)
  - [MissionsPage Decomposition](#missionspage-decomposition)
  - [WorkspaceGraphPage Decomposition](#workspacegraphpage-decomposition)
  - [Shared Frontend Utilities](#shared-frontend-utilities)
- [IPC Integration](#ipc-integration)
- [Implementation Status](#implementation-status)

---

## Overview

The ADE renderer is a React SPA running inside Electron's renderer process. It provides high-density operational UI for lanes, files, terminals, conflicts, context packs, PRs, history, agents, missions, and settings.

The renderer has no direct filesystem/process/git access. All privileged operations flow through `window.ade` (preload bridge), with the Electron main process as the only trusted executor.

---

## Technology Stack

| Category | Technology |
|---|---|
| UI framework | React 18 |
| Language | TypeScript |
| Routing | React Router |
| State | Zustand |
| Styling | Tailwind CSS 4 + CSS custom properties |
| UI primitives | Radix UI |
| Icons | Lucide React |
| Terminal | xterm.js |
| Editor/Diff | Monaco Editor |
| Graph canvas | React Flow |
| Pane layouts | react-resizable-panels |

---

## Theme System

ADE currently ships six curated themes, persisted in local storage (`ade.theme`) and applied via `data-theme` attributes:

- `e-paper`
- `bloomberg`
- `github`
- `rainbow`
- `sky`
- `pats`

Theme tokens are defined in `apps/desktop/src/renderer/index.css` using CSS variables (`--color-*`, `--shadow-*`, `--gradient-*`) and consumed by shared layout primitives.

Design intent:

- Keep themes intentionally distinct (not arbitrary color pickers).
- Preserve readability and contrast for dense operational screens.
- Keep terminal/editor styling synchronized with active theme.

---

## App Shell and Navigation

Routes are defined in `apps/desktop/src/renderer/components/app/App.tsx`. Current product routes:

- `/startup`
- `/project`
- `/onboarding`
- `/lanes`
- `/files`
- `/terminals` (legacy redirect to `/work`)
- `/work`
- `/conflicts`
- `/context` (legacy redirect to `/settings`)
- `/graph`
- `/prs`
- `/history`
- `/automations`
- `/agents` (compatibility alias to `/automations`)
- `/missions`
- `/settings`

Primary left-rail nav (`TabNav`) exposes 11 tabs:

1. Play
2. Lanes
3. Files
4. Work
5. Conflicts
6. Graph
7. PRs
8. History
9. Agents
10. Missions
11. Settings

The shell is composed by `AppShell` + `TopBar` + `TabNav`, with each route rendering a feature page in the content region.

---

## State Management

Global renderer state lives in `apps/desktop/src/renderer/state/appStore.ts`.

Core app state includes:

- `project`
- `lanes`
- `selectedLaneId`
- `runLaneId`
- `focusedSessionId`
- `theme`
- `providerMode`
- `laneInspectorTabs`
- `keybindings`

Store actions include project/lane refresh, project switching, provider mode refresh, keybindings refresh, and theme persistence.

State design principles:

- Keep remote/system authority in main-process services; renderer store remains projection + UI selection state.
- Use narrow selectors in components to minimize rerenders.
- Keep cross-page selected lane/run lane continuity for workflow speed.

---

## Layout Patterns

ADE uses multiple layout systems depending on surface complexity:

- `PaneTilingLayout`: recursive pane trees for high-density workspaces
- `SplitPane` / resizable panels: 2-pane and 3-pane structured views
- Floating pane primitives for modular lane/conflict/terminal sub-surfaces

Layout state persistence is backed by IPC calls into local SQLite (`layout`, `tilingTree`, `graphState` domains).

---

## Component Organization

Renderer components are feature-grouped under `apps/desktop/src/renderer/components`. Large page components have been decomposed into focused sub-modules to keep individual files manageable (typically under 2,500 lines).

### Feature Directories

- `app/`: shell, top-level routes, settings, startup
- `project/`: Play tab and run/test/process controls
- `lanes/`: lane list/detail/inspector, stack workflows, design tokens (`laneDesignTokens.ts`)
- `files/`: workspace browser/editor
- `terminals/`: global terminal/session surfaces
- `conflicts/`: risk, merge simulation, resolution workflows
- `context/`: shared context helpers used by Settings context/docs surfaces (`contextShared.ts`)
- `packs/`: pack visualization
- `graph/`: topology canvas (decomposed, see below)
- `prs/`: PR operations, status surfaces, shared utilities (`prs/shared/prHelpers.ts`, `prs/shared/tilingConstants.ts`)
- `history/`: operations timeline surfaces
- `automations/`: automation/agent control surfaces
- `missions/`: mission orchestration UI (decomposed, see below)
- `onboarding/`: first-run setup flows
- `settings/`: settings subsections (keybindings, terminal profiles, agents, data management)
- `shared/`: shared interactive components (`MentionInput`)
- `ui/`: shared presentation primitives

### MissionsPage Decomposition

`MissionsPage.tsx` was decomposed from ~5,600 lines to ~2,200 lines (60% reduction). The extracted modules live alongside it in `missions/`:

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `missionHelpers.ts` | ~520 | Shared mission utility functions (formatting, status logic, color mapping) |
| `CreateMissionDialog.tsx` | ~1,500 | Full mission creation wizard with model selection, budget, PR strategy |
| `MissionSettingsDialog.tsx` | ~590 | Runtime settings adjustment for active missions |
| `PlanTab.tsx` | ~190 | Plan DAG visualization tab |
| `WorkTab.tsx` | ~210 | Worker activity and lane assignment tab |
| `StepDetailPanel.tsx` | ~270 | Sidebar panel for step inspection and attempt history |
| `ActivityNarrativeHeader.tsx` | ~150 | Run narrative header for the Activity tab |
| `MissionsHomeDashboard.tsx` | ~100 | Mission list/dashboard landing page |

Other mission-scoped components that remain as standalone files: `MissionChatV2.tsx` (Slack-style chat), `AgentChannels.tsx`, `OrchestratorDAG.tsx`, `ModelSelector.tsx`, `ModelProfileSelector.tsx`, `SmartBudgetPanel.tsx`, `PolicyEditor.tsx`, `UsageDashboard.tsx`, `AgentPresencePanel.tsx`, `MissionComposer.tsx`, `MissionControlPage.tsx`, `PhaseProgressBar.tsx`.

### WorkspaceGraphPage Decomposition

`WorkspaceGraphPage.tsx` was decomposed from ~4,800 lines to ~4,100 lines (14% reduction). Extracted modules are organized into sub-directories:

```
graph/
├── WorkspaceGraphPage.tsx      # Main graph page (React Flow canvas)
├── graphTypes.ts               # Shared type definitions for graph state
├── graphHelpers.ts             # Graph data transformation utilities
├── graphLayout.ts              # Layout algorithm (node positioning, edge routing)
├── graphNodes/
│   ├── LaneNode.tsx            # Custom React Flow node for lanes
│   └── ProposalNode.tsx        # Custom React Flow node for conflict proposals
├── graphEdges/
│   └── RiskEdge.tsx            # Custom React Flow edge for conflict risk
└── graphDialogs/
    ├── PrDialog.tsx            # PR creation/detail dialog
    ├── ConflictPanel.tsx        # Conflict resolution panel
    ├── IntegrationDialog.tsx    # Lane integration dialog
    └── TextPromptModal.tsx      # Generic text prompt modal
```

### Shared Frontend Utilities

Common logic that was previously duplicated across pages has been consolidated into shared modules:

**`src/renderer/lib/`** — Pure utility functions:
- `format.ts` — Formatting helpers: `relativeWhen`, `formatDate`, `formatTime`, `formatDurationMs`, `formatTokens`, `formatCost`, `statusTone`
- `shell.ts` — Shell utilities: `quoteShellArg`, `parseCommandLine`
- `sessions.ts` — Session-related utilities

**`src/renderer/hooks/`** — Shared React hooks:
- `useClickOutside.ts` — Click-outside detection (replaced 4 independent implementations)
- `useThreadEventRefresh.ts` — Debounced thread event refresh (replaced 3 independent implementations)

**Design tokens** are consolidated in `lanes/laneDesignTokens.ts` and imported by components across missions, lanes, terminals, PRs, settings, and other feature areas

---

## IPC Integration

Renderer-to-main integration is exclusively through preload APIs (`window.ade`) in `apps/desktop/src/preload/preload.ts`.

High-level IPC domains consumed by the renderer:

- App/project/onboarding/CI
- Lanes/sessions/pty/files/git
- Conflicts/context/packs
- PRs/github/hosted
- Agents/missions/layout/graph/processes/tests
- Project config/keybindings/terminal profiles/agent tools

High-frequency event streams include:

- `ade.pty.data`
- `ade.pty.exit`
- `ade.files.change`
- `ade.processes.event`
- `ade.tests.event`
- `ade.conflicts.event`
- `ade.packs.event`
- `ade.prs.event`
- `ade.agents.event`
- `ade.missions.event`
- `ade.lanes.restackSuggestions.event`
- `ade.lanes.autoRebase.event`
- `ade.project.missing`

The complete live channel inventory is defined in `apps/desktop/src/shared/ipc.ts`.

---

## Implementation Status

Renderer architecture is fully operational for the current desktop scope:

- 12-tab shell + startup/onboarding routes are implemented.
- Six-theme token system is implemented and wired through settings.
- High-density pane layouts are implemented across lanes/terminals/conflicts/graph.
- Key feature pages (Play, Lanes, Files, Terminals, Conflicts, Context, Graph, PRs, History, Agents, Missions, Settings) are implemented.
- IPC integration is broad and type-aligned with the preload contract.
- MissionsPage decomposed into 8 focused modules (60% size reduction).
- WorkspaceGraphPage decomposed into sub-directories for nodes, edges, dialogs, and shared helpers (14% size reduction).
- Shared utility layer established: `renderer/lib/` (format, shell, sessions), `renderer/hooks/` (useClickOutside, useThreadEventRefresh), `context/contextShared.ts`, `prs/shared/`, `lanes/laneDesignTokens.ts`.
- Mission detail tabs: Chat (Slack-style MissionChatV2), Activity (category dropdown filter), Plan, Work, Details.

Future UI surfaces for Machines are planned in `docs/final-plan.md`.
