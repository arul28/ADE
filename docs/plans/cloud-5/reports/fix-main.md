# Cloud 5 · /quality fix: main, preload, shared, CLI (fix-main)

Fixer: fix-main (Opus 5.5). Scope: `apps/desktop/src/{main,preload,shared}/**`, `apps/ade-cli/**`, the iOS settings catalog (generated). Decisions: `quality-decisions.md`. Nothing committed.

Paths below are under `apps/desktop/src/` (desktop) or `apps/ade-cli/src/` (cli) unless they are written in full.

## qa-server B1, step 2 (CLI side): a lane push-work can't read is never `clean`

- **New `laneService.readUnsavedWork(laneId)`** (desktop `main/services/lanes/laneService.ts:9362`).
  - It reads the lane now, with no cache. `dirty` comes from `readWorktreeDirty`, which throws when `git status` fails.
  - `unpushedCommits` is `git rev-list --count <ref> --not --remotes`, for both `refs/heads/<branch>` and the folder's `HEAD`. This is the same count as `cloudStartBranch` and `getAutoArchiveFacts`.
  - So a lane whose branch is its own base (the primary lane) is now measured against the remotes, not against itself.
  - It throws in three cases: the folder exists but is not the expected worktree root, `git status` fails, or a count fails. The one exception is a branch that no longer exists (`show-ref` exit 1): that lane has 0 commits to save.
- **`pushCloudComputerWork`** (cli `services/power/cloudPushWork.ts:55-75`).
  - It lists lanes with `includeStatus: false` and calls `readUnsavedWork` for each lane.
  - A read that throws marks the lane `state: "failed"`, adds 1 to `tally.failed` and logs `cloud.push_work_lane_unreadable`. Such a lane is never `clean`.
  - `ahead` now means "commits no remote has". The type comment says so.
  - The primary lane is still never pushed. With local commits it is now `unpushed` (before this change it was `clean`).
- Checked by hand: in a clone with one unpushed commit on `main`, `rev-list --count refs/heads/main --not --remotes` returns 1. The old `main...main` count gave 0. `show-ref` on a missing branch exits 1.
- **For the server helper:** once cloud images ship this CLI, a primary lane that reports `clean` really is clean. Step 3 ("keep unless the primary lane reports `pushed`") can then relax to `clean`/`pushed`. Until then step 3 is still needed for older images.
- Docs: the work-check bullet in `docs/features/ade-cloud/README.md` now describes this behavior.

## qa-main

| Id | What changed |
|---|---|
| H1 | `invite_redeem` is user-only now. It moved from `ADE_ACTION_CTO_ONLY.cloud` to `ADE_ACTION_USER_ONLY.cloud`, with a comment (desktop `main/services/adeActions/actionPolicy.ts:399-403`). `runMachineAccountAction` limits it to the local desktop. The phone's `cloud.write` → `cloudCall` still reaches the handler directly. CLI: `ade cloud invite redeem\|enter` is a usage error, "Enter an invite in Settings › Account." (`cli.ts:21121`). The `cloud-invite-redeem` output kind and its formatter are gone. The `formatCloudInvite` hint uses the same sentence (`cli.ts:21222-21235`). The help line is replaced by "(enter a friend's invite in Settings › Account)". Contract text and example: `actionInputContracts.ts:224`. The comment in `cloudAgentActions.ts` `invite_redeem` is fixed. The README invite paragraph is updated. |
| M1 | New `ADE_CLOUD_APPROVAL_METADATA_KEY` (desktop `shared/adeCloud.ts:48`). Every ADE Cloud approval card is stamped with it through `requestChatInput` `providerMetadata` (`cloudAgentActions.ts:437`). `isUserOnlyConsentCard` checks it (`shared/types/macDesktop.ts:1993`). An agent's `chat.respondToInput` is now refused on every ADE Cloud card, including `clear_caches`. |
| M2 | One pick rule: `pickCloudPlaceSignIn` (`main/services/providerLogins/providerLoginSyncShared.ts:137`), plus the helpers `savedKeyTokenOf` and `savedKeyVaultKey`. `desiredPlaces` calls it (`providerLoginApplyPass.ts:182`). So does the end warning's `signInsInUse` (`cloudSignInEndWarning.ts:62`), which builds the same candidates (carried, readable, not off), so only the key ADE Cloud uses in its place is named. Passes are unchanged. |
| L1 | The setting read failure is logged as `cloud.pass_end_setting_read_failed` (`cloudSignInEndWarning.ts:139`), and the fallback is still "on". `readCloudSignInSetting` in `registerIpc.ts:12732` now throws on `!ok` instead of returning null silently. |
| L2 | `deeplinkForLog` (`main/services/deeplinks/protocolHandler.ts:207`) logs `ade://invite/<redacted>`. All four log calls use it: parse_failed, refused, dispatch, dispatch_failed, plus `deeplink.buffered`, which the finding missed. |
| L3 | `ade-cloud.plans` and `ade-cloud.sizes` are in `OWNER_ONLY.money` (`shared/settingsAgentAccess.ts:96`). |
| L4 | The `x-ade-computer` header is no longer sent on `CLOUD_PATHS.access` (`cloudServerProvider.ts:128`). |
| L5, L6 | No change, by decision. |

