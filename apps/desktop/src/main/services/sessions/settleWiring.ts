import { createSettleTurnCheck } from "./settleTurnCheck";
import type { SettleCheckOutcome } from "./settleTurnCheck";
import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";

/**
 * @file The settle wiring, shared by the desktop main process and the ADE brain.
 *
 * It lives here rather than at each construction site because there are TWO of
 * them, and the one that matters most is the easiest to forget: in a normal
 * install the brain owns phone sync, remote commands, and the PR-merge poller,
 * so wiring only the desktop leaves the settle check a silent no-op for every
 * settle a user triggers from their phone or from `ade`.
 */

/** A subagent and the parent that spawned it, for the settle cascade. */
export type SubagentLink = { sessionId: string; parentSessionId: string };

/** Only what the settle path needs, so neither caller has to hand over a whole service. */
export type SettleChatService = {
  getSessionSummary: (sessionId: string) => Promise<{ status: string; turnAcceptedAt?: string | null } | null>;
  /** Subagents of these sessions, so a settled parent can settle its subagents. */
  listSubagentLinks?: (parentSessionIds: readonly string[]) => Promise<SubagentLink[]>;
};

export type SettleWiringDeps = {
  agentChatService: SettleChatService;
  analytics?: { captureInternal: (event: ProductAnalyticsCapture) => unknown } | null;
  surface: "desktop" | "api";
  logger?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
    info: (message: string, meta?: Record<string, unknown>) => void;
  };
};

export type SettleWiring = {
  checkSettle: (sessionId: string) => Promise<SettleCheckOutcome>;
  onRemoteSettleWrite: (args: { columns: string[]; changesetSessionCount: number }) => void;
  listSubagentLinks: (parentSessionIds: readonly string[]) => Promise<SubagentLink[]>;
};

/** Bucketed so a large changeset cannot become a high-cardinality dimension. */
function countBucket(count: number): "1" | "2_5" | "6_plus" {
  if (count <= 1) return "1";
  return count <= 5 ? "2_5" : "6_plus";
}

export function createSettleWiring(deps: SettleWiringDeps): SettleWiring {
  const checkSettle = createSettleTurnCheck({
    readTurnRunning: async (sessionId) => {
      const summary = await deps.agentChatService.getSessionSummary(sessionId);
      // An accepted turn the provider has not started yet is still a turn: the
      // chat reads idle until then, and a settle landing in that gap would fire
      // its automations and cascade only for the turn start to undo it.
      return summary ? summary.status === "active" || Boolean(summary.turnAcceptedAt) : null;
    },
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  return {
    checkSettle,
    listSubagentLinks: async (parentSessionIds) =>
      (await deps.agentChatService.listSubagentLinks?.(parentSessionIds)) ?? [],
    onRemoteSettleWrite: ({ columns, changesetSessionCount }) => {
      // Not a warning and not an anomaly: a paired second desktop replicating
      // its own settles reaches this path by design. It is a RATE signal — how
      // much settle traffic arrives already-decided — and the column names are
      // a fixed set, so no session id or value is recorded.
      deps.logger?.info("settle.remote_tuple_write_reconciled", { columns, changesetSessionCount });
      deps.analytics?.captureInternal({
        event: "ade_feature_used",
        surface: deps.surface,
        properties: {
          feature: "work",
          action: "settle_remote_write_reconciled",
          outcome: "partial",
          count_bucket: countBucket(changesetSessionCount),
        },
      });
    },
  };
}

/**
 * The settle hooks `createSessionService` takes, bound later to the real wiring.
 *
 * The session service is built before the chat service that knows which turns
 * are running, so both hosts hand it these forwarders first and `bind` the
 * wiring once the chat service exists. Until then no chat has a running turn
 * to refuse, a remote write has nothing to report to, and no chat has
 * subagents.
 */
export function createLateBoundSettle(): Pick<SettleWiring, "checkSettle" | "onRemoteSettleWrite" | "listSubagentLinks"> & {
  bind: (wiring: SettleWiring) => void;
} {
  let bound: SettleWiring | null = null;
  return {
    checkSettle: async (sessionId) => (bound ? await bound.checkSettle(sessionId) : {}),
    onRemoteSettleWrite: (args) => bound?.onRemoteSettleWrite(args),
    listSubagentLinks: async (parentSessionIds) => (bound ? await bound.listSubagentLinks(parentSessionIds) : []),
    bind: (wiring) => { bound = wiring; },
  };
}
