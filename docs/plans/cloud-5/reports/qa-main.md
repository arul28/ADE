# Cloud 5 · /quality Track A2 · main process, preload, shared, CLI (correctness and security)

Reviewer: qa-main (Opus 5.5). Base `202dc0676` (#2165), diff = committed WIP + the working tree.
Scope: `apps/desktop/src/{main,preload,shared}/**`, `apps/ade-cli/**`, `apps/desktop/resources/agent-skills/**`.
Review only: no file other than this report was changed.

Checks run: `npm run typecheck` in `apps/ade-cli` is clean. In `apps/desktop`, main, preload and shared are clean.
The renderer has 5 errors, outside this track (see "Outside my scope").

## Summary

| # | Severity | What | Fix |
|---|---|---|---|
| H1 | High | `cloud.invite_redeem` is "CTO-only" by role alone: a full-access ADE MCP app and a chatless orchestrator run can redeem. The person's own `ade cloud invite redeem` is refused. | needs human |
| M1 | Medium | The ADE Cloud approval card is not a consent card, so any agent can answer "Clear caches" (and every other ADE Cloud card) with `chat.respondToInput`. | needs human |
| M2 | Medium | The end warning for keys names expiring keys that ADE Cloud does not use (only one sign-in per place is in use). | unambiguous |
| L1 | Low | The end warning reads the setting through a silent `.catch(() => null)`. | unambiguous |
| L2 | Low | `ade://invite/<CODE>` is written to the main log in full (`url: rawUrl`). | unambiguous |
| L3 | Low | The new `ade-cloud.plans` (billing) and `ade-cloud.sizes` entries fall back to the agent-access reason "preference". Plans should be "money". | unambiguous |
| L4 | Low | The computer id header goes to `/cloud/access` for every signed-in account, including refused ones. | needs human |
| L5 | Low | The free-plan gate trusts the client: no header means the account keeps its free hours. An env var turns the header off. | needs human (by design) |
| L6 | Low | Ready machines and the `cloud-ready` vault setting that existed before this branch are never cleaned up. | needs human |

Verified with no finding:
- Cloud 4 step 2b
- the MCP `--machine cloud` exception
- the `providerLogins.*` sync commands
- item 14's origin order and the remote case
- removal of the ready-machine flow
- the #2165 merge in scope
- hiding ADE Cloud in the CLI and ADE MCP
- Windows and Linux parity

Details are under "Checked, no finding".

---

## H1 · High · `invite_redeem` is guarded by role only

**Where**
- `apps/desktop/src/main/services/adeActions/actionPolicy.ts:146`: `cloud: { only: [...USER_SETTING_WRITES.cloud.actions, "invite_redeem"] }`.
- `:452`: the action is machine-scoped.
- `:1190`: the action is in the allowlist.
- `apps/ade-cli/src/cli.ts:21115-21123` (`ade cloud invite redeem`) and the help line at `cli.ts:4791`.
- `apps/desktop/src/main/services/adeCloud/cloudAgentActions.ts:936-955`.

**Evidence**
- `ADE_ACTION_CTO_ONLY` is checked in `adeActionCallerRefusal` (`actionPolicy.ts:541`) as `callerHasRoleAtLeast(role, "cto")`. Nothing else is checked.
- `invite_redeem` is not in `USER_SETTING_WRITES`, which would also require `userClient`, and it is not in `ADE_ACTION_USER_ONLY`.
- The comment at `cloudAgentActions.ts:938-940` says it is in `USER_SETTING_WRITES`. It is not.
- **ADE MCP with full access runs the CLI as `cto`.**
  - `remoteMcpProtocol.ts:432,557` set `role: connection.scope === "write" ? "cto" : "agent"`.
  - `remoteMcpCommandPolicy.ts` lists `cloud` in `FULL_ACCESS_COMMANDS`, and has no refusal for `cloud invite redeem` or for `actions run cloud.invite_redeem`. `checkActionsCommand` only blocks `remote_mcp`, `account`, `account_vault`, android SDK actions and sign-ins.
  - `cloud.call` then goes through `runMachineAccountAction` (`machineAccountActions.ts:69`). The MCP runner's process has no chat, run, step or attempt, and it calls over a local socket, so it passes.
- **A chatless orchestrator run, step or attempt keeps `cto`.** `resolveSessionBoundRole` (`runtimeRoles.ts:68-84`) lowers the role only when there is a `chatSessionId`. The comment at `adeRpcServer.ts:6475-6478` says the same.
- **The person's own terminal is refused.**
  - `parseCliArgs` defaults to `role: resolveAdeDefaultRole(process.env.ADE_DEFAULT_ROLE, "agent")` (`cli.ts:6569`).
  - So a plain `ade cloud invite redeem ABCD2345` fails with "Action 'cloud.invite_redeem' requires elevated role." The help, the action contract (`actionInputContracts.ts:217-221`) and `formatCloudInvite` (`cli.ts:21232`) all tell the person to run exactly that command.

**Failure scenarios**
1. A prompt injection reaches a claude.ai or ChatGPT app that has full ADE MCP access ("redeem invite XXXX for a bonus"). The app runs `ade cloud invite redeem XXXX`. The account's referrer is now the attacker's code, forever. The attacker earns 20 hours when this account's first cloud chat runs.
   - The plan says "one referrer per account, never changed" and "never an agent".
   - The exposure is limited to accounts younger than 30 days. Today ADE Cloud is limited to the owner's account, but this ships to every account later.
2. The person follows the CLI's own advice and is refused with a role error.

**Proposed fix (needs human: where should a code be entered?)**

Recommended: make `invite_redeem` user-only. Add it to `ADE_ACTION_USER_ONLY.cloud`, which `runMachineAccountAction` limits to the local desktop.
- The desktop does not need the action: it uses `IPC.cloudRedeemInvite` straight to the provider (`registerCloudIpc.ts:404`).
- The phone does not need it either: it goes `cloud.write` → `cloudCall` (`syncRemoteCommandService.ts:8419-8441`), which calls the handler directly with `approval: person`.
- Then remove `ade cloud invite redeem` from the CLI, or make it print "enter it in Settings › Account". Update the help line, the contract description and the `formatCloudInvite` hint to match.

If the CLI should keep redeeming, two changes are needed:
- an explicit refusal in `checkRemoteAdeCommand` for `cloud invite|invites redeem|enter` and for `actions run cloud.invite_redeem`;
- a `userClient` requirement (move it into `USER_SETTING_WRITES.cloud`).

The help then has to say `ade --role cto cloud invite redeem …`.

Either way, also fix the comment at `cloudAgentActions.ts:938-940`.

---

## M1 · Medium · An agent can answer the ADE Cloud approval card, including "Clear caches"

**Where**
- `cloudAgentActions.ts:807-813`: `clear_caches` now asks with `approve(..., { action: "person_only" })`.
- `actionPolicy.ts:400-402`: `clear_caches` was removed from `ADE_ACTION_USER_ONLY`.
- `adeRpcServer.ts:3925`: `clear_caches` is in `CLOUD_APPROVED_ACTIONS`.
- The card is `approve` → `approvals.requestChatInput` (`registry.ts:4369-4372` → `agentChatService.requestChatInput`).

**Evidence**
- `chat.respondToInput` is in the agent allowlist (`actionPolicy.ts:982`).
- The RPC server refuses an agent's answer only when `isUserOnlyPendingInput` is true (`adeRpcServer.ts:6621-6640`). That reads `isUserOnlyConsentCard(providerMetadata)` (`shared/types/macDesktop.ts:1987`), which knows only these cards:
  - Mac/Windows input lease
  - MCP app
  - project secret
  - integration connect
  - MCP server
- The ADE Cloud card passes no provider metadata, so any agent (a sibling chat, the CTO thread, a parent) can answer "Clear caches" with "yes".
- For `clear_caches` this branch adds the gap: before, the action was user-only and could not be reached. The same class was already open for `create`, `delete`, `lane_launch` and the other ADE Cloud cards. Those spend hours or delete computers, which is worse.

**Failure scenario**
1. An agent on a lane's cloud computer runs `ade actions run cloud.clear_caches`.
2. A second process of the same agent, or another chat, calls `chat.respondToInput` on the pending card with `decision: yes`.
3. The caches are cleared with no person involved.

The same works for a costly `cloud create` or a `delete`.

**Proposed fix (needs human, because it affects every ADE Cloud card)**
- Stamp the ADE Cloud approval card with a provider-metadata key, for example `ADE_CLOUD_APPROVAL_METADATA_KEY: true`, passed through `requestChatInput`.
- Add that key to `isUserOnlyConsentCard`.

The design ("each asks the person") says only the person answers these cards. If that is right for all of them, this is one change. If only `clear_caches` should be person-only, stamp it only for `action: "person_only"`.

---

## M2 · Medium · The end warning names keys ADE Cloud does not use

**Where:** `apps/desktop/src/main/services/adeCloud/claudePassEndWarning.ts:31-53` (`keyEnd`) and `:92-97`.

**Evidence**
- Every `provider_login` row that is `fixed`, has `expiresAt`, and is not in `setting.off` is named.
- ADE Cloud uses one sign-in per place. `desiredPlaces` (`providerLogins/providerLoginApplyPass.ts:185-213`) picks `setting.inUse[place]`, else the newest by `renewedAt ?? capturedAt`. A saved key wins when `chosen === "key"`, or for Copilot when nothing is picked.

**Failure scenario**
- The person has Cursor signed in on two Macs, so there are two fixed Cursor keys in the vault. ADE Cloud uses the newer one.
- The older one nears its end, and the warning says "Your Cursor key for ADE Cloud (…) ends in 3 days… Sign in to Cursor again on <old Mac>". The same happens when the person picked the saved key.
- That breaks decision 2, which says to warn only for keys ADE Cloud carries. The person re-signs in for nothing, and a dismiss is spent on a key that does not matter.

**Proposed fix (unambiguous, behavior-preserving for the keys in use)**
- Filter `keys` to the place's pick, using the same rule as `desiredPlaces`.
- Best: pull the pick (chosen / saved-key-first / newest) into one shared helper that both files call, so the two cannot drift.
- Passes are not affected.

---

## L1 · Low · Silent catch on the setting read

**Where:** `claudePassEndWarning.ts:96`, `await readSetting().catch(() => null)`.

Counting an unreadable setting as on is deliberate, but nothing is logged. If the setting store breaks, the warning names keys the person switched off and no log says why.

**Fix (unambiguous):** catch and `logger.warn("cloud.pass_end_setting_read_failed", { error })`. The simplest place is the `readCloudSignInSetting` wrapper at `registerIpc.ts:12729-12732`, which has the main logger, or a logger passed into `readClaudePassEnd`. Keep the null fallback.

---

## L2 · Low · The invite code goes into the main log

**Where:** `apps/desktop/src/main/services/deeplinks/protocolHandler.ts:216, 229, 237` log `url: rawUrl`. With the new `ade://invite/<CODE>` (`shared/deeplinks.ts:729-733`), that is the full code.

The branch's own rule elsewhere is "never the code" (`registerCloudIpc.ts:409`, the analytics policy). The risk is small, since a code is not a secret and earns at most 10 rewards, but it contradicts that rule and puts the code in diagnostics uploads.

**Fix (unambiguous):** for `parsed.target.kind === "invite"`, log `ade://invite/<redacted>`, or log only `kind` and `source`. Add a small `redactDeeplinkForLog` and use it in all three calls.

---

## L3 · Low · The new billing entries are classified only by default

**Where:** `shared/settingsManifest.ts:1660` (`ade-cloud.plans`) and `:1671` (`ade-cloud.sizes`). Neither is in `shared/settingsAgentAccess.ts`.

Both default to `owner-only / preference` ("It is your preference"), so `settingIsProtected` is false for them. Plans and billing is money, like `integrations.ade-cloud-spending`.

**Fix (unambiguous):** add `"ade-cloud.plans"` to `OWNER_ONLY.money`. `ade-cloud.sizes` is the default size for new lanes, which costs hours at a larger size, so "money" fits it as well. The chip wording and `ade settings find` change; the brain's refusals do not.

---

## L4 · Low · The computer id is sent to `/cloud/access` for every account

**Where:** `cloudServerProvider.ts:123,144` sends `x-ade-computer` on every request. That includes `GET /cloud/access`, which every signed-in account polls.

The server ignores the header there and settles only after `allowed` (`account-directory/src/cloud/routes.ts:1069-1094`), so nothing is stored for a refused account. Still, a stable id that is the same across accounts (`hardwareAnchor.ts:403-405`, SHA-256 over a public salt) leaves every ADE user's computer, including people who never use ADE Cloud. The privacy line in the plan presents it as part of the free plan.

**Fix (needs human):** leave the header off `CLOUD_PATHS.access`. The simplest way is to skip it when `path === CLOUD_PATHS.access` in `request()`.

---

## L5 · Low · Informational · The free-plan gate trusts the client

**Where:** `cloudAccess.ts:90-97` (`cloudFreePlanComputer`) and `cloudComputerRules.ts:21`.

**Evidence**
- `isAdeCloudComputer()` is only `/^[a-z0-9]{10}$/` on `ADE_CLOUD_INSTANCE_ID`.
- A request with no header keeps the free plan, unclaimed (`freePlan.ts` `settle`, `!signal`). The server only counts it as `unclaimed_use`.
- So anyone who sets `ADE_CLOUD_INSTANCE_ID=abcdefghij` before starting ADE, or uses only MCP or the phone, gets free hours on every account.

The plan accepts this ("phone verification later, only if abuse shows up"). This entry records it: a Sentry or PostHog alert on `unclaimed_use` per account would show it. No client change is proposed.

---

## L6 · Low · Old ready machines are left behind

The ready keeper, its IPC and `ready_*` are gone. Nothing deletes:
- ready machines that already exist (prepared and asleep, holding disk);
- the account vault item `cloud-ready` (`CLOUD_READY_VAULT_KEY`).

An older ADE on another of the person's computers still reads that setting and keeps preparing machines. With the new build those machines show as plain computers. `cloudMachineCopy.ts` still drops the `ade_ready*` keys on a copy, which is right.

Exposure is the owner's account only, since ADE Cloud is hidden from everyone else.

**Fix (needs human):** a one-time cleanup, for example `account_vault.remove` of `cloud-ready` at the first start of this build, plus a note in the release notes. Or the owner deletes them by hand.

---

## Checked, no finding

- **Cloud 4 step 2b (no sign-in values in a new computer's env).**
  - Both `createInstance` callers pass only `ADE_MIN_VERSION`:
    - `cloudMachineCreator.ts:306-333` (make, copy, move, desktop bridge, CLI);
    - `cloudLaneComputerStages.ts:115-139` (lane launch).
  - No other caller passes `env`. The `machineEnv` dep is removed from the creator deps, `registry.ts` and `registerCloudIpc.ts`.
  - `cloudMachineEnv` is deleted.
  - Keys and Claude passes come only from the vault on the brain. Nothing regressed for a saved key or a pass.
- **ADE MCP `--machine cloud` exception (`remoteMcpCommandPolicy.ts:200, 276-301`).**
  - Every word that matches a machine flag must be exactly `--machine=cloud` or `--machine` followed by `cloud`. The only word skipped is the literal `cloud`.
  - The subcommand must be `args[1]`.
  - Each of these is refused:
    - `CLOUD` or `cloud,desktop`
    - a second `--machine`
    - `--all-machines` or `--machine-project`
    - `--machine` before the subcommand
    - `launch-cancel`
    - a `--machine` hidden as a free-text value (a refusal, which is the safe side)
  - The CLI has no other alias for `--machine`: `--to-machine` is a removed flag that is refused. Read-only scope still refuses `chat create`.
  - The brain stamps an MCP caller as `viaAdeMcp` (`adeRpcServer.ts:6718-6738`) only when the running-run check passes. It holds the caller to the agent limits and refuses `lane_launch_cancel` and deletes.
- **`clear_caches` unattended.** A full-auto chat, an automation and ADE MCP are declined, because `approve` throws for `person_only` when `viaAdeMcp || automation || full-auto` (`cloudAgentActions.ts:357-361`). Plan mode is declined. A call naming another machine is refused. The person's dashboard call through the computer's pin is stamped `person`, because `mayUseUserOnlyActions` is the same check that made it user-only before. The open path is M1.
- **`providerLogins.*` sync commands (`syncRemoteCommandService.ts:8443-8456`).**
  - Writes are `viewerAllowed: false, controllerAllowed: true, queueable: false`.
  - Status is viewer-allowed and carries no values.
  - Lane-share guests are refused by default.
  - `allowKeychain` and `allowGitHubCli` are left out.
  - All seven are additive in `MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS` and `SyncRemoteCommandAction`.
  - `cloud.write` → `invite_redeem` is controller-only.
- **Item 14 (`registerCloudLaneLaunchIpc.ts:84-123`).**
  - The order is: carried composer origin, then the stamped binding origin (passed together as `gitOriginUrl`), then the local config file, then async `runGit config --get` (5 s), then the remote `projects(targetId)` (8 s).
  - No `spawnSync`: the file read is a small `readFileSync` of `.git/config`.
  - All the origins are canonicalized the same way (`canonicalGitOriginUrl`, then `normalizeGitRemoteIdentity`).
  - A carried origin that disagrees with the project wins by design. It is the same value the composer's refusal checked, and it comes from a trusted renderer sender. The CLI and brain launch path never reads `args.cloud.originUrl`; it uses the brain's own project origin.
  - The remote case: the preload sends `remote: {targetId, projectId}` and no `localRootPath`.
  - `list` has no carried origin, the same as on main. No regression in calls per list.
- **Ready-machine removal.**
  - No references are left in main, preload, shared or the CLI.
  - All seven `cloudReady*` channels and `cloudCreateMachine` are gone from `ipc.ts`, `ipcTimeouts.ts`, `preload.ts` and `global.d.ts`. The handlers are gone too.
  - `ready_*`, `claim_ready` and `release_ready` are gone from `actionPolicy.ts`, `adeActionAccess.ts`, `actionInputContracts.ts`, `CLOUD_APPROVED_ACTIONS`, the phone's reads and writes, and the desktop bridge (`ready_refresh` on both sides).
  - `--machine cloud:ready` and `ade cloud ready` now give a usage error.
  - The inlined `ade_ready*` keys in `cloudMachineCopy.ts:85-86` match the deleted `CLOUD_READY_METADATA` exactly.
- **#2165 merge in scope.**
  - In `preload.ts`, `global.d.ts`, `settingsManifest.ts`, `deeplinks.ts` and `registerIpc.ts`, the only removals against `202dc0676` are the ready flow and the rewritten ADE Cloud entries.
  - `cloudLaneLaunchOrigin.ts` is gone in favor of #2165's `resolveProjectRepoOrigin`.
  - The CLI typecheck is clean, and main, preload and shared typecheck clean.
- **Hiding ADE Cloud.**
  - `cliCloudEnabled` starts false and stays false on any error or after the 5 s timeout (`cli.ts:40720-40738`).
  - `cloudDomainEnabled` fails closed (`shared/adeCloud.ts:818-830`).
  - `runMachineAccountAction` and the phone's `cloudCall` hide every `cloud` action except `access`, so the new `referral` and `invite_redeem` are hidden too.
  - The ADE MCP instructions gate on `adeWithheldAgentSkills()`.
  - The `ade-mcp-client` and `ade-android` skills no longer name ADE Cloud.
  - The new help lines sit on the cloud page, which `helpPagesWithoutCloud` drops.
- **Pins (CLAUDE.md "Built for remote machines").**
  - The five new pinned Cursor and Devin preload calls use `callPinnedOrBoundRuntimeActionOr`.
  - All five actions are declared in `adeActionAccess.ts` and `actionPolicy.ts`.
  - The new invite, referral and computer-id calls are account-level, with no pin by design.
- **Windows and Linux.**
  - The computer id reads `MachineGuid` with `reg query` through `resolveTrustedWindowsTool` without blocking (`hardwareAnchor.ts:255-262`), `ioreg` on macOS, and the machine-id file on Linux.
  - The platform header is `process.platform`.
  - No new path, shell or process code in scope.
- **Silent catches.** Every new `catch` in scope logs or re-throws, except L1, and except two that cannot fire:
  - `cloudServerProvider.ts:123`: `cloudFreePlanComputer` never rejects.
  - `cloudLaneLaunchAnalytics.ts:27-30`: analytics must not throw by design.

## Outside my scope (for the lead)

`npm run typecheck` in `apps/desktop` fails in the renderer. On a CI typecheck this is a blocker:

- `renderer/components/settings/cloudDashboard/CloudPlans.tsx:16`: "Cannot find module '../../../../../account-directory/src/cloud/contract'". Five `../` from `cloudDashboard/` reach `apps/desktop/`, not `apps/`. It needs six, or an import through `shared/adeCloud`, which already re-exports the contract.
- `CloudPlans.tsx:123,126,173`: `CloudPlanId` used to index `Record<CloudPlanId, string>` (TS7053, probably a result of the bad import).
- `renderer/components/settings/integrations/IntegrationsHome.tsx:332`: `ConnectProviderId` compared with `"cloud"`. This is the dead `cloud` branch the hide-cloud report lists.
