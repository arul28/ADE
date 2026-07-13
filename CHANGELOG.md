# Changelog

All notable changes to ADE will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.24] - 2026-07-13

### Added

- Settings → Storage dashboard showing ADE-owned data by category, including leftover data from archived and deleted lanes, with preview-and-confirm cleanup.
- A quiet top-bar storage indicator that warns before storage gets tight and pauses new agent work only at critical capacity.
- A full-screen, plain-language project-open recovery flow with one-click repair.
- Lossless background compression of old, inactive chat and terminal history (still searchable and openable).

### Changed

- Redesigned chat handoff with a two-card menu, per-runtime forking, and cross-machine fork transport.
- Polished the CTO experience across desktop and iOS.

### Fixed

- A full disk during a database save can no longer leave a project that refuses to open; migrations are crash-safe and self-heal on the next launch.
- Chat metadata and provider thread pointers are written atomically, so an interrupted save can no longer lose a chat's history.
- A provider session that cannot be resumed no longer silently starts a blank thread; the chat keeps its transcript and offers explicit recovery actions.
- Made chat recovery steadier and bounded Codex usage scans so they no longer spike memory.

## [1.2.23] - 2026-07-12

### Changed

- Kept context usage accurate after compaction across desktop, ADE Code, and iOS.
- Strengthened Claude SDK turn lifecycle and steering for active turns, scheduled work, and subagent activity.
- Preferred independently installed Git over Apple's license-gated Git on macOS, including login-shell discovery.

### Fixed

- Moved project-transition failures from a truncated top-bar pill to a full-width, wrapping, dismissible alert.
- Explained that Apple's Xcode license prompt comes from the Git executable rather than ADE's iOS Simulator or code-signing features.
- Preserved complete remote project-add errors on iOS instead of limiting danger messages to three lines.

## [1.2.22] - 2026-07-11

### Changed

- ADE's Claude Agent SDK chats now behave like Claude Code, with correct subagent counts and no chats stopping at turn boundaries.
- Brought the iOS Work composer to parity with desktop typed-trigger behavior.

### Fixed

- Removed a leaked duplicate `claude --resume` background process from ADE Claude chats.
- Stopped a stale-credentials token-refresh storm that could rate-limit the Claude usage endpoint.
- Fixed chat keyboard dismissal on iOS.

## [1.2.21] - 2026-07-10

### Changed

- Redesigned the Stats activity module and aligned the iOS Work activity carousel with the expanded usage model.
- Kept desktop IPC, ADE CLI sync, and iOS remote models in parity for activity data.

### Fixed

- Fixed usage activity history and lifetime totals across refreshes, restarts, and paired machines.
- Added end-to-end and cross-client regression coverage for the corrected usage accounting.

## [1.2.20] - 2026-07-10

### Added

- Cross-machine session handoff to move an active session between paired machines.
- Machine-level Chats tab with a redesigned projectless-chat flow.
- Per-source Automations delivery warnings, an actionable trust banner, and per-source brand identity.
- Mobile chat UI overhaul: staged send, question cards, and artifact cards, plus an iOS usage/activity carousel.
- GPT-5.6 Max reasoning across ADE.

### Changed

- Claude chat: scalable actions pane, copy-turn, full-fidelity transcript view, and chat tags.
- Desktop auto-update now surfaces disk-space failures and recovery steps.
- Files tab is always editable; removed view-only mode.

### Fixed

- Fixed Claude chat end-chat teardown and added SessionStore self-heal.
- Made usage refresh reliable and lifetime totals accurate across clients.
- Fixed remote workspace-id staleness that could strand paired machines.
- Restored copying from macOS CLI terminals.
- Fixed Linear batch launch readiness and blank chats.
- Made Codex app-server failures recover automatically.

## [1.2.19] - 2026-07-10

### Added

- Remote sync between paired desktops so lanes, chats, and actions stay in step across machines.
- Automations engine with Linear/GitHub webhook ingress, a lane lifecycle engine, production unlock, and a rebuilt Automations tab.
- Projectless personal chats across desktop, CLI, and iOS.
- GPT-5.6 model family and Codex 0.144 support across chat, CLI, and background AI.
- Cross-client ADE stats and activity charts, including an iOS usage/activity carousel.

