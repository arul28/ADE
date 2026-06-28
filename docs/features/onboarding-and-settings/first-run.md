# First-Run Setup

The first-run setup page turns a freshly opened project into something usable
without forcing a step-by-step flow. It is a status-card dashboard for checking
local tooling, AI runtimes, optional GitHub / Linear connections, suggested
project config, and existing branch import.

The canonical backend is
`apps/desktop/src/main/services/onboarding/onboardingService.ts`. The setup UI is
`apps/desktop/src/renderer/components/onboarding/ProjectSetupPage.tsx`.

## Setup surfaces

| Surface | Component | Purpose |
|---|---|---|
| Project header | `ProjectSetupPage.tsx` | Shows project identity, setup state, Finish / Skip actions, and repair affordances. |
| Developer tools | `DevToolsRow.tsx` | Checks `git`, the user-facing `ade` CLI install, and terminal readiness. |
| AI runtimes | `AiRuntimesBand.tsx` | Detects Claude, Codex, Cursor, Factory Droid, and OpenCode readiness; surfaces install/sign-in helpers and model picker entry points. |
| GitHub | `GitHubCard.tsx` | Guides repository auth and PR capability setup. |
| Linear | `LinearCard.tsx` | Guides Linear OAuth / API-key auth and optional workflow sync. |
| Existing worktrees | `WorktreesCard.tsx` | Imports existing local branches/worktrees as ADE lanes. |

The dashboard can be finished even when optional integrations are incomplete.
Users can return to the same setup surface later, and long-lived preferences
live in Settings.

## Onboarding service API

`onboardingService.ts` exposes:

```ts
getStatus(): OnboardingStatus
complete(): OnboardingStatus
setDismissed(dismissed: boolean): OnboardingStatus
detectDefaults(): Promise<OnboardingDetectionResult>
detectExistingLanes(): Promise<OnboardingExistingLaneCandidate[]>
applySuggestedConfig(suggestedConfig: ProjectConfigFile): Promise<void>
getHelpState(): OnboardingHelpState
markGlossaryTermSeen(termId: string): OnboardingHelpState
```

The first six methods power project setup. `getHelpState` and
`markGlossaryTermSeen` support passive glossary/help chips; guided tours,
per-tab walkthroughs, and the old welcome wizard are no longer part of the
renderer contract.

### Detection

`detectDefaults()` scans the project root for indicators:

| File | Type | Confidence |
|---|---|---|
| `package.json` | `node` | 0.95 |
| `Cargo.toml` | `rust` | 0.95 |
| `go.mod` | `go` | 0.95 |
| `pyproject.toml` | `python` | 0.95 |
| `Makefile` | `make` | 0.80 |
| `docker-compose.yml` / `.yaml` | `docker` | 0.80 |
| `.github/workflows/` | `github-actions` | 0.70 |

It then parses up to 32 workflow YAML files under `.github/workflows/`,
extracting single-line `run:` commands from each step. Multi-line scripts are
skipped to avoid noisy imports.

### Suggested config

`buildSuggestedConfig` turns indicators into a partial `ProjectConfigFile`:

- Node: `install`, `build` processes; `unit` test suite. Package manager
  detection via `pnpm-lock.yaml` / `yarn.lock` defaults to npm.
- Make: `make` process, `make-test` test.
- Docker: `docker-up` process plus a `dev` stack.
- Rust: `cargo-build` process, `cargo-test` test.
- Go: `go-build` process, `go-test` test.
- Python: `py-install` process, `pytest` test.

CI candidates are filtered down to obvious test/lint commands using a regex
such as `npm run test`, `cargo test`, `pytest`, or `make test`. Up to six are
appended as `ci-N` test suites.

It also seeds:

- a `session-end-local` automation that runs `predict-conflicts` after every
  session end
- provider config for `codex` / `claude` context tools and conflict resolvers

`applySuggestedConfig(suggestedConfig)` merges this partial config into the
shared YAML via `projectConfigService.save`.

### Existing lane import

`detectExistingLanes()` scans all local branches, capped at 200, excludes
branches already mapped to ADE lanes, and returns each with:

- `branchRef` (short ref)
- `isCurrent` (matches `git rev-parse --abbrev-ref HEAD`)
- `hasRemote` (exists as `origin/<branch>`)
- `ahead`, `behind` counts relative to the project's base ref

`WorktreesCard` uses this list to import recent branches as lanes in one click.

## ProjectSetupPage wiring

The page is stateful and reacts to:

- `window.ade.onboarding.getStatus()` on mount
- provider/tool readiness reads for the AI runtimes and developer-tool rows
- `detectDefaults()` and `detectExistingLanes()` when the user scans/imports

Clicking Finish calls `window.ade.onboarding.complete()` and publishes an
`onboardingStatusUpdated` renderer event via `publishOnboardingStatusUpdated` so
other surfaces refresh.

Dismiss calls `setDismissed(true)` without stamping `completedAt`, leaving setup
available through explicit re-entry.

## UX contract

- Do not block on optional integrations. GitHub and Linear are skippable.
- Keep setup responsive. Model detection, CLI probes, and lane detection run
  concurrently where possible.
- Show the fastest path first. For Linear that means personal API keys, with
  OAuth available but secondary.
- Defer heavy work to the feature surface that owns it.

## Gotchas

- `freshProject` is computed at `createOnboardingService` construction and is
  the signal for "this project has never been set up." Passing the wrong value
  reopens first-run setup on a mature repo.
- Existing-lane import runs `git rev-list --left-right --count` per candidate
  branch, capped at 200. Large repos can still see noticeable latency, so the UI
  shows an explicit loading state.
- Workflow command parsing keeps only single-line steps; multi-line `run: |`
  blocks are skipped. Teams with complex CI flows should curate imported
  commands manually in `ade.yaml`.
- `applySuggestedConfig` does a shallow merge at the top level. Calling it twice
  on the same project will not duplicate entries but can leave stale fields in
  place.
- The CTO first-run setup is separate and lives under
  `apps/desktop/src/renderer/components/cto/`. It covers identity, project
  context, and optional Linear, and finishing it does not require Linear.

## Cross-links

- Configuration schema:
  [configuration-schema.md](./configuration-schema.md)
- Project home:
  [../project-home/README.md](../project-home/README.md)
