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
(agent37.com/pricing): $0.80 per vCPU, $0.70 per GB of memory and $0.09 per GB
of disk, per 730-hour month, metered by the minute; a VM's compute is 2.5x.
Running, that is about 0.8¢ / 1.5¢ / 2.5¢ / 4.5¢ an hour for a box (12 GB
disk). Asleep or stopped, only disk bills (~9¢ per GB-month). Workspace tiers cap
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

**What A1 built instead (2026-11-04), and the join-token recommendation.**
A1 uses the device sign-in that already exists, approved by the creating
ADE, with nothing planted on the box:

1. ADE runs `ade login --headless` on the new box through Agent37 exec and
   reads the code it prints.
2. ADE calls `POST /device/approve` with its own account bearer and gets a
   one-time Clerk sign-in ticket that continues to that code's authorize URL.
3. ADE opens the ticket in a private, hidden window and waits for
   `/device/callback`. If the page stops (a consent click), the window is
   shown, titled "Sign in <box name>", as the one confirmation. ADE never
   clicks it.
4. ADE also watches the box itself, so an approval from anywhere ends the
   wait.

Measured on 2026-11-04:

- Production `POST /device/approve` answers **503 `unavailable`**:
  `CLERK_SECRET_KEY` is not set on `ade-account-directory-production`
  (`wrangler secret list --env production` shows no such secret). A1 falls
  back to the code's own `/device` page in a window that uses ADE's browser
  session: Continue, then Clerk's consent page, then Allow.
- Clerk's consent page ("ADE CLI wants to access ADE on behalf of …",
  Allow / Deny, with a "make sure you trust ADE CLI (arulsharma1028.workers.dev)"
  warning) appears on **every** device sign-in. It is not remembered.

Recommendation: **no separate join token yet.** The device flow already gives
the box its own session, is single use, expires in 10 minutes, and a fork
cannot reuse it. A join token would still have to end in Clerk OAuth tokens
for the box, and Clerk only issues those through a browser authorize, so it
would rebuild this same chain inside the Worker. Two settings make the
current chain zero-touch: set `CLERK_SECRET_KEY` on the production account
directory, and turn off the consent screen for ADE's own OAuth application
(`Az7TbviBocyXjZk1`, "ADE CLI") in Clerk. Revisit a join token only if ADE
starts issuing its own machine credentials instead of Clerk sessions.

**Template distribution.** Agent37 templates are per workspace, so each
user's workspace needs ADE's template. Today only
`infra/agent37/build-template.sh` puts it there, and ADE says so plainly
when it is missing. Options: (a) Agent37 publishes `agent37-ade` as a system
template (founder ask 1); (b) CI publishes a public GHCR image per release
and ADE registers it in the user's workspace on first use (one
`POST /v1/templates {name, image_ref}`); (c) ADE runs the cloud build in the
user's workspace on first use (about five minutes, free). (a) is best; (b) is
the fallback.

**Built: (c), on connect (2026-11-04, `ade/agent37-template-on-connect`).**
Saving the key, and every app start with a key saved (20 s after boot), runs
`agent37TemplateBuilder.ts`: it asks Agent37 for the template and, when it is
missing or older than the running release, runs the cloud build over the REST
API (`POST /v1/template-builds`, PUT the gzipped context, `start`, poll). No
CLI, no Node, no Docker: the context is `infra/agent37/template`, shipped as
the `agent37-template` app resource and packed in the main process.

- What a template installs is in its Agent37 description:
  `ADE <version> · template <hash of the two files>`. A release build replaces
  a template that has no marker, other files, or an older ADE; a newer one
  (built by a newer ADE elsewhere) stays. A development or alpha build bakes
  the newest release and only creates a missing template, never replaces one.
- A build in flight is recorded (build id, start time, version, hash) in the
  account vault (`integration` / `agent37-template-build`), falling back to
  this computer's credential file. Another computer that sees a fresh record
  polls that build instead of starting one; an app restart resumes polling it.
  Agent37 has no "list builds" endpoint, so this record is the only guard.
- Failures retry after 1, 5 and 15 minutes, then wait for Retry. A refused key
  or an unfunded workspace does not retry.
- The Agent37 page shows the template (setting up, about N min left / ready /
  failed with the reason and Retry). New Agent37 machine says so and keeps
  Make box off while there is no usable template; while an older template is
  being updated, boxes come from the older one.

Measured 2026-11-04 with a test name (`ade-t2-test`): connect to ready in about
3.5 minutes, revision 1, description marker set by the build.

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
whole `secrets/` folder to `copied-identities/<stamp>-from-<old id>-to-<new id>/` and
retires each project's `.ade/secrets/sync-site-id`, so the box starts
signed out as a new machine with every file kept. Without the variable it
does nothing, so a renamed laptop is never mistaken for a copy.

## 6. Phases (after the connect-cards lane merges)

