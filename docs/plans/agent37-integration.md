# Agent37 integration — plan

Status: plan, partly prototyped. Lane `ade/agent37-integration`. Written
2026-11-03 from the owner's decisions and experiments on real Agent37
machines (numbers below are measured unless marked "published rate").

Builds on the connect-cards lane (`ade/integration-connect-cards`): the
Integrations page, how a credential is asked for and stored, and the
approval cards agents raise all come from there. Nothing in this plan
re-implements them; the Agent37-specific parts start after that lane merges.

## 1. What Agent37 is, for ADE

Agent37 sells persistent Linux machines metered per minute, driven by an
API key (`sk_live_…`; no OAuth, no event webhooks). Three types:

| Type | What it is | Runs | Compute price |
|---|---|---|---|
| default ("box") | gVisor sandbox, Debian 12, PID 1 `tini`, no systemd | ADE brain, lanes, agents, Linux Desktop lane screens | 1x |
| `vm` | full VM (Ubuntu 26.04, own kernel, `/dev/kvm`, Docker) | all of the above + Android emulator + Docker | 2.5x |
| `performance` | dedicated cores, own kernel | like default, never throttled | 4x |

Shapes (all types, max 4 vCPU): 2/4, 4/8, 4/16, 4/32 GB. Published rates
per running hour: box 0.6¢ / 1.2¢ / 2¢ / 3.5¢; VM 1.5¢ / 3¢ / 5¢ / 9¢.
Asleep or stopped, only disk bills (~9¢ per GB-month). Workspace tiers cap
how many machines exist at once (tier 0: 1 and no VMs; first top-up: 10;
$100: 50; $250: 200; sleeping ones count). The $5 card credit is not a
top-up. A create needs one day of the machine's rate in the wallet.

## 2. Owner decisions (2026-11-03)

- **First-class integration** next to GitHub, Linear and Jira, on the
  Integrations page (from the connect-cards lane).
- **Machine picker:** when Agent37 is connected, a "New Agent37 machine"
  button. It picks type and size, lists plainly what that choice can and
  cannot do, and shows the price per hour.
- **Machines list:** Agent37 machines get their own group and cards: state,
  size, cost, lanes; Sleep, Wake, Resize, Fork, Back up; and two removals:
  **Remove from ADE** (any machine: the account row goes, the box keeps
  running) and **Delete box** (Agent37 only: deletes on Agent37 and removes
  from ADE, after a confirmation that names it and says its files go).
- **No second sign-in:** a new machine is ready to use with ADE without
  approving a code.
- **ADE owns sleep and wake,** designed to save as much money as possible
  without ever sleeping a box that is working.
- **Lane placement is the user's choice:** many lanes on one box, a box per
  lane (fork a warm project box), or mixed with their own machines.
- **Agents drive all of it** through `ade` primitives and a skill: they can
  see a box is too small or idle and offer an upgrade, downgrade, move or
  sleep as an approval card; "stop" means stop.
- **Android** on Agent37 waits for the Android emulator lane; that work
  already targets Linux and will behave the same as iOS cross-machine.

## 3. What the experiments established

