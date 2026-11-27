# DAEX Cloud

DAEX Cloud lets a person use DAEX fully with no computer of their own.

- Every signed-in account has one machine named DAEX Cloud, in every machine
  list and "Run on" menu on web, iPhone and desktop.
- Each cloud lane has its own Linux computer (an Agent 37 instance) running the
  DAEX brain, signed in to the account with nothing to type. To the rest of DAEX
  it is an ordinary remote machine ([remote runtime](../remote-runtime/README.md)).
  Clients never show these computers one by one.
- A computer sleeps when its work stops. Asleep is not offline. **Reading never
  wakes it** (the account server keeps copies); **doing** (send, run, Git)
  wakes it.

This is account data under the account-server rules: the server decides limits,
credits and refusals; account calls take no pin; lane work goes to the lane's
computer by its pin. Server routes, caps and errors are in
[`apps/account-directory/README.md`](../../../apps/account-directory/README.md).
To act as any plan or flip server switches, use the
[account test tool](account-test-tool.md).

## Source file map

Desktop main (`apps/desktop/src/main/services/adeCloud/`):

- `cloudAccess.ts` (the one place that picks the provider),
  `cloudServerProvider.ts`, `cloudProvider.ts` (the `CloudProvider` contract),
  `cloudVaultItems.ts` — reaching DAEX's server.
- `registerCloudIpc.ts`, `adeCloudReadIpc.ts` — desktop IPC (no pin).
- `cloudMachines.ts`, `cloudMachineCreator.ts`, `cloudApprovalWindow.ts`,
  `cloudPendingCreates.ts`, `cloudMachineCopy.ts`, `cloudReconnect.ts`,
  `cloudInstanceOps.ts` — the machine list, create/join, copy, reconnect.
- `cloudSleep.ts`, `cloudSleepWatch.ts`, `cloudBrainAccess.ts` — sleep, wake for
  use, agent limits.
- `cloudLaneLaunchService.ts`, `cloudLaneLaunchRecords.ts`,
  `cloudLaneLaunchSteps.ts`, `cloudLaneComputerStages.ts`,
  `cloudLaunchFileCopies.ts`, `registerCloudLaneLaunchIpc.ts` — a new lane on its
  own computer.
- `cloudLaneAccount.ts` (shared with the brain), `cloudLaneLife.ts`,
  `registerCloudLaneLifeIpc.ts`, `cloudLaneVerbs.ts` — delete, free, keep, size
  change, move, the CLI's lane views.
- `cloudAgentActions.ts`, `cloudBrainMaker.ts`, `cloudDesktopActions.ts`,
  `cloudTierRequestActions.ts`, `cloudActionArgs.ts` — CLI and agent verbs,
  approval cards.
- `cloudSignInStore.ts`, `cloudSignInActions.ts`, `cloudClaudeSignIn.ts`,
  `claudePassStore.ts`, `claudePassVerify.ts`, `cloudSignInEndWarning.ts` —
  DAEX Cloud keys, Claude passes; `services/providerLogins/` carries sign-ins to
  every computer.
- `cloudComputerRules.ts`, `cloudComputerLaneHold.ts` — rules on a cloud
  computer.
- `cloudDiskUsage.ts`, `cloudDiskGrowHost.ts`, `cloudLaneNameSync.ts`,
  `cloudLaneAnalytics.ts`, `cloudLaneBackupIpc.ts`.

Brain (`apps/ade-cli/src/services/`):

- `power/cloudKeepAwake.ts` (busy rules, idle, sleep requests),
  `cloudComputerReports.ts`, `cloudPrepareStop.ts`, `cloudDiskGrow.ts`,
  `cloudSetupUpsize.ts`, `cloudMemoryGuard.ts`, `cloudRemoteWorkHold.ts`,
  `cloudIgnoredFiles.ts`.
