# Onboarding and Settings

Two related but distinct flows:

- **Onboarding** — the fastest path to a usable installation and a usable
  project. Covers registering the project with the runtime so every client
  (desktop, `ade code`, iOS) sees it, detecting essentials, connecting AI
  runtimes, GitHub, and Linear, and optionally attaching existing git
  worktrees as lanes. The first-run project setup page is a single dashboard
  of status cards rather than a blocking step-by-step wizard.
- **Settings** — long-lived configuration organized by tab. Project
  configuration persists to `.ade/ade.yaml` (shared) and `.ade/local.yaml`
  (local) through `projectConfigService`; machine-level desktop preferences
  such as automatic update installation persist in the Electron user-data
  `ade-state.json`.

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
| Desktop installation | `<Electron userData>/ade-state.json` | Desktop main process | Recent projects, update handoff/reconciliation state, and machine-local automatic-install preferences. |
| Project (shared) | `<project>/.ade/ade.yaml` | `projectConfigService` | Version-controlled team config: tests, overlays, automations, lane templates, AI mode, providers, Linear sync. |
| Project (local) | `<project>/.ade/local.yaml` | `projectConfigService` | Per-user, gitignored overrides for ports, env vars, and machine-specific paths. |
| Project (data) | `<project>/.ade/` | various services | Lanes, attachments, kvDb, generated assets. The shared `.ade/.gitignore` whitelists only authored files. |

The ADE runtime is the seam that ties machine and project scope
together: it owns `~/.ade/projects.json`, lazily builds an `AdeRuntime`
per project root on first project-scoped JSON-RPC call, and is the
single runtime through which desktop, `ade code`, and SSH-attached
desktops see live lanes, agent chats, and work sessions.

## Source file map

Main process:

- `apps/desktop/src/main/main.ts`,
  `apps/desktop/src/main/services/ipc/registerIpc.ts` — packaged-launch machine
  trust migration plus the process-local launch-gate state exposed through
  `ade.app.getLaunchGateState` / `ade.app.resolveLaunchGate`. Resolving the gate
  applies to every window and renderer reload in that desktop process; the next
  fresh signed-out launch asks again.
- `apps/desktop/src/main/services/runtime/machineTrustResetMigration.ts` —
  one-release, packaged-build reset of saved machine connection grants. It
  clears only remote targets, desktop paired-machine credentials, mobile/web
  pairing records, and runtime-host grants, then forces the background service
  to restart before committing the migration marker.
- `apps/desktop/src/main/services/account/accountBridge.ts`,
  `apps/ade-cli/src/services/account/accountAuthService.ts`, and
  `accountMachineDirectoryService.ts` — machine-scoped Clerk session and
  directory ownership. Account adoption captures the current owner before
  network work and verifies it again before saving; logout/account switch
  removes only that owner's remote targets and paired credentials. Direct
  PIN/link/Nearby/address/SSH trust is explicitly local and is never adopted
  merely because the user later signs in. When product analytics is enabled,
  the account boundary identifies a known user only through a one-way account
  hash with closed enrichment fields; explicit logout rotates the anonymous
  analytics identity.
- `apps/desktop/src/main/services/onboarding/onboardingService.ts` —
  status, stack detection, existing lane detection, suggested config
  application, plus passive glossary help state. The active renderer
  no longer mounts guided tours.
- `apps/desktop/src/main/services/onboarding/onboardingSuggestedConfig.ts` —
  pure GitHub Actions workflow parsing and suggested test/automation/provider
  config generation for `.ade/ade.yaml`.
- `apps/desktop/src/main/services/github/githubService.ts`,
  `githubCredentialHealth.ts`, and `githubRateLimit.ts` — GitHub App,
  environment, PAT, and GitHub CLI credential discovery; `/user` and repository
  probes; REST and GraphQL failure/quota classification; per-resource credential
  cooldowns; and the shared-account primary-quota circuit breaker. Reads use
  environment → ADE GitHub App → GitHub CLI → stored PAT. Writes use environment
  → GitHub CLI → stored PAT because the App user credential is intentionally
  read-only. Request-level 401/403/429 responses, GraphQL rate/permission errors,
  and 403/404 repository-probe denials advance to the next compatible source.
  Invalid or permission-denied credentials cool down for five minutes; rate
  limits wait at least one minute and honor GitHub's reset. ADE then retries the
  preferred source automatically. GitHub's primary user quota is shared by App
  user, OAuth, and PAT credentials for the same account, so an exhausted primary
  bucket pauses known credentials for that account instead of cycling tokens.
  `GitHubStatus.authFailure` distinguishes rate limiting, invalid credentials,
  permission denial, network failures, and unknown validation errors so clients
  do not flatten every failed probe into missing permissions.
- `apps/desktop/src/shared/githubOperationCredential.ts` — the capability-aware
  read/write credential order, App read-only rule, and duplicate-token removal
  used by desktop and runtime-side GitHub services.
- `apps/ade-cli/src/headlessLinearServices.ts` — runtime-owned mirror of the
  GitHub request/status path. It applies the same candidate order, cooldowns,
  GraphQL classification, conditional-request cache isolation, and read/write
  status fields when a packaged or remote-bound window uses `ade serve`.
- `apps/desktop/src/main/services/config/projectConfigService.ts` —
  YAML config read/merge/save, AI mode migration, lane env init,
  Linear sync resolver. ~3,150 lines, the largest service.
- `apps/desktop/src/main/services/config/laneOverlayMatcher.ts` —
  matches lanes against `LaneOverlayPolicy[]` to produce the effective
  overlay.
- `apps/desktop/src/main/services/secrets/projectSecretService.ts` and
  `projectSecretEnv.ts` — encrypted project-secret CRUD plus bounded dotenv
  parsing, selected batch import, and mode-`0600` export to the runtime
  machine's Downloads folder.

Shared types and IPC:

- `apps/desktop/src/shared/types/config.ts` — central type module for
  the configuration schema (tests, overlays, automations, lane
  templates, port allocation, proxy, OAuth, integrations, AI).
- `apps/desktop/src/shared/types/projectSecrets.ts` — project-secret list,
  value, dotenv preview/import, and export request/result contracts.
