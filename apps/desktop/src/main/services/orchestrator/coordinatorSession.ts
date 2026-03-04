/**
 * coordinatorSession.ts
 *
 * Coordinator session lifecycle: start, send events, dispatch actions,
 * trigger evaluations, thinking loop, and end.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import type {
  OrchestratorContext,
  CoordinatorSessionEntry,
  OrchestratorChatMessage,
} from "./orchestratorContext";
import {
  nowIso,
} from "./orchestratorContext";
import type {
  ModelConfig,
} from "../../../shared/types";
import {
  modelConfigToServiceModel,
  thinkingLevelToReasoningEffort,
} from "../../../shared/modelProfiles";

const DEFAULT_COORDINATOR_MODEL_CONFIG: ModelConfig = {
  modelId: "anthropic/claude-sonnet-4-6",
  provider: "anthropic",
  thinkingLevel: "high",
};

// ── Coordinator Prompt Templates ─────────────────────────────────

export const PM_SYSTEM_PREAMBLE = [
  "You are a highly experienced PM/coordinator for a software engineering mission.",
  "You observe runtime events from worker agents and make real-time decisions.",
  "",
  "Available actions (one per line):",
  "  steer <stepKey> <message>       — deliver instruction to a running worker (or queue for non-running)",
  "  skip <stepKey> <reason>         — skip a step that isn't needed",
  "  add_step <after_stepKey> <title> | <instructions> — insert a new step",
  "  broadcast <message>             — message all workers",
  "  escalate <reason>               — flag for human intervention",
  "  pause <reason>                  — pause mission for human review",
  "  parallelize <stepKey> remove_dep <depStepKey> — remove a dependency to allow parallel execution",
  "  consolidate <keepKey> <removeKey> | <merged_instructions> — merge two steps",
  "  shutdown <stepKey> <reason>     — graceful worker shutdown",
  "  acknowledged                    — no action needed",
  "",
  "Be decisive and maximize parallelism. You are a PM — direct, proactive, autonomous."
];

export function buildCoordinatorSystemPrompt(args: { planSummary: string }): string {
  return [
    ...PM_SYSTEM_PREAMBLE,
    "",
    "Current mission plan:",
    args.planSummary,
    "",
    "Respond ONLY with action commands or 'acknowledged'. Do not use any other format."
  ].join("\n");
}

export function buildCoordinatorInitPrompt(stepCount: number): string {
  return [
    `Coordinator session started. Monitoring mission with ${stepCount} steps.`,
    "You will receive runtime events about step completions, failures, and blocks.",
    "Review each event and decide whether to act or acknowledge.",
    "Focus on maximizing parallelism and unblocking workers.",
    "",
    "Respond with 'acknowledged' to confirm you're online."
  ].join("\n");
}

const COORDINATOR_EVAL_DEBOUNCE_MS = 500;

// ── Coordinator Session Functions ────────────────────────────────

export async function startCoordinatorSession(
  ctx: OrchestratorContext,
  missionId: string,
  runId: string,
  plan: { steps: Array<{ stepKey: string; title: string; status: string; dependencyStepIds: string[] }> },
  coordinatorModelConfig?: ModelConfig | null,
  deps?: {
    emitOrchestratorMessage: (missionId: string, content: string, stepKey?: string | null, metadata?: Record<string, unknown> | null) => OrchestratorChatMessage;
    resolveOrchestratorModelConfig: (missionId: string, callType: string) => ModelConfig;
    resolveAiDecisionLikeTimeoutMs: (missionId: string) => number | null;
  }
): Promise<string | null> {
  if (!ctx.aiIntegrationService || !ctx.projectRoot) {
    ctx.logger.debug("ai_orchestrator.coordinator_session_skip", {
      missionId,
      reason: !ctx.aiIntegrationService ? "no_ai_integration_service" : "no_project_root"
    });
    return null;
  }

  try {
    const planSummary = plan.steps
      .map((s) => `- ${s.stepKey}: "${s.title}" [${s.status}]${s.dependencyStepIds.length ? ` (deps: ${s.dependencyStepIds.length})` : ""}`)
      .join("\n");
    const coordinatorSystemPrompt = buildCoordinatorSystemPrompt({ planSummary });
    const timeoutMs = deps?.resolveAiDecisionLikeTimeoutMs(missionId) ?? null;

    const resolvedConfig = coordinatorModelConfig ?? deps?.resolveOrchestratorModelConfig(missionId, "coordinator") ?? DEFAULT_COORDINATOR_MODEL_CONFIG;
    const entry: CoordinatorSessionEntry = {
      sessionId: null,
      missionId,
      runId,
      modelConfig: resolvedConfig,
      startedAt: nowIso(),
      eventCount: 0,
      lastEventAt: null,
      dead: false,
      startupGreetingSent: false,
      systemPrompt: coordinatorSystemPrompt,
      pendingInit: null
    };
    ctx.coordinatorSessions.set(runId, entry);

    const initPromise = (async () => {
      try {
        const result = await ctx.aiIntegrationService!.executeTask({
          feature: "orchestrator" as const,
          taskType: "review" as const,
          prompt: buildCoordinatorInitPrompt(plan.steps.length),
          cwd: ctx.projectRoot!,
          model: modelConfigToServiceModel(resolvedConfig),
          systemPrompt: coordinatorSystemPrompt,
          reasoningEffort: thinkingLevelToReasoningEffort(resolvedConfig.thinkingLevel),
          permissionMode: "read-only" as const,
          oneShot: true,
          ...(timeoutMs != null ? { timeoutMs } : {})
        });

        const activeEntry = ctx.coordinatorSessions.get(runId);
        if (activeEntry !== entry || entry.dead) {
          return;
        }

        if (typeof result.sessionId === "string" && result.sessionId.trim().length > 0) {
          entry.sessionId = result.sessionId.trim();
          ctx.logger.info("ai_orchestrator.coordinator_session_started", {
            missionId,
            runId,
            sessionId: entry.sessionId,
            initResponseChars: result.text?.length ?? 0
          });
        } else {
          ctx.logger.warn("ai_orchestrator.coordinator_session_no_session_id", {
            missionId,
            runId,
            reason: "executeTask did not return a sessionId — coordinator will operate in stateless mode"
          });
        }
        if (!entry.startupGreetingSent && deps?.emitOrchestratorMessage) {
          deps.emitOrchestratorMessage(
            missionId,
            "Coordinator online. Monitoring mission events and ready to intervene.",
            null,
            {
              role: "coordinator",
              runId,
              sessionId: entry.sessionId,
              plannerStepCount: plan.steps.length
            }
          );
          entry.startupGreetingSent = true;
        }
      } catch (error) {
        entry.dead = true;
        ctx.logger.warn("ai_orchestrator.coordinator_session_init_failed", {
          missionId,
          runId,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        entry.pendingInit = null;
      }
    })();

    entry.pendingInit = initPromise;
    return runId;
  } catch (error) {
    ctx.logger.warn("ai_orchestrator.coordinator_session_start_failed", {
      missionId,
      runId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

export async function sendCoordinatorEvent(
  ctx: OrchestratorContext,
  runId: string,
  eventMessage: string,
  deps?: {
    resolveAiDecisionLikeTimeoutMs: (missionId: string) => number | null;
    parseAndDispatchCoordinatorActions: (args: { missionId: string; runId: string; responseText: string }) => { executedActions: number; proseLines: string[] };
    emitOrchestratorMessage: (missionId: string, content: string, stepKey?: string | null, metadata?: Record<string, unknown> | null) => OrchestratorChatMessage;
  }
): Promise<void> {
  const session = ctx.coordinatorSessions.get(runId);
  if (!session || session.dead || !ctx.aiIntegrationService || !ctx.projectRoot) return;

  if (session.pendingInit) {
    try {
      await session.pendingInit;
    } catch {
      return;
    }
  }

  if (session.dead) return;

  try {
    session.eventCount++;
    session.lastEventAt = nowIso();
    const timeoutMs = deps?.resolveAiDecisionLikeTimeoutMs(session.missionId) ?? null;

    const result = await ctx.aiIntegrationService.executeTask({
      feature: "orchestrator" as const,
      taskType: "review" as const,
      prompt: eventMessage,
      cwd: ctx.projectRoot,
      model: modelConfigToServiceModel(session.modelConfig),
      systemPrompt: session.systemPrompt,
      reasoningEffort: thinkingLevelToReasoningEffort(session.modelConfig.thinkingLevel),
      permissionMode: "read-only" as const,
      oneShot: true,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      ...(timeoutMs != null ? { timeoutMs } : {})
    });

    if (typeof result.sessionId === "string" && result.sessionId.trim().length > 0) {
      session.sessionId = result.sessionId.trim();
    }

    const responseText = typeof result.text === "string" ? result.text.trim() : "";
    if (responseText.length > 0 && responseText.toLowerCase() !== "acknowledged") {
      if (deps?.parseAndDispatchCoordinatorActions) {
        deps.parseAndDispatchCoordinatorActions({
          missionId: session.missionId,
          runId,
          responseText
        });
      }
    }
  } catch (error) {
    ctx.logger.debug("ai_orchestrator.coordinator_event_failed", {
      runId,
      missionId: session.missionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export function endCoordinatorSession(ctx: OrchestratorContext, runId: string): void {
  const session = ctx.coordinatorSessions.get(runId);
  if (!session) return;
  ctx.coordinatorSessions.delete(runId);
  ctx.logger.info("ai_orchestrator.coordinator_session_ended", {
    runId,
    missionId: session.missionId,
    sessionId: session.sessionId,
    eventCount: session.eventCount,
    durationMs: Date.now() - Date.parse(session.startedAt)
  });
}

export function triggerCoordinatorEvaluation(
  ctx: OrchestratorContext,
  runId: string,
  reason: string,
  deps: {
    runCoordinatorEvaluation: (runId: string, reason: string) => void;
  }
): void {
  if (ctx.disposed.current || !ctx.aiIntegrationService || !ctx.projectRoot) return;

  const existing = ctx.pendingCoordinatorEvals.get(runId);
  if (existing) clearTimeout(existing);

  ctx.pendingCoordinatorEvals.set(runId, setTimeout(() => {
    ctx.pendingCoordinatorEvals.delete(runId);
    deps.runCoordinatorEvaluation(runId, reason);
  }, COORDINATOR_EVAL_DEBOUNCE_MS));
}

export function stopCoordinatorThinkingLoop(ctx: OrchestratorContext, missionId: string): void {
  const timer = ctx.coordinatorThinkingLoops.get(missionId);
  if (timer) {
    clearInterval(timer);
    ctx.coordinatorThinkingLoops.delete(missionId);
  }
}
