# First-Run Onboarding

The wizard that turns a freshly-opened project into something usable.
Covers stack detection, AI provider setup, optional integrations, and
semantic search setup.

The canonical backend is
`apps/desktop/src/main/services/onboarding/onboardingService.ts`. The
wizard UI is
`apps/desktop/src/renderer/components/onboarding/ProjectSetupPage.tsx`
(~610 lines).

## Wizard steps

`STEP_ORDER = ["tools", "ai", "helpers", "github", "embeddings", "linear"]`.

| Step | Heading | Subtitle | Purpose |
|---|---|---|---|
| `tools` | Developer Tools | "ADE needs git for version control. GitHub CLI unlocks PR creation, review requests, and CI checks." | Detects `git` and `gh` availability. |
| `ai` | Runtime providers | "Set up the four ADE runtime providers: Claude, Codex, Cursor use their native CLIs. OpenCode powers API-backed and local model chats (LM Studio, Ollama)." | Provider CLI detection, model listing. |
| `helpers` | Background helpers | "Lightweight helpers that run in the background while you work. Optional and changeable later." | Non-blocking helper opt-ins. |
| `github` | GitHub Integration | "A personal access token lets ADE create PRs, request reviews, and monitor CI on your behalf." | GitHub PAT setup. |
| `embeddings` | Semantic Search | "A small local model that enables meaning-based memory search instead of just keyword matching." | Local embeddings opt-in. |
| `linear` | Linear Integration | "Connect your Linear workspace to route issues, sync statuses, and enable CTO workflows." | Optional Linear connection. |

All steps are visited in order but none *block* completion — the user
can Skip on any step and come back via Settings.

## Onboarding service API

`onboardingService.ts` exposes:

```ts
getStatus(): OnboardingStatus                    // completedAt, dismissedAt, freshProject
complete(): OnboardingStatus                     // stamps completedAt
setDismissed(dismissed: boolean): OnboardingStatus
detectDefaults(): Promise<OnboardingDetectionResult>
detectExistingLanes(): Promise<OnboardingExistingLaneCandidate[]>
applySuggestedConfig(suggestedConfig: ProjectConfigFile): Promise<void>
```

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

It then parses up to 32 workflow YAML files under
`.github/workflows/`, extracting single-line `run:` commands from each
step's `steps`. Multi-line scripts are skipped to avoid noise.

### Suggested config

`buildSuggestedConfig` turns indicators into a partial
`ProjectConfigFile`:

- Node: `install`, `build` processes; `unit` test suite. Package
  manager detection via `pnpm-lock.yaml` / `yarn.lock` (defaults to
  npm).
- Make: `make` process, `make-test` test.
- Docker: `docker-up` process plus a `dev` stack.
- Rust: `cargo-build` process, `cargo-test` test.
- Go: `go-build` process, `go-test` test.
- Python: `py-install` process, `pytest` test.

CI candidates are filtered down to obvious test/lint commands using a
regex (e.g. `npm run test`, `cargo test`, `pytest`, `make test`). Up
to six are appended as `ci-N` test suites.

It also seeds:

- a `session-end-local` automation that runs `predict-conflicts` after
  every session end
- provider config for `codex`/`claude` context tools and conflict
  resolvers (CLI commands)

`applySuggestedConfig(suggestedConfig)` merges this partial config
into the shared YAML via `projectConfigService.save`.

### Existing lane import

`detectExistingLanes()` scans all local branches (up to 200), excludes
those already mapped to ADE lanes, and returns each with:

- `branchRef` (short ref)
- `isCurrent` (matches `git rev-parse --abbrev-ref HEAD`)
- `hasRemote` (exists as `origin/<branch>`)
- `ahead`, `behind` counts relative to the project's base ref

Used by the lanes pane of the onboarding wizard to let the user
import recent branches as lanes in one click.

## ProjectSetupPage wiring

The page is stateful and reacts to:

- `window.ade.onboarding.getStatus()` on mount
- `window.ade.ai.getStatus()` for `availableModelIds`

Step-to-section embedding:

| Step | Embedded section |
|---|---|
| `tools` | `DevToolsSection` |
| `ai` | `ProvidersSection` + `AiFeaturesSection` |
| `helpers` | inline helper cards |
| `github` | `GitHubSection` |
| `embeddings` | `EmbeddingsSection` |
| `linear` | `LinearSection` |
### Completion

Clicking "Finish" calls `window.ade.onboarding.complete()` and
publishes an `onboardingStatusUpdated` renderer event via
`publishOnboardingStatusUpdated` so other surfaces (App shell banner,
Settings > Workspace) refresh.

"Dismiss" calls `setDismissed(true)` without stamping `completedAt`,
leaving the onboarding banner available via a re-entry from Settings.

## UX contract

Onboarding follows a small rule set:

- Do not block on optional integrations. GitHub, Linear, and embeddings
  are all skippable.
- Keep setup responsive. Model detection, CLI probes, and lane
  detection run concurrently where possible.
- Show the fastest path first. For Linear that means personal API
  keys rather than OAuth, with OAuth available but secondary.
- Defer heavy work to the feature surface that owns it. If the user
  wants deep memory setup, they use Settings > Memory, not
  onboarding.

## Gotchas

- `freshProject` is computed at `createOnboardingService` construction
  and is the system's signal for "this project has never been set up"
  — passing the wrong value re-triggers first-run on a mature repo.
- The existing-lane import runs `git rev-list --left-right --count`
  per candidate (capped at 200). Very large repos can see noticeable
  latency here; the wizard shows a loading indicator.
- Workflow command parsing keeps only single-line steps; multi-line
  `run: |` blocks are skipped. Teams that rely on complex CI flows
  will need to curate the imported commands manually in `ade.yaml`.
- `applySuggestedConfig` does a shallow merge at the top level —
  existing shared config fields take priority. Calling it twice on
  the same project will not duplicate entries but may leave stale
  fields in place.
- The CTO first-run wizard is separate and lives under
  `apps/desktop/src/renderer/components/cto/`. It covers identity,
  project context, and optional Linear, and finishing does not
  require Linear.

## Cross-links

- Configuration schema (where suggested configs land):
  [configuration-schema.md](./configuration-schema.md)
- Project home (the screen users arrive at after onboarding):
  [../project-home/README.md](../project-home/README.md)
