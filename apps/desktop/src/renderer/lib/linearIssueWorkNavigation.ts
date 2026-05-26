import type { LaneLinearIssue } from "../../shared/types";

export type PendingLinearIssueWorkContext = {
  laneId: string;
  issue: LaneLinearIssue;
  contextSource: "lane_link" | "manual";
  modelId: string | null;
  requestedAt: number;
};

let pending: PendingLinearIssueWorkContext | null = null;

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
  if (!pending || pending.laneId !== laneId) return null;
  return pending;
}

export function consumeLinearIssueWorkContext(laneId: string): PendingLinearIssueWorkContext | null {
  if (!pending || pending.laneId !== laneId) return null;
  const next = pending;
  pending = null;
  return next;
}
