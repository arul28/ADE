// ---------------------------------------------------------------------------
// Coordinator Tool Set — 13 Vercel AI SDK tools wrapping orchestratorService
// primitives for the unified coordinator agent.
// ---------------------------------------------------------------------------

import { tool, type Tool } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { createOrchestratorService } from "./orchestratorService";
import type {
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorAttempt,
  DagMutationEvent,
  FanOutDecision,
} from "../../../shared/types";
import {
  enqueuePendingMessage,
  type PendingMessage,
} from "../ai/unifiedExecutor";
import type { Logger } from "../logging/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveStep(
  graph: OrchestratorRunGraph,
  stepKey: string,
): OrchestratorStep | null {
  return graph.steps.find((s) => s.stepKey === stepKey) ?? null;
}

function findRunningAttempt(
  graph: OrchestratorRunGraph,
  stepId: string,
): OrchestratorAttempt | null {
  return (
    graph.attempts.find(
      (a) => a.stepId === stepId && a.status === "running",
    ) ?? null
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCoordinatorToolSet(deps: {
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  runId: string;
  missionId: string;
  logger: Logger;
  onDagMutation: (event: DagMutationEvent) => void;
}): Record<string, Tool> {
  const { orchestratorService, runId, missionId, logger, onDagMutation } = deps;

  /** Shorthand to get a fresh graph snapshot. */
  function graph(): OrchestratorRunGraph {
    return orchestratorService.getRunGraph({ runId });
  }

  // ─── Tool definitions ──────────────────────────────────────────

  const spawn_agent = tool({
    description:
      "Start the agent for a ready step. Triggers autopilot attempt dispatch.",
    inputSchema: z.object({
      stepKey: z.string().describe("The step key to spawn an agent for"),
      reason: z.string().optional().describe("Optional reason for spawning"),
    }),
    execute: async ({ stepKey, reason }) => {
      try {
        const g = graph();
        const step = resolveStep(g, stepKey);
        if (!step)
          return { ok: false, error: `Step not found: ${stepKey}` };
        if (step.status !== "ready")
          return {
            ok: false,
            error: `Step '${stepKey}' is not ready (status: ${step.status})`,
          };
        const started = await orchestratorService.startReadyAutopilotAttempts({
          runId,
          reason: reason ?? "coordinator_spawn",
        });
        logger.info("coordinator.spawn_agent", { stepKey, started });
        return { ok: true, stepKey, attemptStarted: started > 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.spawn_agent.error", { stepKey, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const stop_agent = tool({
    description:
      "Stop a running agent by marking its attempt as canceled.",
    inputSchema: z.object({
      stepKey: z.string().describe("Step key whose agent to stop"),
      reason: z.string().describe("Reason for stopping the agent"),
    }),
    execute: async ({ stepKey, reason }) => {
      try {
        const g = graph();
        const step = resolveStep(g, stepKey);
        if (!step)
          return { ok: false, error: `Step not found: ${stepKey}` };
        const attempt = findRunningAttempt(g, step.id);
        if (!attempt)
          return {
            ok: false,
            error: `No running attempt found for step '${stepKey}'`,
          };
        orchestratorService.completeAttempt({
          attemptId: attempt.id,
          status: "canceled",
          errorClass: "canceled",
          errorMessage: reason,
        });
        logger.info("coordinator.stop_agent", {
          stepKey,
          attemptId: attempt.id,
          reason,
        });
        return { ok: true, stepKey, attemptId: attempt.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.stop_agent.error", { stepKey, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const steer_agent = tool({
    description:
      "Send a steering message to a running agent via its pending message queue.",
    inputSchema: z.object({
      stepKey: z.string().describe("Step key of the agent to steer"),
      message: z.string().describe("The steering message content"),
      priority: z
        .enum(["normal", "urgent"])
        .default("normal")
        .describe("Message priority"),
    }),
    execute: async ({ stepKey, message, priority }) => {
      try {
        const g = graph();
        const step = resolveStep(g, stepKey);
        if (!step)
          return { ok: false, error: `Step not found: ${stepKey}` };
        const attempt = findRunningAttempt(g, step.id);
        if (!attempt)
          return {
            ok: false,
            error: `No running attempt found for step '${stepKey}'`,
          };
        const sessionId = attempt.executorSessionId;
        if (!sessionId)
          return {
            ok: false,
            error: `No session ID for running attempt on step '${stepKey}'`,
          };
        const pending: PendingMessage = {
          id: randomUUID(),
          content: message,
          fromAttemptId: null,
          priority,
          receivedAt: nowIso(),
        };
        enqueuePendingMessage(sessionId, pending);
        orchestratorService.appendRuntimeEvent({
          runId,
          stepId: step.id,
          attemptId: attempt.id,
          sessionId,
          eventType: "coordinator_steering",
          payload: { message, priority },
        });
        logger.info("coordinator.steer_agent", { stepKey, sessionId, priority });
        return { ok: true, stepKey, sessionId, messageId: pending.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.steer_agent.error", {
          stepKey,
          error: msg,
        });
        return { ok: false, error: msg };
      }
    },
  });

  const add_step = tool({
    description:
      "Add a new step to the mission DAG at runtime.",
    inputSchema: z.object({
      stepKey: z.string().describe("Unique key for the new step"),
      title: z.string().describe("Human-readable title"),
      instructions: z.string().describe("Instructions for the agent"),
      dependsOn: z
        .array(z.string())
        .default([])
        .describe("Step keys this step depends on"),
      executorKind: z
        .string()
        .default("unified")
        .describe("Executor kind (e.g. unified, claude, codex)"),
    }),
    execute: async ({ stepKey, title, instructions, dependsOn, executorKind }) => {
      try {
        const g = graph();
        const maxIndex = g.steps.reduce(
          (max, s) => Math.max(max, s.stepIndex),
          -1,
        );
        const created = orchestratorService.addSteps({
          runId,
          steps: [
            {
              stepKey,
              title,
              stepIndex: maxIndex + 1,
              dependencyStepKeys: dependsOn,
              executorKind,
              metadata: { instructions },
            },
          ],
        });
        const newStep = created[0];
        if (newStep) {
          onDagMutation({
            runId,
            mutation: { type: "step_added", step: newStep },
            timestamp: nowIso(),
            source: "coordinator",
          });
        }
        logger.info("coordinator.add_step", { stepKey, title });
        return {
          ok: true,
          stepKey,
          stepId: newStep?.id ?? null,
          status: newStep?.status ?? "unknown",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.add_step.error", { stepKey, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const skip_step = tool({
    description:
      "Skip a step in the DAG so downstream steps become unblocked.",
    inputSchema: z.object({
      stepKey: z.string().describe("Step key to skip"),
      reason: z.string().describe("Reason for skipping"),
    }),
    execute: async ({ stepKey, reason }) => {
      try {
        const g = graph();
        const step = resolveStep(g, stepKey);
        if (!step)
          return { ok: false, error: `Step not found: ${stepKey}` };
        orchestratorService.skipStep({
          runId,
          stepId: step.id,
          reason,
        });
        onDagMutation({
          runId,
          mutation: { type: "step_skipped", stepKey, reason },
          timestamp: nowIso(),
          source: "coordinator",
        });
        logger.info("coordinator.skip_step", { stepKey, reason });
        return { ok: true, stepKey };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.skip_step.error", { stepKey, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const merge_steps = tool({
    description:
      "Merge two steps into one by consolidating the remove step into the keep step.",
    inputSchema: z.object({
      keepStepKey: z.string().describe("Step key to keep"),
      removeStepKey: z.string().describe("Step key to remove (will be skipped)"),
      mergedInstructions: z
        .string()
        .describe("Combined instructions for the merged step"),
    }),
    execute: async ({ keepStepKey, removeStepKey, mergedInstructions }) => {
      try {
        const g = graph();
        const keepStep = resolveStep(g, keepStepKey);
        const removeStep = resolveStep(g, removeStepKey);
        if (!keepStep)
          return { ok: false, error: `Keep step not found: ${keepStepKey}` };
        if (!removeStep)
          return {
            ok: false,
            error: `Remove step not found: ${removeStepKey}`,
          };
        const merged = orchestratorService.consolidateSteps({
          runId,
          keepStepId: keepStep.id,
          removeStepId: removeStep.id,
          mergedInstructions,
        });
        onDagMutation({
          runId,
          mutation: {
            type: "steps_merged",
            sourceKeys: [keepStepKey, removeStepKey],
            targetStep: merged,
          },
          timestamp: nowIso(),
          source: "coordinator",
        });
        logger.info("coordinator.merge_steps", {
          keepStepKey,
          removeStepKey,
        });
        return { ok: true, mergedStepKey: merged.stepKey, mergedStepId: merged.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.merge_steps.error", {
          keepStepKey,
          removeStepKey,
          error: msg,
        });
        return { ok: false, error: msg };
      }
    },
  });

  const split_step = tool({
    description:
      "Split a step into multiple parallel subtasks using fan-out.",
    inputSchema: z.object({
      stepKey: z.string().describe("Step key to split"),
      subtasks: z
        .array(
          z.object({
            title: z.string(),
            instructions: z.string(),
            files: z.array(z.string()).default([]),
          }),
        )
        .describe("Subtasks to create from the split"),
    }),
    execute: async ({ stepKey, subtasks }) => {
      try {
        const decision: FanOutDecision = {
          strategy: "external_parallel",
          subtasks: subtasks.map((st) => ({
            ...st,
            complexity: "moderate" as const,
          })),
          reasoning: `Coordinator split step '${stepKey}' into ${subtasks.length} subtasks`,
        };
        const children = orchestratorService.executeFanOutExternal({
          runId,
          parentStepKey: stepKey,
          decision,
        });
        onDagMutation({
          runId,
          mutation: {
            type: "step_split",
            sourceKey: stepKey,
            children,
          },
          timestamp: nowIso(),
          source: "coordinator",
        });
        logger.info("coordinator.split_step", {
          stepKey,
          childCount: children.length,
        });
        return {
          ok: true,
          stepKey,
          children: children.map((c) => ({
            stepKey: c.stepKey,
            stepId: c.id,
            title: c.title,
          })),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.split_step.error", {
          stepKey,
          error: msg,
        });
        return { ok: false, error: msg };
      }
    },
  });

  const reorder_steps = tool({
    description:
      "Change the dependency list for a step, effectively reordering the DAG.",
    inputSchema: z.object({
      stepKey: z.string().describe("Step key to update"),
      newDependsOn: z
        .array(z.string())
        .describe("New list of dependency step keys"),
    }),
    execute: async ({ stepKey, newDependsOn }) => {
      try {
        const g = graph();
        const step = resolveStep(g, stepKey);
        if (!step)
          return { ok: false, error: `Step not found: ${stepKey}` };
        orchestratorService.updateStepDependencies({
          runId,
          stepId: step.id,
          dependencyStepKeys: newDependsOn,
        });
        onDagMutation({
          runId,
          mutation: {
            type: "dependency_changed",
            stepKey,
            newDeps: newDependsOn,
          },
          timestamp: nowIso(),
          source: "coordinator",
        });
        logger.info("coordinator.reorder_steps", { stepKey, newDependsOn });
        return { ok: true, stepKey, newDependsOn };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.reorder_steps.error", {
          stepKey,
          error: msg,
        });
        return { ok: false, error: msg };
      }
    },
  });

  const send_message = tool({
    description:
      "Send a message to a specific running agent.",
    inputSchema: z.object({
      stepKey: z.string().describe("Step key of the target agent"),
      content: z.string().describe("Message content"),
    }),
    execute: async ({ stepKey, content }) => {
      try {
        const g = graph();
        const step = resolveStep(g, stepKey);
        if (!step)
          return { ok: false, error: `Step not found: ${stepKey}` };
        const attempt = findRunningAttempt(g, step.id);
        if (!attempt)
          return {
            ok: false,
            error: `No running attempt found for step '${stepKey}'`,
          };
        const sessionId = attempt.executorSessionId;
        if (!sessionId)
          return {
            ok: false,
            error: `No session ID for running attempt on step '${stepKey}'`,
          };
        const pending: PendingMessage = {
          id: randomUUID(),
          content,
          fromAttemptId: null,
          priority: "normal",
          receivedAt: nowIso(),
        };
        enqueuePendingMessage(sessionId, pending);
        logger.info("coordinator.send_message", { stepKey, sessionId });
        return { ok: true, stepKey, sessionId, messageId: pending.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.send_message.error", {
          stepKey,
          error: msg,
        });
        return { ok: false, error: msg };
      }
    },
  });

  const broadcast = tool({
    description:
      "Broadcast a message to all currently running agents.",
    inputSchema: z.object({
      content: z.string().describe("Message content to broadcast"),
    }),
    execute: async ({ content }) => {
      try {
        const g = graph();
        const runningAttempts = g.attempts.filter(
          (a) => a.status === "running" && a.executorSessionId,
        );
        let delivered = 0;
        for (const attempt of runningAttempts) {
          if (!attempt.executorSessionId) continue;
          const pending: PendingMessage = {
            id: randomUUID(),
            content,
            fromAttemptId: null,
            priority: "normal",
            receivedAt: nowIso(),
          };
          enqueuePendingMessage(attempt.executorSessionId, pending);
          delivered++;
        }
        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "coordinator_broadcast",
          payload: { content, recipientCount: delivered },
        });
        logger.info("coordinator.broadcast", { delivered });
        return { ok: true, delivered };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.broadcast.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const ask_user = tool({
    description:
      "Escalate a question to the human operator and create an intervention.",
    inputSchema: z.object({
      question: z.string().describe("The question to ask the user"),
      context: z
        .string()
        .optional()
        .describe("Additional context for the question"),
    }),
    execute: async ({ question, context }) => {
      try {
        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "intervention_opened",
          payload: { question, context: context ?? null, missionId },
        });
        const interventionId = randomUUID();
        logger.info("coordinator.ask_user", { question, interventionId });
        return { ok: true, interventionId, question };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.ask_user.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const get_run_state = tool({
    description:
      "Get a concise summary of the current DAG state including step statuses and progress.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const g = graph();
        const total = g.steps.length;
        const byStatus: Record<string, number> = {};
        for (const step of g.steps) {
          byStatus[step.status] = (byStatus[step.status] ?? 0) + 1;
        }
        const terminal = (byStatus.succeeded ?? 0) + (byStatus.failed ?? 0) + (byStatus.skipped ?? 0) + (byStatus.canceled ?? 0);
        const progressPct = total > 0 ? Math.round((terminal / total) * 100) : 0;
        const steps = g.steps.map((s) => {
          const attempt = findRunningAttempt(g, s.id);
          return {
            stepKey: s.stepKey,
            title: s.title,
            status: s.status,
            retryCount: s.retryCount,
            retryLimit: s.retryLimit,
            hasRunningAttempt: !!attempt,
            sessionId: attempt?.executorSessionId ?? null,
          };
        });
        return {
          ok: true,
          runId,
          runStatus: g.run.status,
          progressPct,
          total,
          byStatus,
          steps,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.get_run_state.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const get_agent_output = tool({
    description:
      "Retrieve the output/result from a completed agent step.",
    inputSchema: z.object({
      stepKey: z.string().describe("Step key to get output for"),
    }),
    execute: async ({ stepKey }) => {
      try {
        const g = graph();
        const step = resolveStep(g, stepKey);
        if (!step)
          return { ok: false, error: `Step not found: ${stepKey}` };
        // Find the latest completed attempt (succeeded or failed)
        const completedAttempts = g.attempts
          .filter(
            (a) =>
              a.stepId === step.id &&
              (a.status === "succeeded" || a.status === "failed"),
          )
          .sort((a, b) => {
            const at = a.completedAt ?? a.createdAt;
            const bt = b.completedAt ?? b.createdAt;
            return bt.localeCompare(at);
          });
        const latest = completedAttempts[0];
        if (!latest)
          return {
            ok: false,
            error: `No completed attempt found for step '${stepKey}'`,
          };
        return {
          ok: true,
          stepKey,
          attemptId: latest.id,
          status: latest.status,
          summary: latest.resultEnvelope?.summary ?? null,
          success: latest.resultEnvelope?.success ?? null,
          warnings: latest.resultEnvelope?.warnings ?? [],
          errorMessage: latest.errorMessage ?? null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.get_agent_output.error", {
          stepKey,
          error: msg,
        });
        return { ok: false, error: msg };
      }
    },
  });

  return {
    spawn_agent,
    stop_agent,
    steer_agent,
    add_step,
    skip_step,
    merge_steps,
    split_step,
    reorder_steps,
    send_message,
    broadcast,
    ask_user,
    get_run_state,
    get_agent_output,
  };
}
