# Onboarding & Settings — Setup, Trust & Preferences

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-02

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
preferences, theme, AI provider detection, per-task model routing, and keybindings.

ADE operates inside a developer's existing git repository, which means it must be
transparent about what it creates and what it modifies. No account creation or
sign-up is required — ADE detects existing CLI tool subscriptions (Claude Code,
Codex) and uses them via ADE's AgentExecutor interface. The onboarding flow ensures developers
understand and consent to ADE's behavior before any changes are made. The settings
page provides ongoing control over those same concerns. Together, these features
establish the trust foundation that every other ADE feature builds on.

**Current status**: Onboarding wizard (defaults detection, config review, existing-lane import, initial deterministic pack generation), AI provider auto-detection, and per-task model routing are **implemented and working**. Onboarding now seeds the Project Pack with a lightweight deterministic bootstrap (codebase map + docs index + git history seed) so the initial context is immediately useful even before any AI narratives are generated.

---

## Core Concepts

### Onboarding

The first-time setup when a developer opens a repository in ADE. It handles
repository selection, default detection (scanning for build tools and test
frameworks), `.ade/` directory creation, and configuration review. No account
creation or authentication is required. The flow runs once per repository;
subsequent opens skip to the main UI.

### Trust Model

ADE distinguishes between shared and local configuration:

| Config File | Scope | Trust Level |
|------------|-------|-------------|
| `.ade/ade.yaml` | Shared (committed) | Requires explicit approval before executing processes or tests |
| `.ade/local.yaml` | Local (gitignored) | Always trusted; stores preferences and overrides |

The trust boundary exists because `.ade/ade.yaml` is a shared file that any team
member can modify. ADE prevents execution of untrusted shared config by showing
previews, maintaining an audit trail, and providing escape hatches.

### AI Provider Detection

ADE automatically detects installed CLI tools, API-key providers, and local model endpoints:

| Provider State | Description | AI Features |
|----------------|-------------|-------------|
| **Guest** | No authenticated provider detected (CLI/API/local) | All local features work (lanes, terminals, git, processes, tests, packs). AI-powered features are unavailable. |
| **CLI Subscription** | Claude Code and/or Codex CLI detected with active subscriptions | Full AI features via CLI-backed runtimes. |
| **API Key** | One or more providers configured via env/settings (OpenAI, Anthropic, Google, Mistral, DeepSeek, xAI, etc.) | Full AI features via unified API runtimes. |
| **Local Endpoint** | Local provider detected (LM Studio, Ollama, or vLLM) | Full AI features via OpenAI-compatible local runtimes. |

AI features become available when at least one provider is configured/detected.
For CLI providers, ADE uses existing local auth (`claude login`, `codex` auth). For
API-key/local providers, ADE routes through unified model runtimes.

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

Detection also generates default agent suggestions (for example, a session-end health automation agent) and default provider configuration (context tool generators for Codex and Claude).

**Step 3 — Review Config**: Full-page form showing suggested processes, tests, stack buttons, and agents. User can edit each section before saving. Supports "Append" mode (merge with existing) and "Replace" mode (overwrite). Agents are displayed alongside processes and tests for review.

**Step 4 — Detect Branches**: Scans for existing local branches (via `git for-each-ref refs/heads`). Displays a table showing each branch's ahead/behind counts relative to the base ref, whether it has a remote tracking branch, and whether it is the current branch. Filters out branches already tracked as ADE lanes.

**Step 5 — Import Branches**: For branches selected in Step 4, sequentially creates ADE lanes. Each import creates a lane with the branch ref and optionally sets a parent lane. Progress is shown per-branch with success/failure status.

**Step 6 — Generate Packs**: Triggers initial deterministic pack generation for the project and all imported lanes. When CLI tools are detected, AI narratives are generated in the background after the deterministic refresh via the agent SDKs:

- **Project Pack bootstrap**: Builds a lightweight project map (top-level folders, key files, git history seed) and seeds the Project Pack.
- **Documentation import**: Indexes the repository's `docs/` directory and key markdown files into the Project Pack bootstrap.
- **Lane Pack generation**: For each imported lane, generates an initial Lane Pack by analyzing the branch's diff against the base, commit history, and session data.

When no CLI tools are detected, deterministic packs are still generated; only AI narratives are skipped.

**Step 7 — Complete**: Wizard closes, main UI loads, toast confirms initialization. Users can re-run initial pack generation later from Settings.

