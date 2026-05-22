import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentChatCreateArgs,
  AgentChatProvider,
  AgentChatSendArgs,
  AgentChatSession,
  LaneOrchestratorPhase,
  LaneOrchestratorState,
  LaneOrchestratorWorker,
  LaneOrchestratorWorkerStatus,
  OrchestratorRole,
} from "../../../shared/types";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { nowIso } from "../shared/utils";

export type LaneOrchestratorServiceDeps = {
  projectRoot: string;
  adeDir?: string;
  transcriptsDir: string;
  createSession: (args: AgentChatCreateArgs) => Promise<AgentChatSession>;
  sendMessage: (args: AgentChatSendArgs, options?: { awaitDispatch?: boolean }) => Promise<void>;
  updateSessionTitle: (args: { sessionId: string; title: string }) => Promise<void> | void;
  getLeadSession?: (leadSessionId: string) => Pick<AgentChatSession, "provider" | "model" | "modelId"> | null;
};

const DEFAULT_WORKER_SUMMARY_LINES = 40;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeWorkerStatus(value: unknown): LaneOrchestratorWorkerStatus {
  if (
    value === "spawning"
    || value === "active"
    || value === "idle"
    || value === "completed"
    || value === "failed"
  ) {
    return value;
  }
  return "active";
}

function normalizePhase(value: unknown): LaneOrchestratorPhase {
  if (value === "planning" || value === "executing" || value === "validating" || value === "complete") {
    return value;
  }
  return "planning";
}

function normalizeRole(value: unknown): OrchestratorRole | undefined {
  if (value === "lead" || value === "worker") return value;
  return undefined;
}

function normalizeWorker(value: unknown): LaneOrchestratorWorker | null {
  if (!isPlainRecord(value)) return null;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!sessionId || !title) return null;
  return {
    sessionId,
    title,
    ...(normalizeRole(value.role) ? { role: normalizeRole(value.role) } : {}),
    status: normalizeWorkerStatus(value.status),
    createdAt: typeof value.createdAt === "string" && value.createdAt.trim().length
      ? value.createdAt.trim()
      : nowIso(),
  };
}

function normalizeState(raw: unknown, fallbackLeadSessionId: string): LaneOrchestratorState | null {
  if (!isPlainRecord(raw)) return null;
  const leadSessionId = typeof raw.leadSessionId === "string" && raw.leadSessionId.trim().length
    ? raw.leadSessionId.trim()
    : fallbackLeadSessionId;
  const laneId = typeof raw.laneId === "string" ? raw.laneId.trim() : "";
  if (!laneId) return null;
  const timestamp = nowIso();
  const workers = Array.isArray(raw.workers)
    ? raw.workers.flatMap((entry) => {
        const worker = normalizeWorker(entry);
        return worker ? [worker] : [];
      })
    : [];
  return {
    id: typeof raw.id === "string" && raw.id.trim().length ? raw.id.trim() : randomUUID(),
    laneId,
    leadSessionId,
    phase: normalizePhase(raw.phase),
    ...(typeof raw.planMarkdown === "string" && raw.planMarkdown.trim().length
      ? { planMarkdown: raw.planMarkdown }
      : {}),
    workers,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt.trim().length ? raw.createdAt.trim() : timestamp,
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.trim().length ? raw.updatedAt.trim() : timestamp,
  };
}

