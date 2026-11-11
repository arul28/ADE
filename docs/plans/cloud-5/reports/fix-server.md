# Cloud 5 /quality fix: server and website (fix-server)

Scope: `apps/account-directory/**` and `apps/web/**`, per `quality-decisions.md`. Nothing is committed. Paths below are
relative to `apps/account-directory/` unless they say otherwise.

## qa-server findings

- **B1 (blocker), steps 1 and 3.** `src/cloud/planCleanup.ts:572` `laneIsSafe`, `:578` `leftLanes`, `:544` `readTally`.
  - Step 1: a lane counts as safe only when its state is `clean` or `pushed`. Any other state, including one the server
    doesn't know, keeps the computer.
  - Step 3: a primary lane counts as safe only when it is `pushed`, or `clean` in a tally that carries
    `readsRemotes: true`. A lane entry without a `primary` field is treated as primary, which is the stricter rule.
  - The server tolerates `failed` and `unknown` states: both keep the computer.
  - **Open on fix-main:** I asked (through the lead) for `CloudPushWorkResult` to carry `readsRemotes: true` from the
    fixed CLI (`apps/ade-cli/src/services/power/cloudPushWork.ts`). It isn't there yet. Until it is, no computer with a
    project is ever freed (primary lanes only report `clean`). That is fail-safe, but it means the cleanup does nothing
    for lane computers until the marker ships to cloud images.
- **M1.** `planCleanup.ts:417` `stillDue`. It re-reads the account, the access list and `listComputers`, recomputes the
  pick, and checks the instance's warned due time. It runs twice in `freeComputer`: before the wake (so a computer is
  never woken for nothing) and after `work-state`, right before the delete. When the instance is no longer due, the run
  releases the claim and returns `skipped`.
- **M2.** Migration `0027` was edited in place: it adds `plan_cleanup_warned_json` at `migrations/0027_cloud_plan_cleanup.sql:12`.
  - The column holds a JSON map, `{ instanceId: dueAt }`. Each computer gets its own due time, as the decision asked.
  - Only computers that were warned and are due are freed (`planCleanup.ts:316-323`).
  - A computer the limits pick later is "fresh". It gets its own warning and `now + 3 days` (`warnFresh`, `:342`), and
    the computers warned earlier keep their dates.
  - `plan_cleanup_due_at` is now the earliest due time, kept for display. The dashboard's `dueAt` comes from the map
    (`earliestDue`, `:169`).
  - Both columns are cleared when the account fits.
- **M3.** `warnFresh` (`:342`) follows claim, send, give back.
  - The claim is guarded on the warned JSON as it was read (`is ?`), so overlapping runs warn once.
  - `sent` keeps the claim. So does `skipped` outside production.
  - `failed`, and `skipped` in production, give the claim back (guarded on what this run wrote) and call
    `reportCloudFailure("cloud.plan_cleanup_warning_not_sent")`, which is throttled per hour. The next run tries again.
  - Nothing is freed on a warning that never reached the person.
- **M4.** `src/cloud/referrals.ts:254` `GRANT_LANDED_SQL`. The account update is split in two:
  - The friend's row works as before.
  - The referrer's row is updated only when `exists (... reason = 'referral_referrer' and reference = <friend>)`. A
    capped referrer's `warned_zero_at` and `hours_restored_at` stay as they are.
- **L1.** prepare-stop is now its own exec with `--json` (`planCleanup.ts:89`). `prepareConfirmed` (`:533`) requires all
  of these: exit 0, readable JSON, `stillRunning === 0`, `chatsNotUploaded === 0` and `timedOut === false`. Anything
  else keeps the computer with code `prepare_stop_failed`, and it is tried again a day later.
- **L2.** `src/cloud/freePlan.ts:180`. In production (`isProduction`, `src/cloud/store.ts:60`), a missing
  `CLOUD_CHAT_MASTER_KEY` reports `cloud.free_plan.no_key` and the free plan is not settled. `SENTRY_ENVIRONMENT` was
  added to `CloudEnv`. The rotation note is at `src/cloud/chats.ts:26-29`.
