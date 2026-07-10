# Onboarding and Settings

Two related but distinct flows:

- **Onboarding** — the fastest path to a usable installation and a usable
  project. Covers registering the project with the runtime so every client
  (desktop, `ade code`, iOS) sees it, detecting essentials, connecting AI
  runtimes, GitHub, and Linear, and optionally attaching existing git
  worktrees as lanes. The first-run project setup page is a single dashboard
  of status cards rather than a blocking step-by-step wizard.
- **Settings** — long-lived configuration organized by tab. Persists
  to `.ade/ade.yaml` (shared) and `.ade/local.yaml` (local) through
  `projectConfigService`.

The runtime no longer assumes first-run setup must hydrate every
service. Project open favors a cheap first pass; secondary hydration
(full lane status and provider modes) happens after the app is
interactive.

## Where state lives

ADE state is split between the per-machine runtime root and per-project
directories. Onboarding writes to both.

| Scope | Location | Owner | Contents |
|---|---|---|---|
| Machine | `~/.ade/` (`ADE_HOME` overrides; channel builds use `~/.ade-alpha/` / `~/.ade-beta/`) | ADE runtime (`ade serve`) | Runtime endpoint (`sock/ade.sock`), project registry (`projects.json`), encrypted credential store (`secrets/`), bundled binary (`bin/ade`), native runtime deps (`runtime/<arch>/`), service log files. |
| Project (shared) | `<project>/.ade/ade.yaml` | `projectConfigService` | Version-controlled team config: processes, stacks, tests, automations, lane templates, AI mode, providers, Linear sync. |
| Project (local) | `<project>/.ade/local.yaml` | `projectConfigService` | Per-user, gitignored: ports, env vars, local-only processes. |
| Project (data) | `<project>/.ade/` | various services | Lanes, attachments, kvDb, generated assets. The shared `.ade/.gitignore` whitelists only authored files. |

The ADE runtime is the seam that ties machine and project scope
together: it owns `~/.ade/projects.json`, lazily builds an `AdeRuntime`
per project root on first project-scoped JSON-RPC call, and is the
single runtime through which desktop, `ade code`, and SSH-attached
desktops see live lanes, agent chats, work sessions, and processes.

## Source file map

Main process:

- `apps/desktop/src/main/services/onboarding/onboardingService.ts` —
  status, stack detection, existing lane detection, suggested config
  application, plus passive glossary help state. The active renderer
  no longer mounts guided tours.
