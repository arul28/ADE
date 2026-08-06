---
name: ade-pr-workflows
description: Use this skill when working with ADE PR workflows including PR tab data, GitHub stacked PRs, checks/comments, rebase resolution, CI fixes, or landing a PR.
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

## GitHub stacked PRs

A stack is two or more dependency-ordered, independently reviewable PRs. ADE
creates and tracks them through built-in commands; users and agents do not need
the `gh-stack` extension:

```bash
ade prs stacks list --text
ade prs stacks sync --text
ade prs stacks create --pulls 120,121,122 --text
ade prs stacks add --stack 8 --pulls 123 --text
ade prs stacks unstack --stack 8 --text
```

Mechanics specific to ADE stacks:

1. Order the layers bottom to top and keep foundations below their consumers.
2. Create one deliberate branch and PR per layer. Each layer can own a child
   ADE lane (`ade lanes child`) and its own agent, so every layer gets an
   isolated worktree and ship loop; alternatively one lead keeps the whole
   branch chain and delegates only non-overlapping work.
3. `ade prs stacks create` expects every PR base to already match the previous
   PR's head branch — create the stack only after the bases line up.
4. Fix a root-layer failure once, then rebase and repoll every layer above it
   instead of applying duplicate fixes.
5. Report readiness bottom to top from one stack progress view.

GitHub owns stack membership, review requirements, rebases performed on GitHub,
merge queue state, and final merging. ADE enforces this: `ade prs land` (the
`pr.land` action) refuses any PR that ADE knows is in a GitHub stack, failing
with `github_stack_requires_github_merge` and "PR #N is in GitHub Stack #M.
Review and merge the stack on GitHub." For an unstacked PR, `land` still merges
directly via `gh pr merge`. So send review and merge decisions for a stacked PR
to GitHub.

## PR creation closeout links

When you create or adopt a GitHub PR, include both the GitHub URL
(`githubUrl` / `html_url`) and the ADE PR link in your final handoff. The
`adeUrl` printed by `ade prs create` is the ADE link; for a PR adopted through
another path, mint it as described in the **ade-deeplinks** skill, which is also
where the HTTPS-vs-`ade://` guidance lives.

## Use actions for niche surfaces

```bash
ade actions list --domain pr --text
ade actions run <domain.action> --input-json '{"key":"value"}'
```

## Freshness

For review-thread or CI work, fetch current checks/comments with
`ade prs checks` / `ade prs comments` first; the PR tab snapshot can be stale.
