# Changelog

All notable changes to ADE will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.6] - 2026-06-16

### Fixed

- Voice input is reachable again: the on-device dictation model now downloads straight from the chat mic and from Settings → General instead of a dead-end "ships with a future update" tooltip. The download runs in the background, survives leaving Settings, and verifies its checksum with retry.
- ADE Code: pasting an image while connected to a remote machine no longer crashes with a permission error — the image is materialized locally and uploaded to the runtime.
- Mobile sync resolves project identity aliases, so a paired phone keeps tracking the right project through hide, unhide, and forget (desktop + iOS).

## [1.2.5] - 2026-06-16

### Added

- On-device voice dictation model now downloads on first use (from Settings → Voice input) instead of being bundled, shrinking the app and every update.
- MCP servers configured for ADE now load in Claude chats, matching the ADE CLI.
- Remote ADE Code: `ade code` can launch a Work chat against a remote machine.

### Changed

- macOS now ships separate Apple Silicon and Intel builds instead of one universal bundle, roughly halving the auto-update download and fixing a case where the larger universal update could crash the macOS updater mid-download.
- The macOS release pipeline builds each architecture in parallel for faster, more reliable releases.

### Fixed

- The "stop the other ADE brain" launch-conflict instructions now work regardless of where the conflicting build is installed, and correctly stop a `launchd`-managed runtime.

## [1.2.4] - 2026-06-15

### Added

- On-device voice dictation in the chat composer on desktop (bundled whisper.cpp base.en) and iOS (on-device SpeechAnalyzer), with an inline recording pill, deterministic cleanup, and a Settings toggle.
- Mobile project actions over sync: add and switch projects from iOS, including remote add-project flows.
- Project icon thumbnails in the mobile project picker, delivered over sync.

### Changed

- Mobile chat surfaces token and context usage, preserves runtime-mode state across sessions, and tightens transcript streaming edge cases.

### Fixed

- Usage panel provider status: correct Claude and Codex logos, provider status warmed before a project opens, and no-project CLI detection aligned with settings.

## [1.2.3] - 2026-06-13

### Fixed

- Restored the packaged GitHub updater feed config in the macOS app bundle so Electron's updater can download and install newer ADE releases.
- Configured the updater feed at runtime as a fallback when the packaged config is missing.
- Added mac release validation that fails if the signed app, updater zip, or mounted DMG is missing `app-update.yml`.

## [1.2.2] - 2026-06-13

### Fixed

- Fixed onboarding lane import so project setup does not leave ADE in an incomplete state.
- Fixed iOS chat send recovery against the desktop runtime.

## [1.2.1] - 2026-06-13

### Fixed

- Fixed the macOS updater install handoff by stopping ADE's packaged background runtime service before Squirrel replaces the app bundle.
- Reduced the mac updater package by removing Linux runtime sidecars from the mac release artifact and pruning non-target native payloads from packaged Darwin apps.
- Added mac artifact validation that fails the release if non-mac runtime files are bundled again.

## [1.2.0] - 2026-06-12

### Added

- Moved ADE desktop onto the machine-runtime release architecture, including packaged runtime payloads for desktop, CLI, `ade code`, remote runtime, and iOS sync traffic.
- Reworked the Work, PRs, Files, Lanes, History, proof, browser, simulator, and mobile sync flows so the current desktop product is reflected end to end.
- Overhauled the Mintlify docs around the product ADE ships today, with simpler setup, lanes, chat, PR, CTO, mobile, provider, and troubleshooting guidance.
- Uploaded the iOS companion as a build-number-only TestFlight update on the existing iOS 1.1.10 marketing version.

### Fixed

- Hardened provider readiness, sync host election, runtime switching, credential handling, GitHub and Linear auth, computer-use permissions, and packaged launch/update paths.
- Tuned large-workload responsiveness across chat history hydration, CLI session launch, PR warm paths, terminal loading, file watching, and SQLite/CRDT sync work.
- Removed public Automations and VM documentation paths so the docs stay focused on ADE's current lanes, agents, PR, CTO, proof, browser, and mobile surfaces.

## [1.1.12] - 2026-05-06

### Added

