# Cloud 5 /quality, Track A1: server and website correctness

Branch `ade/cloud-5-dashboard-and-fixes`, review base `202dc0676`. Scope: `apps/account-directory/**`, `apps/web/**`.
Reviewed by reading only. Nothing was edited or run. Every finding below was traced in the real code; anything I could not
confirm was dropped. Windows parity: none of this runs on a user's computer (Worker and website), so no Windows rows apply.

## Blocker

### B1. Plan cleanup can delete a computer whose work is not on GitHub: "clean" in the tally can mean "status not read" or "commits on the primary branch"

- **Where:** `apps/account-directory/src/cloud/planCleanup.ts:447-453` (`leftLanes`), and how it reads
  `apps/ade-cli/src/services/power/cloudPushWork.ts:55-61`, which takes its facts from
  `apps/desktop/src/main/services/lanes/laneService.ts:4146-4151`, `:1176-1177` and `:1271-1299`.
- **Evidence:**
  - `leftLanes` treats only `unpushed` and `failed` as work left behind. Any other state, including one it has never seen,
    counts as safe to delete.
  - `pushCloudComputerWork` marks a lane `clean` whenever `!dirty && ahead === 0`. The numbers come from
    `laneService.list({ includeStatus: true })`.
  - (a) When a lane's status read throws, `listLanes` catches it, logs `laneService.resolveStatus_failed`, and uses
    `DEFAULT_LANE_STATUS` (`dirty: false, ahead: 0`). `computeLaneStatus` does the same when the worktree-root check fails.
    That lane comes back `clean`, and nothing tells the caller the read failed.
  - (b) `ahead` counts commits past the lane's **base** branch, not past its remote. The primary lane has
    `base_ref = defaultBaseRef` and `branch_ref` is that same branch (`ensurePrimaryLane`, `:3635-3645`). So
    `compareBase` is null and the count is `main...main`, which is `0 0`. Local commits on `main` that were never pushed
    read as `ahead: 0`, and if the worktree is clean the lane is `clean`. `upstreamAhead` is never read.
- **Failure scenario:** A person downgrades from Pro to Plus. One of the computers it will free is a general computer
  (not made for a lane) where they committed to `main` without pushing. Three days later the server runs `push-work`
  (nothing to push), then `work-state`. Both report the primary lane `clean`. The server deletes the computer and the
  commits are gone. Case (a) is the same outcome: a slow, just-woken computer with a git status timeout loses a lane's
  unpushed work. Nobody is in the loop. PLAN decision 1 says a computer is "never deleted without a successful push and a
  clean work-state read", and a status that was never read is not a clean read.
- **Fix:**
  1. Server side (`planCleanup.ts`): allowlist instead of denylist. A lane counts as safe only when its state is
     `clean` or `pushed`; anything else keeps the computer. This alone does not close (a) or (b).
  2. CLI side (`cloudPushWork.ts`):
     - A lane whose status could not be read must report `state: "failed"` (or a new `unknown`, which the server would
       keep because of step 1). It must never report `clean`. This needs a signal from `laneService.list`, either a
       `statusError` flag on the summary or a call to `resolveStatus` per lane in push-work.
     - For the primary lane (and any lane whose branch is its base), count commits not on any remote:
       `git rev-list --count <branch> --not --remotes`. The `laneService.ts:9268` helper already does this.
  3. Until the CLI change ships to cloud images, the server can refuse to free any computer whose tally has a primary
     lane, unless that lane reports `pushed`. This is fail-safe: the computer stays and the person is told.
- **Auto-applicable?** Step 1 is unambiguous and behavior-preserving. Steps 2 and 3 are small, but step 2 changes the CLI
  contract, and the cloud image's ADE must update before it helps. Needs the lead's call on step 3. I would not ship the
  cleanup to production without step 1 plus step 3, or without step 2.

## High

None beyond B1.

## Medium

### M1. Cleanup frees computers from a snapshot up to ~10 minutes old and never re-checks that the account is still over its plan

- **Where:** `planCleanup.ts:261-307` (`runPlanCleanups`) and `:352-393` (`freeComputer`). It is called at the end of the
  minute tick (`cron.ts:388-393`) with the tick's `live` list.
