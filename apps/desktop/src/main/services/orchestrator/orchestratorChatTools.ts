import { z } from "zod";
import type { LaneOrchestratorService } from "./laneOrchestratorService";

const orchestratorRoleSchema = z.enum(["lead", "worker"]);

const spawnWorkerChatSchema = z.object({
  title: z.string().min(1),
  role: orchestratorRoleSchema.optional(),
  initialPrompt: z.string().optional(),
  modelId: z.string().optional(),
  provider: z.string().optional(),
});

const listWorkersSchema = z.object({}).optional();

const messageWorkerSchema = z.object({
  workerSessionId: z.string().min(1),
  text: z.string().min(1),
});

const readWorkerStatusSchema = z.object({
  workerSessionId: z.string().min(1),
  lineCount: z.number().int().positive().max(200).optional(),
});

const updatePlanSchema = z.object({
  planMarkdown: z.string().min(1),
  phase: z.enum(["planning", "executing", "validating", "complete"]).optional(),
});

export type OrchestratorChatToolHandlers = ReturnType<typeof createOrchestratorChatToolHandlers>;

export function createOrchestratorChatToolHandlers(deps: {
  laneOrchestratorService: LaneOrchestratorService;
  leadSessionId: string;
  laneId: string;
}) {
  const { laneOrchestratorService, leadSessionId, laneId } = deps;

  return {
    async spawn_worker_chat(input: unknown) {
      const parsed = spawnWorkerChatSchema.parse(input ?? {});
      const worker = await laneOrchestratorService.spawnWorker({
        leadSessionId,
        laneId,
        title: parsed.title,
        ...(parsed.role ? { role: parsed.role } : {}),
        ...(parsed.initialPrompt ? { initialPrompt: parsed.initialPrompt } : {}),
        ...(parsed.modelId ? { modelId: parsed.modelId } : {}),
        ...(parsed.provider ? { provider: parsed.provider as never } : {}),
      });
      return { success: true, worker };
    },

    async list_workers(input: unknown) {
      listWorkersSchema.parse(input ?? {});
      const state = laneOrchestratorService.getState(leadSessionId);
      return {
        success: true,
        phase: state?.phase ?? "planning",
        workers: laneOrchestratorService.listWorkers(leadSessionId),
        planMarkdown: state?.planMarkdown ?? null,
      };
    },

    async message_worker(input: unknown) {
      const parsed = messageWorkerSchema.parse(input);
      await laneOrchestratorService.messageWorker({
        leadSessionId,
        workerSessionId: parsed.workerSessionId,
        text: parsed.text,
      });
      return { success: true };
    },

    async read_worker_status(input: unknown) {
      const parsed = readWorkerStatusSchema.parse(input);
      const worker = laneOrchestratorService.listWorkers(leadSessionId)
        .find((entry) => entry.sessionId === parsed.workerSessionId);
      if (!worker) {
        return {
          success: false,
          error: `Worker ${parsed.workerSessionId} is not registered with this orchestrator run`,
        };
      }
      const summary = laneOrchestratorService.getWorkerSummary({
        workerSessionId: parsed.workerSessionId,
        ...(parsed.lineCount ? { lineCount: parsed.lineCount } : {}),
      });
      return {
        success: true,
        worker,
        summary,
      };
    },

    async update_plan(input: unknown) {
      const parsed = updatePlanSchema.parse(input);
      const state = laneOrchestratorService.setPlanMarkdown({
        leadSessionId,
        planMarkdown: parsed.planMarkdown,
      });
      if (parsed.phase) {
        laneOrchestratorService.setPhase({ leadSessionId, phase: parsed.phase });
      }
      return {
        success: true,
        phase: parsed.phase ?? state.phase,
        planMarkdown: state.planMarkdown ?? parsed.planMarkdown,
      };
    },
  };
}

export const ORCHESTRATOR_CHAT_TOOL_NAMES = [
  "spawn_worker_chat",
  "list_workers",
  "message_worker",
  "read_worker_status",
  "update_plan",
] as const;

export type OrchestratorChatToolName = typeof ORCHESTRATOR_CHAT_TOOL_NAMES[number];

export function parseOrchestratorControlPayload(
  kind: string,
  payload: Record<string, unknown>,
): { tool: OrchestratorChatToolName; input: unknown } | null {
  switch (kind) {
    case "orchestrator_spawn_worker":
      return {
        tool: "spawn_worker_chat",
        input: {
          title: payload.title,
          role: payload.role,
          initialPrompt: payload.initialPrompt ?? payload.prompt,
          modelId: payload.modelId,
          provider: payload.provider,
        },
      };
    case "orchestrator_list_workers":
      return { tool: "list_workers", input: {} };
    case "orchestrator_message_worker":
      return {
        tool: "message_worker",
        input: {
          workerSessionId: payload.workerSessionId ?? payload.sessionId,
          text: payload.text ?? payload.message,
        },
      };
    case "orchestrator_read_worker_status":
      return {
        tool: "read_worker_status",
        input: {
          workerSessionId: payload.workerSessionId ?? payload.sessionId,
          lineCount: payload.lineCount,
        },
      };
    case "orchestrator_update_plan":
      return {
        tool: "update_plan",
        input: {
          planMarkdown: payload.planMarkdown ?? payload.plan,
          phase: payload.phase,
        },
      };
    default:
      return null;
  }
}
