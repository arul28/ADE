# Onboarding and Settings

- **Onboarding** gets a computer and a project usable fast. It registers the
  project with the runtime so every client sees it. Opening or creating a
  project lands on Work; AI runtimes, GitHub and Linear live in Settings. No
  setup dashboard blocks the project.
- **Settings** is long-lived configuration, grouped by scope. Project
  configuration saves to `.ade/local.yaml` through `projectConfigService`;
  desktop-install preferences (automatic update installs) save in the Electron
  user-data `ade-state.json`.

Every client (desktop, CLI, hosted web, iOS) asks for a DAEX account on a fresh
launch. A lost or unreadable session is reported as its real state, never as a
guest. The CLI is `daex`; `ade` is a permanent alias (both are `bin` entries in
`apps/ade-cli/package.json`). Files, env vars and folders keep the old name
(`~/.ade`, `ADE_HOME`, `bin/ade`).

Detail docs:

- [configuration-schema.md](./configuration-schema.md): `.ade/local.yaml` and
  the one-time legacy carry-over.
- [first-run.md](./first-run.md): what a first launch does.
- [desktop-auto-update.md](./desktop-auto-update.md): update tracks, staging,
  install and the post-update transaction.
- [usage-tracking.md](./usage-tracking.md): quota windows, history, rollups,
  pricing.
- [agent-tools-cache.md](./agent-tools-cache.md): DAEX's pinned copies of the
  agent CLIs.
- [harness-presets.md](./harness-presets.md): saved harness + model-provider
  pairings.
- [mcp-servers.md](./mcp-servers.md): account MCP servers.
- [project-health.md](./project-health.md), [project-move.md](./project-move.md):
  project checks and moving a project folder.

## Source file map

Paths are relative to `apps/desktop/src/` unless they start with `apps/`.
Renderer components are under `renderer/components/`.

**Launch, account and session**

- `main/main.ts`, `main/services/ipc/registerIpc.ts`: the process-wide account
  launch gate (`ade.app.getLaunchGateState`; one resolve covers every window and
  reload) and IPC handlers.
