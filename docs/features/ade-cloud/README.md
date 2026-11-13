# ADE Cloud

ADE Cloud is an ADE feature: Linux machines ADE runs for the person. Each one
has ADE's brain as its main process, signs in to the person's ADE account with
nothing to type, and appears under Your computers. From then on it is an
ordinary remote machine (see [Remote Runtime](../remote-runtime/README.md)).

The product plan and build order are in
[docs/plans/ade-cloud-roadmap.md](../../plans/ade-cloud-roadmap.md).

Everything here is account-level: it acts on the account's cloud machines, not
on a lane, chat or another machine, so these IPC calls take no pin. A new
machine's own actions go through the machine list like any other computer.

## Layers

```
renderer (window.ade.cloud)   CLI (ade cloud)   phone (cloud.read/write)
              \                     |                  /
       registerCloudIpc      `cloud` action domain (adeActions/registry.ts)
                       \            |
        machines, sleep, create, copy, move, lanes, hours, sign-ins
                                    |            (apps/desktop/src/main/services/adeCloud/)
                       CloudProvider (cloudProvider.ts)
                                    |
                 getCloudProvider (cloudAccess.ts)   <- the one place that picks the provider
                                    |
                 cloudServerProvider.ts   <- calls ADE's server (`/cloud/*` on the account directory)
                                    |
                 apps/account-directory/src/cloud/   <- the only code that knows the provider's API
```

A lint rule (`apps/desktop/eslint.config.mjs`) stops main-process code other
than `cloudAccess.ts` and tests from importing the server provider. Above the
seam, nothing knows who runs the computers.

## The provider seam

`CloudProvider` (`cloudProvider.ts`) is the contract: list, get, create, delete,
sleep, start, stop, update, resize, back up, auto-sleep, public port, fork,
signed URL, name, metadata, usage, whether the server can make a computer now,
and exec, plus the account's access, plan and billing calls. Failures are
`CloudProviderError`, with the server's one plain sentence (for a refusal ADE
doesn't word itself, such as the provider's `invalid_request`, that sentence
carries the provider's own explanation, cleaned: `cloudRefusalMessage` in
`provider.ts`); the code
`CLOUD_ACCESS_REFUSED` means the account was refused. The server's shapes are in
`apps/account-directory/src/cloud/contract.ts`.

## Access

`getCloudProvider(deps)` returns ADE Cloud for this account, or null. It needs a
signed-in ADE account. The bearer is the account token; no provider key exists
on any desktop or brain. `/cloud/access` is read at most every 10 minutes per
account (a cached yes survives a failed check). The `signedOut`, `no_access` and
`unreadable` states keep their sentences (`requireCloudProvider`,
`readCloudStatus`).

A development build reaches a local server through the account directory's own
override: set `ADE_ACCOUNT_DIRECTORY_URL` (for example to
`http://127.0.0.1:8787`), the same mechanism every other account call uses.

## Source file map

| Area | File (under `services/adeCloud/`) |
|---|---|
| Machine list and box actions | `cloudMachines.ts` |
| Making a machine, its sign-in, joining the account | `cloudMachineCreator.ts`, `cloudApprovalWindow.ts`; the headless approval a brain runs is `apps/ade-cli/src/services/account/cloudHeadlessApproval.ts` |
| Half-made machines after a quit | `cloudPendingCreates.ts` |
| Copy and move | `cloudMachineCopy.ts` |
| Reconnect a machine removed from ADE | `cloudReconnect.ts` |
| Sleep, wake for use, agent limits | `cloudSleep.ts`, `cloudSleepWatch.ts`, `cloudBrainAccess.ts` |
| Saved ADE Cloud keys and Claude's sign-in (kept in the account vault) | `cloudSignInStore.ts`, `cloudSignInActions.ts`, `cloudClaudeSignIn.ts`; `cloudSignInBoot.ts` only for computers an older ADE made |
| Claude passes (one per Claude account, cloud only) | `claudePassStore.ts`, `claudePassVerify.ts`; on a machine `services/claudePass/` |
| The sign-in end warning (Claude passes, and keys with an end date from their provider) | `cloudSignInEndWarning.ts`; the banner `renderer/components/settings/providers/cloud/CloudSignInEndNotice.tsx` |
| Shared machine operations (metadata patch, wake through a transition) | `cloudInstanceOps.ts` |
| Product analytics for cloud lanes (launch result, freed lane, Clear caches; the renderer sends the default size) | `cloudLaneAnalytics.ts` |
| Account sign-ins on every computer (capture, apply, renewal) | `services/providerLogins/` (entry `providerLoginSync.ts`, one file per job) |
| CLI and agent verbs, approvals | `cloudAgentActions.ts`, `cloudBrainMaker.ts`, `cloudDesktopActions.ts` |
| A new lane on its own new computer (before the hand-off to its brain) | `cloudLaneLaunchService.ts`, `cloudLaneLaunchRecords.ts`, `registerCloudLaneLaunchIpc.ts` |
| Rules on a cloud computer (one lane, Codex full access) | `cloudComputerRules.ts`, `cloudComputerLaneHold.ts` |
| Desktop IPC | `registerCloudIpc.ts` |
| Reaching ADE's server, access | `cloudServerProvider.ts`, `cloudAccess.ts`, `cloudVaultItems.ts` |
| Server (account directory, `apps/account-directory/src/cloud/`) | `routes.ts`, `store.ts`, `billing.ts`, `cron.ts`, `chats.ts`, `provider.ts`, `accountDeletion.ts`, `referrals.ts`, `freePlan.ts` |
| Lane launch: the launch's steps and stage cards, the account status a launch checks first | `cloudLaneLaunchSteps.ts`, `cloudLaneComputerStages.ts`, `cloudAccountStatus.ts` |
| Lane life: delete, keep the lane and free its computer, tier change, work check; the job events to every window | `cloudLaneLife.ts`, `registerCloudLaneLifeIpc.ts`, `broadcast.ts` |
| Lane renames written to the computer's metadata | `cloudLaneNameSync.ts` |
| The disk measure and Clear caches on a cloud computer | `cloudDiskUsage.ts` |
| Boot and idle reports from a cloud computer (CLI) | `apps/ade-cli/src/services/power/cloudComputerReports.ts`, `apps/ade-cli/src/services/power/cloudKeepAwake.ts`, `apps/ade-cli/src/services/power/cloudIgnoredFiles.ts` |
| Idle cleanup (warn, save, delete unused computers) | `apps/account-directory/src/cloud/idleCleanup.ts`, `apps/desktop/src/renderer/components/settings/cloudDashboard/CloudIdleCleanupNotice.tsx` |
| CLI status read (`ade cloud status`) | `apps/ade-cli/src/cliCloudStatus.ts` |
| The launch card in chat (its step rows share one parts module with the lane job card) | `apps/desktop/src/renderer/components/chat/launch/adeCloudLaunch.ts`, `apps/desktop/src/renderer/components/chat/launch/stepCardParts.tsx` |
| The dashboard in Settings › ADE Cloud, and the lane pieces (cities, job card, tier change, lanes without a computer) | `apps/desktop/src/renderer/components/settings/cloudDashboard/*`, `apps/desktop/src/renderer/components/cloudLane/*` |
| Server: automatic updates, lanes without a computer, the disk usage report (migrations `0020`, `0021`, `0022` in `apps/account-directory/migrations/`) | `apps/account-directory/src/cloud/updates.ts`, `lanesWithoutComputer.ts`, `diskUsage.ts` |

Shared contracts are in `apps/desktop/src/shared/adeCloud.ts`,
`cloudSignIns.ts`, `cloudTiers.ts` (the four lane sizes, read from the catalog)
and `cloudLaneLaunch.ts`. On a machine, `apps/ade-cli/src/services/power/cloudKeepAwake.ts`
keeps it awake while it works and asks the server to sleep it 3 minutes after
that stops (see Sleep and busy rules).

## Surfaces

- **Settings:** Settings › ADE Cloud, its own tab, listed right under General
  (its settings stay account level) (`CloudSection.tsx` and the
  dashboard in `settings/cloudDashboard/`): the hero with hours, disk and
  computers against the plan, every lane and computer, Plans (`CloudPlans.tsx`:
  one card per plan, the current one on its own patch of the hero's dusk sky
  and the next one up with the main button; buy Plus or Pro, move between
  them or stay on Pro; one "how hours and disk work" panel under the cards
  holds every explanation and the account's own notes; extra hours and extra
  disk as two tiles; and Manage billing, which opens Stripe's portal),
  Sizes, Invite friends, Sign-ins and what agents may do alone, with the
  80% / 95% / out-of-hours banners and computers due for deletion. Settings
  entries are `integrations.ade-cloud*`.
- **Add a computer:** a new lane on ADE Cloud makes its own computer. The old
  "New ADE Cloud computer" form and the ready machines are gone (Cloud 5);
  `ade cloud create` and the phone still make a bare computer.
- **New lane on ADE Cloud:** a chat launch with a `cloud` target makes one
  computer for one lane, then hands the launch to that computer's brain. See
  [ADE Cloud lanes](../chat/README.md#ade-cloud-lanes).
- **The composer:** "Run on" lists one ADE Cloud row (the person's lanes as a
  small skyline), the lane list shows this project's ADE Cloud lanes from the
  computers' metadata with no wake, and a size button picks the tier for a new
  lane. The default size is the account preference `cloudDefaultTier`, Small
  at first. A label above the box turns Send off when the account is out of
  hours, uses all its computers, or has a full disk. See
  [Run on ADE Cloud in the composer](../chat/README.md#run-on-ade-cloud-in-the-composer).
- **Dashboard:** Settings › ADE Cloud is one tab (`settings/cloudDashboard/CloudDashboard.tsx`):
  hours, disk and lanes against the plan, every cloud lane as a city or a list,
  each row's actions behind its ⋯ menu (What uses the disk, Change size, Keep
  the lane and free its computer, Delete), and "Free up space" at 80% of the plan's disk (`CloudFreeUpSpace.tsx`: the
  biggest lanes first, then the longest unused; each one is kept with its
  computer freed, or deleted). The disk measure is each computer's own
  (`cloudDiskUsage.ts`): its repository, dependencies, Docker, Android,
  caches, agent programs (the tools cache) and ADE data (chats and lanes),
  with the rest as "System and other". A part on another disk than the home
  disk (an SDK baked into the image) is left out, since it uses none of the
  billed disk. It is measured at its idle step at most every 6 hours and sent
  with its last work. The dashboard reads it with the computer list, so it wakes nothing.
  Clear caches runs on that lane's own computer, through its brain
  (`cloud.clear_caches`). The dashboard confirms first; an agent's call asks
  the person with a card in its chat, and with nobody watching (full-auto, an
  automation, ADE MCP) the answer is no.
- **Sizes:** one set of size cards (`CloudSizeCards.tsx`) serves the Sizes
  card on the page and the change-size dialog. Each card shows how long the
  hours left (the plan's and earned ones) last at that size.
- **A cloud lane's chat:** a cloud button in the chat header manages that
  lane's computer in place: Change size, Disk, hours and more (opens the ADE
  Cloud page), Sleep (it asks first while the chat's turn runs) and Delete
  lane. Account level, by the computer's ADE Cloud id, so it works for a chat
  on any machine.
- **Look:** the Night sky tokens, the cloud mark, the size icon and the skyline
  live in `remoteTargets/cloudBrand.tsx` and `cloudBrand.css`. A light theme
  changes the tokens there once.
- **CLI:** `ade cloud` (`ade help cloud`) and
  `ade chat create --machine cloud [--size <size>]` (a new lane on its own
  computer; see [From the CLI and agents](#from-the-cli-and-agents)).
- **Agents:** the `ade-cloud` skill (see [Guidance for agents](#guidance-for-agents)).
- **Phone:** the cloud page, over the `cloud.read` and `cloud.write` sync commands.
- **Bring your own provider:** `BringYourOwnCloudCard.tsx` is layout only and
  shows only when `BRING_YOUR_OWN_CLOUD_ENABLED` is on. Nothing is wired to it.

## Plans, hours and sizes

The rules are in [docs/plans/ade-cloud-plans-and-disk.md](../../plans/ade-cloud-plans-and-disk.md).
The server's `plans.ts` holds them, and `GET /cloud/account` sends them in
`catalog`, so no client keeps its own copy (`cloudCatalogOf` in
`shared/adeCloud.ts` fills gaps from an older server).

| Plan | Price | Hours a month | Disk at one time | Phone minutes | Extra hours |
|---|---|---|---|---|---|
| Free | $0 | 100 | 12 GB | 20 | none: work stops |
| Plus | $5 | 300 | 30 GB | 30 | 2¢ an hour |
| Pro | $20 | 1,600 | 80 GB | 160 | 1.5¢ an hour |
| Max | $50 | 5,000 | 175 GB | 500 | 1.2¢ an hour |

Hours are Small-computer hours. Disk is what the account's computers hold at
one time, never a monthly amount. No plan limits how many computers an
account has (Cloud 7). The account says `plan: "free" | "paid"` for older
builds and `planId: "free" | "plus" | "pro" | "max"` for new ones; a
`past_due` account follows the free rules but keeps what it has. Phone
minutes are shown on the plan table only; nothing meters them yet.

- **Cloud 7 terms, from each account's next period** (migration 0033,
  `old_plan_terms`): accounts that existed before keep Plus's 40 GB and Pro's
  120 GB until their next period starts, so nobody is cut mid-period. Hours
  are stored per period (`included_milli`), so the new hours (Plus 300,
  Pro 1,600) start with the next period. Free is the exception (Cloud 8): a
  free period that began on fewer hours than the free plan has now is raised
  at once on the next read (`raiseFreeHours` in `store.ts`, never for an
  account refused the free plan or held by the GitHub rules, and its
  out-of-hours warning clears), since more hours never hurt. `ade cloud
  status` says both numbers when a paid period's hours differ from its plan's
  ("500 hours this period, 300 from 2026-12-01").
- **Extra hours** are one flat price per plan (2¢, 1.5¢, 1.2¢), each its own
  Stripe metered price on the one extra-hours meter
  (`STRIPE_EXTRA_HOURS_{PLUS,PRO,MAX}_PRICE_ID`). Checkout sells only the
  plan (Cloud 8): the extra-hours item joins the subscription, at the price
  of the plan in force, when the person first turns extra hours on
  (`ensureExtraHoursItem`), before the switch goes on, so no extra hour is
  ever reported with nothing to bill it (meter events bill by customer). It
  stays at zero once off, which keeps billing hours used before. Extra disk
  joins the same way (`setExtraDisk`). Subscriptions from before Cloud 8
  keep the items they hold. An upgrade moves the subscription's hours item to the new plan's
  price at once; a downgrade or a subscription still on the old graduated
  price (1¢, then 0.85¢) and the old $1 disk price moves at its next renewal
  (`moveMeteredItems`, `cloud.metered_price_moved`).
- **Awake cap (hidden):** about 25 computers awake at once per account
  (`AWAKE_COMPUTER_CAP`). It is never shown as a plan limit. A wake waits up
  to 12 seconds for room (another computer going to sleep), then answers 429
  `too_many_awake` with a plain sentence; a create, copy, resize wake or
  sign-in wake past it is refused at once. Each refusal reports
  `cloud.awake_cap_reached`; the 10-minute owner check reports
  `cloud.awake_cap_passed` (traffic wakes the server can't stop) and adds an
  owner alert line. Older builds still read `computers.limit`: the server
  sends `max(25, computers + 1)` there, so their "computers full" check never
  blocks.

- **Sizes:** the main list is Small (standard 2/4, 1x, disk up to 12 GB),
  Medium (standard 4/8, 2x, 20 GB), Large (full 4/8, 5x, 50 GB) and X-Large
  (full 4/16, 8x, 100 GB). The other four shapes stay valid with the
  provider's own disk limit (`catalog.sizes[].tier`, `label`, `diskMaxGb`).
- **"You're on Plus":** when a purchase or a move up lands (the account
  flips to a higher paid plan while ADE is open, or ADE opens for the first
  time since the checkout), ADE says so once: a toast app-wide with the plan's
  hours, disk and renewal date, and on the ADE Cloud page a banner and a
  one-time glow on the new plan's card. From Free it also says how many unused
  free hours the paid period replaced. What this computer last saw (plan,
  period, hours left) is kept per account in localStorage
  (`cloudPlanMoment.ts`), so a reload never repeats it and a computer that
  never saw the account seeds quietly. The phone does the same with
  UserDefaults. It records `ade_feature_used` `cloud_plan`/`completed`.
- **Changing plans:** Plus to Pro applies now, charges the difference for the
  rest of the period, and keeps the hours used. Pro to Plus applies at the
  period end (`billing.nextPlanId`); the same for Max to Pro or Plus. A
  downgrade is never refused: over the cheaper plan's disk, the answer
  carries `cleanup`, what that plan's disk will free (see **A cheaper plan's
  limits**). Both go through `POST /cloud/billing/checkout {plan}` on the
  subscription itself. The billing portal doesn't switch plans (its setup
  turns `subscription_update` off): ADE's switch is the one that checks the
  cheaper plan's limits, and a portal downgrade would leave a subscription
  schedule that refuses ADE's own changes.
- **Not set up yet:** Pro and extra disk are offered only once their Stripe
  prices are set. Until then `catalog.plans.plus`/`pro`,
  `catalog.extraDiskCentsPer10GbMonth` and `account.extraDisk` are absent, a
  checkout for Pro is a 400 and the extra-disk route is a 404.
- **Extra disk** (Plus, Pro and Max): disk past the plan's, $2 for each 10 GB a
  month, counted by the day on the day's peak (`cloud_disk_days`, its own
  Stripe meter). It starts undecided; the first grow past the plan is refused
  with reason `needs_approval` and ADE asks once. On, a grow passes only
  when a full 30-day month of the new extra disk fits the monthly limit the
  person set (`POST /cloud/billing/extra-disk`), and what a period bills never
  passes it. Each day's row records the bought plan's disk and whether the day
  is billable (paid, in good standing, extra disk on) when it is written, and
  is billed from the row alone, from the 10-minute owner check. A send that
  fails is retried inside Stripe's one-day dedupe window; one never confirmed
  goes to the owner (`cloud.disk_meter_unconfirmed`), never resent. The daily
  run emails a person once when their extra disk, kept a month, passes the
  limit (a lowered limit, a plan change), and lists them in the owner report.
- **More disk than the free plan has:** an account on the free plan (a
  cancelled plan rolls to it; `past_due` does not count) with more than 12 GB
  keeps its computers but they stay stopped: a wake, a command, an update and
  a new timed wake are refused with 402 `over_plan_disk`, except the short
  "Push all work to GitHub" wake, which does not restart the idle cleanup's
  clock. Timed wakes already set are deleted, as at 0 hours. Deleting a computer always works,
  and the idle cleanup of unused computers still runs. The owner report
  lists these accounts. A cheaper plan's limits apply too (below).
- **A cheaper plan's limits** (`planCleanup.ts`, migrations 0027 and 0032;
  the owner's rules of 2026-11-13): ADE never removes a computer on its own,
  and there is no grace period. Disk that extra disk covers counts as
  fitting; a `past_due` account is never cleaned.
  - **In ADE (a move to a cheaper paid plan):** only disk counts. A move
    that fits asks nothing special. A move that would leave more disk than
    the cheaper plan allows (`downgradePreviews.plus` / `.pro`) opens a
    question first
    (`CloudPlanLimitsDialog.tsx`): "I'll clean up myself" (nothing changes;
    it lists the oldest computers whose delete would be enough) or "Let ADE
    handle it" (a "Push all work to GitHub first" switch, on by default, and
    the computers to free, the oldest that make it fit checked to start; the
    send stays off until the pick fits). The checkout request carries the
    pick (`cleanup`, `CloudPlanCleanupPick`); the server checks it names only
    the account's computers and makes the account fit before Stripe is asked
    (409 `cleanup_does_not_fit` / `cleanup_changed` / `cleanup_running`
    change nothing), changes the plan, and records the pick
    (`plan_cleanup_choice_json`). The minute cron (`runPlanCleanupPicks`)
    frees exactly those computers at once, a few a tick, not at the period
    end. A request without a pick (an older build) changes the plan and
    deletes nothing.
  - **Outside ADE (a cancel in the billing portal, a plan that ended):** nothing is
    deleted. Once the cheaper plan is in force and the account is still over
    it, a new computer or a copy is refused with 403 `over_plan_limits`
    (`overPlanLimitsSentence`), the ten-minute owner check emails the person
    once (`plan_over_told_at`), and the dashboard's notice opens the same
    question ("Choose what goes"), which sends `POST
    /cloud/billing/plan-cleanup`. A cancel waiting for the period end gets an
    email and the same notice, with the date.
  - **Freeing one computer** keeps its lane. With push on, the computer's own
    ADE interrupts its agents, saves its chats and pushes every lane's work
    (`ade cloud prepare-stop`, `push-work`, run over exec in a free 15-minute
    wake), a `work-state` read must find nothing left, then the computer is
    deleted. A computer whose work can't all be pushed stays and the person
    is told; nothing else goes in its place. With push off (a second
    confirmation in ADE), an awake computer saves its chats and the computer
    is deleted. Either way the lane stays as a lane without a computer
    (reason `plan_limit`), with its chats; the next message to it makes a new
    computer. After the pick, an email names each computer and the branch its
    work went to, and the account carries `planCleanupDone` for 14 days. The
    phone shows the notices and sends the person to the desktop to pick.
- **Idle cleanup** (`idleCleanup.ts`, migration 0034; the owner's rules for
  Cloud 7, replacing the 30-day delete). Idle means not awake since the later
  of `last_awake_at` (or creation), `hours_restored_at` and `idle_kept_at`.
  Free: warned at 2 days idle (email and in ADE, "deleted in 1 day"), one
  more email about 6 hours before, deleted at 3 days. Paid (Plus, Pro, and a
  `past_due` paid account): warned at 7 days ("deleted in 3 days"), one email
  a day, deleted at 10 days. The minute cron runs it.
  - **Never sooner than promised.** The warning stores the delete time it
    announced (`idle_deletes_at`); the delete waits for it and for the last
    email plus a gap (5 hours free, 20 hours paid). A late first warning still
    gives the full lead. A plan change re-times it: the delete is the later
    of the announced time and the new plan's rule, so an upgrade moves it
    later (and warns again at the new plan's warning time) and a downgrade
    never moves it earlier.
  - **Never for** an account out of hours or without access, a computer that
    is awake, pending, moving or updating, or one with a timed wake-up booked
    (a `cloud_wakes` row: a chat's scheduled wake-up or an automation's
    schedule, up to 32 days ahead; the wake itself counts as use). Using it
    (`last_awake_at`), its hours coming back, or "Keep it" (`POST
    /cloud/instances/:id/keep`, no wake, no hours) void the warning and
    restart the clock; a booked wake-up voids it too (kept, `scheduled`). The
    warning's and each follow-up's claim also checks that none of these
    happened since the tick read the row.
  - **Emails.** Paid follow-ups go out at 2 days and 1 day before the delete
    (anchored on the delete time, so a late tick never pulls the next one
    earlier). A send that fails keeps its claim, is reported (Sentry
    `cloud.idle_cleanup_email_failed`, step `failed`), and never blocks the
    steps after it; the in-app warning stands.
  - **Save first.** In a free wake (as an update's), the computer's own ADE
    stops its agents, saves its chats, commits with "saved by ADE before
    cleanup" (`ade cloud push-work --message`) and does a normal push to each
    lane's own branch (never force, no extra branch; `git add -A` leaves out
    what git ignores), then a `work-state` read must find nothing left
    (`pushAllWork`). If it doesn't go through, the computer is kept
    (`idle_held_at`/`idle_held_reason`): one email and an in-app notice say
    why, what to do and when ADE tries again (`held.retryAt`), Sentry gets
    `cloud.idle_cleanup_push_refused` or `cloud.idle_cleanup_save_failed`,
    and each failure in a row doubles the wait (1, 2, 4 ... days, at most
    14; `idle_held_count`). A run that fails after the save (the provider
    refuses the delete, or anything throws) records `idle_failed_at` and
    waits 1, 2, 4 ... hours (at most a day) before it runs again. Used while
    the save ran (Keep it, hours back, a booked wake-up, or a start, command
    or sign-in through the account server, which marks `last_awake_at` while
    `idle_claimed_at` is held), it isn't deleted; one the person started
    stays awake for them, any other goes back to rest.
  - **The lane stays** as a lane without a computer, reason `idle_cleanup`;
    its chats stay and the next message makes a new computer from the branch.
    The delete is `system` with reason `idle_cleanup`.
  - **Ignored files.** At its idle step the computer reports, with its disk
    report, a summary of what git ignores in its lanes (`ignored` on `POST
    /cloud/instances/:id/disk-usage`: up to 10 paths, the likely precious
    such as `.env` and local databases first, a count of the rest, build and
    install folders only counted; `cloudIgnoredFiles.ts`). The server keeps
    it (`ignored_files_json`) and the warning lists it, or says it isn't
    known yet. A lane that can't be read (a timeout) marks the summary
    `incomplete`, and the warning says there may be more; entries past
    5,000 in a lane count in `more`.
  - **Where it shows:** `account.dueForDeletion` (`CloudIdleCleanupEntry`:
    when, the lane and branch, the idle days, the ignored files, `held`).
    The dashboard shows a notice per computer with "Keep it" and a mark on
    the lane row (`CloudIdleCleanupNotice.tsx`); the lane's chat header cloud
    button gets a dot and a "Keep it" entry; the phone shows the notice and
    says to send a message in the lane or keep it from the desktop.
  - **Once per step:** every warning and email is claimed with a conditional
    update before it is sent, and the save-and-delete with `idle_claimed_at`,
    so overlapping cron ticks do it once. Each step writes a row to
    `cloud_idle_cleanup_log`, which the owner report counts.
- **Timed wake-ups cancelled:** when a blocked account's timed wakes are
  deleted (0 hours, or the free plan over its disk), the person gets one
  email a period, and the account carries `timedWakesCancelled` while that
  period runs. Each computer sets its next timed wake again the next time it
  runs.
- **Refusals:** a create, copy, move or grow past a limit answers code
  `disk_limit` (or `needs_paid_plan` on Free) with `reason`
  (`CloudDiskRefusalReason`) and a plain `message`. A client that doesn't
  know a reason shows the message.

At 0 hours the server refuses, and that sentence is what the person sees.
Hours, plan, disk and billing come from `GET /cloud/account`
(`CloudAccountState`), read only while ADE Cloud is visible
(`useCloudMachines`). The server picks the image and the first disk (4 GB; a
move keeps the old computer's disk, and the old disk doesn't count twice). A
disk only grows, through `resize` with `disk`: on its own near full, when the
computer is idle (`ade-cli/src/services/power/cloudDiskGrow.ts`, which sends
`origin: "auto"`), or from the Android pane. A first Android start needs
about 7.2 GB free for the device's data, so on a cloud computer the brain
refuses it up front (`ANDROID_LOW_DISK`, `androidDiskGuard.ts`), and the pane
offers **Grow the disk** to the smallest 4 GB step that fits. The person
confirms the restart, which is what the request's `computerIdle` says. The
notice follows the plan rules (`AndroidCloudComputerNotice.tsx`): no button
past the size's `diskMaxGb`, or past the free plan's disk at one time; on a
paid plan it gives the extra disk and its monthly cost, sends a person whose
extra disk is turned down to the plans card, and opens the plans card when
the server answers `needs_approval`.

## Referrals and the free plan

The owner's rules are decisions 4 and 5 of `docs/plans/cloud-5/PLAN.md`. The
server enforces all of it (`referrals.ts`, `freePlan.ts`, migration `0026`);
clients only show it. Every route is behind the `/cloud` access gate except
the website's invite lookup.

**Earned hours.** `cloud_earned_hours` is append-only: one grant per
(account, reason, reference), never removed, never expiring. The account row
keeps `earned_granted_milli` (recomputed from the grants in the batch that
adds one) and `earned_used_milli` (what ended periods drew). Order of use in a
period: the plan's hours, then earned hours, then paid extra hours. A period
draws from earned hours only what it used past the plan's hours and past the
extra hours already billed or owed in it (`earnedDrawMilli` in `store.ts`),
so earned hours are never billed and nothing is both billed and drawn. The
draw is live while the period runs and settles into `earned_used_milli` in
the batch that ends the period (`startFreshPeriod`). `isOutOfHours` is true
only once the plan's hours and earned hours are both gone, so a free account
with earned hours keeps running, and the 0-hours stop, the wake refusal and
the 80/95% warnings (`allowancePercentUsed`) all follow. The extra-hours
meter bills `extraUsedMilli`. A failed payment's cut keeps what it drew
(`past_due_earned_milli`) and a paid invoice in the same period gives it back
with the hours it restores. The account read carries `earnedHours`
(`leftMilli`, `usedThisPeriodMilli`, `grantedMilli`); `hours` stays the
plan's own hours.

**One free plan per computer.** The desktop and a machine's brain send
`x-ade-computer` on every `/cloud` call: SHA-256 of
`ade-cloud-free-plan-computer-v1:` plus the OS machine id (`IOPlatformUUID`,
`MachineGuid`, `/etc/machine-id`, read by `hardwareAnchor.ts`), the same for
every account on the computer, or `unreadable`. An ADE Cloud computer sends
nothing (`isAdeCloudComputer`). The server keys it with an HMAC derived from
`CLOUD_CHAT_MASTER_KEY` (HKDF label `ade-cloud-free-plan-computer-hmac-v1`; a
logged dev constant without it) and keeps only that.
- A create or move, a copy or a wake on the free plan's rules claims the
  computer for the account (`cloud_free_plan_claims`, both keys unique). A
  read never claims, so opening the dashboard on a shared computer doesn't
  take its free plan.
- An account with no claim seen on a computer another account claimed is
  refused (`free_refused_at`): its free plan has 0 hours everywhere (CLI,
  phone, MCP) until it claims a computer of its own, which gives the hours
  back at once. Paid plans, earned hours and extra hours are untouched.
- An account holds one claim; once it has one, any other computer (a family
  one) changes nothing for it. A reinstall is the same OS id, so the same claim.
- An account used only from the phone or MCP sends no header, keeps the free
  plan unclaimed and is counted (`unclaimed_use`). A computer that can't read
  its id claims nothing and is counted (`id_unreadable`). A VM is its own
  computer. Paid accounts claim nothing.
- The account read carries `freePlan: { state: unclaimed | claimed | refused,
  sentence }`; the sentence is set only while refused on the free plan's rules.
- Account deletion keeps the claim (re-making an account must not give the
  computer's free hours again) and deletes the computers seen and the invite code.

**One free plan per GitHub account.** Migration `0035`, `freePlanGithub.ts`.
On a free plan, free hours need a connected GitHub account at least 30 days
old (`CLOUD_FREE_GITHUB_MIN_AGE_MS`). GitHub's `created_at` is read once from
`GET /user` (at connect, adopt, or on the first settle) into
`github_account_ages`; a failed read is retried with a backoff (5 minutes,
doubling to 6 hours), never refused or granted for good. `cloud_free_github_claims`
is unique on both the GitHub user id and the ADE account, like the computer
claim, so a GitHub account switch never feeds two free plans and a lost race
is refused. The settle runs with the computer claim (account read, creates,
launches) and only while the GitHub App is configured. A hold
(`free_github_hold`: `no_github`, `github_too_new`, `github_used`,
`github_checking`) keeps `included_milli` at 0; paid plans, earned and extra
hours are untouched. Accounts that used ADE Cloud before the rules are
`free_github_exempt` (they still claim their GitHub account). A too-new
GitHub account can start now with a card saved at no charge:
`POST /cloud/billing/free-unlock` opens a Stripe Checkout in setup mode (or
unlocks at once when a card is already on file, a past subscription counts);
the webhook checks the SetupIntent succeeded and sets
`free_card_unlocked_at`, kept if the card is removed later. The account read
carries `freePlan.github` (`state`, `oldEnoughAt`, `canUnlockWithCard`,
`githubLogin`, `sentence`); desktop (plan card and hero), CLI, the lane-start
refusal and the `ade-cloud` skill show it; the phone states it without the
card. PostHog `ade_cloud_free_plan` steps `github_*`, `card_unlock_started`,
`card_unlocked`.

**Abuse lines in the daily report.** `abuseSignals.ts`. A computer's brain
samples CPU once a minute in its keep-awake check (`cloudSustainedCpu.ts`)
and, after two hours at 85% or more with no chat turn or agent working, sends
`POST /cloud/instances/:id/cpu-report` (again every six hours). It reports on
itself, and a long build in a terminal looks the same, so the line is for a
person to look at. Sign-up bursts: the Clerk `user.created` client IP is
stored only as a Worker-keyed HMAC (`cloud_signup_ips`, kept 7 days), and 5
or more sign-ups from one address in any hour make a line
(`SIGNUP_BURST_PER_IP_HOUR`).

**Referrals.** One invite code per account (`cloud_invite_codes`, 8 characters
without 0/O/1/I/L), link `https://ade-app.dev/invite/<CODE>`, made at the
first summary. `POST /cloud/referrals/redeem { code }` takes the link, the
`ade://` link or the bare code, within 30 days of the friend's ADE account
(Clerk's `created_at`, kept as `account_created_at`), once and never changed
(`cloud_referrals` is keyed by the friend), never the account's own code, and
never a code whose owner lacks ADE Cloud access. Refusals answer
`invite_refused` with a `reason` (`CloudInviteRefusalReason`) and the sentence.
The reward, 20 hours to both, is paid when the friend's first chat runs on an
ADE Cloud computer: the server sees that as the first saved part of a chat
(`chats.ts`, written only by a computer the account owns), or at the redeem
when the friend already had one. It is one batch that moves the referral out
of `pending` under a fresh token, so two first chats at once pay once; the
referrer's grant counts its earlier grants in the same statement, so the cap
of 10 holds (the friend still gets 20). No reward, and `refused` with the
reason, when the two accounts were seen on one computer (`same_computer`) or
the friend was refused the free plan (`friend_computer_used`). The account
read carries `referral` (`CloudReferralSummary`); `GET /cloud/referrals` is the
same summary alone.

**Website.** `/invite/<CODE>` (`apps/web/src/app/pages/InvitePage.tsx`) asks
the public `GET /invites/<CODE>` (30 a minute per address, CORS open) for the
inviter's first name, answered only for an inviter with ADE Cloud access (else
404, the same as an unknown code). It shows every download option and
"Open in ADE" (`ade://invite/<CODE>`). The code never reaches analytics (the
screen is `invite`, the address `/invite`), replay masks the page's text, and
the ad pixel doesn't load there. Not linked from any page while ADE Cloud is hidden.

**Desktop, CLI, phone.** The account read carries the link and summary
(`CloudAccountState.referral`); `window.ade.cloud.redeemInvite(code)` enters a
code (account-level, no pin; `CloudInviteRedeemOutcome`). `ade://invite/<CODE>`
opens Settings › Account (`account.profile`) with `?invite=<CODE>` for the code
box, and the main log keeps it as `ade://invite/<redacted>`. The `cloud` actions
`referral` and `invite_redeem` (machine-scoped; `invite_redeem` is user-only, so
only the person's desktop and phone reach it: an agent, an ADE MCP app and the
CLI are refused). `ade cloud invite` prints the link and the summary and says
to enter a friend's invite in Settings › Account. Hidden with the rest of
`ade cloud` when access is off.

**Analytics and alerts.** Server PostHog events `ade_cloud_referral` (step
`code_entered` with result and reason, `reward_paid` with role and
`referrer_rewarded`, `reward_refused` with reason, `cap_reached`) and
`ade_cloud_free_plan` (step `claimed`, `restored`, `refused`, `id_unreadable`,
`unclaimed_use`, with platform). Never a code, a link, an email or another
account's id. Sentry issues tagged `area: cloud-referrals` or `cloud-free-plan`:
`cloud.free_plan.many_accounts_one_computer` (a refusal on a computer seen
with 4+ accounts), `cloud.referral.cap_reached_fast` (10 rewards within 7
days of the first), `cloud.referral.many_friends_one_computer` (3+ friends
seen on one computer), and the failures `cloud.free_plan.settle_failed`,
`cloud.referral.reward_failed`, `cloud.referral.summary_failed`,
`cloud.referral.clerk_read_failed`. The desktop's names (feature
`cloud_invite`) are in `productAnalyticsPolicy.ts`.

## Owner cost protection

The Worker estimates what ADE Cloud costs this month (`costReport.ts`, every
10 minutes, from awake time and disk at the provider's prices) and keeps it in
`cloud_settings.cost_mtd_micros`. When `cloud_settings.owner_cost_limit_usd`
is set and reached, creates, copies, moves and grows are refused (`owner_limit`)
and the owner gets one email a day; waking, sleeping and deleting still work.
With no limit set nothing is enforced, and the daily run logs that once. The
daily run also writes `cloud_account_days` (cost and income per account),
raises alarms (a paid account that costs more than it pays, a free one past
$3 a month, a day at twice the week's mean) and emails the owner the report.

Below the limit, the owner check also emails the owner once each time this
calendar month's estimate passes another $50 (`OWNER_COST_STEP_USD`): the step,
the estimate, the limit and how far away it is, and the three accounts that
cost the most this month. A jump over several steps sends one email, for the
highest. The step at or above the limit is left to the limit's own email.
`cloud_settings.owner_cost_step_alert` keeps the month and the last step
(`2026-11:150`); a new month starts again at $50. The check claims the step
with a conditional write before it sends, so two checks at once send one
email, and a send that fails gives the step back for the next check. The
limit's own email does the same: a failed send is tried at the next check,
not a day later.

## Stored data

Account vault items, scope `all`, kind `integration`: `cloud-budget` (agent
limits only; the name is historical), `cloud-claude-token` (the single Claude
item of older versions, adopted as `claude-pass/legacy`) and `cloud-key-<provider>`
(the saved ADE Cloud keys). A new cloud computer is made with no sign-in in its
env (only `ADE_MIN_VERSION`), so no sign-in value passes ADE's server or the
host in plain text: its brain signs in to the account and takes every sign-in
from the vault (`providerLoginApplyPass.ts` for the saved keys and carried
logins, `claudePassSync.ts` for the passes). The Worker holds every client to
that: the create route keeps only a version-shaped `ADE_MIN_VERSION` from the
client's env and drops the rest (`CLIENT_ENV` in `cloud/routes.ts`; the names,
never the values, are logged as `cloud.create_env_dropped`), so an older desktop
that still sends the saved keys and the Claude token no longer puts them on a new
computer. A computer made before that keeps its env until it is deleted; its
brain takes the variables out at the first apply. The old `cloud-ready` item is no longer read.
Kind `provider_login` holds the account's provider sign-ins: `<provider>/<origin>.<slot>`
(the origin is 12 hex of the computer's machine key) and the Claude passes,
`claude-pass/<12 hex>` (`claude-pass/legacy` for the item older versions saved).
The relay caps one such value at 16,000 characters. The account setting
`providerLogins.cloud` says which sign-in ADE Cloud uses for each provider, which
are off, and the Claude smart balance switch. Each computer keeps marks only,
never a token, in `<ADE home>/provider-logins/state.json` and `applied.json`,
and the use of each pass in `claude-pass-use.json`.
Sign-ins also come down to the person's own computers (`providerLoginApplyPass.ts`,
B14-9): an own computer with no sign-in of its own for a provider takes the one
the account uses (another computer's copy, never its own back), on the same
vault ticks. It never replaces a local sign-in (`provider_login.down_kept_local`,
logged once), never writes a saved key or an env variable, and stays off a place
the person signed out of there (`declined` in `applied.json`, or capture's
`signedOut` mark) until they sign in there again. Claude never comes down
(Claude's normal sign-in stays on each computer; ADE Cloud uses a pass), nor
does Copilot's GitHub CLI login. What the sync down wrote is replaced only
while every part of it (files, Pi's entry, Qwen's fields) is as ADE wrote it and
no sign-in made here sits there; when the account stops using it (switched off
for ADE Cloud, removed, another pick) it stays, as with the off switch for all,
and leaves on ADE sign-out. A sign-out here keeps the sync down off that
place from the first pass that sees it (capture's `absentSince`), so this
computer's own copy still leaves the account. The account's cards show one card
per account for copies from several computers ("From 3 computers"), and the
pick of one copy uses the freshest usable copy of the same account
(`cloudPlacePicks`). When a computer signs out of a sign-in (for some providers
that also revokes the token its copy holds), its capture takes its copy out of
the account after two passes 60 s apart; just before, a pick that names that
copy moves to the freshest other live copy of the same account
(`sameAccountCopyFor`, logged `provider_login.pick_moved`), so ADE Cloud stays on
the account the person picked instead of the newest copy of any account. With
no other copy of that account the pick stays (the same sign-in made there again
comes back under the same key), and the provider's card says the sign-in was
signed out on the computer it came from (T14 when nothing else is there, T15
beside the other account's sign-in ADE Cloud uses meanwhile). A computer that
signs out while ADE isn't running there takes its copy out at its next start. The account is the email (`accountIdentityOf`), except
Codex: email and workspace id together, since one email can have several
ChatGPT workspaces.
Before a lane's computer is made, the launch's start runs `cloudGitPreflight`
(`cloudGitCredential.ts`, keys in `github/accountGithubTokenItem.ts`): it checks
the account for a GitHub sign-in git can use (`integration/github`, a pasted
token; `integration/github-cli`, a `gh` login copied to the account, which only
PR #2186 writes, so today only a pasted token answers). A private repository
with none is refused with the way out, a public one goes on, and no answer from
GitHub goes on with a warning on the launch card (`cloud.warning` on the
snapshot). `window.ade.cloud.gitPreflight` answers the same check; no renderer
surface calls it yet.
The clone passes its auth header through Git's config environment, so no token
is left in the clone's `.git/config`. On an ADE Cloud computer only, the clone's
local config also gets an empty `credential.https://github.com.helper` and then
`!'<launcher>' git credential`. The launcher is the ADE the brain runs (the
entrypoint picks the newer of the image's and the ADE home's), else the ADE
home's `bin/ade`, else the image's `/usr/local/bin/ade`; none is recorded when
none exists, and a half-written entry is undone. So a plain `git push`
in a terminal there signs in with ADE's token while no other helper runs or
stores it. A person's own computer records no helper: ADE's own fetch and push
pass the token per command, and the person's git setup works as in any
repository. A clone sent to another computer with this computer's one-shot
header stores nothing there; when that computer has no GitHub sign-in of its
own, the clone's answer says so (`githubSignInMissing`) and the window warns
that fetch and push there won't sign in until GitHub is connected on it.
Machine metadata keys are `ade_*` (`ade_machine_key`, `ade_request_id`,
`ade_made_by_chat`, `ade_disk_full` and `ade_disk_full_reason`; a copy drops the old ready-machine keys `ade_ready*`,
and the lane keys `ade_lane_id`, `ade_lane_name`, `ade_project_origin` in
`cloudLaneLaunch.ts`), plus `created_by: ade`.

A create or copy that repeats a request id this account already used gets the
computer that request made, with status 200, before any hours or limit check.
A reservation with no computer yet answers 409 `create_in_progress` until the
provider's list shows the computer by its tag. A reservation older than 15
minutes with no computer is released, and a fresh create goes ahead. The
reserve insert refuses a second live row for the same account and request id,
so two requests at once make one computer. Another account's request id is
still refused.

The desktop keeps one record per lane launch in
`<userData>/cloud-lane-launches/<launchId>.json` until the launch is finished
and its cleanup is done. A brain keeps its own in
`<machine ADE folder>/cloud-lane-launches/<launchId>.json`.

## From the CLI and agents

### The status read

`cloud.status` (`ade cloud status`, and `ade cloud` alone) answers the whole
account in one call: one list of the computers and one account read, so it
wakes nothing and spends nothing. It never throws for "no ADE Cloud": the
answer says why in `canStartLane`.

- `canStartLane {ok, reason, code}`: whether a new lane can start now. The
  reason is the sentence the composer's label shows (`cloudLaneStartBlock` in
  `shared/cloudLaneLaunch.ts`: out of hours, all computers in use, disk
  full), or the access sentence (`NO_PROVIDER_SENTENCE` in `cloudAccess.ts`:
  not signed in, not available), or that ADE couldn't read the plan and hours.
- `plan`, `hours` (left, included, used, reset date, extra hours), `disk`,
  `computers` (in use, awake, the most at once).
- `lanes`: every computer, lanes first, with the lane name and project origin
  from its metadata (`lane: null` for a computer made for no lane), the lane
  size, the catalog's hours rate, its state, its disk size and a full-disk
  sentence, and `deletesAt` for one unused for long. ADE Cloud doesn't report
  last use, so `lastUsedAt` is null.
- `sizes` (`cloudTiers(catalog)`) and `defaultSize`: the account setting
  `cloudDefaultTier` (scope `all`), read from this machine's copy of the
  account settings; Small when nothing is saved; null when this ADE has no
  settings store.
- `agents`: the agent limits, the new computers agents started today (the
  count the daily limit uses), how many are left, and the sizes agents
  nobody watches may pick alone.

`list`, `hours` and `limits` stay as narrow views of the same reads. The text
view puts "No new lane on ADE Cloud now: <reason>" first when the answer is
no. `cloud.status` is a read for ADE MCP read access, the phone
(`cloud.read`) and a brain with no project open.

### A new lane

`ade chat create --machine cloud --size <small|medium|large|xlarge> --prompt "…"`
makes one new computer for one new lane, gets the repository there, and starts
the chat there. `--size` is optional: without it, the brain uses the size the
person saved for new lanes (`CLOUD_DEFAULT_TIER_SETTING_KEY`), else Small.
`ade chat launch --machine cloud`
takes the same flags with `chat launch`'s lane flags (`--from`, `--lane-name`,
`--existing-branch`). The lane starts from the pushed copy of its branch:
`--on uncommitted` and `--on local` are refused, and so are `--notify-url`,
`--lane`, `--project` and `--clone`. A Linear issue goes as
`laneConfig.linearIssue` and the computer binds it to the new lane; it must be
the whole issue (`--linear-issue-json`), because the computer has no Linear
lookup for a bare id.

`ade lanes create --machine cloud [--size …] [--launch-id <id>] --name <n>`
makes the lane alone, with no chat: a launch of kind `lane`. Its stages are
computer, join, clone, fetch, checkout and environment, with no agent stage,
and it completes when the environment stage ends. It takes `--from`,
`--branch-name`, `--existing-branch` and `--template`, and a whole Linear
issue for a new branch. It refuses `--description` and `--no-template` for
now. The id, replay, one-lane, cancel and delete rules are the same as for a
chat launch.

What a cloud lane is linked to, as a local lane would be: the computer's
brain applies `laneConfig.linearIssue`, `githubIssue` and `jiraIssue` to a new
lane (the Linear, GitHub and Jira batch sends them), and links an
existing-branch lane to `laneConfig.pullRequestUrl` (a lane from a PR's
branch) with `prService.linkToLane` after the checkout. A failed PR link is a
warning on the checkout stage, not a failed launch. An older computer brain
ignores these fields.

**The CTO.** `createLane` and `spawnChat` take `machine: "cloud"` and `size`.
They call `cloud.lane_launch` on the CTO's home brain under the CTO chat's
identity, so the approval card shows in the CTO chat. They return when the
launch starts, with its id, at most after the home brain's 180 s call limit.

**Automations.** A rule can set `execution.cloud: { sizeId? }` ("Run on ADE
Cloud" under "Runs on" in the builder). The machine that runs the rule still
watches the trigger and keeps the history. Each run calls `cloud.lane_launch`
with the run id as the launch id and the approval
`{ by: "agent", chatSessionId: null, automation: true }`, so the agent limits
answer (largest size, new computers a day), never the person. An agent rule
starts a chat launch (its prompt, model and permission); a rule of built-in
steps makes the lane alone, and then runs its ADE action steps here. The run
waits up to 30 minutes for the chat to start or the lane to be ready. Rules
on ADE Cloud need `laneMode` "create" or "pr-branch", no bound chat, and no
step that works in a lane here (`automationCloudProblem`). A safe test run
stays here. Every `ade-action` step that calls the `cloud` domain gets the
same automation approval, whatever its args say.

**Renames.** A cloud computer's brain writes a lane's new name to its
computer's `ade_lane_name` metadata when that lane is the one the computer was
made for (`cloudLaneNameSync.ts`). The write goes through the account server
and wakes nothing.

A CLI session can also be the first session in a new ADE Cloud lane, but only
from the app (pick CLI, then Run on: ADE Cloud). The computer's brain parks the
launch at `awaiting-client`. The launching window then starts the tracked CLI
session on the new computer through `snapshot.cloud.binding`. The brain's
`cloud.lane_launch` refuses kind `cli`, because a brain has no window to start
a terminal in.

- **Who runs it.** This computer's brain (`ade serve`), not the CLI process:
  the brain holds the account and the provider key. The CLI calls
  `cloud.lane_launch` and then reads `cloud.lane_launch_status` every 2 s,
  printing the card's own status line on stderr. The core is the desktop's
  (`cloudLaneLaunchService.ts`); `cloudLaneLaunchBrainHost.ts` fills its deps
  in the brain. One host per process; only a process that set the machine
  transport (`ade serve`) builds one.
- **How it reaches the new computer.** Through the brain's agent machine
  bridge, by account machine key, the path `--machine <name>` takes: the
  connect probe is `projects.list`, the clone is `machines.cloneForAgent` (the
  computer's own Git sign-in), and the hand-off is `chat.startLaunch` there.
  The bridge has no event stream, so the brain reads the computer's
  `chat.listLaunches` every 5 s until the launch ends.
- **Asking first.** `lane_launch` and `lane_launch_cancel` get the RPC
  server's caller stamp (`CLOUD_APPROVED_ACTIONS`), and `lane_launch` asks
  with the same `approve()` as `cloud.create`: a card in an attended chat; in a
  full-auto chat or an automation, the agent limits (daily count, largest
  size, hours). A chatless terminal is an agent with no chat, so it is
  refused with the same sentence as `ade cloud create`. A new launch counts
  once toward the daily limit, and the computer carries `ade_made_by_chat`.
  The start checks (`cloudLaneLaunchStartProblem`) run before the question,
  then the account's (`cloudLaneStartBlock`: hours, computers, disk), so an
  agent and an ADE MCP app get the status read's sentence before any card or
  spend. `create` and `copy` make the same account check. An account ADE
  couldn't read goes on: the server decides, and an unattended agent is still
  refused for unknown hours.
- **A person at a plain terminal.** Refused, with "Start it in the ADE app
  (pick ADE Cloud under Run on in a new chat), or ask for it in an ADE chat,
  where ADE can ask you." The RPC server knows a person only by the desktop's
  client name (`mayUseUserOnlyActions`) or the trusted CTO thread. A chatless
  `ade` at any role looks exactly like an agent's shell (the same caller id,
  role and environment), so no signal there can prove a person.
- **ADE MCP.** An outside app on an ADE MCP connection with write access is
  an unattended agent: the RPC server stamps `viaAdeMcp` on its approval only
  when the caller claims the connection, runs with the operator role, and its
  process is one the MCP runner started and still runs
  (`isRunningRemoteRun`). It is answered like a full-auto chat, within the
  agent limits, and it counts toward the daily limit. A resize, a delete, a
  move, a cancel of a lane launch and loosening the limits always need the
  person. It has no chat, so ADE's line about its answer goes to the log. A
  read-only connection is a chatless agent and is refused.
- **The daily limit.** When agents have already started the day's number of
  new computers, the refusal reads "your agents hit today's limit of N new
  computers a day. Change it in Settings › Integrations › ADE Cloud › What
  agents may do › New computers a day." A person is never counted.
- **The join.** When a desktop app is attached to the brain, the brain
  sends it the computer's sign-in code (`cloud.approveWindow` over the
  desktop bridge, `desktopApprovalWindow` in `cloudLaneLaunchBrainHost.ts`;
  cancelling the launch closes it with `cloud.closeApprovalWindow`). The
  desktop asks its own account service for the one-time ticket
  (`requestCloudApprovalTicket`), so its window opens only what that service
  gave it, and the window signs the computer in with no click. At a step
  only a person can take (a consent screen, or no ticket to mint) the window
  ends at once with `needs_person` instead of waiting on a screen the person
  may not be at, and the brain sends the link right away: the same code when
  it was never claimed, else a fresh one. If the window can't finish for
  another reason (the desktop left or closed it, or is too old to have it),
  the brain waits the moment a landed approval needs, then sends a fresh
  code's link. With no desktop, the brain approves itself only for an
  unattended yes with a headless browser here (a cloud computer); otherwise
  the agent's chat gets a `cloud_join_approval` card (`buildCloudJoinApprovalCard`
  in `shared/cloudLaneLife.ts`) whose Approve opens the account service's
  own `/device?user_code=…` page in this computer's ADE browser, where the
  person confirms the computer by name; the card turns into "joined" or "no
  longer waits" when the join ends. Only the brain posts it (agents can't
  post cards), and a client that doesn't know the card shows its text, link
  included. The CLI prints the link (stderr, and `approvalUrl` in the
  status). A join that fails puts the computer to sleep (`restWhileFailed`),
  and the server's no-check-in sleep catches one ADE never looked at again.
  `ade cloud status` shows a computer that never signed in as "not joined to
  ADE yet", never "up to date".
- **Why agent launches don't use the server launcher yet.** The server
  launcher (below) needs no approval on this machine at all, but it runs a
  different stage model (the computer runs its own launch and posts its
  stages) and hasn't been checked live on an agent's path. Moving agent and
  CLI launches to it is a follow-up once a beta with it is in the cloud
  template. A computer's ADE answers before its
  network is always up, so the sign-in start is retried: `ade login`
  (device mode) keeps trying an account directory it can't reach, that times
  out or answers without JSON for 45 s, and says which it was; the launcher
  starts the sign-in again for up to a minute while the computer's reason is
  one of those (`startCloudBoxSignInWhenReady`, for computers made from an
  older image). A sign-in that still didn't start puts the computer's own
  reason (the last line of `cloud-sign-in.log` that says something, without
  colour codes, tokens, links or ids: `cloudSignInFailureReason`) on the join
  step and in Copy details.
- **One computer per id.** The launch id is printed first (stderr, `--json`
  too). The same `--launch-id` again answers that launch, and a failed one
  goes on from its failed step; `--prompt` is not needed again (the launch
  keeps it), and an id this ADE doesn't hold asks for `--prompt`. A step
  resumed after the brain restarted keeps its first start time, and the join
  publishes only when what it shows changes; the server returns the same computer for a
  repeated request id. Ctrl-C stops only the waiting: the launch goes on in
  the brain, which resumes saved records 5 s after it starts.
  `ade chat launch-status <id> --machine cloud` reads it, and
  `ade chat launch-cancel <id> --machine cloud` stops it and deletes its
  computer (only the chat that started it, or the person).
- **Output.** Text: the launch view with the lane, the chat and
  `ADE Cloud · <computer>`. `--json`: `{ok, launchId, phase, laneId, laneName,
  sessionId, machine {name, instanceId, machineKey}, approvalUrl, launch}`. A
  failed or cancelled launch exits non-zero with the card's sentence.

### A new lane with no computer of your own (the server launcher)

A person with a computer launches from it, as above. A caller with none (the
web client, the phone, an automation on ADE Cloud) starts the lane through
ADE's server, and the new computer runs its own launch
(`apps/account-directory/src/cloud/launches.ts`, migration `0029`; plan:
`docs/plans/cloud-6/c6-c8-launcher-spec.md`).

- **Start.** Files first (`PUT /cloud/launches/:id/files/:fileId`, at most 10,
  25 MB each, kept in R2 under `launches/<user>/<launch>/`), then
  `POST /cloud/launches` with `CloudServerLaunchRequest`. The launch id is the
  create's request id: the same id answers the same launch and never makes a
  second computer. The create is the one create path (`createComputer` in
  `routes.ts`): the same limits, billing and metadata, plus `ade_launch_id`.
- **Join.** The computer's env carries `ADE_LAUNCH_ID` and an
  `ADE_LAUNCH_JOIN` code. The code is an HMAC under the Worker secret
  `CLOUD_LAUNCH_JOIN_KEY` of the launch id and a salt the row keeps from the
  first start, so a start retried after a lost create answer puts the same
  code in the computer the create's replay adopts; the server keeps only the
  salt and the code's SHA-256. At brain start with no account session
  (`apps/ade-cli/src/services/account/cloudBootLaunch.ts`) the brain drops
  both from its env, starts ADE's device sign-in and calls
  `POST /cloud/launches/:id/join` with no account token. The code is valid
  30 minutes and is the only proof: `x-ade-instance` and the provider's
  metadata must name the launch's computer, but they name it, they don't
  prove the caller is it. The first join spends the code; while the launch
  is still `joining` or `needs_approval` and the device sign-in it named was
  not approved, it may join again (a brain that restarted mid-sign-in), at
  most 5 times, each with a fresh device sign-in. A join that lands while the
  server still makes the computer (a lost create answer, before a retried
  start adopts it) gets a retryable `409 join_not_ready`, and the brain asks
  again with a backoff for up to 10 minutes.
  The answer is a sign-in link for the launch's account only, opened in the
  computer's headless Chromium (`cloudHeadlessApproval.ts`, now in
  `apps/ade-cli`). When the page stops on a confirm step, the launch shows
  `needs_approval` with the device page and code, and the caller offers one
  Approve tap in the person's own browser. The computer waits no longer than
  the join window (`joinExpiresAt` in the join's answer), the minute cron's
  no-check-in sleep leaves it awake meanwhile, and a launch still joining
  when the window closes reads as `failed` ("The new computer couldn't sign
  in.").
- **Run.** Signed in, the computer reads the facts (`GET /cloud/launches/:id`),
  sets the repository up with its own Git sign-in, and runs `chat.startLaunch`
  in its own brain with the same launch and lane ids. It posts a stage
  update only when a stage changes (`PUT .../stages`), one after another; the
  last one is retried with a backoff, and the next boot sends it when it still
  couldn't land. A `done` launch takes no other state. A launch stopped in the computer's own
  ADE reads as `failed` ("The launch was stopped on the computer."). The
  caller reads the record while it watches. A cancel before the agent starts
  deletes the computer the row holds after the cancel lands, and a cancel
  again retries a delete that failed. The minute cron deletes a record a
  week after its start (a draft after a day), with all its files.
- **Git credential.** Before it makes the computer, `POST /cloud/launches`
  reads the account vault through the `ACTIVITY_RELAY` binding with the
  caller's own token (`GET /attention/account/vault?scope=all`, the
  `integration/github` and `integration/github-cli` items the desktop's
  `cloudGitCredential.ts` reads; `accountVault.ts`). With none, it asks
  GitHub's API without a token whether the repository is public; a private
  one is refused (`git_credential_missing`) with the "Connect GitHub"
  sentence. A vault or GitHub that doesn't answer goes on, with a log line.
  An automation's run (no token) uses what its rule's registration read.

### Automations whose home is ADE Cloud (C9)

A rule's home can be ADE Cloud itself (`automations/README.md`, "Runs on
ADE Cloud"). The server keeps the rule (`cloud_automations`, migration 0030,
`apps/account-directory/src/cloud/automations.ts`) and watches its trigger:

- **Registration.** `PUT /cloud/automations/:ruleId` from a brain (the one
  that saved the home, or any that sees a version the server lacks; the same
  version writes nothing, but re-reads the vault). `DELETE` (with
  `?through=<version>`, so a newer save stays) when the home leaves ADE Cloud
  or the rule is deleted. Every registration reads the agent limits and the
  git credential from the vault with the brain's token and keeps them for the
  rule's runs; limits never read refuse unattended spend. Only a newer
  version turns a storm-paused rule back on.
- **Schedules.** The rule's cron in its own IANA zone (`automationSchedule.ts`);
  the next fire is kept in UTC and the minute cron reads due rules and open
  runs in one indexed statement. A time the clocks skip doesn't fire that
  day; a time they pass twice fires once. A run missed by an hour or more is
  recorded as skipped, not run late.
- **Webhooks.** The webhook relay forwards a cloud rule's deliveries to
  `POST /cloud/automations/:ruleId/deliveries/:userId` (no account token), signed
  with HMAC-SHA256 over `<timestamp>.<body>` with the hook's key. The key is
  derived from the directory's own `CLOUD_CHAT_MASTER_KEY` and a per-hook salt,
  so the directory's D1 holds no key (the relay keeps the derived key to sign
  with). The relay reaches each directory over its own service binding, picked
  by the forward URL's origin. A hook id is unique per account; the signature
  says which account's rule a delivery is for. A repeat of a delivery is the
  same run; 410 tells the relay the hook no longer forwards here (logged);
  400, 413 and a refused signature drop that delivery so the rest go on. A
  delivery during the handover from a computer waits in the rule's queue
  until it ends. The prompt's `{{trigger.body.*}}` fields are read from the
  whole body when it comes, and `{{date}}`/`{{time}}` in the rule's zone.
- **Runs.** Each run is a server launch (launch id = run id, `madeBy:
  automation`): the agent limits first (unattended spend, largest size, new
  computers a day), then the launcher's own checks. One run at a time per
  rule, one waiting, the rest recorded as skipped (runs of the last 25 hours
  are never pruned, so the counts hold); past the rule's runs an hour
  (default 6) the rule pauses. ADE Cloud briefly unable to make computers (a
  503) leaves the run starting for up to an hour. A chat that stops for input
  ends the run as failed ("The agent asked for input"). The computer reports the `run` stage when
  the chat ends, and the cron then saves its chats, pushes its work and
  deletes it, keeping the lane as a lane without a computer (unless the rule
  keeps its computer). A run that can't start fails before anything is made;
  the person hears through a push (the push relay's
  `POST /directory/accounts/<id>/notify`, directory secret) and, at most once a
  day per rule, an email. `GET /cloud/automations?origin=` answers each rule
  with its last runs; a brain reads it when rules are listed, at most once a
  minute.

Provider sign-ins on a cloud computer from the phone or the web:
`POST /cloud/instances/:id/sign-ins { provider }` runs
`ade providers sign-in <provider> --remote --json` there over exec, and
`.../sign-ins/:job` and `.../code` read it and pass a pasted code (on stdin).
The login runners live in the computer's brain. Which providers can do this
is `CLOUD_REMOTE_SIGN_IN` in `contract.ts`; a `none` row is refused with its
reason. `POST /cloud/projects/computers/delete { origin, dryRun: true }`
lists the project's computers (at most 50, `truncated` when there are more);
`{ origin, instanceIds }` from that list starts a job the minute cron runs on
the named computers that still belong to the project and aren't already in
another job (checked in the same write, so two jobs never take one
computer; the answer's `accepted` and `skipped` say which it took): wake,
push every lane's work, delete; a computer whose push failed is kept with why. The plan cleanup and this job share one push run
(`pushAllWork` in `planCleanup.ts`). The typed client for all of these is
`apps/desktop/src/shared/cloudApiClient.ts` (fetch only). Every `/cloud/*`
route answers a browser only on `WEB_CLIENT_ORIGIN`.

### The life of a lane's computer

The main process runs these (`cloudLaneLife.ts`, `IPC.cloudLaneLifeCall`).
Each call is account level: it names a computer of the account, never a pin.

- **Work check.** `ade cloud push-work --check --json` on the computer reads
  which lanes have uncommitted changes or commits that no remote has
  (`laneService.readUnsavedWork`, read now, uncached; the primary lane is
  measured against the remotes, not its own base). A lane whose state can't be
  read reports `failed`, never `clean`. It changes nothing and uses the free
  `push_work` wake. Both the check and a push first run one
  `git fetch --all --prune` per project (60 s), so a branch force-pushed or
  deleted on GitHub doesn't leave a stale tracking ref that hides unpushed
  commits. Commits whose changes are all in the remote's base branch already
  (`git merge-tree` of the lane into it changes nothing) count as saved, so a
  branch squash-merged and deleted on GitHub is not pushed back; one deleted
  without being merged reads as unsaved and is pushed again. A fetch that fails marks that
  project's lanes `failed`: the computer is kept, and delete says ADE couldn't
  read the work.
- **Delete lane.** The computer goes, and the lane with it. ADE never refuses
  it. The work check runs first unless the person was already warned, and the
  answer says whether work was only on the computer. Saved chats stay.
- **Keep the lane on a fresh computer.** ADE pushes the work first. A push
  that can't save everything keeps the computer, and freeing is refused while
  the agent works ("Stop it or wait, then free the computer"). `ade cloud
  work-state` lists the lanes with uncommitted or unpushed work, the same check
  as `ade cloud push-work --check`, and pushes nothing. Then the server deletes the
  computer with `keepLane` and keeps a lane without a computer
  (`cloud_lanes_without_computer`, migration 0021). The idle cleanup keeps the
  lane the same way. A new computer made for the same lane id ends the row.
- **Tier change.** In place when the kind stays (resize), else a move to the
  other kind. The provider refuses a resize of a sleeping computer, so the
  server's `/resize` wakes it first (under the same wake rules, and metered
  from the wake) for every caller: a size change, a disk grow, the dashboard. It starts when the agent is idle (the computer's
  `keep-awake.json` shows no agent work) or now (`ade cloud prepare-stop`
  stops the turn). Its steps go to every window (`IPC.cloudLaneJobEvent`).
  The lane is Online only when ADE on the computer answers and has the
  lane's project. A moved computer gets the lane's name and lane metadata.
- **An agent asks.** `ade cloud resize --request --size large --reason "…"`
  (`cloud.tier_request`) posts a `cloud_tier_request` card in the agent's
  chat. It changes nothing; the person confirms on the card. An agent with
  nobody there (a full-auto chat, an automation, an ADE MCP app) cannot change
  a size at all: `cloud.resize` is declined for it.
- **Push this branch?** `lane.cloudStartBranch` and `lane.pushCloudStartBranch`
  run on the machine that has the project (pinned), before a cloud launch.
- **Files on the first message** go to the clone on the new computer at the
  hand-off (`uploadAttachment`), once per launch.
- **Cancel** forgets this app's saved connection to the deleted computer.

The launch writes the lane's branch into the computer's metadata
(`ade_lane_branch`) once the brain names it.

## Guidance for agents

One text serves every agent: `apps/desktop/resources/agent-skills/ade-cloud/SKILL.md`.
ADE's own agents load it as the `ade-cloud` skill. ADE MCP serves bundled
skills as prompts, so outside apps get the same text as the `ade-cloud`
prompt; the server's instructions say to run `cloud status` and follow that
prompt, and the `ade-mcp-client` skill has the three-step version. Both are
shown only to an account with ADE Cloud access (`setAdeCloudSkillVisible`).
The skill states, in order: what ADE Cloud is, read the status first and stop
on a no, how to start a lane (size, approval card, daily limit, the terminal
rule), how to follow, retry and cancel, what each refusal means, cleanup
before any delete, and what an agent must never do. Rates are never in the
text: an agent reads them from the status.

## The machine template

`infra/ade-cloud/` holds the image every machine starts from. It sets
`ADE_HOST_INSTANCE_ID=cloud:<hostname>` and `ADE_CLOUD_INSTANCE_ID`, the only
variables the rest of ADE reads to know it runs on a cloud machine. ADE does
not build the template from the app: every release builds it
(`.github/workflows/cloud-template.yml`), tests the build on a real computer
and moves the image of the tag's update channel only on a pass
(`infra/ade-cloud/promote-template.mjs`). The server creates from the pinned
image of the computer's channel; the client picks only the channel. "Update
this computer" moves one computer to it (`updateInstance`).
On first boot a new machine installs the ADE version of the app that made it,
when the image's ADE is older.

Agent programs go to the system layer first, not the person's disk.
`/home/node` is the billed disk; everything else is the provider's unbilled
system layer, which an image update resets. The image bakes the agents its own
ADE pins (by default Codex, Claude Code and OpenCode) read-only into
`/opt/ade-tools`, so a lane's first turn on them downloads nothing. Any other
agent, or a newer pin after `ade brain update`, downloads on its first use into
`/var/cache/ade/tools` on the system layer. Each time one installs there, the
folder (package caches for npm, pip and yarn live there too) is brought within
about 7 GB and within the system layer's free space: old agent versions go
first, least recently used first, then the package caches; an agent that ran in
the last day, or that runs now, keeps its copy. Between installs nothing checks
the folder. Only what cannot fit goes to `/home/node/.ade/tools`. A computer
made before the agents were baked keeps the copies it already has in
`/home/node/.ade/tools`, except those the image now bakes at the same version:
collection removes those duplicates. The brain reads all of this from the image's
environment (`ADE_TOOLS_BAKED_ROOTS`, `ADE_SYSTEM_CACHE_ROOT`,
`ADE_SYSTEM_CACHE_BUDGET_BYTES`), and with `ADE_TOOLS_PREFETCH=used` it fetches
at startup only agents this computer ran, never every agent whose sign-in was
copied over. A status read, a model list or a sign-in check never downloads an
agent on any machine: only a turn (or the person's Download) does. See
[Agent tools cache](../onboarding-and-settings/agent-tools-cache.md#cache-layout-on-disk).

## Updates

Cloud computers update themselves: image and ADE together, onto their
channel's image, only when nothing runs on them. The server's rules are in
`apps/account-directory/src/cloud/updates.ts`.

- **Channels.** The server keeps one image per channel in `cloud_settings`:
  `template_version_stable` and `template_version_beta` (`template_version` is
  the older single setting and the fallback; a Stable move writes both). A
  computer follows the channel of the app that made it: the create sends
  `channel` from the machine's update track (`~/.ade/update-track.json`, else
  the build's track; an Alpha build makes Beta computers). A copy follows its
  original. The column is `cloud_computers.channel`.
- **When.** Idle: when the keep-awake loop
  (`apps/ade-cli/src/services/power/cloudKeepAwake.ts`) would sleep the
  computer, it first asks `GET /cloud/instances/:id/update-check`. When the
  computer is behind, it calls `POST .../update` with
  `{ reason: "idle", computerIdle: true }` instead of sleeping, and the new
  brain sleeps it once idle again. Asleep: the minute cron updates up to three
  computers per tick that slept 10 minutes or more and are behind, unless the
  account is out of hours, over the plan's disk, or the computer is in cold
  storage or a move. Never while work runs.
- **Only a tested image.** Automatic updates go only to the image a passed
  template test named in `auto_update_<channel>` (`off` stops them). A
  person's "Update this computer" (`ade cloud update`) goes to the channel's
  image whatever it says, and one update runs at a time (`409 update_in_progress`).
- **Proof and rollback.** Every brain start sends
  `POST /cloud/instances/:id/booted { adeVersion }`, which settles a waiting
  update (`updated_at`). An automatic update with no report 15 minutes after
  the computer came up has failed: the cron moves it back once to
  `previous_template`, sets `update_state = 'failed'`, `update_error` and
  `update_failed_template`, and never tries that image on its own again (a
  newer image clears it). A rollback that fails or never reports stays failed
  and is never retried on its own. An update to an image older than boot
  reports is settled after 15 minutes, not rolled back.
- **Hours.** The minutes awake for an automatic update or a rollback are free.
  They use the push-work wake's free window (`free_wake_started_at`,
  `free_wake_until`, `awake_since` held at its end), which settling and the
  daily reconcile already leave out. The boot report closes the window, so
  hours count from then on; a computer the cron woke only for the update
  sleeps at its first idle check. Asleep, the update does not reset the
  idle cleanup's clock. A person's update is metered as before.
- **What people see.** Where another machine has an Update button (Settings
  "Update other machines", the General page rows, the Machines list), a cloud
  computer shows one line: "Updates itself when idle", "Updating…", or
  "Update failed: <why>." with Retry (the person's update). `ade cloud status`
  and the `cloud.status` action give each computer's `update {image, channel,
  target, state, error}`. Each update and rollback writes a row to
  `cloud_power_log` (reason `update_manual`, `update_idle`, `update_asleep`,
  `update_rollback`).

## Rules on a cloud computer

`adeCloud/cloudComputerRules.ts` holds the check (`isAdeCloudComputer`,
the `ADE_CLOUD_INSTANCE_ID` variable) and every sentence of these rules. The
keep-awake code reads the same function. A normal computer never meets these
rules.

- **One lane per cloud computer, across every project on it.** An archived
  lane counts; a primary lane never does. `laneService.ts` checks at every
  place a lane row comes to exist (create, import, adoption of a worktree
  found on disk), with the computer-wide count and the lock against two
  creates at once in `cloudComputerLaneHold.ts`. On Linux the machine
  template's own file also marks the computer, so a process with a filtered
  environment meets the rule too. The refusal is `CloudComputerLaneLimitError`
  (an expected `user` error). For an active lane: "This ADE Cloud computer
  already holds a lane, and each cloud computer holds one. Start a new lane on
  ADE Cloud instead: it gets its own computer." For an archived one: "This
  ADE Cloud computer belongs to the archived lane "<name>". Restore that lane
  to use this computer again, or start a new lane on ADE Cloud: it gets its
  own computer." A chat launch and the destination check of a hand-off give
  the same sentence before any work starts. The launch's own lane, a chat
  moved or copied to a new computer, an unarchive, and a restore when the
  computer holds no other lane are not refused. A computer from the older
  flow that holds several lanes keeps them all and cannot get one more. See
  [One lane per ADE Cloud computer](../lanes/README.md#one-lane-per-ade-cloud-computer).
- **Codex runs with full access.** A Codex chat there runs with approval
  `never` and the `danger-full-access` sandbox, set on the chat's own fields at
  create, load, every update and every thread start, so the mode the chat
  shows is the mode that runs. Plan (a read-only sandbox, also every side
  chat), a chat an agent started or spawned (the permission ceiling), a
  recovery chat (it copies the mode of the chat it continues), and a chat
  with a host permission policy keep their mode. An agent's update is
  judged at full access, so an agent can never lift a chat past its own level
  this way. Other providers are unchanged.

## Sleep and busy rules

One busy list, `decideCloudBusy` in `apps/ade-cli/src/services/power/cloudKeepAwake.ts`,
fed from each runtime (`readRuntimeBusyFacts`). Unknown is busy.

- Busy: a running chat turn, a real running command, an agent CLI actually working,
  setup, a new-lane launch still setting up (`lane_setup`: fetch, checkout,
  environment), first clone, move, copy, a lane launch between join and its
  hand-off (`lane_launch`, a 30-minute hold the desktop sets and releases)
  (holds in `$ADE_HOME/cloud/holds/*.json`), someone
  watching a tool (`work_tools.noteWatching`, once a minute, from the desktop, while
  its window is in front and the person moved in the last 3 minutes).
- A hold also counts as use when it ends (`holdCloudWork` in `cli.ts`): the checks
  run once a minute, so a clone that fits between two of them would leave no trace.
  A clone asked for by another machine (`projects.clone`, `machines.cloneForAgent`)
  runs with no project open and takes the same hold. A second clone into a folder
  whose clone still runs joins it (`cloneRepository` in `projectScaffoldService.ts`,
  for every clone path), and for these two requests a folder that already holds a
  complete checkout of the same repository is the answer, with no clone.
- Idle: a shell at its prompt, an agent CLI at its prompt or asking (`waiting-input`),
  a chat waiting on approval, and a command or turn with no output and no touch for 60 minutes.
- A shell's prompt state is read from `/proc` (`readPtyForeground` in `ptyService.ts`):
  tpgid on a normal kernel, the shell's children on gVisor, whose `/proc` carries no
  tty fields. Output-based `runtimeState` reads `idle` under a quiet command, so it isn't used for plain shells.
- Three minutes after the last work, the brain calls `POST /cloud/instances/:id/idle`
  with its account token, and any check after that counts as a fresh wake. The provider's
  own 5-minute timer stays on as the backstop.
- The app's own writes (opening a view, window focus: `isBackgroundAdeWrite`) neither wake
  a sleeping computer nor keep one awake.
- A sleeping computer's relay tunnel looks open until a call times out. When a call
  to a cloud computer fails that way, the desktop asks once whether it is asleep
  (`asleepForUse` in `remoteConnectionService.ts`, filled by `registerCloudIpc`; the questions and the list of resting computers are in `remoteCloudAsleepChecks.ts`). If
  so the link closes and the status goes to idle with no error, so the lists show
  its saved chats and send it no reads. The same question follows a dropped link
  and a failed redial, and is asked again 45 s and 90 s later: a computer closes
  its link up to a minute before its status says asleep. A person's write wakes it; the saved-connection
  maintenance asks again every 5 minutes and redials once it is awake.
- A send from a saved chat wakes its computer, which takes 15–30 s. Until the
  send settles, the chat pane shows its working indicator as "Waking the
  computer…" and the Work row reads "Waking". The renderer decides this at send
  time from the saved copy (`markCloudWakeForSend` in `cloudSavedChatsSync.ts`).
  It is display only: the send goes to the same machine as before.
- A sleeping computer that still exists looks connected in Work: its lanes are
  not dimmed or marked offline (`machineIsCloudResting` in `crossMachineLanes.ts`).
  Its rows stay `online: false` for every guard. A deleted computer's saved
  chats keep the offline look.
- In a chat on a sleeping computer, a proof says the computer is asleep and
  offers **Wake**, and a code block's **Run** wakes it before it asks to run
  (`useChatMachineWake.ts`). Both are the person's explicit connect of the
  chat's own machine, which wakes it; the proof then loads again. A deleted
  computer's proof says so, with no button. An unreachable machine that is
  not a sleeping cloud computer still reads "offline".
- Copy and move hold the computer awake only while they run: the copy's hold
  on the source ends when the fork is running or failed, and the move's hold on
  the new computer ends once its files and projects are in. The time-outs (20
  and 45 minutes) only cover an ADE that quit mid-way.
- After a move, a chat shows once, on the computer that still exists. The Work
  list and the session router let a machine that lists a chat itself win over
  a saved copy with the same id (`crossMachineLanes.ts`,
  `useWorkMachineRouter.ts`). The saved-chats read gives each chat id one
  computer: one that still exists beats a deleted one (no connection, or
  missing from the cloud list while a surface keeps it current), then a
  connected one, then the newer copy (`cloudSavedChatsSync.ts`). Every move
  this desktop runs forgets its saved connection to the deleted source
  (`forgetMachineConnections` in `cloudMachineCopy.ts`). Another desktop keeps
  that connection; its chats there read as on a deleted computer.
- When the remote connection service starts or ends a rest for a computer
  (found asleep, or answering again), main sends `cloudStatusChanged` once per
  change (`onCloudRestChanged` → `cloudRestChanged` in `cloudWakeHook.ts`). The
  windows then read the machine list again. Without it, the tool gate
  (`useCloudMachines`) kept an old "running" answer and the tool showed a
  connection error.
- A saved chat names its project by the id the brain routes by (the registry id,
  written in `bootstrap.ts`). Copies saved before that carry the project database
  id, which the brain does not know. So a pinned remote call also sends the pin's
  folder, and `callAction` in `remoteConnectionService.ts` sends the id the
  machine lists: by id, then by folder (`findMachineProject`). It reads the list
  of the machine it has just woken, or asks a machine it holds no list for. It
  never picks among several projects when none matches.
- Wake, the rest above and the update check apply only to a machine the desktop
  knows as a cloud computer (`knowsBox` in `cloudMachines.ts`). That answer does
  not depend on the Connections pane: the computers are read once at start, any
  list read refreshes them, and a machine key no read has covered gets one read
  (5 s limit). A key that a read did not list (a laptop) is not asked about again
  for 10 minutes, a failed read is not repeated for 60 s, and nothing is read
  without ADE Cloud access.
- `ade cloud prepare-stop --timeout 40` (the server runs it before a stop at 0 hours)
  interrupts running chat turns and agent CLIs and writes the saved chat copy.
- Disk (`cloudDiskGrow.ts`, `cloudDiskGuard.ts`): ADE's storage guard runs on
  every computer, and on a cloud computer its lines follow that computer's own
  disk (`diskPressureThresholdsForSize`, read from the disk at each sample):
  agent turns stop at 5% free, heavy jobs at 10%, the warning at 15%, each
  between a floor and the desktop's own value (1 GB, 4 GB, 12 GB). The disk
  grows 4 GB through `POST /resize` with `computerIdle: true` and
  `origin: "auto"`: at the idle point once it is at 85% used or the warning
  line, and at the next keep-awake check once it is at the 10% line, when
  nothing but someone's use (`in_use`) keeps it busy (checked again right
  before the grow, which restarts the computer). One grow at a time, none for
  10 minutes after one starts, a refused one again after an hour. Refused (the
  plan's disk at one time, extra disk, its monthly limit, or the size's limit)
  and at the 10% line, the computer writes the exact reason to
  `ade_disk_full_reason` and the older `ade_disk_full`: its card says so, and
  `ade cloud status` prints it under the lanes. The grower's last step is in
  `$ADE_HOME/cloud/disk-grow.json`, and a refused turn's sentence reads it: it
  names the cloud computer's disk (not the disk of the computer the person is
  on), then the grow under way, or the refusal's reason and way out (a bigger
  size, extra disk, a plan, Clear caches).

Waking: `WorkSidebar` wraps tool panels in `CloudToolGate`
(`terminals/cloudToolGate.tsx`): a person's click on a tool that needs the computer
wakes it through `cloud.machineAction` (start, so a stopped computer returns too);
a restored tab shows Wake instead; at 0 hours the tool says "Out of hours" and offers
Push all work to GitHub (`cloud.pushAllWork`, the free short wake).

A send caught by a sleep is retried: chat `sendMessage` carries a `clientSendId`,
the desktop retries once after the wake when the answer was lost
(`isRetriableAfterSleep` in `remoteConnectionService.ts`), and the brain drops a
retry it already took.

## Timed wakes

A sleeping machine can't run its own timers, so before sleeping it sends its
next time to the account directory (`/cloud/wake`, table `cloud_wakes`, see
`apps/account-directory/README.md`), and a cron requests its public address.

## Rules for changes

- A new call to the provider goes through `CloudProvider`, never around it.
- User-facing text, CLI output and skills say ADE Cloud. "Powered by Agent 37"
  on the settings page is the only product mention.
- What spends hours or deletes a computer asks the person first (`cloudAgentActions.ts`), in hours.
