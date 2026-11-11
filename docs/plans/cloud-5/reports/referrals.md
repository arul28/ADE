# Cloud 5 · Track B report: referrals, earned hours, one free plan per computer

Owner decisions 4 and 5 of `../PLAN.md`. Helper report, 2026-11-11. Nothing committed by this helper (the
lead's checkpoint 07e4f0766 picked up most files; the rest are in the worktree). No remote migration, deploy or
production write was run.

## 1. Contract for the UI helper

### Account read (`GET /cloud/account`)

Three new optional fields (types in `apps/account-directory/src/cloud/contract.ts`, re-exported from
`apps/desktop/src/shared/adeCloud.ts`):

- `earnedHours: { leftMilli, usedThisPeriodMilli, grantedMilli }` (`CloudEarnedHours`). `hours` stays the plan's
  own hours (`includedMilli`, `leftMilli`, `percentUsed` are plan hours only). `hours.state` is `zero` only when
  plan and earned hours are both gone.
- `freePlan: { state: "unclaimed" | "claimed" | "refused", sentence: string | null }` (`CloudFreePlan`).
  `sentence` is set only while refused and on the free plan's rules:
  "This computer already used another account's free hours. Plus gives you 500 hours a month."
  (`CLOUD_FREE_PLAN_REFUSED_SENTENCE`).
- `referral: CloudReferralSummary`: `code, link, friendsJoined, rewardsPaid, rewardsLeft, rewardLimit (10),
  rewardMilli (20000), hoursEarnedMilli, canEnterCode, enterCodeUntil (ms | null), hasReferrer,
  referredState ("pending" | "rewarded" | "refused" | null)`. Missing if the summary couldn't be built (never
  fails the account read).

Tolerant readers for an older server (`shared/adeCloud.ts`): `cloudEarnedHoursOf(account)` (zeros),
`cloudFreePlanOf(account)` (`unclaimed`), `cloudReferralOf(account)` (null), `readCloudReferralSummary(value)`.
Also exported: `parseCloudInviteCode`, `cloudInviteLink`, `CLOUD_INVITE_URL_BASE`, `CLOUD_INVITE_DEEPLINK_BASE`,
`CLOUD_REFERRAL_REWARD_MILLI`, `CLOUD_REFERRAL_REWARD_LIMIT`, `CLOUD_REFERRAL_ENTER_DAYS`, and the types
`CloudInviteRedeemResult`, `CloudInviteRefusalReason`, `CloudInviteRedeemOutcome`.

### Routes (server)

| Route | Gate | Answer |
|---|---|---|
| `GET /cloud/referrals` | `/cloud` access gate | `CloudReferralSummary` |
| `POST /cloud/referrals/redeem { code }` | `/cloud` access gate | `CloudInviteRedeemResult` `{ result: "accepted", rewarded, referral }`, or `{ error: { code: "invite_refused", reason, message } }` |
| `GET /invites/<CODE>` | public, 30/min per address, CORS `*` | `{ firstName: string \| null }`, or 404 `not_found` |

`code` accepts `https://ade-app.dev/invite/<CODE>`, `ade://invite/<CODE>`, or the bare code; any case, spaces and
dashes ignored. Refusal reasons (`CloudInviteRefusalReason`) and statuses:
`invalid_code` 400, `unknown_code` 404 (also an inviter without ADE Cloud access), `own_code` 400,
`already_referred` 409, `too_late` 403, `rate_limited` 429 (10 tries a minute per account). `message` is the
sentence to show.

### Desktop main / preload (account-level, no pin)

- `window.ade.cloud.getReferral(): Promise<CloudReferralSummary | null>` (IPC `ade.cloud.getReferral`). Null
  without ADE Cloud or on a read failure.
- `window.ade.cloud.redeemInvite(code): Promise<CloudInviteRedeemOutcome>` (IPC `ade.cloud.redeemInvite`):
  `{ ok: true, rewarded, referral }` or `{ ok: false, reason: CloudInviteRefusalReason | "unavailable", message }`.
  Success broadcasts `cloudStatusChanged`, so the account reads again.

### `ade` actions (cloud domain)

