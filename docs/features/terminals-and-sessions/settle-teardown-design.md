# Settle teardown — design

**Status:** design, not implemented. Do not build from this until it is reviewed.

Settle currently writes a lifecycle column and stops nothing. A session filed as
"done" can still own a background shell, a subagent fleet, or a Cursor cloud run
— burning tokens and holding ports behind a row that has left every live-work
surface. **Archive is the only lifecycle path that stops processes today**
(`laneService.archive` → `stopLaneRuntimeWork`, ordered before the port-lease
release).

This document exists because the obvious implementation — "await teardown, then
write `settled_at`" — was built, reviewed six times, and cut in PR #1059. It
produced a real P1 every round. The failure was never a missing null check; it
was that an **async teardown cannot be bolted onto a lifecycle column that seven
call paths write and clear synchronously**. What follows is the inventory that
makes that concrete, the races it implies, and a design that removes the class
rather than patching instances.

Companion reading: `README.md` (canonical phase, settle semantics),
`../../playbooks/ship-lane.md` (how the six rounds were surfaced).

---

## 1. Every path that writes or clears `settled_at`

All line numbers are `apps/desktop/src/main/services/sessions/sessionService.ts`
at merge of #1059 (`6d9ff5771`). **Seven distinct paths mutate the column, and
only three of them are named "settle" or "unsettle".** That asymmetry is the
whole problem: teardown was wired to the three obvious ones.

### 1a. Writers (set `settled_at`)

| # | Site | Method | Invoked by |
|---|---|---|---|
| W1 | `:694` | `settleMany` (private; backs `settleSessions` `:1531` and `settleSessionsWithOutcome` `:1535`) | `registry.ts:2171` (`session.settleSessions`) · `registerIpc.ts:6989` (`sessions.settleMany`) · `syncRemoteCommandService.ts:4132` (`session.settleSessions`) · `prMergeAutoSettlementService.ts:188` (PR-merge auto-settle) |
| W2 | `:1430`, `:1445` | `settleSession` (single) | `ctoOperatorTools.ts:555` (CTO operator tool) · `settleTerminalSession.ts` → `registry.ts:2119`, `registerIpc.ts` (`sessions.settle`), `syncRemoteCommandService.ts` (`session.settleSession`) |
| W3 | `:1491`, `:1518` | `setSettleOverride` / `setSettleOverrides` (`'settled'` pin behaves as a declared settle) | row menus and bulk actions via the registry/IPC lifecycle surface |

### 1b. Clearers (set `settled_at = null`)

| # | Site | Method | Invoked by | Named "unsettle"? |
|---|---|---|---|---|
| C1 | `:1465` | `unsettleSession` | `registry.ts:2142` · `registerIpc.ts:6980` · `syncRemoteCommandService.ts:4101` · `ctoOperatorTools.ts:576` | yes |
| C2 | `:1551` | `unsettleSessions` | `registry.ts:2178` · `registerIpc.ts:7003` · `syncRemoteCommandService.ts:4135` | yes |
| C3 | `:1764` | `clearTurnStartMarkers` | `agentChatService.ts:36284`, `:36990` (turn start) · `ptyService.ts:4999` | **no** |
| C4 | `:1299` | `setLastOutputPreview` (`clearSettled`) | `agentChatService.ts:13024` · `ptyService.ts:4134` — **per output chunk** | **no** |
| C5 | `:1323` | `touchSessionActivity` | `ptyService.ts:4159` | **no** |
| C6 | `:1737` | `markLastTurnFailed` | `agentChatService.ts:13590` | **no** |
| C7 | `:1709` | `requestAttention` | `registry.ts:2059` (`ade chat ask`) | **no** |

**Four of seven clearers are implicit.** C4 is on the hottest path in the
product — it runs per terminal output chunk. Any design that requires a hook,
a pre-read, or a second statement at every clear site pays that cost on C4.

---

## 2. Race matrix

`T` = teardown duration (provider stop calls; `CLAUDE_STOP_TASK_TIMEOUT_MS`
bounds a single call, and a fleet is serial — seconds, not milliseconds).

