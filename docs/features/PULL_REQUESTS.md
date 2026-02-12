# Pull Requests — GitHub Integration & Stacked PRs

> Last updated: 2026-02-11

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
- [User Experience](#user-experience)
  - [Lane PR Panel](#lane-pr-panel)
  - [PRs Tab](#prs-tab)
  - [PR Workflow](#pr-workflow)
  - [Stacked PR Workflow](#stacked-pr-workflow)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [Authentication](#authentication)
  - [IPC Channels](#ipc-channels)
  - [Stacked PR Logic](#stacked-pr-logic)
- [Data Model](#data-model)
  - [Database Tables](#database-tables)
  - [Type Definitions](#type-definitions)
- [Implementation Tracking](#implementation-tracking)

---

## Overview

The Pull Requests feature connects ADE lanes to GitHub pull requests, enabling
developers to create, monitor, and land PRs without leaving the ADE workflow. Since
ADE already models work as lanes (branches with context), the PR integration is a
natural extension: each lane can produce a PR, and stacked lanes produce stacked PRs
with correct base targeting.

This feature eliminates the context switch between the development environment and
GitHub's web UI for routine PR operations. Developers can create a PR, monitor CI
checks, track review status, update descriptions, and merge — all from within ADE.
For stacked workflows, ADE handles the complexity of landing PRs in the correct
order and retargeting child PRs automatically.

**Current status**: This feature is planned for **Phase 7** (GitHub Integration + Workspace Graph). All tasks are TODO. No PR work has been built yet.

**Phase 6 prerequisite**: Phase 6 (Cloud Infrastructure + Auth + LLM Gateway) must be completed before Phase 7 can begin. Key dependencies:

- **LLM-powered PR description drafting** (PR-007) requires the LLM gateway from Phase 6 to generate pack-based descriptions.
- **GitHub OAuth authentication** (PR-001) uses AWS Cognito from Phase 6 for secure token management and OAuth flow.

**Cross-feature note**: CONF-022 (stack-aware conflict resolution) is also in Phase 7's scope, bridging the conflict detection system (Phase 5) with the stacked PR workflow.

---

## Core Concepts

### Lane-to-PR Mapping

Each lane can have at most one associated pull request. PRs are either created
directly from a lane (using the lane's branch, commit history, and pack context)
or linked to an existing GitHub PR by URL or number. The mapping is stored in the
local database and kept in sync with GitHub.

### Stacked PRs

When lanes are stacked (parent-child relationships), their associated PRs form a
chain. Each child PR targets its parent's branch as the base (not `main`), so
reviewers see only the incremental changes. ADE manages the base targeting
automatically and handles retargeting when parent PRs are merged.

**Example stack**:

```
main
 └── feature/auth         PR #101 (base: main)
      └── feature/auth-ui  PR #102 (base: feature/auth)
           └── feature/auth-tests  PR #103 (base: feature/auth-ui)
```

### PR Status

ADE tracks multiple dimensions of PR status:

| Dimension | Values |
|-----------|--------|
| **State** | `draft`, `open`, `merged`, `closed` |
| **Checks** | `pending`, `passing`, `failing`, `none` |
| **Reviews** | `none`, `requested`, `approved`, `changes_requested` |
| **Merge readiness** | Derived from state + checks + reviews + conflicts |

### Land Flow

"Landing" a PR means merging it on GitHub and cleaning up locally. For single PRs,
this merges the PR, deletes the remote branch, and archives the local lane. For
stacked PRs, ADE lands them in order (parent first), retargets each child PR to
the new base, and cleans up the entire chain.

### Pack-Generated Descriptions

When creating a PR, ADE auto-drafts the description from the lane's pack content.
The pack contains a structured summary of what happened during development —
commits, file changes, test results, and a narrative. This provides reviewers with
rich context without the developer having to write it manually.

---

## User Experience

### Lane PR Panel

Located inside the Lanes tab as a "PR" sub-tab for each lane. This is the primary
interface for managing a single lane's pull request.

**States**:

**No PR associated**:
- "Create PR" button — opens creation form
- "Link existing PR" button — enter GitHub PR URL or number

**PR creation form**:
- **Title**: Pre-filled from branch name (e.g., `feature/auth` becomes "Feature auth"),
  editable
- **Body**: Auto-drafted from lane pack (deterministic section + narrative), editable
  with markdown preview
- **Base branch**: Auto-selected (parent lane's branch if stacked, otherwise `main`),
  changeable via dropdown
- **Draft toggle**: Create as draft PR (default off, configurable)
- **Labels**: Optional, from repository label list
- **Reviewers**: Optional, from repository collaborator list
- "Create" button — creates PR via GitHub API and stores mapping

**PR associated** (main view):
- **Status header**: PR title, number (#101), state badge, link to GitHub
- **Checks section**: List of CI checks with status icons (pass/fail/pending),
  last run timestamp, expandable details
- **Reviews section**: List of reviewers with status (pending, approved, changes
  requested), latest review comment preview
- **Merge conflicts**: Warning if GitHub reports merge conflicts
- **Quick actions**:
  - "Open in GitHub" — launches browser to PR page
  - "Update description" — regenerate from current pack state
  - "Push changes" — push latest lane commits to remote
  - "Refresh status" — force-fetch latest PR status from GitHub

### PRs Tab

A global tab providing a project-wide view of all pull requests.

**Layout**:

```
+-----------------------------------------------+
|  [Stacked Chains] [All PRs] [Filters ▼]       |
+-----------------------------------------------+
|                                                |
|  Stacked chains section / All PRs list         |
|  (switches based on selected view)             |
|                                                |
+-----------------------------------------------+
```

**Stacked chains section**:
- Visual chain diagrams showing stacked PR relationships
- Each node: PR title, number, state badge, checks icon, review icon
- Chain flows top-to-bottom (parent at top, deepest child at bottom)
- Click a node to navigate to that lane's PR panel
- "Land stack" button on chains where the parent PR is merge-ready
- Chain health indicator: all green (ready to land), mixed, blocked

**All PRs list**:
- Flat list of every lane PR in the project
- Columns: PR number, title, lane name, state, checks, reviews, updated
- Sort by: updated (default), created, PR number, state
- Click row to navigate to lane's PR panel

**Filters**:
- By state: draft, open, merged, closed
- By checks: passing, failing, pending
- By reviews: approved, changes requested, pending
- By stack: show only PRs that are part of a stack
- By lane: filter to a specific lane

**Land stack flow**:
1. Select a stack chain
2. Click "Land stack"
3. Confirmation dialog showing the merge order and what will happen:
   - "Will merge PR #101 into main"
   - "Will retarget PR #102 to main, then merge into main"
   - "Will retarget PR #103 to main, then merge into main"
   - "Will archive lanes: feature/auth, feature/auth-ui, feature/auth-tests"
4. Progress view: each step shown with status (pending/running/done/failed)
5. Completion summary: all merged, branches deleted, lanes archived

### PR Workflow

Standard single-PR workflow:

1. **Develop**: Work in a lane — edit files, run terminals, commit changes.
2. **Push**: Push lane commits to the remote branch (via terminal or quick action).
3. **Create PR**: Open the Lane PR panel, click "Create PR". Title is pre-filled
   from branch name; body is auto-drafted from the lane pack.
4. **Monitor**: Watch CI checks and review status in the PR panel. ADE polls
   GitHub periodically and updates in real time.
5. **Iterate**: Address review feedback by making changes in the lane and pushing.
   Optionally update the PR description to reflect new changes.
6. **Land**: When checks pass and reviews are approved, click "Land" to merge the
   PR, delete the remote branch, and archive the lane.

### Stacked PR Workflow

Workflow for stacked lanes with chained PRs:

1. **Stack lanes**: Create child lanes that branch from parent lanes.
2. **Create PRs**: Create PRs for each lane in the stack. ADE automatically sets
   the base branch to the parent lane's branch.
3. **Review**: Each PR shows only incremental changes (child vs. parent), making
   review easier for large features broken into steps.
4. **Land stack**: When the entire stack is ready, use "Land stack" to merge all
   PRs in the correct order, retargeting children as parents merge.
5. **Partial landing**: If only the parent is ready, land it individually. ADE
   retargets the next child to `main` (or the new base) automatically.

---

## Technical Implementation

### Services

| Service | Status | Responsibility |
|---------|--------|----------------|
| `githubService` | **New (planned)** | GitHub API integration — PR CRUD, checks, reviews, merge operations. Wraps `gh` CLI or GitHub REST/GraphQL API. |
| `prService` | **New (planned)** | PR lifecycle management — creation, status tracking, stack chain logic, land flow orchestration. |
| `packService` | Exists | Provides lane pack content for auto-drafting PR descriptions. |
| `laneService` | Exists | Lane-PR association, parent-child relationships for stacking. |
| `operationService` | Exists | Records PR land operations in the history timeline. |

### Authentication

GitHub authentication is handled securely:

- **Token storage**: GitHub personal access token (PAT) or OAuth token stored in
  the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).
- **Token acquisition**: Obtained via `gh auth login` (if `gh` CLI is installed)
  or manual entry in ADE settings.
- **Scope requirements**: `repo` scope for private repositories, `public_repo` for
  public repositories.
- **Security policy**: Tokens are **never** stored in config files, environment
  variables, or the SQLite database. They are read from the keychain at runtime
  and held in memory only for the duration of API calls.
- **Token refresh**: ADE prompts the user if a token is expired or has insufficient
  permissions.

### IPC Channels

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.prs.createFromLane` | `(args: { laneId: string; title: string; body: string; draft: boolean; base?: string }) => PrSummary` | Create a new GitHub PR from a lane |
| `ade.prs.linkToLane` | `(args: { laneId: string; prUrl: string }) => PrSummary` | Link an existing GitHub PR to a lane |
| `ade.prs.getForLane` | `(laneId: string) => PrSummary \| null` | Get the PR associated with a lane |
| `ade.prs.listAll` | `() => PrSummary[]` | List all PRs in the current project |
| `ade.prs.getStatus` | `(prId: string) => PrStatus` | Get detailed status for a PR |
| `ade.prs.getChecks` | `(prId: string) => PrCheck[]` | Get CI check results for a PR |
| `ade.prs.getReviews` | `(prId: string) => PrReview[]` | Get review status for a PR |
| `ade.prs.updateDescription` | `(args: { prId: string; body: string }) => void` | Update the PR description on GitHub |
| `ade.prs.land` | `(args: { prId: string; method: MergeMethod }) => LandResult` | Merge a single PR and clean up |
| `ade.prs.landStack` | `(args: { rootLaneId: string; method: MergeMethod }) => LandResult[]` | Land an entire stack of PRs in order |
| `ade.prs.draftDescription` | `(laneId: string) => string` | Generate a PR description from the lane pack |

### Stacked PR Logic

When landing a stack, ADE executes the following sequence:

```
landStack(rootLaneId):
  1. Resolve full stack chain: [root, child1, child2, ...]
  2. Validate: all PRs exist, all checks passing, all reviews approved
  3. For each PR in order (root first):
     a. If not the root: retarget PR base to the merged parent's target
     b. Merge the PR via GitHub API
     c. Delete the remote branch
     d. Record the land operation in history
     e. Archive the lane locally
  4. Return results for each step
```

**Retargeting logic**:

When a parent PR is merged into `main`, its child PR's base changes from the
parent's branch (now deleted) to `main`. ADE updates this via the GitHub API
before merging the child. This ensures each child PR can be merged cleanly
in sequence.

---

## Data Model

### Database Tables

```sql
-- Stores the mapping between lanes and GitHub PRs
pull_requests (
  id TEXT PRIMARY KEY,             -- ADE-generated UUID
  lane_id TEXT NOT NULL,           -- FK to lanes table
  project_id TEXT NOT NULL,        -- FK to projects
  github_pr_number INTEGER,        -- GitHub PR number (e.g., 101)
  github_url TEXT,                 -- Full URL to the PR on GitHub
  github_node_id TEXT,             -- GitHub GraphQL node ID (for API operations)
  title TEXT,                      -- PR title (synced from GitHub)
  state TEXT NOT NULL,             -- 'draft' | 'open' | 'merged' | 'closed'
  base_branch TEXT,                -- Target branch (e.g., 'main' or parent branch)
  head_branch TEXT,                -- Source branch (lane's branch name)
  checks_status TEXT,              -- 'pending' | 'passing' | 'failing' | 'none'
  review_status TEXT,              -- 'none' | 'requested' | 'approved' | 'changes_requested'
  additions INTEGER DEFAULT 0,     -- Total lines added
  deletions INTEGER DEFAULT 0,     -- Total lines deleted
  last_synced_at TEXT,             -- Last time status was fetched from GitHub
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

-- Index for fast lane lookups
CREATE INDEX idx_pull_requests_lane_id ON pull_requests(lane_id);
CREATE INDEX idx_pull_requests_project_id ON pull_requests(project_id);
```

### Type Definitions

```typescript
type PrState = 'draft' | 'open' | 'merged' | 'closed';
type ChecksStatus = 'pending' | 'passing' | 'failing' | 'none';
type ReviewStatus = 'none' | 'requested' | 'approved' | 'changes_requested';
type MergeMethod = 'merge' | 'squash' | 'rebase';

interface PrSummary {
  id: string;
  laneId: string;
  projectId: string;
  githubPrNumber: number;
  githubUrl: string;
  title: string;
  state: PrState;
  baseBranch: string;
  headBranch: string;
  checksStatus: ChecksStatus;
  reviewStatus: ReviewStatus;
  additions: number;
  deletions: number;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PrStatus {
  state: PrState;
  checksStatus: ChecksStatus;
  reviewStatus: ReviewStatus;
  isMergeable: boolean;
  mergeConflicts: boolean;
  behindBaseBy: number;        // Number of commits behind base
}

interface PrCheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled' | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface PrReview {
  reviewer: string;
  state: 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  body: string | null;
  submittedAt: string | null;
}

interface LandResult {
  prId: string;
  prNumber: number;
  success: boolean;
  mergeCommitSha: string | null;
  branchDeleted: boolean;
  laneArchived: boolean;
  error: string | null;
}

interface StackChain {
  rootLaneId: string;
  lanes: Array<{
    laneId: string;
    laneName: string;
    prNumber: number | null;
    prState: PrState | null;
    checksStatus: ChecksStatus | null;
    reviewStatus: ReviewStatus | null;
    depth: number;               // 0 = root, 1 = first child, etc.
  }>;
  isReadyToLand: boolean;        // All PRs approved and checks passing
}
```

---

## Implementation Tracking

All tasks for this feature are **TODO** — implementation has not yet begun. Phase 6 (Cloud Infrastructure + Auth + LLM Gateway) must be completed first, as PR-001 (GitHub OAuth) relies on Cognito and PR-007 (description drafting) relies on the LLM gateway.

### Authentication & API

| ID | Task | Status |
|----|------|--------|
| PR-001 | GitHub authentication (OS keychain token storage and retrieval) | TODO |
| PR-002 | GitHub API integration service (`githubService`) | TODO |

### PR CRUD

| ID | Task | Status |
|----|------|--------|
| PR-003 | PR creation from lane (GitHub API call, local record) | TODO |
| PR-004 | PR link to existing (by URL or number, fetch and store) | TODO |
| PR-005 | PR status display (state badge, checks icon, review icon) | TODO |
| PR-006 | PR status polling (periodic refresh from GitHub) | TODO |
| PR-007 | Pack-generated PR description drafting | TODO |
| PR-008 | PR description update (push to GitHub) | TODO |

### Lane PR Panel

| ID | Task | Status |
|----|------|--------|
| PR-009 | Lane PR panel component (sub-tab in Lane detail) | TODO |
| PR-010 | PR creation form (title, body, base, draft, labels, reviewers) | TODO |
| PR-011 | PR status view (checks, reviews, conflicts) | TODO |
| PR-012 | "Open in GitHub" action (launch external browser) | TODO |

### PRs Tab

| ID | Task | Status |
|----|------|--------|
| PR-010 | PRs tab page layout (stacked chains view, all PRs list) | TODO |
| PR-011 | All PRs list with sortable columns and filters | TODO |
| PR-013 | Stacked PR chain visualization (node graph) | TODO |

### Stacked PRs & Landing

| ID | Task | Status |
|----|------|--------|
| PR-014 | Base retargeting for stacked PRs (update via GitHub API) | TODO |
| PR-015 | Land single PR (merge, delete branch, archive lane) | TODO |
| PR-016 | Land stack flow (ordered merge, retarget, cleanup) | TODO |
| PR-017 | Land progress UI (step-by-step status display) | TODO |

### Advanced Features

| ID | Task | Status |
|----|------|--------|
| PR-017 | PR checks integration (CI status detail view) | TODO |
| PR-018 | PR review status integration (reviewer list, comments) | TODO |
| PR-019 | PR notifications (check failures, review requests, merge ready) | TODO |
| PR-020 | PR template support (load from `.github/PULL_REQUEST_TEMPLATE.md`) | TODO |