- `cloud.referral` (read) and `cloud.invite_redeem` (write, input `{ code }`, answers `CloudInviteRedeemOutcome`;
  a refusal is a result, not a throw). Both allowlisted and machine-scoped (work with no project open, through
  `cloud.call`). `invite_redeem` is CTO-only (`ADE_ACTION_CTO_ONLY.cloud`), so agents are refused and the
  person's desktop, phone and terminal reach it. Input contracts in `actionInputContracts.ts`; access kinds in
  `shared/adeActionAccess.ts`.

### CLI (hidden with the rest of `ade cloud` when access is off)

- `ade cloud invite [--text]`: link, friends joined, rewards paid of 10, hours earned, and the date a code can
  still be entered until.
- `ade cloud invite redeem <link-or-code>`: the outcome sentence.
- `ade cloud hours` now adds earned hours left and the refusal sentence.

### Deeplink

`ade://invite/<CODE>` (`DeeplinkInviteTarget` in `shared/deeplinks.ts`; https form is the invite page itself)
navigates to `/settings?tab=account&invite=<CODE>#account-profile` (manifest entry `account.profile`,
`INVITE_SETTINGS_ENTRY_ID`). The Account card's code box should read `?invite=` from the settings route and fill
itself. The hosted web client routes it the same way (`webRoutes.ts`). In a chat it draws an "ADE Cloud invite"
link chip.

### Desktop analytics names (for the UI helper to fire)

`ade_feature_used`, feature `cloud_invite`, same pattern as `captureStarPromptAnalytics`:
- `invite_pill_shown | invite_pill_clicked | invite_pill_dismissed`, outcome `prompt_first | prompt_second | prompt_third`.
- `invite_link_copied`, outcome `from_pill | from_settings | from_dashboard`.
- `invite_code_entered`, outcome `accepted | refused_invalid_code | refused_unknown_code | refused_own_code |
  refused_already_referred | refused_too_late | refused_rate_limited | refused_unavailable`.

Never the code, link or friend. The reward is counted server-side.

## 2. Files changed

- New: `apps/account-directory/migrations/0026_cloud_referrals_and_free_plan.sql`,
  `apps/account-directory/src/cloud/freePlan.ts`, `apps/account-directory/src/cloud/referrals.ts`,
  `apps/web/src/app/pages/InvitePage.tsx`, `apps/web/src/lib/invite.ts`.
- Server: `src/cloud/{store,contract,analytics,routes,chats,billing (one line),cron (one line),accountDeletion}.ts`,
  `src/index.ts`, `test/cloudAccount.test.ts`.
- Desktop: `main/services/adeCloud/{cloudAccess,cloudServerProvider,cloudProvider,cloudMachines,cloudAgentActions,registerCloudIpc}.ts`,
  `main/services/adeActions/{actionPolicy,actionInputContracts}.ts`, `main/services/analytics/productAnalyticsPolicy.ts`,
  `shared/{adeCloud,adeActionAccess,ipc,deeplinks,chips}.ts`, `shared/types/core.ts`, `preload/{preload.ts,global.d.ts}`,
  `renderer/components/app/App.tsx`, `renderer/webclient/shell/webRoutes.ts`.
- CLI: `apps/ade-cli/src/cli.ts`, `apps/ade-cli/src/services/account/hardwareAnchor.ts`.
- Web: `src/app/SiteRoutes.tsx`, `src/app/pages/PrivacyPage.tsx`, `src/lib/{marketingAnalytics,marketingReplay,freebuffPixel}.ts`.
- Docs: `docs/features/ade-cloud/README.md` (section "Referrals and the free plan", source map), `docs/logging.md`.

## 3. Migration 0026

- `cloud_invite_codes (user_id pk, code unique, created_at)`.
- `cloud_referrals (friend_user_id pk, referrer_user_id, entered_at, state pending|rewarded|refused, reason,
  decided_at, rewarded_at, reward_token, referrer_rewarded)`, index on `(referrer_user_id, state)`.
- `cloud_earned_hours` append-only `(id, user_id, milli, reason, reference, created_at)`, unique
  `(user_id, reason, reference)`. Reasons today: `referral_friend`, `referral_referrer`; reference is the friend.
- `cloud_accounts` columns: `earned_granted_milli`, `earned_used_milli`, `past_due_earned_milli`,
  `free_refused_at`, `account_created_at`.
