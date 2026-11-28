# DAEX triage playbook

You are fixing a broken DAEX install on someone's own machine. `daex triage` handed you a
redacted `context.md` and this file. Read both before you run anything. Commands below use
`daex`; the old `ade` command still works as an alias.

DAEX is a local-first dev environment. The parts that break are: the **brain** (a background
process holding the local RPC endpoint, the project catalog, and sync), the **login service**
that keeps the brain running (launchd / systemd / a Windows per-user Run entry), the **credential
store**, the **project database** under `<project>/.ade/`, and the **pinned agent CLIs** under
the machine tools cache.

---

## 1. Safety rules — these bind you

1. **Diagnose read-only first.** Every command in section 3 marked *(read-only)* is safe. Run
   those, form a diagnosis, and state it before you change anything.
2. **Propose before you mutate.** Say what you are about to run, what it changes, and how to
   undo it. Wait for the user to agree. Restarting the brain interrupts whatever agent sessions
   are running on this machine — including, possibly, the one you are talking through.
3. **Never delete user data.** `~/.ade/` (or `$ADE_HOME`) and every `<project>/.ade/` directory
   hold the user's databases, secrets, artifacts, and transcripts. Do not `rm -rf` them, do not
   "clean them up", do not delete `ade.db`, `credentials.json.enc`, `artifacts/`, or
   `transcripts/`. Moving a file aside with a dated suffix, after the user agrees, is the most
   destructive thing you may propose.
4. **Never kill by name or pattern.** No `pkill -f ade`, no `pgrep … | xargs kill`, no
   `Stop-Process -Name`. Those patterns match this agent's own process, other DAEX channels
   (stable and alpha each run their own brain), and unrelated dev runtimes. If a process
   truly must stop, get its exact PID from `daex brain status --text` or `daex runtime
   service-status --text`, verify the PID's own command line and working directory, then stop
   that one PID — or better, use `daex brain stop`, which stops the right thing by construction.
5. **Prefer the DAEX command over the OS command.** `daex brain restart` over `launchctl`,
   `daex runtime install-service` over hand-editing a plist, `daex brain repair-credentials` over
   touching the keychain. The DAEX commands know about channels, roles, and the handover
   protocol; the raw ones do not.
6. **Do not reinstall as a first move.** Reinstalling loses the evidence and usually not the
   bug. Find the failing row first.
7. **Never print or copy secrets.** `~/.ade/secrets/` is off limits as content: report whether
   a file exists and whether it can be read, never what is in it. The context file you were
   given is redacted; keep anything you add to it redacted too.
8. **Do not touch the user's git work.** Lanes are real git worktrees with real uncommitted
   changes. Triage never runs `git checkout`, `git reset`, `git clean`, or worktree removal.
9. **One change at a time**, then re-run `daex doctor --text` and report the row that moved.

---

## 2. Start here

```bash
daex doctor --text          # (read-only) one ok/warn/fail row per check; exits non-zero on any fail
```

`daex doctor` is the map. Work the failing rows, top to bottom, and stop when they are green.
Row → section:

| Doctor row | Section |
| --- | --- |
| Brain (`fail`) | 3.1 brain not answering |
| Brain (`warn`, `starting`) | 3.2 brain still coming up |
| Wedge history | 3.3 wedged brain |
| Sync port | 3.4 port conflicts |
| Publish health / Relay / Account | 3.5 sync, pairing, and account |
| Credentials | 3.6 credential store lockout |
| Storage | 3.7 disk full and dataless files |
| App | 3.8 version drift and updates |

Not in a doctor row, but common: 3.9 database locked or corrupt, 3.10 agent CLI binary missing,
3.11 the CLI itself is not on PATH.

If `daex doctor` itself will not run, go to 3.11.

---

## 3. Failure classes

### 3.1 Brain not answering (socket unbound or stale)

The brain listens on a per-channel endpoint: `~/.ade/sock/ade.sock` on macOS and Linux
(`$ADE_HOME/sock/ade.sock` when `ADE_HOME` is set), and a named pipe
`\\.\pipe\ade-runtime-<channel>-<hash>` on Windows. Clients that cannot reach it report
"couldn't open project" or "DAEX couldn't be set up" (older versions: "ADE couldn't be set up").

