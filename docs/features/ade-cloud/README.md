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
| CLI and agent verbs, approvals | `cloudAgentActions.ts`, `cloudBrainMaker.ts`, `cloudDesktopActions.ts` |
| A new lane on its own new computer (before the hand-off to its brain) | `cloudLaneLaunchService.ts`, `cloudLaneLaunchRecords.ts`, `registerCloudLaneLaunchIpc.ts` |
| Rules on a cloud computer (one lane, Codex full access) | `cloudComputerRules.ts`, `cloudComputerLaneHold.ts` |
| Desktop IPC | `registerCloudIpc.ts` |
| Reaching ADE's server, access | `cloudServerProvider.ts`, `cloudAccess.ts`, `cloudVaultItems.ts` |
| Server (account directory, `apps/account-directory/src/cloud/`) | `routes.ts`, `store.ts`, `billing.ts`, `cron.ts`, `chats.ts`, `provider.ts`, `accountDeletion.ts` |

Shared contracts are in `apps/desktop/src/shared/adeCloud.ts`, `cloudReady.ts`,
`cloudSignIns.ts`, `cloudTiers.ts` (the four lane sizes, read from the catalog)
and `cloudLaneLaunch.ts`. On a machine, `apps/ade-cli/src/services/power/cloudKeepAwake.ts`
keeps it awake while it works and asks the server to sleep it 3 minutes after
that stops (see Sleep and busy rules).

## Surfaces

- **Settings:** Integrations › ADE Cloud (`CloudSection.tsx`), with Plan and
  hours (`CloudPlanCard.tsx`: hours left, reset date, extra hours for paid
  accounts, buy and manage, which open Stripe's pages in the browser), the
  80% / 95% / out-of-hours banners, and computers due for deletion, ending in
  "Powered by Agent 37". Settings entries are `integrations.ade-cloud*`.
- **Add a computer:** New ADE Cloud computer (a size and a "Full computer
  (Android, Docker)" switch) in Settings and Your computers. The composer no
  longer offers it.
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
- **Look:** the Night sky tokens, the cloud mark, the size icon and the skyline
  live in `remoteTargets/cloudBrand.tsx` and `cloudBrand.css`. A light theme
  changes the tokens there once.
- **CLI:** `ade cloud` (`ade help cloud`), `ade chat create --machine cloud:ready`,
  and `ade chat create --machine cloud [--size <size>]` (a new lane on its own
  computer; see [From the CLI and agents](#from-the-cli-and-agents)).
- **Agents:** the `ade-cloud` skill (see [Guidance for agents](#guidance-for-agents)).
- **Phone:** the cloud page, over the `cloud.read` and `cloud.write` sync commands.
- **Bring your own provider:** `BringYourOwnCloudCard.tsx` is layout only and
  shows only when `BRING_YOUR_OWN_CLOUD_ENABLED` is on. Nothing is wired to it.

## Hours and sizes

Hours are Small-computer hours: free 50 a month, paid 500. Hours, plan, disk and
billing come from `GET /cloud/account` (`CloudAccountState`), read only while
ADE Cloud is visible (`useCloudMachines`). At 0 hours the server refuses, and
that sentence is what the person sees. The eight sizes are Small, Medium, Large
and X-Large, standard or full computer (`CLOUD_SHAPES`, `CLOUD_HOURS_RATE` in
`shared/adeCloud.ts`, matching the server's `plans.ts`). The server picks the
disk and the image; a client never sends either.

## Stored data

Account vault items, scope `all`, kind `integration`: `cloud-budget` (agent
limits only; the name is historical), `cloud-ready` (which projects keep a machine ready),
`cloud-claude-token` and `cloud-key-<provider>` (sign-ins for new machines).
Machine metadata keys are `ade_*` (`ade_machine_key`, `ade_request_id`,
`ade_made_by_chat`, `ade_disk_full`, the ready-machine keys in `cloudReady.ts`,
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
the chat there. `--size` is optional (Small). `ade chat launch --machine cloud`
takes the same flags with `chat launch`'s lane flags (`--from`, `--lane-name`,
`--existing-branch`). The lane starts from the pushed copy of its branch:
`--on uncommitted` and `--on local` are refused, and so are a Linear issue,
`--notify-url`, `--lane`, `--project` and `--clone`. `ade lanes create
--machine cloud` is refused for now: a lane on ADE Cloud starts with a chat.

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
- **The join.** The same rule as a brain's make: the brain approves itself
  only for an unattended yes with a headless browser here (a cloud computer);
  otherwise the sign-in link goes to the agent's chat and to the CLI (stderr,
  and `approvalUrl` in the status).
- **One computer per id.** The launch id is printed first (stderr, `--json`
  too). The same `--launch-id` again answers that launch, and a failed one
  goes on from its failed step; the server returns the same computer for a
  repeated request id. Ctrl-C stops only the waiting: the launch goes on in
  the brain, which resumes saved records 5 s after it starts.
  `ade chat launch-status <id> --machine cloud` reads it, and
  `ade chat launch-cancel <id> --machine cloud` stops it and deletes its
  computer (only the chat that started it, or the person).
- **Output.** Text: the launch view with the lane, the chat and
  `ADE Cloud · <computer>`. `--json`: `{ok, launchId, phase, laneId, laneName,
  sessionId, machine {name, instanceId, machineKey}, approvalUrl, launch}`. A
  failed or cancelled launch exits non-zero with the card's sentence.

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
(`.github/workflows/cloud-template.yml`), and a tested build is moved to with
`infra/ade-cloud/promote-template.mjs`. The server creates from one pinned
version; the client doesn't choose. "Update this computer" moves one computer
to it (`updateInstance`).
On first boot a new machine installs the ADE version of the app that made it,
when the image's ADE is older.

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
- Disk (`cloudDiskGrow.ts`): when idle and at 85% used, a paid computer grows 4 GB
  through `POST /resize` with `computerIdle: true`. Refused at the plan or the 40 GB
  shared limit, and full at 95%, the computer's card says so in a plain sentence.

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
