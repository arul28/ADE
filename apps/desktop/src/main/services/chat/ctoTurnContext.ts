import { providerDisplayLabel } from "../../../shared/pendingInputLabels";
import type {
  AgentChatCompletionReport,
  AgentChatProvider,
  AgentChatSpawnCompletion,
} from "../../../shared/types";

/**
 * The pure pieces of a CTO turn: what its reconstruction context may carry,
 * and how a finished child is reported back into its thread.
 *
 * None of them touch the chat runtime — they take text, flags and a completion
 * report and return text. Out of `agentChatService` they are testable without
 * standing up the provider graph, which is the whole reason this module exists.
 */

/**
 * Tail-truncate to a character budget WITHOUT ever keeping a partial line.
 *
 * The reconstruction context opens with the CTO's role prompt and closes with
 * the live state block, so a raw `slice(-n)` could hand the model half a
 * doctrine line or half a lane row — a fragment that still reads as a complete
 * instruction. Dropping the leading partial line costs a few characters and
 * removes that whole class of defect. A budget too small to hold even one whole
 * line yields nothing rather than a fragment.
 */
export function truncateTailToLineBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const tail = text.slice(text.length - maxChars);
  const firstBreak = tail.indexOf("\n");
  if (firstBreak === -1) return "";
  return tail.slice(firstBreak + 1);
}

/**
 * Should this turn's reconstruction context carry the lane-scoped project
 * memory section?
 *
 * The CTO already receives the whole of durable memory, and a personal chat has
 * no project lane at all. Everyone else gets it once per lane change, keyed on
 * the same `lastLaneDirectiveKey` the lane execution directive uses — so the
 * section arrives with the directive that explains the lane, and a worker that
 * stays put never pays for it again.
 */
export function shouldInjectLaneMemoryContext(args: {
  isCto: boolean;
  isPersonal: boolean;
  laneDirectiveKey: string | null;
  lastLaneDirectiveKey: string | null;
}): boolean {
  if (args.isCto || args.isPersonal) return false;
  if (!args.laneDirectiveKey) return false;
  return args.lastLaneDirectiveKey !== args.laneDirectiveKey;
}

/**
 * The PR a finished child produced, when it named one. The completion report
 * is the structured place an agent files it; the closing summary is the
 * fallback, because plenty of agents write the number in prose and never file
 * an artifact at all.
 */
export function readChildPullRequestNumber(
  completion: AgentChatCompletionReport | null | undefined,
  summary: string,
): number | null {
  const fromText = (value: string | null | undefined): number | null => {
    const match = value?.match(/(?:\/pull\/|#)(\d{1,7})(?!\d)/);
    const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  for (const artifact of completion?.artifacts ?? []) {
    const found = fromText(artifact.reference) ?? fromText(artifact.description);
    if (found != null) return found;
  }
  return fromText(summary);
}

/**
 * One line, never a transcript: what finished, on which provider, how it
 * ended, and the PR if there is one. The CTO runs dozens of chats at once, so
 * a child report that pasted the child's closing summary into its thread
 * would bury every other thing it is holding.
 */
export function formatCtoChildReportLine(args: {
  childTitle: string;
  provider: AgentChatProvider;
  status: AgentChatSpawnCompletion["status"];
  prNumber: number | null;
}): string {
  const outcome = args.status === "completed"
    ? "finished"
    : args.status === "stopped"
      ? "was stopped"
      : "failed";
  return [
    `"${args.childTitle}"`,
    providerDisplayLabel(args.provider, "agent"),
    outcome,
    ...(args.prNumber != null ? [`PR #${args.prNumber}`] : []),
  ].join(" · ");
}