Read-only:

```bash
daex brain status --text            # endpoint state, service state, sync state, last failure
daex runtime status --text          # the endpoint alone (also reports `starting`)
daex runtime service-status --text  # is the login service registered and loaded?
daex doctor --text
```

Then read the brain's own log tail — `daex report-issue --text` already contains it, and so does
the context file you were given (look for `Brain` and `Background service`). The files, if you
want them directly, are under `$ADE_HOME/runtime/`: `brain.jsonl`, and `launchd.err.log` /
`launchd.out.log` on macOS, the supervisor log on Windows, `systemd.err.log` /
`systemd.out.log` on Linux (`journalctl --user -u <unit>` for a unit installed before those files).

Diagnosis:

- Service not registered → 3.12.
- Service registered, socket unbound, brain young → 3.2, wait.
- Service registered, brain alive, socket unbound for minutes, heartbeat stale → 3.3.
- Endpoint answers but reports a build-hash mismatch → the CLI and the running brain are
  different builds. Propose `daex brain restart` (or `daex brain update --text` if the desktop app
  was updated underneath it).

Mutating, in escalation order — propose each one first:

```bash
daex brain restart          # re-exec the service (interrupts running sessions)
daex brain stop             # unload the login service
daex brain start            # register + load it again, pinned to the cto role
```

Do not delete the socket file to "unstick" it. A stale socket with no owner is cleaned up by the
brain's own startup path; deleting one that *is* owned makes every running client unreachable
with no way back except a restart.

### 3.2 Brain still coming up

`starting: true` in `daex brain status` / `daex runtime status`, or a `warn` Brain row that says
starting, means the service is registered and the brain process is alive and younger than the
young-brain window (about 2 minutes). First launch, a cold disk, or a large project database all
land here.

This is "wait", not "repair". Restarting only resets its clock. Re-run `daex brain status --text`
after a minute. Escalate to 3.1 only if it is still starting well past the window.

### 3.3 Wedged brain (event loop blocked / stale heartbeat)

The Wedge history row reports the last recovered wedge. Two things write it: the in-process loop
watchdog (names the blocking command and how long it blocked) and the external watchdog.

Read-only:

```bash
daex runtime watchdog-check --text   # reads the heartbeat; stops a brain that has stopped beating
```

That command is the sanctioned way to deal with a wedged brain: it never opens the runtime
socket and never starts anything, and the service supervisor restarts what it stops. Use it
instead of finding a PID and killing it. A wedge inside the last 24h with a healthy brain now is
history, not a live failure — report it and move on.

### 3.4 Port conflicts (sync host bound off its default port)

The Sync port row is `warn` when the brain bound something other than the default sync port, and
names what it found holding the base port. Usually it is a second DAEX channel (stable and alpha
both running), a leftover brain, or an unrelated dev server.

Read-only:

```bash
daex sync status --text              # listener port, relay state, publish state
daex brain status --text             # port + connectedPeers + project host
daex brain status --scan-listeners --text   # same, but also scans the port's listener
```

`daex brain status` reports a **project host** row (`ready` / `starting` / `conflict` /
`unavailable` plus the same headline a phone would see) and, on a conflict, a **blocking
runtime** row naming the owner and its project. That is the same snapshot the phone's
**Fix connection** card reads, so the terminal and the phone name the same process in the same
words. The listener scan is opt-in because it shells out to `lsof` or a full-machine PowerShell
query; without `--scan-listeners` the answer comes from the machine-wide lock alone, which covers
the common "the host has not taken its lease yet" case. The running brain's own pid is excluded
before any conflict is reported, so a healthy machine never accuses the brain that is serving it.

When DAEX cannot name the owner, use the OS tool in read-only form — `lsof -nP -iTCP:<port>
-sTCP:LISTEN` on macOS/Linux, `netstat -ano | findstr :<port>` on Windows — and report the owner.
Do not kill it. If it is another DAEX channel, that is expected and the warn is cosmetic; if it is a stray
process the user recognises, let them stop it themselves.