- `apps/desktop/src/shared/types/core.ts` — `AutoUpdatePreferences` and
  `DEFAULT_AUTO_UPDATE_PREFERENCES` (`automaticInstall: false`,
  `onlyWhenIdle: true`) plus the renderer-visible update snapshot contract.
- `apps/desktop/src/shared/types/git.ts` — `GitHubStatus`,
  `GitHubAuthFailure`, `GitHubRateLimitState`, and the credential source,
  capability, state, and fallback contracts. `writeAuthSource`,
  `credentialStates`, `credentialFallback`, and
  `backgroundRefreshPausedUntil` are optional so a newer client remains
  compatible with an older remote runtime.
- `apps/desktop/src/shared/ipc.ts` — channels:
  - `ade.onboarding.*` (status, detectDefaults, applySuggestedConfig,
    complete, setDismissed)
  - `ade.projectConfig.*` (get, validate, save, diffAgainstDisk,
    confirmTrust, export)
  - `ade.project.*` (listRecent, openRepo, switchProjectToPath,
    getSnapshot, initializeOrRepair, runIntegrityCheck)
  - `ade.projectSecrets.*` (list, get, set, delete, chooseEnvFile,
    previewEnvImport, importEnv, exportEnv)
  - `ade.ai.*` and settings-specific channels per integration
  - `ade.agentChat.setScheduledWorkPaused` for the per-chat scheduler control;
    the global pause is written through `ade.ai.updateConfig`
  - `ade.update.getPreferences` / `ade.update.setPreferences` for the
    machine-local automatic-install policy
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — handler
  registrations.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.onboarding`,
  `window.ade.projectConfig`, `window.ade.project`,
  `window.ade.projectSecrets`, `window.ade.updateGetPreferences`,
  `window.ade.updateSetPreferences`, plus the integration-specific surfaces
  (`window.ade.github`, etc.).

Renderer — onboarding:

- `apps/desktop/src/renderer/components/projects/ProjectWelcomePage.tsx`
  — projectless welcome and project-picker surface. It lists recent local and
  remote projects, opens or forgets entries, and launches project creation,
  clone, or folder selection before a project-bound route is available.
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
  `LinearCard.tsx` — setup cards for repository auth and Linear OAuth /
  API-key auth. There is no worktree-import card: every git worktree in the
  project already appears as a lane, so there is nothing to select.
- `apps/desktop/src/renderer/components/onboarding/InputPopover.tsx`,
  `RescanButton.tsx`, `onboardingTheme.ts` — shared setup-card controls and
  brand/status styling tokens.
- `apps/desktop/src/renderer/components/onboarding/DevToolsSection.tsx`
  — legacy full-size dev tool detection surface retained for existing routes
  that still mount it.
- `apps/desktop/src/renderer/components/onboarding/OnboardingBootstrap.tsx`
  — top-level passive help mount. It renders the one-time ADE welcome
  video gate plus `DidYouKnow`; guided per-tab tours and the old
  welcome wizard are no longer mounted. The `DidYouKnow` toast is
  suppressed on every `/chats` route (projectless or not) because its
  fixed bottom-right portal overlaps the chats composer at narrow
  widths.
- `apps/desktop/src/renderer/components/onboarding/LaunchGate.tsx`
  — process-launch gate. New installations show the welcome card before
  account choice; returning signed-out launches show account choice directly.
  The signed-out surface keeps one direct sign-in/create-account action, a
  short ADE Relay requirement link, and **Continue without an account**. Its
  top strip is draggable even though the normal shell header is not mounted.
  Renderer reloads or extra windows in the same desktop process do not repeat
  the choice. Directly paired machines stay saved across account sign-out;
  account-directory targets and their paired credentials are owner-tagged and
  removed with that account.
- `apps/desktop/src/renderer/components/account/AccountPage.tsx` — optional
  account status/sign-in/out and account-machine directory. The signed-out page
  receives an explicit in-app return route from the sidebar or Connections and
  falls back safely to `/work` when opened directly. It routes pairing work
  back to the beginner-facing Connections panel rather than owning a second
  machine-connection flow. Signed-in machine menus can rename an account
  machine or clear its custom name. The custom name is account-wide and wins
  for display without replacing the hostname that the machine continues to
  report; list refreshes propagate the new display name through Connections,
  desktop pairing, ADE Code, hosted web, and iOS.
- `apps/desktop/src/renderer/components/onboarding/WelcomeVideoGate.tsx`
  — one-time app-level welcome card backed by global app state. It
  uses the website's canonical hero assets and the privacy-enhanced YouTube
  player, links to GitHub and the docs site, and includes an ADE Mobile
  TestFlight QR/download/copy panel. The Help menu can replay it
  without resetting setup.
- `apps/desktop/src/renderer/public/welcome/` — website-synchronized bundled
  hero screenshots and icon assets consumed by the welcome card.
- `apps/desktop/src/renderer/components/onboarding/HelpMenu.tsx`
  — persistent help menu in the top bar: glossary, docs links, welcome
  video replay, and help preferences. Tour replay entries were removed
  with the guided-tour renderer.
- `apps/desktop/src/renderer/onboarding/docsLinks.ts` — typed registry
  of internal/public doc URLs that `DidYouKnow`, `HelpMenu`, and
  glossary surfaces link to, including the public ADE Relay explainer used by
  account sign-in surfaces.
- `apps/desktop/src/renderer/components/cto/...` — CTO first-run is a
  single lightweight card covering personality and work-style setup.
  Model selection and Linear are deferred to the CTO Settings sheet.

Renderer — settings:

- `apps/desktop/src/renderer/components/app/SettingsPage.tsx` — tab
  container. It renders; it does not decide. Tabs, ordering, deep-link
  resolution, and search all resolve through
  `settings/settingsManifest.ts`, which is also what generates the Cmd-K
  entries. The ten tabs are General, Appearance, Agents & Models,
  Lanes & Git, Integrations, Notifications & Sound, Activity, Secrets,
  Storage & Diagnostics, and Stats. Every tab id ADE has ever shipped in
  a URL still resolves via `LEGACY_TAB_ALIASES`
  (`settingsManifest.test.ts` asserts this); the one exception is
  `keybindings`, dropped because it pointed at a tab with no keybindings
  UI. Welcome video replay and help preferences live under the Help menu
  in the top bar, not as a Settings tab.
- `apps/desktop/src/renderer/components/settings/settingsManifest.ts` —
  the registry. One `SettingEntry` per setting (`id`, `label`,
  `keywords`, `tab`, `anchor`, `scope`, `group`). Add a setting here and
  it becomes navigable, searchable, and deep-linkable at once.
- `apps/desktop/src/renderer/components/settings/primitives/` — the
  control vocabulary (`SettingsCard`, `SettingsGroup`, `ScopeChip`,
  `SettingsToggle` / `Segmented` / `Number` / `Select` / `Slider`,
  `useSavedFlash`). There is **no Save button anywhere in settings**:
  every control persists on change and reports via `SavedFlash`.
  `ScopeChip` (Team / This Mac / This app) is shown only where the
  backing store would surprise — clicking it names the file and who it
  affects.
- `GeneralSection.tsx` and `EnvironmentSection.tsx` were dissolved in the
  IA rewrite — General was a flat stack of 11 unrelated sections, and
  `EnvironmentSection` was App version + ADE CLI (now in General and
  Integrations), not environment variables. `ProxyAndPreviewSection.tsx`
  and `DiagnosticsDashboardSection.tsx` were deleted outright: 1,641
  lines imported by nothing. Legacy deep links:
  `#github-connection`, `#linear-connection`, `#voice-input`,
  `#chat-launch-clipboard`, `#agent-completion-sound`,
  `#auto-updates`, `#pr-chat-transcripts`.
