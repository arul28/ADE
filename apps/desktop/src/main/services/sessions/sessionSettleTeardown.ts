

import { PROVIDERS_WITHOUT_BACKGROUND_STOP_CONTROL } from "../../../shared/subagentCapabilities";
import type { SessionSettleSource } from "../../../shared/types/sessions";
import type { SettleAbortedReason } from "./settlingStateRegistry";

/**
 * @file Real settle teardown: stop the work a session owns, then confirm it stopped.
 *
 * Shaped after `laneService.stopLaneRuntimeWork` — an ordered list of steps,
 * each in its own try/catch so one failure cannot abandon the rest — but NOT
 * built on it. That function disposes chat sessions outright because it serves
 * lane deletion; a settle must leave the session usable, so this stops the
 * session's *outstanding work* and nothing else.
 *
 * Two rules from the design are load-bearing here:
 *
 * - **Terminals stay open.** A settle files a session as done; it does not take
 *   the user's shell away, and ADE cannot re-spawn one it killed. PTYs are
 *   never touched, at any step.
 * - **An accepted turn beats the settle, never the reverse** (§3c). The abort is
 *   checked before every step, so a turn that starts mid-teardown stops the
 *   remaining stops. Work already stopped is lost — inherent, and the reason the
 *   order below is cheapest-to-lose first.
 */

/**
 * What a teardown could not confirm it stopped (design 3d, option 3).
 *
 * The settle still lands — that is the signed-off decision — but it lands WITH
 * this attached, so "settled" never quietly means "and something is still
 * running".
 *
 * Everything recorded here is work ADE tracks, which is what keeps it eligible
 * for the ppid-based orphan reaper. Work that escaped the process tree
 * (`nohup`/`setsid`/`disown`) is invisible to the confirmation read, so it is
 * never counted here — the design requires that it not be folded in and
 * overstated as recoverable, and by construction it cannot be.
 */
export type SettleResidueItem = {
  /** Coarse and closed: this is also the analytics dimension. */
  kind: "background_tasks" | "active_turn";
  /**
   * Why the stop did not confirm. `no_stop_control` is a provider that offers
   * no way to stop this work at all (a Codex chat's subagents); `timeout` and
   * `rejected` are a stop that was attempted and did not land.
   */
  reason: "no_stop_control" | "timeout" | "rejected";
  /** How many jobs this item covers. Bucketed before it reaches analytics. */
  count: number;
  /** Human-readable, for the diagnostics surface. Never analytics. */
  detail: string;
};

/** Checked BETWEEN stop calls, per design 3c. A turn start trips it. */
export type SettleTeardownContext = {
  isAborted: () => boolean;
  /**
   * Whether this settle is allowed to cancel a turn that is running RIGHT NOW.
   *
   * Required, not optional: the answer is a property of who asked for the
   * settle, and a default would silently give an automation the user's
   * privileges. See `settleSourceMayInterruptActiveTurn`.
   */
  mayInterruptActiveTurn: boolean;
};

/**
 * Who is allowed to cancel a running turn.
 *
 * A person asking for a settle has decided the work is over and can watch what
 * happens; a poller has decided nothing — it only noticed something. So the
 * split is by who made the decision, not by how the call arrived:
 *
 * - `user` — someone clicked settle. Today's behavior; may interrupt.
 * - `operator` — the CTO operator tool acting on a person's direct instruction,
 *   one named session at a time, reporting the refusal straight back to them.
 *   A proxy for the user, so it carries the user's privileges.
 * - `agent_explicit` — the session's own agent declaring itself finished. The
 *   only turn it can cancel is its own, which is exactly what it asked for.
 * - `pr_merge` — the PR poller. Machine-initiated: nobody is watching, the
 *   session was not named by a person, and the merge will still be there on the
 *   next pass. It waits instead.
 *
 * Exhaustive on purpose (no `default`): a new `SessionSettleSource` must come
 * back here and be classified rather than inherit whichever answer is cheaper.
 */
export function settleSourceMayInterruptActiveTurn(source: SessionSettleSource | undefined): boolean {
  switch (source ?? "user") {
    case "user":
    case "operator":
    case "agent_explicit":
      return true;
    case "pr_merge":
      return false;
  }
}

/**
 * The result of a real teardown.
 *
 * This replaces step 2's synchronous `SettleTeardownCompleted` brand. That
 * brand made an awaited teardown a COMPILE error while the settle path was
 * still synchronous. It is safe to await now because the settling window is
 * exclusive, abortable and crash-safe, so it can be HELD across the await; the
 * revision re-check and abort check after the await are the guards that make
 * the suspension point survivable.
 */
