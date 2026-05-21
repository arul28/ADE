# Goal: Cross-process ownership for ADE sessions

You are picking this up mid-investigation. The previous agent traced two related bugs to a single root cause and started landing the fix. This document is the complete plan — finish it end-to-end. Worktree is `/Users/admin/Projects/ADE/.ade/worktrees/deeplinks-d52aa89e/`. Do not switch repos or lanes.

---

## 1. The bugs the user is hitting

Two user-visible symptoms, same underlying cause:

### Symptom A — "frozen snapshot after PTY resume"

User opens the Work tab on a CLI session whose status is `stopped`/`ended`, types a message, hits send. The PTY actually resumes in the main process (visible in the TUI, and the OS-level `claude --session-id ...` process is alive in `ps aux`), but the desktop renderer stays on `ClosedCliSessionSurface` showing a frozen pre-resume snapshot. The composer placeholder reads "Type to continue this Claude Code session..." and never flips to a live `TerminalView`.

### Symptom B — "session randomly appears as Stopped while it's still running"

User has the ADE desktop app and `ade code` (TUI) both open on the same lane. A Claude Code session is running fine. Without any user action, the desktop view randomly switches to `ClosedCliSessionSurface` ("Stopped", "Ended <timestamp>", "Type to continue this Claude Code session…"). The TUI still shows the session alive and producing output. The OS-level `claude --session-id <id>` process is still alive. Only the desktop's DB row says the session ended.

The user has also seen this hit Codex CLI sessions and Cursor CLI sessions, not just Claude Code.

---

## 2. Root cause — single-owner assumption in a multi-process world

ADE runs the same project across **multiple OS processes simultaneously**, all opening the same `.ade/ade.db` SQLite file:

- The desktop app (electron) — executes `cli.cjs serve --socket ~/.ade-beta/sock/ade.sock` as its main; it IS both the GUI and an `ade serve` daemon.
- A separate per-lane `ade serve` daemon (e.g. `/tmp/ade-runtime-lane-<lane>.sock`).
- The TUI's embedded runtime when `ade code` is invoked — `apps/ade-cli/src/bootstrap.ts` calls `createPtyService` (imported from `apps/desktop/src/main/services/pty/ptyService.ts`) inside the TUI's own process.
- Mobile is a remote client of one of the above.

I verified live with `ps aux`, `lsof`, and `sqlite3` queries (see §10 for the exact commands you can re-run). The DB has rows for `claude` CLI sessions marked `status='disposed'` while the corresponding `claude --session-id <id>` OS process is still in the process table. Different process, different ptyService map, different opinion about who's alive.

The DB schema has **no concept of which OS process owns which row**. Every process treats `terminal_sessions` as if it were the sole owner:

1. **`sessionService.reconcileStaleRunningSessions`** (`apps/desktop/src/main/services/sessions/sessionService.ts:483`) blindly disposes every `status='running'` row at process startup. Desktop main calls it at `apps/desktop/src/main/main.ts:1939`. TUI bootstrap calls it at `apps/ade-cli/src/bootstrap.ts:450`. When `ade code` starts while the desktop has a live PTY, the TUI's reconcile silently marks the desktop's session disposed.

2. **`ptyService.dispose({ptyId, sessionId})`** (`apps/desktop/src/main/services/pty/ptyService.ts:3497`) has an "orphan" branch: if `ptyId` doesn't match any entry in the calling process's PTY map but `sessionId` does match a DB row, it calls `sessionService.end(..., status='disposed')` to "clean up." Callers from the renderer (`ChatTerminalDrawer.tsx:387-392`, `useWorkSessions.ts:1221`) trigger this on tab unmount / drawer teardown / stop button. If the PTY lives in another process, the "orphan dispose" fires against a perfectly live session.

3. **`closeEntry`** (`apps/desktop/src/main/services/pty/ptyService.ts:2080`) is fine — it only runs when the calling process's own `pty.onExit` fires. It is in-process by definition. Don't touch it for ownership reasons.

