# PRs tab action inventory

This is the audit matrix for PRs-tab autoresearch. It is deliberately not a
completion claim. A row is only `measured` when a real PRs-tab UI run has a
matching manual marker, an equivalent UI-derived probe against the perf-pass
repo, or a focused test that reproduces the exact behavior.

Coverage states:

- `source`: found in source, not yet driven in the current inventory pass.
- `measured`: exact row covered by a real PRs UI run, UI-derived probe, or
  focused fixture test with evidence.
- `measured-partial`: driven in an earlier partial pass; must be re-driven by
  this matrix before claiming full coverage.
- `fixture-needed`: safe to drive, but needs a seeded PR/lane/session state.
- `sandbox-only`: may start agents, local tools, or mutate the perf-pass repo.
- `prompt-only`: destructive or externally visible path. Open and measure the
  confirmation/preflight, then cancel unless explicitly allowed.
- `external-skip`: opens GitHub, a browser, another app, or copies to clipboard.
- `not-applicable`: row came from an older/source-derived inventory item but the
  current visible PRs surface no longer exposes that control.

Evidence run ids used so far:

- `prs-ui-baseline-20260512-051124`
- `prs-ui-lane-metadata-fast-inproc-20260512-060555`
- `prs-ui-rebase-fetch-ttl-20260512-062130`
- `prs-ui-ptm-audit-20260512-0635`
- `prs-ui-coverage-closeout-20260512-074602`

## Route shell

| id | action | state | evidence |
| --- | --- | --- | --- |
| prs.route.github.open | Open PRs route on GitHub surface with perf-pass project | measured | baseline and optimized run ids above |
| prs.route.workflows.open | Switch from GitHub surface to Workflows surface | measured | `prs-ui-rebase-fetch-ttl-20260512-062130` |
| prs.header.create-pr | Open Create PR modal | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.create.open` |
| prs.header.tab.github | Switch to GitHub tab | measured | `prs-ui-coverage-closeout-20260512-074602`, marker `prs.header.tab.github` |
| prs.header.tab.workflows | Switch to Workflows tab | measured | `prs-ui-rebase-fetch-ttl-20260512-062130` |

## GitHub list

| id | action | state | evidence |
| --- | --- | --- | --- |
| prs.github.snapshot.open | Load open PR snapshot | measured | `getGitHubSnapshot 5941ms -> 1146ms` |
| prs.github.search | Type and clear PR search | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.github.search` |
| prs.github.sync | Click Sync | measured | `prs-ui-coverage-closeout-20260512-074602`, marker `prs.github.sync`; explicit all-18 preload refresh measured at `3800ms` |
| prs.github.filter.open | Select Open filter | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.github.filters-and-scopes` |
| prs.github.filter.merged | Select Merged filter | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.github.filters-and-scopes` |
| prs.github.filter.closed | Select Closed filter | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.github.filters-and-scopes`; closed/all history fetch is intentionally opt-in |
| prs.github.filter.all | Select All filter | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.github.filters-and-scopes` |
| prs.github.scope.ade | Select ADE scope | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.github.filters-and-scopes` |
| prs.github.scope.external | Select External scope | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.github.filters-and-scopes` |
| prs.github.card.select.local | Select a local ADE PR card | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs-ptm-open-local-pr` |
| prs.github.card.select.external | Select an external PR card | measured | `prs-ui-coverage-closeout-20260512-074602`, marker `prs.github.card.select.external` |
| prs.github.card.open-github | Click PR card Open on GitHub | external-skip | `GitHubTab.tsx` |
| prs.github.card.open-queue | Click queue shortcut from PR card | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.detail.open-queue`; queue shortcut path also covered by `prs.queue.open-pr` |

## PR detail

