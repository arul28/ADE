# Workspace Graph — Visual Topology Canvas

> Last updated: 2026-02-11

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
  - [Nodes](#nodes)
  - [Edges](#edges)
  - [Edge States](#edge-states)
  - [Merge Simulation](#merge-simulation)
- [User Experience](#user-experience)
  - [Canvas Layout](#canvas-layout)
  - [Node Display](#node-display)
  - [Edge Display](#edge-display)
  - [Merge Simulation Panel](#merge-simulation-panel)
  - [Interactions](#interactions)
- [Technical Implementation](#technical-implementation)
  - [Libraries](#libraries)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [Component Architecture](#component-architecture)
  - [Data Flow](#data-flow)
- [Data Model](#data-model)
  - [Layout Persistence](#layout-persistence)
  - [Risk Matrix Cache](#risk-matrix-cache)
- [Implementation Tracking](#implementation-tracking)

---

## Overview

The Workspace Graph provides an infinite-canvas visualization of all lanes, their
relationships, and integration risks. It gives developers a birds-eye view of their
parallel development topology, answering questions like "how do my worktrees relate
to each other?", "where are the conflicts?", and "what happens if I merge these two
lanes?"

Traditional multi-branch workflows force developers to hold a mental model of branch
relationships in their head. The Workspace Graph externalizes that mental model into
an interactive, always-up-to-date visual representation. Nodes represent lanes, edges
represent structural and risk relationships, and color encodes integration health at
a glance.

The graph also serves as an **environment mindmap**. The main branch (typically `main` or `master`) sits at the center representing production. Branches like `develop` or `staging` are positioned as intermediate nodes. All feature lanes, worktrees, and attached lanes radiate outward, connected by topology, stack, and risk edges. PR status and merge conflict indicators overlay the edges, giving a complete picture of "what connects to what and what's blocking."

Think of it as an infinite canvas where you can see your entire development topology at a glance — which branch maps to which environment, where the conflicts are, and which PRs are open.

**Status**: This feature is planned for **Phase 7** (GitHub Integration + Workspace Graph). Some service-layer work has been completed ahead of schedule in Phase 4/5:

- `laneService.reparent()` method exists for moving lanes between parents
- `laneService.updateAppearance()` method exists for customizing color, icon, and tags
- IPC channels `lanesReparent` and `lanesUpdateAppearance` are registered in `registerIpc.ts`
- Preload bridge exposes `reparent` and `updateAppearance` methods to the renderer
- Types for reparent (`ReparentArgs`), appearance (`AppearanceUpdate`), and graph state (`GraphState`) exist in `types.ts`

The `graph/` directory and `/graph` route exist but UI components are not yet built.

The `docs/PHASE_4_5_UPDATES.md` document (Part 3) contains extended scope beyond the original 28 GRAPH tasks, including:

- Drag-and-drop lane reparenting with cycle detection (WG14)
- Multi-select reparent (WG15)
- Batch operations with progress UI (WG16)
- Collapsible sub-graphs (WG17)
- Multiple view modes — Stack/Risk/Activity/All (WG18)
- Custom node appearance — color, tags, icon (WG19)
- Graph-level filtering (WG20)
- Multiple saved layout presets (WG21)
- Loading and skeleton states (WG23)
- Conflict status animations (WG25)

---

## Core Concepts

### Nodes

A **Node** is the visual representation of a single lane on the canvas. Each node
displays the lane's name, branch, and current status. There are three node types:

| Node Type | Description | Visual Style |
|-----------|-------------|--------------|
| **Primary** | The main repository checkout (not a worktree). Always one per project. | Larger size, centered position, distinct border color, bold label |
| **Worktree** | A `git worktree` managed by ADE. The most common node type. | Standard size, solid border, positioned by relationship |
| **Attached** | An external worktree that ADE discovered but did not create. | Standard size, dashed border, dimmer label |

### Edges

An **Edge** is a connection between two nodes representing a structural or risk
relationship. There are three edge types:

| Edge Type | Description | Visual Style |
|-----------|-------------|--------------|
| **Topology** | Structural link from primary lane to each worktree it owns. Shows the "created from" relationship. | Solid line, neutral color |
| **Stack** | Dependency link from parent lane to child lane (stacked branches). Shows "builds on top of" relationship. | Solid line with arrowhead, thicker stroke |
| **Risk** | Conflict overlay between any two lanes whose changes overlap. Only shown when risk is detected. | Dashed line, colored by risk level |

### Edge States

Every edge carries a state that indicates the predicted merge outcome between the
two connected lanes:

| State | Color | Meaning |
|-------|-------|---------|
| **Clean** | Green | No overlapping changes; merge would succeed without conflicts |
| **Auto-merge** | Blue | Overlapping files but no line-level conflicts; git can auto-merge |
| **Conflicts** | Red | Line-level conflicts detected; manual resolution required |
| **Unknown** | Gray | Risk has not been computed yet (initial state or stale data) |

### Merge Simulation

Clicking any edge opens the **Merge Simulation Panel**, which performs a dry-run
merge between the two connected lanes and displays the predicted outcome. This
allows developers to preview integration results before actually merging, reducing
surprise conflicts and enabling proactive conflict resolution.

### Environment Mapping

Lanes can be associated with **deployment environments** to provide additional context on the canvas. The mapping is configurable in `.ade/ade.yaml`:

```yaml
environments:
  - branch: "main"
    env: "production"
    color: "#22c55e"    # green
  - branch: "develop"
    env: "staging"
    color: "#3b82f6"    # blue
  - branch: "release/*"
    env: "release"
    color: "#f59e0b"    # amber
```

When environment mapping is configured:
- Matched branch nodes display an environment badge (e.g., "PROD", "STAGING")
- The node border color reflects the environment color
- The auto-layout algorithm positions environment-mapped branches closer to the center, with feature branches radiating outward
- A small legend in the corner shows the environment color key

This makes the graph a deployment-aware topology map, not just a branch relationship viewer.

### PR Edge Overlays

When pull requests exist between lanes (from the PR integration, also in Phase 7), the graph overlays **PR indicators** on edges:

- **Open PR**: A small PR icon badge on the edge, colored by PR state (green for open, purple for draft, yellow for changes requested)
- **PR checks**: A tiny status dot (green check, red X, yellow spinner) next to the PR badge
- **Merged PR**: The edge style changes to indicate the merge is complete (solid green, then fades)

PR edges are distinct from risk edges — a lane pair can have both an open PR edge and a conflict risk edge simultaneously. The PR badge is always rendered on top for visibility.

---

## User Experience

### Canvas Layout

The graph occupies the full content area when the Workspace Graph tab is active.
The canvas is powered by React Flow and supports:

- **Infinite panning**: Drag empty canvas to pan in any direction
- **Smooth zooming**: Scroll wheel, trackpad pinch, or dedicated zoom buttons
- **Auto-layout**: On first render, nodes are arranged automatically based on
  their relationships (primary centered, worktrees in a radial or hierarchical
  layout around it)
- **Manual override**: Drag any node to reposition it; the new position is
  persisted so the layout survives app restarts
- **Minimap**: A small overview panel in the bottom-right corner shows the full
  graph with a viewport indicator for navigation

### Node Display

Each node renders the following information:

- **Lane name** (primary label, e.g., "feature/auth-refactor")
- **Branch name** (secondary label if different from lane name)
- **Status badges**:
  - Dirty indicator (uncommitted changes)
  - Ahead/behind counts relative to upstream
  - Conflict indicator (merge conflicts present in worktree)
- **Active session indicator**: A pulsing dot or border glow when a terminal
  session is running in this lane
- **Environment badge** (if configured): Shows the mapped environment name (e.g., "PROD", "DEV") with the configured color

**Node sizing and styling by type**:

- Primary node: 200x100px, 3px solid border in accent color, centered on canvas
- Worktree node: 160x80px, 2px solid border in neutral color
- Attached node: 160x80px, 2px dashed border in muted color

### Edge Display

Edges connect nodes and are drawn as SVG paths:

- **Topology edges**: Straight or curved solid lines from primary to each worktree.
  Always visible. Neutral gray color by default, overridden by edge state color
  when risk data is available.
- **Stack edges**: Curved lines with an arrowhead pointing from parent to child.
  Thicker stroke (3px vs 1.5px). Indicates dependency direction.
- **Risk overlay edges**: Dashed lines between any two lanes with overlapping
  changes. Only rendered when the conflict service reports risk. Color follows
  the edge state palette (green/blue/red/gray).
- **PR edges**: When a pull request exists between two lanes, a PR icon badge is rendered on the connecting edge. Color indicates PR state (green=open, purple=draft, yellow=changes requested). A check status dot shows CI results.

### Merge Simulation Panel

When a user clicks an edge, an overlay panel appears with merge simulation details:

1. **Header**: Source lane name and target lane name with an arrow between them
2. **Prediction badge**: Clean (green), Auto-merge (blue), or Conflicts (red)
3. **Conflicting files list**: Table of files with conflicts, showing file path
   and conflict type (content, rename, delete)
4. **File-level diff preview**: Click a file in the list to see the predicted
   diff inline
5. **Actions**:
   - "Proceed with Merge" button (executes the merge)
   - "Cancel" button (closes panel)
   - "Open in Conflicts Tab" link (navigates to dedicated conflict resolution)

### Interactions

| Action | Input | Result |
|--------|-------|--------|
| Pan canvas | Drag on empty space | Moves viewport |
| Zoom | Scroll wheel / pinch | Zooms in or out |
| Select node | Click node | Highlights node, shows detail panel |
| Select edge | Click edge | Opens merge simulation panel |
| Multi-select | Shift+click or drag selection box | Selects multiple nodes |
| Context menu | Right-click node | Shows actions: Open, Archive, Delete, Create Child |
| Navigate minimap | Click on minimap | Moves viewport to clicked area |
| Zoom to fit | Click zoom-to-fit button | Fits all nodes in viewport |
| Reset layout | Context menu on canvas | Re-runs auto-layout algorithm |

---

## Technical Implementation

### Libraries

| Library | Purpose | Version |
|---------|---------|---------|
| `@xyflow/react` | Node/edge canvas with pan, zoom, minimap, controls | Latest stable |
| Custom React components | Node renderers for Primary, Worktree, Attached types | N/A |
| Custom React components | Edge renderers for Topology, Stack, Risk types | N/A |

React Flow provides the core canvas infrastructure including viewport management,
node dragging, edge routing, minimap, and controls panel. Custom node and edge
components handle ADE-specific rendering and interaction.

### Services

| Service | Status | Role |
|---------|--------|------|
| `laneService` | Exists | Provides the list of all lanes and their metadata (name, branch, status, type). Each lane becomes a node on the graph. |
| `conflictService` | Exists, implemented | Computes pairwise risk between lanes by performing dry-run merges. Provides the risk matrix that determines edge states. |
| Layout persistence (via `kvDb`) | Exists (kvDb implemented, graphState get/set IPC channels registered) | Saves and restores node positions so manual layout adjustments survive app restarts. Uses the existing key-value store. |

### IPC Channels

| Channel | Direction | Status | Payload |
|---------|-----------|--------|---------|
| `ade.lanes.list()` | Main -> Renderer | Exists | Returns `Lane[]` — all lanes for rendering as nodes |
| `ade.conflicts.getRiskMatrix()` | Main -> Renderer | Exists | Returns `RiskMatrix` — pairwise risk levels for all lane pairs |
| `ade.layout.get(projectId)` | Main -> Renderer | Exists (registered as `ade.graphState.get`) | Returns saved node positions for the given project |
| `ade.layout.set(projectId, positions)` | Renderer -> Main | Exists (registered as `ade.graphState.set`) | Persists node positions to kvDb |

### Component Architecture

```
WorkspaceGraphPage (route: /graph)
  +-- ReactFlowProvider
       +-- ReactFlow (canvas)
       |    +-- PrimaryLaneNode (custom node)
       |    +-- WorktreeLaneNode (custom node)
       |    +-- AttachedLaneNode (custom node)
       |    +-- TopologyEdge (custom edge)
       |    +-- StackEdge (custom edge)
       |    +-- RiskEdge (custom edge)
       +-- MiniMap
       +-- Controls (zoom buttons, fit-to-view)
       +-- MergeSimulationPanel (overlay, shown on edge click)
       +-- NodeContextMenu (shown on right-click)
```

### Data Flow

1. On mount, `WorkspaceGraphPage` calls `ade.lanes.list()` to fetch all lanes.
2. Lanes are transformed into React Flow nodes with type, position, and data props.
3. Topology and stack edges are derived from lane relationships (parent lane ID,
   primary lane reference).
4. The component calls `ade.conflicts.getRiskMatrix()` to fetch pairwise risk data.
5. Risk edges are generated for each lane pair with non-clean risk.
6. Edge colors are set based on risk level from the matrix.
7. Saved positions are loaded from `ade.layout.get()` and applied to nodes.
8. When a user drags a node, the new position is debounced and saved via
   `ade.layout.set()`.
9. When a user clicks an edge, the merge simulation panel fetches detailed
   conflict data for that specific lane pair.

---

## Data Model

### Layout Persistence

Node positions are stored in the existing `kvDb` key-value store under a
project-scoped key:

```
Key:    layout:<projectId>
Value:  JSON object mapping node IDs to {x, y} coordinates

Example:
{
  "lane-abc123": { "x": 400, "y": 200 },
  "lane-def456": { "x": 100, "y": 350 },
  "lane-ghi789": { "x": 700, "y": 350 }
}
```

### Risk Matrix Cache

The risk matrix is computed by the conflict service and cached in memory with a
TTL. It is not persisted to disk since it changes frequently as lanes are modified.

```typescript
interface RiskMatrix {
  pairs: Array<{
    laneA: string;       // Lane ID
    laneB: string;       // Lane ID
    risk: 'clean' | 'auto-merge' | 'conflicts' | 'unknown';
    conflictingFiles?: string[];  // Only present if risk is 'conflicts'
    computedAt: string;           // ISO timestamp
  }>;
}
```

### Filesystem Artifacts

No new filesystem artifacts are introduced. Layout data lives in `kvDb` (SQLite).
Risk data lives in memory. All lane data comes from the existing lane service.

---

## Implementation Tracking

All tasks for the Workspace Graph feature are listed below. This feature has no
completed tasks; it is entirely in the planning stage.

| ID | Task | Description | Status |
|----|------|-------------|--------|
| GRAPH-001 | React Flow canvas setup | Install `@xyflow/react`, create `WorkspaceGraphPage` route, render empty canvas | TODO |
| GRAPH-002 | Primary lane node component | Custom React Flow node for primary lane with distinct styling | TODO |
| GRAPH-003 | Worktree lane node component | Custom React Flow node for worktree lanes with standard styling | TODO |
| GRAPH-004 | Attached lane node component | Custom React Flow node for attached/external worktrees with dashed border | TODO |
| GRAPH-005 | Node status badges | Render dirty, ahead/behind, and conflict badges on each node | TODO |
| GRAPH-006 | Active session indicator | Pulsing dot or border glow on nodes with running terminal sessions | TODO |
| GRAPH-007 | Topology edges | Solid edges from primary node to each worktree node | TODO |
| GRAPH-008 | Stack edges | Arrow edges from parent to child lane with thicker stroke | TODO |
| GRAPH-009 | Risk overlay edges | Dashed edges between lanes with change overlap, colored by risk | TODO |
| GRAPH-010 | Edge state coloring | Apply green/blue/red/gray coloring based on risk matrix data | TODO |
| GRAPH-011 | Pan and zoom controls | Zoom buttons, fit-to-view button, scroll-wheel zoom | TODO |
| GRAPH-012 | Auto-layout algorithm | Compute initial node positions based on lane relationships | TODO |
| GRAPH-013 | Manual node repositioning | Enable node dragging with position persistence on drop | TODO |
| GRAPH-014 | Layout persistence | Save/restore node positions via kvDb across app restarts | TODO |
| GRAPH-015 | Click node navigation | Click a node to navigate to lane detail view or show inline panel | TODO |
| GRAPH-016 | Click edge merge simulation | Click an edge to open the merge simulation overlay panel | TODO |
| GRAPH-017 | Merge simulation result display | Show prediction badge, conflicting files list, diff preview | TODO |
| GRAPH-018 | Node context menu | Right-click menu with Open, Archive, Delete, Create Child actions | TODO |
| GRAPH-019 | Minimap | React Flow minimap in bottom-right corner with viewport indicator | TODO |
| GRAPH-020 | Multi-select | Shift+click and drag-box selection for multiple nodes | TODO |
| GRAPH-021 | Zoom-to-fit button | Single click to fit all nodes within the current viewport | TODO |
| GRAPH-022 | Theme-aware styling | Node and edge colors adapt to dark (Bloomberg) and light (Paper) themes | TODO |
| GRAPH-023 | Environment mapping configuration (branch-to-env in ade.yaml) | TODO |
| GRAPH-024 | Environment badge rendering on nodes | TODO |
| GRAPH-025 | Environment-aware auto-layout (env branches centered, features radiate) | TODO |
| GRAPH-026 | PR edge overlays (PR icon badge, state color, check status dot) | TODO |
| GRAPH-027 | PR + risk edge coexistence (both visible simultaneously on same lane pair) | TODO |
| GRAPH-028 | Environment legend (color key panel in canvas corner) | TODO |

### Dependency Notes

- GRAPH-001 is a prerequisite for all other tasks.
- GRAPH-002 through GRAPH-004 can be developed in parallel once GRAPH-001 is complete.
- GRAPH-007 through GRAPH-010 depend on node components (GRAPH-002 to GRAPH-004).
- GRAPH-016 and GRAPH-017 depend on `conflictService` (already implemented in Phase 5).
- GRAPH-014 depends on the existing `kvDb` service (already implemented).
- GRAPH-022 should be addressed last, after all functional tasks are complete.
- GRAPH-023 through GRAPH-025 depend on the configuration service (Phase 2).
- GRAPH-026 and GRAPH-027 (PR edge overlays) depend on the GitHub integration being built first. Both PR integration and Workspace Graph are in Phase 7, but the PR service (`githubService`, `prService`) must be functional before PR overlays can render on the graph.

---

*This document describes the Workspace Graph feature for ADE, planned for Phase 7 (GitHub Integration + Workspace Graph). Service-layer prerequisites (conflict service, kvDb layout persistence, reparent/appearance IPC, and supporting types) are already implemented from Phase 4/5. See `docs/PHASE_4_5_UPDATES.md` Part 3 for the extended scope including view modes (WG18), reparent drag-and-drop (WG14-15), batch operations (WG16), collapsible sub-graphs (WG17), custom appearance (WG19), graph filtering (WG20), layout presets (WG21), loading states (WG23), and conflict animations (WG25). PR edge overlays (GRAPH-026, GRAPH-027) depend on the GitHub integration also being delivered in Phase 7.*
