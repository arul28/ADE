import { randomUUID } from "node:crypto";
import type { EpisodicMemory } from "../../../shared/types";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { Logger } from "../logging/logger";
import type { UnifiedMemoryService } from "./unifiedMemoryService";

type SummaryOutcome = "success" | "partial" | "failure";

function durationSeconds(startedAt?: string | null, endedAt?: string | null): number {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const end = endedAt ? Date.parse(endedAt) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

function uniqueList(values: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter((value) => value.length > 0))];
}

function normalizeOutcome(value: unknown): SummaryOutcome {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "failure" || text === "partial" || text === "success") return text;
  return "partial";
}

function fallbackEpisode(input: {
  missionId?: string;
  sessionId?: string;
  taskDescription: string;
  approachTaken: string;
  outcome: SummaryOutcome;
  patternsDiscovered?: string[];
  gotchas?: string[];
  decisionsMade?: string[];
  toolsUsed?: string[];
  duration: number;
}): EpisodicMemory {
  return {
    id: randomUUID(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
    taskDescription: input.taskDescription,
    approachTaken: input.approachTaken,
    outcome: input.outcome,
    toolsUsed: uniqueList(input.toolsUsed ?? []),
    patternsDiscovered: uniqueList(input.patternsDiscovered ?? []),
    gotchas: uniqueList(input.gotchas ?? []),
    decisionsMade: uniqueList(input.decisionsMade ?? []),
    duration: Math.max(0, Math.floor(input.duration)),
    createdAt: new Date().toISOString(),
  };
}

function readEpisodeOutput(value: unknown): EpisodicMemory | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const taskDescription = String(row.taskDescription ?? "").trim();
  const approachTaken = String(row.approachTaken ?? "").trim();
  if (!taskDescription || !approachTaken) return null;
  return {
    id: String(row.id ?? randomUUID()),
    ...(typeof row.sessionId === "string" && row.sessionId.trim().length > 0 ? { sessionId: row.sessionId.trim() } : {}),
    ...(typeof row.missionId === "string" && row.missionId.trim().length > 0 ? { missionId: row.missionId.trim() } : {}),
    taskDescription,
    approachTaken,
    outcome: normalizeOutcome(row.outcome),
    toolsUsed: uniqueList(Array.isArray(row.toolsUsed) ? row.toolsUsed.map((entry) => String(entry ?? "")) : []),
    patternsDiscovered: uniqueList(Array.isArray(row.patternsDiscovered) ? row.patternsDiscovered.map((entry) => String(entry ?? "")) : []),
    gotchas: uniqueList(Array.isArray(row.gotchas) ? row.gotchas.map((entry) => String(entry ?? "")) : []),
    decisionsMade: uniqueList(Array.isArray(row.decisionsMade) ? row.decisionsMade.map((entry) => String(entry ?? "")) : []),
    duration: Math.max(0, Math.floor(Number(row.duration ?? 0) || 0)),
    createdAt: typeof row.createdAt === "string" && row.createdAt.trim().length > 0 ? row.createdAt.trim() : new Date().toISOString(),
  };
}

