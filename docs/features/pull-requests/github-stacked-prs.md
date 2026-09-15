# GitHub stacked pull requests

GitHub is the authority for stacked pull request membership, ordering, review
requirements, rebases performed on GitHub, merge queue state, and merging. ADE
adds local lane and agent context, a fast operational view, native stack
creation and synchronization, and local conflict repair.

Stacked pull requests are part of GitHub's public preview. ADE uses the
`2026-03-10` REST API contract and treats the repository-scoped GitHub stack
number as the remote identity.

## Product boundaries

- Stacks live in the existing PRs tab. There is no separate top-level Stacks
  tab.
- GitHub remains the final review and merge surface. ADE opens that surface in
  the built-in browser and does not recreate GitHub's merge box.
- ADE may create, extend, unstack, rebase, adopt, and locally repair stacks.
- Existing integration PR workflows remain independent from stacked PRs.
- Users do not need to install `gh-stack`; ADE uses GitHub's API directly.
- Authorizing the ADE GitHub App is sufficient for desktop and headless CLI
  stack operations. An explicit environment token remains available as an
  automation override; a separate PAT or `gh` login is not required.

## Canonical model

ADE persists complete GitHub stack snapshots rather than inferring remote stack
membership from lane parents or PR base branches.

```text
GitHubPrStack
  repo owner/name
  global id + repository-scoped stack number
  base branch
  open/completed state
  ordered entries (bottom → top)
  fetched timestamp + last reconciliation error

GitHubPrStackEntry
  PR number + original position
  open/closed/merged/draft state
  head branch + SHA
  merged timestamp
```

Lane topology remains ADE's local execution model. When lane topology and the
GitHub stack disagree, GitHub wins for remote membership and ADE presents the
divergence with an explicit adopt or restructure action.

Whole stack snapshots are replaced transactionally. Webhooks are hints that
schedule an authoritative stack read; they are not independently applied as
membership mutations.

## GitHub lifecycle

- A normal `pull_request.opened` delivery may arrive before the PR joins a
  stack.
- `pull_request.stacked` identifies the stack when a PR is added.
- Later `pull_request` deliveries include `pull_request.stack` while the PR
  remains stacked.
- A webhook referencing a stack schedules one authoritative
  `GET /repos/{owner}/{repo}/stacks/{number}`.
- A known member delivery with missing stack metadata schedules reconciliation
  of its previously known stack.
- Cursor expiry schedules a bounded repository-wide stack reconciliation.
- Duplicate and out-of-order deliveries cannot overwrite a newer complete
  snapshot with partial event data.
- Because GitHub does not document an `unstacked` webhook action, explicit
  refresh and background polling reconcile removals and dissolved stacks.

Partial merges preserve completed entries for history while the remaining open
entries receive their new bases and positions from GitHub. `merge_queued` is not
treated as merged. Fully completed stacks remain visible as history and cannot
be extended.

## Operations

ADE exposes the same workflow through desktop, hosted web, CLI actions, and
agent tools:

```text
list/show status
plan layers
create from ordered lanes or PRs
add an eligible PR or lane to the top
adopt a remote stack into local lanes
sync local and remote state
request a clean GitHub rebase
merge the stack through GitHub
resolve conflicts locally with ADE
unstack with a consequence preview
open the GitHub review/merge surface
```

Structural changes such as reorder, insert, fold, rename, or remove are
destructive remote/local operations. They require a clean worktree, linear
history, no queued member, a preview of the resulting chain, and explicit
confirmation. ADE snapshots the prior branch heads before applying changes.

## PRs tab

The normal GitHub PR list renders stack metadata from the cached aggregate
snapshot. Opening the tab never performs per-row stack requests.

```text
#843  Desktop stack UI                         Stack 4 of 5
      feat/stack-ui → feat/stack-cli           Checks pass · Review pending
```

- `Stacked` filters to stack members.
- `Group by stack` shows connected rails; ordinary sorting shows position
  badges without implying row adjacency.
- Selecting the badge opens a compact stack map.
- The PR detail pane opens a full stack inspector with GitHub readiness plus
  ADE lane, agent, worktree, validation, and conflict context.
- Copy uses concrete state: `Blocked by #842: one required check failed`, not
  internal terms such as queue position or landing state.
- Empty, loading, stale, permission, unsupported-host, conflict, queued,
  partially merged, and completed states have distinct copy and actions.

The primary final action is `Review and merge on GitHub`. Mutating ADE actions
open the inspector and require confirmation.

## Work card

One stable `pr_stack` card follows an ADE stack plan from proposed layers through
published GitHub PRs and final merge. Its card id is based on the ADE stack plan
id and does not change when GitHub assigns a stack number.

