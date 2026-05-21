---
name: ade-pr-workflows
description: Use this skill when working with ADE PR workflows including PR tab data, PR checks/comments, queues, Path to Merge, rebase resolver, issue resolver agents, CI fixes, or merge readiness.
---

# ADE PR workflows

## Start with typed PR commands

```bash
ade prs list --text
ade prs show <pr-id-or-number-or-url> --text
ade prs checks <pr-id-or-number-or-url> --text
ade prs comments <pr-id-or-number-or-url> --text
ade prs path-to-merge <pr-id-or-number-or-url> --model <model> --max-rounds 3 --no-auto-merge --text
```

Use `ade help prs` and `ade help git rebase` before guessing PR or rebase flags.

## PR creation closeout links

When you create or adopt a GitHub PR, include two links in your final handoff:

- GitHub PR: use the PR's `githubUrl` / `html_url`.
- ADE PR: use the `adeUrl` printed by `ade prs create`; if you created or
  adopted the PR through another path, run `ade link pr <owner/repo> <number>
  --no-clipboard` and include the printed `https://ade.app/open?...` URL.

Prefer the HTTPS ADE link in chat, PR comments, and terminal output because it
unfurls and upgrades into `ade://pr/<owner>/<repo>/<number>` on machines with
ADE installed. The PR body already gets an automatic "Open in ADE" footer, but
the final agent message should still include both links so the user can jump
straight to either GitHub or the ADE PRs tab.

## Use actions for niche surfaces

```bash
ade actions list --domain pr --text
ade actions list --domain issue_inventory --text
ade actions run <domain.action> --input-json '{"key":"value"}'
```

## Resolver rules

- Preserve both the lane's intent and main's intent during conflicts.
- Read conflict files and surrounding call sites before choosing a side.
- For review-thread or CI work, fetch current checks/comments first; do not rely on stale PR tab state.
- Prefer focused fixes and rerun the smallest relevant check before escalating to broader validation.

## Release readiness

Before treating a PR as merge-ready, verify working tree cleanliness, pushed branch status, required checks, unresolved review threads, and whether rebasing/merging main introduced conflicts or semantic drift.
