# Cloud 5 · Track A · Launch fixes (items 14, 10, 13, 15, 16): report

Helper: launch-fixes. Nothing committed. Paths are under `apps/desktop/src/` unless stated.

All five items are built. Open points are listed at the end; none of them blocks the items.

## Item 14 (blocker): "this project has no GitHub origin"

Composer and main now use one origin source.

- `shared/types/chatLaunch.ts`: `ChatLaunchCloudTarget.originUrl?: string | null`, the origin the launching
  window's composer checked before Send.
- `renderer/components/chat/launch/adeCloudLaunch.ts` `startAdeCloudLaunch`: puts its `originUrl` into
  `args.cloud.originUrl`. Every ADE Cloud start goes through it (composer, new-lane dialog, PR branch, Linear
  batch, lane without computer), and each one already passes `originUrlForBinding(tabBinding)`.
- `preload/preload.ts` `cloudLaneLaunchSource`: for a remote binding, also sends
  `remoteProject: { targetId, projectId }` (type in `shared/cloudLaneLaunch.ts`).
- New `main/services/adeCloud/cloudLaneLaunchOrigin.ts` (`createCloudLaneLaunchOriginReader`). One read, in this
  order:
  1. `args.cloud.originUrl`
  2. the binding's stamped `gitOriginUrl`
  3. local checkout: `readGitOriginUrlWithoutGit`, else async `runGit(["config","--get","remote.origin.url"])`
     with a 5 s timeout. No spawnSync, so the main loop never blocks. This fixes 14a (`worktreeConfig = true`).
  4. remote project: `remote.projects(targetId)` (the project's own machine) with a 5 s timeout. This fixes 14b.

  Answers are cached 30 s per root or project (max 64). The reader never throws; a failure logs
  `cloud_lane_launch.origin_read_failed`.
- `main/services/adeCloud/registerCloudLaneLaunchIpc.ts`: `start` and `list` both use the reader (14c). The old
  file-only read is gone.
- Window-to-project binding is untouched (#2165's area).

## Item 10: ADE Cloud pick does not stay picked (also Cursor and Devin Cloud)

- `renderer/state/appStore.ts`: new `WorkDraftCloudTarget { provider: "ade"|"cursor"|"devin"; laneId; sizeId }`
  and `WorkProjectViewState.draftCloudTarget` (default null, normalized, additive, no version bump). It lives
  beside `draftMachineId`, the same storage as machine picks.
- `renderer/lib/workDraft.ts` `startChatDraftPatch`: "New chat in this lane" clears `draftCloudTarget`.
- `renderer/components/chat/useAdeCloudDraft.ts`: exposes `pickedTier`, so only an explicit size is saved, never
  the default.
- `renderer/components/chat/AgentChatPane.tsx`:
  - State renamed `adeCloudPicked` (setter still `setAdeCloudMode`). Effective
    `adeCloudMode = adeCloudPicked && adeCloud.available` is derived right after `useAdeCloudDraft`, and
    `adeCloudModeRef` holds the effective value. Every reader uses the gated value: Run on value, lane list,
    `adeCloudTierId` / create-lane `adeCloudFixed`, sign-in skip, send path. Access unknown or refused never
    clears the pick (asked by the hide-ADE-Cloud helper).
  - Restore (once per project key, Work draft only: `onDraftMachineChange` present, no selected or locked
    session):
    - ADE Cloud: restored at once (pick, lane, size).
    - Cursor and Devin: restored once `cursorCloudCanLaunch` / `devinCloudCanLaunch` is true.
  - Save: writes `currentDraftCloudTarget`, built from `adeCloudPicked`, only after the restore for that key.
    A Cursor or Devin drop caused by its own gate (canLaunch false) does not overwrite the saved pick.
  - An explicit machine pick, "This computer", or a named-lane request ends the restore wait. A named-lane
    request also drops the cloud modes.

## Item 13: Cursor Cloud and Devin Cloud greyed on another computer

- `AgentChatPane.tsx`: the "Cursor/Devin Cloud launches from this computer" rule is removed, both in the picker
  rows and in the Cursor launch guard. Remaining reasons (no lane, git remote check, repo not connected,
  parallel models) are set as both `unavailableReason` and `detail` on the row, so the picker already shows
  them as the second line.
- Launch routing. `cloudPin` is the draft's execution binding, or null when it is the tab's own machine.
  - Cursor flow: `git.push`, `git.getSyncStatus` (via wrapped `pinnedGit`), `git.getOriginRemote`,
    `git.getOpenPrForBranch`, `ai.cursorCloudCreateRun`, `lanes.updateAppearance`, `ai.cursorCloudOpenChat`.
    The adopted chat passes `runtimePin` to `onSessionCreated`.
  - Devin flow: same push/sync wrappers, `lanes.updateAppearance`, `cloudAgents.launch`, adoption with
    `runtimePin`. A hand-off from an open chat uses that chat's `chatRuntimePin`. The draft-machine-unavailable
    check now applies to drafts only.
  - Lane tags read the lane machine's list (`chatMachineLanes`) when pinned.
- Devin sign-in status: `getAiStatusCached({ projectRoot, pin: chatRuntimePin })`. It is re-read when
  `chatRuntimePinKey` changes, not only once.
- `renderer/components/chat/useCursorCloudDraftState.ts`: new `pin` input (the pane passes `chatRuntimePin`, the
  same machine as `useLaneGitRemote`). The repo list, the remembered secret names and the open PR go there.
  Effects are keyed on `pin?.key`.
- Preload (`preload/preload.ts` and `preload/global.d.ts`): optional `pin` on `ai.cursorCloudListRepositories`,
  `ai.cursorCloudCreateRun`, `ai.cursorCloudGetLaneSecretNames`, `ai.cursorCloudOpenChat`, `cloudAgents.launch`.
  Routing goes through `callPinnedOrBoundRuntimeActionOr`. All of these actions are already remote-callable
  (`shared/adeActionAccess.ts`, ai domain).

## Item 15: raw error on the setup card, refusal shown as a failed step

- `shared/chatLaunch.ts`:
  - `chatLaunchErrorMessage(error, fallback)`: the one helper; strips the Electron wrapper through
    `stripElectronErrorWrapper`.
  - `isChatLaunchRefused(snapshot)`: failed, no lane, every step still pending.
  - `CHAT_LAUNCH_REFUSED_TITLE` ("Couldn't start this lane").
  - `buildLaneSetupCard` uses that title, the sentence and no rows for a refusal.
  - `chatLaunchStatusLine` returns "Couldn't start".
- `renderer/state/chatLaunchStore.ts`:
  - `markChatLaunchStartFailed(launchId, error: unknown)` strips the wrapper and puts running steps back to
    pending. No fake failed step, no "0ms". It also sets `endedAt`, so the clock stops at the refusal (the old
    "12s" grew until the next render).
  - `resetChatLaunchStartFailure` clears `endedAt`.
  - Removed `failFirstOpenStage`.
- `renderer/components/chat/launch/chatLaunchActions.ts`: passes the raw error to the store.
- `renderer/components/chat/launch/LaneSetupCard.tsx`:
  - Refused view: title, the plain sentence (`data-testid="lane-setup-refusal"`), no progress rail, no step
    rows, no elapsed time. Retry / Cancel / Copy details stay.
  - Every displayed error is stripped: stage callouts, Details "Error", payload card rows, Copy details,
    action errors.
- Refusal before Send: the composer's blocked label already uses `cloudLaneLaunchStartRefusal`. With item 14 it
  reads the same origin main uses, so the origin refusal can no longer first appear after Send.
- Real step times: no "~N min" estimate exists on the card anymore. Main already records each cloud step's real
  `startedAt` / `endedAt` (`cloudLaneLaunchService.ts` `setStage`). The only fake time was the renderer's
  start-failure marking, now fixed.

## Item 16: failed chat's composer shows the defaults

- Root cause, found by reading the code, not reproduced live: the pane's model-fallback effect replaced a model
  the catalog doesn't list (a DeepSeek preset/route model) with `pickFallbackChatModelId` whenever the pane's
  chat didn't exist yet. Effort and permission mode were never seeded at all.
- `renderer/components/chat/launch/useChatLaunchPaneState.ts` `useChatLaunchPaneLifecycle`: new optional
  `seedComposer(launch) => boolean`. It runs once per launch while awaiting the session; the model-only seed is
  the fallback.
- `AgentChatPane.tsx`:
  - `seedComposerFromLaunch` applies the local record's `draftSnapshot` (model, effort, Fast tier, Cursor tier,
    execution mode, native permission controls) through `applyLaunchConfigToComposer({ preserveFast: true })`,
    the same path as a restored draft.
  - The model-fallback effect returns early while `launchAwaitingSession`.
  - An ADE Cloud launch still being set up skips the local sign-in card (`launchRunsOnAdeCloud`).
- Did the launch carry the picked model? Yes. `args.modelId` and `chat.create` come from the prepared snapshot
  (with the preset snapshot), and Retry re-sends the same `record.args`.

## Remote-machine scoping of new and changed calls

| Call | Machine | How |
|---|---|---|
| cloud launch origin read (`start`, `list`) | the project's machine | carried origin, else local git, else `remote.projects(binding.targetId)` |
| Cursor launch (push, sync, origin remote, open PR, create run, open chat, lane tags) | the chat's draft machine | `cloudPin` = draft execution binding, null when it is the tab's own |
| Devin launch (push, sync, lane tags, `cloudAgents.launch`) | the draft machine, or the open chat's machine for a hand-off | `cloudPin` |
| Devin sign-in status | the chat's machine | `chatRuntimePin`, refresh keyed on `chatRuntimePinKey` |
| Cursor draft reads (repos, remembered secrets, open PR) | the lane's machine | `chatRuntimePin`, effects keyed on `pin?.key` |
| adopted Cursor/Devin chat | its machine | `onSessionCreated(session, { runtimePin })` |

Not pinned on purpose: `projectSecrets.list` (account/repo-scoped secret names, the same on every machine).

## Validation

- Item 14, by script (vite-node against the real module): a temp repo with `extensions.worktreeConfig = true`.
  - `readGitOriginUrlWithoutGit` gives undefined (the MacBook case); the reader returns the origin through async
    git in 33 ms.
  - The carried origin wins.
  - Remote: answered by `listProjects`, cached (1 call for 2 reads).
  - Unknown remote project and a folder with no origin both give null.
- Typecheck (`npm run typecheck`, apps/desktop): no errors in my files. Errors in files I did not touch (other
  helpers' work in progress): `main/services/adeCloud/registerCloudIpc.ts:461`, `cloudMachines.ts:85`,
  `cloudProvider.ts:141,147`, `cloudServerProvider.ts:163`, `renderer/components/settings/cloudDashboard/CloudPlans.tsx`.
- Tests: 8 colocated files, 643 passed, 16 failed. The failures were run before the access-gating change, which
  touched only `AgentChatPane.tsx`; nothing was re-run after it. All 16 come from intended behavior changes, left
  for `/test` (CLAUDE.md rule 0):
  - 14 in `AgentChatPane.test.tsx` "Cursor Cloud composer mode": every received call is the same object plus a
    trailing `null` pin (checked: 26 `+ null` diffs, 1 call each).
  - `AgentChatPane.test.tsx` "disables Cursor Cloud when a remote draft machine is selected" (item 13 removes
    that rule).
  - `state/chatLaunchStore.test.ts` "marks a rejected start as failed on its first open stage" (item 15: no fake
    failed step now).
  - `lib/workDraft.test.ts` startChatDraftPatch `toEqual` (now includes `draftCloudTarget: null`).
- Passed: `LaneSetupCard.test.tsx`, `chatLaunchActions.test.ts`, `appStore.test.ts`,
  `main/services/chat/chatLaunchService.test.ts`, `useWorkSessions.test.ts`.
- Not run in the dev app (the lead owns it). No new tests written.

## Failure modes for /test (notes, not tests)

- Origin:
  - `worktreeConfig`, include or quoted origin when git is not on PATH: null, so it is refused.
  - A remote machine that hangs: 5 s, then null, so it is refused.
  - A remote project missing from the list.
  - A 30 s stale cache after an origin change.
  - A carried origin that disagrees with the stamped one (the carried one wins).
  - `list` for a remote binding with no stamped origin now costs one `projects` call per 30 s.
- Saved pick:
  - A saved ADE Cloud pick while access is still unknown (it must show only once access is true, and must not be
    cleared).
  - A refused account (the pick is kept but has no effect).
  - The person picks a machine before a Cursor/Devin restore.
  - A gated Cursor drop that must not clear the save.
  - Two project tabs with different saves.
  - A named-lane request with a saved ADE Cloud pick.
- Refusal card:
  - A rejected start, then Retry, then the host answers (it must leave refused mode).
  - An unreachable runtime now shows as a refusal, not a failed step.
  - A timed-out start that actually landed (`hostSeen` replaces it).
- Launch seed:
  - A launch started in another window (no local record: model only).
  - The model is not in the catalog.
  - After the chat is created, the session's own settings take over.
- Cursor/Devin on another computer:
  - Auto-create lane and push on that machine.
  - The new lane is not in either lane list yet, so its tag lands only on the next read.
  - A hand-off from an open remote chat.

## For the lead's picker UI

`DraftMachinePicker.tsx` is untouched. Cursor Cloud and Devin Cloud rows now carry the blocking reason in `detail`
as well as `unavailableReason`, so it renders as the row's second line today. If you prefer a dedicated field
(e.g. `disabledReason`), it is a one-line change in the pane's `draftShelfMachineOptions`.

## Open / not done

- The Cursor/Devin lane filter (`laneCloudById`) reads only the tab machine's lane tags. On another computer the
  lane list under Cursor/Devin Cloud shows only "New cloud lane", not that computer's existing cloud lanes.
- The Cursor row's visibility (`cursorCloudApiAvailable`) still reads the tab machine's AI status. With shared
  sign-ins that is the same answer, but it is not pinned.
- Item 16, "This computer" in the owner's screenshot: a locked chat pane has no machine chip. The only "This
  computer" there is the sign-in card's machine name, now skipped for ADE Cloud launches. Confirm in the dev app.
- `docs/features/ade-cloud/README.md` is not updated for the origin-read order or the refusal card.
- The 16 test updates above are for `/test`.