| Question | Answer |
|---|---|
| ADE on a default box | Installs in 16–20 s (after the Debian `mawk` fix on this branch). Brain, projects, lanes work. |
| Linux Desktop lane screen on a default box | Works fully: Chromium, element map, clicks, 1920×1080 screenshots, MP4 recording. Needs `xvfb openbox dbus at-spi2-core ffmpeg` (root). |
| Android on a default box | Impossible: no `/dev/kvm`, no `/dev/binder`. Forced software emulation died before boot. |
| Android on a VM 4/8 | Android 14 x86_64: downloads in 7 s, cold boot 24 s, tap 84 ms, `screencap` 938 ms, `screenrecord` H.264 works headless, ~4.8 of 7.9 GB used with ADE. Use 4/16 for Gradle. |
| Resize within a type | ~2 s, every file kept; the box restarts (running processes stop). Disk grows, never shrinks. |
| Change type | Refused by Agent37 ("type cannot be changed"); fork ignores type; restore is same-box only. Moving box ↔ VM is an ADE copy. |
| Sleep | Wake answers in 1.3–2.2 s. The box's **entrypoint process tree survives** (checkpoint restore); anything started later through Agent37's exec API is killed. Agent37's own auto-sleep counts only traffic through the box's URLs, so a busy ADE brain looks idle to it. |
| Brain as entrypoint (prototype template `ade-brain-proto`) | Box ready in 19 s with the brain running at role `cto`; survives sleep (same process) and resize (restarted by the entrypoint loop). |
| Sign-in | `ade connect --headless` + one approval publishes the box. |
| Short sleeps in ADE | A ~1 min sleep never shows as asleep (presence TTL); publishing resumes on wake. |
| **Fork** | **Identity collision:** the copy reuses the machine key, steals the relay tunnel, and the two boxes take turns renaming the one account row. Also every project's cr-sqlite site id is copied. Fixed on this branch (§5.2). |
| Cross-machine iOS from a cloud box | An agent on the VM ran `ade apple start/screenshot --machine <Mac>`: a simulator booted on the Mac and proof came back. Found and fixed: devices deleted by another project's cleanup, proof filed on the wrong machine (§7). |

## 4. Architecture

### 4.1 The ADE template on Agent37

ADE publishes its own workspace template, built by Agent37's cloud build
from a Dockerfile in this repo:

- ADE installed under `/opt` (the image); `ADE_HOME=/home/node/.ade` on the
  persistent disk.
- Entrypoint: a small loop that runs `ade --role cto serve` and restarts it
  with backoff. Being the entrypoint is what makes the brain survive sleep.
- `ADE_HOST_INSTANCE_ID="agent37:$(hostname)"` (Agent37's hostname is the
  instance id), so a copied home is detected (§5.2).
- Preinstalled: git, gawk, the Linux Desktop packages, Chromium.
- VM variant adds the Android SDK (platform-tools, emulator, an x86_64
  system image) and keeps Docker's data under `$HOME`.
- `/etc/machine-id` must stay absent or per-box: ADE's hardware anchor
  hashes it, and one value shared by every box from the template would make
  the account directory merge different boxes into one row.
- Versioned: ADE pins the template revision it creates from, and moves boxes
  forward with Agent37's `update` (keeps the disk).

### 4.2 Creating a machine with no second sign-in

1. The user's signed-in ADE asks the account service for a **one-time join
   token** (short TTL, single use, scoped to "publish one new machine").
2. ADE creates the box with the token in its environment.
3. On first boot the brain trades the token for its own device credentials
   and publishes itself. The token is dead after one use, so a fork or a
   snapshot cannot reuse it.

Never plant the durable `ade account token` on a box: anything on the box,
agents included, can read its environment.

### 4.3 Sleep and wake, owned by ADE

- Agent37 auto-sleep stays **off** (it would suspend a working brain).
- The brain knows when it is idle: no running turn, terminal, stream,
  recording, device, or wake-up due soon. After a short grace period
  (configurable per box), ADE calls `sleep`.
- ADE calls `start` (or any exec) when the user opens one of the box's
  lanes, the phone taps it, or a scheduled wake-up is near. Wake is ~2 s.
- After wake the brain must notice its relay connection died during the
  checkpoint and reconnect promptly (test item §9.2).
- A per-box spending cap stops runaway cost; the card shows time asleep
  and money saved.

### 4.4 Resize, move, fork

- **Resize** (same type): one Agent37 call. ADE checks nothing is running
  first or asks; the box restarts and the entrypoint brings the brain back.
- **Move box ↔ VM:** create the target, copy `$HOME` (repos, lanes,
  uncommitted work, ADE data), swap it in under the same lanes, delete the
  source. A real lane copies in about 33 s (§8).
- **Fork** (warm box per lane): Agent37 `fork` plus §5.2, so the fork
  starts as a new machine and joins with a join token.

### 4.5 Agent primitives

Every action is an `ade` CLI verb backed by a runtime action reachable
remotely (CLAUDE.md "Built for remote machines"): list, create (type,
size, region), resize, move, fork, sleep, wake, back up, restore, delete,
cost. Reads are free; anything that costs money, changes size, or deletes
is offered as an approval card (connect-cards lane). A skill tells agents
what each type can do, how to notice a box that is too small or idle, and
how to propose a change.

