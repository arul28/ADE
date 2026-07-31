---
name: ade-pr-workflows
description: Use this skill when working with ADE PR workflows including PR tab data, GitHub stacked PRs, checks/comments, rebase resolution, CI fixes, or merge readiness.
---

# ADE PR workflows

## Start with typed PR commands

```bash
ade prs list --text
ade prs show <pr-id-or-number-or-url> --text
ade prs checks <pr-id-or-number-or-url> --text
ade prs comments <pr-id-or-number-or-url> --text
```

Use `ade help prs` and `ade help git rebase` before guessing PR or rebase flags.

## Offer stacked PRs for layered work

When a request naturally divides into two or more dependency-ordered,
independently reviewable changes, offer a GitHub stack before implementation.
If the user accepts and has not already chosen how to run it, ask which
execution model they prefer:

- **One lane per PR** — create a child ADE lane and owning agent for every
  layer. Recommend this when layers are still changing or several agents will
  edit in parallel, because each PR gets an isolated worktree and ship loop.
- **Coordinated delegation** — one lead keeps the branch chain and delegates
  only stable, non-overlapping work to subagents. Recommend this for a tightly
  coupled stack where one agent should own rebases and commits.

Then:

1. Describe the layers bottom to top and keep foundations below their consumers.
2. Create one deliberate branch and PR per layer.
3. Run focused quality and tests for each layer before starting the next one.
4. Create the GitHub stack only after every PR base matches the previous PR's
   head branch.
5. Run the ship loop for every PR. Fix a root-layer failure once, then rebase
   and repoll every layer above it instead of applying duplicate fixes.
6. Apply review feedback to the lowest layer that owns the behavior, then
   rebase every layer above it.
7. Keep one stack progress card current and report readiness bottom to top.

Use ADE's built-in commands; users and agents do not need the `gh-stack`
extension:

```bash
ade prs stacks list --text
ade prs stacks sync --text
ade prs stacks create --pulls 120,121,122 --text
ade prs stacks add --stack 8 --pulls 123 --text
ade prs stacks unstack --stack 8 --text
```

GitHub owns stack membership, review requirements, rebases performed on
GitHub, merge queue state, and final merging. Send final review and merge
decisions to GitHub instead of using ADE's legacy synchronous merge path.

## PR creation closeout links

When you create or adopt a GitHub PR, include two links in your final handoff:

- GitHub PR: use the PR's `githubUrl` / `html_url`.
- ADE PR: use the `adeUrl` printed by `ade prs create`; if you created or
  adopted the PR through another path, run `ade link pr <owner/repo> <number>
  --no-clipboard` and include the printed `https://ade-app.dev/open?...` URL.

Prefer the HTTPS ADE link in chat, PR comments, and terminal output because it
unfurls and upgrades into `ade://pr/<owner>/<repo>/<number>` on machines with
ADE installed. The PR body already gets an automatic "Open in ADE" footer, but
the final agent message should still include both links so the user can jump
straight to either GitHub or the ADE PRs tab.

## Use actions for niche surfaces

```bash
ade actions list --domain pr --text
ade actions run <domain.action> --input-json '{"key":"value"}'
```

## Resolver rules

- Preserve both the lane's intent and main's intent during conflicts.
- Read conflict files and surrounding call sites before choosing a side.
- For review-thread or CI work, fetch current checks/comments first; do not rely on stale PR tab state.
- Prefer focused fixes and rerun the smallest relevant check before escalating to broader validation.

## Release readiness

Before treating a PR as merge-ready, verify working tree cleanliness, pushed branch status, required checks, unresolved review threads, and whether rebasing/merging main introduced conflicts or semantic drift.
