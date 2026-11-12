# Cloud 5 · Track S: billing cleanup and the checkout page

Helper report, 2026-11-11. Nothing is committed (the lead commits). Covers PLAN.md decisions 1 and 7, ledger item 8,
the "Cloud 2 cleanup" items, and the server side of ledger item 18.

## 1. Forced downgrade cleans up (decision 1)

### What happened before

- Pro to Plus was refused (409 `disk_over_plan`, `refuseDowngradeOverDisk` in `billing.ts`) while the computers held
  more than Plus's disk. The computer limit was never checked.
- A cancel (`cancel_at_period_end`, rolled in `rollPeriodIfDue`) or a plan that ends after failed payments
  (subscription `canceled`, `to_free` in `applyCloudPlanChange`) dropped the account to the free plan.
  - Over 12 GB of disk: computers were stopped and blocked (`over_plan_disk`); only the short push-work wake got through.
  - Unused computers were deleted after 30 days, and nothing pushed their work first.
- An account over the computer limit stayed over it. Nothing removed anything.

### The design

- **Never refused.** Pro to Plus goes through, and the answer carries `cleanup`: what Plus's limits will free.
- **Who decides.** The server, from its own rows, in `apps/account-directory/src/cloud/planCleanup.ts`. It runs in the
  minute cron's 10-minute owner check (`runOwnerChecks` in `cron.ts`), as its last account job.
- **When.**
  - The plan whose limits apply is the one the person pays for (`boughtPlanIdOf`).
  - A `past_due` account is never cleaned, because Stripe is still trying the card.
  - Disk that extra disk covers counts as fitting: extra disk on, set up, and a full month of it inside the limit.
  - When the account is first seen over its limits, the run sets `plan_cleanup_due_at` to now + 3 days
    (`CLOUD_PLAN_CLEANUP_GRACE_DAYS`) and emails the list. The person can still choose by deleting computers themselves.
  - Once due, it frees at most 4 computers per run, across all accounts, in parallel.
  - It waits while the account has a move, a pending create or an update in flight.
  - When the account fits again, it clears `plan_cleanup_due_at`.
- **Which computers.** The oldest (`created_at`) until the account fits both the computer limit and the disk limit.
  Pending reservations and either side of a move are never picked.
- **Who pushes.** The computer's own ADE does the git push. For each computer:
  1. Claim: `plan_cleanup_claimed_at`, a guarded update with a 20-minute stale window, so overlapping ticks run it once.
  2. If it isn't awake, wake it with a free wake, like the person's push-work wake. The time isn't charged, isn't
     counted as use, and the tick's stop and sleep paths skip it. The power log reason is `plan_cleanup`.
  3. Exec `ade cloud prepare-stop --timeout 40` (interrupt agents, save chats), then `ade cloud push-work --json`
     (4-minute timeout).
  4. Exec `ade cloud work-state --json`: nothing may be left.
  5. Mark the lane to keep (reason `plan_limit`) and delete the computer (log reason `plan_limit`).
- **Keep the lane, free its computer, rather than delete the lane.** I chose this because the plan's limits are on
  computers and disk, and a lane without a computer uses neither. The lane and its chats stay, and the next message
  makes a new computer from the branch, under the plan's limits like any create. A computer made for no lane is
  deleted after the same push.
- **A push that fails keeps the computer.** This covers: an unreadable answer, an older ADE without the lane list,
  any lane `unpushed` or `failed`, and a provider error. The computer gets `plan_cleanup_failed_at`, the person is told
  once (on the first failure), and it is tried again a day later. Nothing else is removed in its place, so only
  computers the person was warned about ever go.
- **Analytics and logs.**
  - `ade_cloud_action` `delete`, origin `system`.
  - Log lines `cloud.plan_cleanup_set`, `_cleared`, `_freed`, `_ran` and `_warned_ahead`.
  - Sentry: `cloud.plan_cleanup_kept`, `_account_failed`, `_run_failed` and `cloud.plan_cleanup_failed`.
- **Migration 0027** (`migrations/0027_cloud_plan_cleanup.sql`).
  - `cloud_accounts`: `plan_cleanup_due_at`, `plan_cleanup_result_json`, `plan_cleanup_result_at`,
    `wakes_cancelled_at`, `wakes_cancelled_count`, `wakes_cancelled_reason`.
  - `cloud_computers`: `plan_cleanup_claimed_at`, `plan_cleanup_failed_at`.

### What the person is told