### Trust Surfaces

- **"What ADE will do" dialogs**: Show exact commands before executing new or changed shared config
- **Operation timeline**: Full audit trail in the History tab
- **Escape hatches**: Undo operations, delete `.ade/`

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

**AI Provider**: Displays detected CLI tools with their subscription status.
- **Claude Code**: Detected/Not detected, subscription tier (Pro/Max)
- **Codex**: Detected/Not detected, subscription tier (Plus/Pro)
- **Status indicators**: Green (detected and active), gray (not detected)

**Task Model Routing**: Per-task-type configuration for which provider and model to use. Each row has a provider dropdown and a model dropdown. Model lists are populated dynamically at startup.

| Task Type | Description | Default Provider | Default Model | Available Models |
|-----------|-------------|-----------------|---------------|-----------------|
| `planning` | Mission and task planning | Claude | `sonnet` | Any configured model from registry (CLI/API/local/OpenRouter) |
| `implementation` | Code generation and edits | Codex | `gpt-5.3-codex` | Same pool |
| `review` | Code review and analysis | Claude | `sonnet` | Same pool |
| `conflict_resolution` | Merge conflict proposals | Claude | `sonnet` | Same pool |
| `narrative` | Pack narrative generation | Claude | `haiku` | Same pool |
| `pr_description` | Pull request descriptions | Claude | `haiku` | Same pool |
| `terminal_summary` | Terminal session summaries | Claude | `haiku` | Same pool |

Model discovery:
- **CLI models**: Detected from Codex/Claude availability and model discovery paths.
- **Unified models**: Included when API keys, OpenRouter, or local providers (LM Studio/Ollama/vLLM) are configured.
- **Filtering**: The model picker only shows configured/available models; unsupported/unconfigured models are hidden.
- Users can assign any available model to any task type — defaults are suggestions, not requirements.

**AI Feature Toggles**: Per-feature controls for enabling/disabling individual AI capabilities. Each toggle controls whether ADE uses AI for that specific feature. When disabled, the feature falls back to deterministic behavior (or is simply unavailable).

| Feature | Description | Default | Fallback |
|---------|-------------|---------|----------|
| `narratives` | AI-generated lane pack narratives | On | Deterministic template-based narratives |
| `conflict_proposals` | AI-powered merge conflict resolution proposals | On | Manual resolution only |
| `pr_descriptions` | AI-drafted pull request descriptions | On | Empty or template-based descriptions |
| `terminal_summaries` | AI-enhanced terminal session summaries | On | Deterministic pattern-matching summaries |
| `mission_planning` | AI-powered mission step decomposition | On | Deterministic keyword-based planner |
| `orchestrator` | AI orchestrator for mission execution | On | Manual step-by-step execution |

Each toggle persists to `.ade/local.yaml` under `ai.features`. When a feature is disabled, its usage counter stops incrementing and no AI calls are made for that feature type.

**AI Usage Dashboard**: A real-time usage tracking surface showing AI consumption across all ADE features.

The dashboard includes:
- **Usage bar per feature**: Visual progress bars showing AI calls made per feature (narratives, conflict proposals, PR descriptions, terminal summaries, mission planning, orchestrator) within the current billing period.
- **Session totals**: Aggregate token/call counts per provider (Claude, Codex) with breakdown by feature.
- **Subscription status**: Detected subscription tier for each provider (Claude Pro/Max, ChatGPT Plus/Pro) with known rate limits displayed when available. ADE reads rate limit headers from CLI responses when exposed.
- **Budget controls**: Per-feature call limits that users can set. When a limit is reached, ADE pauses AI calls for that feature and surfaces a notification. Budget controls are the foundation for agent guardrails and Night Shift agent budget caps (Phase 4).
- **Usage history**: Sparkline or bar chart showing daily/weekly AI usage trends.
- **Export**: Usage data exportable as JSON for external tracking.

Usage data is stored locally in SQLite (`ai_usage_log` table) with columns: `id`, `timestamp`, `feature`, `provider`, `model`, `input_tokens`, `output_tokens`, `duration_ms`, `success`, `session_id` (optional link to terminal/mission session).

**Implementation status**: The backend infrastructure (`ai_usage_log` table, `logUsage()` recording, daily budget enforcement via `checkBudget()`, aggregated usage queries, and token cost estimation) is fully implemented. A usage dashboard component exists in the Missions tab (`UsageDashboard.tsx`) showing summary cards, model breakdowns, mission breakdowns, and recent sessions. The `UsageDashboard` also includes Context Budget Panel functionality for monitoring memory and context usage during active missions. The Settings-embedded version with per-feature progress bars and sparkline history is not yet built.

