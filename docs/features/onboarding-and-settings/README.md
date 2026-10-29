# Onboarding and Settings

Two related but distinct flows:

- **Onboarding** — the fastest path to a usable installation and a usable
  project. Covers registering the project with the runtime so every client
  (desktop, `ade code`, iOS) sees it. Opening or creating a project lands on
  Work immediately; AI runtimes, GitHub, and Linear live in Settings. There is
  no blocking project setup dashboard.
- **Settings** — long-lived configuration organized by tab. Project
  configuration persists to `.ade/local.yaml` through `projectConfigService`
  (the committed `.ade/ade.yaml` is retired); machine-level desktop preferences
  such as automatic update installation persist in the Electron user-data
  `ade-state.json`.

ADE account identity is required for a fresh launch on every client. The
desktop, `ade code`, CLI, hosted web client, and iOS gate account-backed
surfaces on the signed-in account; a lost or unreadable session is reported as
its actual state rather than being treated as an optional guest account.

The runtime no longer assumes first-run setup must hydrate every
service. Project open favors a cheap first pass; secondary hydration
(full lane status and provider modes) happens after the app is
interactive.

## Where state lives

ADE state is split between the per-machine runtime root and per-project
directories. Onboarding writes to both.

| Scope | Location | Owner | Contents |
|---|---|---|---|
| Machine | `~/.ade/` (`ADE_HOME` overrides; channel builds use `~/.ade-alpha/` / `~/.ade-beta/`) | ADE runtime (`ade serve`) | Runtime endpoint (`sock/ade.sock`), project registry (`projects.json`), provider-account registry (`provider-instances.json`) and the config homes it names (`provider-homes/<provider>/<id>/`), encrypted credential store (`secrets/`), bundled binary (`bin/ade`), native runtime deps (`runtime/<arch>/`), service log files. |
| Desktop installation | `<Electron userData>/ade-state.json` | Desktop main process | Recent projects, update handoff/reconciliation state, and machine-local automatic-install preferences. |
| Project (local) | `<project>/.ade/local.yaml` | `projectConfigService` | Per-user, gitignored overrides for ports, env vars, and machine-specific paths. |
| Project (data) | `<project>/.ade/` | various services | Lanes, attachments, kvDb, generated assets. The shared `.ade/.gitignore` whitelists only authored files. |

The ADE runtime is the seam that ties machine and project scope
together: it owns `~/.ade/projects.json`, lazily builds an `AdeRuntime`
per project root on first project-scoped JSON-RPC call, and is the
single runtime through which desktop, `ade code`, and SSH-attached
desktops see live lanes, agent chats, and work sessions.

The desktop app, the brain, the `ade` CLI and a project move all write
`projects.json`. Each write (`ProjectRegistry.mutate`) holds
`projects.json.lock`, reads the file fresh, and appends one line to
`projects.journal.jsonl` (`projectRegistryJournal.ts`), so two writers that
overlap no longer erase each other's projects. A project id is the hash of its
folder as this machine resolves it on each read; when that differs from the
stored id, the stored id becomes an alias in `project-aliases.json`, as after a
move, and the change is reported to Sentry.

Each local project this machine has opened gets an identity file at
`~/.ade/project-data/<projectId>.json` holding its database file's device and
inode. The desktop, the brain's project scope and the CLI record it when they
open the database. It lives outside `projects.json` because an
older ADE that rewrites that file drops fields it does not know. If a
registered project's folder or its `.ade` folder disappears, or a database the
identity file records is missing, registration and open stop with
`project_data_missing` before creating replacement state, and the desktop shows
the project recovery screen (`data_missing`): Restore from Trash (when the
folder is there), steps to put it back by hand (the screen reopens the project
when it returns), or Start fresh. When the project folder itself is gone it
offers neither, and says to plug the drive in or move the folder back. Start
fresh and removing a project from recents forget the identity. Fresh project
registration still creates its first database normally.

## Source file map

Main process:

- `apps/desktop/src/main/main.ts`,
  `apps/desktop/src/main/services/ipc/registerIpc.ts` — packaged-launch machine
  trust reset plus the process-local account launch-gate state exposed through
  `ade.app.getLaunchGateState` / `ade.app.resolveLaunchGate`. Resolving the gate
  applies to every window and renderer reload in that desktop process; a fresh
  signed-out launch requires account sign-in again.
- `apps/desktop/src/main/services/runtime/machineTrustResetMigration.ts` —
  one-release, packaged-build reset of saved machine connection grants. It
  clears only remote targets, desktop paired-machine credentials, mobile/web
  pairing records, and runtime-host grants, then forces the background service
  to restart before committing the migration marker.
- `apps/desktop/src/renderer/components/settings/SettingsMachinesNav.tsx` and
  `SettingsMachineScope.tsx` — the per-machine Settings navigation and its
  explicit current/pinned runtime target. `projectMachines.ts` supplies the
  shared machine list; local-only and bound-runtime sections are gated to the
  machine that can reach them. `useSettingsMachinePage` keeps each page's `pin`
  identity stable until the machine's binding key changes, so a section's
  effects do not re-run (and cancel an in-flight provider sign-in) on every
  cross-machine sync tick — the scope's `pin` is the machine identity a section
  keys its runtime effects on, not a value to rebuild per render.
- `apps/desktop/src/renderer/components/settings/overview/SettingsOverview.tsx`
  and `overview/useNeedsAttention.ts` — Overview's area cards and aggregated
  attention list. A failed source read adds a "couldn't check" row with Check
  again; a capability missing on an older build is simply absent.
