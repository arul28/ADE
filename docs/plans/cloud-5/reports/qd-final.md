# qd-final: final delta re-review (Track A + Track B)

Scope: `git diff a64c518ae 52d61f167` (round-2 fixes for qd-a / qd-b), with the touched files as context.
Reviewer: Opus 5.5, review only. I made no edits besides this file.

No Blocker or High findings. There are two Medium and four Low.

---

## Medium

### M1. A push now recreates lane branches that were squash-merged and then deleted on GitHub

- **Where:** `apps/ade-cli/src/services/power/cloudPushWork.ts:75-84` (new `fetch --prune`), together with
  `gitOperationsService.ts:1544-1563` (`push`) and `laneService.ts:9362-9387` (`readUnsavedWork`).
- **Evidence:** I reproduced it in a scratch repo:
  1. Push `feat` with `-u`, then delete `feat` on the remote.
  2. Run `git fetch --prune`, which reports `[deleted] (none) -> origin/feat`.
  3. `rev-list --count HEAD --not --remotes` now returns 1.
  4. `rev-parse --abbrev-ref --symbolic-full-name @{upstream}` exits 128, so ADE's `push` falls back to `push -u origin feat`.
  5. The push prints `* [new branch] feat -> feat`, and the branch is back on the remote.
- **Failure scenario:**
  1. A lane's PR is squash-merged on GitHub and the branch is deleted, either by GitHub's auto-delete or by hand. This is the common flow.
  2. Later, "Push all work to GitHub" (`cloudMachines.ts:184`, check=false) or plan cleanup's `ade cloud push-work` runs on that computer.
  3. The fetch prunes `origin/<branch>`. The squashed commits are on no remote ref by SHA, so the lane reads `ahead > 0`.
  4. ADE pushes, and the deleted branch reappears on GitHub. That push can also start `on: push` CI runs.
  5. Before this delta, the stale tracking ref made the lane read `clean`. This was the qd-a L2 data-loss trade-off, so the push is the safe direction.

  Nothing is lost. But the person sees ADE push back branches they merged and deleted, every time push-work runs on a computer whose branch is gone.

  For a lane that plan cleanup keeps without a computer (`laneKept`), recreating the branch is arguably needed, because the next computer checks it out. For a plain "Push all work", or a computer that is about to be deleted, it is clutter.
- **Fix options (product call):**
  - (a) Accept it, and say so in the README bullet: "a lane whose branch was deleted on GitHub is pushed back".
  - (b) When `@{upstream}` is configured but its tracking ref was pruned, and the lane's tree matches a commit on the base (a squash-merge check, e.g. `git cherry` / `merge-tree` against `origin/<base>`), count it as saved.
  - (c) Push such lanes to a namespaced ref (`ade/saved/<branch>`) instead of the deleted name.
- **Unambiguous:** no. It is a behavior choice between data safety and GitHub clutter.

### M2. The iPhone still says "Their lanes and chats stay" for every freed computer

- **Where:** `apps/ios/ADE/Views/Cloud/CloudPhoneFormat.swift:45-56` (`cloudPlanCleanupDoneSentence`) and
  `apps/ios/ADE/Services/SyncService+Cloud.swift:200-206` (`PlanCleanupDone.Freed` has only `name`, `branch`).
- **Evidence:** this delta made the desktop/server sentence conditional on `laneKept` (`contract.ts:607-610`):
  - nothing for computers without a lane;
  - "Its lane…" or "Their lanes…" when every freed computer kept its lane;
  - "The lane(s) among them…" for a mix.

  The Swift doc comment says the phone "builds it as `planCleanupDoneSentence` does". It does not decode `laneKept`, and it still always appends "Their lanes and chats stay; the next message to a lane makes a new computer." No iOS file is in the diff.
- **Failure scenario:** plan cleanup frees a computer that held no lane. Desktop and the email say only that it was removed. The iPhone dashboard says its lanes and chats stay, and that the next message makes a new computer. For that computer, this is wrong.
- **Fix:**
  - Add `let laneKept: Bool?` to `PlanCleanupDone.Freed`. A missing value counts as false, as `filter((entry) => entry.laneKept)` treats `undefined` on desktop.
  - Mirror the same four-way wording in `cloudPlanCleanupDoneSentence`.
- **Unambiguous:** yes.

---

