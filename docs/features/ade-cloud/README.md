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
        machines, sleep, create, copy, move, ready machines, hours, sign-ins
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
`CloudProviderError`, with the server's one plain sentence; the code
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
| Making a machine, its sign-in, joining the account | `cloudMachineCreator.ts`, `cloudApprovalWindow.ts`, `cloudHeadlessApproval.ts` |
| Half-made machines after a quit | `cloudPendingCreates.ts` |
| Copy and move | `cloudMachineCopy.ts` |
| Reconnect a machine removed from ADE | `cloudReconnect.ts` |
| Sleep, wake for use, agent limits | `cloudSleep.ts`, `cloudSleepWatch.ts`, `cloudBrainAccess.ts` |
| Ready machines | `cloudReadyMachines.ts`, `cloudReadyClaim.ts`, `cloudReadySettings.ts`, `cloudReadyActions.ts` |
| Sign-ins new machines start with | `cloudSignInStore.ts`, `cloudSignInActions.ts`, `cloudSignInBoot.ts`, `cloudClaudeSignIn.ts` |
| Claude passes (one per Claude account, cloud only) | `claudePassStore.ts`, `claudePassVerify.ts`, `claudePassEndWarning.ts`; on a machine `services/claudePass/` |
| Account sign-ins on every computer (capture, apply, renewal) | `services/providerLogins/` (entry `providerLoginSync.ts`, one file per job) |
| CLI and agent verbs, approvals | `cloudAgentActions.ts`, `cloudBrainMaker.ts`, `cloudDesktopActions.ts` |
| Desktop IPC | `registerCloudIpc.ts` |
| Reaching ADE's server, access | `cloudServerProvider.ts`, `cloudAccess.ts`, `cloudVaultItems.ts` |
| Server (account directory, `apps/account-directory/src/cloud/`) | `routes.ts`, `store.ts`, `billing.ts`, `cron.ts`, `chats.ts`, `provider.ts`, `accountDeletion.ts` |

Shared contracts are in `apps/desktop/src/shared/adeCloud.ts`, `cloudReady.ts`
and `cloudSignIns.ts`. On a machine, `apps/ade-cli/src/services/power/cloudKeepAwake.ts`
keeps it awake while it works and asks the server to sleep it 3 minutes after
that stops (see Sleep and busy rules).

## Surfaces