- **A1 — template + sign-in + picker + card.** Built on `ade/agent37-a1`:
  `infra/agent37` (template and build script, no CI yet), the Agent37 client
  and account-vault key (`apps/desktop/src/main/services/agent37`), the
  Agent37 connection page and connect card, and "New Agent37 machine" in
  Add a computer. The join token was replaced by the approved device
  sign-in (§4.2).
- **A2 — machine cards + lifecycle.** Cards, Sleep/Wake/Resize/Back up,
  Remove from ADE / Delete box, spending, Agent37 error states (box limit,
  empty wallet, suspended). Built on `ade/agent37-a2-machine-cards`: see
  "The machine cards" in
  [docs/features/remote-runtime/agent37.md](../features/remote-runtime/agent37.md).
  A box finds its account row by the `ade_machine_key` metadata the creator
  writes at join, else by hostname (= instance id).
- **A3 — ADE-owned sleep.** Idle detection, wake on use, caps, savings.
- **A4 — fork and move.** Warm box per lane; box ↔ VM move.
- **A5 — agent primitives.** `ade` verbs, runtime actions, skill, approval
  cards for cost-changing actions.
- **A6 — Android on VM lanes** with the Android emulator lane (PR #2045). Its
  needs from a VM, as that lane stated them (2026-11-04):
  1. `/dev/kvm` usable by the brain's user (group `kvm`); without it ADE
     refuses the start with `ANDROID_NO_ACCELERATION`. A default box cannot
     run Android.
  2. An Android SDK with platform-tools, emulator, cmdline-tools (ADE reads
     the hardware profiles from its `sdklib` jar; without it nothing can be
     made) and one x86_64 system image (google_apis or default, API 34–36).
     None of them needs a JDK at runtime. ADE looks in `$ANDROID_HOME`,
     `$ANDROID_SDK_ROOT`, `~/Android/Sdk`, and (from #2045) `/opt/android-sdk`
     and `/usr/lib/android-sdk`. Elsewhere: set `ANDROID_HOME` in
     `ade-entrypoint.sh` (the brain's own env), not only `.bashrc`.
  3. No display: ADE starts the emulator `-no-window -no-audio -gpu auto`.
  4. Live view needs the scrcpy server jar, which #2045 adds to the standalone
     brain archive. Until that release ships, a VM brain can create, start,
     screenshot and tap but not stream.
  5. 4 vCPU / 8 GB runs one emulator; 4/16 if Gradle builds run there too.
  When this lane merges, that lane tests `ade android … --machine <vm>` end to
  end on one Agent37 VM and deletes the VM afterwards.

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
- 2026-11-04, A1 (`ade/agent37-a1`), template `ade-a1-test` with released
  ADE 1.2.128: "New Agent37 machine" made a 2/4 box; Agent37 answered in
  about 10 s with the brain already up; the box's device sign-in was
  approved (Continue, Clerk consent, Allow, see §4.2); it joined the account
  under the chosen name with a relay route. The first automatic Connect
  failed with "could not verify the account": **released 1.2.128 needs a
  registered project before it answers account verification** (fixed on
  this branch, §5.1). After `ade init` on the box and a brain restart,
  Connect reached it over the relay (151 ms). Boxes `s321i7brh3`,
  `0terhcg4bw`, `mxf022t45j`, `0mqkjuhzqp`, all deleted.
- 2026-11-04, `ade/agent37-template-on-connect`, after Clerk's consent screen
  was turned off and `CLERK_SECRET_KEY` set on the production account
  directory: connecting the key built `ade-t2-test` in about 3.5 minutes; a
  2/4 box made from it signed in with **no window and no click**
  (`/device/approve` answered with a ticket; the hidden window reached
  `/device/callback` without being shown) and was Online in the account about
  35 s after Make box. Closing the dialog while a second box was starting
  cancelled the create and deleted the box within 2 s. Boxes `1g90zd1vub`,
  `k5dwsniok0`, `vjjw6svmrg`, all deleted. Released 1.2.128's `ade logout`
  does not remove the account row (the fix is on this branch only), so the
  rows were removed from ADE by hand.

## 9. Still to test

1. Live simulator video in a desktop pane from a remote chat. Testable now
   without a merge: `npm run dev:machine` runs this branch's brain as its own
   machine on the Mac (verified 2026-11-04: `ade apple start/screenshot
   --machine "<Mac> (dev)"` booted a simulator through it and filed the proof
   in the calling chat), and a dev desktop connects to it.
2. Relay reconnect after a long sleep (minutes to hours).
3. Wallet empty / suspended behaviour.
4. EU and India regions over the relay.
5. Android end to end on a VM lane.

## 10. Final live run (2026-11-04, this branch's desktop)

From the picker with the branch template `ade-brain-dev`: Make box → the box
was signed in with no window or click, renamed, and auto-connected over the
relay (178 ms) about 15 s later. The released-ADE "no project" gap does not
apply to a box running this branch, so auto-connect is confirmed. Signing the
box out removed its row; the box was deleted.

