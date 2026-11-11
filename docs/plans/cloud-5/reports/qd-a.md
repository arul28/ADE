# /quality delta re-review, Track A (correctness and security)

Scope: the review-fix delta `56cf2045c..a89d2323c` only, read against the full touched files. The rules applied were correctness-security-review.md, ade-review-rules.md and windows-quirks.md. I checked every finding below against the code.

**Result:** no Blocker or High. There is 1 Medium and 5 Lows. The plan cleanup safety rules, the user-only invite redeem, the consent stamp, the access-header skip, the referral changes, the renames and the helper moves all hold up. The details are in "Checked, no finding" at the end.

---

## Medium

### M1. The header's ADE Cloud meter no longer refreshes every 5 minutes while the shared computer list is watched, and a failed shared read hides it with no recovery poll

- **Where:**
  - `apps/desktop/src/renderer/state/cloudAccountStore.ts:78-83`: `readUnlessFed`, and the timer and status hook in `subscribe`.
  - `:46-48`: `noteCloudAccountRead`.
  - `apps/desktop/src/renderer/components/remoteTargets/useCloudMachines.ts:73-74, 86-95`: `noteCloudAccountRead(result)` and `setCloudAccountFed(true)` in `startWatching`.
- **Evidence:**
  - Before the fix, `HeaderCloudMeter.tsx` had its own store, which read the account every `REFRESH_MS` (5 minutes) whatever else was mounted.
  - Now the 5-minute timer calls `readUnlessFed`, which skips the read whenever `fed` is true. `fed` is true whenever `useCloudMachines` has any listener.
  - That is the case whenever any of these is mounted:
    - the Work draft composer (`useAdeCloudDraft`, active whenever draft launch controls show);
    - Settings › ADE Cloud;
    - the remote target list (`useCloudMachineGroup`);
    - `useCloudComputer` users;
    - provider sign-ins;
    - the tier dialog.
  - `useCloudMachines` itself reads only on window focus, on `cloud.onStatusChanged`, and on the settling poll (only while a box wakes, sleeps or resizes). It has no periodic read.
- **Failure scenario:**
  - **Stale meter.** The person keeps ADE focused with a new-chat draft open while a cloud lane runs agents for an hour. The header ring and the "ADE Cloud 43.8 h of 50 h left" title stay where they were at the last focus or cloud event. Before the fix they moved every 5 minutes. This is the account's always-on hours display, and the amber and red levels warn before 0 hours, so a stale value can hide that warning.
  - **Lost meter.** A focus read while offline returns `state: "unreachable"`, and `noteCloudAccountRead` publishes `null`. The meter, the invite pill and the Settings › Account invite box disappear. While fed, nothing reads again until the next focus or cloud event, even after the network is back. The old store also cleared on a non-ok read, but its 5-minute poll brought the meter back.
- **Proposed fix:**
  1. Keep the 5-minute cadence without a second read. Record `lastAccountAt = Date.now()` in `noteCloudAccountRead` and in this store's own `read`. Have the timer read only when `Date.now() - lastAccountAt >= REFRESH_MS`, whether fed or not. This is at most one list read per 5 minutes, the same budget as before.
  2. In `noteCloudAccountRead`, publish `null` only for `not_connected` or `access_refused` (no access). For `unreachable`, or `ok` with `account: null`, keep the last account. The access flag (`useCloudAccount` → `useAdeCloudEnabled`) still hides it at once on sign-out.
- **Unambiguous:** part 1, yes. Part 2 is a small judgment: keeping the last value through a blip matches the "the last answer stays while a refresh runs" rule `useCloudMachines` already follows.

---

## Low

### L1. The plan cleanup "done" email always says the lanes stay, and names each freed computer twice

- **Where:** `apps/account-directory/src/cloud/planCleanup.ts:267-277` (`tellPlanCleanupDone`).
- **Evidence:**
  - The body is now `planCleanupDoneSentence(done)` plus one line per computer.
  - `planCleanupDoneSentence` (`contract.ts:599`) always says "Their lanes and chats stay; the next message to a lane makes a new computer." It also already lists every freed computer with its branch.
  - The old email added the "lane stays" line only when `entry.laneKept`. That conditional is gone, and the per-computer lines repeat the names and branches.
