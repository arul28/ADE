# Cloud 5 · Track C: client cleanup and security (report)

Helper: client-cleanup. Nothing committed by me; most of it is in the lead's WIP checkpoint `07e4f0766`.
Uncommitted at the time of writing: the refusal sentence in `remoteMcpCommandPolicy.ts` and my parts of
`docs/logging.md`, `docs/features/ade-cloud/README.md`, `docs/features/sync-and-multi-device/ios-companion.md`.

## 1. Security: no sign-in values at computer creation (Cloud 4 step 2b)

**Before.** `createInstance` for a new cloud computer carried an `env` with every kept sign-in of the old kind,
in the variable its CLI reads: `OPENAI_API_KEY`, `CURSOR_API_KEY`, `FACTORY_API_KEY`, `XAI_API_KEY`,
`COPILOT_GITHUB_TOKEN`, `WINDSURF_API_KEY`, `META_API_KEY`, `OPENROUTER_API_KEY`, plus `CLAUDE_CODE_OAUTH_TOKEN` from
the old `integration/cloud-claude-token` item, plus `ADE_MIN_VERSION`. The Worker and the host saw them in plain text.

**After.** The env holds only `ADE_MIN_VERSION` (and only from a released build). No sign-in value passes the Worker
or the host at creation. Both creation paths: `cloudMachineCreator.ts` (CLI/agent/desktop-bridge make, copy, move)
and `cloudLaneComputerStages.ts` (a new lane on ADE Cloud).

**How a new computer still gets every sign-in** (read in the code; no live computer made):
- Saved ADE Cloud keys: the brain's sign-in sync reads `integration/cloud-key-<id>` from the vault
  (`providerLoginApplyPass.ts` `savedKeyToken` / `desiredPlaces`). Codex's key becomes its `auth.json`; the other
  single-provider keys go in the brain's env while in use; OpenRouter (OpenCode and Pi) is always set when saved;
  Copilot's token goes only to Copilot processes (`providerLoginCopilotEnv.ts`).
- Carried logins (`provider_login`): unchanged, already vault-only.
- Claude: `claudePassSync.ts` adopts the old `cloud-claude-token` item as `claude-pass/legacy` on every brain, and
  makes each pass an account on the cloud computer. Newer passes were never in the env.
- The first turn is covered by the gate before a provider starts (`providerLoginGate`, a vault pull up to 5 s) and
  the pass reconcile before each Claude turn.