I tried two stopgap fixes earlier in this lane:

1. `sessionService.reopen`/`reattach` now emit `emitChanged({reason: "meta-updated"})` so the renderer learns about resume immediately (was silent — sessions/sessionService.ts:725, 745).
2. `reconcileStaleRunningSessions` got an `activityThresholdMs` (default 5 min) so rows whose `last_output_at` is recent are skipped (sessions/sessionService.ts:483).
3. `TerminalsPage.handleContinueCliSession` optimistically upserts the new session snapshot returned by `pty.sendToSession` (terminals/TerminalsPage.tsx:371).
4. `useWorkSessions` exposes `upsertSessionSnapshot` (terminals/useWorkSessions.ts:790).

These help but are heuristics. They do not fix Symptom B in general — `last_output_at` is session-level activity and is flaky for idle sessions. The dispose path still fires across processes with no guard. Replace the `activityThresholdMs` guard with a proper ownership check (see §3, §5). Keep the optimistic upsert and the `emitChanged` additions — they're good independent of the ownership work.

---

## 3. Architecture finding that surprised me — agent chats already do this right

While investigating, I expected to find that the TUI and desktop each ran their own `agentChatService` and never converged. They don't. The user proved it: started a `claude-chat` in the TUI, watched it appear live and in-sync in the desktop in the same lane. The mechanism:

- `ade serve` is a JSON-RPC daemon (`apps/ade-cli/src/adeRpcServer.ts`). It hosts the runtime services (agentChatService, sessionService, etc.).
- The desktop app embeds and connects to it through `localRuntimeConnectionPool` (`apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts`) and `runtimeRpcClient`.
- The TUI client (`apps/ade-cli/src/tuiClient/connection.ts:335 spawnDaemon`, `:356 connectAttachedSocket`) auto-connects to an existing daemon or spawns one detached (`spawn(... detached: true, stdio: "ignore")`), then makes RPC calls.
- The daemon owns the SDK agent-chat session. It pushes events out via `runtimeEvents.subscribe` (`apps/ade-cli/src/adeRpcServer.ts:7254` and surrounding) to every connected client. Desktop and TUI both subscribe and render the same event stream.
- The renderer preload (`apps/desktop/src/preload/preload.ts`) has a helper `callProjectRuntimeActionIfBound("chat", "sendMessage", ...)` that tries the daemon first and falls back to local IPC if no daemon is bound. This is why chats sync.

**This is exactly the "stage 2" architecture you want for CLI PTYs.** It already exists for chats. It does not exist for raw PTYs — each process still spawns and owns its own PTYs locally. That's the asymmetry that makes Symptom B uniquely a CLI/PTY problem.

So the work splits cleanly into:

- **Tier 1** — add process-level ownership tracking and gate dispose/reconcile on it. Stops the immediate bleeding for *every* row type (CLI and chat).
- **Tier 2** — move PTY ownership into the daemon, the same way agent chats already work. Makes CLI sessions truly cross-surface live.

The user wants both. Do both.

---

## 4. What I already changed in this worktree

Don't redo these — finish on top of them. All in `/Users/admin/Projects/ADE/.ade/worktrees/deeplinks-d52aa89e/`. Verify with `git diff` before continuing.

Schema:
- `apps/desktop/src/main/services/state/kvDb.ts` — added `owner_pid INTEGER` column on `terminal_sessions`, added `runtime_processes` table, indexes. (See the diff for exact migration ALTERs.)

New service (skeleton, **not wired anywhere yet**):
- `apps/desktop/src/main/services/runtime/processRegistryService.ts` — `createProcessRegistryService({db, logger, pid?, role, projectRoot?, heartbeatIntervalMs?, livenessWindowMs?})` with `start/heartbeat/stop/listLivePids/isPidLive/listAllProcesses/pruneStale`. Heartbeats default 5s; liveness window default 15s. **This file already exists. Read it before extending.**

