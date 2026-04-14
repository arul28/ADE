# Stacked pull requests

Stacked PRs are PRs whose base branch is another lane's branch
rather than `main` (or the project default). Each PR in the chain
gets reviewed independently but merges in dependency order.

The lane stack model is documented in
[`../lanes/stacking.md`](../lanes/stacking.md); this doc focuses on
how stacked lanes map to PRs, how rebase ordering works for
dependency chains, and how queue-aware rebase targeting changes
things.

## Mapping stacked lanes to PRs

Stacked lanes form a chain through `parent_lane_id`. When a PR is
opened from a child lane:

- `PrSummary.baseBranch = parent_lane.branch_ref` (not the project default).
- `PrSummary.headBranch = lane.branch_ref`.

When the parent lane's PR merges, the child's base branch
effectively becomes the old parent branch (now merged into project
default). ADE rebases the child onto the new base to retarget the
PR.

## `landStack` and `landStackEnhanced`

`ade.prs.landStack` takes a root PR id and lands it plus all
downstream open PRs in dependency order, optionally archiving lanes
on merge. The enhanced variant (`landStackEnhanced`, used by the
Queue tab) additionally:

- Accepts a per-PR merge method override
- Emits per-step events for UI progress rendering
- Applies auto-rebase before each land if a descendant has drifted
- Stops on the first failure rather than attempting partial landings

## Upstream rebase chain

A child lane that is behind its parent usually needs to rebase before
its PR can land. If the parent is _also_ behind its own parent, the
full upstream chain matters. The `buildUpstreamRebaseChain` helper
in `renderer/components/prs/shared/rebaseNeedUtils.ts` walks up the
parent chain from a given lane and returns an `UpstreamRebaseNeed[]`:

```ts
type UpstreamRebaseNeed = {
  laneId: string;
  laneName: string;
  kind: RebaseNeed["kind"];       // "lane_base" | "pr_target"
  baseBranch: string;
  behindBy: number;
  conflictPredicted: boolean;
};
```

The Rebase tab uses this to show the chain in context so the user
can decide: rebase this lane now, or rebase an ancestor first (which
may fix several descendants in one shot).

`formatUpstreamRebaseSummary` produces a human-readable chain summary.

## Rebase need kinds

`RebaseNeed` carries a `kind` field:

- **`lane_base`** — the lane is behind its computed base branch or
  parent lane.
- **`pr_target`** — the lane's open PR targets a branch different
  from the lane's computed base, and the lane is behind that PR
  target. Example: user opens a PR against `develop` but the lane's
  `base_ref` is `main`.

Both kinds can coexist for the same lane. The renderer helpers
dedupe by `rebaseNeedItemKey(need) = ${laneId}:${kind}:${prId ??
"base"}:${baseBranch}`.

## Queue-aware rebase

When a lane's PR belongs to an active merge queue, rebase targets
the queue's tracking branch rather than the lane's static base.
`resolveQueueRebaseOverride()` in
`src/main/services/shared/queueRebase.ts` returns:

```ts
type QueueRebaseOverride = {
  comparisonRef: string;           // e.g., "origin/merge-queue-123"
  displayBaseBranch: string;       // human-readable branch name for UI
};
```

Consumers:

- `conflictService.resolveLaneRebaseTarget` — uses the override when
  present, otherwise falls back to parent tracking or `base_ref`.
- `conflictService.scanRebaseNeeds` / `getRebaseNeed` — pre-fetches
  all queue target tracking branches via
  `fetchQueueTargetTrackingBranches()` before scanning.
- `rebaseLane` — AI-assisted rebase also respects the queue override.

Queue group context (`groupId`, `groupName`) propagates into the
`RebaseNeed` so the UI can display which queue the rebase relates to.

## `forcePushAfterRebase`

The rebase request accepts an optional `forcePushAfterRebase` flag.
This is typically required for `pr_target` rebase needs (the PR
already exists on the remote and rebasing rewrites history) and
optional for `lane_base` rebases where the lane hasn't been pushed
yet.