- `cloud_free_plan_claims (computer_hash pk, user_id unique, claimed_at, platform)`.
- `cloud_account_computers (user_id, computer_hash, first_seen_at, platform)` pk on both, index on hash.

Additive only: apply the migration, then deploy the Worker.

## 4. How each rule is enforced

### Earned hours and the order of use

- Balance = `earned_granted_milli - earned_used_milli`. `earned_granted_milli` is recomputed from
  `cloud_earned_hours` in the same batch that adds a grant (never incremented, so a retry can't count twice).
- Order: plan hours, then earned, then paid extra. A period draws from earned hours only what it used past the
  plan's hours and past the extra hours already billed or owed in it (`earnedDrawMilli` in `store.ts`):
  `draw = min(balance, max(0, used - included - billedExtra))`, where `billedExtra = max(extra_reported, extra_owed)`
  on paid rules, 0 otherwise. So a grant that lands after extra hours were billed covers only later hours; nothing
  is both billed and drawn.
- `isOutOfHours` = extra off AND plan hours used AND no earned hours left. The minute tick's 0-hours stop, the wake
  refusal, create refusals and timed-wake refusal all read it, so a free account with earned hours keeps running
  until they are gone.
- The extra-hours meter (`reportExtraHours`) bills `extraUsedMilli` (used past plan and past what earned covers).
  `extraOwedMilli` and `extraHours.usedMilli` use the same.
- The 80/95% warnings use `allowancePercentUsed` (plan + earned balance). Unchanged for accounts with no earned hours.
- At period end (`startFreshPeriod`) the draw is written in SQL on the row (after the settles, before `used_milli`
  resets, in the same transaction), guarded by the old `period_start`. Two rolls at once draw once.
- A failed payment's cut stashes its draw in `past_due_earned_milli`; a paid invoice that restores the same period
  gives it back (`restored_same_period`), so that period draws once at its real end. A new period clears it.
- A grant after 0 hours clears `warned_zero_at` and sets `hours_restored_at` (the 30-day delete clock restarts).
- Earned hours never expire: there is no expiry anywhere.

### One free plan per physical computer

- Client: SHA-256 of `ade-cloud-free-plan-computer-v1:` plus the raw OS id (`IOPlatformUUID` / `MachineGuid` /
  `/etc/machine-id`, the existing reader `readHardwareAnchorUuidAsync` in `hardwareAnchor.ts`, works on all three
  OSes). Same value for every account and every ADE home on the computer; distinct from the per-account
  `hardware_id` of 0008. Read once per process. `unreadable` when the OS has none.
- Sent as `x-ade-computer` and `x-ade-computer-platform` on every `/cloud` call by the desktop main, the machine
  brain and the project action domains (all build deps through `cloudAccessDepsFor`). An ADE Cloud computer
  (`isAdeCloudComputer`) sends nothing.
- Server: HMAC-SHA256 with a key derived by HKDF (label `ade-cloud-free-plan-computer-hmac-v1`) from the existing
  `CLOUD_CHAT_MASTER_KEY`, so no new secret. Without it: a dev constant, logged once (`cloud.free_plan.dev_key`).
  Only the HMAC is stored.
- The moment (`freePlanMomentOf` in `routes.ts`), settled before the request's own hours check:
  - `use`: `POST /cloud/instances` (create, move, cloud lane start), `POST .../fork` (copy), `POST .../start` (wake).
  - `read`: `GET /cloud/account`, `GET /cloud/referrals`.
- `settleFreePlanComputer` (`freePlan.ts`), idempotent:
  1. Records the computer as seen for the account (one insert, only the first time).
  2. Account holds a claim (on this computer or another) → nothing changes for it (restored if it was refused).
  3. Computer claimed by another account and this account has no claim → refused: `free_refused_at` set, and
     `included_milli = 0` while on free-plan rules (free, or `past_due`). Settled on reads too, so the dashboard
     shows the sentence before anything starts.
  4. Unclaimed computer, no claim, free rules, moment `use` (or a read by a refused account) → claim. Re-read
     decides the winner; a lost race is refused.
  5. Paid rules → never claims.
- Race safety: both keys of `cloud_free_plan_claims` are unique and the insert is `on conflict do nothing`, so two
  accounts claiming one computer at once give one claim and one refusal, and one account claiming two at once
  holds one.
- Settled per account: a refused account has 0 free-plan hours everywhere (CLI, phone, MCP) because the row holds
  it. Period rolls keep it (the roll writes `included_milli = 0` from the row when `free_refused_at` is set).
  Paid plans, earned hours and extra hours are untouched.

### Edge cases (decided, each logged)

| Case | Behavior |
|---|---|
| Reinstall, same account, same computer | Same OS id, same hash, same claim. Nothing logged beyond the read. |
| A computer later signs into the original (claiming) account | That account's own claim: fine. |
| Computer can't read its id | Sends `unreadable`; nothing claimed; log `cloud.free_plan.id_unreadable` + PostHog `id_unreadable` (on `use`). Free hours kept. |
| Account with no computer claim yet (phone-only / MCP-only) | No header: free hours given, nothing claimed; PostHog `unclaimed_use` on each use moment (one a day). Claimed the first time a computer of its own uses hours; refused then if that computer is already someone else's. |
| Shared family computer | First account to USE free hours from it claims it (reads never claim). Another family account seen there without a claim is refused until it uses a computer of its own, which claims that one and gives the hours back at once (`restored`). An account that already has a claim can use the shared computer freely. |
| VM | Its own OS id, so its own computer (accepted). |
| ADE Cloud computer | Sends nothing; never claims. |
| Paid account | Never claims; can be marked refused (only matters if it drops to free). |
| Account deleted | Claim kept (re-making an account must not get the free hours again); invite code and seen computers deleted; referral rows and grants kept (no personal data). |

### Referrals and rewards

- Code: 8 chars of `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, unique, made at the first summary (`ensureInviteCode`,
  retries on a clash). Link `https://ade-app.dev/invite/<CODE>`.
- Redeem order: per-account rate limit → parse → code exists and its owner has ADE Cloud access (else
  `unknown_code`) → not own → not already referred → within 30 days of the friend's ADE account creation (Clerk
  Backend API `created_at`, read once into `account_created_at`; without Clerk, falls back to the cloud account's
  `created_at`, logged `cloud.referral.created_at_fallback`) → insert keyed by friend (`on conflict do nothing`,
  so two redeems at once give one referrer; never changed).
