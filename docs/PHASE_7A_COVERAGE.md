# Phase 7A Coverage Report (GitHub Integration Foundation)

> Updated: 2026-02-13

This report audits Phase 7A requirements against the current implementation in `apps/desktop/`.

## Implementation Plan Phase 7A Bullets

Status legend: `MET`, `PARTIAL`, `MISSING`.

| Requirement (IMPLEMENTATION_PLAN.md Phase 7A) | Status | Notes / Pointers |
|---|---:|---|
| CONF-022: Stack-aware conflict resolution | MET | Enforced in `apps/desktop/src/main/services/conflicts/conflictService.ts` (parent conflicts must be resolved first). |
| GitHub authentication: OS keychain token storage and retrieval | MET | Non-hosted uses Electron `safeStorage` encryption with token stored under `.ade/github/` (not YAML/env/SQLite). Hosted uses GitHub App (no PAT). See `apps/desktop/src/main/services/github/githubService.ts`. |
| GitHub API integration service (`githubService`) | MET | `apps/desktop/src/main/services/github/githubService.ts` (hosted proxy + local token). |
| PR creation from lane / link existing | MET | `apps/desktop/src/main/services/prs/prService.ts`. |
| PR status display and polling | MET | Background poller `apps/desktop/src/main/services/prs/prPollingService.ts` broadcasting `ade.prs.event`; renderer subscribes via `window.ade.prs.onEvent`. Poll interval configurable via Settings (`github.prPollingIntervalSeconds`). |
| Pack-generated PR description drafting via LLM | MET | Hosted: cloud job; BYOK: local API; fallback deterministic. `apps/desktop/src/main/services/prs/prService.ts`. |
| PR description update | MET | `prService.updateDescription`. |
| Lane PR panel component | MET | `apps/desktop/src/renderer/components/prs/LanePrPanel.tsx` (Inspector tab). |
| PR creation form + status view + Open in GitHub | MET | Lane panel + graph modal; external open via `prService.openInGitHub`. |
| PRs tab page layout | MET | `apps/desktop/src/renderer/components/prs/PRsPage.tsx`. |
| Stacked PR chain visualization + base retargeting | MET | Chain view in PRs page; retarget in `prService.landStack`. |
| Land single PR + land stack flow (progress UI) | MET | Single: lane panel + graph; stack: PRs page modal results. |
| PR checks integration + PR review status integration | MET | Checks now pull GitHub check-runs (and fall back to combined status contexts) in `prService.getChecks`. Reviews via `pulls/{n}/reviews`. |
| PR notifications (lane-aware + deep links) | MET | Background poller emits `pr-notification` events; UI toasts deep-link to Lanes Inspector `PR` tab and can open GitHub. |
| PR template support (`.github/PULL_REQUEST_TEMPLATE.md`) | MET | Read + used in drafting fallback/context: `apps/desktop/src/main/services/prs/prService.ts`. |

## PULL_REQUESTS.md Task IDs (PR-001 .. PR-020)

Note: `docs/features/PULL_REQUESTS.md` is historically written as a plan; these statuses reflect actual implementation.

| ID | Task | Status |
|---|---|---:|
| PR-001 | GitHub authentication | MET |
| PR-002 | GitHub API integration service | MET |
| PR-003 | PR creation from lane | MET |
| PR-004 | PR link to existing | MET |
| PR-005 | PR status display | MET |
| PR-006 | PR status polling | MET |
| PR-007 | Pack-generated PR description drafting | MET |
| PR-008 | PR description update | MET |
| PR-009 | Lane PR panel component | MET |
| PR-010 | PR creation form parity (labels, reviewers) | MET |
| PR-011 | PR status view (checks, reviews, conflicts) | MET |
| PR-012 | Open in GitHub action | MET |
| PR-013 | Stacked PR chain visualization | MET |
| PR-014 | Base retargeting for stacked PRs | MET |
| PR-015 | Land single PR | MET |
| PR-016 | Land stack flow | MET |
| PR-017 | Checks integration detail view | MET |
| PR-018 | Review status integration | MET |
| PR-019 | PR notifications | MET |
| PR-020 | PR template support | MET |