- `apps/desktop/src/renderer/components/settings/AutoUpdatesSection.tsx`
  — Settings > General update policy. Automatic installation is off by
  default, leaving installation under the top-right control. Enabling it
  reveals the default-on **Wait until active work finishes** safety option,
  which delays the restart countdown until no agent turn or work session is
  active.
- `apps/desktop/src/renderer/components/settings/ProductAnalyticsSection.tsx`
  — machine-wide desktop/runtime product-analytics status and durable opt-out.
  It shows the configured/effective state and installation daily ceiling but
  never exposes or accepts credentials. Native iOS is independently default-on
  without an in-app preference; hosted web keeps its own affirmative browser
  choice. See [logging and product analytics](../../logging.md).
- `apps/desktop/src/renderer/components/settings/GitHubIntegrationSection.tsx`
  and `GitHubSection.tsx` — ADE GitHub App / environment / GitHub CLI / PAT
  auth, credential-specific permission diagnostics, structured validation
  failures, and automatic fallback state. Embedded inside Integrations. Classic
  PATs and CLI OAuth tokens show their detected scopes; fine-grained PATs show
  repository-permission guidance; App user tokens show installation-backed
  repository metadata access and never report missing classic `repo` /
  `workflow` scopes, because GitHub Apps do not use those OAuth scopes. The App
  panel states that the App is intentionally read-only and documents the
  environment → App → GitHub CLI → PAT read order plus the write-capable
  subset. Healthy connections do not expose quota bookkeeping. When ADE is
  compensating for a problem, Settings names the paused source and temporary
  replacement, plus the retry time when GitHub supplied one. An exhausted shared
  account bucket renders the reset time and explains that background refresh is
  paused automatically; it never asks the user to re-authenticate. When no
  fallback remains, a missing, invalid, or genuinely under-scoped credential
  shows login/refresh instructions. The App-installation card also classifies relay
  rate-limit responses as a concise cooldown state instead of displaying
  GitHub's raw request-id / scraping-policy error. Raw network/unknown
  validation errors stay in Settings rather than the global banner. The shared
  `renderer/lib/githubIntegrationStatus.ts` presentation helper keeps banner
  and Settings classification aligned. This section also hosts the
  `GitHubAppInstallPanel` (below) for installing "ADE for GitHub".