| # | Race | Today's outcome | Severity |
|---|---|---|---|
| R1 | **Settle vs. turn start** — user sends a message during `T` | C3 clears a marker that does not exist yet; the settle write lands afterwards and files a live turn as settled | **worst case.** The user is actively working and the row goes quiet |
| R2 | **Settle vs. teardown-in-progress** — the settle is abandoned after teardown ran | Background work is already stopped and is **not restored**; user loses work *and* gets no settle | asymmetric: the failure hurts in both directions at once |
| R3 | **Settle vs. background completion** — work drains on its own during `T` | Benign. Terminal levels are idempotent; a stop against a finished task is a no-op | low |
| R4 | **Concurrent settle sources** — PR-merge auto-settle (W1) races a user settle (W2) or the CTO tool (W2) | Two teardowns run against one session; the second sees a partially-drained roster and reports differently. `settled_at = coalesce(settled_at, ?)` makes the *write* idempotent, but the teardown is not | medium |
| R5 | **Settle vs. unconfirmed stop** — a provider stop times out or is unavailable | The row settles over work that may still be running. Keeping the task live in `liveBackgroundTaskIds` does not help: `settled` outranks it in the phase | **high** — this is the original bug, unfixed |
| R6 | **Settle vs. C4 output chunk** — any output during `T` | C4 clears the settle mid-teardown; the settle write re-lands after | same shape as R1, at much higher frequency |

**R1/R2/R6 share one root:** the settle decision is made at time `t₀`, the write
lands at `t₀ + T`, and the world is free to change in between with no way to
detect it. `lastActivityAt` is *not* that detector — it is backed by
`last_output_at`, which C3 never writes. That is the dead guard shipped and
caught in round 6.

---

## 3. Proposed design

Three pieces. The first two remove the race class; the third is the product rule.

### 3a. Single settle-writer chokepoint

Every write and clear of `settled_at` goes through one internal function in
`sessionService`. No SQL literal outside it may name the column. `settleMany`,
`settleSession`, `setSettleOverride*`, `unsettleSession(s)`,
`clearTurnStartMarkers`, `setLastOutputPreview`, `touchSessionActivity`,
`markLastTurnFailed`, and `requestAttention` all call it.

The chokepoint owns a **monotonic per-session lifecycle revision**, bumped on
every transition. This is the detector the activity guard needed and did not
have. It must be:

- **synchronous** with the column write (same statement or same transaction), so
  there is no window between "the world changed" and "the revision says so";
- **persisted**, so it survives a restart mid-settle;
- **cheap on C4** — a single integer column incremented in the statement that is
  already running. No pre-read, no second statement.

A settle then becomes: read revision `r₀` → tear down → write **conditionally**
on the revision still being `r₀`. One `where` clause replaces every ad-hoc guard,
at every entry point, for free.

### 3b. An explicit `settling` state

The revision alone still leaves R2 (work stopped, settle abandoned). Add a
short-lived `settling` state the chokepoint sets before teardown starts:

- it is **visible** — the row reads "Settling…", not silently quiet, so a
  multi-second teardown is legible rather than looking like a hang;
- it is **exclusive** — a second settle for the same session joins the in-flight
  one instead of starting a second teardown (closes R4);
- it is **abortable** — see 3c;
- it is **crash-safe** — a `settling` row found at startup did not finish, and
  resolves to not-settled. Teardown is not resumable across a restart, and
  pretending otherwise would resurrect the "orphaned work is live work" mistake
  that the liveness half deliberately avoids.

### 3c. The rule for a turn arriving mid-teardown

**An accepted user turn ABORTS the settle and the teardown. Never the reverse.**

This was the coordinator's starting position and the inventory supports it:
losing a settle costs one click; losing background work the user is mid-way
through is unrecoverable, and ADE cannot re-spawn a shell it stopped. R2 is the
only race where *both* outcomes are bad, and this rule makes it one-sided.

Concretely: teardown checks an abort signal between each stop call; a turn start
(C3) trips it. Work already stopped before the abort is lost — that is inherent,
which is an argument for stopping the **cheapest-to-lose things first** (cloud
runs and monitors before long-lived shells), not for a heroic restore.

