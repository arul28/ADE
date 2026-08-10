# Settle teardown — design

**Status:** reviewed and approved with amendments. Steps 0-2 of §5 are cleared
to implement; step 3 (attaching real teardown) waits until 1 and 2 are merged
and the race-matrix tests have been seen to pass.

**Step 0 is implemented** — see amendment 6 in §3c-i for the host-side half.

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

### 3b-i. What each clearer does DURING `settling`

This is the hole that sinks the naive version, and it is not obvious: **teardown
itself produces output.** A process being stopped emits its final chunks, which
means C4 fires *because* teardown is running. If C4 bumps the guard revision or
trips abort, every real teardown self-aborts and a settle can never land — the
feature would be dead on arrival and would look like a mysterious no-op.

So the clearers are not uniform during `settling`. They split by whether they
represent a **human decision** or **mechanical exhaust**:

| Clearer | During `settling` | Why |
|---|---|---|
| C3 `clearTurnStartMarkers` (turn start) | **ABORT** | A user turn is the one thing that outranks a settle (§3c). |
| C6 `markLastTurnFailed` | **ABORT**, and surface the failure | `failed` outranks `settled` in canonical precedence; filing a failure as done would bury it. |
| C7 `requestAttention` (`ade chat ask`) | **ABORT** | `needs_you` outranks `settled`; an agent raising its hand must not be silenced by an in-flight settle. |
| C4 `setLastOutputPreview` | **SWALLOWED** | Mechanical exhaust, and largely *produced by the teardown itself*. Does not clear `settled_at`, does not bump the revision, does not abort. |
| C5 `touchSessionActivity` | **SWALLOWED** | Same: activity bookkeeping, not a human decision. |

"Swallowed" means precisely three things, and all three matter: the write does
**not** clear `settled_at`, does **not** bump the guard revision, and does
**not** trip abort. The preview/`last_output_at` columns still update — the row
keeps showing live output while it settles, which is exactly what a visible
`Settling…` state should look like.

**Before `settling` starts, all five clear normally, exactly as today.** The
swallow is scoped to the settling window and nothing else.

The residual risk is honest and small: a *user* typing into a terminal during
the settling window produces C4/C5 and would be swallowed. That is why C3 is the
abort trigger — an accepted turn is the durable signal of user intent, and raw
output is not. For a plain (non-chat) terminal with no turn concept, the settling
window is the whole exposure; it is bounded by `T` and by the fact that settling
is visible while it runs.

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

**Abort result — decided.** An abandoned settle returns a typed
`settle_aborted_by_activity` outcome. **Never silent success** — that is what
#1059 did, and a caller that cannot tell "filed" from "not filed" will build on
the wrong assumption. The contract, per entry point:

| Entry point | Contract |
|---|---|
| `sessions.settle` / `settleMany` (IPC, desktop UI) | Typed outcome; the surface shows a quiet toast — *"Settle canceled — session became active"*. Not an error dialog: nothing went wrong, the user simply started working again. |
| `session.settleSession` / `session.settleSessions` (sync, iOS + hosted web) | Typed outcome in the reply envelope. Older clients that only understand `{ok}` must still parse it — treat the outcome as **additive**, never a new error shape (see the mobile-compatibility rule in `../sync-and-multi-device/`). |
| `session.settleSessions` (ADE action registry) | Typed outcome in the result; bulk callers get per-session outcomes, not one aggregate boolean. |
| PR-merge auto-settle (`prMergeAutoSettlementService`) | Consumes the outcome and does **not** mark the PR handled for an aborted session, so a later pass can retry. Today it marks handled unconditionally. |
| CTO operator tool | Typed outcome surfaced in the tool result, so the model is told the settle did not take rather than assuming it did. |

The bulk shape is the load-bearing one: `settleSessions` currently returns a
changed-id list, and an aborted id is simply absent from it — which is already
*almost* the right contract. Making the absence explicit (id + reason) is the
smallest honest change.

### 3c-i. Precondition: `settled_at` must become host-authoritative

**Verified, and the chokepoint is currently bypassable.** This is a hard
precondition, not a caveat.

`terminal_sessions` is a CRR table (it is not in `LOCAL_ONLY_CRR_EXCLUDED_TABLES`
in `kvDb.ts:775`), and iOS writes `settled_at` into its **own replica**
optimistically before sending the remote command:
`apps/ios/ADE/Services/Database.swift:2128` `updateSessionLifecycleLocked`
assigns `settled_at`, called from `SyncService.swift:9286` on the settle path.
The existing code comment there states the hazard outright — *"`terminal_sessions`
is a CRR table whose local writes replicate upstream"* — and the call site does
carry a rollback for a failed remote command.

Intent is not the problem: every iOS settle *does* route through the host's
`session.settle*` remote command, and so through the chokepoint
(`syncRemoteCommandService.ts:4132` → `sessionService.settleSessions`). The
problem is the **replica write racing the chokepoint's decision**. The phone
cannot know the host's revision, so its optimistic `settled_at` carries no
revision bump. If the host's guard *rejects* the settle (a turn started, §3c),
the host leaves `settled_at` null — and the phone's optimistic row still
replicates in and settles it anyway. The guard is defeated by a merge, not by a
caller.

**Required before the chokepoint lands:** iOS stops writing `settled_at` /
`settle_override` / `settle_source` into its replica. The optimistic
responsiveness those writes buy is preserved with a **local pending-UI state**
(not a CRR write) that resolves when the host's changeset arrives or the command
fails. The rollback path in `SyncService.swift:9286` becomes unnecessary and
should go with it — it exists only to undo a write we will no longer make.

