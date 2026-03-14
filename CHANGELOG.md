# Changelog

All notable changes to ADE will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.1]: https://github.com/arul28/ADE/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/arul28/ADE/releases/tag/v1.0.0