## qa-ui #14

The same change as L3. The iOS catalog was regenerated with `node apps/desktop/scripts/generate-ios-settings-catalog.mjs`. `WorkSettingsCatalog.swift` now has `locked: true` for both entries.

## qb-core

| Id | What changed |
|---|---|
| H4 | `IPC.cloudGetReferral` is deleted: the handler, `ipc.ts`, `preload.ts`, `global.d.ts` and the `browserMockCloud.ts` line (the only renderer edit, needed for the type). There is now one redeem, `machines.redeemInvite` in `cloudMachines.ts:595`. It returns a `CloudInviteRedeemOutcome`, logs `invite_redeemed`/`invite_refused` (never the code), and throws for errors other than a refusal. The IPC (`registerCloudIpc.ts:391`) maps a throw to `unavailable` and sends `cloudStatusChanged` on success. The action (`cloudAgentActions.ts` `invite_redeem`) passes the throw on. |
| H5 | The provider parses once. `readReferral` returns `readCloudReferralSummary` or throws `bad_response`. `redeemInvite` returns a parsed referral (`cloudServerProvider.ts:374-384`). `billingCheckout` uses the new `readCloudPlanCleanup` (`shared/adeCloud.ts:829`), which checks every field. The re-parse at each caller is gone. |
| M6 | `hardwareAnchor.ts` imports `CLOUD_COMPUTER_ID_DOMAIN` and `CLOUD_COMPUTER_UNREADABLE` from the contract, and its own copy is deleted. `readCloudComputerIdAsync` is typed `Promise<string>`. `CloudComputerSignal` is exported from `cloudServerProvider.ts:48` and reused in `cloudAccess.ts`. The `unreadable` literal is gone from `cloudAccess.ts`. |
| M7 | Renames: `claudePassEndWarning.ts` → `cloudSignInEndWarning.ts` (git mv), `readClaudePassEnd` → `readCloudSignInEnd` (now takes `{ now, readSetting, logger }`), `ClaudePassEndList` → `CloudSignInEndList`, `CloudPassEnd` → `CloudSignInEnd`. The rename also covers `adeCloudEndNotice.ts`, `CloudSignInEndNotice.tsx`, `state/cloudAccess.ts`, `browserMockProviderLogins.ts`, preload and global.d.ts. `SIGN_IN_END_NOTICE_MS` lives in `shared/cloudSignIns.ts:215` and replaces `CLAUDE_PASS_NOTICE_MS`. `kind` is required, and the mock sets `kind: "claude_pass"`. The hook name `useAdeCloudPassEnd` is kept (renderer, rename-only scope). |
| M9 (desktop, CLI) | The CLI help (`cli.ts:4813-4815`) and the `referral`/`invite_redeem` contract text are built from `CLOUD_REFERRAL_REWARD_MILLI`, `CLOUD_REFERRAL_REWARD_LIMIT`, `CLOUD_REFERRAL_ENTER_DAYS` and `CLOUD_INVITE_REFUSAL_REASONS` (the latter is now re-exported from `shared/adeCloud.ts`). The `global.d.ts` comment names the constant. Three re-exports nothing used are dropped: `CLOUD_INVITE_URL_BASE`, `CLOUD_INVITE_DEEPLINK_BASE`, `planCleanupSentence`. `CLOUD_FREE_PLAN_REFUSED_SENTENCE` was already removed by the server helper. |
| M10 | `CLOUD_LANE_MACHINE` is exported from `shared/cloudLaneLaunch.ts:63` and used by `cliMachineTargeting.ts` and `remoteMcpCommandPolicy.ts`. The policy stays exact-match on purpose, and a comment says so (`remoteMcpCommandPolicy.ts:282`). |
| L2 | `cloudLaneLaunchAnalytics.ts` → `cloudLaneAnalytics.ts` (git mv). `CloudLaneAnalyticsCapture` is exported and replaces the four `Parameters<…>[0]` types. `cloud_default_size` is removed from the main union (the renderer sends it). The paths in `docs/logging.md` and the README are updated. |
| L3 | The phone's provider-login writes are now `["captureNow", ...PROVIDER_LOGIN_ACCOUNT_WRITES]` (`syncRemoteCommandService.ts:8454`). |
| L4 | The allowlists stay literal (decision). `refused_mutual` is added for the server's new `mutual` reason (`productAnalyticsPolicy.ts:775`). The refusal reasons are now a runtime check, `readCloudInviteRefusalReason`, in place of the cast. |
| L5 | `diskShared` is typed `true`, with a comment explaining why it stays (`cloudAccountStatus.ts:89-94`). |
| L7 | **Partly dropped after verification.** `redeemInvite` cannot be required: the web client's adapter (`renderer/webclient/adapter/cloud.ts`) has no code box, and requiring it fails the typecheck. It stays optional, with that reason in the comment. Removing `getReferral` (H4) still applies. |
| L9 | The `ade cloud ready` and `--machine cloud:ready` lines are deleted from `apps/ade-cli/README.md`. `cloudKeepAwake.ts:508` has the comment "Remove after 2026-12-31". **Left:** the same comment in `infra/ade-cloud/template/ade-entrypoint.sh` is outside my files. |