- **L3.** `referrals.ts:400`. The decode is wrapped in `try`, and a malformed `%` sequence answers the same 404 as an
  unknown code.
- **L4.** `src/cloud/billing.ts:143` `ensureCustomer`. The customer is created with constant params (metadata only),
  then `fillCustomerEmail` fills the email.
- **L5.** `src/cloud/accountState.ts`. `readSummaryRow` is guarded with `.catch` and `reportCloudFailure`. With no
  summary row, the free plan is `freePlanOf(account, false)` and `referral` is left out.
- **L6.** Each catch now logs the error name only:
  - `billing.ts:145` (`logCloud`)
  - `referrals.ts:411` (`logCloud`)
  - `costReport.ts:162` (`reportCloudFailure`)
- **L7.** `planCleanup.ts:428`. `push_left_work` and `check_left_work` call `logCloud` only. Every other keep code still
  goes to `reportCloudFailure`.
- **L8.** `billing.ts:545-550`. `warnPlanCleanupAhead` has its own `try`/`catch` and reports
  `cloud.plan_cleanup_warn_ahead_failed`.
- **L9, mutual referrals.** `referrals.ts:212-215` refuses with reason `mutual` (409, `:170`).
  - `src/cloud/contract.ts:520` adds `CLOUD_INVITE_REFUSAL_REASONS`, and the refusal type is derived from it.
  - Client lists to update belong to other helpers: desktop `actionInputContracts.ts:218`, `productAnalyticsPolicy.ts:774`
    and iOS `ProductAnalytics.swift:93`. I reported them to the lead.
- **L9, deletion.** `src/cloud/accountDeletion.ts:53`. The kept rows are re-keyed to `deleted:<sha256(userId)>`:
  - `cloud_free_plan_claims`, so the claim is kept.
  - `cloud_referrals`, on both the friend and the referrer side.
  - `cloud_earned_hours`, on both `user_id` and the referral `reference`.

  The re-keys run in one batch with the existing deletes and are safe to repeat. A referral whose referrer was deleted
  still pays the friend, and the referrer is skipped (`referrals.ts:272`): no account row, no grant, no analytics.
- **Deploy note.** `runPlanCleanups` skips accounts that `cloudAccessAllows` refuses (`planCleanup.ts:298`), and
  `stillDue` checks access again. The production D1 read before the deploy is still the lead's to run.

## qb-core findings (account-directory and web)

- **H1.** `buildAccountState`, `billingNotice` and `recentlyDeletedInstanceIds` moved to the new `src/cloud/accountState.ts`.
  - `store.ts` no longer imports accountNotices, planCleanup, freePlan or referrals, so all four cycles are gone.
  - `store.ts` is 986 lines (it was 1,076).
  - `routes.ts` imports `buildAccountState` from `accountState.ts`.
- **H2.** `cloudAccessAllows` and `readJson` moved to `src/cloud/http.ts:13,22`. Routes, referrals and planCleanup import
  them from there.
- **H3.** `settleFreePlanComputer`, `settle`, `refuse` and `restore` return `Promise<void>`. The TS rebuilds of the
  account are gone (`freePlan.ts`).
- **M1.** `FreshPeriod.included` is `"free" | number` (`store.ts:750`). The free case is SQL that reads
  `free_refused_at`. `freeIncludedMilli`, the `freeHours` flag and the `??` fallbacks are deleted. A missing row after
  the batch throws.
- **M2.** `PAID_RULES_SQL` (`store.ts:502`) sits next to `accountRules`. `EARNED_DRAW_SQL` uses it, and so does
  freePlan's `FREE_RULES_SQL = not ${PAID_RULES_SQL}`.
- **M3.** Every 0026 and 0027 column is now on `AccountRow`, with the `not null default 0` columns required. Deleted:
  `PlanCleanupAccountRow`, `NoticeColumns` and the `?? 0` reads.