- **Settings:** Integrations › ADE Cloud (`CloudSection.tsx`), with Plan and
  hours (`CloudPlanCard.tsx`: hours left, the plan, computers and disk at one
  time, reset date, extra hours and extra disk for paid accounts, buy Plus or
  Pro, move between them, and manage, which opens Stripe's portal), the
  80% / 95% / out-of-hours banners, and computers due for deletion, ending in
  "Powered by Agent 37". Settings entries are `integrations.ade-cloud*`.
- **Add a computer and the chat picker:** New ADE Cloud computer (a size and a
  "Full computer (Android, Docker)" switch), and `Ready` for a project that
  keeps one.
- **CLI:** `ade cloud` (`ade help cloud`), and `ade chat create --machine cloud:ready`.
- **Agents:** the `ade-cloud` skill.
- **Phone:** the cloud page, over the `cloud.read` and `cloud.write` sync commands.
- **Bring your own provider:** `BringYourOwnCloudCard.tsx` is layout only and
  shows only when `BRING_YOUR_OWN_CLOUD_ENABLED` is on. Nothing is wired to it.

## Plans, hours and sizes

The rules are in [docs/plans/ade-cloud-plans-and-disk.md](../../plans/ade-cloud-plans-and-disk.md).
The server's `plans.ts` holds them, and `GET /cloud/account` sends them in
`catalog`, so no client keeps its own copy (`cloudCatalogOf` in
`shared/adeCloud.ts` fills gaps from an older server).

| Plan | Price | Hours a month | Disk at one time | Computers at one time |
|---|---|---|---|---|
| Free | $0 | 50 | 12 GB shared | 3 |
| Plus | $5 | 500 | 40 GB | 10 |
| Pro | $20 | 1,500 | 120 GB | 30 |

Hours are Small-computer hours. Disk and computers are what the account has
at one time, never a monthly amount. The account says `plan: "free" | "paid"`
for older builds and `planId: "free" | "plus" | "pro"` for new ones; a
`past_due` account follows the free rules but keeps what it has.

- **Sizes:** the main list is Small (standard 2/4, 1x, disk up to 12 GB),
  Medium (standard 4/8, 2x, 20 GB), Large (full 4/8, 5x, 50 GB) and X-Large
  (full 4/16, 8x, 100 GB). The other four shapes stay valid with the
  provider's own disk limit (`catalog.sizes[].tier`, `label`, `diskMaxGb`).
- **Changing plans:** Plus to Pro applies now, charges the difference for the
  rest of the period, and keeps the hours used. Pro to Plus applies at the
  period end (`billing.nextPlanId`); it is refused while the computers hold
  more than Plus's disk, unless extra disk is on and a month of it fits the
  limit. Both go through `POST /cloud/billing/checkout {plan}` on the
  subscription itself: Stripe's portal can't switch a subscription with more
  than one item.
- **Not set up yet:** Pro and extra disk are offered only once their Stripe
  prices are set. Until then `catalog.plans.plus`/`pro`,
  `catalog.extraDiskCentsPer10GbMonth` and `account.extraDisk` are absent, a
  checkout for Pro is a 400 and the extra-disk route is a 404.
- **Extra disk** (Plus and Pro): disk past the plan's, $1 for each 10 GB a
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
  "Push all work to GitHub" wake, which does not restart the 30-day delete
  clock. Timed wakes already set are deleted, as at 0 hours. Deleting a computer always works,
  and the 30-day delete of unused computers still runs. The owner report
  lists these accounts.
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

## Stored data

Account vault items, scope `all`, kind `integration`: `cloud-budget` (agent
limits only; the name is historical), `cloud-ready` (which projects keep a machine ready),
`cloud-claude-token` and `cloud-key-<provider>` (sign-ins for new machines).
Kind `provider_login` holds the account's provider sign-ins: `<provider>/<origin>.<slot>`
(the origin is 12 hex of the computer's machine key) and the Claude passes,
`claude-pass/<12 hex>` (`claude-pass/legacy` for the item older versions saved).
The relay caps one such value at 16,000 characters. The account setting
`providerLogins.cloud` says which sign-in ADE Cloud uses for each provider, which
are off, and the Claude smart balance switch. Each computer keeps marks only,
never a token, in `<ADE home>/provider-logins/state.json` and `applied.json`,
and the use of each pass in `claude-pass-use.json`.
Machine metadata keys are `ade_*` (`ade_machine_key`, `ade_request_id`,
`ade_made_by_chat`, `ade_disk_full` and `ade_disk_full_reason`, and the ready-machine keys in `cloudReady.ts`), plus `created_by: ade`.

## The machine template

`infra/ade-cloud/` holds the image every machine starts from. It sets
`ADE_HOST_INSTANCE_ID=cloud:<hostname>` and `ADE_CLOUD_INSTANCE_ID`, the only
variables the rest of ADE reads to know it runs on a cloud machine. ADE does
not build the template from the app: every release builds it
(`.github/workflows/cloud-template.yml`), and a tested build is moved to with
`infra/ade-cloud/promote-template.mjs`. The server creates from one pinned
version; the client doesn't choose. "Update this computer" moves one computer
to it (`updateInstance`).
On first boot a new machine installs the ADE version of the app that made it,
when the image's ADE is older.

## Sleep and busy rules

One busy list, `decideCloudBusy` in `apps/ade-cli/src/services/power/cloudKeepAwake.ts`,
fed from each runtime (`readRuntimeBusyFacts`). Unknown is busy.

- Busy: a running chat turn, a real running command, an agent CLI actually working,
  setup, first clone, move, copy (holds in `$ADE_HOME/cloud/holds/*.json`), someone
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
- Disk (`cloudDiskGrow.ts`): when idle and at 85% used, a computer grows 4 GB
  through `POST /resize` with `computerIdle: true` and `origin: "auto"`. Refused
  (the plan's disk at one time, extra disk, its monthly limit, or the size's limit)
  and full at 95%, the computer writes the exact reason to `ade_disk_full_reason`
  and the older `ade_disk_full`, and its card says so in a plain sentence.

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