- `cloudChats/` — `cloudRestSave.ts`, `cloudChatUploader.ts`, `cloudProofSave.ts`,
  `cloudLaneBackup.ts`, `cloudChatMessageQueue.ts`, `cloudChatRestore.ts`
  (details in [remote runtime › On a DAEX Cloud computer](../remote-runtime/README.md#on-a-daex-cloud-computer)).
- `account/cloudBootLaunch.ts`, `cloudLaunchSignInWait.ts`,
  `cloudLaunchMessages.ts`, `cloudActivityReporter.ts`,
  `cloudHeadlessApproval.ts`.
- `github/cloudGitIdentity.ts`; `apps/ade-cli/src/cliCloudStatus.ts`,
  `cliCloudLanes.ts`.

Server (`apps/account-directory/src/cloud/`): `routes.ts`, `store.ts`,
`plans.ts`, `credits.ts`, `phones.ts`, `billing.ts`, `cron.ts`, `provider.ts`
(the only code that knows Agent 37's API), `contract.ts`, `chats.ts`,
`chatMessages.ts`, `sessionCopies.ts`, `gitSummaries.ts`, `mentionSnapshots.ts`,
`forkCapsules.ts`,
`projectOverview.ts`, `seal.ts`, `launches.ts`, `launchMessages.ts`,
`launchFiles.ts`, `moves.ts`, `laneBackups.ts`, `idleCleanup.ts`,
`planCleanup.ts`, `updates.ts`, `computerStatus.ts`, `automations.ts`,
`eventWakes.ts`, `limits.ts`, `integrations.ts`, `ctoCopy.ts`, `referrals.ts`,
`freePlan.ts`, `safety.ts`, `blocks.ts`, `costReport.ts`, `gravity.ts` and the
`sponsored*.ts` files.

Shared: `apps/desktop/src/shared/adeCloud.ts`, `adeCloud/` (binding, chat queue,
account calls), `cloudApiClient.ts` (typed fetch client), `cloudTiers.ts`,
`cloudLaneLaunch.ts`, `cloudSignIns.ts`, `cloudDiskGrowRules.ts`,
`cloudTierRequest.ts`.

UI: `renderer/components/settings/cloudDashboard/*`,
`renderer/components/cloudLane/*` (`CloudLaneHeaderButton.tsx`,
`CloudLaneComputerPanel.tsx`, `cloudLaneStatus.ts`, `CloudLaneSavedWork.tsx`),
`renderer/components/remoteTargets/cloudBrand.tsx`; iOS `Views/Cloud/`.

Image: `infra/ade-cloud/` (see its README).

## Gotchas / fragile areas

- **Every provider call goes through `CloudProvider`.** A lint rule
  (`apps/desktop/eslint.config.mjs`) stops main-process code other than
  `cloudAccess.ts` from importing the server provider.
- User-facing text says DAEX Cloud; "Powered by Agent 37" on the settings page
  is the only provider mention.
- **Account calls take no pin; lane work does** (plans, credits, the computer
  list, sleep, create and saved copies are `window.ade.cloud`, the `cloud`
  action domain, `/cloud/*`).
- **Reading never wakes a computer.** A resting lane has an account-answered pin
  (`isAccountAnsweredPin`, `shared/adeCloud/binding.ts`). A new read that wakes a
  computer is a bug.
- **The server decides**: clients show `{ code, message }`
  (`CLOUD_REFUSAL_CODES`) and never count.
- **What spends credits or deletes asks the person first**
  (`cloudAgentActions.ts`). An agent never makes a computer alone; a new action
  that adds one sets `makesComputer` on its card.
- **Old default names are mapped, never migrated** (`displayLegacyDefaultName`
  in `shared/legacyDefaultNames.ts`; `isCloudMachineDefaultName` accepts both
  `DAEX Cloud computer` and the old `ADE Cloud computer` forms).
- **A lane computer has one lane**; lane lists leave out its main checkout
  (`crossMachineLanes.ts`).

## The provider seam

`CloudProvider` covers list, get, create, delete, sleep, start, stop, update,
resize, backup, auto-sleep, ports, fork, metadata, usage, exec, and the
account's access, plan and billing calls. Failures are `CloudProviderError`
with the server's sentence; shapes are in `apps/account-directory/src/cloud/contract.ts`.

Agent 37 (`api.agent37.com`, secret `AGENT37_API_KEY`). Read its docs before
changing anything that depends on instance behavior
(https://www.agent37.com/docs/llms.txt: lifecycle, auto-sleep, logs, webhooks).
Facts DAEX leans on: only traffic to the instance (or an exec) counts as
activity, so the brain pings its wake URL while work runs (5-minute provider
timer as backstop); a sleep usually keeps memory but not always; an `update`
recreates the container (home folder stays).

## Access

`getCloudProvider` returns DAEX Cloud for a signed-in account (the bearer is the
account token; no client holds a provider key). `/cloud/access` answers
`{ enabled: true }` or, for a blocked account, `{ enabled: false, readOnly:
true, reason }`; read at most every 10 minutes. A dev build reaches a local
server with `ADE_ACCOUNT_DIRECTORY_URL`.

## Surfaces

- **Settings › DAEX Cloud** (`CloudDashboard.tsx`): credits and computers against
  the plan, disk, 80/95% and out-of-credits banners, computers due for deletion,
  every lane (city or list) with What uses the disk / Change size / Keep the lane
  and free its computer / Delete, plans and billing (Stripe portal), sizes,
  invites, sign-ins, agent limits, Free up space, saved lane work. Disk and
  "work not on GitHub" come from each computer's idle report, so the dashboard
  wakes nothing.
- **Web**: the same page; with no computer online it reads `GET /cloud/account`
  and `GET /cloud/instances` with the browser's token
  (`webclient/adapter/cloud.ts`). Billing goes straight to the server.
- **New lane on DAEX Cloud**: a chat launch with a `cloud` target makes one
  computer for one lane, then hands the launch to that computer's brain. See
  [Chat › DAEX Cloud lanes](../chat/README.md#daex-cloud-lanes).
- **The composer**: one DAEX Cloud row in "Run on"; a size button (default
  `cloudDefaultTier`, Small); Send turns off when the account is out of credits,
  at its computer limit, or the disk is full.
- **A cloud lane's chat**: one cloud button in the header
  (`CloudLaneHeaderButton.tsx`) showing asleep/waking/awake, with the status
  menu, Wake, Keep, Change size, Sleep and Delete lane. It is account level, so
  it works from any machine.
- **CLI**: `daex cloud` (`daex help cloud`), `daex chat create --machine cloud`.
- **Phone**: the `cloud.read` / `cloud.write` sync commands.
- `BringYourOwnCloudCard.tsx` is layout only behind
  `BRING_YOUR_OWN_CLOUD_ENABLED`; nothing uses it.

## DAEX Cloud with no computer of your own

### What a person reads with no computer awake

| What | Server module |
|---|---|
| Saved chats (and their cited proof pictures) | `chats.ts` |
| CLI and shell copies (shells keep 5,000 lines) | `sessionCopies.ts` |
| Git summaries at rest | `gitSummaries.ts` |
| The `@` menu at rest (rows and file names, migration `0071`) | `mentionSnapshots.ts` |
| Lane backups (work not on GitHub) | `laneBackups.ts` |
| Project overview | `projectOverview.ts` |
| Account lane index (mentions only) | `accountLanes/routes.ts` |
| Model favorites | `accountModelFavorites/routes.ts` |
| CTO account copy | `ctoCopy.ts` |
| Automations homed on DAEX Cloud | `automations.ts` |
| Linear and Jira with the account's sign-in | `integrations.ts` |
| Limits, secret names, plan, credits | `limits.ts`, `accountSecrets.ts` |
| Files and history | none: clients read GitHub at the lane's branch |

- Each copy is sealed with the account's key (`seal.ts`); only the account's
  computers write, every read checks the owner.
- The computer writes copies before it rests (`cloudRestSave.ts`: idle step,
  `daex cloud prepare-stop`, `daex cloud save-for-rest`), redacted, skipping
  unchanged ones. Provider history in capsules is redacted string by string so
  the provider still resumes (opaque fields such as thinking signatures stay).
  Moves between the person's own computers are not redacted.
- **Proof in a saved chat** (`cloudProofSave.ts`): cited pictures go as WebP
  (≤2,000 px), videos as one still; at most 40 a save. Stored beside the chat
  (`/cloud/chats/:machine/:chat/proof/:artifact`), pictures only, ≤3 MB, 60 per
  chat. Clients show it instead of "asleep" without waking; a video offers
  **Wake to play**.

### Send to an asleep or deleted computer (the message queue)

1. The client sends `POST /cloud/chats/:machineKey/:chatId/messages` with
   `messageId` = its `clientSendId` (a CLI session id works too; shells take no
   messages).
2. The server runs the wake checks first (a refusal stores nothing), stores the
   sealed message, answers at once, wakes the computer and runs
   `daex cloud messages drain` there. A repeated id changes nothing.
3. The computer claims each message with one conditional update and sends it
   with `clientSendId = messageId`. Each message goes once.

- `settings` (model, preset, effort, fast) picked while resting travel sealed
  with the message and are applied with `updateSession` before the send.
- `DELETE` takes a queued message back (409 `message_taken` once claimed). An
  unsent message fails after 24 h.
- Messages with files or thread comments are not queued; the client wakes the
  computer and sends directly.
- **During a move** (`moves.ts`) the server holds the lane's messages
  (`wake.state: "moving"`) and hands them to the new computer at `register`; a
  message the old computer had claimed ends failed ("check the chat"), never
  sent twice. The old computer, marked with `$ADE_HOME/cloud/moving.json`,
  refuses turn starts from other devices with `computer_moving`
  (`REMOTE_TURN_STARTS` in `cloudMoveMark.ts`), and clients then queue. After a
  move, sends to the old address reach the new computer (`moveMessageRouteOf`,
  up to 4 moves deep). A failed or cancelled move gives messages back.
- Clients draw held messages as the person's own bubbles
  (`cloudQueuedMessageEnvelope`, `CloudQueuedMessages.tsx`) until the transcript
  shows the same `clientSendId`; only failures and sign-in waits say so.

### Continue a chat whose computer is gone (fork-continue)

A send to a chat whose computer was deleted starts a server launch with
`continueChat { machineKey, chatId, kind }` on the same lane and branch; the chat
continues in the same row. Claude, Codex and OpenCode chats and Claude Code and
Codex CLIs restore a native capsule (`forkCapsules.ts`); other providers replay
the saved transcript. The new computer moves the saved copy to its machine key
(`POST /cloud/chats/:m/:c/move`, `/cloud/sessions/:m/:s/move`). One continue
launch per lane and chat (`cloud_launches_continue`); a second send joins it.
Brain side: [cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md#continue-on-a-new-daex-cloud-computer).

### Refusals and what is not built

Every wake, start, send and create refusal is `{ code, message }` from
`CLOUD_REFUSAL_CODES`. A browser can never read the vault. Not built: web push,
and moving a lane or chat onto DAEX Cloud.

## Plans, credits and sizes

The server's `plans.ts` holds the rules and `GET /cloud/account` sends them in
`catalog` (`cloudCatalogOf` fills gaps from an older server). A credit is a
Medium-hour; the person sees credits.

| Plan | Price | Credits a month | Computers | Extra credits | Outside agents (DAEX MCP) |
|---|---|---|---|---|---|
| Free | $0 | 50 | 2 | none: work stops | no |
| Plus | $5 | 100 | 3 | 4¢ | yes |
| Pro | $20 | 600 | 10 | 4¢ | yes |
| Max | $50 | 2,000 | 20 | 4¢ | yes |

- **Sizes** (`catalog.sizes`): Small (2 vCPU / 4 GB, uses no credits, disk ≤12
  GB), Medium (4/8, 1×, 20 GB), Large (4/8 full, 2.5×, 50 GB), X-Large (4/16
  full, 4×, 100 GB). The DAEX Cloud iPhone draws one credit a minute
  (`credits.ts`, `phones.ts`).
- **Disk is per computer** up to its size's `diskMaxGb` (`disk_limit`,
  `tier_limit`); no extra disk is sold.
- **Computer limit** counts every computer, asleep or not; at the limit, 403
  `computer_limit` with `CloudComputerLimitDetail` (least recently used lanes,
  the next plan). The count is inside `reserveComputer`'s conditional insert.
- **Out of credits**: only sizes that use credits are refused (402
  `out_of_hours`) or stopped; Small keeps working. An account refused the free
  plan runs nothing.
- **Outside agents on Free**: a DAEX MCP start answers 403
  `outside_agent_free_plan`.
- **Awake cap** (hidden): about 25 awake computers (`AWAKE_COMPUTER_CAP`); a wake
  waits 12 s for room, then 429 `too_many_awake`.
- **Changing plans**: up applies now; down applies at period end and is never
  refused (over the cheaper plan's computers, the answer carries `cleanup`).
  Both via `POST /cloud/billing/checkout`. Extra credits are one Stripe metered
  price per plan, added when the person first turns them on.
- **DAEX Cloud iPhone** access is behind `CLOUD_PHONE_ACCESS` (`beta`: only added
  testers, including emails that sign up later).
- `past_due` follows Free's rules for credits and outside agents but keeps its
  computers and limit.
- A deleted computer leaves the machine list (`forgetMachineStatements`).

### A cheaper plan's limits

`planCleanup.ts`. DAEX never removes a computer on its own and there is no grace
period. A downgrade that leaves too many computers opens
`CloudPlanLimitsDialog.tsx`: clean up yourself, or let DAEX free the chosen
computers (with "Save each lane's work first", on by default; checked before
Stripe is asked). Outside DAEX (a portal cancel) nothing is deleted: the account
gets `over_plan_limits` on new computers, one email and a dashboard notice.
Freeing keeps the lane and chats (reason `plan_limit`).

### Idle cleanup

`idleCleanup.ts`, minute cron. Free: warning at 2 days idle, delete at 3. Paid:
warning at 7, delete at 10. Never sooner than the stored `idle_deletes_at` plus
the last email's gap; never for an account out of credits, or a computer awake,
moving, updating or with a booked wake. Use, credits back, a booked wake or
**Keep it** (`POST /cloud/instances/:id/keep`, no wake) restart the clock. A
computer is deleted only while it rests with every lane saved
(`saveBeforeDelete`, needs `backup_rest_at`); otherwise it is held with a reason
and re-read with a doubling wait. The lane stays (reason `idle_cleanup`) and the
next message makes a new computer. The warning lists ignored files that would be
lost (`cloudIgnoredFiles.ts`).

### Lane backups at rest

Server `laneBackups.ts`, computer `cloudLaneBackup.ts`. Before every rest, each
lane's work GitHub lacks (unpushed commits plus a snapshot of uncommitted work in
a private index) is saved as a `git bundle` (exact restore) and a binary patch
(download). Nothing is pushed. "What GitHub has" is read with `git ls-remote`
(`readGithubBase`), not local `origin/*`.

- After each save, `POST /cloud/backups/report` names every lane; it is `current`
  only when every lane is clean or saved. The sleep request names the report,
  then `backup_rest_at` is set; any start clears it.
- Every cleanup uses `saveBeforeDelete`. Non-idle cleanups first run
  `prepare-stop --for-delete`, which freezes new turns and terminals
  (`cloudDeleteFreeze.ts`) so nothing is written after the save.
- **Restore**: a lane launch applies the newest backup (`applyHandoffGitBundle`)
  unless the lane has its own diverging work.
- **Get this lane's work** (`CloudLaneSavedWork.tsx`): download the patch, or on
  desktop open it as a new `ade-saved/...` branch.
- Sealed with the account key (encryption at rest, not end to end). Git LFS and
  submodule changes can't travel (that lane fails its backup and the computer is
  kept). Caps: 50 MB a lane, 1 GB an account.

### Disk grows

A disk only grows (`resize` with `disk`): by itself near full while idle
(`cloudDiskGrow.ts`), from the Android pane (a first emulator needs ~7.2 GB;
`androidDiskGuard.ts`), or by an agent (`daex cloud resize --free <GB>`,
`cloud.grow_disk`, fit by `cloudDiskGrowFit`). Inside the size's maximum it needs
no card; past it the server refuses (`tier_limit`). The grow restarts the
computer at idle; chats continue after it (cause `disk_grow`). Chat cards come
from `shared/cloudDiskGrowCard.ts`.

### Sponsored cards and the Index (Free, behind a switch)

Free is ad-supported through Gravity. The account server decides everything and
holds the partner key (`GRAVITY_API_KEY`): switches `gravity_ads` (`off`,
`testers`, `all`) and `gravity_live`, the plan, the country
(`GRAVITY_COUNTRIES`), the account's consent (`cloud_sponsored_consent`, one per
account) and that the chat runs on the account's own live DAEX Cloud computer.
Chats on the person's own machines never get a card.

- Formats (`gravity_format`: `below_reply`, `above_prompt`, `inline`, or `split`
  for an A/B test); placements `ade-<surface>-<format>`; at most one card per
  finished reply, claimed on the server before asking Gravity.
- Gravity's own renderer is used when the client names one (`web1`, `psp1`); DAEX
  keeps placement, hide and link rules.
- **Index pick** (`daex cloud recommend --need "…"`): an agent on a DAEX Cloud
  computer asks for a service; refused for people, DAEX MCP, automations and
  subagents, and while nobody has the computer's chat open.
- Daily limits per account (120 ads, 20 searches); viewer rows pruned after a
  day. iOS asks App Tracking Transparency once before the first card.
- **Small on Free** needs cards: without a recent US look and a yes, Small costs
  half a credit an hour (`sponsoredSmall.ts`, `SMALL_NO_CARDS_RATE_MILLI`). A
  tripwire alerts the owner when looks come from DAEX Cloud's own network.
- Consent rules by law (`sponsoredConsent.ts`) are written once in
  [account-test-tool.md](account-test-tool.md#where-cards-start-on).

### ADE Free Models (any plan, behind a switch)

Gravity's hosted models (`apps/account-directory/src/cloud/freeModels.ts`;
consent and country rules in `freeModelsConsent.ts`; migration `0071`), paid
for by the sponsored cards in the chats that use them. Any plan, any machine
(the person's own computer, their other machines, ADE Cloud), chat only,
through OpenCode's provider `ade-free` (`opencode/ade-free/<alias>`,
`apps/desktop/src/shared/adeFreeModels.ts`). The account server holds
Gravity's inference key (`GRAVITY_INFERENCE_KEY`, a Worker secret) and is
the only caller of `inference.trygravity.ai`.

- **Switch:** the instant `gravity_inference` setting (`off` | `testers` |
  `all`, starts `off`), held under the deploy variable `GRAVITY_INFERENCE`
  (unset or `off`: a hard off), and off without both `GRAVITY_INFERENCE_KEY`
  and `GRAVITY_API_KEY`. `all` reaches non-testers only while real ads are on
  (`gravity_live` under `GRAVITY_LIVE=1`): no free inference behind test ads.
  Off, the account state leaves `freeModels` out and every route answers
  `free_models_off`.
- **Routes** (`CLOUD_PATHS.freeModels*`, the account's own sign-in):
  `PUT /cloud/free-models/consent` (`granted` | `declined`, per account, with
  the hashed email and `CLOUD_FREE_MODELS_TERMS_VERSION`; an older version
  reads as no answer; a no clears the viewer rows; Global Privacy Control
  from the US turns a yes not given from such a browser into a no);
  `POST /cloud/free-models/seen` (`chatId`, `device`: someone has that chat
  open, kept with Cloudflare's `cf-connecting-ip`, user agent, device and
  country, only while the yes holds); OpenAI-compatible
  `GET /cloud/free-models/v1/models` and `POST /cloud/free-models/v1/chat/completions`
  with the chat in `X-ADE-Chat-Id`.
- **Each call** is checked in order: the switch, the yes, the chat id, a
  viewer record no older than 10 minutes (or a call in the last 5 minutes
  with a record no older than an hour: a turn that runs on; a person's ADE
  Cloud launch on one of these models leaves a stand-in record,
  `launch:<launchId>`, that the first unreported chat of the account takes
  over once within 10 minutes; an automation's or agent's launch leaves
  none), the viewer's
  country (`GRAVITY_INFERENCE_COUNTRIES`, default `US,CA`), the hashed email
  (an iPhone viewer without tracking allowed has none), then 50 a minute per
  account, 550 a minute for every account together and 2,900 a UTC day per
  account (`fm_request`), and Gravity's 8 MiB. The alias becomes Gravity's
  model id, `n` and audio go, the output limit is held to 1-65,536, and the
  server adds `session_id` (the chat's ad session, the same hash the cards
  send), `email_hash`, `user_ip` (the viewer's address, never the chat
  machine's) and `stream_options.include_usage`. The stream passes through;
  its usage chunk is added to `cloud_free_model_chats`.
- **Errors** are OpenAI-shaped (`{error: {message, type, code}}`,
  `CloudFreeModelsErrorCode`). Only Gravity's retry-safe
  `provider_rate_limited` stays a 429; every other refusal is a 4xx OpenCode
  doesn't retry (Gravity failing is 424). A context too long is OpenAI's
  `context_length_exceeded`, which OpenCode compacts on. A refused key or a
  suspended account reaches Sentry (`cloud.free_models.gravity_refused`)
  and reads as unavailable; Gravity's words pass only for a request it found
  wrong.
- **Cards:** a chat the proxy served in the last day gets cards on any plan
  and machine (`POST /cloud/sponsored/ad` with `instanceId: null`), under the
  ADE Free Models yes and countries instead of the Free plan's, with their
  own day (`fm_ad`, 400 per account). The last call's usage rides on the
  card request (Gravity's `usage`). Inference doesn't stop when the cards'
  day is used.
- **Not for unattended work:** an ADE Cloud automation can't be saved with
  one of these models, and a run of an older rule fails with the reason.
- **Clean-up and report:** viewer rows go after a day, served chats after a
  week (minutes 23 and 53). The daily report has a line: requests, accounts,
  tokens, cards asked and filled in these chats, and refusals by reason.
- **Catalog:** `GET /cloud/models` lists them in OpenCode's group with
  `free: {source: "ade-free", badge: "ad-supported"}`, beside OpenCode Zen's
  free tier (`source: "opencode-zen"`) from the newest models.dev snapshot.
  The list is the same for every account; clients show ADE Free Models only
  with `freeModels` in the account state.

## Referrals and the free plan

All server-enforced (`referrals.ts`, `freePlan.ts`, `freePlanGithub.ts`).

- **Earned credits** (`cloud_earned_hours`, append-only, never expiring) are used
  after the plan's credits and before extra ones.
- **One free plan per computer**: desktops and brains send `x-ade-computer` (a
  hash of the OS machine id; the server keeps only an HMAC). A create, move,
  copy or wake on free rules claims it; an account seen on another account's
  claimed computer gets 0 free credits (`free_refused_at`).
- **One free plan per GitHub account**: free credits need a connected GitHub
  account at least 30 days old (`free_github_hold` otherwise); a too-new account
  can unlock with a saved card (`POST /cloud/billing/free-unlock`).
- **Referrals**: one code per account (`https://ade-app.dev/invite/<CODE>`,
  `daex://invite/<CODE>`); 20 credits to both when the friend's first chat runs
  on DAEX Cloud; cap 10; refused when the two shared a computer. Redeeming is
  user-only.
- Abuse lines in the owner's daily report (`abuseSignals.ts`).

## Safety

Block list, card rule, kill switch (`CLOUD_CREATES_PAUSED`), hourly limits and
owner alerts are in
[`apps/account-directory/README.md`](../../../apps/account-directory/README.md#ade-cloud-safety).
A blocked account (`POST /cloud/owner/block`) is read-only: GET routes in
`CLOUD_BLOCKED_READ_ROUTES` work, everything else is `403 account_blocked`.

## Stored data

### Sign-ins in the account vault

- Kind `integration`, scope `all`: `cloud-budget` (agent limits),
  `cloud-key-<provider>` (saved DAEX Cloud keys). Kind `provider_login`:
  `<provider>/<origin>.<slot>` and Claude passes `claude-pass/<12 hex>`. The
  setting `providerLogins.cloud` says which sign-in DAEX Cloud uses per provider.
- A computer keeps marks only (`<ade home>/provider-logins/`), never a token in
  its env; its brain pulls sign-ins from the vault (`providerLoginApplyPass.ts`).
  The create route drops client env except `ADE_MIN_VERSION`.
- **The gate** (`providerLoginGate.ts`): on a cloud computer a turn or CLI start
  first waits (≤30 s) for the account's sign-ins to be applied; on a person's own
  computer there is no gate.
- Sign-ins also come down to the person's own computers that have none for that
  provider, never replacing a local one; Claude and Copilot's `gh` login never
  come down.
- **OpenCode** (`providerLoginCarry.ts`, `openCodeCarryWriter.ts`): only the
  opencode.ai credential travels, written through OpenCode's own API as an
  access-only copy; the computer that signed in renews ahead of expiry.
- A card per account picks the freshest usable copy (`cloudPlacePicks`).

### Git on a cloud computer

- `cloudGitPreflight` (`cloudGitCredential.ts`) requires a usable GitHub sign-in
  (`integration/github`, `integration/github-cli`) for a private repository
  before the computer is made; the composer reads the same check.
- Clones pass auth through Git's config environment (no token in `.git/config`).
  On a cloud computer only, a credential helper points at the DAEX launcher, so
  a plain `git push` there signs in.
- Commits use the account's GitHub noreply identity, else `NEUTRAL_GIT_IDENTITY`
  (`cloudGitIdentity.ts`), never over a person's value.

### Metadata, request ids and launch records

- Machine metadata keys are `ade_*` (`ade_machine_key`, `ade_request_id`,
  `ade_made_by_chat`, `ade_disk_full`, `ade_disk_full_reason`, and the lane
  keys `ade_lane_id`, `ade_lane_name`, `ade_project_origin` in
  `cloudLaneLaunch.ts`), plus `created_by: ade`. A copy drops `ade_ready*`.
- A create or copy that repeats a request id of this account gets the
  computer that request made (200), before any check. A reservation with no
  computer yet answers 409 `create_in_progress`; one older than 15 minutes is
  released. The reserve insert allows one live row per account and request id.
- The server writes `ade_env` (its `CLOUD_ENVIRONMENT`: `production` or
  `development`) on every create, copy and metadata write, over any value a
  client sent. The matches by request tag (the minute tick, a repeated create,
  the computer list) adopt only a computer of their own server, and an
  untagged one counts as production's. So two servers can share one provider
  key: each reads the other's computers in the list but never takes them. Only
  production sends the owner the provider wallet's alerts, and the awake-limit
  alert counts its own server's computers.
- A server launch (`POST /cloud/launches`) whose create answer was lost (the
  client went away, the provider timed out) stays `making` while the provider
  makes the computer. Whichever adoption takes that computer (the minute tick,
  the list, a repeated start) links the launch to it in the same batch
  (`lostStartLinkStatement` in `store.ts`): the launch is `joining`, and the
  computer joins and runs the first message with no client. A start cancelled
  meanwhile is linked too, and the cron deletes that computer unless it
  checked in or its join code was used. A start that made nothing (no computer
  and no reservation of its request, 20 minutes after it) is failed, so its
  card offers Retry. The web app follows a start whose answer was lost (no
  answer or a 5xx) by its id, and shows the error with Retry only when the
  server has no such launch (404).
- The desktop keeps one record per lane launch in
  `<userData>/cloud-lane-launches/<launchId>.json` until its cleanup is done;
  a brain keeps its own in `<machine .ade folder>/cloud-lane-launches/`.

## From the CLI and agents

### The status read

`cloud.status` (`daex cloud status`) answers from one computer list and one
account read, wakes nothing and never throws for "no DAEX Cloud": `canStartLane`,
plan, credits, disk, computers, lanes (with `deletesAt`), sizes and
`defaultSize`, agent limits, `lanesComputerDeleted`. `list`, `hours` and
`limits` are narrow views. DAEX MCP read access, the phone and a projectless
brain can read it.

### A new lane

- `daex chat create --machine cloud [--size small|medium|large|xlarge] --prompt
  "…"` makes one computer for one new lane and starts the chat there; no `--size`
  uses `CLOUD_DEFAULT_TIER_SETTING_KEY`, else Small.
- `daex chat launch --machine cloud` (from the pushed branch; `--on
  uncommitted|local`, `--lane`, `--project`, `--clone` refused; a Linear issue
  must be whole JSON).
- `daex lanes create --machine cloud --name <n>` makes the lane alone.
- A CLI session on a new cloud lane starts only from the app (the brain parks the
  launch at `awaiting-client`).
- New lanes get the AI name like local ones; renames sync to `ade_lane_name` and
  the computer name (`cloudLaneNameSync.ts`).

**Who may start one.**

- **The CTO** (`createLane`, `spawnChat` with `machine: "cloud"`) calls
  `cloud.lane_launch` on its home brain; the card shows in the CTO chat.
- **Automations** with `execution.cloud` run each run as a launch under the agent
  limits.
- **Asking first**: `lane_launch` asks with the same `approve()` as
  `cloud.create`: a card in an attended chat, the agent limits (daily count,
  largest size, credits) in a full-auto chat or automation.
- **A computer with no lane** (`create`, `copy`, `move`) carries `makesComputer`:
  always a card in the agent's chat, refused when nobody can answer
  (`CLOUD_AGENT_NO_COMPUTER_MESSAGE`).
- **A chatless terminal** is refused (it cannot prove a person;
  `mayUseUserOnlyActions`).
- **DAEX MCP** with write access is an unattended agent; resize, delete, move,
  cancel and loosening limits always need the person; read-only connections can
  read the account (`remoteMcpCommandPolicy.ts`, `isCloudAccountRead`).
- **The card**: one question, an impact line, one line per yes; no "No" option
  (Decline says no); no answer in 5 minutes is no; a card closed by a stopped turn
  tells the agent nothing was done (`queueAgentNote`).

**How it runs.** The brain runs it through the server launcher
(`cloudLaneLaunchService.ts`); the CLI polls `cloud.lane_launch_status` every
2 s. The launch id is printed first; the same `--launch-id` answers or retries
that launch. `daex chat launch-status|launch-cancel <id> --machine cloud`. A
computer a brain makes itself joins with a device sign-in whose link goes to the
chat and as a push to the person's phones.

### A new lane with no computer of your own (the server launcher)

Every new cloud lane starts through the server (`launches.ts`); the web, phone
and cloud automations send it with no computer. Routes:
[`apps/account-directory/README.md`](../../../apps/account-directory/README.md#launches-from-the-web-and-the-phone).

- **Files** first: `PUT /cloud/launches/:id/files/:fileId` (≤10, 25 MB each; 300
  drafts / 2 GB per account, else 429 `uploads_full`).
- **Start**: `POST /cloud/launches`; the launch id is the create's request id, so
  it never makes two computers. Kinds `chat` or `lane` (a CLI goes as `lane` with
  `cli`). `lane.color` is the first palette color no listed lane uses.
  `project: { accountProjectId }` lets a caller with no computer start one.
- **Git credential** is checked from the vault or the GitHub App before the
  computer is made (`git_credential_missing`, `github_app_not_installed`).
- **Join**: the computer's env carries `ADE_LAUNCH_ID` and a one-time
  `ADE_LAUNCH_JOIN` code (HMAC under `CLOUD_LAUNCH_JOIN_KEY`, valid 30 minutes);
  `cloudBootLaunch.ts` calls `POST /cloud/launches/:id/join` and completes the
  returned Clerk ticket with no browser (`approveSignInLinkDirectly`), headless
  Chromium as fallback, else `needs_approval` with one Approve tap. The join
  first notes the address it came from, so Clerk's new-device email is not sent
  for the computer's own sign-in (`apps/account-directory/src/newDeviceEmail.ts`:
  the account server sends that email itself).
- **Run**: the computer reads the facts, clones with its own Git sign-in,
  prefetches the agent's tool, and runs `chat.startLaunch` with the same ids,
  posting stage changes (`PUT .../stages`). A provider that needs a sign-in there
  reports `waiting_for_sign_in` (30 minutes on the computer, 45 on the server).
- Messages sent before the chat exists queue on the server (`launchMessages.ts`).
- Continue launches: see
  [Continue a chat whose computer is gone](#continue-a-chat-whose-computer-is-gone-fork-continue).

### Automations whose home is DAEX Cloud

The server keeps the rule (`cloud_automations`, `automations.ts`) and watches its
trigger: schedules in the rule's IANA zone, webhooks forwarded by the relay and
signed per hook. Each run is a server launch under the agent limits; one at a
time per rule; a storm pauses the rule. When the chat ends, the cron saves chats
and backups and deletes the computer, keeping the lane. A run that cannot start
fails before anything is made and the person hears by push (and at most one
email a day per rule). See [automations](../automations/README.md).

Other account routes: `POST /cloud/instances/:id/sign-ins` (remote provider
sign-in, `CLOUD_REMOTE_SIGN_IN`), `POST /cloud/projects/computers/delete` (a
project's computers, `saveBeforeDelete`). The typed client is
`apps/desktop/src/shared/cloudApiClient.ts`; `/cloud/*` answers a browser only on
`WEB_CLIENT_ORIGIN`.

### The life of a lane's computer

Account-level calls (`cloudLaneLife.ts`, `cloudLaneAccount.ts`), by computer id,
never a pin.

- **Work check** (`daex cloud push-work --check --json`, `work-state`): lanes with
  uncommitted changes or commits no remote has (after one `git fetch --all
  --prune`). A failed read is `failed`, never `clean`; `github_refused` /
  `github_unreachable` say what GitHub did. A resting computer that saved its
  lanes is checked from its backups with no wake.
- **Secrets stop a push** (`cloudPushSecretCheck.ts`). Before push-work commits,
  it reads what it would send: the lane's changes (staged into a copy of the
  index) and every commit no remote has, then the commit again after its hooks.
  An added line holding one of the project's DAEX secrets (8+ characters, plain
  or base64/base64url/URL-encoded), a token with a known shape (GitHub, AWS, a
  private key, Stripe, Slack, Anthropic, OpenAI, Google, npm), or an added key
  file (`.env`, `.env.local` but not `.env.example`, `id_rsa`, `.netrc`, a
  `.p12`) stops the lane: nothing is pushed or committed. The lane reads
  `failed` with `reason: "secret_found"` and up to 5 `secretFiles`; a free
  keeps the computer, as a refusal. A read that can't finish (30 s, 64 MB) keeps
  the work too. Split, encrypted or binary secrets and shapeless passwords are
  not caught.
- **Delete lane**: the computer, the lane and its saved chats go (work check
  first). "Keep its chats" passes `keepChats`. `cloud.delete` keeps chats;
  `cloud.lane_delete` deletes them and refuses `keepChats` from an agent.
- **A deleted computer looks like a sleeping one**
  (`cloudLanesWithoutComputer.tsx`): the lane stays a normal row with a "Computer
  deleted" mark (machine id `ade-cloud-deleted`, which nothing routes to); the
  next message makes a new computer (optional size chip) and continues the chat.
  Lane links to a kept lane open its kept page (desktop: Settings › DAEX Cloud
  with the row selected).
- **Move this lane to** one of the person's computers (`components/laneMove/`,
  iOS `LaneMoveSheet`): awake → a batch move, then the computer is deleted after
  the source proves nothing changed (`chat.crossMachineBatchSourceChanged`);
  asleep with every lane saved → no wake: the destination deletes the computer
  with `keepLane: { onlyIfSaved: true }` and restores from the backup and saved
  copies (`keptLaneRestore.ts`); not saved → **Wake and move**; deleted → the
  kept-lane restore. Actions `cloud.kept_lane_move_preview` / `kept_lane_move` /
  `kept_lane_move_status` go to the destination's pin. DAEX Cloud is never a
  destination.
- **Keep the lane on a fresh computer**: push first, then the server deletes the
  computer with `keepLane` (`cloud_lanes_without_computer`).
- **Size change**: a resize in place when the kind stays, else a move; it starts
  when the agent is idle or now (`prepare-stop`). While it runs, the lane's chat
  sends through the account queue (files and comments wait in the box), shows one
  slim job bar above the prompt (`CloudLaneChatStatus`), and Cancel works until
  the copy starts.
- **An agent asks**: `daex cloud resize --request --size large --reason "…"`
  (`cloud.tier_request`) posts a card; the person answers above the prompt box;
  answers go to the chat's own machine by its pin (`cloud.tier_request_answer`,
  user-only), and the outcome is told to the agent (`tellRequestingChat`,
  `createTierRequestTelling`). An unwatched agent cannot resize.

### Lanes, chats and saved work from the CLI

`cloudLaneVerbs.ts`: `daex cloud lanes` (every lane once, on a computer or
`computer_deleted`; `--stale`), `chats`, `sessions`, `backups`, `jobs`,
`project`. Reads wake nothing and work from any folder. Writes (`lane_delete`,
`lane_free`, `saved_chat_delete`, `session_delete`, `backup_forget`,
`job_cancel`, `lane_start`) ask with a card; `lane_keep` needs none. A name two
lanes share is refused with their ids.

## Guidance for agents

One text: `apps/desktop/resources/agent-skills/daex-cloud/SKILL.md`, loaded as the
`daex-cloud` skill and served by DAEX MCP as the `daex-cloud` prompt, shown only
to accounts with access (`setAdeCloudSkillVisible`). It holds no rates; agents
read them from the status.

## The machine template

`infra/ade-cloud/` builds the image. It sets `ADE_HOST_INSTANCE_ID=cloud:<host>`
and `ADE_CLOUD_INSTANCE_ID` (the only variables DAEX reads to know it is on a
cloud computer). Each release builds, tests on a real computer and promotes the
channel's image only on a pass (`.github/workflows/cloud-template.yml`,
`infra/ade-cloud/promote-template.mjs`). `/home/node` is the billed disk; pinned
agents are baked into `/opt/ade-tools`; others download into
`/var/cache/ade/tools` (≈7 GB budget). See
[agent tools cache](../onboarding-and-settings/agent-tools-cache.md#cache-layout-on-disk).

## Updates

Cloud computers update themselves (image and DAEX) only when idle
(`updates.ts`): before sleeping, the keep-awake loop asks
`GET /cloud/instances/:id/update-check`. Only a tested image
(`auto_update_<channel>`); a computer follows the track of the app that made it.
Each brain start posts `POST /cloud/instances/:id/booted`; no report in 15
minutes rolls back once to `previous_template`. Automatic updates use a free
window, not the person's credits. Clients show "Updates itself when idle",
"Updating…" or "Update failed" with Retry.

### The status menu

The header menu (`CloudLaneComputerPanel.tsx`) reads one account call when it
opens (`window.ade.cloud.computerStatus` → `GET /cloud/instances/:id/status`,
`computerStatus.ts`), never on a timer, never waking. It combines the provider's
signed status webhook (`POST /cloud/agent37/webhook`, `AGENT37_WEBHOOK_SECRET`,
registered with `scripts/register-agent37-webhook.mjs`), the brain's activity
report (`POST /cloud/instances/:id/activity`, `cloudActivityReporter.ts`), the
provider's health and the newest disk measure.

## Rules on a cloud computer

`cloudComputerRules.ts` (`isAdeCloudComputer`):

- **One lane per cloud computer** across projects (archived lanes count, the
  primary never does), checked wherever a lane row is created
  (`cloudComputerLaneHold.ts`, `CloudComputerLaneLimitError`). See
  [Lanes](../lanes/README.md#one-lane-per-ade-cloud-computer).
- **Codex runs with full access** (approval `never`, `danger-full-access`),
  except plan mode, side chats, agent-started and recovery chats and host
  policies. An agent never lifts a chat past its own level.
- Every agent's prompt carries one line about the computer's memory and
  `daex cloud resize --request` (`describeAdeCloudComputer`).

## Sleep and busy rules

### Busy and idle

One list, `decideCloudBusy` (`cloudKeepAwake.ts`); unknown is busy.

- **Busy**: a running turn or command, a working agent CLI, setup, a launch, a
  clone, a move or copy, holds in `$ADE_HOME/cloud/holds/*.json`, someone
  watching a tool (`work_tools.noteWatching`), and remote work still running
  after 10 s (`cloudRemoteWorkHold.ts`).
- **Idle**: a shell or agent CLI at its prompt, a chat waiting on approval, and
  anything silent for 60 minutes.
- **Typing** in a cloud chat sends `chat.warmupModel` (`sdkOnly`) at most every
  30 s (`CLOUD_TYPING_PING_MS`); it keeps an awake computer awake (within 20
  minutes of real work, `CLOUD_TYPING_KEEPS_AWAKE_MS`) but never wakes one.
  `cloudRemoteUseKind` is the one rule for what counts as use.
- Three minutes after the last work the brain calls
  `POST /cloud/instances/:id/idle` (with its backup report id); the provider's
  5-minute timer is the backstop. DAEX's own background writes
  (`isBackgroundAdeWrite`) never wake or keep awake.
- **The person's Sleep** runs `prepare-stop --timeout 20 --for-sleep` (stop turns,
  save chats and backups, freeze new work), then sleeps.
- `prepare-stop` marks chats whose turn it interrupted, so their saved row reads
  Stopped, not Done.
- Capsules and copies are replaced atomically and each owns its storage key
  (`storageSweeps.ts`).

### A resting computer in the clients

- **Asleep is not offline** (`machineIsCloudResting`), but its rows stay
  `online: false` for every guard.
- **Finding it asleep**: when a call times out, the desktop asks once
  (`asleepForUse`, `remoteCloudAsleepChecks.ts`); if asleep the link closes
  quietly and lists show saved chats. Only machines known as cloud computers are
  asked (`knowsBox`).
- **Saved rows give way to live rows** once the computer answers
  (`reconcileAgentChatSavedCopies` in `shared/chatHistoryMerge.ts`).
- **Waking**: a send wakes it (15–30 s); the pane shows "Waking the computer…";
  `user_message.sentAt` keeps when Enter was pressed. Tool panels wake on a
  click (`CloudToolGate`). Every wake for use logs `remote.cloud_woken_for_use`.
- **While resting**, saved rows carry the chat's settings and lane color; thread
  comments and pasted files stay on the
  device (`heldChatAttachments.ts`) until a send carries them.
- **The @ menu reads the same asleep as awake.** The rest save asks each project
  for its mention rows but machines (`listMentionSnapshotRows`) and each lane's
  file and folder names (`listQuickOpenPaths`, ignored files left out), builds
  one copy (`shared/cloudMentionSnapshot.ts`: ≤900 KB, ≤500 rows a kind) and
  uploads it (`PUT /cloud/mentions/:machine`) when it changed and every read
  worked. Clients rank it with the computer's own rankers
  (`rankChatMentionMenu`, `rankQuickOpenPaths`); machines come live from the
  account. Desktop and DAEX Web read it through the account call
  `mentionSnapshot` (`cloudMentionSnapshotCache.ts`), the phone through
  `CloudAtRestStore.mentionSnapshot` with Swift rankers. A client downloads it
  once per sleep (re-asks at most every 30 s; the first read waits ≤800 ms).
  With no copy yet, the menu shows the saved chats, lanes and open PRs from the
  Work slice (`chatMentionClientRows.ts`; the phone has no PRs or files). A
  deleted computer's chat lists no files.
- **Still wakes before a send**: a permission/mode change, saving or scheduling a
  draft, dismissing a question card, a screenshot added from a tool.
- **Per-account client state** (`state/accountScopedStorage.ts`): cached lane
  index, kept lanes and access state are dropped on sign-out or account change.
- **Saved chats** carry `computer: exists | deleted` (with reason) or `null` (a
  copy that moved to the person's own machine; listed nowhere).

### Disk and memory

- **Disk guard** follows the computer's own disk
  (`diskPressureThresholdsForSize`): turns stop at 5% free, heavy jobs at 10%,
  warning at 15%. The disk grows 4 GB at 85% while idle (one grow at a time).
- **Setup that fills the disk**: `ENOSPC` with a real shortfall grows the disk (at
  most four times per launch) and resumes setup after the restart; the disk a
  repository needed is remembered 90 days (`cloud_repo_disks`).
- **Memory** (no swap; out of memory restarts the computer): setup runs beside a
  guard that stops it below a tenth of memory (`laneSetupMemoryGuard.ts`); a
  machine-wide guard (`cloudMemoryGuard.ts`) kills the biggest process below a
  twentieth, never the brain, and tells the chat named by that process's
  `ADE_CHAT_SESSION_ID` (`reportCloudMemoryKill`; agent CLIs in terminals get no
  notice).
- **A launch that needs more memory** on the default size moves Small → Medium
  once (`cloudSetupUpsize.ts`, `launchAutoSizeCheck`); remembered 90 days
  (`cloud_repo_sizes`). A picked size is never moved.
- The image adds build tools, a `bwrap` wrapper for Codex's sandbox under gVisor,
  the GitHub CLI with DAEX's `gh` shim, and a login-shell PATH fix
  (`infra/ade-cloud/README.md`).

## Timed wakes and event wakes

- **Timed wakes**: before sleeping, the computer sends its next timer
  (`PUT /cloud/wake`); the cron wakes it 2 minutes early and logs each one as a
  `timed_wake` power row (`woke`, `awake`, `gave_up_capped`,
  `gave_up_unreachable`). Woken, the computer re-arms scheduled work and
  scheduled sends from the wall clock (`rearmMachineTimersAfterWake`, within a
  minute), because timers count a monotonic clock that stops while it is
  frozen. The brain opens every
  project at start (`cloud.project_open_at_start`) so timers survive restarts; a
  timer due in under 5 minutes keeps it awake.
- **Event wakes**: the computer lists topics (`PUT
  /cloud/instances/:id/event-wakes`: a Linear organization it is connected to, a
  Linear agent account, the account's webhooks); the relay reports events
  (`POST /cloud/internal/event-wake`) and the server wakes listeners at most once
  in 5 minutes.

Both are use: they bill credits and restart the idle-cleanup clock.