- `apps/desktop/src/renderer/components/github/GitHubAppInstallPanel.tsx`
  — install / status card for the hosted ADE GitHub App that backs
  webhook-relay PR updates. Reads per-repo installation + webhook state via
  `window.ade.github.getAppInstallationStatus` (which the desktop resolves
  against the hosted relay's `/github/repos/:owner/:repo/status` route using
  a locally stored GitHub App user token from device flow), and links out to the
  App install / manage pages. The card is split into **two honest blocks**, one
  per independent prerequisite for real-time PR updates, both derived through the
  shared `renderer/lib/githubIntegrationStatus.ts` helper so their status pills
  reflect actual state instead of the old always-green permission chips:
  - **Account · ADE for GitHub** — the account-scoped App user token. Hosts the
    "Authorize ADE" device-flow UI: `startAppUserDeviceAuth` surfaces the user
    code as a copyable chip plus a waiting state and the verification URL,
    `pollAppUserDeviceAuth` drives the poll loop and auto-renews an expired code
    up to 3 times, a pre-auth status pill reflects `getAppUserAuthStatus` (stored
    token, signed-in login, expiry). `deriveGithubAccountAuthState` classifies the
    token as `valid` / `expired` / `missing` (expiry is computed client-side with
    a refresh-skew mirror because the service does not surface it).
  - **This repo · `owner/name`** — whether the App is installed on the active
    repo. `deriveGithubRepoConnectionState` maps the installation status to
    `connected` / `not_installed` / `access_pending` / `no_repo` / `unknown`.
    After device authorization succeeds, the panel force-refreshes the hosted
    relay status with a short retry window and treats GitHub repo-access 404s as a
    temporary "Checking access" (`access_pending`) state so App installation
    propagation does not look like failed authorization.

  `clearAppUserAuth` revokes the local token. Offers a Refresh. Rendered in
  Settings and, in a compact `onboarding` variant, during setup. The device-flow,
  token store, and single-flight refresh are backed by `githubAppUserAuthService`
  in the main process (see the automations feature doc's Source file map). The
  matching per-repo "GitHub App not connected" banner — distinct from the gh-CLI
  banner — is rendered by the app-shell `IntegrationBannerHost` from the same
  `githubIntegrationStatus.ts` derivation (see
  [ARCHITECTURE §7.6](../../ARCHITECTURE.md)), so the panel and the banner never
  disagree.
- `apps/desktop/src/renderer/lib/githubIntegrationStatus.ts`
  — pure, two-axis derivation of GitHub App integration health (account
  user-token axis vs. per-repo install axis), the `deriveGithubRealtimeBlock`
  top-blocker picker (account problems outrank repo problems),
  `githubStatusHasWriteCredential` for capability-gating mutations, and the
  shared banner/Settings copy for the account, repo, and gh-CLI/token
  sub-states. Imported by `GitHubAppInstallPanel`, `IntegrationBannerHost`, and
  write surfaces such as `FeedbackReporterModal`; App-only read connectivity
  therefore keeps PR data live while still prompting for GitHub CLI or a PAT
  before a mutation.
- `apps/desktop/src/renderer/components/app/IntegrationBannerHost.tsx` and
  `FeedbackReporterModal.tsx` — consume the shared read/write distinction. The
  app shell raises a write-access banner for an otherwise connected App-only
  status, and feedback submission requires a write-capable credential rather
  than treating read connectivity as sufficient.
- `apps/desktop/src/renderer/components/settings/LinearIntegrationSection.tsx`
  and `LinearSection.tsx` — Linear OAuth / API key, workspace status,
  and GitHub autolink setup. Embedded inside General.
- `apps/desktop/src/renderer/components/settings/PrChatTranscriptsSection.tsx`
  — toggles `prTranscriptGists.enabled` in project local config.
- `apps/desktop/src/renderer/components/settings/AboutSection.tsx`
  — About (version, runtime); rendered in General.
  `AdeCliSection.tsx` is rendered in Integrations. The
  `EnvironmentSection.tsx` wrapper that used to pair them is gone.
- `apps/desktop/src/renderer/components/settings/settingsSectionUi.tsx`
  — shared section headers (`SettingsSectionShell`) and toggle styling.
- `apps/desktop/src/renderer/components/settings/AppearanceSection.tsx`
  — theme, chat appearance, and terminal text. Renders `ChatAppearancePreview`
  and writes local user preferences through `appStore` (font size,
  transcript density, chrome tint, shell geometry, user minimap, and the
  default-on prompt-stash bookmark visibility; hiding the bookmark leaves
  Cmd/Ctrl+S active).
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
  install / health status when available. It consumes the shared
  `useAutoUpdateSnapshot` hook so "Installed" reads truthfully: the running
  build normally, but the staged version when a download is `ready` or
  `parked`, with "Latest" showing `latestKnownVersion`.
- `apps/desktop/src/renderer/components/settings/AdeCliSection.tsx`
  — surfaces `window.ade.adeCli.getStatus()` / `installForUser()`.
  Status carries `terminalInstalled`, `agentPathReady`,
  `bundledAvailable`, and the resolved `installTargetPath` for the
  bundled `ade` binary. In compact form (used by the Integrations tab and
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
  without disarming them; overdue work catches up once after resume. Its
  **Active scheduled work** recovery manager reads the runtime's KV-backed
  durable list across every chat and can cancel one exact job. Provider-owned
  jobs remain visible in their returned paused/pending state until Claude
  confirms deletion, and a load/cancel failure renders explicitly rather than
  being mistaken for an empty list.
- `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx`
  — AI Connections settings, organized into two top-level groups. **Coding
  Agents** renders four provider-CLI cards in fixed order — Claude Code,
  Codex CLI, Cursor, and Droid — each showing readiness/auth tone, credential
  source, and CLI path. Claude offers a `ClaudeLoginPromptButton` when the
  binary is present but signed out; Cursor is the only card with an inline
  `CURSOR_API_KEY` field (Add key stores then verifies). **OpenCode —
  Universal Model Access** is the managed universal-model surface with a
  models.dev "catalog synced … · refresh" freshness control (backed by
  `modelsDevLastFetchedAt` + `refreshModelsDev`) and five sub-sections:
  **Subscriptions** (one card per OpenCode provider whose auth methods
  include an `oauth` entry — Connect opens `OAuthConnectModal` — plus an
  always-present **Kimi for Coding** membership-key row that opens
  `KimiKeyDialog`); **API Provider Keys** (a fixed grid of Anthropic, OpenAI,
  Google AI, Mistral, DeepSeek, xAI, Groq, Together AI, OpenRouter, and
  Moonshot AI, each saved with `alsoOpenCode: true` so the key is registered
  with OpenCode via `setOpencodeProviderKey`); **More Providers** (a
  searchable ~160-provider chip cloud sourced from the OpenCode inventory,
  first 30 shown until the user searches; a keyless chip seeds a provider key
  inline); **Local Model Servers** (LM Studio and Ollama endpoints/preferred
  model, written through `updateConfig({ localProviders })`); and **Advanced —
  custom providers & model slugs** (a collapsed `<details>` that adds
  OpenAI-/Anthropic-compatible custom providers — id, name, baseURL, `npm`
  select, models, optional key — writing `ai.customProviders`, and extra
  `provider/model` slugs writing `ai.customModelSlugs`, both via
  `updateConfig`). When the OpenCode provider inventory is served from the
  persisted disk cache on a cold start, `opencodeProvidersStale` renders an
  italic "updating…" hint until the first live probe. When the OpenCode
  binary is missing the group collapses to an install card.
- `apps/desktop/src/renderer/components/settings/OAuthConnectModal.tsx`
  — subscription OAuth connect dialog for OpenCode providers. Runs a
  `form → starting → waiting → error` phase machine: it renders the
  provider's `oauth` auth-method selection and any typed `text`/`select`
  prompts (respecting a prompt's `when` conditional), calls
  `opencodeOAuthStart({ providerId, methodIndex, inputs })` to open the
  browser, extracts and displays a device code from the returned
  instructions when present, and subscribes to `onOpencodeOAuthStatus` to
  settle on `connected` / `failed` / `timeout` / `cancelled` without polling.
  Cancel, Escape, backdrop click, and unmount-while-active all call
  `opencodeOAuthCancel`. Success force-refreshes status, reloads auth
  methods, and toasts the added-model count.
- `apps/desktop/src/renderer/components/settings/SecretsSection.tsx`
  — Settings > Secrets. Lists project-scoped ADE secrets without values,
  adds/replaces secrets, reveals values on demand, copies them to the
  clipboard, and deletes with inline confirmation. The section can also open a
  local Finder picker for a bounded dotenv file, show the extracted names and
  values in a select-all/individual-selection review modal, atomically import
  the selected rows, and export all secrets as a mode-`0600`
  `ade-secrets.env` file in Downloads. Values are backed by
  `projectSecretService` under `.ade/secrets/project-secrets.v1.enc`. When the
  active project is remote, only the Finder read happens on the controller Mac:
  the bounded file content is parsed/imported by the active runtime and export
  writes to Downloads on the remote project host.
- `apps/desktop/src/renderer/components/settings/SecretsImportEnvModal.tsx`
  — dotenv import review dialog. Displays extracted names and plaintext values,
  marks replacements, supports select all or individual selection, and saves
  only the selected secrets.
- `apps/desktop/src/renderer/components/settings/LaneTemplatesSection.tsx`
  and `LaneBehaviorSection.tsx` — lane initialization recipes and
  lifecycle policies.
- `apps/desktop/src/renderer/components/settings/StorageSection.tsx` plus
  `settings/storage/StorageCleanupDialog.tsx`, `StorageDiagnostics.tsx`,
  `StorageMaintenanceJournal.tsx`, `storageView.ts`, and `storageUiConstants.ts`
  — Settings > Storage. Uses plain language to explain lane cleanup rules,
  automatic safety checks, and the difference between Archive (files stay),
  Archive & Reclaim (lane/branch/chat stay; managed files are removed), and
  Delete. Its review table lists archived lanes, orphaned worktrees,
  DerivedData, and build output with size, age, ownership, blocked reasons, and
  reclaim estimates. Destructive actions are previewed and confirmed. The page
  also renders the current volume-pressure state, category breakdown and policy
  chips; a storage-doctor action; a project-database breakdown card with
  per-row prune/compact actions; the "Health & diagnostics" strip
  (`StorageDiagnostics`, anchored `#diagnostics`); and the collapsible recent-cleanups
  journal (`StorageMaintenanceJournal`). `storageView.ts` holds the pure
  snapshot→cleanup-target mapping (including the explicit `review_first`
  `proof_attachments` target) plus the diagnostics/maintenance view-model
  (unit-tested without a DOM); the dashboard reads `window.ade.storage.*` and
  `window.ade.app.getRuntimeHealth`. The domain lives in
  [Storage and recovery](../storage-and-recovery/README.md), which owns the
  disk-pressure monitor, `storageInsightsService`, and the storage doctor behind
  those IPCs.
- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.tsx`
  — shared multi-device sync management used by the focused
  **Connections > Phone** and **Connections > Web** tabs beneath a shared
  **This Mac** card. The card owns the phone-pairing PIN (set / clear / reveal,
  or generate a new six-digit PIN when only the at-rest hash remains) and the
  internal phone QR encoding the v3 smart pairing URL with LAN / Tailscale /
  loopback / relay candidates. The Phone tab explains QR + PIN and Nearby + PIN,
  while the Web tab is account-sign-in only. It also surfaces the bootstrap
  token for desktop peers, relay/discovery status, and the per-device panels
  used to forget paired phones or revoke web clients.
- `apps/desktop/src/renderer/components/app/TopBar.tsx` and
  `ConnectionsPanel.tsx` — the single top-bar Connections control and its
  Machines, Phone, and Web tabs. The Web tab reports connected browser peers
  and directs signed-out users to account sign-in.
- `apps/desktop/src/renderer/components/usage/HeaderUsageControl.tsx`
  and `UsageQuotaPanel.tsx` — header usage popup. Live provider quotas
  for Claude and Codex (tracked providers) and the automation budget
  guardrails are consolidated here. The header renders one compact
  chip per detected tracked provider with the 5-hour window and the
  plan window (`wk` when a
  weekly window is present, otherwise `mo`). Percent values are clamped
  to 0-100, color through the green/amber/red thresholds at 75% /
  100%, and show an ellipsis while missing. On mount, the button reads
  the cached `ade.usage.getSnapshot` and records quota demand; it does not
  force a provider request. Explicit refresh calls `ade.usage.refresh`, while
  adaptive polling tightens to 60 s under demand and backs off when idle.
  Provider detection comes from `ade.ai.getStatus` on mount and every
  5 min; CLIs not detected on the machine are hidden from the header,
  while installed-but-unauthenticated providers stay visible in the
  panel as "Not signed in". The header and panel subscribe to usage `onUpdate`,
  reject an older snapshot within the same project binding, and clear then
  reload both quota and provider-connection state when the binding changes.
  This keeps the compact percentages and the open panel on the same live
  machine-brain snapshot even across fast project or machine switches. The
  panel drills down into 5-hour, weekly, monthly, and other reset windows with
  explicit source, updated time, stale state, and inline provider errors.
  Claude background polling never prompts Keychain and explicit local refresh
  can fall back from OAuth to a bounded CLI probe. When a non-interactive
  caller cannot authoritatively read Claude credentials, the service preserves
  the previous unexpired windows, provider state, and extra-usage values rather
  than replacing them with a false authentication error. Codex returns
  directly when HTTP supplies complete windows and uses a bounded app-server
  RPC only for auth recovery or a successful but unrecognized response schema.
  Cursor usage polling was removed (it required a team-admin API key that
  desktop users almost never have); only `claude` and `codex` are tracked
  in `TRACKED_PROVIDERS`. Budget
  caps round-trip through `ade.usage.getBudgetConfig` /
  `saveBudgetConfig`. Threshold crossings (25 / 50 / 75 / 100 %) emit
  `UsageThresholdEvent`s for local usage handling.
- `apps/desktop/src/renderer/components/usage/usageSnapshotOrdering.ts` —
  shared ordering guard for the compact header and full quota panel. It accepts
  the first snapshot for a binding and newer/equal poll timestamps, while each
  component explicitly resets the guard when the project binding changes.
- `apps/desktop/src/renderer/components/settings/AdeUsageSection.tsx`
  — Settings > Usage, split into **Limits** and **Activity** tabs. Limits
  renders the same live quota contract as the header without starting a local
  ledger scan. Activity is a sectioned dashboard rather than a single
  carousel. Its header carries two segmented controls — a **scope** toggle (This
  project / This machine, persisted to `ade.stats.scope.v1`, default project)
  and a **range** toggle (Today / 7d / 30d / year / all, default all) — plus
  a Refresh button. Below the header: an **Overview** row of stat tiles (AI tokens,
  estimated cost, code movement, pull requests), an **Activity** section that
  mounts `ActivityModule` (`variant="full"`, `showRangeControl={false}`), and
  a two-panel row of **AI usage** (deduplicated per-provider token totals and
  per-model breakdown, with per-provider estimation notes) and **Code & PRs**
  (GitHub activity and ADE-local activity as separate labeled columns, never
  max-merged). A meta line at the bottom reports freshness ("refreshing"),
  estimation caveats, and which scope the provider totals were computed at.
  It reads `window.ade.usage.getAdeStats({ preset, scope })` and calls
  `window.ade.usage.refreshHistory()` for explicit Activity refresh; the first render is
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
  Live quota polling is adaptive and coalesced, retains unexpired last-good
  provider windows with source/freshness metadata, and stays independent from
  the expensive provider-ledger and GitHub history scans. Runtime-backed
  projects use the machine brain as the single quota owner; the desktop does
  not create a second project-context tracker that could race the runtime event
  stream.
  It returns cached provider/GitHub results and current DB aggregates without
  awaiting expensive scans, exposes freshness metadata (`fresh` / `refreshing`),
  and coalesces stale provider/GitHub revalidation in the background
  (`refreshStatsInBackground`, single-flight per range + source).
- `apps/desktop/src/main/services/usage/providerQuotaParsers.ts` — normalizes
  Claude and Codex live-quota response variants. Codex buckets use their
  advertised duration (minute- or second-based fields) to determine whether a
  window is five-hour, weekly, or monthly; primary/secondary position is only a
  fallback for older payloads that omit duration metadata.
- `apps/desktop/src/main/services/usage/ledgers/localUsageLedgers.ts` —
  read-only provider-history adapters. The Codex path selects recent JSONL
  files within per-file and aggregate byte budgets, discards oversized physical
  records with a bounded byte-stream reader, caps detailed entries, and shares
  one production scan across callers. It reconciles the available JSONL history
  with the newest Codex `state_*.sqlite` thread index under bounded row and
  lookup budgets; a zero-cost all-time-only remainder preserves the exact union
  token headline without fabricating day, project, or cost attribution.
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
Diagnostics are rendered inside `StorageSection.tsx`
(`storage/StorageDiagnostics.tsx`) under Storage & Diagnostics. The
standalone `ProxyAndPreviewSection.tsx` and
`DiagnosticsDashboardSection.tsx` files were imported by nothing and have
been deleted.

Auto-update (General preference, top-bar control, and exceptional recovery
banner):

- `apps/desktop/src/main/services/updates/autoUpdateService.ts` —
  electron-updater wrapper that owns the renderer-visible
  `AutoUpdateSnapshot` (`status: "idle" | "checking" | "downloading"
  | "ready" | "installing" | "error"`, version, progress, recently
  installed notice, plus the `parked` / `lastInstallFailed` /
  `autoApplyPending` / `autoApplySuppressedUntil` fields and `currentVersion` /
  `latestKnownVersion` for the truthful-version surfaces). Tracks superseded
  downloads against the current ready version via `compareUpdateVersions`
  (the SemVer-aware comparator in `autoUpdateVersions.ts` that handles
  `v` prefixes, missing patch, and prerelease ordering) so a same-or-older
  `update-available` while a
  newer build is already staged is logged and ignored instead of
  clobbering the staged installer; packaged builds schedule startup and
  periodic update checks, while dev/source launches leave those timers off
  to avoid surfacing missing-updater-config errors; if the new build is strictly
  newer, the cached installer dir is wiped and the snapshot
  transitions back through `downloading`. `quitAndInstall()` is
  transactional and asynchronous: it gates on the current snapshot being `ready`,
  re-runs `updater.checkForUpdates()` with `allowReady: true` to
  confirm the staged installer is still the latest, and only then
  flips the snapshot to `installing`, persists the
  `pendingInstallUpdate` global-state row, and calls
  `updater.quitAndInstall(false, true)`. If the refresh check fails,
  it surfaces the error, drops the cache, and clears the pending
  install. A consent that aborts before the native updater takes over sets
  `snapshot.parked` with a typed `AutoUpdateInstallAbortReason`
  (`refresh_failed`, `install_preflight_failed`, `prepare_failed`,
  `prepare_timeout`, `handoff_failed`) so the shell banner can offer a retry.
  Once the native handoff starts, a staged quit deadline bounds it: a
  never-fatal slow mark, then either the post-staging bound (armed when
  Electron's own `autoUpdater` reports the OS installer finished staging) or the
  hard bound. Escalation logs `autoUpdate.quit_escalated` with its
  `hard_deadline` / `post_staging` reason, drains the log with
  `logger.flushSync()`, and force-quits. See
  [desktop-auto-update.md](./desktop-auto-update.md) for the numbers.
  Installation remains manual by default even though packaged builds continue
  checking and downloading in the background. The machine-local
  `AutoUpdatePreferences` object enables automatic installation and chooses
  whether it must wait for `RuntimeActivitySummary.idle` (no active agent turns
  or work sessions). Idle-only mode waits through the idle grace period;
  immediate mode starts the same renderer-visible countdown
  (`autoApplyPending`) as soon as the update is ready. An explicit cancel
  suppresses the next countdown (`autoApplySuppressedUntil`), and
  `ADE_DISABLE_AUTO_UPDATE_APPLY=1` remains a process-level kill switch. On the
  next launch, `reconcilePersistedUpdateState`
  matches the running version against `pendingInstallUpdate` using
  the same SemVer comparator (so `>=` target counts as installed,
  even if the running build is one ahead), populates
  `recentlyInstalledUpdate` with the actual running version, and
  cleans up the updater cache directory. A launch that comes back on the *old*
  version instead records `failedInstallAttempts` (target version + consecutive
  count), logs `autoUpdate.install_did_not_land`, captures
  `ade_update_install_did_not_land`, and surfaces `lastInstallFailed`. The
  first such failure keeps the verified download so the retry is a click, not
  another full release download; a second consecutive failure on the same
  version clears the cache. On packaged launches with a
  recently installed update, the desktop refreshes the per-user runtime
  service so `ade serve` re-execs the updated bundled CLI and clients
  do not fall back to an isolated build-mismatch runtime.
- `apps/desktop/src/renderer/components/app/AutoUpdateControl.tsx` —
  the primary update control: a small badge in the app shell top bar. Shows
  "Checking for updates" / "Downloading vX.Y.Z (NN%)" / "Install update
  vX.Y.Z" / "ADE will quit and reopen" depending on the snapshot. When
  `lastInstallFailed` names the staged version, the ready label reads "Retry
  install vX.Y.Z" and the tooltip says whether the download is still on the
  machine. Clicking the
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
- `apps/desktop/src/renderer/components/app/useAutoUpdateSnapshot.ts` — the
  shared subscription hook (initial `updateGetState()` read + live
  `onUpdateEvent`). Every truthful-version surface — the top-bar pill, the
  app-shell banner, and the About panel — consumes it so they never disagree
  about what is running versus what is staged.
- `apps/desktop/src/renderer/components/app/AutoUpdateBanner.tsx` — the
  exceptional app-shell recovery banner plus the automatic-install countdown
  toast, colocated so both read one snapshot subscription. Renders a `parked` state as
  "ADE update didn't finish — Restart to retry" and a failed handoff as "ADE
  update did not install — Restart to retry", each with a **Restart now**
  action. A normally staged `ready` update does not render the wide banner; it
  remains available from the top-right control. Dismissal is keyed on a stable
  failure signature so a fresh abort or failed attempt can reappear. The toast
  reads "ADE will update in Ns", is driven off `autoApplyPending`, and has a
  **Cancel** action wired to `updateCancelAutoApply()`.
- `apps/desktop/src/renderer/components/app/BrainRecoveryNotice.tsx` — the
  app-shell notice shown once per distinct machine-brain event-loop recovery.
  It reads the one-shot `localRuntime.lastWedge` from `app.getInfo()`,
  announces "ADE recovered from a background issue … a stuck task (…) was
  restarted", and acknowledges by persisting the wedge `ts` to `localStorage`
  so the same event never nags twice while a fresh recovery (new `ts`)
  reappears. The wedge itself is produced by the brain event-loop watchdog
  (see [ARCHITECTURE.md §2.1](../../ARCHITECTURE.md) and
  [Storage and recovery](../storage-and-recovery/README.md)).
- `apps/desktop/src/main/services/updates/autoUpdateVersions.ts` — the pure
  SemVer helpers shared by the service and the `ade doctor` CLI:
  `compareUpdateVersions` (core + prerelease ordering, `v`-prefix and
  missing-patch tolerant), `buildReleaseNotesUrl` (the docs changelog link),
  and `buildGithubReleaseUrl` (the tagged GitHub release page).

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

1. Reset pre-account machine trust once in the next packaged release. Before
   attaching to the background runtime, ADE removes only
   `remote-machines.json`, `desktop-paired-machines.json`,
   `sync-paired-devices.json`, and its runtime-host grants sidecar from the
   channel's machine secrets directory. Account sessions, machine/device
   identity, the pairing PIN, bootstrap token, projects, and the user's SSH
   files are preserved. A pending marker is written before the service is
   forcibly restarted and becomes complete only after installation/restart is
   confirmed; if ADE exits early, the next launch retries the restart without
   erasing pairings created after the first attempt. Development launches do
   not run this reset.
2. Bring up the ADE runtime. The pool tries to attach to
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
3. Register the runtime as a per-user login service so it survives
   reboots. `installServiceBestEffort()` runs `ade serve --install-service`
   once per session; the implementation lives in
   `apps/ade-cli/src/serviceManager/` (launchd / systemd / schtasks).
   The result is exposed as `LocalRuntimeStatus.serviceInstall` and
   `serviceHealth` (`unsupported | not_installed | installed | running |
   error | unknown`).
4. Install the `ade` command on `PATH`. The `AdeCliSection` "ADE
   command" card calls `window.ade.adeCli.installForUser()`, which
   delegates to the platform helper script bundled with the desktop
   (`/Applications/ADE.app/Contents/Resources/ade-cli/install-path.sh`
   on macOS, equivalents on other platforms). The compact form embedded
   in the Integrations tab and the onboarding `DevToolsSection` shows the
   current install path, an Install / Repair button, and an "Add to
   PATH" hint when the install target is not on the user's `$PATH`.
5. Register projects with the runtime. Opening a project on desktop
   calls `LocalRuntimeConnectionPool.ensureProject(rootPath)`, which
   issues `projects.add { rootPath }` against the daemon. The project
   then appears in `projects.list` to every other client (`ade code`,
   iOS, SSH-attached desktops) without an extra step.

### Project layer (per project)

Repository onboarding covers five things:

1. detect dev tools (git, gh CLI) and report availability
2. detect stack signals (node, rust, go, python, docker, make)
3. suggest test, automation, and provider config defaults
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
| General | `ProjectSection.tsx`, `LaunchPromptSection.tsx`, `AutoUpdatesSection.tsx`, `ProductAnalyticsSection.tsx`, `AboutSection.tsx` | Project identity, launch behavior, updates, privacy, and version info. Legacy `?tab=workspace`, `?tab=project`, `?tab=context`, `?tab=onboarding`, `?tab=help`, and `?tab=tours` land here. |
| Appearance | `AppearanceSection.tsx` (renders `ChatAppearancePreview`) | Theme, chat typography and density, chat surface (tint, corners), chat details (copy-button position, message minimap, prompt-stash bookmark, live preview), and terminal text. Rebuilt on the primitives — the old version used `font-mono` for every prose line and four different control idioms. Persisted to `localStorage` under `ade.userPreferences.v1`. |
| Agents & Models | `ProvidersSection.tsx`, `OAuthConnectModal.tsx`, `AiFeaturesSection.tsx`, `BudgetCapEditor.tsx`, `DictationSection.tsx` | Provider connections, model routing, background helpers, spend cap, and voice input — merged because provider auth and per-task model routing are one mental model. **Coding Agents** cards (Claude Code, Codex CLI, Cursor, Droid) and **OpenCode — Universal Model Access**. Background helpers cover summaries, PR descriptions, commit messages, auto-naming, and scheduled-work recovery. Legacy `?tab=ai`, `?tab=providers`, `?tab=background-jobs`, and `?tab=automations` land here. |
| Lanes & Git | `LaneBehaviorSection.tsx`, `LaneTemplatesSection.tsx`, `PrChatTranscriptsSection.tsx` | How lanes start (`new lane base`), stay current (`auto-rebase`), and tell you they fell behind (`rebase suggestions` off/badge/banner + min-behind threshold), plus lane init recipes and PR transcript gists. Legacy `?tab=lane-templates` lands here. |
| Integrations | `GitHubIntegrationSection.tsx`, `LinearIntegrationSection.tsx`, `AdeCliSection.tsx` | GitHub, Linear, and the `ade` command line — reinstated as its own tab. Legacy `?tab=integrations`, `?tab=github`, and `?tab=linear` land here, as does `?integration=github|linear|cli`. |
| Notifications & Sound | `NotificationsSection.tsx`, `AgentCompletionSoundSection.tsx` | Delivery for `AttentionPreferences`: per-event policy (off / ambient / notify) for agent and PR events, quiet hours, focus suppression, phone delivery and escalation, the agent completion sound, and the Lanes banner budget. The per-event matrix and quiet hours were fully modelled with balanced defaults but had **no UI at all** before this tab. |
| Activity | `ActivitySection.tsx`, `ActivitySettingsControls.tsx` | The surfaces Activity itself paints: the ADE notch (enabled, reveal mode, expanded panel), celebrations, Activity sounds, hide-previews, and the per-machine notification mute. `ActivitySettingsControls` is mounted here **and** by the gear inside the Activity popover and pane, so the two entry points cannot drift. Legacy `?tab=attention` plus the `#attention-notch`, `#celebrations`, `#attention-sounds`, and `#hide-previews` hashes land here. |
| Secrets | `SecretsSection.tsx` | Encrypted key/value pairs for agents, desktop, and the CLI, with `.env` import. Legacy `?tab=secret` lands here. |
| Storage & Diagnostics | `StorageSection.tsx`, `storage/*`, `SessionLifecycleSection.tsx` | Disk-usage and lane-storage dashboard, lane storage rules, session lifecycle, and diagnostics. Rule fields now show the value actually in force with an explicit "Inherited" marker instead of an empty box whose real value hid in the placeholder. Legacy `?tab=disk` and `?tab=diagnostics` land here. See [Storage and recovery](../storage-and-recovery/README.md). |
| Stats | `AdeUsageSection.tsx`, `ActivityModule.tsx`, `providerColors.ts` | Usage page with live Limits plus a sectioned Activity dashboard. Legacy `?tab=usage` and `?tab=ade-usage` land here. |

> Live provider quota windows and automation guardrails live in the top-bar Usage popup (`HeaderUsageControl.tsx` → `UsageQuotaPanel.tsx` + collapsible `BudgetCapEditor`) and Settings > Usage > Limits. The Activity tab is the retrospective cross-client dashboard.


Legacy deep links are forwarded by `LEGACY_TAB_ALIASES` /
`LEGACY_HASH_ALIASES` in `settingsManifest.ts` (previously `TAB_ALIASES`
and `HASH_TARGET_SECTIONS` in `SettingsPage.tsx`). A legacy route that
silently resolves to the wrong page is invisible in review, so
`settingsManifest.test.ts` asserts that every tab id ADE has shipped
still resolves and that every hash alias points at a live entry.

Settings search lives in the content header and filters cards in place
via the `data-settings-anchor` each card carries; a group whose cards all
filter out hides its heading too. Cmd-K entries are generated from the
same manifest — one per tab plus one per setting — so searching "rebase"
surfaces *Auto-rebase child lanes — Lanes & Git* and lands on that card.

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
  machine-specific paths, and personal env. Both are merged into
  `effective`.
- **Trust boundary.** `projectConfigService.getExecutableConfig` gates
  on trust before returning a config that can spawn processes. Callers
  that skip trust (`{ skipTrust: true }`) do so only after trust has
  been confirmed in the same session.
- **Config reload.** On save, dependent services receive reload
  callbacks (the config service iterates listeners). A hot reload is
  best-effort — some changes only take full effect on app restart
  (e.g. proxy port changes).
- **New `ai.*` config fields need both `coerceAiConfig` and
  `mergeAiConfig`.** A field added to only one of `projectConfigService`'s
  two functions is silently dropped (it fails to load off disk, or fails
  to survive the shared+local merge). This bit `ai.customProviders` /
  `ai.customModelSlugs` written by the AI Connections **Advanced** block.
  Both use replace semantics rather than the id-matched merges used
  elsewhere — the UI writes the full authoritative list. See
  [configuration-schema.md](./configuration-schema.md#custom-providers-and-model-slugs).
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
- **A parked install is not a failure.** An aborted consent lands in
  `snapshot.parked`, not `error` — the download is still staged and the shell
  banner offers a **Restart now** retry. Keep parked distinct from the disk /
  network / verification error classification, and let a parked state win over a
  plain `ready` state when both describe the same version.
- **Idle auto-apply needs the runtime activity summary.** Auto-apply only arms
  when the service can read `RuntimeActivitySummary.idle` and the machine has
  been continuously idle for the grace period; renewed activity clears the
  countdown, and an explicit cancel sets `autoApplySuppressedUntil`. It is off
  under `ADE_DISABLE_AUTO_UPDATE_APPLY=1` and on dev/source launches that have no
  auto-check timers.

## Cross-links

- Lane templates used during lane creation: Lanes feature
- Terminal preferences applied at runtime:
  [../terminals-and-sessions/ui-surfaces.md](../terminals-and-sessions/ui-surfaces.md)