Earlier-lane fixes that should stay:
- `sessionService.reopen/reattach` now emit `emitChanged({reason: "meta-updated"})` — `apps/desktop/src/main/services/sessions/sessionService.ts:725-742, 745-765`.
- `sessionService.reconcileStaleRunningSessions` got `activityThresholdMs` heuristic (`apps/desktop/src/main/services/sessions/sessionService.ts:483`). **Tier 1 replaces this heuristic with proper ownership — see §5.4.**
- `TerminalsPage.handleContinueCliSession` does optimistic `work.upsertSessionSnapshot(result.session)` (`apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx:371`).
- `useWorkSessions` exposes `upsertSessionSnapshot` (`apps/desktop/src/renderer/components/terminals/useWorkSessions.ts:790`).
- Two new sessionService tests for the activity-threshold guard. **Update them when you replace the heuristic with ownership.**

---

## 5. Tier 1 — ownership + heartbeat + gated mutations

### 5.1 Schema (DONE in §4)

`terminal_sessions.owner_pid INTEGER NULL` + `runtime_processes(pid PRIMARY KEY, role TEXT, project_root TEXT, started_at TEXT, last_seen TEXT)` + the two indexes. Migrations are idempotent ALTER/CREATE-IF-NOT-EXISTS — safe to re-run on existing DBs. Verify the columns exist with:

```
sqlite3 /path/to/.ade/ade.db "pragma table_info(terminal_sessions);"
sqlite3 /path/to/.ade/ade.db "pragma table_info(runtime_processes);"
```

### 5.2 ProcessRegistry service (DONE skeleton, needs wiring)

File: `apps/desktop/src/main/services/runtime/processRegistryService.ts`. API is fixed — extend tests around it, don't reshape unless you find a bug.

**Roles:** `"desktop-main" | "ade-serve-daemon" | "tui-runtime"`.

**Wiring (NOT YET DONE — do this):**

1. **Desktop main** — instantiate in `apps/desktop/src/main/main.ts`, in the project context init (near where `sessionService` is created, around line 1935 today). Role `"desktop-main"`. Project root = the current project root. Call `start()` immediately. Tear it down on context close. **Critical:** the desktop's main process and the `ade serve --socket /Users/admin/.ade-beta/sock/ade.sock` it runs are *the same OS process* (PID 53089 in my investigation — see §10). One heartbeat row, not two.

2. **TUI runtime bootstrap** — `apps/ade-cli/src/bootstrap.ts` around line 446 where `sessionService` is created. Role `"tui-runtime"`. `start()` before the reconcile call.

3. **`ade serve` daemon** — if `cli.cjs serve` is launched as a standalone daemon (the lane runtime daemon, e.g. PID 88995 in my investigation), it goes through the same `bootstrap.ts` path, so the wiring above covers it. But verify: trace `apps/ade-cli/src/cli.ts` line 10201 (`Promise.all([import("./bootstrap"), import("./adeRpcServer")])`) and confirm `createAdeRuntime` is what `serve` ends up calling. If yes, single wiring suffices. If not, wire `serve` separately.

4. **Stop on exit** — wire `processRegistry.stop()` to `process.on('beforeExit', ...)` and to the desktop's `before-quit` electron event. Best-effort; if the process crashes the row will simply go stale and reconcile cleans it up. Don't block exit on this.

### 5.3 `sessionService` — accept and read `owner_pid`

File: `apps/desktop/src/main/services/sessions/sessionService.ts`.