## Low

### L1. `justRestoredRef` can outlive its pass and swallow the person's next save

- **Where:** `apps/desktop/src/renderer/components/chat/useDraftCloudPick.ts:98-127`.
- **Evidence:** the fix report (`fix-ui-chat.md:70`) says both effects share their trigger deps, "so the flag is always consumed in the same commit that set it". That is not strictly true:
  - `apply` is a dep of the restore effect only.
  - The save effect has `current` and `chosenSeq`, which the restore effect does not.
  - The restore effect can therefore pass its guards and set the flag in a commit where the save effect does not run.
- **When the flag leaks:**
  - All of these hold: `restoredKeyRef !== projectKey`, the gate is open, and `apply` changed identity (`applySavedDraftCloud` depends on `chooseAdeCloudTier`).
  - The restore was pending behind a closed Cursor/Devin gate, and then the stored `draftCloudTarget` changed under it. The usual writer is another pane on the same project; the gate deps themselves did not change.
  - With `saved` now null, no `apply` → no state change → the flag stays `true`.
  - The next save-effect run returns early, and it also clears `personPickedRef`. That run is typically the person's own `markChosen()` pick (a `chosenSeq` bump).
  - The pick shows, but it is not saved until `current` changes again.
- **Side note:** when `saved` is null, the effect skips the write but leaves `current` as it was. If `projectKey` can change while the pane stays mounted, the previous project's pick is still saved on the next `current` change. qd-a's case is deferred, not removed. If each project tab mounts its own pane, this never happens.
- **Fix:** set the skip to what it means, `justRestoredRef.current = current`. In the save effect, skip only when `current === justRestoredRef.current`, then clear it. A stale flag can then never match a later pick.
- **Unambiguous:** yes (small). It is very rare.

### L2. The work check (`work-state`, delete lane's warning) still reads stale tracking refs

- **Where:** `cloudPushWork.ts:71-84` (`if (!args.check && anchor)`), and the README bullet.
- **Evidence:** this is deliberate and documented ("The check reads what it has"). But delete lane relies on the check to warn, and deleting a lane takes its computer with it.
- **Failure scenario:**
  1. Someone force-pushes over the lane's branch on GitHub. The computer still has the old `origin/<branch>` covering its local commits.
  2. The delete warning reads `clean`.
  3. The computer goes, and the overwritten commits with it.

  This is narrower than qd-a L2, because the person chose to delete.
- **Fix:** optionally fetch in check mode too, with the same failure handling: a failed fetch means "couldn't read", which delete already shows as "ADE couldn't read this lane's work".
- **Unambiguous:** no (latency on the delete dialog).

### L3. Only the default remote is fetched; the unsaved-work count reads every remote

- **Where:** `gitOperationsService.ts:1432` runs `["fetch", "--prune"]` with no remote. That fetches the current branch's upstream remote, or `origin`. `readUnsavedWork` counts `--not --remotes`, which is all remotes.
- **Failure scenario:** a lane tracks a second remote, such as a fork's PR head (`ghPrHeadRepo.ts`), and that branch was force-pushed or deleted there. Its stale `refs/remotes/<fork>/<branch>` still covers the local commits, so the lane reads `clean` after the "fresh" fetch.
- **Fix:** have push-work fetch all remotes. Either add an `all` option to `gitService.fetch` that adds `--all`, or fetch each remote that a lane's upstream names.
- **Unambiguous:** no. Fetching more remotes means more network and more auth surface.

### L4. `FETCH_TIMEOUT_MS` duplicates the fetch's own 60 s budget

- **Where:** `cloudPushWork.ts:10-11, 79`.
- **Evidence:** `gitService.fetch` already passes `timeoutMs: GIT_FETCH_TIMEOUT_MS` (60 s, `shared/defaultRemoteLaneBase.ts:10`) to the git run. `AbortSignal.timeout(60_000)` adds only one thing: the clock also runs while `runLaneOperation` waits on the primary lane's queue.
  - When the wait is long, git starts with the signal already aborted and fails at once.
  - That failure is the safe direction (the computer is kept).
  - Still, the constant reads as if it set the fetch's budget, and it does not.
- **Fix:** either drop the constant and signal and rely on `GIT_FETCH_TIMEOUT_MS`, or rename the constant and comment it as the whole-step budget, including the queue wait.
- **Unambiguous:** yes (maintainability only).