### Changed

- Overhauled the Claude chat lifecycle: two-row subagent transcripts, honest schedule reporting, durable wakeups that survive restarts, and refined iOS Work chat composer/timeline/message surfaces.
- Simplified and centered the post-update modal.

### Fixed

- Fixed a chat streaming text-splice bug in the Claude chat lifecycle.
- Fixed imported CLI sessions resolving to the Primary project.
- Rescued web-client pairing and marketing surfaces.

## [1.2.18] - 2026-07-09

### Changed

- Carried forward the per-architecture macOS release workflow, chat launch-control polish, terminal file-change review improvements, and redesigned iOS Work model picker from v1.2.17.

### Fixed

- Fixed per-architecture macOS packaging by allowing the after-pack hook to keep the runner-built `cpu-features` native addon when universal staging inputs are absent.

## [1.2.17] - 2026-07-09

### Changed

- Restored the macOS desktop release path to per-architecture arm64 and x64 updater assets instead of universal updater ZIPs.
- Improved chat permission mode and reasoning effort controls across desktop launch surfaces, PR resolver launch controls, native launch helpers, and mobile-facing action summaries.
- Redesigned the iOS Work model picker with clearer provider, permission, and reasoning-effort affordances.

### Fixed

- Improved terminal-driven file-change review so the primary action and supporting state are clearer across desktop and ADE Code.
- Improved provider sign-in recovery from Claude/model empty states and settings flows.

## [1.2.16] - 2026-07-08

### Changed

- Improved chat peer-message normalization, handoff notes, Codex goal state, and subagent activity parity across desktop, ADE Code, and mobile.
- Improved session stale, stopped, waiting, and running state handling across desktop and iOS Work surfaces.
- Improved iOS Work and Linear flows with refreshed mobile-created sessions, restored start-chat keyboard focus, and more reliable Linear backlog loading.

### Fixed

- Fixed packaged desktop Cursor SDK worker startup by resolving the worker through the packaged Node path and seeding/signing/permitting/pruning arch-specific native payloads for universal macOS packaging, including native addons, runtime archives, and install-time shims.
- Fixed relay-backed chat streaming backpressure so busy remote sessions are less likely to drop or stall output.
- Kept App Clip release metadata and deployment settings aligned for App Store validation.

## [1.2.15] - 2026-07-08

### Added

- Added the local-first ADE release skill, covering no-op detection, independent desktop and iOS release scope, patch-only desktop bumps, build-number-only TestFlight updates, artifact verification, and recovery rules.
- Added mobile Work chat image attachments, including attachment trays, kickoff payload support, sync-backed canonical state, and regression coverage.

### Changed

- Improved iOS relay fallback when Tailscale is unavailable, with stronger remote-model decoding and relay-backed connection tests.
- Improved mobile composer and dictation controls with safer text traits for agent prompts and clearer dictation startup/recording state.

### Fixed

- Fixed hidden configured pairing PIN state across desktop Settings, `ade sync web`, and iOS web-client pairing surfaces.
- Fixed release runtime archive validation and universal macOS packaging inputs so packaging checks expected per-architecture runtime paths and includes the Claude SDK x64 sidecar.

## [1.2.14] - 2026-07-08

### Added

- Added ADE Web pairing and remote browser access for Work, Lanes, Files, and PRs, including `ade sync web`, Settings controls, machine/project selection, and DPoP-backed pairing.
- Added Claude wake, cron, background-stream, scheduled-work, and retraction activity across desktop, ADE Code, and mobile.
- Added the ADE brain self-update foundation and documented App Clip provisioning for release operations.
- Added mobile Linear launch flow, a mobile Shell launcher, and App Clip QR pairing with handoff to the full app.

### Changed

- Improved Codex app-server and Cursor SDK reliability with newer recovery, safety, web-search, subagent, handoff, usage, structured-error, resume-state, and transcript-grouping support.
- Improved context compaction and transcript rendering with shared lifecycle helpers, event merging by compaction ID, desktop/TUI/iOS parity, and clearer activity rows.
- Improved search, deeplinks, lane snapshot invalidation, PR freshness, CLI status in Live Activity, attention capsules, and lane PR badges.
- Improved push and relay operations with per-IP rate limits, daily spend caps, structured logs, clearer notifications, relay-everywhere polish, and fewer toggles.
- Improved mobile PR details with richer overview/activity surfaces, merge/check/review state, markdown handling, widget updates, and repeat-alert protection.
- Kept the current mobile marketing version for a build-number-only iOS TestFlight update.