```text
GitHub stacked PR integration                     3 of 5 ready
│ ✓ #840  API and persistence                     merged
│ ✓ #841  GitHub synchronization                  approved
│ ! #842  CLI and agent tools                     checks failed
│ ● #843  PRs UI                                  agent working
│ ○ #844  Work card                               planned
└ main

Blocked at #842 · one required check failed
```

Desktop renders a graphical rail, iOS reuses the native stack diagram, and the
TUI uses Unicode nodes and lines. The coordinator thread owns the complete card;
member sessions receive a compact layer card. External stacks do not create
chat cards until a user adopts them into an ADE work session.

Card actions navigate to the stack inspector, GitHub review surface, or owning
agent. Rebase, restructure, and unstack never execute directly from transcript
history.

## Chat linking

Work chats own PRs through hybrid edges (`pull_request_chat_sessions`) plus
unlink tombstones (`pull_request_chat_session_dismissals`). The Work peek stays
a peek: `#N` header or a chip switcher, status, three churn-ranked files, a
banner to link unclaimed GitHub stack siblings, and a jump to the PRs tab
Files view. Merge and rebase are not peek actions.

- Humans see the stack-offer banner in the peek and choose Link stack or Not
  now. Agents silent-expand the next layer onto parent chats that already
  linked the base; they do not emit `pr_stack_offer`.
- A chat that created a layer edges that PR. Parent chats that already linked
  an earlier stack member also receive the new layer. Child chats do not get
  the parent's base PR dumped onto them.
- Cross-lane links are allowed for GitHub stack members or an explicit pick.
  Lane headers stay lane-scoped.
- Searching `#N` in the palette returns the Work chats linked to that PR.

When every member of a GitHub stack is merged, linked Work chats receive one
stable `pr_stack_land` card (`pr-stack-land:{owner}:{repo}:{stackNumber}`) so
later layers update the same episode.

## Merge and rebase on the PRs tab

The GitHub stack inspector is the merge/rebase surface. It tries
`POST /repos/{owner}/{repo}/stacks/{number}/merge` (API version `2026-03-10`)
and falls back to bottom-up `merge-async` plus GET polling until `merged_at`
(45s). Rebase tries the stack rebase endpoint, then cascading
`update-branch` with `expected_head_sha`. A 404/403/405 leaves Merge stack and
Rebase stack visibly disabled with the GitHub reason — the peek only jumps
here. Windows uses the same GitHub HTTP + SQLite path.

## Agent behavior

Bundled ADE skills teach agents to:

1. Propose dependency-ordered, independently reviewable layers before coding.
2. Ask whether the user wants one isolated ADE lane and owner per PR, or one
   lead coordinating subagents across stable boundaries.
3. Put foundations below their consumers.
4. Create and validate one deliberate branch layer at a time.
5. Run the ship loop for every PR and fix shared failures at the lowest owning
   layer before cascading the result upward.
6. Delegate only work whose dependency boundary is already stable.
7. Apply feedback to the correct layer, then rebase every layer above it.
8. Review and report progress bottom-up.
9. Keep one stack card current instead of emitting repeated status messages.
10. Send final review and merge decisions to GitHub.

## Delivery stack

The implementation is itself delivered as stacked pull requests:

1. Canonical GitHub stack types, persistence, REST reads, and webhook
   reconciliation.
2. Stack mutations, ADE actions, typed CLI commands, and bundled agent skills.
3. Desktop and hosted-web PR list, grouping, routing, and inspector.
4. Work card protocol plus desktop and `ade code` rendering.
5. iOS PR and Work parity.
6. Remove superseded ADE-owned landing machinery and finish analytics and
   documentation.

Each layer runs focused quality review, contract tests, type checks for touched
packages, and the normal PR ship loop before the stack is merged.

## Required edge coverage

- Opened then stacked webhook ordering.
- Duplicate, replayed, and out-of-order deliveries.
- Remote-only, partially adopted, inaccessible, or deleted members.
- Local lane order diverging from GitHub order.
- Partial merges and survivor retarget/rebase.
- Closed or draft members below an otherwise ready member.
- Down-stack checks, reviews, rules, and merge-queue blockers.
- Clean rebase running, diverged branches, merge conflicts, and failed rebase.
- Stale/rate-limited GitHub detail with a retained cached snapshot.
- Inspector open while the remote stack changes.
- Non-default bases, same-repository enforcement, fork rejection, and 100-entry
  stacks.
- Completed and remotely unstacked stacks.
- Agent or lane removal while the GitHub member remains active.
- Older desktop, web, TUI, and iOS clients receiving additive card/snapshot
  fields.
