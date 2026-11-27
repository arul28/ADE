# Onboarding and Settings

- **Onboarding** is the fastest path to a usable install and project. It
  registers the project with the runtime so every client sees it. Opening or
  creating a project lands on Work; AI runtimes, GitHub and Linear live in
  Settings. No setup dashboard blocks the project.
- **Settings** is long-lived configuration by tab. Project configuration saves
  to `.ade/local.yaml` through `projectConfigService`; machine-level desktop
  preferences (such as automatic update installs) save in the Electron
  user-data `ade-state.json`.

Every client (desktop, CLI, hosted web, iOS) requires an ADE account on a fresh
launch and gates account-backed surfaces on it; a lost or unreadable session is
reported as its real state, never as a guest. Project open runs a cheap first
pass; full lane status and provider modes load after the app is interactive.

## Where state lives

| Scope | Location | Owner | Contents |
|---|---|---|---|
| Machine | `~/.ade/` (`ADE_HOME` overrides; Alpha uses `~/.ade-alpha/`) | ADE runtime (`ade serve`) | Endpoint (`sock/ade.sock`), project registry (`projects.json`), provider-account registry (`provider-instances.json`) and its homes (`provider-homes/<provider>/<id>/`), encrypted credential store (`secrets/`), binary (`bin/ade`), natives (`runtime/<arch>/`), service logs. |
| Desktop installation | `<Electron userData>/ade-state.json` | Desktop main process | Recent projects, update handoff and reconcile state, automatic-install preferences. |
| Project (local) | `<project>/.ade/local.yaml` | `projectConfigService` | Per-user, gitignored overrides: ports, env vars, machine paths. |
| Project (data) | `<project>/.ade/` | various services | Lanes, attachments, kvDb, generated assets; `.ade/.gitignore` whitelists only authored files. |

- **The runtime ties the scopes together.** It owns `~/.ade/projects.json`,
  builds an `AdeRuntime` per project root on the first project-scoped JSON-RPC
  call, and is the one runtime through which desktop and SSH-attached desktops
  see lanes, chats and sessions.
- **Registry writes are serialized.** The desktop, the brain, the CLI and a
  project move all write `projects.json`. Each write
  (`ProjectRegistry.mutate`) holds `projects.json.lock`, reads the file fresh
  and appends a line to `projects.journal.jsonl` (`projectRegistryJournal.ts`),
  so overlapping writers keep each other's projects.
- **Project ids.** An id is the hash of the folder as this machine resolves it
  on each read. When it differs from the stored id, the stored id becomes an
  alias in `project-aliases.json` (as after a move) and Sentry gets a report.
- **Project identity files.** Each opened local project has
  `~/.ade/project-data/<projectId>.json` with its database's device and inode,
  recorded by the desktop, the brain's project scope and the CLI on open. It
  sits outside `projects.json` because an older ADE drops unknown fields there.
- **Missing data stops open.** If a registered project's folder or `.ade`
  folder, or a recorded database, is missing, registration and open stop with
  `project_data_missing` before creating new state. The desktop shows the
  recovery screen (`data_missing`): Restore from Trash (when the folder exists),
  steps to put it back (it reopens when it returns), or Start fresh. With the
  project folder gone it says to plug the drive in or move the folder back.
  Start fresh and removing from recents forget the identity; a new project
  still creates its first database normally.

## Source file map

Paths are relative to `apps/desktop/src/` unless they start with `apps/`.

**Main process**

- `main/main.ts`, `main/services/ipc/registerIpc.ts`: the packaged-launch
  machine-trust reset and the process-wide account launch gate
  (`ade.app.getLaunchGateState` / `resolveLaunchGate`; one resolve covers every
  window and reload; a fresh signed-out launch asks again). `registerIpc.ts`
  also forwards `copyDependencies` on project-move start, and disk pressure
  falls back to this computer's ADE storage root without a local project
  monitor.
- `main/services/runtime/machineTrustResetMigration.ts`: a one-release
  packaged reset of saved connection grants (remote targets, desktop paired
  credentials, mobile/web pairing records, runtime-host grants); it restarts
  the background service before writing its marker.
- `renderer/components/settings/SettingsMachinesNav.tsx`,
  `SettingsMachineScope.tsx`: per-machine Settings navigation and its
  current/pinned target (`projectMachines.ts` lists machines; local-only and
  bound-runtime sections show only on a machine that reaches them).
  `useSettingsMachinePage` keeps each page's `pin` stable until the binding key
  changes, so sync ticks do not restart effects (or cancel a provider
  sign-in).
