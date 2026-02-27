// ---------------------------------------------------------------------------
// Coordinator Tool Set — AI-first tools for the orchestrator brain.
// Each tool is a thin wrapper around persistence + worker spawning.
// The AI decides everything; tools just execute its decisions.
// ---------------------------------------------------------------------------

import { tool, type Tool } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { createOrchestratorService } from "./orchestratorService";
import type {
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorAttempt,
  DagMutationEvent,
} from "../../../shared/types";
import {
  enqueuePendingMessage,
  type PendingMessage,
} from "../ai/unifiedExecutor";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";

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
  db: AdeDb;
  projectRoot: string;
  onDagMutation: (event: DagMutationEvent) => void;
  onRunFinalize?: (args: { runId: string; succeeded: boolean; summary?: string; reason?: string }) => void;
}): Record<string, Tool> {
  const { orchestratorService, runId, missionId, logger, db, projectRoot, onDagMutation } = deps;

  /** Shorthand to get a fresh graph snapshot. */
  function graph(): OrchestratorRunGraph {
    return orchestratorService.getRunGraph({ runId });
  }

  // ─── Worker Management ────────────────────────────────────────

  const spawn_worker = tool({
    description:
      "Spawn a new agent worker session. The worker will execute the given prompt autonomously. Returns a worker ID (step key) you can use to track, message, or stop the worker.",
    inputSchema: z.object({
      name: z.string().describe("Human-readable name for the worker (e.g. 'auth-implementer', 'test-writer')"),
      provider: z.enum(["claude", "codex"]).describe("Which agent provider to use"),
      prompt: z.string().describe("The full task prompt for the worker — be specific about what to do"),
      dependsOn: z
        .array(z.string())
        .default([])
        .describe("Step keys this worker depends on (must complete before worker starts)"),
    }),
    execute: async ({ name, provider, prompt, dependsOn }) => {
      try {
        const g = graph();
        const maxIndex = g.steps.reduce(
          (max, s) => Math.max(max, s.stepIndex),
          -1,
        );
        const stepKey = `worker_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}`;
        const created = orchestratorService.addSteps({
          runId,
          steps: [
            {
              stepKey,
              title: name,
              stepIndex: maxIndex + 1,
              dependencyStepKeys: dependsOn,
              executorKind: provider === "codex" ? "codex" : "claude",
              metadata: {
                instructions: prompt,
                workerName: name,
                spawnedByCoordinator: true,
              },
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

        // Trigger autopilot to pick up the new step if it's ready
        setTimeout(() => {
          void orchestratorService.startReadyAutopilotAttempts({
            runId,
            reason: "coordinator_spawn_worker",
          }).catch(() => {});
        }, 100);

        logger.info("coordinator.spawn_worker", { name, stepKey, provider });
        return {
          ok: true,
          workerId: stepKey,
          stepId: newStep?.id ?? null,
          status: newStep?.status ?? "unknown",
          name,
          provider,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.spawn_worker.error", { name, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const stop_worker = tool({
    description:
      "Stop a running worker by canceling its current attempt.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key (workerId) of the worker to stop"),
      reason: z.string().describe("Reason for stopping the worker"),
    }),
    execute: async ({ workerId, reason }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return { ok: false, error: `Worker not found: ${workerId}` };
        const attempt = findRunningAttempt(g, step.id);
        if (!attempt)
          return {
            ok: false,
            error: `No running attempt found for worker '${workerId}'`,
          };
        orchestratorService.completeAttempt({
          attemptId: attempt.id,
          status: "canceled",
          errorClass: "canceled",
          errorMessage: reason,
        });
        logger.info("coordinator.stop_worker", {
          workerId,
          attemptId: attempt.id,
          reason,
        });
        return { ok: true, workerId, attemptId: attempt.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.stop_worker.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const send_message = tool({
    description:
      "Send a message to a specific running worker. The worker will see it as steering input.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key of the target worker"),
      content: z.string().describe("Message content to send"),
    }),
    execute: async ({ workerId, content }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return { ok: false, error: `Worker not found: ${workerId}` };
        const attempt = findRunningAttempt(g, step.id);
        if (!attempt)
          return {
            ok: false,
            error: `No running attempt found for worker '${workerId}'`,
          };
        const sessionId = attempt.executorSessionId;
        if (!sessionId)
          return {
            ok: false,
            error: `No session ID for running worker '${workerId}'`,
          };
        const pending: PendingMessage = {
          id: randomUUID(),
          content,
          fromAttemptId: null,
          priority: "normal",
          receivedAt: nowIso(),
        };
        enqueuePendingMessage(sessionId, pending);
        orchestratorService.appendRuntimeEvent({
          runId,
          stepId: step.id,
          attemptId: attempt.id,
          sessionId,
          eventType: "coordinator_steering",
          payload: { message: content, priority: "normal" },
        });
        logger.info("coordinator.send_message", { workerId, sessionId });
        return { ok: true, workerId, sessionId, messageId: pending.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.send_message.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const broadcast = tool({
    description:
      "Broadcast a message to ALL currently running workers.",
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

  const get_worker_output = tool({
    description:
      "Read what a completed (or running) worker has produced. Returns summary, status, files changed, and any errors.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key of the worker to get output for"),
    }),
    execute: async ({ workerId }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return { ok: false, error: `Worker not found: ${workerId}` };
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
        // Also check for running attempt
        const running = findRunningAttempt(g, step.id);
        if (!latest && !running)
          return {
            ok: false,
            error: `No completed or running attempt found for worker '${workerId}'`,
          };
        if (latest) {
          return {
            ok: true,
            workerId,
            attemptId: latest.id,
            status: latest.status,
            summary: latest.resultEnvelope?.summary ?? null,
            success: latest.resultEnvelope?.success ?? null,
            warnings: latest.resultEnvelope?.warnings ?? [],
            errorMessage: latest.errorMessage ?? null,
          };
        }
        return {
          ok: true,
          workerId,
          status: "running",
          summary: "Worker is still running.",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.get_worker_output.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const list_workers = tool({
    description:
      "Get status of all workers (active, completed, failed, etc.).",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const g = graph();
        const workers = g.steps
          .filter((s) => s.stepKey !== "__planner__")
          .map((s) => {
            const attempt = findRunningAttempt(g, s.id);
            const latestCompleted = g.attempts
              .filter((a) => a.stepId === s.id && a.status !== "running")
              .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))[0];
            return {
              workerId: s.stepKey,
              title: s.title,
              status: s.status,
              hasRunningAttempt: !!attempt,
              lastResult: latestCompleted?.status ?? null,
              retryCount: s.retryCount,
            };
          });
        return { ok: true, workers, total: workers.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.list_workers.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  // ─── Task Management ──────────────────────────────────────────

  const create_task = tool({
    description:
      "Create a task in the mission DAG. Tasks show up in the UI as a visual work breakdown. Use this to plan the work before spawning workers.",
    inputSchema: z.object({
      key: z.string().describe("Unique key for this task (e.g. 'design-oauth', 'impl-tokens')"),
      title: z.string().describe("Human-readable title for the task"),
      description: z.string().describe("Description of what needs to be done"),
      dependsOn: z
        .array(z.string())
        .default([])
        .describe("Task keys this task depends on"),
    }),
    execute: async ({ key, title, description, dependsOn }) => {
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
              stepKey: key,
              title,
              stepIndex: maxIndex + 1,
              dependencyStepKeys: dependsOn,
              executorKind: "unified",
              metadata: { instructions: description, isTask: true },
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
        logger.info("coordinator.create_task", { key, title });
        return {
          ok: true,
          taskKey: key,
          stepId: newStep?.id ?? null,
          status: newStep?.status ?? "unknown",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.create_task.error", { key, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const update_task = tool({
    description:
      "Update a task's status or description. Use this to mark tasks as done, failed, or to update their instructions.",
    inputSchema: z.object({
      key: z.string().describe("Task key to update"),
      status: z.enum(["succeeded", "failed", "skipped"]).optional().describe("New status for the task"),
      result: z.string().optional().describe("Result summary or failure reason"),
    }),
    execute: async ({ key, status, result }) => {
      try {
        const g = graph();
        const step = resolveStep(g, key);
        if (!step)
          return { ok: false, error: `Task not found: ${key}` };
        if (status === "skipped") {
          orchestratorService.skipStep({
            runId,
            stepId: step.id,
            reason: result ?? "Skipped by coordinator",
          });
        } else if (status) {
          const ts = nowIso();
          db.run(
            `update orchestrator_steps set status = ?, completed_at = ?, updated_at = ? where id = ? and run_id = ?`,
            [status, ts, ts, step.id, runId],
          );
        }
        onDagMutation({
          runId,
          mutation: { type: "status_changed", stepKey: key, newStatus: status ?? step.status },
          timestamp: nowIso(),
          source: "coordinator",
        });
        logger.info("coordinator.update_task", { key, status });
        return { ok: true, taskKey: key, newStatus: status ?? step.status };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.update_task.error", { key, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const assign_task = tool({
    description:
      "Assign a task to a worker. Links the task to the worker in the UI.",
    inputSchema: z.object({
      taskKey: z.string().describe("Task key to assign"),
      workerId: z.string().describe("Worker step key to assign the task to"),
    }),
    execute: async ({ taskKey, workerId }) => {
      try {
        const g = graph();
        const step = resolveStep(g, taskKey);
        if (!step)
          return { ok: false, error: `Task not found: ${taskKey}` };
        // Store assignment in step metadata
        const existingMeta = (step.metadata ?? {}) as Record<string, unknown>;
        const updatedMeta = { ...existingMeta, assignedTo: workerId };
        db.run(
          `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ?`,
          [JSON.stringify(updatedMeta), nowIso(), step.id, runId],
        );
        logger.info("coordinator.assign_task", { taskKey, workerId });
        return { ok: true, taskKey, workerId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.assign_task.error", { taskKey, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const list_tasks = tool({
    description:
      "Get all tasks and their current statuses.",
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
        const tasks = g.steps.map((s) => {
          const attempt = findRunningAttempt(g, s.id);
          const meta = (s.metadata ?? {}) as Record<string, unknown>;
          return {
            key: s.stepKey,
            title: s.title,
            status: s.status,
            assignedTo: meta.assignedTo ?? null,
            hasRunningWorker: !!attempt,
            retryCount: s.retryCount,
          };
        });
        return {
          ok: true,
          runId,
          progressPct,
          total,
          byStatus,
          tasks,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.list_tasks.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  // ─── Step Control ───────────────────────────────────────────

  const skip_step = tool({
    description:
      "Skip a step/task that you've decided is non-critical or unnecessary. Unblocks downstream steps that depend on it.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key of the step to skip"),
      reason: z.string().describe("Why you're skipping this step"),
    }),
    execute: async ({ workerId, reason }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return { ok: false, error: `Step not found: ${workerId}` };
        if (step.status === "succeeded" || step.status === "skipped")
          return { ok: false, error: `Step '${workerId}' is already ${step.status}` };
        // Cancel running attempt if any
        const running = findRunningAttempt(g, step.id);
        if (running) {
          orchestratorService.completeAttempt({
            attemptId: running.id,
            status: "canceled",
            errorClass: "canceled",
            errorMessage: reason,
          });
        }
        orchestratorService.skipStep({
          runId,
          stepId: step.id,
          reason,
        });
        onDagMutation({
          runId,
          mutation: { type: "status_changed", stepKey: workerId, newStatus: "skipped" },
          timestamp: nowIso(),
          source: "coordinator",
        });
        logger.info("coordinator.skip_step", { workerId, reason });
        return { ok: true, workerId, newStatus: "skipped" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.skip_step.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const retry_step = tool({
    description:
      "Retry a failed step with adjusted instructions. Creates a new attempt with the revised prompt. Use when a worker failed but you believe it can succeed with different guidance.",
    inputSchema: z.object({
      workerId: z.string().describe("Step key of the failed step to retry"),
      adjustedInstructions: z.string().describe("New/revised instructions for the retry — explain what went wrong and how to fix it"),
    }),
    execute: async ({ workerId, adjustedInstructions }) => {
      try {
        const g = graph();
        const step = resolveStep(g, workerId);
        if (!step)
          return { ok: false, error: `Step not found: ${workerId}` };
        // Update step metadata with revised instructions
        const existingMeta = (step.metadata ?? {}) as Record<string, unknown>;
        const originalInstructions = existingMeta.instructions;
        const updatedMeta = {
          ...existingMeta,
          instructions: adjustedInstructions,
          previousInstructions: originalInstructions,
          retriedByCoordinator: true,
          retryReason: `Coordinator retry at ${nowIso()}`,
        };
        // Reset step to pending so autopilot picks it up
        const ts = nowIso();
        db.run(
          `update orchestrator_steps set status = 'pending', metadata_json = ?, retry_count = retry_count + 1, completed_at = null, updated_at = ? where id = ? and run_id = ?`,
          [JSON.stringify(updatedMeta), ts, step.id, runId],
        );
        onDagMutation({
          runId,
          mutation: { type: "status_changed", stepKey: workerId, newStatus: "pending" },
          timestamp: ts,
          source: "coordinator",
        });
        // Trigger autopilot to start the retry
        setTimeout(() => {
          void orchestratorService.startReadyAutopilotAttempts({
            runId,
            reason: "coordinator_retry_step",
          }).catch(() => {});
        }, 100);
        logger.info("coordinator.retry_step", { workerId });
        return { ok: true, workerId, newStatus: "pending", retryCount: step.retryCount + 1 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.retry_step.error", { workerId, error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  // ─── Mission Lifecycle ────────────────────────────────────────

  const complete_mission = tool({
    description:
      "Declare the mission complete. Call this when you are satisfied that all work is done.",
    inputSchema: z.object({
      summary: z.string().describe("Summary of what was accomplished"),
    }),
    execute: async ({ summary }) => {
      try {
        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "done",
          payload: { summary, completedBy: "coordinator" },
        });
        // Mark all remaining ready/blocked steps as skipped
        const g = graph();
        for (const step of g.steps) {
          if (step.status === "ready" || step.status === "blocked" || step.status === "pending") {
            orchestratorService.skipStep({
              runId,
              stepId: step.id,
              reason: "Mission completed by coordinator",
            });
          }
        }
        // Finalize via proper lifecycle callback
        if (deps.onRunFinalize) {
          deps.onRunFinalize({ runId, succeeded: true, summary });
        } else {
          // Fallback: raw update if no callback provided (shouldn't happen in practice)
          const ts = nowIso();
          db.run(
            `update orchestrator_runs set status = 'succeeded', completed_at = ?, updated_at = ? where id = ?`,
            [ts, ts, runId],
          );
        }
        logger.info("coordinator.complete_mission", { runId, summary });
        return { ok: true, runId, summary };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.complete_mission.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const fail_mission = tool({
    description:
      "Declare the mission failed. Use when you determine the mission cannot succeed.",
    inputSchema: z.object({
      reason: z.string().describe("Reason why the mission failed"),
    }),
    execute: async ({ reason }) => {
      try {
        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "done",
          payload: { reason, failedBy: "coordinator", failed: true },
        });
        // Finalize via proper lifecycle callback
        if (deps.onRunFinalize) {
          deps.onRunFinalize({ runId, succeeded: false, reason });
        } else {
          // Fallback: raw update if no callback provided
          const ts = nowIso();
          db.run(
            `update orchestrator_runs set status = 'failed', completed_at = ?, updated_at = ?, last_error = ? where id = ?`,
            [ts, ts, reason, runId],
          );
        }
        logger.info("coordinator.fail_mission", { runId, reason });
        return { ok: true, runId, reason };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("coordinator.fail_mission.error", { error: msg });
        return { ok: false, error: msg };
      }
    },
  });

  const ask_user = tool({
    description:
      "Escalate a question to the human user. Creates an intervention visible in the UI. Use when genuinely stuck or for high-risk decisions.",
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

  // ─── Context Tools ────────────────────────────────────────────

  const read_file = tool({
    description:
      "Read a file from the project. Use to inspect code, configs, or docs when you need to understand the codebase.",
    inputSchema: z.object({
      filePath: z.string().describe("Path relative to project root, e.g. 'src/index.ts' or 'package.json'"),
      maxLines: z.number().optional().describe("Maximum number of lines to read (default: 200)"),
    }),
    execute: async ({ filePath, maxLines }) => {
      try {
        const fullPath = path.resolve(projectRoot, filePath);
        // Security: ensure path is within project root
        if (!fullPath.startsWith(projectRoot)) {
          return { ok: false, error: "Path is outside project root" };
        }
        if (!fs.existsSync(fullPath)) {
          return { ok: false, error: `File not found: ${filePath}` };
        }
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(fullPath).slice(0, 100);
          return { ok: true, type: "directory", entries };
        }
        const content = fs.readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        const limit = maxLines ?? 200;
        const truncated = lines.length > limit;
        const result = truncated ? lines.slice(0, limit).join("\n") : content;
        return {
          ok: true,
          type: "file",
          filePath,
          content: result,
          totalLines: lines.length,
          truncated,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  const search_files = tool({
    description:
      "Search project files by name pattern or content. Use to find relevant code or files.",
    inputSchema: z.object({
      pattern: z.string().describe("Search pattern — a filename glob (e.g. '**/*.ts') or content regex"),
      searchType: z.enum(["filename", "content"]).default("content").describe("Whether to search file names or file content"),
      maxResults: z.number().optional().describe("Maximum results to return (default: 20)"),
    }),
    execute: async ({ pattern, searchType, maxResults }) => {
      try {
        const limit = maxResults ?? 20;
        if (searchType === "filename") {
          // Simple recursive file listing with glob matching
          const results: string[] = [];
          const walkDir = (dir: string, depth = 0) => {
            if (depth > 6 || results.length >= limit) return;
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (results.length >= limit) break;
                if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
                const rel = path.relative(projectRoot, path.join(dir, entry.name));
                if (entry.isDirectory()) {
                  walkDir(path.join(dir, entry.name), depth + 1);
                } else if (new RegExp(pattern.replace(/\*/g, ".*")).test(entry.name)) {
                  results.push(rel);
                }
              }
            } catch {
              // Skip unreadable dirs
            }
          };
          walkDir(projectRoot);
          return { ok: true, searchType, pattern, results, total: results.length };
        }
        // Content search using a simple line-by-line grep
        const results: Array<{ file: string; line: number; text: string }> = [];
        const regex = new RegExp(pattern, "i");
        const walkDir = (dir: string, depth = 0) => {
          if (depth > 6 || results.length >= limit) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (results.length >= limit) break;
              if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walkDir(fullPath, depth + 1);
              } else {
                try {
                  const stat = fs.statSync(fullPath);
                  if (stat.size > 500_000) continue; // Skip large files
                  const content = fs.readFileSync(fullPath, "utf-8");
                  const lines = content.split("\n");
                  for (let i = 0; i < lines.length && results.length < limit; i++) {
                    if (regex.test(lines[i]!)) {
                      results.push({
                        file: path.relative(projectRoot, fullPath),
                        line: i + 1,
                        text: lines[i]!.slice(0, 200),
                      });
                    }
                  }
                } catch {
                  // Skip unreadable files
                }
              }
            }
          } catch {
            // Skip unreadable dirs
          }
        };
        walkDir(projectRoot);
        return { ok: true, searchType, pattern, results, total: results.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  const get_project_context = tool({
    description:
      "Get a summary of the project: key docs, file structure, and config. Use at mission start to understand the codebase.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        // Read key project files
        const keyFiles = ["package.json", "tsconfig.json", "README.md", "CLAUDE.md"];
        const docs: Record<string, string> = {};
        for (const f of keyFiles) {
          const fp = path.resolve(projectRoot, f);
          try {
            if (fs.existsSync(fp)) {
              const content = fs.readFileSync(fp, "utf-8");
              docs[f] = content.slice(0, 4_000);
            }
          } catch {
            // Skip unreadable files
          }
        }
        // Top-level directory listing
        let topLevel: string[] = [];
        try {
          topLevel = fs.readdirSync(projectRoot)
            .filter((e) => !e.startsWith("."))
            .slice(0, 50);
        } catch {
          // Ignore
        }
        return {
          ok: true,
          projectRoot,
          topLevelEntries: topLevel,
          docs,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  });

  return {
    spawn_worker,
    stop_worker,
    send_message,
    broadcast,
    get_worker_output,
    list_workers,
    create_task,
    update_task,
    assign_task,
    list_tasks,
    skip_step,
    retry_step,
    complete_mission,
    fail_mission,
    ask_user,
    read_file,
    search_files,
    get_project_context,
  };
}