### Fixed

- Fixed web-client project entry, Files results, terminal live streaming, GitHub status refresh, shell chrome, and pairing-screen routing edge cases.
- Fixed Cursor SDK resume-state recovery, SDK error surfacing, mobile approval consolidation, and CLI Node requirement alignment.
- Fixed release workflow packaging expectations for per-arch macOS builds and local App Clip signing guidance.

## [1.2.13] - 2026-07-06

### Added

- Added mobile push notifications, Live Activities, APNs-backed delivery, deployed push/tunnel relay workers, per-device notification preferences, and optional cloud relay fallback.
- Added smart universal-link pairing QR payloads, Secure Enclave DPoP proofs for paired hellos, fail-closed sync ingress controls, and an offline outbox for queued mobile chat creation.
- Added cursor-relative slash command and `@file` composer chips across desktop, ADE Code, and iOS.
- Added Claude Workflow progress rows, CLI-spawned child-chat lineage, "Subagent spawned" transcript notices, and strict Mosaic v1 interactive cards for Claude-family chats.

### Changed

- Reworked CTO into one persistent-memory agent thread across desktop and iOS, with file-backed memory, daily journals, model-switch preservation, memory tools, and a simpler setup/settings flow.
- Improved ADE Code and CLI reliability with per-provider Chat/CLI mode, provider-neutral tracked CLI sessions, faster TUI rendering, safer JSON-RPC/event-buffer handling, closed-session browsing, `/secrets`, and remote sync hardening.
- Improved mobile PR details with virtualized timeline rows, desktop-style merge requirements, metadata cards, freshness reloads, and Work-row "Open in PRs tab" routing.
- Improved mobile connection, Work list, lane creation, and terminal behavior, including Tailscale-off warnings, attributed pairing revocation, bounded port probes, standalone CLI rows, remote-first lane bases, background AI lane naming, and live-tail terminal pinning.
- Improved the landing page with lighter animations, cheaper showcase transitions, and bounded media loading.
- Kept the current mobile marketing version for a build-number-only iOS TestFlight update.

### Removed

- Removed the legacy CTO worker/hiring subsystem, Linear workflow engine, pipeline builder, Team/Workflows surfaces, and dead CTO/flow CLI paths.

### Fixed

- Fixed stale quick-open cache races, partially-built quick-open index reads, unmatched composer-token dead keys, iOS suggestion cache drift, and iOS TextKit retention during composer chip usage.
- Fixed sync-host startup loops after transient cross-channel conflicts, queue handling for `host_unavailable`, old failed CLI sessions pinning hub attention, and terminal live-tail drift after keyboard or font layout changes.

## [1.2.12] - 2026-07-03

### Added

- Added cross-project chat quick-look: open a lane's chat transcript from the hub (desktop and iOS) without switching projects, streamed read-only from the brain without booting the foreign runtime, capability-gated and fail-closed on older brains.
- Added Work-tab lane creation in place with a redesigned create-lane modal and lane action toasts.
- Added repo-gated webhook-secret heal and delivery-log routes to the GitHub webhook relay to recover from webhook secret drift.

### Changed

- Improved GitHub PR freshness in installed builds: daemon-owned PR polling now starts at project startup so Work, Lanes, and PRs refresh without opening the PR tab first, and the GitHub relay is polled every 30s instead of 60s.
- Improved the mobile hub and chat surfaces with an inline keyboard composer, hydration-gated chat open, and redesigned question/approval/plan cards with hardened chat-event decoding.
- Improved Lanes tab performance via conditional CRR upserts for no-op lane-state snapshots, conditional (ifNoneMatch/notModified) lane list/detail responses with presence stamping, and per-lane detail invalidation.
- Improved GitHub App authorization status UX and restyled the post-update restart card to point release notes at the docs changelog route.
- Kept the current mobile marketing version for a build-number-only iOS TestFlight update.

### Fixed