- **Evidence:** The account row and its computers are read once, at the start of the run. `freeComputer` then wakes the
  computer (up to 3 min), pushes (up to 4 min) and checks (up to 2 min) before it calls `deleteComputer`. The only
  re-check is the claim's `deleted_at is null` on this one computer. Nothing re-reads whether the account still holds more
  than the plan allows, or whether the plan changed.
- **Failure scenario:**
  - On the due day the person follows the email ("Delete computers you no longer use before then to choose yourself")
    and deletes two newer computers. The run already holds the old snapshot and frees the two oldest as well, so the
    person loses four computers instead of two.
  - The same happens if they upgrade from Plus to Pro while the push runs.
- **Fix:** In `freeComputer`, after the work-state check and right before `markKeepLaneStatement`/`deleteComputer`, do
  this:
  1. Re-read the account (`select * from cloud_accounts`) and `listComputers`.
  2. Recompute `cleanupPlanOf` and `planCleanupFor`.
  3. Go ahead only if this instance is still in the computed list. Otherwise release the claim and return `skipped`.
  Do the same check once before `wakeForPush`, so a computer is never woken for nothing.
- **Auto-applicable:** Yes. It is unambiguous and behavior-preserving, since it only removes deletes that would no longer
  be needed.

### M2. Computers the person was never told about can be freed

- **Where:** `planCleanup.ts:280-301`.
- **Evidence:** The warning (`warnPlanCleanupDue`) names `cleanup.computers` once, when `plan_cleanup_due_at` is set.
  Every later run recomputes the list from scratch and frees whatever it picks now, as long as `due_at` is in the past.
  `due_at` is cleared only when the account fits.
- **Failure scenario:**
  - An account on Plus is over by computer count. It was warned about A, and A is kept because its push failed, so
    `due_at` stays set. Later the person turns extra disk off, or their disk is re-measured higher. The next run picks
    the oldest computers past the disk limit as well, and frees B and C at once, with no new warning and no grace.
  - The same thing happens months later: a second over-limit episode while `due_at` is still set from the first one
    skips the grace entirely.
  - PLAN decision 1 and the file header both say "only computers the person was warned about."