- `create({...})` (line 657 today) — add `ownerPid?: number | null` to the args type. Persist into the new column. Default `null` if not provided (legacy callers).
- `mapRow` and `SESSION_COLUMNS` — add `owner_pid as ownerPid`. Surface `ownerPid` on `TerminalSessionSummary` and `TerminalSessionDetail` (types live in `apps/desktop/src/shared/types/sessions.ts`).
- `reattach(args)` (line 745) — add optional `ownerPid` arg. When provided, set `owner_pid = ?` in the UPDATE. Reattach is the resume path; the new owner is whoever called `ptyService.create` (see §5.5).
- `clearOwnerPid(sessionId)` — new method, sets `owner_pid = null`. Used by tier 2 when the daemon takes over a previously-local session.
- `setOwnerPid(sessionId, pid)` — new method. Used by tests and migration helpers.

### 5.4 `sessionService.reconcileStaleRunningSessions` — gate on ownership

Replace the `activityThresholdMs` guard with a proper ownership check. Signature:

```ts
reconcileStaleRunningSessions({
  endedAt?: string;
  status?: TerminalSessionStatus;
  excludeToolTypes?: string[];
  liveOwnerPids: Set<number>;   // NEW — caller passes this in
}): number
```

Semantics:

- A row is "stale" iff `status='running'` AND (`owner_pid IS NULL` OR `owner_pid NOT IN (liveOwnerPids)`).
- The `owner_pid IS NULL` branch catches pre-migration rows (always treated as orphan — they came from before ownership existed).
- Build the SQL with a parameterized `NOT IN (?,?,?...)` clause, with care for the empty-set case (use `NOT IN (-1)` sentinel to keep SQL valid).
- Emit `emitChanged({reason: "meta-updated"})` for each disposed sessionId so renderers refresh.

Callers (`main.ts:1939`, `bootstrap.ts:450`) become:

```ts
processRegistry.start();
const reconciledSessions = sessionService.reconcileStaleRunningSessions({
  status: "disposed",
  liveOwnerPids: processRegistry.listLivePids(),
  // bootstrap.ts also passes its existing excludeToolTypes
});
```

**Delete** `activityThresholdMs` and the two tests that exercised it. Add the new tests in §5.7.

### 5.5 `ptyService` — write owner_pid on every spawn, gate dispose on ownership

File: `apps/desktop/src/main/services/pty/ptyService.ts`.

- Constructor takes a new option `processRegistry: ProcessRegistryService` (or just `ownerPid: () => number` if you want the minimal coupling — the registry is the source of truth either way).
- `create(args)` (line 2392) — when calling `sessionService.create(...)` (line ~2485), pass `ownerPid: registry.pid`.
- `create(args)` — when the resume branch calls `sessionService.reattach(...)` (line 2654), pass `ownerPid: registry.pid`. The resuming process becomes the new owner. **Watch out:** there's another reattach call at line 2436 (live-attached-entry branch) for the rare case where a live PTY is found for an existingSession. That branch should also write `ownerPid: registry.pid`.
- `dispose({ptyId, sessionId})` (line 3497) — **the orphan branch is the dangerous one.** Right now if `ptyId` is unknown but `sessionId` resolves, it disposes the row unconditionally. New behavior: if `session.ownerPid != null && session.ownerPid !== registry.pid && registry.isPidLive(session.ownerPid)`, **skip the dispose** and emit a `warn` log (`pty.dispose_skipped_owned_by_peer`). Return the existing PtyCreateResult shape (caller already handles missing PTY). The "PTY in our map" branch (line 3534 onwards) is fine — if we have the entry, we own it by definition.
- `closeEntry` (line 2080) — no change. It only fires from `pty.onExit` in our process, so by definition we own the row. Leave it alone.

### 5.6 `agentChatService` — write owner_pid on chat row creation

File: `apps/desktop/src/main/services/chat/agentChatService.ts`. The chat rows are also `terminal_sessions` (toolType `claude-chat`, `codex-chat`, etc.).

