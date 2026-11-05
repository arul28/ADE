# Agent 37 machines

Agent 37 sells persistent Linux machines ("boxes", and VMs) metered by the
minute and driven by a workspace API key. ADE treats it as an integration next
to GitHub, Linear and Jira: connect a key once, and **New Agent 37 machine** in
Add a computer makes a box that runs ADE's brain, signs in to the person's ADE
account with nothing to type, and appears under Your computers. From then on
it is an ordinary remote machine (relay, LAN or tailnet; see
[README](README.md)). The product plan, the measurements behind it and the
phases still to build (ADE-owned sleep, fork and move, `ade` verbs for
agents) are in
[docs/plans/agent37-integration.md](../../plans/agent37-integration.md).

Everything here is account-level: it acts on the Agent 37 workspace and the
ADE account, never on a lane, chat or another machine, so none of these IPC
calls take a pin. They run in the desktop main process of the computer the
person is using.

## Source file map

- `apps/desktop/src/main/services/agent37/agent37Client.ts` — the Agent 37
  control plane (`api.agent37.com/v1`) and exec (`sandbox.agent37.app/v1`) for
  one key. Every failure is an `Agent37Error` keyed on Agent 37's stable
  `error.code`, with a sentence a person can act on. The key is only a header:
  never logged, never in an error. The request timeout covers the response
  body too.
- `agent37Credential.ts` — where the key lives: the account vault item
  (`all` / `integration` / `agent37`) when signed in, else this computer's
  shared credential file (`agent37.apiKey.v1`), which the desktop, the brain
  and the CLI all read. `removeAgent37Key` refuses (and keeps every copy) when
  the account confirms it holds the key and will not let go; when the account
  can't be read it removes this computer's copy and says the account copy is
  unverified. Also the connect card's status/save adapter, used by the brain
  (`adeActions/registry.ts`).
- `agent37TemplateBuilder.ts` — builds ADE's template in the person's
  workspace (see below).
- `agent37MachineCreator.ts` — `createAgent37Machine`, the New Agent 37
  machine flow.
- `agent37PendingCreates.ts` — the on-disk record of creates not yet
  resolved, the startup reconcile, and `readAgent37BoxSignedIn`.
- `agent37Machines.ts` — the machine list (`listMachines`: every box in the
  workspace with its state, size, prices and spend) and the box actions
  (`machineAction`: Sleep, Wake, Resize, Back up, Delete box), each refusal
  mapped to a sentence and a blocker. Also `recordAgent37MachineKey`, which
  tags a box with its ADE machine key when it joins.
- `agent37ReadyMachines.ts` — ready machines: the keeper that prepares one
  machine per project and keeps it asleep, and the setup job it hands the box.
- `agent37ReadySettings.ts` — the per-project choice (account vault, else
  this computer's `agent37.ready.v1`), shared by the desktop and the brain.
- `agent37ReadyClaim.ts` — claiming a ready machine (tag it `claimed`, wake
  it) and giving an unused claim back. No window and no Electron, so the
  brain uses it too.
- `agent37Sleep.ts` — sleep and money: turning Agent 37's idle sleep on for
  a box once its brain keeps it awake (`enableAgent37Sleep`), the per-box
  setting, waking a box for use (`wakeAgent37MachineForUse`), and the monthly
  cap's store. `agent37BrainAccess.ts` is the same for a brain (the key, the
  cap, wake for `--machine` calls); `agent37WakeHook.ts` lets the desktop's
  remote connections ask for a wake.
- `apps/ade-cli/src/services/power/agent37KeepAwake.ts` — on the box: while
  work runs, the brain requests the box's own wake URL once a minute.
- `apps/desktop/src/renderer/components/settings/Agent37SpendingCard.tsx` —
  the Spending card (this month against the cap, saved asleep, how long the
  wallet lasts, the cap).
- `agent37MachineCopy.ts` — Copy (Agent 37's fork, then the new-machine
  sign-in) and Move (box ↔ VM: a new machine, the home folder streamed over,
  the old box deleted).