## Also fixed (qb-core "outside this track", accepted)

- `cloudFreePlanComputer` kept `unreadable` for the life of the process.
  - It now reads again after 10 minutes (`cloudAccess.ts:86-110`).
  - In `hardwareAnchor.ts`, an async probe that failed (spawn error or timeout) is not cached; only a real "no id" is cached (`hardwareAnchor.ts:250-282`).
  - The sync reader and the telemetry id are unchanged: they keep their own result.

## Follow-ups from the lead, fix-server and fix-ui-dash

- **`readsRemotes: true`**: a top-level field on `CloudPushWorkResult` (cli `services/power/cloudPushWork.ts:28-35`), set on every tally. `push-work` and `work-state` both return this one tally unchanged (`multiProjectRpcServer.ts:3151,3157`), so the field appears in both `--json` outputs. Each lane already had `primary`.
- **Contract changes** from fix-server:
  - `CLOUD_FREE_PLAN_REFUSED_SENTENCE` was already dropped from `shared/adeCloud.ts` by fix-ui-dash.
  - `mutual` reaches the `invite_redeem` contract text through `CLOUD_INVITE_REFUSAL_REASONS.join(...)`.
  - `refused_mutual` is in the analytics allowlist, which stays literal.
- **qb-ui B-M4 union** (handed over by fix-ui-dash):
  - `CloudSignInEnd` is now `(CloudSignInEndFacts & { kind: "claude_pass" }) | CloudKeyEnd`, and `CloudKeyEnd` has `provider` and `madeOnLabel` as required fields (`shared/cloudSignIns.ts`).
  - `adeCloudEndProviderName` and `keyWords` now take `CloudKeyEnd`, so the "the provider" fallback is gone.
  - `CloudSignInEndNotice.tsx` drops both `&& end.provider` checks.
- **qb-ui Low noLaneName**: `CLOUD_MACHINE_DEFAULT_NAME` replaces the literal in `cloudMachineCreator.ts:259` and in `cloudAgentActions.ts` `create`.
- **Re-check after these edits**:
  - Typecheck is clean in both packages. The `IntegrationsHome.tsx` errors are gone; another helper fixed them.
  - `adeCloud/*.test.ts`: 49 tests passed.
  - cli `power.test.ts`: 54 tests passed.

## Remote scoping

- Every call I added or changed is account-level or this-computer-only, with no pin by design:
  - `IPC.cloudRedeemInvite` and `machines.redeemInvite` act on the account.
  - The end warning reads the account vault.
  - The computer id header is about this computer.
- `readUnsavedWork` runs on the cloud computer's own brain, inside `ade cloud push-work`, which the server runs on that computer. It is local to that machine by design.
- `invite_redeem` from another machine: the phone's `cloud.write` (controller-only) reaches the handler. Remote and agent callers through `cloud.call` are refused by the user-only check.
- The M1 consent stamp holds wherever the card is answered: `isUserOnlyConsentCard` is checked by the brain that owns the chat.

## Failure modes, for /test

1. A primary lane with unpushed commits reads `clean`, and the computer is freed.
2. A lane whose status read fails reads `clean`.
3. The pick rule drifts between the apply pass and the warning, so the warning names a key ADE Cloud does not use.
4. An agent answers an ADE Cloud card.
5. An invite code reaches the main log.
6. An agent or ADE MCP redeems an invite through `cloud.call`.

## Checks