- **M4.**
  - `CLOUD_PLAN_SENTENCE_NAMES` is exported from contract and replaces planCleanup's `PLAN_NAMES`.
  - The "done" email is `planCleanupDoneSentence(done)` plus one line per computer (`planCleanup.ts:267`).
  - `CLOUD_FREE_PLAN_REFUSED_SENTENCE` is replaced by `cloudFreePlanRefusedSentence(plusIncludedMilli)`
    (`contract.ts:488`), and the server passes `CLOUD_PLANS.plus.includedMilli`.
  - `WakeBlock = CloudTimedWakesCancelled["reason"]`, and `stopAll` takes `WakeBlock`.
- **M5.**
  - `checkDeviceRateLimit` is exported with a string scope (`src/deviceAuthorization.ts:353`) and used for
    `invite_lookup`. The local `sha256Hex` and `admitLookup` are deleted.
  - There is one `readClerkUser` (`src/cloud/email.ts:91`), returning `{ email, createdAt, firstName }`.
    `accountEmail` wraps it, and referrals uses it.
  - Redeem uses `readJson`.
- **M8.** `instanceRouteOf` (`src/cloud/routes.ts:1043`) is used by both `freePlanMomentOf` and the router.
- **M9, web.** `apps/web/src/lib/invite.ts` keeps its copies, and each one names the contract or plans constant it
  mirrors. New `INVITE_ENTER_DAYS`, used in `InvitePage.tsx:82`.
- **M9, Stripe.** `scripts/stripe-setup.mjs:30` adds `PLAN_NUMBERS`, and the product descriptions and plan prices are
  built from it. `checkPlanNumbers()` (`:42`, called at `:101` before any Stripe call) imports `src/cloud/plans.ts`
  through Node's type stripping and exits 1 on any difference. I checked this by hand: the real file passes, and a copy
  with Plus disk 41 fails with the difference named.
- **L1.** `cron.ts` drops the `blockedUsers` array and returns `new Set(blockedWhy.keys())` (`:274`).
- **L6.** `apps/web/src/lib/marketingReplay.ts` uses `withoutInviteCode(normalized) === "/invite"`.
- **Outside this track: `referrals.ts:409`.** This is qa-server L3, covered above.
- **Outside this track: Clerk on every read.** `accountCreatedAt` (`referrals.ts:88-115`) now persists the fallback when
  Clerk answers without `created_at`. After a failed or empty read it waits 10 minutes before asking Clerk again (per
  isolate). The invite-code write already happens once per account, so it needed no change.

## Tests

