# GitHub stacked pull requests

GitHub is the authority for stack membership, order, reviews, branch rules,
merge queue state and merging. DAEX adds lane and chat context, a fast view in
the PRs tab, stack creation and sync, and the merge through GitHub's async
merge API. Stacks are a GitHub public preview; DAEX uses the `2026-03-10` REST
contract and treats the repository-scoped stack number as the identity.

- Stacks live in the PRs tab; there is no Stacks tab.
- DAEX does not recreate GitHub's merge box and does not need `gh-stack`.
- The DAEX GitHub App is enough for desktop and headless stack operations; an environment token is an automation override.

Sources: `apps/desktop/src/main/services/prs/githubStackStore.ts` (decode,
persist, reconcile), `githubStackMerge.ts` (merge),
`renderer/components/prs/shared/GitHubStackInspector.tsx`, `GitHubStackBadge.tsx`.

## Model

DAEX stores complete GitHub stack snapshots, never inferring membership from
lane parents or PR bases. A `GitHubPrStack` has repo, global id and stack
number, base branch, open/completed state, ordered entries (bottom → top: PR
number, position, state, head branch and SHA, merged time), fetch time and the
last reconciliation error. Snapshots are replaced whole in one transaction.
When lane topology and GitHub disagree, GitHub wins.

## Lifecycle

Webhooks are hints that schedule an authoritative read, never membership
mutations:

- `pull_request.opened` may arrive before the PR joins a stack; `pull_request.stacked` and later deliveries carrying `pull_request.stack` schedule one `GET /repos/{owner}/{repo}/stacks/{number}`.
- A known member's delivery without stack metadata reconciles its previous stack.
- Relay cursor expiry, and a project's first relay drain, run a bounded repository-wide reconcile (`reconcileGithubStacks`).
- Duplicate or out-of-order deliveries cannot overwrite a newer snapshot.
- GitHub sends no `unstacked` action, so refresh and background polling reconcile removals.

Partial merges keep completed entries as history; open entries take new bases
from GitHub. `merge_queued` is not merged. A fully merged stack stays visible
and cannot be extended.

## Operations

Actions in the `pr` domain (desktop, web, CLI, agent tools):
`listGithubStacks`, `createGithubStack`, `addGithubStackPullRequests`,
`syncGithubStacks`, `unstackGithubStack` (with a consequence preview),
`linkChatStack`, `getStackLinkOffer`, and merge through `land`.

## PRs tab

- Rows show stack metadata from the cached snapshot; opening the tab makes no per-row stack request. `Stacked` filters to members; `Group by stack` draws connected rails.
- A stacked PR's detail opens with `GitHubStackInspector`: the base and each layer as a chip (state, number, CI dot), one line saying what blocks the merge from the bottom up (`Blocked at #842: checks failing.`), and Refresh, GitHub, Manage (add PRs, Unstack) and a layer-list toggle. A merged PR finds its completed stack by member number.

**Merging.** The Merge card on a stacked PR merges every open PR from the stack
base up to it, all or none, through `githubStackMerge.ts`; the first click arms
the button. **Bypass branch rules** is offered on every layer, but GitHub honors
a bypass only for the bottom open PR, so from higher up DAEX merges layer by
layer from the bottom, waiting for GitHub to restack each. The stale-head guard
holds: lower heads must be inside the confirmed top head, and each restacked
layer must carry the same commits and files, or the run stops. A failure names
the layers that merged. iOS offers the layered bypass above the bottom PR only
when the host advertises `prsStackLayeredBypass` in `hello_ok.features`.

## Work cards and chats

- When every member is merged, linked chats get one `pr_stack_land` card keyed `pr-stack-land:{owner}:{repo}:{stackNumber}` (`prChatCards.ts`), updated in place and sent to every linked chat, including other lanes. Card actions only navigate.
- Chats own PRs through `pull_request_chat_sessions` edges ([PR README › chat edges](./README.md#multi-pr-lane-ownership-and-chat-edges)). A link from a coordinator chat on another lane is a reference, not a claim, so each layer's own chats keep their PR.
- When a chat's PR belongs to a stack, the pane offers **Link stack** for unclaimed siblings (**Not now** hides it per chat and stack). A new layer an agent creates attaches to parent chats that linked an earlier layer.

## Agent guidance

The bundled skills teach agents to propose dependency-ordered, reviewable
layers first, ask whether to use one lane per PR or a lead with subagents, keep
foundations at the bottom, fix shared failures at the lowest owning layer and
rebase upward, report bottom-up, and leave final review and merge to GitHub.

## Edge cases worth testing

Opened-then-stacked ordering; duplicate and out-of-order deliveries;
inaccessible or deleted members; partial merges and retargeting; closed or
draft members below a ready one; down-stack check and rule blockers; stale or
rate-limited GitHub with a cached snapshot; forks and non-default bases;
completed and remotely unstacked stacks; older clients receiving additive
fields.
