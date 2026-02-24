# UI Framework Architecture

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-19

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
- `/terminals`
- `/conflicts`
- `/context`
- `/graph`
- `/prs`
- `/history`
- `/agents`
- `/missions`
- `/settings`

Primary left-rail nav (`TabNav`) exposes 12 tabs:

1. Play
2. Lanes
3. Files
4. Terminals
5. Conflicts
6. Context
7. Graph
8. PRs
9. History
10. Agents
11. Missions
12. Settings

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

Renderer components are feature-grouped under `apps/desktop/src/renderer/components`:

- `app/`: shell, top-level routes, settings, startup
- `project/`: Play tab and run/test/process controls
- `lanes/`: lane list/detail/inspector and stack workflows
- `files/`: workspace browser/editor
- `terminals/`: global terminal/session surfaces
- `conflicts/`: risk, merge simulation, resolution workflows
- `context/` + `packs/`: context generation and pack visualization
- `graph/`: topology canvas
- `prs/`: PR operations and status surfaces
- `history/`: operations timeline surfaces
- `agents/`: agent cards, builder wizard, findings, morning briefing, run history
- `missions/`: mission intake, status board, interventions, artifacts, and outcomes
- `onboarding/`: first-run setup flows
- `settings/`: settings subsections (keybindings, terminal profiles, agents, data management)
- `ui/`: shared presentation primitives

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

Future UI surfaces for Machines are planned in `docs/final-plan.md`.