The AI rebase prompt assumes `forcePushAfterRebase = true` unless
explicitly set to `false`:

```
args.forcePushAfterRebase !== false
```

## AI rebase resolver

`prRebaseResolver.ts` constructs a prompt tailored to the lane's
state:

- Lane metadata (name, branch, base, behind-by, worktree)
- List of files likely to conflict (from the rebase need)
- Recent commits on the base branch (the upstream commits)
- Recent commits on the lane

Launches an agent chat session in the lane's worktree with the
prompt. The session gets the standard workflow tool set and follows
the permissive instructions in the prompt (navigate to worktree,
fetch, rebase, resolve conflicts by merging intelligently, continue,
optionally force-push).

Permission mode is resolved via `mapPermissionMode(args.permissionMode)`.

## Rebase attention items

`rebaseAttentionUtils.ts` exposes failures from the auto-rebase
service as a `stack_attention` section in the Rebase tab:

```ts
type RebaseAttentionItem = {
  laneId: string;
  laneName: string;
  parentLaneId: string | null;
  parentLaneName: string | null;
  state: "rebaseFailed" | "rebaseConflict" | "rebasePending" | "autoRebased";
  conflictCount: number;
  message: string | null;
  source: "auto" | "manual";
  updatedAt: string;
};
```

Helpers:

- `buildRebaseAttentionItems(statuses, lanes)` — joins statuses with
  lane metadata.
- `filterRebaseAttentionStatuses(...)` / `findRebaseAttentionStatus(...)` —
  filter and lookup.

The Rebase and Workflows tabs receive `attentionStatuses` alongside
regular rebase needs so the UI can show both "lanes that need action
right now" and "lanes the auto-rebase loop couldn't handle."

## Rebase resolution launch flow

User clicks "Rebase with AI" in the Rebase tab →
`prsIssueResolutionStart` is not the path (that's issue resolution);
the rebase launch goes through `rebaseResolutionStart` IPC which
eventually calls `prRebaseResolver.ts`'s `startRebaseResolution()`:

1. Look up the lane; verify worktree exists.
2. Call `conflictService.getRebaseNeed(laneId)`. Throw if no need.
3. Parallel-read recent commits for lane + remote base + local base.
4. Prefer `origin/<base>` commits over local when available (remote
   is the rebase target in most cases).
5. Build the rebase prompt.
6. Create a chat session with `sessionProfile: "workflow"` and
   `requestedCwd: lane.worktreePath`.
7. Send the prompt.
8. Return `{ sessionId, laneId, href }` so the UI can deep-link
   straight into the running session.

## Data model touchpoints

- `pull_requests` — the PR row.
- `pr_groups` (`group_type: queue | integration`) — PR group tables.
- `pr_group_members` — ordered membership with `role: source | integration | target | … `.
- `queue_landing_state` — queue state (see [`queue.md`](./queue.md)).
- `pr_issue_inventory`, `pr_convergence_state` — issue resolution / convergence.

## Gotchas

- **Don't cross-wire `lane_base` and `pr_target` rebase needs.** The
  UI surfaces them with different action copy. Deduplication uses
  `rebaseNeedItemKey`, not plain `laneId`.
- **Queue rebase override must precede parent tracking.** If a PR
  is in a queue, the queue's tracking branch always wins even if the
  lane has a non-primary parent. `resolveLaneRebaseTarget` checks
  `queueOverride` first.
- **`force-push` after rebase is destructive.** Only opt in for
  `pr_target` needs or when the user explicitly selects it. The AI
  rebase prompt includes this option in its planning section.
- **Stack membership changes during a run.** A `landStack` run may
  archive the oldest lanes as they merge. Pre-compute the order
  once and iterate a snapshot; reading the stack chain every
  iteration causes reorderings when an earlier land succeeded.
