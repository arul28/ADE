# Cloud 5 · /quality fix: composer and chat UI (fix-ui-chat)

Helper: fix-ui-chat (Opus 5.5). Scope: qa-ui #2, #3; qb-ui B-H1, B-M4 (AgentChatPane/appStore part), B-M7, B-M8,
B-M11 (rename only), and the Lows on these files. Nothing committed.

## Per finding

| Id | What changed |
|---|---|
| qa-ui #2 (High) | The saved Run on cloud pick is now read through the project store in context: `useAppStoreApi().getState()` in `components/chat/useDraftCloudPick.ts` (restore and save effects). The write still goes through `useAppStore((s) => s.setWorkViewState)`, which uses the same context store. No `useAppStore.getState().getWorkViewState` is left in `components/chat/`. |
| qa-ui #3 (Medium) | `personPickedRef` in `useDraftCloudPick.ts`. `markChosen()` sets it, and the save effect reads it and clears it. The "dropped by its gate" guard now applies only when the flag is false. `markChosen()` also bumps a `chosenSeq` state, which is in the save effect's deps. That makes a pick that changes no draft state still reach the save. Example: the saved pick is Cursor, its gate is closed, the draft shows no cloud, and the person picks This computer. Callers: `AgentChatPane.tsx:12079` (lane request), `:17204` (`handleDraftShelfMachineChange`), `:17246` (`useThisComputerForDraft`). |
| qb-ui B-H1 | New `components/chat/useDraftCloudPick.ts`. It holds `sameDraftCloudTarget`, the restored-key ref, the person-picked ref, `current` (was `currentDraftCloudTarget`), and both effects, and returns `{ markChosen }`. In `AgentChatPane.tsx:17181-17201`, `applySavedDraftCloud` (the old restore body) is passed as `apply`, followed by the hook call. Effect order is kept: the hook sits after the "draft opened in a cloud lane" effect, as before. To allow that, `handleDraftShelfMachineChange` moved below it. It is a callback, so no effect order changes. |
| qb-ui B-M4 (AgentChatPane/appStore) | `WorkDraftCloudTarget` is now `{ provider: "ade"; laneId; sizeId: CloudTierId \| null } \| { provider: "cursor" } \| { provider: "devin" }` (`state/appStore.ts:270`). `normalizeWorkDraftCloudTarget` (`:541`) drops the always-null fields for cursor/devin and checks `sizeId` with `isCloudTierId`; an unknown size reads as the saved default (null). An old blob `{provider:"cursor",laneId:null,sizeId:null}` still normalizes, to `{provider:"cursor"}`. The `saved.sizeId as CloudTierId` cast and the `CloudTierId` import in AgentChatPane are gone. |
| qb-ui B-M7 | New `components/chat/launch/cloudLaunchScope.ts` with `cloudLaunchScope(launchBinding, projectBinding) => { pin, git }` and `laneOnLaunchMachine(laneId, pin, machineLanes, tabLanes)`. Callers: Cursor launch `AgentChatPane.tsx:14028`, `:14142`; Devin launch `:14298`, `:14369`. The pin rule is unchanged (null when the launch machine is the tab's own). |
| qb-ui B-M8 | `refetchDevinCloudAuth` deps are now `[projectRoot]`. The effect that runs it is keyed `[chatRuntimePinKey, refetchDevinCloudAuth]` (`AgentChatPane.tsx:8098-8109`), so it is still keyed on the pin key. The `:17302` warning is gone with B-H1, because the hook gets `chooseAdeCloudTier` (`:16780`) through `applySavedDraftCloud`. eslint on the changed regions and the new files shows no warnings. |
| qb-ui B-M11 | Renamed `setAdeCloudMode` to `setAdeCloudPicked` (every use, AgentChatPane only). |
| Low: duplicate `detail` | Removed `detail:` from the Cursor and Devin rows in the Run on list. The picker shows `unavailableReason ?? detail`, so the text is the same. |
| Low: `chatLaunchErrorMessage(x, x)` | Added a local one-argument `launchErrorText(raw)` in `LaneSetupCard.tsx:87`, used at `:317`, `:334`, `:823`. `shared/chatLaunch.ts` is not mine to change. |
| B-M2 (picker part) | `DraftMachinePicker.tsx:387`: the reason line uses `text-[var(--kit-warn)]` instead of `text-amber-300/70`. The `/70` opacity is dropped: `--color-warning` is a plain var, so Tailwind's opacity modifier can't apply to it. |
| skyline | Deleted `DraftMachineOption.skyline` and its `CloudSkylineLane` import in `DraftMachinePicker.tsx`, and updated the `detailPending` comment. I told the lead. `useAdeCloudDraft.ts` `skylineLanes` is left to fix-ui-dash. |

Remote check (CLAUDE.md): no new IPC call. Both launches still pass `cloudPin` to every git, lanes, Cursor and Devin
call. Devin auth is still read with `chatRuntimePinRef.current` and re-run on `chatRuntimePinKey`. The draft
cloud pick is per project view state and has no pin.

Behavior: unchanged, except the two bug fixes. One known behavior is kept on purpose: on a restore, the
save effect in the same commit writes once from the pre-restore render, and the next render writes the restored
pick back. This was there before, and the final value is the same.

## Tests updated for intended changes (launch-fixes)

- `AgentChatPane.test.tsx`, Cursor Cloud describe: 18 `toHaveBeenCalledWith` assertions on
  `createRun`, `openChat`, `push`, `getOriginRemote` and `getSyncStatus` now expect the trailing `null` pin.
  The draft's readiness probe (`getOriginRemote({ laneId: "lane-primary" })`) still takes one argument and was
  left as is.
- "disables Cursor Cloud when a remote draft machine is selected" is now "keeps Cursor Cloud pickable when
  a remote draft machine is selected". The row is enabled, and the old "launches from this computer" reason is gone.
- `chatLaunchStore.test.ts`: the rejected-start test now checks `snapshot.error`, and that every step is pending
  with no error (no fake failed step). On reset it checks phase running and the error cleared.
- `lib/workDraft.test.ts`: `startChatDraftPatch` expects `draftCloudTarget: null`.

## Checks (one pass)

- `npm run typecheck` (apps/desktop): no errors in my files. Errors remain only in files other helpers are
  editing:
  - `chat/useAdeCloudDraft.ts:12`, `usage/HeaderCloudMeter.tsx:7`, `settings/cloudDashboard/CloudSizes.tsx:7`,
    and `CloudFreeUpSpace.tsx:8` import `earnedHoursLeftMilli`, `formatGb` and `percentOf`, which
    `cloudDashboardModel.ts` no longer exports.
  - `settings/cloudDashboard/CloudPlans.tsx:16,123,126,173`: the contract import and `CloudPlanId` indexing.
  - `settings/integrations/IntegrationsHome.tsx:332`: the `"cloud"` comparison.
  - `shared/adeCloud.ts:29`: `CLOUD_FREE_PLAN_REFUSED_SENTENCE`.
- vitest: `AgentChatPane.test.tsx`, `state/chatLaunchStore.test.ts`, `lib/workDraft.test.ts`,
  `launch/LaneSetupCard.test.tsx` and `state/appStore.test.ts` all pass: 514/514 tests.

## Left / for /test

- I did not run #2 and #3 in the dev app. Failure modes to cover:
  1. You pick ADE Cloud in a session that started with no saved pick, show a chat, then come back to the draft. ADE Cloud should be shown again.
  2. The app starts with ADE Cloud saved. You pick This computer, then leave the draft and come back. ADE Cloud should not come back.
  3. Cursor Cloud is saved and its gate is still closed. You pick This computer, then the draft remounts. Cursor should not come back.
  4. Cursor Cloud is picked, then its gate closes (lane cleared or sign-in lost). The saved Cursor pick should stay.
  5. A saved size that this build doesn't know should read as the default.

## Round 2 (re-review qd-a / qd-b)

| Id | What changed |
|---|---|
| qd-b B4 | `state/appStore.ts`: the `setCloudDefaultTier` type comment now reads "Sync calls this too; a person's pick is counted in `lib/cloudDefaultTier.ts`." The stale `synced` option text is gone. |
| qd-b B6 | `components/chat/useDraftCloudPick.ts`: `current` now comes from a small `draftCloudTargetOf(...)` if-chain instead of the nested ternary. One `gateClosed(target)` callback (deps `cursorCanLaunch`, `devinCanLaunch`) is used by both the restore effect and the save effect's gate guard. |
| qd-a note (same-pass save) | `justRestoredRef`: the restore effect sets it whenever it settles a project key. That covers both "a saved pick was applied" and "nothing saved". The save effect consumes it first and skips that one pass. It no longer writes the old `current` (null, or the previous project's pick) before the restored value lands. The restored pick is saved by the next pass only if it differs from what is stored, and normally it doesn't. Both effects share their trigger deps (`gateClosed`, `keeps`, `projectKey`), so the flag is always consumed in the same commit that set it. |

Checks: `npm run typecheck` (apps/desktop) shows no errors in my files. The only errors are in
`main/services/adeCloud/cloudSignInEndWarning.ts:31,84,85`: `pickCloudPlaceSignIn` is not exported from
`providerLoginSyncShared`. That file is another helper's work in progress. vitest `AgentChatPane.test.tsx`,
`state/appStore.test.ts` and `lib/workDraft.test.ts` pass (475/475). eslint on `useDraftCloudPick.ts` is clean.
