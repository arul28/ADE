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
  PrPipelineState,
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

/**
 * States whose drawer is fully answerable from data the tab already holds.
 *
 * The graph node carries the job's steps, their conclusions, and their
 * timestamps, all hydrated from the checks/runs poll the pane runs anyway. For
 * these states there is nothing a round trip could add, so the drawer opens
 * with zero GitHub calls.
 */
const LOCALLY_ANSWERABLE: ReadonlySet<PrPipelineState> = new Set<PrPipelineState>([
  "passed",
  "running",
  "queued",
  "skipped",
]);

export function isCheckLogFetchWorthwhile(state: PrPipelineState): boolean {
  return !LOCALLY_ANSWERABLE.has(state);
}

/**
 * Fetch a log excerpt only when the job's state justifies one.
 *
 * `resolution` says what happened, so a caller never has to read "no excerpt" as
 * "the fetch failed": `skipped` means ADE deliberately did not ask GitHub.
 *
 * Pass `force` for a user action ("show me the log for this green job anyway").
 * User-initiated reads are exempt from the automatic-read budget on purpose;
 * this function is the only place that distinction is made.
 */
export async function fetchCheckLogForState(
  args: GetPrCheckLogArgs & { state: PrPipelineState; force?: boolean },
): Promise<{ resolution: "fetched" | "skipped" | "no-api"; excerpt: PrCheckLogExcerpt | null }> {
  const { state, force, ...rest } = args;
  if (!force && !isCheckLogFetchWorthwhile(state)) {
    return { resolution: "skipped", excerpt: null };
  }
  if (!hasCheckLogApi()) return { resolution: "no-api", excerpt: null };
  const excerpt = await fetchCheckLog(force ? { ...rest, includeLog: true } : rest);
  return { resolution: "fetched", excerpt };
}
