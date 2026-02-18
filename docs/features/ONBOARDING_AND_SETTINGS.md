# Onboarding & Settings — Setup, Trust & Preferences

> Last updated: 2026-02-16

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
- [User Experience](#user-experience)
  - [Onboarding Flow](#onboarding-flow)
  - [Trust Surfaces](#trust-surfaces)
  - [Settings Page](#settings-page)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [Component Architecture](#component-architecture)
  - [Data Flow](#data-flow)
- [Data Model](#data-model)
- [Implementation Tracking](#implementation-tracking)

---

## Overview

Onboarding and Settings are the gateway into ADE. Onboarding provides a safe,
guided flow for initializing ADE in an existing repository. Settings manages user
preferences, theme, provider configuration, and keybindings.

ADE operates inside a developer's existing git repository, which means it must be
transparent about what it creates, what it modifies, and what data (if any) leaves
the machine. The onboarding flow ensures developers understand and consent to ADE's
behavior before any changes are made. The settings page provides ongoing control
over those same concerns. Together, these features establish the trust foundation
that every other ADE feature builds on.

**Current status**: Onboarding wizard (defaults detection, config review, existing-lane import, initial deterministic pack generation), guest mode, hosted agent consent + bootstrap flow, and provider configuration (Hosted/BYOK/CLI) are **implemented and working** (Phases 3, 6, 8). Onboarding now seeds the Project Pack with a lightweight deterministic bootstrap (codebase map + docs index + git history seed) so the initial context is immediately useful even before any AI details are generated.

---

## Core Concepts

### Onboarding

The first-time setup when a developer opens a repository in ADE. It handles
repository selection, default detection (scanning for build tools and test
frameworks), `.ade/` directory creation, configuration review, and optional hosted
agent consent. The flow runs once per repository; subsequent opens skip to the main UI.

### Trust Model

ADE distinguishes between shared and local configuration:

| Config File | Scope | Trust Level |
|------------|-------|-------------|
| `.ade/ade.yaml` | Shared (committed) | Requires explicit approval before executing processes or tests |
| `.ade/local.yaml` | Local (gitignored) | Always trusted; stores API keys, preferences, overrides |

The trust boundary exists because `.ade/ade.yaml` is a shared file that any team
member can modify. ADE prevents execution of untrusted shared config by showing
previews, maintaining an audit trail, and providing escape hatches.

### Provider Configuration

| Provider | Description | Data Residency |
|----------|-------------|----------------|
| **Hosted Agent** | ADE cloud handles LLM calls, conflict prediction, mirror hosting | Data transmitted to ADE servers |
| **BYOK** | User provides their own API key (OpenAI, Anthropic, etc.) | Data transmitted to chosen LLM provider |
| **CLI (Local)** | Local tools only, no LLM features, heuristic conflict prediction | No data leaves the machine |

### Guest Mode

ADE can be used without creating an account or configuring an LLM provider. In **Guest Mode**:

- All local features work: lanes, terminals, git operations, process management, test suites, file editing
- Deterministic context tracking works locally: packs, checkpoints, pack events, and operation history continue to record and refresh
- AI-powered features are disabled: hosted mirror sync, hosted narratives, hosted conflict proposals, and AI PR drafting
- Conflict prediction and merge simulation still run locally; only AI-generated resolution proposals are unavailable

Guest Mode is the default state before onboarding is completed. Users can remain in Guest Mode indefinitely. A persistent banner shows: "Running in Guest Mode — AI details disabled. [Set up provider →]" with a link to the Settings page.

Guest Mode ensures ADE is immediately useful for git workflow management and terminal orchestration even without any cloud or LLM setup.

---

## User Experience

### Onboarding Flow

Presented as a step-by-step wizard (`OnboardingPage`) when the opened repository lacks a `.ade/` directory.

**Step 1 — Welcome**: Introduction screen with overview of what ADE does. Includes a "Skip" option to bypass onboarding entirely.

**Step 2 — Detect Defaults**: Scans for project indicators and suggests config:

| Indicator | Detection Result |
|-----------|-----------------|
| `package.json` | Suggests install/test/build commands (detects npm/yarn/pnpm via lockfiles) |
| `Makefile` | Suggests `make`, `make test` |
| `docker-compose.yml` / `docker-compose.yaml` | Suggests `docker compose up` |
| `Cargo.toml` | Suggests `cargo build`, `cargo test` |
| `go.mod` | Suggests `go build ./...`, `go test ./...` |
| `pyproject.toml` | Suggests `pip install -e .`, `pytest` |
| `.github/workflows/` | Parses YAML workflow files, imports test/lint commands from CI steps |

Detection also generates default automation rules (session-end conflict prediction and hourly mirror sync) and default provider configuration (context tool generators for Codex and Claude).

**Step 3 — Review Config**: Full-page form showing suggested processes, tests, stack buttons, and automations. User can edit each section before saving. Supports "Append" mode (merge with existing) and "Replace" mode (overwrite). Automations are displayed alongside processes and tests for review.

**Step 4 — Detect Branches**: Scans for existing local branches (via `git for-each-ref refs/heads`). Displays a table showing each branch's ahead/behind counts relative to the base ref, whether it has a remote tracking branch, and whether it is the current branch. Filters out branches already tracked as ADE lanes.

**Step 5 — Import Branches**: For branches selected in Step 4, sequentially creates ADE lanes. Each import creates a lane with the branch ref and optionally sets a parent lane. Progress is shown per-branch with success/failure status.

**Step 6 — Generate Packs**: Triggers initial deterministic pack generation for the project and all imported lanes. If Hosted or BYOK is configured, AI details are generated in the background after the deterministic refresh:

- **Project Pack bootstrap**: Builds a lightweight project map (top-level folders, key files, git history seed) and seeds the Project Pack.
- **Documentation import**: Indexes the repository's `docs/` directory and key markdown files into the Project Pack bootstrap.
- **Lane Pack generation**: For each imported lane, generates an initial Lane Pack by analyzing the branch's diff against the base, commit history, and session data.

In Guest Mode, deterministic packs are still generated; only AI details are skipped.

**Step 7 — Complete**: Wizard closes, main UI loads, toast confirms initialization. Users can re-run initial pack generation later from Settings.

### Trust Surfaces

- **"What ADE will do" dialogs**: Show exact commands before executing new or changed shared config
- **Operation timeline**: Full audit trail in the History tab
- **Escape hatches**: Undo operations, delete `.ade/`, disable hosted agent

### Settings Page

**App Info**: Version, Electron version, Node.js version, platform, architecture (read-only).

**Theme**: Six visual themes, each applied immediately and persisted to `localStorage`:

| Theme ID | Name | Description |
|----------|------|-------------|
| `e-paper` | E-Paper | Muted, paper-like tones |
| `bloomberg` | Bloomberg Terminal | Dark terminal aesthetic |
| `github` | GitHub | Familiar GitHub-inspired palette |
| `rainbow` | Rainbow | Vibrant, colorful |
| `sky` | Sky | Light blue tones |
| `pats` | Pat's | Custom accent theme |

**Provider Configuration**: Radio selector for Guest/Hosted/BYOK/CLI.
- **Guest**: No AI provider, all local features work, AI details disabled.
- **Hosted**: ADE cloud agent. Includes Clerk OAuth for authentication, bootstrap config, mirror sync controls, context delivery mode selector (Auto/Inline/Mirror Preferred), and GitHub App connection.
- **BYOK**: Provider dropdown (Anthropic/OpenAI/Gemini), model selector, API key input (password field). Keys stored in `local.yaml`.
- **CLI**: Local tools only (Codex CLI, Claude CLI). No data leaves the machine.

**Automations**: Embedded `AutomationsSection` showing all automation rules with enable/disable toggles, "Run Now" buttons, and history links. Provides a summary view without leaving Settings.

**Terminal Profiles**: Manage terminal launch profiles. Default profiles include Shell, Claude, Codex, and Aider. Users can add custom profiles with name, command, args, cwd, and environment variables. Profiles are persisted via `kvDb`.

**Keybindings**: Table showing all shortcuts with action, scope, default binding, user override, and effective binding. Supports text-based override input with chord normalization and conflict detection (warns when two actions share the same key binding).

**Data Management**: Three actions:
- **Clear local data**: Removes packs, logs, and transcripts.
- **Export config**: Exports the project configuration as a bundle.
- **Delete hosted mirror data**: Removes hosted mirror state (requires confirmation).

**GitHub**: Local GitHub token management. Configure PATs for GitHub API access. PR polling interval configuration.

**Guest Mode Banner**: When no provider is configured, a persistent banner appears at the top of every page: "Running in Guest Mode — AI details disabled. [Set up provider →]". The banner links to the Provider Configuration section.

---

## Technical Implementation

### Services

| Service | Status | Role |
|---------|--------|------|
| `projectService` | Exists | Repository initialization, `.ade/` creation, project metadata |
| `projectConfigService` | Exists | Config CRUD, validation, trust confirmation, schema enforcement |
| `onboardingService` | Exists | Detection of project defaults (node/rust/go/python/make/docker/CI), suggested config generation (incl. default automations and provider config), existing branch detection with ahead/behind computation, initial pack generation |
| `keybindingsService` | Exists | Keybinding override store. Reads definitions from `shared/keybindings.ts`, persists user overrides via `kvDb`. |
| `terminalProfilesService` | Exists | Terminal launch profile management. Default profiles: Shell, Claude, Codex, Aider. Merge-defaults pattern, persisted via `kvDb`. |
| `kvDb` | Exists | Persists theme, keybinding overrides, terminal profiles, and local settings outside YAML config |

### IPC Channels

| Channel | Status | Payload |
|---------|--------|---------|
| `ade.project.openRepo()` | Exists | Opens file picker, returns `ProjectInfo` |
| `ade.project.openAdeFolder()` | Exists | Opens `.ade/` in system file manager |
| `ade.projectConfig.get()` | Exists | Returns merged config (shared + local) |
| `ade.projectConfig.validate(config)` | Exists | Validates config against schema |
| `ade.projectConfig.save(config)` | Exists | Writes to `ade.yaml` and/or `local.yaml` |
| `ade.projectConfig.confirmTrust()` | Exists | Marks shared config as trusted |
| `ade.app.getInfo()` | Exists | Returns `AppInfo` (version, platform, etc.) |
| `ade.onboarding.getStatus()` | Exists | Returns `OnboardingStatus` (completedAt timestamp or null) |
| `ade.onboarding.detectDefaults()` | Exists | Scans repo for project indicators, returns `OnboardingDetectionResult` with suggested config incl. automations and provider defaults |
| `ade.onboarding.detectExistingLanes()` | Exists | Scans for local branches, returns `OnboardingExistingLaneCandidate[]` with ahead/behind/remote/isCurrent per branch |
| `ade.onboarding.generateInitialPacks(args)` | Exists | Triggers initial pack generation for project and selected lane IDs |
| `ade.onboarding.complete()` | Exists | Marks onboarding as complete, returns `OnboardingStatus` |

### Component Architecture

```
OnboardingPage (route: /onboarding, 7-step wizard)
  +-- Step indicator (progress dots)
  +-- WelcomeStep (intro + skip option)
  +-- DetectDefaultsStep (spinner then indicator results)
  +-- ReviewConfigStep
  |    +-- Process list editor (add/edit/remove)
  |    +-- Test suite editor (add/edit/remove)
  |    +-- Stack button editor (add/edit/remove)
  |    +-- Automation rule editor (add/edit/remove)
  |    +-- Append/Replace mode toggle
  +-- DetectBranchesStep (branch table with ahead/behind/remote columns)
  +-- ImportBranchesStep (sequential import with parent lane selection)
  +-- GeneratePacksStep (progress indicator per pack)
  +-- CompleteStep (done message + toast)

SettingsPage (route: /settings)
  +-- AppInfoSection (version, Electron, Node, platform, arch)
  +-- ThemeSection (6 theme swatches: e-paper, bloomberg, github, rainbow, sky, pats)
  +-- ProviderSection
  |    +-- Guest / Hosted / BYOK / CLI radio selector
  |    +-- HostedConfig (Clerk OAuth, bootstrap, mirror sync, context delivery, GitHub App)
  |    +-- BYOKConfig (provider dropdown: Anthropic/OpenAI/Gemini, model selector, API key)
  |    +-- CLIConfig (local tools only)
  +-- AutomationsSection (per-rule summary with run-now, history, toggle)
  +-- TerminalProfilesSection (profile CRUD: name, command, args, cwd, env)
  +-- KeybindingsSection (table: action, scope, default, override, effective + conflict detection)
  +-- GitHubSection (local PAT management, PR polling interval)
  +-- DataManagementSection (clear data, export config, delete hosted mirror)
```

### Data Flow

**Onboarding**: User opens project via file picker (`ade.project.openRepo`). Main
validates git repo, returns `ProjectInfo`. Renderer calls `ade.onboarding.detectDefaults()`
to scan for indicators, which returns `OnboardingDetectionResult` with project types,
indicators, suggested config (including automations and provider defaults), and
suggested workflows. User reviews and edits the suggested config. Renderer calls
`ade.onboarding.applySuggestedConfig()` (via `projectConfig.save`) to write files.
Next, `ade.onboarding.detectExistingLanes()` scans for local branches and returns
candidates with ahead/behind/remote status. User selects branches to import as lanes.
`ade.onboarding.generateInitialPacks()` triggers pack generation. Finally,
`ade.onboarding.complete()` marks onboarding done. Wizard closes, main UI loads.

**Settings**: Renderer calls `ade.app.getInfo()` for metadata. Theme changes apply
via CSS class toggle and persist to `localStorage`. Provider changes save to
`local.yaml` via `projectConfig.save()`. Keybinding overrides save via the
keybindings service to `kvDb`. Terminal profile changes save via the terminal
profiles service to `kvDb`. Data management actions use dedicated IPC calls with
confirmation dialogs.

---

## Data Model

### Configuration Files

**`.ade/ade.yaml`** (shared, committed):
```yaml
processes:
  - id: "install"
    name: "Install Dependencies"
    command: "npm install"
    cwd: "."
tests:
  - id: "unit"
    name: "Unit Tests"
    command: "npm test"
    cwd: "."
stackButtons:
  - id: "install"
    label: "Install"
    processId: "install"
automations: []
```

**`.ade/local.yaml`** (local, gitignored):
```yaml
provider:
  type: "byok"
  apiKey: "sk-..."
  llmProvider: "openai"
  model: "gpt-4"
preferences:
  theme: "dark"
  confirmBeforeExecute: true
trusted:
  configHash: "abc123"
  trustedAt: "2026-02-11T10:30:00Z"
```

### Detection Results

```typescript
interface OnboardingDetectionResult {
  projectTypes: string[];             // e.g. ["node", "docker", "ci"]
  indicators: OnboardingDetectionIndicator[];
  suggestedConfig: ProjectConfigFile; // Full suggested config incl. processes, tests, stacks, automations, providers
  suggestedWorkflows: Array<{ path: string; kind: "github-actions" | "gitlab-ci" | "other" }>;
}

interface OnboardingDetectionIndicator {
  file: string;       // e.g. "package.json"
  type: string;       // e.g. "node", "rust", "go", "python", "make", "docker", "github-actions"
  confidence: number; // 0.0 - 1.0
}

interface OnboardingExistingLaneCandidate {
  branchRef: string;
  isCurrent: boolean;
  hasRemote: boolean;
  ahead: number;
  behind: number;
}

interface OnboardingStatus {
  completedAt: string | null;
}
```

### Filesystem Artifacts

| Artifact | Created By | Purpose |
|----------|-----------|---------|
| `.ade/` directory | Onboarding Step 3 | Root for all ADE configuration |
| `.ade/ade.yaml` | Onboarding Step 3/4 | Shared project configuration |
| `.ade/local.yaml` | Onboarding Step 3 | Local preferences and secrets |
| `.git/info/exclude` entry | Onboarding Step 3 | Prevents `local.yaml` from being committed |

---

## Implementation Tracking

### Completed

| ID | Task | Description | Status |
|----|------|-------------|--------|
| ONBOARD-001 | Repository selection | Native file picker via Electron dialog, git repo validation | DONE |
| ONBOARD-002 | `.ade/` directory creation | Creates `.ade/` with default files on first open | DONE |
| ONBOARD-003 | Default `ade.yaml` generation | Writes a minimal valid `ade.yaml` with empty sections | DONE |
| ONBOARD-004 | `.git/info/exclude` setup | Adds `.ade/local.yaml` to git exclude | DONE |
| ONBOARD-005 | Settings page (app info) | Displays version, Electron, Node, platform, arch | DONE |
| ONBOARD-006 | Theme toggle | Dark/light switch with persistence | DONE |

### Implemented (Phase 6 / Phase 8)

| ID | Task | Description | Status |
|----|------|-------------|--------|
| ONBOARD-007 | Project defaults detection | Scan for `package.json`, `Makefile`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `docker-compose.yml`, `.github/workflows/`. Also detects package manager (npm/yarn/pnpm) and parses CI workflow YAML for test/lint commands. | DONE — Phase 8 |
| ONBOARD-008 | Onboarding wizard UI | 7-step wizard (welcome, detect-defaults, review-config, detect-branches, import-branches, generate-packs, complete) with progress indicator | DONE — Phase 8 |
| ONBOARD-009 | Suggested process definitions | Generate entries from detection results (install, build per detected ecosystem) | DONE — Phase 8 |
| ONBOARD-010 | Suggested test definitions | Generate test entries from detection + CI-derived commands (filtered to test/lint patterns, max 6) | DONE — Phase 8 |
| ONBOARD-011 | Config review step | Edit suggested config (processes, tests, stacks, automations) with append/replace mode before saving | DONE — Phase 8 |
| ONBOARD-012 | Hosted agent consent flow | Consent screen with data explanation | DONE — Phase 6 (consent checkboxes in SettingsPage + StartupAuthPage) |
| ONBOARD-013 | "What ADE will do" previews | Pre-execution dialogs for shared config | PARTIAL — onboarding previews implemented; generic pre-execution dialogs TBD |
| ONBOARD-014 | Provider configuration UI | Guest/Hosted/BYOK/CLI selector with config forms | DONE — Phase 6/8 (SettingsPage with Clerk OAuth, BYOK multi-provider, CLI config) |
| ONBOARD-015 | API key management | Secure input, local.yaml storage, validation | DONE — Phase 6 (password input in SettingsPage, stored in local.yaml, validated before save) |
| ONBOARD-016 | Keybindings viewer | Shortcut table by scope with action, default, override, effective columns | DONE — Phase 8 |
| ONBOARD-017 | Keybindings customization | Text-based override input with chord normalization and conflict detection | DONE — Phase 8 (text override UI; click-to-record deferred) |
| ONBOARD-018 | Data management | Clear local data (packs/logs/transcripts), export config bundle, delete hosted mirror data | DONE — Phase 8 |
| ONBOARD-019 | Welcome guide | In-app getting started with feature highlights | DONE — Phase 8 (onboarding welcome step) |
| ONBOARD-020 | Project switching | Recent projects list with quick-switch | DONE — Phase 8 |
| ONBOARD-021 | Initial codebase scan for pack seeding | Build a lightweight deterministic project bootstrap (repo map + git history seed) for the Project Pack | DONE — Phase 8 |
| ONBOARD-022 | Existing documentation import | Index `docs/` and key markdown files into the Project Pack bootstrap; AI details can summarize when Hosted/BYOK is enabled | DONE — Phase 8 |
| ONBOARD-023 | Existing lane/branch detection | Detect existing branches via `git for-each-ref`, compute ahead/behind counts, check remote tracking, filter already-tracked lanes | DONE — Phase 8 |
| ONBOARD-024 | Initial pack generation trigger | Run pack generation for project and all detected lanes during onboarding | DONE — Phase 8 |
| ONBOARD-025 | Guest mode | No-account usage with local features only; AI details disabled | DONE |
| ONBOARD-026 | Guest mode banner | Persistent "Guest Mode" banner with provider setup link | DONE |
| ONBOARD-027 | Terminal profiles service | Default launch profiles (Shell, Claude, Codex, Aider) with user customization. Persisted via kvDb. | DONE — Phase 8 |
| ONBOARD-028 | Terminal profiles UI | TerminalProfilesSection in Settings for profile CRUD (name, command, args, cwd, env) | DONE — Phase 8 |
| ONBOARD-029 | Suggested automations in onboarding | Default automation rules (session-end conflict prediction, hourly mirror sync) generated as part of suggested config | DONE — Phase 8 |
| ONBOARD-030 | Suggested provider config in onboarding | Default context tool generators (Codex, Claude) and conflict resolvers generated in suggested config | DONE — Phase 8 |
| ONBOARD-031 | GitHub settings section | Local PAT management and PR polling interval configuration | DONE — Phase 8 |

### Dependency Notes

- ONBOARD-007 is prerequisite for ONBOARD-009, ONBOARD-010, and ONBOARD-029/030.
- ONBOARD-008 depends on ONBOARD-007 for detection step content.
- ONBOARD-011 depends on ONBOARD-009/010/029/030 for suggested config.
- ONBOARD-012, ONBOARD-014, ONBOARD-015 completed in **Phase 6** (Cloud Infrastructure).
- ONBOARD-016/017 are independent of all other tasks.
- ONBOARD-020 requires a project registry service (**Phase 8**).
- ONBOARD-021 through ONBOARD-024 run deterministically in all modes; AI details are only generated when Hosted/BYOK is configured (and are skipped in Guest Mode).
- ONBOARD-025 and ONBOARD-026 are independent and were implemented in Phase 2/3.
- ONBOARD-027/028 (terminal profiles) are independent of onboarding but integrated into Settings.
- ONBOARD-031 (GitHub settings) depends on the GitHub service from **Phase 7**.

---

*This document describes the Onboarding and Settings features for ADE. Basic setup (ONBOARD-001 through ONBOARD-006) and guest mode (ONBOARD-025, ONBOARD-026) are implemented. Phase 6 implements hosted agent consent and provider configuration. Phase 8 implements the full onboarding wizard (7 steps), terminal profiles, keybindings customization, automations summary in settings, and deterministic context bootstrap.*