- **Failure scenario:** a freed computer with no lane (`laneKept: false`, a plain computer the person made) gets an email promising its lane and chats stay. Every freed computer is also listed twice.
- **Proposed fix:** make the second part of the sentence depend on whether any freed entry has `laneKept`, or keep it out of the shared sentence and add it per computer as the old email did. Then drop the duplicate `freed` lines, or drop the list from the sentence for the email.
- **Unambiguous:** no. It is copy, and the dashboard shows the same sentence.

### L2. A lane is checked only against the computer's local remote-tracking refs, which can be stale

- **Where:** `apps/desktop/src/main/services/lanes/laneService.ts:9362-9387` (`readUnsavedWork`), used by `apps/ade-cli/src/services/power/cloudPushWork.ts:66-80`.
- **Evidence:**
  - `git rev-list --count <ref> --not --remotes` counts against `refs/remotes/*` as last fetched or pushed.
  - Nothing fetches before the read, and nothing prunes.
  - The doc comment says the lane is "measured against GitHub".
- **Failure scenario:** a lane branch is deleted on GitHub without being merged, or force-pushed over, while the computer still holds the old `origin/<branch>`.
  - The lane reads `ahead: 0`, so it is not pushed and reads `clean`.
  - With `readsRemotes: true`, the server's `laneIsSafe` accepts `clean`.
  - The computer is freed, and the commits that only the stale tracking ref covered are lost.

  This is rare, but it is the one remaining path that loses data in the cleanup.
- **Proposed fix:** in push mode only, run `git fetch --prune origin` (with a short timeout) once per project before reading. Any failure marks the lanes `failed`, so the computer is kept.
- **Unambiguous:** no. It adds a network round trip per project, and the server runs the push.

### L3. The delete-lane warning says "the last push failed" for a lane ADE couldn't read

- **Where:** `apps/desktop/src/renderer/components/cloudLane/deleteCloudLane.tsx:177`, with `cloudPushWork.ts:71-76`.
- **Evidence:**
  - Check mode (`work-state`) never pushes.
  - Since the fix, a lane whose `readUnsavedWork` throws is reported as `state: "failed"` with `dirty: false` and `ahead: 0`.
  - `unpushedText` maps `failed` to "the last push failed".
- **Failure scenario:** before a delete, the warning lists a lane as "the last push failed" when ADE simply couldn't read it, for example because its folder isn't the expected worktree.
- **Proposed fix:** when `state === "failed"` and the lane is neither dirty nor ahead, say "ADE couldn't read this lane's work". The other case can keep the current text.
- **Unambiguous:** yes.

### L4. "Stay on Pro" says it worked without checking the answer

- **Where:** `apps/desktop/src/renderer/components/settings/cloudDashboard/CloudPlans.tsx:83-86`.
- **Evidence:** `stayOnPro` awaits `bridge?.openCheckout?.("pro")` and then always shows "You stay on Pro." It does this even when `bridge` or `openCheckout` is missing (the call is skipped) and when the answer isn't `{ change: "now" }`. `checkout` (`:76-80`) does check `result?.change`.
- **Failure scenario:** on a client without the bridge method, or when main answers `opened: true` (an unexpected checkout URL), the person is told the move to Plus was undone when it wasn't.
- **Proposed fix:** `const result = await bridge?.openCheckout?.("pro"); if (result?.change === "now") showToast(...)`. Otherwise show nothing, or set the error.
- **Unambiguous:** yes.

### L5. The hardware id: a real "no id" is now treated as a failed probe and never cached

- **Where:** `apps/ade-cli/src/services/account/hardwareAnchor.ts:251-281`.
- **Evidence:**
  - `runProbeAsync` resolves `null` for any `execFile` error: a timeout, a spawn failure, or a plain non-zero exit.
  - `probeFailed = output === null` therefore also catches a host that answers "no such value", for example `reg query` exiting 1 on a Windows image without `MachineGuid`.
  - Such a host is never cached. Before the fix, `null` was cached.
