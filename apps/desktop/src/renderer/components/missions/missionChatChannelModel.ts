import type {
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
