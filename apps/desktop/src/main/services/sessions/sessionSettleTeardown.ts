

import { PROVIDERS_WITHOUT_BACKGROUND_STOP_CONTROL } from "../../../shared/subagentCapabilities";

/**
 * Real settle teardown: stop the work a session owns, then confirm it stopped.
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
};

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
  residue: SettleResidueItem[];
  /** For the residue analytics dimension. Null when the session has no chat. */
  provider?: string | null;
};

/**
 * How long to keep re-reading the session after a stop before calling the work
 * residue. NOT a provider stop budget — those are shorter and live in
 * `agentChatService` (`CLAUDE_STOP_TASK_TIMEOUT_MS` and friends). This is the
 * grace period for a stop that has been accepted and is still draining.
 */
const STOP_CONFIRM_TIMEOUT_MS = 5_000;
const STOP_CONFIRM_POLL_MS = 100;
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

/** Resolves to not-ok rather than rejecting, so a slow provider is residue, not a crash. */
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
    ?? (() => new Promise<void>((resolve) => { setTimeout(resolve, PROVIDER_CALL_TIMEOUT_MS); }));

  return async (sessionId, ctx): Promise<SettleTeardownOutcome> => {
    const residue: SettleResidueItem[] = [];

    const readWork = async (): Promise<SessionActiveWork | null> => {
      const result = await withTimeout(deps.readActiveWork(sessionId), expireProviderCall)
        .catch(() => ({ ok: false }) as const);
      return result.ok ? result.value : null;
    };

    const before = await readWork();
    // Nothing to stop, or a session this service does not own (a plain
    // terminal). Either way there is no work to lose and no residue to report.
    if (!before || (!before.active && before.backgroundTaskCount === 0)) {
      return { residue };
    }

    const provider = before.provider;
    // Checked before the step, not after: the point of the abort is to stop
    // work we have NOT done yet.
    if (ctx.isAborted()) return { residue };

    let stopRejected = false;
    try {
      const stop = await withTimeout(deps.interrupt(sessionId), expireProviderCall);
      if (!stop.ok) {
        stopRejected = true;
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
    if (ctx.isAborted()) return { residue };

    const after = await waitForQuiet(readWork, ctx);
    if (after && (after.active || after.backgroundTaskCount > 0) && !ctx.isAborted()) {
      const remaining = after.backgroundTaskCount + (after.active ? 1 : 0);
      residue.push({
        kind: after.active && after.backgroundTaskCount === 0 ? "active_turn" : "background_tasks",
        reason: stopRejected
          ? "rejected"
          : provider && noStopControl.has(provider)
            ? "no_stop_control"
            : "timeout",
        count: remaining,
        detail: describeResidue(remaining, provider),
      });
    }

    return { residue, provider };
  };

  /**
   * Poll until the session goes quiet or the budget runs out. A stop is
   * asynchronous inside the provider, so reading once immediately after
   * `interrupt` would report residue for work that was about to stop anyway.
   */
  async function waitForQuiet(
    read: () => Promise<SessionActiveWork | null>,
    ctx: SettleTeardownContext,
  ): Promise<SessionActiveWork | null> {
    const deadline = now() + STOP_CONFIRM_TIMEOUT_MS;
    let latest = await read();
    while (latest && (latest.active || latest.backgroundTaskCount > 0) && now() < deadline) {
      if (ctx.isAborted()) return latest;
      await sleep(STOP_CONFIRM_POLL_MS);
      latest = await read();
    }
    return latest;
  }
}

function describeResidue(remaining: number, provider: string | null): string {
  const what = remaining === 1 ? "1 job" : `${remaining} jobs`;
  return provider ? `${what} on ${provider} could not be stopped` : `${what} could not be stopped`;
}

/** Bucketed so a fleet that fails to stop cannot become a high-cardinality dimension. */
export function residueCountBucket(count: number): "1" | "2_5" | "6_plus" {
  if (count <= 1) return "1";
  return count <= 5 ? "2_5" : "6_plus";
}
