# Cloud 5 · /quality Track A3 · renderer and iOS correctness

Reviewer: qa-ui (Opus 5.5). Review base `202dc0676`. Scope: `apps/desktop/src/renderer/**` and `apps/ios/**`
in `git diff 202dc0676`, working tree as of 2026-11-11 (includes `2b0ec191c`, iPhone invite card).
Review only: no file edited except this report.

Every finding below was checked against the code. Items I could not confirm were dropped.

## Summary

| # | Sev | Where | One line |
|---|-----|-------|----------|
| 1 | High | `settings/cloudDashboard/CloudPlans.tsx:119-127` | "Stay on Pro" can never show: a Pro account with a scheduled move to Plus has no way to undo it (regression from `CloudPlanCard`) |
| 2 | High | `chat/AgentChatPane.tsx:17279`, `:17313` | The saved cloud pick is read from the ROOT store, not the project store it's written to, so item 10 doesn't work within a session and can bring back an old pick |
| 3 | Medium | `chat/AgentChatPane.tsx:17315-17320` (+ `:17184`, `:17251`) | An explicit "This computer" or machine pick made while Cursor/Devin's gate is closed isn't saved; the old Cursor/Devin pick comes back later |
| 4 | Medium | `ios/.../ConnectionSettingsView.swift:131-140`, `SyncService+Cloud.swift:390-400` | iPhone: `cloudAvailable` is never reset on disconnect or machine switch, so the new Settings › ADE Cloud row shows while access is unknown (a flash) |
| 5 | Medium (needs human) | `ios/ADE/Views/Cloud/CloudPaneSheet.swift:729` | iPhone plans card: "Change your plan in the ADE desktop app." reads as an App Store call to action pointing outside in-app purchase |
| 6 | Low | `settings/cloudDashboard/CloudInvite.tsx:160` | `ade://invite/<CODE>` opened while Settings › Account is already open doesn't fill the box (`initialCode` only seeds `useState`) |
| 7 | Low | `usage/HeaderCloudMeter.tsx:32-48, 76-78` | Module store: an in-flight read that lands after access turns off brings back the old account; refreshes asked for during a read are dropped |
| 8 | Low (perf) | `usage/HeaderCloudMeter.tsx:21, 50-56` | A new 5-minute `listMachines` poll on always-visible chrome, a second store beside `useCloudMachines`; the dashboard's refresh never updates it |
| 9 | Low (needs human) | `usage/HeaderCloudMeter.tsx:82-89`, `cloudDashboardModel.ts:171-181`, `CloudDashboard.tsx:307` | Plan-only hours: a red "0 h of 0 h left" ring for a refused free plan, or once plan hours run out, even with earned hours left; forecast ignores earned hours |
| 10 | Low | `settings/cloudDashboard/CloudInvite.tsx:38-39` | Toast hard-codes "20 free cloud hours" instead of `referral.rewardMilli` |
| 11 | Low | `usage/HeaderCloudMeter.tsx:164-166` | "Invite friends, get hours" always shows, even with no referral or no rewards left; it opens an anchor that isn't rendered |
| 12 | Low | `settings/CloudSection.tsx:85-103` | `connected:false` with no error and not signed out (main says `no_access` while the renderer still says yes) spins forever on "Reading your ADE Cloud account…" |
| 13 | Low | `settings/CloudPlanCard.tsx` (whole file) | Dead file: nothing imports it any more |
| 14 | Low (shared, cross-scope) | `shared/settingsAgentAccess.ts:91-98` | `ade-cloud.plans` / `ade-cloud.sizes` are not in the `money` list, so their chips (and the generated iOS catalog: `locked: false`) draw no lock |

