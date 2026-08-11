import { createSessionSettleTeardown, residueCountBucket } from "./sessionSettleTeardown";
import type { SettleResidueItem, SettleTeardownContext, SettleTeardownOutcome } from "./sessionSettleTeardown";
import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";

/**
 * @file The settle-teardown wiring, shared by the desktop main process and the ADE
 * brain.
 *
 * It lives here rather than at each construction site because there are TWO of
 * them, and the one that matters most is the easiest to forget: in a normal
 * install the brain owns phone sync, remote commands, and the PR-merge poller,
 * so wiring only the desktop leaves teardown a silent no-op for every settle a
 * user actually triggers from their phone or from `ade`. That is ADE's oldest
 * bug class — works in-process, no-ops in the runtime-backed build — and a
 * shared factory is what stops the two copies drifting apart.
 */

/** Only what teardown needs, so neither caller has to hand over a whole service. */
export type SettleTeardownChatService = {
  interrupt: (args: { sessionId: string; mode: "stop_only" | "stop_and_clear" }) => Promise<unknown>;
  getSessionSummary: (sessionId: string) => Promise<{
    status: string;
    activeBackgroundTaskCount?: number | null;
    provider?: string | null;
    claudeBackgroundJobShort?: string | null;
  } | null>;
  /**
   * Liveness for a persisted Claude `--bg` job; the recorded short alone is not
   * one. REQUIRED, not optional: a wiring without it would read a recorded job
   * as absent and confirm a clean teardown over work that is still running,
   * which is the hole this callback exists to close.
   *
   * `"unknown"` is a distinct answer on purpose — an unreachable daemon is not
   * evidence the job finished.
   */
  hasLiveClaudeBackgroundJob: (
    short: string | null | undefined,
  ) => Promise<"alive" | "gone" | "unknown">;
};

export type SettleTeardownWiringDeps = {
  agentChatService: SettleTeardownChatService;
  /**
   * Built here rather than at each call site: the two sites were byte-identical
   * apart from `surface`, and the property allowlist has already bitten this
   * feature once — two copies is two chances to drift out of it.
   */
  analytics?: { captureInternal: (event: ProductAnalyticsCapture) => unknown } | null;
  surface: "desktop" | "api";
  logger?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
    info: (message: string, meta?: Record<string, unknown>) => void;
  };
};

export type SettleTeardownWiring = {
  runSettleTeardown: (sessionId: string, ctx: SettleTeardownContext) => Promise<SettleTeardownOutcome>;
  onRemoteSettleWrite: (args: { columns: string[]; changesetSessionCount: number }) => void;
  onSettleResidue: (args: { provider: string | null; items: SettleResidueItem[] }) => void;
};

export function createSettleTeardownWiring(deps: SettleTeardownWiringDeps): SettleTeardownWiring {
  const capture = (properties: Record<string, string>): void => {
    deps.analytics?.captureInternal({
      event: "ade_feature_used",
      surface: deps.surface,
      properties: { feature: "work", ...properties },
    });
  };
  const runSettleTeardown = createSessionSettleTeardown({
    interrupt: async (sessionId) => {
      // `stop_only`, never `stop_and_clear`: the latter also cancels the user's
      // QUEUED turns. Design 3c's rule is that losing a settle costs one click
      // while losing the user's work is unrecoverable, and a queued prompt is
      // the user's work. If a queued turn then starts, C3 clears the settle —
      // which is R1, and already the accepted trade.
      await deps.agentChatService.interrupt({ sessionId, mode: "stop_only" });
    },
    readActiveWork: async (sessionId) => {
      const summary = await deps.agentChatService.getSessionSummary(sessionId);
      if (!summary) return null;
      // `activeBackgroundTaskCount` comes from the LIVE managed runtime, so it
      // reads zero after a restart even while a Claude `--bg` job keeps running
      // in the daemon. Counting the persisted job is what stops a settle from
      // looking at a restarted session, seeing it quiet, and filing it as done
      // over work it never stopped — the exact bug this feature exists to fix.
      const liveCount = summary.activeBackgroundTaskCount ?? 0;
      // Only asked when the live count says quiet AND a job is on record — the
      // restart case. The daemon round-trip is not worth paying on every read,
      // and the short is a record rather than a liveness signal: it survives the
      // job finishing, so trusting it alone would make every later settle burn
      // the confirmation budget and report residue that no longer exists.
      const persistedBackgroundJob = liveCount === 0 && summary.claudeBackgroundJobShort
        // Anything but a definite "gone" counts as work. An unreachable daemon
        // means we cannot tell, and guessing "finished" is the one guess that
        // settles over a running job.
        && await deps.agentChatService.hasLiveClaudeBackgroundJob(summary.claudeBackgroundJobShort) !== "gone"
        ? 1
        : 0;
      return {
        active: summary.status === "active",
        backgroundTaskCount: Math.max(liveCount, persistedBackgroundJob),
        provider: summary.provider ?? null,
      };
    },
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  return {
    runSettleTeardown,
    onSettleResidue: ({ provider, items }) => {
      // One event per settle that had residue, not one per failed job: a fleet
      // that fails to stop must not become a burst. Coarse properties only —
      // no session id, task id, command, or error text.
      capture({
        action: "settle_teardown_residue",
        outcome: items[0]?.reason ?? "failed",
        count_bucket: residueCountBucket(items.reduce((total, item) => total + item.count, 0)),
        ...(provider ? { provider } : {}),
      });
    },
    onRemoteSettleWrite: ({ columns, changesetSessionCount }) => {
      // Not a warning and not an anomaly: a paired second desktop replicating
      // its own settles reaches this path by design. It is a RATE signal — how
      // much settle traffic arrives already-decided — and the column names are
      // a fixed set, so no session id or value is recorded.
      deps.logger?.info("settle.remote_tuple_write_reconciled", { columns, changesetSessionCount });
      capture({
        action: "settle_remote_write_reconciled",
        outcome: "partial",
        count_bucket: residueCountBucket(changesetSessionCount),
      });
    },
  };
}
