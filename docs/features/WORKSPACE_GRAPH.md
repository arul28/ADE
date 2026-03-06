# Workspace Graph — Visual Topology Canvas

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-02

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

**Current status**: Implemented (Phase 7). The `/graph` route renders the React Flow canvas and supports:

- Stack / Risk / Activity / All view modes
- Parent/child stack edges and primary topology edges
- Conflict risk overlays (from the conflict service) and merge simulation on edge click
- PR overlays and lane <-> PR actions
- Drag-to-reparent with cycle detection, multi-select, filters, and layout persistence

The Lanes tab also includes a lightweight mini stack graph for quick parent/child navigation, with an “Open canvas” button for the full graph.

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
   - Inline conflict actions for merge simulation and AI proposal workflows

### View Modes

The graph supports four view modes, each applying a different auto-layout algorithm and emphasizing different relationships:

| Mode | Focus | Layout Strategy |
|------|-------|-----------------|
| **Stack** | Parent-child stacking relationships | Hierarchical top-down layout. Stack edges are prominent; non-stack edges are dimmed. |
| **Risk** | Conflict risk between lanes | Force-directed layout grouping lanes with overlapping changes. Risk edges are colored by severity. |
| **Activity** | Recent commit activity | Nodes are sized and positioned by activity bucket (hot, warm, cold). Active lanes are centered and larger. |
| **All** | Complete topology | Shows all edge types equally. Default radial/hierarchical layout with primary lane centered. |

Switching view modes preserves per-mode layout positions — dragging a node in "stack" mode does not affect its position in "risk" mode. Positions are stored as a `GraphLayoutPreset` with separate snapshots per view mode.

### Batch Operations

The graph supports batch operations on multiple selected lanes. When multiple nodes are selected (via shift-click or drag-box), a batch toolbar appears with:

| Operation | Description |
|-----------|-------------|
| **Rebase** | Rebase selected lanes onto their parents (resolve stale stacks) |
| **Push** | Push all selected lanes to their remotes |
| **Fetch** | Fetch upstream changes for all selected lanes |
| **Archive** | Archive all selected lanes |
| **Delete** | Delete all selected lanes (with confirmation) |
| **Sync** | Sync all selected lanes (fetch + merge/rebase) |

Batch operations show a step-by-step progress indicator with per-lane status (pending, running, done, failed, skipped).

### Drag-to-Reparent

Dragging a node onto another node triggers a **reparent dialog** (not just repositioning). The dialog offers three action modes:

- **Reparent**: Change the dragged lane's parent to the target lane (with cycle detection to prevent invalid topologies)
- **Integrate**: Create a new integration lane that merges changes from both lanes
- **PR**: Open a PR creation dialog targeting the drop target lane

### Conflict Panel

Clicking a risk edge opens an inline **conflict panel** on the graph (rather than navigating away). The panel shows:

- The two conflicting lanes and their overlapping files
- File-level conflict details as they load from the conflict service
- Inline preparation, proposal, and apply actions without leaving Graph

### Integration Dialog

The graph includes an **integration dialog** for creating new integration branches directly from the canvas. Users select multiple lanes and create a named integration lane that merges their changes together. The dialog shows progress as the integration is set up.

### Filter Panel

A filter panel allows filtering visible nodes by:

- Lane name (text search)
- Lane status (active, archived, etc.)
- Environment mapping
- Stack membership

Filtered-out nodes are dimmed or hidden based on the filter mode.

### Interactions

| Action | Input | Result |
|--------|-------|--------|
| Pan canvas | Drag on empty space | Moves viewport |
| Zoom | Scroll wheel / pinch | Zooms in or out |
| Select node | Click node | Highlights node, shows detail panel |
| Select edge | Click edge | Opens conflict panel / merge simulation |
| Multi-select | Shift+click or drag selection box | Selects multiple nodes, shows batch toolbar |
| Drag node onto node | Drag and drop | Opens reparent dialog (reparent / integrate / PR) |
| Context menu | Right-click node | Shows actions: Open, Archive, Delete, Create Child, Create PR |
| Navigate minimap | Click on minimap | Moves viewport to clicked area |
| Zoom to fit | Click zoom-to-fit button | Fits all nodes in viewport |
| Switch view mode | Click view mode button (Stack / Risk / Activity / All) | Changes layout algorithm and edge emphasis |
| Reset layout | Context menu on canvas | Re-runs auto-layout algorithm for current view mode |

---

## Technical Implementation

### Libraries

| Library | Purpose | Version |
|---------|---------|---------|
| `@xyflow/react` | Node/edge canvas with pan, zoom, minimap, controls | Latest stable |
| Custom React components | Node renderers (`graphNodes/LaneNode.tsx`, `ProposalNode.tsx`) for Primary, Worktree, Attached types | N/A |
| Custom React components | Edge renderers (`graphEdges/RiskEdge.tsx`) for risk overlays; built-in renderers for topology and stack | N/A |

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