export function createLaneOrchestratorService(deps: LaneOrchestratorServiceDeps) {
  const adeDir = deps.adeDir ?? path.join(deps.projectRoot, ".ade");
  const storageDir = path.join(adeDir, "lane-orchestrators");

  const statePathFor = (leadSessionId: string): string =>
    path.join(storageDir, `${leadSessionId.trim()}.json`);

  const readStateFile = (leadSessionId: string): LaneOrchestratorState | null => {
    const trimmed = leadSessionId.trim();
    if (!trimmed.length) return null;
    const filePath = statePathFor(trimmed);
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      return normalizeState(parsed, trimmed);
    } catch {
      return null;
    }
  };

  const writeStateFile = (state: LaneOrchestratorState): LaneOrchestratorState => {
    fs.mkdirSync(storageDir, { recursive: true });
    const timestamp = nowIso();
    const next: LaneOrchestratorState = {
      ...state,
      updatedAt: timestamp,
    };
    fs.writeFileSync(statePathFor(state.leadSessionId), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  };

  const getState = (leadSessionId: string): LaneOrchestratorState | null =>
    readStateFile(leadSessionId);

  const saveState = (state: LaneOrchestratorState): LaneOrchestratorState =>
    writeStateFile(state);

  const ensureRun = (args: { leadSessionId: string; laneId: string }): LaneOrchestratorState => {
    const leadSessionId = args.leadSessionId.trim();
    const laneId = args.laneId.trim();
    const existing = readStateFile(leadSessionId);
    if (existing) return existing;
    const timestamp = nowIso();
    const created: LaneOrchestratorState = {
      id: randomUUID(),
      laneId,
      leadSessionId,
      phase: "planning",
      workers: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return writeStateFile(created);
  };

  const mutateState = (
    leadSessionId: string,
    mutator: (state: LaneOrchestratorState) => LaneOrchestratorState,
  ): LaneOrchestratorState => {
    const existing = readStateFile(leadSessionId);
    if (!existing) {
      throw new Error(`Lane orchestrator run not found for lead session ${leadSessionId}`);
    }
    return writeStateFile(mutator(existing));
  };

  const registerWorker = (args: {
    leadSessionId: string;
    sessionId: string;
    title: string;
    role?: OrchestratorRole;
    status?: LaneOrchestratorWorkerStatus;
  }): LaneOrchestratorWorker => {
    const worker: LaneOrchestratorWorker = {
      sessionId: args.sessionId.trim(),
      title: args.title.trim(),
      ...(args.role ? { role: args.role } : {}),
      status: args.status ?? "spawning",
      createdAt: nowIso(),
    };
    mutateState(args.leadSessionId, (state) => ({
      ...state,
      workers: [
        ...state.workers.filter((entry) => entry.sessionId !== worker.sessionId),
        worker,
      ],
    }));
    return worker;
  };

  const updateWorkerStatus = (args: {
    leadSessionId: string;
    workerSessionId: string;
    status: LaneOrchestratorWorkerStatus;
  }): LaneOrchestratorWorker | null => {
    let updated: LaneOrchestratorWorker | null = null;
    mutateState(args.leadSessionId, (state) => ({
      ...state,
      workers: state.workers.map((worker) => {
        if (worker.sessionId !== args.workerSessionId.trim()) return worker;
        updated = { ...worker, status: args.status };
        return updated;
      }),
    }));
    return updated;
  };

  const listWorkers = (leadSessionId: string): LaneOrchestratorWorker[] =>
    readStateFile(leadSessionId)?.workers ?? [];

  const setPhase = (args: { leadSessionId: string; phase: LaneOrchestratorPhase }): LaneOrchestratorState =>
    mutateState(args.leadSessionId, (state) => ({ ...state, phase: args.phase }));

  const setPlanMarkdown = (args: { leadSessionId: string; planMarkdown: string }): LaneOrchestratorState =>
    mutateState(args.leadSessionId, (state) => ({
      ...state,
      planMarkdown: args.planMarkdown,
    }));

  const spawnWorker = async (args: {
    leadSessionId: string;
    laneId: string;
    title: string;
    role?: OrchestratorRole;
    initialPrompt?: string;
    modelId?: string;
    provider?: AgentChatProvider;
  }): Promise<LaneOrchestratorWorker> => {
    const leadSessionId = args.leadSessionId.trim();
    const laneId = args.laneId.trim();
    ensureRun({ leadSessionId, laneId });
    const leadSession = deps.getLeadSession?.(leadSessionId) ?? null;
    const provider = args.provider ?? leadSession?.provider ?? "claude";
    const model = leadSession?.model ?? "claude-sonnet-4-20250514";
    const session = await deps.createSession({
      laneId,
      provider,
      model,
      ...(args.modelId ?? leadSession?.modelId ? { modelId: args.modelId ?? leadSession?.modelId } : {}),
      title: args.title,
      sessionProfile: "orchestrator-worker",
      orchestratorRole: args.role ?? "worker",
      orchestratorLeadSessionId: leadSessionId,
      permissionMode: "edit",
      interactionMode: "default",
    });
    await deps.updateSessionTitle({ sessionId: session.id, title: args.title });
    const worker = registerWorker({
      leadSessionId,
      sessionId: session.id,
      title: args.title,
      role: args.role ?? "worker",
      status: "spawning",
    });
    if (typeof args.initialPrompt === "string" && args.initialPrompt.trim().length) {
      await deps.sendMessage({
        sessionId: session.id,
        text: args.initialPrompt.trim(),
      }, { awaitDispatch: true });
      updateWorkerStatus({
        leadSessionId,
        workerSessionId: session.id,
        status: "active",
      });
    } else {
      updateWorkerStatus({
        leadSessionId,
        workerSessionId: session.id,
        status: "active",
      });
    }
    return worker;
  };

  const messageWorker = async (args: {
    leadSessionId: string;
    workerSessionId: string;
    text: string;
  }): Promise<void> => {
    const text = args.text.trim();
    if (!text.length) {
      throw new Error("Worker message text is required");
    }
    const state = readStateFile(args.leadSessionId);
    const worker = state?.workers.find((entry) => entry.sessionId === args.workerSessionId.trim());
    if (!worker) {
      throw new Error(`Worker session ${args.workerSessionId} is not registered with lead ${args.leadSessionId}`);
    }
    await deps.sendMessage({
      sessionId: worker.sessionId,
      text,
    }, { awaitDispatch: true });
    updateWorkerStatus({
      leadSessionId: args.leadSessionId,
      workerSessionId: worker.sessionId,
      status: "active",
    });
  };

  const getWorkerSummary = (args: {
    workerSessionId: string;
    lineCount?: number;
  }): string => {
    const workerSessionId = args.workerSessionId.trim();
    const lineCount = Math.max(1, Math.min(args.lineCount ?? DEFAULT_WORKER_SUMMARY_LINES, 200));
    const transcriptPath = path.join(deps.transcriptsDir, `${workerSessionId}.chat.jsonl`);
    if (!fs.existsSync(transcriptPath)) return "";
    try {
      const raw = fs.readFileSync(transcriptPath, "utf8");
      const lines = parseAgentChatTranscript(raw)
        .filter((entry) => entry.sessionId === workerSessionId)
        .flatMap((entry) => {
          if (entry.event.type === "user_message") {
            const text = entry.event.text.trim();
            return text.length ? [`User: ${text}`] : [];
          }
          if (entry.event.type === "text") {
            const text = entry.event.text.trim();
            return text.length ? [`Assistant: ${text}`] : [];
          }
          if (entry.event.type === "tool_call") {
            const tool = typeof entry.event.tool === "string" ? entry.event.tool.trim() : "tool";
            return [`Tool: ${tool}`];
          }
          if (entry.event.type === "tool_result") {
            const tool = typeof entry.event.tool === "string" ? entry.event.tool.trim() : "tool";
            return [`Tool result (${tool})`];
          }
          return [];
        });
      return lines.slice(-lineCount).join("\n");
    } catch {
      return "";
    }
  };

  return {
    getState,
    saveState,
    ensureRun,
    registerWorker,
    updateWorkerStatus,
    listWorkers,
    setPhase,
    setPlanMarkdown,
    spawnWorker,
    messageWorker,
    getWorkerSummary,
  };
}

export type LaneOrchestratorService = ReturnType<typeof createLaneOrchestratorService>;