The usage dashboard connects to the Agents hub (Phase 4) by providing the budget enforcement infrastructure — agent guardrails (including Night Shift agent budget caps) reuse the same per-feature limits and usage counters.

**Memory Settings**: Configuration for scoped memory namespaces that support agent knowledge persistence across missions.

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| Memory budget level | `lite` / `standard` / `deep` | `standard` | Controls how much memory context is injected into agent prompts. |
| Auto-promote candidates | Toggle | On | When enabled, candidate memories with sufficient confidence are automatically promoted on run completion. |
| Read scopes | Checkboxes: `run` / `project` / `identity` / `daily-log` | `run`, `project`, `identity` | Controls which scoped memories are retrieved into runtime context. |
| Write scopes | Checkboxes: `run` / `project` / `identity` | `run` | Controls where runtime writeback is allowed by default. |

Memory settings persist to `.ade/local.yaml` under `ai.memory`.

**Implementation status**: The `memoryService` backend (`apps/desktop/src/main/services/memory/memoryService.ts`) is fully implemented with candidate/promoted status tracking, confidence scoring, shared facts, and scoped retrieval/query methods for prompt injection. The Settings UI for full scope policy control is not yet built.

**Compaction Settings**: Configuration for SDK agent context compaction during long-running missions.

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| Compaction threshold | Percentage slider | 70% | Context window usage percentage at which compaction triggers. Lower values compact more aggressively (preserves headroom); higher values allow more context before compacting. |
| Pre-compaction fact writeback | Toggle | On | When enabled, facts are extracted from the transcript and persisted to the memory service before compaction. |

Compaction settings persist to `.ade/local.yaml` under `ai.compaction`.

**Implementation status**: The compaction engine (`apps/desktop/src/main/services/ai/compactionEngine.ts`) is fully implemented with transcript persistence (`attempt_transcripts` table), compaction monitoring, fact writeback, and session resume. The Settings UI for compaction configuration is not yet built.

**AI Permissions & Sandbox Configuration**: A dedicated section for controlling how Claude and Codex agents operate when invoked by ADE. These settings determine the security posture and autonomy level of AI agents across all ADE features.

**Claude Permissions**:

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| Permission Mode | `plan` / `acceptEdits` / `bypassPermissions` | `plan` | `plan` = read-only analysis (safest). `acceptEdits` = auto-approve file edits. `bypassPermissions` = full autonomy (use with caution). |
| Settings Sources | Checkboxes: User / Project / Local | None checked | Controls whether Claude loads `.claude/settings.json` files. By default, ADE controls all settings. Check "Project" to honor project-level Claude configuration. |
| CLAUDE.md Loading | Toggle | Off | When enabled (requires "Project" settings source), Claude reads the project's CLAUDE.md for additional context. |
| Per-Session Budget | USD input | $5.00 | Maximum spend per AI session. Claude stops when budget is reached. |
| Sandbox Mode | Toggle | On | Enable filesystem sandbox isolation. |

**Codex Permissions**:

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| Sandbox Level | `read-only` / `workspace-write` / `danger-full-access` | `workspace-write` | `read-only` = can read files but not write. `workspace-write` = can write within the lane worktree. `danger-full-access` = no filesystem restrictions. |
| Approval Mode | `untrusted` / `on-request` / `never` | `on-request` | `untrusted` = approve every tool use. `on-request` = approve mutations only. `never` = full autonomy. |
| Writable Paths | Path list editor | Empty | Additional paths the agent may write to beyond the current lane worktree (only applies in `workspace-write` mode). |
| Command Allowlist | Command list editor | Empty (default set) | Shell commands the agent is allowed to run. Empty uses the SDK default set. Add specific commands to restrict or expand. |
| `codex.toml` Honoring | Info display | Read-only | Shows whether a project-level `codex.toml` exists and notes that ADE's settings override it. |

**Settings Honoring Behavior**:

Both Claude and Codex have project-level configuration files (`.claude/settings.json` and `codex.toml` respectively). ADE's behavior with these files:

- **Claude**: `.claude/settings.json` is NOT loaded by default. ADE controls all Claude settings via the SDK. Users can opt in to loading project settings by checking "Project" in Settings Sources. This is a deliberate design choice — ADE's permission policies should not be overridden by project-level Claude configuration.
- **Codex**: `codex.toml` is loaded as a base layer, but ADE's SDK config always takes priority. This means project-level `codex.toml` provides defaults, but ADE's Settings always win. Users can see the effective configuration in Settings.

These settings persist to `.ade/local.yaml` under `ai.permissions.claude` and `ai.permissions.codex`.

**Agent Chat Settings**: Configuration for the interactive agent chat interface (Phase 1.5).

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| Default chat provider | Codex / Claude / Last used | Last used | Legacy default used when opening a fresh chat before an explicit model is selected. |
| Default approval policy | Auto / Approve mutations / Approve all | Approve mutations | How tool use approvals are handled in chat. Auto = never ask. Approve mutations = ask for file writes and commands. Approve all = ask for everything. |
| Send on Enter | Toggle | On | When on, Enter sends messages. When off, Cmd+Enter sends (Enter inserts newline). |
| Codex chat sandbox | Read-only / Workspace write / Full access | Workspace write | Filesystem sandbox policy for Codex chat sessions. |
| Claude chat permission mode | Plan / Accept edits / Bypass permissions | Accept edits | Permission mode for Claude chat sessions (independent of one-shot task permission mode). |
| Unified chat permission mode | Plan / Edit / Full-auto | Edit | Default permission mode for non-CLI chat sessions (API-key/local/OpenRouter models). |
| Chat session budget | USD input | $10.00 | Per-session budget cap for chat sessions (applies to both providers). |

Chat settings persist to `.ade/local.yaml` under `ai.chat`.

Chat model availability and switching behavior:
- The chat model dropdown only shows models that are currently configured/authenticated (including local endpoints like LM Studio/Ollama/vLLM when detected).
- Changing to a different model family while a chat thread is active starts a new chat session using the selected model, preserving thread consistency and provider/runtime invariants.

**Lane Templates**: Manage reusable lane initialization templates.

**Settings → Lane Templates**

- **Template List**: CRUD for lane templates (create, edit, duplicate, delete)
- **Template Fields**:
  - Name and description
  - Environment file mappings (source → destination, with variable substitution)
  - Port range (start port, range size)
  - Docker Compose file path (optional)
  - Install command (e.g., `npm install`, `pip install -r requirements.txt`)
- **Default Template**: Set a project-level default template for new lanes

**Proxy & Preview**: Configure lane-level hostname isolation and preview URLs.

**Settings → Proxy & Preview**

- **Enable Proxy**: Toggle on/off (default: off)
- **Proxy Port**: Single port for the reverse proxy (default: 8080)
- **Hostname Pattern**: Template for lane hostnames (default: `<lane-slug>.localhost`)
- **Auto-Setup**: Automatically register lanes with proxy on creation
- **Port Detection**: Auto-detect dev server ports in lanes

**Compute Backends**: Configure available execution environments for lanes and missions.

**Settings → Compute Backends**

*Local* (Default)
- No additional configuration required
- Uses host machine resources

*VPS*
- Relay server address
- Pairing code / SSH key configuration
- Set as Night Shift agent default (route after-hours agent work to VPS)

*Daytona* (Opt-in)
- API key
- Region selection
- Default resource allocation (CPU, RAM, disk)
- Auto-stop timeout (idle workspace cleanup)
- Set as mission default (route orchestrated work to Daytona sandbox)

Note: Daytona integration is always opt-in. It provides isolated cloud sandbox environments but is never required for ADE functionality.

**Browser Profiles**: Configure isolated browser profiles for per-lane preview.

**Settings → Browser Profiles**

- **Enable**: Toggle browser profile isolation on/off
- **Chrome Path**: Path to Chrome/Chromium executable
- **Profile Directory**: Base directory for lane-specific browser profiles
- **Auto-Launch**: Automatically open preview URL in isolated profile on lane start

**Agents**: Embedded `AgentsSection` showing all agents with type badges, enable/disable toggles, "Run Now" buttons, and history links. Includes agent identity management (create, edit, clone, delete identities with version history), Night Shift global settings (time window, compute backend default, morning digest delivery time, global budget cap, subscription utilization mode with maximize/conservative/fixed options, conservative capacity percentage, weekly reserve percentage for daytime use, multi-batch scheduling toggle, and a live subscription status panel showing current tier, rate limit state, estimated overnight capacity, and projected utilization), and watcher agent settings (default poll interval, GitHub API rate limit awareness). Provides a summary view without leaving Settings.