### 3.5 Sync, pairing, relay, and account

Read-only:

```bash
daex auth status --text      # account identity + credential source
daex sync status --text      # listener, relay, publish health, failing-since
daex machines list --text    # what the account directory believes about this machine
daex sync devices            # paired devices
```

Common shapes:

- **Signed out** → `daex login` (browser loopback), or `daex login --headless` over SSH / on a
  display-less host. Ask first: sign-in is the user's action, not yours.
- **Relay slot claimed by another DAEX process on this machine** → the row names it. The fix is
  to quit the rival DAEX process; propose it, do not kill it.
- **Publish failing** → the brain must stay running to publish. Confirm 3.1 is green first, then
  `daex sync refresh`.
- **Phone will not pair** → `daex brain pin generate` (or `daex brain pin set 123456`), and
  `daex sync web --open` for the web client link. A PIN that reads as correct but is refused is
  usually a machine that is not published: check `daex machines list --text`.
- **This machine was removed from the account** → `daex machines reconnect`. It can open a browser
  step ("Confirm it's you") that the user must complete, so ask first.

### 3.6 Credential store lockout

The shared store is `$ADE_HOME/secrets/credentials.json.enc`. The Credentials row is read
straight off disk — it works on a machine where the brain will not start, which is the whole
point of it.

- **Sealed with a key this process cannot obtain** (a GUI-written, OS-bound store that the
  background brain cannot open): the remedy is to open the DAEX desktop app on this computer
  once. Say that; do not go digging in the keychain.
- **Anything else unreadable**: a fresh sign-in.
- **A quarantined store waiting to be restored** (`warn`): that is what
  `daex brain repair-credentials` is for.

```bash
daex brain repair-credentials   # local only; never contacts the network
```

Never delete `credentials.json.enc`. Never read its contents. Never re-run a "repair" in a loop.

### 3.7 Disk full, and files that are not on the disk

The Storage row covers two different failures:

- **No room left.** The full report (`daex report-issue --text`, and the context file) prints free
  space for the DAEX home and the project volume. Under a few GB, everything downstream —
  database writes, tool fetches, brain updates — fails in confusing ways. Report the number and
  let the user free space. Do not delete anything to make room; DAEX caches under `~/.ade/tools`
  belong to the user, and `daex tools gc --dry-run --text` is the only sanctioned way to look at
  reclaiming them (`--dry-run` first, always).
- **Bytes not present.** A project on iCloud Drive / OneDrive whose files have been evicted, read
  by a background service that is not allowed to hydrate them, fails with `EDEADLK` /
  "Unknown system error -11" while every other row stays green. The remedy the row names is
  `daex runtime install-service`, which rewrites the launch agent with the permission to
  materialize dataless files. Propose it — it re-registers the login service.

### 3.8 Version drift and updates

The App row compares the installed desktop version against the latest known. `daex doctor
--online --text` also checks the network (best effort, short timeout).

```bash
daex brain update --text          # stage + apply the latest standalone brain, then restart
daex brain update status --text   # (read-only) what the last headless update did
```

An update is a mutation and a restart: propose it, and never run it while the user has work in
flight.

### 3.9 Database locked or corrupt

Each project keeps its state in `<project>/.ade/ade.db`, with `ade.db-wal` and `ade.db-shm`
siblings while it is open. Symptoms: "database is locked", "database disk image is malformed",
or a project that will not open while the rest of DAEX is healthy.

Read-only:

```bash
daex projects list --text                 # what this machine has registered
daex status --text --project-root <path>  # can this specific project be reached?
```

Rules for this one, because it is the easiest place to destroy someone's work:

- **The WAL and SHM files are part of the database.** Deleting `ade.db-wal` discards committed
  transactions that have not been checkpointed. Never delete a sibling without the `.db`, never
  delete any of them without the user's explicit agreement, and never while a brain is running.
