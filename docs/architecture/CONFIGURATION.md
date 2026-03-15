# Configuration System Architecture

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-11

The ADE configuration system manages project-level and workspace-level settings through a layered YAML-based approach. It supports shared team configuration, personal local overrides, and a trust model that prevents unauthorized command execution.

---

## Table of Contents

- [Overview](#overview)
- [Design Decisions](#design-decisions)
- [Technical Details](#technical-details)
  - [Config File Locations](#config-file-locations)
  - [Config Layering](#config-layering)
  - [Config Schema](#config-schema)
  - [Trust Model](#trust-model)
  - [Config Service API](#config-service-api)
  - [Lane Profiles](#lane-profiles)
  - [Lane Overlay Policies](#lane-overlay-policies)
- [Integration Points](#integration-points)
- [Implementation Status](#implementation-status)

---

## Overview

ADE uses a two-file configuration system that balances shared project defaults with personal customization:

- **`.ade/ade.yaml`** is the tracked shared baseline config. It defines process commands, stack buttons, test suites, lane templates, and workflow defaults.
- **`.ade/local.yaml`** contains machine-local overrides such as environment variables, local AI/provider preferences, and personal process tweaks.
- **`.ade/local.secret.yaml`** is the machine-local secret companion file for external MCP config and other secret-backed integrations.

ADE now uses a canonical `.ade/` contract. The tracked/shareable subset lives alongside a tracked `.ade/.gitignore` that ignores machine-local runtime state (`local.yaml`, `local.secret.yaml`, databases, caches, transcripts, worktrees, secrets, and generated artifacts).

---

## Design Decisions

### Why YAML Over JSON or TOML?

YAML supports comments (critical for documenting config choices), has cleaner syntax for nested structures, and is the de facto standard for developer tool configuration (Docker Compose, GitHub Actions, Kubernetes). JSON lacks comments, and TOML becomes unwieldy for deeply nested structures like process definitions with multiple sub-fields.

### Why Two Files Instead of One?

A single config file creates a constant tension between "what the project wants" and "what I need locally." Developers end up with perpetual unstaged changes to the shared config, risk accidentally committing personal settings, and struggle with merge conflicts on config changes. The two-file approach cleanly separates these concerns: shared decisions go in `ade.yaml`, personal tweaks go in `local.yaml`. Secret-backed integration config lives beside them in `local.secret.yaml`, but outside the normal shared/local merge.

### Why a Trust Model?

Shared configuration files can contain arbitrary shell commands (process definitions, test commands). A malicious or careless teammate could add a command that runs destructive operations when ADE starts processes. The trust model requires explicit user approval before any commands from the shared config can be executed, similar to how VS Code prompts before running workspace tasks from untrusted repositories.

### Why SHA-Based Trust Rather Than GPG Signing?

GPG signing adds significant complexity (key management, distribution, revocation) for marginal benefit in this context. The threat model is not a sophisticated attacker forging commits, but rather a careless change to shared config that introduces unwanted commands. SHA comparison detects any change and prompts for review, which is sufficient for this use case. The trust boundary is "I have reviewed this version of the config," not "I trust this specific author."

---

## Technical Details

### Config File Locations

The shared, local, and secret config files all reside in the `.ade/` directory at the project root.

```
project-root/
├── .ade/
│   ├── .gitignore        # Tracks ignored machine-local ADE state
│   ├── ade.yaml          # Shared baseline config
│   ├── local.yaml        # Local override config (ignored)
│   ├── local.secret.yaml # Secret companion config (ignored)
│   ├── transcripts/      # Terminal session transcripts (ignored)
│   ├── cache/            # Runtime scratch state (ignored)
│   ├── artifacts/        # Generated compatibility artifacts (ignored)
│   ├── worktrees/        # Lane worktrees (ignored)
│   └── secrets/          # Local secret material (ignored)
├── src/
└── ...
```

ADE writes a tracked `.ade/.gitignore` file that defines the ignored machine-local subset. On startup, `adeProjectService.ts` also removes stale `.git/info/exclude` rules that previously hid the entire `.ade/` directory.

### Config Layering

Configuration values are resolved using a three-tier precedence model. Higher tiers override lower tiers.

```
┌─────────────────────────────────┐
│  Tier 3: local.yaml (highest)   │  Personal overrides
├─────────────────────────────────┤
│  Tier 2: ade.yaml               │  Shared team config
├─────────────────────────────────┤
│  Tier 1: ADE defaults (lowest)  │  Built-in fallbacks
└─────────────────────────────────┘
```

**Merge strategy**:

- **Scalar values**: Higher tier replaces lower tier entirely.
- **Arrays** (processes, test suites): Items are merged by `id`. If `local.yaml` defines a process with the same `id` as one in `ade.yaml`, the local definition completely replaces the shared one. New IDs in `local.yaml` are appended.
- **Objects** (nested maps): Deep merged. Individual keys in `local.yaml` override the corresponding keys in `ade.yaml` without removing sibling keys.

**Example**:

```yaml
# ade.yaml (shared)
processes:
  - id: "dev-server"
    command: "npm run dev"
    env:
      PORT: "3000"
      NODE_ENV: "development"

# local.yaml (personal)
processes:
  - id: "dev-server"
    env:
      PORT: "3001"           # Override port
      DEBUG: "true"          # Add personal debug flag
```

**Effective (merged) result**:

```yaml
processes:
  - id: "dev-server"
    command: "npm run dev"   # From shared (not overridden)
    env:
      PORT: "3001"           # From local (overridden)
      NODE_ENV: "development" # From shared (preserved)
      DEBUG: "true"          # From local (added)
```

### Config Schema

The full configuration schema for `ade.yaml` (all fields are also valid in `local.yaml` for override purposes):

```yaml
# Config file version (required)
version: 1

# Process definitions
processes:
  - id: "dev-server"                # Unique identifier (required)
    name: "Dev Server"              # Display name (required)
    command: "npm run dev"          # Shell command to execute (required)
    cwd: "."                        # Working directory, relative to project root
    env:                            # Environment variables
      PORT: "3000"
      NODE_ENV: "development"
    autostart: false                # Start automatically when lane opens
    restartPolicy: "on-failure"     # "never" | "on-failure" | "always"
    readiness:                      # Health check configuration
      type: "port"                  # "port" | "log-regex"
      port: 3000                    # For type: "port" — port to probe
      pattern: "ready"              # For type: "log-regex" — regex to match in stdout
      timeoutMs: 30000              # Max time to wait for readiness
    dependsOn: []                   # IDs of processes that must be ready first
    tags: ["frontend"]              # Arbitrary tags for filtering and grouping

# Stack buttons — named groups of processes
stackButtons:
  - id: "full-stack"               # Unique identifier (required)
    name: "Full Stack"             # Display name (required)
    processIds:                    # Ordered list of process IDs
      - "dev-server"
      - "api-server"
      - "db"
    startOrder: "sequential"       # "sequential" | "parallel"

# Test suite definitions
testSuites:
  - id: "unit"                     # Unique identifier (required)
    name: "Unit Tests"             # Display name (required)
    command: "npm test"            # Shell command to execute (required)
    cwd: "."                       # Working directory, relative to project root
    env: {}                        # Environment variables
    timeoutMs: 120000              # Maximum execution time
    tags: ["unit"]                 # Tags for filtering

# AI configuration (local.yaml only)
ai:
  mode: "subscription"             # "guest" | "subscription"
  defaultProvider: "auto"         # "auto" | "claude" | "codex"
  taskRouting:
    planning:
      provider: "claude"           # "claude" | "codex"
      model: "anthropic/claude-sonnet-4-6-api"   # Registry model ID
    implementation:
      provider: "codex"
      model: "openai/gpt-5.3-codex"
    review:
      provider: "claude"
      model: "anthropic/claude-sonnet-4-6-api"
    conflict_resolution:
      provider: "claude"
      model: "anthropic/claude-sonnet-4-6-api"
    narrative:
      provider: "claude"
      model: "anthropic/claude-haiku-4-5-api"
    pr_description:
      provider: "claude"
      model: "anthropic/claude-haiku-4-5-api"
```

The `ai` section belongs in `local.yaml` only, since it reflects the individual developer's installed CLI tools and preferences. ADE auto-detects available CLI tools (Claude Code, Codex) and populates provider information automatically. The `taskRouting` section allows per-task-type configuration of which provider and model to use. Model identifiers reference entries in the unified model registry (`src/shared/modelRegistry.ts`), which serves as the single source of truth for all supported models, their capabilities, and pricing (see DATA_MODEL.md for details). Provider mode is derived from `ai.mode`; legacy `providers.mode` values are ignored and stripped on save rather than migrated.

### Orchestrator Evolution Configuration

The following configuration blocks extend the `ai` section in `local.yaml` with settings introduced by the orchestrator evolution workstreams:

```yaml
ai:
  orchestrator:
    # Meta-reasoner settings (WS5: Smart Fan-Out)
    metaReasoner:
      model: "sonnet"                    # Model for fan-out analysis
      enabled: true                      # Enable/disable meta-reasoner
      max_fan_out_breadth: 6             # Max parallel steps from a single fan-out
      strategies:                        # Allowed fan-out strategies
        - external_parallel              # Multiple agents in separate lanes
        - internal_parallel              # Single agent handling sub-tasks
        - hybrid                         # Combination of both

    # Context compaction settings (WS6: Context Compaction)
    compaction_threshold: 0.7            # Trigger compaction at 70% of context window
    pre_compaction_writeback: true       # Extract facts before compacting
    compaction_model: "haiku"            # Model for generating compaction summaries

    # Session persistence settings (WS6: Session Persistence)
    persist_transcripts: true            # Write attempt transcripts to DB
    transcript_jsonl: true               # Also write JSONL files to .ade/transcripts/
    enable_resume: true                  # Allow resuming interrupted sessions

    # Memory settings (WS7: Scoped Memory Architecture)
    memory:
      auto_promote_on_completion: true   # Auto-promote high-confidence memories on run completion
      auto_promote_threshold: 0.8        # Confidence threshold for auto-promotion
      max_candidate_age_hours: 168       # Archive candidates older than 7 days
      max_memories_in_context: 20        # Max promoted memories injected into agent prompts
      search_relevance_threshold: 0.5    # Min relevance score for memory injection
      read_scopes:                       # Memory namespaces allowed for retrieval
        - run
        - project
        - identity
      write_scopes:                      # Memory namespaces allowed for writeback
        - run
        - project

    # Shared facts settings (WS4: Shared Facts)
    shared_facts:
      inject_in_prompts: true            # Inject run facts into agent prompts
      max_facts_in_context: 50           # Max facts injected per prompt

    # Run narrative settings (WS4/WS8: Run Narrative)
    run_narrative:
      enabled: true                      # Generate rolling narrative after each step
      model: "haiku"                     # Model for narrative generation
```

These settings are all optional. ADE provides sensible defaults for all values. Model identifiers used in these sections (e.g., `"sonnet"`, `"haiku"`) are resolved against the model registry. The `ModelConfig` and `OrchestratorIntelligenceConfig` types that back these settings live in `src/shared/types/models.ts`.

### Trust Model

The trust model prevents unauthorized command execution from shared configuration.

#### Trust State Machine

```
                    ┌──────────┐
     First open     │          │
    ─────────────>  │ UNTRUSTED│
                    │          │
                    └────┬─────┘
                         │
              User clicks │ "Trust"
              in UI       │
                         ▼
                    ┌──────────┐
                    │          │     ade.yaml unchanged
                    │ TRUSTED  │ ◄──────────────────────
                    │          │
                    └────┬─────┘
                         │
              ade.yaml   │ changes
              hash       │ differs
                         ▼
                    ┌──────────┐
                    │          │
                    │ STALE    │
                    │          │
                    └────┬─────┘
                         │
              User reviews│ and clicks "Trust"
                         │
                         ▼
                    ┌──────────┐
                    │          │
                    │ TRUSTED  │
                    │          │
                    └──────────┘
```

#### Trust Storage

Trust state is stored in the SQLite `kv` table (the same key-value database used for other local state):

| Key | Value | Description |
|-----|-------|-------------|
| `config.sharedHash` | SHA-256 hex | Hash of current `ade.yaml` contents |
| `config.approvedHash` | SHA-256 hex | Hash of the version the user approved |

**Trust check**: `sharedHash === approvedHash`. If they match, the config is trusted. If they differ (file was modified since last approval), the config is untrusted and commands from it will not execute until re-approved.

#### What Requires Trust?

| Operation | Requires Trust | Reason |
|-----------|---------------|--------|
| Process `command` execution | Yes | Arbitrary shell commands |
| Test suite `command` execution | Yes | Arbitrary shell commands |
| Stack button activation | Yes | Triggers process commands |
| Reading config values (env, display names) | No | No execution risk |
| Local config (`local.yaml`) commands | No | User's own machine |

When trust is not established, the UI displays a trust confirmation dialog showing the full contents of `ade.yaml` with any changes highlighted. The user must explicitly click "Trust this configuration" before any commands from it can be executed.

### Config Service API

The configuration system is exposed through `projectConfigService.ts`, which provides a unified interface for reading, validating, and writing configuration. Configuration-related types (`AdeConfig`, `ConfigSnapshot`, `TrustState`, `ValidationResult`) are defined in `src/shared/types/config.ts`.

#### `get(): ConfigSnapshot`

Returns a complete snapshot of the current configuration state:

```typescript
interface ConfigSnapshot {
  shared: AdeConfig | null;          // Parsed ade.yaml (null if file missing)
  local: AdeConfig | null;           // Parsed local.yaml (null if file missing)
  effective: AdeConfig;              // Merged result (shared + local + defaults)
  validation: ValidationResult;      // Schema validation errors/warnings
  trust: TrustState;                 // { trusted: boolean, sharedHash, approvedHash }
  paths: {
    shared: string;                  // Absolute path to ade.yaml
    local: string;                   // Absolute path to local.yaml
    root: string;                    // Project root path
  };
}
```

#### `validate(candidate: unknown): ValidationResult`

Validates a YAML structure against the config schema. Returns structured errors and warnings:

```typescript
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];        // Schema violations (prevent save)
  warnings: ValidationWarning[];    // Non-blocking issues (allow save)
}
```

#### `save(candidate: AdeConfig, target: "shared" | "local"): void`

Writes validated configuration to disk. For shared config, updates the `sharedHash` in the kv store. For local config, no trust hash update is needed.

#### `diffAgainstDisk(): ConfigDiff`

Compares the in-memory configuration snapshot against the current on-disk files. Used to detect external modifications (e.g., a teammate pushed a config change that was pulled via git).

#### `confirmTrust(args: { hash: string }): void`

Records the user's explicit approval of the current shared config hash. Sets `approvedHash = hash` in the kv store.

### Lane Profiles

**Status: NOT YET STARTED (planned)**

Lane profiles are named sets of defaults that can be applied when creating a new lane. They define which processes to auto-start, which environment variables to set, and which test suites to associate with the lane.

```yaml
# Planned schema (in ade.yaml)
laneProfiles:
  - id: "frontend"
    name: "Frontend Development"
    autoStartProcesses: ["dev-server", "storybook"]
    env:
      BROWSER: "none"
    testSuites: ["unit", "e2e-chrome"]

  - id: "backend"
    name: "Backend Development"
    autoStartProcesses: ["api-server", "db"]
    env:
      LOG_LEVEL: "debug"
    testSuites: ["unit", "integration"]

  - id: "fullstack"
    name: "Full Stack"
    autoStartProcesses: ["dev-server", "api-server", "db"]
    testSuites: ["unit"]
```

When creating a new lane, the user can select a profile from a dropdown. The profile's settings are applied as defaults, which the user can then modify for that specific lane.

### Lane Overlay Policies

**Status: DONE (Phase 4)**

Lane overlay policies are workspace-level rules that automatically apply configuration overrides to lanes matching certain criteria. This is implemented via `laneOverlayMatcher.ts`. This enables organizational policies like "all frontend lanes must use port range 3000-3999" or "all staging lanes get the staging API URL."

```yaml
# Schema (in ade.yaml)
laneOverlays:
  - id: "frontend-ports"
    match:
      tags: ["frontend"]           # Match lanes with this tag
    apply:
      env:
        PORT: "3001"               # Override port for matched lanes

  - id: "staging-api"
    match:
      namePattern: "staging/*"     # Match lanes whose name starts with "staging/"
    apply:
      env:
        API_URL: "https://staging.example.com"
```

Overlay policies are evaluated in order. Later policies override earlier ones for the same keys. Explicit lane-level configuration always takes precedence over overlay policies.

---

## Integration Points

### Lane Service

- Reads effective process definitions from the config service when starting processes in a lane.
- Applies lane profiles (when implemented) during lane creation.
- Evaluates lane overlay policies (when implemented) when computing effective lane configuration.

### PTY Service

- Receives process commands and environment variables from the config service.
- Respects `cwd`, `env`, and `restartPolicy` settings.
- Reports readiness status based on the configured readiness check.

### Project Config Service (`projectConfigService.ts`)

- Central service that loads, validates, merges, and caches configuration.
- Handles schema validation and trust-state snapshots for `ade.yaml` + `local.yaml`.

### Config Reload Service (`configReloadService.ts`)

- Watches `ade.yaml`, `local.yaml`, and `local.secret.yaml` using `chokidar`.
- Refreshes config reads, reloads automation schedules, reloads secret-backed services on secret changes, and emits renderer-facing project-state refresh events.

### Trust System

- Trust state stored in SQLite `kv` table via `kvDb.ts`.
- UI trust dialog rendered in the renderer process.
- Trust confirmation routed through IPC to the config service in the main process.

### IPC Layer

- `config:get` — Returns the current config snapshot.
- `config:save` — Writes config to disk (with validation).
- `config:confirmTrust` — Records trust approval.
- `ade.project.state.event` — Project-state event emitted when watched config files change on disk.

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Config file locations (`.ade/ade.yaml`, `.ade/local.yaml`) | Done | Files created on project init |
| Config layering (shared + local + defaults merge) | Done | Deep merge with ID-based array merge |
| YAML parsing and serialization | Done | Using `yaml` npm package |
| Config schema validation | Done | Validates against TypeScript interfaces |
| Trust model (SHA-based approval) | Done | Hash stored in SQLite kv table |
| Trust UI dialog | Done | Renderer shows diff on hash mismatch |
| Config service (`projectConfigService.ts`) | Done | Full CRUD + validation + trust |
| File system watchers for config changes | Done | `configReloadService.ts` watches `ade.yaml`, `local.yaml`, and `local.secret.yaml` |
| IPC endpoints for config operations | Done | `config:get`, `config:save`, `config:confirmTrust` |
| Canonical `.ade/` git contract | Done | Tracked `.ade/.gitignore` defines ignored runtime state; stale `.git/info/exclude` rules are scrubbed |
| AI provider auto-detection | Done | Detects Claude Code and Codex CLI tools |
| Per-task model routing | Done | Task type → provider → model configuration |
| Meta-reasoner configuration | Done | Fan-out strategies, model selection, breadth limits |
| Compaction threshold configuration | Done | Token threshold, pre-compaction writeback toggle |
| Memory promotion policies | Done | Auto-promotion threshold, max candidate age, context limits |
| Run narrative configuration | Done | Enable/disable, model selection |
| Lane profiles | Not started | Schema designed, runtime not implemented |
| Lane overlay policies | Done | Implemented via `laneOverlayMatcher.ts` (Phase 4) |
| Config versioning layer | N/A | Runtime consumes version 1 config shape directly; no legacy provider-mode migration path is maintained |

**Overall status**: Core configuration system is DONE for parsing, layering, validation, trust, CRUD operations, and runtime reload. AI provider detection and per-task model routing are DONE. Lane overlay policies are DONE (Phase 4, `laneOverlayMatcher.ts`). Orchestrator evolution configuration (meta-reasoner, compaction, memory, shared facts, run narrative) is DONE. Lane profiles are NOT YET STARTED. The current repo already uses the canonical W10 `.ade` structure and tracked `.ade/.gitignore` model.

---

## Planned Configuration Blocks

### Lane Templates Configuration

```yaml
# Lane templates (stored in project-level local.yaml)
laneTemplates:
  - name: "Node.js Full Stack"
    description: "Node.js app with PostgreSQL and Redis"
    envFiles:
      - source: ".env.template"
        destination: ".env"
        variables:
          PORT: "${LANE_PORT_START}"
          DATABASE_URL: "postgresql://localhost:${LANE_PORT_START + 1}/app"
    portRange:
      start: auto  # or explicit: 3000
      size: 100
    dockerCompose: "docker-compose.dev.yml"
    installCommand: "npm install"

  - name: "Python API"
    description: "FastAPI with SQLite"
    envFiles:
      - source: ".env.template"
        destination: ".env"
    portRange:
      size: 50
    installCommand: "pip install -r requirements.txt"
```

### Lane Proxy Configuration

```yaml
# Lane proxy settings
laneProxy:
  enabled: false
  port: 8080
  hostnamePattern: "<lane-slug>.localhost"
  autoSetup: true
  portDetection: true
```

### Compute Backend Configuration

```yaml
# Compute backend settings
computeBackends:
  default: "local"

  local:
    # No additional configuration required
    enabled: true

  vps:
    enabled: false
    relayAddress: ""
    sshKeyPath: "~/.ssh/ade_vps"

  daytona:
    enabled: false  # Always opt-in
    apiKey: ""  # Stored in system keychain
    region: "us-east-1"
    defaultResources:
      cpu: 2
      ramMb: 4096
      diskGb: 20
    autoStopMinutes: 30
    missionDefault: false
```
