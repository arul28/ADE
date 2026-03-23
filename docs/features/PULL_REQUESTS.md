# Pull requests

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-23

ADE's PR surface manages lane-backed pull requests, queue workflows, integration proposals, and GitHub inspection. The current implementation still centers on local git truth for simulation and merge planning, but the UI data-loading model is now much lighter than the earlier eager version.

---

## Core model

The PR feature still supports:

- lane-to-PR mapping
- stacked PRs through lane parent/child relationships
- queue automation state
- integration proposals backed by local simulation
- GitHub detail, checks, reviews, and comments

Integration and conflict prediction still rely on local git primitives rather than a remote-only simulator.

---

## GitHub data-loading model

The GitHub tab is now built around cached snapshots instead of repeated cold remote fetches.

### Current behavior

- the main process caches the GitHub snapshot for a short TTL
- the renderer also caches the snapshot so revisiting the tab can render immediately
- manual sync explicitly forces a refresh
- repeated in-flight snapshot requests are deduplicated

This keeps revisits from paying the full GitHub fetch cost every time while preserving a clear force-refresh path when the user asks for fresh data.

### What the snapshot contains

The snapshot still includes:

- repo pull requests
- external pull requests involving the current user
- lane linkage and ADE workflow metadata

The GitHub tab remains the read-only inspection and import/linking surface for remote PRs.

---

## PR context loading

The broader PR page no longer assumes every tab needs every workflow query.

Current behavior:

- queue state only loads for workflow-oriented tabs
- merge contexts load lazily
- selected PR detail still loads status, checks, reviews, and comments on demand
- background PR refresh only updates a small stale subset instead of every PR on every cycle

This keeps the default PR surface from paying for queue/integration orchestration when the user is just browsing ordinary PRs.

---

## Integration proposals

ADE still supports saved integration proposals and committed integration workflows, but the interaction model is now more explicit.

### Manual simulation

Integration simulation is no longer auto-triggered just because the user entered the Integration tab or selected a PR.

Current behavior:

- simulation state resets when the selected PR changes
- actual simulation runs only when the user triggers it
- the rerun path remains available through the existing explicit actions

This avoids surprise expensive local simulation work and prevents stale proposals from silently re-running in the background.

### Local simulation path

Simulation continues to use local git operations such as:

- `git rev-parse`
- `git merge-tree`
- diff-based overlap checks

That keeps PR readiness and conflict prediction aligned with the actual local repo state.

---

## Queue and workflow state

Queue automation and committed integration workflows are still first-class PR concepts. The important change is that those states are now treated as **workflow-only data**, not data every PR screen must preload.

That is the main reason the normal PR and GitHub views feel less heavy than before.

---

## Current product contract

The current PR experience follows these rules:

- use local git state for merge/integration truth
- load normal PR browsing data first
- load workflow state only when the user is actually in a workflow view
- never auto-run expensive integration simulation just from tab selection
- make GitHub revisits warm through layered caching

That preserves the full PR feature set while keeping the common browse-and-review path much cheaper.

---

## PR issue resolution

ADE now supports agent-driven resolution of PR issues directly from the PR detail surface. This covers two categories of actionable PR issues:

- **Failing CI checks** — available once all check runs have completed and at least one has failed.
- **Unresolved review threads** — non-outdated GitHub review threads that still require action.

### How it works

The user opens the issue resolver modal from the PR detail pane and selects a scope (`checks`, `comments`, or `both`). ADE assembles a structured prompt from the live PR state (failing checks with workflow run detail, unresolved review threads with compact summaries, changed files, recent commits, and PR context), then launches a chat agent session in the lane worktree with that prompt.

The prompt assembly is handled by `prIssueResolver.ts` in the main process. The shared availability logic in `prIssueResolution.ts` determines which scopes are selectable based on current check and thread state.

### Agent tools for issue resolution

Chat agents working on PR issue resolution have access to four dedicated workflow tools in addition to the standard workflow tool set:

| Tool | Purpose |
|---|---|
| `prRefreshIssueInventory` | Fetch the latest checks, review threads, and comments so the agent can re-evaluate what still needs fixing |
| `prRerunFailedChecks` | Re-trigger failed GitHub Actions check runs after applying fixes |
| `prReplyToReviewThread` | Post a reply on a GitHub review thread |
| `prResolveReviewThread` | Mark a GitHub review thread as resolved |

These tools keep the agent loop self-contained: the agent can inspect issues, fix code, reply to reviewers, rerun CI, and resolve threads without leaving the ADE runtime.

### Review thread management

The PR service now exposes review thread data through a dedicated GraphQL-backed `getReviewThreads` method and supports thread replies and resolution via `replyToReviewThread` and `resolveReviewThread`. These are available through IPC for both the renderer UI and agent tool surfaces.

---

## Queue workflow model

Queue tab state management is now extracted into a dedicated model (`queueWorkflowModel.ts`) that handles:

- active/history bucketing of queue groups
- current member selection based on landing state or open PR position
- manual land warning generation from PR status
- queue guidance computation (idle, ready, warning, blocked, success tones with action recommendations)

This keeps queue tab rendering logic testable and separated from the component tree.

---

## PR route state

PR page tab navigation is now URL-driven through `prsRouteState.ts`. The route state encodes the active tab, workflow sub-tab, selected PR, queue group, and lane into URL search parameters. This makes PR tab state shareable and preserves selection across navigation.