What I checked and found correct (no finding): access gating everywhere on desktop (Settings tab via the
manifest, `CloudSection`, header ring, invite pill, Account invite box, end notice, sign-in card lines) never
shows before the yes; UTC dates (`formatCloudDate`, iOS `cloudDate`); hours-left-at-size math
(`cloudTierHoursLeftLabel`); the free-plan refusal sentence; past_due and `cancelAtPeriodEnd` hiding the plan
actions; Pro→Plus confirm wording and date; the Cursor/Devin launch pins (`cloudPin` on push, sync status,
origin, open PR, create run, open chat, `cloudAgents.launch`, lane tags, adoption `runtimePin`); the Cursor draft
reads keyed on `pin?.key`; Devin sign-in status pinned and re-read on `chatRuntimePinKey`; hooks order in
`HeaderUsageControl` and `AgentChatPane` (no use of `adeCloudMode` before its declaration); `invitePill.ts`
localStorage reads and writes wrapped; `browserMockCloud` runs only under `shouldInstallBrowserMock` and
`?mockCloud=`; the iPhone shows no price and no buy button (prices decode but are never displayed; no `¢`/`$`
text); launch refusal card and `markChatLaunchStartFailed` / Retry; launch seed ordering
(`applyLaunchConfigToComposer` declared before `seedComposerFromLaunch`).

---

## 1. High: "Stay on Pro" is unreachable

**Where:** `apps/desktop/src/renderer/components/settings/cloudDashboard/CloudPlans.tsx:119-127` (and `choose`, `:87-95`).

**Evidence.**
```ts
const actionFor = (column: Column) => {
  if (column.id === current) return null;            // Pro is `current` while the move to Plus waits
  ...
  if (nextPlanId === column.id) return null;          // Plus column: null
  if (column.id === "pro" && nextPlanId === "plus") return { label: "Stay on Pro", primary: true }; // never reached
```
While a downgrade waits, the server still reports `planId: "pro"` (`store.ts:1026` `boughtPlanIdOf` reads
`paid_plan`, which stays `pro` until the period ends) and `nextPlanId: "plus"`. So `current === "pro"`, the first
`return null` fires for the Pro column, and the Plus column returns null too. No column has an action.

At the base this worked: `CloudPlanCard.tsx` (still in the tree, now unused) rendered "Stay on Pro" →
`checkout("pro")` when `nextPlanId === "plus"`. The server supports it (`billing.ts:280`, `undoDowngrade`:
uncharged).

**Failure.** A Pro customer clicks "Move to Plus", changes their mind, and has no way back in ADE. "Manage
billing" (Stripe portal) may not undo a scheduled item change. This removes a billing control that existed
before.

**Even if reached,** `choose(pro)` would open the "Move to Pro? … You pay the difference for the rest of this
month now" confirm, which is wrong for an undo (it is uncharged).

**Fix (unambiguous, restores base behavior).**
- In `actionFor`, test `column.id === "pro" && nextPlanId === "plus" && paid && !pastDue && !billing.cancelAtPeriodEnd`
  before the `column.id === current` return.
- In `choose`, when `target.id === "pro" && nextPlanId === "plus"`, call `checkout("pro")` directly with no
  "pay the difference" confirm (as the base did), and toast "You stay on Pro."

## 2. High: the saved Run on cloud pick is read from the root store

**Where:** `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx:17279` and `:17313`.

**Evidence.**
- Both effects read `useAppStore.getState().getWorkViewState(workDraftProjectStateKey).draftCloudTarget`.
  `useAppStore.getState` is `rootAppStore.getState` (`appStore.ts:4223`), not the store in context.
- The write goes to the project store: `setWorkViewState` comes from `useAppStore((s) => s.setWorkViewState)`
  (`:4469`), which resolves the `AppStoreProvider` context. Every project tab mounts its own store (`App.tsx:761`).
- The root store's `workViewByProject` is the copy it loaded at startup. A project surface's writes reach it only
  through `retainProjectAppStoreState` when that surface is torn down (`appStore.ts:4130-4150`). The comment at
  `appStore.ts:4086` describes exactly this split.

**Failure.**
- The Work surface stays mounted, but the draft pane (`WorkStartSurface` → `AgentChatPane`) unmounts whenever a
  chat is shown (`WorkViewArea.tsx` ternary) and mounts again when the draft comes back. That is item 10's
  "leave the draft and come back".
