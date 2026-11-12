# Cloud 5 · /quality delta re-review, Track B (maintainability)

Reviewer: qd-b (Opus 5.5). Scope: `git diff 56cf2045c a89d2323c` only, against `thermo-nuclear-review.md`. Review only, nothing edited.
Line numbers are at `a89d2323c`. Other fixers have uncommitted edits in the worktree right now (server `chats/freePlan/planCleanup/referrals`, iOS `CloudDashboardCards/CloudPhoneFormat/SyncService+Cloud`). This review reads the commit, not those edits.

## Verdict

The moves landed cleanly. Of the seven findings below, two are Medium and five are Low. Every finding is behavior-preserving, and none needs a product decision.

## Move checks

| Check | Result |
|---|---|
| Old names left over | None in code. Searched for `CloudPlanCard`, `AdeCloudSignInsRow`, `claudePassEndWarning`, `cloudLaneLaunchAnalytics`, `readClaudePassEnd`, `ClaudePassEndList`, `CloudPassEnd`, `CLAUDE_PASS_NOTICE_MS`, `cloudGetReferral`, `formatShortDate`, `earnedHoursLeftMilli`, `formatGb`, `ProviderLoginsLenient`, `ade-cloud.svg`, `currentDraftCloudTarget`, `useHeaderCloudAccount`, `CloudSkyline*`, `PlanCleanupAccountRow`, `NoticeColumns`, `freeIncludedMilli`, `admitLookup`, `CLOUD_FREE_PLAN_REFUSED_SENTENCE`, `adecd-signins-lead/hero-btn/warn/cleanup`. The only hits are in the historical test ledger. The one half-rename is `passEnd` (B3). |
| Duplicates left after the moves | `HeaderCloudMeter` no longer has its own store, `cloudDashboardModel` no longer has `percentOf`/`formatGb`/`CLOUD_DISK_WARN_SHARE`, `AgentChatPane` no longer has the restore/save effects, and the server's `cloudAccessAllows`/`readJson` exist only in `http.ts`. The candidate filter for the pick rule is still duplicated (B2). |
| New import cycles | Desktop: none touch a changed file. The four small cycles in `apps/desktop/src` are the same at base and at head. Server: the H1 cycles through `store.ts` are gone, and the 12-file SCC is down to 7. But the delta adds one edge that keeps `referrals`/`chats` inside main's existing cycle (B1). |
| Dead exports from the moves | Every new hook and helper has a caller: `useCloudAccount` ×3, `noteCloudAccountRead`, `setCloudAccountFed`, `useDraftCloudPick`, `cloudLaunchScope` ×2, `laneOnLaunchMachine` ×2, `pickCloudDefaultTier` ×2, `recordNudgeMessageSent`, `pickCloudPlaceSignIn` ×2, `savedKeyTokenOf`, `savedKeyVaultKey`. The dead pieces are two schedule members (B5) and orphan CSS (B7). |
| Files still under 1,000 lines | iOS: `CloudPaneSheet` 289, `CloudDashboardCards` 671, `CloudMachineScreen` 257, `CloudPhoneFormat` 263, `CloudLimitsScreen` 99, `CloudSignInsCard` 87, `ProviderLoginsPhoneStatus` 156, `SettingsProviderSignIns` 479. Server: `store.ts` 986 (was 1,076). `billing.ts` is 990 (main has 946) and sits just under the limit. `routes.ts` is 1,116: main already had 1,106, and this delta shrank it from 1,128. |
| iOS project file | Each of the 6 new Swift files has exactly one PBXFileReference, one PBXBuildFile, one group entry (5 in Cloud, `ProviderLoginsPhoneStatus` in Services) and one Sources-phase entry. Each `C10D…A000n` id appears 3 times and each `C10D…B000n` id 2 times; none collides with an existing id. `plutil -lint` is OK. Every referenced path exists on disk. |
| `npm run lint:ci` (apps/desktop) | 0 errors and 852 warnings repo-wide. "ade-ui ratchet: no new violations against apps/desktop/lint-baseline.json." `lint-baseline.json` is not changed by the delta, so **no touched file and no new file gained an ade-ui warning**. Running eslint on just the touched files finds only non-ade-ui warnings that were already there at base (`CloudTier` unused in `cloudAgentActions.ts:74`, `CloudMachine` in `cloudMachines.ts:27`, an exhaustive-deps warning in `useAdeCloudDraft.ts:260`). |

## Findings

