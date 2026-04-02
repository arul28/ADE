# Changelog

All notable changes to ADE will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Packed session grid** — resizable tile layout for the Work view with per-session column/row spans, drag-handle resizing on all edges and corners, and a bin-packing algorithm for compact arrangement (`PackedSessionGrid`, `packedSessionGridMath`)
- **Multi-select agent questions** — `AgentQuestionModal` now supports toggling multiple predefined options per question, with a Markdown/HTML preview pane for selected option descriptions (via `ReactMarkdown` + `rehype-sanitize`)
- **New Chat quick-create** — faster optimistic session opening from the Work view with immediate tab activation before the backend session is ready
- **Turn recap** — `chatTranscriptRows` emits a `turn_recap` summary row at the end of each turn, aggregating tool invocation counts and status
- **Claude tool-use tracking** — per-invocation lifecycle tracking via `toolUseID`; `tool_use_start` and `tool_use_complete` events enable per-tool status indicators in the work log
- **MCP initialize probe** — Claude runtime pre-checks MCP server availability before starting a session

### Changed

- **Terminal renderer fallback** — simplified from three tiers (WebGL/canvas/DOM) to two (WebGL-first with DOM fallback); added fit recovery with retry on invalid dimensions and `fitRecoveries` health counter
- **Work log headings** — human-readable labels (e.g. "Read utils.ts", "Run shell", "Write index.ts") replace generic tool identifiers; default visible entries increased from 1 to 4
- **Model catalog filtering** — `UnifiedModelSelector` accepts `catalogMode: "available-only"` to restrict the picker to models available via configured providers
- **Git stash actions** — stash pop, drop, and clear now refresh workspace metadata after completion
- **Composer sizing** — new compact and grid-tile sizing modes in `ChatComposerShell`

## [1.0.2] - 2026-03-15

### Added

- **Provider health pipeline** — five-module detection system (`authDetector`, `providerCredentialSources`, `providerConnectionStatus`, `providerRuntimeHealth`, `claudeRuntimeProbe`) replaces the single-pass provider check with granular CLI, credential, and runtime health detection
- **CTO identity presets** — built-in personality presets for the CTO agent with one-click selection in the identity editor
- **Budget cap editor** — inline budget cap editing in the automations UI

### Changed

- **Website overhaul** — complete rewrite of the landing page with accurate feature descriptions, screenshot placeholders, quick-start instructions, and links to docs/GitHub/releases; removed marketing fluff and false claims
- **README** — docs, website, and download links moved to a prominent position after badges; consolidated redundant sections
- **Documentation** — updated Mintlify docs and internal architecture docs to match current implementation; removed references to deleted services; fixed inaccurate feature descriptions
- **Claude runtime probe** — cache is now scoped by project root to prevent cross-project contamination when switching projects
- **Auth error detection** — deduplicated `isClaudeRuntimeAuthError` and `CLAUDE_RUNTIME_AUTH_ERROR` into a single shared module
- **GitHub token migration** — added completion flag to skip redundant filesystem checks after first migration
- **Memory doc sync** — debounced `syncDerivedMemoryDocs` (2s) to avoid write storms during rapid memory mutations
- **Automation run details** — fixed double DB lookup for ingress events in `getRunDetail`
- **Chat session comment** — corrected stale "lazy boot" comment to reflect eager pre-warm behavior
- **Docs site branding** — updated Mintlify config with correct logo paths and canonical URL

### Removed

- `automationRoutingService` (routing logic consolidated into `automationService`)
- `NightShiftTab` (deprecated automation UI)
- `PreviewPage` and `TestPage` (unused renderer pages)
- `infra/` directory (SST cloud infrastructure — ADE is fully local-first)

## [1.0.1] - 2026-03-14

### Added

- **Multimodal chat** — Claude agent chat now supports image attachments via base64 content blocks, with a new file upload picker and clipboard paste support in the composer
- **CTO daily logs** — CTO persona gains a Memory Protocol and Decision Framework; daily log utilities (append/read/list) auto-inject recent context into CTO sessions
- **External MCP auth service** — full OAuth and token-based authentication flows for connecting external MCP servers (795-line service with PKCE support)
- **Onboarding rewrite** — replaced the 1,373-line `OnboardingPage` with a focused 328-line `ProjectSetupPage`
- **New settings sections** — Lane Behavior, Lane Templates (expanded), Integrations, Workspace Settings, and AI Settings panels
- **Context doc preferences** — model, effort, and events settings now persist to the backend via new IPC handlers
- **Release workflow** — tag-triggered (`v*`) GitHub Actions workflow with a verification step ensuring tags point to `main`, concurrency control, and automated draft release creation
- **Repo protections** — branch protection rulesets for `main` and release tags, `CODEOWNERS` file, and release notes template
- **Run network panel** — new `RunNetworkPanel` component for the Run page
- **Computer use panel** — new `ChatComputerUsePanel` for inline computer-use artifacts
- **Vercel docs proxy** — `/docs` route now rewrites to the Mintlify-hosted documentation site
- **New documentation pages** — `cto/memory.mdx`, `docs/features/MEMORY.md`, and expanded getting-started guides

### Changed

- **Chat composer** — non-blocking async file handling, basename-only display in attachment tray, reworked prompt composition with identity re-injection after compaction
- **Linear OAuth** — bundled public PKCE client-ID fallback so CTO Linear sync works without manual credential setup; fixed OAuth server to listen on port 19836 and force `prompt=consent`
- **Orchestrator tuning** — lowered dedupe/retention/pruning thresholds, capped `workerProgressChatState`, pruned config cache, reduced session signal retention and health sweep intervals
- **Main process** — simplified hardware acceleration logic, narrowed default background task flags in dev stability mode
- **CI** — tightened permissions, removed old inline release job, added MCP server dependency install before desktop typecheck
- **Homepage & web** — refreshed landing page layout and styles, updated Tailwind config

### Removed

- `TerminalProfilesSection` and `TerminalSettingsDialog` (deprecated)
- `GenerateDocsModal` (functionality moved into `ContextSection`)
- `OnboardingPage` (replaced by `ProjectSetupPage`)
- Legacy infra packages (Pulumi binaries, factory configs, scrutiny reviews)

## [1.0.0] - 2026-03-13

Initial public release.

[1.0.2]: https://github.com/arul28/ADE/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/arul28/ADE/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/arul28/ADE/releases/tag/v1.0.0