- **Fix:**
  1. Store the warned instance ids with the due date: a JSON column, or reuse `plan_cleanup_result_json`'s neighbour
     (needs a column in 0027, which hasn't shipped yet, so it can still be edited).
  2. Free only the intersection of the current pick and the warned ids.
  3. When the current pick holds an id that was never warned, warn again and set a new `due_at = now + grace` for the
     new ones.
- **Auto-applicable:** No. It is a small design change (a schema column plus the re-warn rule). Lead's call; it is cheap
  while 0027 is unreleased.

### M3. The cleanup goes ahead even when the warning email was never delivered

- **Where:** `planCleanup.ts:287` (`warnPlanCleanupDue`), `:215-224` (`warnPlanCleanupAhead`).
- **Evidence:** `sendCloudEmail` now returns `"sent" | "skipped" | "failed"`, and `accountNotices.ts` and
  `costReport.ts` act on that result. The cleanup ignores it. With no `RESEND_API_KEY`, a Clerk lookup that fails, or a
  Resend refusal, `due_at` is still set and the delete runs 3 days later. The only other warning is the dashboard, which
  the person may never open (the account may be used from the CLI or MCP only).
- **Failure scenario:** Resend has a bad day when `due_at` is set. The person never hears of it, and their computers are
  removed.
- **Fix:** Set `due_at` only after a `"sent"` result. On `"failed"`, clear the guard, so the next run (10 minutes on)
  warns again. Follow the `costReport.ts` give-back pattern: claim, send, give back on failure. Decide what `"skipped"`
  means: dev, where sending is not set up, probably proceeds.
- **Auto-applicable:** Yes for `"failed"`. `"skipped"` needs a call from the lead.

### M4. A referral reward resets the out-of-hours warning for a referrer who got nothing (past their cap of 10)

- **Where:** `apps/account-directory/src/cloud/referrals.ts:304-310`.
- **Evidence:** The last statement in the reward batch sets `warned_zero_at = null` and
  `hours_restored_at = now when warned_zero_at is not null` for `user_id in (friend, referrer)`. It does this whether or
  not the referrer's grant was inserted, and past the cap it isn't. A capped referrer at 0 hours keeps
  `isOutOfHours` true, so the next minute tick (`cron.ts:256` → `warnHours`) finds `warned_zero_at` null and sends
  "You're out of ADE Cloud hours" again. `hours_restored_at` also moves forward, which restarts the 30-day inactive
  delete clock for every one of their computers (`store.ts:973-976`).
- **Failure scenario:** A referrer who hit the cap and is out of hours gets a fresh out-of-hours email each time a friend
  of theirs is rewarded. Their idle computers also keep getting another 30 days of free storage.
- **Fix:**
  - Split the statement in two. The friend's row works as today.
  - The referrer's row recomputes `earned_granted_milli` as today, but resets the warning and restore columns only when
    `exists (select 1 from cloud_earned_hours where user_id = ? and reason = 'referral_referrer' and reference = ?)`
    for this friend.
- **Auto-applicable:** Yes. It is unambiguous and behavior-preserving for every case that paid.

## Low

### L1. When the cleanup's `prepare-stop` fails, the push runs anyway with agents still working

- **Where:** `planCleanup.ts:83` runs `ade cloud prepare-stop --timeout 40 >/dev/null 2>&1 || true`.
- **Evidence:** The desktop's own "free the computer" refuses when the agent is busy or its state is unknown
  (`cloudLaneLife.ts:267-269`). The server swallows a `prepare-stop` failure. An agent that is still running can write
  after the `work-state` check and before `deleteComputer`. The window is seconds wide, but the writes would be lost.
- **Fix:** Read `prepare-stop`'s exit code or JSON. When it did not confirm that the agents stopped, keep the computer
  (code `prepare_stop_failed`). It is tried again tomorrow.
- **Auto-applicable:** Yes, provided `prepare-stop --json` reports the result. Otherwise it needs a CLI flag.

### L2. Missing `CLOUD_CHAT_MASTER_KEY` in production silently falls back to the public development HMAC key

- **Where:** `apps/account-directory/src/cloud/freePlan.ts:100-111`.
- **Evidence:** With no secret, computer ids are keyed with the source constant `ade-cloud-free-plan-dev-key`, logged
  once per isolate (`logCloud`, not Sentry). The client hash is SHA-256 of a public salt plus the OS machine id, so stored
  values become matchable by anyone who knows a machine id. When the secret is later set, every stored hash changes:
  every claim is orphaned and every computer can claim the free plan again. The key is also tied to
  `CLOUD_CHAT_MASTER_KEY`, so rotating the chat key resets all claims. Production has the secret today (saved chats need
  it), so this is defense in depth.
- **Fix:** When `SENTRY_ENVIRONMENT === "production"` and the secret is missing, call
  `reportCloudFailure("cloud.free_plan.no_key")` and skip settling (claim nothing, refuse nothing). Add a comment in
  `chats.ts` that rotating the master key resets free-plan claims.
- **Auto-applicable:** Yes.

### L3. A malformed invite lookup path returns 500 and raises a Sentry error from a public endpoint

- **Where:** `referrals.ts:409`: `decodeURIComponent(url.pathname.slice(...))`.
- **Evidence:** `GET /invites/%E0%A4%A` throws a `URIError`, which nothing in `handleInviteLookup` catches. `index.ts`
  reports it as a 500 error to Sentry. Anyone can trigger this without signing in, so it is error noise on demand.
- **Fix:** Wrap the decode in `try`/`catch` and answer 404 on failure.
- **Auto-applicable:** Yes.

### L4. The Stripe customer create can now hit an idempotency conflict

- **Where:** `billing.ts:142-151`.
- **Evidence:** The idempotency key `ade-cloud-customer-<userId>` is unchanged, but the params now include `email` only
  when Clerk answered. If a first create reaches Stripe and its id never gets saved (lost response, or a failed D1
  write), a retry within 24 h with the other email shape gets Stripe's 400 `idempotency_error`. Checkout then fails for
  that account until the key expires. Before this branch the params were constant.
- **Fix:** Create the customer with the constant params (metadata only), then call
  `fillCustomerEmail(env, id, email)` after it, as is already done for existing customers.
- **Auto-applicable:** Yes. It is behavior-preserving: Checkout still shows the email.

### L5. `buildAccountState` claims the referral read can't fail the account read, but half of that read is unguarded

- **Where:** `store.ts:1003` (`readSummaryRow` inside the unguarded `Promise.all`) versus the guarded `referralSummary`
  at `:996-1000`.
- **Evidence:** A D1 error in `readSummaryRow` (or a Worker deployed before migration 0026) fails all of
  `GET /cloud/account`. That is the dashboard, the CLI's `ade cloud status`, and MCP.
- **Fix:** Add `.catch(() => null)` with `reportCloudFailure`. With no summary row, use `freePlanOf(account, false)` and
  omit `referral`.
- **Auto-applicable:** Yes.

### L6. Three catches swallow errors with no log

- **Where and evidence:**
  - `billing.ts:143`: `accountEmail(...).catch(() => null)`.
  - `referrals.ts:414`: `clerkFacts(...).catch(() => null)` in the public lookup.
  - `costReport.ts:160`: the top-accounts query `.catch(() => ({ results: [] }))`.
  - Each one hides a Clerk outage or a D1 error. The project rule treats a silent catch as a finding.
- **Fix:** In each catch, call `logCloud` (or `reportCloudFailure` with `area`) with the error name only. Never the email
  or the code.
- **Auto-applicable:** Yes.

### L7. A kept computer is reported to Sentry as an ADE failure even when the person just has unpushed work

- **Where:** `planCleanup.ts:359`.
- **Evidence:** `keep()` calls `reportCloudFailure("cloud.plan_cleanup_kept")` for every reason, including
  `push_left_work` and `check_left_work`. Those are normal user states (for example a dirty primary lane, which push-work
  never pushes), and they repeat daily. That is alert noise on the new `area` tags the alert rules key on.
- **Fix:**
  - For the codes `push_left_work` and `check_left_work`, call `logCloud` only.
  - Keep `reportCloudFailure` for the unreadable, unreachable and wake-timeout codes.
- **Auto-applicable:** Yes.

### L8. The new plan-cleanup email runs before the past-due email in `announceChange`, so its failure can skip that email

- **Where:** `billing.ts:538-543`.
- **Evidence:** `warnPlanCleanupAhead` calls `listComputers`, which can throw on a D1 error, before the past-due or
  restored email branch. A throw skips that email. The Stripe retry then sees `before == after` and never sends it.
- **Fix:** Wrap the plan-cleanup warning in its own `try`/`catch` with `reportCloudFailure`.
- **Auto-applicable:** Yes.

### L9 (needs a human). Two policy gaps in referrals and deletion

- **Mutual referrals:** A enters B's code and B enters A's code within each other's 30 days, on two different computers.
  Each account then gets 40 h: 20 as friend plus 20 as referrer. No rule forbids it, and PLAN decision 4 does not mention
  it. A one-line refusal (`mutual`) in `redeem` would close it, if the owner wants it closed.
- **Deletion:** `deleteCloudAccount` deliberately keeps `cloud_referrals`, `cloud_earned_hours` and
  `cloud_free_plan_claims` rows with the deleted account's Clerk user id. The comment says they "hold no personal data".
  A Clerk id is a pseudonymous identifier tied to a person. Keeping the claim is required (no re-claim after re-signup),
  but the privacy policy line should say so, or the rows should be re-keyed to a hash of the user id at deletion.

## Checked and fine

- **Referral reward race and cap** (`referrals.ts:280-311`):
  - The reward is one D1 batch, which is one transaction.
  - The state flip is gated by a per-call token, and both grants are gated on that token.
  - `unique (user_id, reason, reference)` makes the grants idempotent.
  - The cap's `count(*)` is inside the insert's `select`, in the same transaction. D1 serializes writes, so two rewards
    at once cannot both be the 10th.
  - `earned_granted_milli` is recomputed from the grants themselves.
- **Earned-hours draw at the period roll** (`store.ts` `EARNED_DRAW_SQL`, `startFreshPeriod`):
  - The draw is held to `period_start = <the period read>`, so two racing rolls draw once.
  - The draw reads the row after the settles and before the reset, with old `stripe_status`/`extra_*` because the
    `alongside` updates run after it.
  - `past_due_earned_milli` is stashed in the same `UPDATE`, so it sees the old values.
  - `restored_same_period` gives the stash back, and `restored_new_period` clears it.
  - JS `billedExtraMilli` and the SQL agree with `accountRules`.
- **Earned hours never billed:**
  - `extraUsedMilli = live - included - draw`, and the draw is capped by the balance and excludes extra hours already
    reported or owed. For every ordering I traced (grant before or after extra reports, the switch turned off, past due),
    `billable - extra_reported_milli >= 0`, and no hour is both drawn and billed.
  - `isOutOfHours`, `updates.ts`, and the create and wake checks all go through the earned-aware helpers.
- **Free-plan claim races:**
  - Both unique keys on `cloud_free_plan_claims`, plus `on conflict do nothing` and a re-read, settle two simultaneous
    claims to one.
  - `refuse` and `restore` are guarded updates.
  - A refusal written mid-roll is honored (`included_milli = case when … free_refused_at is not null then 0`).
- **Plan cleanup safety rails that hold:**
  - `past_due` is never cleaned (`cleanupPlanOf`, `waitingPlanOf`).
  - The 3-day grace runs from the first run that sees the over-limit state.
  - The per-computer claim with a 20-minute stale window means overlapping runs free a computer once.
  - The push wake is free: it uses the same `awake_since = now + 15 min` / `free_wake_until` pattern as the person's
    push-work wake, and `stopAll` skips it.
  - Moves, reservations and updates in flight are waited out.
  - An older ADE without a lane list, or unreadable JSON, keeps the computer.
- **Stripe price swap:**
  - The extra-hours price is used only at Checkout. Existing subscriptions keep billing on the archived price, which
    Stripe allows, and it is on the same meter as the server's meter events.
  - `hasDiskItem` finds an older disk price by meter, so turning extra disk on never adds a second item on the disk meter.
  - The var `STRIPE_EXTRA_HOURS_PRICE_ID` wins over the older secret, and production's other Stripe vars are sandbox ids
    too, so they are consistent.
- **Checkout email:** it comes from Clerk and is never logged. Only the Stripe status is reported on a failure.
- **Access gate:** `/cloud/referrals` and `/cloud/referrals/redeem` sit after `if (!allowed) return notFound()`. The
  public `/invites/<code>` answers 404 for an inviter without access, so it can't be told apart from an unknown code.
- **Public lookup:**
  - Rate-limited to 30 a minute per IP, in D1.
  - It returns only `firstName`, with CORS `*` and no credentials.
  - Its logs carry no code.
- **Analytics:**
  - No invite codes or emails in server events: the uuid seeds hash the friend's id, which is never sent.
  - The web: `withoutInviteCode` covers screen, URL, referrer and pathname. The ad pixel is skipped on `/invite`.
    Replay masks text, link attributes and heatmap keys there.
  - Vercel's catch-all rewrite serves `/invite/<code>`.
- **Migrations 0026 and 0027:**
  - Additive only. `add column … not null default 0` is valid in SQLite, and the old Worker's `select *` ignores the new
    columns, so it is safe to apply before the Worker deploy.
  - Numbering follows main's 0025.
  - Every new query has an index: `cloud_referrals(referrer_user_id, state)`, `cloud_account_computers(computer_hash)`,
    the PKs and unique keys, and `idx_cloud_chat_copies_user` for the redeem's chat check.
- **Cancelled-wakes count** (`accountNotices.ts`): `delete … returning` counts each wake once across overlapping ticks.
  The "first of the period" update is a guarded single statement, and later ones add.

## By design (no finding, noted for the record)

- **The header can be forged:** `x-ade-computer` is asserted by the client. Anyone can send a random 64-hex value, or no
  header (phone, MCP), and claim or keep a free plan. A refused account can even restore itself with a forged id on a
  read. PLAN decision 5 accepts this, with phone verification later.
- **Gitignored files:** files outside git (`.env`, local databases, untracked files covered by `.gitignore`) are lost
  when the cleanup frees a computer. The cleanup sentence says ADE pushes "each lane's work", which is accurate, but the
  owner may want the email to say plainly that only git work is saved.

## Deploy note

Run this read against production D1 before the deploy. The first owner check after the deploy warns, and 3 days later
frees computers in, every account already over its plan: free with more than 3 computers or more than 12 GB, Plus with
more than 10 or more than 40 GB, `deleted_at is null`, and not `past_due`. It also covers accounts no longer on
`CLOUD_ACCESS_ACCOUNTS`: `runPlanCleanups` does not check access. Confirm the list is only the owner's test accounts.