- On that remount the restore reads root:
  - **Pick lost.** The app started with no saved pick, and the person picked ADE Cloud this session: root says
    null, so nothing is restored. Item 10 stays broken within a session.
  - **Stale pick back.** The app started with ADE Cloud saved, and the person chose This computer this session:
    root still says ADE Cloud, so the restore puts it back and the save effect writes it into the project store
    again. The next Send can create an ADE Cloud lane (spending hours) after the person turned it off.
- The launch-fixes report says this path was "Not run in the dev app".

**Fix (unambiguous).** Read through the context store:
- `const appStoreApi = useAppStoreApi();`, then `appStoreApi.getState().getWorkViewState(...)`.
- Or subscribe: `const savedDraftCloudTarget = useAppStore((s) => s.getWorkViewState(workDraftProjectStateKey).draftCloudTarget)`
  and use that value in both effects.

Lines `13442` and `13518` read `projectBinding` from the root store the same way, but they predate this branch
and are out of scope.

## 3. Medium: an explicit pick while Cursor/Devin's gate is closed is not saved

**Where:** `AgentChatPane.tsx:17315-17320`, with `handleDraftShelfMachineChange` (`:17184`) and
`useThisComputerForDraft` (`:17251`).

**Evidence.**
- The save effect skips the write when the current target is null and the saved one is Cursor (or Devin) whose
  `…CanLaunch` is false. The skip is meant for "dropped by its gate".
- A person who picks "This computer" or another machine also produces a null target. `restoredDraftCloudKeyRef`
  is set, but the guard can't tell that pick from a gate drop.
- The gate is closed whenever `cursorCloudCanLaunch` is false: no `laneId` yet, a Cursor status not read yet, a
  chat with events.

**Failure.**
1. Saved: Cursor Cloud.
2. The draft opens before Cursor's gate opens.
3. The person picks This computer, so nothing is written and the saved pick stays Cursor.
4. On the next remount, the restore waits for `cursorCloudCanLaunch` and switches the draft back to Cursor
   Cloud.

