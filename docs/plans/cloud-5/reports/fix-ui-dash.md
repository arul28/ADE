# /quality fix: dashboard UI (fix-ui-dash)

Branch `ade/cloud-5-dashboard-and-fixes`. Scope: qb-ui B-H2, B-H3, B-H4, B-M1–B-M6
(B-M4 minus the appStore `sizeId` part), B-M9, B-M10, the Lows on my files, the
hero exception note, the CloudSignIns switch-hint note; qa-ui #1, #6–#13.
Nothing committed. Paths are under `apps/desktop/src/renderer/` unless given in full.

## qb-ui

**B-H2 dead code: done.**
- Skyline: `CloudSkyline`, `CloudSkylineLane`, `cloudSkylineSummary` deleted from
  `components/remoteTargets/cloudBrand.tsx` (file now ends after `CloudSizeIcon`).
  `cloudBrand.css`: the `.adec-pill*` rules, every `.adec-sky-*` rule and the
  `--adec-sky-*`, `--adec-pill-border/-bg/-bg-hover` vars (dark and light) deleted;
  `--adec-pill-fg` kept (read by `cloudLane.css`). `useAdeCloudDraft.ts`: `skylineLanes`
  memo, its return field and the `CloudSkylineLane` import deleted. The
  `DraftMachineOption.skyline` field was already gone (fix-ui-chat).
- `components/settings/providers/cloud/AdeCloudSignInsRow.tsx` deleted.
- `cloud` IntegrationId: `integrationBrand.tsx:17-21` (`IntegrationId = ConnectProviderId`),
  the `cloud` brand entry and the `banners/ade-cloud.svg` import deleted (the svg file
  too: nothing else used it). `IntegrationsHome.tsx`: the `cloud` description, the
  `id !== "cloud"` / `if (id === "cloud") return UNKNOWN` branches, the `cloud` keys in the
  three summary objects (`:99-110`), the filter memo (param renamed back to
  `integrations`) and the anchor ternary (`:322`) deleted.
- `components/app/ConnectionsPanel.tsx:309` now `navigate("/settings?tab=ade-cloud")`.
  The redirect in `SettingsPage.tsx:368` stays, comment says it's for outside links.
- Orphaned CSS found while there: `integrationPage.css` `.ade-ig-limit-rows/-row/-controls`
  and `.ade-ig-figures/-figure` had no user left after the two deletions; removed.

**B-H3 warning cards to `<Banner>`: done.** `cloudDashboard/CloudDashboard.tsx:224-236`
disk card is `<Banner layout="inline">` (`cloud-disk-full`, warning, "Free up space"
action, `report: false`); `:643-665` the plan-cleanup card is a warning Banner, title =
server sentence, detail = due-date sentence, `extra` = the computers list
(`.adecd-cleanup-list`). `.adecd-warn*`, `.adecd-cleanup*` CSS deleted. `Warning` icon
import dropped.