- Fixed terminal ADE PR state (merged/closed) being overridden by a stale open GitHub snapshot in desktop and iOS lane PR chips.

## [1.2.11] - 2026-07-02

### Added

- Added `ade new chat --mode chat|cli` as the unified command for persistent Work chats and tracked provider CLI sessions, including auto-created lanes, provider/model/reasoning controls, fast-mode selection, dry-run previews, and prompt kickoff.
- Added GitHub App device-flow auth, repository permission gates, durable repository/event storage, and relay tests for webhook-backed PR sync.

### Changed

- Improved Work and chat launch reliability across start-chat-in-lane, tracked CLI naming, chat PR live refresh, Claude logout recovery, compact Claude hook errors, Codex continuation recovery, and no-op prompt handling.
- Improved Files, onboarding, browser, project secrets, and web download surfaces, including multi-lane editor tabs, removed edit-trust friction, clamped context menus, welcome-card polish, and mobile TestFlight links.
- Improved iOS Work, Hub, PR, Files, CTO, Settings, and sync flows while keeping the current mobile marketing version for a build-number-only TestFlight update.

### Removed

- Removed the old edit-trust gate from the Files workflow.

### Fixed

- Fixed mobile sync control on remote projects, iPhone handoff recovery, chunk assembly, roster hydration, and phone-started CLI session launch parity for fast-mode and reasoning settings.

## [1.2.10] - 2026-06-28

### Added

- One-time "Welcome to ADE" video gate with Help menu replay, tab tooltips, expanded Did you know hints, and updated first-run docs.

### Changed

- Upgraded ADE Code terminal rendering and tightened TUI input, approval prompts, palettes, polling, Codex initial prompt handling, PTY reads, and shell-session startup behavior.
- Improved auto-lane chat recovery, pinned project-config cache keys, stale launch UI guards, running-work notifications, and Claude auth recovery prompts.
- Improved Files workbench/editor state, search-result collapse behavior, dirty-buffer handling, recent-file tracking, and remote file event cursor updates.

### Removed

- Removed guided tour, wizard, tutorial UI, and the old tour IPC/preload/service contract in favor of passive help surfaces.

### Fixed

- Fixed iOS sync freezes during mobile actions and preserved running chat badge counts in the mobile Work flow.
- Fixed release-doc validation so the next changelog page can pass CI before its tag exists.

## [1.2.9] - 2026-06-23

### Added

- Claude chat: upgraded Agent SDK integration with long-lived and background chat timeout handling and new chat surfaces, plus a dedicated Claude login prompt that recovers stale auth in one click.
- Orchestration delegation lineage: lead↔worker and lead↔validator spawns and results are recorded as first-class manifest state — who spawned whom, with what brief and resolved model, and what came back.

### Changed

- Instant lane and chat/CLI naming: sessions get a deterministic name immediately and are upgraded to an AI name in the background, removing the 10-second race that left many stuck on the fallback name; deterministic names now strip URLs and markdown.
- Codex full-auto permission switching is fixed and hardened: queued approvals are guarded by lane path, grants are validated before they apply, and project-root permission paths resolve safely.
- Remote project tabs show the real project icon and the correct yellow machine accent instead of a blank folder glyph.
- Settings General tab reorganized: GitHub, Linear, voice input, launch prompts, completion sound, PR transcripts, project files, and environment are consolidated under branded section headers and the separate Integrations tab is removed; background-job reasoning effort is now independent, with refreshed web-renderer UX.
- Faster mobile realtime sync, including changeset-ack backpressure handling so a busy stream stays responsive.

### Fixed

- Stale lane worktree cleanup is recorded and safely retried after a delete; Files tree refreshes on external directory changes, with better external opening and previews; remote ADE Code clipboard paste; the ADE deeplink footer logo; and mobile notification, widget, and PR-navigation fixes.

## [1.2.8] - 2026-06-19

### Added

- PR merge and timeline at GitHub parity across desktop and iOS: authoritative merge-state status, a merge dialog with selectable method and editable commit message, admin bypass, update-branch, and a unified commits/reviews/checks timeline.
- Deterministic orchestration planning: an explicit planning → approval → developing state machine with structured plan specs, a real readiness gate, a structured validation-findings table, and crash-resume.
- Mobile: unified Files search, project-picker icons, a Work-tab PR status indicator, and a composer that remembers your last-used model and mode.