- `apps/desktop/src/main/services/onboarding/onboardingSuggestedConfig.ts` —
  pure GitHub Actions workflow parsing and suggested process/test/stack
  config generation for `.ade/ade.yaml`.
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
  - `ade.project.*` (listRecent, openRepo, switchProjectToPath,
    getSnapshot, initializeOrRepair, runIntegrityCheck)
  - `ade.ai.*` and settings-specific channels per integration
  - `ade.agentChat.setScheduledWorkPaused` for the per-chat scheduler control;
    the global pause is written through `ade.ai.updateConfig`
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — handler
  registrations.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.onboarding`,
  `window.ade.projectConfig`, `window.ade.project`, plus the
  integration-specific surfaces (`window.ade.github`, etc.).

Renderer — onboarding:

- `apps/desktop/src/renderer/components/onboarding/ProjectSetupPage.tsx`
  — first-run and manual "re-run setup" dashboard. It renders the project
  header, Finish / Skip actions, the AI runtimes band, essentials row,
  GitHub / Linear cards, and existing-worktree import card.
- `apps/desktop/src/renderer/components/onboarding/AiRuntimesBand.tsx`
  — compact setup surface for Claude, Codex, Cursor, Factory Droid, and
  OpenCode. Shows runtime readiness, install / sign-in commands, Cursor API-key
  entry, helper toggles, and per-helper model pickers.
- `apps/desktop/src/renderer/components/onboarding/DevToolsRow.tsx`
  — essential local tooling status for git and the terminal `ade` CLI.
- `apps/desktop/src/renderer/components/onboarding/GitHubCard.tsx`,
  `LinearCard.tsx`, `WorktreesCard.tsx` — setup cards for repository auth,
  Linear OAuth / API-key auth, and importing existing worktrees as lanes.
  `WorktreesCard` refreshes the shared lane store after successful imports so
  the first post-onboarding Work/Lanes views render the attached lanes without
  waiting for a later project refresh.
- `apps/desktop/src/renderer/components/onboarding/InputPopover.tsx`,
  `RescanButton.tsx`, `onboardingTheme.ts` — shared setup-card controls and
  brand/status styling tokens.
- `apps/desktop/src/renderer/components/onboarding/DevToolsSection.tsx`
  — legacy full-size dev tool detection surface retained for existing routes
  that still mount it.
- `apps/desktop/src/renderer/components/onboarding/OnboardingBootstrap.tsx`
  — top-level passive help mount. It renders the one-time ADE welcome
  video gate plus `DidYouKnow`; guided per-tab tours and the old
  welcome wizard are no longer mounted.
- `apps/desktop/src/renderer/components/onboarding/WelcomeVideoGate.tsx`
  — one-time app-level welcome card backed by global app state. It
  uses sanitized bundled welcome assets, lazy-loads the intro video,
  links to GitHub and the docs site, and includes an ADE Mobile
  TestFlight QR/download/copy panel. The Help menu can replay it
  without resetting setup.
- `apps/desktop/src/renderer/public/welcome/` — sanitized bundled
  screenshots/poster/icon assets consumed by the welcome card.
- `apps/desktop/src/renderer/components/onboarding/HelpMenu.tsx`
  — persistent help menu in the top bar: glossary, docs links, welcome
  video replay, and help preferences. Tour replay entries were removed
  with the guided-tour renderer.
- `apps/desktop/src/renderer/onboarding/docsLinks.ts` — typed registry
  of internal/public doc URLs that `DidYouKnow`, `HelpMenu`, and
  glossary surfaces link to.
- `apps/desktop/src/renderer/components/cto/...` — CTO first-run is a
  single lightweight card covering personality and work-style setup.
  Model selection and Linear are deferred to the CTO Settings sheet.

Renderer — settings:

- `apps/desktop/src/renderer/components/app/SettingsPage.tsx` — tab
  container. The current top-level sections are General, Appearance,
  AI Connections, Secrets, Background Jobs, Lane Templates, and Stats. Legacy
  `workspace`, `project`, `context`, `integrations`, `github`, and
  `linear` deep links land in General; `providers` lands in AI
  Connections; `automations` lands in Background Jobs. Welcome video
  replay and help preferences live under the Help menu in the top bar,
  not as a Settings tab.
- `apps/desktop/src/renderer/components/settings/GeneralSection.tsx`
  — consolidated general preferences: GitHub and Linear connections,
  voice input, launch-prompt clipboard, agent completion sound, PR
  chat transcript gists, project `.ade` health, and environment
  (About + compact `AdeCliSection`). Each block uses
  `SettingsSectionShell` for a branded header. Deep links:
  `#github-connection`, `#linear-connection`, `#voice-input`,
  `#chat-launch-clipboard`, `#agent-completion-sound`,
  `#pr-chat-transcripts`.
- `apps/desktop/src/renderer/components/settings/GitHubIntegrationSection.tsx`
  and `GitHubSection.tsx` — GitHub CLI / PAT auth, scope diagnostics,
  and permission guidance. Embedded inside General. Also hosts the
  `GitHubAppInstallPanel` (below) for installing "ADE for GitHub".