- Broadened CLI agent support across cursor-agent, Factory Droid, and OpenCode, including model discovery, launch paths, transcript helpers, and tool-logo coverage.
- Added Codex Fast Mode plumbing through the JSON-RPC service-tier surface and the `ade chat` CLI.
- Expanded iOS connection-health presentation, Work session settings, simulator service coverage, and auto-update tests on the existing 1.1.10 TestFlight train.

### Fixed

- Tightened built-in browser UA spoofing, open-panel IPC logging, PTY ADE context env, localhost-link routing, Lanes page state handling, recent-project ordering, lane pack cleanup, and explicit Codex Fast Mode false handling.

## [1.1.11] - 2026-05-04

### Added

- Added the Add Project flow for creating, cloning, and publishing projects from the command palette and top bar.
- Added the built-in browser and resizable Work sidebar, replacing the old right-edge floating panes.
- Added persistent Path-to-Merge automation, richer PR issue rows, and state-aware PR badging across desktop and iOS.

### Fixed

- Hardened browser inspect-state resets, drawer persistence, composer pending-input locking, PR refresh races, paste handling, renderer CSP coverage, iOS simulator helpers, and PTY resume scanning.

## [1.1.10] - 2026-05-02

### Added

- Added shared desktop-to-mobile model catalog responses so iOS model choices come from the desktop catalog.
- Added an `asc`-backed internal TestFlight build path for the iOS companion.

### Fixed

- Improved Cursor SDK model handling, provider status copy, simulator live-view packaging behavior, release artifact checks, and run session title sanitization.

## [1.1.9] - 2026-05-01

### Added

- Added Cursor SDK-backed chat and the next TestFlight build for the iOS companion.

### Fixed

- Strengthened iOS Simulator control, run-tab failure reporting, and desktop-to-mobile sync durability.

## [1.1.8] - 2026-04-30

### Added

- Added the Electron Viewer surface tying app control, sessions, and chat together.
- Added the mobile models registry, including Droid grouping alongside Claude, Codex, and Cursor.

### Changed

- Shipped a broad desktop performance pass across main-process caching, renderer dedupe, IPC bridge cleanup, and lifecycle correctness.

## [1.1.7] - 2026-04-29

### Added

- Added an in-chat iOS Simulator panel with auto-resolving visual stream.
- Added full Factory Droid ACP chat support alongside Claude, Cursor SDK, and Codex.
- Added Windows code-signing and sync parity foundations for the Windows desktop build.
- Added lane branch switching, Live Activity and Lock Screen widget polish on iOS, and on-demand context doc generation in place of legacy context packs.

## [1.1.6] - 2026-04-26

### Added

- Added first-class automation rule targeting with per-action overrides, explicit lane mode, and preset-to-template helpers.
- Added explicit proof owner routing in the ADE CLI.

### Fixed

- Locked host-role sync state to avoid stale on-disk demotions, consolidated orchestrator/CTO/PR tests, and cleaned up stale iOS host keys.

## [1.1.5] - 2026-04-25

### Added

- Added the two-way PTY bridge so iOS can drive a desktop shell.
- Added bulk session select, archive, restore, and markdown export on desktop and iOS.
- Added a one-shot `ade install` shell PATH setup and broader iOS lane/session parity.

### Fixed

- Recovered orphaned OpenCode listener ports, fixed mobile sync project-switch regressions, and corrected release publishing with explicit GitHub repo targeting.

## [1.1.4] - 2026-04-24

### Added

- Added the multi-pass review engine with adjudicated findings, suppressions, tool evidence, inline diff excerpts, and a Learnings tab.
- Added PR convergence rails on desktop and iOS, `/shipLane` orchestration, and session archive improvements.

### Fixed

- Fixed doubled assistant bubbles, reworked scroll anchoring, improved assistant thought collapse, and hardened Windows release validation plus mac/Windows asset expectations.

## [1.1.3] - 2026-04-23

### Added

- Added the automations rewrite, URL-routed rebase and merge surface, parallel multi-model Work sessions, tiled Work panes, and Windows port foundations.
- Added ADE CLI usability from a fresh `gh auth login` without duplicate credential setup.