- Wherever `sessionService.create({...})` is called from `createSession` / `ensureIdentitySession`, pass `ownerPid: registry.pid`.
- `resumeSession` (line 19584 today) and `endSession` (line 8489) — no ownership flip needed for the in-process case (we own it because the runtime is in this process). But: in the multi-daemon world the user has, a chat row created by daemon A may get a `resumeSession` call from daemon B. **Tier 2 fixes this properly by routing to whichever process owns the row.** For tier 1, do an ownership guard in `resumeSession`: if the row's `owner_pid` is a live peer pid (not us), throw `Error("Chat session is owned by another ADE process; cannot resume from here.")`. The renderer should fall back to using the existing daemon RPC path (`callProjectRuntimeActionIfBound`).

### 5.7 Tests

Add to `apps/desktop/src/main/services/sessions/sessionService.test.ts`:

1. `create` with `ownerPid` persists and `get(id)` returns it on `ownerPid`.
2. `reconcileStaleRunningSessions` with a `liveOwnerPids = {12345}` set leaves rows with `owner_pid=12345` alone, sweeps rows with `owner_pid=99999`, sweeps rows with `owner_pid=null` (legacy).
3. `reattach` sets `owner_pid` to the new owner.

New test file `apps/desktop/src/main/services/runtime/processRegistryService.test.ts`:

1. `start` inserts a row.
2. `heartbeat` advances `last_seen`.
3. `listLivePids` includes own pid even before first heartbeat.
4. `listLivePids` excludes a peer pid whose `last_seen` is older than the liveness window.
5. `isPidLive` matches the listLivePids predicate.
6. `pruneStale` deletes peer rows older than 10x liveness window, keeps own.
7. `stop` removes own row.

Add to `apps/desktop/src/main/services/pty/ptyService.test.ts`:

1. `dispose({ptyId: "missing", sessionId})` against a row owned by a live peer is a no-op (does not call `sessionService.end`); emits the warn log.
2. `dispose({ptyId: "missing", sessionId})` against a row owned by us OR a dead peer DOES call `sessionService.end`.
3. `create` writes `owner_pid` on the row.

### 5.8 Edge cases for tier 1

- **Same OS process opens DB twice (sqlite WAL etc.).** Not an issue here — process pid is unique per OS process.
- **Pid reuse after a crash.** A new ADE process happens to grab the same pid as a dead one. The dead one's `runtime_processes` row will have a stale `last_seen` — `listLivePids` won't include it. As soon as `processRegistry.start()` writes the new row, the pid maps to the live process. The narrow race: between the new process starting and writing its first row, a sibling could mistake the stale row's pid (now the new pid) for "still dead." Acceptable; reconcile is best-effort and the new owner will heartbeat within seconds.
- **DB in `journal_mode=delete` (current state).** Confirmed live via `sqlite3 .../ade.db "pragma journal_mode;"` → `delete`. Concurrent writers serialize via SQLite's reserved/exclusive lock. WAL would be better for concurrent readers + writers; that's a separate task. For tier 1, the heartbeat write contention is bounded (one row per process, 5s cadence) and SQLite's `busy_timeout` handles brief stalls.
- **Long-running processes that pause heartbeats during sync GC.** Liveness window is 3x heartbeat interval (15s default) to absorb single missed beats. Tune if you see false positives.
- **Mobile / sync workers.** They also open the DB. Decide their role: probably `"sync-worker"` and treat like any other process. Don't let them dispose anything they didn't create — gate on owner_pid as elsewhere.
- **Stale `runtime_processes` rows after a hard crash.** `pruneStale` cleans them up; call it from each `processRegistry.start()` once at boot.
- **`ChatTerminalDrawer.tsx:387-392` `disposeTabsOnUnmount`** — this is the renderer calling `pty.dispose` from a React effect cleanup. The renderer doesn't know the owner. The main-process `dispose` now refuses to dispose rows it doesn't own, so this is safe even when the renderer unmounts a tab whose backing PTY lives in a daemon. Same goes for `useWorkSessions.stopRuntime` and the chat drawer's "session deleted" branch.

