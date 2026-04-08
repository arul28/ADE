# Changelog

All notable changes to ADE will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.13] - 2026-04-07

### Added

- **OpenCode runtime integration** — replaced the Vercel AI SDK unified executor with direct OpenCode server integration; all non-CLI providers (API-key, OpenRouter, local) now route through the OpenCode server via `@opencode-ai/sdk`
- **OpenCode binary manager** — resolves OpenCode binary from user-installed PATH or bundled fallback, with process-lifetime caching (`openCodeBinaryManager.ts`)
- **OpenCode model catalog** — dynamic model discovery from OpenCode CLI with verbose JSON parsing and plain-text fallback (`openCodeModelCatalog.ts`)
- **OpenCode provider inventory** — probes connected providers and available models with shared server pooling, idle TTL, and deduped in-flight requests (`openCodeInventory.ts`)
- **Provider task runner** — unified 306-line task runner dispatching to Claude, Codex, Cursor, and OpenCode paths with timeout enforcement and permission mode mapping (`providerTaskRunner.ts`)
- **Tool exposure policy** — score-based heuristics for frontend repo discovery tool exposure based on prompt content analysis (`toolExposurePolicy.ts`)
- **Runtime message types** — provider-agnostic message representation decoupling ADE internals from SDK types (`runtimeMessageTypes.ts`)
- **CLI MCP config normalization** — normalizes MCP server config between Claude (`type`) and Codex (`transport`) field formats (`cliMcpConfig.ts`)
- **Local provider discovery pipeline** — endpoint probing, model inspection, capability inference, harness profile assignment, and TTL-based caching for Ollama and LM Studio
- **900+ lines of new tool tests** — `globSearch.test.ts` (219 lines), `grepSearch.test.ts` (276 lines), `readFileRange.test.ts` (197 lines), expanded `universalTools.test.ts` (+364 lines)
- **Compaction engine tests** — 526-line test suite covering transcript persistence, compaction triggering, and token accounting
- **Local model discovery tests** — 486-line test suite covering endpoint probing, capability inference, and cache invalidation

### Changed

- **Model registry** — `ProviderFamily` expanded with `"opencode"`; `ModelProviderGroup` changed from `"claude" | "codex" | "unified" | "cursor"` to `"claude" | "codex" | "opencode" | "cursor"`; new `openCodeProviderId` and `openCodeModelId` fields on `ModelDescriptor`
- **AI integration service** — uses OpenCode inventory for runtime discovery; dynamic model descriptors replaced via `replaceDynamicOpenCodeModelDescriptors`
- **Compaction engine** — uses `runOpenCodeTextPrompt` instead of the removed Vercel AI SDK path
- **Agent chat service** — restructured runtime management per provider group (+2,284/-2,284 lines)
- **Local model chat** — shared `LOCAL_PROVIDER_LABELS` helpers, merged CLI/local runtime banners, permission mode reset on harness profile change

### Fixed

- **Claude stream idle timeout** — removed entirely (was 75s, then 300s); long tool calls no longer risk timeout
- **Session list cache cross-tab** — creating a session invalidates the cache in all windows
- **Local model banner stacking** — CLI and local banners merged instead of stacking

### Removed

- Vercel AI SDK packages (`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`, `ai`)
- `providerResolver.ts`, `unifiedExecutor.ts`, `unifiedSessionProcessor.ts`, `middleware.ts`, `adeProviderRegistry.ts`, `tools/index.ts`, `verify-ai-sdks.cjs` and their test suites

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

[1.0.13]: https://github.com/arul28/ADE/compare/v1.0.12...v1.0.13
[1.0.2]: https://github.com/arul28/ADE/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/arul28/ADE/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/arul28/ADE/releases/tag/v1.0.0