- **Known failing test, updated to the new behavior.** `test/cloudAccount.test.ts:795`: "Pro to Plus above Plus's disk
  with extra disk off is accepted for the period end, and names what Plus's limits free". It checks for a 200, `change:
  next_period`, a `cleanup` with plan `plus`, 50 GB used of 40, one computer named, and `paid_plan_next: plus`.
- **Extended: the cap race test** (`:1213`), with a capped referrer at 0 hours. **Why a test:** the race and the cap
  have no surface except the stored rows.
- **Extended: one `it.each` for plan cleanup** (`describe("ADE Cloud plan cleanup")`, `:1248`), run through
  `runPlanCleanups`. **Why a test:** this deletes computers from the cron with nobody watching (data loss), and the
  re-check race has no other surface. It has five rows:
  1. All lanes on GitHub, read against the remotes: freed.
  2. A primary lane `clean` from an older ADE: kept.
  3. An unknown lane state: kept.
  4. prepare-stop not confirmed: kept.
  5. The person deleted a newer computer during the push: not freed (the M1 re-check).
- **Each new assertion was shown to fail.** I broke each behavior on purpose and saw its test fail, then restored the
  code:
  - Primary rule removed: row 2 fails.
  - Denylist restored: rows 2 and 3 fail.
  - `prepareConfirmed` forced true: row 4 fails.
  - Second `stillDue` removed: row 5 fails.
  - Old combined referral update: the cap test fails.

## Checks (one pass, at the end)

- `npx tsc -p tsconfig.json --noEmit` in `apps/account-directory`: passes.
- `npx tsc -p tsconfig.json --noEmit` in `apps/web`: passes.
- `npx vitest run` on the six test files that import the touched modules (`cloudAccount`, `cronMonitor`,
  `deviceAuthorization`, `directory`, `diagnostics` and `usageResearch`): 6 files, 266 tests, all pass.
- No web test covers the touched web files. `marketingAnalytics.test.ts` covers `withoutInviteCode`, which I didn't
  change.

## Left for others / follow-ups

- **fix-main:** add `readsRemotes: true` to `CloudPushWorkResult` (see B1). Without it, the cleanup frees only computers
  that have no projects.
- **fix-main: drop the old sentence export.** Desktop `shared/adeCloud.ts:29` still re-exports the removed
  `CLOUD_FREE_PLAN_REFUSED_SENTENCE`, so desktop typecheck fails until that line goes.
  `browserMockCloud.ts` can call `cloudFreePlanRefusedSentence(CLOUD_PLANS.plus.includedMilli)`.
- **fix-main and iOS:** add `mutual` to the three client refusal-reason lists.
- **Not done here:** the production D1 read in qa-server's deploy note, and the release-notes line for qa-main L6.

## PR bot findings (round 2, on top of a89d2323c)

### Cursor 4540634914 (High): a computer the cleanup woke and then kept was left running

- **The fix.** `freeComputer` now records whether this run started the computer, and the resting status the provider
  reported before the start. The record is a `WakeRecord` that `wakeForPush` fills in `apps/account-directory/src/cloud/planCleanup.ts`.
  - It is set right after `startInstance`, before the wait. So a wake that times out is covered too.
- **Where it applies.** Both `keep` (any code) and the second-check `release` call the new `putBackToRest`
  (`planCleanup.ts:444` and `:452`).
  - `putBackToRest` (`:534`) does what the rest of the server does: a computer that was `stopped` is stopped again,
    and any other is put to sleep.
  - It writes the change with `statusChangeStatements` (`reason: plan_cleanup`), as the tick's no-check-in sleep does.
    That closes the free push wake without charging it.
  - It is best effort: a failure is reported as `cloud.plan_cleanup_put_back_failed`, and `sleepUnseen` is the
    backstop.
- **Computers already awake.** A computer that was awake before the run is never started, so it stays as it was.

### Greptile 4540477215 (P2): a failed referral reward was never retried

- **The fix.** `apps/account-directory/src/cloud/chats.ts:388` now calls `rewardAfterCloudChat` on every saved part, not
  only a chat's first. With nothing pending, the call costs one primary-key read of the friend's pending row
  (`rewardReferralIfDue`'s first statement). The reward stays idempotent because of its token.
- **Why not a cron sweep.** This is the cheaper path. A sweep would join pending referrals to saved chats every tick.
- **Docs.** Both the module header and the function docstring in `referrals.ts` now say this.

### Greptile 4540477197 (P1 security): a read could restore a refused account's free hours

- **The fix.** In `apps/account-directory/src/cloud/freePlan.ts` `settle`, a `read` never claims and never restores,
  not even for a refused account. A restore through an existing claim also needs a `use` moment.
  - A read still refuses, so the dashboard can say why.
  - A refused account gets its hours back by using ADE Cloud from a computer of its own. Create, copy and wake settle
    the free plan before the hours check, so that works even at 0 hours.
- **Docs.** The file header now says this.

### Tests

These are rows in existing tables in `test/cloudAccount.test.ts`.

- **Free-plan table.** The row "a refused account gets its free hours back" changed behavior on purpose: its last step
  is now a `POST` (a use). A new row covers the security contract: "a refused account's read from another computer (any
  id it sends) gives nothing back".
- **Plan-cleanup table.** A new row: "a sleeping computer it woke for the push and then kept goes back to sleep". The
  table body now also checks that a kept computer ends in the state it started in, on both the provider and the row.
- **Failure checks.** I broke each fix on purpose and saw its row fail:
  - Putting back removed: the new sleep row fails.
  - The read-restore restored: the new security row fails.
- **No test for the retry.** It is a one-line change to an unconditional call, and I checked it by reading the code.
- **Checks.** `npx tsc -p tsconfig.json --noEmit` in `apps/account-directory` passes. `npx vitest run
  test/cloudAccount.test.ts test/directory.test.ts`: 2 files, 177 tests, all pass.
