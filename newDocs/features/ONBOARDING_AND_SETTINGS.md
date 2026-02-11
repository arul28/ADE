# Onboarding & Settings — Setup, Trust & Preferences

> Last updated: 2026-02-11

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
- Context tracking (packs, checkpoints, narratives) is **disabled** — these require an LLM connection or hosted agent account
- Conflict prediction runs in **heuristic-only mode** (file-overlap detection, no LLM-powered resolution proposals)
- The History tab records operations but without pack-enriched context
- The Workspace Graph renders topology and stack edges, but risk edges default to "unknown" (gray)

Guest Mode is the default state before onboarding is completed. Users can remain in Guest Mode indefinitely. A persistent banner shows: "Running in Guest Mode — context tracking disabled. [Set up provider →]" with a link to the Settings page.

Guest Mode ensures ADE is immediately useful for git workflow management and terminal orchestration even without any cloud or LLM setup.

---

## User Experience

### Onboarding Flow

Presented as a step-by-step wizard when the opened repository lacks a `.ade/` directory.

**Step 1 — Select Repository**: Native file picker or CLI path argument. Validates the directory is a git repository.

**Step 2 — Detect Defaults**: Scans for project indicators and suggests config:

| Indicator | Detection Result |
|-----------|-----------------|
| `package.json` | Suggests `npm install`, `npm test`, `npm run build` |
| `Makefile` | Suggests `make`, `make test` |
| `docker-compose.yml` | Suggests `docker compose up` |
| `Cargo.toml` | Suggests `cargo build`, `cargo test` |
| `go.mod` | Suggests `go build ./...`, `go test ./...` |
| `pyproject.toml` | Suggests `pip install -e .`, `pytest` |
| `.github/workflows/` | Imports test commands from CI workflow files |

**Step 3 — Create `.ade/`**: Initializes `.ade/ade.yaml` (shared) and `.ade/local.yaml` (local). Adds `local.yaml` to `.git/info/exclude`.

**Step 4 — Review Config**: Full-page form showing suggested processes, tests, and stack buttons. User can edit before saving.

**Step 5 — Hosted Agent Consent** (optional): Explains what data leaves the machine, what stays local, and how to revoke. Options: "Enable Hosted Agent", "Use BYOK", "Stay Local", "Decide Later".

**Step 5.5 — Initial Pack Generation** (optional, requires provider): If a provider is configured (Hosted, BYOK, or CLI), ADE offers to generate initial packs:

- **Codebase scan**: ADE analyzes the repository structure, key files (`README.md`, `package.json`, `Cargo.toml`, etc.), directory layout, and git history to bootstrap a **Project Pack** with architecture overview, conventions, and technology stack.
- **Existing documentation import**: ADE asks: "Do you have existing project documentation? (e.g., PRD, architecture docs, design specs)". If the user provides file paths or a docs directory, ADE uses the LLM to ingest those documents and seed the Project Pack with richer, more accurate context than codebase analysis alone.
- **Existing lane detection**: If the repository already has branches or worktrees, ADE offers to create lanes for them and generate initial **Lane Packs** by analyzing each branch's diff against the base, commit history, and any existing documentation references.

This step is skipped entirely in Guest Mode. Users can trigger initial pack generation later from Settings → Data Management → "Generate Initial Packs".

**Step 6 — Done**: Wizard closes, main UI loads, toast confirms initialization.

### Trust Surfaces

- **"What ADE will do" dialogs**: Show exact commands before executing new or changed shared config
- **Operation timeline**: Full audit trail in the History tab
- **Escape hatches**: Undo operations, delete `.ade/`, disable hosted agent

### Settings Page

**App Info**: Version, Electron version, Node.js version, platform, architecture (read-only).

**Theme**: Dark (Bloomberg Terminal) / Light (Clean Paper) toggle. Persisted to `localStorage`, applied immediately.

**Provider Configuration**: Radio selector for Hosted/BYOK/CLI. BYOK shows API key input, provider dropdown, model selection. API keys stored in `local.yaml`.

**Keybindings**: Table of all shortcuts with action, binding, and scope. Customization planned for future.

**Data Management**: Clear local data, export project config, delete hosted mirror data.

**Guest Mode Banner**: When no provider is configured, a persistent banner appears at the top of every page: "Running in Guest Mode — context tracking disabled. [Set up provider →]". The banner links to the Provider Configuration section.

---

## Technical Implementation

### Services

| Service | Status | Role |
|---------|--------|------|
| `projectService` | Exists | Repository initialization, `.ade/` creation, project metadata |
| `projectConfigService` | Exists | Config CRUD, validation, trust confirmation, schema enforcement |
| `onboardingService` | Planned | Detection of project defaults, suggested config generation, wizard state |
| `kvDb` | Exists | Persists theme and local settings outside YAML config |

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
| `ade.onboarding.detectDefaults(repoPath)` | Planned | Scans repo, returns detection results |
| `ade.onboarding.generateConfig(detections)` | Planned | Generates suggested `ade.yaml` |
| `ade.onboarding.scanCodebase(repoPath)` | Planned | Analyzes repo structure, returns codebase summary for pack seeding |
| `ade.onboarding.importDocs(paths)` | Planned | Ingests existing documentation files, returns structured content for pack seeding |
| `ade.onboarding.detectExistingLanes(repoPath)` | Planned | Scans for existing branches/worktrees, returns candidates for lane creation |
| `ade.onboarding.generateInitialPacks(args)` | Planned | Triggers initial pack generation for project and detected lanes |

