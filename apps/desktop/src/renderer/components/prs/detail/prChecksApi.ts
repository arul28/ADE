/**
 * Late-bound access to the two CI endpoints owned by the workflow-graph /
 * log-excerpt service.
 *
 * The renderer must keep working against runtimes that predate those methods
 * (older brains, the browser mock, tests), so we look them up at call time and
 * degrade instead of throwing: no graph → the honest swimlane fallback, no log
 * API → the drawer says the log isn't reachable from this runtime.
 */

import type {
  GetPrCheckLogArgs,
  GetPrWorkflowGraphArgs,
  PrCheckLogExcerpt,
  PrWorkflowGraph,
} from "../../../../shared/types";

type PrChecksApiSurface = {
  getWorkflowGraph?: (args: GetPrWorkflowGraphArgs) => Promise<PrWorkflowGraph | null>;
  getCheckLog?: (args: GetPrCheckLogArgs) => Promise<PrCheckLogExcerpt | null>;
};

function surface(): PrChecksApiSurface {
  try {
    return (window.ade?.prs ?? {}) as unknown as PrChecksApiSurface;
  } catch {
    return {};
  }
}

export function hasCheckLogApi(): boolean {
  return typeof surface().getCheckLog === "function";
}

export async function fetchWorkflowGraph(args: GetPrWorkflowGraphArgs): Promise<PrWorkflowGraph | null> {
  const fn = surface().getWorkflowGraph;
  if (typeof fn !== "function") return null;
  return (await fn(args)) ?? null;
}

export async function fetchCheckLog(args: GetPrCheckLogArgs): Promise<PrCheckLogExcerpt | null> {
  const fn = surface().getCheckLog;
  if (typeof fn !== "function") return null;
  return (await fn(args)) ?? null;
}
