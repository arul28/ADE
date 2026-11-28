# First-run setup

Opening or creating a project goes straight to Work. There is no blocking
setup dashboard (`/onboarding` redirects to `/work`). The `.ade` layout and
`ade.db` are created as soon as DAEX knows the folder. AI runtimes, GitHub and
Linear live in Settings; a new local repo can stay unpublished, and the header
Publish pill shows until `origin` exists.

The first-run flow on a computer (welcome, sign-in, agents, project import,
tour) is in the [README](./README.md#first-run-on-a-computer).

## Source file map

- `apps/desktop/src/main/services/projects/projectScaffoldService.ts`: create
  and clone scaffold.
- `apps/desktop/src/shared/fsAccessRefusal.ts` (`isFsAccessRefusal`): the
  folder-refusal check shared with the project registry.
- `apps/desktop/src/main/services/onboarding/onboardingService.ts`: status
  (`getStatus`, `complete`, `setDismissed`) and `detectDefaults`.
- `onboardingSuggestedConfig.ts`: `buildSuggestedConfig`, pure.
- `apps/desktop/src/renderer/components/projects/CreateProjectForm.tsx`: name
  and location; Create opens Work.

## Create and clone

- The scaffold never makes a folder that already exists, so a Windows drive
  root (`D:\`, where recursive `mkdir` fails with `EPERM`) is accepted as is.
- A folder the account may not create or read (`EACCES`, `EPERM`, `EROFS`) is
  an expected user error that names the folder ("DAEX can't create a folder in
  <path>. Pick another location.", or the missing-drive and unreadable-folder
  variants).

## Detection and suggested config

`detectDefaults()` looks for `package.json`, `Cargo.toml`, `go.mod`,
`pyproject.toml`, `Makefile`, `docker-compose.y(a)ml` and `.github/workflows/`,
then reads single-line `run:` steps from up to 32 workflow files (multi-line
`run: |` blocks are skipped).

`buildSuggestedConfig` adds a test suite per stack (npm, pnpm or yarn by lock
file; `make test`, `cargo test`, `go test`, `pytest`), up to six CI test
commands as `ci-N` suites, a `session-end-local` automation that runs
`predict-conflicts`, and provider config. Docker is a signal only.
`applySuggestedConfig` merges this into `.ade/local.yaml` through
`projectConfigService.save` with a shallow top-level merge: a second call does
not duplicate entries but can leave stale fields.

## Gotchas

- **`freshProject`** is computed when `createOnboardingService` is built, from a
  missing `.ade/ade.db`. Create and clone warm that database so first open is
  not special. Do not reintroduce a shell redirect on the flag.
- **The account gate is not a guest mode.** A fresh launch requires sign-in; a
  device with an existing paired or local connection gets an explicit recovery
  path while signed out, not an account-less setup.
- CTO first run is only the model picker
  ([CTO › Welcome](../cto/README.md#welcome)).