The graph feature has been decomposed from a single monolithic page component into focused modules. `WorkspaceGraphPage.tsx` (~4,139 lines) remains the top-level orchestrator, but types, layout algorithms, helper utilities, custom nodes, custom edges, and dialog panels are each extracted into dedicated files under `src/renderer/components/graph/`.

**Module breakdown:**

| Module | Path | Lines | Responsibility |
|--------|------|-------|----------------|
| `graphTypes.ts` | `graph/graphTypes.ts` | ~135 | Shared TypeScript types for nodes, edges, view modes, layout snapshots |
| `graphHelpers.ts` | `graph/graphHelpers.ts` | ~194 | Pure-function graph utilities (edge derivation, node filtering, batch operations) |
| `graphLayout.ts` | `graph/graphLayout.ts` | ~177 | Auto-layout algorithms for each view mode (stack, risk, activity, all) |
| `LaneNode.tsx` | `graph/graphNodes/LaneNode.tsx` | ~137 | Unified custom React Flow node component (adapts by lane type + view mode) |
| `ProposalNode.tsx` | `graph/graphNodes/ProposalNode.tsx` | ~53 | Node component for AI-generated proposal overlays |
| `RiskEdge.tsx` | `graph/graphEdges/RiskEdge.tsx` | ~87 | Custom edge renderer for risk overlays (dashed, colored by severity) |
| `RiskMatrix.tsx` | `graph/shared/RiskMatrix.tsx` | ~300 | Pairwise lane risk matrix reused by the Graph page |
| `RiskTooltip.tsx` | `graph/shared/RiskTooltip.tsx` | ~120 | Hover tooltip for overlap files in the risk matrix |
| `PrDialog.tsx` | `graph/graphDialogs/PrDialog.tsx` | ~280 | PR creation/linking dialog launched from canvas context menu |
| `ConflictPanel.tsx` | `graph/graphDialogs/ConflictPanel.tsx` | ~314 | Inline conflict detail panel (shown on risk edge click) |
| `IntegrationDialog.tsx` | `graph/graphDialogs/IntegrationDialog.tsx` | ~114 | Integration lane creation dialog |
| `TextPromptModal.tsx` | `graph/graphDialogs/TextPromptModal.tsx` | ~61 | Generic text-input modal (used for rename, reparent confirmation, etc.) |

Design tokens for lane styling (colors, borders, status indicators) are consolidated in `src/renderer/components/lanes/laneDesignTokens.ts` and shared between the graph nodes and the Lanes tab.

**Component tree:**

```
WorkspaceGraphPage (route: /graph)
  +-- View mode toolbar (Stack | Risk | Activity | All)
  +-- Filter panel (text search, status, environment)
  +-- Batch toolbar (visible when multi-select active)
  +-- ReactFlowProvider
       +-- ReactFlow (canvas)
       |    +-- LaneNode (graphNodes/LaneNode.tsx)
       |    +-- ProposalNode (graphNodes/ProposalNode.tsx)
       |    +-- RiskEdge (graphEdges/RiskEdge.tsx)
       |    +-- Built-in edge renderers (topology, stack)
       +-- MiniMap
       +-- Controls (zoom buttons, fit-to-view)
  +-- RiskMatrix (graph/shared/RiskMatrix.tsx)
  +-- ConflictPanel (graphDialogs/ConflictPanel.tsx)
  +-- PrDialog (graphDialogs/PrDialog.tsx)
  +-- IntegrationDialog (graphDialogs/IntegrationDialog.tsx)
  +-- TextPromptModal (graphDialogs/TextPromptModal.tsx)
  +-- ReparentDialog (shown on drag-to-reparent)
  +-- NodeContextMenu (shown on right-click)
  +-- BatchProgressPanel (shown during batch operations)
```

Graph components also use shared hooks and utilities extracted during the frontend decomposition:

- `src/renderer/hooks/useClickOutside.ts` -- Click-outside detection for dialogs and panels (replaces 4 inline implementations)
- `src/renderer/hooks/useThreadEventRefresh.ts` -- Shared hook for refreshing on thread events
- `src/renderer/lib/format.ts` -- Formatting utilities (`relativeWhen`, `formatDurationMs`, etc.) used in node badges and tooltips

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

Node positions are stored in the existing `kvDb` key-value store as a `GraphLayoutPreset` with **separate snapshots per view mode**. This means dragging a node in "stack" mode does not affect its position in "risk" mode.

