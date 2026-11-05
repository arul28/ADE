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
  machine per project and keeps it asleep, the setup job it hands the box,
  and the per-project choice (account vault, else this computer's
  `agent37.ready.v1`).
- `agent37ReadyClaim.ts` — claiming a ready machine (tag it `claimed`, wake
  it) and giving an unused claim back. No window and no Electron, so the
  brain uses it too.
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
  `claimed` and wakes it. From then on it is an ordinary machine of the
  person's, never touched by the keeper, and the next pass prepares the next
  one. A claim nothing used (the person picked another machine, or the CLI
  failed before sending) is given back: `ready` again, and asleep.
- **Starting the chat.** In the new-chat picker, "Agent 37 · ready" claims
  and wakes the machine as soon as it is picked, so the wake overlaps the
  typing, then pairs, connects and selects it like any machine. From the CLI,
  `ade chat create --machine agent37:ready` claims through this computer's
  brain, waits until ADE shows the machine online (a machine still shown
  offline refuses work at once, "Nothing was sent"), then sends, retrying
  only refusals that sent nothing, for up to two minutes.
- **Money.** A failed prepare deletes its machine and is recorded with the
  project's choice, so no computer and no restart tries again on its own;
  Retry does. Turning a project off deletes its unclaimed machine and its
  account row. A machine still `preparing` that this copy of ADE started
  before it quit (`ade_ready_by`) is deleted on the next pass; anyone else's
  after an hour.
- **Fresh, not forked.** A fork of a warm VM took 167 s (it copies the disk,
  boots fresh and comes up signed out by design); a cold bring-up of the same
  Supabase stack took 93 s. So the next machine is made fresh.

The template runs Docker on a VM: `docker-ce` with compose and buildx, started
by the entrypoint as root through one sudoers rule
(`ade-entrypoint.sh --start-dockerd`), after it loads the netfilter modules
the VM kernel ships unloaded (without them dockerd can't make its NAT chain
and exits). Its data is under `/home/node/.docker-data`, and the socket's
group is `node`. A sandboxed box (gVisor) has no Docker and skips it. The
entrypoint also sets `IS_SANDBOX=1` (Claude Code refuses full-auto as root
otherwise) and `ADE_SUSPEND_GAP_TICK_MS=1000` (the brain notices a wake within
a second and reconnects).

Nothing here takes a pin: the choice is the account's, the pool is Agent
37's, and the chat goes to the claimed machine through its own connection.

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

## Logging and analytics

Failures log under `agent37.*` (desktop main) and `host_instance.*` (the
brain), never with the key, the account token or the approval link (the
window logs host and path only). A finished create records one coarse product
fact, `ade_feature_used` with `feature: "connections"`, `action:
"agent37_machine_create"` and `completed`, `partial`, `cancelled` or `failed`;
see [docs/logging.md](../../logging.md).