### Changed

- Polished Files, Lanes, PRs, and Work on iOS and moved the iOS companion to TestFlight build 4.

## [1.1.2] - 2026-04-22

### Fixed

- Fixed chat continuity across project switches, tab closes, and long idle gaps.
- Improved orphan-lane sessions, sync and discovery cleanup, iOS Work timeline stability, privacy pages, and App Store review preparation.

## [1.1.1] - 2026-04-22

### Added

- Prepared the iOS privacy page, web SPA rewrite, and Work transcript polish release.

### Fixed

- Polished the iOS launch surface and root header, including centered iOS app icon handling.

## [1.1.0] - 2026-04-22

### Added

- Added Tailscale-based multi-device sync, dual-path iOS pairing, saved host routing, and a clearer sync status surface.
- Added the onboarding tutorial system, simplified computer-use proof flow, Manage Lane dialog, iOS redesign, and updated README/architecture docs.

### Fixed

- Restored plaintext WebSocket trust boundaries, cleaned up provider permission merging, automation lane targeting, and rebase/review suggestion state.

## [1.0.19] - 2026-04-21

### Added

- Added external MCP OAuth, auto-rebase suggestions, PR issue resolver, smart tooltips, and the diagnostics dashboard.
- Added legacy Cursor integration and OpenCode runtime integration for managed AI backends.

## [1.0.18] - 2026-04-14

### Changed

- Consolidated Lanes, Runs, and Run surfaces into fewer, denser screens.
- Replaced the dedicated Project Home with the Run page, added Quick Run and stacked-run tabs, and moved per-turn file diffs into the chat transcript.
- Batched renderer user-preference persistence and paused the event-loop watchdog while hidden.

### Fixed

- Tightened PTY service lifecycle, process registry behavior, agent chat service organization, CTO operator tools, OAuth redirect handling, and test stability.

## [1.0.17] - 2026-04-11

### Fixed

- Reduced Work tab mount thrash, improved pane coordination, added cached renderer discovery for AI/model/project config state, and tightened file, git, main/preload, and error-boundary behavior.

## [1.0.16] - 2026-04-11

### Added

- Added OpenAI responses-based verification, scoped OpenCode tool selection, isolated OpenCode server launches, ADE CLI schema sanitization, and provider verification badges.

### Fixed

- Improved OpenAI auth error classification, refreshed OpenCode tool selection before prompts, surfaced OpenCode runtime status in Settings, and fixed OpenCode key merging.

## [1.0.15] - 2026-04-10

### Added

- Added terminal session management overhaul, terminal preferences, ADE CLI standalone chat, PR tab unification with auto bot detection, and sync host resilience.

### Fixed

- Improved file watcher behavior, PTY reattach and transcript resume, and session lifecycle reliability.

## [1.0.14] - 2026-04-09

### Added

- Added a feedback reporter with diagnostics collection and ADE CLI server improvements.

### Fixed

- Polished chat UX and hardened OpenCode runtime behavior after the 1.0.13 architecture overhaul.

## [1.0.13] - 2026-04-07

### Added

- Added direct OpenCode server integration, dynamic model discovery, local provider probing, provider task routing, CLI MCP config normalization, and expanded universal-tool tests.

### Changed

- Replaced the Vercel AI SDK unified executor with the OpenCode runtime for non-CLI providers.

### Removed

- Removed Vercel AI SDK packages and the deleted unified executor/provider resolver stack.

## [1.0.12] - 2026-04-02

### Added

- Added the next round of release, desktop, and runtime refinements from the site changelog.

### Fixed

- Improved desktop reliability and test coverage after the 1.0.11 release train.

## [1.0.11] - 2026-04-01

### Added

- Added Cursor as a first-class chat provider, cross-platform CLI executable resolution, and a large agent chat service expansion.

### Changed

- Shipped the largest release to date with 102 commits across 12 merged PRs.

## [1.0.10] - 2026-03-30

### Changed

- Shipped the 1.0.10 release after skipping 1.0.9.

### Fixed

- Folded in follow-up desktop and release fixes from the site changelog.

## [1.0.8] - 2026-03-26

