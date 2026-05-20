import type {
  OrchestratorChatTarget,
  OrchestratorChatThread,
  OrchestratorRunStatus,
  OrchestratorWorkerState,
} from "../../../shared/types";

export function isLiveMissionWorkerState(state: OrchestratorWorkerState["state"] | null | undefined): boolean {
  return state === "spawned"
    || state === "initializing"
    || state === "working"
    || state === "waiting_input";
}

export function resolveWorkerThreadChannelStatus(args: {
  threadStatus: OrchestratorChatThread["status"];
  workerState: OrchestratorWorkerState | undefined;
  runStatus: OrchestratorRunStatus | null;
}): "active" | "closed" {
  const { threadStatus, workerState, runStatus } = args;
  if (runStatus === "succeeded" || runStatus === "failed" || runStatus === "canceled") return "closed";
  if (threadStatus !== "active") return "closed";
  if (!workerState) return "closed";
  return isLiveMissionWorkerState(workerState.state) ? "active" : "closed";
}

export function shouldShowWorkerStreamingIndicator(args: {
  channelKind: string | null | undefined;
  channelStatus: "active" | "closed" | null | undefined;
  attemptId: string | null | undefined;
  workerState: OrchestratorWorkerState["state"] | null | undefined;
}): boolean {
  if (args.channelKind !== "worker") return false;
  if (args.channelStatus !== "active") return false;
  if (!trimmed(args.attemptId)) return false;
  return args.workerState === "initializing" || args.workerState === "working";
}

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function metadataString(thread: OrchestratorChatThread, key: string): string {
  const value = thread.metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function threadChannelId(thread: OrchestratorChatThread | null | undefined): string | null {
  return thread ? `thread:${thread.id}` : null;
}

export function resolveChatTargetChannelId(args: {
  target: OrchestratorChatTarget;
  threads: OrchestratorChatThread[];
}): string | null {
  const { target, threads } = args;

  if (target.kind === "coordinator") {
    const sessionId = trimmed(target.sessionId);
    const laneId = trimmed(target.laneId);
    const thread = threads.find((candidate) => {
      if (candidate.threadType !== "coordinator") return false;
      if (sessionId && trimmed(candidate.sessionId) !== sessionId) return false;
      if (laneId && trimmed(candidate.laneId) !== laneId) return false;
      return true;
    });
    return threadChannelId(thread);
  }

  if (target.kind === "teammate") {
    const sessionId = trimmed(target.sessionId);
    const teamMemberId = trimmed(target.teamMemberId);
    const thread = threads.find((candidate) => {
      if (candidate.threadType !== "teammate") return false;
      if (sessionId && trimmed(candidate.sessionId) !== sessionId) return false;
      if (teamMemberId && metadataString(candidate, "teamMemberId") !== teamMemberId) return false;
      return true;
    });
    return threadChannelId(thread);
  }

  if (target.kind === "worker") {
    const attemptId = trimmed(target.attemptId);
    const stepId = trimmed(target.stepId);
    const sessionId = trimmed(target.sessionId);
    const stepKey = trimmed(target.stepKey);
    const laneId = trimmed(target.laneId);
    if (!attemptId && !stepId && !sessionId && !stepKey && !laneId) return null;

    const workerThreads = threads.filter((candidate) => candidate.threadType === "worker");
    const thread =
      (attemptId ? workerThreads.find((candidate) => trimmed(candidate.attemptId) === attemptId) : null)
      ?? (stepId ? workerThreads.find((candidate) => trimmed(candidate.stepId) === stepId) : null)
      ?? (sessionId ? workerThreads.find((candidate) => trimmed(candidate.sessionId) === sessionId) : null)
      ?? (stepKey ? workerThreads.find((candidate) => trimmed(candidate.stepKey) === stepKey) : null)
      ?? (!attemptId && !stepId && !sessionId && !stepKey && laneId
        ? workerThreads.find((candidate) => trimmed(candidate.laneId) === laneId)
        : null);
    return threadChannelId(thread);
  }

  if (target.kind === "workers") {
    const laneId = trimmed(target.laneId);
    const thread = threads.find((candidate) => (
      candidate.threadType === "worker"
      && (!laneId || trimmed(candidate.laneId) === laneId)
    ));
    return threadChannelId(thread);
  }

  if (target.kind === "agent") {
    const targetAttemptId = trimmed(target.targetAttemptId);
    if (!targetAttemptId) return null;
    const thread = threads.find((candidate) => (
      candidate.threadType === "worker"
      && trimmed(candidate.attemptId) === targetAttemptId
    ));
    return threadChannelId(thread);
  }

  return null;
}