- **Failure scenario:** on such a host:
  - `cloudFreePlanComputer` reads again every 10 minutes, which is bounded and fine.
  - The synchronous `readHardwareAnchorUuid` callers (`machineTelemetryId.ts:74`, `accountMachinePublisherService` through `readAccountHardwareId`) no longer find a cached answer. They run `spawnSync` themselves, which on the desktop's main process blocks for up to the probe timeout.
- **Proposed fix:** have `runProbeAsync` tell a timeout or spawn error (`error.killed`, `error.code` such as `ENOENT` or `ETIMEDOUT`) apart from a non-zero exit. Treat only the first as `probeFailed`.
- **Unambiguous:** mostly. The split between the error kinds is the only judgment.

---

## Not from this delta (for the record, not counted)

- **`useDraftCloudPick`** (`apps/desktop/src/renderer/components/chat/useDraftCloudPick.ts:80-108`): in the commit where the restore effect calls `apply(saved)`, the save effect runs with the old `current`. It writes `null`, or, after a project switch with no saved pick there, the previous project's pick, before the next render writes the restored value. The base had the same two effects in the same order, so this is not a regression. It only shows if the pane unmounts between the two renders. A fix would be to skip the save in the same pass that restored, for example by having the restore set a `justRestoredRef` that the save effect consumes.

---

## Checked, no finding

### Plan cleanup safety (`planCleanup.ts`)
- `laneIsSafe` lets only `pushed` through, plus `clean` from a non-primary lane or from a `readsRemotes` tally. An unknown state stays unsafe.
- A missing `primary` is treated as primary.
- `readsRemotes` is set on every CLI tally, and `work-state` returns the same object (`multiProjectRpcServer.ts:3149-3157`).
- `stillDue` runs before the wake and again before the delete. It re-reads the account, access, a fresh `listComputers` and the warned due time.
- Only warned, due ids are freed.
- `warnFresh`:
  - The claim is guarded with `is ?` on the JSON as read, so a null works.
  - The give-back is guarded on this run's JSON and restores `due_at`.
  - `skipped` counts as sent only outside production.
- prepare-stop:
  - It requires exit 0, readable JSON, `stillRunning === 0`, `chatsNotUploaded === 0` and `timedOut === false`.
  - These fields match `CloudPrepareStopResult`.
  - `uploadPendingCloudChats` answers `remaining: 0, timedOut: false` when nothing is pending.
- `runPlanCleanups` skips accounts `cloudAccessAllows` refuses.

### `cloudPushWork` / `readUnsavedWork`
- **Clean primary lane with a remote:** 0, so `clean`.
- **Primary lane with local commits, or no remote at all:** counts every commit, so `unpushed` and kept. That is correct for a computer about to be deleted.
- **Detached worktree:** `HEAD` is counted, and a missing `refs/heads/<branch>` counts 0.
- **Unborn HEAD:** throws, so `failed` and kept. That fails safe.
- **Push updates the tracking ref:** `git push -u origin <branch>` uses the default refspec from a normal `git clone` (`projectScaffoldService.ts:325`, no `--single-branch`), so the later check reads 0.
- **Perf:** about 3–4 git calls per lane, run only by push-work and work-state (the server's cleanup and the person's push), never on a timer. That matches the old `includeStatus: true` list in kind.
- **Windows:** plain `git` arguments, with no shell or path quoting issues.

### User-only invite redeem
- `invite_redeem` moved from CTO_ONLY to `ADE_ACTION_USER_ONLY.cloud`.
- The phone reaches the handler directly through `cloud.write` (`syncRemoteCommandService.ts:6721, 8441`, controller-only), so the user-only check doesn't apply there. The phone path still works.
- The desktop IPC calls `machines.redeemInvite` locally and sends `cloudStatusChanged` on success.
- A refusal reason the client doesn't know throws, and the IPC maps it to `unavailable` with the server's sentence.
- The CLI's `redeem` and `enter` give a usage error.

