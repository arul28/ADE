# First-Run Setup

Opening or creating a project goes straight to Work. There is no blocking
project-setup dashboard. `.ade` layout and `ade.db` are created as soon as ADE
knows the folder (create/clone scaffold, then the normal project bind).

AI runtimes, GitHub, and Linear stay in Settings. A new local repo can stay
unpublished; the header Publish pill appears until `origin` exists.

The canonical backend is
`apps/desktop/src/main/services/onboarding/onboardingService.ts`
(status and suggested config). `/onboarding` redirects to `/work`.

## Surfaces

| Surface | Component | Purpose |
|---|---|---|
| Create project | `CreateProjectForm.tsx` | Name + first-class location; create opens Work. |
| Work | Work tab / new chat | Default landing for new, existing, and first-open projects. |
| Publish | header Publish pill | Optional GitHub repo creation when there is no `origin`. |
| Settings | Agents, Integrations | AI runtimes, GitHub, Linear. |

## Onboarding service API

`onboardingService.ts` exposes:

```ts
getStatus(): OnboardingStatus
complete(): OnboardingStatus
setDismissed(dismissed: boolean): OnboardingStatus
detectDefaults(): Promise<OnboardingDetectionResult>
applySuggestedConfig(suggestedConfig: ProjectConfigFile): Promise<void>
```

These five methods remain for suggested config and status storage. The desktop
shell no longer redirects on `freshProject`.

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

`buildSuggestedConfig` turns indicators into a partial
`ProjectConfigFile`. Node, Make, Rust, Go, and Python projects receive
an appropriate test suite (`unit`, `make-test`, `cargo-test`, `go-test`,
or `pytest`). Node package-manager detection uses `pnpm-lock.yaml` or
`yarn.lock` and otherwise defaults to npm. Docker remains a detection
signal but does not add project configuration.

CI candidates are filtered down to obvious test/lint commands using a regex
such as `npm run test`, `cargo test`, `pytest`, or `make test`. Up to six are
appended as `ci-N` test suites.

It also seeds:

- a `session-end-local` automation that runs `predict-conflicts` after every
  session end
- provider config for `codex` / `claude` context tools and conflict resolvers

`applySuggestedConfig(suggestedConfig)` merges this partial config into the
shared YAML via `projectConfigService.save`.

## UX contract

- Never intercept project open with a setup route. Work is the landing.
- Do not block chatting on GitHub, Linear, or an initial commit.
- Create shows the default location clearly; changing it is a first-class control.

## Gotchas

- `freshProject` is still computed at `createOnboardingService` construction
  from missing `.ade/ade.db`. Create/clone now warm that database so first open
  is not a special UI state. Do not reintroduce a shell redirect on the flag.
- Existing-lane import runs `git rev-list --left-right --count` per candidate
  branch, capped at 200. Large repos can still see noticeable latency on the
  Lanes tab, not on Work paint.
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