**Terminal Profiles**: Manage terminal launch profiles. Default profiles include Shell, Claude, Codex, and Aider. Users can add custom profiles with name, command, args, cwd, and environment variables. Profiles are persisted via `kvDb`.

**Keybindings**: Table showing all shortcuts with action, scope, default binding, user override, and effective binding. Supports text-based override input with chord normalization and conflict detection (warns when two actions share the same key binding).

**Data Management**: Two actions:
- **Clear local data**: Removes packs, logs, and transcripts.
- **Export config**: Exports the project configuration as a bundle.

**GitHub**: Local GitHub token management. Configure PATs stored in `local.yaml` for GitHub API access. PR polling interval configuration. GitHub integration uses the local `gh` CLI or PATs.

---

## Technical Implementation

### Services

| Service | Status | Role |
|---------|--------|------|
| `projectService` | Exists | Repository initialization, `.ade/` creation, project metadata |
| `projectConfigService` | Exists | Config CRUD, validation, trust confirmation, schema enforcement |
| `onboardingService` | Exists | Detection of project defaults (node/rust/go/python/make/docker/CI), suggested config generation (incl. default agents and provider config), existing branch detection with ahead/behind computation, initial pack generation |
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
| `ade.onboarding.detectDefaults()` | Exists | Scans repo for project indicators, returns `OnboardingDetectionResult` with suggested config incl. agents and provider defaults |
| `ade.onboarding.detectExistingLanes()` | Exists | Scans for local branches, returns `OnboardingExistingLaneCandidate[]` with ahead/behind/remote/isCurrent per branch |
| `ade.onboarding.generateInitialPacks(args)` | Exists | Triggers initial pack generation for project and selected lane IDs |
| `ade.onboarding.complete()` | Exists | Marks onboarding as complete, returns `OnboardingStatus` |
| `ade.ai.getUsage()` | Planned | Returns usage stats per feature/provider |
| `ade.ai.getFeatureToggles()` | Planned | Returns current toggle states |
| `ade.ai.setFeatureToggles(toggles)` | Planned | Update toggle states |
| `ade.ai.getBudgets()` | Planned | Returns budget limits |
| `ade.ai.setBudgets(budgets)` | Planned | Update budget limits |
| `ade.ai.getPermissions()` | Planned | Returns current Claude and Codex permission/sandbox settings |
| `ade.ai.setPermissions(settings)` | Planned | Update Claude and Codex permission/sandbox settings |
| `ade.ai.getAvailableModels()` | Planned | Returns available models per provider (from SDK discovery and hardcoded lists) |
| `ade.ai.getChatSettings()` | Planned | Returns current chat configuration |
| `ade.ai.setChatSettings(settings)` | Planned | Update chat configuration |

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
  |    +-- Agent editor (add/edit/remove)
  |    +-- Append/Replace mode toggle
  +-- DetectBranchesStep (branch table with ahead/behind/remote columns)
  +-- ImportBranchesStep (sequential import with parent lane selection)
  +-- GeneratePacksStep (progress indicator per pack)
  +-- CompleteStep (done message + toast)