**B-H4 header store: done.** New `state/cloudAccountStore.ts` (`useCloudAccount`,
`noteCloudAccountRead`, `setCloudAccountFed`). `useCloudMachines.ts` publishes every
read's account (`load`) and marks the store fed while it watches (`startWatching` /
`stopWatching`); while fed, the store's 5-min timer and status-change read skip
(the shared list already reads on focus and cloud events). Access off runs `forget()`
inside the store (generation bump + notify), so an in-flight read is ignored (qa #7),
and a read asked for during a read sets `readAgain` (qa #7). `HeaderCloudMeter.tsx`
keeps only the ring, title and panel. Consumers switched: `usage/HeaderUsageControl.tsx:35,341`,
`account/AccountPage.tsx:54,382`, `app/projectSidebar/InviteFriendsPill.tsx`.

**B-M1 kit adoption: done.** `kit-panel` added to `.adecd-billing` (CloudPlans x2),
`.adecd-sizecard` (CloudSizes), `.adecd-signin-list` (CloudSignIns), invite stats cells
(CloudInvite), `.adecd-fl` (CloudFreeUpSpace), the limits rows (CloudAgentLimitsCard);
their border/radius/background declarations deleted. Pills: "Your plan" →
`kit-tag data-tone="accent"`, "From <date>" → `kit-tag`, size "Default" →
`kit-tag data-tone="accent"` (keeps `.adecd-sizecard-pick` for layout only). Kit gained
`.kit-tag[data-tone="accent"]` reading `--kit-tag-accent` (fallback `--color-accent`)
in `styles/surfaceKit.css`; `.adecd` sets it to ADE Cloud blue (dark `--adec-300`,
light `--adec-600`). Hero button is `kit-btn data-size="sm"` (`CloudDashboard.tsx:337`);
`.adecd-hero-btn` CSS deleted.

**B-M2 colour for meaning: done.** Hero warn note → `var(--kit-warn)`; the earned-hours
bold uses a new brand token `--adec-lamp-text` in `cloudBrand.css` (dark = lamp, light
= the old #b26b00) instead of a hex in the dashboard sheet. `.adecd-old` (hex) deleted;
CloudFreeUpSpace uses `kit-tag data-tone="warn"`. Header "Disk almost full" →
`text-[var(--kit-warn)]` with `>= CLOUD_DISK_WARN_SHARE * 100`
(`HeaderCloudMeter.tsx:125`). The `.adecd-hero .kit-num` font override deleted; the kit
gained `.kit-num[data-face="ui"]` (surfaceKit.css), set on the hero, plan, size and
invite figures. The DraftMachinePicker amber was already fixed by fix-ui-chat. Left
as is: the city's own palette (`.adecd-flag`, readout) under the hero exception.

**B-M3 CSS hygiene: done.** One `.adecd` gap (16px), one `.adecd-name-text`, the second
`.adecd-warn .kit-btn` gone, orphan section comments deleted ("Header", "The three
facts…", "The selected lane", "Rows that open", "The older cards…"), appended rules
moved into their sections (`.adecd-plan-wrap`, `.adecd-plan-fine[data-tone]` into
Plans). `.adecd-empty` + `.adecd-card .adecd-empty` are not duplicates (the dialog's
empty line uses the base); kept as base + one card variant side by side, unused
`.adecd-citycard .adecd-empty` deleted. `adecd-signins-lead` → `adecd-lead`
(CloudSignIns, CloudInvite, CloudAgentLimitsCard). `.adecd-acct-invite` stays with
the InviteCodeBox styles (CloudInvite owns it on both pages), commented.

**B-M4 casts: done except two parts.** `CloudPlans.tsx` `result?.cleanup` (no cast);
`lastRunText` cast dropped; `CloudSizes` `tier.id as CloudTierId` gone; `CloudSignIns`
filters with a type guard (`ProviderDescriptor & { id: ProviderLoginProvider }`), both
casts gone; `webclient/shell/webRoutes.ts:109-113` builds the invite route with `URL` /
`searchParams`. NOT done here: the appStore `sizeId` (fix-ui-chat), and the
`CloudPassEnd` union: fix-main is renaming that type (`CloudSignInEnd`, `kind`
required) in `shared/cloudSignIns.ts` right now, so I sent fix-main the union shape and
the two renderer spots (`adeCloudEndNotice.ts`, `CloudSignInEndNotice.tsx`) and did not
touch them.

**B-M5 one hours-left rule: done.** `shared/adeCloud.ts`: `cloudHoursLeftMilli`
(plan left + max(0, earned left)), `CLOUD_DISK_WARN_SHARE`, `percentOf`,
`formatCloudGb` (was `formatGb`). Callers: `CloudSizes`, `useAdeCloudDraft`
(`hoursLeftMilli`), `hoursForecast`, `HeaderCloudMeter`; `earnedHoursLeftMilli` deleted
(hero uses `cloudEarnedHoursOf`). No renderer file outside settings imports
`cloudDashboardModel` any more.

**B-M6 boundary: done.** `CloudPlanFacts`, `CloudPlanId` re-exported from
`shared/adeCloud.ts`; `CloudPlans.tsx` imports them there. `RANK` →
`CLOUD_PLAN_RANK` beside `CLOUD_PLAN_LABELS`.

**B-M9 analytics out of the store: done.** `state/appStore.ts` `setCloudDefaultTier`
is pure (no options, no capture); `lib/accountSettingsSync.ts:155` drops `{ synced }`.
New `lib/cloudDefaultTier.ts` `pickCloudDefaultTier(tier)` saves and captures
`cloud_default_size` only when the value changed; used by `CloudSizes` and
`useAdeCloudDraft`'s `setDefaultTier`. Same two user paths emit; sync never does.

**B-M10 shared nudge schedule: done.** New `lib/nudgePill.ts`
(`createNudgeSchedule({ snoozeMessages, maxDismissals, firstAfterMessages })`: visible,
countsMessages, showing, shownDue, markShown, dismissed, messageSent). Star pill:
`STAR_PILL_SCHEDULE` (20, 2, 1) in `starPill.ts`; `isStarPillVisible` /
`starPillCountsMessages` add `!starred`; prefs, account sync and `mergeStarPillPrefs`
untouched. Invite pill: `INVITE_PILL_SCHEDULE` (40, 3, 0) in `invitePill.ts`,
localStorage as before. Both pill components use `markShown` / `dismissed`. One
`recordNudgeMessageSent()` (`lib/nudgePillActivity.ts`) replaces the two calls in
`AgentChatPane.tsx` (import `:518`, call `:15137`; a 3-line change in fix-ui-chat's file,
made after re-reading it). Rule equivalence checked case by case (first showing,
snooze, final dismissal, showing index, what counts a message). `docs/features/cto/README.md`
names the shared schedule.

**Lows: done.** `formatShortDate` removed (callers use `formatCloudDate`); `dashLanes`
comparator no longer orders by `noLane` (the two filters do it); `noLaneName` uses
`CLOUD_MACHINE_DEFAULT_NAME` (new in `shared/adeCloud.ts`; also used by
`browserMockCloud.ts`; main's two literals in `cloudMachineCreator.ts:259` and
`cloudAgentActions.ts:555` left for fix-main, told them); InviteCodeBox toast reads the
reward (below, qa #10) and its `data-source` attribute and the `source` prop are gone;
`CloudAgentLimitsCard.tsx` re-indented, rows are `kit-panel adecd-limit-rows` /
`adecd-limit-row` styled in the dashboard sheet (no more borrowing the Integrations
page's rows); `cloudDashboard.css` import dropped from `CloudDashboard.tsx` (CloudSection
needs it for its own states; CloudInvite for Settings › Account).

**Hero exception: done.** `docs/design/visual-language.md` gets "Exception: the ADE
Cloud hero" under Colour rules, plus kit table rows for `kit-tag` accent and
`kit-num data-face="ui"`.

**CloudSignIns switch hint: done.** The line under the switch says the current state,
as iOS does: on = "Cloud computers use the accounts you're signed in to on your
computers.", off = "Off: you sign in on each cloud computer yourself." (`CloudSignIns.tsx`).

## qa-ui

- **#1 Stay on Pro: fixed.** `CloudPlans.tsx:54` `canStayOnPro` (paid, not past due, not
  cancelling, current Pro, next Plus); `actionFor` returns "Stay on Pro" for the Pro
  column before the current-plan check (`:131`); `choose` calls `stayOnPro()` (`:90`):
  `openCheckout("pro")`, no "pay the difference" confirm, toast "You stay on Pro."
  Checked in the browser (new `mockCloud=downgrade` scenario): button shows on the Pro
  column, click gives the toast with no dialog.
- **#13 CloudPlanCard.tsx: deleted** (after #1). `docs/features/ade-cloud/README.md`
  Surfaces line updated (it named the file and the old Integrations page).
- **#6 invite link into a mounted box: fixed.** `CloudInvite.tsx:166`
  `<InviteCodeBox key={inviteParam ?? ""} …>`.
- **#7 header store race: fixed** by the store (generation on access off, `readAgain`).
- **#8 second poll: fixed** by the store: the dashboard/composer reads feed it, and its
  own 5-min read and status read stop while the shared list is watched. Perf note: one
  fewer `listMachines` per status event while the dashboard or composer is open; no new
  timer. Not measured (no perf run; nothing added to a hot path).
- **#9 plan + earned: fixed** per the decision. `HeaderCloudMeter.tsx:36` `hoursOf`:
  left = `cloudHoursLeftMilli`, total = included + earned left + earned used this
  period (holds still while earned hours are used); ring, title and panel big number
  read it; the panel line says "Includes N h earned". `hoursForecast` uses
  `cloudHoursLeftMilli`. The hero keeps the plan's own "of N h" and the earned line.
  Browser: plus mock shows "327 h left of 540 h" (287 + 40).
- **#10 reward in toast: fixed.** `CloudInvite.tsx:42` uses
  `outcome.referral?.rewardMilli || CLOUD_REFERRAL_REWARD_MILLI`.
- **#11 invite button: fixed.** `HeaderCloudMeter.tsx:103,131` only with
  `rewardsLeft > 0`.
- **#12 endless spinner: fixed.** `CloudSection.tsx:80` returns null for main's
  no-access status (`connected: false`, not signed out, no error; only `NO_ACCESS` in
  `cloudAccess.ts` has that shape).

## Also touched

- `shared/adeCloud.ts`: removed `CLOUD_FREE_PLAN_REFUSED_SENTENCE` from the
  re-export block. Another helper deleted it from `account-directory/src/cloud/contract.ts`;
  the stale re-export broke the renderer in Vite (blank page). Nothing used it. fix-main told.
- `shared/adeCloud.ts` re-exports `cloudFreePlanRefusedSentence`; `browserMockCloud.ts`
  builds the refused free plan's sentence with it
  (`cloudFreePlanRefusedSentence(CATALOG.plans.plus.includedMilli)`) instead of a literal.
  The new `mutual` invite refusal needs no UI change (the box shows the server's message).
- `browserMockCloud.ts`: new `mockCloud=downgrade` scenario (Pro, next Plus, a
  `planCleanup` with two computers) to check #1 and the cleanup Banner by eye.

## Screenshots checked (scratchpad, 1360x900, dark)

- `plus-top.png`: hero (kit-btn "Plan and billing"), disk Banner with "Free up space".
- `plus-plans.png`: Plans (accent "Your plan", kit-panel billing, UI-face figures),
  Sizes ("Default" tag, "327 h" = plan + earned).
- `plus-invite.png`: invite stats panels, sign-ins list panel, limits panel.
- `downgrade-top.png`: plan-cleanup Banner with the computers list in `extra`.
- `downgrade-plans.png`, `stay-on-pro.png`: "Stay on Pro" and its toast.
- `header-plus.png`: header popover, "327 h left of 540 h", "Includes 40 h earned",
  "Disk almost full" in warn colour, invite button.
- `full-free.png`: Free up space dialog (kit-panel rows, "Not used for a long time"
  warn tag; it wraps under the name at this width).
- Not checked: light theme (`mockTheme=light` did not switch the preview), the
  Account page invite box, `blocked`/`empty`.

## Checks (one pass)

- `npm run typecheck` (apps/desktop): pass (after one fix: the `cloud` keys in
  IntegrationsHome's summary objects).
- `npm run lint:ci`: 0 errors, 852 warnings, "ade-ui ratchet: no new violations".
  Touched files linted directly: one warning, `useAdeCloudDraft.ts:260`
  exhaustive-deps on `input`, pre-existing (the composer notice memo, not edited).
- Tests: SettingsPage, TopBar, cloudMachineModel, usage, accountSettingsSync,
  starPill, webClientShell, crossMachineLanes, PublishToGitHubDialog: 9 files, 299
  passed. Main tests importing `shared/adeCloud` (accountActionBridge,
  cloudAgentActions): 2 files, 43 passed. No test needed changing.

## Left

- B-M4 `CloudPassEnd` → union: handed to fix-main (they own the rename in progress).
- Main literals "ADE Cloud computer" → `CLOUD_MACHINE_DEFAULT_NAME`: fix-main's files.
- Failure modes for /test (notes, no tests written): the store keeps an old account
  if access turns off between a read's answer and `forget` (guarded by generation);
  a `fed` store never reads on its own until the shared list stops watching; Stay on
  Pro must never show while cancelling or past due; the shared schedule must keep the
  star pill's exact counts (`starPill.test.ts` passes unchanged).

## Round 2 (qd-a, qd-b)

- **qd-a M1 (cloudAccountStore): fixed.** `state/cloudAccountStore.ts`: one `take(result)`
  for both writers records `lastAccountAt` on every answer (`noteCloudAccountRead` and the
  store's own read; a failed own call also stamps it, so a dead network retries in 5
  minutes, not every minute). The timer is now a 60 s age check (`readIfOld`): it reads
  only when the last answer from either writer is 5 minutes old, fed or not, so at most
  one list read per 5 minutes. Change events still read only while unfed (the shared list
  reads on them itself). `take` publishes null only for `not_connected` /
  `access_refused`; `unreachable` and `ok` with `account: null` keep the last account.
  Sign-out still hides it at once through `useAdeCloudEnabled` + `forget()`. Doc comment
  rewritten to match.
- **qd-a L4 (Stay on Pro): fixed.** `CloudPlans.tsx` `stayOnPro` toasts "You stay on
  Pro." only on `result?.change === "now"`; anything else throws inside `run`, which sets
  the plan error Banner ("ADE Cloud didn't keep you on Pro. Try again in a moment, or use
  Manage billing."). The server's undo answers `change: "now"` (`billing.ts:344`). The
  browser mock's `openCheckout` now answers like the server for a paid account
  (`{ opened: false, change }`, Pro to Plus = `next_period`), so the mock flow still works.
- **qd-b B5 (nudge schedule): fixed.** `lib/nudgePill.ts`: `snoozeMessages` /
  `maxDismissals` members dropped from `NudgeSchedule`; new `finalDismissal(prefs)`
  (`dismissCount >= maxDismissals - 1`), used by `InviteFriendsPill.tsx` (`last`) and
  `StarRepoPill.tsx` (the × title; same result as `showing === "prompt_first"` for 2
  dismissals). `nudgePillActivity.ts` uses `STAR_PILL_SCHEDULE.messageSent`. The invite
  path keeps its `countsMessages` guard, with a comment: it skips a localStorage write and
  a notify on every send. Star outcome: kept `NudgeShowing` and fixed the comment
  (`starPillActivity.ts`): only `prompt_first` / `prompt_second` are ever sent.
- **qd-b B7 (orphan CSS): fixed.** Each class confirmed with no TS/TSX user (word match
  across `apps/desktop/src`, and no `ade-ig-${…}` template): deleted `.ade-ig-field`,
  `-field-label`, `-field-controls` (and their `@container integrationpage` block),
  `.ade-ig-code-input`, `.ade-ig-state`, `.ade-ig-card-foot`, `.ade-ig-hero-foot-row`,
  `.ade-ig-ready-steps`, `.ade-ig-chip-btn` from `integrationPage.css`. `.ade-ig-hero-foot`
  stays (`IntegrationChrome.tsx:180`); its comment no longer says ADE Cloud.
- **Checks:** desktop typecheck pass; tests starPill, usage, SettingsPage,
  accountSettingsSync: 4 files, 128 passed; eslint on the touched files: clean.