- `settings/general/GeneralPage.tsx`, `general/NeedsAttentionStrip.tsx`,
  `general/MachineUpdateRows.tsx`, `overview/useNeedsAttention.ts`: General,
  where Settings opens. One Needs attention row that opens in place (a failed
  read adds "couldn't check" with Check again; a capability an older build
  lacks is absent), the You and This machine cards, and the ADE card (version,
  the one restart action, update track, automatic installs, an update row per
  machine offered its own track's newest build).
- `settings/machines/MachinesPage.tsx`, `MachineSettings.tsx`,
  `machineFacts.ts`, `machineSeams.tsx`: System → Machines, every machine on
  one page and a page per machine (`?machine=<id>`); each row acts through
  that machine's pin or says where it changes. `MachineWorkCopies.tsx` is
  "Work from other machines" (`remote_work.list` / `remote_work.delete`, see
  [cross-machine agents](../sync-and-multi-device/cross-machine-agents.md)).
  `machineSeams.tsx` holds empty typed slots that render nothing until a real
  source feeds them.
- `settings/ContinueAfterRestartSection.tsx`: Chat › Restarts › **Continue
  chats after restarts**, one value per machine
  (`~/.ade/continue-after-restart.json`, read by that brain), with a machine
  picker when several are reachable.
- `settings/lanes/LanesSettingsPage.tsx`, `lanes/LaneList.tsx`: Project →
  Lanes (Your lanes, Rules), Project → Deleted & Archived (Recently deleted,
  Archive) and Project → Disk space (Space, Rules), one view at a time. The
  web shows Recently deleted, Archive and Rules; a page with one view has no
  tab strip; hash links and search switch views. Project
  → Agents is a section list in `settingsTabContent.tsx`.
- `main/services/account/accountBridge.ts`,
  `apps/ade-cli/src/services/account/accountAuthService.ts`,
  `accountMachineDirectoryService.ts`: machine-scoped Clerk session and
  directory ownership.
  - Adoption captures the owner before network work and checks it again before
    saving; logout or an account switch removes only that owner's remote
    targets and paired credentials. Direct trust (PIN, link, Nearby, address,
    SSH) stays local and is never adopted by a later sign-in.
  - With analytics on, a known user is identified only by a one-way account
    hash with closed fields; logout rotates the anonymous id.
  - `accountAuthService` owns `sessionState`, the mark-dead-not-delete markers,
    the `account.session_mutation` audit line and
    `accountSessionRetainsMachineOwnership`; see
    [Account session state](#account-session-state-is-a-four-state-not-a-boolean).
    `accountBridge.ts` mirrors `sessionState` onto `AdeAccountStatus`, deriving
    it from `sessionReadState` when the runtime omits it.
- `apps/ade-cli/src/services/account/accountSettingsStore.ts`,
  `accountVaultStore.ts`, `accountCacheStore.ts`: the four-scope, owner-tagged
  settings cache and the encrypted vault cache.
  - Settings are non-secret and survive sign-out. Vault credentials are
    encrypted, purged on sign-out or account switch, and never reach the
    renderer settings bridge. Local reads are immediate; the brain and Worker
    stay the authority.
  - A sync pulls every truncated page before ready, and drops uploaded write
    seqs even when a later delete fails. A cache write that cannot reach disk
    rolls back and reports failure.
  - Local renderer preferences upload after a successful sync when the account
    has no row; a cold empty cache does not seed. Vault writes made while the
    brain is down retry a few times on an unref'd timer.
  - **One refused item never blocks the queue.** The store asks for per-item
    answers (splitting batches against an older Worker), parks the refused
    item with its reason, sends the rest and still pulls. Parked items retry
    hourly or when rewritten.
  - **Older writes lose.** Each queued write carries its time; the Worker
    refuses one older than the stored row (clock-corrected for this computer,
    never for the row's device), and the store adopts the newer row, so an
    unjammed queue cannot overwrite a rotated token.
  - `health()` (ok / failing / unavailable, last sync, pending, parked, an
    error sentence) shows in Settings › ADE MCP; failures log, rate-limited,
    to `<ade home>/runtime/brain.jsonl`.
- `main/services/account/accountMigrationRunner.ts`,
  `apps/ade-cli/src/services/account/accountMigrationReceipt.ts`: silent,
  receipt-backed sign-in migration of provider API keys and Linear OAuth
  refresh credentials; the `project_secrets` source moves old project secrets
  into Passwords & Secrets. A source completes only after the account confirms
  the write; others stay pending and retry on a later vault-ready tick.
- `apps/ade-cli/src/services/account/sharedAccountAuthService.ts`,
  `cliRefreshBroker.ts`, `accountBridge.ts`: the brain-owned refresh broker
  for desktop and CLI; a local exchange is only the unavailable-brain
  fallback.
- `apps/ade-cli/src/services/account/accountSessionRotationJournal.ts`: the
  crash-safe rotation journal (`account.session.rotation.v1`) in the session's
  own credential bucket, seen by brain, CLI and desktop. `tryBegin`
  compare-and-swaps it, so a peer's in-flight Clerk refresh is a mutex.
- Keep-awake ([Keeping the machine awake](#keeping-the-machine-awake)):
  `apps/ade-cli/src/services/power/brainKeepAwakeService.ts` (brain-owned
  preference and turn-following lock); `main/services/power/keepAwakeService.ts`
  (the macOS authorization prompt, and an in-process fallback only for a brain
  without the action); `systemSleepConfig.ts` (reads and fixes the idle-sleep
  timer); `shared/types/keepAwake.ts` (`KeepAwakeLevel`, `KeepAwakeSnapshot`,
  `normalizeKeepAwakePreferences` — anything unknown is `never`,
  `systemSleepStopsAgents`, `INERT_KEEP_AWAKE_SNAPSHOT`);
  `settings/KeepAwakeSection.tsx` (radiogroup, "This Mac can still sleep"
  alert, system-sleep fix card).
- `settings/BackgroundServiceSection.tsx`: General → ADE → Background service:
  who runs agents, working chats in open projects (plus "may also be running"
  for busy projects not open), "Stop and quit ADE", and "Ask before quitting"
  (undoes the quit prompt's "Don't ask again"). Stop confirms with the chat
  list and fails closed (`services/runtime/backgroundServiceControls.ts`): it
  refuses when ADE cannot read what runs, when an agent started after the
  confirm, during a lane delete and during any Repair. Packaged builds only.
- `main/services/runtime/quitPrompt.ts`, `app/QuitPromptHost.tsx`,
  `shared/quitPromptModel.ts`: the quit and restart confirmation in ADE's
  dialog, with a native fallback from the same model (see
  `docs/ARCHITECTURE.md`, shutdown pipeline).
- Archive: `main/services/archive/archiveService.ts` (`list` / `summary` from
  `laneService.list` and `terminal_sessions.archived_at`; `restore` / `delete`
  one item at a time). Delete keeps the branch (`deleteBranch: false`),
  forwards `force` only when sent, and refuses a dirty lane without it. Delete
  is user-only, restore CTO-only (`ADE_ACTION_USER_ONLY` /
  `ADE_ACTION_CTO_ONLY`, `adeActions/actionPolicy.ts`). `shared/archive.ts`,
  `shared/types/archive.ts`: one vocabulary (`isArchiveStale`).
  `settings/ArchiveSection.tsx`: every online copy's archive in one list, each
  row split at its own machine's `staleAfterDays` ("Free up space after", 14
  when off), selection bar, restore, Free up space (Archive & reclaim through
  `useLaneReclaim` on the row's machine pin), and delete (non-lane items
  together, at most five lanes a request, then one forced retry by name for
  dirty lanes, matched by machine). `app/useArchiveReminderBanner.tsx`: at most
  once per project per `ARCHIVE_REMINDER_INTERVAL_MS` (a week) when something
  passes the host's line; a summary that lands after a snooze is dropped.
- `apps/ade-cli/src/services/providerInstances/providerInstanceStore.ts`: this
  machine's Claude and Codex accounts: the JSON registry, the base account
  (its `configHome` recomputed each read), default selection,
  `resolve(provider, requestedId)` for every launch, and per-provider settings
  (smart balance, auto-start windows). Backs `provider_instances.*` and `ade
  providers accounts`.
- `main/services/providerAccounts/`: in-app sign-in. `providerLoginRunner.ts`
  runs the provider's login for one config home in a private node-pty, reads
  the link and code prompt, and checks the saved login on exit; it is the only
  reader of raw login output and creates no terminal or Work row.
  `machineProviderLoginRunner.ts` is the one runner per machine (local IPC and
  pinned `provider_instances`). `refreshProviderAccounts.ts` re-reads accounts
  after a sign-in.
- `main/services/ai/agentCliLoginRunner.ts`: the same sign-in for the pinned
  agent CLIs (Grok, Devin, Muse, GitHub Copilot, Droid, Kimi) behind
  `ai.cliLoginStart` / `cliLoginStatus` / `cliLoginSubmitCode` /
  `cliLoginCancel`, in a private PTY on the owning machine. The result is the
  saved login read back by file fingerprint (`readAgentCliSavedLogin`,
  `authDetector.ts`), never output text, and counts only when it differs from
  the starting one. With a login already there (Sign in again) or a file
  rewritten before approval (Copilot), only a clean exit with a changed login
  counts. Muse on macOS (Keychain) counts a clean exit unless it printed a
  failure. A signed-in Droid ends at once as signed in.
  `machineAgentCliLoginRunner.ts` is one per machine;
  `main/services/shared/cliLoginPty.ts` holds the shared PTY spawn, Windows
  tree kill, output cleaning (a ConPTY cursor move reads as a break or space),
  link, device-code and paste-prompt reading.
- Shared contracts: `shared/types/providerInstances.ts` (providers, accounts,
  env keys, per-provider settings, `ProviderLoginStatus`);
  `shared/types/apiCredentials.ts` (secret-free key summaries: provider, id,
  label, source, masked tail); `shared/types/subscriptionProxy.ts` (proxy
  status and routes, no credentials); `shared/types/machineInventory.ts`
  (token-free account and harness summaries for paired machines);
  `shared/safeIdentifier.ts` (an ADE-owned id must pass it before it becomes a
  path or key segment); `shared/providerColors.ts` (the one provider colour
  table).
- `main/services/account/accountMachineInventoryLiveRefresh.ts`: live detail
  for one directory machine row, asked only of machines already online and
  connected, so expanding a row never pairs or spends a reconnect.
- `settings/providers/accounts/`: the Accounts panel (routing strip, account
  cards, `UsageAccountRow`, ⋯ menu, copy and replaced-login states, the
  three-step Add-account sheet, `useProviderInstances`).
- `settings/providers/ProviderDetailPage.tsx`, `ProviderHero.tsx`,
  `providerBrand.tsx`, `providerPage.css`, `banners/`: one provider's page
  (banner art or gradient, 3D logo, status, version, this machine's 30-day
  usage from `usage.getAdeStats`, then Accounts and two columns).
  `providerBrand.tsx` is the one table of accent, banner and logo (`solid` or
  `tile`).
- `settings/providers/ProviderContextPanel.tsx`: the
  [Initial context window](#initial-context-window) card.
  `main/services/ai/providerContextInventory.ts` and `ai/providerContext/`:
  the read-only `ai.getProviderContextInventory` (`PROVIDER_CONTEXT_SPECS`,
  scanners `items.ts` / `fsScan.ts`, one file per provider, `adeItems.ts` from
  `agentChatService.previewNewChatAdeContext` and
  `chat/adeChatContextPreview.ts`, `firstTurnMeasurement.ts`);
  `ai/providerContextReveal.ts` allowlists "Show in Finder".
- `settings/providers/keys/`: the stored API keys panel, the add-key sheet
  (only fields a harness has), the OpenCode custom-provider panel,
  `useApiCredentials`, `useAccountProviderKeyNames` (for "This computer
  only").
- `settings/CloudAgentLimitsCard.tsx`: ADE Cloud › What agents may do alone.
  Desktop: `cloud.getAgentLimits` / `setAgentLimits` (server first, a local
  copy on 404). Web: `accountCall` `limits` / `saveLimits` with the read
  revision; a stale save loads the newer limits and says "Your limits changed
  on another device. ADE loaded the new ones."
  - On the web, `getAgentLimits` and `setAgentLimits`
    (`webclient/adapter/cloud.ts`) go to a connected computer's `cloud.read`
    and `cloud.write`. With no computer that has them, they go to the account
    (`GET/PUT /cloud/limits`). A stale `ifRevision` answers 409.
- `settings/WebAccountCloudCards.tsx`: two cards under
  `AccountCloudProvidersPanel` in Settings › ADE Cloud, on the web with no
  own computer that is on (`useAccountProvidersInSettings` in
  `settingsTabContent.tsx`). Each card reads from the account
  (`window.ade.accountSettings`) when it opens and on window focus. There is
  no poll and no secret read.
  - **Sign-ins on ADE Cloud**: one switch, "Share my sign-ins with ADE
    Cloud" (`providerLogins.cloud.enabled`; absent is on). Before it writes,
    the card reads the setting again and keeps every other field (picks,
    keys switched off, smart balance). Off reads "Off: you sign in on each
    cloud computer yourself."
  - **MCP servers**: the account's `mcp.servers`, by name and transport only
    (`normalizeMcpRegistry`, `MCP_TRANSPORT_LABEL`). Add, change and secrets
    stay on a computer. Empty: "No MCP servers in your account. Add one in
    ADE on a computer and every agent gets it, ADE Cloud too."
  - A failed read shows "ADE couldn't read this from your account. Try
    again." with Try again and no Report.
- `settings/cloudDashboard/CloudDashboard.tsx`: on the web, `ownComputer`
  counts only an own computer that is on. With none on, the account's cards
  above show in place of the computer's sign-ins.
- `apps/ade-cli/src/services/proxy/`: the local subscription proxy (`ade
  proxy`, `proxy.*`): hash-verified download, config written 0600, state
  without secrets, start/stop/health supervisor.
- `settings/CaptureGestureSection.tsx`: the capture-gesture switch, helper
  health and retry, via `supportsCaptureGesturePlatform()` /
  `captureGestureBlocker()` (`renderer/lib/platform.ts`).
- `main/services/onboarding/onboardingService.ts`: status, stack detection,
  existing lanes, suggested config. `onboardingSuggestedConfig.ts`: pure
  GitHub Actions parsing into suggested `.ade/local.yaml` config.
- `main/services/tools/agentToolsCacheService.ts`: the desktop half of the
  pinned agent-tools cache: a coalesced ensure of this machine's tools
  (`agentToolDemand.ts`) on packaged launch, one `ensureTools` per tool, GC
  only after a clean pass, and an `AgentToolsCacheSnapshot` (status, percent,
  `errorKind`) over IPC; failures are per tool; others download on demand
  (`onDemand.ts`). See [agent-tools-cache.md](./agent-tools-cache.md).

- **GitHub** — `main/services/github/githubService.ts`,
  `githubCredentialHealth.ts`, `githubRateLimit.ts`: App, environment, PAT and
  `gh` discovery, `/user` and repository probes, failure and quota
  classification, per-resource cooldowns, and the shared-account quota breaker.
  - Order (`shared/githubOperationCredential.ts`): env > app > gh > pat >
    account_app > account_gh for reads; writes skip `app` (read-only).
    `account_app` writes only where the owner's installation grants it;
    `account_gh` comes last. Duplicate tokens are removed.
  - 401/403/429, GraphQL rate/permission errors and 403/404 probe denials move
    to the next source. Invalid or denied credentials cool down five minutes;
    rate limits wait at least a minute and honour GitHub's reset; then ADE
    retries the preferred source. An exhausted primary user quota pauses every
    known credential of that account instead of cycling tokens.
  - `GitHubStatus.authFailure` separates rate limit, invalid, permission,
    `service_unavailable` (GitHub 5xx), network and unknown. A
    `service_unavailable` probe gets no cooldown and stops the walk.
  - **Publishing** (`createRepository`, same in the service's twin) routes with
    `resolveGithubCreateRepositoryRoute` (`shared/githubApiPath.ts`):
    `/user/repos` for no owner or the write credential's own login,
    `/orgs/{owner}/repos` otherwise; when `GET /user` fails, `GET
    /users/{owner}` decides, and an unconfirmed user owner fails with the
    retryable `github_owner_unverified`. The personal route never falls back
    to another credential (`credentialSource`). An unknown owner answers
    `github_owner_not_found`. A leftover same-name repository is reused only
    when empty and of the requested visibility. A repository whose owner is not
    the requested one is refused before `git remote add`
    (`repo_owner_mismatch`, `assertGithubRepositoryOwner`).
  - `GitHubStatus.credentialStoreUnreadable` rides the credential inventory
    (cached 30 s), is sticky across reads, warns
    `github.credential_store_unreadable` once per transition, and clears on a
    successful token write.
- `main/services/github/credentialReadState.ts`: `readCredentialWithState` /
  `readCredentialWithStateAsync` return a credential and readability in one
  call. An undecryptable store returns an empty view, and `getLastReadState()`
  describes only the latest read, so it must follow the `getSync` it judges; a
  throwing store (Electron `safeStorage`) also counts as unreadable.
- `shared/githubServiceHealth.ts`, `main/services/github/githubStatusPage.ts`:
  outage versus broken credential. Parses githubstatus.com `summary.json` into
  `GitHubServiceHealth` (`isGithubServiceUnavailable`), counting only API
  Requests, Pull Requests, Issues, Actions, Webhooks and Git Operations. It
  runs only after a failed request, caches 60 s (negative too), times out at 2
  s and fails silent; `attachGitHubServiceHealth` fills
  `GitHubStatus.serviceHealth` in both `getStatus` owners. A corroborated
  incident clears the user; a healthy page never blames them (it lags 10–20
  minutes). See
  [pull requests](../pull-requests/README.md#telling-a-github-outage-apart-from-a-broken-credential).
- `apps/ade-cli/src/headlessLinearServices.ts`: the runtime's mirror of the
  GitHub path (order, cooldowns, GraphQL classification, cache isolation,
  read/write fields, status-page corroboration, `credentialReadState.ts`,
  `credentialStoreUnreadable`). The renderer uses whichever service owns the
  project, so a change to one `getStatus` only is dead in the runtime-backed
  build.
- `main/services/config/projectConfigService.ts`: YAML read/merge/save, AI
  mode migration, lane env init, Linear sync resolver (the largest service).
  The parsed `local.yaml` is cached by file identity (inode, size, mtime, ctime
  of `local.yaml` and the legacy `ade.yaml`). Validation still runs every read
  (it checks named paths); the `test_suites` snapshot is rewritten only when
  the file changed or validation first passes. `laneOverlayMatcher.ts`
  matches lanes against `LaneOverlayPolicy[]`.
- `main/services/secrets/projectSecretService.ts`: one project's view of
  Passwords & Secrets (`ade secrets`, process env, webhook checks) and the
  one-time move of the old store; `projectSecretEnv.ts`: bounded dotenv parsing
  and the `0600` export file.

**Shared types, IPC and preload**

- `shared/types/config.ts`: the config schema types.
  `shared/types/projectSecrets.ts`: list, value, set and delete contracts.
- `shared/types/core.ts`: `AutoUpdatePreferences`,
  `DEFAULT_AUTO_UPDATE_PREFERENCES` (`automaticInstall: false`, `onlyWhenIdle:
  true`) and the update snapshot.
- `shared/types/git.ts`: `GitHubStatus`, `GitHubAuthFailure`,
  `GitHubRateLimitState` and the credential contracts. `writeAuthSource`,
  `credentialStates`, `credentialFallback`, `credentialStoreUnreadable`,
  `backgroundRefreshPausedUntil` and `serviceHealth` are optional so an older
  runtime can omit them. `GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY` is the one
  wording for Settings, the integration banner, the PR tab's empty state and
  Publish to GitHub, which then hides the token field and offers only **Open
  connections** (a saved token would overwrite a recoverable sign-in).
- `shared/ipc.ts`: `ade.onboarding.*` (status, detectDefaults,
  applySuggestedConfig, complete, setDismissed); `ade.projectConfig.*` (get,
  validate, save, diffAgainstDisk, export); `ade.project.*` (listRecent,
  openRepo, switchProjectToPath, getSnapshot, initializeOrRepair,
  runIntegrityCheck, inspectRemoval, removeCopy); `ade.passwords.*` (call,
  reveal, chooseEnvFile, projects); `ade.ai.*` and per-integration channels;
  `ade.agentChat.setScheduledWorkPaused` (the global pause goes through
  `ade.ai.updateConfig`); `ade.update.getPreferences` / `setPreferences`.
  Handlers: `main/services/ipc/registerIpc.ts`.
- `preload/preload.ts`: `window.ade.onboarding`, `.projectConfig`,
  `.project`, `.passwords`, `.projectSecrets` (list and set on the pinned
  machine, for chat and webhook cards), `.updateGetPreferences`,
  `.updateSetPreferences`, `.github` and other integrations.

**Renderer — projects and home**

- `projects/ProjectWelcomePage.tsx`: the projectless home. A hero
  (`ProjectWelcomeHome.tsx`: greeting, date, headline from
  `home/homeHeadline.ts`, running / needs-you counts), actions (**Add
  project**, **Chat without a project**, **Browser**, recents panel) and the
  widget grid.
  - **The Projects card** lists the account's projects, one row each, and
    counts them (`ade projects list --account`) on every client, with or
    without a computer (`homeProjectRows.ts`, `useHomeAccountProjects.ts`).
    Folders on no account project follow under "Only on <computer>" and do not
    count: this computer's from `project.listThisComputer` (no pin; reread
    when the brain connects), others from their connection catalogs.
  - A row's computers chip opens the copies menu. X opens the remove window
    with **From this list** first (hides the row on this computer,
    `homeHiddenProjects.ts`, by account project id; it still counts; "N
    hidden" restores; opening the project restores it). A local folder's X
    forgets it with Undo. At most 40 rows inline, then "N more".
  - Rows share the project tab's right-click menu (`projectMenuEntries.ts`:
    icon, pin, copy path); with no checkout here, **Add a copy on this
    computer…** opens Add project with this computer ticked.
  - **Settings** sets `standaloneSettingsOpen` and opens `/settings` (see
    [Settings with no project](#settings-with-no-project)).
- `projects/ProjectWelcomeSidePanels.tsx`: the machine list: this machine,
  connected own computers, then one **ADE Cloud** row ("Wakes when you start
  work"). Offline computers hide; no ADE Cloud computer shows by name. "N of M
  computers connected" counts all the account's computers.
- Opening a project with no own computer online binds the tab to ADE Cloud
  (`openAdeCloudProject`, `renderer/state/adeCloudTabs.ts`): the normal pages
  with its ADE Cloud lanes.
- `projects/AddProjectForm.tsx`: **Add project** from GitHub. **Open a
  folder…** and **New empty project…** sit under it
  (`AddProjectMoreActions.tsx`), with a computer picker when others are
  connected. The repository, then one row per machine (this computer except on
  hosted web, and every saved machine). Offline machines cannot be ticked; the
  form never connects or wakes one; a machine with a copy says "already here".
  Each ticked machine clones on its own (`projectCopyJobs.ts`; a retry goes to
  the same machine). **Opens on** picks where it opens; a closed form gets
  "<repo> is ready on <machine>" with **Open**, or a toast naming the machine.
- `projects/ProjectCopiesMenu.tsx`: a project's copies (Home chip, sidebar
  computers tag, the tab's **Copies** submenu). One row per machine: the copy
  in use, another copy (moves the tab with that copy's binding), "not here"
  with **Add a copy**, "Not connected", or offline; every surface counts with
  `copyComputers`. No git origin: "This machine only" with Publish.
  `useProjectCopiesMenu.ts` owns menu and remove-dialog state;
  `projectCopies.ts` holds the shared rules; `ConnectGithubPrompt.tsx` asks
  for GitHub access when repositories cannot load.
- `projects/RemoveProjectDialog.tsx`: **Remove project…** removes the entry
  from the tab's machine, or with **Remove from all my machines** from every
  copy (hidden without a git origin). Folders stay by default. With **Also
  delete the folders**, each machine reports its copy
  (`projects.inspectRemoval`): clean copies are ticked, copies with work no
  remote has need ticking by name, copies with something running cannot be
  ticked. Each machine re-checks right before deleting and refuses on a
  change. This computer's folders go to the Trash; others are deleted for good,
  and the dialog says so. Offline machines are never called.
- `shared/projectRemoval.ts`: the removal shapes.
  `apps/ade-cli/src/services/projects/projectCopyRemoval.ts` runs
  `projects.inspectRemoval` / `removeCopy` in a fixed order (re-read, refuse on
  mismatch, check the folder, stop the project, delete, drop the entry); a
  brain deletes permanently. `desktopProjectRemoval.ts` adds this computer's
  folder check and the Trash (`folderMode: "caller"`).
  `projectRemovalState.ts` reads what would be lost from git (checkouts,
  changed files, unpushed commits, stashes, unpushed branches) only on request.
  `projectRemovalGuard.ts`: a folder may be deleted only when it is an exact
  registered root that holds no home folder, ADE home, other project or ADE
  itself, and the copy still matches what was accepted. `projectCopyCheck.ts`
  holds the shared checks. IPC: `ade.project.inspectRemoval` / `removeCopy`
  (this computer), `ade.remoteRuntime.inspectProjectRemoval` /
  `removeProjectCopy` (others).
- `shared/projectRecord.ts`: one display name and icon per repository for all
  the account's machines, as `repo:<origin>` rows in the account settings store
  (last writer wins); no origin keeps them on its machine. Readers:
  `apps/ade-cli/src/services/projects/projectRecords.ts` (brain; one snapshot,
  read at most once a second, or `.ade/project-record.json` with sync off) and
  `main/services/projects/desktopProjectRecords.ts`. `projectRecordHost.ts`
  holds the stand-in file, per-state values and the icon shrink; a choice the
  store cannot take stays pending in the stand-in and goes first on the next
  access. `renderer/lib/useProjectRecords.ts` reads it per set of repositories
  and on `accountSettings.onChanged`, with no timer. See
  [remote runtime](../remote-runtime/README.md) for `projects.setIcon` /
  `removeIcon`.
- `components/home/`: the widget home (Projects, Working now, Activity,
  Limits, PRs, Clock & weather, Focus timer, Clipboard, Machine,
  Contributions, Shipped, Feed, Now Playing), each with a size class and
  order. `homeGridPack.ts` fits them with no scroll or gaps (smaller classes
  before hiding); `homeLayout.ts` keeps named layouts per computer in
  localStorage (a second window follows). The default stack is Pull requests
  over Contributions, Projects over Working now, Clock & weather beside; a new
  `HOME_DEFAULT_STACK_VERSION` installs the new stack as "Default" once and
  keeps saved layouts. `HomeWidgetPicker.tsx` (inert previews),
  `HomeEditTools.tsx`, `homeFeed.ts`, `widgets/`; main side
  `main/services/home/` behind `ade.home.*`. Rules:
  `docs/plans/ade-dev-home.md` section 4.
- `projects/ProjectWelcomeHome.tsx`: the hero and default card bodies
  (`RunningCard`, `ActivityUsageCard`, `LimitsMachinesCard`,
  `PullRequestsCard`), each linking to its full surface. The PR card reads the
  PRs tab's snapshot (`prReadCache`) joined with tracked PRs, reloading on PR
  events and focus, never on its own timer.
- `projects/CreateProjectForm.tsx`: name and a location row (default parent,
  Change folder, editable path). Create opens Work.

**Renderer — launch and sign-in**

- `onboarding/OnboardingBootstrap.tsx`: the passive help mount; it renders the
  one-time welcome video gate.
- `onboarding/LaunchGate.tsx`: the launch gate. New installs see the welcome
  card before sign-in; returning signed-out launches see sign-in. By
  `accountGateMode`: `required` (never held a session) has no pass-through;
  `recoverable` (expired or unreadable session) always offers **Continue to
  your work**. Local work is never blocked; `AccountSignedOutBanner` nags
  instead. It keeps a short ADE Relay link and a draggable top strip, and does
  not repeat for reloads or extra windows. Directly paired machines survive
  sign-out; owner-tagged directory targets go with the account.

- `onboarding/GlassSignInCard.tsx`, `account/useSignInFlow.ts`: the gate's
  sign-in, a frosted panel (`onboarding/launchGateGlass.css`, needs an
  `.ade-gate` ancestor) with the mark, a heading, sign-in, **Sign in with your
  phone or another device**, the awaiting/cancel line and ADE Relay help. The
  other-device link starts device authorization with no browser here:
  `AnotherDeviceSignInPanel` shows the link as a QR code and the user code
  (absent on the hosted web). `useSignInFlow` owns browser login, device login
  (`useAccountDeviceLogin`, `lib/accountLogin.ts`), the four session words and
  the brain repair; the Account page's `SignInCard` draws the same state.
- `account/AccountSignedOutBanner.tsx`: the permanent bar while the account is
  not usable, through `AppBannerHost` and `Banner` with `dismiss: false` (only
  sign-in or a repair clears it). The host is mounted in `AppShell` outside
  project conditions, so it reaches projectless windows; `IntegrationBanners`
  uses the same host. It hides on `/account`. The four states' copy is one
  record in `renderer/lib/account.ts` (a new state is a type error).
  - It also carries the one signed-in problem: the directory refuses THIS
    computer (`machine_revoked` or `pairing_authentication_required`, from the
    sync snapshot via `hooks/useThisComputerRefusal.ts`). It names the date
    from `revokedAt` ("This computer was removed from your account on 14
    August"), adds "ADE stopped trying to reconnect it on its own." once the
    brain's repair gave up, and offers **Reconnect this computer** (or
    **Confirm it's you**), showing the browser step's code in the bar. Not
    dismissable.
  - `hooks/useReconnectThisComputer.ts` only subscribes; the one flow per
    window is `renderer/lib/reconnectThisComputer.ts`, so a second surface
    joins the running attempt. Refusal copy: `renderer/lib/thisComputerRefusal.ts`
    (also read by the Account card, Connections' This computer card and the
    Machines list). Main raises no OS notification for a give-up.
- `account/AccountPage.tsx`: account status and sign-in/out. The signed-out
  page takes a return route from the sidebar or Connections (else `/work`) and
  sends pairing work to Connections. `AdeAccountStatus.sessionState` is
  `active | signed_out | expired | unreadable` (derived from
  `sessionReadState` for older runtimes); `accountSessionState` /
  `accountSessionNotice` (`renderer/lib/account.ts`) are the only branch
  point. `expired` keeps Sign in; `unreadable` must not lead with sign-in (a
  new session overwrites the stored one): it leads with `BrainRepairButton`
  (or a retry) and demotes sign-in to "Sign in anyway".
- `account/YourMacsCard.tsx`: **Your computers** (this computer first;
  rename, clear name, remove; the missing-directory row). ADE Cloud's
  computers never get their own rows: one ADE Cloud row shows while ADE Cloud
  is available, and the web heading counts only the rows it shows. Custom names are
  account-wide and win for display without replacing the reported hostname.
  - **Absence is not removal** (a publish gap, a split listener or an expired
    sign-in look the same). `describeThisComputerMissing` claims removal only
    on the directory's own refusal; otherwise expired → Reconnect, unreadable
    → Repair then Reconnect, active/signed_out names both causes and actions.
    Machine repair never says "Sign in again"; the browser step is "Confirm
    it's you".
  - Rows show the name (`accountMachineRowName`) and, when not the regular
    app, the install (`accountMachineInstallLabel`: "MacBook Pro" then "ADE
    Alpha"), with the ADE home on hover.
  - Remove warns for a machine seen in the last five minutes
    (`accountMachineRemovalConfirmBody`, shared with the web). Removal is
    terminal; heartbeats never re-register.
  - **Reconnect this computer** calls `repairMachinePairing` (running the
    device login when the directory wants a fresh interactive sign-in, the
    only flow ending in the single-use pairing grant); **Repair** restarts the
    background service (`BrainRepairButton`, disabled during Reconnect).
    Outcome copy covers a rejoin before push resumes.
  - Outcome words (`describeReconnectOutcome`, `reconnectNeedsFreshSignIn`,
    `readReconnectResult`, `ReconnectOutcome`) live in
    `shared/reconnectOutcome.ts` (no renderer or Node globals), also read by
    `ade machines reconnect --text`.
- `onboarding/FirstRunFlow.tsx`, `firstRun.css` and one stylesheet per step
  (`firstRunWelcome.css`, `firstRunAgentRail.css`, `firstRunProjects.css`,
  `firstRunDevices.css`): first-run setup. `FirstRunSteps.tsx` holds the step
  machine (`useFirstRunSteps`) and the card renderer; `LaunchGate.tsx` runs it
  around sign-in and `OnboardingBootstrap.tsx` shows it over the app ("Show
  me around again" or a reload mid-setup), leaving out "Connect your agents"
  when the front tab is on another machine. See
  [First run on a computer](#first-run-on-a-computer).
- `main/services/onboarding/onboardingProjectDiscovery.ts`: finds projects
  from every importable provider's history without git
  (`app.discoverOnboardingProjects`) and lists one project's importable chats
  (`app.listOnboardingProjectChats`), both in a child process
  (`onboardingDiscoveryClient.ts`, `ELECTRON_RUN_AS_NODE`) because the
  discoverers read synchronously; chat lists stay in main for the session.
  `app.resolveOnboardingFolder` maps a picked folder to its project (a
  subfolder to its checkout, a lane or worktree to its project) or refuses one
  outside git. `app.addOnboardingProjects` adds to the front of recents
  without evicting (the cap of 24 may be passed until later opens trim). All
  four run on this computer only; the 30-day window is
  `shared/onboardingChatWindow.ts`.
- `onboarding/FirstRunChatPicker.tsx`: the per-chat picker behind an import
  pill's count. `onboarding/useOnboardingChatImport.ts` and
  `renderer/onboarding/pendingChatImports.ts`: the first open of each added
  project with its pill on imports the last 30 days of chats, minus those left
  out.
- `onboarding/tour/`: the guided tour (`onboardingTourSteps.ts` with each
  step's `data-onboarding-anchor`; `OnboardingTourHost.tsx`: cursor, ring,
  card, paused pill; `anchorGeometry.ts`, shared with hints).
  `renderer/onboarding/onboardingProgress.ts`: per-computer progress.
- `renderer/onboarding/situationalSuggestions.ts`,
  `app/suggestions/`: [Situational suggestions](#situational-suggestions).
- `onboarding/HelpMenu.tsx`: the top-bar help menu (docs link, "Show me
  around again", the detailed-tooltip toggle); `SmartTooltip` hover detail is
  the one help surface. `renderer/onboarding/docsLinks.ts`: the typed registry
  of doc URLs, including the ADE Relay explainer.
- `components/cto/…`: CTO first run is the model picker. A project with no
  stored model opens on `CtoWelcome` (`cto-model-pick`); Linear and the rest
  live on the CTO settings page.

Account Settings shows a named update prompt when a connected computer needs
a newer ADE version to share its routes or provider inventory. In the
**Connections** section, **Check again** shows progress and the latest results
for the local network, Tailscale, and ADE Relay, along with Tailscale setup
steps and the time of the check. This computer's Tailscale reading
(`tailscaleLocalStatus.ts`) also reports `keyExpired` (Tailscale's
`Self.Expired`, or a key expiry already past), Tailscale's own `Health`
warnings, and `readError` (a timeout, or Tailscale's first error line) when
ADE got no answer it could read. The first step then says "Tailscale sign-in
expired" with the renew path, or why ADE couldn't read Tailscale, and quotes
Tailscale's first warning; **Open Tailscale** opens the app on this computer
(`app.openTailscale`, a fixed list of install paths). The route tiles say
"Sign-in expired", "Starting" or "Couldn't check" instead of "Not connected".

**Renderer — settings**

- `app/SettingsPage.tsx`: the tab container (one column per section page, a
  section rail when there is room; sections in
  `settings/settingsTabContent.tsx`). It renders only. Tabs, order, deep
  links, search and Cmd-K resolve through `settings/settingsManifest.ts`.
  - Tabs: General, Appearance, Chat, Apple devices, Notifications, Agents &
    Models, Lanes, Integrations, Secrets, Storage, Diagnostics, Archive,
    Usage.
  - Notifications and Activity are one page on one `useActivitySettings()`
    model (event policies, per-machine mute, privacy, sounds, scheduled
    work); `activity` and `attention` resolve to `notifications`.
  - Every shipped tab id resolves through `LEGACY_TAB_ALIASES`
    (`settingsManifest.test.ts`), except `keybindings`.
  - Welcome video and help preferences live in the Help menu.
- `settings/BrowserLinksSection.tsx`: General → **Links**
  (`general.link-open-mode`, scope `machine`, `web: "hidden"`), writing
  `browser.linkOpenMode` and `browser.autoOpenDevServer` to `.ade/local.yaml`
  ([Configuration schema](configuration-schema.md)).
- `shared/settingsManifest.ts`: the registry data and pure helpers, shared
  with `ade settings find` and chat chips;
  `renderer/components/settings/settingsManifest.ts` re-exports it and adds
  platform, web and standalone rules.
  - One `SettingEntry` per setting (`id`, `label`, `keywords`, `tab`,
    `anchor`, `scope`, `web`, `group`, optional `webOnly`); adding one makes it
    navigable, searchable and deep-linkable. `webOnly: true` marks a card only
    the hosted browser draws (`agents.accounts`).
  - `scope` (`account`, `account-repo`, `machine`, `machine-repo`) says who it
    affects. `web` (`SettingWebScope`) says whether it works from a browser:
    it travels to the machine, syncs through the account, stays in the tab, or
    is `hidden`. Secrets, providers, GitHub credentials, dictation, the CLI
    installer, auto-updates, storage, session lifecycle and lane templates are
    `hidden` (their writes would have no descriptor and vanish).
  - `passwords.web` (scope `account`, `webOnly: true`) puts **Passwords** in
    the web Settings nav. The page shows only one notice: "Open ADE desktop
    or the iPhone to see and change Passwords. Agents on every computer, ADE
    Cloud too, still use them." (`WEB_PASSWORDS_SENTENCE`).
    `sectionWebScope` and `WebScopePill.tsx` print the scope as the section's
    first line on the web.
- `shared/settingsAgentAccess.ts`: settings an agent may change (lanes, lane
  templates, agent notes, secrets) and settings only the user changes
  (publishing, sign-ins, money, agent reach, the computer, deleting data,
  preferences); unlisted means the user's.
  - The brain refuses: `ADE_ACTION_CTO_ONLY` for the writes
    (`USER_SETTING_WRITES` in `actionPolicy.ts`, each with its card), and
    `ownerOnlyProjectConfigChange` for an agent `project_config.save` whose
    `local` layer changes a key outside `AGENT_EDITABLE_PROJECT_CONFIG_KEYS`.
    Automation steps may not run `project_config.save`.
  - The user's terminal keeps `ade settings …` and `ade providers accounts
    add|remove|default` (operator role; an agent shell is clamped to agent).
    An agent can still hand-edit `.ade/local.yaml` (a known gap).
- **Themes** — `shared/theme/library.ts`, `resolve.ts`,
  `renderer/theme/applyTheme.ts`.
  - `ADE_THEME_FAMILIES` each have a dark and light variant. `dark` and
    `light` use the stylesheet palettes; others set inline `--color-*` on
    `<html>`.
  - **Only `<html>` carries `data-theme` / `data-theme-id`**; the stylesheet
    re-declares `--color-*` under `[data-theme]`, so the attribute lower down
    resets the palette.
  - `LEGACY_THEME_ID_ALIASES` maps retired ids (obsidian, high-contrast,
    midnight, evergreen, parchment, blush). `themeFollowsSystem` paints the
    family's variant for `systemColorScheme` (`effectiveThemeId`).
  - **Appearance is per computer**: theme id, custom themes,
    `themeFollowsSystem`, `interfacePreferences` (including
    `focusGridMaxChats`, the Focus grid's **Chats per page**, read by
    `useWorkFocusGrid`) and `terminalPreferences` are not in
    `ACCOUNT_SYNCED_SETTINGS`.
  - Families are built in `family.ts` and written in `library.ts`,
    `libraryOriginals.ts` and `libraryClassics.ts`. Optional `syntax` (ten
    code colours, else from the terminal palette) and `flair` (corners, depth,
    face, backdrop). `renderer/theme/codeTheme.ts` makes the Monaco and Shiki
    themes; `applyTheme.ts` sets `data-theme-backdrop`, `data-theme-radius`,
    `data-theme-shadow`.
  - `renderer/theme/applyInterface.ts` applies `sansFont`, `monoFont` and
    `reduceMotion` (`--font-sans`, `--font-mono`,
    `html[data-motion="reduced"]`); `App` drives `MotionConfig` from the same
    flag.
- `shared/accountSettingsScope.ts`, `renderer/lib/accountSettingsSync.ts`,
  `useAccountSettingsSync.ts`: the renderer's account-settings half.
  `accountSettingScopeKey` files a row by scope. A local-first write-through
  engine hydrates newer remote rows and pushes local edits per key with a
  strictly newer stamp, and a dirty queue retries offline edits. Only
  `account` and `account-repo` reach the store.
  - A per-computer account preference (Apple device options) keys by device
    (`accountDeviceSettingKey`, `device.<syncDeviceId>.<key>`).
  - An `account-repo` key is `repo:<host>/<owner>/<repo>` from the canonical
    origin (`readGitOriginUrl`); the checkout's machine resolves a GitHub SSH
    alias through `ssh -G` (`github/githubSshAlias.ts`). The
    `repo_scope_alias` migration copies secrets and settings from the old
    alias key once per project; an existing new-key row wins.
  - Automation rules use the repository key (`automations.rule.<id>`,
    `automations.home.<id>`), each run only by its home computer; see
    [Rules follow the account](../automations/README.md#rules-follow-the-account)
    and [Sync and multi-device](../sync-and-multi-device/README.md).

- `renderer/scene/`, `renderer/styles/scene.css`: the window backdrop (This
  computer → Appearance → **Background**). Modes: `plain` (flat, the web
  default), `gradient` (animated mesh), `image`, and `shuffle` (a library
  picture changed on launch, wake, hourly or daily; the desktop default, sized
  for the screen). Pictures are bundled (`public/scenes/*.jpg` via
  `sceneLibrary.ts`, plus a 2560×1600 copy for 1080p/1440p) or the user's own
  (re-encoded to at most 5120 px JPEG in IndexedDB by `userScenes.ts`, never on
  disk or in sync). `scenePalette.ts` extracts a palette; `sceneTheme.ts`
  (`themeTintedByScene`) tints the theme when App colours is **From picture**;
  `SceneImageLayer` draws one window-aligned slice per surface.
  `BackgroundContextMenu.tsx`: **Next picture**, light/dark, **Change
  background…**. Preferences are per computer
  (`interfacePreferences.scene` in `ade.userPreferences.v1`);
  `SCENE_DEFAULTS_REVISION` (`scenePreferences.ts`) is a one-time default
  reset. See [visual language](../../design/visual-language.md).
- `settings/primitives/`: the control vocabulary (`SettingsCard`,
  `SettingsGroup`, `ScopeChip`, `SettingsToggle` / `Segmented` / `Number` /
  `Select` / `Slider`, `SettingsDisclosure`, `useSavedFlash`).
  `SettingsRows.tsx` adds `SettingsSection`, `SettingsPanel`, `SettingsRow`
  (`icon` / `tone`), `SettingsColumn`, `SettingsSplit`,
  `SettingsSectionAction`. `SettingsModern.tsx` is the page vocabulary
  (`ModernPage`, `ModernSection` with `data-settings-anchor`, `ModernRows` /
  `ModernRow`), the settings side of `renderer/styles/surfaceKit.css`.
  - **No Save button anywhere**: controls persist on change and report through
    `SavedFlash`.
  - `SettingsDisclosure` is a native `<details>` (keyboard and find-in-page);
    its `defaultOpen` is uncontrolled, so pass `true` when the block holds a
    value.
  - `ScopeChip` shows only where the store would surprise; a click names the
    file and who it affects.
  - Page templates: `SettingsCard`, `SettingsManagerPage`,
    `SettingsDashboardPage`.
- Legacy deep links that still resolve: `#github-connection`,
  `#linear-connection`, `#voice-input`, `#chat-launch-clipboard`,
  `#agent-completion-sound`, `#auto-updates`, `#pr-chat-transcripts`.
- `settings/AutoUpdatesSection.tsx`: automatic install on General's ADE card,
  off by default; turning it on shows **Wait until active work finishes**
  (on by default), which delays the restart countdown until no turn or work
  session is active.
- Product analytics has no Settings section: on by default, off under
  `DO_NOT_TRACK=1` or a stored opt-out ([logging](../../logging.md)).
- `settings/DiagnosticsSharingSection.tsx`: **Send a report to ADE**
  (`general.diagnostics-sharing`, `#diagnostics-sharing`, `web: "hidden"`), the
  only report control that needs nothing visibly broken. No toggle; automatic
  reports are on unless `DO_NOT_TRACK=1` or a stored opt-out. Its own cap: 5
  per install per 24 h, apart from the automatic 3. See
  [Auto-send](../storage-and-recovery/README.md#auto-send).
- `settings/integrations/`: the Integrations tab (under **App**); `?tab=mcp`,
  `github`, `linear` and `jira` alias to it.
  - **Home** (`IntegrationsHome.tsx`): **Connected** (GitHub, Linear, Jira when
    working, read with the Settings machine's pin, and every account MCP
    server), then **Add** with search: the three integrations as banner tiles
    with where each is saved (account for GitHub, project for Linear and Jira),
    then **MCP servers** (**Add any MCP server**, **Import** when other tools
    have servers, the catalogue's quick setups via `McpCatalogueAddDialog.tsx`,
    which signs in a browser-auth server, and **Not listed?**).
    `mcpCatalogueBrand.tsx` gives logos and accents; `McpRunsLine.tsx` shows
    the command or URL. The quick setups show 12 popular tiles, then **Show
    all**, with filter chips (Popular, All, each category with its count;
    `useCatalogueFilter.ts`). Typing in the Add search shows every match.
    Folded tiles stay mounted and carry `data-folded`, so Settings search,
    which filters what is on the page, still finds them: `SettingsPage.tsx`
    sets `data-settings-searching` on its content while a search runs.
  - **A stuck computer** (`MachineIntegrationWarning.tsx`): one line above
    Connected when a computer that should answer ADE MCP is stuck (signed out,
    no relay, account sync failing, waiting for its key past 10 minutes, too
    old an ADE). It reads ADE MCP's status once when the page opens (account
    level, no pin) and picks computers with `machinesNeedingAttention`
    (`adeMcpState.ts`); offline, left out, getting ready and never-reported
    computers are not counted. Dismissing it lasts until a different computer
    or trouble shows up; it hides during a Settings search.
  - `?integration=<github|linear|jira|mcp>` or a settings `#hash` opens one
    page; the hash wins (`openIntegrationFromUrl`, `settingsTabContent.tsx`).
    Only one page mounts, so search lists matches elsewhere as "On other
    pages".
  - The machine picker says whose GitHub, Linear and Jira connections you are
    viewing. MCP server definitions belong to your account. The MCP page
    searches the registry and the discovered servers and shows ten rows at a
    time in each list. **Try again** shows progress while ADE checks account sync.
  - **Links on GitHub** (Linear page) turns typed Linear keys into links on
    github.com through repository autolinks, one per team key. Only a
    repository admin can read or add them, so when an admin opens the page ADE
    adds the missing ones itself, once per repository and key (remembered on
    this computer, so a link the admin deletes is not added again from here).
    **Add** shows only when that failed or a link was removed later. Anyone
    else gets a quiet note, not a warning: inside ADE's PR view keys link
    anyway (see [Issues](../issues/README.md)).
  - **ADE agent** (Linear page) reads `viewerIsAdmin` from the Linear connection
    status (Linear's `viewer.admin`, asked in the same identity query on every
    route: this computer, a pinned machine, the CLI, ADE Cloud and the web
    client). Linear lets only workspace admins add the agent, so a member sees
    why and **Copy a note for an admin** (the note also shows under the button)
    in place of **Add to workspace**. Unknown (null, an older brain) keeps
    **Add to workspace**.
  - Each page (`IntegrationChrome.tsx`) has a banner in the maker's colours
    (`SolidLogo`, state, a sign-in panel with main actions, a facts strip with
    the top-bar switch), then two equal cards or one.
    `integrationBrand.tsx` holds accent, art and logo.
- `settings/GitHubIntegrationSection.tsx`, `GitHubSection.tsx`: the GitHub
  page. "Your sign-in" lists every credential in try order, with the token form
  (and needed permissions) inline in the token row.
  - **How GitHub connects** is an account setting. **GitHub CLI only** uses
    an existing `gh auth login` or a shared copy of that login for GitHub
    operations. Git can use its usual SSH or HTTPS credentials. Live GitHub
    App notifications require the App, and ADE checks for PR updates
    periodically in CLI-only mode. You can remove a previously saved token
    while CLI-only mode is on. **App, token or CLI** restores the credential
    choices.
  - Classic PATs and CLI tokens show scopes; fine-grained PATs show
    repository-permission guidance; App tokens show installation access and
    never report missing `repo` / `workflow` scopes. The App panel says the App
    is read-only and states the read order and the write subset.
  - Healthy connections hide quota. When ADE compensates, Settings names the
    paused source, the replacement and the retry time. The App row's own state
    outranks the ladder (`useGithubAppUserAuth`,
    `describeGithubAppCredentialBadge`), because only it separates a paused
    renewal from a dead authorization; its retry time comes from the refresh
    ledger. An exhausted shared bucket shows the reset time and never asks to
    re-authenticate. With no fallback left, a missing, invalid or under-scoped
    credential gets instructions.
  - **An unreadable store outranks all of that**: **Can't read sign-in**, the
    shared notice with **Open connections** (Connections → Machines), and no
    `gh auth login` steps (they would overwrite a probably intact credential).
  - Relay rate limits read as a short cooldown, not GitHub's raw error; raw
    network/unknown errors stay in Settings, not the global banner.
  - **A corroborated outage turns the card neutral**: "GitHub outage" chip,
    untinted failure box with an incident link, `READS WITH` / `WRITES WITH`
    "Unknown", badges "Waiting on GitHub", no `gh auth login` steps. A missing
    token still shows its instruction.
- `github/GitHubAppInstallPanel.tsx`: the hosted ADE GitHub App card for
  webhook-relay PR updates. `window.ade.github.getAppInstallationStatus`
  resolves against the relay's `/github/repos/:owner/:repo/status` with the
  local App user token. Two blocks, both from
  `renderer/lib/githubIntegrationStatus.ts`:
  - **Account · ADE for GitHub.** Device flow: `startAppUserDeviceAuth` (a
    copyable code, waiting state, verification URL) and
    `pollAppUserDeviceAuth` (renews an expired code up to 3 times).
    `deriveGithubAccountAuthState` reads `credentialState` as `valid` /
    `blocked` / `needs_reauth` / `missing`. **Never judge the account by
    `expiresAt`**: the token lives 8 hours and renews on every use.
    `describeGithubAccountAxis` returns `cta: null` for every state ADE
    recovers from.

    | State | Shows | Action |
    |---|---|---|
    | `valid` | "Authorized", "<login> · renews automatically" (no expiry) | none |
    | `blocked`, no recorded failure | "Renewing…" (another process holds the lease) | none |
    | `blocked`, recorded failure | "Paused" / "Paused until 3:40 PM" (`githubRefreshPauseCopy`), re-authorizing unavailable | none |
    | `needs_reauth` | the problem | "Re-authorize" |
    | `missing` | not authorized | "Authorize ADE" |

  - **This repo · `owner/name`.** `deriveGithubRepoConnectionState` combines
    account and installation: `connected` / `not_installed` / `access_pending`
    / `waiting_on_account` / `no_repo` / `unknown`. `waiting_on_account`
    (from typed `appUserAuthFailure`, then the older-host shim, then any
    non-`valid` account) refuses to report an install check made without a
    working account, and offers only **Recheck**; a rate limit or GitHub 5xx is
    exempt. After authorization the panel force-refreshes with a short retry
    and treats 404s as "Checking access" (`access_pending`). A GitHub 5xx reads
    "Waiting on GitHub".
  - **Disconnect** (two clicks; the confirm says real-time PR updates stop)
    calls `clearAppUserAuth`; it is hidden where `isGithubAppUserAuthSupported`
    is false (hosts without the call, the standalone web). Refresh is offered.
    A compact `onboarding` variant shows during setup.
  - `renderer/lib/useGithubAppUserAuth.ts` is one module-level value with
    listeners (the panel and the ladder are not siblings, and the panel mounts
    alone in onboarding). `refreshGithubAppUserAuth({ force: true })` starts a
    new read even with one in flight, for reads after an action.
  - The device flow, token store, refresh lease and backoff ledger live in
    `githubAppUserAuthService` (see
    [automations](../automations/README.md#github-relay-and-app) and
    [refresh storm](../automations/README.md#how-ade-stops-a-github-app-refresh-storm)).
    The per-repo "GitHub App not connected" banner comes from the same
    derivation through `IntegrationBanners` and `AppBannerHost`
    ([ARCHITECTURE §7.6](../../ARCHITECTURE.md)).
- `renderer/lib/githubIntegrationStatus.ts`: the pure two-axis derivation
  (account token vs. repo install), `deriveGithubRealtimeBlock` (account beats
  repo; `null` for `blocked`, which nobody can act on),
  `githubStatusHasWriteCredential` (App-only read keeps PR data live but asks
  for `gh` or a PAT before a mutation), and shared copy. It never re-derives
  health from expiry.
  - `describeGithubAccountAxis` and `describeGithubAppCredentialBadge` share
    `githubPausedLabel`, so both cards read the same.
  - `isGithubAppUserAuthSupported`: the standalone web adapter declares
    `appUserAuthSupported: false`; older hosts are recognised by `configured`.
  - `deviceAuthMessageCopy` / `deviceAuthErrorCopy` replace raw transport
    errors ("GitHub OAuth request failed (429)").
  - `GITHUB_ACCOUNT_AUTH_ERROR_MATCHES` is a **compatibility shim** for hosts
    without `appUserAuthFailure`. Do not add phrasings: "not authorized" also
    appears in repository messages.
  - `describeGithubOutage(status)` is the one outage entry point (is there one,
    what to say, where the button goes); null means say nothing about
    GitHub's health.
  - `describeGithubCliBanner` resolves in this order, and the order is the
    rule:
    1. `credentialStoreUnreadable` (every later conclusion would come from an
       empty view, and it is fixable locally).
    2. `!tokenStored` (local; survives an outage).
    3. The outage (every remaining state comes from GitHub's own answers).
       `describeGithubAuthFailure` checks the outage first too.

    Each branch returns a `target` (`github-settings` | `connections`); an
    unreadable store is fixed in Connections.
- `app/IntegrationBanners.tsx`: raises a write-access banner for an App-only
  status; routes the gh-CLI/token banner by `target`; keys dismissal on the
  sub-state, so a newly unreadable store re-raises it.
- `settings/LinearIntegrationSection.tsx`, `LinearSection.tsx`: Linear OAuth or
  API key, workspace status, automatic GitHub autolinks for admins.
- `settings/PrChatTranscriptsSection.tsx`: `prTranscriptGists.enabled` under
  Project → Agents.
- `settings/ResetAdeSection.tsx`: **Reset ADE**, last on General (this machine
  only; anchor `reset-ade`, legacy `#about.reset`), mounting `ResetAdeButton`
  from `app/ResetAdeDialog.tsx`.

- `settings/settingsTabContent.tsx`: the section layer (`TAB_SECTIONS`, the
  named blocks `TAB_GROUPS`, `TabContent`, the Providers sub-view).
  `primitives/SettingsSectionRail.tsx`: the sticky rail of a page's blocks,
  shown for two or more blocks at 900 px or wider (a container query), marking
  the last block at the page end. `AdeCliSection.tsx` sits in General's ADE
  block.
- `settings/settingsSectionUi.tsx`: `SettingsSectionShell`, toggle styling and
  `SettingsToggle` (fed the persisted value; disabled when the preload lacks
  the setting).
- `settings/AppearanceSection.tsx`: theme, interface faces and terminal text,
  per computer (chat appearance is in `ChatSection.tsx` with
  `ChatAppearancePreview`).
  - **Schedule** (`AppearanceScheduleSettings.tsx`): up to eight start times,
    each saving a whole look (theme, mode, background, fonts). Rules in
    `renderer/theme/appearanceSchedule.ts`: the day is cut at each start,
    yesterday's last slot runs until the first, and a slot applies once per
    start, so a manual change holds until the next. `app/AppearanceScheduleHost.tsx`
    checks; the store applies a due slot at launch (`withDueScheduledLook`)
    and while running (`applyScheduleSlot`), writing only the look
    (`patchStoredLook`). Stored per computer in `ade.appearanceSchedule.v1`,
    never synced.
  - **Theme**: `ThemeGallery.tsx` + `ThemePreview.tsx` (search over ADE,
    Originals, Editor classics and the user's themes, naming the active
    theme's corners, depth, type and backdrop); `ThemeImportExport.tsx`
    (export, or import an ADE / VS Code theme with comments and trailing
    commas); `ThemeFilesHelp`; `ThemeCustomizer.tsx` + `themeCustomizerModel.ts`
    (tokens, code colours, shape; saves custom themes). See
    [design/theming.md](../../design/theming.md).
- `settings/DictationSection.tsx`: `voiceInputEnabled`, whether the bundled
  on-device model is installed; gates the composer mic.
- `settings/ProjectSection.tsx`: the `.ade` structure snapshot,
  shared/local/secret config paths, health warnings, structure repair and
  integrity checks.
- `settings/AdeCliSection.tsx`: `window.ade.adeCli.getStatus()` /
  `installForUser()` (`terminalInstalled`, `agentPathReady`,
  `bundledAvailable`, `installTargetPath`): the install path, Install / Repair,
  and an "Add to PATH" hint. ADE-launched agents always get the bundled CLI;
  this makes `ade` available to the user's own terminals.
- `settings/AiFeaturesSection.tsx`: **Pause all scheduled work**
  (`ai.chat.scheduledWorkPaused`: pauses Claude wakeups, cron and `/loop`
  without disarming; overdue work catches up once) and **Active scheduled
  work** (the runtime's KV-backed durable list across chats; cancels one exact
  job; provider jobs stay in their returned state until Claude confirms; a
  failed load says so instead of showing an empty list). Background helpers
  (naming, idle status lines) use one model from the session's provider: Haiku
  5.5 `low` for Claude, GPT-6 Luna `low` for Codex, Composer 2.5 for Cursor,
  else the session's model; there is no picker.
- `settings/ProvidersSection.tsx`: AI Connections, one page per provider.
  A forced status read after a setup, key or sign-in also re-reads that
  machine's chat model lists in the background, only the changed provider's
  (`refreshRuntimeCatalogsForMachine`, `refreshProvider`; an OpenCode
  inventory read re-probes OpenCode). For Qwen, Kimi, Grok and Devin the
  page-open diagnostics read (`ai.getAcpProviderDiagnostics`) is a background
  write and never wakes a sleeping cloud computer; **Run doctor** is the
  person's own action (`ai.runAcpProviderDoctor`) and does wake it. A machine
  on an older ADE that lacks that action falls back to the old doctor run
  with a console warning.
  Cursor offers browser sign-in when disconnected and Sign out when connected;
  keys live in the shared panel.
  - **OpenCode — Universal Model Access**, with a models.dev "catalog synced …
    · refresh" control (`modelsDevLastFetchedAt`, `refreshModelsDev`):
    - **Subscriptions**: one card per OpenCode provider with an `oauth` method
      (`OAuthConnectModal`), plus **Kimi for Coding** (`KimiKeyDialog`).
      The opencode.ai sign-in (OpenCode Go and Zen) is copied to ADE Cloud
      and to the person's other computers with no OpenCode sign-in, without
      its refresh token; this computer keeps renewing it. Other OpenCode
      sign-ins stay here, and an Anthropic one is never copied. See
      [OpenCode's sign-in](../ade-cloud/README.md#sign-ins-in-the-account-vault).
    - **API Provider Keys**: Anthropic, OpenAI, Google AI, Mistral, DeepSeek,
      xAI, Groq, Together AI, OpenRouter, Moonshot AI, saved with
      `alsoOpenCode: true` (`setOpencodeProviderKey`).
    - **More Providers**: a searchable chip cloud of about 160 providers (30
      until a search); a keyless chip seeds a key inline.
    - **Local Model Servers**: LM Studio and Ollama
      (`updateConfig({ localProviders })`).
    - **Advanced**: OpenAI-/Anthropic-compatible custom providers (id, name,
      baseURL, `npm`, models, key) in `ai.customProviders`, and extra slugs in
      `ai.customModelSlugs`.
    - A cold start from the disk cache shows "updating…"
      (`opencodeProvidersStale`) until the first live probe; without ADE's
      OpenCode copy the group is a card with Download/Retry.
  - **Pi**: a `CollapsibleProviderCard` (readiness, version, CLI path, Open
    `settings.json` / `auth.json` / `models.json`) around `PiProvidersPanel.tsx`.
- `settings/providers/cliTools.ts`: status and credential phrasing.
  `describeProviderCredentialLine` leads with the account when known
  ("Authenticated as dev@example.com · ChatGPT Pro", from
  `AiProviderConnectionStatus.accountEmail` / `accountPlan`), else
  `describeCredentialSource` (the file or variable); `shortCredentialSource`
  is the tile form. Account fields come from `providerAccountIdentity.ts`, the
  usage poller's reader.
- `shared/providerRemediation.ts`: the one source of each CLI provider's login
  command, name and docs URL; `installCommand` is always `null` (ADE downloads
  its own copies, see [agent tools cache](agent-tools-cache.md)). Read by the
  CLI-tools cards, `ModelPicker/providerEmptyState.tsx`,
  `apps/ade-cli/src/services/agentRegistry.ts` and the `providers.status` RPC;
  edit vendor commands only here. Droid's `loginCommand` is bare `droid` (no
  non-interactive login); Pi's is bare `pi` (it signs in with `/login`).
- `settings/PiProvidersPanel.tsx`: Pi's sign-in and catalog.
  - A running sign-in owns the surface: `PiSignInFlowCard` renders what Pi
    asks live (`onPiAuthStatus`: an auth URL opened and kept on screen, a
    device code with Copy, a text or password field, a choice group); a second
    sign-in supersedes the first. URLs and codes stay pinned; progress lines
    replace each other. Cancel is not failure; only a failure offers **Try
    again** with the method used. Leaving Settings cancels nothing.
  - Otherwise `PiProviderBrowser`: **Connected**, **All providers** with search
    (a "Popular" grid until typing), **Local Model Servers**. A tile opens
    `PiProviderDetailModal.tsx`; starting a sign-in closes it.
  - Local servers have **no sign-in** (login options dropped) and take status
    from ADE's live probe (Running / Load a model / Not detected), never from
    `models.json`; only Ollama and LM Studio are probed, others read
    "Configured in Pi".
  - With `sdkAvailable` false, the panel says to run `pi` and use `/login`.
    Rows: `piProviderRow.ts`; shared primitives:
    `providerSectionPrimitives.tsx`. ADE stores nothing typed into a Pi prompt
    ([Pi sign-in](../chat/agent-routing.md#pi-sign-in)).
- `settings/OAuthConnectModal.tsx`: the OpenCode subscription dialog, `form →
  starting → waiting → error`. It renders the `oauth` method choice and typed
  `text` / `select` prompts (with `when`), calls `opencodeOAuthStart({
  providerId, methodIndex, inputs })`, shows a device code when present, and
  settles on `onOpencodeOAuthStatus` (`connected` / `failed` / `timeout` /
  `cancelled`) without polling. Cancel, Escape, backdrop and unmount call
  `opencodeOAuthCancel`. Success refreshes status and methods and toasts the
  model count. The subscription and unmount cancel key only on the stable
  `pin` and provider id. OpenCode Go borrows the `opencode` sign-in;
  `useOpenCodeProviderDetail` (`OpenCodeProviderDetailModal.tsx`) latches the
  row and target so a catalog refresh cannot unmount or retarget the flow.
- `settings/passwords/PasswordsSection.tsx`: Passwords & Secrets
  (`?tab=secrets` opens its Secrets view). One account vault read on this
  computer, so no machine picker: a status bar (counts, Import, New, ⋯ with the
  ADE Cloud switch, "Turn off on this computer", Reset), then Logins · Secrets
  · Activity. Secrets group by project (all-projects first), each with
  **Export .env**; computer-only secrets wear "This computer". Results are
  toasts. `PasswordDialogs.tsx`: new login, new secret (project picker; "Keep
  on this computer only" under More options), `.env` import (values shown as
  lengths), change value, Reset. See [Passwords & Secrets](../passwords/README.md).
- Chats add secrets without the value entering the transcript
  ([Private secret card](../chat/composer-and-ui.md#private-secret-card)) and
  connect GitHub, Linear and Jira the same way
  ([Connect card](../chat/composer-and-ui.md#connect-card)).
- `settings/LaneTemplatesSection.tsx`, `NewLaneSettingsSection.tsx`: lane
  recipes and start defaults. Fields are named for what they do ("Files to
  copy into new lanes", "Env files to fill in", "Install command", "Setup
  script", "Use for new lanes") with a hint each. Docker services, `.ade`
  mounts and extra variables sit under **Advanced**; per-platform commands
  under "Different commands on Windows"; both open when they hold a value.
  There is no port-range control (the lane's leased range always wins); an
  existing `portRange` is kept.
- `settings/health/HealthSpace.tsx`, `HealthCleanups.tsx`,
  `settings/storage/StorageCleanupDialog.tsx`, `ReclaimConfirmDialog.tsx`,
  `storageView.ts`, `storageUiConstants.ts`: Project → Disk space. Plain
  copy on Archive (files stay), Archive & Reclaim (lane, branch and chat stay;
  managed files go) and Delete; a review table of archived lanes, orphaned
  worktrees, DerivedData and build output (size, age, owner, blocked reasons,
  estimates); previewed, confirmed destructive actions; volume pressure,
  categories, policy chips, storage doctor, a project-database card with
  prune/compact, "Health & diagnostics" (`StorageDiagnostics`, `#diagnostics`)
  and the cleanup journal (`StorageMaintenanceJournal`). `storageView.ts`
  holds the pure snapshot→target mapping (including `review_first`
  `proof_attachments`). Reads `window.ade.storage.*` and
  `window.ade.app.getRuntimeHealth`; see
  [Storage and recovery](../storage-and-recovery/README.md).
- `settings/SyncDevicesSection.tsx`: Connections > Phone and > Web under a
  **This Mac** card: the pairing PIN (set, clear, reveal, or a new six-digit
  PIN when only the hash remains), the phone QR (v3 smart pairing URL with
  LAN / Tailscale / loopback / relay candidates), the desktop bootstrap token,
  relay and discovery status, and per-device forget/revoke. Phone explains QR
  + PIN and Nearby + PIN; Web is account sign-in only. A brain-side unreadable
  session (`isBrainAccountSessionFailure`) adds **Repair**; a directory refusal
  of this computer shows its date and **Reconnect this computer** (or
  **Confirm it's you**), read only from this computer's snapshot. See
  [Sync and multi-device](../sync-and-multi-device/README.md).
- `app/TopBar.tsx`, `ConnectionsPanel.tsx`: the one Connections control with
  Machines, Phone and Web. A saved machine's **Edit** has **Slow connection
  mode** (Automatic, Always on, Off) beside **Reconnect automatically**
  ([Remote runtime](../remote-runtime/README.md#a-slow-or-dropping-link)).

**Usage** (full behaviour: [usage-tracking.md](usage-tracking.md))

- `usage/HeaderUsageControl.tsx`, `UsageLimitsBand.tsx`: the header usage
  popup for Claude and Codex (`TRACKED_PROVIDERS`) and the automation budget.
  - One chip per detected tracked provider: the 5-hour window and the plan
    window (`wk` with a weekly window, else `mo`); percents clamp to 0–100,
    green/amber/red at 75 % / 100 %, ellipsis while missing.
  - Mount reads the cached `ade.usage.getSnapshot` and records demand, never
    forcing a provider request; Refresh calls `ade.usage.refresh`; polling
    tightens to 60 s under demand and backs off idle. Detection is
    `ade.ai.getStatus` on mount and every 5 min; undetected CLIs hide,
    signed-out installed ones show "Not signed in".
  - Header and panel order snapshots with the shared guard and clear and
    reload quota and connection state on a binding change.
  - `UsageLimitsBand` draws one row per account (`UsageAccountRow.tsx`): mark,
    provider, `email · plan`, windows as meters (5-hour, weekly, monthly,
    then others), inline errors, staleness, source and time. The link is
    `status.accountUrl`, else `usageProviderAccountUrl`.
  - On the web, `usage.liveReadings()` (web only) is false when no computer
    answers `usage.getQuotaSnapshot`. With no snapshot, the band then says:
    "Claude, Codex and the other providers report their limits through one
    of your computers. They show here while one is on." The header's ADE
    Cloud ring (`useCloudAccount`, `/cloud/account`: hours, disk, computers)
    shows without a computer.
  - Claude background polls never prompt the Keychain; an explicit refresh may
    fall back from OAuth to a bounded CLI probe. A non-interactive caller that
    cannot read Claude credentials keeps the previous unexpired windows, state
    and extra usage instead of a false auth error. Codex uses HTTP windows when
    complete and a bounded app-server RPC only for auth recovery or an unknown
    schema.
  - Budget caps: `ade.usage.getBudgetConfig` / `saveBudgetConfig`. Crossing 25
    / 50 / 75 / 100 % emits `UsageThresholdEvent`.
- `usage/usageSnapshotOrdering.ts`: orders by `revision.seq` within one
  `producerId` and always accepts another producer; unstamped disk snapshots
  use `lastPolledAt`. Reset on a binding change.
- `usage/useUsageSnapshot.ts`: the one subscription (`getSnapshot` /
  `onUpdate` / `onProjectBindingChanged`, the binding-generation guard,
  `shouldApplyUsageSnapshot`), owned by the popover and passed down. Preload
  publishes its own rebinds.
- `settings/AdeUsageSection.tsx`: Settings › Usage, one page in reading order:
  totals (Estimated cost, Tokens, Sessions, Active days, each with a 14-day
  sparkline and change, plus Cached input / Output / Lines changed / Pull
  requests), **Rate limits** gauges (This machine and This project), the daily
  chart, **Week over week**, **By provider**, **Where the cost went**, the
  Breakdown (per provider and model with estimation notes; GitHub and ADE-local
  activity as separate columns, never max-merged), **Machines**,
  `ActivityModule`, and on the account scope a pooled **Live limits**
  (`UsagePooledLimits`). Toolbar: **scope** (All machines / This machine / This
  project, `ade.stats.scope.v1`), **range** (Today / 7d / 30d / year / all,
  `ade.stats.range.v1`), Refresh. A meta line gives freshness, caveats and the
  computed scope. Reads `window.ade.usage.getAdeStats({ preset, scope })`;
  Refresh calls `refreshHistory()`; the first render is stale-while-revalidate.
- `usage/UsageLimitGauges.tsx`: one radial gauge per provider window, pooled
  across accounts, in **% left**, with a steady-burn tick, on track / watch /
  low, and a cycle bar ("Day 3 of 7"). `usageLeftLevel` /
  `usageLeftLevelColor` (`usageDesign.ts`): amber at 20 % left, red at 5 %,
  for every meter, gauge and home ring.
- `usage/UsageSparks.tsx` (14-day sparkline, day strip, `periodDelta` /
  `DeltaTag`, from the chart's series), `UsageWeekCompare.tsx` (each of the
  last seven days beside the same weekday a week earlier; below a 30-day range
  it says so), `usageProviderNames.ts` (`humanizeProvider`).
- `usage/UsageDailyChart.tsx`: one series per provider from
  `AdeUsageDailyPoint.byProvider` (cost or tokens); top-N get series, the rest
  is **Other**; no split falls back to one series. `usageDailyChartModel.ts` is
  its React-free half (bucketing, selection, scale, paths), re-exported by the
  component; it stays React-free because `usageTrackingService.test.ts`
  checks main's daily split against it.
- `usage/usageDesign.ts`: the visual vocabulary (five type steps, rhythm,
  pressure colours, top-N/Other), all on theme variables.
  `usageWindowFormat.ts`: labels, countdowns (`formatCountdown` "6d 7h",
  `formatResetClock`), percents, pace.
- `usage/usageLimitModel.ts`, `UsageAccountRow.tsx`: the headroom model, pure
  and clock-injected. `poolAccounts` merges one login seen by two machines
  (`machines`, freshest first); `buildLimitCards` makes one card per window
  label with a segment per account, pooled headroom and what each reset
  restores; `buildAccountRows` transposes them. No `accountId` falls back to
  the provider's single account, then `status.accountEmail`, then "This
  machine". Meters fill to headroom in brand colour, the spent part hatched,
  pressure colour from consumption. Hover, focus or click opens the window
  detail (plan, machines, headroom, reset, pace, model split, restore, limits
  link), edge-anchored in the 420 px popover. **Use reset**
  (`ade.usage.consumeResetCredit`) goes to the machine that produced the row,
  also for credits only another machine can read. A login signed in elsewhere
  reads **Not signed in here**.
- `main/services/usage/accountBalance.ts`: the pure smart-balance selector for
  new Claude/Codex chats: the signed-in account with the most weekly room
  relative to its reset, after the committed burn (measured, pending,
  reserved) on each login's freshest reading, gated on projected five-hour
  room; it skips gone logins and says why when nothing was a real choice.
- `usage/windowAutoStart.ts`: one best-effort small request per enabled
  account just after a five-hour reset or an early window end (including a
  credit spent in ADE), via a per-provider opener table with no persisted
  timers. `AUTOSTART_WINDOW_TYPE` (`shared/types/providerInstances.ts`) gates
  providers and the toggle.
- `shared/usageResetCredit.ts`: the reset-credit outcome and copy for desktop,
  CLI and paired callers.
- `usage/providerAccountIdentity.ts`: which account the numbers belong to:
  Codex `auth.json` `id_token` (`email`, `chatgpt_plan_type`), Claude
  `.claude.json` `oauthAccount.emailAddress` (`subscriptionType` /
  `rateLimitTier`), from the home dir or the provider's env override, never the
  Keychain; cached 5 minutes; `undefined` rather than a guess; no token reaches
  a snapshot, log or disk. Used by the poller and
  `providerConnectionStatus.ts`.
- `usage/UsagePaceBar.tsx`, `UsageSegmented.tsx`: shared pace bar and segmented
  control.
- `usage/sharedUsageTracking.ts`: one tracker per ADE home; project scopes
  attach (`attachSharedUsageTrackingScope`) and the last detach disposes it.
  `bootedUsageScope.ts`: unbound usage IPC and the event relay borrow a booted
  brain scope.
- `usage/usageTrackingService.ts`: the live quota snapshot and
  `getAdeUsageStats(args)`.
  - `args.scope`: `account` (all machines, merged rollups), `machine` (this
    machine's provider ledgers), `project` (sessions matched by cwd). GitHub
    and ADE-DB metrics are always repo-scoped. `account` merges history only,
    never live windows (rate limits belong to the provider account).
  - Token totals dedupe across ledgers; days are machine-local (`localDay.ts`).
  - Live polling is adaptive and coalesced, keeps unexpired last-good windows
    with freshness, and is separate from the ledger and GitHub scans. Each
    snapshot has a `revision`. The machine brain is the one quota owner;
    production desktop creates no second tracker.
  - Stats return cached provider/GitHub results and live DB aggregates at once
    (`fresh` / `refreshing`) and revalidate in the background
    (`refreshStatsInBackground`, single-flight per range and source).
- `usage/accountUsageRollup.ts`: one machine's costs as day × provider × model
  rows, merged into `account` stats with the `machines` list (`live` /
  `rollup` / `stale` / `deduped` / `failed`). Aggregates only; no transcript,
  session id or path crosses machines. GitHub is excluded (repo-scoped; three
  clones would triple a PR count), and `sourceNotes` says so.
- `usage/accountUsageRollupStore.ts`: CRR tables `usage_machine_rollups` /
  `usage_machine_rollup_meta`, `ROLLUP_RETAINED_DAYS` 400, primary key
  `(machine_key, day, provider, model)` (a CRR table allows no other UNIQUE
  index). No-op upserts are skipped. It never throws; an unreadable cache
  shows one machine's numbers.
- `usage/accountUsageSource.ts`: dedupe of machines reading the same
  transcripts (synced home, network share). A `.ade-usage-source` marker id in
  the transcript home travels with the files. `isSameTranscriptSource`: both
  markers → compare ids; else folded root digests (sha256 of `pathKey` paths)
  must match. Machines cloned from one image share a marker and show as
  `deduped`; deleting the marker mints a new id.
- `usage/accountUsageLiveRefresh.ts`: asks reachable machines for a fresh
  rollup (`usage.getUsageRollup`) over the paired pool, at most
  `MAX_LIVE_MACHINES` (12); an unreachable machine is a `failure` entry, never a
  rejection. A peer without the method is "too old to share usage"
  (authorization denials, also `methodNotFound`, are excluded). It also builds
  the quota fan-out (`usage.getLiveQuota`, `createAccountLiveQuotaFetcher`);
  the brain installs both in `cli.ts`.
- `usage/peerLiveQuota.ts`: other machines' live quota in memory, pulled at
  most once a minute while limits show. `views()` returns `poolPeerQuota`
  (`shared/usageLiveQuota.ts`): each login's freshest reading; a login signed
  in only elsewhere is `notSignedInHere` (shown, never picked by smart balance
  or budget caps).
- `usage/usagePricing.ts`: token rates from models.dev only (vendor row for a
  bare id, provider row for `provider/model`; 10 s timeout, cached in
  `~/.ade/models-dev-pricing.json`, refreshed daily, dropped after 30 days); an
  unlisted model uses its registry price. `tokenPriceSource(model)` is `list`
  or `fallback`. See
  [where a token price comes from](./usage-tracking.md#where-a-token-price-comes-from).
- `usage/githubActivityStats.ts`: commits, PRs and code movement via `gh` (60
  s timeout), failing soft with a reason sentence (no `gh`, auth or remote is
  normal); consumed through `scanGithubActivityStats`.
- `usage/usageLedgerWorkerClient.ts`: the isolated ledger scan streams NDJSON
  (a roster, then one line per provider), so a timeout keeps finished
  providers. `incompleteProviders` become `publishLocalRollup`'s
  `skipReconcileProviders` and carry the previous snapshots forward, so a
  partial round never deletes or lowers totals. `LEDGER_WORKER_TIMEOUT_MS`
  sets every outer budget: `USAGE_REFRESH_HISTORY_REMOTE_TRANSPORT_TIMEOUT_MS`
  and `USAGE_REFRESH_HISTORY_TIMEOUT_MS` derive from it and grow outward.
- `main/services/account/localMachineIdentity.ts`: the one "which machine is
  this?" key for the directory and rollups, free of Electron so the publisher
  and the CLI brain agree (another key would mint a phantom machine).

- `usage/providerQuotaParsers.ts`: normalizes the live quota of Claude, Codex,
  Cursor, Copilot, Grok, OpenCode Go and Kimi, and Factory session credits.
  Codex windows are classed by their advertised duration; primary/secondary
  position is only the fallback for payloads without it.
- `usage/ledgers/localUsageLedgers.ts`: read-only history adapters. Codex reads
  recent JSONL within per-file and total byte budgets, drops oversized records
  with a bounded reader, caps detail, shares one scan, and reconciles with the
  newest `state_*.sqlite` thread index under row and lookup budgets; a
  zero-cost all-time-only remainder keeps the exact token headline without
  inventing day, project or cost attribution. `ledgerScanCore.ts`: shared
  plumbing (`TokenEntry`, completeness, discovery, streamed JSONL, read-only
  SQLite). `acpProviderLedgers.ts`: Pi, Qwen, Grok and Copilot CLI ledgers.
  `usageLedgerScanners.ts`: the one scanner list for the worker and in-process
  scan. `providerLedgerFormats.ts`, `tokenSplit.ts`: record constants and
  token-split rules shared with the live chat path.
- Per-turn ledger: `usage/turnUsageLedger.ts` (one JSON line per finished turn
  under `<adeHome>/usage/`, read by `usage.getTurnUsageSummary`);
  `turnUsageReconcilers.ts` (amends rows from Cursor dashboard events and
  Factory credits); `cursorBilledUsageStore.ts` (Cursor `getUsage` billed rows
  per API-key run; the worker does not read them); `cursorDashboardUsage.ts`
  (reads dashboard events; writes no Usage rows); `usageAccountId.ts` (the one
  account-id rule for poller and ledger); `quotaBurnRate.ts` (what one percent
  of a window costs).
- `main/services/router/`: the model router in shadow mode. `routeCatalog`
  rates every route (harness × model × effort) from the daily registry;
  `routerCore` picks the cheapest route that keeps quality;
  `modelRegistryStore` caches `<adeHome>/router/registry.json`;
  `modelRouterService` logs to `<adeHome>/usage/router-shadow-*.jsonl` and
  changes no turn; `routerEfficiency` backs `ade router efficiency`;
  `modelCatalog` backs `ade models catalog`; `modelSheet` backs `ade models
  sheet`. Contract: `shared/routerRegistry.ts`.
- `usage/usageStatsStore.ts`: project DB aggregates and the `usage_events`
  ledger: only successful, meaningful user mutations, attributed `desktop`,
  `tui`, `mobile`, `web` or `api`. Local-only (not CRR), because each action is
  recorded once on the runtime that runs it.
- `usage/localDay.ts`: `localDayKey`, `localDayStart`, `localDayOffset`,
  `localDayOrdinal` (the user's timezone, not UTC).
- `shared/types/usage.ts`: range, scope, daily point, freshness, estimation,
  GitHub-vs-local, aggregate and client-attribution contracts; presets today,
  7d, 30d, year, all; `AdeUsageEstimationKind` `exact` / `chars` /
  `distribution` / `mixed`.
- `usage/ActivityModule.tsx`: the activity/tokens/code/clients module (`full`
  and `compact`), saving tab and range in `ade.activity.module.v1` (migrating
  `ade.stats.carousel.v1`). `WorkActivityModule` fetches `usage.getAdeStats`
  and sits under the empty Work composer on desktop and web as an opaque plate
  (`--work-popover-bg` over `--color-bg`).
- `usage/providerColors.ts`: `providerColor(provider, theme)`, **the source of
  truth for provider colour** (hashed fallback for unknown providers);
  `shared/modelCatalog.ts` `PROVIDER_GROUP_COLORS` and iOS `ADESharedTheme` /
  `ADEDesignSystem` mirror its dark values. Accounts have no colour; the email
  tells them apart.

**Auto-update** (mechanics and numbers:
[desktop-auto-update.md](./desktop-auto-update.md))

- `main/services/updates/appBundleOwnership.ts`,
  `registerAppBundleOwnershipIpc.ts`, `shared/types/appBundleOwnership.ts`,
  `app/AppBundleOwnershipBanner.tsx`: a root-owned `/Applications/ADE.app` on
  macOS and the "ADE will ask for your password on every update" banner (Fix
  it runs an admin `chown -R` via `osascript`; local only).
- `apps/ade-cli/src/commands/windowsDesktopRescue.ts`: Windows `brain update
  --apply-staged` also installs the desktop app when one is installed.
- `updates/autoUpdateService.ts`: the electron-updater wrapper and
  `AutoUpdateSnapshot` (`idle` / `checking` / `downloading` / `ready` /
  `installing` / `error`, version, progress, `recentlyInstalled`, `parked`,
  `lastInstallFailed`, `autoApplyPending`, `autoApplySuppressedUntil`,
  `currentVersion`, `latestKnownVersion`).
  - A same-or-older `update-available` never replaces a staged newer build; a
    strictly newer one wipes the cache and downloads. Packaged builds check at
    start and periodically; dev launches do not. A staged update never stops a
    check. `userInitiated` only labels `autoUpdate.check_requested`.
  - `quitAndInstall()` needs `ready`, re-checks the feed, then sets
    `installing`, saves `pendingInstallUpdate` and calls
    `updater.quitAndInstall(false, true)`. An abort before the native handoff
    sets `parked` with an `AutoUpdateInstallAbortReason` (`refresh_failed`,
    `install_preflight_failed`, `prepare_failed`, `prepare_timeout`,
    `handoff_failed`); after the handoff a staged quit deadline force-quits
    (`autoUpdate.quit_escalated`, `logger.flushSync()`).
  - Install is manual by default. `AutoUpdatePreferences` turns on automatic
    install and whether it waits for `RuntimeActivitySummary.idle`; both start
    the `autoApplyPending` countdown; a cancel sets
    `autoApplySuppressedUntil`; `ADE_DISABLE_AUTO_UPDATE_APPLY=1` is the kill
    switch.
  - Next launch, `reconcilePersistedUpdateState` treats a running version `>=`
    the target as installed (filling `recentlyInstalledUpdate`, cleaning the
    cache). A launch on the old version records `failedInstallAttempts`, logs
    `autoUpdate.install_did_not_land` and `ade_update_install_did_not_land`,
    and sets `lastInstallFailed`; the first failure keeps the download, a
    second on the same version clears it.
  - Windows: `app-update.yml` comes from the build's publish authority and
    must match `ADE_RELEASE_REPOSITORY` (default `arul28/ADE`; forks
    override); NSIS uses the 60-second quit deadline.
- `updates/updateTransaction.ts`: `runUpdateTransaction`, the injected `swap`
  → `service` → `restart` → `health` sequence run once after a relaunch with
  `recentlyInstalled` (a new bundle does not restart the background service).
  Pure. The first failure stops it; later steps are `skipped`; a throw becomes
  `failed`. `UpdateTransactionResult` rides `AutoUpdateSnapshot` as
  `updateTransaction`; `AutoUpdateBanner` shows its `failureMessage` beside
  **Repair**. `main.ts` shares one `ProjectRecoveryService` with
  `registerIpc`, so repair and this restart exclude each other.
- `updates/runtimeRestartVerification.ts`: `verifyRuntimeIdentity` (`matches`
  or `unreachable` / `incompatible` / `version` / `build` / `stale_runtime`),
  `checkRuntimeIdentity` (shared by restart and health), and
  `runVerifiedRuntimeRestart` (up to `maxRestarts` 2, then a **failed** step
  when it cannot prove the new brain answers; an `ok` alone could be the old
  brain). Events: `autoUpdate.restart_not_needed` / `_required` /
  `_attempt_failed` / `_verified` / `_verification_failed`.
- `main/services/processes/processStartTime.ts`: `readProcessStartTimeMs(pid)`
  (one bounded `/bin/ps -o lstart=` with `LC_ALL=C`; `null` on Windows) makes a
  pid an identity; used to spot a stale brain and by the external watchdog
  before a kill.
- `shared/updateVersions.ts`: the one version comparator (numeric core, then
  prerelease; a release beats its prereleases; unparseable segments are `0`).
  `updates/autoUpdateVersions.ts` re-exports `compareUpdateVersions` for main
  and builds `buildReleaseNotesUrl` and `buildGithubReleaseUrl` (also used by
  `ade doctor`).
- `app/AutoUpdateControl.tsx`: the top-bar badge ("Checking for updates",
  "Downloading vX.Y.Z (NN%)", "Install update vX.Y.Z", "ADE will quit and
  reopen"; "Retry install vX.Y.Z" when `lastInstallFailed` names the staged
  version, with whether the download is still here).
  - The install prompt (`autoUpdateInstallAction.tsx`, shared with the ready
    prompt) says what the restart stops: "2 agent chats running, 1 terminal
    open" with chat names, "Nothing is running", or "Couldn't check what's
    running" after 3 s. It reads the brain's `runtime.updateImpact`
    (`main/services/runtime/updateImpactProbe.ts`: every open project and
    personal chats). An older brain is asked per project plus
    `runtime.activitySummary`; if that shows more running than the chats found,
    the prompt says so. The quit prompt uses the same probe. Each probe logs
    `autoUpdate.impact_probe` or `_unknown` to `ade-update.jsonl`.
  - "Resume this computer's chats" is offered when a listed chat can be queued
    (not personal chats). Connected machines on an older ADE are listed and
    update first when left ticked (`machine.updateAndRestart`).
  - The prompt sets `installRequested` and calls
    `window.ade.updateQuitAndInstall()`; `false` clears the flag. While
    installing the badge pulses fuchsia and is disabled.
  - After an update, an "Updated to vX.Y.Z" card (X and click-outside close)
    shows the bundled `changelog/vX.Y.Z.mdx` summary and bullets, with
    **Changelog** (`releaseNotesUrl`) and **View on GitHub**
    (`githubReleaseUrl`), each only when present; either dismisses.
  - The update quit marks one relaunch to reopen the open local project tabs on
    their remembered route and chat; the mark is consumed, and closing a
    window drops its tabs.
- `app/useAutoUpdateSnapshot.ts`: the one subscription (`updateGetState()` +
  `onUpdateEvent`) for the top-bar pill, the banner and About.
- `app/AutoUpdateBanner.tsx`: the ready prompt (**Restart and install**;
  dismissal hides that version for the session), the recovery banner (`parked`
  → "ADE update didn't finish — Restart to retry"; failed handoff → "ADE update
  did not install — Restart to retry"; **Restart now**; dismissal keyed on a
  failure signature) and the countdown toast ("ADE will update in Ns",
  **Cancel** → `updateCancelAutoApply()`).
- `app/BrainRecoveryNotice.tsx`: one notice per brain event-loop recovery,
  from `localRuntime.lastWedge` (`app.getInfo()`) via `formatRecoveryMessage`.
  A wedge with a command reads "ADE recovered from a background issue … a stuck
  task (…) was restarted"; `lastCommand` `external-watchdog` reads "ADE
  restarted its background service at … after it stopped responding." The
  wedge `ts` is stored in `localStorage` so one event shows once. See
  [ARCHITECTURE.md §2.1](../../ARCHITECTURE.md) and
  [Storage and recovery](../storage-and-recovery/README.md).

## Detail docs

- [configuration-schema.md](./configuration-schema.md): `.ade/local.yaml` and
  the one-time legacy carry-over (`shared/types/config.ts`).
- [first-run.md](./first-run.md): first launch lands on Work; integrations
  live in Settings.
- [harness-presets.md](./harness-presets.md): saved harness + model-provider
  pairings (Settings › Providers › Custom, the Custom tab of every picker).
- [mcp-servers.md](./mcp-servers.md): account MCP servers given to every
  agent, off per computer or project, secrets in the vault, imports from
  provider CLI configs.

## Onboarding responsibilities

Onboarding has a machine layer and a project layer, plus the first-run
screens and the three help tiers below.

### First run on a computer

It runs once per computer and is stored in global app state
(`welcomeVideo.completedAt` / `dismissedAt`), so a computer set up before it
existed never sees it. It runs on, and reads, the computer ADE opens on.

ADE Web shows only the welcome card, and only to an account created on or after
2026-11-18 that has not started onboarding anywhere (`webWelcomeDue` in
`FirstRunSteps.tsx` reads the account's `onboarding.progress` first; if it
cannot, no card). **Get started** marks onboarding started; **Skip the tour**
skips it on every device; Escape only closes the card. It waits while the
shared-lane page (`/shared`) is open.

1. **Welcome.** One card on the gate's glass: headline, one sentence, provider
   marks, **Get started** and **Skip setup**. Skipping setup still leaves the
   tour for the first project.
2. **Sign in**, if this computer has no ADE session.
3. **Connect your agents** (`FirstRunAgents.tsx`, `FirstRunAgentRail.tsx`).
   Each agent's 3D logo (`providerBrand`) hangs from a rail, sign-in-capable
   agents first. Moving along the rail swings the logos and turns the nearest
   one; the banner below shows its Settings banner, name, standing ("Signed in
   as … · plan", "Not signed in on this computer", or "Set this one up later,
   in Settings › Agents & Models") and **Sign in**. A logo spins once on
   connect. Status is `ai.getStatus` (works before a project opens). Sign-in
   uses Settings' flows on this computer: the account sheet (Claude Code,
   Codex), browser login (Cursor), Google sign-in (Antigravity), and
   `CliSignInSheet.tsx` (Grok, Devin, Muse, Copilot, Droid, Kimi).
   - A sheet stays mounted when status turns connected, so a refresh never
     cancels it.
   - The swing runs on animation frames only until it settles (none under
     reduced motion).
   - Status is re-read on open, after a sign-in (a re-read requested during
     one runs after it), on focus, and when the tools cache finishes
     OpenCode (downloaded at launch on a computer with no agent signs,
     so its tile turns connected with no extra copy); never polled.
   - Project discovery starts in the background meanwhile.
4. **Bring your projects in.** `discoverOnboardingProjects` reads Claude Code
   transcripts (one listing plus the newest transcript head per folder),
   Codex's thread index (one grouped query) and the other importers'
   discoverers (newest 300 sessions each, 2.5 s per provider). Folders map to
   their git project (a lane or worktree counts toward its checkout); scratch,
   temp, Downloads and existing projects drop; newest first. A failed
   discovery offers a retry, not an empty list.
   - A project with two or more chats in 30 days starts ticked. Rows show
     worktrees (they open as lanes) and last activity.
   - Recent chats add an **Import N chats** pill (off by default). Its box
     (and marks) turns all on or off; its count opens `FirstRunChatPicker`
     (read once via `app.listOnboardingProjectChats`): provider, title or
     opening prompt, lane folder, last active, prompt count, a box each,
     Select all / none, "5 of 7 chats". Unticking narrows the import
     (**Importing 5 of 7 chats**, a dash in the box); unticking the last turns
     it off; ticking one while off turns it on with that chat; the box always
     means all or nothing. Claude and Codex are read for the project's folders
     (Claude stops at the window edge by file time); others filter discovery's
     read under the same 2.5 s budget. Escape closes only the picker.
   - Below: an iPhone QR and a line about other computers.
5. **Into ADE.** Chosen projects join recents and open as tabs; the first opens;
   worktrees become lanes through normal adoption. For each project with its
   pill on, `useOnboardingChatImport` imports up to 25 chats from the last 30
   days (newest first, any provider) into the lane each ran in (or the main
   checkout's) on first open, skipping sessions that may still be open in
   their CLI. Left-out chats are stored as `provider:sessionId`
   (`excludedKeys`); it is an exclusion list, so chats started after setup
   still come in.
6. **The tour** (`components/onboarding/tour/`). It starts only inside a
   project the person opened (never on Home or the welcome screen; the screens
   before a project explain themselves). A violet ADE cursor glides to a real
   control, a ring settles and a card explains it, six cards ("N of 6"): the
   prompt box, its permission/model/effort controls, where it runs (the Run on
   menu: this computer, another computer or ADE Cloud, with the lane picker
   beside it: main checkout or a new lane), the chats list, the first chat,
   and the Tools pane. A person who already has chats gets **Open a chat**
   instead of the first chat (both are card 5); the Tools step is skipped
   when the pane is open.
   - With no chats, the step is **Send your first chat**: a new chat in the
     main checkout with "In one sentence, what is this project?" on a cheap
     runnable model (Haiku, Luna or Composer when connected, else the cheapest
     the registry knows). The user sends it. That model is not saved as
     last-used; a model the user picks there is.
   - The finish card points at ADE Tips for the rest.
   - Some steps ask for the click; every card has Next and Back; nothing is
     dimmed. Leaving shows a **Tour paused** pill with **Show me**; the step
     returns when its control is on screen, across reloads. A step with
     nothing to point at is skipped.
   - **Skip tour** ends it and every hint; "Show me around again" (help menu,
     palette) restarts it. Contextual hints (`hints/`, "This chat needs you")
     wait for the tour to finish.

Run `npm run dev:desktop -- --first-run` to walk it as a new user (see
[local development](../../development/local-development.md#walk-first-run-setup-as-a-new-user)).

### What's new pages

Free-form announcements (`renderer/components/announcements/`): any React
component in `pages/` with one entry in `announcementPages.ts` (`{ id,
added, title, ...lazyPage(() => import(...)) }`, which gives the lazy `Page`
and a `load` that fetches its code ahead; both share one fetch).
`AnnouncementsHost` adds only a close button and a pager.

- **Once per page per account**, keyed by `id`: a local copy
  (`ade.announcements.seen.v1`) and the account setting `announcements.seen`
  hold the union across devices and ADE Web (`announcementSeenSync.ts`; merge
  in `shared/announcementsSeen.ts`: never unseen, earliest time wins, at most
  500). ADE Web uses `announcements.getSeen` / `markSeen` through the computer
  (not for lane-share guests). Pages seen before another account signed in
  stay local. Use a new `id` to reshow; remove the entry to retire.
- **Never an empty window.** A page's entrance is timed from when it mounts,
  and after an update it also waits for the logo to land, so a window that
  opened before its page loaded sat empty. A showing that opens by itself
  waits for its first page's `load`, and decides and opens in one step: inside
  a project the page loads while the project settles, and a check that finds
  it still loading waits for the next check; after an update it loads while
  the splash plays, the quiet moment is judged after it is in, and a showing
  that waited for a quiet moment picks its pages again then
  (`firstPageLoader`). The next
  page loads while one is read. Help › What's new opens at once.
- **When:** inside a project (never Home), a few seconds after it opens, with
  no dialog, setup or tour, only once onboarding finished or was skipped
  before this launch; after 8 s with no key or click, and never while a
  focused text field holds text or a terminal has focus. On screen counts as
  seen. A page older than the account (`accountCreatedAtFromUserId`) or than
  21 days never shows by itself. At most two pages a showing, a week apart,
  and only when the unasked budget allows (below).
- **After an update** this computer installed: on the new version's first
  launch, after the splash, up to two unseen pages then the release notes
  since the old version. The logo flies from the splash's last box into the
  header as the window opens (`WhatsNewArrival.tsx`; `BootSplashReveal.tsx`
  records the box); the window mounts one frame after the logo. Reduced motion
  skips the flight; recent input waits for the quiet moment and rises
  centred. A self-opened showing focuses its panel, not a button.
- **Reopen:** Help › What's new and the palette show every page.
- **To add one:** create `pages/<Name>.tsx` with a default component taking
  `{ close }` (call it before navigating), and add its entry (through
  `lazyPage`) at the top of `ANNOUNCEMENT_PAGES`. Most pages are a `WhatsNewFeature`: a place, a
  headline, one sentence on where to try it, an `action` running an ADE Tips
  entry, beside a looping muted recording, a screenshot crossfade (`holdMs`,
  optional `caption`) or phones.

### The agree line and the privacy policy notice

Every sign-in path shows "By continuing, you agree to ADE's Terms and
Privacy Policy" with links: the shared sign-in card (`onboarding/GlassSignInCard.tsx`,
which covers the desktop gate, ADE Web and the `/sign-in` page that a desktop
or `ade login` sign-in opens), the device-code pages on the account directory
(`LEGAL_AGREEMENT_HTML` in `apps/account-directory/src/brandPage.ts`), the
`ade login` text (`SIGN_IN_LEGAL_LINE`), and the iPhone's
`AccountSignInView`. Clerk's own hosted page, the fallback when Clerk's API
cannot be reached from the card, shows Clerk's legal-consent setting instead.
The card, the device-code pages and `ade login` take the links from
`shared/legalLinks.ts`; the iPhone keeps them as literals, because SwiftUI
parses Markdown links only in a string literal.

When the policy changes, existing users see "We updated our Privacy Policy"
once: a floating app banner on desktop and ADE Web
(`app/PrivacyPolicyUpdateNotice.tsx`) and a top banner on the iPhone
(`PrivacyPolicyNoticeBanner` in `apps/ios/ADE/App/ContentView.swift`). Read,
Got it/OK and × all count as seen. The seen version is per device
(`ade.privacyPolicyNotice.seenVersion` in localStorage or UserDefaults): it is
a notice, not a consent, so it does not use an account setting. A sign-in
through a card that showed the agree line marks the version seen, so a new
account does not get the notice. It sends no analytics event.

It is not a What's new page and does not spend the unasked budget: those can
hold a page back for days or skip it, and a policy notice must show.

To reshow it, change the policy's `LAST_UPDATED` and its changelog
(`apps/web/src/app/pages/PrivacyPage.tsx`), `PRIVACY_POLICY_VERSION`
(`shared/legalLinks.ts`) and `PrivacyPolicyNotice.version` (iOS) together.

### Boot splash and the ADE logo

"Starting ADE" plays a WebGL2 liquid glass reveal
(`components/ui/LiquidGlassLogoReveal.tsx`, parts in `components/ui/liquidGlass/`)
for the boot or the reveal (about 3.5 s), whichever ends later, once per window
(`app/BootSplashReveal.tsx`). Reduced motion, no WebGL or a failed logo load
show the still logo. The hosted web never plays it. The logo everywhere is
`<AdeWordmark>` (`logo.png` dark, `logo-light.png` light).

### ADE Tips

The second tier: every feature worth knowing, from Help › ADE Tips, the
palette, the Home widget or the tour's last card (`renderer/onboarding/adeTips.ts`;
`components/onboarding/tips/`). One group at a time as a tile wall: the group
tile, screenshot tiles (`size`, `shot`, packed without holes in four and two
columns) and icon tiles; postponed suggestions first under **For you**. The
startup-context tip points at the provider's initial context inventory.

- **Try it** goes where the feature lives (a project page, a Settings card, a
  new chat, Home in a new tab, Connections, Music); the spotlight
  (`components/onboarding/spotlight/`) rings the control with one line. It
  waits a few seconds for the control, fades after six seconds or a click or
  Escape. A chat tip rings the open chat's control, else a chat row ("Open a
  chat and…"); with no project, "Open a project first" on Home. It is
  navigation only; no machine call.
- **Tip cards** (`useFeatureTipCard`): a while into a session, one untried tip
  in the corner (icon, title, Try it, Not now, screenshot), in a per-computer
  random order. One corner card at a time with suggestions, never during
  onboarding, not within 30 minutes of a suggestion; up to two a week, two
  days apart, within the unasked budget, each once (trying it elsewhere
  counts); it never uses a suggestion's per-launch slot. It never asks or
  shows while a chat or CLI turn runs in the open project on any machine (an
  Activity row the user dismissed still counts), nor for 30 s after the last
  turn ends; a card already up steps aside and comes back (`useAgentBusy`).
  Another machine's items match the project by name; an item from the
  project's own device matches only by folder. ADE Tips' header turns them off. A tip with
  `card: false` (setup and power-user tips such as Beta track, Headless,
  Keyboard, Quick slots, Music) stays in ADE Tips but is never a card, and
  ADE Web never offers a `desktopOnly` tip (`tipOfferedAsCard`).
- **Testing**: `npm run dev:desktop -- --first-run --keep` reopens as a
  returning user; dev palette **Dev: Suggestions test mode** (no limits) and
  **Dev: Reset Tips, suggestions and What's new** (`resetOnboardingTiers`).

### The unasked budget and onboarding sync

Everything ADE shows that the person did not ask for (What's new opening by
itself, tip cards, surveys, situational suggestions) shares one budget
(`renderer/onboarding/unaskedBudget.ts`): at most one a day (20 h gap),
nothing in a new account's first three days. A suggestion is never held back
by it, but spends it.

The sidebar nudges ("Invite friends, get free cloud hours" and "Star ADE on
GitHub") stay outside it: each already has its own message-count schedule with
snoozes and a final dismissal (`lib/nudgePill.ts`). One shows at a time, and
"Invite friends" goes first (it shows only to someone who has used ADE Cloud,
and it pays them hours); the star pill takes the place once the invite is
dismissed or done. Both wait while the tour runs (`onboarding/useTourOpen.ts`)
and mount only while the sidebar shows. The "Import your chats" pill under the
new-chat composer also waits while the tour runs, since the tour's cards point
at the same composer.

Onboarding lives on the account as one setting, `onboarding.progress`
(`shared/onboardingProgressRecord.ts`, `ACCOUNT_SCOPE_ALL`): started, skipped,
tour done, hint answers, tips already offered, and the last unasked showing.
`onboardingSync.ts` reconciles on open, sign-in, a remote settings change and
1.5 s after a local change: it reads the account copy (the desktop pulls its
brain's copy once per account first), merges (later times win, the earlier
start, tips join; "Show me around again" sets `resetAt`, which drops older
tour and hint answers everywhere), adopts the result locally and writes back
only when the account lacked something. What a computer held before its
first account signed in belongs to that account; when another account signs
in there, its copy replaces the computer's. The shared pass loop is
`renderer/lib/accountValueSync.ts` (also used by What's new seen pages); a
desktop brain pull counts only when `accountSettings.sync` reports `ready`. The desktop goes through its brain,
ADE Web through the account relay. Signed out or offline, the local copy
decides. No polling.

### Situational suggestions

The third tier: a bottom-right card (`suggestion` placement,
`docs/design/notices.md`) shown only on a signal: what, why now, one action,
**Not now** (files it under "Suggested for you" in ADE Tips, with **Don't
suggest again**).

- Rules (`renderer/onboarding/situationalSuggestions.ts`,
  `ade.suggestions.v1`, per computer): one card per signal (again only after
  its repeat time), at most one new card per launch, none for four hours after
  the last, none during the tour or before onboarding ended on an earlier
  launch. "Not now" snoozes the kind two weeks.
- `app/suggestions/useSituationalSuggestion.tsx` draws the card;
  `SituationalSuggestions.tsx` (in `AppShell`) holds one hook per signal.
- The lane-template suggestion (`useLaneDependencyBanners`) uses the same
  helper but returns per project after two weeks while it applies, and
  "Don't suggest again" is per project (`neverPerScope`);
  `ade.laneTemplateSuggestion.v1` folds into `ade.suggestions.v1` on first
  read.

| Suggestion | Signal | Action |
| --- | --- | --- |
| Plan running low | A Claude or Codex limit at 20% left or less with one account signed in (the tab machine's snapshot); once per provider per reset window | Settings › AI accounts |
| `@` sends work to another machine | Another machine of the project is online and no sent message ever had an `@machine` mention | A new chat in the primary lane |
| ADE secrets | A sent message looks like it holds a key or password (`shared/secretText.ts`); again after 30 days | Settings › Passwords & Secrets |
| Connect the tracker | A sent message links a Linear, Jira or GitHub issue or PR and the tab's machine is not connected (read only then) | Settings › Integrations › that tracker |
| The Work grid | Three or more chats working and the grid off | Turns on Focus with the grid, opens Work |
| Automations | The same prompt (normalized, 20+ characters, not a slash command) sent three times in a week here; only hashes kept | Automations |
| ADE on iPhone | A week after first run, no other machine and no paired phone (read once then) | Connections › Phone |
| Stacked PRs | A lane on another lane (not the main checkout) with an open PR, while it has none | PRs |
| Import your .env | The open project's main checkout has a git-ignored `.env` on the person's own connected computer; once per set of files (`useEnvImportSuggestion.ts`) | Passwords & Secrets with the import dialog ([The `.env` tip](../passwords/README.md#the-env-tip)) |

Send-time checks (`chatSendSignals.ts`, from `AgentChatPane`'s submit) read
only the typed text in one pass, so they work for a chat on any machine;
tracker status is checked only for chats on the tab's machine. Nothing polls.
Preview with `?mockSuggestion=<id>` (flags in `browserMock.ts`).

### Machine layer (one-time per machine)

`LocalRuntimeConnectionPool` drives it at desktop launch; General shows it
through `AdeCliSection`.

1. **Reset pre-account machine trust** once, in packaged builds only. Before
   attaching, ADE removes only `remote-machines.json`,
   `desktop-paired-machines.json`, `sync-paired-devices.json` and the
   runtime-host grants sidecar from the channel's machine secrets directory;
   sessions, identity, the PIN, the bootstrap token, projects and SSH files
   stay. A pending marker is written before the forced service restart and
   completes only after the restart is confirmed; an early exit retries the
   restart without erasing newer pairings.
2. **Bring up the runtime.** The pool attaches to `~/.ade/sock/ade.sock`, else
   spawns `ade serve --socket <path>` from the bundled CLI. `initialize`
   checks the version and a SHA-256 build hash of the CLI script
   (`ADE_RUNTIME_BUILD_HASH`, set by `apps/ade-cli/src/cli.ts`; compared in
   `LocalRuntimeConnectionPool.connectClient`). A dev `0.0.0` with a matching
   hash is accepted. A mismatch raises `LocalRuntimeCompatibilityError`; the
   pool kills the stale runtime when it reported a pid, unlinks the endpoint
   and spawns a compatible one.
3. **Register a per-user login service.** `installServiceBestEffort()` runs `ade
   serve --install-service` once per session (`apps/ade-cli/src/serviceManager/`:
   launchd, systemd, Windows startup), exposed as
   `LocalRuntimeStatus.serviceInstall` and `serviceHealth` (`unsupported |
   not_installed | installed | running | error | unknown`). On macOS both
   launch agents (brain and watchdog) carry `AssociatedBundleIdentifiers`, so
   Login Items show ADE's name and icon.
4. **Install `ade` on `PATH`** through `window.ade.adeCli.installForUser()`
   and the bundled helper (`…/Resources/ade-cli/install-path.sh` on macOS);
   Settings → System → Advanced shows the path, Install / Repair and the PATH
   hint.
5. **Register projects.** Opening a project calls
   `LocalRuntimeConnectionPool.ensureProject(rootPath)` → `projects.add {
   rootPath }`, so every client sees it in `projects.list`.

### Project layer (per project)

Repository onboarding:

1. Detects dev tools (git, `gh`).
2. Detects stack signals (node, rust, go, python, docker, make).
3. Suggests test, automation and provider config.
4. Optionally imports git branches as lanes.
5. Prepares the initial workspace state.

Project open runs a cheap first pass: lanes load without per-lane status,
keybindings load at once, provider modes and full lane status warm later, and
heavy background work does not block use.

### Headless install

For machines without the desktop app (CI, SSH-attached runtimes, Linux
servers):

```bash
curl -fsSL https://ade-app.dev/install.sh | sh     # macOS, Linux
irm https://ade-app.dev/install.ps1 | iex          # Windows PowerShell
```

- The script downloads the static `ade-<platform-arch>` binary (a Node SEA; no
  Node or npm needed) and its native archive, puts the binary in
  `$ADE_INSTALL_DIR` (or `~/.ade/bin`), extracts natives under
  `~/.ade/runtime/<arch>/`, and registers the service.
- **PATH first.** Windows updates the per-user `PATH` unless `-NoPath`. POSIX
  writes `~/.ade/env` and, with consent on a tty, appends one grep-guarded
  `. "$HOME/.ade/env"` block to `~/.zshrc`, `~/.bash_profile` (macOS bash) or
  `~/.bashrc` (Linux bash). Fish, unknown shells, non-interactive runs and
  `ADE_INSTALL_NO_PATH=1` get printed instructions.
- **Register through `ade brain start`**, which pins the default role to `cto`
  (needed by `ade connect` and the desktop). `serve --install-service` would
  leave `ADE_DEFAULT_ROLE` unset, land on `agent` and break sign-in.
- **Then `ade setup`**, shared by both platforms: pinned agent CLIs, account,
  desktop app, an end-to-end check (brain running, machine linked) and a
  five-step summary. A failed step names its fix inline and under "What's
  left".
  - Before the account step, `awaitRuntimeService` probes the socket, installs
    the service only if nothing answers, and dials for
    `SETUP_SERVICE_START_BUDGET_MS` (`RUNTIME_SERVICE_START_WAIT_MS`, 90 s),
    printing "Starting ADE's background service..." only when it waits. The
    wait never blocks later steps. A still-starting brain makes the account
    step *skipped* ("ADE's background service is still starting"), ending with
    "Give it a moment, then run `ade connect`."
  - An already-linked machine is offered keep / switch / skip. The desktop step
    skips its ~1 GB download for the same version, resumes with a Range
    request, and launches detached (no inherited Windows console).
  - `ade connect --headless` for no browser. Non-interactive runs skip prompts
    and print commands; `ADE_INSTALL_NO_PROMPT=1` / `-NoPrompt` opts out.
    `ade setup` can be re-run.
- See [`apps/ade-cli/README.md`](../../../apps/ade-cli/README.md) for the flow
  and overrides.

### CTO first-run setup

A project whose `modelPreferences` is null opens on `CtoWelcome` (avatar
asleep), offering only models that can steer a live turn. That pick is the
whole setup; effort, Fast, backups, look and personality come later from the
CTO settings page. `CtoOnboardingState` is an internal marker list (`intro`),
never shown. See [CTO › Welcome](../cto/README.md#welcome).

## Settings responsibilities

Settings is organised by **scope**: the sidebar group says where a setting
saves and who it affects, once per group.

| Group | Saves to | Pages |
|---|---|---|
| **General** | — | Needs attention, You and this machine, ADE version and updates on every machine |
| **You** | Your ADE account, everywhere | Account, Usage, Sharing (desktop only) |
| **App** | How ADE behaves for you | Chat, Providers, Android devices and Apple devices (each with a machine picker in its title), MCP servers, ADE MCP, Notifications, Appearance, Behaviour and Keyboard (these three on this computer) |
| **Project** | The open project (routed to its machine) | Lanes (Your lanes, Rules), Agents (PR chat transcripts), Deleted & Archived (Recently deleted, Archive; every machine at once), Disk space (Space, Rules), Location (move, project checks), Secrets (this project on every computer), Integrations |
| **System** | This computer, or the picked machine | Machines (all, and a page each), Advanced (background service, the `ade` command, Send a report, Database copies, Reset) |

**General** opens first:

- **Needs attention**: every problem (project, this computer, other machines,
  providers, MCP servers, integrations, Apple), opening in place with Fix
  buttons and "Ask an agent". A failed read is a "couldn't check" row with
  Check again. The header counts problems and warnings ("3 things need
  attention · 2 notes"); notes sit under "Good to know". Each warning or
  note has a quiet eye-slash (on hover or focus) to ignore it: a project line
  can ignore one of its folders or hide until it changes, saved in the project
  ([project-health.md](./project-health.md#ignoring-a-check)); any other row
  hides on this computer until it changes. What was ignored sits folded under
  the rows ("2 ignored items") with Show again.
- **You** and **This machine** cards.
- **ADE**: version and track, the one restart action ("Restart and update", or
  "Restart and switch to Stable", the same words as the top bar, floating
  prompt and restart dialog), the track, automatic installs, an update row per
  machine.

**Only real problems.** A provider counts only when used (signed in here, or a
Claude/Codex account here naming an email or plan, found signed out by usage,
or with a broken saved login; an unnamed default account does not count) and
unable to start chats; never one never set up, switched off, still
downloading (`runtimeDownloadPending`) or running with a side note (an old
Codex token for usage). "Background service calls failed" counts a call once
after its last retry, skips refusals the brain marks expected, and lists the
worst (`RuntimeHealthSnapshot.failedActionsTop`). An ADE Cloud box that is
asleep, stopped or changing state is dropped once the box list answers. The
renderer gathers problems (`settings/overview/useNeedsAttention.ts`); the
project part is `projectHealth.getReport` ([project-health.md](./project-health.md)).

**Old links.** Every entry keeps its id and anchor; old tab links (`overview`,
`service`, `computer`, `diagnostics`, `general`, `storage`, `health`,
`archive`, …) and hashes (`#continue-after-restart`, `#about.reset`) land on the
page holding them. `DEFAULT_SETTINGS_TAB` names the landing page (not
`tabs[0]`, so reordering the sidebar cannot move it).

**Other machines** are reached from Machines or the Providers picker, never a
copy of every page. A machine's page reads and writes through its pin (keep
awake, terminal shell, Continue chats after restarts, its update track via
`ai.getMachineUpdateTrack`); a row only that machine's ADE can change shows
its value and "Change on that machine". Offline machines show what was last
known. The Project group is named after the repository and disappears outside
a project.

- `SettingsMachinesNav.tsx` derives machine pages from the project machine
  snapshot; `SettingsMachineScope` carries the current target or an explicit
  `OpenProjectBinding`; `machineSectionAvailable()` keeps local-only and
  bound-runtime sections on reachable machines.
- GitHub and Linear are `routed`: every call (including the per-machine App
  status in `useGithubAppUserAuth`) carries the page's pin. Browser steps (the
  GitHub device code, Linear sign-in) open on this computer; Linear browser
  sign-in is not offered for another machine (its callback cannot reach it),
  so the API key path shows. `linksToTabMachine` sends a link without
  `?machine=` to the tab's machine.

**Project pages.** One-column blocks. Lanes: **Your lanes** (All, Stale, Has
changes, Running tiles) and **New lanes** (start defaults, templates).
Deleted & Archived: **Recently deleted** (lanes and chats, a lane with its
chats) and **Archive** (lanes, chats, shells), both read from every online
machine at once, with no machine picker. Each view has one toolbar (kind
filter, search) and no second title; row meta lines wrap through
`MetaLine.tsx`. Disk space: **Space** (lane and ADE
storage, cleanup history; one machine, picked on the page) and **Rules** (idle
archiving, session lifecycle, project files). Agents: PR chat transcripts. The
web shows Recently deleted, Archive and Rules. Links and search switch to the
right view; `?tab=archive`, `archived`, `recently-deleted` and `trash` open
Deleted & Archived; `?tab=storage`, `disk` and `session-lifecycle` open Disk
space.

- Bulk archive re-reads git before the merged-PR exception, then skips dirty,
  active or unpushed lanes.
- A machine change clears the previous machine's lane, storage and health data
  first.
- Disk pressure stays available with no project by reading this computer's ADE
  storage root.

### Settings with no project

The new-project screen's **Settings** button sets `standaloneSettingsOpen` and
opens `/settings`; `App` renders `SettingsPage` with `standalone` (Back
returns; the top bar shows a "Settings" tab).

- Only project-free settings show: the standalone resolver hides
  `account-repo` and `machine-repo` entries and tabs whose sections all need a
  project.
- Integrations shows only account pages (ADE Cloud, MCP servers); GitHub,
  Linear and Jira tiles and status reads are left out.
- Mixed pages (Chat, Notifications) check `isStandaloneSettings()` and show one
  "Open a project to change these." (`ProjectSettingsNotice`) instead of the
  project cards (prompt suggestions, Smart decisions, Claude mods, scheduled
  work).
- It ends on a new tab ("+"), Back, closing the tab, or opening a project. A
  project closed on `/settings` falls back to the new-project screen.

### Settings holds the project sidebar open

On any Settings page the project sidebar shows: its toggle is disabled (the
tooltip says why) and Mod+B does nothing. The saved preference is untouched, so
leaving Settings restores it. While collapsed, the toggle is accent-coloured
with a dot.

A Machines page (General, Appearance, Apple devices, Providers, Lanes,
Integrations, Diagnostics, Archive) describes one computer, so a project never
keeps one as its start page: it returns to its last other page (a stored
Machines page restores to Work). The cog reopens the project's last Account or
Project section, or the default page. `isMachineScopedSettingsRoute`
(`settingsManifest.ts`) decides.

| Tab | Section file | What lives here |
|---|---|---|
| General | `general/GeneralPage.tsx`, `NeedsAttentionStrip.tsx`, `MachineUpdateRows.tsx`, `UpdateTrackControls.tsx`, `AutoUpdatesSection.tsx` | Needs attention, You and This machine, the ADE card. Legacy `?tab=overview`, `health`, `about`, `updates`, `onboarding`, `help`, `tours`, `home`. |
| Machines (System) | `machines/MachinesPage.tsx`, `MachineSettings.tsx` | Every machine (tile, status, OS, version and track, free disk here) and a page each: updates, providers link, Continue chats after restarts, terminal shell, keep awake, service, `ade` command, system, projects. ADE Cloud is one more row, as in the Connections panel: its lanes, how many are awake and the credits left, from memory with no wake; it opens Settings › ADE Cloud and counts as one machine. Each lane computer stays out of the list. Legacy `?tab=computer`, `computers`, `this-computer`. |
| Advanced (System) | `health/HealthService.tsx`, `BackgroundServiceSection.tsx`, `AdeCliSection.tsx`, `DiagnosticsSharingSection.tsx`, `DatabaseCopiesSection.tsx`, `ResetAdeSection.tsx` | Service status, background service and quit question, the `ade` command (`#ade-cli`), **Send a report to ADE** (`#diagnostics-sharing`, not on hosted web; no consent switch), **Database copies** (`#database-copies`, this computer: one copy per database from the last update, deleted after a day of the update working, Reveal and Delete; restore is the "ADE could not start" window's Go back), **Reset ADE** (`#reset-ade`, last; `#about.reset` lands here). Legacy `?tab=service`, `ade-service`, `diagnostics`, `context`. |
| Appearance (App, this computer) | `AppearanceSection.tsx`, `AppearanceTerminal.tsx`, `ThemeGallery.tsx`, `ThemeCustomizer.tsx`, `ThemeImportExport.tsx`, `AppearanceScheduleSettings.tsx` | Per computer, never synced: theme families with search, Auto / Light / Dark, import/export, interface and code faces, reduce motion, Focus grid chats per page, terminal text, **Background** (`#background`: plain, gradient, picture, shuffle with cadence and App colours from the picture), **Schedule**. One page, under This computer. Chat looks are on Chat. |
| Apple devices (App, follows `?machine=`) | `AppleDevicesSection.tsx`, `devices/AppleMachineSection.tsx`, `devices/AppleToolsSection.tsx`, `devices/useDevToolsStorage.ts` | The picked Mac's Xcode (version, build, app and developer folder, update, first-launch setup), one bar of what simulators, runtimes and Xcode build data (DerivedData) take on its disk, then each list biggest first with its delete: simulators (owner: a lane, ADE, or yours; a lane's or a running one can't be deleted here), runtimes (Remove, Remove replaced), build data (Delete, Delete unused for 30 days or whose project is gone; refused while Xcode builds). Every call carries the page's pin. A Windows or Linux machine shows "The iOS Simulator runs on a Mac" with the ADE Cloud iPhone and the person's Macs. Then this window's simulator and preview choices: 3D body, recording overlays, remote streaming bitrate cap, recordings storage warning, filed in the account store per device (`device.<syncDeviceId>.<key>`). |
| Keyboard (App, this computer) | `keyboard/KeyboardPage.tsx`, `ShortcutsCard.tsx`, `QuickSlotsCards.tsx` | A banner (status, Quick slots leader, shortcut and change counts, main modifier, where it saves), then cards. **Shortcuts** (`#keyboard-shortcuts`): every action in `shared/keybindings.ts`, a recorder, conflict marks against shortcuts, Quick slot chords and OS-reserved chords, reset per shortcut or all; saved on this computer (`lib/keybindingStore.ts`, `ade.keybindings.v1`) for every project and window (the hosted client keeps them in the browser); older per-project overrides are copied once. **Quick slots**: nine actions on a leader + digit (`Option+Command` macOS, `Ctrl+Shift` Windows), a 3×3 grid, leader and sticky choices, saved model profiles (model + thinking). With the caret in the composer a profile inserts an `@model` chip; elsewhere it sets the chat's model. See [Quick slots](../chat/quick-slots.md). |
| Chat | `ChatSection.tsx`, `DictationSection.tsx`, `LaunchPromptSection.tsx` (with `ChatAppearancePreview`), `SmartDecisionsSection.tsx` | Typography and density, surface (tint, corners), details (copy-button position, minimap, drafts button, launch-prompt clipboard, live preview), voice input. Smart decisions (OpenCode Jev) and the model hint sit beside Next prompt and save to `.ade/local.yaml`; without an OpenCode Zen sign-in the row offers **Sign in to OpenCode**. Label maps are imported from `AppearanceSection.tsx`, not copied. |
| Providers | `ProvidersSection.tsx`, `OAuthConnectModal.tsx` | Connections, model routing, spend cap, voice input. **Coding Agents** cards (Claude Code, Codex CLI, Muse Code, Cursor, Droid, Pi with in-app sign-in) and **OpenCode — Universal Model Access**. Background helpers here are scheduled-work pause/recovery only. Legacy `?tab=ai`, `providers`, `background-jobs`, `automations`. On hosted web every provider page is hidden and the web-only **AI accounts** card (`agents.accounts`, `#ai-accounts`) shows the connected machine's Claude and Codex `ProviderAccountsPanel`s. |
| Lanes | `NewLaneSettingsSection.tsx` | **Your lanes**; **New lanes** (Where new lanes start, Lane templates). |
| Sharing (You, desktop only) | `laneShare/SharingSettingsPage.tsx`, `laneShare/laneShareDefaults.tsx` | **Lanes you shared** (`#sharing-by-me`: every share on any machine, by project, a row per person; rows for this window's machine and project show and change rights and usage; a share elsewhere can be stopped), **Lanes shared with you** (`#sharing-with-me`: Accept, Open, Decline, Leave; no project needed), **Default access** (`#sharing-defaults`, account key `laneShare.defaultRights`, scope `all`). In `ACCOUNT_ONLY_TAB_IDS`; hidden on the web (no channel for `lane_share`). See [lane sharing](../lanes/lane-sharing.md). |
| Agents (Project) | `PrChatTranscriptsSection.tsx` | PR transcript gists (id `lanes-git.pr-chat-transcripts`). |
| Integrations | `GitHubIntegrationSection.tsx`, `LinearIntegrationSection.tsx` | GitHub and Linear. Legacy `?tab=integrations`, `github`, `linear`, and `?integration=github|linear`; `?integration=cli` follows the `ade-cli` anchor to General. |
| Notifications | `NotificationsSection.tsx`, `AgentCompletionSoundSection.tsx`, `ActivitySettingsControls.tsx`, `AiFeaturesSection.tsx` | `AttentionPreferences` delivery: per-event policy (off / ambient / notify) for agent and PR events, quiet hours, focus suppression, phone delivery and escalation, the completion sound. Then Activity's surfaces: the notch (enabled; reveal `always` or `hover`, the same strip either way; expanded panel), celebrations, sounds, hide-previews, per-machine mute, and delivery switches for iPhones and iPads registered to the account. The notch always flashes for work that needs you, and the strip shows state-group counts. One `useActivitySettings()` model; `ActivitySettingsControls` also mounts in the Activity popover and pane. Legacy `?tab=attention`, `activity`, and `#attention-notch`, `#celebrations`, `#attention-sounds`, `#hide-previews`. |
| Passwords & Secrets (This computer) | `passwords/PasswordsSection.tsx`, `PasswordDialogs.tsx`, `passwordsFormat.ts` | One end-to-end encrypted vault (logins, passkeys, secrets), on by default; secrets for every or one project, in the account or this computer only, `.env` import and export. `?tab=secrets` / `secret` open Secrets. See [Passwords & Secrets](../passwords/README.md). |
| Deleted & Archived (Project) | `lanes/LanesSettingsPage.tsx` (`DeletedArchivedPage`), `RecentlyDeletedSection.tsx`, `ArchiveSection.tsx`, `EveryCopyList.tsx`, `state/everyCopyRead.ts` | Recently deleted lanes and chats, and the archive, from every online copy of the project in one list (no picker; an asleep ADE Cloud computer is not read, and neither is the ADE Cloud account itself). Each row acts on its own machine's pin. Legacy `?tab=archive`, `archived`, `recently-deleted`, `trash`. See [Storage and recovery](../storage-and-recovery/README.md). |
| Disk space (Project) | `lanes/LanesSettingsPage.tsx` (`StorageSettingsPage`), `health/*`, `storage/*`, `SessionLifecycleSection.tsx`, `ProjectSection.tsx` | Disk and lane storage, cleanup history, idle-archive rules, session lifecycle, project files, for the copy picked on the page. Rule fields show the value in force with "Inherited". Legacy `?tab=storage`, `disk`, `space`, `session-lifecycle`; `?tab=diagnostics` opens Advanced. See [Storage and recovery](../storage-and-recovery/README.md). |
| Usage | `AdeUsageSection.tsx`, `BudgetCapEditor.tsx` (the spend cap lives with spend) and the `usage/` components | The one-page usage dashboard (see the source map); scope `account` / `machine` / `project`. Legacy `?tab=usage`, `ade-usage`. |

Live quota windows render twice from one snapshot: the top-bar popup
(`HeaderUsageControl.tsx` → `UsageLimitsBand.tsx` → `UsageAccountRow.tsx`, with
the collapsible `BudgetCapEditor`) as one meter row per account, and Settings ›
Usage's machine and project scopes as `UsageLimitGauges`.

- `LEGACY_TAB_ALIASES` / `LEGACY_HASH_ALIASES` (`settingsManifest.ts`) forward
  old links; `settingsManifest.test.ts` asserts every shipped tab id resolves
  and every hash alias reaches a live entry.
- Search in the content header filters cards by `data-settings-anchor`; a
  group whose cards all filter out hides its heading. Cmd-K has one entry per
  tab and per setting from the same manifest.

### Keeping the machine awake

**Keep this Mac awake while agents work** (Settings → Behaviour, `keep-awake`)
is one radiogroup. The selected machine's brain stores it in
`<ADE_HOME>/keep-awake.json`, so it holds after the desktop quits. The desktop
migrates `keepAwakePreferences` from `GlobalState` on first use and removes
the old value only after the brain confirms.

| Level | What it does | Where it works |
|---|---|---|
| `never` (default) | Holds nothing. Turns pause when the machine sleeps, and the chat says so. | everywhere |
| `while-away` | The brain holds one OS wake lock **only while work runs**: macOS `caffeinate -i -w <brain pid>`; Windows a `SetThreadExecutionState` helper that exits with the brain; Linux `systemd-inhibit --what=idle:sleep` around `tail --pid=<brain pid>`, plus `gnome-session-inhibit --inhibit suspend` in a GNOME session, whose idle suspend ignores the user's own logind lock. The screen still locks. Stops idle sleep, not the lid. | macOS, Windows, Linux with systemd |
| `lid-closed` | `pmset -a disablesleep 1` through the authorization dialog. Machine-wide; outlives ADE. | macOS only |

- **A wake lock stops idle sleep only** (measured: an `IOPMAssertion` held 35
  days slept through two lid closes). No code or copy may imply otherwise.
  Only `pmset -a disablesleep` survives a closed lid; it is root-only and
  machine-wide, so the level asks for a password and warns it stays on. The
  prompt runs in the selected Mac's desktop (open Settings on a remote Mac).
  Windows has no equivalent, so the level is **absent** there. The brain
  reports its platform, so the pane describes the machine it shows.
- **The lock follows the work.** A 5-second brain poll counts active agent
  turns and tracked agent CLI sessions with PTY state `running` (idle shells
  and open sessions do not count). One helper runs for the whole active
  period; a failed read releases it; `never` releases synchronously; macOS
  `-w` and the Windows handle wait release it when the brain exits.
- **The snapshot reports the machine.** A `lid-closed` level whose assertion
  was released elsewhere shows "This Mac can still sleep." with **Turn on
  again**. `pmset -a disablesleep` stays engaged at quit (reverting would
  prompt on exit or on every launch).
- **The OS idle timer.** The section reads it (`pmset -g custom` on macOS,
  `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` on Windows, nothing on
  Linux) and offers a fix when a non-zero timer would stop agents: **Fix —
  needs your password** on macOS (system settings); the Windows fix edits the
  user's active scheme without elevation.
- **Routing.** A pinned machine uses the remote-capable `keep_awake` action;
  this computer uses the brain's machine method `keepAwake.call` (no project,
  cto role). A brain without keep-awake answers `action_not_callable`; a brain
  without the machine method is reached through any project. The local desktop
  shows macOS admin prompts (the brain has no GUI); a remote Mac is sent to its
  own Settings; Windows uses the brain action. The desktop's in-process blocker
  starts only when the local brain lacks the action, and successful brain reads
  stop it. Hosted web and the mock show the inert snapshot.
- When the machine sleeps anyway, see
  [chat → When the host machine sleeps](../chat/README.md#when-the-host-machine-sleeps)
  and [machine power in the account directory](../sync-and-multi-device/README.md#account-directory-and-connection-leases).

### Capturing a window with a key gesture

**Settings → Behaviour → "Capture with a key gesture"** (`capture-gesture`,
`CaptureGestureSection.tsx`) arms the global chord (both ⌘ on macOS, both Ctrl
on Windows); see [Capture gesture](../capture-gesture/README.md).

- `scope: "machine"`, `showScopeChip: true`, `web: "hidden"`, stored in
  `localStorage` `ade:capture-gesture:enabled` (default **on**), not synced:
  each Mac has its own Screen Recording grant. `GlobalCaptureGestureHost`
  pushes it to main through `captureGesture.updateSettings` on mount.
- The card shows helper **health**, because every failure is the user's to
  fix: `permission_denied` (Screen Recording; recovery `grant_permission`),
  `permission_denied` with an Input Monitoring message on macOS 27 (recovery
  `retry`; the tap reinstalls in place), `monitor_unavailable` (`retry`),
  `missing` (`reinstall_or_update`).
- Linux shows `CAPTURE_GESTURE_UNSUPPORTED_BLOCKER`.
  `captureGestureBridgeAvailable()` uses an `in` probe, because the hosted web
  adapter's proxy fabricates `window.ade.captureGesture`.

### Where durable data lives

| What | Location | Notes |
|---|---|---|
| Project config (local) | `.ade/local.yaml` | gitignored |
| Onboarding status | `AdeDb`, `STATUS_KEY = "onboarding:status"` | `completedAt`, `dismissedAt`, `freshProject` |
| Context doc prefs | `AdeDb`, `context:docs:preferences.v1` | provider, model, effort, event triggers |
| Terminal preferences | `localStorage` `ade.terminalPreferences.v1` | font size, line height, scrollback, family |
| Work view state | `localStorage` `ade.workViewState.v1` | per-project and per-lane-project slices |
| Keep-awake level | `<ADE_HOME>/keep-awake.json` | brain-owned, per machine; `GlobalState.keepAwakePreferences` migrates once; unreadable means `never` |
| GitHub credentials | Keychain via `safeStorage` | encrypted; an undecryptable store reports `credentialStoreUnreadable`, not "not connected" |
| Account settings cache | `~/.ade/account-settings.json` | plaintext, owner-tagged; survives sign-out; stamps namespaced by account |
| Account vault cache | `~/.ade/account-vault.json.enc` | machine-key encrypted, atomic `0600` writes; a plaintext copy is removed after an encrypted write |
| AI provider API keys | Machine credential store plus account vault | each value records device/account provenance; account-hydrated keys go on sign-out or switch; device-origin keys stay |
| Linear credentials | Machine credential store or the project's `.ade/secrets`, plus account vault | the refresh token is the `linear_refresh_token` item with a `refreshOwner` device id; only that owner hydrates or refreshes; account-origin values go on sign-out; device API keys and custom OAuth settings stay |
| Secrets | Passwords & Secrets (sealed on the relay, a machine-key-encrypted cache per computer) | for every project or one repository (normalized origin, or the folder without a remote); follows the account; "this computer only" never leaves |
| Capture-gesture switch | `localStorage` `ade:capture-gesture:enabled` | per machine, default on |

## AI mode and provider behavior

`effective.ai.mode` decides guest versus subscription behaviour:

- **guest**: deterministic features work; AI features (narratives, summaries)
  degrade cleanly.
- **subscription**: chat, narratives and summaries.

`projectConfigService` keeps an idempotent `providers.mode` migration path.

## Provider accounts

A machine can hold several Claude and several Codex logins. Each is a provider
config directory selected at launch by one variable, `CLAUDE_CONFIG_DIR` or
`CODEX_HOME`. Other providers have one identity per machine (no config-home
override or no local account file).

- **Registry.** The brain owns `provider-instances.json` in the machine ADE
  home beside `projects.json`. It is not a SQLite table, because every table
  with a primary key becomes a cr-sqlite CRR and replicates to devices where
  these paths mean nothing. ADE-made accounts get
  `<adeHome>/provider-homes/<provider>/<instanceId>/` (`0700`; the CLI writes
  its credentials there). ADE never reads, copies or revokes those credentials.
- **The default account is synthesized on read.** The machine's existing login
  has the provider slug as its id (`claude`, `codex`) and its home is whatever
  `providerConfigHomes.ts` resolves on each read. No migration or first-boot
  write; deleting the file is a full reset. Its identity is read without a
  scoped home, because the Claude CLI keeps `oauthAccount` in `~/.claude.json`
  beside the config directory.
- **One default per provider**, stored as a pointer. A pointer at a missing
  account resolves to the base identity, as a chat does.
- **Removing forgets only.** The config home stays on disk and is returned so
  the user can be told. The machine's own login and the current default refuse
  removal.
- **Accounts have no names.** Surfaces show the signed-in email, else the id
  (`ProviderInstance.label`, set by `providerInstanceDisplayLabel`). The id is
  what `--instance` takes and never changes; new accounts get the next free
  `<provider>-<n>`. `create` takes no label (an optional one only shapes the
  id). No surface offers Rename; the `rename` action stays for older phones and
  what it stores is not shown.
- **Action domain `provider_instances`**: `list`, `create`, `remove`, `rename`,
  `setDefault`, `setAccent`, `getSettings`, `setSettings`, `loginCommand`,
  `refresh`, all on the agent tier with no CTO gate (an account is a path, not
  a token). Reachable from IPC, the preload three-way route (pinned runtime →
  project runtime → local IPC), the daemon action bus and `ade providers
  accounts list|add|remove|default`. `setAccent` and `accentColor` exist only
  for compatibility; no surface shows an account colour.
- **Per-provider settings** (`smartBalance`, `autoStartWindows`) live under
  `settings.<provider>` in the same file, default off.
- **Signing in is a command, not a flow.** `loginCommand` returns the provider
  binary, its argv and the one env var for the account's home; `ade providers
  accounts add` prints it.
- **AI settings save to `.ade/local.yaml`.** `ai.updateConfig` (IPC, the `ai`
  domain, the brain's remote command) merges into the local layer through
  `projectConfigService.updateAiConfig`; `.ade/ade.yaml` is never written.

**Per-account settings** live in each account card's actions menu, never in
the card body.

| Setting | Providers | Choices and storage | Effect |
|---|---|---|---|
| Auto-compact (only with more than one account) | Claude, Codex | "Same as provider default" or Custom; `compaction` on the record | Overrides the provider's `ai.compaction.<provider>` field by field ([Compaction per provider](../chat/agent-routing.md#compaction-per-provider)) |
| Subagent cache | Claude | 5 minutes (Claude Code default, stores nothing) or 1 hour (`subagentPromptCacheTtl`; a **1h cache** tag on the card) | `claudeAccountPromptCacheEnv` (`providerInstanceStore.ts`) sets `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` for SDK chats and terminal `claude` on the account |
| Main chat cache | Claude | Automatic (stores nothing; Claude Code picks 1 h on a subscription within limits, else 5 min), 5 minutes, 1 hour (`mainPromptCacheTtl`) | Sets `CLAUDE_CODE_PROMPT_CACHE_TTL` the same way |
| Extra usage | Claude | **Continue** (stores nothing) or **Stop the turn** (`onExtraUsage: "stop"`) | See below |

- **Provider compaction** (`CompactionSettings.tsx`): **Compact at** (Auto by
  default) and, for Claude, **Subagents compact at** and **After the cache
  expires**, in `ai.compaction.<provider>` in `.ade/local.yaml`. No on/off:
  every chat compacts when full.
- **Cache env rules.** Nothing is added when the environment already states a
  TTL, and a launch on a preset or stored credential never gets it (that
  endpoint bills separately). ADE has no default: 1-hour writes cost more and
  pay off only when subagents wait over 5 minutes. The chat's cache countdown
  and Compact first read the lifetime Claude really wrote
  ([composer and UI](../chat/composer-and-ui.md)), not this setting.
- **Stop on extra usage.** When a `rate_limit_event` reports extra usage
  (`isUsingOverage` or `overageInUse`), the Claude runtime interrupts the
  turn, cancels its queue and ends it as a usage limit: the quota card shows,
  then the chat acts as at a plan limit (resume at reset, or move account under
  Smart balance). One request is billed first, because Claude reports after
  the response. It is this machine's registry only (not iOS or hosted web) and
  covers chats on the account's own login, including a chat whose preset
  cannot resolve; preset or stored-credential chats and terminal `claude` are
  not stopped.
- **Claude sign-in end date.** A Claude card shows "Sign-in ends around Nov 17"
  once a chat reported `credential_expires_at` (kept as `claudeLoginEndsAt`);
  "around" because it can be an estimate. It goes when another login replaces
  the account. Only on this page.

### Accounts panel

Settings → Agents & Models → Claude Code (or Codex CLI) shows **Accounts**
under the banner across the full width. It is the only surface with every
local login of a provider, and only these two providers have it. Sign-in lives
on each row and on **Add account** (no separate Sign in section). A copy that
is not downloaded shows the pinned-copy row (Download/Retry) under the status
chip.

- **Routing strip**, only when it has a switch: *Smart balance* (two or more
  accounts) and *Auto-start 5-hour windows* (while the provider reports a
  five-hour window), each a `SettingsToggle` with a (?) hint, plus one line on
  where new chats go. Both use `provider_instances` `getSettings` /
  `setSettings`.
  - Smart balance sends a new chat to the account that needs the most weekly
    room spent before its reset, net of committed burn (measured quota
    movement, chats just placed, reservations for open idle chats). The
    five-hour window is a gate, not a ranking; a chat is never refused when
    every account is blocked. **Next chat** previews the pick.
  - A running chat stays on its account; at a usage limit it moves to an
    account with room (with the switch off, the limit offers the move).
  - Auto-start sends one tiny request on the cheapest model when a window ends,
    logging its cost.
- **Cards.** A grid of as many 290px columns as fit, evened over rows
  (`balancedColumns`: two cards never leave an empty column; four go two by
  two); a row shares a height; no account cap. A card has the name, one badge,
  the ⋯ menu, and the usage popover's own `UsageAccountRow` (email, pace pill,
  Use reset, a meter per window) from `accountLimitRow` / `buildAccountRows`,
  matched by `UsageAccountRow.instanceId`, never by email.
- **Badges say where new chats go.** Balance off: the default shows `New chats`
  and an accent border; another card shows **Use** on hover or focus, and a
  click selects it. Balance on: `Next chat` marks
  `UsageSnapshot.balanceNext` (the same `pickInstanceForNewChat` chat creation
  runs); a click turns balance off and selects the card.
- **Signed out**: a `Signed out` pill (the usage row's, else a header badge),
  dimmed meters, **Sign in**.
- **Same login twice.** One card owns an email (`sameLoginOwner`): the default
  when it holds the email and works, else the first working login. Others
  (`ProviderInstance.sameLoginAs`) show `Copy`, name the owner, offer **Sign in
  to another account**, add no quota and are skipped by balance. The usage
  snapshot keeps only the owner's reading.
- **Machine scope**: accounts and usage come from the page's machine
  (`useUsageSnapshot({ pin })`).
- **Replaced login.** When a home's email changes (for example `claude /login`
  in a terminal), the store records `replacedAccount` and the card says "<old
  email> is signed out on this computer" (a running CLI changes account from
  its actions pane). A login several cards lost shows once, on the last.
  **Sign it back in** uses a `Copy` slot when there is one, else a new account
  named after the email; **Dismiss** (`provider_instances.dismissReplaced`)
  clears it everywhere. It clears itself once any account holds the email.
- **The ⋯ menu**: Sign in / Sign in again, Sign out, Remove, and the
  per-account settings above.
  - **Sign out** (every card but the default; `provider_instances.signOut` →
    `signOutProviderAccount`) runs `claude auth logout` / `codex logout` in the
    account's home and keeps the card; on the machine's own login the confirm
    says the terminal's CLI signs out too.
  - **Remove** (not on the default or the machine's login) signs the account
    out first (`removeProviderAccount`, shared by every surface), so re-adding
    starts fresh. A failed sign-out does not block removal; the card says the
    login stayed.
  - Both confirm in Settings and show the store's refusal sentence. Agents may
    call both; the default is always refused.
- **Panels fold.** `ProviderPanel` takes `autoCollapsed` and `summary`; an
  empty panel folds to its header (`API keys · 0 None saved`), the title
  toggles any panel, and sheets render outside the body so a folded panel still
  opens Add.
- **Add account**: a sheet (Name it → Sign in → Done). **Continue to sign-in**
  creates the account and calls `provider_instances.loginStart`.
  - The machine's login runner
    (`main/services/providerAccounts/providerLoginRunner.ts`) runs the
    provider's login command for the account's home in a private node-pty,
    reads the sign-in link and any code prompt, and verifies the login when the
    CLI exits (re-reading a stale signed-out mark and the home's identity). No
    terminal session or Work row is created.
  - The sheet polls `loginStatus` every second (the subscription proxy's shape,
    so it works for a page pinned to another machine) and shows **Open sign-in
    page** / **Copy link**, a code field (`loginSubmitCode`) and the output
    behind a closed **Sign-in output** disclosure.
  - For another machine and for hosted web, Codex passes `deviceAuth`
    (`--device-auth`), so the CLI prints a one-time code instead of using a
    localhost port the browser cannot reach; the sheet shows the code.
  - It ends on Done with the email, or "Sign-in did not complete." with the
    reason, **Try again** and **Close**. Closing cancels (`loginCancel`); it
    times out after ten minutes.
  - **Sign in to Claude Code** / **Sign in to Codex** on the left card opens it
    for the default account. `providers accounts refresh` (and IPC refresh)
    re-reads every account marked signed out.
- **Elsewhere**: the provider list row shows `N accounts` when there is more
  than one; the model picker adds "Smart balance is on for Claude Code" under
  the provider header while balancing (every model still listed, an explicit
  pick still honoured).
- **Hosted web** hides provider pages but gets one web-only **AI accounts**
  card (`agents.accounts`, `webOnly: true`, `#ai-accounts`) on the Agents tab
  with the same `ProviderAccountsPanel` for Claude and Codex; `webOnly` keeps it
  out of desktop nav, search and the palette.

### API credentials

A provider can hold several non-secret credential entries. The default keeps
the provider's single slot; others use a provider-and-credential id.
`ai.api_credentials.index.v1` stores labels, endpoints, protocols, models,
timestamps and masked tails, never secrets. Environment variables appear only
as the read-only default. Account-vault mirrors use `<provider>` for the
default and `provider#credentialId` for others, so single-key callers read the
default.

### Initial context window

Every provider page has a read-only **Initial context window** card: what a new
chat on that provider receives before the first message, on the page's
machine. ADE lists items; it does not switch them off.

- **Four parts**: the provider (its prompt and tools, in its colour), ADE
  (teal), the user's setup (pink), this project (amber). A bar shows shares;
  each item lists a size, its file and, for config entries, where it is set
  (`Set in ~/.codex/config.toml`).
- **Sizes.** ADE items are counted from the text a real launch builds (the same
  builders, dry-run); user and project items from their files by the
  provider's discovery rules; both are estimates (about 4 characters per
  token, `≈`). The total is the median first request of one-request chats in
  the turn ledger (at least 3; this project's when enough, else the
  machine's); with fewer, the listed sum. The provider part is the median
  minus the listed items.
- **Row buttons.** A gear opens the managing ADE page (MCP servers). A folder
  button reveals the file (Finder or Explorer), only for This computer and not
  on hosted web, through `ai.revealProviderContextPath`, whose allowlist holds
  the providers' config homes, the project, instruction files in parent
  folders and ADE's folders. A symlinked skill pointing outside shows as the
  link.
- **Machines.** Both renderer calls take the page's pin. A failed read shows
  **Try again**; a failed **Check again** keeps the last list and says so. An
  older ADE without the action hides the card.

### API keys panel

Every provider page ends its right column with **API keys**: one row per key
ADE sees, with label, exported variable, masked tail, source (Local store,
Environment, Project config), endpoint host and declared model count.

- **Local store** rows offer **Replace** and **Delete** (confirmed).
- **Environment** and **Project config** rows are read-only: "Managed outside
  ADE — clear the env/config value to remove."
- **This computer only.** A Local store key the account lacks shows "This
  computer only" ("That computer only" for another computer); other computers
  and ADE Cloud cannot use it, and saving it again while signed in moves it to
  the account. Key names are read once (`useAccountProviderKeyNames.ts`,
  `accountSecrets` kind `provider_api_key`, names only) and after a save or
  delete; when the account cannot answer, no tag shows.
- **Verify** only on the default key of a provider with a live probe (Claude
  Code, Codex, Cursor, Grok, Kimi), because the probe reads one key per
  provider.

**+ Add** asks only what the harness reads, one line per field, one Save:

| Provider | Stored under | Key variable | Endpoint | Protocol | Models | Provider id |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `anthropic` | `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` with an endpoint | `ANTHROPIC_BASE_URL` | — | yes | — |
| Codex | `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | — | yes | — |
| Cursor | `cursor` | `CURSOR_API_KEY` | — | — | — | — |
| Droid | `droid` | `FACTORY_API_KEY` | base URL | yes | yes | — |
| Pi | `pi` | — | — (Pi reads its own `models.json`; the sheet says so) | — | — | — |
| OpenCode | per custom provider id | — | base URL | yes | yes | yes |
| Qwen Code | `qwen` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | — | — | — |
| Kimi | `moonshotai` | `MOONSHOT_API_KEY` | — | — | — | — |
| Grok | `xai` | `XAI_API_KEY` | — | — | — | — |
| GitHub Copilot | `copilot` | `GITHUB_TOKEN` | — | — | — | — |

- Keys are filed under the vendor's id, so an existing `ANTHROPIC_API_KEY`
  shows as an Environment row on the Claude page and Verify finds its probe.
- The first key takes the default slot, so single-key readers find it. Cursor
  writes the single slot its SDK signs in from.

**One key store**: the account vault kind `provider_api_key` holds every key for
every computer and ADE Cloud.

- Names: `<provider>` for the default, `<provider>#<credentialId>` for others
  (`credentialStorageKey`, `main/services/ai/apiKeyStore.ts`).
- An ADE Cloud key goes to `<provider>`, or `<provider>#ade-cloud` when that row
  holds a different key; cloud computers read `<provider>#ade-cloud` first.
- On ADE Cloud, Qwen Code signs in with a DashScope key (`qwen` in
  `shared/cloudSignIns.ts`), written into Qwen's own settings, never the
  brain's environment.
- Two idempotent one-time moves per computer after sign-in
  (`main/services/account/accountMigrationRunner.ts`): device keys into the
  account (`provider_api_keys`), and ADE Cloud's `integration/cloud-key-<id>`
  keys into `provider_api_key` (`cloud_keys_api_store`). Neither deletes.

### OpenCode custom providers

The OpenCode page's **Advanced** section lists custom providers (name, id, base
URL, model count) with **Edit** and **Delete**. Add and Edit use the key sheet
with **Provider id** and a **Protocol** select (one per npm package). An empty
key on edit keeps the saved one. Every write sends the whole list, because
`ai.updateConfig` replaces arrays. **Custom model slugs** has its own Save.

## UX contract

- Require an account sign-in on a fresh launch; keep explicit recovery for an
  existing paired or local session.
- Never block on optional integrations.
- Keep setup responsive and show the fastest path first.
- Leave advanced or heavy configuration to the feature that owns it.

## Account session state is a four-state, not a boolean

`AccountAuthStatus.sessionState` (mirrored as `AdeAccountStatus.sessionState`)
separates three ways of not being signed in, because treating them alike
destroys good sessions:

| State | What happened | What the surface says |
| --- | --- | --- |
| `active` | Signed in. | — |
| `signed_out` | No session on this machine. | Offer sign-in. |
| `expired` | A session exists and the issuer definitively rejected its grant. | Say the sign-in expired; offer sign-in. |
| `unreadable` | The credential store could not be read this time. | Say nothing changed; offer **repair/retry**; demote sign-in. |

- **Why `unreadable` matters.** A new sign-in overwrites the stored session, so
  offering one over a merely unreadable session destroys a valid one.
  `SignInCard`, the Connections account header and the sidebar avatar label
  render the three states distinctly from one branch
  (`accountSessionState` / `accountSessionNotice`,
  `apps/desktop/src/renderer/lib/account.ts`); `unreadable` leads with the
  shared `BrainRepairButton` (or a plain retry with no brain) and demotes
  sign-in to "Sign in anyway". The CLI's `account-auth` formatter makes the
  same three distinctions.
- **Repair repairs the store.** A brain restart alone cannot fix it (the new
  process reads the same file). `account.repairSession` converges the shared
  store's key binding, merges back anything a peer set aside, then restarts the
  brain, and reports one of: readable again; readable but what was set aside
  cannot be opened here, so a fresh sign-in is needed; repair failed. Store
  mechanics: [ARCHITECTURE](../../ARCHITECTURE.md), machine credential stores.
- **Older runtimes** without `sessionState` derive it from `sessionReadState`.
- **A rejected grant is marked dead, not deleted.** The record keeps
  `rejectedAt` / `needsReauth` / `rejectedReason`. Deleting would make every
  process forget an account the user never left and drop the relay tunnel and
  account-directory row, cutting every remote route. `needsReauth` alone
  condemns a record (a marker without a parsable time still counts); the next
  sign-in overwrites it.
- **Ownership is not usability.** `accountSessionRetainsMachineOwnership(status)`
  is true for `active`, `expired` and `unreadable`, false only for a deliberate
  `signed_out`. Existing paired reachability survives a token accident; live-token
  work still gates on `signedIn`. See
  [remote runtime → Account state and reachability](../remote-runtime/README.md#account-state-and-reachability).
- **Every mutation is logged** as one `account.session_mutation` line: `action`
  (`persist`, `rotate`, `delete`, `mark_dead`, `sign_out`, three
  `rotation_journal_*`), `reason`, `pid`, `source` (`brain` | `cli` |
  `desktop`, from `deriveAccountSessionMutationSource`, overridable with
  `ADE_ACCOUNT_SESSION_SOURCE`) and `tokenGeneration` (a truncated SHA-256 of
  the refresh token, so no token material is logged).
- **Only the brain exchanges the refresh credential.** `accountAuthService`
  takes a `getRefreshBroker`; every non-brain process installs one with
  `setSharedAccountRefreshBroker` and asks the brain for an access token
  (`account.call` → `getToken`; desktop: `createBrainRefreshBroker` in
  `accountBridge.ts`). The broker never forwards `forceRefresh`. It is read at
  call time, because `getSharedAccountAuthService` caches one service per
  secrets directory and desktop's first caller can run before the runtime pool
  exists.
- **The broker probes per refresh.** The CLI installs it on non-brain paths. A
  missing brain returns null and the local exchange runs; a reachable brain
  that fails raises transient `AccountRefreshUnavailableError` and leaves the
  record. Only a definitive `invalid_grant` marks a session dead.
- **Unreadable repairs itself once.** `accountBridge.status()` runs
  `repairCredentialStore()` on the first `unreadable` read per desktop process
  (the flag is set before the attempt, so a throw cannot loop), then reports
  the result. It does not restart the brain; the manual **Repair** does both.
  Transient faults such as `ENOSPC` on `credentials.json.enc.lock` should never
  ask the user anything.
- **Rotation is crash-safe; a live peer's journal is a mutex.**
  `accountSessionRotationJournal.ts` records an exchange start against a token
  generation and clears it once the replacement is durable. A surviving entry
  means the token may be consumed, so the following `invalid_grant` is not
  definitive. `tryBegin` compare-and-swaps the entry: a live peer is waited
  out, never raced (two POSTs on a single-use token sign the user out); a dead
  peer's entry is taken over as interrupted.
  `DEFAULT_REFRESH_ROTATION_WAIT_MS` is `CREDENTIAL_STORE_LOCK_TIMEOUT_MS` plus
  5 s, so the loser never declares a live session dead while the winner waits
  on the lock.

## GitHub connection status has the same third state

`github.token.v1` and `github.appUserToken.v1` fail the same way: an
undecryptable store returns an **empty view**, which looks like a fresh
install. "Not connected" invites a reconnect, and a reconnect overwrites
credentials that were only unreadable.

- **Per-key verdicts.** `github.appUserToken.v1` is file-backed and shared with
  the brain and CLI; `github.token.v1` is in the Electron-only store. The routed
  store sends each read to its file, and `getWithReadState` answers per call,
  not from the router's last-read state. A locked OS keychain therefore hides
  only the Electron-only half. See
  [ARCHITECTURE §8.1](../../ARCHITECTURE.md#81-electron-safestorage-for-secrets).
- **Waiting is not unreadable.** Until the OS store answers its first check
  (macOS prompts for an unrecognized build), reads are **waiting**. The check
  runs off the main thread, so the window stays usable;
  `isSecureStorageCheckPending()` lets a surface say "ADE is waiting for the
  system keychain" (Settings → Providers shows an info banner and re-reads on
  answer). Nothing is cached meanwhile (key reads, legacy-token migrations and
  file-backed adoption re-run), so a granted prompt shows keys without a
  restart. A quit during the prompt does not wait: shutdown finishes, web
  storage flushes, the process ends.

| `GitHubStatus` answer | What is true | What the surface offers |
| --- | --- | --- |
| connected | A credential validated by `GET /user` and, where needed, the repo probe. | Nothing; `writeAuthSource` still gates mutations. |
| not connected | The store read fine and holds no usable credential. | `gh auth login` steps or a PAT field. |
| `credentialStoreUnreadable` | The store could not be opened on this read; credentials may be intact. | Say so and offer **repair**, never a reconnect first. |

Every surface resolves the third state before `!tokenStored`:

- **Settings → Integrations → GitHub** (`GitHubSection.tsx`): **Can't read
  sign-in** in warning tone, the shared notice, **Open connections**, no gh-CLI
  steps.
- **The app-shell banner** (`IntegrationBanners.tsx`, `AppBannerHost`) points
  at the Connections panel, since no GitHub action repairs the store.
- **The PR tab's empty state**: built in main by
  `prService.buildGithubSnapshotAuthError`, with the wording a shared constant
  in `shared/types/git.ts`.
- **Publish to GitHub** (`PublishToGitHubDialog.tsx`) reads the flag on open and
  uses the unreadable wording; the token field stays.

The Settings button and the banner open the Connections panel's **Machines**
tab, whose account header runs the same `account.repairSession` (one store, one
repair). Writing a new GitHub token clears the flag. An older runtime that
omits the field keeps the two-way behaviour.

## Gotchas

- **A provider account is a path, not a credential.** The registry holds config
  home paths; the tokens inside belong to the provider CLI. So the registry is
  plain JSON, `remove` deletes nothing, and the domain is not CTO-gated. Never
  add a field a credential would fit in.
- **The default account's config home is resolved, never stored.** A frozen
  path would make ADE read one directory and launch against another once a
  user sets `CLAUDE_CONFIG_DIR`. Any persisted `configHome` for the base
  identity is ignored (its `accentColor` field is never set or shown).
- **Scope has two axes**: owner (your account or this computer) and coverage
  (everything or one repository). A value holding a path, a port or a hardware
  fact is machine scope; everything else is account scope. `SettingScope` is
  the four combinations, and the sidebar group is the scope.
- **No trust gate, no committed config.** `.ade/ade.yaml` is not read: it is
  carried into `local.yaml` once (non-executable keys only) and deleted
  ([configuration-schema.md](./configuration-schema.md#no-trust-gate)). There is
  no `getExecutableConfig`; use `getEffective`.
- **Phone-sync port 8787.** Binding always tries 8787 first, even when
  `lastPort` is 8788; a brain on 8788 keeps retrying 8787 so phones that saved
  it reconnect. The "ADE is already running with phone sync" dialog is the
  intended cross-channel case (ADE vs ADE Alpha). Contract:
  [sync and multi-device](../sync-and-multi-device/README.md).
- **Config reload** calls each listener on save; hot reload is best-effort,
  and some changes (the proxy port) need a restart.
- **New `ai.*` fields need both `coerceAiConfig` and `mergeAiConfig`**, or they
  fail to load or to survive the shared+local merge (as `ai.customProviders` /
  `ai.customModelSlugs` did). Both lists use replace semantics; the UI writes
  the full list. See
  [configuration-schema.md](./configuration-schema.md#custom-providers-and-model-slugs).
- **`freshProject`** is computed when `createOnboardingService` is built and
  never updates; a wrong boolean shows first-run surfaces on a used project.
- **Deep links.** `?tab=<id>` is read through `useSearchParams`; old ids resolve
  through `LEGACY_TAB_ALIASES` (see the pages table).
- **Install refreshes before quitting.** `quitAndInstall()` re-runs
  `updater.checkForUpdates()` before `installing`, or ADE could install a stale
  download while a newer build exists. Compare with `compareUpdateVersions`,
  never `===` (`v1.2.3`, `1.2.3-rc.1`, `1.2.3` must order consistently in the
  reconcile and supersede paths).
- **`installing` is sticky; `ready` is not.** While `installing`, the service
  ignores `update-not-available`, `checking-for-update` and `error`. Checks
  keep running while `ready` (same-or-older ignored, newer supersedes, a failed
  check keeps the archive). Only a running `quitAndInstall()` blocks a check:
  status stays `ready` until the handoff, and a supersede then would delete the
  archive being handed to Squirrel or NSIS. See
  [Checking while an update is staged](./desktop-auto-update.md#checking-while-an-update-is-staged).
- **Parked is not failed.** An aborted consent goes to `snapshot.parked`, not
  `error`; the download stays and the banner offers **Restart now**. Keep it
  apart from the disk / network / verification errors, and let parked win over
  `ready` for the same version.
- **Idle auto-apply needs `RuntimeActivitySummary.idle`** and continuous idle
  for the grace period; activity clears the countdown and a cancel sets
  `autoApplySuppressedUntil`. It is off under
  `ADE_DISABLE_AUTO_UPDATE_APPLY=1` and on dev launches.

## Archive

Archiving **hides** a lane, chat or shell; ADE never deletes an archived item
by itself. The only thing ADE deletes on its own is a dead App Control shell.
Project → Deleted & Archived → Archive, `ade archive` and a weekly desktop banner
all read `archive.list` / `archive.summary`.

- **Dead App Control shells are deleted.** An agent-launched shell
  (`launchedBy: "agent"`) nobody typed into is deleted with its transcript once
  dead: at once when a new shell replaces it, after 10 minutes on a clean exit
  or ADE stop, and after its chat settles following a crash. A relaunch by the
  same chat reuses it. Typing into it (`terminal.write { fromUser }` or a hand
  resume) makes it the person's, never deleted. See
  [terminals and sessions](../terminals-and-sessions/README.md#dead-agent-shells).
- **Delete is the person's alone.** `archive.delete` is `ADE_ACTION_USER_ONLY`
  and `archive.restore` is `ADE_ACTION_CTO_ONLY`. The CLI refuses `ade archive
  delete` and points at Settings. Deleting a lane keeps its branch; a dirty
  worktree needs a confirmed forced delete.
- **The reminder asks, never acts.** At most once per project per week, when
  something is older than "Free up space after" (14 days by default); every
  answer (review, snooze, dismiss) pushes the next ask a week out.
- iOS reads the same archive model but has no archive screen or banner.

## Cross-links

- Lane templates used during lane creation: Lanes feature
- Terminal preferences applied at runtime:
  [../terminals-and-sessions/ui-surfaces.md](../terminals-and-sessions/ui-surfaces.md)
