import type { LaneLinearIssue } from "../../shared/types";

export type PendingLinearIssueWorkContext = {
  laneId: string;
  issue: LaneLinearIssue;
  contextSource: "lane_link" | "manual";
  modelId: string | null;
  requestedAt: number;
};

/** Pending context expires after 60 seconds to prevent stale consumption. */
const PENDING_TTL_MS = 60_000;

let pending: PendingLinearIssueWorkContext | null = null;

function isExpired(ctx: PendingLinearIssueWorkContext): boolean {
  return Date.now() - ctx.requestedAt > PENDING_TTL_MS;
}

/** Discard stale pending context and return null when expired. */
function getIfFresh(): PendingLinearIssueWorkContext | null {
  if (pending && isExpired(pending)) {
    pending = null;
  }
  return pending;
}

export function requestLinearIssueWorkContext(args: {
  laneId: string;
  issue: LaneLinearIssue;
  contextSource: "lane_link" | "manual";
  modelId?: string | null;
}): PendingLinearIssueWorkContext {
  pending = {
    laneId: args.laneId,
    issue: args.issue,
    contextSource: args.contextSource,
    modelId: args.modelId?.trim() || null,
    requestedAt: Date.now(),
  };
  return pending;
}

export function peekLinearIssueWorkContext(laneId: string): PendingLinearIssueWorkContext | null {
  const ctx = getIfFresh();
  if (!ctx || ctx.laneId !== laneId) return null;
  return ctx;
}

export function consumeLinearIssueWorkContext(laneId: string): PendingLinearIssueWorkContext | null {
  const ctx = getIfFresh();
  if (!ctx || ctx.laneId !== laneId) return null;
  pending = null;
  return ctx;
}