- `apps/desktop/src/renderer/components/github/GitHubAppInstallPanel.tsx`
  — install / status card for the hosted ADE GitHub App that backs
  webhook-relay PR updates. Reads per-repo installation + webhook state via
  `window.ade.github.getAppInstallationStatus` (which the desktop resolves
  against the hosted relay's `/github/repos/:owner/:repo/status` route using
  a locally stored GitHub App user token from device flow), and links out to the
  App install / manage pages. Hosts the "Authorize ADE" device-flow UI:
  `startAppUserDeviceAuth` surfaces the user code as a copyable chip plus a
  waiting state and the verification URL, `pollAppUserDeviceAuth` drives the
  poll loop and auto-renews an expired code up to 3 times, a pre-auth status
  pill reflects `getAppUserAuthStatus` (stored token, signed-in login, expiry).
  After device authorization succeeds, the panel force-refreshes the hosted
  relay status with a short retry window and treats GitHub repo-access 404s as a
  temporary "Checking access" state so GitHub App installation propagation does
  not look like failed authorization. `clearAppUserAuth` revokes the local token.
  Offers a Refresh. Rendered in Settings and, in a compact `onboarding` variant,
  during setup. The
  device-flow, token store, and single-flight refresh are backed by
  `githubAppUserAuthService` in the main process (see the automations feature
  doc's Source file map).
- `apps/desktop/src/renderer/components/settings/LinearIntegrationSection.tsx`
  and `LinearSection.tsx` — Linear OAuth / API key, workspace status,
  and GitHub autolink setup. Embedded inside General.
- `apps/desktop/src/renderer/components/settings/PrChatTranscriptsSection.tsx`
  — toggles `prTranscriptGists.enabled` in project local config.
- `apps/desktop/src/renderer/components/settings/EnvironmentSection.tsx`
  — About (version, runtime) plus compact ADE CLI install surface.
- `apps/desktop/src/renderer/components/settings/settingsSectionUi.tsx`
  — shared section headers (`SettingsSectionShell`) and toggle styling.
- `apps/desktop/src/renderer/components/settings/AppearanceSection.tsx`
  — theme and chat appearance preferences. Renders `ChatAppearancePreview`
  and writes local user preferences through `appStore` (font size,
  transcript density, chrome tint, shell geometry, user minimap).
- `apps/desktop/src/renderer/components/settings/DictationSection.tsx`
  — voice input settings. Persists `voiceInputEnabled`, shows whether
  the bundled on-device transcription model is installed, and gates the
  chat composer mic affordance.
- `apps/desktop/src/renderer/components/settings/ProjectSection.tsx`
  — project `.ade` structure snapshot, shared/local/secret config paths,
  health warnings, structure repair, and integrity-check controls.
- `apps/desktop/src/renderer/components/settings/AboutSection.tsx`
  — installed ADE version, packaged/dev badge, latest GitHub release
  lookup, release notes link, manual update check button, and ADE runtime
  install / health status when available.
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
- `apps/desktop/src/renderer/components/settings/AiFeaturesSection.tsx`
  — Background Jobs settings for AI-powered helpers: auto-naming chats,
  CLI sessions, and lanes; summarizing completed chats and terminals;
  PR description drafting; and commit message drafting. Reasoning-effort
  pickers use `useFamilyDefaults={false}` so each row keeps an
  independent effort override. The section also owns **Pause all scheduled
  work**, persisted as `ai.chat.scheduledWorkPaused`. This pauses Claude
  wakeups, cron tasks, and `/loop` schedules across the project runtime
  without disarming them; overdue work catches up once after resume.
- `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx`
  — AI Connections settings for provider CLIs, authentication, API keys,
  and model availability.
- `apps/desktop/src/renderer/components/settings/SecretsSection.tsx`
  — Settings > Secrets. Lists project-scoped ADE secrets without values,
  adds/replaces secrets, reveals values on demand, copies them to the
  clipboard, and deletes with inline confirmation. Values are backed by
  `projectSecretService` under `.ade/secrets/project-secrets.v1.enc`.
- `apps/desktop/src/renderer/components/settings/LaneTemplatesSection.tsx`
  and `LaneBehaviorSection.tsx` — lane initialization recipes and
  lifecycle policies.
- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.tsx`
  — multi-device sync management. The default `variant="all"` shows phone,
  web-client, and desktop-peer controls in Settings; `"phone"` and `"web"`
  variants provide focused content for the matching top-bar sheets. It
  surfaces the phone-pairing PIN (set / clear / reveal, or generate a new
  six-digit PIN when only the at-rest hash remains), the v3 smart pairing URL
  with LAN / Tailscale / loopback / relay candidates, the web-client link and
  QR, the bootstrap token for desktop peers, relay/discovery status, and the
  per-device panels used to forget paired phones or revoke web clients.
- `apps/desktop/src/renderer/components/app/TopBar.tsx` and `HeaderSheet.tsx`
  — Mobile and Web connection chips plus their mutually exclusive portaled
  sheets. The Mobile sheet includes the TestFlight install action; the Web
  sheet reports connected browser peers and exposes focused browser pairing.
- `apps/desktop/src/renderer/components/usage/HeaderUsageControl.tsx`
  and `UsageQuotaPanel.tsx` — header usage popup. Live provider quotas
  for Claude and Codex (tracked providers) and the automation budget
  guardrails are consolidated here. The header renders one compact
  chip per detected tracked provider with the 5-hour window and the
  plan window (`wk` when a
  weekly window is present, otherwise `mo`). Percent values are clamped
  to 0-100, color through the green/amber/red thresholds at 75% /
  100%, and show an ellipsis while missing. On mount, the button reads
  the cached `ade.usage.getSnapshot`, immediately forces
  `ade.usage.refresh`, ignores a slower cached startup read when a
  fresher forced refresh has already landed, refreshes every 120 s, and
  refreshes on window focus when the latest poll is older than 60 s.
  Provider detection comes from `ade.ai.getStatus` on mount and every
  5 min; CLIs not detected on the machine are hidden from the header,
  while installed-but-unauthenticated providers stay visible in the
  panel as "Not signed in". The panel auto-refreshes on open, subscribes
  to usage `onUpdate`, and drills down into 5-hour, weekly, monthly,
  and other reset windows, last-poll status, daily 7-day usage, and
  per-provider messages/error chips. Codex polling keeps the legacy HTTP
  rate-limit endpoint as the first source for windows, then also asks the
  Codex app-server via CLI JSON-RPC for `account/usage/read` and
  `account/workspaceMessages/read` so the panel can show native daily
  usage and provider workspace messages even when HTTP windows succeed.
  Cursor usage polling was removed (it required a team-admin API key that
  desktop users almost never have); only `claude` and `codex` are tracked
  in `TRACKED_PROVIDERS`. Budget
  caps round-trip through `ade.usage.getBudgetConfig` /
  `saveBudgetConfig`. Threshold crossings (25 / 50 / 75 / 100 %) emit
  `UsageThresholdEvent`s for local usage handling.
- `apps/desktop/src/renderer/components/settings/AdeUsageSection.tsx`
  — Settings > Stats, a sectioned dashboard rather than a single carousel.
  The header carries two segmented controls — a **scope** toggle (This
  project / This machine, persisted to `ade.stats.scope.v1`, default project)
  and a **range** toggle (Today / 7d / 30d / year / all) — plus a Refresh
  button. Below the header: an **Overview** row of stat tiles (AI tokens,
  estimated cost, code movement, pull requests), an **Activity** section that
  mounts `ActivityModule` (`variant="full"`, `showRangeControl={false}`), and
  a two-panel row of **AI usage** (deduplicated per-provider token totals and
  per-model breakdown, with per-provider estimation notes) and **Code & PRs**
  (GitHub activity and ADE-local activity as separate labeled columns, never
  max-merged). A meta line at the bottom reports freshness ("refreshing"),
  estimation caveats, and which scope the provider totals were computed at.
  It reads `window.ade.usage.getAdeStats({ preset, scope })` and calls
  `window.ade.usage.refresh()` for explicit refresh; the first render is
  stale-while-revalidate (cached provider/GitHub data plus live project-DB
  aggregates return immediately while expensive provider-ledger and `gh` scans
  refresh in the background). Provider colors come from `providerColor`.
- `apps/desktop/src/main/services/usage/usageTrackingService.ts` — owns the
  live quota snapshot plus the retrospective `getAdeUsageStats(args)`
  projection. `args.scope` selects `machine` (every session in the provider's
  local ledgers, codeburn-comparable) or `project` (only sessions attributable
  to the current project root by cwd match); GitHub and ADE-DB metrics are
  always project/repo scoped regardless of scope. Provider token totals are
  deduplicated from the local provider ledgers, all daily buckets and range
  boundaries key on machine-local calendar days (`localDay.ts`), and GitHub vs
  local activity are reported as separate labeled groups (never max-merged).
  It returns cached provider/GitHub results and current DB aggregates without
  awaiting expensive scans, exposes freshness metadata (`fresh` / `refreshing`),
  and coalesces stale provider/GitHub revalidation in the background
  (`refreshStatsInBackground`, single-flight per range + source).
- `apps/desktop/src/main/services/usage/usageStatsStore.ts` — aggregates the
  project database and owns the low-volume `usage_events` ledger. Only
  successful, meaningful user mutations are recorded; read/poll IPC is
  ignored. Desktop IPC, ADE Code/TUI RPC, paired mobile commands, paired web
  commands, and API callers are attributed as `desktop`, `tui`, `mobile`,
  `web`, and `api`. `usage_events` is local-only (excluded from CRR
  replication) because every controller action is recorded once on the runtime
  that executes it.
- `apps/desktop/src/main/services/usage/localDay.ts` — machine-local calendar
  day helpers (`localDayKey`, `localDayStart`, `localDayOffset`,
  `localDayOrdinal`) so daily points and range boundaries follow the user's
  timezone instead of UTC.
- `apps/desktop/src/shared/types/usage.ts` — shared range, scope, daily-point,
  freshness, estimation, GitHub-vs-local activity, aggregate, and
  client-attribution contracts. Supported presets are today, 7d, 30d, year,
  and all time; scopes are `machine` and `project`; `AdeUsageEstimationKind`
  (`exact` / `chars` / `distribution` / `mixed`) records how a provider's token
  counts were obtained.
- `apps/desktop/src/renderer/components/usage/ActivityModule.tsx` — the
  tabbed activity/tokens/code/clients module that replaced the old carousel.
  `ActivityModule` renders `full` and `compact` variants (optional range
  control) and persists the selected tab and day/week/month/year range to
  `ade.activity.module.v1` (migrating the retired `ade.stats.carousel.v1`
  key). `WorkActivityModule` is the self-fetching compact wrapper that reads
  `usage.getAdeStats` and renders directly below the empty Work composer on
  desktop and web.
- `apps/desktop/src/renderer/components/usage/providerColors.ts` — theme-aware
  brand color palette for usage bars and legends. `providerColor(provider,
  theme)` returns a per-provider brand color (Claude's rust family, distinct
  hues for the other providers) with a deterministic hashed fallback for
  unknown providers.
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
  clobbering the staged installer; packaged builds schedule startup and
  periodic update checks, while dev/source launches leave those timers off
  to avoid surfacing missing-updater-config errors; if the new build is strictly
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
  cleans up the updater cache directory. On packaged launches with a
  recently installed update, the desktop refreshes the per-user runtime
  service so `ade serve` re-execs the updated bundled CLI and clients
  do not fall back to an isolated build-mismatch runtime.
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
  disabled. The post-install dialog is a centered card titled
  "Updated to vX.Y.Z" (the running version) with an X close button
  and click-outside dismiss; it offers a "Changelog" button that opens
  `recentlyInstalled.releaseNotesUrl` (the docs changelog) and a "View
  on GitHub" button that opens `recentlyInstalled.githubReleaseUrl`
  (the GitHub release page). Each button is shown only when its URL is
  present; opening either link also dismisses the notice.

## Detail docs

- [configuration-schema.md](./configuration-schema.md) — shape of
  `.ade/ade.yaml` and `.ade/local.yaml` as consumed by
  `projectConfigService`; types in `shared/types/config.ts`.
- [first-run.md](./first-run.md) — the first-run setup dashboard,
  stack detection, existing-lane import, and the UX contract that lets
  users skip optional integrations.

## Onboarding responsibilities

Onboarding covers two layers.

### Machine layer (one-time per machine)

Driven by `LocalRuntimeConnectionPool` on desktop launch and surfaced in
the General settings tab via `AdeCliSection`:

1. Bring up the ADE runtime. The pool tries to attach to
   `~/.ade/sock/ade.sock`; if that fails it spawns
   `ade serve --socket <path>` from the bundled CLI and waits for the
   endpoint. Compatibility is checked at `initialize` time using both the
   reported version and a SHA-256 build hash of the CLI script
   (`ADE_RUNTIME_BUILD_HASH` is set by `apps/ade-cli/src/cli.ts` before
   spawning the runtime, and `LocalRuntimeConnectionPool.connectClient`
   compares the runtime's `buildHash` against the desktop's expected
   value). A dev build that reports the placeholder version `0.0.0` is
   accepted when its build hash matches the bundled CLI. Mismatches
   are surfaced as a `LocalRuntimeCompatibilityError`; the pool
   terminates the stale runtime process when the handshake reported a
   pid, unlinks the stale endpoint, and then lets the normal spawn path
   start a compatible runtime.
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
SSH-attached runtimes), the ADE runtime and `ade` CLI install via
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
   CTO core continuity; user can edit summary, conventions, focus areas.
3. **Integrations** — Linear is optional. Primary action finishes
   onboarding with or without Linear. Fastest path is a personal API
   key; OAuth is available but not the default recommendation.

## Settings responsibilities

Top-level tabs, organized to match the kind of thing the user is
changing rather than which service backs it:

| Tab | Section file | What lives here |
|---|---|---|
| General | `GeneralSection.tsx` (GitHub/Linear connections, voice input, launch prompts, completion sound, PR transcripts, project files, environment) | Consolidated day-to-day preferences and integrations. GitHub and Linear auth live here (not a separate Integrations tab). Legacy `?tab=integrations`, `?tab=github`, and `?tab=linear` redirect to General with hash anchors (`#github-connection`, `#linear-connection`). Also receives `?tab=onboarding`, `?tab=help`, `?tab=tours`, and `?tab=keybindings` via `TAB_ALIASES`. |
| Appearance | `AppearanceSection.tsx` (renders `ChatAppearancePreview`) | Theme, code-block copy-button position, chat font size, transcript density, chrome tint, shell geometry, and the user-message minimap toggle. Persisted to `localStorage` under `ade.userPreferences.v1`. |
| AI Connections | `ProvidersSection.tsx` | Provider CLIs, models, API-key status, provider readiness, OpenCode runtime diagnostics. When Claude is installed but unauthenticated, the shared `Login to Claude` CTA opens a primary-lane terminal running `claude auth login` and navigates to Work. Legacy `?tab=providers` lands here. |
| Background Jobs | `AiFeaturesSection.tsx` | AI-powered automations: summaries, PR descriptions, commit messages, auto-naming, plus the project-wide **Pause all scheduled work** control for Claude wakeups, cron tasks, and loops. Pausing keeps schedules armed and suppresses `nextWakeAt`; on resume each overdue schedule runs once before cron work returns to its normal cadence. Legacy `?tab=automations` lands here. Each feature row has an independent reasoning-effort override (`ReasoningEffortPicker` with `useFamilyDefaults={false}`). |
| Lane Templates | `LaneTemplatesSection.tsx`, `LaneBehaviorSection.tsx` | Lane init recipes and lane lifecycle policy |
| Stats | `AdeUsageSection.tsx`, `ActivityModule.tsx`, `providerColors.ts` | Sectioned dashboard: overview stat tiles, an activity/tokens/code/clients module, and split AI-usage and GitHub-vs-local Code & PRs panels, with project/machine scope and day/week/month/year ranges. Fast cached local-provider, project-DB, GitHub, and cross-client activity. Deep links from `?tab=usage` and `?tab=stats` land here. |

> Live provider quota windows and automation guardrails live in the top-bar Usage popup (`HeaderUsageControl.tsx` → `UsageQuotaPanel.tsx` + collapsible `BudgetCapEditor`). Settings > Stats is the retrospective cross-client ADE activity dashboard.


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
| GitHub credentials | Keychain via `safeStorage` | tokens encrypted, banner on decryption failure |
| Linear credentials | Active project's `.ade/secrets` | project-local token/OAuth state, encrypted on disk |

## AI mode and provider behavior

`effective.ai.mode` is the source of truth for guest vs subscription
behavior. Current behavior:

- **guest mode** — deterministic features remain usable; AI-backed
  features degrade cleanly (no narrative generation, no summaries).
- **subscription mode** — unlocks chat, narratives, and summaries.

Legacy `providers.mode` migration ran during earlier releases and is
no longer part of the contract; `projectConfigService` still contains
the migration path but it is idempotent for current configs.

## UX contract

Onboarding and settings follow a simple rule:

- do not block on optional integrations
- keep setup responsive
- show the fastest path first
- defer advanced or heavy configuration to the feature surface that
  owns it

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
