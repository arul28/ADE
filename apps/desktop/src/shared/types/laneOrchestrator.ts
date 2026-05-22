// ---------------------------------------------------------------------------
// Work-tab lane orchestrator types
// ---------------------------------------------------------------------------

export type OrchestratorRole = "lead" | "worker";

export type LaneOrchestratorPhase = "planning" | "executing" | "validating" | "complete";

export type LaneOrchestratorWorkerStatus =
  | "spawning"
  | "active"
  | "idle"
  | "completed"
  | "failed";

export type LaneOrchestratorWorker = {
  sessionId: string;
  title: string;
  role?: OrchestratorRole;
  status: LaneOrchestratorWorkerStatus;
  createdAt: string;
};

export type LaneOrchestratorState = {
  id: string;
  laneId: string;
  leadSessionId: string;
  phase: LaneOrchestratorPhase;
  planMarkdown?: string;
  workers: LaneOrchestratorWorker[];
  createdAt: string;
  updatedAt: string;
};