- "Locked" almost always means *another live process holds it* — a second brain, a desktop app,
  a stray `daex serve`. Resolve that (3.1), do not break the lock.
- Genuine corruption: propose a copy-aside (`ade.db` → `ade.db.broken-<date>`, all three files
  together, with the brain stopped) and let the user decide. Say plainly what is lost.

### 3.10 Agent CLI binary missing

DAEX runs only its own pinned copies of the agent CLIs, from a machine-level cache
(`ADE_TOOLS_ROOT`, else `%LOCALAPPDATA%\ADE\tools` on Windows, else `~/.ade/tools`). It never
runs a CLI from the PATH, so a `claude` or `codex` the user installed does not fix a missing
pin; do not tell the user to install one. Logins are shared: DAEX's copy reads the user's
`~/.claude`, `~/.codex`, … sign-in.

```bash
daex tools status --text       # (read-only) installed version + entry path per pinned tool
daex tools ensure --text       # fetch the pinned tools this machine uses (network)
daex tools ensure codex --text # just one
daex tools ensure --all --text # every pinned tool (well over 1 GB)
```

A provider with no build for this machine (`unsupported-target`, e.g. Windows on Arm) reads
"not available on this machine"; there is nothing to fetch.

Failures come back with a typed `errorKind` — `network`, `integrity`, `disk-space`,
`lock-timeout` — read it rather than the message. `disk-space` sends you to 3.7; `lock-timeout`
usually means a background fetch is already running, so wait and re-run. If the environment sets
`ADE_DISABLE_TOOLS_FETCH=1`, background fetching is off on purpose; say so instead of unsetting
it behind the user's back.

### 3.11 `daex` itself will not run

If `daex doctor` cannot even start:

```bash
daex --version                 # is the CLI on PATH at all?
```

- **Command not found**: the release install puts the binary at `$ADE_HOME/bin/ade`
  (`ade.exe` on Windows). On POSIX the installer writes `$ADE_HOME/env`, which is safe to source
  repeatedly: `. "$HOME/.ade/env"`. On Windows the installer adds the install directory to the
  user's PATH — a new terminal is required. Check whether the binary exists before concluding
  anything about the install.
- **Runs but crashes immediately**: native dependencies live under
  `$ADE_HOME/runtime/<platform>-<arch>/`. A CLI that starts and then dies on a missing native
  module usually means a half-finished update; `daex brain update --text` re-stages it. Capture
  the exact error first.
- **Wrong DAEX**: `ADE_HOME` and `ADE_PACKAGE_CHANNEL` select a channel. If the user has stable
  and alpha installed, confirm which one you are talking to before diagnosing anything.

### 3.12 Login service not registered or not loaded

```bash
daex runtime service-status --text   # (read-only) registration + load state
daex brain status --text             # includes the same service block
```

The service is a launchd LaunchAgent (`com.ade.runtime`, plus `.alpha`) on macOS, a
user systemd unit on Linux, and on Windows a per-user, per-channel entry under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` that starts a PowerShell supervisor. Read
`daex runtime service-status --text` instead of guessing the entry name.

Register with `daex brain start`. Use that, not `daex serve --install-service`: only
`daex brain start` pins the runtime's default role to `cto`, which is what `daex connect` and the
desktop app require. A service registered the other way lands on the `agent` role and makes
sign-in fail on every clean install.

`daex connect` runs the whole account + service + machine-publish sequence idempotently, and
`daex connect --status --text` reports all three without changing anything.

---

## 4. Finishing

1. Re-run `daex doctor --text` and quote the rows that changed.
2. Tell the user, in plain words: what was broken, what you changed, and what you deliberately
   did not touch.
3. If a row still fails and nothing here explains it, that is a bug worth filing:
   `daex report-issue --open` copies a redacted report and opens a prefilled GitHub issue.
   `daex report-issue --send` hands the same redacted report to DAEX and prints a reference id.
   Both read local files only, so they work on a machine where the brain will not come up.
4. Delete nothing on your way out. The triage directory (`context.md` and this playbook) is in a
   temp dir; leave it for the user.
