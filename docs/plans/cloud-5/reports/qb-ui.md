# Quality Track B1: UI maintainability (renderer + iOS)

Branch `ade/cloud-5-dashboard-and-fixes` (PR #2177). Review base `202dc0676`.
Scope: `apps/desktop/src/renderer/**` and `apps/ios/**` in `git diff 202dc0676`.
Standard: `.claude/skills/quality/references/thermo-nuclear-review.md` (S1 structural
simplification, S2 1k-line rule, S3 spaghetti, S4 design over acceptance, S5 direct
code, S6 type/boundary clarity, S7 canonical layer). Review only: no source edits.

Each finding: **where**, **standard**, **judo move**, **behavior-preserving?**

---

## 0. UI primitives check (lint + by eye)

**`npm run lint:ci` (apps/desktop, run once):** 0 errors, 854 warnings repo-wide;
`ade-ui ratchet: no new violations against apps/desktop/lint-baseline.json`.

**`ade-ui/*` warnings in files this branch touched:** none. I linted the 48 touched
renderer `.ts/.tsx` files directly (`eslint --format unix`) to list them: zero
`ade-ui/*` hits, and `lint-baseline.json` has no entry for any touched file.

**Other new warnings on lines this branch added** (from the same per-file run):

| File:line | Rule | Note |
|---|---|---|
| `components/chat/AgentChatPane.tsx:8116` | `react-hooks/exhaustive-deps` (unnecessary dep `chatRuntimePinKey`) | see B-H1 / B-M8 |
| `components/chat/AgentChatPane.tsx:17302` | `react-hooks/exhaustive-deps` (missing dep `adeCloud`) | see B-M8 |

**By eye (what the lint can't see), against `docs/design/notices.md`:**

- **Hand-rolled notice: `.adecd-warn`.** `CloudDashboard.tsx:218-224` (disk 80% full)
  and the new `PlanNotices` cleanup notice `CloudDashboard.tsx:632-648` are cards that
  copy the banner look with a class (`cloudDashboard.css:23-35`, `:729-733`: tinted
  `--kit-warn` border + background, icon, trailing button). This is exactly the
  "hand-built card that copies the banner look" notices.md tells reviewers to flag. The
  same function already renders its two sibling notices with `<Banner layout="inline">`
  (`:650-651`), so one card group uses two notice systems. See B-H3.
- No custom scrim/panel, no `fixed`, no `z-[N]` in touched files. `.adecd-readout`
  (`cloudDashboard.css:207`) uses `z-index: 3` inside its own surface (allowed by
  notices.md's "inside one surface" rule). `InviteFriendsPill` correctly renders through
  `<Banner layout="floating">`.
- The plan-change error in `CloudPlans.tsx:278-280`, the sign-in error in
  `CloudSection.tsx`, and every toast use the primitives. Good.

---

## High

### B-H1. `AgentChatPane.tsx`: the draft cloud-pick persistence belongs in a hook
- **Where:** `AgentChatPane.tsx:4001-4004` (`sameDraftCloudTarget`), `:5004`, `:5015`
  (`restoredDraftCloudKeyRef`), `:12090`, `:17184`, `:17251` (the ref written in three
  separate handlers), `:17259-17323` (`keepsDraftCloudPick`, `currentDraftCloudTarget`,
  the restore effect and the save effect). About 90 new lines in a 21,010-line file
  (+162 net on this branch).
- **Standard:** S2 (file growth along a clear responsibility seam), S3 (an implicit
  protocol: every place the person picks a machine must remember to write
  `restoredDraftCloudKeyRef.current = workDraftProjectStateKey`, or a saved pick
  overwrites their choice; that rule lives in four distant spots).
- **Judo move:** extract `components/chat/useDraftCloudPick.ts`:
  `useDraftCloudPick({ projectKey, keeps, current, cursorCanLaunch, devinCanLaunch, apply, setWorkViewState }) => { markChosen }`.
  Move `sameDraftCloudTarget`, the ref, both effects and `currentDraftCloudTarget` into
  it; `apply(saved)` is the existing restore body. The three handlers call
  `markChosen()` instead of writing the ref. Fixing the 17302 lint warning falls out
  (the hook receives `chooseTier`, not `adeCloud`).
- **Behavior-preserving:** yes (pure move; same effects, same deps).

### B-H2. Dead code left behind by this branch's removals
- **Where / what:**
  - Skyline: `DraftMachinePicker.tsx` stopped drawing it, `AgentChatPane` stopped
    passing it, but these stay: `DraftMachineOption.skyline` and its
    `CloudSkylineLane` import (`DraftMachinePicker.tsx:6`, `:28-29`, now documented as
    "kept for callers" with no caller); `CloudSkyline` and `cloudSkylineSummary`
    (`remoteTargets/cloudBrand.tsx:98-185`, no importer); `useAdeCloudDraft`'s
    `skylineLanes` memo and return field (`useAdeCloudDraft.ts:106-110`, `:148`, no
    reader); `.adec-pill*` and every `.adec-sky-*` rule plus the `--adec-sky-*` vars in
    `cloudBrand.css` (`:34-42`, `:60-68`, `:80-87`, `:106-117`; the class
    `adec-pill` has no user; keep `--adec-pill-fg`, which `cloudLane.css:15,85` still
    reads).
  - `components/settings/providers/cloud/AdeCloudSignInsRow.tsx` (119 lines): its only
    importer was the old `CloudSection`; nothing imports it now.
  - ADE Cloud as an integration: `INTEGRATION_IDS` dropped `"cloud"`
    (`integrationBrand.tsx:20-24`) and `CloudSection` no longer renders
    `IntegrationPage`/`IntegrationHero id="cloud"`, yet `IntegrationId` still includes
    `"cloud"` (`:18`), its brand entry stays (`:113`), and `IntegrationsHome.tsx` keeps
    three now-unreachable branches (`:59` `id !== "cloud"`, `:64` `if (id === "cloud")
    return UNKNOWN`, `:184` the filter, `:332` the anchor ternary).
  - `components/app/ConnectionsPanel.tsx:309` still navigates to
    `/settings?tab=integrations&integration=cloud` and relies on the new redirect effect
    (`SettingsPage.tsx:368-376`) to bounce it. Point it at
    `navigateToAppTarget({ kind: "settings", tab: "ade-cloud" })` directly; keep the
    redirect only for old external links.
- **Standard:** S1.
- **Judo move:** delete the listed symbols, file, CSS and branches; drop `"cloud"` from
  `IntegrationId` (the compiler then finds every leftover); change the one link.
- **Behavior-preserving:** yes (nothing reads any of it; the link change skips one
  redirect hop).

### B-H3. Two hand-built warning cards instead of `<Banner>`
- **Where:** `CloudDashboard.tsx:218-224` (disk), `:632-648` (plan cleanup, new);
  CSS `cloudDashboard.css:22-35`, `:485`, `:729-733`.
- **Standard:** S4 + `docs/design/notices.md` ("A state of one tab, pane, or panel →
  `<Banner model layout="inline" />`"; "Do not add ... a new `*Banner` component with
  its own styling").
- **Judo move:** disk → `<Banner layout="inline" model={{ id: "cloud-disk-full", tone:
  "warning", title: \`Your disk is ${n}% full\`, detail: "Free some space before your
  lanes need more.", actions: [{ label: "Free up space", onClick: () => setFreeing(true)
  }], report: false }} />`. Cleanup → `<Banner ... tone: "warning", title: <the
  server sentence>, detail: <the due-date sentence>, extra: <the computers list>,
  report: false />` (`BannerModel.extra` exists, `ui/notice/Banner.tsx:75`). Then delete
  `.adecd-warn`, `.adecd-cleanup*`.
- **Behavior-preserving:** same content and actions; the look moves to the shared banner,
  which is the intended look.

### B-H4. `HeaderCloudMeter.tsx` is a second, parallel store of the cloud account
- **Where:** `usage/HeaderCloudMeter.tsx:21-80` (module-level `account`, `timer`,
  `listeners`, its own `listMachines()` read every 5 min). Consumed by
  `HeaderUsageControl`, `AccountPage.tsx:381`, and `InviteFriendsPill.tsx:25`
  (a sidebar pill and the Account page importing a hook named "Header…" from
  `components/usage/`).
- **Standard:** S7 (state in a component file; feature data in a presentational
  folder), S4 (`remoteTargets/useCloudMachines.ts` already is the one shared store of
  `listMachines`; two caches of the same read can disagree: open the dashboard, change
  the plan, and the header keeps the old hours for up to 5 minutes).
- **Judo move:** move the store to `state/cloudAccountStore.ts` as
  `useCloudAccount()`, and have `useCloudMachines`'s `load()` publish the account into it
  on every successful read (exactly as it already calls `noteCloudLaneMachines`). Keep
  the 5-minute, no-focus read as the header's own fallback. Also: `useEffect(() => { if
  (!enabled) account = null })` (`:76-78`) mutates the store without notifying
  listeners; do it inside the store on disable.
- **Behavior-preserving:** yes for the header's cadence; the header gets fresher (one
  more writer), which is the point.

---

## Medium

### B-M1. Dashboard CSS invents panels, pills and a button the kit already has
- **Where (cloudDashboard.css):** `.adecd-billing` (`:595-602`), `.adecd-sizecard`
  (`:613-625`), `.adecd-signin-list` (`:664`), `.adecd-invite-stats > div` (`:752`),
  `.adecd-limits .ade-ig-limit-rows` (`:724`), `.adecd-fl` (`:276`): each repeats
  `border: 1px solid var(--kit-panel-edge); border-radius: 12px; background:
  var(--kit-panel-bg)`, which is `.kit-panel`. `.adecd-plan-you`, `.adecd-plan-next`
  (`:577-586`) and `.adecd-sizecard-pick` (`:635-646`) are hand-made pills = `.kit-tag`.
  `.adecd-hero-btn` (`:399-413`) is a new button style next to `.kit-btn`.
- **Standard:** S4 + `visual-language.md` principle 2 ("Do not write a new panel style;
  if the kit lacks something, add it to the kit").
- **Judo move:** add `kit-panel` to those elements and delete the three repeated
  declarations from each rule (keep only layout). Use `kit-tag` for the pills; if an
  accent pill is needed, add `data-tone="accent"` to `.kit-tag` in `surfaceKit.css`
  (`.kit-dot` already has an `accent` state). Use `kit-btn` (with the dashboard's
  existing `.adecd .kit-btn` focus ring) for the hero button.
- **Behavior-preserving:** yes; pixel-close (radius `--radius-lg` vs 12px).

### B-M2. Colour for meaning: hard-coded hexes and a mono override
- **Where:** `cloudDashboard.css:112` `#b26b00`, `:114` `#fcd34d`, `:115` `#a16207`
  (the "warn" note on the hero), `:260-261` `.adecd-old` `#d99a12`/`#fbbf24`;
  `HeaderCloudMeter.tsx:158` `text-[var(--color-warning)]` and a bare `>= 80`
  (the dashboard's `CLOUD_DISK_WARN_SHARE` is 0.8); `DraftMachinePicker.tsx` reason
  line `text-amber-300/70`. `.adecd-hero .kit-num { font-family: inherit }`
  (`:713-719`) un-monos the kit's number class.
- **Standard:** `visual-language.md` "Colour is for meaning" (`--kit-warn`, `--kit-crit`),
  S5 (one named threshold).
- **Judo move:** `var(--kit-warn)` for every warn tint (it already resolves per theme);
  `percentOf(...) >= CLOUD_DISK_WARN_SHARE * 100` in the header panel; if UI-face
  tabular numbers are wanted, add a `.kit-num[data-face="ui"]` variant to the kit
  instead of overriding per surface.
- **Behavior-preserving:** yes, with the amber shade moving to the theme's warning token.

### B-M3. `cloudDashboard.css` hygiene
- **Where:** duplicate rules: `.adecd { gap }` at `:13` and `:348`;
  `.adecd-warn .kit-btn` at `:35` and `:485`; `.adecd-name-text` at `:513` and `:720`;
  `.adecd-empty` at `:114` and `.adecd-card .adecd-empty` `:528`. Orphan section
  headings with no rules under them: `:18` "Header", `:20` "The three facts…", `:263`
  "The selected lane", `:265` "A tier change's steps…", `:269` "Rows that open", `:344`
  "The older cards… until Cloud 4's PR merges" (that PR merged). Late patches appended
  out of their section: `:728` `.adecd-plan-col > span.adecd-plan-wrap`, `:729-733`
  `.adecd-cleanup`, `:734` `.adecd-plan-fine[data-tone]`. A class named for one card used
  as the generic lead paragraph in three: `adecd-signins-lead` in `CloudInvite.tsx:108`
  and `CloudAgentLimitsCard.tsx:76`. An Account-page class in the dashboard sheet:
  `.adecd-acct-invite` (`:762`).
- **Dead classes:** none. Every class selector in the file (138) is referenced by some
  `.ts/.tsx` (exact-token scan), and every `[data-*]` value it styles is emitted.
- **Standard:** S1.
- **Judo move:** keep one of each duplicate (the later value wins today: keep `gap: 16px`,
  `flex: 0 1 auto` merged into the first `.adecd-name-text`), delete the orphan comments,
  move the appended rules into their sections, rename `adecd-signins-lead` →
  `adecd-lead`.
- **Behavior-preserving:** yes (cascade-equivalent if the later values are kept).

### B-M4. Casts the types already make unnecessary
- `CloudPlans.tsx:111` `(result as { cleanup?: { sentence?: string } } | undefined)?.cleanup`:
  `CloudOpenCheckoutResult` already has `cleanup?: CloudPlanCleanup`
  (`shared/adeCloud.ts:728`). → `result?.cleanup?.sentence`.
- `cloudDashboardModel.ts` `lastRunText`: `lane.without?.reason as string | undefined`:
  the contract's `reason` is already `"freed" | "inactive" | "plan_limit"`. → drop the
  cast (and the narrowing then checks the `if`s).
- `CloudSizes.tsx:41` `tier.id as CloudTierId`: `CloudTier.id` is `CloudTierId`. No-op
  cast; delete.
- `CloudSignIns.tsx:35` `descriptor.id as ProviderLoginProvider` and `… as AdeCloudTile`:
  filter with a type guard at `:30`
  (`.filter((d): d is … & { id: ProviderLoginProvider } => isProviderLoginProvider(d.id))`)
  and drop both.
- `appStore.ts` `WorkDraftCloudTarget.sizeId: string | null` forces
  `saved.sizeId as CloudTierId` (`AgentChatPane.tsx:17289`). Type it `CloudTierId | null`
  and normalize with `isCloudTierId` in `normalizeWorkDraftCloudTarget`. Better still,
  a union: `{ provider: "ade"; laneId: string | null; sizeId: CloudTierId | null } |
  { provider: "cursor" } | { provider: "devin" }` (cursor/devin carry two always-null
  fields today).
- `adeCloudEndNotice.ts` `end.provider as ProviderGroupKey` and
  `CloudSignInEndNotice.tsx` `end.kind === "key" && end.provider ? … : "claude"`:
  `CloudPassEnd` (`shared/cloudSignIns.ts:222-241`) is a flat type with optional
  per-kind fields. A discriminated union (`kind: "claude_pass"` vs `kind: "key";
  provider: ProviderLoginProvider; madeOnLabel`) removes the double checks. (Shared
  type: coordinate with the main-process owner; older answers without `kind` normalize
  to `claude_pass` at the read.)
- `webclient/shell/webRoutes.ts` invite case: `path!` and hand-built `?`/`&` joining →
  build with `URL`/`URLSearchParams`.
- **Standard:** S6. **Behavior-preserving:** yes.

### B-M5. One hours-left rule, three places, imported across features
- **Where:** `CloudSizes.tsx:20` and `useAdeCloudDraft.ts:129` both compute
  `hours.leftMilli + max(0, earnedHoursLeftMilli(account) ?? 0)`; iOS repeats it
  (`CloudPaneSheet.swift:793` `CloudSizesCard.leftMilli`). `earnedHoursLeftMilli` lives in
  `settings/cloudDashboard/cloudDashboardModel.ts:229` and is imported by
  `chat/useAdeCloudDraft.ts:12` and `usage/HeaderCloudMeter.tsx:7` (chat and the header
  reaching into a settings page's model; the header also takes `formatGb`/`percentOf`
  from it).
- **Standard:** S7.
- **Judo move:** add `cloudHoursLeftMilli(account)` (plan + earned) beside
  `cloudEarnedHoursOf` in `shared/adeCloud.ts`; both callers use it; move `formatGb`
  and `percentOf` to `shared/adeCloud.ts` (or a `lib/cloudFormat.ts`) so the header and
  chat stop importing from `settings/`.
- **Behavior-preserving:** yes.

### B-M6. `CloudPlans.tsx` reaches into another app's source
- **Where:** `CloudPlans.tsx:16` imports `CloudPlanFacts`, `CloudPlanId` from
  `account-directory/src/cloud/contract`: the only renderer file that does; everything
  else goes through `shared/adeCloud.ts`.
- **Standard:** S7 (one boundary module).
- **Judo move:** add both to the `export type { … }` list at `shared/adeCloud.ts:719`
  and import from there. While there: `RANK` (`:30`) is plan order, a fact of the plan
  catalog → `cloudPlanRank` beside `CLOUD_PLAN_LABELS`.
- **Behavior-preserving:** yes.

### B-M7. Cursor and Devin Cloud launches copy the same pin plumbing
- **Where:** `AgentChatPane.tsx:14040-14044` and `:14316-14320` (identical `cloudPin` +
  `pinnedGit` object), `:14159` and `:14392` (identical
  `(cloudPin ? chatMachineLanes ?? [] : lanes).find(…)`).
- **Standard:** S4, S2 (more launch logic inside the giant component).
- **Judo move:** one helper next to `pushAutoCreatedLaneOriginForCursorCloud` (it takes
  the `git` object already): `cloudLaunchScope(launchBinding, projectBinding) => {
  pin, git }` and `laneOnLaunchMachine(id, pin, chatMachineLanes, lanes)`. Both
  callbacks call them.
- **Behavior-preserving:** yes. (Remote check for the record: both paths now pass the
  pin to every git, lanes, cursor/devin call and to `notifySessionCreated`; good.)

### B-M8. The two new hook-deps warnings
- `AgentChatPane.tsx:8116`: `chatRuntimePinKey` is in `refetchDevinCloudAuth`'s deps only
  to re-run the effect when the machine changes. Per CLAUDE.md (key effects on
  `pin?.key`), put it on the effect instead: callback deps `[projectRoot]`, effect deps
  `[chatRuntimePinKey, refetchDevinCloudAuth]`.
- `AgentChatPane.tsx:17302`: the restore effect reads `adeCloud.chooseTier` but lists the
  member, not the object. `const chooseAdeCloudTier = adeCloud.chooseTier;` above it and
  depend on that (it is a stable `useCallback`). Disappears with B-H1.
- **Standard:** S5. **Behavior-preserving:** yes.

### B-M9. `setCloudDefaultTier(tier, { synced })`: a boolean that turns on analytics inside the store
- **Where:** `state/appStore.ts:3040-3055`; the only `synced: true` caller is
  `lib/accountSettingsSync.ts:155`.
- **Standard:** S3 (boolean parameter switching a side effect), S7 (analytics in a
  store setter).
- **Judo move:** keep the setter pure; capture `cloud_default_size` where the person
  picks: `CloudSizes.tsx:41` and `useAdeCloudDraft`'s `setDefaultTier` (the composer's
  "Start every new lane on …"). The sync path then needs no option.
- **Behavior-preserving:** yes (same two user paths emit; sync never did).

### B-M10. `InviteFriendsPill` re-implements the star pill's schedule
- **Where:** `lib/invitePill.ts` (prefs `messagesSent / dismissCount / shownReported /
  snoozedUntilMessageCount`, normalize, visible, showing, record-on-send, a daily
  deduped `capture`) mirrors `lib/starPill.ts` + `lib/starPillActivity.ts`;
  `InviteFriendsPill.tsx:32-50` mirrors `StarRepoPill`'s shown-once and dismiss effects.
  `AgentChatPane.tsx:15159-15162` now calls both recorders on every send.
- **Standard:** S4.
- **Judo move (needs judgment):** a small `lib/nudgePill.ts` schedule
  (`createNudgeSchedule({ snoozeMessages, maxDismissals })`) both pills use, with one
  `recordNudgeMessageSent()` on send. The star pill's prefs sync through the account and
  the invite pill's are local, so the storage adapter differs; that is why this is not
  an auto-fix.
- **Behavior-preserving:** yes if storage stays per pill.

### B-M11. Three cloud booleans kept mutually exclusive by hand
- **Where:** `cursorCloudMode`, `devinCloudMode`, `adeCloudPicked` (+ `adeCloudLaneId`)
  are reset together in ~10 places (`AgentChatPane.tsx:12090-12094`, `:17193-17253`,
  `:17286-17293`, `:19824`); the branch then re-derives the single value
  (`currentDraftCloudTarget`, `:17267-17275`) to persist it. The setter
  `setAdeCloudMode` now writes `adeCloudPicked` (`:5004`): the name pair no longer
  matches.
- **Standard:** S3/S4 (the state already *is* one `WorkDraftCloudTarget | null`).
- **Judo move (follow-up, needs judgment):** one `draftCloud: WorkDraftCloudTarget |
  null` state with `pickDraftCloud(target)`; the three booleans become derived. It
  crosses `useCursorCloudDraftState`, so it is larger than this branch should take on;
  at minimum rename the setter to `setAdeCloudPicked`.
- **Behavior-preserving:** yes, but wide.

---

## Low

- **`formatShortDate` is now an alias** (`cloudDashboardModel.ts` → `formatCloudDate`).
  Inline it at its callers (S1).
- **`dashLanes` sort** (`cloudDashboardModel.ts`, the `order()` comparator) sorts lanes
  with no lane last, then splits them out again with two `filter`s. Drop `order()` from
  the comparator (S1).
- **`noLaneName`** compares with the magic string `"ADE Cloud computer"`; name it as a
  constant shared with whatever sets that default name (S5).
- **`LaneSetupCard.tsx`** calls `chatLaunchErrorMessage(x, x)` three times (the raw text as
  its own fallback). Give `chatLaunchErrorMessage` a one-argument form for strings (S5).
- **`InviteCodeBox` copy** hard-codes "20 free cloud hours" (`CloudInvite.tsx:38-39`)
  while the card beside it reads `referral.rewardMilli`; iOS falls back to `"20"`
  (`CloudPaneSheet.swift:1001`). Use `CLOUD_REFERRAL_REWARD_MILLI` /
  `outcome.referral.rewardMilli` (S7).
- **`InviteCodeBox` `data-source`** attribute (`CloudInvite.tsx:60`) is read by nothing
  (no CSS, no test, no analytics). Drop it (S1).
- **`DraftMachineOption.detail`** is now set to the same string as `unavailableReason`
  (`AgentChatPane.tsx:17133`, `:17144`) while the picker already shows `reason ??
  detail` (`DraftMachinePicker.tsx:367`). Drop the duplicate `detail` (S1).
- **`CloudAgentLimitsCard.tsx`**: the body was wrapped in a new `<section>` without
  re-indenting its children (`:75-123`); it also still borrows the Integrations page's
  `ade-ig-limit-rows` and patches it from the dashboard sheet (`cloudDashboard.css:724`).
  Re-indent; move the rows' look onto `kit-panel` (see B-M1).
- **`CloudSection.tsx:11`, `CloudDashboard.tsx:42`, `CloudInvite.tsx:6`** each import
  `cloudDashboard.css`. Harmless; `CloudInvite` needs it for the Account page, the other
  two only need one.

---

## Visual-language conformance (new dashboard)

- **Kit cards:** Plans, Sizes, Lanes and computers, Invite, Sign-ins and Agent limits
  are `.kit-card` + `.kit-card-head` (+ `.kit-card-head-count`, `-action`), with
  `.kit-btn`, `.kit-tag`, `.kit-meter`, `.kit-dot`, `.kit-input`. Good.
- **Meters:** hours and the mini meters use `usageLeftLevel`, the one 20%/5% rule. Good.
- **Invented styles:** B-M1 (panels, pills, hero button), B-M2 (hex colours, mono
  override).
- **The hero** (`.adecd-citycard.adecd-hero`, `cloudDashboard.css:42-109`, `:364-385`)
  is an opaque, self-coloured slab with its own radius (14px) and border: principle 1
  says cards are translucent planes, and the kit's answer for a coloured page header is
  `.kit-hero`. The city's colours are recorded as the owner's pick (`:37-41`), so this
  needs the owner's call, not an auto-fix: either keep the sky as the city's own canvas
  inside a `.kit-card`/`.kit-hero`, or record the exception in `visual-language.md`.
- **Fit the window:** Settings pages scroll (allowed); container queries are on the
  surface (`container: adecd`) with children styled under `@container adecd`. Good.

---

## iOS

### B-I1. `CloudPaneSheet.swift` crossed the 1k-line rule (956 → 1,564)
- **Where:** one file holds the sheet (`:32`), the settings page (`:127`), the dashboard
  screen and every card (`:293-1035`: hero, notices, lanes, plans, sizes, invite, code
  box, agents), the machine screen and its parts (`:1037-1255`), the limits screen
  (`:1256`), the tier model (`:1395-1495`) and 15 formatters (`:1496-1564`).
- **Standard:** S2.
- **Judo move:** split by responsibility, no logic change:
  `CloudDashboardCards.swift` (hero → agents card), `CloudMachineScreen.swift`
  (machine screen, facts, disk parts, controls, chips), `CloudLimitsScreen.swift`,
  `CloudPhoneFormat.swift` (`CloudPhoneTier`, `cloudPhoneTiers`, the `cloud*` text
  helpers). Add the new files to `project.pbxproj`.
- **Behavior-preserving:** yes.

### B-I2. `ProviderLoginsLenient<T>` duplicates `ADELossyArray`
- **Where:** `Views/Settings/SettingsProviderSignIns.swift:167-172`;
  `Models/RemoteModels.swift:3464` already has `ADELossyArray` for exactly this
  ("decode each element, drop the malformed one").
- **Standard:** S4.
- **Judo move:** use `ADELossyArray<…>` for the sign-in and pass lists (the element types
  are already `Equatable`) and delete the new wrapper.
- **Behavior-preserving:** yes.

### B-I3. `SettingsProviderSignIns.swift` mixes model, words, store and views (725 lines)
- **Where:** `ProviderLoginsPhoneStatus` decoding (`:17-165`), text helpers
  (`:177-212`), tile model (`:214-288`), five views, the store (`~:575-640`), and the
  ADE Cloud page's `CloudSignInsCard` (`:644`).
- **Standard:** S7 (under the size limit, but the model and store are not views).
- **Judo move:** move `ProviderLoginsPhoneStatus` + its read/write to
  `Services/` (beside `SyncService+Cloud.swift`), and `CloudSignInsCard` into the cloud
  folder next to the other dashboard cards (B-I1).
- **Behavior-preserving:** yes.

### B-I4. Lenient decoding boilerplate
- **Where:** `Services/SyncService+Cloud.swift` adds ~30 lines of
  `x = try? c.decodeIfPresent(T.self, forKey: .x)` across `CloudPhoneMachine` and
  `CloudPhoneAccount`.
- **Standard:** S5 (Low).
- **Judo move:** a `KeyedDecodingContainer.lenient(_:forKey:)` extension, one line per
  field. Optional; only if B-I2 touches this area anyway.

---

## Remote-scope check (renderer calls added on this branch)

- Cursor Cloud and Devin Cloud launches, the Cursor repo list, remembered secrets, open
  PR read, and the Devin auth read now take the chat's machine pin
  (`AgentChatPane.tsx:14040`, `:14316`; `useCursorCloudDraftState.ts`
  `pinRef`/`pinKey`; `:8114`), effects keyed on `pin?.key`. Good, apart from B-M8's
  dep placement.
- `CloudSignIns.tsx:52` writes through `useAdeCloudSignIns().accountPin` (This
  computer's pin), as the Providers page does.
- Account-level reads (`cloud.listMachines`, plans, invites, sizes) are unpinned by
  design and say so in their doc comments.

## Notes for Track A (not maintainability)

- `CloudSignIns.tsx:121`: the hint under the switch describes the *other* state
  (`on ? "Off: …" : "On: …"`). If it means "what turning it changes", the copy should
  say so; as written it reads as the current state being wrong.
- `CloudPaneSheet.swift:435`: iOS writes its own refused-free-plan sentence instead of
  the server's `freePlan.sentence` the desktop shows (deliberate per the comment; flag
  only so the two don't drift).