- `agent37AgentActions.ts` — the machine verbs of the `agent37` action domain
  (`ade agent37 list|create|sleep|wake|resize|copy|move|delete|sleep-after|cap|
  spending|ready on|off|retry`) and their approval cards.
  `agent37DesktopActions.ts` is the desktop half the brain reaches over the
  desktop bridge (`agent37.*`, `agent37DesktopBridgeClient.ts` in the CLI) for
  what signs a new machine in.
- `apps/desktop/resources/agent-skills/ade-agent37/SKILL.md` — the skill
  agents read before using them.
- `agent37ReadyActions.ts` — the `agent37` action domain on a brain
  (`ready_status`, `claim_ready`, `release_ready`) behind `ade agent37 ready`
  and `ade chat create --machine agent37:ready`.
- `registerAgent37Ipc.ts` — the `ade.agent37.*` IPC handlers, the hidden
  approval window, the template-build record store (account vault with a
  per-computer fallback), and the startup check 20 s after boot.
- `apps/desktop/src/shared/agent37.ts` — shapes, prices, kinds, status and
  progress types shared with the renderer.
- `apps/desktop/src/renderer/components/settings/Agent37Section.tsx` — the
  Agent 37 page under Settings › Integrations (key, wallet, template state,
  Retry, Disconnect).
- `apps/desktop/src/renderer/components/remoteTargets/NewAgent37MachineForm.tsx`,
  `useAgent37Template.ts`, `agent37Brand.tsx` — the create form in Add a
  computer, its template status, and Agent 37's real logo (monochrome; never
  invented art).
- `useAgent37MachineGroup.tsx`, `Agent37MachineGroup.tsx`,
  `agent37MachineModel.ts`, `useAgent37Machines.ts`, `useAgent37BoxActions.tsx`
  — the Agent 37 group in the machine list (`RemoteTargetList.tsx` draws its
  rows): which rows move to the group, its head and banners, the fact line on
  each card, which account row is which box, and the box menu with its
  confirmations and the resize picker.
- `apps/desktop/src/renderer/components/settings/Agent37ReadyMachinesCard.tsx`
  and `components/chat/useAgent37ReadyDraftMachine.ts` — the Ready machine
  card on the Agent 37 page, and the "Agent 37 · ready" row in the new-chat
  machine picker.
- `infra/agent37/` — the template's Dockerfile and entrypoint (shipped in the
  app as the `agent37-template` resource) and a manual build script.
- `apps/ade-cli/src/services/sync/hostInstanceGuard.ts` — the copied-home
  guard a forked box needs (see below).
- `apps/ade-cli/src/serviceManager/detachedSupervisor.ts` — `ade brain
  start/stop/restart` on Linux without systemd (an Agent 37 box has none).

## The template

Agent 37 templates are per workspace, so a workspace that has never seen ADE
has nothing to make a box from. Saving the key, and every app start with a key
saved, runs the builder: it reads the template and, when it is missing or was
built for an older ADE release, runs Agent 37's cloud build over its REST API
(create a build, upload the gzipped context, start, poll). No CLI and no local
Docker.

- What a template installs is in its description, `ADE <version> · template
  <hash>`, so every computer reads the same answer. A release build replaces a
  template with no marker, other template files or an older ADE; a newer one
  stays. A development or alpha build bakes the newest release and only ever
  creates a missing template.
- Two computers can check at once, and the account vault has no
  compare-and-set. A build only runs once it is uploaded and started, so the
  builder claims before that: it writes the build-in-flight record, waits five
  seconds, and reads it back. The record's last write is the one answer every
  computer reads, so it decides: when it holds another computer's claim for
  the same template whose build has not failed, this computer follows that
  build and never rewrites the record; its own is never uploaded or started
  (Agent 37 cannot cancel a build, so an unstarted one is left behind). A
  record that can't be read, a claimed build that can't be checked, or a claim
  that didn't land stops the pass and retries: unknown is never "nobody is
  building".
- A finished build is ready only once Agent 37 shows the template with this
  build's marker (ADE sets it when the build published without one). Until
  then the record stays, so a later pass resumes.
- Failures retry after 1, 5 and 15 minutes, then wait for Retry. A refused key
  or an empty wallet does not retry.

## New Agent 37 machine

