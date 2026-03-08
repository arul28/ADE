# Pull Requests — Lane PRs, Stacks, and Integration Simulation

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-08

---

## Overview

The PR feature maps ADE lanes to GitHub pull requests and supports both single-lane and stacked workflows.

Current behavior uses:

- GitHub APIs for remote PR lifecycle operations,
- **local git-only simulation** for integration/conflict prediction and merge planning.

There is no legacy VCS adapter/backfill path in the simulation pipeline.

---

## Core Concepts

### Lane-to-PR mapping

Each lane can be linked to one PR record in ADE state. PR status, checks, and review signals are synced from GitHub.

### Stacked PRs

Parent/child lane relationships define stacked PR base targeting. Landing logic merges in dependency order and updates local state accordingly.

### Integration proposals

For multi-lane merges, ADE can simulate and persist an integration proposal with pairwise conflict analysis and ordered merge steps.

---

## Git-Only Simulation Path (Current Baseline)

PR integration simulation is computed from local git primitives:

- `git rev-parse` for base/head resolution,
- `git merge-tree --write-tree --messages` for dry merge/conflict signals,
- `git diff --name-only` and `git diff --numstat` for overlap and diff stats,
- optional heuristic overlap fallback when merge-tree output has no parsable conflict paths.

This path runs directly against local repository state and does not depend on legacy remote-only simulators.

---

## Conflict Path Integration

Conflict service and PR service share the same modern merge prediction assumptions:

- merge-base and head SHAs resolved via git,
- merge outcomes predicted with `runGitMergeTree(...)`,
- conflicted file sets and marker previews extracted from git output,
- integration lane/rebase helpers using local worktree state.

This keeps PR readiness and conflict prediction consistent across `/prs`, Graph risk workflows, and lane-level conflict surfaces.

---

## PR Detail View (Split-Pane)

The PR tab now provides a full **split-pane detail view** (`PrDetailPane`) for inspecting and managing pull requests without leaving ADE. The design follows a Graphite/GitButler-tier experience: selecting a PR in the list opens its detail pane alongside the list, giving developers a dense, information-rich view of every aspect of a PR.

### Why split-pane

Traditional Git GUIs force users to navigate away from the PR list to view details, losing context. The split-pane keeps the list visible for quick switching while dedicating the remaining space to a rich detail surface with sub-tabs.

### Detail Tabs

| Tab | Contents |
|-----|----------|
| **Overview** | PR description (markdown rendered), metadata badges (state, CI, review), labels with color chips, assignees with avatars, requested reviewers, linked issues, milestone |
| **Files** | Changed files list with per-file additions/deletions counts, file status indicators (A/D/M/R/C), expandable patch view per file showing the diff |
| **Activity** | Unified timeline of all PR events — comments, reviews, commits, label changes, CI status changes, review requests, state transitions — displayed chronologically with author avatars |
| **CI (Checks)** | GitHub Actions workflow runs with expandable job/step detail, pass/fail/pending indicators per step, rerun button for failed checks |

### Inline Actions

From the detail pane, users can:

- Add comments (issue-level or inline)
- Edit the PR title and body in-place
- Set labels, request reviewers, submit reviews (APPROVE / REQUEST_CHANGES / COMMENT)
- Close or reopen the PR
- Rerun failed CI checks
- Request an AI-generated review summary
- Merge the PR (with method selection)

---

## prService Methods

### Existing Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `createFromLane` | `(args: CreatePrFromLaneArgs) => PrSummary` | Create a GitHub PR from a lane |
| `linkToLane` | `(args: LinkPrToLaneArgs) => PrSummary` | Link an existing GitHub PR to a lane |
| `getForLane` | `(args: { laneId }) => PrSummary[]` | Get PRs for a specific lane |
| `listAll` | `(args: { projectId }) => PrSummary[]` | List all PRs for a project |
| `refresh` | `(args: { projectId }) => PrSummary[]` | Refresh PR data from GitHub |
| `getStatus` | `(args: { prId }) => PrStatus` | Get live PR status (mergeable, behind-by, conflicts) |
| `getChecks` | `(args: { prId }) => PrCheck[]` | Get CI check runs |
| `getComments` | `(args: { prId }) => PrComment[]` | Get PR comments |
| `getReviews` | `(args: { prId }) => PrReview[]` | Get PR reviews |
| `updateDescription` | `(args: UpdatePrDescriptionArgs) => void` | Update PR description |
| `delete` | `(args: DeletePrArgs) => DeletePrResult` | Delete/close a PR |
| `land` | `(args: LandPrArgs) => LandResult` | Merge a PR |
| `landStack` | `(args: LandStackArgs) => LandResult[]` | Merge stacked PRs in order |

### New Detail & Action Methods (DONE)

These 14 methods were added to support the PR detail view and inline actions:

| Method | Signature | Description |
|--------|-----------|-------------|
| `getDetail` | `(args: { prId }) => PrDetail` | Fetch full PR detail from GitHub: body, labels, assignees, reviewers, author, draft status, milestone, linked issues |
| `getFiles` | `(args: { prId }) => PrFile[]` | Fetch changed files with patch/diff data |
| `getActionRuns` | `(args: { prId }) => PrActionRun[]` | Fetch GitHub Actions workflow runs with jobs and steps |
| `getActivityTimeline` | `(args: { prId }) => PrActivityEvent[]` | Fetch unified activity timeline (comments, reviews, commits, labels, CI runs, state changes, review requests) |
| `addComment` | `(args: AddPrCommentArgs) => void` | Add an inline or issue-level comment |
| `updateTitle` | `(args: UpdatePrTitleArgs) => void` | Update PR title |
| `updateBody` | `(args: UpdatePrBodyArgs) => void` | Update PR body/description |
| `setLabels` | `(args: SetPrLabelsArgs) => void` | Set PR labels |
| `requestReviewers` | `(args: RequestPrReviewersArgs) => void` | Request reviewers |
| `submitReview` | `(args: SubmitPrReviewArgs) => void` | Submit a review (APPROVE / REQUEST_CHANGES / COMMENT) |
| `closePr` | `(args: ClosePrArgs) => void` | Close PR without merging |
| `reopenPr` | `(args: ReopenPrArgs) => void` | Reopen a closed PR |
| `rerunChecks` | `(args: RerunPrChecksArgs) => void` | Rerun failed CI checks |
| `aiReviewSummary` | `(args: AiReviewSummaryArgs) => AiReviewSummary` | Generate an AI review summary (summary, potential issues, recommendations, merge readiness) |

### Why AI review summary is a separate method

The AI review summary is exposed as an independent, composable method rather than being baked into the detail view. This keeps the feature model-agnostic (callers pass the model they want), allows the summary to be invoked from other surfaces (graph, missions, orchestrator), and avoids coupling AI inference to the detail-fetch path.

---

## Types

### PR Detail Overhaul Types

Defined in `src/shared/types/prs.ts`:

```typescript
type PrDetail = {
  prId: string;
  body: string | null;
  labels: PrLabel[];
  assignees: PrUser[];
  requestedReviewers: PrUser[];
  author: PrUser;
  isDraft: boolean;
  milestone: string | null;
  linkedIssues: Array<{ number: number; title: string; state: string }>;
};

type PrLabel = { name: string; color: string; description: string | null };
type PrUser = { login: string; avatarUrl: string | null };

type PrFile = {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied";
  additions: number;
  deletions: number;
  patch: string | null;
  previousFilename: string | null;
};

type PrActionRun = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | "waiting";
  conclusion: "success" | "failure" | "neutral" | "cancelled"
    | "skipped" | "timed_out" | "action_required" | null;
  headSha: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  jobs: PrActionJob[];
};

type PrActionJob = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: PrActionStep[];
};

type PrActionStep = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | null;
  number: number;
  startedAt: string | null;
  completedAt: string | null;
};

type PrActivityEvent = {
  id: string;
  type: "comment" | "review" | "commit" | "label"
    | "ci_run" | "state_change" | "review_request";
  author: string;
  avatarUrl: string | null;
  body: string | null;
  timestamp: string;
  metadata: Record<string, unknown>;
};

type AiReviewSummary = {
  summary: string;
  potentialIssues: string[];
  recommendations: string[];
  mergeReadiness: "ready" | "needs_work" | "blocked";
};
```

### Action Argument Types

```typescript
type AddPrCommentArgs = { prId: string; body: string; inReplyToCommentId?: string };
type UpdatePrTitleArgs = { prId: string; title: string };
type UpdatePrBodyArgs = { prId: string; body: string };
type SetPrLabelsArgs = { prId: string; labels: string[] };
type RequestPrReviewersArgs = { prId: string; reviewers: string[] };
type SubmitPrReviewArgs = {
  prId: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body?: string;
};
type ClosePrArgs = { prId: string };
type ReopenPrArgs = { prId: string };
type RerunPrChecksArgs = { prId: string; checkRunIds?: number[] };
type AiReviewSummaryArgs = { prId: string; model?: string };
```

---

## IPC Channels

### Existing Channels