SettingsPage (route: /settings)
  +-- AppInfoSection (version, Electron, Node, platform, arch)
  +-- ThemeSection (6 theme swatches: e-paper, bloomberg, github, rainbow, sky, pats)
  +-- AIProviderSection
  |    +-- DetectedToolsList (Claude Code status, Codex status with subscription tier)
  |    +-- TaskRoutingTable (task type → provider → model per row)
  +-- AIFeatureTogglesSection
  |    +-- Per-feature toggle switches with status indicators
  |    +-- "Disable all AI" master toggle
  +-- AIUsageDashboardSection
  |    +-- UsageBarPerFeature (visual progress bars)
  |    +-- SubscriptionStatusCards (provider tiers, rate limits)
  |    +-- BudgetControlsTable (per-feature limits)
  |    +-- UsageHistoryChart (sparkline/bar)
  |    +-- ExportButton (JSON export)
  +-- AIMemorySettingsSection
  |    +-- MemoryBudgetLevelPicker (lite / standard / deep)
  |    +-- AutoPromoteCandidatesToggle
  |    +-- MemoryScopeVisibilityCheckboxes (user, project, lane, mission)
  +-- AICompactionSettingsSection
  |    +-- CompactionThresholdSlider (percentage, default 70%)
  |    +-- FactWritebackToggle (default on)
  +-- AIPermissionsSandboxSection
  |    +-- ClaudePermissionsCard (permission mode, settings sources, CLAUDE.md, budget, sandbox)
  |    +-- CodexPermissionsCard (sandbox level, approval mode, writable paths, command allowlist)
  |    +-- SettingsHonoringInfo (display of .claude/settings.json and codex.toml status)
  +-- AgentChatSettingsSection
  |    +-- DefaultProviderPicker (Codex / Claude / Last used)
  |    +-- ApprovalPolicyPicker (Auto / Approve mutations / Approve all)
  |    +-- SendOnEnterToggle
  |    +-- PerProviderChatSettings (sandbox/permission mode per provider)
  |    +-- ChatBudgetInput
  +-- LaneTemplatesSection
  |    +-- TemplateList (CRUD: create, edit, duplicate, delete)
  |    +-- TemplateEditor (name, env files, port range, Docker path, install cmd)
  |    +-- DefaultTemplatePicker
  +-- ProxyPreviewSection
  |    +-- EnableProxyToggle
  |    +-- ProxyPortInput
  |    +-- HostnamePatternInput
  |    +-- AutoSetupToggle
  |    +-- PortDetectionToggle
  +-- ComputeBackendsSection
  |    +-- LocalBackendCard (default, no config)
  |    +-- VpsBackendCard (relay address, pairing, Night Shift default toggle)
  |    +-- DaytonaBackendCard (API key, region, resources, auto-stop, mission default toggle)
  +-- BrowserProfilesSection
  |    +-- EnableToggle
  |    +-- ChromePathInput
  |    +-- ProfileDirectoryInput
  |    +-- AutoLaunchToggle
  +-- AgentsSection
  |    +-- AgentSummaryList (per-agent summary with type badge, run-now, history, toggle)
  |    +-- AgentIdentitiesManager (CRUD for identities, preset library, version history)
  |    +-- NightShiftGlobalSettings (time window, compute backend, digest time, budget cap, subscription utilization mode, conservative %, weekly reserve %, multi-batch toggle, subscription status panel)
  +-- TerminalProfilesSection (profile CRUD: name, command, args, cwd, env)
  +-- KeybindingsSection (table: action, scope, default, override, effective + conflict detection)
  +-- GitHubSection (local PAT management, PR polling interval)
  +-- DataManagementSection (clear data, export config)
```

### Data Flow

**Onboarding**: User opens project via file picker (`ade.project.openRepo`). Main
validates git repo, returns `ProjectInfo`. Renderer calls `ade.onboarding.detectDefaults()`
to scan for indicators, which returns `OnboardingDetectionResult` with project types,
indicators, suggested config (including agent definitions and provider defaults), and
suggested workflows. User reviews and edits the suggested config. Renderer calls
`ade.onboarding.applySuggestedConfig()` (via `projectConfig.save`) to write files.
Next, `ade.onboarding.detectExistingLanes()` scans for local branches and returns
candidates with ahead/behind/remote status. User selects branches to import as lanes.
`ade.onboarding.generateInitialPacks()` triggers pack generation. Finally,
`ade.onboarding.complete()` marks onboarding done. Wizard closes, main UI loads.

**Settings**: Renderer calls `ade.app.getInfo()` for metadata. Theme changes apply
via CSS class toggle and persist to `localStorage`. AI provider detection runs
automatically on settings load, displaying detected CLI tools and their status.
Task routing changes save to `local.yaml` via `projectConfig.save()`. Keybinding
overrides save via the keybindings service to `kvDb`. Terminal profile changes save
via the terminal profiles service to `kvDb`. Data management actions use dedicated
IPC calls with confirmation dialogs.

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
agents: []
```