The launch-fixes report lists this case as a failure mode for `/test` ("The person picks a machine before a
Cursor/Devin restore") but did not handle it.

**Fix (unambiguous).**
- Add `personPickedDraftCloudRef`, set to true wherever `restoredDraftCloudKeyRef.current = key` is set by a
  person: `:12090`, `:17184`, `:17251`.
- In the save effect, apply the gate guard only when that ref is false.

## 4. Medium: iPhone shows the ADE Cloud Settings row while access is unknown

**Where:** `apps/ios/ADE/Views/Settings/ConnectionSettingsView.swift:131-140, 221-225, 257-261` and
`apps/ios/ADE/Services/SyncService+Cloud.swift:390-400`.

**Evidence.**
- `cloudAvailable` (`SyncService.swift:4475`) is set only by `refreshCloudAvailability()`. Nothing sets it to
  false when the connection drops, the phone moves to another machine, or the account signs out.
- The new `.task(id: connectionState == .connected)` returns early on disconnect without clearing it. Its comment
  says "Until the answer, the ADE Cloud row stays hidden", which is not what the code does.

**Failure.**
1. The phone was on a machine of an account with access (`cloudAvailable = true`).
2. It disconnects, or connects to a machine of a second account without access.
3. Settings lists "ADE Cloud" (and the Providers "ADE Cloud" place) until the `access` read answers, or for the
   whole time it is offline.

This breaks decision 6, "Unknown / offline = hidden, never a flash". The state is old, but this branch adds the
new Settings route and Providers place on top of it.

**Fix (needs light judgment, matches the decision).**
- Set `cloudAvailable = false` when `connectionState` leaves `.connected` or the host identity changes: one
  place in `SyncService`, or the task's `guard ... else { syncService.cloudAvailable = false; return }`.
- Optionally also clear it at the start of `refreshCloudAvailability()` when the host differs from the last
  answer's host.

## 5. Medium (needs human): an App Store call to action on the iPhone plans card

**Where:** `apps/ios/ADE/Views/Cloud/CloudPaneSheet.swift:722-730`.

**Evidence.** The card shows the free account the Plus and Pro columns, then:
"Change your plan in the ADE desktop app." There's no price and no button, which is good. But App Store
guideline 3.1.1 / 3.1.3 forbids "buttons, external links, or **other calls to action** that direct customers to
purchasing mechanisms other than in-app purchase". Telling a free user where to go to upgrade is the kind of line
App Review flags.

**Failure.** A risk of rejection for the TestFlight/App Store build that ships this page.

**Fix (human).** Drop the line; the page states facts only. If a hint is wanted for paid users, show it only when
`account.plan == "paid"` and word it as account management, not as a way to upgrade.

## 6. Low: the invite deep link doesn't fill an already-mounted code box

**Where:** `apps/desktop/src/renderer/components/settings/cloudDashboard/CloudInvite.tsx:160` (`InviteCodeBox`
`useState(initialCode)`).

**Failure.**
1. Settings › Account is open, and the box is mounted with an empty value.
2. The person clicks "Open in ADE" on the invite web page, and `App.tsx:1484` navigates to `?invite=CODE`.
3. `AccountDetailsSection` stays mounted, so the box keeps its empty value.

**Fix (unambiguous).** `<InviteCodeBox key={inviteParam ?? ""} … />`.

## 7. Low: the header meter's module store races an access change

**Where:** `apps/desktop/src/renderer/components/usage/HeaderCloudMeter.tsx:32-48, 76-78`.

**Evidence.**
- `useEffect(() => { if (!enabled) account = null }, [enabled])` clears the cache, but a read already in flight
  still sets `account = <old account>` when it lands.
- `read()` returns early while `reading`, so a status-changed event during a read is lost until the next
  5-minute tick.

**Failure.**
1. Account A signs out mid-read, and the read lands with A's state.
2. Account B (with access) signs in, and `subscribe` serves A's hours, ring and invite referral until B's read
   answers.

That is a brief wrong-account flash. Separately, after a plan change the header can lag up to 5 minutes.

**Fix (unambiguous).**
- Add a generation counter: bump it when access turns off, and ignore results from older generations.
- Add a `readAgain` flag like `cloudAccess.ts` has.
- Or adopt #8.

## 8. Low (perf): a second account poll on always-visible chrome

**Where:** `HeaderCloudMeter.tsx:21, 50-56`.

**Evidence.**
- New `setInterval(read, 5 min)` plus an `onStatusChanged` subscription, live in every window while ADE Cloud is
  on. Each tick runs `cloud:listMachines`, which hits the server and the provider (`registerCloudIpc.ts:343`).
- It is a separate store from `useCloudMachines`, which the dashboard and composer already share. At startup
  both read once, and the dashboard's `refresh()` (after a plan change, Free up space or an invite) never
  reaches the header, pill or Account box.

Today only the owner's account sees it, so the cost is small. It is not in `docs/perf/macos-baseline.md`.

**Fix.** Back `useHeaderCloudAccount` with the `useCloudMachines` store (`settle: false`), adding its 5-minute
refresh there, or have `refresh()` also call the header's `read()`. Keeps one read path and fixes #7 as well.

## 9. Low (needs human): plan-only hours read as "out" when earned hours remain

**Where:** `HeaderCloudMeter.tsx:82-89, 149-152`; `CloudDashboard.tsx:307-339`; `cloudDashboardModel.ts:171-181`
(`hoursForecast`).

**Evidence.**
- `hours` is the plan's own hours (contract: "`hours` above stays the plan's own hours"). A refused free plan has
  `includedMilli: 0` (`store.ts:741`).
- The header ring and title then read "ADE Cloud 0 h of 0 h left" in red, and the same happens once plan hours
  run out, even with 20 earned hours left that work will use.
- The composer adds earned hours (`useAdeCloudDraft.ts`, `hoursLeftMilli = plan + earned`), so the two disagree.
- `hoursForecast` says hours run out on a date when earned hours carry past it.

**Fix (human: which number the meter shows).** Either base the ring, title and forecast on plan + earned, or
keep plan-only and add earned to the title ("0 h of 0 h + 20 h earned"). Not auto-applied.

## 10. Low: the reward size is hard-coded in the toast

**Where:** `CloudInvite.tsx:38-39`. The toast says "You both got 20 free cloud hours" and "You both get 20 free
cloud hours when…" while the card text uses `referral.rewardMilli`. If the server's reward changes, the toast is
wrong.

**Fix (unambiguous).** Use `formatCloudHours(outcome.referral?.rewardMilli ?? CLOUD_REFERRAL_REWARD_MILLI)`.

## 11. Low: the header's invite button with nothing to invite to

**Where:** `HeaderCloudMeter.tsx:164-166`.

**Evidence.** It always renders. With no referral summary (an older server) or `rewardsLeft === 0`, it opens the
dashboard at `cloud-invite`, which `CloudInviteCard` doesn't render (it returns null without a referral), so it
lands at the top of the page.

**Fix (unambiguous).** Render it only when `cloudReferralOf(state)?.rewardsLeft > 0`.

## 12. Low: an endless spinner when main says no access

**Where:** `apps/desktop/src/renderer/components/settings/CloudSection.tsx:85-103`.

**Evidence.**
- `readCloudStatus` returns `NO_ACCESS = { connected: false, signedOut: false, error: null }`
  (`main/.../cloudAccess.ts:310-315`).
- If the renderer's access flag is still true (it re-reads on focus or change), then `live` is false, the machine
  list isn't read, and `problem` is null. The page shows "Reading your ADE Cloud account…" with a spinner until
  access flips.
- The old page said "ADE Cloud isn't available on this account yet." The window is short, because the access
  change event hides the tab.

**Fix (unambiguous).** When `!loading && status && !status.connected && !status.signedOut && !status.error`,
return `null`. This matches the hidden state and avoids a flash.

## 13. Low: `CloudPlanCard.tsx` is dead

**Where:** `apps/desktop/src/renderer/components/settings/CloudPlanCard.tsx`. `CloudPlans.tsx` replaced it and
nothing imports it now. Delete it once #1 has taken its "Stay on Pro" behavior.

## 14. Low (shared, cross-scope): plans and sizes chips draw no lock

**Where:** `apps/desktop/src/shared/settingsAgentAccess.ts:91-98`.

**Evidence.**
- `ade-cloud.plans` ("plans and billing", the Stripe subscription) and `ade-cloud.sizes` fall to `PREFERENCE`.
  Agents still can't change them, but `settingIsProtected` is false.
- So the settings chip shows no lock, and the generated iOS catalog writes `locked: false`
  (`WorkSettingsCatalog.swift:231-232`) for a money setting.

**Fix (unambiguous).**
- Add `ade-cloud.plans` to `money`. Optionally add `ade-cloud.sizes` too, since it sets what new lanes cost.
- Regenerate the iOS catalog.

---

## Remote scoping (the CLAUDE.md check)

| New or changed renderer call | Machine | Verdict |
|---|---|---|
| Cursor launch: push, sync status, origin remote, open PR, `cursorCloudCreateRun`, `cursorCloudOpenChat`, `lanes.updateAppearance`, adoption | `cloudPin` = draft execution binding, null for the tab's own | correct |
| Devin launch: push, sync, `lanes.updateAppearance`, `cloudAgents.launch`, adoption; hand-off uses the chat's pin | `cloudPin` | correct |
| Cursor draft reads (repos, remembered secrets, open PR) | `chatRuntimePin`, effects keyed on `pinKey` | correct (repo list isn't re-read on a pin change once ready; it's account-level, so fine) |
| Devin sign-in status | `chatRuntimePinRef.current`, re-read on `chatRuntimePinKey` | correct |
| Dashboard, header meter, invite box, plans, sizes, sign-ins card | account level, no pin | correct |
| Web `providerLogins` adapter | `assertWebRuntimePinRoutable` refuses a foreign pin | correct |

No effect in the diff keys on a pin object.

## Windows

Nothing in this scope builds paths, launches processes or touches IPC transport. No Windows finding.