export type SettleTeardownOutcome = {
  /**
   * True only when teardown actually ran AND confirmed the session went quiet.
   *
   * An empty `residue` is not the same claim: it is also what you get before the
   * chat service exists, or when the confirmation read never came back. Only a
   * confirmed-clean settle may erase a previous residue record — otherwise a
   * settle that checked nothing deletes an accurate report of work that is
   * still running.
   */
  confirmed: boolean;
  residue: SettleResidueItem[];
  /** For the residue analytics dimension. Null when the session has no chat. */
  provider?: string | null;
  /**
   * Set when teardown decided the settle must NOT land at all.
   *
   * Distinct from `confirmed: false`, which still settles and records residue:
   * this says nothing was stopped and nothing should be filed, so the caller
   * reports an abort and leaves the session exactly as it found it.
   */
  abortedBy?: SettleAbortedReason;
};

/**
 * How long to keep re-reading the session after a stop before calling the work
 * residue. NOT a provider stop budget — those are shorter and live in
 * `agentChatService` (`CLAUDE_STOP_TASK_TIMEOUT_MS` and friends). This is the
 * grace period for a stop that has been accepted and is still draining.
 */
const STOP_CONFIRM_TIMEOUT_MS = 5_000;
const STOP_CONFIRM_POLL_MS = 100;
const STOP_CONFIRM_MAX_POLL_MS = 800;
/**
 * Per-call ceiling for the provider calls themselves.
 *
 * The poll budget above bounds the LOOP, not any single await. Without this a
 * provider control call that never resolves would hold the settling window
 * open forever: the `finally` that closes it is unreachable, the row is stuck
 * showing "Settling…", it can never be settled again for the life of the
 * process, and the IPC or remote-command caller hangs with it.
 */
const PROVIDER_CALL_TIMEOUT_MS = 10_000;

/**
 * Resolves to not-ok rather than rejecting, so a slow provider is residue, not
 * a crash.
 *
 * KNOWN LIMITATION: the losing arm keeps running. `agentChatService.interrupt`
 * takes no abort signal, so a provider stop that overruns the ceiling cannot be
 * recalled — and a session-scoped one (OpenCode's `session.abort`) could land
 * after the settle was abandoned and stop a turn the user has since started,
 * which is the one thing §3c says must never happen.
 *
 * Shipped anyway, deliberately: the alternative is no ceiling, and an
 * un-bounded await holds the settling window open forever and leaves the row
 * permanently unsettleable — a certain failure traded for a narrow one. The
 * window needs a provider stop to overrun 10s AND the user to start a turn
 * inside it AND the late abort to still apply, and a provider hung that long is
 * usually not delivering the abort either. Closing it properly means threading
 * an AbortSignal through every provider branch of `interrupt`.
 */
async function withTimeout<T>(
  work: Promise<T>,
  expire: () => Promise<void>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  return await Promise.race([
    work.then((value) => ({ ok: true, value }) as const),
    expire().then(() => ({ ok: false }) as const),
  ]);
}

export type SessionActiveWork = {
  /** A turn is running right now. */
  active: boolean;
  /** Background tasks, subagents, or cloud runs still attributed to the session. */
  backgroundTaskCount: number;
  provider: string | null;
};

export type SessionSettleTeardownDeps = {
  /**
   * Stop the session's active turn and its background work. Resolves when the
   * stop has been REQUESTED; whether it took is decided by `readActiveWork`.
   */
  interrupt: (sessionId: string) => Promise<void>;
  /** Ground truth after a stop. `null` for a session the chat service does not own. */
  readActiveWork: (sessionId: string) => Promise<SessionActiveWork | null>;
  /** Overrides `PROVIDERS_WITHOUT_BACKGROUND_STOP_CONTROL`; tests only. */
  providersWithoutStopControl?: ReadonlySet<string>;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
  now?: () => number;
  /**
   * Delay between confirmation polls. Tests fast-forward this.
   *
   * Deliberately NOT the same seam as `expireProviderCall`: a fast-forwarding
   * `sleep` would otherwise win every timeout race and make every provider call
   * look like it hung.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Fires when a single provider call has taken too long. Real timer by default. */
  expireProviderCall?: () => Promise<void>;
};