- No migration was needed. Computers made before this keep their instance env until deleted; their brain takes the
  variables out at its first apply (unchanged). `cloudSignInBoot.ts` stays for them (it only reads the box's own env).

**The gap: a cloud brain with sign-in sync off gets no keys.** The sync is statically off for an embedded runtime,
a development build (`brainReportsAsRelease` false: an unreleased build, `ADE_DEV_BRAIN`, a source checkout) or a
brain with sync off (`--no-sync`, an ADE home that is not the default, or an installed service brain beside a
hand-run one) — `cli.ts` `staticOff`. **A production cloud computer never runs that way**: the template
(`infra/ade-cloud/template/ade-entrypoint.sh:150`) starts the installed release as `ade --role cto serve` with no
`--no-sync`, `ADE_HOME=/home/node/.ade` (the default home, `Dockerfile:84`), no embedded profile and no service
brain beside it. A computer made from a development desktop gets no `ADE_MIN_VERSION` and runs the template's own
released ADE, so it is a release brain too. Only someone who puts a dev build on a box by hand would hit it, and
then providers ask to sign in there, as before Cloud 4.

Files: `cloudMachineCreator.ts` (no `machineEnv` dep), `cloudLaneComputerStages.ts`, `adeActions/registry.ts`,
`registerCloudIpc.ts` (wiring and the unused vault accessor removed), `cloudSignInStore.ts` (`cloudMachineEnv`
deleted, header), `shared/cloudSignIns.ts`, `cloudSignInBoot.ts`, `ade-cli/src/cli.ts` (comments),
`ai/providerAuthResolvers.ts` (comment).

## 2. Sign-in end warning also covers keys (decision 2)

Which kept keys carry an end date the provider gives: only Cursor's key from the Cursor sign-in (carried login,
class `fixed`, `expiresAt` from Cursor's own `apiKeyExpiresAtMs`). Pasted ADE Cloud keys (`cloud-key-<id>`) carry no
date, and renewing logins renew themselves, so neither is named. No guessed dates.

- `claudePassEndWarning.ts` `readClaudePassEnd(list, now, readSetting?)`: a `fixed` `provider_login` row with
  `expiresAt` is due 7 days before it (`ending`) and `ended` once past. Only keys on for ADE Cloud count: the account
  setting `providerLogins.cloud` (`enabled`, `off`) is read only when a key is due; unreadable counts as on, as the
  sync reads it. Passes and keys share one list: ended first, then soonest; `more` and `fingerprint` cover both.
- `shared/cloudSignIns.ts` `CloudPassEnd`: optional `kind` (`claude_pass` | `key`; absent = pass), `provider`,
  `madeOnLabel`. The renderer state (`state/cloudAccess.ts`) is unchanged.
- `registerCloudIpc.ts` takes `readCloudSignInSetting`; `registerIpc.ts` passes `accountSettingsSyncService.get`.
- Renderer: `adeCloudEndNotice.ts` (key words, `action` label; "more" now says sign-ins), `CloudSignInEndNotice.tsx`
  (the provider's logo; **Replace** opens Settings › Providers › ADE Cloud › that provider, where the person signs
  in again or adds a key; a pass keeps **Renew**).

Validated with a scratch script on fake vault rows: a Cursor key 3 days out → "Your Cursor key for ADE Cloud
(a@b.c) ends in 3 days … Sign in to Cursor again on Mac Studio, or add a new key, so cloud chats keep working.";
ended → "has ended … set it to end on Nov 10"; nothing for 30 days out, a renewing login, a fixed key with no date,
a key in `off`, or `enabled: false`.

Not done: GitHub fine-grained tokens (Copilot's saved key) do expire, and GitHub returns the date in the
`github-authentication-token-expiration` header, but ADE does not read it at save today. Adding it needs a GitHub
call at save and a field in the vault item.

## 3a. ADE MCP may start a cloud lane

- `remoteMcpCommandPolicy.ts`: `isCloudLaneMachineUse` is the reviewed exception to "no `--machine`": every machine
  flag must be exactly `--machine cloud` or `--machine=cloud`, and the subcommand right after the command word must be
  `chat|chats create`, `chat|chats launch-status` or `lanes|lane create`. `--size` was never refused. A list, a second
  machine, a cloud-like name (`cloud:ready`), `--all-machines`, `--machine-project`, `--machine cloud` before the
  subcommand, other subcommands and `chat launch-cancel` stay refused. A start needs full access; read-only can follow
  a launch. The brain answers an ADE MCP app as an unattended agent (agent limits, hours; never the person).
  The refusal sentence now names the exception. Read-only `cloud ready` allowances removed.
- `remoteMcpCommandPolicy.test.ts` (the policy's validation table): +9 refused rows, +4 allowed rows, the `cloud ready`
  rows removed. 139 pass; with the exception forced on, 10 rows failed (restored).
- Docs: `apps/desktop/resources/agent-skills/ade-cloud/SKILL.md`, `docs/features/ade-mcp/README.md`.

## 3b. The old pre-Cloud-3 flow removed

Deleted: `settings/CloudReadyMachinesCard.tsx`, `settings/CloudMachinesCard.tsx` (only `CloudSection` used it),
`remoteTargets/NewCloudMachineForm.tsx`, `remoteTargets/NewCloudMachineDialog.tsx` (only Settings and the
Your computers add sheet used them), `adeCloud/cloudReadyMachines.ts`, `cloudReadyClaim.ts`, `cloudReadySettings.ts`,
`cloudReadyActions.ts`, `cloudReadyMachines.test.ts`, `shared/cloudReady.ts`, `chat/useCloudReadyDraftMachine.ts`
(already unused).

Moved: `patchCloudMetadata` and `wakeThroughTransition` → new `adeCloud/cloudInstanceOps.ts` (importers:
`cloudSleep.ts`, `cloudReconnect.ts`, `cloudMachines.ts`, `cloudMachineCopy.ts`, `ade-cli/.../cloudDiskGrow.ts`);
`CLOUD_READY_WAKE_WAIT_MS` → `CLOUD_WAKE_WAIT_MS` in `shared/adeCloud.ts` (`useDraftMachineSetup.ts`,
`adeCloudLaneBinding.ts`).

Removed:
- Main: the ready keeper, its IPC handlers and `recordReady` in `registerCloudIpc.ts` / `registerIpc.ts`; the
  `IPC.cloudCreateMachine` handler (no caller left once the forms went; `cancelCreate` and `onCreateProgress` stay for
  copy and move; `recordMachineCreate` stays for the bridge create); `readyRefresh` in `cloudDesktopActions.ts`,
  `desktopBridgeServer.ts`, `ade-cli/.../cloudDesktopBridgeClient.ts`; `ready_set|ready_off|ready_retry` and the
  `readySettings` dep in `cloudAgentActions.ts`; `buildCloudReadyActions` in `registry.ts`; `CloudMachine.ready`
  (`shared/adeCloud.ts`, `cloudMachines.ts`) and `readyFor` (`cloudAccountStatus.ts`, `actionInputContracts.ts`);
  `cloud-ready` from the no-project vault items (`cloudVaultItems.ts`). A copy still drops the old `ade_ready*`
  metadata keys (`cloudMachineCopy.ts`) so an older ADE never takes a copy as a ready machine.
- Policies: `ready_status`, `claim_ready`, `release_ready`, `ready_set`, `ready_off`, `ready_retry` from
  `actionPolicy.ts`, `shared/adeActionAccess.ts`, `actionInputContracts.ts`, `adeRpcServer.ts` (approved set) and the
  phone's `CLOUD_REMOTE_READS/WRITES` (`ade-cli/.../syncRemoteCommandService.ts`).
- IPC/preload: the seven `cloudReady*` channels (`shared/ipc.ts`), `ipcTimeouts.ts` cases, `preload.ts`,
  `global.d.ts`, `createMachine` (also the web adapter stub `webclient/adapter/cloud.ts`).
- CLI: `--machine cloud:ready` (`cliMachineTargeting.ts`), `ade cloud ready` (now a usage error that points to
  `ade chat create --machine cloud`), `formatCloudReady`, the `cloud-ready` format, help lines.
- Renderer: the "New ADE Cloud machine" add mode in `RemoteTargetList.tsx`; the ready tag in `CloudMachineGroup.tsx`;
  `ready: null` in `browserMockCloud.ts`. In `CloudSection.tsx` only the removed cards and dialog (before the lead's
  rewrite). The refused-account gates on the remaining cloud rows are in `useCloudMachineGroup.tsx:64-65`.
- Analytics: `cloud_ready`, `ready_picker`, `ready_cli` (`productAnalyticsPolicy.ts`).
- Settings: `integrations.ade-cloud-ready` removed from `settingsManifest.ts` and `settingsAgentAccess.ts`; its old
  hash `#cloud-ready` is a `LEGACY_HASH_ALIASES` entry → `integrations.ade-cloud-spending` (the dashboard already maps
  `cloud-ready` → `cloud-lanes`). There is no id-alias mechanism, only hash aliases.
- iOS: the Ready machines section, `CloudReadyRow`, the "Ready machine" label, `CloudPhoneReadyPool`,
  `CloudPhoneReadyTag` and `CloudPhoneMachine.ready` (`CloudPaneSheet.swift`, `CloudPreviews.swift`,
  `SyncService+Cloud.swift`); the catalog row (`WorkSettingsCatalog.swift`).
- Docs: `docs/features/ade-cloud/README.md`, `docs/logging.md`, `docs/PRD.md`, `ios-companion.md`.

Left on purpose: `cloudReadySetupRunning` in `ade-cli/.../cloudKeepAwake.ts` (the template's entrypoint still runs
`$ADE_HOME/ready/job.sh`; nothing writes one now, comment updated); the `cloud_machine_create` vocabulary.

## 3c. `cloud.clear_caches` asks first

- `cloudAgentActions.ts` `clear_caches` calls `approve(..., { action: "person_only", title: "Clear caches on this
  computer", confirm: "Clear caches" })` before clearing. The person (the dashboard, through the lane computer's pin)
  is not asked again: `CloudDashboard.tsx` already shows its confirm dialog. An agent in a watched chat gets the
  approval card (5-minute time-out = no). A full-auto chat, an automation and an ADE MCP app are declined
  ("only you can decide it"; the person place is the lane's row in Settings › ADE Cloud). `machine` defaults to this
  computer; a call naming another computer is still refused, never run.
- `actionPolicy.ts`: `clear_caches` is no longer user-only (an agent may ask).
- `ade-cli/src/adeRpcServer.ts`: `clear_caches` is in `CLOUD_APPROVED_ACTIONS`, so the server stamps who asks. Without
  it the person's own dashboard call would arrive as a chatless agent and be declined.
- `actionInputContracts.ts` description; the skill says how an agent asks.

## 3d. Launch analytics

`adeCloud/cloudLaneLaunchAnalytics.ts`, `ade_feature_used`, feature `connections`, one coarse outcome each, nothing
else (no lane, project, computer, branch, prompt, size of a computer or error); `productAnalyticsPolicy.ts` allows the
four actions and `size_small|medium|large|xlarge`.
- `cloud_lane_launch`: `completed | failed | cancelled`, counted when the host saw the launch move there from another
  phase (a restart that loads a finished launch counts nothing; a Retry that fixes a failure counts both). Hosts:
  `registerCloudLaneLaunchIpc.ts` (surface `desktop`) and `cloudLaneLaunchBrainHost.ts` (surface `api`), wrapped
  around their `emit`; analytics passed from `registerIpc.ts` and `registry.ts`.
- `cloud_lane_freed`: `completed | failed`, in `registerCloudLaneLifeIpc.ts` `freeLane`.
- `cloud_clear_caches`: `completed | failed | denied`, in the action on the cloud computer's own brain (so it counts
  under that computer's ADE installation, not the person's desktop).
- `cloud_default_size`: `size_<tier>` in `appStore.ts` `setCloudDefaultTier`, only for the person's pick; the account
  settings sync passes `{ synced: true }` (`renderer/lib/accountSettingsSync.ts`) and is not counted.
- No dedupe key: each is a person's decision or a launch that makes a computer; the existing `ade_feature_used`
  ceilings bound them. Documented in `docs/logging.md`.

## Remote scoping (CLAUDE.md)

No new call acts on a lane or computer without its pin: Clear caches keeps its existing pin
(`preload` `clearCaches(pin, …)`); the end warning's setting read is account-level in desktop main; analytics
take no pin; the MCP exception reaches only the connection's own brain, which makes the computer.

## Tests deleted or changed

- `adeCloud/cloudSignIns.test.ts`: deleted the `cloudMachineEnv` block (removed function) and its helpers.
- `adeCloud/cloudReadyMachines.test.ts`: deleted with the code.
- `analytics/productAnalyticsService.test.ts`: deleted the `cloud_ready` loop (removed vocabulary).
- `adeCloud/cloudAgentActions.test.ts`: dropped the `readySettings` dep from its fixture.
- `remoteTargets/cloudMachineModel.test.ts`: dropped `ready: null` from its fixture.
- `remoteMcp/remoteMcpCommandPolicy.test.ts`: rows added and removed (3a).
- No other new tests.

## What I validated

- Typecheck apps/desktop: clean in my files. Errors left, not mine: `settings/cloudDashboard/CloudPlans.tsx` (missing
  `account-directory/src/cloud/contract`, and `CloudPlanId` indexing) and `webclient/shell/webRoutes.ts:53`.
- Typecheck apps/ade-cli: clean.
- Desktop colocated tests, 15 files: 13 pass. Failing, from other tracks: `actionPolicy.test.ts`
  (`cloud.referral`, `cloud.invite_redeem` not declared in `adeActionAccess.ts`) and `settingsManifest.test.ts`
  (`integrations.ade-cloud` no longer under its tab after the move to `ade-cloud`).
- CLI colocated tests (`cli.test.ts`, `cliMachineTargeting.test.ts`, `power.test.ts`,
  `syncRemoteCommandService.test.ts`, the policy table): all pass but one `cli.test.ts` case that picks up this
  agent's own chat session id from the environment ("builds session lifecycle chat commands without inventing a
  session id"); not related.
- End warning: the scratch run in section 2.
- iOS: no Xcode build (another worktree's xcodebuild was running). `xcrun swiftc -parse` passes on the four edited
  Swift files. Needs one simulator build before merge.
- No live cloud computer made, no deploy, no production write.

## Failure modes for /test

1. Security: either creation path (`createCloudMachine`, the lane launch's computer stage) puts any `CLOUD_SIGN_INS`
   env name (or any value from the vault) in `createInstance`'s `env`.
2. A new computer that has only saved keys, or only the old Claude item, does not get them from the vault (the
   `providerLoginApplyPass` key fallback; the legacy pass adoption and the pass account on a cloud computer).
3. End warning: names a renewing login, a fixed key with no `expiresAt`, a key in `off`, or any key with
   `enabled: false`; orders ended after ending; a state change does not change the fingerprint (a dismiss would hide
   a key that ended); a setting read that throws hides a due key instead of counting it as on.
4. MCP policy: any `--machine` value other than exactly `cloud`, on any subcommand other than the three, gets
   through (the table owns this).
5. Clear caches: `clear_caches` drops out of `CLOUD_APPROVED_ACTIONS` (the person's dashboard call is declined); an
   agent's "no" or a time-out still clears; an unattended or MCP caller clears; a call naming another computer runs.
6. Launch analytics: a launch end counted twice, or counted again when a restart loads a finished launch.
7. Default size: a value synced from another computer is counted as the person's pick.

## Not done

- GitHub token expiry for the end warning (section 2).
- iOS simulator build (another build was running).
- `chat launch-cancel --machine cloud` stays refused for ADE MCP (the person cancels), as the brain already refuses an
  MCP cancel.
- The template's ready job runner (`ade-entrypoint.sh`) is untouched; removing it needs a template rebuild.