- **Before**
  - In ADE: the sentence at the change, plus the account fields below.
  - Email when a downgrade or cancel is made over the cheaper plan's limits (`announceChange`, which also catches a
    cancel made in the Stripe billing portal): "Your ADE Cloud computers go past <plan> on <date>".
  - Email when the cheaper plan starts and the cleanup is set: "ADE Cloud frees N computers on <date>".
- **After**
  - Email naming each computer that was freed and the branch its work went to, and any computer kept, with the reason.
  - `planCleanupDone` on the account for 14 days.
  - The lane shows as a lane without a computer, reason `plan_limit`, with its own sentence in
    `CloudLaneWithoutComputer.tsx`.

## 2. Pro to Plus says exactly how much disk to free

There is one shared sentence, `planCleanupSentence` in `contract.ts`. The server answer, the account fields, the emails
and ADE all use it. Validated output:

> Free 20 GB first: Plus allows 40 GB and you use 60 GB. Otherwise ADE pushes each lane's work to its branch on GitHub,
> then removes your oldest computers: Lane 0, Lane 1. Their lanes and chats stay, and the next message to a lane makes
> a new computer. A computer whose work can't be pushed stays.

When the account is over the computer limit, it adds: "Delete N computers first: Plus allows 10 at one time and you
have 14."

## 3. Free account whose timed wakes are cancelled

- **Where it happened.** `cron.ts` `settleAccounts` deleted `cloud_wakes` for every blocked account (0 hours with extra
  hours off, or the free plan over its disk) every tick, silently.
- **Now.** `accountNotices.ts` `cancelTimedWakes`:
  - deletes the rows with `returning`, so it knows how many each account lost;
  - for the first cancel in a billing period, records `wakes_cancelled_*` and sends one email, "Your ADE Cloud timed
    wake-ups were cancelled";
  - for later cancels in the same period, only adds to the count.
- **In the app.** The account carries `timedWakesCancelled` while that period runs.
- **Coming back.** Each computer sets its next timed wake again the next time it runs.

## 4. The checkout page (item 8)

- **Named lines.** Plus, Pro, extra hours and extra disk are now four products, so Checkout names each line: "ADE Cloud
  Plus", "ADE Cloud Pro", "Extra hours", "Extra disk". Each has a one-line description.
  - Plus: "500 hours a month, 40 GB of disk and up to 10 computers at one time. Every size, with Android and Docker."
  - Pro: the same, with 1,500 hours, 120 GB and 30 computers.
  - Extra hours: "$0.01 per hour past your plan's hours ($0.0085 after 1,000 in a month). You pay only if you turn
    extra hours on in ADE."
  - Extra disk: "$1 per 10 GB a month, counted by the day, on disk past your plan's. You pay only if you turn extra
    disk on in ADE."
- **Plain units.** Extra disk now shows "$0.01 for every 3 GB-days" instead of "$0.00333333333333 per unit". The price
  is 1 cent per 3 GB-days, with the period's total rounded down, so Stripe never bills more than ADE counted (under a
  cent a period goes unbilled). Extra hours keeps its graduated price (1¢, then 0.85¢ after 1,000), which Checkout
  shows as "Price varies / See details".
- **No `custom_text`.** Managed Payments refuses Checkout's `custom_text` (tested: "You cannot use custom_text with
  Managed Payments"), so the product descriptions carry every word.
- **Email prefilled.** `ensureCustomer` creates the Stripe customer with the account's email from Clerk
  (`accountEmail` in `email.ts`, now exported, using the existing `CLERK_SECRET_KEY`). An older customer that has no
  email gets it filled in on its next checkout; an email the person changed in Stripe stays. The email is never logged.
  If Clerk can't be read, Checkout simply asks for it.
- **No double disk billing.** Turning extra disk on now recognizes an older extra-disk price on the same meter
  (`hasDiskItem`), so a subscription that holds the archived disk price never gets a second item on that meter.
- **Setup script.** `scripts/stripe-setup.mjs` sets all of this up the same way for the sandbox and, later, live:
  - it brings product names, descriptions and unit labels up to date;
  - a price that is on the wrong product, or shaped differently, hands its lookup key to a new price and is archived;
  - subscriptions that hold an archived price keep billing on it.
  - A rerun changes nothing (checked).

### Stripe sandbox changes (account `acct_1UZWdlBsy4QVYccD`; live untouched)