| id | action | state | evidence |
| --- | --- | --- | --- |
| prs.detail.open | Open local PR detail pane | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs-ptm-open-local-pr` |
| prs.detail.open-external | Open external PR detail pane | measured | `prs-ui-coverage-closeout-20260512-074602`, marker `prs.detail.open-external` |
| prs.detail.refresh | Click detail Refresh | measured | `prs-ui-coverage-closeout-20260512-074602`, marker `prs.detail.refresh` |
| prs.detail.view-github | Click View/Open on GitHub | external-skip | `PrDetailPane.tsx` |
| prs.detail.more-menu | Open detail overflow menu | not-applicable | Current top-level `PrDetailPane.tsx` exposes direct `Refresh`, `GitHub`, `Graph`, and `Edit title` buttons; no detail overflow menu is rendered |
| prs.detail.copy-url | Copy PR URL from detail menu | not-applicable | No current top-level detail copy-url menu is rendered; comment-level copy links remain external/clipboard-skip |
| prs.detail.edit-title | Edit PR title | prompt-only | `PrDetailPane.tsx` |
| prs.detail.open-queue | Open linked queue from detail | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.detail.open-queue` |
| prs.detail.open-graph | Show lane in graph | external-skip | navigates away from PRs |
| prs.detail.overview | Open Overview tab | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.detail.overview` |
| prs.detail.files | Open Files tab | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.detail.files` |
| prs.detail.files.expand | Expand a changed file diff | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.detail.files.expand` |
| prs.detail.ci | Open CI / Checks tab | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.detail.ci` |
| prs.detail.ci.open-log | Open check log drawer | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.detail.ci.open-log`; Checks-tab button opened no drawer, Overview timeline log button did |
| prs.detail.ci.open-full-log | Open full CI log | external-skip | `PrCheckLogDrawer.tsx` |
| prs.detail.ci.rerun | Rerun checks | prompt-only | `PrDetailPane.tsx` |
| prs.detail.activity | Open Activity tab | measured | `prs-ui-coverage-closeout-20260512-074602`, marker `prs.detail.activity` |
| prs.detail.comment | Add PR comment | prompt-only | `ActivityTab` |
| prs.detail.review-modal | Open review modal | fixture-needed | hidden by timeline-rails overview in the current surface; drive with flag/fixture if still supported |
| prs.detail.review-submit | Submit PR review | prompt-only | `PrDetailPane.tsx` |
| prs.detail.request-reviewers | Edit/request reviewers | fixture-needed | hidden by timeline-rails overview in the current surface |
| prs.detail.labels | Edit labels | fixture-needed | hidden by timeline-rails overview in the current surface |
| prs.detail.ai-summary | Generate AI summary | fixture-needed | hidden by timeline-rails overview in the current surface |
| prs.detail.issue-resolver | Open issue resolver modal | fixture-needed | needs actionable failed checks or unresolved review threads |
| prs.detail.issue-resolver.start | Resolve issues with agent | sandbox-only | `PrIssueResolverModal.tsx` |
| prs.detail.close-pr | Close PR | prompt-only | `PrDetailPane.tsx` |
| prs.detail.reopen-pr | Reopen PR | prompt-only | `PrDetailPane.tsx` |

## Workflows shell

| id | action | state | evidence |
| --- | --- | --- | --- |
| prs.workflows.active | Select Active | measured | `prs-ui-coverage-closeout-20260512-074602`, marker `prs.workflows.active` |
| prs.workflows.history | Select History | measured | `prs-ui-coverage-closeout-20260512-074602`, marker `prs.workflows.history`; empty history state rendered |
| prs.workflows.integration | Select Integration | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.integration.select` |
| prs.workflows.queue | Select Queue | measured | `prs-ui-rebase-fetch-ttl-20260512-062130` |
| prs.workflows.rebase | Select Rebase/Merge | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.queue.inspect-rebase` |
| prs.workflows.refresh | Click Workflows Refresh | measured | stale/no-op UI plus explicit all-18 refresh evidence |

## Queue workflow

| id | action | state | evidence |
| --- | --- | --- | --- |
| prs.queue.select | Select queue group | measured | `prs-ui-rebase-fetch-ttl-20260512-062130` |
| prs.queue.open-pr | Open a queue member PR | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.queue.open-pr` |
| prs.queue.open-github | Open queue member on GitHub | external-skip | `WorkflowsTab.tsx` |
| prs.queue.inspect-rebase | Inspect queued lane rebase need | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.queue.inspect-rebase` |
| prs.queue.scope-next | Select Next lane only | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.queue.scope-controls` |
| prs.queue.scope-all | Select All affected lanes | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.queue.scope-controls` |
| prs.queue.rebase-ai | Rebase with AI | sandbox-only | `WorkflowsTab.tsx` / `RebaseTab.tsx` |
| prs.queue.rebase-local | Rebase now local only | prompt-only | mutates perf-pass worktree |
| prs.queue.rebase-push | Rebase and push | prompt-only | externally visible GitHub push |
| prs.queue.land-current | Land current PR | prompt-only | externally visible merge |
| prs.queue.resume | Resume queue automation | prompt-only | `WorkflowsTab.tsx` |
| prs.queue.cancel | Cancel queue automation | prompt-only | `WorkflowsTab.tsx` |
| prs.queue.automate | Open automate merging modal | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.queue.automate`, opened and cancelled |