export function createEpisodicSummaryService(args: {
  projectId: string;
  projectRoot: string;
  logger?: Pick<Logger, "warn"> | null;
  enabled?: boolean;
  aiIntegrationService?: Pick<ReturnType<typeof createAiIntegrationService>, "executeTask"> | null;
  memoryService: Pick<UnifiedMemoryService, "addMemory">;
  onEpisodeSaved?: (memoryId: string) => void | Promise<void>;
}) {
  const enabled = args.enabled !== false;
  const enqueue = (job: () => Promise<void>) => {
    if (!enabled) return;
    void job().catch((error) => {
      args.logger?.warn?.("memory.episodic_summary_job_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const generateWithAi = async (prompt: string): Promise<EpisodicMemory | null> => {
    if (!args.aiIntegrationService) return null;
    try {
      const response = await args.aiIntegrationService.executeTask({
        feature: "memory_consolidation",
        taskType: "memory_consolidation",
        cwd: args.projectRoot,
        prompt,
        jsonSchema: {
          type: "object",
          additionalProperties: false,
          required: ["taskDescription", "approachTaken", "outcome", "toolsUsed", "patternsDiscovered", "gotchas", "decisionsMade", "duration"],
          properties: {
            taskDescription: { type: "string", minLength: 1 },
            approachTaken: { type: "string", minLength: 1 },
            outcome: { type: "string", enum: ["success", "partial", "failure"] },
            toolsUsed: { type: "array", items: { type: "string" } },
            patternsDiscovered: { type: "array", items: { type: "string" } },
            gotchas: { type: "array", items: { type: "string" } },
            decisionsMade: { type: "array", items: { type: "string" } },
            duration: { type: "number" },
          },
        },
      });
      return readEpisodeOutput(response.structuredOutput) ?? readEpisodeOutput(response.text);
    } catch (error) {
      args.logger?.warn?.("memory.episodic_summary_ai_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const saveEpisode = async (episode: EpisodicMemory, sourceType: "mission_promotion" | "system", sourceId: string) => {
    const memory = args.memoryService.addMemory({
      projectId: args.projectId,
      scope: "project",
      category: "episode",
      content: JSON.stringify(episode),
      importance: "medium",
      sourceType,
      sourceId,
      ...(episode.missionId ? { sourceRunId: sourceId } : {}),
    });
    await args.onEpisodeSaved?.(memory.id);
    return memory;
  };

  const enqueueMissionSummary = (input: {
    missionId: string;
    runId: string;
    taskDescription: string;
    finalStatus: SummaryOutcome;
    startedAt?: string | null;
    endedAt?: string | null;
    sharedFacts?: string[];
    decisions?: string[];
    gotchas?: string[];
    workerOutputs?: string[];
    toolsUsed?: string[];
  }) => {
    enqueue(async () => {
      const prompt = [
        "Summarize the completed ADE mission as a structured episodic memory.",
        `Mission ID: ${input.missionId}`,
        `Run ID: ${input.runId}`,
        `Task: ${input.taskDescription}`,
        `Outcome: ${input.finalStatus}`,
        `Duration seconds: ${durationSeconds(input.startedAt, input.endedAt)}`,
        "Shared facts:",
        ...uniqueList(input.sharedFacts ?? []).map((entry) => `- ${entry}`),
        "Decisions:",
        ...uniqueList(input.decisions ?? []).map((entry) => `- ${entry}`),
        "Gotchas:",
        ...uniqueList(input.gotchas ?? []).map((entry) => `- ${entry}`),
        "Worker outputs:",
        ...uniqueList(input.workerOutputs ?? []).map((entry) => `- ${entry}`),
      ].join("\n");

      const episode = (await generateWithAi(prompt)) ?? fallbackEpisode({
        missionId: input.missionId,
        taskDescription: input.taskDescription,
        approachTaken: uniqueList(input.workerOutputs ?? []).join(" ") || "Mission completed with recorded worker outputs and mission memory.",
        outcome: input.finalStatus,
        patternsDiscovered: input.sharedFacts ?? [],
        gotchas: input.gotchas ?? [],
        decisionsMade: input.decisions ?? [],
        toolsUsed: input.toolsUsed ?? [],
        duration: durationSeconds(input.startedAt, input.endedAt),
      });
      episode.id = randomUUID();
      episode.missionId = input.missionId;
      await saveEpisode(episode, "mission_promotion", input.runId);
    });
  };

  const enqueueSessionSummary = (input: {
    sessionId: string;
    role: "cto" | "worker";
    summary: string;
    startedAt?: string | null;
    endedAt?: string | null;
    toolsUsed?: string[];
    decisions?: string[];
    gotchas?: string[];
  }) => {
    const decisions = uniqueList(input.decisions ?? []);
    const gotchas = uniqueList(input.gotchas ?? []);
    const toolsUsed = uniqueList(input.toolsUsed ?? []);
    const summary = String(input.summary ?? "").trim();
    const duration = durationSeconds(input.startedAt, input.endedAt);
    const isTrivialSummary =
      duration < 60
      && decisions.length === 0
      && gotchas.length === 0
      && toolsUsed.length === 0
      && /^(session closed|chat completed|cto session ended|worker session ended|session ended|no action taken|completed|done)\.?$/iu.test(summary);

    if (!enabled || isTrivialSummary) {
      return;
    }

    enqueue(async () => {
      const prompt = [
        `Summarize the completed ADE ${input.role} session as a structured episodic memory.`,
        `Session ID: ${input.sessionId}`,
        `Summary: ${summary}`,
        `Duration seconds: ${duration}`,
        "Decisions:",
        ...decisions.map((entry) => `- ${entry}`),
        "Gotchas:",
        ...gotchas.map((entry) => `- ${entry}`),
      ].join("\n");

      const episode = (await generateWithAi(prompt)) ?? fallbackEpisode({
        sessionId: input.sessionId,
        taskDescription: `${input.role.toUpperCase()} session`,
        approachTaken: summary,
        outcome: "partial",
        patternsDiscovered: [],
        gotchas,
        decisionsMade: decisions,
        toolsUsed,
        duration,
      });
      episode.id = randomUUID();
      episode.sessionId = input.sessionId;
      await saveEpisode(episode, "system", input.sessionId);
    });
  };

  return {
    enqueueMissionSummary,
    enqueueSessionSummary,
  };
}

export type EpisodicSummaryService = ReturnType<typeof createEpisodicSummaryService>;