- `main/services/runtime/machineTrustResetMigration.ts`: the one-time packaged
  reset of pre-account connection grants (see [Machine layer](#machine-layer)).
- `main/services/account/accountBridge.ts`: desktop side of the account
  session; mirrors `sessionState` onto `AdeAccountStatus` and installs the
  brain refresh broker.
- `apps/ade-cli/src/services/account/accountAuthService.ts`,
  `sharedAccountAuthService.ts`, `cliRefreshBroker.ts`,
  `accountSessionRotationJournal.ts`: session state, the brain-owned refresh,
  the rotation journal. See
  [Account session state](#account-session-state-is-a-four-state-not-a-boolean).
- `apps/ade-cli/src/services/account/accountMachineDirectoryService.ts`:
  machine directory ownership. Logout or an account switch removes only that
  owner's remote targets and paired credentials; direct trust (PIN, link,
  Nearby, address, SSH) stays local.
- `apps/ade-cli/src/services/account/accountSettingsStore.ts`,
  `accountVaultStore.ts`, `accountCacheStore.ts`: the owner-tagged account
  settings cache and the encrypted vault cache (see
  [Account settings sync](#account-settings-sync)).
- `main/services/account/accountMigrationRunner.ts`,
  `apps/ade-cli/src/services/account/accountMigrationReceipt.ts`: receipt-backed
  one-time moves after sign-in (provider API keys, Linear refresh credentials,
  old project secrets into Passwords & Secrets). A source completes only after
  the account confirms the write.
- `main/services/account/localMachineIdentity.ts`: the one "which machine is
  this?" key, free of Electron so the desktop and the CLI brain agree.
- `onboarding/LaunchGate.tsx`, `onboarding/GlassSignInCard.tsx`,
  `account/useSignInFlow.ts`: the gate and its sign-in (browser login, device
  login with a QR for another device, brain repair).
- `account/AccountSignedOutBanner.tsx`: the permanent bar while the account is
  unusable, or while the directory refuses this computer
  (`hooks/useThisComputerRefusal.ts`, `renderer/lib/thisComputerRefusal.ts`,
  one reconnect flow per window in `renderer/lib/reconnectThisComputer.ts`).
- `account/AccountPage.tsx`, `account/YourMacsCard.tsx`: account status,
  sign-in/out, **Your computers** (rename, remove, reconnect).
  `shared/reconnectOutcome.ts` holds the reconnect outcome copy, shared with
  `daex machines reconnect`.
- `renderer/lib/account.ts`: `accountSessionState`, `accountSessionNotice`,
  `accountGateMode`: the only branch point for session copy.

**Projects and home**

- `main/services/onboarding/onboardingService.ts`,
  `onboardingSuggestedConfig.ts`: onboarding status, stack detection, suggested
  config from GitHub Actions.
- `main/services/onboarding/onboardingProjectDiscovery.ts`,
  `onboardingDiscoveryClient.ts`: first-run project and chat discovery in a
  child process (`ELECTRON_RUN_AS_NODE`), this computer only.
- `projects/ProjectWelcomePage.tsx`, `ProjectWelcomeHome.tsx`,
  `ProjectWelcomeSidePanels.tsx`: the projectless home (hero, actions, machine
  list, widget grid). The Projects card lists the account's projects
  (`homeProjectRows.ts`, `useHomeAccountProjects.ts`); folders on no account
  project follow under "Only on <computer>".
- `components/home/`: the widget home. `homeGridPack.ts` fits widgets without
  scroll; `homeLayout.ts` keeps named layouts per computer. Main side
  `main/services/home/` behind `ade.home.*`.
- `projects/AddProjectForm.tsx`, `AddProjectMoreActions.tsx`,
  `projectCopyJobs.ts`: **Add project** puts the project on the account and
  opens its tab at once; each ticked computer clones in the background.
- `projects/ProjectCopiesMenu.tsx`, `useProjectCopiesMenu.ts`,
  `projectCopies.ts`: a project's copies, one row per machine.
- `projects/RemoveProjectDialog.tsx`, `shared/projectRemoval.ts`,
  `apps/ade-cli/src/services/projects/projectCopyRemoval.ts`,
  `projectRemovalGuard.ts`, `projectRemovalState.ts`: removing a project
  (see [Removing a project](#removing-a-project)).
- `shared/projectRecord.ts`, `apps/ade-cli/src/services/projects/projectRecords.ts`,
  `main/services/projects/desktopProjectRecords.ts`: one display name and icon
  per repository across the account (`repo:<origin>` rows; last writer wins).
- `projects/CreateProjectForm.tsx`: new empty project.
- Opening a project with no own computer online binds the tab to DAEX Cloud
  (`openAdeCloudProject`, `renderer/state/adeCloudTabs.ts`).

**First run and help**

- `onboarding/FirstRunFlow.tsx`, `FirstRunSteps.tsx`, `FirstRunAgents.tsx`,
  `FirstRunAgentRail.tsx`, `FirstRunChatPicker.tsx`: first-run setup.
  `onboarding/OnboardingBootstrap.tsx` re-shows it over the app.
- `onboarding/useOnboardingChatImport.ts`,
  `renderer/onboarding/pendingChatImports.ts`: chat import on first open.
- `onboarding/tour/`: the guided tour; `renderer/onboarding/onboardingProgress.ts`.
- `renderer/onboarding/adeTips.ts`, `components/onboarding/tips/`,
  `components/onboarding/spotlight/`: DAEX Tips.
- `renderer/onboarding/situationalSuggestions.ts`, `app/suggestions/`:
  situational suggestions.
- `renderer/onboarding/unaskedBudget.ts`, `onboardingSync.ts`,
  `shared/onboardingProgressRecord.ts`: the shared budget and account sync.
- `renderer/components/announcements/`: What's new pages.
- `onboarding/HelpMenu.tsx`, `renderer/onboarding/docsLinks.ts`: help menu and
  doc URLs.
- `app/BootSplashReveal.tsx`, `components/ui/LiquidGlassLogoReveal.tsx`: the
  boot splash.
- `app/PrivacyPolicyUpdateNotice.tsx`, `shared/legalLinks.ts`: the agree line
  and the privacy notice.

**Settings shell**

- `app/SettingsPage.tsx`: the page container. It renders only.
- `shared/settingsManifest.ts`: tabs, groups, every `SettingEntry` (`id`,
  `label`, `keywords`, `tab`, `anchor`, `scope`, `web`), legacy tab and hash
  aliases, search. Shared with `daex settings find` and chat chips.
  `settings/settingsManifest.ts` adds platform, web and standalone rules.
- `settings/settingsTabContent.tsx`: sections per tab and named blocks;
  `primitives/SettingsSectionRail.tsx`: the block rail.
- `settings/primitives/`, `SettingsRows.tsx`, `SettingsModern.tsx`: the control
  and page vocabulary.
- `settings/SettingsMachinesNav.tsx`, `SettingsMachineScope.tsx`: machine pages
  and the page's pin (`useSettingsMachineScope`, `useSettingsMachinePage`).
- `shared/settingsAgentAccess.ts`: which settings an agent may change (see
  [Agent access](#agent-access-to-settings)).
- `shared/accountSettingsScope.ts`, `renderer/lib/accountSettingsSync.ts`,
  `useAccountSettingsSync.ts`: the renderer's account-settings engine.

**Settings pages** (one line per area; files under `settings/`)

- General: `general/GeneralPage.tsx`, `NeedsAttentionStrip.tsx`,
  `MachineUpdateRows.tsx`, `overview/useNeedsAttention.ts`,
  `AutoUpdatesSection.tsx`, `UpdateTrackControls.tsx`.
- Machines: `machines/MachinesPage.tsx`, `MachineSettings.tsx`,
  `MachineWorkCopies.tsx` ("Work from other machines").
- Advanced: `BackgroundServiceSection.tsx` (with
  `services/runtime/backgroundServiceControls.ts`), `AdeCliSection.tsx`,
  `DiagnosticsSharingSection.tsx`, `DatabaseCopiesSection.tsx`,
  `ResetAdeSection.tsx`.
- Behaviour: `KeepAwakeSection.tsx`, `CaptureGestureSection.tsx`,
  `BrowserLinksSection.tsx`.
- Appearance: `AppearanceSection.tsx`, `ThemeGallery.tsx`,
  `ThemeCustomizer.tsx`, `ThemeImportExport.tsx`,
  `AppearanceScheduleSettings.tsx`; themes in `shared/theme/` and
  `renderer/theme/`; backgrounds in `renderer/scene/`.
- Chat: `ChatSection.tsx`, `DictationSection.tsx`, `LaunchPromptSection.tsx`,
  `SmartDecisionsSection.tsx`, `ContinueAfterRestartSection.tsx`.
- Providers: `ProvidersSection.tsx`, `providers/ProviderDetailPage.tsx`,
  `providers/accounts/` (Accounts panel), `providers/keys/` (API keys,
  OpenCode custom providers; field specs in `providerKeySpecs.ts`),
  `providers/ProviderContextPanel.tsx`, `PiProvidersPanel.tsx`,
  `OAuthConnectModal.tsx`, `providers/cliTools.ts`.
- Integrations: `integrations/` (home, MCP catalogue, stuck-computer warning),
  `GitHubIntegrationSection.tsx`, `GitHubSection.tsx`,
  `github/GitHubAppInstallPanel.tsx`, `LinearIntegrationSection.tsx`,
  `LinearSection.tsx`, `JiraSection.tsx`.
- DAEX Cloud: `CloudSection.tsx`, `CloudAgentLimitsCard.tsx`,
  `WebAccountCloudCards.tsx`, `cloudDashboard/CloudDashboard.tsx`.
- Passwords & Secrets: `passwords/PasswordsSection.tsx`, `PasswordDialogs.tsx`
  ([Passwords & Secrets](../passwords/README.md)).
- Lanes: `lanes/LanesSettingsPage.tsx`, `NewLaneSettingsSection.tsx`,
  `LaneTemplatesSection.tsx`.
- Deleted & Archived: `RecentlyDeletedSection.tsx`, `ArchiveSection.tsx`,
  `EveryCopyList.tsx`, `state/everyCopyRead.ts`.
- Disk space: `health/`, `storage/`, `SessionLifecycleSection.tsx`,
  `ProjectSection.tsx` ([Storage and recovery](../storage-and-recovery/README.md)).
- Notifications: `NotificationsSection.tsx`, `ActivitySettingsControls.tsx`,
  `AiFeaturesSection.tsx` (scheduled-work pause and list).
- Usage: `AdeUsageSection.tsx`, `BudgetCapEditor.tsx` and `usage/`
  ([usage-tracking.md](./usage-tracking.md)).
- Connections: `SyncDevicesSection.tsx`, `app/ConnectionsPanel.tsx`
  ([Sync and multi-device](../sync-and-multi-device/README.md)).

**Main-process services behind Settings**

- `main/services/config/projectConfigService.ts`: YAML read/merge/save, AI
  config coercion and merge, lane env init. The parsed file is cached by file
  identity; validation still runs on every read. `laneOverlayMatcher.ts`
  matches lane overlay policies.
- `main/services/secrets/projectSecretService.ts`, `projectSecretEnv.ts`: one
  project's view of Passwords & Secrets and the `.env` export.
- `apps/ade-cli/src/services/providerInstances/providerInstanceStore.ts`: this
  machine's Claude and Codex accounts (see [Provider accounts](#provider-accounts)).
- `main/services/providerAccounts/providerLoginRunner.ts`,
  `machineProviderLoginRunner.ts`: in-app Claude/Codex sign-in in a private
  PTY.
- `main/services/ai/agentCliLoginRunner.ts`, `machineAgentCliLoginRunner.ts`,
  `main/services/shared/cliLoginPty.ts`: the same for Grok, Devin, Muse,
  Copilot, Droid and Kimi (`ai.cliLoginStart` and friends). Success is the saved
  login read back by file fingerprint (`authDetector.ts`), never output text.
- `main/services/ai/providerContextInventory.ts`, `ai/providerContext/`: the
  [Initial context window](#initial-context-window) read.
- `main/services/ai/apiKeyStore.ts`: API key storage names.
- `shared/providerRemediation.ts`: each CLI provider's login command, name and
  docs URL; the only place to edit vendor commands. `installCommand` is always
  `null` (DAEX downloads its own copies).
- `apps/ade-cli/src/services/proxy/`: the local subscription proxy (`daex
  proxy`).
- `main/services/github/githubService.ts`, `githubCredentialHealth.ts`,
  `githubRateLimit.ts`, `credentialReadState.ts`,
  `shared/githubOperationCredential.ts`, `shared/githubServiceHealth.ts`,
  `githubStatusPage.ts`: GitHub credentials (see [GitHub](#github)).
- `apps/ade-cli/src/headlessLinearServices.ts`: the runtime's twin of the
  GitHub and Linear status path.
- `main/services/archive/archiveService.ts`, `shared/archive.ts`: the archive
  (see [Archive](#archive)).
- `apps/ade-cli/src/services/power/brainKeepAwakeService.ts`,
  `main/services/power/keepAwakeService.ts`, `systemSleepConfig.ts`,
  `shared/types/keepAwake.ts`: keep-awake.
- `main/services/runtime/quitPrompt.ts`, `app/QuitPromptHost.tsx`,
  `shared/quitPromptModel.ts`: the quit and restart confirmation.
- `main/services/updates/` and `app/AutoUpdate*.tsx`: auto-update
  ([desktop-auto-update.md](./desktop-auto-update.md)).
- `main/services/tools/agentToolsCacheService.ts`: the desktop half of the
  agent-tools cache ([agent-tools-cache.md](./agent-tools-cache.md)).

**Contracts**

- `shared/types/config.ts` (config schema), `shared/types/core.ts`
  (`AutoUpdatePreferences`, `DEFAULT_AUTO_UPDATE_PREFERENCES`:
  `automaticInstall: false`, `onlyWhenIdle: true`), `shared/types/git.ts`
  (`GitHubStatus`), `shared/types/providerInstances.ts`,
  `shared/types/apiCredentials.ts`, `shared/types/projectSecrets.ts`.
- `shared/ipc.ts` and `preload/preload.ts`: `ade.onboarding.*`,
  `ade.projectConfig.*`, `ade.project.*`, `ade.passwords.*`, `ade.ai.*`,
  `ade.update.*` and the integration channels.

## Gotchas

- **Settings acts on the page's machine.** Machine settings, provider sign-ins
  and storage read `useSettingsMachineScope().pin` and send every call there;
  `null` is only for this computer's machine-global calls.
  `useSettingsMachinePage` keeps the pin stable until the binding key changes,
  so a sync tick does not cancel a provider sign-in. Key effects on `pin?.key`.
- **Account settings are the account's.** Plan, credits, consents and other
  account-wide values come from the account server, stored per account, never
  in `.ade/`, localStorage or one machine's settings. They take no pin.
- **Scope has two axes**: owner (your account or this computer) and coverage
  (everything or one repository). A value holding a path, a port or a hardware
  fact is machine scope; everything else is account scope. `SettingScope` is
  the four combinations.
- **No trust gate, no committed config.** `.ade/ade.yaml` is carried into
  `local.yaml` once and deleted
  ([configuration-schema.md](./configuration-schema.md#no-trust-gate)). Use
  `getEffective`.
- **New `ai.*` fields need both `coerceAiConfig` and `mergeAiConfig`**
  (`projectConfigService.ts`), or they fail to load or to survive the merge.
  Array fields replace; the UI writes the whole list.
- **Config reload** calls each listener on save; hot reload is best-effort,
  and some changes (the proxy port) need a restart.
- **`freshProject`** is computed when `createOnboardingService` is built and
  never updates; a wrong value shows first-run surfaces on a used project.
- **Two GitHub status owners.** The desktop service and
  `apps/ade-cli/src/headlessLinearServices.ts` both build `GitHubStatus`. A
  change to one is dead in the other build.
- **A provider account is a path, not a credential.** Never add a field to the
  provider-account registry that a token would fit in.
- **Phone-sync port 8787.** Binding always tries 8787 first; a brain on 8788
  keeps retrying it (`apps/ade-cli/src/services/sync/sharedSyncListener.ts`).
  The "DAEX is already running with phone sync" dialog is the intended
  DAEX vs DAEX Alpha case.
- **Old links resolve.** `LEGACY_TAB_ALIASES` and `LEGACY_HASH_ALIASES`
  (`shared/settingsManifest.ts`) forward retired tab ids and hashes. Keep an
  entry's id and anchor when moving it. `DEFAULT_SETTINGS_TAB` names the
  landing page, so reordering the sidebar cannot move it.

## Where state lives

| Scope | Location | Owner | Contents |
|---|---|---|---|
| Machine | `~/.ade/` (`ADE_HOME` overrides; Alpha uses `~/.ade-alpha/`) | runtime (`daex serve`) | socket, `projects.json`, `provider-instances.json` and `provider-homes/`, encrypted `secrets/`, `bin/ade`, natives, logs, `keep-awake.json`, account settings and vault caches |
| Desktop install | `<Electron userData>/ade-state.json` | desktop main | recent projects, update handoff state, automatic-install preferences |
| Project (local) | `<project>/.ade/local.yaml` | `projectConfigService` | per-user, gitignored config |
| Project (data) | `<project>/.ade/` | various | lanes, attachments, databases, generated assets |
| Renderer | localStorage | renderer | per-computer UI state: appearance, keybindings, terminal preferences, capture-gesture switch, suggestions |
| Account | account settings store | account server | `account` and `account-repo` scoped settings, onboarding progress, secrets vault |

- **Registry writes are serialized.** The desktop, the brain, the CLI and a
  project move all write `projects.json`. Each write
  (`ProjectRegistry.mutate`) holds `projects.json.lock`, reads fresh and
  appends to `projects.journal.jsonl`.
- **Project ids** hash the folder as this machine resolves it. When that
  differs from the stored id, the stored id becomes an alias in
  `project-aliases.json`.
- **Missing data stops open.** If a registered project's folder, `.ade` folder
  or recorded database (`~/.ade/project-data/<projectId>.json`) is missing,
  open stops with `project_data_missing` before creating new state. The
  desktop shows a recovery screen (Restore from Trash, put it back, Start
  fresh).

## Onboarding

### Machine layer

`LocalRuntimeConnectionPool` drives it at desktop launch.

1. **Reset pre-account machine trust** once, packaged builds only: removes
   `remote-machines.json`, `desktop-paired-machines.json`,
   `sync-paired-devices.json` and the runtime-host grants. Sessions, identity,
   the PIN, projects and SSH files stay. The marker completes only after the
   forced service restart is confirmed.
2. **Bring up the runtime.** Attach to `~/.ade/sock/ade.sock`, else spawn
   `daex serve --socket <path>` from the bundled CLI. `initialize` checks the
   version and a build hash (`ADE_RUNTIME_BUILD_HASH`); a mismatch raises
   `LocalRuntimeCompatibilityError`, and the pool replaces the stale runtime.
3. **Register a login service** (`daex serve --install-service`,
   `apps/ade-cli/src/serviceManager/`: launchd, systemd, Windows startup),
   reported as `LocalRuntimeStatus.serviceInstall` / `serviceHealth`.
4. **Put `ade` on `PATH`** via `window.ade.adeCli.installForUser()`
   (Settings → Advanced). DAEX-launched agents always get the bundled CLI.
5. **Register projects.** Opening one calls `ensureProject(rootPath)` →
   `projects.add`, so every client sees it.

Project open runs a cheap first pass: lanes load without per-lane status;
provider modes and full lane status warm later.

### Headless install

For machines without the desktop app:

```bash
curl -fsSL https://ade-app.dev/install.sh | sh     # macOS, Linux
irm https://ade-app.dev/install.ps1 | iex          # Windows PowerShell
```

- Downloads the static CLI binary (a Node SEA) and its natives into
  `$ADE_INSTALL_DIR` (or `~/.ade/bin`) and `~/.ade/runtime/<arch>/`, and sets
  up `PATH` (opt out with `ADE_INSTALL_NO_PATH=1` / `-NoPath`).
- Registers through `daex brain start`, which pins the default role to `cto`.
  `serve --install-service` alone would land on `agent` and break sign-in.
- Then `daex setup`: pinned agent CLIs, account, desktop app, an end-to-end
  check and a summary; re-runnable. `daex connect --headless` signs in with no
  browser.
- Flow and overrides: [`apps/ade-cli/README.md`](../../../apps/ade-cli/README.md).

### First run on a computer

Runs once per computer (`welcomeVideo.completedAt` / `dismissedAt` in global
app state) on the computer DAEX opens on. `npm run dev:desktop -- --first-run`
walks it as a new user
([local development](../../development/local-development.md#walk-first-run-setup-as-a-new-user)).

1. **Welcome** card (**Get started**, **Skip setup**; skipping still leaves the
   tour).
2. **Sign in**, if there is no session.
3. **Connect your agents**: every provider on a rail with its status
   (`ai.getStatus`, works before a project opens) and the Settings sign-in
   flows on this computer. Left out when the front tab is on another machine.
   Status is re-read on open, after a sign-in, on focus and when the tools
   cache finishes; never polled.
4. **Bring your projects in**: `app.discoverOnboardingProjects` reads
   provider histories (Claude transcripts, Codex's thread index, other
   importers; time-boxed per provider) and maps folders to git projects. A
   project with two or more chats in 30 days starts ticked. An **Import N
   chats** pill (off by default) opens a per-chat picker.
5. **Into DAEX**: chosen projects join recents and open as tabs. On first open
   `useOnboardingChatImport` imports up to 25 chats from the last 30 days into
   the lane each ran in, minus the excluded ones (`excludedKeys`).
6. **The tour** (`onboarding/tour/`): six cards inside a project the person
   opened, never on Home. With no chats, step 5 is **Send your first chat** on a
   cheap model (not saved as last-used). Leaving pauses it; **Skip tour** ends
   it and every hint; "Show me around again" restarts it.

DAEX Web shows only the welcome card, to an account that has not started
onboarding anywhere (`webWelcomeDue` in `FirstRunSteps.tsx`).

CTO first run is the model picker: a project with no stored CTO model opens on
`CtoWelcome` ([CTO › Welcome](../cto/README.md#welcome)).

### What's new pages

`renderer/components/announcements/`: each page is a component in `pages/`
with one entry at the top of `ANNOUNCEMENT_PAGES` (`announcementPages.ts`,
through `lazyPage`). The default component takes `{ close }`.

- **Once per page per account**, keyed by `id`: a local copy and the account
  setting `announcements.seen` merge across devices
  (`shared/announcementsSeen.ts`). Use a new `id` to reshow.
- **When**: inside a project, a few seconds after it opens, with no dialog,
  setup or tour, after onboarding ended on an earlier launch, and only when the
  unasked budget allows. A page older than the account or than 21 days never
  shows by itself. After an update this computer installed, up to two unseen
  pages then the release notes show after the splash.
- A self-opening showing waits for its first page's code to load, so the window
  never opens empty. Help › What's new shows every page at once.

### The agree line and the privacy policy notice

Every sign-in path shows "By continuing, you agree to DAEX's Terms and Privacy
Policy": `GlassSignInCard.tsx` (desktop gate, DAEX Web, `/sign-in`), the
account directory's device-code pages (`apps/account-directory/src/brandPage.ts`),
`daex login` and the iPhone's `AccountSignInView`. Links come from
`shared/legalLinks.ts`; iOS keeps literals (SwiftUI parses Markdown links only
in a literal).

When the policy changes, existing users see "We updated our Privacy Policy"
once (`app/PrivacyPolicyUpdateNotice.tsx`; iOS `PrivacyPolicyNoticeBanner`).
The seen version is per device: it is a notice, not a consent. It does not
spend the unasked budget. To reshow it, change `LAST_UPDATED`
(`apps/web/src/app/pages/PrivacyPage.tsx`), `PRIVACY_POLICY_VERSION`
(`shared/legalLinks.ts`) and the iOS `PrivacyPolicyNotice.version` together.

### DAEX Tips

Help › DAEX Tips, the palette, the Home widget or the tour's last card open a
tile wall of features (`renderer/onboarding/adeTips.ts`). **Try it** navigates
and rings the control with the spotlight; it makes no machine call.

**Tip cards** (`useFeatureTipCard`): one untried tip in the corner, at most two
a week, two days apart, within the unasked budget, never during onboarding and
never while a chat or CLI turn runs in the open project (`useAgentBusy`). Tips
with `card: false` never become cards; DAEX Web never offers a `desktopOnly`
tip.

Testing: `npm run dev:desktop -- --first-run --keep`, and the dev palette
commands **Dev: Suggestions test mode** and **Dev: Reset Tips, suggestions
and What's new**.

### The unasked budget and onboarding sync

Everything DAEX shows unasked (What's new opening by itself, tip cards,
surveys, situational suggestions) shares one budget
(`renderer/onboarding/unaskedBudget.ts`): at most one per 20 hours, nothing in
a new account's first three days. A suggestion is never held back by it, but
spends it. The sidebar nudges (invite, star) have their own schedule
(`lib/nudgePill.ts`) and wait while the tour runs.

Onboarding progress is one account setting, `onboarding.progress`
(`shared/onboardingProgressRecord.ts`). `onboardingSync.ts` reconciles on open,
sign-in, a remote settings change and shortly after a local change: later times
win, tips join, and "Show me around again" sets `resetAt`, which drops older
tour and hint answers everywhere. The loop is `renderer/lib/accountValueSync.ts`.
The desktop goes through its brain, DAEX Web through the account. Signed out or
offline, the local copy decides. No polling.

### Situational suggestions

A bottom-right card shown only on a signal: what, why now, one action, **Not
now** (snoozes the kind two weeks and files it under DAEX Tips with **Don't
suggest again**).

- Rules (`renderer/onboarding/situationalSuggestions.ts`, per computer): one
  card per signal, at most one new card per launch, none for four hours after
  the last, none during the tour or before onboarding ended on an earlier
  launch.
- `app/suggestions/SituationalSuggestions.tsx` (in `AppShell`) holds one hook
  per signal; the signals include a low plan limit, `@machine` mentions, a
  secret pasted into a chat, an unconnected tracker link, three working chats
  without the grid, a repeated prompt, no paired phone, stacked PRs and a
  git-ignored `.env` ([The `.env` tip](../passwords/README.md#the-env-tip)).
- Send-time checks (`chatSendSignals.ts`) read only the typed text, so they
  work for a chat on any machine. Nothing polls. Preview with
  `?mockSuggestion=<id>` (`browserMock.ts`).

## Settings

Settings is organised by **scope**: the sidebar group says where a setting
saves. Groups and tabs are `SETTINGS_GROUPS` and `SETTINGS_TABS` in
`shared/settingsManifest.ts`.

| Group | Saves to | Tabs |
|---|---|---|
| **General** | — | General (where Settings opens) |
| **You** | your account | Account, Usage, Sharing (desktop only) |
| **App** | your account, or this computer where noted | Chat, Providers, Integrations, DAEX Cloud, DAEX MCP, Notifications, Appearance, Behaviour, Apple devices, Android devices, Keyboard, Passwords & Secrets |
| **Project** | the open project, on its machine | Lanes, Agents, Deleted & Archived, Disk space, Location |
| **System** | this computer or the picked machine | Machines, Advanced |

- **No Save button.** Controls persist on change and flash "Saved".
- **Search** filters cards by `data-settings-anchor`; Cmd-K has one entry per
  tab and per setting from the same manifest.
- **The web** reads each entry's `web` scope. Secrets, providers, GitHub
  credentials, dictation, the CLI installer, auto-updates, storage, session
  lifecycle and lane templates are `hidden` there. `webOnly` entries (the
  **AI accounts** card, the Passwords notice) show only on the web.
- **Per computer, never synced**: appearance (theme, fonts, background,
  schedule), keybindings, terminal preferences, the capture-gesture switch.
  They are not in `ACCOUNT_SYNCED_SETTINGS` (`renderer/lib/accountSettingsSync.ts`).
- **Settings holds the project sidebar open**: its toggle is disabled and
  Mod+B does nothing; leaving restores the saved preference. A machine-scoped
  page is never kept as a project's start page (`isMachineScopedSettingsRoute`).

**General** has Needs attention, the You and This machine cards, and the DAEX
card (version, track, the one restart action, automatic installs, an update
row per machine). Needs attention lists only real problems: a provider counts
only when it is used and cannot start chats; a failed read is a "couldn't
check" row; a project row can be ignored per folder
([project-health.md](./project-health.md#ignoring-a-check)).

**Other machines** are reached from Machines or the Providers picker. A
machine's page reads and writes through its pin; a row only that machine can
change shows its value and "Change on that machine". GitHub and Linear calls
carry the page's pin; browser steps open on this computer, and Linear browser
sign-in is not offered for another machine (its callback cannot reach it).

**Project pages** read from the project's machine. Deleted & Archived reads
every online copy at once (not an asleep DAEX Cloud computer) and acts on each
row's own pin. A machine change clears the previous machine's data first.

### Settings with no project

The new-project screen's **Settings** button sets `standaloneSettingsOpen` and
opens `/settings` in standalone mode. Only project-free settings show (no
`account-repo` / `machine-repo` entries); Integrations shows only account
pages; mixed pages show "Open a project to change these."
(`ProjectSettingsNotice`). It ends on a new tab, Back, closing the tab or
opening a project.

### Agent access to settings

`shared/settingsAgentAccess.ts` lists settings an agent may change (lanes, lane
templates, agent notes, secrets); everything else is the user's. The brain
enforces it: `ADE_ACTION_CTO_ONLY` on user setting writes (`USER_SETTING_WRITES`
in `adeActions/actionPolicy.ts`) and `ownerOnlyProjectConfigChange` for an
agent `project_config.save` touching keys outside
`AGENT_EDITABLE_PROJECT_CONFIG_KEYS`. An agent can still hand-edit
`.ade/local.yaml` (a known gap).

### Account settings sync

- **Renderer** (`renderer/lib/accountSettingsSync.ts`): local-first
  write-through. Only `account` and `account-repo` scopes reach the store. An
  `account-repo` key is `repo:<host>/<owner>/<repo>` from the canonical origin
  (a GitHub SSH alias is resolved through `ssh -G`). Per-device account values
  key as `device.<syncDeviceId>.<key>`.
- **Brain cache** (`accountSettingsStore.ts`): settings are non-secret and
  survive sign-out. A sync pulls every page before ready. **One refused item
  never blocks the queue**: refused items park with a reason and retry hourly.
  **Older writes lose**: the Worker refuses a write older than the stored row.
  `health()` shows in Settings › DAEX MCP.
- **Vault cache** (`accountVaultStore.ts`): encrypted, purged on sign-out or
  account switch, never reaches the renderer settings bridge.

### Themes and backgrounds

- `shared/theme/library.ts`, `resolve.ts`, `renderer/theme/applyTheme.ts`:
  `ADE_THEME_FAMILIES`, each with dark and light variants;
  `LEGACY_THEME_ID_ALIASES` maps retired ids. The app sets `data-theme` and
  `data-theme-id` on `<html>`. See [design/theming.md](../../design/theming.md).
- `renderer/theme/appearanceSchedule.ts`: up to eight start times, each a whole
  look; a manual change holds until the next start. Per computer.
- `renderer/scene/`: the window background (plain, gradient, image, shuffle).
  User pictures live in IndexedDB, never on disk or in sync. See
  [visual language](../../design/visual-language.md).

### Keeping the machine awake

**Keep this Mac awake while agents work** (Behaviour, `keep-awake`) is one
radiogroup. The selected machine's brain stores it in
`<ADE_HOME>/keep-awake.json`, so it holds after the desktop quits.

| Level | What it does | Where |
|---|---|---|
| `never` (default) | Holds nothing; turns pause when the machine sleeps. | everywhere |
| `while-away` | One OS wake lock only while work runs: macOS `caffeinate -i -w <brain pid>`, Windows `SetThreadExecutionState`, Linux `systemd-inhibit` (plus `gnome-session-inhibit` under GNOME). Stops idle sleep, not the lid. | macOS, Windows, Linux with systemd |
| `lid-closed` | `pmset -a disablesleep 1` through the authorization dialog. Machine-wide; outlives DAEX. | macOS only |

- **A wake lock stops idle sleep only.** No code or copy may imply it survives
  a closed lid. Only `pmset -a disablesleep` does; it is root-only, so the
  level asks for a password and warns that it stays on.
- **The lock follows the work.** A 5-second brain poll counts active agent
  turns and running agent CLI sessions. A failed read releases the lock.
- **The OS idle timer.** The section reads it (`pmset -g custom`, `powercfg`)
  and offers a fix when a non-zero timer would stop agents.
- **Routing.** A pinned machine uses the `keep_awake` action; this computer
  uses the brain method `keepAwake.call`. macOS admin prompts run in the local
  desktop; a remote Mac is sent to its own Settings. Hosted web shows the inert
  snapshot.
- When the machine sleeps anyway, see
  [chat → When the host machine sleeps](../chat/README.md#when-the-host-machine-sleeps).

### Capturing a window with a key gesture

**Behaviour → Capture with a key gesture** (`CaptureGestureSection.tsx`) arms
the global chord (both ⌘ on macOS, both Ctrl on Windows); see
[Capture gesture](../capture-gesture/README.md).

- Machine scope, hidden on the web, stored in localStorage
  `ade:capture-gesture:enabled` (default on): each Mac has its own Screen
  Recording grant. `GlobalCaptureGestureHost` pushes it to main on mount.
- The card shows helper health (`permission_denied`, `monitor_unavailable`,
  `missing`) with the fix for each. Linux shows
  `CAPTURE_GESTURE_UNSUPPORTED_BLOCKER`.
- `captureGestureBridgeAvailable()` uses an `in` probe, because the hosted web
  adapter's proxy fabricates `window.ade.captureGesture`.

### Background service and reset

- **Background service** (Advanced): who runs agents, working chats, **Stop and
  quit DAEX** and **Ask before quitting**. Stop fails closed
  (`services/runtime/backgroundServiceControls.ts`): it refuses when DAEX cannot
  read what runs, when an agent started after the confirm, during a lane delete
  or a Repair. Packaged builds only.
- **Send a report to DAEX** (`DiagnosticsSharingSection.tsx`): the manual
  report, capped per install per day
  ([Auto-send](../storage-and-recovery/README.md#auto-send)). Product analytics
  has no Settings switch: off under `DO_NOT_TRACK=1` or a stored opt-out
  ([logging](../../logging.md)).
- **Reset DAEX** (`ResetAdeSection.tsx`, anchor `reset-ade`): this machine
  only.

## Providers

`ProvidersSection.tsx` has one page per provider, for the machine picked at the
top. A forced status read after a setup, key or sign-in re-reads only that
provider's model list on that machine (`refreshRuntimeCatalogsForMachine`).
For the ACP providers the page-open diagnostics read
(`ai.acpProviderDiagnostics`) never wakes a sleeping cloud computer; **Run
doctor** does.

- **Sign-in** happens in-app on the owning machine: Claude and Codex through the
  account sheet, Cursor and Antigravity through their browser sign-ins, Grok,
  Devin, Muse, Copilot, Droid and Kimi through `agentCliLoginRunner.ts`, Pi in
  `PiProvidersPanel.tsx` (DAEX stores nothing typed into a Pi prompt), OpenCode
  subscriptions in `OAuthConnectModal.tsx` (settles on
  `onOpencodeOAuthStatus`, no polling). On DAEX Cloud, Qwen Code signs in with
  a DashScope key (`shared/cloudSignIns.ts`).
- **OpenCode** groups subscriptions, API provider keys, a searchable provider
  list from models.dev, local model servers (LM Studio, Ollama) and custom
  providers (`ai.customProviders`, `ai.customModelSlugs`). The opencode.ai
  sign-in is copied to DAEX Cloud and other computers without its refresh
  token ([OpenCode's sign-in](../ade-cloud/README.md#sign-ins-in-the-account-vault)).
- **Background helpers** (names, idle status lines) use one cheap model per
  provider (`shared/backgroundUtilityModel.ts`): Haiku 5.5 low for Claude,
  GPT-6 Luna low for Codex, Composer 2.5 for Cursor, else the session's own
  model. There is no picker.
- **Scheduled work** (`AiFeaturesSection.tsx`): **Pause all scheduled work**
  (`ai.chat.scheduledWorkPaused`) pauses Claude wakeups, cron and `/loop`
  without disarming; **Active scheduled work** lists the durable jobs and
  cancels one exactly.

### Provider accounts

A machine can hold several Claude and several Codex logins. Each is a config
directory selected at launch by `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. Other
providers have one identity per machine.

- **Registry**: the brain owns `provider-instances.json` in the machine DAEX
  home. It is not a SQLite table, because every table with a primary key
  replicates as a CRR to devices where these paths mean nothing. New accounts
  get `<adeHome>/provider-homes/<provider>/<instanceId>/` (`0700`). DAEX never
  reads, copies or revokes the credentials inside.
- **The default account is synthesized on read**: id = provider slug, home
  resolved each read by `providerConfigHomes.ts`, never stored (a frozen path
  would break once a user sets `CLAUDE_CONFIG_DIR`).
- **Accounts have no names.** Surfaces show the signed-in email, else the id
  (`<provider>-<n>`, what `--instance` takes).
- **Action domain `provider_instances`** (`list`, `create`, `remove`,
  `setDefault`, `getSettings`, `setSettings`, `loginStart`, `signOut`,
  `refresh`, …), agent tier, no CTO gate. Also `daex providers accounts
  list|add|remove|default`.
- **Removing** signs the account out first and forgets it; its folder stays.
  The machine's own login and the current default refuse removal.
- **Per-provider settings** (`smartBalance`, `autoStartWindows`) live in the
  same file, default off. Smart balance picks the account with the most weekly
  room relative to its reset, gated on five-hour room
  (`main/services/usage/accountBalance.ts`). A running chat stays on its
  account; at a usage limit it moves.
- **Per-account settings** (⋯ menu): auto-compact override, Claude's subagent
  and main prompt cache TTL (`claudeAccountPromptCacheEnv` sets
  `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` / `CLAUDE_CODE_PROMPT_CACHE_TTL`; not
  added when the env already sets one or on a preset/stored credential), and
  **Stop the turn** on Claude extra usage (`onExtraUsage: "stop"`; one request
  is billed first because Claude reports after the response).
- **Same login twice**: one card owns an email (`sameLoginOwner`); the others
  show `Copy`, add no quota and are skipped by balance.
- **Replaced login**: when a home's email changes, the card says the old email
  is signed out here and offers **Sign it back in** or **Dismiss**.
- **Add account** creates the account and runs `provider_instances.loginStart`;
  the sheet polls `loginStatus`. For another machine and hosted web, Codex
  uses `--device-auth` so the browser need not reach a localhost port.
- Hosted web hides provider pages but shows the web-only **AI accounts** card
  with the same panel for Claude and Codex.

### API keys

Every provider page has an **API keys** panel: label, exported variable, masked
tail, source (Local store, Environment, Project config). Only Local store rows
can be replaced or deleted. The add sheet asks only for fields the harness reads
(`settings/providers/keys/providerKeySpecs.ts`).

- **One key store**: the account vault kind `provider_api_key` holds every key
  for every computer and DAEX Cloud. Names are `<provider>` for the default and
  `<provider>#<credentialId>` for others (`credentialStorageKey`,
  `main/services/ai/apiKeyStore.ts`). A DAEX Cloud key goes to
  `<provider>#ade-cloud` when the default holds a different key.
- **This computer only**: a local key the account lacks is tagged so; saving it
  again while signed in moves it to the account.
- `ai.api_credentials.index.v1` stores labels, endpoints and masked tails,
  never secrets.

### Initial context window

Every provider page has a read-only card of what a new chat receives before the
first message, on the page's machine: the provider's part, DAEX's, the user's
setup and the project's. DAEX items are measured from the real launch builders
(dry-run); files are estimated (about 4 characters per token). The total is the
median first request of one-request chats from the turn ledger when there are
at least three. The reveal button works only for this computer
(`ai.revealProviderContextPath`, allowlisted). Both calls take the page's pin;
an older DAEX without the action hides the card.

## GitHub

- **Credential order** (`shared/githubOperationCredential.ts`): env > app > gh
  > pat > account_app > account_gh for reads; writes skip `app` (read-only).
- **Fallback**: 401/403/429 and permission errors move to the next source.
  Invalid or denied credentials cool down five minutes; rate limits honour
  GitHub's reset. An exhausted user quota pauses every credential of that
  account instead of cycling tokens.
- **Outage vs broken credential** (`shared/githubServiceHealth.ts`,
  `githubStatusPage.ts`): only after a failed request, githubstatus.com is read
  (cached 60 s); a corroborated incident turns the card neutral and never
  blames the user. See
  [pull requests](../pull-requests/README.md#telling-a-github-outage-apart-from-a-broken-credential).
- **Publishing** routes with `resolveGithubCreateRepositoryRoute`
  (`shared/githubApiPath.ts`) and refuses a repository whose owner is not the
  requested one before `git remote add`.
- **How GitHub connects** is an account setting: **GitHub CLI only** uses
  `gh auth login`; **App, token or CLI** restores every choice.
- **The DAEX GitHub App** (`github/GitHubAppInstallPanel.tsx`,
  `renderer/lib/githubIntegrationStatus.ts`) has two axes: the account token
  (`valid` / `blocked` / `needs_reauth` / `missing`) and the repo install.
  **Never judge the account by `expiresAt`**: the token lives 8 hours and renews
  on use. `describeGithubCliBanner` resolves in a fixed order: unreadable store,
  then no token, then an outage. Device flow, token store and refresh lease live
  in `githubAppUserAuthService`
  ([automations](../automations/README.md#github-relay-and-app)).

### GitHub connection status has the same third state

`github.token.v1` and `github.appUserToken.v1` fail like the account session:
an undecryptable store returns an empty view that looks like a fresh install,
and a reconnect would overwrite credentials that were only unreadable.

| `GitHubStatus` answer | What is true | What the surface offers |
| --- | --- | --- |
| connected | A credential validated by `GET /user` and, where needed, the repo probe. | Nothing; `writeAuthSource` still gates mutations. |
| not connected | The store read fine and holds no usable credential. | `gh auth login` steps or a token field. |
| `credentialStoreUnreadable` | The store could not be opened on this read. | Say so and offer repair, never a reconnect first. |

- `credentialReadState.ts` returns a credential and its readability in one
  call; `getLastReadState()` describes only the latest read.
  `github.appUserToken.v1` is file-backed and shared with the brain;
  `github.token.v1` is Electron-only, so a locked OS keychain hides only that
  half.
- **Waiting is not unreadable.** Until the OS store answers its first check,
  reads are waiting (`isSecureStorageCheckPending()`), nothing is cached, and a
  granted prompt shows keys without a restart.
- Every surface resolves the third state before `!tokenStored`: Settings
  (**Can't read sign-in**, **Open connections**), the app-shell banner
  (`IntegrationBanners.tsx`), the PR tab's empty state and Publish to GitHub.
  `GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY` (`shared/types/git.ts`) is the one
  wording. The Connections panel's account header runs `account.repairSession`.
  A new token write clears the flag.

## Account session state is a four-state, not a boolean

`AccountAuthStatus.sessionState` (mirrored as `AdeAccountStatus.sessionState`)
separates three ways of not being signed in, because treating them alike
destroys good sessions.

| State | What happened | What the surface says |
| --- | --- | --- |
| `active` | Signed in. | — |
| `signed_out` | No session on this machine. | Offer sign-in. |
| `expired` | The issuer definitively rejected the grant. | Say it expired; offer sign-in. |
| `unreadable` | The credential store could not be read this time. | Say nothing changed; offer repair; demote sign-in to "Sign in anyway". |

- **Why `unreadable` matters.** A new sign-in overwrites the stored session.
  Surfaces branch only through `accountSessionState` / `accountSessionNotice`
  (`renderer/lib/account.ts`); `unreadable` leads with `BrainRepairButton`.
- **Repair repairs the store.** `account.repairSession` converges the store's
  key binding, merges back anything a peer set aside, then restarts the brain.
  `accountBridge.status()` runs one automatic repair on the first `unreadable`
  read per desktop process.
- **A rejected grant is marked dead, not deleted** (`rejectedAt`,
  `needsReauth`). Deleting would make every process forget the account and drop
  the relay tunnel and directory row.
- **Ownership is not usability.** `accountSessionRetainsMachineOwnership` is
  true for `active`, `expired` and `unreadable`; paired reachability survives a
  token accident. See
  [remote runtime](../remote-runtime/README.md#account-state-and-reachability).
- **Only the brain exchanges the refresh credential.** Other processes ask it
  for an access token through a refresh broker; a missing brain falls back to a
  local exchange. Only a definitive `invalid_grant` marks a session dead.
- **Rotation is crash-safe.** `accountSessionRotationJournal.ts` records an
  exchange start; a surviving entry means the token may be consumed, so the
  next `invalid_grant` is not definitive. `tryBegin` compare-and-swaps it, so a
  live peer is waited out, never raced.
- **Every mutation logs** one `account.session_mutation` line (action, reason,
  source, a truncated hash of the token).

## Archive

Archiving **hides** a lane, chat or shell; DAEX never deletes an archived item
by itself. Settings → Deleted & Archived, `daex archive` and a weekly desktop
banner read `archive.list` / `archive.summary`.

- **Delete is the person's alone**: `archive.delete` is `ADE_ACTION_USER_ONLY`,
  `archive.restore` is `ADE_ACTION_CTO_ONLY`. Deleting a lane keeps its branch;
  a dirty worktree needs a confirmed forced delete.
- **The reminder asks, never acts** (`app/useArchiveReminderBanner.tsx`): at
  most once per project per `ARCHIVE_REMINDER_INTERVAL_MS` (a week), when
  something passes the machine's "Free up space after" (14 days by default).
- The one exception: a dead agent-launched App Control shell nobody typed into
  is deleted
  ([terminals and sessions](../terminals-and-sessions/README.md#dead-agent-shells)).

## Removing a project

**Remove project…** removes the entry from the tab's machine, or with **Remove
from all my machines** from every copy. Folders stay by default. With **Also
delete the folders**, each machine reports its copy (`projects.inspectRemoval`):
copies with unpushed work need ticking by name, running copies cannot be
ticked, and each machine re-checks right before deleting
(`projectRemovalGuard.ts`: only an exact registered root holding no home, DAEX
home or other project). This computer's folders go to the Trash; others are
deleted for good. Offline machines are never called.
