# Onboarding and Settings

Two related but distinct flows:

- **Onboarding** — the fastest path to a usable installation and a usable
  project. Covers installing the per-machine ADE runtime daemon as a login
  service, putting `ade` on `PATH`, registering the project with the runtime
  so every client (desktop, `ade code`, iOS) sees it, then detecting dev tools
  and stack signals, suggesting a project config, optionally importing
  existing git branches as lanes, and walking the user through AI providers,
  GitHub, and optional integrations.
- **Settings** — long-lived configuration organized by tab. Persists
  to `.ade/ade.yaml` (shared) and `.ade/local.yaml` (local) through
  `projectConfigService`.

The runtime no longer assumes first-run setup must hydrate every
service. Project open favors a cheap first pass; secondary hydration
(full lane status, provider modes, semantic indexing) happens after
the app is interactive.

## Where state lives

ADE state is split between the per-machine runtime root and per-project
directories. Onboarding writes to both.

| Scope | Location | Owner | Contents |
|---|---|---|---|
| Machine | `~/.ade/` (`ADE_HOME` overrides; channel builds use `~/.ade-alpha/` / `~/.ade-beta/`) | `ade serve` runtime daemon | Runtime socket (`sock/ade.sock`), project registry (`projects.json`), encrypted credential store (`secrets/`), bundled binary (`bin/ade`), native runtime deps (`runtime/<arch>/`), service log files. |
| Project (shared) | `<project>/.ade/ade.yaml` | `projectConfigService` | Version-controlled team config: processes, stacks, tests, automations, lane templates, AI mode, providers, Linear sync. |
| Project (local) | `<project>/.ade/local.yaml` | `projectConfigService` | Per-user, gitignored: ports, env vars, local-only processes. |
| Project (data) | `<project>/.ade/` | various services | Lanes, attachments, kvDb, generated assets. The shared `.ade/.gitignore` whitelists only authored files. |

The runtime daemon is the seam that ties machine and project scope
together: it owns `~/.ade/projects.json`, lazily builds an `AdeRuntime`
per project root on first project-scoped JSON-RPC call, and is the
single host through which desktop, `ade code`, and SSH-attached
desktops see live lanes / chats / processes.

## Source file map

Main process:

- `apps/desktop/src/main/services/onboarding/onboardingService.ts` —
  status, stack detection, suggested config, existing lane detection,
  and tour progress tracking. `OnboardingTourProgress` carries the
  legacy flat per-tour map (`tours: Record<string, OnboardingTourEntry>`)
  plus a new variant-aware `tourVariants: Record<string,
  OnboardingTourEntryV2>` keyed by base tour id with a `full` +
  `highlights` pair. A separate `tutorial: OnboardingTutorialState`
  slab tracks the 13-act first-session tutorial
  (`completedAt`/`dismissedAt`/`silenced`/`inProgress`/`lastActIndex`/
  `ctxSnapshot`). Glossary terms seen are tracked in
  `glossaryTermsSeen[]`. Persisted to `kvDb` under
  `onboarding:tourProgress`.
- `apps/desktop/src/main/services/config/projectConfigService.ts` —
  YAML config read/merge/save, AI mode migration, lane env init,
  Linear sync resolver. ~2,870 lines, the largest service.
- `apps/desktop/src/main/services/config/laneOverlayMatcher.ts` —
  matches lanes against `LaneOverlayPolicy[]` to produce the effective
  overlay.

Shared types and IPC:

- `apps/desktop/src/shared/types/config.ts` — central type module for
  the configuration schema (processes, stacks, tests, overlays, lane
  templates, port allocation, proxy, OAuth, integrations, AI).
