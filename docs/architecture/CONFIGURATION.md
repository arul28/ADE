# Configuration (Project, Actions, Provider Swaps)

Last updated: 2026-02-11

## 1. Goals

- Keep config readable and repo-portable.
- Avoid surprising git changes by default.
- Make provider swapping (hosted/BYOK/CLI) a config change, not a rewrite.
- Make process/test workflows reproducible via explicit definitions.

## 2. `.ade/` Folder

Recommended local layout (default git-ignored via `.git/info/exclude`):

- `.ade/ade.yaml` (shareable baseline config)
- `.ade/local.yaml` (machine overrides; non-shareable)
- `.ade/actions.yaml` (shareable automations/actions)
- `.ade/packs/` (local-only by default)
- `.ade/transcripts/` (local-only)
- `.ade/logs/`
  - `processes/`
  - `tests/`
- `.ade/cache/` (local-only)

## 3. Config Layering

Load order:

1. defaults from app
2. `.ade/ade.yaml`
3. `.ade/local.yaml` (override)

Rules:

- arrays of objects should merge by stable `id` where possible
- unresolved references (for example stack button references missing process IDs) fail validation
- commands are never executed until config passes validation

## 4. Process/Test Config Schema (Phase 2)

Top-level keys:

- `version`
- `processes[]`
- `stackButtons[]`
- `testSuites[]`
- `providers` (existing provider config)

### 4.1 `processes[]`

Each process definition:

- `id` (required)
- `name` (required)
- `command` (required argv array)
- `cwd` (required)
- `env` (optional object)
- `autostart` (optional, default `false`)
- `restart` (optional: `never | on_crash`)
- `gracefulShutdownMs` (optional, default `7000`)
- `dependsOn[]` (optional process IDs)
- `readiness` (optional):
  - `type: none | port | logRegex`
  - `port` for port checks
  - `pattern` for regex checks

### 4.2 `stackButtons[]`

Each button definition:

- `id` (required)
- `name` (required)
- `processIds[]` (required)
- `startOrder` (optional: `parallel | dependency`, default `parallel`)

### 4.3 `testSuites[]`

Each suite definition:

- `id` (required)
- `name` (required)
- `command` (required argv array)
- `cwd` (required)
- `env` (optional)
- `timeoutMs` (optional)
- `tags[]` (optional)

## 5. Example `.ade/ade.yaml`

```yaml
version: 1

processes:
  - id: api
    name: API
    command: ["npm", "run", "dev:api"]
    cwd: "apps/api"
    env: {}
    restart: on_crash
    gracefulShutdownMs: 7000
    readiness:
      type: port
      port: 3001

  - id: web
    name: Web
    command: ["npm", "run", "dev:web"]
    cwd: "apps/web"
    env: {}
    restart: on_crash
    gracefulShutdownMs: 7000
    readiness:
      type: port
      port: 5173

stackButtons:
  - id: backend
    name: Backend
    processIds: ["api"]
  - id: frontend
    name: Frontend
    processIds: ["web"]
  - id: full
    name: Full Stack
    processIds: ["api", "web"]

# Unit/lint/integration/e2e buttons
# shown in Projects (Home)
testSuites:
  - id: unit
    name: Unit
    command: ["npm", "run", "test:unit"]
    cwd: "."
  - id: lint
    name: Lint
    command: ["npm", "run", "lint"]
    cwd: "."
```

## 6. Validation Rules

Validation must fail fast for:

- duplicate IDs
- empty command arrays
- missing cwd paths
- cyclic `dependsOn`
- stack buttons referencing unknown process IDs
- test suites with missing command/cwd

## 7. Trust and Change Confirmation

Commands in shared config are executable code. Safety requirements:

- when `.ade/ade.yaml` changes from git pull/sync, show an explicit trust confirmation before allowing execution
- local overrides in `.ade/local.yaml` are trusted for that machine/user
- preserve a last-approved config hash in local state for comparison

## 8. Provider Swapping

Design rule:

- the local core uses a single provider interface (`ManagerProvider`)
- config selects the default provider:
  - `hosted`
  - `byok`
  - `cli`

All providers must return the same output shapes (narratives + patch proposals).

## 9. Sync Policy

Hosted mirror sync should be configurable:

- force sync on session end
- coalesce sync during active edits
- early sync if dirty change threshold exceeded
- exclude list (denylist) for files/dirs that should never upload