1. Everything that can fail before money is spent is checked first: the
   template is usable, the account service is configured, this computer is
   signed in to ADE.
2. The create is written to this computer's credential file **before** the
   request goes out, under a request id that ADE also puts in the box's
   metadata (`ade_request_id`). If it can't be written, no box is made.
3. Agent 37 answers once the box is running. ADE waits for the brain (the
   box's main process), runs `ade login --headless` on it over exec, and
   approves the code with its own account through the account directory's
   `POST /device/approve`, which answers with a one-time sign-in link. The
   link opens in a private, hidden window that is shown only if the page
   stops on something the person must confirm. The account token never leaves
   this process and nothing durable is planted on the box.
4. ADE waits for the box's row in the account list, gives it the chosen name
   and connects. A box that is signed in but not ready by the deadline is a
   partial result: the picker keeps watching for its row.

Cancel (Cancel, closing the dialog, or the window going away) reaches every
step, including the approval request. A box that never signed in is only a
bill, so any failure deletes it, and the record goes only once Agent 37
confirms the deletion.

### Half-made boxes

A create can end without ADE knowing the box's id: a lost answer, an app quit
mid-request, a failed list or delete. The pending record covers all of them.
Whoever finds it (the create's own failure path, or the next app start)
reconciles it: it lists the workspace's boxes by `ade_request_id`, and for
each one asks the box `ade auth status`:

- **signed out** (or no ADE on the box at all, exit 127): deleted;
- **signed in**: a real machine, kept;
- **unknown** (asleep, unreachable, timed out, an answer ADE can't read):
  kept, with its record, for the next start. A box that may be someone's real
  machine is never deleted on a guess.

A record that matches no box is kept for a day, in case Agent 37 still had
the create in flight, then dropped. Boxes made by another request id (another
computer's create, or not ADE's) are never touched.

## The machine cards

In the machine list (Your computers), every Agent 37 box leaves its usual
section for an **Agent 37** group below them. The group's head shows the
number of boxes, what they cost per hour now, what they spent, and the wallet.
Each card keeps its ordinary row (connect, rename, update) and adds a fact
line: the state (Running, Asleep, Starting, Stopping, Stopped, Error,
Suspended), the type and size, the price in that state (asleep and stopped
pay only the disk), the spend, the lanes on the box and the chats running
there. Lanes and chats come from account Activity, so ADE never wakes a box
to read them.

**Which row is which box.** When a box joins, the creator writes the
machine's ADE key into the box's metadata as `ade_machine_key` (Agent 37
replaces metadata on PATCH, so ADE merges first). A box without the tag
matches the account row whose hostname is the instance id (Agent 37 sets the
hostname to the instance id). A box ADE made that matches no row (still
joining, removed from ADE, never signed in) gets a row of its own, because it
still bills. It reads "Setting up…" only while it is new and has no machine
key yet; a box with a key has joined, so it reads "Not in ADE". Boxes ADE did not make stay out of the list unless a row matches
them.

**A sleeping box's row.** A box that is asleep, stopped or suspended can't
take a connection, so its row says so ("Asleep on Agent 37") with a dim dot,
and Wake (or Top up) takes the place of Connect. The account's own presence
lags the box by up to a minute either way; after a wake, while Agent 37 says
the box runs but its row still says asleep, the list reads the account again
every 15 s for at most 3 minutes.

**Reads.** The list asks when it opens, on window focus and when the
integration changes (a box action, a finished create, a new key). Only while
a box moves between states does it ask again, every 4 s for at most 5
minutes. Spend comes from `GET /usage` over the last
90 days (cached for 5 minutes); Agent 37 settles it once an hour, so the
newest minutes show later. A box newer than 90 days shows "so far", an older
one "in 90 days".

**Actions** (the card's menu; a sleeping box also gets Wake on its card):

| Action | What happens | Asks first when |
| --- | --- | --- |
| Sleep | `POST /instances/{id}/sleep`; only the disk bills | chats run on it |
| Wake / Start | `POST /instances/{id}/start` | never; at the limit, says what to do |
| Resize | `POST /instances/{id}/resize`; the box restarts and running work stops; the disk only grows | always (the size picker); it names the running chats |
| Back up | `POST /instances/{id}/backups`; Agent 37 allows one in 15 minutes | never |
| Remove from ADE | the account row goes (and this computer's saved connection); a box keeps running and billing | always |
| Delete box | deletes on Agent 37, waits until it is gone, then removes the account row | always; names the box and says its files are gone |

Every machine on the account, Agent 37 or not, has **Remove from ADE**. ADE
never calls it "sign out". On a box's row it replaces "Remove from this
computer" (it removes the saved connection too); a saved box with no account
row keeps "Remove from this computer". When the box is gone but the account
row can't be removed, the card says so and offers Remove from ADE.

A box action answers once Agent 37 is done, which for a resize that moves
hosts or a backup of a big disk takes minutes. The two IPC channels have their
own budgets in `ipcTimeouts.ts` (the longest call plus a minute), so the card
never shows a timeout for an action that is still running.

**Agent 37's refusals** become a sentence and a next step: the machine limit
(on tier 0 every box counts; after the first top-up only awake ones), an empty
wallet or one that can't pay for the change (Top up), a suspended workspace
(every box asleep and not billing; deleted after 30 days), a revoked key
(Connect a new key), and the backup rate limit. A wallet that lasts under
three days at the current rate shows a warning in the group.

None of these calls take a pin: the key is the account's, and the calls go
from this desktop's main process to Agent 37. The settings search finds the
card as **Agent 37 machines** (Settings › Integrations › Agent 37).

## Sleep and spending

A box sleeps on its own once nothing has run on it for a few minutes (10 by
default; 5, 30, 60 or never from **Sleep when idle…** on its card), and wakes
when it is used. Asleep, it keeps its memory and only its disk bills.

**Who sleeps it.** Agent 37 does, with its own auto-sleep: once nothing has
reached any of the box's URLs for the idle timeout, it checkpoints the box.
That happens with every ADE window closed, so a laptop that shuts never
leaves a box billing. Agent 37 counts only traffic through the box's URLs,
and a brain works through an outgoing relay connection it doesn't count, so
its timer alone would sleep a working box. So the brain on the box keeps it
awake: while a chat turn, a running terminal command, an agent CLI, a ready
machine's setup, or a scheduled wake-up due within the hour is there, it
requests the box's **wake URL** once a minute (`agent37KeepAwake.ts`). The
wake URL is a public port ADE makes with the box (port 7337, a random
hostname). Nothing listens on it: Agent 37 answers 502, which still counts as
traffic. ADE-only sleep (a desktop calling `sleep`) was rejected because it
needs a desktop online; Agent 37-only sleep because it sleeps working boxes.

Measured on real boxes (2026-11-05): pings kept a box with a 300 s timer
awake 415 s and more; once work stopped it slept 312 s later; a request to
the wake URL of a sleeping box woke it in 0.59 s.

**Turning it on.** A new box is made with its wake URL and auto-sleep off.
Once it has signed in, ADE hands the URL to the box (`$ADE_HOME/agent37/
wake.json`, with the box's id, so a forked copy of the disk never keeps the
source awake) and switches auto-sleep on only when the box's brain has written
`keep-awake.json`, which an ADE that pings writes at start. An older brain
never pings, so its box stays awake ("Sleeps once ADE on it updates" on the
card). Every ten minutes the desktop turns sleep on for awake ADE boxes still
waiting for it; nothing there wakes a box. **Never** is kept in the box's
metadata (`ade_sleep`), so ADE leaves that box alone.

**Waking it for use.** These wake an asleep box and wait for it to come back
(about 5 s on an ADE with the reconnect fixes):

- an explicit Connect, or opening a project or lane there (the desktop's
  remote connection, through `agent37WakeHook.ts`);
- a call that changes something there: sending to a chat, a terminal command,
  a file write (`write` actions in `adeActionAccess.ts`). Background reads
  never wake a box, or an open window would keep it awake forever;
- any `--machine` call from an agent, the CLI or the CTO (the brain's
  `agentMachineBridge`, with the account's key).

Agent 37's own **Wake** on the card still works. The phone has no Agent 37
key, so it can't wake a box yet.

**The monthly cap.** One cap for every Agent 37 machine on the account
($20 by default; $5 to $100 or off on the Spending card), kept in the account
vault. At the cap ADE makes, wakes, resizes and copies nothing, and says so;
running work carries on and boxes still sleep when idle. From 80% the group
and the card warn, and the desktop notifies once per month at 80% and 100%.
The spend is Agent 37's `GET /usage` for this UTC month, which Agent 37
settles hourly, so the newest hour shows later.

**Saved by sleeping** is, per box, its spend window at the running rate less
what it actually spent: the compute its asleep hours didn't cost. The group
head and the Spending card add it up.

**A wallet about to run dry.** The machine group warns under three days at the
current rate, the Spending card says how long the wallet lasts, and the
desktop notifies once a day when it lasts under a day.

## Copy and move

**Copy** (card menu, `ade agent37 copy`) makes a second machine with the same
disk: repos, lanes with their uncommitted work, installed dependencies, build
caches. It is Agent 37's fork. The copy boots fresh (nothing that ran on the
source runs), and the copied-home guard starts it signed out as a new
machine, so ADE signs it in like a new one, names it, and turns its sleep on.
It is the fast way to get a fresh machine for a lane from a warm one. The
fork carries no ADE identity, ready-machine tag or wake URL of the source
(the wake file names its machine's id, so a copy never keeps the source
awake). A big disk takes minutes: a warm VM with an 8 GB Supabase stack took
167 s.

**Move** (card menu "Move to a VM…" / "Move to a box…", `ade agent37 move
--to vm|box`) changes a machine's type, which Agent 37 can't do in place
(resize keeps the type and fork ignores it):

1. ADE makes the new machine (signed in, its own identity).
2. It pauses ADE on the old one (`$ADE_HOME/brain.paused`: the entrypoint
   holds the brain, so every database is copied whole) and has it serve its
   home folder once, gzipped, behind a one-hour signed Agent 37 URL.
3. The new machine pulls it into its home folder: every repo, lane worktree
   with its uncommitted work, the projects' chats, and provider sign-ins. Not ADE's
   own home (`~/.ade`, which holds the machine's identity), Docker's data,
   or the projects' cr-sqlite site ids.
4. It registers the old machine's projects with its ADE, takes the old name,
   and the old box is deleted (its row too).

A failure before the files land deletes the new machine and lets the old one's
ADE start again, so nothing is lost. Running processes and Docker containers
don't move; a setup starts them again.

Moving one chat and its lane between computers (this Mac and a cloud machine,
or two cloud machines) is the cross-machine handoff, `ade chat move` (see
[cross-machine-session-handoff.md](../sync-and-multi-device/cross-machine-session-handoff.md)):
it carries the lane's commits and uncommitted work as a bundle to any machine
on the account, so nothing Agent 37-specific is needed there.

## Agent commands

`ade agent37 …` reaches the `agent37` action domain of the brain the CLI talks
to (see `ade help agent37` and the `ade-agent37` skill): `list`, `spending`,
`create`, `sleep`, `wake`, `resize`, `copy`, `move`, `delete`, `sleep-after`,
`cap`, and `ready on|off|retry|status`. Reads are free. `create`, `copy` and
`move` sign the new machine in through the desktop attached to that brain
(over the desktop bridge); a brain with no desktop says so.

**Approvals.** What spends money or deletes asks first: create, resize, copy,
move, delete, "never sleep", raising or removing the cap, and turning a ready
machine on. The RPC server stamps who asks (never the arguments):

- the person's own client (the desktop, the CTO thread): no card;
- an agent in a chat: an approval card in its own chat, which gives up after
  5 minutes ("nobody answered, so nothing was done");
- a full-auto chat or an automation run: nobody is watching, so ADE answers
  on the spot and leaves a line in the chat: yes to spending (the monthly cap
  still applies), no to what can spend past the cap (raising or removing it,
  "never sleep"), no to deleting a machine
  that chat didn't make (machines an agent makes carry `ade_made_by_chat`,
  which a copy does not inherit). Plan mode says no to everything;
- a shell with no chat: refused, with where to do it instead.

Wake is not asked: it is what using the machine does anyway, and the cap
bounds it. At the cap ADE also prepares and hands out no ready machine. Remote MCP callers reach only the reads.

## Ready machines

A ready machine is one ADE keeps prepared for a project and asleep: the
repository cloned, the person's setup run, its services started, signed in.
A new chat on it wakes it (Agent 37 answers in about a second) and is working
in seconds, which is what a prepared seed is in other products. Asleep it
bills only its disk. Turn it on per project on the Agent 37 page (Ready
machine: box or VM, size, setup commands); the card shows what it costs
asleep and awake, the step it is on while preparing, and Retry after a
failure.

- **The pool lives on Agent 37.** Each machine's metadata says which project
  it is for (`ade_ready_for`, the git identity `github.com/owner/repo`) and
  where it is: `preparing`, `ready`, `claimed`, or `failed`. Every computer,
  the brain and the CLI read the same answer without talking to each other.
- **Preparing runs in the desktop** (`agent37ReadyMachines.ts`), because
  signing a new machine in uses the approval window. It makes the machine
  with the New Agent 37 machine flow, then writes a setup job to
  `$ADE_HOME/ready/job.sh`: clone over HTTPS, `ade projects add`, wait for
  Docker on a VM, the person's commands. The template's entrypoint runs the
  job, so what it starts is part of the entrypoint's process tree and
  survives sleep. Then ADE tags the machine `ready` and sleeps it.
- **Claiming** (`agent37ReadyClaim.ts`) tags the oldest ready machine
  `claimed` with a claim token and wakes it. From then on it is an ordinary
  machine of the person's, never touched by the keeper, and the next pass
  prepares the next one. A claim nothing used (the person picked another
  machine or closed the draft mid-wake, the connect timed out, or the CLI
  failed before sending) is given back: `ready` again, and asleep. Only the
  holder of the claim token can give it back, so one caller never sleeps a
  machine another caller's chat is on.
- **Starting the chat.** In the new-chat picker, "Agent 37 · ready" claims
  and wakes the machine as soon as it is picked, so the wake overlaps the
  typing, then pairs, connects and selects it like any machine. From the CLI,
  `ade chat create --machine agent37:ready` claims through this computer's
  brain, waits until ADE shows the machine online (a machine still shown
  offline refuses work at once, "Nothing was sent") and a harmless call
  through it succeeds, for up to two minutes, then sends the chat once. With
  no `--lane` the chat starts in the project's primary lane there (recorded
  on the machine at setup). `--json` adds `readyMachine` (name, machine key,
  instance id, lane id, wake, online and sent times). `ade agent37 ready
  --json` reports each project's pool.
- **Money.** A failed prepare deletes its machine and is recorded with the
  project's choice (and in memory, if the choice can't be saved). ADE tries
  again on its own twice, after one and five minutes (never when it couldn't
  confirm the delete, or the template can't run a setup), then waits for
  Retry; a prepare that works clears the failure. Turning a
  project off deletes its unclaimed machine and its account row, but only
  when the account answered with the choice: a choice read from this
  computer alone deletes only machines this copy of ADE made. A machine
  still `preparing` that this copy started before it quit (`ade_ready_by`, a
  random id in the app's data folder) is deleted on the next pass; anyone
  else's after an hour. A machine Agent 37 reports as failed is deleted. Each
  machine is read again right before a delete or a sleep, so a claim that
  landed meanwhile is never touched. A quit stops a prepare in flight and
  deletes its machine on the way out.
- **Versions.** Ready machines record the ADE release their template
  installed (`ade_ready_ade`); once the template moves to a newer release,
  an unclaimed older one is replaced. Packaged builds pin the template to
  their own version (a beta app bakes its beta).
- **Fresh, not forked.** Measured again with Copy (2026-11-05, 4/8 VMs,
  supabase-stack): a fresh prepare took 101 s; a fork of the prepared machine
  took 156 s to copy its disk (8 GB of images) plus 13 s to sign in, and its
  stack was back in 1.3 s, so about 170 s. A small box forks in 24 to 34 s,
  about what a fresh box plus a light setup costs. A fork costs disk-copy
  time, which grows with exactly what a heavy setup leaves behind, so the
  pool keeps preparing fresh, and Copy stays the person's tool for a warm
  machine per lane.

The template runs Docker on a VM: `docker-ce` with compose and buildx, started
by the entrypoint as root through one sudoers rule
(`ade-entrypoint.sh --root-setup`), after it loads the netfilter modules
the VM kernel ships unloaded (without them dockerd can't make its NAT chain
and exits). Its data is under `/home/node/.docker-data`, and the socket's
group is `node`. A sandboxed box (gVisor) has no Docker and skips it. The
entrypoint also sets `IS_SANDBOX=1` (Claude Code refuses full-auto as root
otherwise) and `ADE_SUSPEND_GAP_TICK_MS=1000` (the brain notices a wake within
a second and reconnects).

Nothing here takes a pin: the choice is the account's, the pool is Agent
37's, and the chat goes to the claimed machine through its own connection.

## Android on a VM

The Android tool (`ade android …`, the Android pane) runs on an Agent 37 VM
like on any Linux machine with KVM. The template carries what it needs:

- **The SDK in the image**, at `/opt/android-sdk`: platform-tools, the
  emulator, cmdline-tools (ADE reads the device profiles from its `sdklib`
  jar) and the Android 14 (API 34) `google_apis` x86_64 system image. In the
  image it is read-only and costs nothing against the machine's disk; Java is
  only used to install it. The entrypoint sets `ANDROID_HOME` and
  `ANDROID_SDK_ROOT` in the brain's own environment, so the tool finds it.
  The phone's own storage (the AVD) lives in `~/.android` on the disk.
- **`/dev/kvm` for the brain's user.** The VM's kernel has hardware
  virtualization; the root step gives the device to group `node` (the brain
  runs as `node`). A sandboxed box has no `/dev/kvm`, so Android needs a VM.
- **The live view** uses the scrcpy server jar the standalone brain ships
  (from 1.2.129-beta.8).
- **Size:** 4 vCPU / 8 GB runs one emulator; 4/16 if Gradle builds run there
  too.

## The copied-home guard

Agent 37's fork copies the whole disk, so a forked box would come up as the
machine it was copied from: same relay key, device id, account session and
every project's cr-sqlite site id. ADE's template sets
`ADE_HOST_INSTANCE_ID=agent37:<hostname>`, and `ade serve` calls
`guardAgainstCopiedAdeHome` first. The brain records the id beside its
identity; a later start with a different id moves `secrets/` aside to
`copied-identities/` (never deleted) and retires each registered project's
`.ade/secrets/sync-site-id`, so the box starts signed out as a new machine and
keeps every file. Until every site id is retired the brain refuses to serve,
and the next start finishes what is left. The moved folder and the retired site
ids are named for that one reset (old id to new id), and the folder is marked
`.done` when the reset finishes, so a finished reset never lets a later copy
skip its own. Without the variable the guard does
nothing, so a renamed laptop is never mistaken for a copy.

## Permissions of a chat started from the CLI

`ade chat create` (with or without `--machine`) gives the new chat at most the
calling agent's own level: an agent can't hand out more access than it has.
The brain reads that level from the calling chat. A chat it can't find (the
CLI's `ADE_CHAT_SESSION_ID` names a chat on another ADE on this computer, such
as the installed brain while the CLI talks to a dev brain) reads as `ask`, so
the new chat is capped there; Codex at `ask` runs sandboxed with no network.
That is the safe answer, and it stays. The chat's notice now says which case
it is ("the chat that ran this command isn't on this ADE"), and the fix is to
run the CLI from a chat on the same ADE, or start the chat from the desktop.
Across machines the level travels with the request, so `--machine` from a
known chat keeps it.

## Logging and analytics

Failures log under `agent37.*` (desktop main) and `host_instance.*` (the
brain), never with the key, the account token or the approval link (the
window logs host and path only). A finished create records one coarse product
fact, `ade_feature_used` with `feature: "connections"`, `action:
"agent37_machine_create"` and `completed`, `partial`, `cancelled` or `failed`;
see [docs/logging.md](../../logging.md).