```typescript
type GraphLayoutSnapshot = {
  viewMode: GraphViewMode;
  positions: Record<string, { x: number; y: number }>;
  zoom: number;
  panX: number;
  panY: number;
};

type GraphLayoutPreset = {
  name: string;
  byViewMode: {
    stack: GraphLayoutSnapshot;
    risk: GraphLayoutSnapshot;
    activity: GraphLayoutSnapshot;
    all: GraphLayoutSnapshot;
  };
};
```

Stored under a project-scoped key in `kvDb`.

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

Workspace Graph is **implemented** (Phase 7). The checklist below is retained for reference; all items are complete.

| ID | Task | Description | Status |
|----|------|-------------|--------|
| GRAPH-001 | React Flow canvas setup | Install `@xyflow/react`, create `WorkspaceGraphPage` route, render empty canvas | DONE |
| GRAPH-002 | Primary lane node component | Custom React Flow node for primary lane with distinct styling | DONE |
| GRAPH-003 | Worktree lane node component | Custom React Flow node for worktree lanes with standard styling | DONE |
| GRAPH-004 | Attached lane node component | Custom React Flow node for attached/external worktrees with dashed border | DONE |
| GRAPH-005 | Node status badges | Render dirty, ahead/behind, and conflict badges on each node | DONE |
| GRAPH-006 | Active session indicator | Pulsing dot or border glow on nodes with running terminal sessions | DONE |
| GRAPH-007 | Topology edges | Solid edges from primary node to each worktree node | DONE |
| GRAPH-008 | Stack edges | Arrow edges from parent to child lane with thicker stroke | DONE |
| GRAPH-009 | Risk overlay edges | Dashed edges between lanes with change overlap, colored by risk | DONE |
| GRAPH-010 | Edge state coloring | Apply green/blue/red/gray coloring based on risk matrix data | DONE |
| GRAPH-011 | Pan and zoom controls | Zoom buttons, fit-to-view button, scroll-wheel zoom | DONE |
| GRAPH-012 | Auto-layout algorithm | Compute initial node positions based on lane relationships | DONE |
| GRAPH-013 | Manual node repositioning | Enable node dragging with position persistence on drop | DONE |
| GRAPH-014 | Layout persistence | Save/restore node positions via kvDb across app restarts | DONE |
| GRAPH-015 | Click node navigation | Click a node to navigate to lane detail view or show inline panel | DONE |
| GRAPH-016 | Click edge merge simulation | Click an edge to open the merge simulation overlay panel | DONE |
| GRAPH-017 | Merge simulation result display | Show prediction badge, conflicting files list, diff preview | DONE |
| GRAPH-018 | Node context menu | Right-click menu with Open, Archive, Delete, Create Child actions | DONE |
| GRAPH-019 | Minimap | React Flow minimap in bottom-right corner with viewport indicator | DONE |
| GRAPH-020 | Multi-select | Shift+click and drag-box selection for multiple nodes | DONE |
| GRAPH-021 | Zoom-to-fit button | Single click to fit all nodes within the current viewport | DONE |
| GRAPH-022 | Theme-aware styling | Node and edge colors adapt to dark (Bloomberg) and light (Paper) themes | DONE |
| GRAPH-023 | Environment mapping configuration (branch-to-env in ade.yaml) | DONE |
| GRAPH-024 | Environment badge rendering on nodes | DONE |
| GRAPH-025 | Environment-aware auto-layout (env branches centered, features radiate) | DONE |
| GRAPH-026 | PR edge overlays (PR icon badge, state color, check status dot) | DONE |
| GRAPH-027 | PR + risk edge coexistence (both visible simultaneously on same lane pair) | DONE |
| GRAPH-028 | Environment legend (color key panel in canvas corner) | DONE |
| GRAPH-029 | View modes (Stack / Risk / Activity / All) with per-mode auto-layout | DONE |
| GRAPH-030 | Per-view-mode layout persistence (GraphLayoutPreset with byViewMode) | DONE |
| GRAPH-031 | Drag-to-reparent with cycle detection and reparent dialog | DONE |
| GRAPH-032 | Batch operations toolbar (rebase, push, fetch, archive, delete, sync) | DONE |
| GRAPH-033 | Batch progress indicator (per-lane step status) | DONE |
| GRAPH-034 | Integration dialog (create integration lane from canvas) | DONE |
| GRAPH-035 | Inline conflict panel on risk edge click | DONE |
| GRAPH-036 | Filter panel (text search, status, environment) | DONE |
| GRAPH-037 | Rebase failure indication (node border pulse on rebase failure) | DONE |
| GRAPH-038 | Activity bucket sizing (hot/warm/cold node dimensions) | DONE |

### Dependency Notes

- Historical note: the dependencies listed in this section are all satisfied in the current implementation.

---

*Workspace Graph is delivered as part of Phase 7 (GitHub Integration + Workspace Graph).*