- `apps/desktop/src/renderer/components/settings/lanes/LanesSettingsPage.tsx`
  and `lanes/LaneList.tsx` — Project → Lanes (Your lanes, Rules) and Project →
  Storage & cleanup (Space, Archive, Rules), one view at a time; the web client
  shows only the Rules and Archive views, and a page left with one view drops
  its tab strip. Hash links and Settings search switch to the view containing
  a card. Project → Agents (Agent notes, PR chat transcripts) is a plain
  section list in `settingsTabContent.tsx`.
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — project-move start
  forwards `copyDependencies`; disk pressure falls back to this computer's ADE
  storage root when no local project monitor is available.
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
  analytics identity. `accountAuthService` also owns the four-value
  `sessionState`, the mark-dead-not-delete rejection markers, the attributed
  `account.session_mutation` audit line, and
  `accountSessionRetainsMachineOwnership` — see
  [Account session state](#account-session-state-is-a-four-state-not-a-boolean).
  `accountBridge.ts` mirrors `sessionState` onto `AdeAccountStatus` for the
  renderer, deriving it from the older `sessionReadState` when the runtime does
  not report one.
- `apps/ade-cli/src/services/account/accountSettingsStore.ts`,
  `accountVaultStore.ts`, and `accountCacheStore.ts` — the four-scope,
  owner-tagged account settings cache and encrypted account-vault cache.
  Settings are non-secret and survive sign-out; vault credentials are encrypted,
  purged at deliberate sign-out or account switch, and never exposed through
  the renderer settings bridge. Both stores keep local reads immediate while
  the brain and Worker remain the account authority. A sync pulls every
  truncated page before it reports ready, and it drops uploaded write seqs
  even when a later delete cannot be sent. A cache write that cannot hit
  disk rolls the in-memory mutation back and reports failure rather than
  pretending the value is saved. Renderer preferences that already exist
  locally are uploaded after a successful Worker sync when the account still
  has no row for them. A cold empty cache does not seed, because that cache
  has not merged the Worker yet. Vault writes that fail while the brain is
  down retry a few times on an unref'd timer.
- `apps/desktop/src/main/services/account/accountMigrationRunner.ts` and
  `apps/ade-cli/src/services/account/accountMigrationReceipt.ts` — silent,
  receipt-backed sign-in migration and hydration for provider API keys, Linear
  OAuth refresh credentials, and repository-scoped project secrets. A source is
  marked complete only after the account confirms the write; crashes and
  unavailable contexts leave it pending, and a later vault-ready tick retries
  those pending sources.
- `apps/ade-cli/src/services/account/sharedAccountAuthService.ts`,
  `cliRefreshBroker.ts`, and `apps/desktop/src/main/services/account/accountBridge.ts` —
  the brain-owned refresh broker used by desktop, CLI, and ADE Code; a
  non-brain local exchange is only the explicit unavailable-brain fallback.
- `apps/ade-cli/src/services/account/accountSessionRotationJournal.ts` — the
  crash-safe refresh-rotation journal (`account.session.rotation.v1`), kept in
  the same file-backed credential bucket as the session it describes so the
  brain, the CLI, and the desktop all see an interrupted rotation. `tryBegin`
  compare-and-swaps that entry so a live peer's in-flight Clerk refresh is a
  mutex, not a race.
- `apps/ade-cli/src/services/power/brainKeepAwakeService.ts` — the brain-owned
  keep-awake preference and turn-following lock. The desktop helper in
  `apps/desktop/src/main/services/power/keepAwakeService.ts` handles the local
  macOS authorization prompt and is an in-process fallback only when an older
  brain does not expose the new action; `systemSleepConfig.ts` reads and fixes
  the OS's idle-sleep timer. See [Keeping the machine awake](#keeping-the-machine-awake).
- `apps/desktop/src/shared/types/keepAwake.ts` — `KeepAwakeLevel`,
  `KeepAwakeSnapshot`, `normalizeKeepAwakePreferences` (anything unrecognized
  degrades to `never` — an unreadable preference must never be read as "hold the
  lock"), `systemSleepStopsAgents`, and the frozen `INERT_KEEP_AWAKE_SNAPSHOT`
  shared by every surface that holds no lock.
- `apps/desktop/src/renderer/components/settings/KeepAwakeSection.tsx` — the
  radiogroup, the "This Mac can still sleep" recovery alert, and the
  system-sleep fix card.
- `apps/desktop/src/renderer/components/settings/BackgroundServiceSection.tsx`
  — General → ADE → Background service: whether the service or the desktop is
  running agents, the working chats in open projects (and a "may also be
  running" note when the service reports busy projects that are not open),
  "Stop and quit ADE", and the "Ask before quitting" toggle that undoes the quit
  prompt's "Don't ask again". Stop confirms with the chat list and fails
  closed in `services/runtime/backgroundServiceControls.ts`: it refuses when
  ADE cannot read what is running, when an agent started after the
  confirmation, during a lane delete, and during any Repair. Packaged builds
  only; a dev build shows the status without the button.
- `apps/desktop/src/main/services/runtime/quitPrompt.ts` +
  `apps/desktop/src/renderer/components/app/QuitPromptHost.tsx` +
  `apps/desktop/src/shared/quitPromptModel.ts` — the quit and restart
  confirmation, in ADE's own dialog with a native fallback built from the same
  model. See `docs/ARCHITECTURE.md` (shutdown pipeline).
- `apps/desktop/src/main/services/archive/archiveService.ts` — the archive:
  `list`/`summary` read archived lanes (from `laneService.list`) and archived
  chats/shells (from `terminal_sessions.archived_at`), and `restore`/`delete`
  run one item at a time so a bad ref reports its own failure. Delete keeps a
  lane's branch (`deleteBranch: false`) and forwards `force` only when the
  caller sent it; a dirty lane is refused, not discarded, without it. Delete is
  user-only and restore CTO-only (`ADE_ACTION_USER_ONLY` / `ADE_ACTION_CTO_ONLY`
  in `adeActions/actionPolicy.ts`), so no agent or automation can reach them.
- `apps/desktop/src/shared/archive.ts` and `shared/types/archive.ts` — the one
  archive vocabulary (kinds, stale threshold, labels, `isArchiveStale`) shared
  by the service, the Settings page, the reminder, ADE Code, and `ade archive`.
- `apps/desktop/src/renderer/components/settings/ArchiveSection.tsx` — the
  Project → Storage & cleanup → Archive page: the list split at the two-week line, the
  selection bar, restore, and delete. Deleting batches non-lane items together
  and at most five lanes per request, then offers a single forced retry by name
  for lanes with uncommitted changes.
- `apps/desktop/src/renderer/components/app/useArchiveReminderBanner.tsx` — the
  weekly docked reminder. It asks at most once per project per
  `ARCHIVE_REMINDER_INTERVAL_MS` (a week) when something is
  `DEFAULT_ARCHIVE_STALE_DAYS` (14 days) old, and a summary read that lands
  after the person snoozed is dropped rather than re-shown.
- `apps/ade-cli/src/services/providerInstances/providerInstanceStore.ts` — this
  machine's provider accounts (Claude and Codex only): the plain-JSON registry,
  the always-present base account whose `configHome` is recomputed on every read,
  default selection, `resolve(provider, requestedId)` used by every launch path,
  and the per-provider settings (smart balance, auto-start windows). Backs the
  `provider_instances.*` action domain and `ade providers accounts`.
- `apps/desktop/src/main/services/providerAccounts/` — the in-app sign-in.
  `providerLoginRunner.ts` runs a provider's own login command for one
  account's config home in a private node-pty, reads the sign-in link and any
  code prompt from its output, and verifies the saved login when the CLI exits;
  it is the only place that reads a login's raw output, and it never creates a
  terminal session or Work row. `machineProviderLoginRunner.ts` is the one
  runner per machine, shared by local IPC and the pinned `provider_instances`
  actions. `refreshProviderAccounts.ts` re-reads a provider's accounts (and one
  named account's saved login) after a sign-in.
- `apps/desktop/src/shared/types/providerInstances.ts` — the shared provider,
  account, environment-key, and per-provider-settings contracts used by the
  registry, IPC, renderer, and CLI action surface. It also carries the
  `ProviderLoginStatus` shape the sign-in sheet polls.
- `apps/desktop/src/shared/types/apiCredentials.ts` — secret-free credential
  summaries for the stored-key panel and harness launch catalog; values are
  represented by provider, id, label, source, and masked tail rather than the
  secret itself.
- `apps/desktop/src/shared/types/subscriptionProxy.ts` — the public proxy
  status and provider-route contracts shared by the desktop and CLI surfaces;
  they intentionally contain no proxy credentials.
- `apps/desktop/src/shared/types/machineInventory.ts` — token-free account and
  harness summaries published to paired machines, with detail expansion kept
  behind the already-connected peer path.
- `apps/desktop/src/shared/safeIdentifier.ts` — the containment rule every
  ADE-owned id must pass before it becomes a path or storage-key segment, so an
  account, preset or credential id cannot escape the directory ADE owns.
- `apps/desktop/src/shared/providerColors.ts` — the one provider colour table
  (usage light/dark pairs, picker badge tokens), so a second hex map cannot
  drift from the iOS mirror.
- `apps/desktop/src/main/services/account/accountMachineInventoryLiveRefresh.ts`
  — live detail for one account-directory machine row. Asks only machines
  already online and already connected in the paired pool, so expanding a row
  never creates a pairing or spends a reconnect attempt; the durable directory
  summary stays the floor.
- `apps/desktop/src/renderer/components/settings/providers/accounts/` — the
  Accounts panel: the routing strip, account cards with name, badges and the
  usage popover's `UsageAccountRow`, the ⋯ menu, the copy and replaced-login
  states, the three-step Add-account sheet driven by the host's login runner,
  and `useProviderInstances`.
- `apps/desktop/src/renderer/components/settings/providers/ProviderDetailPage.tsx`,
  `ProviderHero.tsx`, `providerBrand.tsx`, `providerPage.css`, `banners/` — one
  provider's page: the branded banner (the provider's art or gradient, its logo
  in 3D, status, version, and this machine's 30-day usage from
  `usage.getAdeStats`), the Accounts panel under it, then two columns.
  `providerBrand.tsx` is the one table of each provider's accent, banner and
  logo (`solid` for a shaped mark, `tile` for a square one).
- `apps/desktop/src/renderer/components/settings/providers/ProviderContextPanel.tsx`
  — the **Initial context window** card (see below).
- `apps/desktop/src/main/services/ai/providerContextInventory.ts` and
  `ai/providerContext/` — the read-only `ai.getProviderContextInventory`
  action: one table of providers (`PROVIDER_CONTEXT_SPECS`), the generic
  scanners (`items.ts`, `fsScan.ts`), one file per provider under
  `providers/`, ADE's own parts (`adeItems.ts`, from
  `agentChatService.previewNewChatAdeContext` and
  `chat/adeChatContextPreview.ts`), and the measured first turn
  (`firstTurnMeasurement.ts`). `ai/providerContextReveal.ts` is the allowlist
  of its "Show in Finder" button.
- `apps/desktop/src/renderer/components/settings/providers/keys/` — the stored
  API keys panel, the add-key sheet (only the fields a harness actually has),
  the OpenCode custom-provider panel, and `useApiCredentials`.
- `apps/ade-cli/src/services/proxy/` — the local subscription proxy behind
  `ade proxy` and the `proxy.*` actions: hash-verified release download,
  install/config management (config written 0600, state carries no secrets),
  the start/stop/health supervisor, and the shared provider vocabulary.
- `apps/desktop/src/renderer/components/settings/CaptureGestureSection.tsx` —
  the capture-gesture switch plus the native helper's health line and its
  retry. Reads `supportsCaptureGesturePlatform()` / `captureGestureBlocker()`
  from `renderer/lib/platform.ts`, which wrap the shared
  `captureGesturePlatformSupport` rules.
- `apps/desktop/src/main/services/onboarding/onboardingService.ts` —
  status, stack detection, existing lane detection, and suggested config
  application. The active renderer
  no longer mounts guided tours.
- `apps/desktop/src/main/services/tools/agentToolsCacheService.ts` — the
  desktop half of the pinned agent-tools cache. Kicks a coalesced ensure of the
  tools this machine uses (`agentToolDemand.ts`) on packaged launch, one
  `ensureTools` call per tool so a single failure cannot abandon the rest, GCs
  superseded versions only after a fully clean pass, and keeps an
  `AgentToolsCacheSnapshot` (per-tool status, percent, typed `errorKind`) over
  IPC. Resolution failures are per tool, never per pass. Other tools download on
  demand (`onDemand.ts`). See
  [agent-tools-cache.md](./agent-tools-cache.md).
- `apps/desktop/src/main/services/onboarding/onboardingSuggestedConfig.ts` —
  pure GitHub Actions workflow parsing and suggested test/automation/provider
  config generation for `.ade/local.yaml`.
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
  permission denial, GitHub's own 5xx (`service_unavailable`), network failures,
  and unknown validation errors so clients do not flatten every failed probe
  into missing permissions. `service_unavailable` gets no credential cooldown,
  because the credential is not the problem and must stay usable the instant
  GitHub recovers.
  `GitHubStatus.credentialStoreUnreadable` is carried on the credential
  inventory (cached with it for 30 s) rather than re-read at status time, so the
  readability verdict always belongs to the read that produced that inventory's
  candidates. The service holds it sticky across reads and warns
  `github.credential_store_unreadable` — with the store's own failure reason —
  once per transition into unreadable rather than on every cached refresh; a
  successful token write clears it, because a write that landed re-sealed the
  store under a key this process holds.
- `apps/desktop/src/main/services/github/credentialReadState.ts` — returns a
  credential *and* whether the store was readable in one call
  (`readCredentialWithState` / `readCredentialWithStateAsync`). An undecryptable
  store returns an empty view instead of throwing, so "no token" and "a token
  ADE cannot read" are the same answer, and only the store's
  `getLastReadState()` separates them — and that method describes the store's
  most recent read, so it has to be consulted immediately after the `getSync` it
  is being asked about. Pairing the two in one helper is what makes that
  ordering impossible to get wrong. A store that throws counts as unreadable
  too: the Electron `safeStorage` store reports decrypt failures that way rather
  than by returning `{}`.
- `apps/desktop/src/shared/githubServiceHealth.ts` and
  `apps/desktop/src/main/services/github/githubStatusPage.ts` — telling a GitHub
  outage apart from a broken credential. The shared module parses
  githubstatus.com's Statuspage `summary.json` into `GitHubServiceHealth` and
  exposes `isGithubServiceUnavailable`; it counts only components ADE actually
  uses (API Requests, Pull Requests, Issues, Actions, Webhooks, Git Operations),
  so a Copilot or Codespaces outage never becomes an ADE claim. The main-process
  module is failure-triggered and never polls: it runs only after a GitHub
  request already failed, caches results (including negative ones) for 60 s,
  times out at 2 s, and fails silent. `attachGitHubServiceHealth` populates
  `GitHubStatus.serviceHealth` and is applied in both `getStatus` owners.
  Attribution is one-directional — a corroborated incident clears the user of
  blame, while a healthy status page never implies the opposite, because the
  page lags real incidents by 10-20 minutes. See
  [pull requests](../pull-requests/README.md#telling-a-github-outage-apart-from-a-broken-credential).
- `apps/desktop/src/shared/githubOperationCredential.ts` — the capability-aware
  read/write credential order, App read-only rule, and duplicate-token removal
  used by desktop and runtime-side GitHub services. A `service_unavailable`
  probe stops the credential walk instead of retrying every candidate against a
  service that is already failing.
- `apps/ade-cli/src/headlessLinearServices.ts` — runtime-owned mirror of the
  GitHub request/status path. It applies the same candidate order, cooldowns,
  GraphQL classification, conditional-request cache isolation, read/write
  status fields, and githubstatus.com corroboration when a packaged or
  remote-bound window uses `ade serve`. It reads its stored tokens through the
  same `credentialReadState.ts` helpers the desktop service uses and reports
  `credentialStoreUnreadable` on its own status and inventory, because an
  undecryptable store returns an empty view rather than throwing — without it a
  remote runtime describes a corrupted store exactly as it describes a fresh
  install. The renderer reaches GitHub through whichever service owns the
  project, so anything applied to only one of the two `getStatus`
  implementations is dead in the shipping runtime-backed build.
- `apps/desktop/src/main/services/config/projectConfigService.ts` —
  YAML config read/merge/save, AI mode migration, lane env init,
  Linear sync resolver. ~3,150 lines, the largest service. The parsed
  `local.yaml` is cached keyed by the file's identity (inode, size, mtime and
  ctime of `local.yaml` and the legacy `ade.yaml`), because a chat list asks
  for a snapshot per session row. Validation still runs on every read — it
  checks paths the config names, which change without the file — and the
  `test_suites` snapshot is rewritten only when the file changed or validation
  first passes.
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
  `credentialStates`, `credentialFallback`, `credentialStoreUnreadable`,
  `backgroundRefreshPausedUntil`, and `serviceHealth` are optional so a newer
  client remains compatible with an older remote runtime, which simply omits
  them. The same module owns `GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY` — the
  single wording for the unreadable case, shared by the Settings card, the
  integration banner, the PR tab's main-process empty state, and the
  Publish-to-GitHub dialog — which, in this state, drops the token field
  entirely and offers only **Open connections**, because saving a token would
  overwrite a sign-in that repair can still recover. It lives beside
  the field rather than in a renderer helper because the main process needs it
  too, and two hand-kept copies of one sentence is how the "not connected"
  masking survived in more than one place.
- `apps/desktop/src/shared/ipc.ts` — channels:
  - `ade.onboarding.*` (status, detectDefaults, applySuggestedConfig,
    complete, setDismissed)
  - `ade.projectConfig.*` (get, validate, save, diffAgainstDisk, export)
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
  — projectless home and project-picker surface. The page is a fixed dashboard
  over the window backdrop: a hero line (`ProjectWelcomeHome.tsx`) with a
  greeting, the date, a one-line headline (`home/homeHeadline.ts`) and running /
  needs-you counts, over a row of actions (**Add project**, **Chat without a
  project**, **Browser**, and the recents side panel), above the widget grid.
  Recents list recent local and remote projects, open or forget entries, and
  launch project creation, clone, or folder selection before a project-bound
  route is available. Each row carries the same right-click project menu as a
  project tab — change icon, clone to this machine, pin or unpin, and copy path
  — and a project with no checkout on this machine offers **Clone locally**.
  `projectMenuEntries.ts` holds the rows both surfaces share. A **Settings**
  button sets the app-store flag `standaloneSettingsOpen` and navigates to
  `/settings`, so a person with no project can still reach the settings that
  need none (see "Settings with no project" below).
- `apps/desktop/src/renderer/components/home/` — the widget home. The user
  picks widgets (Projects, Working now, Activity, Limits, PRs, Clock & weather,
  Focus timer, Clipboard, Machine, Contributions, Shipped, Feed, Now Playing),
  a size class for each and an order; `homeGridPack.ts` fits them to the window
  with no scrolling and no gaps (smaller classes before hiding), and
  `homeLayout.ts` keeps named layouts per computer in localStorage (a second
  window follows the first's saves). The shipped stack is Pull requests with
  Contributions under it, then Projects with Working now under it, and Clock &
  weather beside them; a build that changes it carries a new
  `HOME_DEFAULT_STACK_VERSION`, and the next launch puts the new stack in as
  the "Default" layout and shows it once, for every computer, keeping the
  layouts the user saved themselves in the switcher (the version is written
  down then, so it never happens twice). `HomeWidgetPicker.tsx` is the Add
  widget gallery (live, inert previews that read nothing), `HomeEditTools.tsx`
  the edit chrome, `homeFeed.ts` the feed and "while you were away", and
  `widgets/` one file per widget. The main-process half is
  `apps/desktop/src/main/services/home/` (clipboard history, machine health and
  ports, weather, Now Playing, share images) behind `ade.home.*`. Design and
  rules: `docs/plans/ade-dev-home.md` section 4.
- `apps/desktop/src/renderer/components/projects/ProjectWelcomeHome.tsx` —
  the home dashboard's hero, and the card bodies the default widgets render
  (`RunningCard`, `ActivityUsageCard`, `LimitsMachinesCard`,
  `PullRequestsCard`). Each answers one question at a glance and links to the
  full surface instead of listing everything. The PR card reads the same GitHub
  snapshot the PRs tab reads (through `prReadCache`) and joins it to ADE's
  tracked PRs for checks and review state, reloading on PR events and window
  focus, never on a timer of its own.
- `apps/desktop/src/renderer/components/projects/CreateProjectForm.tsx`
  — name plus a first-class location row (default parent, Change folder,
  editable path). Create opens Work; it does not show a success interstitial
  or the removed project-setup dashboard.
- `apps/desktop/src/renderer/components/onboarding/OnboardingBootstrap.tsx`
  — top-level passive help mount. It renders the one-time ADE welcome
  video gate; guided per-tab tours, the old welcome wizard, and the
  `DidYouKnow` hint toast were removed with their renderer surfaces.
- `apps/desktop/src/renderer/components/onboarding/LaunchGate.tsx`
  — process-launch gate. New installations show the welcome card before
  sign-in; returning signed-out launches show sign-in directly. ADE requires
  an account, so what the gate offers beside sign-in depends on
  `accountGateMode`: a machine that has never held a session is `required`
  and gets no pass-through, while a session that expired or became unreadable
  is `recoverable` and always offers **Continue to your work**. Local work is
  never blocked; `AccountSignedOutBanner` carries the nagging instead. The
  signed-out surface also keeps a short ADE Relay requirement link. Its
  top strip is draggable even though the normal shell header is not mounted.
  Renderer reloads or extra windows in the same desktop process do not repeat
  the gate. Directly paired machines stay saved across account sign-out;
  account-directory targets and their paired credentials are owner-tagged and
  removed with that account.
- `apps/desktop/src/renderer/components/onboarding/GlassSignInCard.tsx` and
  `components/account/useSignInFlow.ts` — the launch gate's sign-in. The card is
  a frosted glass panel floating over the window backdrop (styled by
  `onboarding/launchGateGlass.css`, which needs an `.ade-gate` ancestor for its
  tokens), with the mark, one heading, the sign-in button, the **Sign in with
  your phone or another device** link, the awaiting/cancel line, and the ADE
  Relay help affordance. That link starts a device-authorization sign-in that
  opens no browser on this computer: `AnotherDeviceSignInPanel` draws the
  verification link as a QR code and shows the user code, so a phone or another
  computer completes the sign-in and the password is never typed here (a VM, a
  shared machine). It is absent in the hosted web client, which is a browser
  already. `useSignInFlow` owns the shared sign-in state — the browser login,
  the sign-in from another device (`useAccountDeviceLogin` in
  `lib/accountLogin.ts`), the four
  session-state words, and the brain repair offered when a stored session
  cannot be read — and the Account page's
  `SignInCard` draws that same state its own way, so the two surfaces cannot
  drift on what "expired" or "unreadable" means.
- `apps/desktop/src/renderer/components/account/AccountSignedOutBanner.tsx` —
  the permanent bar ADE shows while the account is not usable. It registers a
  model with `AppBannerHost`, which renders it through the shared `Banner`
  primitive with `dismiss: false`, because `bannerDismiss.ts` is for banners a
  user may reasonably live with and this is not one of them: the only way to
  clear it is to sign in, or to repair a store ADE could not read. The global
  host is mounted in `AppShell` outside every project condition, so this bar
  reaches welcome and projectless windows too. `IntegrationBanners` registers
  project-dependent integration states with that same host.
  It hides itself on `/account`, where its own action would lead. All four
  states' copy lives in one record in `renderer/lib/account.ts`, so a new
  state is a type error rather than a missing case. The same bar carries the
  one account problem a signed-in person can have: the directory refuses THIS
  computer (`machine_revoked` or `pairing_authentication_required`, read from
  the local sync snapshot by `hooks/useThisComputerRefusal.ts`). It names the
  removal date from the brain's `revokedAt` ("This computer was removed from
  your account on 14 August"), says "ADE stopped trying to reconnect it on its
  own." once the brain's automatic repair gave up, and offers **Reconnect this
  computer** — or **Confirm it's you** for `pairing_authentication_required`.
  The button runs `hooks/useReconnectThisComputer.ts`, the same flow as the
  Account page card, and the browser step shows its code in the bar. The hook
  only subscribes: the flow is one per window, in
  `renderer/lib/reconnectThisComputer.ts`, so a press on a second surface joins
  the attempt that is already running instead of starting a second device
  login. It is not
  dismissable either: the automatic repair used to give up with only a
  diagnostic toast, and one install stayed removed for a month. The copy lives
  in `renderer/lib/thisComputerRefusal.ts`, which the Account card, the
  Connections pane's This computer card, and the Machines list also read. The desktop raises no OS notification for a give-up:
  the only notification code in main is inline in `main.ts`, with no helper that
  brain events reach.
- `apps/desktop/src/renderer/components/account/AccountPage.tsx` — account
  status/sign-in/out shell. The signed-out page receives an explicit
  in-app return route from the sidebar or Connections and falls back safely to
  `/work` when opened directly. It routes pairing work back to the
  beginner-facing Connections panel rather than owning a second
  machine-connection flow. "Not signed in" is not one state:
  `AdeAccountStatus.sessionState` carries the daemon's
  `active | signed_out | expired | unreadable` tri-state (older runtimes are
  derived from `sessionReadState`), and `accountSessionState` /
  `accountSessionNotice` in `renderer/lib/account.ts` are the single place the
  UI branches on it. `SignInCard`, the Connections account header, and the
  sidebar avatar label each render the three states distinctly. `expired` says
  the sign-in expired and keeps a Sign in button; `unreadable` must NOT lead
  with sign-in — a new session overwrites the stored one — so it leads with the
  shared `BrainRepairButton` (or a plain retry where no brain can be restarted)
  and demotes sign-in to "Sign in anyway".
- `apps/desktop/src/renderer/components/account/YourMacsCard.tsx` — signed-in
  **Your computers** directory card extracted from `AccountPage`. It lists
  account machines (this computer pinned first), rename/clear custom name,
  remove, and the missing-directory recovery row. Custom names are account-wide
  and win for display without replacing the hostname the machine continues to
  report; list refreshes propagate the new display name through Connections,
  desktop pairing, ADE Code, hosted web, and iOS. Absence from the directory is
  not proof of removal: a publish gap, a split sync listener, or an expired
  sign-in all produce the same empty row. `describeThisComputerMissing`
  therefore claims removal only when the directory's own refusal says so (then
  it uses the shared refusal copy with the date); otherwise it branches on
  `sessionState` — expired points at Reconnect this computer; unreadable asks
  to Repair the stored sign-in then Reconnect; active/signed_out names both
  causes and offers both actions. No machine-repair copy says "Sign in again":
  the person is signed in, and the browser step is called "Confirm it's you".
  Rows show the name alone (`accountMachineRowName`) and name the install
  separately beside it only when it is not the regular app
  (`accountMachineInstallLabel`, "MacBook Pro" then "ADE Alpha"), with the ADE
  home on hover, so two installs on one Mac do not look like a duplicate. The
  Remove sheet starts with a warning for a machine
  seen in the last five minutes ("It was active 2 minutes ago. Removing it
  disconnects it from your account until someone confirms it on that
  computer.") from `accountMachineRemovalConfirmBody`, the same body the web
  client's confirm uses. **Reconnect this computer** and
  **Repair** sit side by side: Reconnect calls `repairMachinePairing` on the
  brain (and runs the *device* login flow when the directory demands proof of a
  fresh interactive sign-in — the only flow that ends with the single-use
  pairing grant a re-pair needs); Repair restarts this Mac's background service
  via the shared `BrainRepairButton` (`disabled` while Reconnect is in flight).
  Removing a machine is terminal — heartbeats never re-register it — so
  Reconnect is the only way back onto the roster. Outcome copy stays honest
  about the in-between case where the machine rejoined but push delivery has
  not resumed. `ConfirmSheet` and `describeThisComputerMissing` live here. The
  reconnect flow lives in `renderer/lib/reconnectThisComputer.ts` (one attempt
  per window) behind `hooks/useReconnectThisComputer.ts`. The refusal words live
  in `renderer/lib/thisComputerRefusal.ts`. The outcome words
  (`describeReconnectOutcome`, `reconnectNeedsFreshSignIn`, `readReconnectResult`
  and the `ReconnectOutcome` type) live in `shared/reconnectOutcome.ts`, which
  has no renderer or Node globals. `ade machines reconnect --text` and the
  `ade code` `/reconnect` notice (`reconnectOutcomeNotice` in
  `tuiClient/activityPane.ts`) read that module too, so the desktop, the CLI and
  ADE Code say the same thing. The shell bar, the Connections pane and the
  Machines list share the flow and both copy modules. `AccountPage` re-exports
  `describeThisComputerMissing` for existing tests.
- `apps/desktop/src/renderer/components/onboarding/FirstRunFlow.tsx` +
  `firstRun.css` (shared frame and motion) with one stylesheet per step
  (`firstRunWelcome.css`, `firstRunAgents.css`, `firstRunProjects.css`,
  `firstRunDevices.css`) — first-run setup on a computer: the welcome card (the
  website's "Every AI coding tool" promise, one button, Skip setup) and "Bring
  your projects in" (the git projects found on this computer, the phone QR and
  the "another computer" line). `FirstRunSteps.tsx` holds the step machine
  (`useFirstRunSteps`) and the card renderer both hosts share:
  `LaunchGate.tsx` runs it around sign-in; `OnboardingBootstrap.tsx` shows it
  again over the app for "Show me around again" or a reload during setup, and
  leaves out "Connect your agents" when the front tab is a project on another
  machine (that card reads and signs in on the tab's machine). See
  [First run on a computer](#first-run-on-a-computer).
- `apps/desktop/src/main/services/onboarding/onboardingProjectDiscovery.ts`
  — finds the projects for that card from every importable provider's
  history, without spawning git (`app.discoverOnboardingProjects`), and lists
  one project's importable chats for the import picker
  (`app.listOnboardingProjectChats`). Both read in a child process
  (`onboardingDiscoveryClient.ts`, `ELECTRON_RUN_AS_NODE`), because the
  providers' discoverers read synchronously and held Electron main for up to
  2.7 s; the chat lists come back with each answer and are kept in main for
  the setup session. `app.resolveOnboardingFolder` turns a folder picked with
  "Add another folder" into the project it belongs to (a subfolder into its
  checkout, a lane or worktree into its project), or refuses one outside a git
  checkout. `app.addOnboardingProjects` adds the chosen ones to the front of
  recent projects without evicting any (the list may pass its cap of 24 until
  later opens trim it). All four run only on this computer. The 30-day window
  is `shared/onboardingChatWindow.ts`.
- `apps/desktop/src/renderer/components/onboarding/FirstRunChatPicker.tsx` —
  the per-chat picker behind an import pill's count.
- `apps/desktop/src/renderer/components/onboarding/useOnboardingChatImport.ts`
  + `renderer/onboarding/pendingChatImports.ts` — the first open of each added
  project whose import pill was on imports its chats from the last 30 days as
  ADE chats, minus the ones left out in the picker.
- `apps/desktop/src/renderer/components/onboarding/tour/` — the guided tour:
  `onboardingTourSteps.ts` (the steps and the `data-onboarding-anchor` each
  points at), `OnboardingTourHost.tsx` (cursor, ring, card, paused pill) and
  `anchorGeometry.ts` (shared with the contextual hints).
- `apps/desktop/src/renderer/onboarding/onboardingProgress.ts` — per-computer
  onboarding progress (started, skipped, the tour's step, each hint's state).
- `apps/desktop/src/renderer/onboarding/situationalSuggestions.ts` +
  `renderer/components/app/suggestions/` — situational suggestions (tier 3):
  the shared rules, the card hook, the signal hooks and the send-time checks
  (see [Situational suggestions](#situational-suggestions)).
- `apps/desktop/src/renderer/components/onboarding/HelpMenu.tsx`
  — persistent help menu in the top bar: docs link, "Show me around again",
  and one help preference (the detailed hover-tooltip toggle). Glossary,
  help chips, and did-you-know hints were removed; `SmartTooltip`
  hover detail is the single surviving help surface.
- `apps/desktop/src/renderer/onboarding/docsLinks.ts` — typed registry
  of internal/public doc URLs that `SmartTooltip`, `HelpMenu`, welcome,
  and account surfaces link to, including the public ADE Relay explainer used by
  account sign-in surfaces.
- `apps/desktop/src/renderer/components/cto/...` — CTO first-run is the
  model picker. There is no setup wizard: a project with no stored model
  preference opens on `ModelPickCard`, and picking a model is the whole
  of first run. Linear and the rest live in the CTO Settings sheet.

Renderer — settings:

- `apps/desktop/src/renderer/components/app/SettingsPage.tsx` — tab
  container and page layout (each section page is one column, with the
  section rail beside it when there is room; the section layer lives in
  `settings/settingsTabContent.tsx`). It renders; it does not decide. Tabs, ordering, deep-link
  resolution, and search all resolve through
  `settings/settingsManifest.ts`, which is also what generates the Cmd-K
  entries. The tabs are General, Appearance, Chat, Apple devices, Notifications,
  Agents & Models, Lanes, Integrations, Secrets, Storage, Diagnostics,
  Archive, and Usage. Notifications and Activity are one page: the event policies,
  per-machine mute, privacy, sounds, and scheduled work all read and
  write through one `useActivitySettings()` model, so a change on one control
  can no longer be overwritten by a save from another copy. The retired
  `activity` tab id and the `attention` alias resolve to `notifications`.
  Every tab id ADE has ever shipped in a URL still resolves via
  `LEGACY_TAB_ALIASES` (`settingsManifest.test.ts` asserts this); the one
  exception is `keybindings`, dropped because it pointed at a tab with no
  keybindings UI. Welcome video replay and help preferences live under the
  Help menu in the top bar, not as a Settings tab.
  The manifest assigns each setting to one of four persistence scopes:
  `account`, `account-repo`, `machine`, or `machine-repo`.
- `apps/desktop/src/renderer/components/settings/BrowserLinksSection.tsx`
  — the General tab's **Links** group (`general.link-open-mode`, scope
  `machine`, `web: "hidden"` because a hosted tab has no Electron browser
  and its own browser already owns link handling). Writes
  `browser.linkOpenMode` and `browser.autoOpenDevServer` into the
  project's `.ade/local.yaml`; see
  [Configuration schema](configuration-schema.md).
- `apps/desktop/src/shared/settingsManifest.ts` — the registry's data and
  pure helpers, in `shared/` so the CLI (`ade settings find`) and chat chips
  read the same entries. `renderer/components/settings/settingsManifest.ts`
  re-exports it and adds what depends on the renderer (platform, web client,
  standalone Settings).
- `apps/desktop/src/shared/settingsAgentAccess.ts` — the two lists: settings
  an agent may change (the setup of the work: lanes, lane templates, agent
  notes, secrets) and settings only the user changes (publishing, sign-ins,
  money, agent reach, the computer, deleting data, preferences). A setting
  not listed is the user's. The refusals live in the brain:
  `ADE_ACTION_CTO_ONLY` for the writes (`USER_SETTING_WRITES` in
  `actionPolicy.ts` lists them with the card each refusal links to), and
  `ownerOnlyProjectConfigChange`, which refuses an agent's
  `project_config.save` whose `local` layer would change or drop any config key
  outside the work setup (`AGENT_EDITABLE_PROJECT_CONFIG_KEYS`). Automation
  steps may not run `project_config.save` at all. The user's own terminal keeps
  these commands (`ade settings …`, `ade providers accounts add|remove|default`
  connect as the operator role; an agent's shell is clamped back to agent). An
  agent can still hand-edit `.ade/local.yaml`; that gap is known.
- `apps/desktop/src/renderer/components/settings/settingsManifest.ts` —
  the registry. One `SettingEntry` per setting (`id`, `label`,
  `keywords`, `tab`, `anchor`, `scope`, `web`, `group`, and an optional
  `webOnly`). Add a setting here and
  it becomes navigable, searchable, and deep-linkable at once.
  `webOnly: true` marks a card only the hosted browser draws (currently
  `agents.accounts`, "AI accounts"): the desktop reaches the same controls on
  each provider's page, so its nav, search, and palette must not offer an
  anchor it never renders.
  `scope` answers *who does this affect*; `web` (`SettingWebScope`) answers
  *does it work at all from a browser, and what do we tell the user about where
  it went*. A hosted browser has no Electron shell and reaches its machine only
  through the actions the sync host registers, so a setting either travels to
  that machine, syncs through the ADE account, never leaves the browser tab, or
  is `hidden`. `hidden` is why Secrets, providers, GitHub credentials,
  dictation, the CLI installer, auto-updates, storage, session lifecycle, and
  lane templates stay off the web nav: their reads would land, but their writes
  would resolve against a missing descriptor and silently vanish.
  `sectionWebScope` resolves a section's scope, and `WebScopePill.tsx` prints
  it as the section's opening line — so a toggle that will not follow you to
  another browser says so before you flip it. Desktop renders sections exactly
  as before, with no banner.
- `apps/desktop/src/shared/theme/library.ts`, `resolve.ts`, and
  `renderer/theme/applyTheme.ts` — the theme engine. Shipped themes are
  `ADE_THEME_FAMILIES` (each family has a dark and a light variant); `dark`
  and `light` keep the stylesheet's own palettes and emit no inline vars,
  while every other theme paints its palette as inline `--color-*` properties
  on `<html>`. Only `<html>` carries `data-theme` / `data-theme-id`: the
  stylesheet re-declares every `--color-*` under `[data-theme]`, so the same
  attribute on `<body>` or the app root reset the palette one level below the
  inline overrides and made every theme look like plain dark or light.
  `LEGACY_THEME_ID_ALIASES` maps a retired id (obsidian, high-contrast,
  midnight, evergreen, parchment, blush) to the variant that replaced it. The
  per-computer `themeFollowsSystem` flag makes the painted theme follow the
  OS colour scheme: `effectiveThemeId` paints the chosen family's variant for
  the current `systemColorScheme`. **Appearance is per computer**: the theme
  id, the custom theme list, `themeFollowsSystem`, `interfacePreferences` and
  `terminalPreferences` are not in `ACCOUNT_SYNCED_SETTINGS`, so they live in
  this machine's localStorage and never reach the account. That includes
  `interfacePreferences.focusGridMaxChats`, the Focus grid's **Chats per
  page** (null for Automatic), which `useWorkFocusGrid` reads: it follows the
  screen. The families are
  built in `family.ts` and written in three files: `library.ts` (the ADE
  families), `libraryOriginals.ts` (themes with their own shape, type and
  backdrop) and `libraryClassics.ts` (editor colour schemes). A theme may also
  carry `syntax` (ten code colours, derived from its terminal palette when
  omitted) and `flair` (corners, depth, interface face, backdrop);
  `renderer/theme/codeTheme.ts` turns the resolved theme into a Monaco theme
  for the file editor and a Shiki theme for chat code blocks, and
  `applyTheme.ts` sets `data-theme-backdrop`, `data-theme-radius` and
  `data-theme-shadow` for the rules in `index.css` that custom properties alone
  cannot express.
  `renderer/theme/applyInterface.ts` applies the per-computer
  `interfacePreferences` (`sansFont`, `monoFont`, `reduceMotion`) as
  `--font-sans` / `--font-mono` overrides plus `html[data-motion="reduced"]`,
  and `App` drives `MotionConfig` from the same flag so the preference reaches
  JS animations, not only CSS.
- `apps/desktop/src/shared/accountSettingsScope.ts`,
  `apps/desktop/src/renderer/lib/accountSettingsSync.ts`, and
  `useAccountSettingsSync.ts` — the renderer's account-settings half. It turns
  the four-value setting scope into the key the account store files a row under
  (`accountSettingScopeKey`), and it makes the "Stored in your ADE account" chip
  true for the preferences that claim it: a local-first write-through engine
  hydrates newer remote rows and pushes local edits back, per key, with a
  strictly-newer stamp so one machine's change cannot revert another's, and a
  dirty queue that retries signed-out or offline edits. Only `account` and
  `account-repo` scopes ever reach the store; machine-scoped values (paths,
  ports, hardware facts) never leave this computer. A preference that is
  account-scoped but one-value-per-computer — the Apple device options — keeps
  the account-wide scope and carries the device in the key
  (`accountDeviceSettingKey`, `device.<syncDeviceId>.<key>`) so another machine
  skips it while this brain can read it. An `account-repo` key is
  `repo:<host>/<owner>/<repo>` from the canonical origin
  (`readGitOriginUrl`): the machine that owns the checkout resolves an SSH
  alias of GitHub (`git@github.com-work:org/repo`) through `ssh -G`
  (`github/githubSshAlias.ts`), so every checkout of one repository shares a
  key. The `repo_scope_alias` account migration copies a project's secrets and
  settings from the alias key an older ADE used, once per project; a row
  already under the new key wins, and the old rows stay. See
  [Sync and multi-device](../sync-and-multi-device/README.md).
- `apps/desktop/src/renderer/scene/` and `renderer/styles/scene.css` — the
  window backdrop, configured under Settings → This computer → Appearance →
  **Background**. Modes are `plain` (the theme's flat background, no picture
  and no mesh; the web client's default), `gradient` (the theme's animated
  mesh), `image` (one picture), and `shuffle` (a picture from the library,
  changed on launch, wake, hourly, or daily; the desktop default, drawing from
  the pictures sized for the screen in use). Pictures are bundled (`public/scenes/*.jpg` through
  `sceneLibrary.ts`, with a 2560×1600 copy for 1080p and 1440p screens) or the user's own — re-encoded to at most 5120 px JPEG and
  kept in IndexedDB by `userScenes.ts`, never on disk or in sync.
  `scenePalette.ts` extracts the picture's palette, `sceneTheme.ts`
  (`themeTintedByScene`) tints the theme from it when App colours is **From
  picture**, and `SceneImageLayer` draws one window-aligned slice per surface so
  the top bar, home page and new chat page read as one picture.
  `BackgroundContextMenu.tsx` is the background right-click menu (**Next
  picture**, light/dark, **Change background…**). Scene preferences live in
  `interfacePreferences.scene` in `ade.userPreferences.v1` and are per computer,
  like the theme; `SCENE_DEFAULTS_REVISION` in `scenePreferences.ts` is a
  one-time shipped-default reset. Full behavior:
  [`docs/design/visual-language.md`](../../design/visual-language.md).
- `apps/desktop/src/renderer/components/settings/primitives/` — the
  control vocabulary (`SettingsCard`, `SettingsGroup`, `ScopeChip`,
  `SettingsToggle` / `Segmented` / `Number` / `Select` / `Slider`,
  `SettingsDisclosure`, `useSavedFlash`). `primitives/SettingsRows.tsx` adds
  the grouped-rows page vocabulary — `SettingsSection`, `SettingsPanel`,
  `SettingsRow` (with `icon`/`tone`), `SettingsColumn`, `SettingsSplit`, and
  `SettingsSectionAction`. `primitives/SettingsModern.tsx` is the modern page
  vocabulary every redesigned settings page now uses — `ModernPage` (the
  section column), `ModernSection` (heading, one-line hint, optional actions,
  carrying `data-settings-anchor` for search and deep links), and
  `ModernRows` / `ModernRow` (a grouped panel with title, hint and control) —
  and it is the settings counterpart of the surface kit in
  `renderer/styles/surfaceKit.css`. `SettingsDisclosure` is a
  native `<details>` in a recessed card for rarely-needed fields —
  native markup keeps keyboard and find-in-page behaviour — and its
  `defaultOpen` is uncontrolled on purpose, so a caller passes `true`
  when the block already holds a value and an existing config never
  hides itself. There is **no Save button anywhere in settings**:
  every control persists on change and reports via `SavedFlash`.
  `ScopeChip` uses the shared four-scope copy and is shown only where the
  backing store would surprise — clicking it names the file and who it
  affects. `SettingsCard`, `SettingsManagerPage`, and
  `SettingsDashboardPage` are the three page templates; section files choose
  one instead of drawing their own page layout.
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
  — the Updates block inside Settings → ADE service. Automatic installation is off by
  default, leaving installation under the top-right control. Enabling it
  reveals the default-on **Wait until active work finishes** safety option,
  which delays the restart countdown until no agent turn or work session is
  active.
- Product analytics has no Settings section. It is on by default, and
  `DO_NOT_TRACK=1` or an opt-out a previous build stored turns it off silently.
  See [logging and product analytics](../../logging.md).
- `apps/desktop/src/renderer/components/settings/DiagnosticsSharingSection.tsx`
  — the one report control in Settings (`general.diagnostics-sharing`, anchored
  `#diagnostics-sharing`, titled **"Send a report to ADE"**). It has no toggle.
  Automatic reports are on by default and stop under `DO_NOT_TRACK=1` or an
  earlier stored opt-out. The card's **Send a report to ADE** button is the only
  report control that does not require something to have already visibly broken,
  which is what makes the report's copy true for a user whose app merely feels
  wrong. It has its own daily cap (5 per install per 24h, counted apart from the
  automatic 3). `web: "hidden"` in the manifest, because the report is built on
  this machine by the desktop app. See
  [storage and recovery → Auto-send](../storage-and-recovery/README.md#auto-send).
- `apps/desktop/src/renderer/components/settings/integrations/` — the
  Integrations tab's frame, built like the provider pages. With nothing open
  the tab is a grid of GitHub, Linear and Jira (`IntegrationsHome.tsx`: the
  maker's banner, what it does, and this machine's connection state, each read
  with the Settings machine's pin). `?integration=<id>` opens one page, and a
  `#hash` naming any of its settings (`#github-connection`, `#jira-projects`)
  opens it too; the hash wins over the param, because a search result keeps
  the query string (`openIntegrationFromUrl` in `settingsTabContent.tsx`).
  Only one integration's page is mounted at a time, so Settings search lists a
  match on another integration's page (or every match while the grid is open)
  as an "On other pages" result that opens it. Each page (`IntegrationChrome.tsx`)
  starts with a banner in the maker's colors: the logo standing in 3D
  (`SolidLogo` from the provider hero), the state, a panel naming what this
  machine is signed in to with the main actions, and a strip of facts that
  also holds the top-bar switch. Below it sit two cards of equal size, or one
  across. `integrationBrand.tsx` holds each brand's accent, banner art and logo.
- `apps/desktop/src/renderer/components/settings/GitHubIntegrationSection.tsx`
  and `GitHubSection.tsx` — ADE GitHub App / environment / GitHub CLI / PAT
  auth, credential-specific permission diagnostics, structured validation
  failures, and automatic fallback state. The GitHub page of Integrations: its "Your sign-in"
  card lists every credential in the order ADE tries them, with the token form
  (and the permissions a token needs) opening inline in the token row. Classic
  PATs and CLI OAuth tokens show their detected scopes; fine-grained PATs show
  repository-permission guidance; App user tokens show installation-backed
  repository metadata access and never report missing classic `repo` /
  `workflow` scopes, because GitHub Apps do not use those OAuth scopes. The App
  panel states that the App is intentionally read-only and documents the
  environment → App → GitHub CLI → PAT read order plus the write-capable
  subset. Healthy connections do not expose quota bookkeeping. When ADE is
  compensating for a problem, Settings names the paused source and temporary
  replacement, plus the retry time when GitHub supplied one. The App row in that
  connection ladder is a special case: the App credential's own state outranks
  the generic ladder states, because it is the only place that can tell a paused
  renewal from a dead authorization, and only the dead one may ask the user to
  re-authorize. The row reads the shared account status through
  `useGithubAppUserAuth` and badges itself through
  `describeGithubAppCredentialBadge`. Its retry time also comes from there: the
  App's pause lives in the credential's refresh ledger rather than in the
  request budget, so the ladder's own `retryAt` is usually absent and the
  sentence would otherwise end open. An exhausted shared
  account bucket renders the reset time and explains that background refresh is
  paused automatically; it never asks the user to re-authenticate. When no
  fallback remains, a missing, invalid, or genuinely under-scoped credential
  shows login/refresh instructions. An unreadable credential store outranks all
  of that: the card reads **Can't read sign-in** instead of "Not connected",
  renders the shared unreadable notice with an **Open connections** button that
  opens the Connections panel's Machines tab, and suppresses the `gh auth login`
  setup steps — those steps would answer a question ADE has not actually asked,
  and following them writes a new credential over one that is probably intact.
  The App-installation card also classifies relay
  rate-limit responses as a concise cooldown state instead of displaying
  GitHub's raw request-id / scraping-policy error. Raw network/unknown
  validation errors stay in Settings rather than the global banner. The shared
  `renderer/lib/githubIntegrationStatus.ts` presentation helper keeps banner
  and Settings classification aligned. When githubstatus.com corroborates an
  outage the whole card goes neutral instead of reading as "your setup is
  broken": the status chip says "GitHub outage", the failure box drops its
  warning tint and grows a link to the live incident, `READS WITH` / `WRITES
  WITH` say "Unknown" rather than the false-negative "Not connected",
  connection-order badges read "Waiting on GitHub" instead of "Reconnect
  needed", and the `gh auth login` instructions are hidden so nobody replaces a
  credential that was working. A missing token still shows its instruction —
  that is a local fact an outage cannot explain away. This section also hosts
  the `GitHubAppInstallPanel` (below) for installing "ADE for GitHub".
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
    "Authorize ADE" device-flow UI: `startAppUserDeviceAuth` shows the user
    code as a copyable chip plus a waiting state and the verification URL, and
    `pollAppUserDeviceAuth` drives the poll loop and auto-renews an expired code
    up to 3 times. `deriveGithubAccountAuthState` reads the service's
    `credentialState` and classifies the account as `valid` / `blocked` /
    `needs_reauth` / `missing`. **Never judge the account by `expiresAt`.** The
    App access token lives 8 hours and is renewed from the refresh token on
    every use, so a lapsed `expiresAt` is ordinary operation; reading it as
    "authorization expired" sent working accounts back through a device flow
    against the same OAuth endpoint the renewals were already failing on, which
    is the one thing guaranteed to keep the account locked out. The whole row is
    built by `describeGithubAccountAxis`, and its rule is that every state ADE
    recovers from on its own returns `cta: null`:
    - `valid` renders "Authorized" plus *"<login> · renews automatically"*. It
      is deliberately silent about the 8-hour token, because showing that expiry
      taught users to read a normal renewal cycle as a countdown to breakage.
    - `blocked` with no recorded failure is ADE's own lease — one process on the
      machine is renewing and the rest wait a moment — so it reads "Renewing…".
      `blocked` with a recorded failure reads "Paused" (or "Paused until 3:40
      PM" when the ledger carries a deadline), with copy from
      `githubRefreshPauseCopy` naming what GitHub did, and a note that
      re-authorizing is unavailable while GitHub has those requests paused.
      Neither offers a button.
    - `needs_reauth` is the **only** state that offers "Re-authorize", and
      `missing` the only one that offers "Authorize ADE".
  - **This repo · `owner/name`** — whether the App is installed on the active
    repo. `deriveGithubRepoConnectionState` takes the account state as well as
    the installation status and maps them to `connected` / `not_installed` /
    `access_pending` / `waiting_on_account` / `no_repo` / `unknown`.
    `waiting_on_account` is the axis refusing to report a reading it could not
    take: an install check that ran without a working account credential proves
    nothing about the installation, so saying "not installed" reports an
    uninstall that never happened. It is chosen from the typed
    `appUserAuthFailure` on the installation status first, then from the
    message-matching compatibility shim for older hosts, and finally from any
    non-`valid` account state. A rate limit or a GitHub 5xx is exempt, because
    those are corroborated reasons that hold whichever credential the check ran
    with. In `waiting_on_account` the panel offers only **Recheck** — Install and
    Manage would both be guesses. After device authorization succeeds, the panel
    force-refreshes the hosted relay status with a short retry window and treats
    GitHub repo-access 404s as a temporary "Checking access" (`access_pending`)
    state so App installation propagation does not look like failed
    authorization. A GitHub server error renders as "Waiting on GitHub" rather
    than "Couldn't verify": the install state is unknown, not broken.

  A quiet **Disconnect** control sits next to the account row whenever there is
  something to disconnect. It is two clicks — the confirm step explains that
  real-time pull request updates stop until the user authorizes again — and it
  calls `clearAppUserAuth`. It is hidden on hosts that do not implement the call
  and on the standalone web client, which implements it but has no credential to
  clear; both are judged by `isGithubAppUserAuthSupported` so a new stub cannot
  pass half the check. Offers a Refresh. Rendered in Settings and, in a compact
  `onboarding` variant, during setup.

  Both this panel and the Settings connection ladder above it read one shared
  account status through `renderer/lib/useGithubAppUserAuth.ts` — a module-level
  value with a listener set, not context, because the two consumers are not
  siblings under a common provider and the panel is also mounted alone during
  onboarding. There is exactly one such credential per machine, and with a fetch
  and a piece of state per component, disconnecting in the panel left the ladder
  badge one card away still reporting the authorization that had just been
  removed. `refreshGithubAppUserAuth({ force: true })` starts a read even when
  one is in flight, which a caller reading *after* an action it just performed
  needs: joining the running read answers with the state from before the action.

  The device-flow, token store, refresh lease, and backoff ledger are backed by
  `githubAppUserAuthService` in the main process (see the automations feature
  doc's [Source file map](../automations/README.md#github-relay-and-app) and
  [How ADE stops a GitHub App refresh storm](../automations/README.md#how-ade-stops-a-github-app-refresh-storm)).
  The matching per-repo "GitHub App not connected" banner — distinct from the
  gh-CLI banner — is registered by `IntegrationBanners` and rendered by the
  app-shell `AppBannerHost` from the
  same `githubIntegrationStatus.ts` derivation (see
  [ARCHITECTURE §7.6](../../ARCHITECTURE.md)), so the panel and the banner never
  disagree.
- `apps/desktop/src/renderer/lib/githubIntegrationStatus.ts`
  — pure, two-axis derivation of GitHub App integration health (account
  user-token axis vs. per-repo install axis), the `deriveGithubRealtimeBlock`
  top-blocker picker (account problems outrank repo problems),
  `githubStatusHasWriteCredential` for capability-gating mutations, and the
  shared banner/Settings copy for the account, repo, and gh-CLI/token
  sub-states. Imported by `GitHubAppInstallPanel`, `GitHubSection`,
  and `IntegrationBanners`;
  App-only read connectivity therefore keeps PR data live while still prompting
  for GitHub CLI or a PAT before a mutation. This module only translates the
  service's `credentialState` into copy — it does not re-derive the account's
  health from token expiry. `deriveGithubRealtimeBlock` returns `null` for a
  `blocked` account: ADE retries on its own, so a banner there would be one
  nobody can act on. `describeGithubAccountAxis` and
  `describeGithubAppCredentialBadge` render the same fact in the panel and in
  the Settings ladder, and share `githubPausedLabel` so the two read
  identically — a user who sees "Paused" in one card and "Paused until 3:40 PM"
  in the other reads them as two different problems.
  `isGithubAppUserAuthSupported` separates "this host has no GitHub App
  credential" from "this machine is not authorized": the standalone web-client
  adapter declares itself with `appUserAuthSupported: false`, and older hosts
  are still recognised by `configured`, which no stub has ever carried. Reading
  a stub as a real answer flashed a false "not authorized" banner on every
  hosted-web project. `deviceAuthMessageCopy` / `deviceAuthErrorCopy` replace
  GitHub's raw transport error (*"GitHub OAuth request failed (429)"*) with what
  it means, because that string reads as ADE breaking rather than GitHub
  throttling. `GITHUB_ACCOUNT_AUTH_ERROR_MATCHES` is a **compatibility shim**
  and marked as one: the typed `appUserAuthFailure` is the real signal, and this
  enumerated list only catches a host older than that field or a raw 401 body
  from the relay. Do not add new ADE phrasings to it — a loose substring here is
  worse than a missing one, because "not authorized" also appears in messages
  about the repository, and matching those reported a real install problem as an
  account problem the user could not act on. `describeGithubOutage(status)` is the one presentation
  entry point for a corroborated GitHub outage — it answers "is there an
  outage", "what do we say", and "where does the button go" together, and every
  GitHub-blaming surface gates on it. When it returns null ADE says nothing
  about GitHub's health and keeps its existing copy.
  `describeGithubCliBanner` resolves three states in a fixed order, and the
  order is the whole point:
  1. `credentialStoreUnreadable` — first, ahead of everything. An unreadable
     store returns an EMPTY view, so every conclusion below it would be drawn
     from credentials ADE could not read. It is also a local, repairable fact
     that outlives any incident, so an outage must not mask the one thing the
     user can actually fix.
  2. `!tokenStored` — ahead of the outage. A missing token is a purely local
     fact and stays true regardless of GitHub's health, so the genuine "connect
     GitHub" instruction survives an incident.
  3. the outage — ahead of every remaining state, all of which are inferred
     from GitHub's own answers and are therefore unreliable while GitHub is
     failing. `describeGithubAuthFailure` consults the outage first for the same
     reason.

  Every branch also returns a `target` (`github-settings` | `connections`)
  rather than leaving the destination implicit: an unreadable store is not a
  GitHub problem and is not fixed on the GitHub card, whereas an outage and
  every auth failure are — there the credential ADE holds is readable and it is
  the account behind it, or GitHub itself, that has the objection.
- `apps/desktop/src/renderer/components/app/IntegrationBanners.tsx` — consumes
  the shared read/write distinction. The app shell raises a write-access
  banner for an otherwise connected App-only status. The gh-CLI/token banner routes
  its single action by the `target` the derivation supplies — the GitHub
  connection settings route, or the same Connections panel the relay banner
  opens — and keys its dismissal fingerprint on the sub-state, so a store that
  becomes unreadable re-raises a banner the user had dismissed for a different
  reason.
- `apps/desktop/src/renderer/components/settings/LinearIntegrationSection.tsx`
  and `LinearSection.tsx` — Linear OAuth / API key, workspace status,
  and GitHub autolink setup. Embedded inside General.
- `apps/desktop/src/renderer/components/settings/PrChatTranscriptsSection.tsx`
  — toggles `prTranscriptGists.enabled` in project local config under Project
  → Agents.
- `apps/desktop/src/renderer/components/settings/AgentNotesSection.tsx` — the
  read-only Project → Agents list of project notes visible to agents on the
  project machine. Notes are written with `ade notes`.
- `apps/desktop/src/renderer/components/settings/AboutSection.tsx`
  — About (version, runtime); rendered in General.
- `apps/desktop/src/renderer/components/settings/ResetAdeSection.tsx`
  — **Reset ADE** as its own section, last on General (local machine only;
  anchor `reset-ade`, legacy `#about.reset` still resolves). It mounts
  `ResetAdeButton` from `app/ResetAdeDialog.tsx`.
- `apps/desktop/src/renderer/components/settings/settingsTabContent.tsx`
  — the tab-section layer: `TAB_SECTIONS`, the named blocks each section-list
  page is organised into (`TAB_GROUPS`), `TabContent`, and the Providers
  sub-view. `SettingsPage.tsx` only lays out the page around it.
- `apps/desktop/src/renderer/components/settings/primitives/SettingsSectionRail.tsx`
  — the sticky in-page rail of a page's blocks, with their icons. Rendered when
  a page has two or more blocks; a CSS container query shows it only at 900px
  or wider. At the end of the page it marks the last block.
  `AdeCliSection.tsx` is rendered in General too, in the ADE block —
  CLI availability is app basics, not an integration. The
  `EnvironmentSection.tsx` wrapper that used to pair them is gone.
- `apps/desktop/src/renderer/components/settings/settingsSectionUi.tsx`
  — shared section headers (`SettingsSectionShell`), toggle styling, and
  `SettingsToggle`: a labelled on/off switch that callers feed the persisted
  value, which renders disabled rather than pretending to work when a preload
  predates the setting. The product-analytics and diagnostics consent controls
  that used it are gone; other settings still use it.
- `apps/desktop/src/renderer/components/settings/AppearanceSection.tsx`
  — theme, interface faces, and terminal text, all per computer. (The chat
  appearance controls moved to `ChatSection.tsx`, which renders
  `ChatAppearancePreview`.) The Theme card renders the `ThemeGallery` picker
  (`components/settings/ThemeGallery.tsx` + `ThemePreview.tsx`): a search field
  over shelves of families (ADE, Originals, Editor classics, then the user's own
  themes), with the active theme's corners, depth, type and backdrop named on
  the stage. A `ThemeImportExport` toolbar
  (`components/settings/ThemeImportExport.tsx`) exports the active theme or
  imports an ADE / VS Code theme file (comments and trailing commas allowed),
  and `ThemeFilesHelp` under the gallery says what both do and where to find
  themes. A `ThemeCustomizer` dialog
  (`components/settings/ThemeCustomizer.tsx` + `themeCustomizerModel.ts`)
  overrides individual tokens, code colours and shape settings and saves custom
  themes; the theme format, engine
  and shipped library live in `apps/desktop/src/shared/theme/` and are applied
  by `apps/desktop/src/renderer/theme/applyTheme.ts`. See
  [design/theming.md](../../design/theming.md).
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
  bundled `ade` binary. It shows the current install
  path, an Install / Repair button that runs the platform
  install-path helper, and an "Add to PATH" hint when the install
  target isn't on the user's `$PATH`. Agents launched by ADE always
  get the bundled CLI automatically; this surface is what makes
  `ade` available to the user's own terminals.
- `apps/desktop/src/renderer/components/settings/AiFeaturesSection.tsx`
  — Pause all scheduled work and the active durable-job list. Naming,
  idle status lines, and similar background helpers run on one model
  from the ADE provider that owns the session (Haiku 5.5 at `low` effort
  for Claude, GPT-6 Luna at `low` for Codex, Composer 2.5 for Cursor;
  every other provider uses the session's own model). There is no
  Settings picker for those helpers. The section owns **Pause all scheduled
  work**, persisted as `ai.chat.scheduledWorkPaused`. This pauses Claude
  wakeups, cron tasks, and `/loop` schedules across the project runtime
  without disarming them; overdue work catches up once after resume. Its
  **Active scheduled work** recovery manager reads the runtime's KV-backed
  durable list across every chat and can cancel one exact job. Provider-owned
  jobs remain visible in their returned paused/pending state until Claude
  confirms deletion, and a load/cancel failure renders explicitly rather than
  being mistaken for an empty list.
- `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx`
  — AI Connections settings lists coding providers and opens a dedicated page
  for each one. The Cursor page offers browser sign-in while disconnected and
  keeps Sign out available after connecting; API keys live in the shared keys
  panel. **OpenCode —
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
  italic "updating…" hint until the first live probe. When ADE's OpenCode
  copy is not downloaded yet the group collapses to a card with the pinned-copy
  line and Download/Retry. The **Pi** card is a
  `CollapsibleProviderCard` (readiness tone, version, CLI path, and Open
  `settings.json` / `auth.json` / `models.json` shortcuts) whose body is
  `PiProvidersPanel.tsx`.
- `apps/desktop/src/renderer/components/settings/providers/cliTools.ts` — the
  provider card's status and credential phrasing. The detail page's left rail
  prints `describeProviderCredentialLine`, which leads with the account when the
  provider records one locally ("Authenticated as dev@example.com · ChatGPT
  Pro", from `AiProviderConnectionStatus.accountEmail` / `accountPlan`) and
  falls back to `describeCredentialSource` — the file or environment variable
  the credential was detected in — when it does not. The two stay separate
  functions so a diagnostics view can still ask for the *file*.
  `shortCredentialSource` is the two-or-three-word tile form. The account fields
  come from `providerAccountIdentity.ts`, the same reader the usage poller uses,
  so Providers and the Limits cards cannot disagree about who is signed in.
- `apps/desktop/src/shared/providerRemediation.ts` — the single source of the
  login command, display name, and docs URL for every CLI-backed provider. It
  has no install commands any more: ADE downloads its own pinned copy of every
  agent ([agent tools cache](agent-tools-cache.md)), and `installCommand` is
  always `null`. Four surfaces read it and none keeps its own copy: the
  Settings CLI-tools cards (`settings/providers/cliTools.ts`), the model
  picker's empty states (`shared/ModelPicker/providerEmptyState.tsx`), the CLI
  agent registry (`apps/ade-cli/src/services/agentRegistry.ts`), and the
  `providers.status` RPC that reports the same strings to SDK embedders. Edit a
  changed vendor command here; copying it into a screen is how the four drift.
  Each string is the vendor's own documented one, and two are not the obvious
  guess: Droid has no non-interactive login, so the honest `loginCommand` is the
  bare `droid`, and Pi signs in through the interactive CLI's `/login`, so its
  `loginCommand` is the bare `pi`.
- `apps/desktop/src/renderer/components/settings/PiProvidersPanel.tsx`
  — Pi's half of Settings → Providers: the sign-in flow and the provider
  catalog. Its own module because Pi's catalog is the size of OpenCode's and the
  two together made `ProvidersSection.tsx` unreadable. A running sign-in owns
  the surface — `PiSignInFlowCard` renders whatever Pi asks for live off
  `onPiAuthStatus` (an auth URL, which is opened automatically and left on
  screen for a blocked browser; a device code with a Copy control; a free-text
  or password field; a labelled choice group), and the catalog steps aside while
  it runs, because starting a second sign-in supersedes the first. Auth URLs and
  device codes stay pinned while plain progress lines replace each other. Cancel
  is a distinct outcome from failure, and only a failure offers **Try again**
  (retrying with the method the user actually pressed); leaving Settings no
  longer cancels anything. With no flow on screen, `PiProviderBrowser` shows
  **Connected** first, then **All providers** behind a search field (a "Popular"
  grid — everything with an interactive sign-in, most models first — until the
  user types), then **Local Model Servers**. A tile opens
  `PiProviderDetailModal.tsx`, the provider's own page: the models it
  contributes and how it can be signed into; starting a sign-in closes the
  dialog so the device code and prompts survive it. Local servers are a separate
  section with **no sign-in at all** — their login options are dropped rather
  than hidden, which is what put an API-key prompt in front of LM Studio — and
  their status comes from ADE's live endpoint probe (Running / Load a model /
  Not detected), never from the presence of a `models.json` entry; ADE probes
  only Ollama and LM Studio, so any other loopback server falls back to
  "Configured in Pi". When `sdkAvailable` is false the panel collapses to a
  stated instruction to run `pi` and use its `/login` — ADE does not automate
  it. Row shape and the questions asked of it live in `piProviderRow.ts`; the
  grid/tile/search/dialog primitives shared with the OpenCode half live in
  `providerSectionPrimitives.tsx`. Nothing typed into a Pi prompt is stored by
  ADE — see
  [Agent Routing › Pi sign-in](../chat/agent-routing.md#pi-sign-in).
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
  methods, and toasts the added-model count. The status subscription and the
  unmount cancel key only on the machine's stable `pin` and the provider id
  (parent callbacks are read through refs), so a re-render cannot re-anchor a
  pinned status feed past a `connected` event or cancel a running sign-in.
  OpenCode Go has no sign-in of its own and opens this dialog against the
  `opencode` provider it borrows; `useOpenCodeProviderDetail` in
  `OpenCodeProviderDetailModal.tsx` latches the open row and snapshots the
  sign-in target when the dialog opens, so a catalog refresh can neither
  unmount the dialog nor retarget a running flow.
- `apps/desktop/src/renderer/components/settings/SecretsSection.tsx`
  — Settings > Secrets. Lists project-scoped ADE secrets without values,
  adds/replaces secrets, reveals values on demand, copies them to the
  clipboard, and deletes with inline confirmation. The section can also open a
  local Finder picker for a bounded dotenv file, show the extracted names and
  values in a select-all/individual-selection review modal, atomically import
  the selected rows, and export all secrets as a mode-`0600`
  `ade-secrets.env` file in Downloads. Values are backed by
  `projectSecretService` under `.ade/secrets/project-secrets.v1.enc`. New
  secrets default to the account and can be saved to the current repository's
  account scope or this device only; an account choice falls back to this
  device when the repository has no Git remote, when nobody is signed in, or
  when no account vault is wired, and the save message says which of those
  happened. A "Pull from account" control in the section header asks the
  account and takes every account secret the repository has in the vault onto
  this machine without touching a device-only row. Opening the list and
  revealing a value also check the account first (bounded to a few seconds), so
  a secret added on another machine shows up without a manual pull. The list
  shows the effective destination for every secret; an account secret this
  machine has not finished uploading shows "Uploading" until it lands. When the active project is remote, only the
  Finder read happens on the controller Mac:
  the bounded file content is parsed/imported by the active runtime and export
  writes to Downloads on the remote project host.
- Chats can also add project secrets without the value entering the
  transcript: an agent's `ade secrets request NAME --reason "…"` raises the
  private secret card, and the composer's "Add secret…" item opens the same
  form. Both save through `projectSecretService`; see
  [Private secret card](../chat/composer-and-ui.md#private-secret-card).
- `apps/desktop/src/renderer/components/settings/SecretsImportEnvModal.tsx`
  — dotenv import review dialog. Displays extracted names and plaintext values,
  marks replacements, supports select all or individual selection, and saves
  only the selected secrets.
- `apps/desktop/src/renderer/components/settings/LaneTemplatesSection.tsx`
  and `LaneBehaviorSection.tsx` — lane initialization recipes and
  lifecycle policies. The template editor is written for someone who has
  never read the config schema: fields are named for what they do
  ("Files to copy into new lanes", "Env files to fill in", "Install
  command", "Setup script", "Use for new lanes") rather than for the
  YAML keys behind them, each with a one-line hint. Docker services,
  `.ade`-folder mounts, and extra variables sit behind an **Advanced**
  `SettingsDisclosure`, and per-platform setup commands behind a
  "Different commands on Windows" one; both open by default when the
  template already has a value there. There is no port-range control —
  lane creation leases a port range and the lease always outranks a
  template's `portRange`, so the field could only mislead. An existing
  `portRange` in YAML is preserved across edits rather than dropped.
- `apps/desktop/src/renderer/components/settings/StorageSection.tsx` plus
  `settings/storage/StorageCleanupDialog.tsx`, `StorageDiagnostics.tsx`,
  `StorageMaintenanceJournal.tsx`, `storageView.ts`, and `storageUiConstants.ts`
  — Project → Storage & cleanup. Uses plain language to explain lane cleanup rules,
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
  used to forget paired phones or revoke web clients. When the account-directory
  state is the brain-side unreadable session (`isBrainAccountSessionFailure`),
  the card adds a **Repair** button that restarts this Mac's background service
  and re-reads the snapshot once it settles. When the account directory refuses
  this computer, the card's directory line says so ("This computer was removed
  from your account on 14 August") and a **Reconnect this computer** (or
  **Confirm it's you**) button sits beside it. The card reads that refusal only
  from this computer's own snapshot, so a remote-bound pane and the hosted web
  client never show it — see
  [Sync and multi-device](../sync-and-multi-device/README.md).
- `apps/desktop/src/renderer/components/app/TopBar.tsx` and
  `ConnectionsPanel.tsx` — the single top-bar Connections control and its
  Machines, Phone, and Web tabs. The Web tab reports connected browser peers
  and directs signed-out users to account sign-in.
- `apps/desktop/src/renderer/components/usage/HeaderUsageControl.tsx`
  and `UsageLimitsBand.tsx` — header usage popup. Live provider quotas
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
  order snapshots by `revision.producerId`/`seq` (accepting a different
  producer outright), and clear then
  reload both quota and provider-connection state when the binding changes.
  This keeps the compact percentages and the open panel on the same live
  machine-brain snapshot even across fast project or machine switches.
  `UsageLimitsBand` renders one row per ACCOUNT (`UsageAccountRow.tsx`): the
  provider mark, the provider, `email · plan`, and that account's windows side
  by side as meters (5-hour first, then weekly, then monthly, then anything else
  the provider reports). Inline provider errors, stale state, and the source and
  updated time stay on the row. The external-link target comes from
  `status.accountUrl` falling back to the shared `usageProviderAccountUrl`,
  never from a second URL map in the component.
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
  shared ordering guard for the compact header and full quota panel. It orders
  by `revision.seq` within one `producerId` and always accepts a snapshot from
  a different producer, so unrelated wall clocks cannot latch the meters.
  Unstamped on-disk cache snapshots stay on the legacy `lastPolledAt` path.
  Each component resets the guard when the project binding changes.
- `apps/desktop/src/renderer/components/settings/AdeUsageSection.tsx`
  — Settings > Usage. One scrolling page, deliberately not split by where a
  number comes from: dividing live limits from history means "am I spending a
  lot, and am I about to be cut off" takes two screens held in your head.
  Reading order is the headline totals, then whether you can keep going, then
  the shape of the spend: a totals card (Estimated cost, Tokens, Sessions,
  Active days — each with a 14-day
  sparkline and a change, plus a small strip of Cached input / Output / Lines
  changed / Pull requests), a **Rate limits** card of
  radial gauges (`UsageLimitGauges`) shown for the This machine and This project
  scopes, the daily chart (`UsageDailyChart`), **Week over week**
  (`UsageWeekCompare`), **By provider** and **Where the cost went**, the
  Breakdown panel (per-provider and per-model totals with estimation notes, plus
  GitHub and ADE-local activity as separate labeled columns, never max-merged),
  a **Machines** list, `ActivityModule`, and — on the account scope only — a
  pooled **Live limits** card (`UsagePooledLimits`). The toolbar carries a
  three-way **scope** control (All machines / This machine / This project,
  persisted to `ade.stats.scope.v1`), a **range** control (Today / 7d / 30d /
  year / all, `ade.stats.range.v1`), and Refresh. A meta line reports freshness
  ("refreshing"), estimation caveats, and the scope the provider totals were
  computed at. It reads `window.ade.usage.getAdeStats({ preset, scope })` and
  calls `window.ade.usage.refreshHistory()` for explicit refresh; the first
  render is stale-while-revalidate (cached provider/GitHub data plus live
  project-DB aggregates return immediately while expensive provider-ledger and
  `gh` scans refresh in the background). Provider colors come from
  `providerColor`.
- `apps/desktop/src/renderer/components/usage/UsageLimitGauges.tsx` — the
  This machine / This project **Rate limits**: one radial gauge per provider
  window (5-hour, weekly, monthly…), pooled across that provider's accounts. A
  gauge reads in **% left**, marks where a perfectly steady burn would be with a
  tick on the arc, tags itself on track / watch / low, and draws a thin cycle
  bar ("Day 3 of 7") under the dial. `usageLeftLevel` / `usageLeftLevelColor` in
  `usageDesign.ts` give the neutral-meter rule — amber at 20 % left, red at 5 %
  — shared by every kit meter, gauge and home ring.
- `apps/desktop/src/renderer/components/usage/UsageSparks.tsx` and
  `UsageWeekCompare.tsx` — the small trend marks and the week-over-week chart.
  `UsageSparks` draws a 14-day sparkline (area, line, a dot on today), an on/off
  day strip, and the `periodDelta` / `DeltaTag` change, all from the same daily
  series as the big chart so a trend cannot disagree with its number.
  `UsageWeekCompare` pairs each of the last seven days with the same weekday a
  week earlier as grouped bars and states both totals; below a 30-day range it
  says so instead of drawing a misleading pair.
- `apps/desktop/src/renderer/components/usage/usageProviderNames.ts` — the one
  provider-name table (`humanizeProvider`), so `lmstudio` reads "LM Studio" on
  every usage surface.
- `apps/desktop/src/renderer/components/usage/UsageDailyChart.tsx` — the
  layered daily chart, plotting one series per provider from
  `AdeUsageDailyPoint.byProvider` for either cost or tokens. Top-N providers by
  volume get their own series and the tail merges into a neutral **Other**; a
  host that reports no per-provider split falls back to one combined series
  rather than rendering empty. `buildDayColumns` / `selectTopSeries` do the
  bucketing and series selection outside render.
- `apps/desktop/src/renderer/components/usage/usageDailyChartModel.ts` — that
  chart's React-free half: day-column reduction, series selection, scale, curve
  maths, and SVG path geometry, with the component left to measure a box and
  render what comes back. Being React-free is load-bearing rather than tidy:
  `usageTrackingService.test.ts` asserts the main process's daily split against
  this reducer instead of a re-implementation, and importing the component to do
  that dragged React and the whole icon graph into a main-process test.
  Everything is re-exported from `UsageDailyChart.tsx`, so no call site needs to
  know about the split.
- `apps/desktop/src/renderer/components/usage/useUsageSnapshot.ts` — the single
  subscription to the host's live usage snapshot (`getSnapshot` / `onUpdate` /
  `onProjectBindingChanged`, the binding-generation guard, and
  `shouldApplyUsageSnapshot` revision ordering), owned by the popover and passed
  down. Preload publishes its own rebinds, so this hook sees a binding change
  even when main does not push one.
  The popover and the quota band each used to keep a private copy with its own
  guard and then hand it back up through a callback — two readers and two guards
  over one number, which is the arrangement where a late response is discarded
  by one and accepted by the other.
- `apps/desktop/src/renderer/components/usage/usageDesign.ts` — the shared
  visual vocabulary for every usage surface: five type steps and no more, card
  and section rhythm, pressure colors, and the chart's top-N/Other rule.
  Everything resolves to the app's Tailwind theme variables, which is what
  makes the usage surfaces follow light and dark instead of the dark-only
  `rgba()` literals they used to bake in.
- `apps/desktop/src/renderer/components/usage/usageWindowFormat.ts` — window
  labels, reset countdowns, percentages, and pace/trend phrasing, shared so the
  header chip and the Live limits band describe one window with the same words.
  `formatCountdown` is the bare "6d 7h" form for a segment chip whose glyph
  already says "resets"; `formatResetClock` is the absolute time beside it.
- `apps/desktop/src/renderer/components/usage/usageLimitModel.ts` and
  `UsageAccountRow.tsx` — the headroom reading of a live window. The model is
  pure and clock-injected: `poolAccounts` merges the same login reported by two
  machines into one `UsageAccountView` with a `machines` list (freshest first);
  `buildLimitCards` groups a provider's windows into one card per window label
  with one segment per account, computes pooled headroom, and computes what each
  account's reset restores to that pool; `buildAccountRows` transposes those
  cards into one row per account, so both shapes read one set of numbers. A
  window with no `accountId` (a host predating account attribution) falls back
  to the provider's single account, and a provider with no account directory at
  all falls back to `status.accountEmail`, then to "This machine". Each meter
  fills to the HEADROOM in the provider's brand colour — the same quantity its
  number names — with the spent remainder hatched, and takes its pressure
  colour from consumption so a nearly-dry window still reads hot; hover, focus,
  or click opens that window's detail panel (plan,
  machines, headroom, absolute reset, pace, model split, restore, and the
  provider limits link), edge-anchored so it cannot overhang the 420px popover.
  A row carrying a banked reset credit also offers **Use reset**
  (`ade.usage.consumeResetCredit`). Full behaviour in
  [usage-tracking.md](usage-tracking.md).
- `apps/desktop/src/main/services/usage/accountBalance.ts` — the pure smart-
  balance selector for new Claude/Codex chats. It picks the signed-in account
  with the most weekly room left relative to its reset, after subtracting the
  burn already committed there (measured, pending and reserved), gates on the
  projected five-hour room, skips a login that is gone, and reports why it
  skipped when no account was a real choice.
- `apps/desktop/src/main/services/usage/windowAutoStart.ts` — schedules one
  best-effort lightweight request per enabled Claude/Codex account shortly
  after a five-hour reset, or right after the provider ends the window early
  (including a reset credit spent in ADE), through a per-provider opener table
  and no persisted timer state. `AUTOSTART_WINDOW_TYPE` in
  `shared/types/providerInstances.ts` names the eligible providers and gates
  the settings toggle.
- `apps/desktop/src/shared/usageResetCredit.ts` — the shared reset-credit
  outcome and copy contract used by desktop, CLI, and paired action callers.
- `apps/desktop/src/main/services/usage/providerAccountIdentity.ts` — which
  account the live numbers belong to. Reads Codex's `auth.json` `id_token`
  payload (`email`, `chatgpt_plan_type`) and Claude's `.claude.json`
  `oauthAccount.emailAddress` (`subscriptionType` / `rateLimitTier`) from
  `os.homedir()` or the provider's own env override — never the Keychain, so
  Windows and Linux behave identically — caches for 5 minutes, and returns
  `undefined` rather than guessing. No token reaches a snapshot, a log, or
  disk. Both the usage poller and `providerConnectionStatus.ts` call it, so
  Settings > Providers and the Limits cards cannot name two different accounts
  for one provider.
- `apps/desktop/src/renderer/components/usage/UsagePaceBar.tsx` and
  `UsageSegmented.tsx` — the quota pace bar and the segmented control used by
  both usage surfaces.
- `apps/desktop/src/main/services/usage/sharedUsageTracking.ts` — one usage
  tracker per ADE home. Every project scope in the brain attaches to it
  (`attachSharedUsageTrackingScope`); the last detach disposes the poller.
- `apps/desktop/src/main/services/usage/bootedUsageScope.ts` — picks any
  already-booted local project root so unbound usage IPC and the main-process
  usage-event relay borrow the same brain scope.
- `apps/desktop/src/main/services/usage/usageTrackingService.ts` — owns the
  live quota snapshot plus the retrospective `getAdeUsageStats(args)`
  projection. `args.scope` selects `account` (every machine on the ADE account,
  merged from published rollups), `machine` (every session in the provider's
  local ledgers, codeburn-comparable), or `project` (only sessions attributable
  to the current project root by cwd match); GitHub and ADE-DB metrics are
  always project/repo scoped regardless of scope. The three are one control
  rather than two axes — a project normally lives on one machine. `account`
  merges historical cost, tokens, and code movement only; it deliberately does
  not change the live quota windows, because provider rate limits are tied to
  the provider account rather than the machine, so every machine already
  reports the same window. Provider token totals are
  deduplicated from the local provider ledgers, all daily buckets and range
  boundaries key on machine-local calendar days (`localDay.ts`), and GitHub vs
  local activity are reported as separate labeled groups (never max-merged).
  Live quota polling is adaptive and coalesced, retains unexpired last-good
  provider windows with source/freshness metadata, and stays independent from
  the expensive provider-ledger and GitHub history scans. Each published
  snapshot carries `revision`. Runtime-backed projects use the machine brain as
  the single quota owner; production desktop does not create a second
  project-context tracker that could race the runtime event stream. Unbound
  windows proxy usage IPC to a booted brain scope and receive the brain's
  snapshots via main's `ade.usage.event` relay.
  It returns cached provider/GitHub results and current DB aggregates without
  awaiting expensive scans, exposes freshness metadata (`fresh` / `refreshing`),
  and coalesces stale provider/GitHub revalidation in the background
  (`refreshStatsInBackground`, single-flight per range + source).
- `apps/desktop/src/main/services/usage/accountUsageRollup.ts` — folds one
  machine's cost snapshots into day × provider × model rows and merges the
  machines' rollups into an `account`-scoped `AdeUsageStats`, including the
  `machines` contribution list (`live` / `rollup` / `stale` / `deduped` /
  `failed`). Aggregates only: no transcript record, session id, or path crosses
  the machine boundary. GitHub metrics are deliberately excluded from the merge
  because they are repo-scoped, not machine-scoped — three machines with the
  same clone would triple one PR count — so the account page shows the local
  machine's GitHub numbers and says so in `sourceNotes`.
- `apps/desktop/src/main/services/usage/accountUsageRollupStore.ts` — durable,
  CRR-replicated storage for those rollups in `usage_machine_rollups` /
  `usage_machine_rollup_meta`, retaining `ROLLUP_RETAINED_DAYS` (400) so the
  longest `year` preset is never short a day at its far edge. Uniqueness is the
  composite primary key `(machine_key, day, provider, model)`, because a
  CRR-converted table may not carry any UNIQUE index besides its primary key.
  Writers skip no-op upserts so republishing unchanged history does not churn
  the CRR clock. The store never throws at its caller: a Usage page that cannot
  read its own cache shows one machine's numbers, not an error.
- `apps/desktop/src/main/services/usage/accountUsageSource.ts` — dedupe of two
  machines that read the *same* transcript files (a synced home, an SMB/NFS
  share, a roaming profile), which would otherwise double every token. Identity
  travels with the files: a `.ade-usage-source` marker id written once into the
  transcript home, so whoever mounts that directory reads that id wherever it is
  mounted. `isSameTranscriptSource` is marker-then-roots and nothing else — when
  both sides carry a marker, equal ids are the same source and different ids are
  not; when either side has none, the folded root digests must match exactly.
  Roots are sha256 digests of `pathKey`-normalized paths, so no absolute path
  leaves the machine that scanned it. The known trade: two machines cloned from
  one disk image share a marker and merge, under-counting — visible in the
  Machines list as `deduped`, and the opposite direction from silent
  double-counting. Deleting the marker on one of them mints a fresh id.
- `apps/desktop/src/main/services/usage/accountUsageLiveRefresh.ts` — the
  opportunistic half: ask whichever machines are reachable right now for a fresh
  rollup over the paired remote-connection pool
  (`usage.getUsageRollup`), capped at `MAX_LIVE_MACHINES` (12) so a large fleet
  cannot turn one page open into a fan-out storm. Best effort by design — the
  durable rollups are the floor the page renders from and this only raises it,
  so an unreachable machine becomes a `failure` entry, never a rejected promise
  that takes the other machines' numbers down with it. A peer that genuinely
  does not know the method is reported as too old to share usage; the guard
  explicitly excludes authorization denials, which ADE also dresses in
  `methodNotFound`.
- `apps/desktop/src/main/services/usage/usagePricing.ts` — per-model token
  rates, all from models.dev (vendor row for a bare model id, the provider's
  row for a `provider/model` name; fetched with a 10 s timeout, cached to
  `~/.ade/models-dev-pricing.json`, refreshed daily, dropped after 30 days). A
  model models.dev has not listed yet takes its registry / model-manifest
  price. There is no hand-maintained rate table.
  `tokenPriceSource(model)` reports `list` or `fallback` so a cost headline can
  say where its rates came from. See
  [Usage tracking strategy](./usage-tracking.md#where-a-token-price-comes-from).
- `apps/desktop/src/main/services/usage/githubActivityStats.ts` — commits, pull
  requests, and the code movement inside them, lifted out of
  `usageTrackingService.ts` because it is the one part of it that talks to
  something off the machine. It shells out to `gh` under a 60 s command timeout
  and fails soft: no `gh`, no auth, and no remote are the common case, not an
  error state, so every path returns an empty stats object carrying a sentence
  about why instead of throwing into the page. The service consumes it through
  `scanGithubActivityStats` and merges the result into the daily series itself.
- `apps/desktop/src/main/services/usage/usageLedgerWorkerClient.ts` — spawns and
  folds the isolated ledger scan. The worker streams NDJSON (a roster header,
  then one line per provider as it finishes) so a timeout returns the providers
  that landed instead of discarding every finished scan along with the running
  one. `incompleteProviders` — providers reached but not fully readable, plus
  providers whose root yielded nothing — becomes `publishLocalRollup`'s
  `skipReconcileProviders` so a partial round is never read as a deletion, and
  carries the previous round's snapshots forward so it cannot lower a totals
  figure. Its `LEDGER_WORKER_TIMEOUT_MS` is the origin of every budget above it:
  `USAGE_REFRESH_HISTORY_REMOTE_TRANSPORT_TIMEOUT_MS` (remote JSON-RPC leg) and
  `USAGE_REFRESH_HISTORY_TIMEOUT_MS` (renderer IPC and the runtime-backed
  `usage.refreshHistory` action) are derived from it so the chain increases
  monotonically outward rather than racing.
- `apps/desktop/src/main/services/account/localMachineIdentity.ts` — the single
  answer to "which machine is this?" for the account directory: the key peers
  stamp onto incoming usage rollups and the directory files this computer's data
  under. It depends on nothing from Electron, so the rollup publisher and the
  CLI-hosted brain resolve the same identity without importing the IPC bridge —
  publishing under a different key would mint a phantom machine no peer ever
  reconciles with the real one.
- `apps/desktop/src/main/services/usage/providerQuotaParsers.ts` — normalizes
  the live-quota responses of Claude, Codex, Cursor, Copilot, Grok, OpenCode
  Go, and Kimi, and the Factory session credits. Codex buckets use their
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
- `apps/desktop/src/main/services/usage/ledgers/ledgerScanCore.ts` — the
  plumbing that all history scanners share: `TokenEntry`, scan completeness,
  file discovery, line-streamed JSONL reads, and the read-only SQLite opener.
- `apps/desktop/src/main/services/usage/ledgers/acpProviderLedgers.ts` — the
  history scanners for the ledgers that Pi, Qwen, Grok, and Copilot CLI keep
  on disk.
- `apps/desktop/src/main/services/usage/usageLedgerScanners.ts` — the one list
  of history scanners. The ledger worker and the in-process scan both walk it.
- `apps/desktop/src/main/services/usage/providerLedgerFormats.ts` and
  `tokenSplit.ts` — the provider record constants and token-split rules that
  the live chat path and the history scanners share.
- `apps/desktop/src/main/services/usage/cursorBilledUsageStore.ts` — the
  Cursor `getUsage` billed rows of API-key turns, one row per run. The worker
  scan does not read them.
- `apps/desktop/src/main/services/usage/cursorDashboardUsage.ts` — reads
  Cursor's dashboard usage events for the per-turn ledger. It writes no Usage
  rows.
- `apps/desktop/src/main/services/usage/usageAccountId.ts` — the one rule for
  a usage account id, shared by the quota poller and the per-turn ledger.
- `apps/desktop/src/main/services/usage/turnUsageLedger.ts` — the per-turn
  usage ledger: one JSON line per finished chat turn under
  `<adeHome>/usage/`. `usage.getTurnUsageSummary` reads it asynchronously.
- `apps/desktop/src/main/services/usage/quotaBurnRate.ts` — what one percent
  of a subscription window costs, from the ledger's quota readings and rows.
- `apps/desktop/src/main/services/router/` — the model router in shadow mode.
  `routeCatalog` rates every route (harness × model × effort) from the daily
  model registry; `routerCore` classifies the task and picks the cheapest route
  that keeps quality; `modelRegistryStore` caches the registry at
  `<adeHome>/router/registry.json`; `modelRouterService` logs decisions and
  outcomes to `<adeHome>/usage/router-shadow-*.jsonl` and changes no turn;
  `routerEfficiency` replays every ledger thread at its free switch points and
  sums the shadow log's subagents for `ade router efficiency`; `modelCatalog`
  joins the runnable models with their full registry profiles for
  `ade models catalog`; `modelSheet` scores those models per task kind and
  adds curated words for `ade models sheet`. The wire contract is
  `apps/desktop/src/shared/routerRegistry.ts`.
- `apps/desktop/src/main/services/usage/turnUsageReconcilers.ts` — amends a
  ledger row after the turn, from Cursor's dashboard events and Factory
  session credits.
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
  desktop and web. On that surface the card is an opaque plate using
  `--work-popover-bg` over `--color-bg`, matching the machine/lane submenu.
- `apps/desktop/src/renderer/components/usage/providerColors.ts` — theme-aware
  brand color palette for usage bars and legends. `providerColor(provider,
  theme)` returns a per-provider brand color (Claude's rust family, distinct
  hues for the other providers) with a deterministic hashed fallback for
  unknown providers. **This table is the product's source of truth for a
  provider's colour**: `shared/modelCatalog.ts`'s `PROVIDER_GROUP_COLORS` and
  both iOS tables (`ADESharedTheme`, `ADEDesignSystem`) mirror its dark values.
  Accounts deliberately have no colour of their own — the per-account hash that
  used to tint a chip could draw a Claude account in Gemini's blue, and the
  email on every row is what tells accounts apart.
Diagnostics are rendered inside `StorageSection.tsx`
(`storage/StorageDiagnostics.tsx`) under Diagnostics. The
standalone `ProxyAndPreviewSection.tsx` and
`DiagnosticsDashboardSection.tsx` files were imported by nothing and have
been deleted.

Auto-update (General preference, top-bar control, and exceptional recovery
banner):

- `apps/desktop/src/main/services/updates/appBundleOwnership.ts`,
  `registerAppBundleOwnershipIpc.ts`,
  `apps/desktop/src/shared/types/appBundleOwnership.ts` and
  `apps/desktop/src/renderer/components/app/AppBundleOwnershipBanner.tsx` —
  macOS root-owned `/Applications/ADE.app` detection and the docked "ADE will
  ask for your password on every update" banner (Fix it runs an `osascript`
  admin `chown -R`; local-only, no pin). See
  [Desktop auto-update](./desktop-auto-update.md#app-bundle-ownership).
- `apps/ade-cli/src/commands/windowsDesktopRescue.ts` — Windows
  `brain update --apply-staged` installs the desktop app itself when one is
  installed. See [Desktop auto-update](./desktop-auto-update.md).
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
  transitions back through `downloading`. A staged update never stops a check;
  see
  [Checking while an update is staged](./desktop-auto-update.md#checking-while-an-update-is-staged)
  for what each entry point does with a same, newer, or failed feed answer.
  `userInitiated` only labels `autoUpdate.check_requested`; it does not
  change whether the check runs. `quitAndInstall()` is
  transactional and asynchronous: it gates on the current snapshot being `ready`,
  re-runs `updater.checkForUpdates()` to
  confirm the staged installer is still the latest, and only then
  flips the snapshot to `installing`, persists the
  `pendingInstallUpdate` global-state row, and calls
  `updater.quitAndInstall(false, true)`. If the refresh check fails, it parks as `refresh_failed`, returns
  the snapshot to `ready` on the staged version, and keeps the
  archive. A consent that aborts before the native updater takes over sets
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
  do not fall back to an isolated build-mismatch runtime — now as one explicit
  four-step transaction rather than a silent side effect of a build-hash
  mismatch (see `updateTransaction.ts` below). On Windows,
  electron-builder generates the installed `app-update.yml` from the build's
  GitHub publish authority; package smoke requires it to match
  `ADE_RELEASE_REPOSITORY`. The source default remains upstream
  `arul28/ADE`; fork CI overrides it with the repository performing the build.
  The NSIS handoff uses the non-macOS 60-second quit deadline. Signed/public
  Windows release assets remain behind the independent repository-variable
  gates described in
  [desktop-auto-update.md](./desktop-auto-update.md#windows-update-path).
- `apps/desktop/src/main/services/updates/updateTransaction.ts` —
  `runUpdateTransaction`, the dependency-injected `swap` → `service` →
  `restart` → `health` sequence that runs once after a relaunch whose snapshot
  carries `recentlyInstalled`. Pure: no Electron, no timers. Replacing the app
  bundle does not touch the background service, so without this the machine
  keeps running old code until something reinstalls and restarts it — and a
  failure in that repair was invisible. The first failure stops the sequence and
  later steps record `skipped`; a dependency that throws becomes a `failed`
  step, never an unhandled rejection. The typed `UpdateTransactionResult` rides
  the existing `AutoUpdateSnapshot` over `IPC.updateEvent` / `updateGetState` as
  `updateTransaction` — no new channel — and `AutoUpdateBanner` renders its
  one-line `failureMessage` beside the shared **Repair** control. `main.ts` owns
  the single `ProjectRecoveryService` instance it shares with `registerIpc`, so
  repair and this restart stay mutually exclusive. Step-by-step copy and the
  bound dependencies are in
  [desktop-auto-update.md](./desktop-auto-update.md#applying-an-update-is-one-transaction).
- `apps/desktop/src/main/services/updates/runtimeRestartVerification.ts` —
  what the transaction's `restart` and `health` steps actually bind to.
  `verifyRuntimeIdentity` is the pure verdict (`matches`, or one of
  `unreachable` / `incompatible` / `version` / `build` / `stale_runtime`);
  `checkRuntimeIdentity` is the shared probe-and-judge both steps call, so they
  cannot drift; `runVerifiedRuntimeRestart` restarts and re-verifies up to
  `maxRestarts` (2) and returns a **failed** step when it still cannot prove the
  installed brain is the one answering. The old step asked the endpoint whether
  it was `ok`, which a surviving pre-update brain answers just as well as the
  new one — so a machine could report a green update while running yesterday's
  code and holding the sync-host lease. Its log events are
  `autoUpdate.restart_not_needed` / `_required` / `_attempt_failed` /
  `_verified` / `_verification_failed`. See
  [desktop-auto-update.md](./desktop-auto-update.md#the-restart-step-has-to-be-told-the-truth).
- `apps/desktop/src/main/services/processes/processStartTime.ts` —
  `readProcessStartTimeMs(pid)`, one bounded `/bin/ps -o lstart=` under a pinned
  `LC_ALL=C`, `null` on Windows. It is what makes a recorded pid an identity
  rather than a number the OS may already have handed to somebody else; the
  update path uses it to recognise a stale pre-update brain, and the external
  brain watchdog uses it before killing anything.
- `apps/desktop/src/shared/updateVersions.ts` — the one ADE version comparator,
  shared by main and renderer. Update prompts, "is this machine behind?", and
  the auto-update state machine all have to agree on what "newer" means, so
  SemVer-ish ordering (numeric core segments, then prerelease precedence, with a
  release outranking any prerelease of the same core, and unparseable segments
  read as `0` rather than throwing) lives here instead of being re-derived per
  surface. `autoUpdateVersions.ts` re-exports `compareUpdateVersions` (every
  main-process caller imports it from there) and remains the home for the
  changelog / GitHub release link builders.
- `apps/desktop/src/renderer/components/app/AutoUpdateControl.tsx` —
  the primary update control: a small badge in the app shell top bar. Shows
  "Checking for updates" / "Downloading vX.Y.Z (NN%)" / "Install update
  vX.Y.Z" / "ADE will quit and reopen" depending on the snapshot. When
  `lastInstallFailed` names the staged version, the ready label reads "Retry
  install vX.Y.Z" and the tooltip says whether the download is still on the
  machine. Clicking the
  install affordance prompts the user (`autoUpdateInstallAction.tsx`). The
  prompt always says what the restart stops on this computer: "2 agent
  chats running, 1 terminal open" with the chats by name, "Nothing is
  running", or "Couldn't check what's running" when the brain did not
  answer within 3 seconds. The answer is the brain's
  `runtime.updateImpact` (read by `main/services/runtime/updateImpactProbe.ts`),
  which covers every project it has open and personal chats, not only the
  projects with a tab. A brain from before that method is asked for chats
  project by project, plus `runtime.activitySummary`; when that says more
  is running than the chats it found, the prompt says more work is
  running rather than claim nothing else is. The quit prompt reads the
  same probe and, when it could not check (or only knows that something
  unnamed is running), says so instead of counting zero. Each probe logs
  `autoUpdate.impact_probe` or `autoUpdate.impact_probe_unknown` to
  `ade-update.jsonl`. "Resume this computer's chats" is offered when a listed chat
  can be queued to continue (personal chats cannot). Connected machines on
  an older ADE are listed too, and update first when their checkbox stays
  on (see remote runtime, `machine.updateAndRestart`). The prompt then sets a local
  `installRequested` flag, and calls
  `window.ade.updateQuitAndInstall()`; if the IPC returns `false`
  (refresh check failed, no longer ready, etc.) the flag is cleared
  so the badge falls back to the underlying snapshot. While
  `installing` (or after the user clicks install but before the main
  process flips status), the badge animates in fuchsia and is
  disabled.   The post-install dialog is a centered card titled
  "Updated to vX.Y.Z" (the running version) with an X close button
  and click-outside dismiss. When this build bundled
  `changelog/vX.Y.Z.mdx`, the card shows that page's summary and section
  bullets. It offers a "Changelog" button that opens
  `recentlyInstalled.releaseNotesUrl` (the docs changelog) and a "View
  on GitHub" button that opens `recentlyInstalled.githubReleaseUrl`
  (the GitHub release page). Each button is shown only when its URL is
  present; opening either link also dismisses the notice.   The update quit marks one relaunch to reopen the local project tabs
  that were open, and each project comes back on the route and chat it
  already remembered. That mark is consumed on the relaunch, so a later
  ordinary launch still opens on the welcome surface. Closing a window
  drops its tabs from the saved set. The first update into this version
  has no saved set yet, because the previous build did not write one.
- `apps/desktop/src/renderer/components/app/useAutoUpdateSnapshot.ts` — the
  shared subscription hook (initial `updateGetState()` read + live
  `onUpdateEvent`). Every truthful-version surface — the top-bar pill, the
  app-shell banner, and the About panel — consumes it so they never disagree
  about what is running versus what is staged.
- `apps/desktop/src/renderer/components/app/AutoUpdateBanner.tsx` — the
  floating prompt for a normally staged `ready` update, the exceptional
  app-shell recovery banner, and the automatic-install countdown toast,
  colocated so they read one snapshot subscription. The ready prompt names the
  version and offers **Restart and install**, sharing its impact confirmation
  and install handler with the flashing top-right control. Dismissing it hides
  that version's prompt for the current app session; the top-right control
  remains available. The banner renders a `parked` state as "ADE update didn't
  finish — Restart to retry" and a failed handoff as "ADE update did not
  install — Restart to retry", each with a **Restart now** action. Recovery
  dismissal is keyed on a stable failure signature so a fresh abort or failed
  attempt can reappear. The toast reads "ADE will update in Ns", is driven off
  `autoApplyPending`, and has a **Cancel** action wired to
  `updateCancelAutoApply()`.
- `apps/desktop/src/renderer/components/app/autoUpdateInstallAction.ts` — the
  shared install-impact confirmation, decision capture, and
  `updateQuitAndInstall()` action used by the top-right control and floating
  ready prompt.
- `apps/desktop/src/renderer/components/app/BrainRecoveryNotice.tsx` — the
  app-shell notice shown once per distinct machine-brain event-loop recovery.
  It reads the one-shot `localRuntime.lastWedge` from `app.getInfo()` and words
  the notice from `formatRecoveryMessage`, which has two cases because the two
  recoveries are not the same event. A wedge attributed to a running command
  reads "ADE recovered from a background issue … a stuck task (…) was
  restarted". A wedge whose `lastCommand` is `external-watchdog` had no stuck
  task — the whole brain stopped answering and something outside it restarted
  the service — so naming a command there would invent one, and it reads "ADE
  restarted its background service at … after it stopped responding." It
  acknowledges by persisting the wedge `ts` to `localStorage`
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
  `.ade/local.yaml` and the one-time legacy carry-over as consumed by
  `projectConfigService`; types in `shared/types/config.ts`.
- [first-run.md](./first-run.md) — first launch lands on Work. There is
  no blocking project-setup dashboard; optional integrations live in Settings.
- [harness-presets.md](./harness-presets.md) — saved pairings of a harness
  (the program ADE runs) and a model provider (the account, key, or
  subscription that answers for it), managed in Settings › Providers › Custom
  and selectable from the Custom tab of every model picker.
- [mcp-servers.md](./mcp-servers.md) — Settings › MCP servers: servers
  defined once in the account and handed to every agent, switched off per
  computer or per project, with secret values in the account vault and an
  import from the provider CLIs' own configs.

## Onboarding responsibilities

Onboarding covers two layers.

### First run on a computer

What a person sees the first time ADE opens on a computer. It runs once per
computer (not per project) and is stored in that computer's global app state
(`welcomeVideo.completedAt` / `dismissedAt`, the key kept from the welcome
video it replaced), so a computer set up before it existed never sees it.

1. **Welcome.** One card on the launch gate's glass: the landing page's
   headline, one sentence, the provider marks, **Get started** and **Skip
   setup**. Skip marks onboarding skipped, so no hint shows later either.
2. **Sign in**, if this computer has no ADE session (the account is required).
3. **Connect your agents** (`FirstRunAgents.tsx`). Claude Code, Codex and
   Cursor, each Connected (with its account) or with a **Sign in** button,
   read from the same `ai.getStatus` Settings › Agents & Models reads (it
   answers before any project is open). Claude Code and Codex sign in through
   the Settings account sheet, a machine-level login that needs no project;
   Cursor through its browser login. Other providers show as chips only when
   already connected; the card points at Settings for the rest. Status is
   re-read on open, after a sign-in and on window focus, never polled. While
   this card is up, project discovery starts in the background so the next
   card opens with its list.
4. **Bring your projects in.** `discoverOnboardingProjects` reads the history
   of every provider ADE imports chats from: Claude Code's transcripts (one
   listing, plus the head of the newest transcript per folder for its cwd),
   Codex's thread index (one grouped query), and the rest (Cursor, Droid,
   OpenCode, Pi, Copilot…) through the importer's own discoverers, capped at
   the newest 300 sessions each with a 2.5s budget per provider. It maps each
   folder to its git project (an ADE lane or linked worktree counts toward
   its main checkout), drops scratch, temp, Downloads and projects already in
   ADE, and returns them newest first. If discovery fails, setup reports that
   it couldn't load the projects and offers a retry instead of showing an
   empty result. A project with at least two chats in the last 30 days starts
   ticked. Each row shows its worktrees (they open as
   lanes) and when it was last active; a row with recent chats also has an
   **Import N chats** pill with its providers' marks (the draft page's import
   pill, per project), off by default. The pill has two targets. Its box (and
   the marks) turns the import on for every chat or off. Its count opens a
   picker of those chats (`FirstRunChatPicker`), read on first open through
   `app.listOnboardingProjectChats` and kept for the card's life: each chat
   with its provider, title or opening prompt, the lane folder it ran in,
   when it was last active and its prompt count, each with its own box, plus
   Select all / none and "5 of 7 chats". Unticking chats narrows the import
   and the pill reads **Importing 5 of 7 chats** (its box shows a dash).
   Unticking the last one turns the import off; ticking one while it is off
   turns it on with just that chat. The box always means all or nothing, so
   turning it on again brings every chat back. The list reads Claude and
   Codex for that project's folders (Claude stops at the window's edge by
   file time) and filters discovery's own read of the other providers, one
   provider at a time under the same 2.5s budget. Escape closes the picker,
   never setup. Below the list: a QR for ADE on iPhone and a line about
   signing in on another computer, shown to everyone.
5. **Into ADE.** The chosen projects are added to recent projects and opened
   as tabs, and the first one opens. Its worktrees become lanes through the
   normal adoption on open. For each project whose pill was on,
   `useOnboardingChatImport` imports its chats from the last 30 days (up to
   25, newest first, any provider) into the lane each one ran in, or the main
   checkout's lane, the first time it opens; a session that may still be open
   in its CLI is skipped. Chats left out in the picker are stored with the
   queued entry as `provider:sessionId` keys (`excludedKeys`, the importer's
   own ids) and skipped; an entry without the list imports everything. It is
   a list of what to leave out, so a chat that starts after setup still comes
   in.
6. **The tour** (`components/onboarding/tour/`). An ADE cursor (violet, a
   size up from the system arrow) glides to a real control, a ring settles on
   it and a card beside it says what it is. In order: the lane chip (ADE works
   in lanes; the checkout is the primary lane), the prompt box, its
   permission/model/effort controls, the lane menu, importing chats, the chats
   list, opening a chat (or, with no chats yet, **Send your first chat**: a
   new chat in the primary lane with "In one sentence, what is this
   project?" in the composer, on a cheap model the computer can run — Haiku,
   Luna or Composer when their provider is connected, else the lowest-priced
   runnable model the registry knows — which the user sends themselves; ADE
   set that model, so it is not saved as the machine's or the composer's
   last-used model, while a model the user picks there is), the
   Tools pane, back to a new chat, a new project
   tab, the Home page and its edit tools, and Connections. Some steps ask for
   the click (the card says so, and the click moves the tour on); every card
   also has Next and Back. Nothing is dimmed or blocked. When the user goes
   elsewhere the card steps aside and a **Tour paused** pill offers **Show
   me**; the step comes back when its control is on screen again, across
   reloads. A step with nothing to point at (no chats to open, the Tools pane
   already open) is passed over. **Skip tour** ends it and every hint;
   "Show me around again" in the help menu or the command palette starts it
   over. Contextual hints (`hints/`, today only "This chat needs you") wait
   until the tour is finished.

Everything here runs on, and reads, the computer ADE is opening on. The
hosted web client has no first run; it controls other computers.

To walk all of it as a new user without touching your own ADE, run
`npm run dev:desktop -- --first-run` (see
[local development](../../development/local-development.md#walk-first-run-setup-as-a-new-user)).

### What's new pages

Free-form announcements the owner writes as features land
(`renderer/components/announcements/`). A page is any React component in
`pages/`, with one entry in `announcementPages.ts`
(`{ id, revision, title, Page }`); nothing about its layout is fixed. The
modal (`AnnouncementsHost`) adds only a close button and, when several are
due, a pager.

- **Once per page per computer**, keyed by `id` + `revision` in this
  renderer's localStorage (`ade.announcements.seen.v1`). A new entry shows on
  every computer that has not seen it; bump `revision` to show an edited page
  again; remove the entry to retire it. Not tied to releases.
- **When:** inside a project (never on Home), a few seconds after it opens,
  with no dialog, setup screen or tour up, and only once onboarding finished
  or was skipped before this launch, so a new user meets them on a later
  visit. A page counts as seen once it is on screen.
- **After an update** this computer installed: on the first launch of the new
  version, after the boot splash. Up to three unseen pages, then the release
  notes since the version it came from. This one arrives: the logo flies from
  where the splash left it into the window's header while the window opens
  around it (`WhatsNewArrival.tsx`; `BootSplashReveal.tsx` records the splash's
  last logo box and says when the splash is gone). The window mounts one frame
  after the logo, so the frame in which the splash goes stays light. Reduce
  motion (ADE's or the system's) skips the flight.
- **Reopen:** Help › What's new and the command palette ("What's new") show
  every page, with the plain dialog fade.

To add one: create `pages/<Name>.tsx` exporting a default component that
takes `{ close }` (call it before navigating from a "Try it" button), then add
its entry at the top of `ANNOUNCEMENT_PAGES`.

The account management page introduces provider accounts, usage, settings and
the initial context inventory, and links to AI connections.

### Boot splash and the ADE logo

While a window starts, "Starting ADE" plays a liquid glass reveal of the logo
(`components/ui/LiquidGlassLogoReveal.tsx`, a WebGL2 pass; its texture,
renderer, timeline and settings live in `components/ui/liquidGlass/`). The
splash stays for the boot or the reveal (about 3.5 s), whichever ends later,
never longer, and plays once per window (`app/BootSplashReveal.tsx`). Reduce
motion, no WebGL or a logo that fails to load show the still logo and hold
nothing.

The logo everywhere in the app is `<AdeWordmark>` (`components/ui/AdeWordmark.tsx`):
`logo.png` on dark themes, `logo-light.png` (purple and white swapped) on light
ones.

### ADE Tips

Onboarding's second tier: every feature worth knowing, browsed from Help ›
ADE Tips, the command palette, the home screen's ADE Tips widget or the
tour's last card (`renderer/onboarding/adeTips.ts` holds the tips;
`components/onboarding/tips/` draws them). One group at a time, as a wall of
tiles: the group's own tile, screenshot tiles for its headline features
(each tip's `size` and `shot` in `adeTips.ts`, listed in wall order, pack each
group with no holes in four columns and in two) and icon tiles for the rest. Suggestions the user
postponed sit first, under **For you**.

The startup context tip points to provider settings, where the initial context
inventory shows what a new chat receives and where each item is configured.

Every tip has **Try it**. It goes where the feature lives (a page of the open
project, a Settings card, a new chat, Home in a new tab, the Connections
panel, Music) and then the spotlight (`components/onboarding/spotlight/`)
rings the control there with one line on what to do, using the tour's
geometry, page watch and layer. It waits up to a few seconds for the control
to appear, fades after six seconds or on any click or Escape, and leaves the
user where they landed if the control never shows. A tip that lives inside a
chat (rewind, comments, PR watch) rings the open chat's control when there is
one, else a chat row with "Open a chat and…". With no project open, a project
tip goes Home and rings the projects ("Open a project first"). All of it is
navigation in the front window: no call reaches a machine.

Tips also come to the user now and then (`useFeatureTipCard`): a while into a
project session, one tip they have not tried shows as the corner card ("Tip",
Try it, Not now), in this computer's own random order. It shares the corner
with situational suggestions (one card at a time, never during onboarding,
and not within half an hour of a suggestion) but keeps its own pace: up to
three a day, two hours apart, each tip once, and trying a tip from ADE Tips or
the Home widget counts too. It never uses up a suggestion's once-per-launch
slot. ADE Tips' header turns them off.

To test tiers 2 and 3 without waiting days: `npm run dev:desktop -- --first-run
--keep` reopens the isolated app as a returning user, and in dev builds the
command palette has **Dev: Suggestions test mode** (no cooldown, no
once-per-launch or per-day, no snooze; answer a card and the next can show)
and **Dev: Reset Tips, suggestions and What's new** (`resetOnboardingTiers`).

### Situational suggestions

Onboarding's third tier: a small card in the bottom-right corner (the
`suggestion` placement, see `docs/design/notices.md`) that shows a feature only
when ADE sees a signal that it would help now. Each card says what the feature
is, why now, one action, and **Not now**, which files it into ADE Tips under
"Suggested for you" (start it from there, or **Don't suggest again**).

The shared rules live in `renderer/onboarding/situationalSuggestions.ts`
(`ade.suggestions.v1`, per computer): one card per signal (again only after a
suggestion's own repeat time), at most one new card per launch and none for
four hours after the last, nothing while the tour runs or until onboarding
finished (or was skipped) on an earlier launch. "Not now" snoozes the kind for
two weeks. `components/app/suggestions/useSituationalSuggestion.tsx` draws the
card and does the Tips plumbing; `SituationalSuggestions.tsx` (mounted in
`AppShell`) holds one small hook per signal. The lane-template suggestion
(`useLaneDependencyBanners`) goes through the same helper, with two
differences: it comes back for a project after two weeks while it still
applies, and "Don't suggest again" turns it off for that project only
(`neverPerScope`). Its answers from before the shared rules
(`ade.laneTemplateSuggestion.v1`) are folded into `ade.suggestions.v1` on
first read.

| Suggestion | Signal | Action |
| --- | --- | --- |
| Plan running low | A Claude or Codex limit at 20% left or less with one account signed in (the tab machine's usage snapshot); once per provider per reset window | Settings › AI accounts |
| `@` sends work to another machine | Another machine of the project is online, and no sent message has ever had an `@machine` mention | A new chat in the primary lane |
| ADE secrets | A sent message looks like it holds a key or password (`shared/secretText.ts`, the clipboard history's check); again only after 30 days | Settings › Secrets |
| Connect the tracker | A sent message links a Linear, Jira or GitHub issue (or PR) and the tab's machine is not connected to it; the status is read only then | Settings › Integrations › that tracker |
| The Work grid | Activity shows three or more chats working and the grid is off | Turns on Focus with the grid in the open project, opens Work |
| Automations | The same prompt (normalized, 20+ characters, not a slash command) sent three times in a week in this project; only hashes are kept | Automations |
| ADE on iPhone | A week after first run, still no other machine and no paired phone (paired devices are read once, then) | Connections › Phone |
| Stacked PRs | A lane built on another lane (not the main checkout) whose pull request is open, per Activity's PR items, while it has none | PRs |

The send-time checks (`chatSendSignals.ts`, called from `AgentChatPane`'s
submit) read only the typed text, in one O(text) pass, so they work for a chat
on any machine; tracker connections are checked only for chats on the tab's
machine, the one Settings connects. Nothing polls: the other signals read push
feeds the shell already holds. Preview each one in the browser mock with
`?mockSuggestion=<id>` and the flags documented in `browserMock.ts`.

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
   `apps/ade-cli/src/serviceManager/` (launchd / systemd / Windows per-user startup).
   The result is exposed as `LocalRuntimeStatus.serviceInstall` and
   `serviceHealth` (`unsupported | not_installed | installed | running |
   error | unknown`). On macOS both launch agents (the brain and its
   watchdog) carry `AssociatedBundleIdentifiers` naming the channel's ADE
   app, so the system's "can run in the background" notice and Login Items
   show ADE's name and icon instead of the signing developer's name.
4. Install the `ade` command on `PATH`. The `AdeCliSection` "ADE
   command" card calls `window.ade.adeCli.installForUser()`, which
   delegates to the platform helper script bundled with the desktop
   (`/Applications/ADE.app/Contents/Resources/ade-cli/install-path.sh`
   on macOS, equivalents on other platforms). Settings → ADE service shows the
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
SSH-attached runtimes, Linux servers), the ADE runtime and `ade` CLI
install via one command:

```bash
curl -fsSL https://ade-app.dev/install.sh | sh     # macOS, Linux
irm https://ade-app.dev/install.ps1 | iex          # Windows PowerShell
```

The script downloads the static `ade-<platform-arch>` binary plus its
native dependency archive, drops the binary in `$ADE_INSTALL_DIR` (or
`~/.ade/bin`), extracts native modules under `~/.ade/runtime/<arch>/`,
and best-effort registers the login service. No Node or npm is required —
the binary is a Node SEA.

Both installers then put `ade` on `PATH` before anything else prompts:
Windows updates the per-user `PATH` unless `-NoPath`; POSIX writes
`~/.ade/env` and, with consent on a tty, appends one marker-commented
`. "$HOME/.ade/env"` block to the shell profile (`~/.zshrc`,
`~/.bash_profile` on macOS bash, `~/.bashrc` on Linux bash). The block is
grep-guarded so re-running the installer never duplicates it; fish and
unrecognized shells get printed instructions instead, as do
non-interactive runs and `ADE_INSTALL_NO_PATH=1`.

The shell scripts own only what must happen before the `ade` binary
exists: downloading and verifying the runtime, and registering the brain
service. They register it through `ade brain start`, which pins the
runtime's default role to `cto` — the role `ade connect` and the desktop
app both require. Registering through `serve --install-service` instead
inherits an unset `ADE_DEFAULT_ROLE`, which lands on `agent` and makes
sign-in fail on every clean install.

Everything after that is `ade setup`, one implementation both platforms
hand off to, so Windows and macOS cannot drift. It runs the remaining
steps — pinned agent CLIs, account, desktop app — then verifies the
install end to end (brain running, machine linked) and prints a summary
recapping all five steps. A step that fails names the command that fixes
it, inline and again under "What's left"; a clean run prints neither.

Between the tools step and the account step, setup waits for the brain's
endpoint. Everything after it needs a brain that answers, and a brain that is
still coming up is not a broken one: `awaitRuntimeService` probes the socket,
installs the service only if nothing answers, and then keeps dialling for
`SETUP_SERVICE_START_BUDGET_MS` (`RUNTIME_SERVICE_START_WAIT_MS`, 90 s),
printing "Starting ADE's background service..." only if it actually has to
wait. The wait is a courtesy, not a gate — its own failure never costs the user
the account and desktop steps. If the brain is still starting when the account
step fails, that step is reported as *skipped* with "ADE's background service
is still starting" rather than as a failed sign-in, and the summary ends with
"Give it a moment, then run `ade connect`." Reporting a slow start as a broken
install is what used to send people hunting a fault that did not exist.

The account step checks first: an already-linked machine is offered
keep / switch / skip rather than being asked to sign in blind. The
desktop step skips its ~1 GB download when that exact version is already
installed, resumes an interrupted download via a Range request, and
launches the app detached so a Windows console is never inherited.
Use `ade connect --headless` when there is no browser. Non-interactive
contexts skip the prompts and print the follow-up commands;
`ADE_INSTALL_NO_PROMPT=1` (or `-NoPrompt`) opts out explicitly. Running
`ade setup` later re-runs the same flow on its own.

See [`apps/ade-cli/README.md`](../../../apps/ade-cli/README.md)
for the full flow and environment overrides.

### CTO first-run setup

The CTO has no wizard. A project whose `modelPreferences` is null opens
on `ModelPickCard` instead of the thread, the user picks a model that can
steer a live turn, and that pick is the entire setup — there is no
personality question, no project-context step, and nothing to re-run.
Reasoning effort, Fast mode, and Linear all layer in afterward from the
CTO's own settings sheet. `CtoOnboardingState` survives only as an
internal marker list (`intro`, `memory_gardener`) that is never shown.
See [CTO › The welcome screen](../cto/README.md#the-welcome-screen).

## Settings responsibilities

Settings is organised by **scope**. The sidebar group is the answer to "where
does this save, and who does it affect", said once at the top of a group instead
of repeated as a badge on every row:

Settings opens on **Overview**: one **Needs attention** list (every problem
from the project, this computer, other machines, providers, MCP servers,
integrations and Apple, each with its Fix button where there is one, and "Ask
an agent" for the whole list) and an **At a glance** card per area. A failed
read appears as a "couldn't check" row with Check again instead of claiming
nothing needs attention. It gathers problems in the renderer
(`settings/overview/useNeedsAttention.ts`); the project part is
`projectHealth.getReport`
([`project-health.md`](./project-health.md)). Nothing else is called Health.

| Group | Saves to | Pages |
|---|---|---|
| **Overview** | — | Needs attention, At a glance |
| **You** | Your ADE account, everywhere | Account, Chat, Notifications, MCP servers, Usage |
| **Project** | The open project (routed to the machine that owns it) | Lanes (Your lanes, Rules), Agents (Agent notes, PR chat transcripts), Storage & cleanup (Space, Archive, Rules), Location (move, project checks), Secrets (this project on every computer), Integrations |
| **Computer** | The selected machine | ADE service (service status, updates, `ade` command, Send a report, Reset), Providers, Apple devices (This computer), Appearance (This computer), Behaviour |

General and the old Diagnostics/Health page are gone; every entry kept its
id and anchor, and old tab links (`general`, `storage`, `disk`, `diagnostics`,
`health`, `archive`, `project-location`, …) land on the page that holds them.

The Machines group contains one set of pages per project machine. Calls from a
machine page use that machine's binding; sections that only work on the current
desktop or the tab's bound runtime are shown only for the machine they can
reach. Offline machines remain in the navigation and identify why their pages
are unavailable. The Project group is named after the repository and disappears
when Settings is opened outside a project.

`SettingsMachinesNav.tsx` derives the machine pages from the shared project
machine snapshot. `SettingsMachineScope` carries either the current-machine
target or an explicit `OpenProjectBinding`; `machineSectionAvailable()` keeps
local-only and bound-runtime sections on the machine they can actually reach.
GitHub and Linear are `routed`: every call they make, including the per-machine
GitHub App account status in `useGithubAppUserAuth`, carries the page's pin, so
each machine's Integrations page shows and changes that machine's own
credentials. Browser steps (the GitHub device code, Linear sign-in) open on
This computer; Linear browser sign-in is not offered for another machine
because its callback cannot reach it, and the API key path is shown instead.
Their `linksToTabMachine` flag keeps a settings link with no `?machine=` (an
integration banner, a PR's GitHub notice) landing on the tab's machine.

Section pages use one-column blocks. Project → Lanes has two views: **Your
lanes** lists active lanes with All, Stale, Has changes and Running count
tiles, and **Rules** holds the new lane base, rebase and lane templates.
Project → Storage & cleanup has three: **Space** shows lane and ADE storage and
the cleanup history, **Archive** manages archived lanes, chats and shells, and
**Rules** holds archiving idle lanes, session lifecycle and project files.
Project → Agents lists agent notes and PR chat transcripts. The hosted web
client shows only the Rules and Archive views. Links and Settings search
switch to the page and view containing the destination; legacy `?tab=storage`,
`?tab=archive`, `?tab=disk` and `?tab=session-lifecycle` open Storage &
cleanup. Bulk archive re-reads git state
before applying the merged-PR exception, then skips dirty, active or unpushed
lanes. A machine change clears the previous machine's lane, storage and health
data before loading the new machine. Disk pressure remains available in
Settings with no project open by reading this computer's ADE storage root.

### Settings with no project

The new-project screen has a **Settings** button. It sets the app-store flag
`standaloneSettingsOpen` and navigates to `/settings`, and `App` renders
`SettingsPage` with `standalone`: a Back button returns to the new-project
screen and the top bar shows a "Settings" tab. Only settings that need no
project are shown. The manifest's standalone resolver hides `account-repo` and
`machine-repo` entries, and a tab whose sections all need a project binding is
left out. A page that mixes this computer's settings with ones saved in a
project (Chat, Notifications) reads `isStandaloneSettings()` and shows one
"Open a project to change these." notice (`ProjectSettingsNotice`) in place of
the project cards (prompt suggestions, Smart decisions, Claude mods, scheduled
work), so no card asks for a project config that is not there. Standalone mode ends on a new tab ("+"), Back, closing the Settings
tab, or opening a project. A project closed while on `/settings` falls back to
the new-project screen.

`DEFAULT_SETTINGS_TAB` names where Settings opens. It used to be `tabs[0]`, so
reordering the sidebar silently moved the landing page.

### Settings holds the project sidebar open

On any Settings page the project sidebar is shown: its toggle is disabled (the
tooltip says why) and Mod+B does nothing. The saved show/hide preference is not
changed, so leaving Settings restores the sidebar the way you had it. While the
sidebar is collapsed, its toggle is drawn in the accent colour with a dot.

A Machines page (General, Appearance, Apple devices, Providers, Lanes,
Integrations, Diagnostics, Archive) describes one computer, so a project never
remembers one as its start page. The project returns to its last page that is
not a Machines page, and a stored Machines page from before this rule restores
to Work. The cog reopens the project's last Account or Project section, or
Settings' default page. `isMachineScopedSettingsRoute` in `settingsManifest.ts`
decides which routes count.

The pages themselves:

| Tab | Section file | What lives here |
|---|---|---|
| General | `ProjectSection.tsx`, `AdeCliSection.tsx`, `AutoUpdatesSection.tsx`, `KeepAwakeSection.tsx`, `DiagnosticsSharingSection.tsx`, `AboutSection.tsx`, `ResetAdeSection.tsx` | The top ADE card shows running/installed/downloaded versions, the runtime service, and update controls; below it are project health, the `ade` command line (`#ade-cli`), **Sleep** (`#keep-awake`, hidden on hosted web — a browser holds no power lock), and **Send a report to ADE** (`#diagnostics-sharing`, hidden on hosted web). There is no analytics or diagnostics consent switch. **Reset ADE** (`#reset-ade`, local machine only) is its own section, last on the page; the old `#about.reset` hash still lands on it. Legacy `?tab=workspace`, `?tab=project`, `?tab=context`, `?tab=onboarding`, `?tab=help`, and `?tab=tours` land here. |
| Appearance (Machines → This computer) | `AppearanceSection.tsx`, `AppearanceTerminal.tsx`, `ThemeGallery.tsx`, `ThemeCustomizer.tsx`, `ThemeImportExport.tsx` | Per computer, never synced. Theme families (dark + light each) with search, the Auto / Light / Dark mode choice, import and export, the interface and code faces, reduce motion, the Focus grid's chats per page, terminal text, and the **Background** (`#background`) scene picker — plain, gradient, one picture, or a shuffled library, with the shuffle cadence and App colours from the picture. It has one page, under This computer: a remote machine has no copy of it to show. Everything chat-shaped is on the Chat page. |
| Apple devices (Machines → This computer) | `AppleDevicesSection.tsx` | This computer's own simulator and preview choices — the 3D device body, recording overlays (tap rings, typed-text badges), the remote streaming bitrate cap, and the recordings storage warning — drawn in the Appearance language. Per computer, because every Mac has its own simulators, and it sits beside Appearance under This computer rather than on the Account group. It still files through the account store so the brain on this computer can read the remote streaming cap and the recording overlays: each computer's copy lives under the account-wide scope with the device in the key (`device.<syncDeviceId>.<key>`, `accountDeviceSettingKey`). |
| Chat | `ChatSection.tsx`, `DictationSection.tsx`, `LaunchPromptSection.tsx` (renders `ChatAppearancePreview`), `SmartDecisionsSection.tsx` | Chat typography and density, chat surface (tint, corners), chat details (copy-button position, message minimap, drafts button, launch-prompt clipboard, live preview), and voice input — which is chat dictation, so it lives here. Smart decisions (OpenCode Jev) and the composer's model hint sit beside Next prompt: they act on chats and the composer, and save to the project's `.ade/local.yaml` like it. With no OpenCode Zen sign-in the Smart decisions row offers **Sign in to OpenCode** instead of its switch. The label maps stay exported from `AppearanceSection.tsx` and are imported, not copied, so the two pages cannot drift on what "Comfortable" means. |
| Providers | `ProvidersSection.tsx`, `OAuthConnectModal.tsx` | Provider connections, model routing, spend cap, and voice input — merged because provider auth and per-task model routing are one mental model. **Coding Agents** cards (Claude Code, Codex CLI, Muse Code, Cursor, Droid, Pi — Pi's card also carries in-app provider sign-in) and **OpenCode — Universal Model Access**. Background helpers on this tab are scheduled-work pause/recovery only; naming uses the session's ADE provider. Legacy `?tab=ai`, `?tab=providers`, `?tab=background-jobs`, and `?tab=automations` land here. On the hosted web client every provider page is hidden (sign-in, keys and permissions run on the machine), so the tab instead renders the web-only **AI accounts** card (`agents.accounts`, `#ai-accounts`) with the connected machine's Claude and Codex `ProviderAccountsPanel`s. |
| Lanes | `LaneBehaviorSection.tsx`, `LaneTemplatesSection.tsx` | How lanes start (`new lane base`), stay current (`auto-rebase`), and tell you they fell behind (`rebase suggestions` off/badge/banner + min-behind threshold), plus lane init recipes. Legacy `?tab=lane-templates` lands here. |
| Agents (Project) | `AgentNotesSection.tsx`, `PrChatTranscriptsSection.tsx` | What agents keep about the project: the read-only list of project notes (`ade notes`) and PR transcript gists. Legacy `?tab=agent-notes` and `?tab=notes` land here; the PR transcripts entry keeps its `lanes-git.pr-chat-transcripts` id. |
| Integrations | `GitHubIntegrationSection.tsx`, `LinearIntegrationSection.tsx` | GitHub and Linear — reinstated as its own tab. Legacy `?tab=integrations`, `?tab=github`, and `?tab=linear` land here; `?integration=github|linear` too, while `?integration=cli` follows the `ade-cli` anchor to General. |
| Notifications | `NotificationsSection.tsx`, `AgentCompletionSoundSection.tsx`, `ActivitySettingsControls.tsx`, `AiFeaturesSection.tsx` | Everything ADE tells you about running work. Delivery for `AttentionPreferences`: per-event policy (off / ambient / notify) for agent and PR events, quiet hours, focus suppression, phone delivery and escalation, and the agent completion sound — the per-event matrix and quiet hours were fully modelled with balanced defaults but had **no UI at all** before this page. Then the surfaces Activity paints: the ADE notch (enabled, reveal mode — `always` or `hover`, which render the identical strip and differ only in whether it is there before you point at it — expanded panel), celebrations, Activity sounds, hide-previews, and the per-machine notification mute. The retired `activity.notch-auto-reveal` and `activity.notch-ticker` entries are gone rather than hidden: the notch always flashes for work that needs you, and the strip is state-group counts with no ticker to cycle. All of it reads and writes through one `useActivitySettings()` model, so a change on one control can no longer be overwritten by a save from another copy; `ActivitySettingsControls` is mounted here **and** by the gear inside the Activity popover and pane, so the entry points cannot drift. Legacy `?tab=attention`, `?tab=activity`, and the `#attention-notch`, `#celebrations`, `#attention-sounds`, and `#hide-previews` hashes land here. |
| Secrets | `SecretsSection.tsx` | Encrypted key/value pairs for agents, desktop, and the CLI, with `.env` import. Legacy `?tab=secret` lands here. |
| Storage & cleanup (Project) | `lanes/LanesSettingsPage.tsx` (`StorageSettingsPage`), `health/*`, `storage/*`, `ArchiveSection.tsx`, `SessionLifecycleSection.tsx`, `ProjectSection.tsx` | Disk-usage and lane-storage dashboard, cleanup history, the archive, rules for archiving idle lanes, session lifecycle, and project files. Rule fields show the value actually in force with an explicit "Inherited" marker. Legacy `?tab=storage`, `?tab=disk`, `?tab=space`, `?tab=archive` and `?tab=session-lifecycle` land here; `?tab=diagnostics` opens Computer → ADE service. See [Storage and recovery](../storage-and-recovery/README.md). |
| Usage | `AdeUsageSection.tsx`, `BudgetCapEditor.tsx` (the spend cap lives where spend lives), `UsageDailyChart.tsx`, `UsageLimitGauges.tsx`, `UsageSparks.tsx`, `UsageWeekCompare.tsx`, `UsagePooledLimits.tsx`, `UsageCostSplit.tsx`, `UsageLimitsBand.tsx`, `UsageAccountRow.tsx`, `usageLimitModel.ts`, `UsagePaceBar.tsx`, `UsageSegmented.tsx`, `ActivityModule.tsx`, `usageDesign.ts`, `usageProviderNames.ts`, `usageWindowFormat.ts`, `providerColors.ts` | One scrolling page: headline totals with trends, this machine's Rate limits as radial gauges, the layered daily chart, Week over week, per-provider split, breakdown, Activity, contributing machines, and (account scope) pooled Live limits. Scope is a three-way `account` / `machine` / `project` control. Legacy `?tab=usage` and `?tab=ade-usage` land here. |

> Live provider quota windows render in two shapes: the top-bar Usage popup (`HeaderUsageControl.tsx` → `UsageLimitsBand.tsx` → `UsageAccountRow.tsx`, which also hosts the collapsible `BudgetCapEditor` for automation guardrails) keeps one meter row per account, while Settings > Usage's This machine / This project scope draws the same snapshot as radial `UsageLimitGauges`. The rest of that page is the retrospective cross-client dashboard.


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
surfaces *Auto-rebase child lanes — Lanes* and lands on that card.

### Keeping the machine awake

**Keep this Mac awake while agents work** (Settings → Behaviour, anchor
`keep-awake`) is one radiogroup with three levels. The selected machine's brain
stores the preference in `<ADE_HOME>/keep-awake.json`, so the rule remains in
effect after the desktop quits and the brain serves a phone. On first use, the
desktop migrates `keepAwakePreferences` from `GlobalState` and removes the old
value only after the brain confirms the migration:

| Level | What it does | Where it works |
|---|---|---|
| `never` (default) | ADE holds nothing. Turns pause when the machine sleeps, and the chat says so. | everywhere |
| `while-away` | The brain holds one OS wake lock **only while work is running**. macOS runs `caffeinate -i -w <brain pid>`; Windows runs a helper using `SetThreadExecutionState` that exits with the brain. Stops idle sleep. Not the lid. | macOS, Windows |
| `lid-closed` | `pmset -a disablesleep 1` through the system authorization dialog. Machine-wide, and it outlives ADE. | macOS only |

The distinction between the middle and top levels is the whole point of the
setting, and it was measured rather than assumed: **a wake lock stops idle sleep
only.** An `IOPMAssertion` held continuously for 35 days sat through two
clamshell sleeps. Nothing in this feature's code or copy may imply otherwise.
Only `pmset -a disablesleep` survives a closed lid, and it is root-only and
machine-wide — which is why the top level asks for a password and warns that it
stays on after you quit. The password prompt runs in the selected Mac's desktop;
for a remote Mac, open Settings on that Mac to authorize the change. Windows has
no equivalent, so the third level is **absent** on Windows rather than disabled.
The selected brain reports its platform, so the settings pane describes the
machine it is showing.

Two behaviors follow from the level being an arming switch, not a pin:

- The lock follows the **work**, not the setting. A 5-second brain poll counts
  active agent turns plus tracked agent CLI sessions whose PTY state is
  `running`; idle shells and merely-open sessions do not count. One helper runs
  for the full active period, and a failed activity read releases the lock.
  `never` releases synchronously. macOS's `-w` and the Windows process-handle
  wait also release the lock when the brain exits.
- The snapshot reports what the **machine** says, not what the stored level
  says. A `lid-closed` level whose assertion was released behind ADE's back
  renders a "This Mac can still sleep." alert with a **Turn on again** action,
  rather than silently claiming a lock it does not hold. `pmset -a disablesleep`
  is deliberately left engaged at quit — reverting would either prompt for a
  password on the way out or re-prompt on every launch to put it back.

Separately, the section reads the OS's own idle-sleep timer (`pmset -g custom`
on macOS, `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` on Windows,
nothing on Linux) and, when a non-zero timer would stop agents anyway, offers a
one-click fix. The macOS fix writes system power settings and is labelled
**Fix — needs your password**; the Windows fix edits the signed-in user's active
scheme and needs no elevation.

Reads and writes go to the selected machine: a pinned machine through the
remote-capable `keep_awake` runtime action, this computer through the brain's
machine method `keepAwake.call` (no project needed, cto role only). A brain
that does not manage keep-awake answers `action_not_callable`; a brain from
before the machine method is reached through any project it has. The local desktop handles the macOS admin prompt because
the brain has no GUI. Fixing the local Mac's system sleep timer still uses that
prompt; a remote Mac is directed to its own Settings, while Windows uses the
selected brain action. The desktop starts its old in-process blocker only when
the connected local brain reports that it lacks the new action; successful
brain reads stop that fallback before it can duplicate the brain's lock. Hosted
web and the browser mock report the frozen inert snapshot and direct the user
to change power settings on the computer.

For what happens when the machine sleeps anyway, see
[chat → When the host machine sleeps](../chat/README.md#when-the-host-machine-sleeps)
and [machine power and sleep in the account directory](../sync-and-multi-device/README.md#account-directory-and-connection-leases).

### Capturing a window with a key gesture

**Settings → Behaviour → "Capture with a key gesture"**
(anchor `capture-gesture`, `CaptureGestureSection.tsx`) arms the global
screenshot chord — both ⌘ on macOS, both Ctrl on Windows — described in
[Capture gesture](../capture-gesture/README.md).

The switch is `scope: "machine"`, `showScopeChip: true`, `web: "hidden"`,
and it is stored in this renderer's `localStorage` under
`ade:capture-gesture:enabled` (defaulting **on**) rather than in synced
settings, because what a native
helper does on *this* computer is not a preference that should travel to
another machine through the account. A second Mac has its own Screen
Recording grant and its own opinion about whether a global key gesture is
welcome. `GlobalCaptureGestureHost` pushes the stored value down through
`captureGesture.updateSettings` on mount, because the setting lives in the
renderer and the main process cannot know whether to run the helper until
a window tells it.

The card shows helper **health**, not just a toggle, because the
interesting failures are all things only the user can fix: macOS has not
been told ADE may record the screen (`permission_denied`, recovery
`grant_permission`), macOS 27 has not been told ADE may watch the keyboard
(`permission_denied` with an Input Monitoring message, recovery `retry`,
because the helper installs its tap again in place), the key monitor could
not start (`monitor_unavailable`, recovery `retry`), or the helper is
missing from the install (`missing`, recovery `reinstall_or_update`). A
bare switch that is on while the gesture does nothing is the exact state
this card exists to prevent. On Linux the card renders `CAPTURE_GESTURE_UNSUPPORTED_BLOCKER`
rather than a toggle, and `captureGestureBridgeAvailable()` is an `in`
probe rather than a property read — the hosted web adapter's fallback
proxy fabricates callable namespaces for missing properties, so
`window.ade.captureGesture` is truthy there even with no helper behind it.

### Where durable data lives

| What | Location | Notes |
|---|---|---|
| Project config (local) | `.ade/local.yaml` | gitignored |
| Onboarding status | `AdeDb` via `STATUS_KEY = "onboarding:status"` | `completedAt`, `dismissedAt`, `freshProject` |
| Context doc prefs | `AdeDb` via `context:docs:preferences.v1` | provider, model, reasoning effort, event triggers |
| Terminal preferences | `localStorage` under `ade.terminalPreferences.v1` | font size, line height, scrollback, font family |
| Work view state | `localStorage` under `ade.workViewState.v1` | per-project and per-lane-project slices |
| Keep-awake level | `<ADE_HOME>/keep-awake.json` | brain-owned and machine-scoped; old `GlobalState.keepAwakePreferences` migrates once; unreadable state fails toward `never` |
| GitHub credentials | Keychain via `safeStorage` | tokens encrypted; a store ADE cannot decrypt reports `credentialStoreUnreadable` rather than "not connected" |
| Account settings cache | `~/.ade/account-settings.json` | Plaintext, owner-tagged cache; settings survive sign-out and stamps are namespaced by account |
| Account vault cache | `~/.ade/account-vault.json.enc` | Encrypted with the machine credential-store key, written atomically with `0600`; legacy plaintext is removed after a successful encrypted write |
| AI provider API keys | Machine credential store plus account vault | Every local value records device/account provenance; account-hydrated keys are purged on sign-out or account switch, while device-origin keys remain |
| Linear credentials | Encrypted machine credential store or active project's `.ade/secrets`, plus account vault | The OAuth refresh token is the `linear_refresh_token` account item, stamped with a `refreshOwner` device id. Only that owner hydrates or refreshes the grant; provenance purges account-origin values on sign-out or account switch, while device-origin API keys and custom OAuth-client settings remain local |
| Repository account secrets | Encrypted project-secret store plus account vault | Repository-scoped `project_secret` values follow the account and are keyed by normalized Git origin; device-only secrets remain local |
| Capture-gesture switch | `localStorage` under `ade:capture-gesture:enabled` | machine-local, defaults on; pushed to the main process by `GlobalCaptureGestureHost` on mount |

## AI mode and provider behavior

`effective.ai.mode` is the source of truth for guest vs subscription
behavior. Current behavior:

- **guest mode** — deterministic features remain usable; AI-backed
  features degrade cleanly (no narrative generation, no summaries).
- **subscription mode** — unlocks chat, narratives, and summaries.

Legacy `providers.mode` migration ran during earlier releases and is
no longer part of the contract; `projectConfigService` still contains
the migration path but it is idempotent for current configs.

## Provider accounts

A machine can hold several Claude logins and several Codex logins. Each one is a
provider config directory plus a label, selected at launch by a single
environment variable — `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. Only those two
providers participate; the rest have no config-home override or no local account
file, so they have exactly one identity per machine.

- **The registry is a brain-owned JSON file**, `provider-instances.json`, in the
  machine ADE home beside `projects.json`. It is deliberately not a SQLite
  table: every table with a primary key in this repo auto-becomes a cr-sqlite
  CRR and replicates to every paired device, and a list of directory paths on
  this laptop is meaningless on the phone. Accounts created through ADE get a
  config home at `<adeHome>/provider-homes/<provider>/<instanceId>/`, created
  `0700` because the provider CLI writes its own credentials there. ADE never
  reads, copies, or revokes those credentials.
- **The default account is synthesized on read.** The login the machine already
  had is the default account: its id IS the provider slug (`claude`, `codex`)
  and its config home is whatever `providerConfigHomes.ts` resolves right now,
  recomputed every read rather than frozen. There is no migration step and no
  first-boot write — a machine that has never used this feature and one that has
  both describe the same state, and deleting the registry file is a complete
  reset. The default account's identity is also read WITHOUT a scoped home,
  because the Claude CLI records `oauthAccount` in `~/.claude.json`, beside the
  config directory rather than inside it.
- **Exactly one account per provider is the default**, stored as a pointer. A
  pointer at an account that no longer exists resolves to the base identity
  rather than erroring — the same silent fallback a chat takes.
- **Removing an account deletes nothing on disk.** It is forgotten from the
  registry and the config home is returned so the user can be told what is still
  there. The machine's own login and the current default both refuse removal.
- **Accounts have no names.** Every surface shows an account as its signed-in
  email, else its id (`ProviderInstance.label` is that value, set by the host:
  `providerInstanceDisplayLabel`). The id is what `--instance` takes and never
  changes; a new account gets the next free `<provider>-<n>`. `create` takes no
  label (an optional one from an older phone or script only shapes the id), and
  desktop, web, iOS and the CLI no longer offer Rename. The `rename` action stays
  for older phones; what it stores is not shown.
- **Action domain `provider_instances`** carries `list`, `create`, `remove`,
  `rename` (older phones only), `setDefault`, `setAccent`, `getSettings`,
  `setSettings`, `loginCommand`, and `refresh` — on the agent tier for reads
  *and* mutations, with no CTO gate, because an account is a directory path,
  never a token. Reachable from the desktop IPC surface, the preload three-way
  route (pinned runtime → project runtime → local IPC), the daemon action bus,
  and `ade providers accounts list|add|remove|default`. `setAccent` and the
  stored `accentColor` field are retained for compatibility only: no desktop,
  web, or iOS surface offers or shows a per-account colour any more.
- **Per-provider settings** (`smartBalance`, `autoStartWindows`) live in the
  same file under `settings.<provider>` and default to off.
- **Compaction.** Each provider page shows the compaction settings ADE can
  apply for that harness (`CompactionSettings.tsx`): **Compact at** (Auto by
  default) and, for Claude, **Subagents compact at** and **After the cache
  expires**. There is no on/off switch: every chat compacts when it fills; the provider-level values
  live in project config `ai.compaction.<provider>` in `.ade/local.yaml`. With
  more than one account, the actions menu of each account card has an
  **Auto-compact** page ("Same as provider default" or Custom), stored as
  `compaction` on that account
  record; it overrides the provider value field by field. See
  [Compaction per provider](../chat/agent-routing.md#compaction-per-provider).
- **Subagent prompt cache (Claude).** The actions menu of each Claude account
  card has a **Subagent cache** page (`AccountCard.tsx`) that explains the two
  choices: 5 minutes, the Claude Code default, or 1 hour. With 1 hour, the card
  header shows a **1h cache** tag. Account settings live in the menu, never in
  the card body, so the cards stay a quick view. ADE has no
  default of its own here: 1-hour
  cache writes cost more, and they pay off only when subagents often wait more
  than 5 minutes between requests. "1 hour" is stored as
  `subagentPromptCacheTtl` on the account record; the default stores nothing.
  `claudeAccountPromptCacheEnv` (`providerInstanceStore.ts`) turns the choice
  into `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` for SDK chats and terminal
  `claude` sessions on that account. It adds nothing when the environment
  already states a TTL, and a launch on a preset or a stored credential never
  gets it, because that endpoint bills separately.
- **Main chat prompt cache (Claude).** The same menu has a **Main chat cache**
  page: Automatic (the default, Claude Code decides: 1 hour on a subscription
  within its limits, 5 minutes otherwise), 5 minutes, or 1 hour. A choice is
  stored as `mainPromptCacheTtl` on the account record and travels the same
  path as `CLAUDE_CODE_PROMPT_CACHE_TTL`; Automatic stores nothing. The chat's
  cache countdown and the Compact first offer do not read this setting. They
  read the lifetime Claude really wrote
  ([composer and UI](../chat/composer-and-ui.md)), so they follow it on the next
  turn.
- **Extra usage (Claude).** The same menu has an **Extra usage** page with two
  choices: **Continue**, which is what Claude Code does by itself, or **Stop
  the turn**. Extra usage is usage that Claude bills after the plan limit, on
  an account that allows it. "Stop the turn" is stored as `onExtraUsage: "stop"`
  on the account record; the default stores nothing. When a `rate_limit_event`
  says the request drew on extra usage (`isUsingOverage` or `overageInUse`),
  the Claude chat runtime interrupts the turn, cancels its queued messages,
  and ends it as a usage limit: the quota card shows, and the chat then does
  what it does at a plan limit (it resumes at the reset when Claude sends a
  reset time and the chat continues at limits, or it moves to another account
  under Smart balance). Claude reports extra usage after the response, so one
  request is billed before the stop. The setting lives in this machine's
  account registry, so another machine with the same account does not apply
  it, and iOS and the hosted web client show no control for it. It covers ADE
  chats that run on the account's own login: a chat that runs on a preset or a
  stored credential, and a terminal `claude` session, are not stopped. A chat
  whose preset cannot be resolved runs on the account's own login, so the
  setting applies to it.
- **AI settings save to `.ade/local.yaml`.** `ai.updateConfig` (IPC, the `ai`
  action domain, and the brain's remote command) merges its partial config into
  the local layer through `projectConfigService.updateAiConfig`. The shared
  `.ade/ade.yaml` layer is never written.
- **Signing in is a command ADE returns, not a flow it drives.**
  `loginCommand` gives back the resolved provider binary, its argv, and the one
  env var pointing at that account's config home. `ade providers accounts add`
  prints it so a shell user can run it directly.

### Accounts panel

Settings → Agents & Models → Claude Code (or Codex CLI) opens the provider page,
and **Accounts** sits directly under the banner, across the full width, so the
account cards stand side by side. It is the only surface that shows the whole
set of local logins for that provider. No
other provider page has the panel, because no other provider can hold more than
one identity per machine. Sign-in for Claude and Codex lives on each account
row and on **Add account**. The left column does not repeat a Sign in section.
A copy that is not downloaded yet shows the pinned-copy row (Download/Retry)
under the status chip instead.

- **Routing strip** above the cards, shown only when it has a switch: *Smart
  balance* (two or more accounts) and *Auto-start 5-hour windows* (while the
  provider reports a five-hour window), each a `SettingsToggle` with a (?) hint,
  and one line saying where new chats go. Smart balance sends new chats to the
  account that needs the most weekly room spent before its reset, after
  subtracting the burn already committed there: measured quota movement,
  chats just placed, and reservations for open-but-idle chats. The five-hour
  window is a gate, not a ranking; a chat is never refused when every account
  is blocked. **Next chat** previews that pick. A
  running chat stays on its account; one that hits a usage limit moves to
  another account with room (with the switch off, the limit offers that move
  instead). Auto-start sends one tiny request on the cheapest model when a
  window ends, each logged with its cost. Both read and write
  `provider_instances` `getSettings`/`setSettings`.
- **One card per account**, in a grid that fits as many 290px columns as the
  width allows, then evens them out over the rows (`balancedColumns`): two cards
  never leave an empty column, and four go two by two, not three and one. Cards
  in a row share a height.
  A card has the account's name, one status
  badge and the ⋯ menu; under it, the top-bar usage popover's own
  `UsageAccountRow` (email, pace pill, Use reset, one meter per window), built by
  `accountLimitRow` with `buildAccountRows` and matched by
  `UsageAccountRow.instanceId`, never by email — so Settings and the popover draw
  one account the same way. There is no cap on accounts.
- **Badges say where new chats go.** With smart balance off the default carries
  `New chats` and an accent border; another card shows **Use** while pointed at
  or focused, and clicking a card does the same. With smart balance on,
  `Next chat` marks the account the host would pick now, from
  `UsageSnapshot.balanceNext` (the same pure `pickInstanceForNewChat` chat
  creation runs); clicking a card turns balance off and selects it.
- **Signed out**: a `Signed out` pill (the usage row's own when the poller saw
  it, else a header badge), dimmed meters, and **Sign in**.
- **Same login twice**: when two config homes hold one email, one card owns it
  (`sameLoginOwner`): the default account when it holds that email and its
  login works, else the first working login in list order. Every other card
  (`ProviderInstance.sameLoginAs`, computed by the store) is badged `Copy` and
  says which account it copies, with **Sign in to another account**; it adds no
  quota and smart balance skips it. The usage snapshot keeps only the owner's
  reading by the same rule, so the account that balance counts is the one
  with numbers.
- **Machine scope**: the panel reads accounts and usage from the machine the
  Settings page names (`useUsageSnapshot({ pin })`), never usage from the tab's
  own machine under another machine's accounts.
- **Replaced login**: when a config home's email changes to another email — a
  `claude /login` in a shell for the default account — the store records the old
  one as `replacedAccount`. The card says it was replaced outside ADE, with
  **Sign it back in** (into a `Copy` slot when there is one, so the accounts
  shift instead of doubling; otherwise, or when the only copy is the machine's
  own login, a new account named after the email) and
  **Dismiss** (`provider_instances.dismissReplaced`). It disappears on its own
  once any account holds that email again.
- **The card menu (⋯)** carries Rename, Sign in / Sign in again, Sign out, and
  Remove. Every card but the default offers **Sign out**
  (`provider_instances.signOut` → `signOutProviderAccount`), which runs the
  provider CLI's own `claude auth logout` / `codex logout` in that account's
  config home and keeps the card; on the machine's own login the confirm says
  the terminal's CLI is signed out too. **Remove** is not offered on the default
  or the machine's own login, which the store refuses; it signs a signed-in
  account out first (`removeProviderAccount`, shared by every surface), so
  adding it again starts from a fresh sign-in. A sign-out that fails does not
  block the removal; the card's error says the login was left in place. Both
  ask for confirmation in Settings, and any refusal shows the store's own
  sentence. Agents may call both too (account management is theirs by design);
  the default account is refused either way.
- **Panels fold.** `ProviderPanel` takes `autoCollapsed` and `summary`: a panel
  with nothing to show folds to its header (API keys with none saved reads
  `API keys · 0 None saved`), and a click on the title flips any panel. Sheets
  render outside the panel body, so a folded panel still opens its Add sheet.
- **Add account** opens a three-step sheet (Name it → Sign in → Done): a name
  and a note that the provider opens its sign-in page and the login
  is saved for this account only. **Continue to sign-in** creates the account
  and calls `provider_instances.loginStart`. There is no terminal: the host's
  login runner (`main/services/providerAccounts/providerLoginRunner.ts`, one per
  machine) runs the provider's own login command for that account's config home
  in a private node-pty, reads its output for the sign-in link and a code
  prompt, and verifies the saved login when the CLI exits (re-reading a stale
  signed-out mark and the config home's identity). The sheet polls
  `loginStatus` every second — the subscription proxy's sign-in shape, so it
  works the same for a Settings page pinned to another machine — and shows a
  "finish with your browser" card with **Open sign-in page** / **Copy link**, a
  code field when the CLI asks for one (`loginSubmitCode`), and the CLI's output
  behind a closed **Sign-in output** disclosure. For a machine other than the
  one holding the browser, and for the hosted web client, a Codex sign-in passes
  `deviceAuth`, which appends
  `--device-auth` so the CLI prints a one-time code instead of returning to a
  localhost port the other computer (or a browser) cannot reach; the sheet shows that code to
  type into the sign-in page. It ends on a Done state with the
  email, or "Sign-in did not complete." with the runner's reason, **Try again**
  and **Close**. Closing a running sign-in cancels it (`loginCancel`); a sign-in
  times out after ten minutes. No terminal session or Work row is created.
  The embedded terminal it replaces drew nothing once the CLI exited (an
  untracked shell has no transcript) and left an Ended row per attempt.
  The left card's **Sign in to Claude Code** / **Sign in to Codex** opens the
  same sheet for the default account. `providers accounts refresh` (and the IPC
  refresh) also re-reads the saved login of every account marked signed out.
- **The provider list row** shows `N accounts` in its Details column once a
  provider has more than one.
- **The model picker** adds one muted line under the provider header —
  "Smart balance is on for Claude Code" — while that provider is balancing.
  Nothing else about the picker changes: every model is still listed and an
  explicit pick is still honoured.

The hosted web client hides every provider page (sign-in, keys, and permissions
run on the machine itself), but the machine's Claude and Codex logins are
managed over sync, so it gets them as one web-only **AI accounts** card
(`agents.accounts`, `webOnly: true`, anchor `#ai-accounts`) on the Agents tab,
showing the same `ProviderAccountsPanel` for Claude and Codex. The manifest's
`webOnly` flag keeps the anchor out of the desktop nav, search, and command
palette, which never draw it.

### API credentials

Provider API credentials support multiple non-secret entries per provider. The
default entry keeps the legacy provider slot; additional entries use a
provider-and-credential id, while `ai.api_credentials.index.v1` stores labels,
endpoints, protocols, models, timestamps, and masked tails without storing
secrets. Environment variables appear only as the provider's default,
read-only credential. Account-vault mirrors use the provider name for the
default and `provider#credentialId` for additional entries, so legacy callers
continue to read only default credentials.

### Initial context window

Every provider page has an **Initial context window** card: what a new chat on
that provider receives before the user's first message, on the page's machine.
It is read-only. ADE lists the items so a person can see them and change their
own setup; it does not switch them off.

- **Four parts**, one color each: the provider itself (its own prompt and
  tools, in the provider's color), ADE (teal), the user's setup (pink) and this
  project (amber). A bar shows each part's share, and each part lists its items
  with a size, the file they come from, and, for config entries, where they are
  set (`Set in ~/.codex/config.toml`).
- **Sizes.** ADE's items are counted from the exact text a real launch builds
  (the same builders, dry-run). The user's and the project's items are counted
  from their files, by the provider's documented discovery rules. Both are
  token estimates (about 4 characters each) and show `≈`. The total is the
  median first request of real chats that made one request (the turn ledger),
  from at least 3 chats, this project's when it has enough, else the machine's;
  with fewer chats the card shows the listed sum instead. The provider's own
  part is that median minus the listed items.
- **Row buttons.** A gear opens the ADE settings page that manages the item
  (MCP servers, Agent notes). A folder button shows the file in Finder (Explorer
  on Windows). It appears only when the page shows This computer and not in the
  hosted web client, and it goes through its own IPC channel
  (`ai.revealProviderContextPath`), whose allowlist holds the providers' config
  homes, the project, the instruction files in the folders above it, and ADE's
  own folders. A symlinked skill whose target is outside those is shown as the
  link.
- **Machines.** The list is built on the machine the Settings page shows; both
  renderer calls take that machine's pin. A failed read shows an error with
  **Try again**; a failed **Check again** keeps the last list and says so. An
  older ADE without the action hides the card.

### API keys panel

Every provider page carries an **API keys** panel, last in the right column.
It lists one row per key ADE can see for that provider: the label, the variable
the key is exported as, the masked tail, a source badge (Local store,
Environment, Project config), the endpoint host when one is set, and how many
models the key declares.

- **Local store** rows offer **Replace** and **Delete**. Delete confirms first.
- **Environment** and **Project config** rows are read-only and say
  "Managed outside ADE — clear the env/config value to remove." ADE did not
  write them, so it does not offer to delete them.
- **Verify** appears only on the default key of a provider that has a live
  probe — Claude Code, Codex, Cursor, Grok and Kimi. The verification path reads
  one key per provider, so a second key gets no button rather than a button that
  would verify a different key than the row it sits on.

**+ Add** opens a sheet that asks only what that provider's harness reads. Every
field carries a one-line description, there is one Save, and no field is shown
that would do nothing:

| Provider | Stored under | Key variable | Endpoint | Protocol | Models | Provider id |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `anthropic` | `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` when an endpoint is set | `ANTHROPIC_BASE_URL` | — | yes | — |
| Codex | `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | — | yes | — |
| Cursor | `cursor` | `CURSOR_API_KEY` | — | — | — | — |
| Droid | `droid` | `FACTORY_API_KEY` | base URL | yes | yes | — |
| Pi | `pi` | — | — | — | — | — |
| OpenCode | per custom provider id | — | base URL | yes | yes | yes |
| Qwen Code | `qwen` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | — | — | — |
| Kimi | `moonshotai` | `MOONSHOT_API_KEY` | — | — | — | — |
| Grok | `xai` | `XAI_API_KEY` | — | — | — | — |
| GitHub Copilot | `copilot` | `GITHUB_TOKEN` | — | — | — | — |

A key is filed under the vendor's id rather than the page's id where the two
differ, which is what makes an `ANTHROPIC_API_KEY` that is already set show up
as an Environment row on the Claude page, and what lets Verify reach a probe
that exists. The first key a provider holds takes the default slot, so every
single-key reader in the app finds it. Cursor writes through the legacy single
slot, because that is the slot its SDK signs in from.

Pi is the one provider with no endpoint field: it reads its own `models.json`
for endpoints and model ids, and the sheet says so.

### OpenCode custom providers

The OpenCode page's **Advanced** section lists the custom providers OpenCode is
configured with — name, id, base URL, model count — with **Edit** and **Delete**
on each. Add and Edit open the same key sheet, with a **Provider id** field and
a **Protocol** select in place of the npm package name (each package is one wire
protocol). An edit may leave the key empty to keep the saved one.

Every write sends the whole provider list: `ai.updateConfig` merges arrays with
replace semantics, so a write that carried only the entry being changed would
drop every other custom provider. **Custom model slugs** stays a separate field
with its own Save.

## UX contract

Onboarding and settings follow a simple rule:

- require account sign-in for a fresh launch, while preserving explicit
  recovery for an existing paired/local session
- do not block on optional integrations
- keep setup responsive
- show the fastest path first
- defer advanced or heavy configuration to the feature surface that
  owns it

## Account session state is a four-state, not a boolean

"Not signed in" was one word for three different situations, and treating them
alike is how a perfectly good session gets destroyed. `AccountAuthStatus`
therefore carries `sessionState`, mirrored onto the desktop as
`AdeAccountStatus.sessionState`:

| State | What actually happened | What the surface must say |
| --- | --- | --- |
| `active` | Signed in. | — |
| `signed_out` | No session on this machine. | Offer sign-in. |
| `expired` | A session exists and the issuer definitively rejected its grant. | Say the sign-in expired, and offer sign-in. |
| `unreadable` | The credential store could not be read on this attempt. | Say nothing changed and offer **repair/retry**. Sign-in must be demoted. |

The `unreadable` row is the whole point. A new sign-in **overwrites** the stored
session, so inviting one over a session that is merely unreadable is how the
user destroys something valid. The desktop's `SignInCard`, the Connections
account header, and the sidebar avatar label each render the three
not-signed-in states distinctly; the branch logic lives once in
`accountSessionState` / `accountSessionNotice`
(`apps/desktop/src/renderer/lib/account.ts`), and the `unreadable` copy leads
with the shared `BrainRepairButton` (or a plain retry where there is no brain to
restart) with sign-in demoted to "Sign in anyway".

Repair has to actually repair. Restarting the background service — all this
control used to do — cannot fix any credential-store condition, which is the
only condition this surface appears for: the replacement process reads the same
unreadable file. `account.repairSession` therefore repairs the shared credential
store first (converge its key binding, merge back anything a peer process had to
set aside) and restarts the brain after, then reports which of three things
happened: the store is readable again, the store is readable but nothing on this
computer can open what was set aside so a fresh sign-in is required, or the
repair itself failed. The store mechanics are in
[ARCHITECTURE](../../ARCHITECTURE.md) under the machine credential stores. The CLI's `account-auth` text
formatter makes the same three distinctions rather than printing one
"Not signed in — run `ade login`." for all of them.

Older runtimes that predate `sessionState` are derived from the existing
`sessionReadState`, so a mixed-version pair degrades to the old behaviour
instead of mis-labelling.

**A rejected grant is marked dead, not deleted.** The stored record keeps
`rejectedAt` / `needsReauth` / `rejectedReason` in place. Deleting it makes
every process on the machine silently forget an account the user never signed
out of — and takes the host's relay tunnel and its account-directory row down
with it, which is what removed every remote route to a still-owned machine.
`needsReauth` alone condemns a record, so a marker written by an older or newer
peer without a parsable timestamp is still honoured; the next successful sign-in
overwrites it.

**Ownership and usability are different questions.**
`accountSessionRetainsMachineOwnership(status)` answers "is this still their
machine" — true for `active`, `expired`, and `unreadable`; false only for a
deliberate `signed_out`. Reachability a paired device already has must survive a
token accident; anything that needs a live token still gates on `signedIn`. See
[remote runtime → Account state and reachability](../remote-runtime/README.md#account-state-and-reachability).

**Every mutation is logged.** The incident this came from had an empty
`account.*` log: the deletion that erased the session for every process on the
machine left no trace. Each write, rotation, rejection, and sign-out now emits
one attributed `account.session_mutation` line naming its `action`
(`persist`, `rotate`, `delete`, `mark_dead`, `sign_out`, and the three
`rotation_journal_*` actions), `reason`, `pid`, `source`
(`brain` | `cli` | `desktop`, derived by `deriveAccountSessionMutationSource`
and overridable with `ADE_ACCOUNT_SESSION_SOURCE`), and the
`tokenGeneration` it acted on — a truncated SHA-256 of the refresh token, so a
grant can be followed across processes with no token material in any log file
or journal entry.

**Only the brain exchanges the refresh credential.** The journal below made
rotation crash-safe and made a live peer a mutex, but it could not remove the
race, because two processes were still both entitled to exchange a single-use
token. `accountAuthService` therefore takes a `getRefreshBroker`, and every
process that is not the brain installs one through
`setSharedAccountRefreshBroker`. A brokered process never POSTs the credential:
it asks the brain for an access token over `account.call` -> `getToken`, and the
desktop's broker is `createBrainRefreshBroker` in `accountBridge.ts`. The
brokered path deliberately does **not** forward `forceRefresh` — a caller able
to force an exchange would be a second refresher wearing a different hat.

The broker is read at call time rather than at construction, because
`getSharedAccountAuthService` caches one service per secrets directory and on
desktop the first caller can run before the runtime pool exists; installing the
broker separately means startup order cannot decide whether a process refreshes
locally.

**The broker probes dynamically.** CLI and TUI install it unconditionally on
their non-brain paths, then probe the brain socket for each refresh. A missing
brain returns null so the service safely uses its local exchange; a brain that
was reachable but fails still raises transient
`AccountRefreshUnavailableError` and leaves the stored record untouched. Only
a definitive `invalid_grant` marks a session dead.

**An unreadable store repairs itself once before the user sees it.**
`accountBridge.status()` runs `repairCredentialStore()` on the first
`unreadable` read in a desktop process, then reports whatever is true
afterwards. The flag is set before the attempt, so a repair that throws cannot
turn every later status read into another attempt at the same broken file. The
brain is not restarted on this path: that half is disruptive, needs the user's
intent, and cannot fix a credential-store condition anyway. The manual
**Repair** control still does both. The motivation is in the numbers — 1,148
`account.session_read_failed` entries in a single day on one machine, every one
`ENOSPC` on `credentials.json.enc.lock` — a condition that resolves itself and
should never have raised a question the user had to answer.

**Rotation is crash-safe, and a live peer's journal is a mutex.**
`accountSessionRotationJournal.ts` records that a refresh exchange *started*
against a specific token generation and clears it once the replacement is
durable. A surviving entry means the stored token may already have been
consumed by a process that died before it could persist the replacement, so
the `invalid_grant` that follows is not definitive. `tryBegin` compare-and-swaps
that same entry: a live peer already exchanging the grant is waited out, not
raced at Clerk — two POSTs against a single-use refresh token is what produced
the daily `invalid_grant` / mark_dead sign-outs. A dead peer's journal is taken
over and treated as interrupted. The waits around this are ordered
deliberately: the peer-rotation wait (`DEFAULT_REFRESH_ROTATION_WAIT_MS`) is
the credential store's own `CREDENTIAL_STORE_LOCK_TIMEOUT_MS` plus a 5 s
margin, because a wait shorter than the lock timeout could expire while the
winning peer is still legitimately queued behind the lock — and the loser
would then declare a live session dead.

## GitHub connection status has the same third state

The account session is not the only thing the credential store can hide.
`github.token.v1` and `github.appUserToken.v1` fail the same way: an
undecryptable store returns an **empty view** rather than an error, so a GitHub
status built from it is indistinguishable from a fresh install. That is the
whole hazard — "not connected" invites a reconnect, and a reconnect overwrites
credentials that were only unreadable, turning a recoverable read failure into
real credential loss.

The two keys do not live in the same file. `github.appUserToken.v1` is
file-backed and shared with the brain and the CLI, while `github.token.v1` stays
in the desktop's Electron-only store, and the routed credential store sends each
read to its own file. So a readability verdict has to belong to the key it was
asked about: the router tracks which store served the most recent read, and
`getWithReadState` answers per call rather than through that shared state.
Answering from the wrong file is how a perfectly readable credential gets
reported as "can't read your sign-in". It also means a locked OS keychain no
longer hides the shared credentials — those need no keychain, so they stay
reachable while only the Electron-only half refuses. See
[ARCHITECTURE §8.1](../../ARCHITECTURE.md#81-electron-safestorage-for-secrets).

`GitHubStatus` therefore separates three answers, not two:

| Answer | What is actually true | What the surface offers |
| --- | --- | --- |
| connected | A credential validated against `GET /user` and, where required, the repo probe. | Nothing; `writeAuthSource` still gates mutations separately. |
| not connected | ADE read the store successfully and there is no usable credential. | `gh auth login` steps, or a PAT field. |
| `credentialStoreUnreadable` | ADE could not open the store on this read. Saved credentials may be entirely intact. | Say so, and offer **repair** — never a reconnect as the primary path. |

Every surface that would otherwise conclude "not connected" resolves the third
state *first*, ahead of `!tokenStored`, because everything downstream of an
unreadable read is a guess:

- **Settings → Integrations → GitHub** (`GitHubSection.tsx`) shows **Can't read
  sign-in** in warning tone with the shared notice and an **Open connections**
  button, and hides the gh-CLI setup steps.
- **The app-shell integration banner** (registered by `IntegrationBanners.tsx`
  and rendered by `AppBannerHost`) points its
  action at the Connections panel rather than the GitHub settings route, since
  no GitHub-side action repairs a store ADE cannot open.
- **The PR tab's empty state** — the message is built in the main process by
  `prService.buildGithubSnapshotAuthError`, which is why the wording is a shared
  constant in `shared/types/git.ts` rather than renderer copy.
- **Publish to GitHub** (`PublishToGitHubDialog.tsx`) reads the flag once when
  the dialog opens and replaces "GitHub is not connected" with the unreadable
  wording. The token field stays, because pasting a token there is a deliberate
  act by a user who already came to connect — the dialog only stops asserting a
  disconnection it cannot actually observe.

The Settings button and the banner action both land on the Connections panel's
**Machines** tab, where the account header already carries the sign-in repair
path — the same
`account.repairSession` the account tri-state uses, which converges the shared
credential store's key binding before restarting the brain. One store, one
repair: a GitHub-specific fix-it control would be a second button for the same
file. Writing a new GitHub token also clears the flag, because a successful
write re-seals the store under a key this process holds.

Because the field is optional, an older remote runtime that omits it degrades to
the previous two-way behaviour instead of reporting a state it cannot compute.

## Gotchas

- **A provider account is a path, not a credential.** The registry stores config
  home paths and labels; the tokens inside those directories belong to the
  provider CLI that wrote them. That is why the registry is plain JSON rather
  than the encrypted credential store, why `remove` deletes nothing, and why the
  action domain is not CTO-gated. Do not add a field to this file that a
  credential would fit in.
- **The default account's config home is resolved, never stored.** Freezing it
  would make ADE read one directory and launch the provider against another the
  moment a user sets `CLAUDE_CONFIG_DIR` in a shell profile. The stored record
  for the base identity carries a label (and a legacy `accentColor` field no
  surface sets or shows); its `configHome` is
  recomputed on every read and any persisted copy is ignored.
- **Scope is two axes, not one.** Who owns a setting — your account or this
  computer — and how much it covers — everything, or one repository. The
  placement rule is mechanical so it can be checked: a value holding a path, a
  port, or a fact about hardware is machine scope, because it means nothing on
  another computer. Everything else is account scope and follows the user.
  `SettingScope` is the four combinations, and the sidebar group IS the scope.
- **No trust gate, and no committed config.** `.ade/ade.yaml` is no longer read
  at all — it is carried over into `local.yaml` once (non-executable keys only)
  and deleted. The gate went with the file it guarded;
  see [configuration-schema.md](./configuration-schema.md#no-trust-gate).
  `getExecutableConfig` is gone too — it had become `getEffective` with an extra
  throw.
- **Phone-sync port 8787.** Bind order always tries 8787 first, even when
  `lastPort` is 8788. A replacement brain that lands on 8788 keeps retrying
  8787 at runtime so phones that saved 8787 reconnect without a restart.
  The "ADE is already running with phone sync" dialog is the cross-channel
  case (ADE vs ADE Beta) and is intentional. Full bind/reap/migrate contract:
  [sync and multi-device](../sync-and-multi-device/README.md).
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
  before flipping to `installing`. Skipping
  that step (e.g. a synchronous quitAndInstall) reintroduces the bug
  where ADE quits to install a stale download while a strictly newer
  build is available. Comparison goes through `compareUpdateVersions`
  — never `===` on the version string — because `v1.2.3` /
  `1.2.3-rc.1` / `1.2.3` all need consistent ordering on both the
  pending-install reconcile path and the supersede check.
- **`installing` is a sticky status; `ready` is not.** While the snapshot is
  `installing` the service ignores `update-not-available`,
  `checking-for-update`, and `error`, because the main process is in
  the middle of quitAndInstall. Checks keep running while status is `ready`
  (same-or-older ignored, strictly newer supersedes, failed check leaves the
  archive). Do not skip a check just because an update is staged. The one
  window that *does* block a check is an already-running `quitAndInstall()`:
  status stays `ready` until the native handoff, and a supersede in that
  window would delete the archive about to be handed to Squirrel or NSIS. See
  [Checking while an update is staged](./desktop-auto-update.md#checking-while-an-update-is-staged).
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

## Archive

Archiving **hides** a lane, chat, or shell; ADE never deletes an archived item
on its own. The one thing ADE deletes by itself is a dead App Control shell
(below), which it removes instead of archiving.
The archive is the one place the three kinds are listed together, so it has a
Project → Storage & cleanup → Archive page, an `ade archive` CLI, an ADE Code
weekly notice, and a weekly desktop banner that all read the same
`archive.list` / `archive.summary` result.

- **Dead App Control shells are deleted.** A shell App Control started
  (`launchedBy: "agent"`) that nobody typed into is deleted, with its
  transcript, once dead: at once when a launch in a new shell replaces it, after
  a 10-minute grace on a clean exit or an ADE stop, and only once its chat
  settles after a crash. A relaunch by the same chat reuses the shell instead.
  Typing into it (`terminal.write { fromUser }` from a user client, or a hand
  resume) makes it the person's, and it is never deleted. See
  [terminals and sessions](../terminals-and-sessions/README.md#dead-agent-shells).
- **Delete is the person's alone.** `archive.delete` is `ADE_ACTION_USER_ONLY`
  and `archive.restore` is `ADE_ACTION_CTO_ONLY`, so an agent or automation can
  read the archive and a CTO can restore, but only a user client may delete. The
  CLI refuses `ade archive delete` and points at Settings. Deleting a lane keeps
  its branch; a dirty worktree is refused unless the person confirms a forced
  delete.
- **The reminder asks, never acts.** The desktop banner and the ADE Code notice
  appear at most once per project per week when something has been archived for
  at least 14 days, and every answer (review, snooze, dismiss) pushes the next
  ask a week out.

iOS reads archived lanes, chats, and shells from the same shared model, but the
iOS archive screen and banner are not built yet; that is a follow-up.

## Cross-links

- Lane templates used during lane creation: Lanes feature
- Terminal preferences applied at runtime:
  [../terminals-and-sessions/ui-surfaces.md](../terminals-and-sessions/ui-surfaces.md)