| Check | Result |
|---|---|
| `npm run typecheck`, apps/ade-cli | Clean. |
| `npm run typecheck`, apps/desktop | Clean in main, preload and shared. 3 errors remain, all in `renderer/components/settings/integrations/IntegrationsHome.tsx:103,108,111` (`cloud` is not a `ConnectProviderId`). That file is outside my scope and another helper is editing it now. |
| desktop vitest, 11 files, 488 tests | Passed: `actionPolicy`, `registry`, `protocolHandler`, every `adeCloud/*.test.ts`, `providerLoginSync`, `productAnalyticsService`, `featureProductAnalytics`, `mcpServerRequest`. |
| desktop vitest, `laneService.test.ts`, 143 tests | Passed. |
| cli vitest, 1,131 tests | Passed: `remoteMcpCommandPolicy`, `hardwareAnchor`, `cliMachineTargeting`, `power`, `adeRpcServer`, `cli`, `syncRemoteCommandService`. Two skipped. |

Caveats on the cli run:
- `cli.test.ts` fails one case when it runs inside an ADE chat: the `setSessionActivity` case picks up `ADE_CHAT_SESSION_ID` and `ADE_ACTIVITY_SESSION_ID` from the environment. It passes with those unset. The leak is in the test's environment, not in this change.
- No test was added or bent.

Re-checked on the lead's second request. `readsRemotes: true` is already in the code (`cloudPushWork.ts:34,57`), and every lane carries `primary: boolean` (`:67`). That matches the server's `TallyLane`/`Tally` parser (`planCleanup.ts:539-561`). Both `cloud.pushWork` and `cloud.workState` print that one tally. cli `power.test.ts`: 54 tests passed.

## Round 2 (qd-a, qd-b)

| Id | What changed |
|---|---|
| qd-b B2 | **One rule for the whole pick.** `cloudPlacePicks(rows, setting, { usable, meta, savedKeyToken })` in `providerLoginSyncShared.ts` holds both the candidate filter and the pick: kind, not deleted, usable, not off, carried, readable meta, `cloudChoiceKey`, the newest by `renewedAt ?? capturedAt`, and saved key first. `pickCloudPlaceSignIn` is folded into it. `desiredPlaces` passes `row.readable` and `metaFor`. The end warning's `signInsInUse` passes `!!row.value` and `readProviderLoginMeta`. |
| qd-b B3 | **Rename finished.** The field `passEnd` is now `signInEnd` in preload, `global.d.ts`, `registerCloudIpc`, `renderer/state/cloudAccess.ts`, both browser mocks and the doc comments. The hook `useAdeCloudPassEnd` is now `useCloudSignInEnd`. The registerCloudIpc helpers `readPassEnd`, `passEndMemo` and `PASS_END_FRESH_MS` are now `readSignInEnd`, `signInEndMemo` and `SIGN_IN_END_FRESH_MS`. The two stale comments now say "a Claude pass or a key". The `cloud.pass_end_*` log events are unchanged. |
| qd-b B8 | **Cast and placeholder removed.** The `hardwareAnchor.ts` cast is replaced by a `cachedAnchor()` getter. `cloudAccess.ts` keeps a plain `Promise | null` plus a module-level `freePlanRetryAt`, so the placeholder promise is gone. |
| qd-a L5 | **Probe failures told apart.** `runProbeAsync` now returns `{ stdout }`, `{ failed }` (a killed child, meaning the timeout, or a string error code such as ENOENT) or `{ exited }` (a numeric exit code). Only `failed` skips the cache. A host that answers "no id" is cached as before. I checked Node's `execFile` error shapes by hand: a timeout gives `killed: true`, ENOENT gives a string code, and `exit 1` gives the number 1. |
| qd-a L2 | **Fetch before push.** In push mode only, `pushCloudComputerWork` runs `gitService.fetch` (`fetch --prune` with GitHub auth fallback) once per project, on the primary lane or else the first lane, with a 60 s `AbortSignal.timeout`. On failure it logs `cloud.push_work_fetch_failed` and marks every lane of that project `failed`, so the computer is kept. Check mode (`work-state`) does not fetch. The README work-check bullet says so. |
| qd-a L3 | **Wording for an unread lane.** In `deleteCloudLane.tsx`, a `failed` lane that is neither dirty nor ahead now reads "ADE couldn't read this lane's work". |

**Remote scoping:** nothing new crosses machines. The fetch runs on the cloud computer's own brain, inside push-work.

**Checks:**
- Typecheck is clean in apps/desktop and in apps/ade-cli.
- Desktop: `providerLoginSync` and `adeCloud/*` passed, 62 tests.
- CLI: `hardwareAnchor` and `power` passed, 78 tests.
