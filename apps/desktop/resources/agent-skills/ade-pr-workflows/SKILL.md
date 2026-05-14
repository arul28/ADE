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
