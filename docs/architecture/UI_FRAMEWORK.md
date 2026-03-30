# UI Framework Architecture

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-10

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
- [Performance](#performance)
- [Implementation Status](#implementation-status)

---

## Overview

The ADE renderer is a React SPA running inside Electron's renderer process. It provides high-density operational UI for lanes, files, terminals, conflicts, PRs, history, agents, missions, and settings.

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
- `/work`
- `/graph`
- `/prs`
- `/history`
- `/automations`
- `/missions`
- `/cto`
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
9. CTO
10. Missions
11. Settings

The shell is composed by `AppShell` + `TopBar` + `TabNav`, with each route rendering a feature page in the content region.

---

## State Management

### Global App Store

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

### Domain-Specific Stores

`useMissionsStore` (`apps/desktop/src/renderer/components/missions/useMissionsStore.ts`) is a domain-specific Zustand store that owns all mission-related state and actions. It colocates state, derived data, and side-effect management in a single module:

- **Fine-grained selectors with `useShallow`**: Components subscribe to narrow slices of the store using `useShallow` to minimize rerenders (e.g., `useMissionsStore(useShallow(s => ({ missions: s.missions, selectedId: s.selectedMissionId })))`).
- **Store-owned event subscriptions (`initEventSubscriptions`)**: The store registers IPC event listeners for `ade.missions.event` and `ade.orchestrator.event` internally, ensuring mission and orchestrator state updates are handled in one place rather than scattered across components.
- **Store-owned timers**: Toast management (auto-dismiss timers) and debounced operations (e.g., search filtering, event coalescing) are managed within the store, keeping timer lifecycle tied to store lifetime.

### State Design Principles

- Keep remote/system authority in main-process services; renderer store remains projection + UI selection state.
- Use narrow selectors in components to minimize rerenders.
- Keep cross-page selected lane/run lane continuity for workflow speed.
- Domain-heavy pages (Missions) use dedicated Zustand stores to avoid bloating the global appStore.

---

## Layout Patterns

ADE uses multiple layout systems depending on surface complexity:

- `PaneTilingLayout`: recursive pane trees for high-density workspaces
- `SplitPane` / resizable panels: 2-pane and 3-pane structured views
- Floating pane primitives for modular lane/conflict/terminal sub-surfaces
- **Work view session grid** (`WorkViewArea`): CSS Grid with `auto-fill` and `minmax` for fluid responsive session card layout that adapts to viewport width without fixed breakpoints

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

The missions UI has been further decomposed through the M3/M4 UI overhaul. The current module structure:

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `MissionsPage.tsx` | ~389 | Orchestrates layout, hooks, loading state, sidebar + detail routing |
| `useMissionsStore.ts` | ~596 | All mission state + actions (Zustand store with event subscriptions, timers, selectors) |
| `MissionSidebar.tsx` | — | Virtualized mission list, search, status filters |
| `MissionHeader.tsx` | — | Status display, progress (`computeProgress`), lifecycle actions, `CompactUsageMeter` |
| `MissionDetailView.tsx` | — | Tab routing (Plan, Work, DAG, Chat, Activity, Details), intervention panel |
| `MissionTabContainer.tsx` | — | Tab content rendering |
| `InterventionPanel.tsx` | — | Dedicated intervention display and resolve UI |
| `missionHelpers.ts` | ~520 | `STATUS_CONFIG`, `classifyErrorSource`, `computeProgress`, `collapseFeedMessages`, `getAvailableLifecycleActions`, `usagePercentColor`, `formatResetCountdown` |
| `CreateMissionDialog.tsx` | ~1,500 | Full mission creation wizard with model selection, budget, PR strategy |
| `MissionSettingsDialog.tsx` | ~590 | Runtime settings adjustment for active missions |
| `PlanTab.tsx` | ~190 | Plan DAG visualization tab |
| `WorkTab.tsx` | ~210 | Worker runtime inspection, transcript-oriented follow mode, and validator lineage tab |
| `StepDetailPanel.tsx` | ~270 | Sidebar panel for step inspection and attempt history |
| `ActivityNarrativeHeader.tsx` | ~150 | Run narrative header for the Activity tab |
| `MissionsHomeDashboard.tsx` | ~100 | Mission list/dashboard landing page |

**MissionChatV2 decomposition**: The mission chat container has been decomposed into focused sub-components:
- `ChatChannelList` — Channel sidebar for thread navigation
- `ChatMessageArea` — Message display with virtualized scrolling
- `ChatInput` — Message composition and send
- `chatFilters` — Filter logic for channel-based message routing

Other mission-scoped components that remain as standalone files: `MissionThreadMessageList.tsx` (shared renderer wrapper for worker/orchestrator threads), `OrchestratorDAG.tsx`, `ModelSelector.tsx`, `ModelProfileSelector.tsx`, `SmartBudgetPanel.tsx`, `UsageDashboard.tsx`, `AgentPresencePanel.tsx`, `MissionComposer.tsx`, `MissionControlPage.tsx`, `PhaseProgressBar.tsx`.

### WorkspaceGraphPage Decomposition

`WorkspaceGraphPage.tsx` was decomposed from ~4,800 lines to ~4,100 lines (14% reduction). Extracted modules are organized into sub-directories:

```
graph/
├── WorkspaceGraphPage.tsx      # Main graph page (React Flow canvas)
├── graphTypes.ts               # Shared type definitions for graph state
├── graphHelpers.ts             # Graph data transformation utilities
├── graphLayout.ts              # Layout algorithm (node positioning, edge routing)
├── shared/
│   ├── RiskMatrix.tsx          # Shared pairwise risk matrix used by Graph
│   └── RiskTooltip.tsx         # Hover details for risk matrix cells
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
- Conflicts/context/memory
- PRs/github/hosted
- Agents/missions/layout/graph/processes/tests
- Project config/keybindings/terminal profiles/agent tools

**Consolidated IPC patterns:**

- `getFullMissionView`: A single IPC call that returns the complete mission state (metadata, run status, steps, chat threads, interventions, artifacts, usage) for a selected mission. Replaces 5+ separate IPC calls that previously fired on every mission selection change, reducing burst traffic and simplifying renderer-side data assembly.

High-frequency event streams include:

- `ade.pty.data`
- `ade.pty.exit`
- `ade.files.change`
- `ade.processes.event`
- `ade.tests.event`
- `ade.conflicts.event`
- `ade.prs.event`
- `ade.agents.event`
- `ade.missions.event`
- `ade.lanes.rebaseSuggestions.event`
- `ade.lanes.autoRebase.event`
- `ade.project.missing`

The complete live channel inventory is defined in `apps/desktop/src/shared/ipc.ts`.

---

## Performance

### Virtualized Lists

The missions UI uses `@tanstack/react-virtual` for virtualized rendering of large lists:

- **Mission sidebar list**: The mission list in `MissionSidebar.tsx` is virtualized to handle large numbers of missions without DOM bloat.
- **Chat message area**: `ChatMessageArea` uses virtualized scrolling for mission chat threads, ensuring smooth performance even with thousands of messages.

### Consolidated IPC

Mission selection previously triggered 5+ separate IPC calls (metadata, run, steps, chat, interventions, etc.). The `getFullMissionView` consolidated call reduces selection-change burst to a single round-trip, cutting perceived latency and main-process load.

### Store-Level Event Debouncing

`useMissionsStore` debounces high-frequency `ade.missions.event` and `ade.orchestrator.event` streams at the store level, coalescing rapid state updates into batched renders rather than triggering per-event component updates.

---

## Implementation Status

Renderer architecture is fully operational for the current desktop scope:

- 11-tab shell + startup/onboarding routes are implemented.
- Six-theme token system is implemented and wired through settings.
- High-density pane layouts are implemented across lanes/work/graph/prs.
- Key feature pages (Play, Lanes, Files, Work, Graph, PRs, History, Automations, CTO, Missions, Settings) are implemented.
- IPC integration is broad and type-aligned with the preload contract.
- MissionsPage decomposed into 8 focused modules (60% size reduction).
- WorkspaceGraphPage decomposed into sub-directories for nodes, edges, dialogs, and shared helpers (14% size reduction).
- Shared utility layer established: `renderer/lib/` (format, shell, sessions), `renderer/hooks/` (useClickOutside, useThreadEventRefresh), `context/contextShared.ts`, `prs/shared/`, `lanes/laneDesignTokens.ts`.
- Mission detail tabs: Plan, Work, DAG, Chat, Activity, Details.
- Mission chat is split by channel purpose: Global is the high-signal summary/broadcast view, while orchestrator and worker threads reuse the shared agent chat message renderer for detailed structured event/tool/thinking display.

Future UI surfaces for Machines are planned in `docs/final-plan/README.md`.
