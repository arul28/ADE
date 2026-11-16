import { useMemo } from "react";
import type { AgentChatSessionStatus } from "../../../shared/types";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import { runningSubagentRowCount, useChatSubagentRows } from "./chatSubagentRoster";

/**
 * The small count on the chat progress toggle: proof first, then subagents
 * running now, then an unfinished task list. A finished list shows none.
 *
 * The subagent number comes from the same rows the progress pane lists
 * (`useChatSubagentRows`): only children that report back, and "running"
 * checked against what the child's machine says. Rendered inside the chat's
 * runtime scope, so the rows read the chat's own machine.
 */
export function ChatActionsToggleBadge({
  proofArtifactCount,
  sessionId,
  snapshots,
  childChatStatuses,
  runtimeAlive,
  taskProgress,
}: {
  proofArtifactCount: number;
  sessionId: string | null | undefined;
  snapshots: ChatSubagentSnapshot[];
  childChatStatuses: ReadonlyMap<string, AgentChatSessionStatus>;
  runtimeAlive: boolean | undefined;
  taskProgress: { done: number; total: number } | null | undefined;
}) {
  const { rows } = useChatSubagentRows(sessionId, snapshots, childChatStatuses, runtimeAlive);
  const runningCount = useMemo(() => runningSubagentRowCount(rows), [rows]);
  if (proofArtifactCount > 0) {
    return (
      <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-emerald-500/80 px-0.5 font-mono text-[8px] font-bold text-black">
        {proofArtifactCount}
      </span>
    );
  }
  if (runningCount > 0) {
    return (
      <span
        data-testid="chat-actions-subagent-badge"
        className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-amber-400/85 px-0.5 font-mono text-[8px] font-bold text-(color:--ade-on-tone-ink)"
      >
        {runningCount}
      </span>
    );
  }
  if (taskProgress && taskProgress.total > 0 && taskProgress.done < taskProgress.total) {
    return (
      <span
        data-testid="chat-actions-task-badge"
        className="absolute -right-1.5 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-sky-400/85 px-0.5 font-mono text-[8px] font-bold text-(color:--ade-on-tone-ink)"
      >
        {taskProgress.done}/{taskProgress.total}
      </span>
    );
  }
  return null;
}