export function createSessionSettleTeardown(
  deps: SessionSettleTeardownDeps,
): (sessionId: string, ctx: SettleTeardownContext) => Promise<SettleTeardownOutcome> {
  const noStopControl = deps.providersWithoutStopControl ?? PROVIDERS_WITHOUT_BACKGROUND_STOP_CONTROL;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const expireProviderCall = deps.expireProviderCall
    ?? (() => new Promise<void>((resolve) => { setTimeout(resolve, PROVIDER_CALL_TIMEOUT_MS).unref?.(); }));

  return async (sessionId, ctx): Promise<SettleTeardownOutcome> => {
    const residue: SettleResidueItem[] = [];

    // `{ok:false}` rather than collapsing a timeout to null: a timed-out read
    // and "this is not a chat session" are both absences, and treating them the
    // same is how a slow host settles while claiming a clean teardown. Making
    // it a discriminated result forces every call site to decide.
    const readWork = async (): Promise<{ ok: true; value: SessionActiveWork | null } | { ok: false }> =>
      await withTimeout(deps.readActiveWork(sessionId), expireProviderCall)
        .catch(() => ({ ok: false }) as const);

    const timedOutResidue = (provider: string | null = null): SettleTeardownOutcome => ({
      residue: [{
        kind: "background_tasks",
        reason: "timeout",
        count: 1,
        detail: "could not read what this session was running, so nothing was stopped",
      }],
      provider,
      confirmed: false,
    });

    const first = await readWork();
    if (!first.ok) return timedOutResidue();
    const before = first.value;
    // Nothing to stop, or a session this service does not own (a plain
    // terminal). Either way there is no work to lose and no residue to report.
    if (!before || (!before.active && before.backgroundTaskCount === 0)) {
      return { residue, confirmed: true };
    }

    const provider = before.provider;
    // A machine-initiated settle never cancels a turn the user is watching run.
    // `interrupt` is not selective — it stops the turn and the background work
    // together — so the only way to honor that is to not call it, and to give
    // up the settle entirely rather than file a session whose work is untouched
    // and still going. The merge is not lost: the poller retries on a later
    // pass, once the session is genuinely at rest.
    //
    // Background work WITHOUT an active turn is still stopped: nothing is being
    // watched, and that is the work a settle exists to close out.
    if (before.active && !ctx.mayInterruptActiveTurn) {
      return { residue, provider, confirmed: false, abortedBy: "turn_start" };
    }
    // Checked before the step, not after: the point of the abort is to stop
    // work we have NOT done yet.
    if (ctx.isAborted()) return { residue, confirmed: false };

    // Tracked apart: a provider that REFUSED the stop and one that never
    // answered are different facts, and collapsing them is what the reason
    // field exists to prevent — a hung call would be filed as an explicit
    // rejection in both the residue the user sees and the analytics.
    let stopRejected = false;
    let stopTimedOut = false;
    try {
      const stop = await withTimeout(deps.interrupt(sessionId), expireProviderCall);
      if (!stop.ok) {
        stopTimedOut = true;
        deps.logger?.warn("settle_teardown.step_timed_out", { step: "interrupt" });
      }
    } catch (error) {
      stopRejected = true;
      deps.logger?.warn("settle_teardown.step_failed", {
        step: "interrupt",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // A turn that arrived while the stop was in flight wins. Do not spend the
    // confirmation budget re-reading a session the user is actively using.
    if (ctx.isAborted()) return { residue, confirmed: false };

    const confirmed = await waitForQuiet(readWork, ctx);
    // Same rule for the confirmation read: a timeout here is not confirmation.
    if (!confirmed.ok) return timedOutResidue(provider);
    const after = confirmed.value;
    if (after && !ctx.isAborted()) {
      const reason = stopRejected
        ? "rejected" as const
        : stopTimedOut
          ? "timeout" as const
          : provider && noStopControl.has(provider)
            ? "no_stop_control" as const
            : "timeout" as const;
      // A surviving turn and surviving background tasks are separate facts.
      // Folding them into one item lost both the kind and the count — the two
      // things the residue exists to report.
      if (after.backgroundTaskCount > 0) {
        residue.push({
          kind: "background_tasks",
          reason,
          count: after.backgroundTaskCount,
          detail: describeResidue(after.backgroundTaskCount, provider, "jobs"),
        });
      }
      if (after.active) {
        residue.push({
          kind: "active_turn",
          reason,
          count: 1,
          detail: describeResidue(1, provider, "turn"),
        });
      }
    }

    return { residue, provider, confirmed: !ctx.isAborted() };
  };

  /**
   * Poll until the session goes quiet or the budget runs out. A stop is
   * asynchronous inside the provider, so reading once immediately after
   * `interrupt` would report residue for work that was about to stop anyway.
   */
  async function waitForQuiet(
    read: () => Promise<{ ok: true; value: SessionActiveWork | null } | { ok: false }>,
    ctx: SettleTeardownContext,
  ): Promise<{ ok: true; value: SessionActiveWork | null } | { ok: false }> {
    const deadline = now() + STOP_CONFIRM_TIMEOUT_MS;
    let delay = STOP_CONFIRM_POLL_MS;
    let latest = await read();
    while (latest.ok && latest.value && (latest.value.active || latest.value.backgroundTaskCount > 0) && now() < deadline) {
      if (ctx.isAborted()) return latest;
      await sleep(delay);
      // `getSessionSummary` resolves persisted state, model descriptors and a
      // pending-input query; 10 Hz for five seconds is ~50 of those per settle.
      delay = Math.min(delay * 2, STOP_CONFIRM_MAX_POLL_MS);
      latest = await read();
    }
    return latest;
  }
}

function describeResidue(count: number, provider: string | null, noun: "jobs" | "turn"): string {
  const what = noun === "turn"
    ? "the running turn"
    : count === 1 ? "1 job" : `${count} jobs`;
  return provider ? `${what} on ${provider} could not be stopped` : `${what} could not be stopped`;
}

/** Bucketed so a fleet that fails to stop cannot become a high-cardinality dimension. */
export function residueCountBucket(count: number): "1" | "2_5" | "6_plus" {
  if (count <= 1) return "1";
  return count <= 5 ? "2_5" : "6_plus";
}