| Object | Change |
|---|---|
| Product `ade_cloud` | Renamed "ADE Cloud" to "ADE Cloud Plus"; description added |
| Product `ade_cloud_pro` | Description added (name unchanged, "ADE Cloud Pro") |
| Product `ade_cloud_extra_hours` | New: "Extra hours", description, unit label `hour` |
| Product `ade_cloud_extra_disk` | New: "Extra disk", description, unit label `GB-days` |
| Price `price_1UadQVBsy4QVYccDnPEBOIkW` | New extra-hours price on `ade_cloud_extra_hours` (graduated 1¢ / 0.85¢ after 1,000, meter `mtr_test_61Vj8IvPiHpDEkzRc41Bsy4QVYccDXMm`); took lookup key `ade_cloud_extra_hours_monthly` |
| Price `price_1UZkLZBsy4QVYccDDwJ33ruZ` | Old extra-hours price (on `ade_cloud`), archived |
| Price `price_1UadQVBsy4QVYccDH47NVQxH` | New extra-disk price on `ade_cloud_extra_disk` (1¢ per 3 GB-days, `transform_quantity` divide by 3 rounding down, meter `mtr_test_61Vjhs4wm6FRz2mHy41Bsy4QVYccDBqi`); took lookup key `ade_cloud_extra_disk_monthly` |
| Price `price_1UaJujBsy4QVYccDV5I9JPx0` | Old extra-disk price (on `ade_cloud`, $0.00333 per GB-day), archived |
| Product `prod_Vbr6TfIigvvzDa` "Disk display experiment" and price `price_1UadOkBsy4QVYccDGs9Q1eZm` | Made to test the display, then archived |
| Customer "checkout-preview@example.com" (metadata `purpose=checkout-preview`) | Test customer for the proof; still there |
| Three Checkout sessions on that customer | One from the display test and two for the proof; open, and they expire on their own within 24 h |

Unchanged: Plus price `price_1UZkLZBsy4QVYccDJhyDhBPZ`, Pro price `price_1UaJv6Bsy4QVYccDyUbQTq6x`, both meters, and
the portal configuration `bpc_1UaJvHBsy4QVYccDU70Jf6tD`.

### Config ids changed (`apps/account-directory/wrangler.jsonc`; the merge deploys them)

- `STRIPE_DISK_PRICE_ID` changed from `price_1UaJujBsy4QVYccDV5I9JPx0` to `price_1UadQVBsy4QVYccDH47NVQxH`, in the
  default env and in `production`.
- New var `STRIPE_EXTRA_HOURS_PRICE_ID = price_1UadQVBsy4QVYccDnPEBOIkW`, in the default env and in `production`.
  - `billing.ts` reads it before the older `STRIPE_EXTRA_PRICE_ID`.
  - It has a new name because `STRIPE_EXTRA_PRICE_ID` is a Worker secret in production, which a config change can't
    update, and a var and a secret can't share a name.
  - In the default env it replaces the `STRIPE_EXTRA_PRICE_ID` var.
- `CloudEnv` in `store.ts` gained `STRIPE_EXTRA_HOURS_PRICE_ID`.

### Proof