### Added

- Added follow-up app, runtime, and docs improvements from the site changelog.

### Fixed

- Continued early release stabilization across desktop, sync, and tests.

## [1.0.7] - 2026-03-25

### Added

- Added early post-launch desktop and runtime improvements from the site changelog.

### Fixed

- Continued fixing release-train issues found after the initial public launch.

## [1.0.6] - 2026-03-24

### Fixed

- Incorporated all changes from unpublished v1.0.5 and fixed the macOS build path.

## [1.0.5] - 2026-03-24

### Fixed

- Improved lane rebase targeting, PR merge status, cleanup behavior, runtime packaging, MCP binary launch, fallback refs, validation, accessibility, and toast UX.

## [1.0.4] - 2026-03-24

### Added

- Added early Codex, chat, and desktop refinements from the site changelog.

### Fixed

- Fixed text batching across Codex service and renderer paths.

## [1.0.3] - 2026-03-22

### Added

- Added early launch follow-ups from the site changelog.

### Fixed

- Improved first-week desktop and documentation stability.

## [1.0.2] - 2026-03-15

### Added

- Added provider health pipeline, CTO identity presets, budget cap editor, local provider discovery tests, and expanded getting-started coverage.

### Changed

- Reworked the website, README, docs, Claude runtime probe caching, Linear OAuth defaults, orchestrator tuning, and CI permissions.

### Removed

- Removed deprecated automation, preview/test, onboarding, settings, and legacy infra surfaces.

## [1.0.1] - 2026-03-14

### Added

- Added multimodal chat attachments, CTO daily logs, ADE CLI auth service, settings sections, context doc preferences, release workflow, CODEOWNERS, run network panel, computer-use panel, docs proxy, and onboarding rewrite.

### Changed

- Improved chat composer file handling, Linear OAuth, orchestrator retention, main-process background flags, CI setup, and homepage/docs copy.

### Removed

- Removed deprecated terminal settings, docs modal, legacy onboarding, and infra packages.

## [1.0.0] - 2026-03-13

### Added

- Initial public release.

[Unreleased]: https://github.com/arul28/ADE/compare/v1.2.5...HEAD
[1.2.6]: https://github.com/arul28/ADE/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/arul28/ADE/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/arul28/ADE/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/arul28/ADE/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/arul28/ADE/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/arul28/ADE/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/arul28/ADE/compare/v1.1.12...v1.2.0
[1.1.12]: https://github.com/arul28/ADE/compare/v1.1.11...v1.1.12
[1.1.11]: https://github.com/arul28/ADE/compare/v1.1.10...v1.1.11
[1.1.10]: https://github.com/arul28/ADE/compare/v1.1.9...v1.1.10
[1.1.9]: https://github.com/arul28/ADE/compare/v1.1.8...v1.1.9
[1.1.8]: https://github.com/arul28/ADE/compare/v1.1.7...v1.1.8
[1.1.7]: https://github.com/arul28/ADE/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/arul28/ADE/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/arul28/ADE/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/arul28/ADE/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/arul28/ADE/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/arul28/ADE/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/arul28/ADE/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/arul28/ADE/compare/v1.0.19...v1.1.0
[1.0.19]: https://github.com/arul28/ADE/compare/v1.0.18...v1.0.19
[1.0.18]: https://github.com/arul28/ADE/compare/v1.0.17...v1.0.18
[1.0.17]: https://github.com/arul28/ADE/compare/v1.0.16...v1.0.17
[1.0.16]: https://github.com/arul28/ADE/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/arul28/ADE/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/arul28/ADE/compare/v1.0.13...v1.0.14
[1.0.13]: https://github.com/arul28/ADE/compare/v1.0.12...v1.0.13
[1.0.12]: https://github.com/arul28/ADE/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/arul28/ADE/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/arul28/ADE/compare/v1.0.8...v1.0.10
[1.0.8]: https://github.com/arul28/ADE/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/arul28/ADE/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/arul28/ADE/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/arul28/ADE/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/arul28/ADE/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/arul28/ADE/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/arul28/ADE/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/arul28/ADE/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/arul28/ADE/releases/tag/v1.0.0