---

## 6. Tier 2 — daemon owns PTYs

Tier 1 makes everything safe. Tier 2 makes it *interactive across surfaces*. The pattern already exists for chats. Mirror it for PTYs.

### 6.1 Add PTY RPC methods to `adeRpcServer`

File: `apps/ade-cli/src/adeRpcServer.ts`. Open the file, find where `sync.*` and `modelPicker.*` methods are dispatched (around line 7763, 7826), and add a similar `pty.*` block.

Methods needed (mirror `ptyService` interface):

- `pty.create` → wraps `ptyService.create(args)` and returns `PtyCreateResult` + the new session row.
- `pty.write` → wraps `ptyService.write({ptyId, data})`.
- `pty.resize` → wraps `ptyService.resize({ptyId, cols, rows})`.
- `pty.dispose` → wraps `ptyService.dispose({ptyId, sessionId})`.
- `pty.sendToSession` → wraps `ptyService.sendToSession(args)`. This is the critical one for the "resume an ended CLI session" flow.
- `pty.list` → returns `service.enrichSessions(...)` snapshot.

The daemon already has an `eventBuffer`. Add a new event category `"pty"` (alongside `"runtime"`, `"mission"`, etc.) and push every `broadcastData`/`broadcastExit` event into it:

```ts
const ptyService = createPtyService({
  ...,
  broadcastData: (event) => {
    runtime.eventBuffer.push({ timestamp: nowIso(), category: "pty", payload: { type: "pty_data", event } });
  },
  broadcastExit: (event) => {
    runtime.eventBuffer.push({ timestamp: nowIso(), category: "pty", payload: { type: "pty_exit", event } });
  },
});
```

Clients subscribe via the existing `runtimeEvents.subscribe` mechanism with `category: "pty"` and get the live stream.

### 6.2 Route the desktop's PTY calls through the daemon

File: `apps/desktop/src/preload/preload.ts`. Look at how `chat.send` works (around line 5173). The pattern:

```ts
const runtime = await callProjectRuntimeActionIfBound<void>("chat", "sendMessage", { args });
if (!runtime.handled) await ipcRenderer.invoke(IPC.agentChatSend, args);
```

Add the same pattern for every `pty.*` method exposed on `window.ade.pty`. When the daemon is bound, route through it. Otherwise fall back to local IPC (the existing behavior).

The IPC handlers in `apps/desktop/src/main/services/ipc/registerIpc.ts` (lines 7572-7589 for pty methods) stay as the local fallback — they call `ctx.ptyService` directly. The desktop-main `ptyService` becomes a legacy fallback that only fires when the daemon isn't reachable.

### 6.3 Renderer subscribes to daemon PTY events

`TerminalView` currently reads PTY data via `window.ade.pty.onData(...)` which fans out from the local main process. Add a parallel subscription to the daemon's `runtimeEvents.subscribe({category: "pty"})` stream. The preload already has `subscribeAgentChatEvents` doing exactly this pattern (preload.ts:2366) — clone it for PTY events.

### 6.4 TUI gets the same byte stream

`apps/ade-cli/src/tuiClient/connection.ts:448 subscribeRuntimeEvents` already supports arbitrary categories. The TUI can subscribe to `category: "pty"` the moment it has an Ink terminal renderer to display the bytes. **Building that Ink terminal widget is out of scope for tier 2** — leave a TODO, ship tier 2 with the wire ready.

### 6.5 Mobile and remote runtimes

`apps/desktop/src/main/services/remoteRuntime/` already brokers chat events to/from a remote daemon via SSH. The PTY event category needs the same forwarding. Audit `remoteConnectionPool.ts` and add the new category to its allowed list.

### 6.6 Migrate `ChatTerminalDrawer` and `WorkViewArea` to be daemon-aware

These components hold direct `window.ade.pty.*` calls. Audit:

- `apps/desktop/src/renderer/components/terminals/WorkViewArea.tsx` — `WorkCliContinuationComposer` and `ClosedCliSessionSurface` invoke `onContinue` which threads through to `pty.sendToSession`. The preload-level routing in §6.2 covers this transparently.
- `apps/desktop/src/renderer/components/chat/ChatTerminalDrawer.tsx` — calls `pty.dispose` on unmount and on session-deleted events. The daemon-side `pty.dispose` (already ownership-gated from tier 1) will no-op cross-process correctly.

### 6.7 Tests

Integration test in `apps/ade-cli/src/adeRpcServer.test.ts`: a client subscribes to `category: "pty"`, calls `pty.create`, then receives `pty_data` notifications when the PTY produces output.

Integration test for the desktop preload routing: when `callProjectRuntimeActionIfBound` is bound, `pty.sendToSession` does NOT hit the local IPC handler.

---

## 7. Acceptance criteria

Run these by hand at the end. None of them require the user.

1. **Concurrent boot, no false dispose.** Start the desktop. Start `ade code` on the same project. Confirm no rows flip to `disposed` purely from the TUI boot. (`sqlite3 .../ade.db "select id, tool_type, status, owner_pid from terminal_sessions where status='running';"` before/after.)
2. **Crash-resilient cleanup.** Start a CLI session in the desktop. `kill -9` the desktop process. Wait > liveness window. Open desktop again. The row is now `disposed` (the new desktop's reconcile sees the dead owner_pid). No live PTYs were killed — verify the runaway claude/codex processes are still in `ps aux` and will be reaped by the OS / a follow-up cleanup pass.
3. **Cross-surface live CLI rendering (tier 2).** Start `claude` from the desktop's Work tab. Open `ade code` in another terminal on the same lane. The TUI sees the same byte stream live (or at minimum receives pty events on `category: "pty"` — the Ink renderer is out of scope but the wire test confirms data is flowing).
4. **Mobile sees what desktop sees** when sync is configured — same `category: "pty"` events forwarded over the remote runtime transport.
5. **Symptom A regression test** — resume an ended CLI session from `ClosedCliSessionSurface`, observe the surface swap to live `TerminalView` immediately (already fixed by `upsertSessionSnapshot` + `reattach` emitChanged from §4; still works).
6. **Symptom B regression test** — start a Claude Code CLI in the desktop, immediately open `ade code` on the same lane. Confirm the desktop's view stays as live `TerminalView`. Confirm the `terminal_sessions` row keeps `status='running'` and `owner_pid` matches the desktop's pid.

---

## 8. Out of scope / follow-ups (do not do as part of this work)

- Build the Ink terminal widget so TUI can render raw PTY bytes for Codex CLI etc. (Tier 2 makes the data available; rendering is a UI task.)
- Move the DB to `journal_mode=wal` for true concurrent readers/writers. Worthwhile but separate.
- Replace the renderer's `disposeTabsOnUnmount` pattern with explicit user intent. The ownership gate makes it safe enough.
- Make the daemon survive desktop crashes when desktop spawned it (currently child of init thanks to `detached: true`, but verify `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts:824 spawnRuntime` does the same).

---

## 9. Working notes for the next agent

- **Worktree:** `/Users/admin/Projects/ADE/.ade/worktrees/deeplinks-d52aa89e/`. Stay in it. Don't switch to project root.
- **Git diff to inspect before starting:** there are pre-existing changes from other in-flight work in this lane (e.g. `agentChatService.ts` hook-noise removal, `chatTranscriptRows.ts` tweaks). Run `git diff --stat` to see what's untouched-by-me vs touched. Don't revert anyone else's changes.
- **Branch:** `ade/deeplinks-d52aa89e`. Don't push or open a PR until acceptance criteria pass.
- **Test sharding** — the test suite is large. Always run scoped (`npx vitest run src/main/services/sessions/sessionService.test.ts` etc.). Full-suite invocations OOM.
- **Type-check:** `npm run typecheck` from `apps/desktop/` and from `apps/ade-cli/`. Both must be green.
- **Lint:** `npm run lint` from `apps/desktop/`. Run only after typecheck.
- **Don't touch normal ADE chats.** The user has been explicit that agent chats already work and any UI changes to `AgentChatPane.tsx` will be rejected unless they're strictly ownership-related. The chat path already has cross-surface sync via the daemon (§3). Don't try to "improve" it.

---

## 10. Investigation log — commands you can re-run to verify

These are the queries that proved the diagnosis. Re-run them to confirm the state matches what's described above.

Find live ADE processes and which sockets they own:

```sh
ps aux | grep -E "ade.*serve|ade-runtime|claude " | grep -v grep
ls -la /tmp/ade-runtime-*.sock /Users/admin/.ade*/sock/*.sock
lsof /Users/admin/.ade-beta/sock/ade.sock
lsof /tmp/ade-runtime-lane-*.sock
```

Confirm multiple ADE processes share the same project DB:

```sh
lsof /Users/admin/Projects/ADE/.ade/ade.db
```

(I saw five processes with the same inode open: desktop electron, ADE Beta main, two TUI lane runtimes, and a dev runtime.)

DB state — running sessions vs OS-level claude processes:

```sh
sqlite3 /Users/admin/Projects/ADE/.ade/ade.db \
  "select id, lane_id, tool_type, status, started_at, ended_at, last_output_at, pty_id from terminal_sessions where status in ('running','disposed') order by started_at desc limit 30;"
```

Cross-reference any `claude` row marked `disposed` against `ps aux | grep "claude --session-id <that id>"`. If the OS process is alive and the row is disposed, you've reproduced Symptom B.

DB journal mode (informational — tier 1 doesn't require WAL):

```sh
sqlite3 /Users/admin/Projects/ADE/.ade/ade.db "pragma journal_mode;"
```

---

## 11. Why this is the right fix

Three things have to be true for the user's bugs to recur. Each tier eliminates one.

- The DB has no concept of "who owns this row." → Tier 1 (`owner_pid` + heartbeat).
- Multiple processes mutate the same row believing they're the sole owner. → Tier 1 (dispose/reconcile gated on ownership).
- Surfaces other than the spawner can't see live output for raw PTY sessions, so the user thinks the session "ended" when really only their view stopped updating. → Tier 2 (daemon owns PTYs, every surface subscribes to the byte stream).

The user's "running for a while and finally responded" anecdote is consistent with this: the agent chat (`claude-chat`) was healthy throughout because it goes through the daemon's chat path. The CLI row (`claude` tool type) had its `owner_pid`-less ancestor stomped at some point — likely by a `dispose` from a renderer effect or a reconcile pass from a sibling process — leaving the OS-level `claude` process orphaned in the DB sense but alive in reality. Tier 1 + Tier 2 together make this configuration impossible.

The alternative fixes considered and rejected:

- **`last_output_at` heuristic only.** Already in place from §4. Doesn't help idle sessions; doesn't help dispose path. Acceptable as belt-and-suspenders, not as the primary mechanism.
- **`process.kill(pid, 0)` instead of a registry table.** Works on the local machine. Falls over for sync / remote-runtime scenarios where the owner is on another host. The registry table generalizes.
- **Lazy verification on interaction (skip reconcile entirely).** Discussed with the user. UI would briefly show stale "running" rows for crashed sessions; user explicitly rejected this UX.
- **Move the DB to WAL mode.** Helps contention but doesn't change the ownership semantics. Worth doing eventually; orthogonal.

The right fix is the registry-backed ownership model + daemon-owned PTYs because both are *consistent with how chats already work in this codebase*. Tier 2 isn't introducing a new pattern, it's extending the one that demonstrably already works to the missing case.