**Open question for review:** what does an *abandoned* settle report to its
caller? Silently returning success is what #1059 did and it is a small lie. A
distinct `settle_aborted_by_activity` result is honest but is a new contract for
five entry points, mobile included.

### 3d. When teardown cannot confirm

R5 is a product decision, not a mechanism. If a provider stop is unavailable,
times out, or fails, the options are:

1. **Reject the settle** — honest, but a Codex chat (no per-subagent stop
   control at all) could then never be settled while it owns background work.
2. **Settle, and let the row keep reporting the live work** — requires `settled`
   to stop outranking liveness in presentation and rollups, which re-lights a
   row the user declared done.
3. **Settle and record the unconfirmed work** — a marker on the row ("settled,
   1 job could not be stopped") with no change to filing.

Option 3 is the recommendation: it neither blocks the user nor re-lights the
row, and it makes the residue visible where it actually happened. **This needs
sign-off before implementation** — it is the one place where the honest answer
and the quiet answer differ.

---

## 4. What the 16 P1 findings constrain

Each row is a design constraint bought with a review round. The mechanism from
§3 that neutralises it is named.

| # | Finding (round) | Constraint | Neutralised by |
|---|---|---|---|
| 1 | Unsettle left schedules paused (2) | Any durable state teardown takes needs an exact, complete undo — or must not be taken | 3a chokepoint |
| 2 | Generic shells classified as monitors (2) | Mixed-meaning provider types are *unknown*; unknown is working | shipped in #1059 |
| 3 | Activity-driven unsettle skipped the resume (3) | The implicit clearers are the common case, not the edge case | 3a |
| 4 | CTO operator settle bypassed teardown (3) | Any per-caller wiring will be missed by a caller | 3a |
| 5 | Failed stop still closed the task row (3) | Never report work as concluded on an unconfirmed stop | 3d |
| 6 | Settle-clear paths skipped the hook — 3 of 7 (4) | The full clear inventory must be enumerated **before** design, not discovered | §1 |
| 7 | Stale resume released a newer pause (4) | Deferred lifecycle work must carry identity, not just a session id | 3a revision |
| 8 | Settling mid-turn tore down nothing (5) | A carve-out for "active turn" must distinguish turn-owned from detached work | 3c |
| 9 | RPC operator bridge missing the control (5) | Daemon and in-process construction must be wired from one place | 3a |
| 10 | Stop count could not be kept honest (5) | Do not report a number the code cannot substantiate | 3d |
| 11 | Unconfirmed stop closed the row upstream (6) | The invariant must hold in shared helpers, not just new code | 3d |
| 12 | Teardown raced the lifecycle write (6) | The settle write must be conditional on a revision, not a timestamp | 3a |
| 13 | The activity guard could not fire (6) | Verify the field a guard reads actually changes on the event it guards | 3a |
| 14 | Losing settle still stopped work (6) | Abort must precede the stop, not follow it | 3c |
| 15 | Guard applied to one entry point only (6) | The guarantee belongs to the writer, not the caller | 3a |
| 16 | Settled state hides live work (7) | If settle cannot stop the work, it must not silently own it | 3d |

Findings 6, 13, and 15 are the load-bearing ones: **enumerate the writers first,
verify the detector, and put the guarantee in the writer.** #1059 did none of the
three, and that is why it produced a defect every round.

---

## 5. Sequencing

1. Land the chokepoint + lifecycle revision (3a) **alone**, with no teardown.
   It is pure refactor with a testable invariant: no `settled_at` mutation
   outside one function, and every mutation bumps the revision.
2. Add the `settling` state and abort rule (3b, 3c), still with a no-op
   teardown, and test the race matrix directly against the revision.
3. Only then attach real teardown, reusing `stopLaneRuntimeWork`'s shape.
4. Resolve 3d by decision before step 3.

Steps 1 and 2 are independently valuable: the chokepoint alone would have
prevented findings 1, 3, 4, 6, 7, 9, 12, 13, and 15.
