import type { SettleResidueItem, SettleTeardownContext, SettleTeardownOutcome } from "./settlingStateRegistry";

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

/** Bounds a single provider stop, matching the chat service's own stop budget. */
const STOP_CONFIRM_TIMEOUT_MS = 5_000;
const STOP_CONFIRM_POLL_MS = 100;

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
  /**
   * Providers with no way to stop background work at all. A Codex chat cannot
   * stop an individual subagent, so its residue is `no_stop_control` rather
   * than a stop that failed — the distinction is the whole point of the field.
   */
  providersWithoutStopControl?: ReadonlySet<string>;
  onResidue?: (args: { provider: string | null; items: SettleResidueItem[] }) => void;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_NO_STOP_CONTROL = new Set(["codex"]);

export function createSessionSettleTeardown(
  deps: SessionSettleTeardownDeps,
): (sessionId: string, ctx: SettleTeardownContext) => Promise<SettleTeardownOutcome> {
  const noStopControl = deps.providersWithoutStopControl ?? DEFAULT_NO_STOP_CONTROL;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  return async (sessionId, ctx): Promise<SettleTeardownOutcome> => {
    const stopped: string[] = [];
    const residue: SettleResidueItem[] = [];

    const before = await deps.readActiveWork(sessionId).catch(() => null);
    // Nothing to stop, or a session this service does not own (a plain
    // terminal). Either way there is no work to lose and no residue to report.
    if (!before || (!before.active && before.backgroundTaskCount === 0)) {
      return { stopped, residue };
    }

    const provider = before.provider;
    // Checked before the step, not after: the point of the abort is to stop
    // work we have NOT done yet.
    if (ctx.isAborted()) return { stopped, residue };

    let stopRejected = false;
    try {
      await deps.interrupt(sessionId);
      stopped.push("interrupt");
    } catch (error) {
      stopRejected = true;
      deps.logger?.warn("settle_teardown.step_failed", {
        step: "interrupt",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // A turn that arrived while the stop was in flight wins. Do not spend the
    // confirmation budget re-reading a session the user is actively using.
    if (ctx.isAborted()) return { stopped, residue };

    const after = await waitForQuiet(sessionId, ctx);
    const stillActive = after ? after.active || after.backgroundTaskCount > 0 : false;
    if (stillActive && !ctx.isAborted()) {
      const remaining = (after?.backgroundTaskCount ?? 0) + (after?.active ? 1 : 0);
      residue.push({
        kind: after?.active && (after?.backgroundTaskCount ?? 0) === 0 ? "active_turn" : "background_tasks",
        reason: stopRejected
          ? "rejected"
          : provider && noStopControl.has(provider)
            ? "no_stop_control"
            : "timeout",
        // Everything counted here is still a child of this ADE process, which
        // is what keeps it eligible for the ppid-based orphan reaper. Work that
        // escaped the tree (`nohup`/`setsid`/`disown`) is not visible to
        // `readActiveWork` at all, so it is never folded into this count — it is
        // unreachable by construction, and saying otherwise would overstate what
        // the reaper can clean up.
        reapable: true,
        detail: describeResidue(remaining, provider),
      });
    }

    if (residue.length) deps.onResidue?.({ provider, items: residue });
    return { stopped, residue };
  };

  /**
   * Poll until the session goes quiet or the budget runs out. A stop is
   * asynchronous inside the provider, so reading once immediately after
   * `interrupt` would report residue for work that was about to stop anyway.
   */
  async function waitForQuiet(
    sessionId: string,
    ctx: SettleTeardownContext,
  ): Promise<SessionActiveWork | null> {
    const deadline = now() + STOP_CONFIRM_TIMEOUT_MS;
    let latest = await deps.readActiveWork(sessionId).catch(() => null);
    while (latest && (latest.active || latest.backgroundTaskCount > 0) && now() < deadline) {
      if (ctx.isAborted()) return latest;
      await sleep(STOP_CONFIRM_POLL_MS);
      latest = await deps.readActiveWork(sessionId).catch(() => null);
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