| Channel | Description |
|---------|-------------|
| `ade.prs.createFromLane` | Create PR from lane |
| `ade.prs.linkToLane` | Link existing PR to lane |
| `ade.prs.getForLane` | Get PRs for lane |
| `ade.prs.listAll` | List all PRs |
| `ade.prs.refresh` | Refresh from GitHub |
| `ade.prs.getStatus` | Get PR status |
| `ade.prs.getChecks` | Get CI checks |
| `ade.prs.getComments` | Get comments |
| `ade.prs.getReviews` | Get reviews |
| `ade.prs.updateDescription` | Update description |
| `ade.prs.delete` | Delete PR |
| `ade.prs.land` | Land (merge) PR |
| `ade.prs.landStack` | Land stacked PRs |
| `ade.prs.draftDescription` | AI-draft PR description |
| `ade.prs.openInGitHub` | Open in browser |
| `ade.prs.createIntegration` | Create integration PR |
| `ade.prs.landStackEnhanced` | Enhanced stack landing |
| `ade.prs.getConflictAnalysis` | Get conflict analysis |
| `ade.prs.getMergeContext` | Get merge context |
| `ade.prs.listWithConflicts` | List PRs with conflict data |
| `ade.prs.createQueue` | Create merge queue |
| `ade.prs.simulateIntegration` | Simulate integration |
| `ade.prs.commitIntegration` | Commit integration |
| `ade.prs.listProposals` | List proposals |
| `ade.prs.updateProposal` | Update proposal |
| `ade.prs.deleteProposal` | Delete proposal |
| `ade.prs.landQueueNext` | Land next in queue |
| `ade.prs.getHealth` | Get PR health |
| `ade.prs.getQueueState` | Get queue state |
| `ade.prs.createIntegrationLaneForProposal` | Create integration lane |
| `ade.prs.startIntegrationResolution` | Start resolution |
| `ade.prs.getIntegrationResolutionState` | Get resolution state |
| `ade.prs.recheckIntegrationStep` | Recheck step |
| `ade.prs.aiResolution.start` | Start AI resolution |
| `ade.prs.aiResolution.input` | Send AI resolution input |
| `ade.prs.aiResolution.stop` | Stop AI resolution |
| `ade.prs.event` | PR event stream |

### New Detail & Action Channels (DONE)

| Channel | Description |
|---------|-------------|
| `ade.prs.getDetail` | Fetch full PR detail (body, labels, assignees, reviewers, etc.) |
| `ade.prs.getFiles` | Fetch changed files with patches |
| `ade.prs.getActionRuns` | Fetch GitHub Actions workflow runs |
| `ade.prs.getActivity` | Fetch unified activity timeline |
| `ade.prs.addComment` | Add comment |
| `ade.prs.updateTitle` | Update title |
| `ade.prs.updateBody` | Update body |
| `ade.prs.setLabels` | Set labels |
| `ade.prs.requestReviewers` | Request reviewers |
| `ade.prs.submitReview` | Submit review |
| `ade.prs.close` | Close PR |
| `ade.prs.reopen` | Reopen PR |
| `ade.prs.rerunChecks` | Rerun failed checks |
| `ade.prs.aiReviewSummary` | Generate AI review summary |

---

## Component Architecture

### PR Tab Components

| Component | Path | Responsibility |
|-----------|------|----------------|
| `NormalTab` | `prs/tabs/NormalTab.tsx` | Standard PR list with per-PR status badges and row actions |
| `PrDetailPane` | `prs/detail/PrDetailPane.tsx` | Full split-pane detail view with Overview/Files/Activity/CI tabs |
| `prVisuals.tsx` | `prs/shared/prVisuals.tsx` | Shared badge/color logic for PR state, checks, reviews, edge colors, and activity state derivation — reused by both NormalTab and the workspace graph |

### Shared prVisuals

`prVisuals.tsx` provides consistent PR state coloring across the NormalTab list and Graph canvas overlays. Key exports:

- `getPrStateBadge(state)` / `getPrChecksBadge(status)` / `getPrReviewBadge(status)` — badge specs (label, color, background, border)
- `getPrEdgeColor({ state, checksStatus, reviewStatus, ciRunning })` — edge color for graph PR overlays
- `derivePrActivityState({ state, reviewStatus, lastActivityAt, pendingCheckCount })` — derives `PrActivityState` ("active" | "idle" | "stale") for graph node badges
- `PrInlineBadge` / `InlinePrBadge` — React components for inline badge rendering

By sharing this module, badge colors in the PR list and edge/node colors on the graph are always in sync.

---

## User Workflow

### Single lane PR

1. work in lane,
2. create or link PR,
3. monitor checks/reviews,
4. update description if needed,
5. land when merge-ready.

### Stacked lane PRs

1. create stacked lanes,
2. create PRs with correct parent base targeting,
3. review incrementally,
4. land in order (or land parent first and retarget descendants as needed).

### Integration simulation

1. choose source lanes and base branch,
2. run simulation,
3. inspect clean/conflict outcomes,
4. create integration lane when appropriate,
5. resolve remaining conflicts and proceed to commit/PR.

### PR Detail Inspection

1. Open PRs tab, select a PR from the list.
2. Detail pane opens alongside the list.
3. Use Overview tab to review description, labels, assignees, linked issues.
4. Switch to Files tab to browse changed files and patches.
5. Switch to Activity tab to follow the full event timeline.
6. Switch to CI tab to inspect workflow runs, jobs, and steps; rerun failures.
7. Use inline actions to comment, request reviewers, approve, or merge.
8. Optionally generate an AI review summary for a high-level assessment.

---

## Data and Persistence

PR data persists in local ADE state (pull request rows, group rows/members, integration proposal records, resolution state). Simulation artifacts are derived from git and stored in proposal state for follow-up actions.

---

## Practical Guidance

- Treat local git history/state as the source of truth for simulation outputs.
- Refresh lane packs before drafting PR descriptions for better summaries.
- Use integration proposals for multi-lane merges instead of ad hoc manual ordering.
- Use the detail pane for quick reviews and actions instead of switching to the GitHub web UI.
