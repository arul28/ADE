# Workspace Graph (Main Directory + Worktrees Overview)

Last updated: 2026-02-11

## 1. Goal

Provide a single visual overview of all active development surfaces in a repo:

- main repository directory
- all linked worktrees
- relationships between lanes/branches/stacks
- merge and conflict risk between any pair

## 2. UX Model

Workspace graph is an infinite-canvas style view.

### 2.1 Nodes

- Primary workspace node (main directory), centered by default
- Worktree lane nodes
- Attached lane nodes

Node details:

- lane name/type
- workspace path
- active branch
- dirty/clean
- ahead/behind
- tests status
- PR status
- conflict risk score

### 2.2 Edges

- topology edge: primary -> worktree relationship
- stack edge: parent -> child lane relationship
- risk edge overlay: overlap/merge risk severity

Edge states:

- `clean`
- `auto-merge`
- `conflicts`
- `unknown`

## 3. Interactions

- pan/zoom
- click node to focus lane details
- click edge to open merge simulation details
- filter nodes by status/type/risk
- compare two selected lanes directly

## 4. Merge Simulation

Users can simulate merge/rebase outcomes between any lanes (or lane -> branch) without mutating worktrees.

Output:

- predicted outcome state
- likely conflict files
- coarse conflict types
- suggested next action

## 5. Data Inputs

- lanes/workspaces metadata
- stack relationships
- per-lane status
- conflict radar predictions (base and pairwise)
- recent checkpoints/operations for freshness hints

## 6. Performance Rules

- render from cached topology + prediction snapshots
- coalesce pairwise recomputation
- avoid full recomputation on every keystroke

## 7. Development Checklist

MVP:

- [ ] Graph data model for workspace topology
- [ ] Node/edge renderer in Lanes canvas mode
- [ ] Node focus and edge detail interactions
- [ ] Snapshot-based risk overlays

V1:

- [ ] Live updates from staged/dirty changes
- [ ] Grouping/clustering for large repos
- [ ] Time-travel overlay using history checkpoints