## 5. Done on this branch

### 5.1 Fixes found by running ADE on Agent37 (commits `e9c5d3e5f`, `b8996824c`)

- `install.sh` checksum lookup works with Debian 12's `mawk`.
- Without systemd, `brain start/stop/restart` use a detached supervisor
  (restarts on crash, role `cto`), and status says so.
- The CLI's automatic machine-brain spawn uses role `cto`.
- A brain with no project answers sealed account adoption.
- Adoption caps LAN/tailnet attempts at 3 s when a relay route exists.
- Sign-out removes the machine from the account directory (best effort).
- Key/account/subscription routes send the provider's bare model id.
- `chat read` shows a failed turn's error.
- A same-vendor one-off route shows the harness logo.
- Remote-work simulators: borrow a free user device; other projects'
  cleanup no longer deletes them; Apple proof sent with `--machine` is
  filed in the calling chat's drawer.

### 5.2 Copied-home guard

`apps/ade-cli/src/services/sync/hostInstanceGuard.ts`, called first in
`ade serve`. With `ADE_HOST_INSTANCE_ID` set, the brain records the id in
`$ADE_HOME/host-instance.json`; a later start with a different id moves the
whole `secrets/` folder to `copied-identities/<stamp>-from-<old id>/` and
retires each project's `.ade/secrets/sync-site-id`, so the box starts
signed out as a new machine with every file kept. Without the variable it
does nothing, so a renamed laptop is never mistaken for a copy.

## 6. Phases (after the connect-cards lane merges)

- **A1 — template + join token.** Template in the repo with CI build and
  publish; join token in the account service; "New Agent37 machine" from
  the picker; the Integrations card.
- **A2 — machine cards + lifecycle.** Cards, Sleep/Wake/Resize/Back up,
  Remove from ADE / Delete box, spending, Agent37 error states (box limit,
  empty wallet, suspended).
- **A3 — ADE-owned sleep.** Idle detection, wake on use, caps, savings.
- **A4 — fork and move.** Warm box per lane; box ↔ VM move.
- **A5 — agent primitives.** `ade` verbs, runtime actions, skill, approval
  cards for cost-changing actions.
- **A6 — Android on VM lanes** with the Android emulator lane.

## 7. Founder asks

1. An `agent37-ade` system template and an "ADE on Agent37" docs page, the
   way Cursor has one (we write both).
2. OAuth or scoped partner keys, so users do not paste a full workspace key.
3. Instance state webhooks (slept, woke, out of budget, suspended).
4. Type change in place, or fork into another type.
5. A shape above 4 vCPU, or a 4/16 priced for dev workloads.
6. Referral credit for users ADE sends.

## 8. Verified on this branch's build (Agent37, 2026-11-03)

- Fork of a SIGNED-IN box: the copy came up signed out with a new device id
  and moved the old identity aside; it made no relay claim or publish, and
  the account row stayed with the original for the whole observation.
- Sign-out removed the box's row from the account directory.
- A fresh box with no project now answers sealed adoption: the Mac's error
  changed from "could not verify the account" to "could not connect in
  time" (the Mac still runs the released build, without the 3 s LAN cap).
- Box → VM copy of a 730 MB / 23,307-file lane: 33 s (25 s gzipped).
- 2026-11-04, this branch's desktop (`npm run dev:desktop`, beside the
  installed ADE): a fresh relay-only box appeared under Ready to connect only
  after a fix (a saved relay target's hostname is the shared relay host, which
  hid every relay-only account machine), then Connect reached it over the
  relay in seconds (211 ms). The box's sign-in was approved from ADE's
  browser, with no step for the owner.

## 9. Still to test

1. Live simulator video from a cloud chat. The desktop side runs from the
   lane with `npm run dev:desktop`; the simulator's host must be a brain
   running this branch that other machines can reach. A dev brain runs
   `--no-sync`, so this needs a branch brain on another machine.
2. Relay reconnect after a long sleep (minutes to hours).
3. Wallet empty / suspended behaviour.
4. EU and India regions over the relay.
5. Android end to end on a VM lane.