![Stripe sandbox Checkout for ADE Cloud Plus: named lines (ADE Cloud Plus, Extra hours, Extra disk) with one-line descriptions, plain units, email prefilled](ade-proof://08d35780-344a-4f11-b562-5e6f9ae4eb89)

![Stripe sandbox Checkout for ADE Cloud Pro: named lines with descriptions, plain units, email prefilled](ade-proof://98c099dc-7947-4a1f-a469-b09ca1a46a3b)

The proof sessions were made with the same parameters as `createCheckoutUrl`: plan price, then the extra-hours and
extra-disk prices, `managed_payments[enabled]`, and a customer that has an email. I did not run the Worker itself
against the sandbox.

## 5. Disk wording (item 18)

- **The true rule** (`plans.ts`): every plan's disk is one total that all the account's computers share at one time.
  Free is a shared 12 GB, not a per-computer amount.
- **What was wrong.** The server's sentences were already right. The bug was in desktop main: `cloudAccountStatus.ts`
  set `diskShared: account.rules === "paid"`, so on Free `ade cloud status` said "12 GB disk per computer".
- **Fixed.**
  - `diskShared` is now `account.disk.limitGb != null`. It is false only for a server from before plans existed.
  - `cliCloudStatus.ts` now says "12 GB disk at one time".
- **Wording for the app:** "12 GB at one time, shared by all your computers."

## For the lead: shared fields, functions, and what the person sees where

Everything is in `apps/account-directory/src/cloud/contract.ts`. `apps/desktop/src/shared/adeCloud.ts` re-exports the
types and the functions `planCleanupSentence`, `planCleanupDoneSentence`, `timedWakesCancelledSentence` and the
constant `CLOUD_PLAN_CLEANUP_GRACE_DAYS` (= 3). The server's emails use the same functions.

### Fields on `CloudAccountState` (all optional; older servers leave them out)

- `planCleanup?: CloudPlanCleanup | null`: what a cheaper plan's limits will free.
  - Set while a downgrade or cancel waits for the period end; `dueAt` is `periodEnd` + 3 days.
  - Set while the cheaper plan is on and the account is still over its limits; `dueAt` is the date that was set.
- `downgradePreviews?: { plus?: CloudPlanCleanup; free?: CloudPlanCleanup }`: what moving to that plan now would free.
  It lists only plans that would free something, and `dueAt` is null.
- `planCleanupDone?: CloudPlanCleanupDone | null`: the last run, kept for 14 days.
- `timedWakesCancelled?: CloudTimedWakesCancelled | null`: present only during the billing period it happened in.

```ts
type CloudPlanCleanup = { planId: CloudPlanId; computers: CloudPlanCleanupComputer[] /* oldest first */; usedGb: number; limitGb: number; computerCount: number; computerLimit: number; dueAt: number | null; sentence: string };
type CloudPlanCleanupComputer = { instanceId: string; name: string | null; laneName: string | null; branch: string | null; diskGb: number };
type CloudPlanCleanupDone = { at: number; planId: CloudPlanId; freed: Array<{ name: string; branch: string | null; laneKept: boolean }>; kept: Array<{ name: string; reason: string }> };
type CloudTimedWakesCancelled = { at: number; count: number; reason: "out_of_hours" | "over_plan_disk" };
```

- **Checkout result.** `POST /cloud/billing/checkout {plan: "plus"}` from Pro now answers
  `{ url: null, change: "next_period", cleanup? }`; `cleanup` is left out when nothing goes. Through IPC,
  `window.ade.cloud.openCheckout("plus")` returns `{ opened: false, change, cleanup? }` (`CloudOpenCheckoutResult`).
  The pass-through is in `cloudServerProvider.ts` and `registerCloudIpc.ts`.
- **Lane reason.** `CloudLaneWithoutComputer.reason` can now be `"plan_limit"`.

### Functions

- `planCleanupSentence(cleanup)` is the warning (also already in `cleanup.sentence`).
- `planCleanupDoneSentence(done)` says what was freed, with the branch its work went to, and what was kept.
- `timedWakesCancelledSentence({ count, reason })` says what won't run, why, and how the wake-ups come back.

### What the person should see where

1. **Move to Plus, before confirming.** If `account.downgradePreviews.plus` is there, the confirm dialog shows its
   `sentence`, followed by "This happens on <formatCloudDate(billing.periodEnd + 3 days)>". Plus is never refused.
2. **Move to Plus, after.** If the result has `cleanup`, add its `sentence` to the "You move to Plus on <date>"
   message.
3. **Cancel.** Cancelling happens in the Stripe portal (Manage). Next to Manage, while `downgradePreviews.free` is
   there, show its `sentence` ("If you cancel: …"). The server also emails the list when the cancel arrives.
4. **The list of what goes (dashboard).** While `planCleanup` is set, show a warning with its `sentence` and
   "on <formatCloudDate(dueAt)>".
   - List each of `computers` by `laneName ?? name`, with `branch` ("work goes to <branch>") and `diskGb`.
   - Add one line: deleting computers yourself before then lets you choose.
5. **After a run.** While `planCleanupDone` is set, show `planCleanupDoneSentence(done)` once (dismissible). Freed
   lanes also appear in the lanes list as lanes without a computer (reason `plan_limit`). Their sentence is in
   `CloudLaneWithoutComputer.tsx`: "<lane> has no computer now. ADE Cloud removed it on <date> to fit your plan,
   after pushing its work to GitHub. A new computer starts from the branch on GitHub."
   - Still needed in `cloudDashboardModel.ts:171`: a short label for `plan_limit`, for example "Computer removed to
     fit your plan". Today any reason other than `inactive` reads "No computer now".
6. **Timed wake-ups cancelled.** While `timedWakesCancelled` is set, show `timedWakesCancelledSentence(notice)` near
   the hours/plan card. The email went out once that period.
7. **Disk wording (item 18).** "12 GB at one time, shared by all your computers", on every plan.
8. **Browser mock.** `renderer/browserMockCloud.ts` types `reason: "freed" | "inactive"`. Widen it if the mock should
   show a `plan_limit` lane.

## Validation

- **Typecheck.**
  - account-directory: my source files are clean. The only error is in the referrals helper's test code
    (`test/cloudAccount.test.ts:1064`).
  - desktop and ade-cli: errors only in files other helpers are editing: `CloudPlans.tsx` (wrong relative import of
    `contract`), `cloudMachines.ts` (`ready` missing), `cloudProvider.ts` and `cloudServerProvider.ts` (referral
    methods).
- **Tests.** `cloudAccount.test.ts` and `cloudWake.test.ts`: 116 of 117 pass. One fails on purpose:
  - **"plans and billing: Pro to Plus above Plus's disk with extra disk off is refused, and nothing moves"**
    (`cloudAccount.test.ts` ~line 790) expects 409 `disk_over_plan`. Decision 1 reverses that behavior: Pro to Plus
    is never refused, and the answer carries `cleanup`.
  - Per the test rules I left it for `/test`. It should become: the downgrade is accepted (`paid_plan_next = plus`),
    and `cleanup` names the oldest computers and how many GB to free.
- **Hand validation.** I ran a temporary harness test over the real migrations, with the fake provider and Stripe, and
  deleted it afterwards. It showed:
  - Pro to Plus over disk is accepted; the answer and `GET /cloud/account` carry `cleanup`, `planCleanup` (with
    `dueAt` = `periodEnd` + 3 days) and the `plus` and `free` previews.
  - A free account with 5 × 4 GB computers gets `plan_cleanup_due_at` = now + 3 days and the warning email, and no
    exec runs before then.
  - At the due time, the oldest computer pushes, passes the check, is deleted, and its lane row has reason
    `plan_limit` with the pushed branch. The second-oldest leaves work behind, so it is kept with
    `plan_cleanup_failed_at`, and the email lists both.
  - A rerun 20 minutes later makes no calls. A day later the kept one pushes and is freed, and the next run clears
    the due date.
  - Cancelled timed wakes: one email, and the count adds up over two ticks (2); `timedWakesCancelled` is on the
    account.
- **Checkout.** Checked live in the sandbox with screenshots (proof above).

## Failure modes for /test

- A computer is deleted without a successful push and a clean `work-state` read, or an older ADE without the lane
  list counts as pushed.
- A computer the person wasn't warned about is freed in place of one that was kept.
- Overlapping cron runs free the same computer twice (the claim).
- A `past_due` account is cleaned, or one whose extra disk covers its disk is cleaned for disk.
- The free wake for the push is charged, counts as use, or is stopped or slept by the tick before the push finishes.
- A lane row is missing after a delete that crashed partway (the mark is written before the delete; a failed delete
  removes the mark).
- The due date isn't cleared once the account fits; or after a plan upgrade, a stale due date frees computers.
- The cancelled-wakes email is sent more than once a period, or the count is lost.
- Extra disk is billed twice: a second subscription item on the disk meter for a subscription holding the archived
  price.
- An existing Stripe customer's email (one the person changed in Stripe) is overwritten, or the email is logged.
- The downgrade-ahead email is repeated on a webhook replay (before/after comparison in `announceChange`).

## Not done, or needs the owner

- **Dashboard UI (the lead's).** The items above; and widen `browserMockCloud.ts` for `plan_limit` if wanted.
- **Before the Worker deploys.** Run migration 0027.
- **Live Stripe.** Run `scripts/stripe-setup.mjs` against live when going live. It renames the products, makes new
  extra prices there, and prints the ids to swap in.
- **Stripe account branding** (name "ADE sandbox", no logo or colors). This is in Stripe's settings, not touched here.
  The live account's branding is unchecked.
- **`docs/logging.md`.** Not updated with the new `cloud.plan_cleanup_*` and timed-wake log events.
- **Open question for the owner.** The 3-day grace before freeing, and "oldest by creation date" (rather than least
  recently used), are my reading of "remove the oldest". Tell me if either should change.

## Files

- **New:** `apps/account-directory/src/cloud/planCleanup.ts`, `apps/account-directory/src/cloud/accountNotices.ts`,
  `apps/account-directory/migrations/0027_cloud_plan_cleanup.sql`, this report.
- **account-directory:** `src/cloud/{billing,contract,cron,store,lanesWithoutComputer,email,costReport}.ts`,
  `scripts/stripe-setup.mjs`, `wrangler.jsonc`, `README.md`.
- **desktop:** `src/shared/adeCloud.ts`, `src/main/services/adeCloud/{cloudServerProvider,registerCloudIpc,cloudAccountStatus}.ts`,
  `src/renderer/components/cloudLane/CloudLaneWithoutComputer.tsx`.
- **ade-cli:** `src/cliCloudStatus.ts`.
- **docs:** `docs/features/ade-cloud/README.md`.