- Reward signal: the friend's first saved chat part (`chats.ts` `handlePutPart`, a new chat row). Only a computer
  the account owns can write saved chats, so this is the server's proof a chat ran on an ADE Cloud computer
  (free or paid). If the friend already had a saved cloud chat before redeeming, the reward is paid at the redeem.
  Never fails the chat save.
- Abuse refusals at reward time, recorded as `state = refused` with `reason`:
  - `friend_computer_used`: the friend was refused the free plan.
  - `same_computer`: the two accounts were ever seen on one computer (`cloud_account_computers`).
- Payment (`rewardReferralIfDue`): one batch (one D1 transaction): move the referral from `pending` to `rewarded`
  with a fresh `reward_token`; insert the friend's grant only under that token; insert the referrer's grant only
  under that token AND while the referrer's earlier `referral_referrer` grants are under 10 (counted inside the
  same statement); set `referrer_rewarded`; recompute both balances from the grants. Grants are also unique per
  (account, reason, friend). So two first chats at once pay once, and the cap holds when the 10th and 11th land
  at once; past the cap the friend still gets 20.

## 5. Website invite page

- `apps/web/src/app/pages/InvitePage.tsx`, route `/invite/:code` (`SiteRoutes.tsx`). Not linked from any page.
- Asks `GET <directory>/invites/<CODE>` (`lib/invite.ts`; directory from `VITE_ADE_ACCOUNT_DIRECTORY_URL`, default
  the production Worker URL). The server answers the inviter's Clerk first name only when the inviter has ADE
  Cloud access; otherwise 404, the same as an unknown code. First names cached 10 minutes per isolate.
- Shows: "Invited by <first name>." (or "You're invited to ADE." without a name; "This invite isn't valid." on
  404), "You both get 20 extra free cloud hours, on top of the 50 free every month.", every download option
  (the existing `InstallBlock`: Mac, Windows, iPhone, the install command, Linux), and "Already have ADE?" with
  "Open in ADE" (`ade://invite/<CODE>`) and the code with a copy button.
