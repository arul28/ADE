# ADE Cloud

ADE Cloud lets a person use ADE fully with no computer of their own.

- Every signed-in account always has one machine named ADE Cloud. It shows in
  every machine list and every "Run on" menu on the web, the iPhone and the
  desktop, next to the person's own computers.
- Each cloud lane has its own Linux computer behind the scenes. ADE never shows
  these computers one by one.
- Each computer runs ADE's brain as its main process and signs in to the
  account with nothing to type. To the rest of ADE it is an ordinary remote
  machine (see [Remote Runtime](../remote-runtime/README.md)).
- A computer sleeps when its work stops. An asleep cloud computer is not
  offline. Reading never wakes it: the account server keeps a copy of what a
  person reads (see [ADE Cloud with no computer of your own](#ade-cloud-with-no-computer-of-your-own)).
  Doing (send, run, continue) wakes it.

The calls in this doc are account level. They act on the account's cloud
computers, not on a lane, a chat or another machine, so these IPC calls take no
pin. A computer's own actions go through the machine list like any other
machine.

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

`CloudProvider` (`cloudProvider.ts`) is the contract: list, get, create,
delete, sleep, start, stop, update, resize, back up, auto-sleep, public port,
fork, signed URL, name, metadata, usage, can-create, exec, and the account's
access, plan and billing calls. Failures are `CloudProviderError` with the
server's sentence (`cloudRefusalMessage` in `provider.ts` cleans a provider
refusal); `CLOUD_ACCESS_REFUSED` means the account was refused. The shapes
are in `apps/account-directory/src/cloud/contract.ts`.

### The provider: Agent 37

ADE Cloud computers are Agent 37 instances. The account server talks to its
API in `apps/account-directory/src/cloud/provider.ts` (`api.agent37.com`, exec
on `sandbox.agent37.app`, secret `AGENT37_API_KEY`); the image is built there
too (`infra/ade-cloud/README.md`). Users never see the name. Read Agent 37's
own docs before changing anything that depends on how an instance behaves:

- Docs index, for agents: https://www.agent37.com/docs/llms.txt
- Lifecycle (what a stop, restart, update and resize keep):
  https://www.agent37.com/docs/agents-api/instance-lifecycle.md
- Auto-sleep (what counts as activity, checkpoints, what a wake keeps):
  https://www.agent37.com/docs/agents-api/instance-auto-sleep.md
- The instance object and its statuses:
  https://www.agent37.com/docs/agents-api/instances/object.md
- Logs (with `health`: restart count, out-of-memory) and metrics:
  https://www.agent37.com/docs/agents-api/logs.md,
  https://www.agent37.com/docs/agents-api/metrics.md
- Webhooks (`instance.status.updated`):
  https://www.agent37.com/docs/agents-api/webhooks.md

Facts from those docs that ADE's design leans on:

- Only traffic to the instance's own URLs (or an exec) counts as activity.
  An agent's outgoing calls don't, which is why the brain pings its wake URL
  while work runs (`cloudKeepAwake.ts`), with the provider's own 5-minute
  timer as the backstop.
- A sleep usually keeps memory, but not always: an instance moved to another
  host, or asleep long enough, boots fresh. Files stay; processes don't.
- An `update` recreates the container: memory is gone, the home folder stays.

## Access

- `getCloudProvider(deps)` returns ADE Cloud for a signed-in ADE account, or
  null. The bearer is the account token; no desktop or brain holds a provider
  key.
- `/cloud/access` answers `{ enabled: true }`, or for a blocked account
  `{ enabled: false, readOnly: true, reason }` (see [Safety](#safety)). It is
  read at most every 10 minutes per account; a cached yes survives a failed
  check. The `signedOut`, `no_access` and `unreadable` states keep their
  sentences (`requireCloudProvider`, `readCloudStatus`).
- A development build reaches a local server with `ADE_ACCOUNT_DIRECTORY_URL`
  (for example `http://127.0.0.1:8787`).

## Source file map

| Area | File (under `services/adeCloud/`) |
|---|---|
| Machine list and box actions | `cloudMachines.ts` |
| Making a machine, its sign-in, joining the account | `cloudMachineCreator.ts`, `cloudApprovalWindow.ts`; the approval a machine with nobody at it runs (browserless first, headless Chromium as the fallback) is `apps/ade-cli/src/services/account/cloudHeadlessApproval.ts` (`approveSignInLink`) |
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
| A new lane on its own new computer (before the hand-off to its brain) | `cloudLaneLaunchService.ts`, `cloudLaneLaunchRecords.ts`, `registerCloudLaneLaunchIpc.ts`, `cloudLaunchFileCopies.ts` (images from another machine) |
| An agent's disk grow on its own computer | `cloudAgentActions.ts` (`grow_disk`), `cloudDiskGrowHost.ts`; `apps/ade-cli/src/services/power/cloudDiskGrow.ts`; `apps/desktop/src/shared/cloudDiskGrowRules.ts` (the fit), `apps/desktop/src/shared/cloudDiskGrowCard.ts` (the chat cards) |
| Rules on a cloud computer (one lane, Codex full access) | `cloudComputerRules.ts`, `cloudComputerLaneHold.ts` |
| Desktop IPC | `registerCloudIpc.ts` |
| Reaching ADE's server, access | `cloudServerProvider.ts`, `cloudAccess.ts`, `cloudVaultItems.ts` |
| Server (account directory, `apps/account-directory/src/cloud/`) | `routes.ts`, `store.ts`, `billing.ts`, `cron.ts`, `chats.ts`, `provider.ts`, `accountDeletion.ts`, `referrals.ts`, `freePlan.ts`, `email.ts` |
| Server reads with no computer awake (migration `0039`): sealed saved copies, the project overview, the account lane index | `apps/account-directory/src/cloud/seal.ts`, `sessionCopies.ts`, `gitSummaries.ts`, `forkCapsules.ts`, `projectOverview.ts`; `apps/account-directory/src/accountLanes/routes.ts` |
| Server message queue of an existing chat or CLI, and the continue on a new computer | `apps/account-directory/src/cloud/chatMessages.ts`, `launches.ts` (`continueChat`), `launchMessages.ts`, `chats.ts` (`handleMove`), `moves.ts` (the hold during a move) |
| Server account reads for a client with no computer (migrations `0040`, `0041`) | `apps/account-directory/src/cloud/limits.ts`, `accountSecrets.ts`, `ctoCopy.ts`, `integrations.ts`, `linearRenewal.ts`, `eventWakes.ts` |
| Client calls for ADE with no computer (desktop and web) | `apps/desktop/src/shared/cloudApiClient.ts`, `apps/desktop/src/shared/adeCloud/chatQueue.ts`, `apps/desktop/src/shared/adeCloud/accountCalls.ts`, `apps/desktop/src/renderer/state/adeCloudChatQueue.ts`, `apps/desktop/src/main/services/adeCloud/adeCloudReadIpc.ts` |
| A cloud computer's git identity | `apps/ade-cli/src/services/github/cloudGitIdentity.ts` |
| Lane launch: the launch's steps and stage cards, the account status a launch checks first | `cloudLaneLaunchSteps.ts`, `cloudLaneComputerStages.ts`, `cloudAccountStatus.ts` |
| Lane life: delete, keep the lane and free its computer, tier change, work check; the job events to every window | `cloudLaneAccount.ts` (the account side, shared by the desktop and the brain), `cloudLaneLife.ts`, `registerCloudLaneLifeIpc.ts`, `broadcast.ts` |
| An agent's size request: the card, the answer, telling the agent how the change ended | `cloudTierRequestActions.ts` (`tier_request`, `tier_request_answer`); `apps/desktop/src/shared/cloudTierRequest.ts`; the asking chat's pin parsed by `apps/desktop/src/shared/projectBinding.ts` (shared with `main.ts`'s renderer-pin sanitizer) |
| The argument readers every ADE Cloud action builder shares (`record`, `text`, `clipReason`, `readApproval`) | `cloudActionArgs.ts` |
| A running move or size change as one line (title, live step, size label) for the job card, the bar above the prompt box and the header's status menu | `apps/desktop/src/renderer/components/cloudLane/cloudLaneJobPresentation.ts` (pure; `cloudLaneStatus.ts` reads it) |
| Where a send goes while the chat's lane is moving or its computer is gone (the account's queue, or files and comments kept in the box) | `apps/desktop/src/renderer/components/chat/chatAccountQueueRoute.ts` |
| The account's lanes, saved chats, CLI copies, backups and server jobs from the CLI and agents (`ade cloud lanes`, `chats`, `sessions`, `backups`, `jobs`, `project`) | `cloudLaneVerbs.ts`; text in `apps/ade-cli/src/cliCloudLanes.ts` |
| Lane renames written to the computer's metadata | `cloudLaneNameSync.ts` |
| The disk measure and Clear caches on a cloud computer | `cloudDiskUsage.ts` |
| A lane computer's status menu: the header button and menu, the status hook, the server read, the provider's status webhook (migration `0050`), the brain's activity report | `apps/desktop/src/renderer/components/cloudLane/CloudLaneHeaderButton.tsx`, `CloudLaneComputerPanel.tsx`, `CloudLaneConnectionRow.tsx`, `cloudLaneStatus.ts`, `useCloudComputerStatus.ts`; `registerCloudIpc.ts` (`cloudComputerStatus`); `apps/account-directory/src/cloud/computerStatus.ts`, `apps/account-directory/src/webhookSignature.ts`, `apps/account-directory/scripts/register-agent37-webhook.mjs`; `apps/ade-cli/src/services/account/cloudActivityReporter.ts` |
| Boot and idle reports from a cloud computer (CLI) | `apps/ade-cli/src/services/power/cloudComputerReports.ts`, `apps/ade-cli/src/services/power/cloudKeepAwake.ts`, `apps/ade-cli/src/services/power/cloudIgnoredFiles.ts` |
| Idle cleanup (warn, save, delete unused computers) | `apps/account-directory/src/cloud/idleCleanup.ts`, `planCleanup.ts` (`saveBeforeDelete`), `apps/desktop/src/renderer/components/settings/cloudDashboard/CloudIdleCleanupNotice.tsx` |
| Lane backups at rest (save, report, restore, download) | `apps/account-directory/src/cloud/laneBackups.ts`, `apps/ade-cli/src/services/cloudChats/cloudLaneBackup.ts`, `apps/desktop/src/main/services/lanes/cloudLaneRestoreHook.ts`, `apps/desktop/src/main/services/adeCloud/cloudLaneBackupIpc.ts`, `apps/desktop/src/renderer/components/cloudLane/CloudLaneSavedWork.tsx`, `apps/ios/ADE/Views/Cloud/CloudMachineScreen.swift` (`CloudSavedWorkRow`) |
| CLI status read (`ade cloud status`) | `apps/ade-cli/src/cliCloudStatus.ts` |
| The launch card in chat (its step rows share one parts module with the lane job card) | `apps/desktop/src/renderer/components/chat/launch/adeCloudLaunch.ts`, `apps/desktop/src/renderer/components/chat/launch/stepCardParts.tsx` |
| The dashboard in Settings › ADE Cloud, and the lane pieces (cities, job card, tier change, lanes without a computer) | `apps/desktop/src/renderer/components/settings/cloudDashboard/*`, `apps/desktop/src/renderer/components/cloudLane/*` |
| Server: automatic updates, lanes without a computer, the disk usage report (migrations `0020`, `0021`, `0022` in `apps/account-directory/migrations/`) | `apps/account-directory/src/cloud/updates.ts`, `lanesWithoutComputer.ts`, `diskUsage.ts` |
| A default-size launch moving its computer from Small to Medium when setup runs out of memory, and the repository remembered (migration `0036`) | `apps/ade-cli/src/services/power/cloudSetupUpsize.ts`, `apps/account-directory/src/cloud/launches.ts` (`launchAutoSizeCheck`, `startSizeOf`) |
| Server safety: block list, card rule, kill switch, hourly limits, owner alerts (migration `0037`) | `apps/account-directory/src/cloud/blocks.ts`, `safety.ts`, `costReport.ts` (free-use cap) |
| Server launches from the web and the phone: queued messages, sign-in status, models (migration `0038`) | `apps/account-directory/src/cloud/launches.ts`, `launchMessages.ts`, `accountSignIns.ts`, `models.ts` |
| Launch files and their per-account caps (migration `0068`) | `apps/account-directory/src/cloud/launchFiles.ts` |
| The cloud computer's side of a launch: sign-in wait, queued messages | `apps/ade-cli/src/services/account/cloudBootLaunch.ts`, `cloudLaunchSignInWait.ts`, `cloudLaunchMessages.ts` |

Shared contracts are in `apps/desktop/src/shared/adeCloud.ts`,
`cloudSignIns.ts`, `cloudTiers.ts` (the four lane sizes, read from the catalog)
and `cloudLaneLaunch.ts`. On a machine, `apps/ade-cli/src/services/power/cloudKeepAwake.ts`
keeps it awake while it works and asks the server to sleep it 3 minutes after
that stops (see Sleep and busy rules).

## Surfaces

- **Settings › ADE Cloud** (its own tab under General, `CloudSection.tsx`,
  `settings/cloudDashboard/CloudDashboard.tsx`, entries `integrations.ade-cloud*`):
  - The hero: hours and computers against the plan, and the disk used; the 80% / 95% /
    out-of-hours banners; computers due for deletion.
  - Every cloud lane as a city or a list. Each row's ⋯ menu: What uses the
    disk, Change size, Keep the lane and free its computer, Delete.
  - Plans (`CloudPlans.tsx`): one card per plan, the next one up with the main
    button, one "how hours work" panel, extra hours, and Manage billing
    (Stripe's portal).
  - Sizes (`CloudSizeCards.tsx`, also the change-size dialog): how long the
    hours left last at each size.
  - Invite friends, Sign-ins, and what agents may do alone.
  - "Free up space" at 80% of the plan's disk (`CloudFreeUpSpace.tsx`): the
    biggest lanes first, then the longest unused.
  - The disk measure is each computer's own (`cloudDiskUsage.ts`): repository,
    dependencies, Docker, Android, caches, agent programs and ADE data, the
    rest as "System and other", parts on another disk left out. The computer
    measures it at its idle step at most every 6 hours, so the dashboard wakes
    nothing.
  - Clear caches runs on that lane's computer (`cloud.clear_caches`). The
    dashboard confirms first; an agent's call asks with a card, and an
    unwatched agent gets no.
- **The web app:** the same page (`web: "account"`), from the top bar's
  Settings with no project or computer. `GET /cloud/access` (kept a minute)
  says whether ADE Cloud is on. An online computer answers the computer list
  (`cloud.read`). With none online, or a brain too old, the web reads
  `GET /cloud/account` and `GET /cloud/instances` with the browser's own token
  (`webclient/adapter/cloud.ts`); a failed list shows the plan and marks the
  computers unread (`computersUnread`). Billing goes straight to the server
  (`webclient/adapter/cloudBilling.ts`, `BrowserAccountClient.cloudRequest`).
  Stripe opens in the same tab with `returnTo: "web"` and comes back to the
  web Settings › ADE Cloud. The website's plan buttons link to
  `app.ade-app.dev/?cloudPlan=<plan>` (see
  [Web client deeplinks](../web-client/README.md#deeplinks)).
- **New lane on ADE Cloud:** a chat launch with a `cloud` target makes one
  computer for one lane, then hands the launch to that computer's brain. There
  is no form for a bare computer; the phone and a person's `ade cloud create`
  can still make one. An agent never makes one alone (see **Who may start
  one**). See [ADE Cloud lanes](../chat/README.md#ade-cloud-lanes).
- **The composer:** "Run on" lists one ADE Cloud row (the person's lanes as a
  small skyline). The lane list shows this project's ADE Cloud lanes from the
  computers' metadata with no wake. A size button picks the size (default
  `cloudDefaultTier`, Small at first). A label turns Send off when the account
  is out of hours, uses all its computers, or has a full disk. See
  [Run on ADE Cloud in the composer](../chat/README.md#run-on-ade-cloud-in-the-composer).
- **A cloud lane's chat:** one cloud button in the header
  (`CloudLaneHeaderButton.tsx`). Its mark says asleep, waking or awake
  (`cloudLaneStatus.ts`), with a warning dot while idle cleanup plans to delete
  the computer. With that button the chat has no "asleep" banner (a message
  wakes the computer); only a failed wake shows a line (Try again), and a chat
  with no header button still shows the asleep and waking lines
  (`ChatMachineWakeBanner`, `headerLaneId`). The menu opens on the computer's
  status (up since, size, disk and hours, its work, running agents, trouble
  only when there is some; see [The status menu](#the-status-menu)), then Wake,
  Keep, Change size, Sleep (asks first while a turn runs), the ADE Cloud page
  and Delete lane. It is account level, by the computer's id, so it works for
  a chat on any machine. A chat whose computer was deleted has no header
  button (desktop and iPhone); its deleted-computer banner says what the next
  message does.
- **Look:** the Night sky tokens, the cloud mark, the size icon and the skyline
  are in `remoteTargets/cloudBrand.tsx` and `cloudBrand.css`.
- **CLI:** `ade cloud` (`ade help cloud`) and
  `ade chat create --machine cloud [--size <size>]` (see
  [From the CLI and agents](#from-the-cli-and-agents)).
- **Agents:** the `ade-cloud` skill (see [Guidance for agents](#guidance-for-agents)).
- **Phone:** the cloud page, over the `cloud.read` and `cloud.write` sync
  commands.
- **Bring your own provider:** `BringYourOwnCloudCard.tsx` is layout only,
  behind `BRING_YOUR_OWN_CLOUD_ENABLED`. Nothing uses it.

## ADE Cloud with no computer of your own

A person with no computer of their own uses ADE on the web, the iPhone or the
desktop with ADE Cloud as their machine. The account server keeps what a
person reads, so a read never wakes a cloud computer. An action wakes the
computer, and the UI never waits for the wake. The routes, caps and errors
are in
[`apps/account-directory/README.md`](../../../apps/account-directory/README.md#saved-chats-and-other-saved-copies).

### What a person reads with no computer awake

| What | Server module |
|---|---|
| Saved chats | `chats.ts` |
| CLI and shell copies (a shell keeps its last 5,000 lines) | `sessionCopies.ts` |
| Git summaries saved at rest | `gitSummaries.ts` |
| Lane backups: each lane's work not on GitHub (a patch to download) | `laneBackups.ts` |
| One project's overview | `projectOverview.ts` |
| The account lane index (name, branch, machine, PR; only for mentions) | `accountLanes/routes.ts` |
| The CTO account copy | `ctoCopy.ts` |
| Automations whose home is ADE Cloud | `automations.ts` |
| Linear and Jira, with the account's sign-in | `integrations.ts` |
| Agent limits, secret names, plan, hours, usage | `limits.ts`, `accountSecrets.ts` |
| Files and history | none: the client reads GitHub (each lane's branch, and a read-only "Default branch" workspace for every repository) |

- The server seals each copy with the account's own key (`seal.ts`). Only a
  computer the account owns writes one, and every read checks the owner.
- The computer writes the copies before it rests (`cloudRestSave.ts` in
  `apps/ade-cli/src/services/cloudChats/`): at its idle step, in
  `ade cloud prepare-stop` and in `ade cloud save-for-rest`. An unchanged
  copy is not sent again. The text is redacted first. The same save makes
  the lane backups first ([Lane backups at rest](#lane-backups-at-rest)).
- A saved CLI or shell copy opens read-only. The person's own computers that
  are offline are hidden in Work, Lanes and the welcome page.

### Send to an asleep or deleted computer (the message queue)

A message to a chat or CLI whose computer rests goes to the account server
(`chatMessages.ts`; the client is `shared/adeCloud/chatQueue.ts`):

1. The client sends `POST /cloud/chats/:machineKey/:chatId/messages` with
   `messageId` (its `clientSendId`). A CLI session's id takes the chat id's
   place; a shell takes no messages.
2. The server runs the wake checks first, so a refusal stores nothing.
3. It stores the sealed message, answers at once, wakes the computer and runs
   `ade cloud messages drain` there. The same `messageId` again changes
   nothing.
4. The computer claims each message in one conditional update, sends it with
   `clientSendId = messageId`, and reports it. Each message goes once.

A chat message can carry `settings`: the model, preset, reasoning effort and
fast mode the person picked while the chat rested. The server checks each
field (`cloudChatMessageSettingsOf`), seals the settings with the text, and
gives them only to the chat's computer. That computer applies them with
`updateSession` before it sends the message. A failed apply logs
`cloud.chat_queue_settings_failed` and the message still goes.

The person can take back a queued message (`DELETE`); one a claim took
answers 409 `message_taken`. An unsent message fails after 24 hours.

A message with files, or one that carries thread comments, is not queued: the
client wakes the computer and sends it directly. A queued message reaches the
chat as text only, so its comments would stay pending there, unsent.

**While a move runs** (`moves.ts`, a computer to the other kind), the server
holds the lane's messages and answers `wake.state: "moving"`:

- From the move's `make` step until `register`, a send is stored for the old
  computer and nothing wakes it or asks it to drain. Only the plan's
  refusals run then (`ChatWake.heldCheck`: the account's block, an outside
  agent on the free plan, credits for the size the move lands on, as the
  move's start checked them); the wake's checks
  (an update in progress, the queue feature, past due, the awake cap, the
  idle cleanup's claim) are skipped. Its own list and claim
  leave the held messages out (`MOVE_HOLDS_MESSAGES_SQL`), since the move
  stops its ADE and would cut the turn. `wait_idle` holds nothing.
- A send straight to the old computer, from a device that doesn't know of
  the move (another desktop, ADE Web, the phone): the move marks the running
  old computer with its hold (`moveOutMarkCommand`,
  `$ADE_HOME/cloud/moving.json`), and its ADE refuses, with
  `computer_moving`, exactly what starts a turn from another device: the
  actions in `REMOTE_TURN_STARTS` (`cloudMoveMark.ts`), one list for the
  desktop's `ade/actions/call` and the sync commands of ADE Web and the
  phone. That is a chat's sends and launches, and a CLI's input: text typed
  into it (`chat.typeIntoCli`, `pty.sendToSession` / `work.sendToSession`)
  and a terminal started with its first input (`pty.create` /
  `work.startCliSession`), since a CLI's process does not survive the move.
  A chat made with no turn (`chat.create`) and a terminal started with no
  first input are not refused. The desktop, ADE Web and the phone then send
  a message to a chat that exists to the account's queue (desktop and web:
  `withSavedChatReads`; the phone: `SyncService.sendChatMessage`), which
  holds it. A refused send with files or comments is not queued: they stay
  in the composer with the line "Files and comments can't go while this
  chat's computer moves". A new chat with its first message
  has no queue: the desktop shows the sentence and keeps the text, and a
  launch fails with the sentence. `ade chat create --prompt` and
  `ade new chat --prompt` with `--machine` make the chat, then send to it:
  when the send is refused they delete the chat they made and print the
  sentence. The queue's own drain is never refused. The undo clears the
  mark; one it misses (the computer was asleep) expires with the hold.
- At the end of `register` the new computer has the lane: the queued
  messages move to its instance id and keep their chat address (machine key
  and chat id), so every client reads them where it queued them. The server
  runs `ade cloud messages drain` there, detached
  (`DRAIN_MESSAGES_DETACHED_COMMAND`). A message the old computer had
  claimed may have reached the chat there, so it ends failed with "check the
  chat" (`MOVE_CUT_MESSAGE_ERROR`), never sent twice. The move's last step
  hands over again, for one sent in between.
- After `register`, and after the move (also when its old computer was
  kept), a send to the old address goes to the new computer
  (`moveMessageRouteOf`, up to 4 moves deep, while the move's record lasts a
  week). It no longer starts a continue launch for a computer a move
  deleted.
- A chat with no saved copy yet (the move's save writes it while the new
  computer is made) still takes a message by the old computer's address; the
  computer finds the chat by its id.
- A failed or cancelled move gives the messages back to the old computer:
  what the new one was given comes back, and a running old computer is asked
  to drain (a paused one drains when its ADE starts again). An asleep one
  keeps them for its next wake.
- A size change in place keeps the computer's id, so its messages drain when
  its ADE starts again after the restart. The server does not hold them
  before the resize is asked; the client waits until then (below).

On the desktop, in ADE Web and on the phone, a held message looks like any
sent message: the person's own bubble at the end of the thread and the
working line, with a quiet Cancel while it is queued. Only a failed message
(Put back, Dismiss) and one waiting for a sign-in say so. The bubble stays
until the chat's transcript shows the message with the same `clientSendId`.
On the desktop and ADE Web the bubble is `cloudQueuedMessageEnvelope`
(`CloudQueuedMessages.tsx`). It takes the send's own bubble's place at the
same time, so the row does not move. The working line says what the messages
wait for: "Waking the computer…", "Moving to the new computer…", "Changing
the computer's size…", "Starting a new computer…" or "Starting <agent>…". A
message that waits for a sign-in gets no working line. Only the failed
messages show in a banner. See
[iOS companion › Held messages](../sync-and-multi-device/ios-companion.md).

### Continue a chat whose computer is gone (fork-continue)

When the chat's computer was deleted, the send starts a server launch with
`continueChat { machineKey, chatId, kind }` on the same lane and branch. The
chat continues on the new computer in the same chat row.

- Claude, Codex and OpenCode chats, and Claude Code and Codex CLIs, restore
  from a native capsule the old computer saved at its last rest save (the
  idle step, `prepare-stop` or `save-for-rest`; `forkCapsules.ts`). The
  capsule holds only the provider's history; the lane's code comes from the
  lane backup. The other 10 providers replay the saved transcript.
- The new computer moves the saved chat to its own machine key
  (`POST /cloud/chats/:m/:c/move`); the queued messages move with it. A CLI's
  saved copy moves the same way (`POST /cloud/sessions/:m/:s/move`), sealed
  again under the new key, once the CLI runs there. Until then a send joins
  the continue launch; after it, a send to the old address finds the moved
  copy by its session id and reaches the new computer. A CLI restored from its
  capsule alone (its screen copy was pruned) has no copy to move.
- Messages a person sends while the new CLI starts are typed at the CLI's
  prompt (`typeIntoAgentCliWhenFree`), never sent as a chat's.
- The first message's `settings` go in `continueChat.settings` (chats only).
  The new computer applies them after the restore and before it sends the
  message. A second send that joins the launch carries no settings.
- A lane and chat has one continue launch at a time
  (`cloud_launches_continue`); a second send joins it.
- A failed, timed-out, cancelled or gone launch fails its messages with the
  launch's sentence, but a delivered message stays `delivered`. A Retry
  answers 409 `computer_busy` while a newer launch continues the chat.

### Refusals, the account and what is not built

- Every wake, start, send and create refusal is `{ code, message }` from
  `CLOUD_REFUSAL_CODES` (`contract.ts`). Clients show the server's message.
- The account keeps one API key store (vault kind `provider_api_key`), the
  Qwen key (a DashScope API key), the launch defaults and quick slots. Proxy
  logins go to the account as access-only copies. Personal chats stay on
  their machine.
- A browser can never read the vault (the push relay's browser allowlist).
  Web Passwords says to open ADE desktop or the iPhone.
- Git on a cloud computer: see [Stored data](#git-on-a-cloud-computer).
- Not built: web push, and a move of a lane or a chat onto ADE Cloud.

## Plans, hours and sizes

The server's `plans.ts` holds the plan rules, and `GET /cloud/account` sends
them in `catalog`, so no client keeps its own copy (`cloudCatalogOf` in
`shared/adeCloud.ts` fills gaps from an older server). The design is in
[docs/plans/ade-cloud-plans-and-disk.md](../../plans/ade-cloud-plans-and-disk.md).

Pricing v2 (owner, 2026-11-21; [docs/plans/pricing-v2-and-gravity.md](../../plans/pricing-v2-and-gravity.md)):

| Plan | Price | Hours a month | Cloud computers | Extra hours | Outside agents (ADE MCP) |
|---|---|---|---|---|---|
| Free | $0 | 50 | 2 | none: work stops | no |
| Plus | $5 | 100 | 3 | 4¢ an hour | yes |
| Pro | $20 | 600 | 10 | 4¢ an hour | yes |
| Max | $50 | 2,000 | 20 | 4¢ an hour | yes |

The ADE Cloud iPhone has no minutes of its own: it draws from these credits,
one a minute (below).

- **Hours are Medium-hours** (`catalog.hourUnit: "medium"`; integer
  thousandths in the API). Small computers never use hours, on every plan:
  Small is unlimited. Each size's rate is in `catalog.sizes[].multiplierMilli`.
- **Sizes:** Small (standard 2/4, 0, disk up to 12 GB), Medium (standard 4/8,
  1x, 20 GB), Large (full 4/8, 2.5x, 50 GB), X-Large (full 4/16, 4x, 100 GB).
  The other four shapes stay valid at rates in proportion to their cost
  (standard 4/16 1.65x, standard 4/32 2.9x, full 2/4 1.25x, full 4/32 7.25x)
  with the provider's disk limit (`catalog.sizes[].tier`, `label`,
  `diskMaxGb`).
- **No account-wide disk.** Each computer's disk grows to its size's
  `diskMaxGb` and no further (`disk_limit`, reason `tier_limit`). No extra
  disk is sold; `catalog.extraDiskCentsPer10GbMonth` and
  `CloudAccountState.extraDisk` are never sent, `disk.limitGb` is null, and
  `POST /cloud/billing/extra-disk` is no route (404). Builds before Pricing
  v2 read `plans[].diskGb` as the plan's shared disk and check their own
  grows against it, so it is sent as the plan's computers times the largest
  size's `diskMaxGb`: such a build never refuses a grow the server allows.
  The server never enforces it. The owner's daily report alarms on a free account holding more
  than 24 GB (`costReport.ts`).
- **The computer limit.** Every computer the account has counts, asleep,
  stopped or failed; a lane without a computer doesn't. A create, copy,
  new-lane launch or move into a new lane at the limit answers 403
  `computer_limit` with `CloudComputerLimitDetail` on the error (`planId`,
  `limit`, `total`, `lanes` least recently used first, `nextPlan`) and
  `message` = `computerLimitSentence` (`cloud.computer_limit_reached`). The
  count is part of `reserveComputer`'s one conditional insert, so concurrent
  creates can't pass it together. A reservation that never finished counts
  until it times out (15 minutes). A move's two computers count once in the
  account's count. A move's own check leaves its source out, so a move at
  the limit goes; another running move's source counts there (a source can
  outlive its move, and counts again after `MOVE_GRACE_MS`), so two moves at
  once can't leave the account over. An account over its plan is refused a
  move like a create (`over_plan_limits`). `past_due` keeps the bought plan's
  limit, and so does a downgrade waiting for the period end, until then (the
  person paid for it; the downgrade's cleanup handles going over at the
  switch), so the limit card offers the plan above the bought one.
  `computers.limit` on the account is the plan's limit, and
  `computers.nextPlan` (`CloudNextPlan`, from `nextPlanOffer`) the plan the
  limit card offers: the same object a refusal carries, so no client works it
  out.
- **Out of hours.** At 0 hours only sizes that use hours are refused (402
  `out_of_hours`) or stopped by the cron; Small keeps working, and its timed
  wake-ups stay. An account with no free plan (`free_refused_at` or
  `free_github_hold`) and no hours left runs nothing, Small included.
- **Outside agents on Free.** An ADE MCP request to start ADE Cloud work on
  the free plan (`past_due` included) answers 403 `outside_agent_free_plan`
  (`CLOUD_OUTSIDE_AGENT_FREE_MESSAGE`). It is read from lane metadata
  `ade_made_by_agent: "mcp"`, a launch's `madeBy: { kind: "agent", agent:
  "mcp" }`, or `origin: "mcp"` on a server copy, a move, a start or a sent
  message. The refusal is recorded (`refusal: "outside_agent_free"`).
- The account sends `plan: "free" | "paid"` for older builds and
  `planId: "free" | "plus" | "pro" | "max"`. A `past_due` account follows the
  free rules for hours and outside agents but keeps its computers.
- **ADE Cloud iPhone:** behind `CLOUD_PHONE_ACCESS`. With `beta`, only the
  accounts the owner added read `on`; everyone else reads `off` (never
  `soon`), and ADE shows no iPhone. The owner can add a tester by email
  before they sign up: the email waits in `cloud_phone_beta_pending`, and the
  account that first appears with it as a verified Clerk address takes it.
  The owner check (every 10 minutes) also asks Clerk about each waiting email
  about once an hour, ten a run, so a failed first read or an address
  verified later still lands.
- Computers sleep a few minutes after work stops (`CLOUD_IDLE_SLEEP_AFTER_MS`),
  so hours go only to real work.
- **Migration 0052** (`0052_pricing_v2.sql`) moves stored hours to
  Medium-hours: this period's Small use comes off `used_milli` (and off a
  past-due account's saved paid period), then every account, day and
  computer number halves, deleted computers too (Small's become 0). Apply it
  right before the Worker that reads it. Earned hours (referrals) stay as
  they are, now Medium-hours. The extra hours already reported to Stripe
  (`extra_reported_milli` and its daily-report snapshot) stay unhalved: the
  meter identifiers count from it, so halving it would bill those hours
  twice. Right after the Worker deploy, run the follow-up SQL in the
  migration's header once (computers made and free periods rolled by the old
  Worker in between keep old numbers).
- **Period terms** (migration 0033): hours are stored per period
  (`included_milli`). A free period that began on fewer hours than the free
  plan has now is raised on the next read (`raiseFreeHours`), except for an
  account refused the free plan or held by the GitHub rules.
- **Extra hours:** one flat Stripe metered price per plan
  (`STRIPE_EXTRA_HOURS_{PLUS,PRO,MAX}_PRICE_ID`) on one meter, 4¢ a
  Medium-hour on each. Checkout sells only the plan. The extra-hours item
  joins the subscription when the person first turns extra hours on
  (`ensureExtraHoursItem`), before the switch goes on, so no hour is
  reported with nothing to bill it. An upgrade moves the item to the new
  plan's price at once; a downgrade or an older price moves at the next
  renewal (`moveMeteredItems`, `cloud.metered_price_moved`).
- **Awake cap (hidden):** about 25 computers awake at once per account
  (`AWAKE_COMPUTER_CAP`), never shown as a plan limit. A wake waits up to 12 s
  for room, then answers 429 `too_many_awake`. A create, copy, resize wake or
  sign-in wake past it is refused at once (`cloud.awake_cap_reached`). The
  owner check reports `cloud.awake_cap_passed`.
- **"You're on Plus":** when the account moves to a higher paid plan, ADE says
  so once: a toast with the plan's hours, computers and renewal date, and a
  banner and a one-time glow on the ADE Cloud page. From Free it also names
  the free hours the paid period replaced. `cloudPlanMoment.ts` (localStorage
  per account; UserDefaults on the phone) keeps what this device last saw. It
  records `ade_feature_used` `cloud_plan`/`completed`.
- **Changing plans:** a move up applies now, charges the difference and keeps
  the hours used. A move down applies at the period end
  (`billing.nextPlanId`) and is never refused; over the cheaper plan's
  computers, the answer carries `cleanup`. Both go through
  `POST /cloud/billing/checkout {plan}`. The billing portal can not switch
  plans (`subscription_update` off), so ADE's switch always checks the
  cheaper plan's limits.
- **Not set up yet:** Pro and Max show only once their Stripe prices are
  set. Until then their catalog fields are absent and a checkout for them is
  a 400.
- **Timed wake-ups cancelled:** when the server deletes an account's timed
  wakes (0 hours: those of computers that use hours, or all of them on an
  account with no free plan), the person gets one email a period, and the
  account carries `timedWakesCancelled`.
- **Disk refusals:** a create, copy, move or grow past the size's disk
  answers `disk_limit` with `reason: "tier_limit"` and `message`.
- **A deleted computer leaves the machine list** (`forgetMachineStatements`):
  every close of a computer revokes its machine key and removes its machine
  row and project copies, unless another live computer carries the same key.
  The push relay's Activity for it stays (that purge needs the person's
  token).

Hours, plan, disk and billing come from `GET /cloud/account`
(`CloudAccountState`), read only while ADE Cloud shows (`useCloudMachines`).
At 0 hours the server refuses, and its sentence is what the person sees.

### Credits

One balance for everything ADE Cloud runs (owner, 2026-11-24). Every account
is on credits: the `cloud_credits` switch that rolled them out was turned to
`all` on 2026-11-25 and then removed (its stored row is ignored; the owner
log keeps the flip). Where this page says hours, the person sees credits.

A credit is the hour renamed, so no number changes: Free 50, Plus 100, Pro
600, Max 2,000 a month; a Small computer uses none, Medium 1 an hour, Large
2.5, X-Large 4. The ADE Cloud iPhone draws from the same balance at one credit
a minute (a Mac VM, later, the same). Past the plan, a paid plan's extra
credits are the extra-hours switch at 4¢ each, so an extra iPhone minute is
an extra credit. Free stops when the credits run out.

How the server counts it (`credits.ts`, `phones.ts`, migration 0059):

- A phone counts in credits when its row says so (`cloud_phones.credits = 1`):
  every phone saved since the flip. Rows from before it (`credits = 0`, the
  old iPhone minutes, gone since 2026-11-25) are history only: they charge
  nothing and count nothing.
- Its billed minutes go into the account's `used_milli` as its provider
  settles them, in the same write as the phone's row
  (`phoneCreditStatements`); `credited_milli` holds what is already in, so a
  repeated answer adds nothing. Every rule that reads hours (the limits,
  extra hours, earned hours, the period's end) counts them. A phone that ran
  across a period's turn adds nothing to the new period.
- What a phone may run is what the credits allow: the plan's left, then
  earned ones, then any minute while extra hours are on (two hours at most a
  phone), with running computers' time counted too. The ten-minute check
  moves its `stop_at` as computers use the balance.
- `CloudAccountState.credits` (`{ phoneMilliPerMinute }`) tells every surface
  to say credits; `phone.creditsUsedMilli` is the iPhone's share, for the
  split bar. The iPhone's own minute warnings stop; the hours emails cover
  the balance.

### A cheaper plan's limits

`planCleanup.ts`, migrations 0027 and 0032. ADE never removes a computer on
its own, and there is no grace period. Only the number of computers counts
(a move's two computers once, a reservation not at all). A `past_due`
account is never cleaned.

- **In ADE:** a move down that leaves too many computers
  (`downgradePreviews.plus` / `.pro`) opens `CloudPlanLimitsDialog.tsx`: "I'll
  clean up myself" (lists the oldest computers that would be enough), or "Let
  ADE handle it" (a "Save each lane's work first" switch, on by default, and
  the computers to free). The checkout carries the pick (`cleanup`,
  `CloudPlanCleanupPick`). The server checks that the pick fits before Stripe
  is asked (409 `cleanup_does_not_fit`, `cleanup_changed`,
  `cleanup_running`), records it (`plan_cleanup_choice_json`), and the minute
  cron (`runPlanCleanupPicks`) frees those computers at once. A request with
  no pick deletes nothing.
- **Outside ADE** (a portal cancel, a plan that ended): nothing is deleted. An
  account still over the plan gets 403 `over_plan_limits` on a new computer
  or copy, one email (`plan_over_told_at`), and a dashboard notice ("Choose
  what goes", `POST /cloud/billing/plan-cleanup`). A cancel that waits for the
  period end gets the email and the notice with the date.
- **Freeing one computer** keeps its lane (reason `plan_limit`) and chats.
  With the switch on (`push` in the contract), a computer goes only when
  every lane's work is saved (see [Lane backups at rest](#lane-backups-at-rest)):
  never woken, nothing pushed. One whose lanes are not all saved stays, and
  the person is told. With the switch off (a second confirm), it goes as it is. Afterwards an email names
  each computer and its branch, and the account carries `planCleanupDone`
  for 14 days. The phone shows the notices and sends the person to the
  desktop to pick.

### Idle cleanup

`idleCleanup.ts`, migration 0034, run by the minute cron. Idle means not awake
since the latest of `last_awake_at` (or creation), `hours_restored_at` and
`idle_kept_at`.

| Plan | Warning | Emails | Delete |
|---|---|---|---|
| Free | 2 days idle ("deleted in 1 day") | one more about 6 hours before | 3 days |
| Paid (and a `past_due` paid account) | 7 days idle ("deleted in 3 days") | at 2 days and 1 day before | 10 days |

- **Never sooner than promised.** The warning stores its delete time
  (`idle_deletes_at`). The delete waits for it and for the last email plus a
  gap (5 hours free, 20 hours paid). A plan change only moves the delete
  later, and an upgrade warns again at the new plan's time.
- **Never for** an account out of hours or without access, or a computer that
  is awake, pending, moving, updating, or has a timed wake booked
  (`cloud_wakes`). Use, hours coming back, a booked wake or **Keep it**
  (`POST /cloud/instances/:id/keep`, no wake, no hours) void the warning and
  restart the clock. Each claim checks again that none of these happened.
- **Emails.** A failed send keeps its claim, is reported
  (`cloud.idle_cleanup_email_failed`) and blocks nothing. A send the Worker
  can not make (no `RESEND_API_KEY`, no `CLERK_SECRET_KEY`, no address) logs
  `cloud.email_skipped`.
- **No wake, no push.** The computer is deleted as it rests, only when it
  rested with every lane's work saved (`saveBeforeDelete` in
  `planCleanup.ts`, [Lane backups at rest](#lane-backups-at-rest)). ADE never
  starts it to save, and never commits or pushes. The delete claim
  (`claimDelete`) also needs `backup_rest_at`, so a start during the run calls
  the delete off.
- **Held.** If a lane is not saved, the computer stays as it is
  (`idle_held_at`, `idle_held_reason`: "ADE couldn't save this lane's work."
  and the lanes' reasons). One email and a notice say why and when ADE reads
  again (`held.retryAt`); Sentry gets `cloud.idle_cleanup_not_saved` or
  `cloud.idle_cleanup_save_failed`. The read is a D1 read, never a wake: the
  computer's next real use saves it when it rests. Each read in a row that
  finds it not saved doubles the wait (1 to 14 days, `idle_held_count`). A
  failure after the save (`idle_failed_at`) waits 1 hour to 1 day.
- **Came back during the save.** Keep it, hours back, a booked wake, a start,
  command or sign-in through the server (`last_awake_at`), or a use the
  computer reports with `POST /cloud/instances/:id/use` (`last_active_at`)
  stops the delete, and a start clears `backup_rest_at` too. Once the delete
  runs, `/use` answers 409 `computer_deleting`.
- **The lane stays** as a lane without a computer (reason `idle_cleanup`),
  with its chats and its backup. The next message makes a new computer from
  the branch, and that computer puts the lane's saved work back.
- **Ignored files.** At its idle step, the computer reports what git ignores
  in its lanes (`ignored` on `POST /cloud/instances/:id/disk-usage`,
  `cloudIgnoredFiles.ts`): up to 10 paths, likely precious ones (`.env`, local
  databases) first, build folders only counted, `incomplete` on a timeout. The
  warning lists them.
- **Where it shows:** `account.dueForDeletion` (`CloudIdleCleanupEntry`) and
  `idleSaving` on `GET /cloud/instances`. The person sees a "Deleting soon"
  notice with **Keep it** on the dashboard (`CloudIdleCleanupNotice.tsx`),
  a dot on the chat header's cloud button, and a notice on the phone.
- **Once per step:** every warning, email and delete is claimed with a
  conditional update (`idle_claimed_at`), and each step writes a row to
  `cloud_idle_cleanup_log`.

### Lane backups at rest

Server `laneBackups.ts` (migration 0044), computer `cloudLaneBackup.ts`. Every
wake is use, and ADE never pushes on its own, so a computer saves each lane's
work that is not on GitHub before it rests, and a cleanup deletes it later
with no wake.

- **What.** For each lane on the computer (archived ones and the main
  checkout too): the commits GitHub has in no branch, and a snapshot commit
  of the uncommitted work (staged, unstaged, untracked files git does not
  ignore), made in a private copy of the index. It is one `git bundle` (the
  exact restore) and one `git diff --binary` patch (the download). Nothing is
  pushed, the snapshot is on no branch, and the temporary ref goes at once.
- **What GitHub has** (`readGithubBase`): the branch heads `git ls-remote`
  reads from GitHub at the save, not this clone's `origin/*` refs. A branch
  GitHub deleted (a squash merge) leaves its ref here, and a backup that
  left its commits out could not be restored. The set is in the
  fingerprint, so a change on GitHub makes the next save upload. When GitHub
  can't be reached, only its default branch counts. A restore that lacks a
  commit the backup builds on fetches `origin`, then that commit by id
  (`ensureBundleBase`).
- **When.** In every rest save (`cloudRestSave.ts`, before the copies): the
  idle step (90 s budget), `prepare-stop` (so the 0-hours stop too) and
  `save-for-rest`. Same work as the last backup (HEAD and the working-tree
  tree): nothing is sent. A lane whose work is all on GitHub deletes its
  backup.
- **The report.** After each save, `POST /cloud/backups/report` names every
  lane: `clean`, `saved`, `unchanged`, `failed` or `too_large`. It is
  `current` only when the save read every project and every lane is clean or
  has its backup on the server with the same fingerprint.
- **Rest with it.** The computer's own sleep request names the report
  (`POST .../idle {backupReportId}`), and only after a save with no use since.
  The 0-hours stop names the report its prepare-stop made. Then
  `backup_rest_at` is set. Any start clears it (`clearBackupRestStatement`).
  The provider's own 5-minute sleep sets nothing, so such a computer is kept.
- **Cleanups.** Idle, plan, project delete and automation run end all use
  `saveBeforeDelete`: a resting computer goes only with `backup_rest_at`; an
  awake one is saved in place (`prepare-stop`, `save-for-rest --capsules`)
  and goes when that report is current. Else it stays with "ADE couldn't save
  this lane's work." An image older than lane backups never reports, so it
  stays until its next real wake updates it.
- **Freeze before a delete.** Every cleanup but the idle one runs
  `prepare-stop --for-delete` on an awake computer
  (`CLOUD_COMPUTER_COMMANDS.prepareForDelete`). From the start of that
  prepare, the computer refuses new chat turns (send, steer, rerun,
  recovery; a scheduled wake waits), new terminals and agent CLIs, and remote
  work, with "This ADE Cloud computer is being removed. …"
  (`cloudDeleteFreeze.ts`). So nothing is written after the save and lost
  with the delete. The freeze ends when the prepare is not confirmed, when
  the server keeps the computer (`ade cloud unfreeze`, `unfreezeComputer`),
  or after 10 minutes. The idle cleanup keeps its own rule: a person's use
  calls its delete off (`/use`).
- **Restore.** A lane launch on a cloud computer (`chatLaunchService.ts`,
  `cloudLaneRestoreHook.ts`): a branch never pushed is made locally from the
  backup and imported with `publishUpstream: false`; once the lane exists,
  the newest backup of the lane from another machine is applied
  (`applyHandoffGitBundle`) if the lane lacks it. A lane with its own
  uncommitted work, commits past the backup, or a branch that went another
  way is left as it is; the launch card says so and the backup stays. The
  uncommitted work comes back as unstaged changes: the backup does not keep
  which files were staged.
- **Lifetime.** A backup goes when a newer one of the lane replaces it, when
  the lane's work is on GitHub (the computer that restored it deletes it),
  with the lane (a delete with no `keepLane`, or Forget lane), with the
  account, and when the person deletes it (`POST .../forget`, any app, the
  web too; refused while a computer still holds that machine key). A
  project delete keeps it: it is the lane's only copy. "Restored" names the
  backup by fingerprint, so a newer one is never marked by mistake. An
  upload nobody commits in 30 minutes loses its parts (the minute cron's
  sweep), and each part must fit the size the upload declared for its kind.
- **Get this lane's work** (`CloudLaneSavedWork.tsx`, iPhone
  `CloudSavedWorkRow`): on a lane without a computer and on a computer that
  can't wake (0 hours on a size that uses hours). Download patch everywhere; on
  the desktop, "Open in a new lane here" puts the work on a new
  `ade-saved/...` branch of a clone on this computer (the uncommitted part as
  its last commit) and makes a lane of it, with no push. Settings › ADE
  Cloud lists, under "Saved lane work", the saved work no lane row shows
  (a deleted project's lanes), with Delete in its ⋯ menu.
- **Security.** Sealed with the account's key, the additional data naming
  user, machine key, lane, upload, kind and part. Encryption at rest, not
  end-to-end: the server can open it to give it back. Only a computer with
  that machine key writes; a browser reads only the list and the patch;
  another account gets 404. Ignored files (`.env` when ignored) stay out;
  untracked files git does not ignore go in, as the person's work. Git LFS
  files and submodule changes can't travel: that lane fails its backup and
  the computer is kept. Caps: 50 MB a lane, 1 GB an account.

### Disk grows

A disk only grows, through `resize` with `disk`: by itself near full while
idle (`ade-cli/src/services/power/cloudDiskGrow.ts`, `origin: "auto"`), from
the Android pane, or by an agent on that computer. The first disk is 4 GB; a
move keeps the old disk.

- **Android:** a first emulator start needs about 7.2 GB free, so the brain
  refuses it up front on a cloud computer (`ANDROID_LOW_DISK`,
  `androidDiskGuard.ts`). The pane offers **Grow the disk** to the smallest
  4 GB step that fits (`AndroidCloudComputerNotice.tsx`), within the size's
  `diskMaxGb` and the plan's rules. The emulator grows the disk the same way
  when it is short (`androidEmulatorLifecycle.ts`).
- **An agent:** `ade cloud resize --free <GB>` (or `--disk <GB>`,
  `--reason "…"`) runs `cloud.grow_disk` (`cloudAgentActions.ts`), then
  `growToFit` of the computer's own grower (`cloudDiskGrowHost.ts`). It grows
  only the computer it runs on. The fit is `cloudDiskGrowFit`
  (`shared/cloudDiskGrowRules.ts`):
  - Inside the size's disk maximum (`diskMaxGb`), it grows with no card. The
    hours check does not apply.
  - Past it, the server refuses (`tier_limit`): ADE Cloud sells no extra
    disk, so the way out is a bigger size. `growToFit` reads the fit again
    before each resize and retry, at most 3 rounds.
- **The restart:** the grow waits for idle. Chats and ADE's own agent CLIs do
  not hold it; they continue after the restart whatever "Continue chats after
  restarts" says (cause `disk_grow`, `brainUnplannedRestart.ts`). A terminal
  command or a hand-started agent CLI (`shell_agent_cli`) holds it; the `ade`
  command that asked for it (`disk_grow_command`) does not. A Devin CLI can't
  be reopened.
- **The chat cards** (`shared/cloudDiskGrowCard.ts`, posted by the brain):
  "growing" before the restart, and the new disk
  after it. `$ADE_HOME/cloud/disk-grow.json` keeps what was told. After the
  restart, the cards are retried after 10 s, then up to 5 times every 30 s.

### Sponsored cards and the Index (Free, behind a switch)

Free is ad-supported through Gravity (`apps/account-directory/src/cloud/gravity.ts`;
who is told, asked and how a no holds in `sponsoredConsent.ts`; the ad switches in
`sponsoredSwitch.ts`; what Free's Small costs, and its tripwire, in `sponsoredSmall.ts`;
Gravity's answer read into a card in `gravityAd.ts`; the clean-up, the A/B scoreboard and
the daily report's lines in `sponsoredReport.ts`;
migrations `0054`, `0055`, `0056`, `0062`, `0064`, `0065`, `0066`). The account server decides everything and holds the partner
key (`GRAVITY_API_KEY`, a Worker secret): the instant switch `gravity_ads` (`off` |
`testers` | `all`, starts `off`; `testers` reads `cloud_sponsored_testers`), held
under the deploy variable `GRAVITY_ADS` (production `all`; `off` there is a hard
off), test ads until the `gravity_live` switch is on under `GRAVITY_LIVE=1`, the
plan (Free only, `past_due` included as paid, or the account test tool's plan), the country (`GRAVITY_COUNTRIES`, from Cloudflare), the account's answer
(`cloud_sponsored_consent`, one per account, so every machine agrees), and that
the chat runs on one of the account's own live ADE Cloud computers and is not a
subagent's (`cloud_chat_copies`). Chats on the person's own machine never get a
card, whatever the plan.

- **Formats:** the `gravity_format` switch (`below_reply` default,
  `above_prompt`, `inline`, or `split` for an A/B test; migration `0061`
  keeps an owner's choice per account) names where
  an account's card shows: under the finished reply, docked above the prompt
  box (the latest reply's card, kept while the next reply runs), or at the
  end of the reply, inside it. The state carries `format`;
  the ad request says the format it draws in and its surface (`desktop`,
  `web`, `ios`), and the server sends Gravity the registered placement
  `ade-<surface>-<below|above-prompt|inline>` (`below_response`,
  `bottom_page`, `inline_response`; inline asks for at most 120 characters),
  so Gravity reports each surface and format apart. The one-time question
  always shows under the reply. Desktop draws the other two through the
  pane's outlets (`sponsoredOutlets.tsx`); a pane without them gets the card
  under the reply.
- **Format A/B test:** under `split`, an account is given a format the first
  time ads reach it, by a hash of its id and the `gravity_format_split`
  weights (default `70-20-10`: under the reply, inline, above the prompt box),
  and keeps it (`cloud_sponsored_formats`, source `split`; an owner's
  `ad-format` choice, source `owner`, wins). Each ad request, fill and hide
  is counted per format in `cloud_sponsored_days` (`ad_request:<format>`,
  `ad_fill:<format>`, `ad_hide:<format>`); a hide (`POST
  /cloud/sponsored/hide`) counts once per reply. `GET /cloud/owner/ab`
  (`cloud-owner.mjs ab`) joins those counts with Gravity's per-placement
  views, clicks and revenue, and the daily report has a formats line.
- **Reply card** (`renderer/components/chat/sponsored/`, iOS
  `WorkSponsoredCards.swift`): at most one per finished reply, asked for
  only while the pane and that spot are on screen. The server claims the reply
  before it asks Gravity, so two screens make one request, and keeps the card's
  fields (never chat text) for a day. Nothing rewards a view or a click. One
  sponsored unit per window (`sponsoredOnScreen.ts`), and the tray hides its
  upgrade button beside it.
- **Gravity's renderer** (Gravity's recommendation, 2026-11-25): the ad
  request names the client's renderer (`renderer`: `web1` for
  `@gravity-ai/ui` on desktop and web, `psp1` for Gravity's Swift SDK on the
  iPhone and iPad), and only then does the server ask Gravity for its design
  (`supportsSpec`; never a frame). The answer's `gravity` is Gravity's ad in
  its own field names, design (`renderer_spec`) included; the client hands it
  to `GravityAd` (`SponsoredGravityCard.tsx`, loaded only when a card shows)
  or `SpecAdView`, which draws Gravity's design in ADE's colors and sends the
  view link and the `measured`/`viewable` beacons itself. ADE keeps the place,
  the hide button and its link rule (every click opens one of Gravity's own
  links in the browser). For `web1` the server inlines the advertiser's icon
  as a `data:` image (the desktop page loads images only from listed hosts;
  `rendererCsp.ts` and the web client's `_headers` list Gravity's hosts for
  the beacons). An older client sends no `renderer`, gets no design, and
  draws ADE's own card from the plain fields, sending the view link itself
  once half the card is on screen.
- **Index pick** (`ade cloud recommend --need "…"`, `cloudAgentActions.ts`): an
  agent on an ADE Cloud computer asks for a service the person needs. Refused
  for a person, ADE MCP, automation and subagent chats, and while nobody has a
  chat or agent CLI of that computer open (`cloud_sponsored_viewers`, from
  `seen` every 4 minutes). The Index has no test mode, so before go-live only
  testers reach it, and only from a listed country (`GRAVITY_COUNTRIES`, read
  from the viewer's last `seen`; a tester abroad gets `reason: "country"`,
  where test ads still show). A chat gets a `sponsored_pick` card that installs nothing;
  a CLI session gets text the agent repeats once, starting with "Sponsored:".
- **Limits and report:** per account per day (120 ads, 20 Index searches) and
  an optional ceiling on Gravity's live requests (`GRAVITY_DAILY_LIMIT`, unset
  since the contract dropped the daily limit), each taken in one
  conditional write before the request (`cloud_sponsored_days`). The daily cost
  report prints the counts and Gravity's revenue against the day's free-plan
  cost. Minutes 23 and 53 of every hour prune answers and viewer rows (IP,
  user agent, device) older than a day, for every account, whatever the switch.
- **iPhone tracking (ATT):** the iPhone app shows Apple's App Tracking
  Transparency prompt once, right before its first card ask, and sends its
  answer as `device.tracking` (`seen` too, kept on the viewer row, migration
  `0055`). The server sends Gravity the hashed email from an iOS device only
  when the answer is `authorized`; anything else, or nothing from an older app,
  still asks for the card without it. Desktop and web always send it.
- **Small needs cards on Free** (part of the ad switch, no switch of its
  own): a Free account the ad switch reaches runs Small without hours only
  in the US (`SMALL_FREE_COUNTRY`): while it said yes and someone opened one
  of its ADE Cloud chats or terminals from the US in the last 7 days
  (`src/cloud/sponsoredSmall.ts`: `SMALL_FREE_LOOK_MS`, plus the hour
  `looked_at` may trail the last look; `cloud_sponsored_consent.looked_at`,
  set by a yes from the US and refreshed by `/cloud/sponsored/seen` from the
  US at most hourly, never moved back, migration `0065`). A yes from
  elsewhere keeps the US look the row holds. Cards still show in Gravity's
  other countries, but Small uses credits there once the week since the
  last US look is over. Past the week (away, or a yes given once through a
  VPN) Small uses credits until the next such look; the minute tick re-rates
  the lapse, and the apps read the account again after an answer or a look
  that may have moved Small's rate. The account state, read from where the
  person is, says `smallNeedsLook` (in the US) or `smallOutsideUS`
  (elsewhere, once no US look keeps Small free; sent instead of
  `smallNeedsCards`, so the question offers no free Small there). A no or no answer runs Small at half a Medium-hour an hour
  (`SMALL_NO_CARDS_RATE_MILLI`, set on the computer row by `syncSmallRates`; the
  account's catalog shows Small at that rate). A no is asked again two weeks
  later (`SPONSORED_REASK_MS`), and at once when it came before the ad switch
  last changed; until answered it still counts as a no.
- **Small look tripwire** (watches, never refuses): a person-approved cloud
  computer holds a real session, so a look sent from it keeps Small free like
  one from a phone, and so does a yes from the US. Each computer's activity
  report saves its network (`cloud_computers.net_asn`, Cloudflare's `cf.asn`)
  and each look or US yes that moves `looked_at` saves its network
  (`cloud_sponsored_consent.looked_asn`, migration `0066`; a no clears it with
  `looked_at`; kept only for Free, and never a privacy relay's network such
  as Cloudflare's, Akamai's or Fastly's). Each computer's launch join also
  saves its network once (`cloud_computers.join_asn`): the join is the
  computer's own, made during setup with a one-time code no person holds. ADE
  Cloud's network is the account's own computers' (activity reports use the
  account's own sign-in, so they name only that account's computers), or one an
  ADE Cloud computer joined from in the last 30 days (`JOINED_NETWORK_MS`), so
  an account rewriting its own computers' network hides nothing and no account
  can make someone's home network count. A look or yes from it, while the account has a live Small,
  sends the owner one alert per account per week (`small_cloud_look`: an
  email, a Sentry `cloud.abuse` issue, a `cloud_abuse_events` row and the
  `ade_cloud_safety` step) and adds a line to the daily report while that look
  is what keeps Small free (`smallCloudLookAlarms`). It sees only computers
  that send activity reports, and only the latest look's network.
- **Start on in the US:** in `GRAVITY_DEFAULT_ON_COUNTRIES` (default `US`,
  empty asks everywhere; California, `ASK_FIRST_REGIONS` by Cloudflare's
  `regionCode`, is asked, and so is an unknown US state) the state carries
  `startsOn` instead of asking: the
  chat's card (and Settings › ADE Cloud) is the notice that cards are on, with
  Got it and Turn off. Shown, it is saved as `PUT /cloud/sponsored/consent
  {consent: "notice"}`, a yes with `source = notice` (migration `0062`) that
  holds only from those countries and never from a request with
  `Sec-GPC: 1`. The notice's reply asks for no card. A no given there holds
  12 months (`SPONSORED_OPT_OUT_HOLD_MS`); elsewhere the two-week re-ask
  applies. A notice never overwrites an answer that holds. After a no in
  the US, or with `Sec-GPC: 1` from the US, the state carries `confirmYes`:
  the question's yes and Settings' switch confirm a second time
  (California's two-step opt-in), and `PUT` refuses an unconfirmed yes
  (409 `sponsored_confirm`). Elsewhere a yes after a no is one click.
- **Global Privacy Control:** `Sec-GPC: 1` from the US opts the whole
  account out (CCPA §7025): any request that reads or reports sponsored
  state turns no answer, or a yes not given from such a browser, into a
  no (`source = gpc`, held 12 months like any US no), deletes the viewer
  rows and moves Small's rate, so no notice starts cards on another
  device. The state then says `gpcOff`, and Settings says why. A yes
  given from that browser, past the second confirm, is saved with
  `gpc = 1` (migration `0064`) and holds there. The US rules (the
  12-month hold, the second confirm, GPC) follow the law, not
  `GRAVITY_DEFAULT_ON_COUNTRIES` (`OPT_OUT_LAW_COUNTRIES` in
  `sponsoredConsent.ts`).
  A look at a chat keeps its state beside its country (`region`, migration
  `0064`), so the Index checks a notice's yes where the person last looked.
  Details:
  [account-test-tool.md](account-test-tool.md#where-cards-start-on).
- **Testers abroad:** while ads are test ads (`gravity_live` off), an account
  on the testers list gets cards from any country; everyone else still needs
  `GRAVITY_COUNTRIES`. Real ads keep the country check for everyone, and so
  does the Index: it has no test mode, so its picks are always real.
- **Testing:** the account test tool flips these switches and has an account
  act as any plan, instantly, without touching Stripe
  ([account-test-tool.md](account-test-tool.md)).

## Referrals and the free plan

The server enforces all of it (`referrals.ts`, `freePlan.ts`,
`freePlanGithub.ts`, migrations `0026` and `0035`); clients only show it. Every
route is behind the `/cloud` access gate except the website's invite lookup.

### Earned hours

- `cloud_earned_hours` is append-only: one grant per (account, reason,
  reference), never removed, never expiring. The account row keeps
  `earned_granted_milli` and `earned_used_milli`.
- A period uses the plan's hours, then earned hours, then paid extra hours. It
  draws earned hours only past the plan's hours and the extra hours billed or
  owed (`earnedDrawMilli`), so nothing is both billed and drawn. The draw
  settles when the period ends (`startFreshPeriod`).
- `isOutOfHours` is true only when the plan's and earned hours are both gone.
  The 0-hours stop, the wake refusal and the 80/95% warnings
  (`allowancePercentUsed`) follow it. The meter bills `extraUsedMilli`.
- A failed payment keeps what it drew (`past_due_earned_milli`); a paid
  invoice in the same period gives it back.
- The account read carries `earnedHours` (`leftMilli`, `usedThisPeriodMilli`,
  `grantedMilli`); `hours` stays the plan's own hours.

### One free plan per computer

- The desktop and a brain send `x-ade-computer` on every `/cloud` call:
  SHA-256 of `ade-cloud-free-plan-computer-v1:` plus the OS machine id
  (`hardwareAnchor.ts`), or `unreadable`. An ADE Cloud computer sends none.
  The server keeps only an HMAC of it (key from `CLOUD_CHAT_MASTER_KEY`).
- A create, move, copy or wake on free rules claims the computer for the
  account (`cloud_free_plan_claims`, both keys unique). A read never claims.
- An account with no claim, seen on a computer another account claimed, is
  refused (`free_refused_at`): 0 free hours everywhere until it claims a
  computer of its own. Paid, earned and extra hours are untouched.
- An account holds one claim. A reinstall is the same claim. A phone-only or
  MCP-only account claims nothing (`unclaimed_use`); an unreadable id claims
  nothing (`id_unreadable`). Paid accounts claim nothing.
- The account read carries `freePlan: { state, sentence }`. Account deletion
  keeps the claim.

### One free plan per GitHub account

- Free hours need a connected GitHub account at least 30 days old
  (`CLOUD_FREE_GITHUB_MIN_AGE_MS`). GitHub's `created_at` is read once into
  `github_account_ages`, with a backoff retry (5 minutes to 6 hours).
- `cloud_free_github_claims` is unique on the GitHub user and the ADE account.
  The settle runs with the computer claim, only while the GitHub App is set.
- A hold (`free_github_hold`: `no_github`, `github_too_new`, `github_used`,
  `github_checking`) keeps `included_milli` at 0. Accounts that used ADE Cloud
  before the rule are `free_github_exempt`.
- A too-new GitHub account can start with a card saved at no charge
  (`POST /cloud/billing/free-unlock`, a Stripe setup Checkout;
  `free_card_unlocked_at`).
- The account read carries `freePlan.github`. Desktop, CLI, the lane-start
  refusal and the `ade-cloud` skill show it; the phone states it without the
  card. PostHog: `ade_cloud_free_plan` steps `github_*`,
  `card_unlock_started`, `card_unlocked`.

### Abuse lines in the daily report

`abuseSignals.ts`. A brain reports 2 hours at 85% CPU or more with no agent
work (`cloudSustainedCpu.ts`, `POST /cloud/instances/:id/cpu-report`, again
every 6 hours). Five or more sign-ups from one address in an hour make a line
(`SIGNUP_BURST_PER_IP_HOUR`); the address is kept only as an HMAC for 7 days
(`cloud_signup_ips`).

### Referrals

- One invite code per account (`cloud_invite_codes`, 8 characters without
  0/O/1/I/L), link `https://ade-app.dev/invite/<CODE>`.
- `POST /cloud/referrals/redeem { code }` takes the link, the `ade://` link or
  the code, within 30 days of the friend's ADE account, once, never the
  account's own code, never a code whose owner lacks access. Refusals answer
  `invite_refused` with a `reason` (`CloudInviteRefusalReason`).
- The reward, 20 hours to both, is paid when the friend's first chat runs on
  an ADE Cloud computer (its first saved part, `chats.ts`). One batch moves the
  referral out of `pending`, so it pays once; the referrer's cap is 10 rewards.
  No reward (`refused`) when the two accounts shared a computer
  (`same_computer`) or the friend was refused the free plan
  (`friend_computer_used`).
- The account read carries `referral` (`CloudReferralSummary`);
  `GET /cloud/referrals` answers it alone.
- **Website:** `/invite/<CODE>` (`apps/web/src/app/pages/InvitePage.tsx`) asks
  `GET /invites/<CODE>` (public, 30 a minute per address) for the inviter's
  first name, and shows the downloads and "Open in ADE"
  (`ade://invite/<CODE>`). The code never reaches analytics, and replay masks
  the page.
- **Desktop, CLI, phone:** `window.ade.cloud.redeemInvite(code)`;
  `ade://invite/<CODE>` opens Settings › Account with the code filled (the log
  keeps `ade://invite/<redacted>`). The `cloud` actions `referral` and
  `invite_redeem` (user-only: an agent, an ADE MCP app and the CLI are
  refused). `ade cloud invite` prints the link and the summary.

### Analytics and alerts

- PostHog: `ade_cloud_referral` (`code_entered`, `reward_paid`,
  `reward_refused`, `cap_reached`) and `ade_cloud_free_plan` (`claimed`,
  `restored`, `refused`, `id_unreadable`, `unclaimed_use`). Never a code, a
  link, an email or another account's id.
- Sentry (tags `area: cloud-referrals`, `cloud-free-plan`):
  `cloud.free_plan.many_accounts_one_computer`, `cloud.referral.cap_reached_fast`,
  `cloud.referral.many_friends_one_computer`, and the failures
  `cloud.free_plan.settle_failed`, `cloud.referral.reward_failed`,
  `cloud.referral.summary_failed`, `cloud.referral.clerk_read_failed`. The
  desktop's names (feature `cloud_invite`) are in `productAnalyticsPolicy.ts`.

## Safety

The block list, the one-card-per-free-account rule, the kill switch
(`CLOUD_CREATES_PAUSED`), the hourly limits, the owner's cap on free use and
the owner alerts are in
[`apps/account-directory/README.md`](../../../apps/account-directory/README.md#ade-cloud-safety).
The owner blocks an account with `POST /cloud/owner/block`: its computers lose
the internet (`deny-all`) and stop, the subscription is cancelled with no
refund, and its GitHub account and cards go on the block list.

A blocked account is read-only. It can read and export its saved chats and
use every GET route in `CLOUD_BLOCKED_READ_ROUTES` (`blockedMayRead` in
`routes.ts`). Every other `/cloud` route answers `403 account_blocked`.
`GET /cloud/access` answers `{ enabled: false, readOnly: true, reason }`, and
`GET /cloud/account` carries `blocked: true`. Clients show the server's
sentence.

## Stored data

### Sign-ins in the account vault

- Kind `integration`, scope `all`: `cloud-budget` (the agent limits),
  `cloud-key-<provider>` (the saved ADE Cloud keys) and `cloud-claude-token`
  (an older Claude item, adopted as `claude-pass/legacy`).
- Kind `provider_login`: the provider sign-ins, `<provider>/<origin>.<slot>`
  (the origin is 12 hex of the computer's machine key), and the Claude passes,
  `claude-pass/<12 hex>`. The relay caps one value at 16,000 characters.
- The account setting `providerLogins.cloud` says which sign-in ADE Cloud uses
  for each provider, which are off, and the Claude smart balance switch.
- A computer keeps marks only, never a token: `<ADE home>/provider-logins/`
  `state.json` and `applied.json`, and `claude-pass-use.json`.
- A new cloud computer gets no sign-in in its env. Its brain signs in to the
  account and takes every sign-in from the vault (`providerLoginApplyPass.ts`,
  `claudePassSync.ts`). The create route keeps only a version-shaped
  `ADE_MIN_VERSION` from a client's env and drops the rest (`CLIENT_ENV` in
  `cloud/routes.ts`, names logged as `cloud.create_env_dropped`). An older
  computer with keys in its env has them taken out at the first apply.

Sign-ins also come down to the person's own computers
(`providerLoginApplyPass.ts`):

- A computer with no sign-in of its own for a provider takes the one the
  account uses (another computer's copy, never its own back).
- It never replaces a local sign-in (`provider_login.down_kept_local`), never
  writes a saved key or an env variable, and stays off a place the person
  signed out of there until they sign in there again.
- Claude never comes down (ADE Cloud uses a pass), nor does Copilot's GitHub
  CLI login.
- What the sync down wrote is replaced only while it is as ADE wrote it. It
  leaves on ADE sign-out.

OpenCode's sign-in (`providerLoginCarry.ts`, `openCodeCarryWriter.ts`):

- Only the opencode.ai sign-in travels (OpenCode Go and Zen ride it): the
  `credential` row with `integration_id = 'opencode'` in ADE's own OpenCode
  store, the one in use. Other sign-ins made in OpenCode stay on the computer.
  An Anthropic login held by OpenCode is never copied (the Claude rule), and
  an API key pasted into OpenCode stays too (ADE's saved keys carry keys).
- Capture never reads the store file (it is large and changes on every
  turn). It asks SQLite for the row's id and last write only when the file or
  its WAL moved, and reads the row when that changed.
- Apply writes the row through OpenCode's own `credential` API on the shared
  server, never by SQL, and makes it the one in use. A copy is access-only
  (the refresh token is empty), on ADE Cloud and on the person's other
  computers alike. Each copy is a new row (`cred_ade…`): it is written and
  made the one in use first, then the copy before is removed, so a failed
  write never leaves no sign-in. A copy before that cannot be removed then
  stays on the entry (`openCodeLeft`) and is tried again by the next copy and
  by sign-out. ADE never downloads OpenCode only to write a
  sign-in; it waits until OpenCode is there. On sign-out ADE removes its row
  with OpenCode's API, or with one SQL delete when OpenCode is gone. A
  removal that fails (the store is busy) stays in `applied.json`, and the
  next account's first pass tries it again (all providers). A copy OpenCode
  took while its store could not be read back is tracked by what was sent.
- A copy is replaced only while it is still the row OpenCode uses and nobody
  changed it. A sign-in made in OpenCode on that computer afterwards is a new
  row in use, so the copy stops there.
- The computer that signed in renews it ahead: 270 s before expiry, ADE asks
  its OpenCode server to load a new, empty folder, which makes OpenCode 2.0.29
  renew the login (it renews only inside the last 5 minutes). No model
  request. The renewed row is pushed by the next pass. A renewal timer more
  than 24.8 days out (setTimeout's limit) wakes early and waits again; it
  does not count as a try.
- An access-only copy's OpenCode asks to renew in the last 5 minutes and is
  refused; the row stays and works until its own expiry, by which time the
  renewed copy has come down. A route (`--via opencode-go`) reads the access
  token straight from the store and works until that expiry.

The account's cards show one card per account for copies from several
computers ("From 3 computers"), and a pick uses the freshest usable copy of
that account (`cloudPlacePicks`). A computer that signs out takes its copy out
of the account after two passes 60 s apart. A pick of that copy first moves to
the freshest other copy of the same account (`sameAccountCopyFor`,
`provider_login.pick_moved`); with none, the pick stays and the card says the
sign-in was signed out where it came from. The account is the email
(`accountIdentityOf`); for Codex, the email and the workspace id.

### Git on a cloud computer

- Before a lane's computer is made, `cloudGitPreflight`
  (`cloudGitCredential.ts`, `github/accountGithubTokenItem.ts`) looks for a
  GitHub sign-in git can use: `integration/github` (a pasted token) or
  `integration/github-cli` (a `gh` login that `githubGhAccountSync.ts` copies
  to the account). A private repository with none is refused with the way
  out. A public one goes on. No answer from GitHub goes on with a warning
  (`cloud.warning`). The composer of a new ADE Cloud lane reads the same check
  (`window.ade.cloud.gitPreflight`, `useAdeCloudDraft.ts`) and turns Send off
  on a refusal.
- The clone passes its auth header through Git's config environment, so no
  token stays in `.git/config`.
- On an ADE Cloud computer only, the clone's config gets an empty
  `credential.https://github.com.helper` and then
  `!'<launcher>' git credential`. The launcher is the ADE the brain runs, else
  the ADE home's `bin/ade`, else `/usr/local/bin/ade`. A plain `git push` in a
  terminal there signs in with ADE's token.
- A person's own computer records no helper: ADE passes the token per command.
  A clone sent to a computer with no GitHub sign-in says so
  (`githubSignInMissing`), and the window warns that fetch and push there
  will not sign in.
- Commits use the account's GitHub noreply identity, else
  `ADE Cloud <cloud@users.noreply.ade-app.dev>` (`cloudGitIdentity.ts`), never
  over a value a person set.

### Metadata, request ids and launch records

- Machine metadata keys are `ade_*` (`ade_machine_key`, `ade_request_id`,
  `ade_made_by_chat`, `ade_disk_full`, `ade_disk_full_reason`, and the lane
  keys `ade_lane_id`, `ade_lane_name`, `ade_project_origin` in
  `cloudLaneLaunch.ts`), plus `created_by: ade`. A copy drops `ade_ready*`.
- A create or copy that repeats a request id of this account gets the
  computer that request made (200), before any check. A reservation with no
  computer yet answers 409 `create_in_progress`; one older than 15 minutes is
  released. The reserve insert allows one live row per account and request id.
- The desktop keeps one record per lane launch in
  `<userData>/cloud-lane-launches/<launchId>.json` until its cleanup is done;
  a brain keeps its own in `<machine ADE folder>/cloud-lane-launches/`.

## From the CLI and agents

### The status read

`cloud.status` (`ade cloud status`, or `ade cloud` alone) answers the whole
account from one computer list and one account read. It wakes and spends
nothing, and never throws for "no ADE Cloud".

- `canStartLane {ok, reason, code}`: the composer's sentence
  (`cloudLaneStartBlock`: out of hours, all computers in use, disk full), the
  access sentence (`NO_PROVIDER_SENTENCE`), or that ADE couldn't read the plan.
- `plan`, `hours`, `disk`, `computers` (in use, awake, the most at once).
- `lanes`: every computer, lanes first, with the lane name and origin from its
  metadata, size, rate, state, disk and full-disk sentence, and `deletesAt`.
  `lastUsedAt` is null.
- `sizes` and `defaultSize` (the account setting `cloudDefaultTier`, else
  Small).
- `agents`: the agent limits, today's new computers by agents, how many are
  left, and the sizes unwatched agents may pick.

`list`, `hours` and `limits` are narrow views of the same reads. The text puts
"No new lane on ADE Cloud now: <reason>" first on a no. ADE MCP read access,
the phone (`cloud.read`) and a brain with no project can read it.

### A new lane

**The commands.**

- `ade chat create --machine cloud [--size small|medium|large|xlarge] --prompt "…"`
  makes one computer for one new lane, gets the repository there and starts
  the chat there. With no `--size`, the brain uses the saved size for new
  lanes (`CLOUD_DEFAULT_TIER_SETTING_KEY`), else Small; a default Small that
  runs out of memory in setup moves to Medium once (see "A launch that needs
  more memory").
- `ade chat launch --machine cloud` takes the same flags and `chat launch`'s
  lane flags (`--from`, `--lane-name`, `--existing-branch`). The lane starts
  from the pushed branch: `--on uncommitted`, `--on local`, `--notify-url`,
  `--lane`, `--project` and `--clone` are refused. A Linear issue must be the
  whole issue (`--linear-issue-json`), because the computer can not look up a
  bare id.
- `ade lanes create --machine cloud [--size …] [--launch-id <id>] --name <n>`
  makes the lane alone (a launch of kind `lane`: computer, join, clone, fetch,
  checkout, environment; no agent stage). It takes `--from`, `--branch-name`,
  `--existing-branch`, `--template` and a whole Linear issue, and refuses
  `--description` and `--no-template`.
- A CLI session can start a new ADE Cloud lane only from the app (pick CLI,
  then Run on: ADE Cloud). The computer's brain parks the launch at
  `awaiting-client`, and the launching window starts the CLI there through
  `snapshot.cloud.binding`. `cloud.lane_launch` refuses kind `cli`, because a
  brain has no window.

**Links and names.**

- The computer's brain applies `laneConfig.linearIssue`, `githubIssue` and
  `jiraIssue` to the new lane, and links an existing-branch lane to
  `laneConfig.pullRequestUrl` (`prService.linkToLane`) after the checkout. A
  failed PR link is a warning on the checkout stage.
- A new lane is named as a local lane: the name from the prompt and a
  placeholder branch first, then the AI name for the lane and its branch
  (`cloudLaneConfig` keeps `autoName`; a chosen name stays). The desktop
  follows a finished launch until the name comes.
- Renames: the computer's brain writes the lane's new name to `ade_lane_name`
  for the lane its computer was made for (`cloudLaneNameSync.ts`), and renames
  the computer and its account machine (`normalizeCloudMachineName`, 60
  characters). The server checks both are the account's and cleans each name
  (`boundedDisplayText`). The writes wake nothing; a failed one is tried twice
  more with a doubling wait.

**Who may start one.**

- **The CTO:** `createLane` and `spawnChat` take `machine: "cloud"` and
  `size`. They call `cloud.lane_launch` on the CTO's home brain under the CTO
  chat's identity, so the approval card shows in the CTO chat, and return
  when the launch starts (at most 180 s).
- **Automations:** a rule can set `execution.cloud: { sizeId? }` ("Run on ADE
  Cloud"). The machine that runs the rule watches the trigger and keeps the
  history. Each run calls `cloud.lane_launch` with the run id as the launch id
  and the approval `{ by: "agent", chatSessionId: null, automation: true }`,
  so the agent limits answer. An agent rule starts a chat launch; a rule of
  built-in steps makes the lane alone, then runs its ADE action steps here.
  The run waits up to 30 minutes. Such rules need `laneMode` "create" or
  "pr-branch", no bound chat and no step that works in a lane here
  (`automationCloudProblem`). A test run stays here.
- **Asking first:** `lane_launch` and `lane_launch_cancel` get the RPC
  server's caller stamp (`CLOUD_APPROVED_ACTIONS`), and `lane_launch` asks
  with the same `approve()` as `cloud.create`: a card in an attended chat; the
  agent limits (daily count, largest size, hours) in a full-auto chat or an
  automation. The start checks (`cloudLaneLaunchStartProblem`, then
  `cloudLaneStartBlock`) run before the question. An account ADE couldn't
  read goes on to the server, but an unattended agent is refused for unknown
  hours.
- **A computer with no lane (`create`, `copy`, `move`):** agents start lanes;
  they never make a computer alone. These cards carry `makesComputer`, so
  `approve()` asks the person on a card in the agent's chat, also in a
  full-auto chat, and refuses when nobody can answer: an automation run, an
  ADE MCP app, a chatless shell, and the CTO's generic action tool (the RPC
  server stamps the CTO as an agent for these three actions,
  `CLOUD_COMPUTER_MAKE_ACTIONS`). The refusal is
  `CLOUD_AGENT_NO_COMPUTER_MESSAGE`: start a lane with the size the work
  needs, or ask the person to make the computer in Settings › ADE Cloud. A
  move adds a computer too, so it has the same rule. Lane launches keep the
  agent limits.
- **A person at a plain terminal or a chatless agent:** refused, with "Start
  it in the ADE app (pick ADE Cloud under Run on in a new chat), or ask for it
  in an ADE chat, where ADE can ask you." A chatless `ade` looks exactly like
  an agent's shell, so nothing there can prove a person
  (`mayUseUserOnlyActions`).
- **ADE MCP:** an outside app with write access is an unattended agent, only
  when the RPC server can stamp `viaAdeMcp` (the operator role and a process
  the MCP runner started, `isRunningRemoteRun`). A resize, a delete, a move, a
  cancel and loosening the limits always need the person. A read-only
  connection is refused. It can read the account with no wake: `ade cloud
  status`, `list`, `hours`, `limits`, and the list and read forms of `lanes`,
  `chats`, `sessions`, `backups`, `jobs` and `project`
  (`remoteMcpCommandPolicy.ts`, `isCloudAccountRead`).
- **The daily limit:** past the day's new computers for agents, the refusal
  names the limit and Settings › Integrations › ADE Cloud › What agents may do
  › New computers a day. A person is never counted.
- **The card.** `approve()` asks with one structured question: a short
  question ("Delete Stall Repro?", `question`, else the title with "?"), one
  line under it on what goes or what it costs (`impact`), and each yes with
  one line on what it does (`confirmDetail`, `alternative.detail`). There is
  no "No" option: the card's Decline says no, so there is one way to say it.
  No answer in 5 minutes is a no. A card closed with no answer (the turn
  stopped, or a size change or move saved the work and stopped the turns)
  is not a no: the chat gets a notice that nothing was done, and the agent
  gets the same sentence as the command's error and as a note ahead of its
  next turn (`queueAgentNote`, the restart-note channel), because the
  command's answer may never reach a turn that was stopped.
- **In an agent's shell,** a command that may wait for the card
  (`cloudStep(..., waitsForPerson)`) first prints on stderr that it waits for
  the person and prints the outcome when they answer. A shell tool that
  hands back a command still running, or moved it to the background, shows
  that line, so the agent doesn't read the silence as done.

**How it runs.**

- This computer's brain (`ade serve`) runs it through the server launcher
  (core `cloudLaneLaunchService.ts`, deps `cloudLaneLaunchBrainHost.ts`). The
  CLI calls `cloud.lane_launch` and reads `cloud.lane_launch_status` every 2 s.
- The `computer`, `join` and `clone` rows show the server's record (every 3 s,
  10 s after a quiet minute). Once the computer joins, the brain reads its
  `chat.listLaunches` every 5 s through the machine bridge. A join that needs
  a person puts the page in `cloud.approvalUrl` (**Approve** on the card).
- The launch carries the server's facts and the whole launch as set up
  (`launch`, at most 256 KB). `madeBy` names an agent's chat
  (`ade_made_by_agent`, `ade_made_by_chat`).
- A computer the brain makes itself (`ade cloud create`, copy, a move with no
  desktop) joins with a device sign-in. Its link goes to the agent's chat, to
  `make_status`, and as a push to the person's phones ("Approve <computer>
  joining your ADE account", `setCloudJoinApprovalPush` in
  `cloudBrainMaker.ts`), under the normal push rules. With no push publisher,
  the brain logs `cloud.join_approval_push_skipped`.
- **One computer per id:** the launch id is printed first. The same
  `--launch-id` answers that launch, and a failed one is retried (`--prompt`
  is not needed again). Ctrl-C stops only the waiting; the brain resumes saved
  records 5 s after it starts. `ade chat launch-status <id> --machine cloud`
  reads it; `ade chat launch-cancel <id> --machine cloud` stops it and deletes
  its computer (only the chat that started it, or the person).
- **Output:** text shows the lane, the chat and `ADE Cloud · <computer>`.
  `--json`: `{ok, launchId, phase, laneId, laneName, sessionId, machine,
  approvalUrl, launch}`. A failed or cancelled launch exits non-zero with the
  card's sentence.

### A new lane with no computer of your own (the server launcher)

Every new lane on its own computer starts through the server
(`apps/account-directory/src/cloud/launches.ts`, migration `0029`; design in
`docs/plans/cloud-6/c6-c8-launcher-spec.md`). The app and the CLI send it
through `cloudLaneLaunchService.ts` and follow the computer's launch once it
joins. The web, the phone and an automation on ADE Cloud send it with no
computer. The new computer runs its own launch. The routes are in
[`apps/account-directory/README.md`](../../../apps/account-directory/README.md#launches-from-the-web-and-the-phone).

- **Files.** `PUT /cloud/launches/:id/files/:fileId` first (at most 10, 25 MB
  each, R2 `launches/<user>/<launch>/`). An account holds at most 300 open
  drafts and 2 GB in them; past either the upload answers 429
  `uploads_full`. The route counts against the `uploads` minute. The desktop copies images attached on
  another machine to this computer first, through that machine's
  `chat.getImageDataUrl` (`cloudLaunchFileCopies.ts`); a non-image file from
  another machine stops the start with what to do.
- **Start.** `POST /cloud/launches` with `CloudServerLaunchRequest`. The launch
  id is the create's request id, so the same id never makes a second
  computer. It uses the one create path (`createComputer` in `routes.ts`),
  plus `ade_launch_id`.
  - The kind is `chat` or `lane`. A CLI launch goes as `lane` with `cli` in
    `launch.kind`, so an older server or computer runs the lane alone.
  - `lane.autoName: true` lets the computer's brain give the AI name.
  - An ADE app also sends its launch args (`launch`, at most 256 KB); the
    facts win where both say something.
  - A caller with no computer sends `project: { accountProjectId }` and may
    leave out `lane` and `sizeId` (a new lane named from the first message,
    Small). `GET /cloud/launches?active=1` finds running launches again.
  - `retry: true` on a launch whose computer failed before its agent started
    deletes that computer and begins again under the same id.
- **Git credential.** Before it makes the computer, the server reads the
  account vault with the caller's token (`accountVault.ts`) for
  `integration/github` or `integration/github-cli`, or the account's GitHub
  App sign-in. With none, it asks GitHub whether the repository is public; a
  private one is refused (`git_credential_missing`, or 403
  `github_app_not_installed` with `installUrl`). A vault or GitHub that
  doesn't answer goes on. An automation's run uses what its rule's
  registration read.
- **Join.** The computer's env carries `ADE_LAUNCH_ID` and an `ADE_LAUNCH_JOIN`
  code (an HMAC under `CLOUD_LAUNCH_JOIN_KEY` of the launch id and a kept
  salt; the server keeps only the salt and the code's SHA-256).
  - At brain start with no session (`cloudBootLaunch.ts`), the brain drops
    both from its env, starts ADE's device sign-in and calls
    `POST /cloud/launches/:id/join` with no account token. The code is valid
    30 minutes and is the only proof. The brain may join again while the
    sign-in was not approved, at most 5 times. `409 join_not_ready` is
    retried with a backoff for up to 10 minutes.
  - The answer is a Clerk sign-in ticket for the launch's account only. The
    computer completes it with no browser through Clerk's Frontend API
    (`approveSignInLinkDirectly` in `cloudHeadlessApproval.ts`), only on the
    hosts it already signs in with. A headless Chromium is the fallback while
    the ticket is unused. After that, the launch shows `needs_approval` with
    the device page, and the caller offers one Approve tap.
  - A launch still joining when the window (`joinExpiresAt`) closes reads
    `failed` ("The new computer couldn't sign in.").
- **Run.** The computer reads the facts (`GET /cloud/launches/:id`), sets up
  the repository with its own Git sign-in, and runs `chat.startLaunch` with
  the same launch and lane ids.
  - Once the facts are read, the agent's own tool starts downloading
    (`launchAgentOf`, then `startPinnedToolsForLaunch`), beside the clone and
    the setup, never awaited: the chat's provider tool, a CLI launch's
    terminal tools, nothing for a lane alone, a shell or a Cursor chat. The
    chat's start joins that download. A new computer has no use record, so
    without this its first turn waited on the download (about 17 s for Claude
    Code after Start now). Logged as `cloud_boot_launch.tools_prefetch`.
  - It posts a stage only when a stage changes (`PUT .../stages`). The last
    one is retried with a backoff and again at the next boot. A `done` launch
    takes no other state. A launch stopped on the computer reads `failed`.
  - The setup card shows the computer's rows (fetch, checkout, environment,
    agent) from the record, and a row never goes back. The desktop starts
    pairing once the computer joined.
  - A cancel before the agent starts deletes the computer after the cancel
    lands; a second cancel retries a failed delete. The minute cron deletes a
    record a week after its start (a draft after a day), with its files.
- **Sign-in on the computer.** A provider that signs in there reports
  `waiting_for_sign_in` with `signIn` (`cloudLaunchSignInWait.ts`). The caller
  shows it, and the result goes to the account vault for later computers. The
  computer waits 30 minutes; the server fails the launch after 45
  (`CLOUD_LAUNCH_SIGN_IN_TIMED_OUT`).
- **Queued messages.** The first message stays with the launch. Messages sent
  before the chat exists queue on the server (`launchMessages.ts`, migration
  `0038`). The computer claims, sends and reports each one
  (`cloudLaunchMessages.ts`), so the person may close the tab.
- **Continue launches.** A launch with `continueChat` continues an existing
  chat on a new computer (see
  [Continue a chat whose computer is gone](#continue-a-chat-whose-computer-is-gone-fork-continue)).

### Automations whose home is ADE Cloud

A rule's home can be ADE Cloud itself (`automations/README.md`, "Runs on ADE
Cloud"). The server keeps the rule (`cloud_automations`, migration 0030,
`apps/account-directory/src/cloud/automations.ts`) and watches its trigger.

- **Registration.** A brain sends `PUT /cloud/automations/:ruleId` for a
  version the server lacks (the same version writes nothing but reads the
  vault again), and `DELETE ?through=<version>` when the home leaves ADE Cloud
  or the rule goes. Each registration reads the agent limits and the git
  credential from the vault and keeps them for the runs; unread limits refuse
  unattended spend. Only a newer version turns a storm-paused rule back on.
- **Schedules.** The cron runs in the rule's IANA zone
  (`automationSchedule.ts`); the next fire is kept in UTC. A skipped clock time
  doesn't fire; a repeated one fires once. A run missed by an hour or more is
  recorded as skipped.
- **Webhooks.** The webhook relay forwards deliveries to
  `POST /cloud/automations/:ruleId/deliveries/:userId` (no account token),
  signed with HMAC-SHA256 over `<timestamp>.<body>`. The key comes from
  `CLOUD_CHAT_MASTER_KEY` and a per-hook salt, so D1 holds no key. A repeated
  delivery is the same run. 410 tells the relay the hook no longer forwards
  here; 400, 413 and a bad signature drop that delivery. `{{trigger.body.*}}`
  reads the whole body; `{{date}}`/`{{time}}` use the rule's zone.
- **Runs.** Each run is a server launch (launch id = run id, `madeBy:
  automation`), under the agent limits, then the launcher's checks.
  - One run at a time per rule and one waiting; the rest are skipped. Past the
    rule's runs an hour (default 6), the rule pauses.
  - A 503 from ADE Cloud leaves the run starting for up to an hour. A chat
    that stops for input fails the run ("The agent asked for input").
  - When the chat ends, the cron saves its chats and each lane's backup on the
    awake computer (nothing is pushed) and deletes the computer, keeping the
    lane without a computer (unless the rule keeps its computer).
  - A run that can't start fails before anything is made. The person hears
    through a push (the push relay's `POST /directory/accounts/<id>/notify`)
    and, at most once a day per rule, an email.
  - `GET /cloud/automations?origin=` answers each rule with its last runs.

**Other account-level routes.**

- Provider sign-ins from the phone or the web:
  `POST /cloud/instances/:id/sign-ins { provider }` runs
  `ade providers sign-in <provider> --remote --json` there;
  `.../sign-ins/:job` and `.../code` read it and pass a pasted code. Which
  providers can do this is `CLOUD_REMOTE_SIGN_IN` in `contract.ts`.
- `POST /cloud/projects/computers/delete { origin, dryRun: true }` lists a
  project's computers (at most 50, `truncated`). `{ origin, instanceIds }`
  starts a cron job on those computers: check that every lane is saved
  (`saveBeforeDelete`: no wake, nothing pushed), delete. A computer whose
  lanes are not all saved is kept with why. The
  answer's `accepted` and `skipped` say which it took.
- The typed client for all of these is
  `apps/desktop/src/shared/cloudApiClient.ts` (fetch only). Every `/cloud/*`
  route answers a browser only on `WEB_CLIENT_ORIGIN`.

### The life of a lane's computer

The main process runs these (`cloudLaneLife.ts`, `IPC.cloudLaneLifeCall`).
The account side (work check, delete, free, keep, lanes without a computer)
is `cloudLaneAccount.ts`, which a brain's `cloud` actions use too
(`cloudLaneVerbs.ts`). Each call is account level: it names a computer of the
account, never a pin.

- **Work check.** `ade cloud push-work --check --json` on the computer lists
  the lanes with uncommitted changes or commits no remote has
  (`laneService.readUnsavedWork`, uncached). It changes nothing. A resting
  computer is woken for it like any wake: the person's click is use, and at 0
  hours it is refused (the lanes' backups still read). The check and a push first run one
  `git fetch --all --prune` per project (60 s). Commits already in the
  remote's base branch (`git merge-tree` changes nothing) count as saved. A
  lane that can't be read, or a fetch that fails, reads `failed`, never
  `clean`, and the computer is kept. `ade cloud work-state` runs the same
  check.
  - **No wake for a saved computer.** When the computer is not running and
    the server says it saved its lanes at rest (`backups.saved`; any start
    clears it), the check reads the lanes' backups instead
    (`GET /cloud/backups?machineKey=`): the newest backup of each lane with
    commits or changed files is unpushed work. `checkedBy` says which way it
    read. An asleep computer that saved nothing is still woken.
- **Delete lane.** The computer goes, and the lane and its saved chats with
  it. ADE never refuses it. The work check runs first unless the person was
  already warned.
  - "Keep its chats to read later" (off by default) passes `keepChats`.
    Otherwise main deletes the computer's saved chats by its machine key, and
    the keys in `ade_former_machine_keys` (a moved lane) while the server says
    their computer is deleted. It reads at most 20 pages of 200; when chats
    stay, `chatsKept` is true and the toast says to remove the rest in Work.
  - `cloud.delete` (`ade cloud delete <machine>`) keeps the chats.
    `cloud.lane_delete` (`ade cloud lanes delete <lane>`) deletes them, as
    the desktop does. It refuses `keepChats` (and the CLI refuses
    `--keep-chats`): the person picks on the card, and Keep for later is the
    way to keep the lane and its chats. An agent can't keep the chats behind
    the card.
  - Each person's delete sends `ade_feature_used` `cloud_lane_deleted` with
    the outcome `completed`, `kept`, `partial` or `failed`.
- **Manage lane on a cloud lane** opens a Computer tab
  (`CloudLaneComputerPanel.tsx`): Change size, Put to sleep, Keep the lane and
  free its computer (`freeCloudLaneWithConfirm`), Keep this computer while
  the idle cleanup warned, and the ADE Cloud page. Its Delete tab is the cloud
  delete with the keep-chats box.
- **A deleted computer looks like a sleeping one** (`cloudLanesWithoutComputer.tsx`,
  `CloudLaneComputerDeletedBanner.tsx`). A lane whose computer was deleted,
  kept by the server or listed only by its saved chats, stays a normal row
  among the ADE Cloud lanes in Lanes and Work, with one quiet "Computer
  deleted" mark. Its rows name the machine id `ade-cloud-deleted`, which
  nothing routes to, so every lane action refuses them. Its lane page and its
  chats show one inline banner: what happened, what the next message does,
  and "Why?". The next message goes through the account's queue, which makes
  a new computer and continues the same chat. The chat's banner has a size
  chip for that computer. With no pick, the server starts it at Small, or
  bigger if the project needed it before. A pick goes with the message
  (`sizeId`), and the server starts the computer at that size and does not
  change it. The pick belongs to the deleted computer's machine key, so all
  of its chats share it, and a send that carries it clears it. When ADE Cloud can't start one (the account is blocked or signed
  out, no hours or disk, no branch or repository), the banner turns to a
  warning with the reason and Send is off. A lane with no chat offers New
  computer on the same branch instead. In Lanes, a lane with no kept record
  says "Only its N saved chats are left" (`onlyChatsLeftSentence`). Its
  button is "Delete lane" in every case, as on the iPhone. Delete asks first, removes the kept
  record (the server refuses it while a computer holds the lane again), then
  every saved chat of that lane on its old computers, page by page; when
  chats remain, it says so and keeps the row. After the server confirms a
  delete, the lane leaves the list at once (`noteKeptLaneDeleted`), and a
  saved-chats read that started before the delete can't list the lane or
  its chats again (`noteCloudSavedChatsDeleted`). A lane on a deleted
  computer whose chats are all gone leaves the list. The ADE Cloud page lists every
  project's kept lanes (`CloudDashboard.tsx`).
  - On the iPhone the same lanes are normal rows in the project's Lanes list
    (`LaneKeptCloudRows.swift`), counted under Active. A tap opens the newest
    saved chat, else the kept-lane page (`CloudKeptLaneActionsCard` in
    `CloudKeptLanes.swift`): New computer on the same branch for a lane with
    no saved chat, its saved chats, and Delete. The chat's line says what
    happened and what its next message does (`CloudDeletedComputerFacts`).
    Everything goes through the account server, so it works with no machine
    of the person's own.
  - **Lane links to a kept lane** open its kept page, not "Lane shared with
    you" or "This link is from a computer that isn't in your ADE account".
    The iPhone reads the kept list fresh (`openKeptLane` in
    `DeepLinkRouter.swift`) and shows `KeptLaneLinkSheet`, which closes when
    the lane leaves the list. The desktop (`keptCloudLaneNavigation` in
    `main.ts`, and `App.tsx` for a link with no machine) and ADE Web
    (`WebClientRoot.resolveOwnedTarget`) open Settings › ADE Cloud with that
    row selected (`?tab=ade-cloud&lane=<id>#cloud-lanes`).
    A lane page left open while its computer goes (opened from any machine's
    row) turns into that kept row, with New computer and Delete; it reads
    the list a few times for about half a minute. When the read fails, the
    ADE Cloud page says so with Try again, never "No cloud lanes yet".
- **Move this lane to** one of the person's own computers
  (`components/laneMove/`, the chat composer's machine chip; the iPhone's
  `LaneMoveSheet`). The review lists every chat with how much history it
  keeps, the unpushed work, and the files git ignores
  (`instance.ignoredFiles`, from the disk report): those do not move. ADE
  Cloud is never a destination. The way depends on the lane's computer:
  - **Awake:** the batch move carries the lane and its Work chats and CLIs,
    then ADE deletes the computer. Only the saved copies of the chats that
    arrived go with it (`deleteLane` with `onlyChats`); a Done, archived or
    other-surface chat the move left stays readable from ADE Cloud.
    Before the delete, the source answers two checks: no chat or CLI started
    on the lane during the move, and the lane's HEAD and working tree match
    what the move carried (`chat.crossMachineBatchSourceChanged`, against the
    lane item's `carriedHeadSha` and `carriedTreeSha`). A chat that started
    there keeps the computer and ends the run as "move again", which does not
    block a new move. Changed files, or a computer whose ADE is too old to
    check, end it at "Push to GitHub and delete": ADE pushes the lane's files
    to its branch, checks nothing is left off GitHub, then deletes the
    computer, and the person pulls the branch on the destination. "Keep
    computer" leaves it. A check that can't read the source keeps the
    computer, and its retry runs the checks again.
  - **Asleep, with every lane saved at its rest** (`backups.saved`): no wake.
    The destination brain (`keptLaneRestore.ts`, step `release`) deletes the
    computer with `keepLane: { onlyIfSaved: true }`. The server refuses with
    409 (`computer_awake`, `backup_not_current`, `backup_never_saved`) unless
    the computer rests right after that save, and it checks again just before
    the delete. Then the kept-lane restore runs: lane from its backup, chats
    from their saved copies and capsules, then the kept row goes. A refusal
    deletes nothing and sets `wakeInstead`; the dialog offers **Wake and
    move**. A failure after the delete leaves the lane kept, so the move can
    run again.
  - **Asleep, not saved** (the rest save failed or ran out of time: Git LFS,
    a submodule, a crash): the dialog says why and offers
    **Wake and move**, which wakes the computer and moves it live.
  - **Deleted:** the kept-lane restore with no release step.
  - Claude, Codex and OpenCode chats, and Claude Code and Codex CLIs, keep
    their native history from the capsule saved at each rest; the other
    providers replay the saved transcript.
  - The preview, the start and the status reads go to the destination's pin
    (runtime actions `cloud.kept_lane_move_preview`, `cloud.kept_lane_move`
    and `cloud.kept_lane_move_status`; the phone's sync commands
    `cloud.previewKeptLaneRestore`, `cloud.restoreKeptLane` and
    `cloud.getKeptLaneRestore`; all with `fromComputer: { instanceId }`).
  - A restore lists at most 100 chats and CLIs to bring. When more are left,
    it ends as failed and keeps the lane; a new start brings the next ones.
- **Keep the lane on a fresh computer.** ADE pushes the work first; a push that
  can't save everything keeps the computer, and freeing is refused while the
  agent works ("Stop it or wait, then free the computer"). Then the server
  deletes the computer with `keepLane` (`cloud_lanes_without_computer`,
  migration 0021). A new computer for the same lane id ends the row.
- **Tier change.** A resize in place when the kind stays, else a move. The
  server's `/resize` wakes a sleeping computer first, metered from the wake.
  It starts when the agent is idle (`keep-awake.json`) or now
  (`ade cloud prepare-stop` stops the turn).
  - A disk-only grow runs `ade cloud prepare-stop --disk-grow <GB>`: it
    writes the grow note and keeps the turns, which continue after the
    restart.
  - A resize with a disk sends `computerIdle: true` only within 2 minutes of
    the job's own save. A failed disk-only resize removes the note.
  - Its steps go to every window (`IPC.cloudLaneJobEvent`). The lane is Online
    only when ADE on the computer answers and has the lane's project.
  - While a change runs, the desktop and ADE Web composer of the lane's chat
    send through the account's queue instead of to the computer
    (`chatLaneChangeRef` in `AgentChatPane`, then `sendThroughCloudQueue`). ADE
    on the computer stops during the change (a move stops it at `serve` and
    deletes the computer), so a direct send waited at most 45 s on the old
    address and failed, or started a turn the change cut. A move's message
    is held on the server and sent on the new computer
    ([the message queue](#send-to-an-asleep-or-deleted-computer-the-message-queue));
    the chat shows it as queued ("Moving this lane to its new ADE Cloud
    computer…") until the transcript has it. A size change queues only once
    its resize was asked: before that its ADE still answers, and the restart
    would cut the turn the message started, so the message stays in the box
    with a hint. Files and thread comments stay in the box with a hint for
    the whole change (they go with a live send only), and so does a message
    the queue can't take (an older server). The phone sends to the queue
    once its link to the old computer drops (after `serve`); before that it
    sends directly, and the move cuts that turn.
  - A move saves the chats while it makes the new computer (Save work and
    Make computer run at once; one after the other they took about 1.5
    minutes each). The server's `make` step holds the running old computer
    and starts `ade cloud prepare-stop` there in the background, once per
    move (`startMoveSaveCommand`); `join` notes its end while it waits, and
    `save` waits for it, at most 2 minutes from its start, then goes on with
    a warning as a save past its time always did. The copy (`serve`, the
    pause) starts only after both. The record says `saveState` (`running`,
    `done`, `warning`) and `copyStarted`; `copying` reads from the sign-in
    on, so a client shows the copy only once `copyStarted` is true.
  - The desktop job (`cloudLaneLife.ts`) waits for the agent first (timing
    `idle`), then hands the save to the server (`onSave`); a move run from
    here (an older server) runs its own save beside `createCloudMachine` and
    waits for it before the pause (`saveHere`). An older server's save shows
    done when its copy starts.
  - Cancel works until the copy starts (the card's Cancel, `cancelJob`): the
    server's undo deletes the new computer, releases the old one's hold, and
    unpauses it only if it was paused. The answer waits for the server (up to
    30 s); if the copy started first, it says so and the move goes on. A
    cancel while the new computer exists costs its minutes so far, metered
    like any computer's. The save keeps running to its end: the stopped
    turns stay stopped, as after any save.
  - In the lane's chat it is one slim bar above the prompt box
    (`CloudLaneChatStatus` in `CloudLaneChatCards.tsx`, the job card's `bar`
    variant): the job's title, its step now and how long it has run. A click
    opens the steps (Retry, Cancel); the × hides it while it runs (the job
    goes on, and the bar comes back if it fails) and dismisses it once it
    ended. A finish leaves after 20 seconds unless its steps are open; a
    failure opens on its steps and stays for Retry. The bar and Send find the
    lane's job the same way (`useChatCloudLaneJob`), and Send goes to the
    account's queue while the job holds sends (`cloudLaneJobHoldsSends`). The
    chat header's cloud button shows the job too: its step now, "Show the
    move's steps" (opens that bar, else the ADE Cloud page), and no sleep
    countdown, Change size or Sleep now while it runs.
- **An agent asks.** `ade cloud resize --request --size large --reason "…"`
  (`cloud.tier_request`, `cloudTierRequestActions.ts`) posts a `cloud_tier_request` card in the agent's
  chat; the person confirms there. An unwatched agent can not change a size:
  `cloud.resize` is declined.
  - The newest request still waiting (a day at most) is pinned above the
    prompt box, where an "ADE asks" question shows
    (`CloudTierRequestsAboveComposer`); its transcript card turns to one line
    that points there. The × and Keep the size say no; Change size or Move it
    start the change (`changeTier`, main process, no pin).
  - Every answer then goes to the chat's own machine by the chat's pin
    (`cloud.tier_request_answer` with the chat and the request id, user-only;
    ADE Web and the phone through `cloud.write`). That machine reads the card
    from the chat (never a client's copy), marks it answered (same `cardId`,
    no buttons, the answer in its subtitle and rows) for every surface, and
    tells the agent (`cloudTierRequestAgentMessage`): Keep the size wakes it
    at once with ADE's words (`hostContinuation.reason: "card_answer"`); a
    yes is a note for its next turn (no wake: a turn then would hold up a
    change that waits for the agent to be idle).
  - How the change ended (online, failed or cancelled) goes to the chat's
    machine from what runs the change, with the chat's pin the confirm
    passed (`requestedByChatPin`): this app's main process
    (`tellRequestingChat` in `cloudLaneLife.ts`) for a size change it runs
    and for a move it follows on ADE's server, with every window closed; it
    tries again a few times, and after a quit. Each try reads the job again,
    so a Retry's end is told too (at once when it comes while a try waits).
    ADE Web's tab tells it for a size change it ran and for a move it
    follows (`createWebTierRequestTeller`), while the tab is open; both run
    the same loop (`createTierRequestTelling` in `shared/cloudTierRequest.ts`).
    A move started from ADE Web keeps its request and timing on the server's
    record (`CloudMoveRequest.requestId`, `requestedByChat`,
    `requestedByChatPin`), so a reloaded tab still tells the chat; an older
    server drops them and nobody is told. A chat that lived
    on the moved computer is told on the new one, and a pin that names no
    machine (a saved chat's `cloud-saved:<key>`, the ADE Cloud tab's) is
    reached by its machine key: that machine is connected and the chat's
    project found there (`cloudTierRequestChatMachineKey`). The agent is
    woken with the outcome. The card keeps what the agent was told
    (`tier_request_told`), so a repeat tells it nothing.
- **Before a launch,** `lane.cloudStartBranch` and `lane.pushCloudStartBranch`
  run (pinned) on the machine that has the project. Files on the first message
  go to the launcher (`uploadLaunchFile`); later ones go to the clone after
  the hand-off (`uploadAttachment`). A cancel forgets the app's connection to
  the deleted computer. The brain writes the branch into `ade_lane_branch`.

### Lanes, chats and saved work from the CLI

`cloudLaneVerbs.ts` adds the account's views to the brain's `cloud` domain.
Reads wake nothing and work from any folder (`ADE_ACTION_MACHINE_SCOPED`).

- **One lane model.** `cloud.lanes` (`ade cloud lanes`) lists every lane of
  the account once. A lane is on a computer (`awake`, `asleep`, `starting`,
  `stopping`, `deleting`, `error`) or `computer_deleted`: the server kept the
  lane, or only its saved chats are left. Each lane has its saved chat count,
  its newest backup and a lane link. The list reads the computers, the kept
  lanes, at most 5 pages of saved chats and the backups in parallel; a part
  that fails goes in `unread`, never a throw. `--stale` keeps the lanes unused
  for a week or due for cleanup, biggest disk first.
- **A lane** is named by its name, id, branch or link (`lane_show`). A name
  two lanes share is refused with their ids. An id is the whole selector or
  a lane link's lane; a name that holds an id stays a name. A write named by
  a name or branch needs the id while the kept lanes or saved chats can't be
  read (a hidden second lane could have that name).
- **Writes** are the delete class of `approve` (`CLOUD_APPROVED_ACTIONS`):
  - `lane_delete`: on a computer, the work check runs first (no wake for a
    saved computer), then one card: "Delete X?", one line on what goes and
    the work not on GitHub, then Delete lane and Keep for later (a free),
    each with one line on what it does. Decline says no. A person always decides, even for a computer the chat made:
    the lane's saved chats go with it. A card that read an asleep computer's
    backups stops the delete if the computer started meanwhile. A move run
    by the server refuses a delete or free of either computer. Computer
    already deleted: its kept record (the
    server deletes the lane's backups and saved chats with it), then any
    chats left on its deleted computers. With no kept record, ADE deletes
    those chats and the lane's backups itself.
  - `lane_free`, `saved_chat_delete`, `session_delete`, `backup_forget` and
    `job_cancel` ask the same way.
  - After the person's yes, the agent's chat shows the write as one card
    (`cloud_lane_action`, drawn by the generic `ade_card`): "Deleting X…",
    then "Deleted X" with the result's sentence, or why it failed in amber. The command gets the same result. `lane_start` makes the lane's new computer
    through `lane_launch` and its card, on `origin/<branch>`, from a folder
    of the lane's project. A lane whose repository ADE doesn't know is
    refused.
  - `lane_keep` (`POST /cloud/instances/:id/keep`) needs no card: it stops
    the idle cleanup's delete, wakes nothing and uses no hours.
- **Status.** `cloud.status` also returns `lanesComputerDeleted`, read beside
  the computer list; null when it can't be read, and the text says so.
  `lanesComputerDeletedPartial: true` when the saved chats were read only up
  to the page limit, so a lane known only from older chats can be missing.
- **A brain** holds no connections to the computers, so a delete or free
  from the CLI forgets none; the desktop drops them on its next list read.

## Guidance for agents

One text serves every agent: `apps/desktop/resources/agent-skills/ade-cloud/SKILL.md`.
ADE's agents load it as the `ade-cloud` skill; ADE MCP serves it as the
`ade-cloud` prompt, and the `ade-mcp-client` skill has a three-step version.
Both show only to an account with ADE Cloud access (`setAdeCloudSkillVisible`).
The skill says what ADE Cloud is, to read the status first and stop on a no,
how to start, follow, retry and cancel a lane, what each refusal means, to
clean up before a delete, and what an agent must never do. It holds no rates:
an agent reads them from the status.

## The machine template

`infra/ade-cloud/` holds the image every computer starts from (see its
README). It sets `ADE_HOST_INSTANCE_ID=cloud:<hostname>` and
`ADE_CLOUD_INSTANCE_ID`, the only variables the rest of ADE reads to know it
runs on a cloud computer. Every release builds the image
(`.github/workflows/cloud-template.yml`), tests it on a real computer and
moves the image of the tag's channel only on a pass
(`infra/ade-cloud/promote-template.mjs`). The server creates from the pinned
image of the computer's channel. On first boot, a computer installs the ADE
version of the app that made it when the image's ADE is older.

Agent programs (see
[Agent tools cache](../onboarding-and-settings/agent-tools-cache.md#cache-layout-on-disk)):

- `/home/node` is the billed disk. Everything else is the provider's unbilled
  system layer, which an image update resets.
- The image bakes the agents its ADE pins (Codex, Claude Code and OpenCode by
  default) read-only into `/opt/ade-tools`.
- Any other agent, or a newer pin, downloads on first use into
  `/var/cache/ade/tools` (with the npm, pip and yarn caches). Each install
  keeps that folder within about 7 GB and the layer's free space: old agent
  versions first, then the package caches; an agent used in the last day
  stays. Only what can't fit goes to `/home/node/.ade/tools`, and copies there
  that the image now bakes are removed.
- The brain reads `ADE_TOOLS_BAKED_ROOTS`, `ADE_SYSTEM_CACHE_ROOT` and
  `ADE_SYSTEM_CACHE_BUDGET_BYTES`. With `ADE_TOOLS_PREFETCH=used`, it fetches
  at startup only agents this computer ran. A server launch fetches its own
  agent as soon as it reads the launch (see **Run** above).
- A status read, a model list or a sign-in check never downloads an agent.

## Updates

Cloud computers update themselves, image and ADE together, onto their
channel's image, only when nothing runs (`apps/account-directory/src/cloud/updates.ts`).

- **Channels.** `cloud_settings` keeps `template_version_stable` and
  `template_version_beta` (`template_version` is the fallback; a Stable move
  writes both). A computer follows the update track of the app that made it
  (`cloud_computers.channel`; an Alpha build makes Beta computers). A copy
  follows its original.
- **When.** Idle: before it sleeps, the keep-awake loop asks
  `GET /cloud/instances/:id/update-check`; a computer behind calls
  `POST .../update` (`reason: "idle"`) instead. A resting computer is never
  woken to update: it updates at the idle step after its next real wake.
  (Older rows may still read `reason: "asleep"`.)
- **Only a tested image.** Automatic updates go only to `auto_update_<channel>`
  (`off` stops them). A person's "Update this computer" (`ade cloud update`)
  goes to the channel's image; one update runs at a time
  (`409 update_in_progress`).
- **Proof and rollback.** Each brain start sends
  `POST /cloud/instances/:id/booted { adeVersion }`, which settles an update.
  With no report 15 minutes after boot, the cron moves the computer back once
  to `previous_template` and marks the image failed for it
  (`update_state`, `update_error`, `update_failed_template`); a newer image
  clears it. A failed rollback is not retried.
- **Hours.** An automatic update or rollback of an awake, idle computer uses
  a free window (`free_wake_started_at`, `free_wake_until`) until the boot
  report: the restart is ADE's, not use. The idle update's power log and free
  window are written before the provider is asked, and the computer's call
  waits at most 8 s for the provider (a quick refusal reaches it; otherwise it
  is told the update started), because the restart can cancel that request. A person's update is metered.
- **What people see.** Where other machines have an Update button, a cloud
  computer shows "Updates itself when idle", "Updating…", or "Update failed:
  <why>." with Retry. `ade cloud status` gives each computer's
  `update {image, channel, target, state, error}`. Each update writes
  `cloud_power_log` (`update_manual`, `update_idle`, `update_asleep`,
  `update_rollback`).

### The status menu

A cloud lane's header menu (`CloudLaneComputerPanel.tsx`) reads one account
call when it opens, never on a timer, and no read wakes the computer
(`window.ade.cloud.computerStatus`, IPC `ade.cloud.computerStatus`, then
`GET /cloud/instances/:id/status`, `computerStatus.ts`, migration `0050`;
`useCloudComputerStatus.ts` keeps a read 20 s in the window, the server 15 s).
The answer puts together:

- **The provider's signed webhook,** `POST /cloud/agent37/webhook`
  (Standard Webhooks, secret `AGENT37_WEBHOOK_SECRET`): every status change of
  the account's computers goes to `cloud_instance_events` once per
  `webhook-id`, so a sleep, wake or restart between two minute ticks is seen.
  A change to running also keeps the provider's restart count. A failed save
  answers 503 so the provider retries; a refused signature is logged
  (`secret_unreadable` is reported). Register it once with
  `apps/account-directory/scripts/register-agent37-webhook.mjs`.
- **The brain's own word,** `POST /cloud/instances/:id/activity`
  (`cloud_computer_activity`): working or idle, since when, when it sleeps and
  how many agents run. `cloudActivityReporter.ts` (CLI) sends it only when that
  changes (and once after a wake), riding the keep-awake's checks through
  `onIdleFacts`; the agent count comes from each busy read.
- **The provider's health and metrics** (restarts, memory verdict) and the
  newest disk measure.

## Rules on a cloud computer

`adeCloud/cloudComputerRules.ts` holds the check (`isAdeCloudComputer`, the
`ADE_CLOUD_INSTANCE_ID` variable) and every sentence of these rules.

- **One lane per cloud computer,** across every project on it. An archived
  lane counts; a primary lane never does. `laneService.ts` checks every place
  a lane row comes to exist, with the count and the create lock in
  `cloudComputerLaneHold.ts`. On Linux the template's own file also marks the
  computer. The refusal (`CloudComputerLaneLimitError`) says to start a new
  lane on ADE Cloud, or to restore the archived lane that owns the computer.
  A chat launch and a hand-off check give it before any work. The launch's own
  lane, a moved or copied chat, an unarchive and a restore on an empty
  computer are allowed. An older computer with several lanes keeps them. See
  [One lane per ADE Cloud computer](../lanes/README.md#one-lane-per-ade-cloud-computer).
- **Codex runs with full access:** approval `never` and the
  `danger-full-access` sandbox, set on the chat's fields at every create, load,
  update and thread start. Plan mode, side chats, a chat an agent started, a
  recovery chat and a chat with a host permission policy keep their mode. An
  agent can never lift a chat past its own level. Other providers are
  unchanged.

## Sleep and busy rules

### Busy and idle

One busy list, `decideCloudBusy` in
`apps/ade-cli/src/services/power/cloudKeepAwake.ts`, fed from each runtime
(`readRuntimeBusyFacts`). Unknown is busy.

- **Busy:** a running chat turn, a real running command, an agent CLI that
  works, setup, a new-lane launch that still sets up (`lane_setup`), a first
  clone, a move, a copy, a server launch between its join and its hand-off,
  holds in `$ADE_HOME/cloud/holds/*.json`, and someone who watches a tool
  (`work_tools.noteWatching`, once a minute while the desktop window is in
  front and the person moved in the last 3 minutes).
- A hold also counts as use when it ends (`holdCloudWork`), so a short clone
  between two checks still counts. A clone asked by another machine
  (`projects.clone`, `machines.cloneForAgent`) takes the same hold. A second
  clone into a folder whose clone runs joins it (`cloneRepository`); a folder
  that already holds the same repository is the answer, with no clone.
- **Idle:** a shell at its prompt, an agent CLI at its prompt or asking
  (`waiting-input`), a chat that waits on approval, and a command or turn with
  no output and no touch for 60 minutes. A shell's prompt state comes from
  `/proc` (`readPtyForeground`): tpgid on a normal kernel, the shell's
  children on gVisor.
- Typing warms the chat's model (`chat.prewarmDraft`, and `chat.warmupModel`
  with `sdkOnly`). These are background writes, so typing never wakes a
  sleeping computer, but an awake one counts it as use and stays awake. Any
  other warmup (a viewed Cursor tile) is not use. A person's **Run doctor**
  (`ai.runAcpProviderDoctor`) is use and wakes it; the page-open diagnostics
  are not.
- Three minutes after the last work, the brain calls
  `POST /cloud/instances/:id/idle`. The provider's own 5-minute timer is the
  backstop. The app's own writes (`isBackgroundAdeWrite`) neither wake a
  computer nor keep it awake.
- Copy and move hold a computer awake only while they run (time-outs of 20 and
  45 minutes cover an ADE that quit mid-way).
- `ade cloud prepare-stop --timeout 40` (before a stop at 0 hours) interrupts
  chat turns and agent CLIs, writes the saved chat copy, and saves each lane's
  backup (`backups` in its `--json` result).
- **The person's Sleep** of an awake computer first runs
  `prepare-stop --timeout 20 --for-sleep` (`prepareForPersonSleep` in
  `routes.ts`): the running turns stop, the chats are saved, and each lane's
  backup is saved in the time left. `--for-sleep` freezes new work from the
  start of the prepare until 30 s after it answers; a wake lifts it. Then the
  computer sleeps whatever the prepare says. The server marks the rest
  (`markRestedWithBackups`), so a later move or cleanup needs no wake, only
  when the prepare reports every lane saved, answers `frozen: true`, and the
  sleep follows within 20 s. A save that didn't finish in time, or an older
  ADE that doesn't freeze, marks nothing.
- **The saved-only delete** (a move from an asleep computer) claims the
  computer with one conditional write (`claimSavedDelete`, `idle_deleting_at`)
  while it rests with current backups. While the claim holds, start, exec,
  sign-in, message sends, `/use` and event wakes answer 409
  `computer_deleting`. A path that deletes nothing gives the claim back. The
  client sends `onlyIfSaved` only to a server whose computer reads
  `deleteOnlyIfSaved: true`; an older server gets no delete, and the move
  asks for a wake.
- **Native-history capsules** are replaced atomically: a new upload writes
  under its own prefix and its commit swaps it in (migration 0051), so a
  failed upload leaves the old capsule readable. A chat capsule records the
  newest turn it holds (`transcriptEnd`); a restore drops a capsule older
  than the saved transcript and replays the transcript. A restore moves the
  chat with `keepCapsule: true` and deletes the capsule
  (`DELETE /cloud/capsules/:machineKey/:chatId`) only after the local
  restore succeeds.
- **Each saved copy owns its storage.** A new chat copy, capsule upload or
  CLI copy save gets its own R2 key (`storageSweeps.ts`), so a delete or a
  move touches only the storage it read. The write that lets storage go also
  writes a row in `cloud_storage_sweeps` (migration 0051); the objects go
  after it, and the minute tick finishes a sweep that failed. Older rows keep
  their keys.
- **A turn stopped for a rest reads Stopped.** Each chat whose turn a
  prepare-stop interrupts is marked (`noteCloudChatStoppedForRest`). Its saved
  row then has status `interrupted` (`SAVED_CHAT_STOPPED_STATUS`), and the
  saved Work row reads Stopped, as the turn reads in the chat, not Done. The
  next turn end that is not an interrupt removes the mark.

### A resting computer in the clients

- **Asleep is not offline.** A sleeping computer that still exists looks
  connected in Work (`machineIsCloudResting` in `crossMachineLanes.ts`), but
  its rows stay `online: false` for every guard. The account directory gives
  it `online: false`, `sleepState: "asleep"` and `cloud: { state, stateAt }`
  (`cloudComputerTruth`). A deleted computer's chats keep the offline look.
- **Finding it asleep.** A sleeping computer's relay tunnel looks open until a
  call times out. Then the desktop asks once whether it is asleep
  (`asleepForUse`, `remoteCloudAsleepChecks.ts`). If so, the link closes with
  no error, and the lists show its saved chats and send it no reads. The same
  question follows a dropped link, and again 45 s and 90 s later. The
  saved-connection maintenance asks every 5 minutes and redials once it is
  awake. Each change sends `cloudStatusChanged` once (`cloudWakeHook.ts`), and
  the windows read the machine list again.
  All of this applies only to a machine the desktop knows as a cloud computer
  (`knowsBox` in `cloudMachines.ts`; an unknown key gets one read, a laptop
  key is not asked again for 10 minutes).
- **Waking.** A send from a saved chat wakes its computer (15–30 s). The pane
  shows "Waking the computer…" and the Work row "Waking"
  (`markCloudWakeForSend`, display only). Once the chat's connection is up
  again (the header then reads Awake) and the send is still on its way, the
  line reads "Starting <agent>…"; a turn waiting for ADE to download the agent
  reads "Getting <agent> ready…" (the notice's `status: "agent_download"`).
  The bubble shows when the person pressed Enter: a send that reached the
  computer 5 s to 1 hour after that carries the time as `user_message.sentAt`
  (`heldSendSentAt`, from the desktop's `clientSubmittedAtMs`); the transcript
  row's own timestamp stays when the computer wrote it. In a chat on a sleeping computer, a
  proof offers **Wake**, and a code block's **Run** wakes it first
  (`useChatMachineWake.tsx`). A deleted computer's proof says so with no
  button. Every wake for use logs its cause (`remote.cloud_woken_for_use`:
  target, `via`, action). A tool panel (`CloudToolGate`, `terminals/cloudToolGate.tsx`) wakes
  the computer on a person's click through `cloud.machineAction`; a restored
  tab shows Wake; at 0 hours (a size that uses hours) it shows the lane's
  saved work instead (`CloudLaneSavedWork`, no wake). A connect from ADE Web to an asleep computer wakes
  it first, then retries the connect for up to two minutes.
- **The chat's settings while it rests.** The computer puts the chat's
  settings in each saved row: model, preset, thinking level, Fast and the
  access modes (`settings`, `readChatRow` in `bootstrap.ts`). A setting that
  changed with no new transcript part goes at the next rest save, after the
  new turns (`markChangedSettings` in `cloudChatUploader.ts`). The server checks each
  field (`cloudChatRowSettingsOf`), seals them in the copy's summary and
  returns them in `GET /cloud/chats`. The desktop and ADE Web show them in
  the composer (`savedChatSummary`); a pick since the last send wins, and a
  pick a queued send carried shows until the computer saves a newer row. The
  phone shows the model, thinking level and Fast (`rosterChatSummary`) and
  still hides the access mode of a saved chat.
- **The @ menu while it rests.** The menu never asks a resting or deleted
  computer, since a read must not wake it. It shows the account's machines
  (an account read, kept 15 s) and the computer's saved chats, lanes and open
  PRs from its Work slice (`chatMentionClientRows.ts`). While the computer is
  awake, its own answer comes first, and the account's machines fill the
  menu only when that answer has no machine rows.
- **A deleted computer's chat** shows no running turn: nothing runs there.
- **Comments wait on the device.** A thread comment written in a chat whose
  computer rests stays on the device that wrote it (desktop and ADE Web,
  localStorage), because a create is a write and would wake the computer. So
  does an edit, tick or delete of a comment the computer already has. The
  send that carries comments applies the changes and hands the new ones to
  the computer first, then sends; the host builds the review block as for
  any comment. Once the computer is awake, any send hands them over (so a
  delete of the last comment reaches it with an ordinary message); while it
  rests, an ordinary message goes to the queue without waiting for the wake.
  Other devices see them only after that send. See
  [chat › thread comments](../chat/README.md).
- **Files wait on the device.** A file pasted, dropped or picked into a chat
  whose computer rests stays in the window that took it (desktop and ADE
  Web, `heldChatAttachments.ts`), because copying it to the computer is a
  write. The send copies it there right before the message and goes direct
  (files never ride the queue from the desktop); a failed copy sends nothing
  and keeps the text and files in the box. The phone already holds files
  and sends them with the queued message. See
  [chat › attachments](../chat/composer-and-ui.md#attachments).
- **What still wakes a resting computer before a send** (a person's
  explicit action on the chat's machine): a permission or mode change (it
  must reach the computer before any other turn runs there, a scheduled wake
  or another device's message included), Codex Daybreak, saving or
  scheduling a draft, a Retry or Discard of a comment whose save failed,
  dismissing an open question card, and a screenshot added from the iOS
  simulator, App Control, the browser or the capture gesture. Model, effort
  and Fast picks wait for the send (`updateSession` in `withSavedChatReads`).
- **A send caught by a sleep** is retried once after the wake: chat
  `sendMessage` carries a `clientSendId` (`isRetriableAfterSleep`), and the
  brain drops a retry it already took. A send to a computer that rests or is
  gone goes to the server queue instead (see
  [the message queue](#send-to-an-asleep-or-deleted-computer-the-message-queue)).
- **Saved chats.** Each row of `GET /cloud/chats` carries `computer`:
  `exists`, or `deleted` with its time and reason (`you`, `freed`, `idle`,
  `plan`, `automation`, `project`, `launch`, `other`). A live computer with
  the copy's machine key wins, so a moved lane's chats read `exists`. A copy
  that no ADE Cloud computer saved reads `null`: it moved with its lane to one
  of the person's own machines. The desktop and the phone list it nowhere
  (`cloudSavedChatsSync.ts`, `restingCloudMachineRows`), because that machine
  lists its own chats and is never a deleted ADE Cloud computer.
- **After a move,** a chat shows once. A machine that lists a chat itself wins
  over a saved copy (`crossMachineLanes.ts`, `useWorkMachineRouter.ts`). The
  saved-chats read gives each chat id one computer: an existing one, then a
  connected one, then the newer copy (`cloudSavedChatsSync.ts`). A move forgets
  this desktop's connection to the deleted source
  (`forgetMachineConnections`).
- **ADE Web** reads saved chats through an online computer (`cloud.read`
  `saved_chats_list` / `saved_chats_read`), else from the account server.
- **Project ids.** A pinned remote call also sends the pin's folder, and
  `callAction` matches the machine's project by id, then by folder
  (`findMachineProject`), never guessing among several.

### Disk and memory

- Disk (`cloudDiskGrow.ts`, `cloudDiskGrowHost.ts`, `cloudDiskGuard.ts`): the
  storage guard follows the cloud computer's own disk
  (`diskPressureThresholdsForSize`): agent turns stop at 5% free, heavy jobs
  at 10%, the warning at 15% (floors 1 GB, 4 GB, 12 GB).
  - The disk grows 4 GB (`POST /resize`, `computerIdle: true`,
    `origin: "auto"`) at the idle point once it is 85% used or past the
    warning, and at the next keep-awake check at the 10% line when only
    someone's use (`in_use`) keeps it busy. One grow at a time, none for 10
    minutes after one starts, a refused one again after an hour.
  - A refusal at the 10% line writes the reason to `ade_disk_full_reason`
    (and `ade_disk_full`); the card and `ade cloud status` show it. A refused
    turn's sentence reads `$ADE_HOME/cloud/disk-grow.json` and names the cloud
    computer's disk, the grow under way, or the way out.
- **Setup that fills the disk** (every size starts at 4 GB, or the disk the repository's setup grew to before):
  - The setup step reads `ENOSPC` in the command's output and says so with
    that line (`laneSetupDiskFullError`). A file-watcher limit is not a full
    disk.
  - On a cloud computer (`cloudDiskGrower.setupDisk`), each setup run keeps a
    4 MB reserve and reads the free space every 2 s. An `ENOSPC` grows the
    disk only when the run's lowest reading was really short (under 1 GB or
    10% free). A launch grows again only when its peak use passed the last
    grown run's, four grows at most.
  - Before the grow, the launch record gets a room mark (`roomMark`); if that
    write fails, nothing grows. A grow that never started is taken back, so a
    Retry grows again.
  - The grow restarts the computer. The brain opens its projects at start
    (see [Timed wakes](#timed-wakes-and-event-wakes)), and a marked launch
    runs its setup again ("running again after
    the disk grew (restart N)"). The mark goes when the environment stage
    settles, on Cancel and on Retry. Past 3 resumes or an hour after the mark,
    the launch reads as interrupted (`chat_launch.environment_resume_refused`).
  - A refused grow fails the stage with its way out and Retry.
    `ade chat launch-status` prints the stage's sentence as `now`.
  - `cloud_repo_disks` (migration 0046) remembers the disk per account,
    origin and lane template (`setupKeyOf`). The server writes it after a grow
    with `origin: "auto"` that the provider made, while a launch on that
    computer is still setting up (its agent stage pending;
    `rememberLaunchSetupDisk`, best effort). For 90 days
    (`CLOUD_AUTO_SIZE_MEMORY_MS`) a new launch of that repository starts at
    that disk (`setupStartDiskGb` in `plans.ts`): in whole 4 GB steps,
    inside the size's limit (there is no account-wide disk since Pricing
    v2); what doesn't fit starts at the most that does, down to 4 GB. A
    move keeps its source's disk.
- **Memory** (`lanes/laneSetupMemoryGuard.ts`): a cloud computer has no swap,
  and out of memory the provider restarts the whole computer.
  - Every setup script and dependency install runs beside a small `sh` guard
    that reads `MemAvailable` every 0.5 s and kills the command's process
    group below a tenth of memory (256 MB to 1 GB). The step fails with
    "Setup used nearly all of this computer's memory (N GB), so ADE stopped it
    before the computer had to restart. …" (`laneSetupOutOfMemoryError`,
    `lane_env_init.setup_stopped_for_memory`).
  - A machine-wide guard (`ade-cli/src/services/power/cloudMemoryGuard.ts`)
    kills the biggest process of the brain's user below a twentieth of memory
    (200 to 512 MB), never the brain, its workers, the entrypoint or the
    provider's processes (`cloud.memory_guard_killed`).
  - The chat hears it (`tellChatsOfCloudMemoryKill`). Before the kill the
    guard reads the process's `ADE_CHAT_SESSION_ID`, which every chat's agent
    process and its commands carry, on all 13 providers
    (`buildAgentRuntimeEnv`). That chat, loaded if it is at rest, gets a
    warning notice: what was stopped, its size, the computer's memory, and
    that a bigger size gives more. Its agent gets a one-time note ahead of
    its next turn (`pendingRestartNote`, the restart-note channel, every
    provider): the same facts and `ade cloud resize --request`. A process
    with no chat id, or a chat no booted runtime has, tells every chat with a
    running turn instead. One notice per chat a minute
    (`reportCloudMemoryKill` in `agentChatService.ts`), so a burst of kills is
    one notice. The command shows as its program and the words before its
    first option, paths cut to their last part, secrets scrubbed
    (`cloudMemoryKillNotice.ts`). A tracked agent CLI's terminal carries its
    own terminal session id as `ADE_CHAT_SESSION_ID` (`ptyService.ts`), and
    so does every command the CLI runs: that id names a session that is not a
    chat, so no chat is told (`notAChat`,
    `agent_chat.cloud_memory_kill_not_a_chat`). The CLI surface gets no
    notice: not supported, a terminal has no notice channel, and its own
    output shows "Killed".
  - Every agent's prompt on a cloud computer has one line
    (`describeAdeCloudComputer` in `adeCloud/cloudComputerRules.ts`): its memory,
    no swap, that "Killed" means the guard stopped it, and
    `ade cloud resize --request`. The runtime block carries it for Claude,
    Codex, Copilot, Droid, OpenCode and Pi; `buildAdeGuidanceForLane` for
    Cursor (beside its 3 KB prompt, outside the budget), Muse and the ACP
    agents (Qwen, Kimi, Grok, Devin, Antigravity). Cursor Cloud and Devin
    Cloud agents run elsewhere and don't get it; nor do personal chats or
    agent CLIs in a terminal (OpenCode's terminal does: it shares the chat's
    prompt).
- **A launch that needs more memory** (`CLOUD_AUTO_SIZE` in `contract.ts`): a
  launch on the default size moves its computer from Small to Medium once when
  the setup guard stops its setup.
  - `cloud.sizeChoice` (`CloudLaunchSizeChoice`): `default`, `picked`, or
    `capped` (an unattended agent's limits refuse Medium). Left out means
    `picked`.
  - The host (`ade-cli/src/services/power/cloudSetupUpsize.ts`) answers yes
    only on a Small whose launch hasn't moved
    (`$ADE_HOME/cloud/setup-memory-moves.json`). It writes a room mark with
    `kind: "memory"` and asks `POST /resize` with `launchId`.
  - The server (`launchAutoSizeCheck` in `launches.ts`) moves only that
    launch's own computer, with `sizeChoice: "default"`, a row at `small` and
    Medium as the target. Else 409 `size_kept` with `error.reason` (`picked`,
    `capped`, `moved`, `not_launch`). The row's `size_id` becomes `medium`
    (`auto_size = 'setup_memory'`). It never loops.
  - `cloud_repo_sizes` (migration 0036) remembers the move per account,
    origin and lane template. For 90 days (`CLOUD_AUTO_SIZE_MEMORY_MS`), a
    default Small launch of that repository starts at Medium
    (`auto_size = 'remembered'`).
  - The app shows the record's size (`adoptServerSize`) and `sizeNote`
    ("Medium: this repo's setup needed more than 4 GB before."). A picked
    Small adds "Small was picked for this launch, so ADE didn't move it up.
    Start it again on Medium (2× hours)."
- The image (see [`infra/ade-cloud/README.md`](../../../infra/ade-cloud/README.md)):
  - `build-essential` and `pkg-config`, so npm packages with native code
    compile on install.
  - `/usr/bin/bwrap` is a wrapper (`infra/ade-cloud/template/bwrap-gvisor.sh`)
    that drops `--unshare-net` only for Codex's sandbox, because gVisor can't
    make the network namespace. Codex's seccomp filter still blocks the
    network: plan mode can't write or reach the network, default mode writes
    only in the workspace, and Codex's network-on setting (on in every ADE
    chat mode and a terminal's Default and Edit) reaches it. When the wrapper
    can't run, Codex falls back to its own bwrap.
  - The GitHub CLI. ADE's `gh` shim adds the account's GitHub token and runs
    it. The brain puts the shim on the first chat after it starts
    (`gitConfigOrigin.ts`).
  - `/etc/profile.d/ade-shims.sh` (`ade-shims-profile.sh`) puts the PATH a
    login shell was given back in front of Debian's, so a login shell outside
    ADE (an SSH session) keeps the `ade` and `gh` shims and the tools. ADE's
    own terminals are non-login shells (see
    [Linux support](../../development/linux-support.md)).

## Timed wakes and event wakes

A sleeping computer can't run its own timers or hear events. The account
directory wakes it (routes in `apps/account-directory/README.md`):

- **Timed wakes.** Before it sleeps, the computer sends its next time
  (`PUT /cloud/wake`, `cloud_wakes`). The minute cron requests its public
  address 2 minutes early, and its row reads `waking` at once. The power log
  shows the wake as `wake` `seen_by_tick` once the tick reads it awake.
  - The next time is the soonest scheduled wake-up or automation cron in an
    open project or in the personal chats (`readMachineNextScheduledWakeAt`).
    A timer due in under 5 minutes keeps the computer awake (`schedule`); one
    that could not be sent keeps it awake for the hour before it.
  - A project's timers run only while the project is open, so the brain
    opens every project of the computer when it starts
    (`cloud.project_open_at_start`). Otherwise a restart (an update at idle,
    a disk grow) leaves the project closed, the new brain sends "no timer",
    the server drops the wake, and the check runs at the next message,
    hours late.
  - The keep-awake's busy read waits for those opens, for at most a minute
    (`cloud.project_open_at_start_slow`). Its first check can sleep a
    computer that woke only for an update, so that check must already send
    the timer. The read never waits on a project still opening after that:
    such a project counts as busy (`unknown`) for up to 10 minutes after the
    brain's start, then it is left out. A hung folder never holds a check
    back, and keeps the computer awake for 10 minutes at most.
  - The last busy read before a sleep also compares the timer. A timer that
    changed during the rest save (a project done opening) is not on the
    server yet, so the computer does not sleep then; the next check sends it
    first.
- **Event wakes.** The computer lists the topics that wake it
  (`PUT /cloud/instances/:id/event-wakes`): a Linear organization, a Linear
  agent account, or the account's custom webhooks. The webhook relay reports
  each event (`POST /cloud/internal/event-wake`), and the directory wakes each
  listed computer under the normal checks, at most once in 5 minutes.
  Repository events wake nothing.

A timed wake and an event wake are use, the same as a person's wake: the time
awake bills hours, and the wake restarts the idle cleanup's clock.

## Rules for changes

- A new call to the provider goes through `CloudProvider`, never around it.
- User-facing text, CLI output and skills say ADE Cloud. "Powered by Agent 37"
  on the settings page is the only product mention.
- What spends hours or deletes a computer asks the person first (`cloudAgentActions.ts`), in hours.
- An agent never makes a computer alone. A new action that adds a computer
  other than a lane launch sets `makesComputer` on its card.