Snooze columns (`snoozed_until`, `snoozed_at`, `woke_*`) are out of scope here;
they are written by the same helper but are not guarded by a revision and have
no teardown attached.

**Amendment 6 — how the host treats a pre-fix client (implemented, step 0).**
Removing the write from iOS fixes new builds and nothing else: a paired phone on
an older build keeps writing `settled_at` into its replica, and a CRDT merge
never reaches the caller a host-side check would guard. Waiting for clients to
update is not a guarantee, so the host enforces it.

`syncHostService` drops inbound `terminal_sessions` changes for `settled_at`,
`settle_override`, and `settle_source` when the peer is a phone
(`isMobileChangesetPeer`), alongside the existing `sync_cluster_state`
brain-seizure filter. The drop is per-column and silent: the rest of the batch —
including the phone's own snooze overlay, which it legitimately owns — applies
normally, and the batch still acks `ok`, because a rejected ack would stall the
peer's outbound cursor and make it resend the same range forever.

It is scoped to phone peers deliberately. A paired **desktop** runs the same
`sessionService` chokepoint, so its settle writes are host-decided too and must
keep replicating; broadening the filter would silently stop settle propagating
between two of a user's own machines.

No capability negotiation is involved — no wire shape changes and the client
needs to know nothing. The visible consequence for a pre-fix phone is that its
optimistic value is now local-only divergence rather than authoritative
corruption, and it self-heals: `refreshWorkSessions` rewrites local rows from the
host's `work.listSessions` payload via `replaceTerminalSessions`. Host authority
wins, which is the whole point of the precondition.

### 3c-ii. Where the revision column lives

**The revision must be local-only.** `terminal_sessions` is CRR, and C4 writes
that row *per terminal output chunk* (`sessionService.ts:1299` — a single
`update` carrying `last_output_preview` + `last_output_at`). Adding a revision
column to that table would ride the same statement and the same row, but
cr-sqlite clocks are **per column**, so it would add a clock entry to every
chunk — sync amplification on the highest-frequency write in the product, for a
value no other device can use.

So: a local-only `session_lifecycle_revisions` table added to
`LOCAL_ONLY_CRR_EXCLUDED_TABLES` (`kvDb.ts:775`), keyed by session id. The
revision is a **host-local concurrency token**, and this is consistent with
making the column host-authoritative in §3c-i — only the host runs the
chokepoint, so only the host needs the token.

Two constraints on the schema, both from the CRR rules in
`../../ARCHITECTURE.md` and `kvDb.ts`:

- the table is excluded from CRR, so the no-non-PK-unique-index rule does not
  bind it — but the exclusion must be *added deliberately*, and
  `removeExcludedCrrMetadata` will un-CRR it if a prior build converted it;
- it must be keyed by session id alone (PK), so the atomic
  `update … set rev = rev + 1` stays a single statement on the write path.

Cost on C4 is one extra local `update` per chunk against a two-column,
PK-lookup, non-replicated table. If that proves measurable under a terminal
firehose, the fallback is to keep the revision **in memory** on the host and
accept that a mid-settle restart resolves to not-settled — which §3b already
requires for the `settling` state anyway, so the two degrade identically.

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

**Option 3 is signed off.** It neither blocks the user nor re-lights the row,
and it makes the residue visible where it actually happened. Two additions are
part of the decision, and both exist because a label alone would just be a
prettier way of losing the process:

1. **The residue must keep the un-stopped work discoverable, not merely
   labelled.** Concretely: it lands on a diagnostics surface that lists what
   could not be stopped and why, and — where the process is one ADE actually
   tracks — it stays eligible for the existing ppid-based orphan reaper
   (`services/processes/orphanedAgentProcessReaper.ts`). A user who sees
   "1 job could not be stopped" must have somewhere to go. Work that escaped the
   process tree entirely (`nohup`/`setsid`/`disown`) is still unreachable and
   must be reported as such rather than silently folded into the same count.
2. **Emit an analytics event**, so we learn how often stops actually fail in the
   field instead of guessing. Per `docs/logging.md`: reuse `ade_feature_used`
   with coarse allowlisted properties — provider, a coarse failure reason
   (`no_stop_control` / `timeout` / `rejected`), and a bucketed count. **No**
   session ids, task ids, commands, or error text. One event per settle that had
   residue, deduplicated per session, not one per failed task — a fleet that
   fails to stop must not become a burst.

Together these turn R5 from a silent hazard into a measured one, which is the
precondition for ever tightening it further.

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

0. **Precondition (§3c-i):** make `settled_at` host-authoritative — iOS stops
   writing the settle columns into its replica and uses a local pending-UI state
   instead. Until this lands, a revision-guarded write is defeatable by CRR
   merge, so the chokepoint would provide a guarantee it does not actually have.
1. Land the chokepoint + lifecycle revision (3a) **alone**, with no teardown.
   It is pure refactor with a testable invariant: no `settled_at` mutation
   outside one function, and every mutation bumps the revision. The revision
   goes in a local-only table (§3c-ii).
2. Add the `settling` state, the per-clearer behavior table (3b-i), and the
   abort rule (3c) — still with a **no-op teardown** — and test the race matrix
   directly against the revision. The C4/C5 swallow is the case to test hardest:
   it is what makes a real teardown able to finish at all.
3. Only then attach real teardown, reusing `stopLaneRuntimeWork`'s shape.
4. Resolve 3d by decision before step 3.

Steps 1 and 2 are independently valuable: the chokepoint alone would have
prevented findings 1, 3, 4, 6, 7, 9, 12, 13, and 15.