- Privacy of the code: the analytics screen is `invite` and every recorded page address and referrer is `/invite`
  (`withoutInviteCode` in `marketingAnalytics.ts`); session replay masks all text on `/invite`; the Freebuff ad
  pixel doesn't load on an invite page (an outside script reads the address). New marketing names: screen
  `invite`, position `invite_page`, features `open_invite_in_ade`, `copy_invite_code`.

## 6. Privacy line

`apps/web/src/app/pages/PrivacyPage.tsx`, section "What the desktop app collects", one line:
"We keep a scrambled id of your computer so the free plan is given once per computer." Effective date set to
November 11, 2026.

## 7. Analytics and alerts

### Server PostHog events (`analytics.ts`; distinct id is the account hash; never a code, link, email, computer id or the other account)

- `ade_cloud_referral`: `step` = `code_entered` (`result` accepted|refused, `reason`), `reward_paid` (`role`
  friend|referrer, `referrer_rewarded`), `reward_refused` (`reason` same_computer|friend_computer_used),
  `cap_reached`. One per account, step, reason and hour.
- `ade_cloud_free_plan`: `step` = `claimed`, `restored`, `refused`, `id_unreadable`, `unclaimed_use`, with
  `platform`. One per account, step and day.

### Sentry alert rules for the lead to create

Each signal is one Sentry issue per event name (fingerprint = the name), level warning, tag `area`. Note
`reportCloudFailure` sends a given name at most once per Worker isolate per hour, so counts are hourly samples.

1. **Free plan abuse.** Issue alert. Filter: tag `area` equals `cloud-free-plan` AND message equals
   `cloud.free_plan.many_accounts_one_computer`. Trigger: a new issue is created, OR the issue is seen more than
   3 times in 1 day. Action: email the owner. Meaning: a refusal on a computer seen with 4+ accounts (3+ refused).