**`.ade/local.yaml`** (local, gitignored):
```yaml
ai:
  providers:
    claude:
      detected: true
      subscription: "pro"
    codex:
      detected: true
      subscription: "plus"
  taskRouting:
    planning: { provider: "claude", model: "sonnet" }
    implementation: { provider: "codex", model: "gpt-4.1" }
    review: { provider: "claude", model: "sonnet" }
    conflict_resolution: { provider: "claude", model: "sonnet" }
    narrative: { provider: "claude", model: "haiku" }
    pr_description: { provider: "claude", model: "haiku" }
    terminal_summary: { provider: "claude", model: "haiku" }
  features:
    narratives: true
    conflict_proposals: true
    pr_descriptions: true
    terminal_summaries: true
    mission_planning: true
    orchestrator: true
  budgets:
    narratives: { daily_limit: 50 }
    conflict_proposals: { daily_limit: 20 }
    pr_descriptions: { daily_limit: 30 }
    terminal_summaries: { daily_limit: 100 }
    mission_planning: { daily_limit: 10 }
    orchestrator: { daily_limit: 5 }
  permissions:
    claude:
      permission_mode: plan
      settings_sources: []
      claude_md_loading: false
      max_budget_usd: 5.00
      sandbox: true
    codex:
      approval_mode: on-request
      sandbox_permissions: workspace-write
      writable_paths: []
      command_allowlist: []
  chat:
    default_provider: last_used        # codex | claude | last_used
    approval_policy: approve_mutations # auto | approve_mutations | approve_all
    send_on_enter: true
    codex_sandbox: workspace-write     # read-only | workspace-write | full-access
    claude_permission_mode: acceptEdits # plan | acceptEdits | bypassPermissions
    session_budget_usd: 10.00
  memory:
    budget_level: standard             # lite | standard | deep
    auto_promote_candidates: true
    read_scopes:
      run: true
      project: true
      identity: true
      daily_log: false
    write_scopes:
      run: true
      project: false
      identity: false
  compaction:
    threshold_percent: 70              # 0-100, context window % before compaction triggers
    fact_writeback: true               # extract facts before compacting
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
  suggestedConfig: ProjectConfigFile; // Full suggested config incl. processes, tests, stacks, agents, providers
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
| `.ade/local.yaml` | Onboarding Step 3 | Local preferences and AI provider config |
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

### Implemented

| ID | Task | Description | Status |
|----|------|-------------|--------|
| ONBOARD-007 | Project defaults detection | Scan for `package.json`, `Makefile`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `docker-compose.yml`, `.github/workflows/`. Also detects package manager (npm/yarn/pnpm) and parses CI workflow YAML for test/lint commands. | DONE |
| ONBOARD-008 | Onboarding wizard UI | 7-step wizard (welcome, detect-defaults, review-config, detect-branches, import-branches, generate-packs, complete) with progress indicator | DONE |
| ONBOARD-009 | Suggested process definitions | Generate entries from detection results (install, build per detected ecosystem) | DONE |
| ONBOARD-010 | Suggested test definitions | Generate test entries from detection + CI-derived commands (filtered to test/lint patterns, max 6) | DONE |
| ONBOARD-011 | Config review step | Edit suggested config (processes, tests, stacks, agents) with append/replace mode before saving | DONE |
| ONBOARD-013 | "What ADE will do" previews | Pre-execution dialogs for shared config | PARTIAL — onboarding previews implemented; generic pre-execution dialogs TBD |
| ONBOARD-014 | AI provider detection UI | Detected CLI tools display with subscription status and per-task model routing | DONE |
| ONBOARD-016 | Keybindings viewer | Shortcut table by scope with action, default, override, effective columns | DONE |
| ONBOARD-017 | Keybindings customization | Text-based override input with chord normalization and conflict detection | DONE (text override UI; click-to-record deferred) |
| ONBOARD-018 | Data management | Clear local data (packs/logs/transcripts), export config bundle | DONE |
| ONBOARD-019 | Welcome guide | In-app getting started with feature highlights | DONE (onboarding welcome step) |
| ONBOARD-020 | Project switching | Recent projects list with quick-switch | DONE |
| ONBOARD-021 | Initial codebase scan for pack seeding | Build a lightweight deterministic project bootstrap (repo map + git history seed) for the Project Pack | DONE |
| ONBOARD-022 | Existing documentation import | Index `docs/` and key markdown files into the Project Pack bootstrap; AI narratives generated when CLI tools are detected | DONE |
| ONBOARD-023 | Existing lane/branch detection | Detect existing branches via `git for-each-ref`, compute ahead/behind counts, check remote tracking, filter already-tracked lanes | DONE |
| ONBOARD-024 | Initial pack generation trigger | Run pack generation for project and all detected lanes during onboarding | DONE |
| ONBOARD-027 | Terminal profiles service | Default launch profiles (Shell, Claude, Codex, Aider) with user customization. Persisted via kvDb. | DONE |
| ONBOARD-028 | Terminal profiles UI | TerminalProfilesSection in Settings for profile CRUD (name, command, args, cwd, env) | DONE |
| ONBOARD-029 | Suggested agents in onboarding | Default agent rules (session-end conflict prediction and baseline maintenance) generated as part of suggested config | DONE |
| ONBOARD-030 | Suggested provider config in onboarding | Default context tool generators (Codex, Claude) and conflict resolvers generated in suggested config | DONE |
| ONBOARD-031 | GitHub settings section | Local PAT management and PR polling interval configuration | DONE |
| ONBOARD-032 | AI feature toggles UI and persistence | Per-feature AI enable/disable toggles with master toggle, persisted to `local.yaml` under `ai.features` | TODO |
| ONBOARD-033 | AI usage dashboard with per-feature tracking | Real-time usage tracking surface with per-feature progress bars, session totals, and usage history. Backend: `ai_usage_log` table, `logUsage()`, aggregated usage query IPC, and cost estimation are DONE. A usage dashboard UI exists in Missions tab (`UsageDashboard.tsx`). Remaining: dedicated Settings-embedded dashboard with per-feature progress bars and usage history sparklines | PARTIAL |
| ONBOARD-034 | Budget controls with daily limits | Per-feature AI call limits with notification when limits are reached; foundation for agent guardrails and Night Shift agent budget caps. Backend: daily budget enforcement via `checkBudget()` is DONE — blocks execution when daily limit exceeded. Budget config read from `ai.budgets` in `local.yaml` is DONE. Remaining: Settings UI to configure budget limits, soft warning notifications before limit reached | PARTIAL |
| ONBOARD-035 | Provider status detection and display | Detected provider/auth status display with known rate-limit metadata where available. Backend: mode detection across guest/CLI/API/local is DONE. Remaining: richer tier detection (Pro/Max for Claude, Plus/Pro for Codex), robust CLI header parsing, and expanded Settings presentation | PARTIAL |
| ONBOARD-036 | AI permissions & sandbox configuration UI | Dedicated section for Claude permission mode, Codex sandbox level, approval mode, writable paths, command allowlist. Persisted to `local.yaml` under `ai.permissions` | TODO |
| ONBOARD-037 | Dynamic model picker for task routing | Per-task model dropdown populated from `supportedModels()` (Claude) and hardcoded list (Codex). Users can assign any model to any task type | TODO |
| ONBOARD-038 | Settings honoring behavior display | Show whether .claude/settings.json and codex.toml exist, explain override behavior, allow opt-in for project settings sources | TODO |
| ONBOARD-039 | Agent chat settings UI | Chat-specific settings: default provider, approval policy, send-on-enter, per-provider sandbox/permission, session budget | TODO |
| ONBOARD-040 | Memory settings UI | Memory budget level picker (lite/standard/deep), auto-promote toggle, read/write scope policy controls. Backend: `memoryService` with candidate promotion, shared facts, and scoped retrieval/writeback — all implemented. | TODO (UI) |
| ONBOARD-041 | Compaction settings UI | Compaction threshold slider, fact writeback toggle. Backend: `compactionEngine` with `attempt_transcripts` table, compaction monitoring, fact writeback — all implemented. | TODO (UI) |
| ONBOARD-042 | Context Budget Panel (Missions) | Context budget visibility in mission Details tab via `UsageDashboard.tsx`, showing memory usage and context window consumption during active missions | DONE |

### Dependency Notes

- ONBOARD-007 is prerequisite for ONBOARD-009, ONBOARD-010, and ONBOARD-029/030.
- ONBOARD-008 depends on ONBOARD-007 for detection step content.
- ONBOARD-011 depends on ONBOARD-009/010/029/030 for suggested config.
- ONBOARD-016/017 are independent of all other tasks.
- ONBOARD-020 requires a project registry service.
- ONBOARD-021 through ONBOARD-024 run deterministically in all modes; AI narratives are only generated when CLI tools are detected.
- ONBOARD-027/028 (terminal profiles) are independent of onboarding but integrated into Settings.
- ONBOARD-031 (GitHub settings) depends on the GitHub service.

---

*This document describes the Onboarding and Settings features for ADE. Onboarding provides a guided setup wizard for initializing ADE in a repository. Settings provides AI provider detection, per-task model routing, theme management, keybindings, terminal profiles, and data management. No account creation or authentication is required — AI features are powered by detected CLI tool subscriptions via the agent SDKs.*