### Changed

- Sync host hardening: inbound peer changesets are bounded so one oversized batch can't lock the database, cluster/brain ownership is host-authoritative so a paired peer can't seize it, and socket trust plus runtime-event availability are tightened.
- iOS data layer is serialized through a single queue, eliminating apply-versus-main-actor data races and transaction interleaving.
- Unified the project recents explorer and refined pending-input cards across chat surfaces.

### Fixed

- Security/correctness sweep: forgeable validator gate, bypassable plan-approval gate, credential-store wipe on OS-key rotation, non-atomic config writes, git commit-SHA option injection, and `/open` deeplink SSRF (now origin-pinned with a fetch timeout).
- Sync gzip cap and Intel (x64) cr-sqlite packaging; iOS terminal/transcript renderer clamps hostile escape sequences so agent output can't exhaust memory.
- Lost auto-create lane / background launch on project switch, macOS traffic-light overlap when zoomed out, remote image-paste attachment routing, chat mic refreshing live after a voice-model download, ADE browser downloads and overlay layering, external-link opening in remote PR surfaces, and mobile reconnect-cancel handling.

## [1.2.7] - 2026-06-16

### Added

- ADE Code: multi-question approvals in the terminal — arrow keys choose an option and move between questions, number keys pick and submit — replacing the old single-question quick-select.
- Mobile: auto-created lanes are now named from your prompt by the host's small AI model (Chat and CLI), with a deterministic fallback if the model is offline or times out.
- iOS: the new-chat composer now matches an in-session thread (single permission dropdown when space is tight, model pill, fast-mode toggle), with fast mode honored on create.

### Changed

- ADE Code: selecting a lane no longer reflows the drawer — single-line lane cards, a shared chat row, and reserved viewport rows kill the flicker; provider glyphs and colors now match the model picker, and grid navigation escapes cleanly with Tab.
- iOS: faster Work chat scrolling, with assistant previews cached for visible rows and deferred until after the stream merges.
- Stored chat transcripts are compacted while preserving durable replay and live output.

### Removed

- macOS VM runtime, UI, and `ade vm` CLI commands.
- Mobile push notifications; the app now relies on its live sync connection, and PR actions from widgets navigate in-app.

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

[Unreleased]: https://github.com/arul28/ADE/compare/v1.2.24...HEAD
[1.2.24]: https://github.com/arul28/ADE/compare/v1.2.23...v1.2.24
[1.2.23]: https://github.com/arul28/ADE/compare/v1.2.22...v1.2.23
[1.2.22]: https://github.com/arul28/ADE/compare/v1.2.21...v1.2.22
[1.2.21]: https://github.com/arul28/ADE/compare/v1.2.20...v1.2.21
[1.2.20]: https://github.com/arul28/ADE/compare/v1.2.19...v1.2.20
[1.2.19]: https://github.com/arul28/ADE/compare/v1.2.18...v1.2.19
[1.2.18]: https://github.com/arul28/ADE/compare/v1.2.17...v1.2.18
[1.2.17]: https://github.com/arul28/ADE/compare/v1.2.16...v1.2.17
[1.2.16]: https://github.com/arul28/ADE/compare/v1.2.15...v1.2.16
[1.2.15]: https://github.com/arul28/ADE/compare/v1.2.14...v1.2.15
[1.2.14]: https://github.com/arul28/ADE/compare/v1.2.13...v1.2.14
[1.2.13]: https://github.com/arul28/ADE/compare/v1.2.12...v1.2.13
[1.2.12]: https://github.com/arul28/ADE/compare/v1.2.11...v1.2.12
[1.2.11]: https://github.com/arul28/ADE/compare/v1.2.10...v1.2.11
[1.2.10]: https://github.com/arul28/ADE/compare/v1.2.9...v1.2.10
[1.2.9]: https://github.com/arul28/ADE/compare/v1.2.8...v1.2.9
[1.2.8]: https://github.com/arul28/ADE/compare/v1.2.7...v1.2.8
[1.2.7]: https://github.com/arul28/ADE/compare/v1.2.6...v1.2.7
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