### B1 · Medium · The delta keeps referrals and chats inside main's server import cycle
- **Where:** `apps/account-directory/src/cloud/accountDeletion.ts:5` adds `import { DELETED_ACCOUNT_PREFIX, FRIEND_REASON, REFERRER_REASON } from "./referrals"`. Main already has the cycle `signupAnalytics.ts:30 → accountDeletion → billing → analytics → signupAnalytics` (`cloud/analytics.ts:1` imports `accountDistinctId` and `uuidFromSeed` from `../signupAnalytics`). The new edge, together with `chats → referrals → analytics`, keeps `referrals.ts` and `chats.ts` in that SCC: 7 files at head, against 4 on main and 12 at base.
- **Standard:** 5 (no hidden ordering between modules) and 4.
- **Judo move:** Break the cycle at its root. Move `accountDistinctId` and `uuidFromSeed` out of `signupAnalytics.ts` into the leaf `sinkUtils.ts`, which already exports `sha256Hex`. `signupAnalytics.ts:107` keeps a private copy of `sha256Hex`, which this move deletes. Then point `cloud/analytics.ts:1` and `signupAnalytics.ts` at it. I checked this on a copy of the tree: with that one import moved, **no cycle is left in `apps/account-directory/src`**, so the result is smaller than main. Optional: also move the three referral constants into `contract.ts`, so the deletion code does not import the referrals feature.
- **Behavior:** preserved. The functions are pure and only move.

### B2 · Medium · One pick rule, but the candidate filter is still copied
- **Where:** `main/services/adeCloud/cloudSignInEndWarning.ts:62-72` (`signInsInUse`) and `main/services/providerLogins/providerLoginApplyPass.ts:165-177` (`desiredPlaces`) build the same per-place candidate map line for line: kind, not deleted, readable, not switched off, `carry === "carried"`, readable meta, `cloudChoiceKey(provider, slot)`, and the same stamp `renewedAt ?? capturedAt`. Only `pickCloudPlaceSignIn` is shared. fix-main's failure mode #3 ("the pick rule drifts between the apply pass and the warning") can still happen through the filter. The copies already differ: `!row.readable` vs `!row.value`, and `metaFor(vault,row)` vs `readProviderLoginMeta(row.value)`.
- **Standard:** 4 and 7 (one canonical rule).
- **Judo move:** In `providerLoginSyncShared.ts`, add `cloudPlaceCandidates<R>(rows, setting, { usable(row): boolean; meta(row): LoginMeta | null })`, returning `Map<place, { row, meta, provider, slot }[]>`. Both callers use it. The warning passes `row => !!row.value` plus `readProviderLoginMeta`; the apply pass passes `row => row.readable` plus `metaFor`. Better still, make one `cloudPlacePicks(rows, setting, deps)` that also runs `pickCloudPlaceSignIn` per place, and have both callers read its map.
- **Behavior:** preserved, because each caller keeps its own predicates.

### B3 · Low · The `passEnd` → sign-in-end rename is half done
- **Where:** The types are now `CloudSignInEnd` (a Claude pass **or** a key), but the field and hook names still say pass:
  - `passEnd` in `preload.ts:13407`, `global.d.ts:4792-4793`, `registerCloudIpc.ts:140-141,177,313-332`, `browserMockCloud.ts:363`, `browserMockProviderLogins.ts:933,951`, and `renderer/state/cloudAccess.ts:15,34-42,80`;
  - `useAdeCloudPassEnd` (`cloudAccess.ts:85`, `CloudSignInEndNotice.tsx:19,33`).
  - Two comments are now wrong: `global.d.ts:4792` ("the end warning's Claude pass") and `cloudAccess.ts:84` ("The Claude pass the end warning names").
- **Standard:** 4 (one concept, one name).
- **Judo move:**
  - Rename `passEnd` to `signInEnd`, `useAdeCloudPassEnd` to `useCloudSignInEnd`, and `readPassEnd`/`passEndMemo`/`PASS_END_FRESH_MS` to `readSignInEnd`/`signInEndMemo`/`SIGN_IN_END_FRESH_MS`.
  - Fix the two comments.
  - Nothing outside desktop reads the field: no webclient adapter, iOS, web or test file uses it.
  - Leave the `cloud.pass_end_*` log events alone unless `docs/logging.md` changes with them.
- **Behavior:** preserved. The IPC stays inside this process.

### B4 · Low · A stale doc for an option the delta removed
- **Where:** `renderer/state/appStore.ts:1887`: "`synced`: the account settings sync brought it from another computer…" sits above `setCloudDefaultTier: (tier: CloudTierId) => void`, which no longer takes options.
- **Standard:** 6.
- **Judo move:** Replace it with "Sync calls this too; a person's pick is counted in `lib/cloudDefaultTier.ts`", or delete it. The implementation already has that comment at `:3040`.
- **Behavior:** preserved.