### Component Architecture

```
OnboardingWizard (modal, shown on first open)
  +-- StepIndicator (progress bar)
  +-- RepoSelectStep
  +-- DetectDefaultsStep (spinner then results)
  +-- ReviewConfigStep
  |    +-- ProcessEditor / TestEditor / StackButtonEditor
  +-- HostedConsentStep
  +-- DoneStep

SettingsPage (route: /settings)
  +-- AppInfoSection
  +-- ThemeSection (+-- ThemeToggle)
  +-- ProviderSection (+-- ProviderSelector, BYOKConfig, HostedConfig)
  +-- KeybindingsSection (+-- KeybindingsTable)
  +-- DataManagementSection
```

### Data Flow

**Onboarding**: User opens project via file picker (`ade.project.openRepo`). Main
validates git repo, returns `ProjectInfo`. Renderer calls `detectDefaults` to scan
for indicators, then `generateConfig` for suggested YAML. User reviews and edits.
Renderer calls `projectConfig.save` to write files. Main creates `.ade/`, writes
config, updates `.git/info/exclude`. Wizard closes, main UI loads.

**Settings**: Renderer calls `ade.app.getInfo()` for metadata. Theme changes apply
via CSS class toggle and persist to `localStorage`. Provider changes save to
`local.yaml` via `projectConfig.save()`. Data management actions use dedicated IPC
calls with confirmation dialogs.

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
interface DetectionResult {
  projectType: string[];
  indicators: Array<{ file: string; type: string; confidence: number }>;
  suggestedProcesses: Array<{ id: string; name: string; command: string; cwd: string }>;
  suggestedTests: Array<{ id: string; name: string; command: string; suiteId: string }>;
  suggestedStackButtons: Array<{ id: string; label: string; processId: string }>;
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

### Planned

| ID | Task | Description | Status |
|----|------|-------------|--------|
| ONBOARD-007 | Project defaults detection | Scan for `package.json`, `Makefile`, etc. | TODO |
| ONBOARD-008 | Onboarding wizard UI | Step-by-step modal with progress indicator | TODO |
| ONBOARD-009 | Suggested process definitions | Generate entries from detection results | TODO |
| ONBOARD-010 | Suggested test definitions | Generate test entries from detection | TODO |
| ONBOARD-011 | Config review step | Edit suggested config before saving | TODO |
| ONBOARD-012 | Hosted agent consent flow | Consent screen with data explanation | TODO |
| ONBOARD-013 | "What ADE will do" previews | Pre-execution dialogs for shared config | TODO |
| ONBOARD-014 | Provider configuration UI | Hosted/BYOK/CLI selector with config forms | TODO |
| ONBOARD-015 | API key management | Secure input, local.yaml storage, validation | TODO |
| ONBOARD-016 | Keybindings viewer | Read-only shortcut table by scope | TODO |
| ONBOARD-017 | Keybindings customization | Click-to-record editor with conflict detection | TODO |
| ONBOARD-018 | Data management | Clear local data, export config, delete hosted data | TODO |
| ONBOARD-019 | Welcome guide | In-app getting started with feature highlights | TODO |
| ONBOARD-020 | Project switching | Recent projects list with quick-switch | TODO |
| ONBOARD-021 | Initial codebase scan for pack seeding | Analyze repo structure, key files, and git history to bootstrap Project Pack | TODO |
| ONBOARD-022 | Existing documentation import | Ask user for docs directory/files, ingest via LLM for richer pack seeding | TODO |
| ONBOARD-023 | Existing lane/branch detection | Detect existing branches and worktrees, offer to create lanes and generate Lane Packs | TODO |
| ONBOARD-024 | Initial pack generation trigger | Run pack generation for project and all detected lanes during onboarding | TODO |
| ONBOARD-025 | Guest mode | No-account usage with local features only, context tracking disabled | TODO |
| ONBOARD-026 | Guest mode banner | Persistent "Guest Mode" banner with provider setup link | TODO |

### Dependency Notes

- ONBOARD-007 is prerequisite for ONBOARD-009 and ONBOARD-010.
- ONBOARD-008 depends on ONBOARD-007 for detection step content.
- ONBOARD-011 depends on ONBOARD-009/010 for suggested config.
- ONBOARD-012 depends on the hosted agent service (not yet implemented).
- ONBOARD-014/015 can be developed independently of onboarding.
- ONBOARD-016/017 are independent of all other tasks.
- ONBOARD-020 requires a project registry service (not yet implemented).
- ONBOARD-021 through ONBOARD-024 require a configured LLM provider (skipped in Guest Mode).
- ONBOARD-025 and ONBOARD-026 are independent and should be implemented early (Phase 2 or 3).

---

*This document describes the Onboarding and Settings features for ADE. It will be
updated as implementation progresses.*