### ADE Cloud approval stamp
- `providerMetadata` reaches `requestChatInput` (`RequestChatInputArgs.providerMetadata`, wired in `registry.ts:4369-4371`).
- The only `requestChatInput` in adeCloud is the one stamped.
- The person's own paths are untouched: the dashboard's clear caches goes `clear(pin, instanceId)` → `approve(readApproval(args))` with the person's approval and no card.
- Side effects, as intended for consent cards:
  - the card is no longer "redirectable" from the composer;
  - a subagent's card is relayed to the person, not the parent agent;
  - lane-share guests see "waiting for the owner".

### Computer-id header
- It is skipped only when `path === "/cloud/access"`.
- That route is not a free-plan moment (`freePlanMomentOf` is account and referrals for reads, create, start and fork for use), so no settle loses its signal.

### Referrals
- **Mutual check:** the direction is right (`friend = owner, referrer = me`).
- **Re-keying at deletion:**
  - No primary-key or unique collisions: one friend row per id, and the `(user_id, reason, reference)` target is new.
  - The free-plan claim moves to the hash, so a re-made account is refused.
- **Deleted referrer:** the friend is paid. The referrer insert is gated by `? = 0`, the landed-update matches no row, and no analytics are sent.
- **The referrer's landed update** requires its own grant, so a capped referrer's `warned_zero_at` stays.
- **Bind order** checked for all three statements.
- **Rate limiter reuse:** the same 60 s window and `scope:client` hashing. `x-forwarded-for` is only a fallback behind `cf-connecting-ip`.
- **`decodeURIComponent`** is guarded.

### Renames
- `CloudSignInEnd` is a required-`kind` union.
- Every reader narrows on `kind === "key"`: `CloudSignInEndNotice.tsx`, `adeCloudEndNotice.ts` and `browserMockProviderLogins.ts`.
- `passEnd` comes only from this desktop's main.
- `readCloudSignInSetting` throwing is caught, logged and counted as on.
- `signInsInUse` uses the same candidate filter as the apply pass: carried, not off, has meta. Cursor is `carried`, so its key can still be named.

### Helper moves
These are identical bodies:
- `formatGb` → `formatCloudGb`
- `percentOf`
- `CLOUD_DISK_WARN_SHARE`
- `formatShortDate` → `formatCloudDate`
- `cloudAccessAllows` and `readJson` → `http.ts`
- `CLOUD_COMPUTER_ID_DOMAIN`, now from the contract with the same string

Behavior that changed on purpose:
- `cloudHoursLeftMilli` now adds earned hours where the header used the plan's hours alone. This is decision #9.
- `FREE_RULES_SQL = not PAID_RULES_SQL` is equivalent to the old SQL.
- The `included: "free"` SQL in `startFreshPeriod` matches the old `freeHours` case, and the binds line up.

### Nudge pills
- `createNudgeSchedule` reproduces the star schedule (first showing after 1 message, 2 dismissals) and the invite schedule (40-message snooze, 3 dismissals, `countsMessages` only while snoozed) exactly.
- `shownDue` is the old `shownReported <= dismissCount`.
- The web-client guard moved into `recordNudgeMessageSent`, which is the only caller.

### Default size analytics
- The person's pick is counted once, in `pickCloudDefaultTier`, from both the composer and Sizes.
- A synced value goes through the bare setter and isn't counted.

### Stay on Pro
- The server's `undoDowngrade` covers `to: "pro"` on a Pro account with `paid_plan_next = plus`, uncharged.
- `canStayOnPro` excludes past due and cancel-at-period-end.

### iOS
- The split dropped no declaration: I compared the top-level `struct`, `func`, `class` and `enum` names before and after. It only added the four new sentence helpers.
- `cloudAvailable` is cleared when the phone leaves `.connected` and when the host identity changes.
- `refreshCloudAvailability` drops a late answer, and Work's `.task` re-reads on `isAttached` and on host change.
- `mutual` is in the iOS refusal list.

### `CloudSection` early return
- It hides the page only for `no_access`: `connected: false`, not signed out, no error.
- A refusal or an unreachable server still shows the banner.