### B5 · Low · The nudge schedule has dead members and a second copy of one rule
- **Where:**
  - `lib/nudgePill.ts:27-28,59-60`: `NudgeSchedule.snoozeMessages` and `.maxDismissals` are returned, but nothing reads them. The pills read `STAR_PILL_*` and `INVITE_PILL_*` directly.
  - `lib/nudgePillActivity.ts:16` hand-rolls `{ ...prev, messagesSent: prev.messagesSent + 1 }` for the star pill instead of `STAR_PILL_SCHEDULE.messageSent`.
  - `lib/invitePill.ts:98-99` checks `countsMessages` and then calls `messageSent`, which checks it again.
  - "Is this the final dismissal" has two idioms: `InviteFriendsPill.tsx:50` (`dismissCount >= INVITE_PILL_MAX_DISMISSALS - 1`) and `StarRepoPill.tsx:171` (`showing === "prompt_first"`).
  - The comment at `starPillActivity.ts:22` says "two showings", but the type is now the 3-member `NudgeShowing`.
- **Standard:** 1 and 3.
- **Judo move:**
  - Drop the two dead members.
  - Add `finalDismissal(prefs)` to the schedule and use it in both pills.
  - The star path becomes `if (starPillCountsMessages(s)) state.updateStarPill(STAR_PILL_SCHEDULE.messageSent)`.
  - The invite path keeps just `updateInvitePill(INVITE_PILL_SCHEDULE.messageSent)`. Its guard only skips a no-op localStorage write and a notify. Keep the guard if that write matters, and say so in a comment.
  - Type the star outcome as `Exclude<NudgeShowing, "prompt_third">`, or fix the comment.
- **Behavior:** preserved.

### B6 · Low · `useDraftCloudPick` has a nested ternary and two copies of the gate check
- **Where:**
  - `components/chat/useDraftCloudPick.ts:70-78`: `current` is a ternary nested three deep (moved over from `AgentChatPane`).
  - The Cursor/Devin "its gate is closed" check is written twice, at `:87-88` and at `:103-106`.
- **Standard:** 3.
- **Judo move:**
  - Add `const gateClosed = (t: WorkDraftCloudTarget | null) => (t?.provider === "cursor" && !cursorCanLaunch) || (t?.provider === "devin" && !devinCanLaunch);` and use it in both effects.
  - Write `current` as an if-chain or a small `targetOf(...)` function.
- **Behavior:** preserved.

### B7 · Low · Orphan `.ade-ig-*` CSS left from the deleted cloud cards
- **Where:** in `settings/integrations/integrationPage.css`:
  - `:777-781`: `.ade-ig-field`, `-field-label`, `-field-controls`
  - `:782`: `.ade-ig-code-input`
  - `:792-805`: `.ade-ig-state`
  - `:806`: `.ade-ig-card-foot`
  - `:834-837`: `.ade-ig-hero-foot-row`
  - `:838-841`: `.ade-ig-ready-steps`
  - `:842`: `.ade-ig-chip-btn`
- No TS or TSX file uses any of them at base or at head. On main, `CloudReadyMachinesCard`, `CloudMachinesCard` and `CloudSection` used them; this branch deleted those cards earlier. The delta removed the `.ade-ig-figures` orphans from this same file but missed these.
- **Standard:** 1.
- **Judo move:** Delete those rules.
- **Behavior:** preserved.

### B8 · Low · A cast to get around narrowing, and a placeholder promise
- **Where:**
  - `apps/ade-cli/src/services/account/hardwareAnchor.ts:278`: `(cachedAnchorUuid as { value: string | null } | null)?.value`. It casts only because TS narrowed the module `let` before the await.
  - `apps/desktop/src/main/services/adeCloud/cloudAccess.ts:100` builds `entry` with a dummy `Promise.resolve(...)` that is then overwritten.
- **Standard:** 6.
- **Judo move:**
  - Read the cache through a one-line `cachedAnchor()` getter, which TS does not narrow, or restructure as `if (!probeFailed) cachedAnchorUuid ??= { value }; return cachedAnchor()?.value ?? null;`.
  - In `cloudAccess.ts`, keep the retry time in its own module `let freePlanRetryAt: number | null`. Reset it when a read starts and set it in the `.then`. `freePlanComputer` then goes back to a plain `Promise | null`, and the placeholder goes away.
- **Behavior:** preserved.

## Not findings (checked)

- `cloudAccountStore.ts`: one module store with two writers. `useCloudMachines` publishes into it and marks it fed; it does not import `useCloudMachines`, so there is no cycle. When it is not fed, it has its own coalescing read of `listMachines`. Folding that read into the shared list's `load()` would also start settling polls from the header, which changes behavior and perf, so it is left as is.
- The forward reference to `markDraftCloudChosen` (`AgentChatPane.tsx:12079`) is called later at `:17190`. It is safe: `useWorkDraftLaneRequest` calls `onRequest` from an effect through a ref.
- `cloudLaunchScope.ts` now replaces both inline Cursor and Devin pin/git blocks; neither copy is left.
- The iOS split moved code by line range, with a header in each new file. `CloudPaneSheet.swift`'s header still lists the page's sections without saying which file now holds each. That is cosmetic and not listed above.