- `apps/desktop/src/shared/ipc.ts` — channels:
  - `ade.onboarding.*` (status, detectDefaults, detectExistingLanes,
    applySuggestedConfig, complete, setDismissed)
  - `ade.projectConfig.*` (get, validate, save, diffAgainstDisk,
    confirmTrust, export)
  - `ade.project.*` (listRecent, openRepo, switchProjectToPath)
  - `ade.ai.*` and settings-specific channels per integration
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — handler
  registrations.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.onboarding`,
  `window.ade.projectConfig`, `window.ade.project`, plus the
  integration-specific surfaces (`window.ade.github`, etc.).

Renderer — onboarding:

- `apps/desktop/src/renderer/components/onboarding/ProjectSetupPage.tsx`
  — the project setup wizard used during first-run and on the manual
  "re-run setup" flow. ~610 lines.
- `apps/desktop/src/renderer/components/onboarding/DevToolsSection.tsx`
  — dev tool detection (git, gh).
- `apps/desktop/src/renderer/components/onboarding/EmbeddingsSection.tsx`
  — local embedding model setup.
- `apps/desktop/src/renderer/components/onboarding/OnboardingBootstrap.tsx`
  — top-level orchestrator: mounts the `TourHost`, auto-fires per-tab
  tours on route change, renders `DidYouKnow`, and pops the
  `TutorialPromptCard` when the first-session tutorial is available.
  `DidYouKnow` suppresses itself whenever `activeTourId` is set in the
  onboarding store, so a live tour never competes with a "did you know"
  tooltip. `SmartTooltip` applies the same gate — tooltips silently
  return a null wrapper while a tour is active so the tour's own
  spotlight is the only floating UI.
- `apps/desktop/src/renderer/components/onboarding/TutorialPromptCard.tsx`
  — Start / Not now / Don't show again gate for the 13-act tutorial.
- `apps/desktop/src/renderer/components/onboarding/HelpMenu.tsx`
  — persistent help menu in the top bar: tour replay, glossary, docs
  links, restart tutorial.
- `apps/desktop/src/renderer/components/onboarding/tour/TourHost.tsx`,
  `TourOverlay.tsx`, `TourStep.tsx` — rendered overlay and per-step card.
  `TourHost` intentionally does not gate on the `onboardingEnabled`
  preference: the preference hides passive onboarding surfaces
  (`DidYouKnow`, tour auto-start hooks), but a tour the user explicitly
  starts from the Help menu must still render even when ambient
  onboarding is off — otherwise the menu would silently change routes
  without showing any guidance. `TourOverlay` applies a short
  (350 ms) grace period after a step mounts before
  `exitOnOutsideInteraction` takes effect, so the click that launched
  the current step cannot also dismiss it.
- `apps/desktop/src/renderer/components/onboarding/fx/*` — motion-FX
  primitives (`ActIntro`, `AnimatedField`, `Confetti`, `GhostCursor`,
  `MorphingTree`, `Spotlight`, `StaggeredText`, `TourIllustration`)
  plus a `useReducedMotion` hook. Used by the tutorial and per-tab tours.
- `apps/desktop/src/renderer/onboarding/TourController.ts` — imperative
  driver (advance/skip/complete/dismiss); source of truth for the
  Zustand `onboardingStore`.
- `apps/desktop/src/renderer/onboarding/waitForTarget.ts` — polls for a
  DOM target (ref or `data-onboarding-target`) with a visibility check
  so tour steps anchor reliably to async-mounted elements.
- `apps/desktop/src/renderer/onboarding/docsLinks.ts` — typed registry
  of internal/public doc URLs that tour steps and `HelpMenu` link to.
- `apps/desktop/src/renderer/onboarding/registry.ts` — tour registry.
- `apps/desktop/src/renderer/onboarding/tourGuards.ts` — per-step guard
  predicates (route, selection, and element-presence checks) that decide
  whether a step can advance, skip, or must pause for the user.
- `apps/desktop/src/renderer/onboarding/stepBuilders/*.ts` — factories
  for per-dialog tour steps (`createLaneDialog`, `manageLaneDialog`,
  `prCreateModal`); kept separate from the per-surface tour files so
  dialog-scoped steps can be composed from multiple tours.
- `apps/desktop/src/renderer/onboarding/tours/*.ts` — per-surface tours:
  `lanesTour`, `laneWorkPaneTour`, `workTour`, `filesTour`,
  `runTour`, `missionsTour`, `prsTour`, `graphTour`, `historyTour`,
  `automationsTour`, `ctoTour`, `settingsTour`, plus the first-session
  `firstJourneyTour`. The first-session tour reuses individual steps
  from the per-surface tours via a small `tutorialSection(sectionId,
  steps, requires)` wrapper that namespaces step ids
  (`<sectionId>.<index>`), forces a `requires` gate, derives
  `waitForSelector` from `target`, and — for any step that has a
  `requires` gate without its own `fallbackAfterMs` — injects a
  default 30 s `Skip` fallback so the tutorial can never get
  permanently stuck waiting on state that doesn't appear. The acts
  themselves are intentionally streamlined: act 1 only borrows the
  base-branch / status-chip / lane-work-pane bits (since the user has
  just created a lane interactively); acts 2 + 3 inline ctx-aware
  graph/files steps directly rather than spreading the full sub-tour;
  the per-act "tab handoff" reminder steps were collapsed into the
  single act 12 finale.
- `apps/desktop/src/renderer/components/cto/...` — CTO first-run is a
  separate lightweight wizard covering identity, project context, and
  optional Linear (see `apps/desktop/src/renderer/components/cto/`).

Renderer — settings:

- `apps/desktop/src/renderer/components/app/SettingsPage.tsx` — tab
  container. The current top-level sections are General, Appearance,
  Workspace, AI, Mobile Push, Integrations, Memory, Lane Templates,
  and Usage. Onboarding / Help / Tours route deep links land in
  General (`TAB_ALIASES`); tutorial replay and tour entry points live
  under the Help menu in the top bar, not as a Settings tab. The
  legacy `OnboardingSection` was removed — its surface lives in the
  top-bar Help menu and the onboarding store.
- `apps/desktop/src/renderer/components/settings/GeneralSection.tsx`
  — AI mode, task routing, terminal preferences, keybindings link,
  and the embedded `AdeCliSection` (compact form) so the most common
  terminal-CLI install/repair affordance lives next to the other
  day-one settings without forcing a tab switch into Integrations.
  Visual chat / theme controls now live in the dedicated Appearance
  tab (`AppearanceSection.tsx`).
- `apps/desktop/src/renderer/components/settings/AdeCliSection.tsx`
  — surfaces `window.ade.adeCli.getStatus()` / `installForUser()`.
  Status carries `terminalInstalled`, `agentPathReady`,
  `bundledAvailable`, and the resolved `installTargetPath` for the
  bundled `ade` binary. In compact form (used by `GeneralSection` and
  the onboarding `DevToolsSection`) it shows the current install
  path, an Install / Repair button that runs the platform
  install-path helper, and an "Add to PATH" hint when the install
  target isn't on the user's `$PATH`. Agents launched by ADE always
  get the bundled CLI automatically; this surface is what makes
  `ade` available to the user's own terminals.
- `apps/desktop/src/renderer/components/settings/WorkspaceSettingsSection.tsx`
  + `ProjectSection.tsx` — project identity, base ref, paths.
- `apps/desktop/src/renderer/components/settings/AiSettingsSection.tsx`
  / `AiFeaturesSection.tsx` — AI provider preferences.
- `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx`
  — provider CLIs and models.
- `apps/desktop/src/renderer/components/settings/IntegrationsSettingsSection.tsx`
  — GitHub, Linear, and computer-use backend readiness. The old
  dedicated `ComputerUseSection.tsx` was removed; its content folded
  in here.
- `apps/desktop/src/renderer/components/settings/MemoryHealthTab.tsx`
  — memory system overview and browser.
- `apps/desktop/src/renderer/components/settings/LaneTemplatesSection.tsx`
  and `LaneBehaviorSection.tsx` — lane initialization recipes and
  lifecycle policies.
- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.tsx`
  — multi-device sync management. Surfaces the phone-pairing PIN (set
  / clear / reveal), the QR payload (v2) with its LAN / Tailscale /
  loopback address candidates, the bootstrap token for desktop peers,
  the Tailscale MagicDNS discovery status (`svc:ade-sync` publication
  via `tailscale serve`), and the per-device connection panel used to
  forget paired phones.
- `apps/desktop/src/renderer/components/usage/HeaderUsageControl.tsx`
  and `UsageQuotaPanel.tsx` — header usage popup. Live provider quotas
  for Claude / Codex / Cursor and the automation budget guardrails are
  now consolidated here; Settings no longer has a Usage tab. The popup
  hydrates from `ade.usage.getSnapshot` and re-fetches via the explicit
  Refresh control. Budget caps round-trip through
  `ade.usage.getBudgetConfig` / `saveBudgetConfig`.
- `apps/desktop/src/renderer/components/settings/ProxyAndPreviewSection.tsx`
  — proxy/preview configuration UI.
- `apps/desktop/src/renderer/components/settings/DiagnosticsDashboardSection.tsx`
  — runtime diagnostics.

Auto-update (top-bar control, not a settings tab):

- `apps/desktop/src/main/services/updates/autoUpdateService.ts` —
  electron-updater wrapper that owns the renderer-visible
  `AutoUpdateSnapshot` (`status: "idle" | "checking" | "downloading"
  | "ready" | "installing" | "error"`, version, progress, recently
  installed notice). Tracks superseded downloads against the current
  ready version via `compareUpdateVersions` (a SemVer-aware
  comparator that handles `v` prefixes, missing patch, and
  prerelease ordering) so a same-or-older `update-available` while a
  newer build is already staged is logged and ignored instead of
  clobbering the staged installer; if the new build is strictly
  newer, the cached installer dir is wiped and the snapshot
  transitions back through `downloading`. `quitAndInstall()` is
  asynchronous: it gates on the current snapshot being `ready`,
  re-runs `updater.checkForUpdates()` with `allowReady: true` to
  confirm the staged installer is still the latest, and only then
  flips the snapshot to `installing`, persists the
  `pendingInstallUpdate` global-state row, and calls
  `updater.quitAndInstall(false, true)`. If the refresh check fails,
  it surfaces the error, drops the cache, and clears the pending
  install. On the next launch, `reconcilePersistedUpdateState`
  matches the running version against `pendingInstallUpdate` using
  the same SemVer comparator (so `>=` target counts as installed,
  even if the running build is one ahead), populates
  `recentlyInstalledUpdate` with the actual running version, and
  cleans up the updater cache directory.
- `apps/desktop/src/renderer/components/app/AutoUpdateControl.tsx` —
  the small badge in the app shell top bar. Shows "Checking for
  updates" / "Downloading vX.Y.Z (NN%)" / "Install update vX.Y.Z" /
  "ADE will quit and reopen" depending on the snapshot. Clicking the
  install affordance prompts the user, sets a local
  `installRequested` flag, and calls
  `window.ade.updateQuitAndInstall()`; if the IPC returns `false`
  (refresh check failed, no longer ready, etc.) the flag is cleared
  so the badge falls back to the underlying snapshot. While
  `installing` (or after the user clicks install but before the main
  process flips status), the badge animates in fuchsia and is
  disabled. The "Update installed" dialog reads
  `recentlyInstalled.releaseNotesUrl` and opens the public release
  notes link for the running version.

## Detail docs

- [configuration-schema.md](./configuration-schema.md) — shape of
  `.ade/ade.yaml` and `.ade/local.yaml` as consumed by
  `projectConfigService`; types in `shared/types/config.ts`.
- [first-run.md](./first-run.md) — the onboarding wizard, stack
  detection, existing-lane import, and the UX contract that lets
  users skip optional integrations.

## Onboarding responsibilities

Onboarding covers two layers.

### Machine layer (one-time per machine)

Driven by `LocalRuntimeConnectionPool` on desktop launch and surfaced in
the General settings tab via `AdeCliSection`:

1. Bring up the runtime daemon. The pool tries to attach to
   `~/.ade/sock/ade.sock`; if that fails it spawns
   `ade serve --socket <path>` from the bundled CLI and waits for the
   socket. A version mismatch between the running daemon and the desktop
   build forces a clean restart.
2. Register the runtime as a per-user login service so it survives
   reboots. `installServiceBestEffort()` runs `ade serve --install-service`
   once per session; the implementation lives in
   `apps/ade-cli/src/serviceManager/` (launchd / systemd / schtasks).
   The result is exposed as `LocalRuntimeStatus.serviceInstall` and
   `serviceHealth` (`unsupported | not_installed | installed | running |
   error | unknown`).
3. Install the `ade` command on `PATH`. The `AdeCliSection` "ADE
   command" card calls `window.ade.adeCli.installForUser()`, which
   delegates to the platform helper script bundled with the desktop
   (`/Applications/ADE.app/Contents/Resources/ade-cli/install-path.sh`
   on macOS, equivalents on other platforms). The compact form embedded
   in `GeneralSection` and the onboarding `DevToolsSection` shows the
   current install path, an Install / Repair button, and an "Add to
   PATH" hint when the install target is not on the user's `$PATH`.
4. Register projects with the runtime. Opening a project on desktop
   calls `LocalRuntimeConnectionPool.ensureProject(rootPath)`, which
   issues `projects.add { rootPath }` against the daemon. The project
   then appears in `projects.list` to every other client (`ade code`,
   iOS, SSH-attached desktops) without an extra step.

### Project layer (per project)

Repository onboarding covers five things:

1. detect dev tools (git, gh CLI) and report availability
2. detect stack signals (node, rust, go, python, docker, make)
3. suggest config defaults for processes, tests, stacks
4. optionally import existing git branches as lanes
5. prepare initial deterministic workspace state

Timing: project open runs a cheap first pass and defers heavy work.
Current behavior:

- lanes load without expensive per-lane status first
- keybindings load immediately (they are tiny)
- provider mode and full lane status warm later
- expensive background work is no longer gated on "must finish before
  the app feels usable"

### Headless install

For machines without a desktop install (CI workers, remote
SSH-attached runtimes), the runtime daemon and `ade` CLI install via
`curl -fsSL .../install.sh | sh`. The script downloads the static
`ade-<platform-arch>` binary plus its native dependency archive, drops
the binary in `$ADE_INSTALL_DIR` (or `~/.local/bin`), extracts native
modules under `~/.ade/runtime/<arch>/`, and best-effort registers the
login service. See [`apps/ade-cli/README.md`](../../../apps/ade-cli/README.md)
for the full flow and environment overrides.

### CTO first-run setup

CTO (the agent identity used in the Chat tab) has its own lightweight
wizard:

1. **Identity** — name, provider/model preference, persona. System
   prompt preview is generated live, debounced.
2. **Project context** — seed from repo-detected defaults or existing
   CTO memory; user can edit summary, conventions, focus areas.
3. **Integrations** — Linear is optional. Primary action finishes
   onboarding with or without Linear. Fastest path is a personal API
   key; OAuth is available but not the default recommendation.

## Settings responsibilities

Top-level tabs, organized to match the kind of thing the user is
changing rather than which service backs it:

| Tab | Section file | What lives here |
|---|---|---|
| General | `GeneralSection.tsx` (embeds `AdeCliSection` in compact form) | AI mode, task routing, terminal preferences (font size, line height, scrollback), keybindings link, and the `ade` CLI install / status surface. The CLI card reports whether the bundled `ade-<platform-arch>` binary is on `PATH`, the resolved install target, and exposes one-click Install / Repair backed by the platform install-path helper. Receives the legacy `?tab=onboarding`, `?tab=help`, `?tab=tours`, and `?tab=keybindings` deep links via `TAB_ALIASES`. |
| Appearance | `AppearanceSection.tsx` (renders `ChatAppearancePreview`) | Theme, code-block copy-button position, agent-turn completion sound + volume + quiet-when-focused, chat font size (`chatFontSizePx`), chat transcript density (`chatTranscriptDensity` — `compact` / `comfortable` / `spacious`), chat chrome tint (`chatChromeTint` — `colored` default vs `neutral` for monochrome chrome; the legacy `chatLaneAccentEmphasis` preset slug is still read so older user-pref blobs migrate cleanly), chat shell geometry (`chatShellGeometry` — `soft` / `default` / `sharp` corners), and the user-message minimap toggle (`chatUserMinimapEnabled` — drives the inline `ChatUserMinimap`). Persisted to `localStorage` under `ade.userPreferences.v1`. |
| Workspace | `WorkspaceSettingsSection.tsx`, `ProjectSection.tsx` | Project identity, paths, skill files. (`SyncDevicesSection.tsx` — multi-device sync, host transfer, peer status, pairing PIN, Tailscale discovery — is mounted from the top bar's Sync popover, not as a Settings tab.) |
| AI | `AiSettingsSection.tsx`, `AiFeaturesSection.tsx`, `ProvidersSection.tsx` | Provider CLIs, models, API-key status, provider readiness, OpenCode runtime diagnostics, and AI feature flags. The same status surface is exposed through ADE actions for `ade code` model setup. |
| Mobile Push | `MobilePushPanel.tsx` | APNs registration, paired-device push tokens, per-category preferences |
| Integrations | `IntegrationsSettingsSection.tsx`, `GitHubSection.tsx`, `LinearSection.tsx` | GitHub, Linear, and computer-use backend readiness. The GitHub section reads `status.connected` (the backend's single "GitHub is usable" gate) to decide between CONNECTED / LIMITED ACCESS / NOT CONNECTED, surfaces a dedicated repo-probe error when a fine-grained token authenticates as a user but cannot access the active repo, and the REFRESH button calls `getStatus({ forceRefresh: true })` so users who fix permissions on github.com see the change immediately. See [`pull-requests/README.md`](../pull-requests/README.md#github-connectivity-model) for the full status-shape and `connected` derivation. |
| Memory | `MemoryHealthTab.tsx` | Memory health, browser, embedding health |
| Lane Templates | `LaneTemplatesSection.tsx`, `LaneBehaviorSection.tsx` | Lane init recipes and lane lifecycle policy |

> Live provider usage and automation guardrails moved out of Settings. They are now in the top-bar Usage popup (`HeaderUsageControl.tsx` → `UsageQuotaPanel.tsx` + collapsible `BudgetCapEditor`).


The Settings page itself (`SettingsPage.tsx`) has a legacy alias
table (`TAB_ALIASES`) that forwards deep links (`?tab=context`,
`?tab=providers`, `?tab=github`, etc.) to the correct section after
the consolidation that collapsed many top-level tabs into sub-sections.

### Where durable data lives

| What | Location | Notes |
|---|---|---|
| Project config (shared) | `.ade/ade.yaml` | committed to git |
| Project config (local) | `.ade/local.yaml` | gitignored |
| Onboarding status | `AdeDb` via `STATUS_KEY = "onboarding:status"` | `completedAt`, `dismissedAt`, `freshProject` |
| Context doc prefs | `AdeDb` via `context:docs:preferences.v1` | provider, model, reasoning effort, event triggers |
| Terminal preferences | `localStorage` under `ade.terminalPreferences.v1` | font size, line height, scrollback, font family |
| Work view state | `localStorage` under `ade.workViewState.v1` | per-project and per-lane-project slices |
| Memory system | `AdeDb` | see memory feature |
| GitHub/Linear credentials | Keychain via `safeStorage` | tokens encrypted, banner on decryption failure |

## AI mode and provider behavior

`effective.ai.mode` is the source of truth for guest vs subscription
behavior. Current behavior:

- **guest mode** — deterministic features remain usable; AI-backed
  features degrade cleanly (no narrative generation, no summaries).
- **subscription mode** — unlocks chat, narratives, summaries,
  mission orchestration.

Legacy `providers.mode` migration ran during earlier releases and is
no longer part of the contract; `projectConfigService` still contains
the migration path but it is idempotent for current configs.

## UX contract

Onboarding and settings follow a simple rule:

- do not block on optional integrations
- keep setup responsive
- show the fastest path first
- defer advanced or heavy configuration to the feature surface that
  owns it (e.g. memory browser is in the Memory tab, not sprayed
  across multiple places)

## Gotchas

- **Shared vs local.** Shared config is version-controlled and visible
  to the whole team; saving to shared triggers a trust confirmation
  dialog. Local config is per-user and gitignored — use it for ports,
  local-only processes, personal env. Both are merged into `effective`.
- **Trust boundary.** `projectConfigService.getExecutableConfig` gates
  on trust before returning a config that can spawn processes. Callers
  that skip trust (`{ skipTrust: true }`) do so only after trust has
  been confirmed in the same session.
- **Config reload.** On save, dependent services receive reload
  callbacks (the config service iterates listeners). A hot reload is
  best-effort — some changes only take full effect on app restart
  (e.g. proxy port changes).
- **Onboarding status.** `freshProject` is computed at
  `createOnboardingService` construction and does not update at
  runtime. Passing the wrong boolean flips the "first-run" surface on
  a well-used project.
- **Deep links.** Settings tabs accept `?tab=<id>` via
  `useSearchParams`; legacy ids `onboarding`, `help`, `tours`,
  `context`, `providers`, `github`, `linear`, `computer-use`, and
  `keybindings` resolve to their canonical tab through `TAB_ALIASES`
  (most route to **General**; provider/GitHub/Linear/computer-use
  route to **Integrations**). The dedicated Onboarding tab no longer
  exists — its settings moved into General + the top-bar Help menu.
- **Auto-update install must refresh before quitting.**
  `quitAndInstall()` deliberately re-runs `updater.checkForUpdates()`
  with `allowReady: true` before flipping to `installing`. Skipping
  that step (e.g. a synchronous quitAndInstall) reintroduces the bug
  where ADE quits to install a stale download while a strictly newer
  build is available. Comparison goes through `compareUpdateVersions`
  — never `===` on the version string — because `v1.2.3` /
  `1.2.3-rc.1` / `1.2.3` all need consistent ordering on both the
  pending-install reconcile path and the supersede check.
- **`installing` is a sticky status.** While the snapshot is
  `installing` the service ignores `update-not-available`,
  `checking-for-update`, and `error`, because the main process is in
  the middle of quitAndInstall. New status checks should treat
  `ready` and `installing` symmetrically when deciding whether to
  cancel or override the staged update.

## Cross-links

- Run/Project home: [../project-home/README.md](../project-home/README.md)
- Lane templates used during lane creation: Lanes feature
- Terminal preferences applied at runtime:
  [../terminals-and-sessions/ui-surfaces.md](../terminals-and-sessions/ui-surfaces.md)