## Integration workflow

| id | action | state | evidence |
| --- | --- | --- | --- |
| prs.integration.select | Select integration workflow | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.integration.select` |
| prs.integration.refresh | Click integration workflow Refresh | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.integration.refresh` |
| prs.integration.open-linked-pr | Open linked PR in ADE | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.integration.open-linked-pr` |
| prs.integration.open-github | Open linked PR on GitHub | external-skip | `WorkflowsTab.tsx` |
| prs.integration.cleanup | Open cleanup controls | prompt-only | `WorkflowsTab.tsx` |
| prs.integration.dismiss-cleanup | Dismiss cleanup prompt | prompt-only | `WorkflowsTab.tsx` |
| prs.integration.simulate | Simulate integration | sandbox-only | `IntegrationTab.tsx` |
| prs.integration.create-lane | Create integration lane | sandbox-only | `IntegrationTab.tsx` |
| prs.integration.commit | Commit integration | prompt-only | mutates perf-pass/GitHub workflow |
| prs.integration.resolver | Start integration resolver | sandbox-only | `IntegrationTab.tsx` |

## Rebase/Merge workflow

| id | action | state | evidence |
| --- | --- | --- | --- |
| prs.rebase.select-need | Select a rebase need | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.queue.inspect-rebase` navigated to rebase need |
| prs.rebase.commit-expand | Expand commit/file details | measured | `prs-ui-coverage-closeout-20260512-074602`, marker `prs.rebase.commit-expand`; expanded `5c7d11f` file details |
| prs.rebase.dismiss | Dismiss/defer rebase need | prompt-only | `RebaseTab.tsx` |
| prs.rebase.ai | Rebase with AI | sandbox-only | `RebaseTab.tsx` |
| prs.rebase.local | Rebase now local only | prompt-only | mutates perf-pass worktree |
| prs.rebase.push | Rebase and push | prompt-only | externally visible GitHub push |
| prs.rebase.abort | Abort active rebase | prompt-only | `RebaseTab.tsx` |
| prs.rebase.rollback | Roll back completed rebase | prompt-only | `RebaseTab.tsx` |

## Create PR modal

| id | action | state | evidence |
| --- | --- | --- | --- |
| prs.create.open | Open Create PR modal | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.create.open` |
| prs.create.mode.normal | Select normal PR mode | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.create.mode.normal` |
| prs.create.mode.queue | Select queue workflow mode | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.create.mode.queue` |
| prs.create.mode.integration | Select integration workflow mode | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.create.mode.integration` |
| prs.create.lane-picker | Change lane/source pickers | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.create.lane-picker` |
| prs.create.rebase-warning | Read rebase warning panel | measured | `prs-ui-ptm-audit-20260512-0635`, marker `prs.create.lane-picker`; warning rendered for behind lane selection |
| prs.create.submit | Submit PR creation | prompt-only | externally visible GitHub PR |

## Deferred and non-executed rows

- Issue resolver and legacy overview controls remain `fixture-needed` because
  they require actionable failed checks, unresolved review threads, or older
  overview controls hidden by the current timeline-rails surface.
- Prompt-only, sandbox-only, and external-skip rows are intentionally not fully
  executed in this audit because they mutate GitHub/perf-pass state, launch
  agents/tools, copy to clipboard, or leave ADE.