---

## Checked and clean

- **`git fetch` before reading lanes:**
  - It uses `runGitWithGithubAuthFallbackOrThrow`, the same GitHub auth fallback as `push` (`runGitPushOrThrow` → `runGitWithGithubAuthFallback`), so a cloud computer that can push can fetch.
  - A project with no remote: `git fetch --prune` exits 0 with no remote configured (tested on git 2.54), so it is not marked failed.
  - A failed fetch marks every lane `failed` and keeps the computer.
  - Windows: the plain argv goes through the shared `runGit` runner, with no shell quoting and no path issues.
  - The README bullet matches the code.
- **`deleteCloudLane.tsx` `unpushedText`:** a `failed` lane with `dirty: false, ahead: 0`, as a failed fetch or read leaves it, now says "ADE couldn't read this lane's work". That is correct.
- **hardwareAnchor probe split:** Node's `execFile` error on a non-zero exit has a numeric `code`. A timeout sets `killed: true`. ENOENT, EACCES and maxBuffer give string codes. So only a real exit is cached, and the getter `cachedAnchor()` re-reads the cache after the await. The behavior matches the comment.
- **`cloudFreePlanComputer`** (desktop main): the flattened `freePlanComputer` / `freePlanRetryAt` behave as before. Callers share one pending read, and a retry happens only after an `unreadable` answer is 10 minutes old.
- **`cloudPlacePicks`:** the apply pass and the end warning now share one filter and pick rule.
  - Apply pass, before and after: same filter (`readable`, `metaFor`), `setting.enabled` gate, provider, chosen key and newest stamp. `desiredPlaces` uses only `row`, `meta`, `provider` and `slot` from the pick.
  - End warning: the old version had no `enabled` gate inside, but its caller already checks `setting.enabled` (`cloudSignInEndWarning.ts:126`), so nothing changed. No unused imports are left (`cloudChoiceKey` and `parseProviderLoginKey` are still used in the apply pass).
- **`passEnd` → `signInEnd`:**
  - `git grep` finds no `passEnd`, `useAdeCloudPassEnd` or `pickCloudPlaceSignIn` left in apps, docs or scripts. Preload, `global.d.ts`, IPC, renderer state, both browser mocks and the notice all agree.
  - The web client adapter (`webclient/adapter/misc.ts:1078`) never sent the field, which is fine because it is optional.
  - The `cloud.pass_end_*` log events were kept on purpose, per qd-b.
- **Account store 5-minute logic:**
  - `take()` stamps `lastAccountAt` for every answer from either writer. A failed call stamps it too.
  - The 60 s check reads only once the newest answer is 5 minutes old, so there are no extra reads while `useCloudMachines` feeds it.
  - `unreachable`, or `ok` without an account, keeps the last account. `not_connected` and `access_refused` drop it, and access-off still goes through `forget()`.
  - So the meter no longer drops on a blip.
- **Server import cycle:** `accountDistinctId` and `uuidFromSeed` now live in leaf `sinkUtils.ts` (no imports), and the referral constants live in `contract.ts`.
  - madge over `apps/account-directory/src` reports only `cloud/store.ts > cloud/lanesWithoutComputer.ts`, which is an `import type` (erased, not a runtime cycle).
  - No caller still imports these helpers from `signupAnalytics`.
  - The reconcile script's comment points at the new home.
- **Plan cleanup email:** dropping the per-freed-computer lines is right, because the sentence already names each one with its branch.
- **Nudge pills:** `finalDismissal` matches the old checks.
  - The invite pill keeps `dismissCount >= MAX-1`.
  - The star pill's old `showing === "prompt_first"` is the same as `!finalDismissal` with two dismissals.
  - `STAR_PILL_SCHEDULE.messageSent` is guarded by `starPillCountsMessages` (not starred).
  - The removed `snoozeMessages` and `maxDismissals` fields have no remaining readers.
- **Removed `integrationPage.css` classes:** none is referenced outside CSS. `.ade-ig-hero-foot` is kept and still used (`IntegrationChrome.tsx:180`).
- **`CloudPlans` "Stay on Pro":** the server answers `change: "now"` for `to === "pro"` (`billing.ts:344`). Any other answer now shows an error instead of a false success toast. The browser mock matches the server.