2. **Referral abuse.** Issue alert. Filter: tag `area` equals `cloud-referrals` AND message is one of
   `cloud.referral.cap_reached_fast` (a referrer's 10 rewards within 7 days of the first),
   `cloud.referral.many_friends_one_computer` (3+ referred friends seen on one computer). Trigger: a new issue is
   created, OR seen more than 3 times in 1 day. Action: email the owner.
3. **Unexpected failures.** Issue alert. Filter: tag `area` is one of `cloud-referrals`, `cloud-free-plan` AND
   message is one of `cloud.free_plan.settle_failed`, `cloud.referral.reward_failed`,
   `cloud.referral.summary_failed`, `cloud.referral.clerk_read_failed`. Trigger: more than 5 events in 1 hour, or
   a new issue. Action: email the owner.

### PostHog alerts for the lead to create (trend insight + alert on each)

1. `ade_cloud_free_plan` where `step = refused`, daily count. Alert: above 20 a day, or more than 2x the 7-day
   average (abuse, or a bug refusing real people).
2. `ade_cloud_free_plan` where `step = id_unreadable`, daily, broken down by `platform`. Alert: above 5 a day
   (a platform whose id reader broke).
3. `ade_cloud_free_plan` where `step = unclaimed_use`, daily. Alert: above 20 a day (phone/MCP-only accounts
   farming the free plan).
4. `ade_cloud_referral` where `step = code_entered` and `result = refused`, daily, broken down by `reason`. Alert:
   `reason = unknown_code` above 30 a day (code guessing); `rate_limited` above 10 a day.
5. `ade_cloud_referral` where `step = reward_paid` and `role = friend`, daily. Alert: more than 3x the weekly
   average.
6. `ade_cloud_referral` where `step = reward_refused`, daily. Alert: above 5 a day.
7. `ade_cloud_referral` where `step = cap_reached`. Alert: any (above 0 in a day).

## 8. Validation

- Typecheck, once per package: account-directory, web (both tsconfigs) and ade-cli clean. Desktop's only errors
  are in files this track did not touch, from other helpers mid-edit: `renderer/components/settings/cloudDashboard/CloudPlans.tsx`
  (missing module path and `CloudPlanId` index errors) and `renderer/components/settings/integrations/IntegrationsHome.tsx`
  (`ConnectProviderId` vs `"cloud"`).
- Tests run on touched code: account-directory `cloudAccount.test.ts` (108 pass, 1 fail, see below) and
  `signupAnalytics.test.ts`; desktop `shared/deeplinks.test.ts`, `shared/chips.test.ts`, `adeActions/actionPolicy.test.ts`,
  `analytics/productAnalyticsService.test.ts`, `adeCloud/cloudAgentActions.test.ts`, `adeCloud/cloudPendingCreates.test.ts`,
  `deeplinks/protocolHandler.test.ts` (all pass); ade-cli `hardwareAnchor.test.ts` (pass); web `npm test`
  (`marketingAnalytics.test.ts` 10 pass, `api/releaseAssets.test.ts` 12 pass).
- New tests (the race and accounting exception: these rules have no UI or CLI surface, so a test is how they are
  proven), in `cloudAccount.test.ts`, describe "ADE Cloud earned hours, referrals and the free plan per computer",
  18 cases: order of use (6 rows, including extra hours never billing earned hours via `reportExtraHours`), the
  period-end draw under a racing roll, the failed-payment draw, the claim race, 5 free-plan edge cases, the
  double reward, the cap race, and the two refusal reasons. Races are deterministic: `landBefore` runs the
  competing request just before the first one's critical statement or batch. Each guard was broken on purpose
  (JS-computed draw without the period guard; lost claim race not refused; reward not held to `pending`; cap
  counted outside the statement; the stash refund removed; the billed-extra term removed) and its test failed,
  then the code was restored.
- By hand (temporary test block, removed): every redeem refusal reason including `too_late`, a lowercase dashed
  `ade://` link accepted, the immediate reward when a saved chat exists, both summaries, the lookup's 200
  (`access-control-allow-origin: *`), 404 for an unknown code and for an inviter off the access list, and 429 on
  the 31st lookup from one address in a minute.

## 9. The failing test, and why

`test/cloudAccount.test.ts` › "plans and billing: Pro to Plus above Plus's disk with extra disk off is refused,
and nothing moves" expects `409 disk_over_plan` from `POST /cloud/billing/checkout { plan: "plus" }`; it now gets
200. Owner decision 1 ("you should never stop a user from paying less") made the billing helper change checkout so
a downgrade is never refused (it answers `cleanup` instead; see the contract comment on `CloudCheckoutResult`).
The test is stale against that intended change; it is the billing helper's to rewrite in `/test`. Nothing in this
track touches checkout.

## 10. Failure modes for /test

1. A friend's first chat pays twice (two saved parts at once), or a referrer gets an 11th reward.
2. A free account is stopped at 0 plan hours while it still has earned hours.
3. Earned hours are billed as extra hours, or a grant after extra billing refunds/double-counts.
4. A period roll (or two racing rolls, or a failed payment then a paid invoice) draws earned hours twice or not at all.
5. Two accounts end up holding one computer's free plan, or one account holds two claims.
6. A dashboard read claims a computer (a family member who only looked takes the free plan).
7. A refused account doesn't get its hours back after using a computer of its own; or a refusal is lost at the
   next period roll.
8. An ADE Cloud computer sends a computer id; or a missing/unreadable id causes a refusal.
9. An old desktop or server breaks on the new optional fields (tolerant readers return defaults).
10. A code reaches PostHog, replay or the ad pixel through the page address, referrer or event properties.
11. An agent (role `agent`) redeems a code; or an account changes its referrer; or enters its own code; or enters
    one after 30 days.
12. The public lookup answers for an inviter without ADE Cloud access, or returns anything but a first name.
13. Account deletion drops the free-plan claim (re-made account gets free hours again).

## 11. Not done / caveats

- No UI: the pill, the code boxes (LaunchGate, iPhone sign-in, Settings › Account) and the dashboard card are the
  UI helper's track, built on section 1. The iPhone's own `ade://invite` handling is the iPhone helper's.
- The redeem rate limit (10/min/account) is in memory per Worker isolate, behind the auth gate; the public lookup's
  limit is in D1 (`device_approval_rate_limits`, its own scope).
- A CTO chat agent has the `cto` role and could technically call `cloud.invite_redeem`; other agents cannot.
- The invite page has no server-rendered link-preview card yet (the SPA's default tags show).
- The Clerk `user.created` webhook does not store the creation date; it is read from the Clerk Backend API once
  per account (needs `CLERK_SECRET_KEY`, already set for emails).
- Migration 0026 must be applied before the Worker that reads it is deployed.
