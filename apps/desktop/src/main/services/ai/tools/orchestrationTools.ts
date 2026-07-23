/**
 * Orchestration tool factory — companion to `createUniversalToolSet`.
 *
 * Gated on `interactionMode === "orchestrator-lead" | "orchestrator-worker" |
 * "orchestrator-validator"`. The factory composes the read-only base from the
 * universal toolset (for lead) and adds the orchestration-specific tools, OR
 * keeps the full edit-capable set (for worker/validator) and layers
 * orchestration tools on top.
 *
 * Plan-quality assessment lives in `./orchestrationPlanQuality.ts`.
 * Runtime infrastructure (heartbeat, cancellation, lead notification,
 * sandbox config) lives in `./orchestrationRuntime.ts`.
 */

import crypto from "node:crypto";
import { z } from "zod";
import { executableTool as tool, type ExecutableTool } from "./executableTool";
import {
  createUniversalToolSet,
  type AskUserToolResult,
  type UniversalToolSetOptions,
} from "./universalTools";
import type {
  EvidenceRef,
  ManifestPatchOp,
  OrchestrationAgentStatus,
  OrchestrationAssetExternalRef,
  OrchestrationAssetKind,
  OrchestrationManifest,
  OrchestrationPingIntent,
  OrchestrationPingKind,
  OrchestrationRole,
  OrchestrationTaskStatus,
  ModelSelection,
  PlanningRoundKind,
  PlanningRoundOption,
  PlanningRoundRecord,
  PlanningStage,
} from "../../../../shared/types/orchestration";
import {
  ORCHESTRATION_SPAWN_BRIEF_REQUIRED_SECTIONS,
  type OrchestrationSpawnAgentRequest,
} from "../../../../shared/types/orchestration";
import type {
  createOrchestrationService,
  NewOutboxEntry,
} from "../../orchestration/orchestrationService";
import {
  buildOutboxEnqueueOps,
  validateSpawnBrief,
} from "../../orchestration/orchestrationService";
import {
  applyOrchestrationPermissionProfile,
  isOrchestrationPlanApproved,
  isPlanningReadyForModelSelection,
  resolveOrchestrationModel,
} from "../../orchestration/runtimeProfile";

import { assessPlanReadiness } from "./orchestrationPlanQuality";
import { deriveSuggestedValidationSteps } from "./orchestrationValidationDerivation";
import { drainOutbox } from "./orchestrationOutbox";
import {
  buildOrchestrationSandboxConfig,
  errorMessage,
  manifestOrThrow,
  registerOrchestrationBashCancellation,
  withHeartbeat,
  withMutationSideEffects,
} from "./orchestrationRuntime";

// Re-export so existing consumers keep working
export { assessPlanReadiness } from "./orchestrationPlanQuality";
export type { OrchestrationPlanQualityMissing } from "./orchestrationPlanQuality";
export { buildOrchestrationSandboxConfig } from "./orchestrationRuntime";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OrchestrationInteractionMode =
  | "orchestrator-lead"
  | "orchestrator-worker"
  | "orchestrator-validator";

/**
 * Session context the chat runtime hands to the orchestration tools.
 * The tools embed this in every IPC/service call so the server-side
 * patchPolicy can enforce per-actor rules.
 */
export type OrchestrationSessionContext = {
  /** The session running these tools (lead/worker/validator). */
  sessionId: string;
  /** Run identifier (manifest.runId). */
  runId: string;
  /** Resolved role for permission gating. */
  role: OrchestrationRole;
  /** Absolute bundle path — used so service calls resolve the right runtime. */
  bundlePath: string;
  /** Lane id — required for downstream spawn flow. */
  laneId: string;
  /** Parent lead session id (workers/validators inherit this). */
  leadSessionId?: string;
};

/**
 * Minimal `agentChatService` surface the orchestration tools need.
 * Kept narrow on purpose so tests can stub without dragging the whole service.
 */
export type OrchestrationAgentChatHandle = {
  createSession: (args: Record<string, unknown>) => Promise<{ id: string }>;
  deleteSession: (args: { sessionId: string }) => Promise<void>;
  sendMessage: (
    args: Record<string, unknown>,
    options?: { awaitDispatch?: boolean },
  ) => Promise<void>;
  steer: (args: Record<string, unknown>) => Promise<unknown>;
  interrupt: (args: { sessionId: string }) => Promise<void>;
  readTranscript: (
    sessionId: string,
    limit?: number,
    since?: string,
  ) => Promise<unknown>;
};

/**
 * Result shape every lead read-only capability tool returns. Always resolves —
 * a missing backing service yields `{ ok: false, error: "unavailable" }` rather
 * than throwing (runtime-backed-null-services safety: never assume a service
 * exists in prod).
 */
export type OrchestrationLeadReadResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string; message: string };

/**
 * Curated, READ-ONLY ADE capability backings for the orchestrator lead. Each is
 * optional and injected by the chat runtime from whatever services are actually
 * wired in this process; a missing entry means the matching tool reports
 * "unavailable". All calls run with orchestrator-role read scope and MUST NOT
 * mutate anything (deeplink minting is side-effect-free).
 */
export type OrchestrationLeadReadServices = {
  /** Universal search across ADE (transcripts, PRs, commits, Linear, proof, lanes). */
  searchWorkspace?: (args: {
    query: string;
    limit?: number;
    laneId?: string;
  }) => Promise<OrchestrationLeadReadResult>;
  /** Read a Linear issue (description + comments) by id/identifier. */
  readLinearIssue?: (args: { issueId: string }) => Promise<OrchestrationLeadReadResult>;
  /** Read PR summary/status/checks for the lane (or a specific PR id). */
  readPr?: (args: { prId?: string }) => Promise<OrchestrationLeadReadResult>;
  /** List proof-drawer / computer-use artifacts (evidence). */
  listProofArtifacts?: (args: { limit?: number }) => Promise<OrchestrationLeadReadResult>;
  /** Mint an ADE deeplink (pure; side-effect-free) for a target. */
  mintDeeplink?: (args: {
    target: Record<string, unknown>;
  }) => Promise<OrchestrationLeadReadResult>;
};

export type OrchestrationToolSetOptions = {
  cwd: string;
  interactionMode: OrchestrationInteractionMode;
  sessionContext: OrchestrationSessionContext;
  orchestrationService: ReturnType<typeof createOrchestrationService>;
  agentChatService: OrchestrationAgentChatHandle;
  /**
   * Forwarded to the universal toolset — every orchestration session embeds
   * a base set of read or edit tools depending on role.
   */
  universal: UniversalToolSetOptions;
  /**
   * Optional read-only ADE capability backings for the lead slice. Absent
   * entries degrade to an "unavailable" tool result; never required.
   */
  leadReadServices?: OrchestrationLeadReadServices;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PING_KIND_VALUES = ["queue", "interrupt-replace", "wake"] as const;
const PING_INTENT_VALUES = [
  "directive",
  "status",
  "diff_notice",
  "cancellation",
  "question",
] as const;
const WORKER_INTENT_VALUES = ["status", "question"] as const;
const TASK_STATUS_VALUES = [
  "pending",
  "claimed",
  "in_progress",
  "review",
  "done",
  "failed",
] as const;
const VALIDATION_RUN_STATUS_VALUES = ["running", "passed", "failed"] as const;
const ASSET_KIND_VALUES = [
  "html_spec",
  "screenshot",
  "test_log",
  "doc",
  // Unit S evidence kinds for externally-visible ADE actions (see SKILL §13).
  "proof_artifact",
  "computer_use",
  "video",
  "pr_link",
  "linear_issue",
  "deeplink",
] as const;
const MODEL_SELECTION_ROLE_VALUES = ["worker", "validator"] as const;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

const LEAD_READ_ONLY_BASE = new Set([
  "readFile",
  "grep",
  "glob",
  "listDir",
  "gitStatus",
  "gitDiff",
  "gitLog",
  "webFetch",
  "webSearch",
  "askUser",
  "findRoutingFiles",
  "findPageComponents",
  "findAppEntryPoints",
  "summarizeFrontendStructure",
]);

// ---------------------------------------------------------------------------
// Tool factories (per orchestration concept)
// ---------------------------------------------------------------------------

function createSpawnAgentTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
) {
  return tool({
    description:
      "Lead-only. Spawn an orchestration worker or validator session. " +
      "The `initialMessage` must include all required sections " +
      `(${ORCHESTRATION_SPAWN_BRIEF_REQUIRED_SECTIONS.join(", ")}). ` +
      "Use the brief to point the agent at manifest.json, plan.md, the relevant plan section, exact task scope, peer/parallel work, validation gates, report-back rules, stuck protocol, and required planAppend evidence.",
    inputSchema: z.object({
      role: z.enum(["worker", "validator"]),
      tag: z.string().min(1, "tag is required"),
      goalSummary: z.string().min(1, "goalSummary is required"),
      stepId: z.string().min(1, "stepId is required"),
      initialMessage: z.string().min(1, "initialMessage is required"),
      requestId: z.string().min(1).optional(),
      spawnKind: z.enum(["subagent", "peer", "none"]).optional(),
      modelOverride: z
        .object({
          provider: z.string(),
          modelId: z.string(),
          reasoningEffort: z.string().nullable().optional(),
          fastMode: z.boolean().optional(),
        })
        .partial({ reasoningEffort: true, fastMode: true })
        .optional(),
    }),
    execute: async (input) => {
      return withHeartbeat(ctx, svc, async () => {
        const brief = validateSpawnBrief(input.initialMessage);
        if (!brief.ok) {
          return {
            ok: false as const,
            error: "spawn_brief_missing_sections",
            missing: brief.missing,
            message:
              `Spawn brief missing required sections: ${brief.missing.join(", ")}.`,
          };
        }
        const manifest = manifestOrThrow(svc, ctx.runId);
        if (!isOrchestrationPlanApproved(manifest)) {
          return {
            ok: false as const,
            error: "plan_not_approved",
            message:
              "spawnAgent is blocked until the user approves the orchestration plan. Call requestPlanApproval and patch the run into developing first.",
          };
        }
        const routedSelection = resolveOrchestrationModel(
          manifest,
          input.role,
          input.tag,
          input.modelOverride as ModelSelection | undefined,
        );
        const briefDigest = sha256(input.initialMessage);
        const requestId =
          input.requestId ??
          `spawn:${sha256(
            `${ctx.runId}|${input.role}|${input.tag}|${input.stepId}|${briefDigest}`,
          )}`;
        const reservation = await svc.reserveReceipt(
          ctx.runId,
          ctx.bundlePath,
          { requestId, kind: "spawnAgent" },
        );
        if (!reservation.ok) {
          return {
            ok: false as const,
            error: "receipt_reservation_failed",
            message: reservation.message,
          };
        }
        if (reservation.status === "duplicate") {
          // Only a COMPLETED receipt carries a real result to replay. A still
          // PENDING receipt means an earlier spawn with this requestId is in
          // flight (or crashed mid-flight and has not yet aged past the stale
          // receipt sweep). Replaying it as success would report a session that
          // may not exist (undefined sessionId) — surface a retryable in-progress
          // result so the caller waits instead of treating delegation as done.
          if (reservation.receipt.status !== "completed") {
            return {
              ok: false as const,
              error: "spawn_in_progress",
              retryable: true,
              message:
                "A spawn with this requestId is already in progress. Retry once it settles; a crashed reservation is reclaimed by recoverStaleTasks after the receipt TTL.",
            };
          }
          return {
            ok: true as const,
            sessionId: reservation.receipt.result?.sessionId,
            etag: reservation.receipt.result?.etag,
            deduped: true,
          };
        }
        const interactionMode =
          input.role === "validator"
            ? "orchestrator-validator"
            : "orchestrator-worker";
        let created: { id: string };
        try {
          created = await chat.createSession({
            laneId: ctx.laneId,
            provider: routedSelection.provider,
            model: routedSelection.modelId,
            reasoningEffort: routedSelection.reasoningEffort ?? null,
            fastMode: routedSelection.fastMode,
            interactionMode,
            surface: "work",
            ...applyOrchestrationPermissionProfile(routedSelection.provider),
            orchestrationRunId: ctx.runId,
            orchestrationRole: input.role,
            orchestrationParentSessionId: ctx.sessionId,
            spawnKind: input.spawnKind ?? "subagent",
            orchestrationTag: input.tag,
            orchestrationStepId: input.stepId,
            orchestrationBundlePath: ctx.bundlePath,
            goal: input.goalSummary,
          });
        } catch (err) {
          await svc.releaseReceipt(ctx.runId, ctx.bundlePath, { requestId });
          return {
            ok: false as const,
            error: "create_session_failed",
            message: errorMessage(err),
          };
        }
        const spawnedAt = new Date().toISOString();
        const patch: ManifestPatchOp = {
          op: "add",
          path: "/agents/-",
          value: {
            sessionId: created.id,
            role: input.role,
            tag: input.tag,
            goalSummary: input.goalSummary,
            status: "pending",
            spawnedAt,
            currentStepId: input.stepId,
            // Link the agent to its spawn receipt so reserveReceipt can reconcile
            // a stale/pruned receipt to this row instead of duplicating the spawn.
            spawnRequestId: requestId,
            spawnFingerprint: {
              provider: routedSelection.provider,
              modelId: routedSelection.modelId,
              reasoningEffort: routedSelection.reasoningEffort ?? null,
              fastMode: routedSelection.fastMode,
              resolvedAt: spawnedAt,
              routingKey: routedSelection.routingKey,
            },
          },
        };
        const currentManifest = manifestOrThrow(svc, ctx.runId);
        const briefOps = buildOutboxEnqueueOps(currentManifest, [{
          kind: "brief",
          targetSessionId: created.id,
          delivery: {
            op: "sendMessage",
            text: input.initialMessage,
            metadata: {
              orchestrationOrigin: {
                runId: ctx.runId,
                fromSessionId: ctx.sessionId,
                kind: "wake" as OrchestrationPingKind,
                intent: "directive" as OrchestrationPingIntent,
                taskId: input.stepId,
              },
            },
          },
          requestId,
        }]);
        const completeRes = await svc.completeReceipt(
          ctx.runId,
          ctx.bundlePath,
          { requestId, result: { sessionId: created.id } },
          [patch, ...briefOps],
        );
        if (!completeRes.ok) {
          // Clean up the orphaned session since manifest registration failed
          try {
            await chat.deleteSession({ sessionId: created.id });
          } catch (_cleanupErr) {
            // Best-effort cleanup — log suppressed to avoid masking the root error
          }
          await svc.releaseReceipt(ctx.runId, ctx.bundlePath, { requestId });
          return {
            ok: false as const,
            error: "manifest_patch_failed",
            message:
              "Created session but failed to append agent row (session cleaned up): " +
              completeRes.error,
          };
        }
        // Record the lead→child delegation edge (best-effort; never fails the
        // spawn — the agent row is the source of truth, the edge is provenance).
        try {
          await svc.recordDelegationSpawn(
            {
              runId: ctx.runId,
              parentSessionId: ctx.sessionId,
              childSessionId: created.id,
              childRole: input.role,
              childTag: input.tag,
              stepId: input.stepId,
              briefText: input.initialMessage,
              spawnFingerprint: {
                provider: routedSelection.provider,
                modelId: routedSelection.modelId,
                reasoningEffort: routedSelection.reasoningEffort ?? null,
                fastMode: routedSelection.fastMode,
                resolvedAt: spawnedAt,
                routingKey: routedSelection.routingKey,
              },
            },
            ctx.bundlePath,
          );
        } catch {
          // Supplementary provenance only — swallow.
        }
        await drainOutbox(svc, chat, ctx);
        return {
          ok: true as const,
          sessionId: created.id,
          etag: completeRes.etag,
        };
      });
    },
  });
}

/**
 * Shared delivery epilogue for messageAgent's cancellation and ping branches:
 * enqueue the single outbox entry and complete the idempotency receipt in ONE
 * atomic transaction (the outbox `add` is folded into `completeReceipt` as an
 * extra patch — exactly like spawnAgent), then drain.
 *
 * Atomicity is the correctness invariant here: a failed `completeReceipt`
 * persists neither the receipt completion nor the outbox entry, so releasing the
 * receipt on failure orphans nothing. If the enqueue were a separate prior
 * transaction (as it once was), the outbox entry would already be durable when
 * completeReceipt failed — freeing the deterministic requestId would then let an
 * LLM retry enqueue a DUPLICATE ping/cancel/interrupt. `releaseReceipt` no-ops
 * when the run is suspended, so the suspended case never frees a live receipt.
 *
 * `buildOutboxEnqueueOps` needs the current manifest to derive the deterministic
 * etag+index outbox id, so read it fresh right before completing (mirrors
 * spawnAgent's `currentManifest` read).
 */
async function finalizeDelivery(
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
  ctx: OrchestrationSessionContext,
  args: {
    requestId: string;
    entry: NewOutboxEntry;
    /**
     * State that must commit atomically WITH the receipt+outbox entry, built
     * from the fresh manifest. Used by cancellation so its decision/attempt/flag
     * patches land in the same transaction as the receipt — a crash between them
     * can no longer leave cancellation durable while the receipt is released
     * (which would let a retry re-append a second cancellation decision/attempt).
     */
    buildExtraPatches?: (manifest: OrchestrationManifest) => ManifestPatchOp[];
  },
): Promise<{ ok: true } | { ok: false; error: "delivery_failed"; message: string }> {
  const manifest = manifestOrThrow(svc, ctx.runId);
  const extraPatches = args.buildExtraPatches?.(manifest) ?? [];
  const outboxOps = buildOutboxEnqueueOps(manifest, [args.entry]);
  const completed = await svc.completeReceipt(
    ctx.runId,
    ctx.bundlePath,
    { requestId: args.requestId, result: {} },
    [...extraPatches, ...outboxOps],
  );
  if (!completed.ok) {
    await svc.releaseReceipt(ctx.runId, ctx.bundlePath, { requestId: args.requestId });
    return { ok: false, error: "delivery_failed", message: completed.message };
  }
  await drainOutbox(svc, chat, ctx);
  return { ok: true };
}

/**
 * Normalize a single-choice askUser response. Returns the selected option value
 * (if any) and whether the user dismissed the card (cancel/decline). A raw
 * string response (no structured answer) is treated as not-dismissed with no
 * answer — matching the prior inline handling at both call sites.
 */
function readSingleChoice(
  response: string | AskUserToolResult,
  questionId: string,
): { answer?: string; dismissed: boolean } {
  if (typeof response === "string") {
    return { dismissed: false };
  }
  return {
    answer: response.answers?.[questionId]?.[0],
    dismissed: response.decision === "cancel" || response.decision === "decline",
  };
}

function createMessageAgentTool(args: {
  ctx: OrchestrationSessionContext;
  chat: OrchestrationAgentChatHandle;
  svc: ReturnType<typeof createOrchestrationService>;
  /** When true, restrict `intent` to {status, question}. */
  restrictedIntents: boolean;
}) {
  const intentSchema = args.restrictedIntents
    ? z.enum(WORKER_INTENT_VALUES)
    : z.enum(PING_INTENT_VALUES);
  return tool({
    description:
      "Send a directive/status/question to another orchestration agent in the same run. " +
      "Choose `kind`: 'queue' to append to the target's input queue, 'interrupt-replace' to halt their current turn and replace, 'wake' to deliver as a dormant prompt. " +
      (args.restrictedIntents
        ? "Workers/validators may only use intent: 'status' or 'question'."
        : ""),
    inputSchema: z.object({
      targetSessionId: z.string().min(1),
      kind: z.enum(PING_KIND_VALUES),
      intent: intentSchema,
      text: z.string().min(1),
      taskId: z.string().optional(),
      requestId: z.string().min(1).optional(),
      cancellation: z
        .object({
          revert: z.union([z.boolean(), z.literal("review")]),
          reason: z.string().min(1),
        })
        .optional(),
    }),
    execute: async (input) => {
      return withHeartbeat(args.ctx, args.svc, async () => {
        // Server-side membership check: target must belong to the same run.
        const manifest = manifestOrThrow(args.svc, args.ctx.runId);
        const target = manifest.agents.find(
          (a) => a.sessionId === input.targetSessionId,
        );
        const self = manifest.agents.find(
          (a) => a.sessionId === args.ctx.sessionId,
        );
        if (!self || !target) {
          return {
            ok: false as const,
            error: "agent_not_in_run",
            message:
              "messageAgent: source or target session is not registered in this run.",
          };
        }
        // Defence-in-depth: schema already rejects "cancellation" when restricted,
        // but a direct caller could still attempt it. Cast to the full intent
        // union so the runtime check covers bypassed schema calls.
        const intent = input.intent as OrchestrationPingIntent;
        if (
          args.restrictedIntents &&
          intent === "cancellation"
        ) {
          return {
            ok: false as const,
            error: "intent_not_allowed",
            message:
              "Workers and validators cannot send cancellation directives.",
          };
        }
        const requestId =
          input.requestId ??
          `msg:${sha256(
            `${args.ctx.runId}|${args.ctx.sessionId}|${input.targetSessionId}|${input.kind}|${intent}|${input.taskId ?? ""}|${input.text}`,
          )}`;
        const reservation = await args.svc.reserveReceipt(
          args.ctx.runId,
          args.ctx.bundlePath,
          { requestId, kind: "messageAgent" },
        );
        if (!reservation.ok) {
          return {
            ok: false as const,
            error: "delivery_failed",
            message: reservation.message,
          };
        }
        if (reservation.status === "duplicate") {
          // A COMPLETED receipt means the message was already enqueued+delivered
          // under this requestId — replay the deduped success. A PENDING receipt
          // means the enqueue never completed (concurrent/crashed retry); the
          // outbox entry does not exist, so reporting success would silently drop
          // the message. Return a retryable in-progress result instead.
          if (reservation.receipt.status !== "completed") {
            return {
              ok: false as const,
              error: "delivery_in_progress",
              retryable: true,
              message:
                "A message with this requestId is already in progress. Retry once it settles; a crashed reservation is reclaimed by recoverStaleTasks after the receipt TTL.",
            };
          }
          return { ok: true as const, deduped: true };
        }
        const origin = {
          runId: args.ctx.runId,
          fromSessionId: args.ctx.sessionId,
          kind: input.kind,
          intent,
          taskId: input.taskId,
        };
        const metadata = {
          orchestrationOrigin: origin,
          ...(input.cancellation ? { orchestrationCancellation: input.cancellation } : {}),
        };
        if (intent === "cancellation") {
          const cancelledAt = new Date().toISOString();
          // The cancellation's own state (flag + decision + task-attempt rows) is
          // committed in the SAME transaction as the receipt completion and the
          // outbox entry — folded into completeReceipt as extra patches. Built
          // from the fresh manifest completeReceipt reads under its mutex, so the
          // `{id:…}` / `{sessionId:…}` paths resolve at apply time and no external
          // etag/retry is needed (completeReceipt uses the internal direct patch).
          const buildCancellationPatches = (
            current: OrchestrationManifest,
          ): ManifestPatchOp[] => {
            const patches: ManifestPatchOp[] = [
              {
                op: "add",
                path: `/agents/{sessionId:${input.targetSessionId}}/cancellationRequested`,
                value: true,
              },
              {
                op: "add",
                path: "/decisions/-",
                value: {
                  id: `D-cancel-${cancelledAt.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
                  at: cancelledAt,
                  source: args.ctx.role,
                  summary: `Cancellation requested for ${input.targetSessionId}: ${input.cancellation?.reason ?? input.text}`,
                  ...(input.taskId ? { refs: { taskId: input.taskId } } : {}),
                },
              },
            ];
            for (const task of current.tasks) {
              if (task.assigneeSessionId !== input.targetSessionId) continue;
              if (task.status !== "claimed" && task.status !== "in_progress") continue;
              const attemptId = `A-cancel-${task.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${cancelledAt.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
              const attempt = {
                id: attemptId,
                sessionId: input.targetSessionId,
                startedAt: task.claimedAt ?? cancelledAt,
                endedAt: cancelledAt,
                outcome: "cancelled" as const,
                failureReason: input.cancellation?.reason ?? input.text,
              };
              patches.push(
                task.attempts
                  ? {
                      op: "add",
                      path: `/tasks/{id:${task.id}}/attempts/-`,
                      value: attempt,
                    }
                  : {
                      op: "add",
                      path: `/tasks/{id:${task.id}}/attempts`,
                      value: [attempt],
                    },
                {
                  op: "add",
                  path: `/tasks/{id:${task.id}}/currentAttemptId`,
                  value: attemptId,
                },
              );
            }
            return patches;
          };
          return finalizeDelivery(args.svc, args.chat, args.ctx, {
            requestId,
            entry: {
              kind: "cancel_interrupt",
              targetSessionId: input.targetSessionId,
              delivery: { op: "interrupt" },
              requestId,
            },
            buildExtraPatches: buildCancellationPatches,
          });
        }

        const deliveryOp =
          input.kind === "queue"
            ? "steer"
            : input.kind === "interrupt-replace"
              ? "interrupt-replace"
              : "sendMessage";
        return finalizeDelivery(args.svc, args.chat, args.ctx, {
          requestId,
          entry: {
            kind: "ping",
            targetSessionId: input.targetSessionId,
            delivery: {
              op: deliveryOp,
              text: input.text,
              metadata,
            },
            requestId,
          },
        });
      });
    },
  });
}

function createGetAgentTranscriptTool(
  ctx: OrchestrationSessionContext,
  chat: OrchestrationAgentChatHandle,
  svc: ReturnType<typeof createOrchestrationService>,
) {
  return tool({
    description:
      "Read the last N transcript entries from another orchestration agent in this run. " +
      "Use to verify what a peer/worker has actually said before acting.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      limit: z.number().int().positive().max(500).optional(),
      since: z.string().optional(),
    }),
    execute: async ({ sessionId, limit, since }) => {
      return withHeartbeat(ctx, svc, async () => {
        const manifest = manifestOrThrow(svc, ctx.runId);
        const inRun = manifest.agents.some((a) => a.sessionId === sessionId);
        if (!inRun) {
          return {
            ok: false as const,
            error: "agent_not_in_run",
            message: `session ${sessionId} not registered in run ${ctx.runId}`,
          };
        }
        try {
          const entries = await chat.readTranscript(sessionId, limit, since);
          return { ok: true as const, entries };
        } catch (err) {
          return {
            ok: false as const,
            error: "read_failed",
            message: errorMessage(err),
          };
        }
      });
    },
  });
}

/** Agent statuses that count as "settled" for awaitAgent (turn done / failed). */
const SETTLED_AGENT_STATUSES: ReadonlySet<OrchestrationAgentStatus> = new Set([
  "completed",
  "failed",
]);

const AWAIT_AGENT_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const AWAIT_AGENT_MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

type AwaitAgentSnapshot = {
  sessionId: string;
  tag?: string;
  role: OrchestrationRole;
  status: OrchestrationAgentStatus;
  settled: boolean;
};

function snapshotAwaitTargets(
  manifest: OrchestrationManifest,
  sessionIds: readonly string[],
): { known: AwaitAgentSnapshot[]; unknown: string[] } {
  const known: AwaitAgentSnapshot[] = [];
  const unknown: string[] = [];
  for (const sessionId of sessionIds) {
    const agent = manifest.agents.find((a) => a.sessionId === sessionId);
    if (!agent) {
      unknown.push(sessionId);
      continue;
    }
    known.push({
      sessionId,
      ...(agent.tag ? { tag: agent.tag } : {}),
      role: agent.role,
      status: agent.status,
      settled: SETTLED_AGENT_STATUSES.has(agent.status),
    });
  }
  return { known, unknown };
}

function awaitConditionMet(
  snapshots: readonly AwaitAgentSnapshot[],
  waitFor: "all" | "any",
): boolean {
  if (!snapshots.length) return true;
  return waitFor === "any"
    ? snapshots.some((s) => s.settled)
    : snapshots.every((s) => s.settled);
}

/**
 * Lead-only. Block until target agent(s) reach a settled state (turn completed /
 * idle / failed), driven purely by the orchestration event bus — no transcript
 * polling. Short-circuits when already settled and always cleans up its
 * subscription + timer, so duplicate calls cannot leak listeners.
 */
function createAwaitAgentTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
) {
  return tool({
    description:
      "Lead-only. Wait until the given orchestration agent(s) finish their turn (settle as completed or failed), " +
      "then return. Event-driven — it subscribes to run lifecycle events, it does NOT poll transcripts. " +
      "Pass `sessionIds` (one or more) and optionally `waitFor` ('all' | 'any', default 'all') and `timeoutMs` " +
      "(default 10 min, max 30 min). On timeout it returns a structured still-running result instead of blocking forever. " +
      "Completion events are also delivered to you durably via the run outbox, so awaitAgent is a convenience, not the only signal.",
    inputSchema: z.object({
      sessionIds: z.array(z.string().min(1)).min(1, "at least one target sessionId"),
      waitFor: z.enum(["all", "any"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () => {
        const waitFor = input.waitFor ?? "all";
        const timeoutMs = Math.min(
          input.timeoutMs ?? AWAIT_AGENT_DEFAULT_TIMEOUT_MS,
          AWAIT_AGENT_MAX_TIMEOUT_MS,
        );
        const manifest = manifestOrThrow(svc, ctx.runId);
        const initial = snapshotAwaitTargets(manifest, input.sessionIds);
        if (initial.unknown.length) {
          return {
            ok: false as const,
            error: "agent_not_in_run",
            unknownSessionIds: initial.unknown,
            message:
              `awaitAgent: session(s) not registered in run ${ctx.runId}: ${initial.unknown.join(", ")}.`,
          };
        }
        // Short-circuit: already settled — no subscription needed.
        if (awaitConditionMet(initial.known, waitFor)) {
          return {
            ok: true as const,
            done: true,
            timedOut: false,
            waitFor,
            agents: initial.known,
          };
        }
        return await new Promise<{
          ok: true;
          done: boolean;
          timedOut: boolean;
          waitFor: "all" | "any";
          agents: AwaitAgentSnapshot[];
          stillRunning?: AwaitAgentSnapshot[];
          message?: string;
        }>((resolve) => {
          let finished = false;
          let unsubscribe: () => void = () => {};
          let timer: ReturnType<typeof setTimeout> | null = null;
          const currentSnapshots = (): AwaitAgentSnapshot[] => {
            const m = svc.getManifestForRun(ctx.runId);
            return m
              ? snapshotAwaitTargets(m, input.sessionIds).known
              : initial.known;
          };
          const finish = (
            result: Parameters<typeof resolve>[0],
          ): void => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            unsubscribe();
            resolve(result);
          };
          const check = (): void => {
            const snapshots = currentSnapshots();
            if (awaitConditionMet(snapshots, waitFor)) {
              finish({
                ok: true,
                done: true,
                timedOut: false,
                waitFor,
                agents: snapshots,
              });
            }
          };
          unsubscribe = svc.on("event", (payload) => {
            if (payload.runId !== ctx.runId) return;
            check();
          });
          timer = setTimeout(() => {
            const snapshots = currentSnapshots();
            finish({
              ok: true,
              done: false,
              timedOut: true,
              waitFor,
              agents: snapshots,
              stillRunning: snapshots.filter((s) => !s.settled),
              message:
                `Timed out after ${timeoutMs}ms waiting for ${waitFor === "any" ? "any of" : "all"} the target agent(s) to finish.`,
            });
          }, timeoutMs);
          // Close the subscribe race: state may have advanced between the initial
          // read and the subscription being installed.
          check();
        });
      }),
  });
}

function createManifestPatchTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
) {
  return tool({
    description:
      "Apply a list of RFC-6902 subset patches to the run manifest. " +
      "Use id-predicate paths (e.g. `/tasks/{id:T-1}/status`), never numeric indices. " +
      "Pass `ifMatchEtag` from the most recent read; on `etag_conflict` re-read and retry. " +
      "Server enforces a per-role whitelist — workers and validators can only patch their own rows.",
    inputSchema: z.object({
      ifMatchEtag: z.string().min(1),
      summary: z.string().optional(),
      patches: z
        .array(
          z.object({
            op: z.enum(["add", "replace", "remove"]),
            path: z.string().min(1),
            value: z.unknown().optional(),
          }),
        )
        .min(1),
    }),
    execute: async (input) => {
      return withMutationSideEffects({
        ctx,
        svc,
        chat,
        notifyText: `${ctx.role} ${ctx.sessionId} updated the run manifest${input.summary ? `: ${input.summary}` : "."}`,
        fn: async () => {
          const patches: ManifestPatchOp[] = input.patches.map((entry) =>
            entry.op === "remove"
              ? { op: "remove", path: entry.path }
              : ({
                  op: entry.op,
                  path: entry.path,
                  value: entry.value,
                } as ManifestPatchOp),
          );
          const res = await svc.manifestPatch(
            {
              runId: ctx.runId,
              ifMatchEtag: input.ifMatchEtag,
              actorRole: ctx.role,
              actorSessionId: ctx.sessionId,
              summary: input.summary,
              patches,
            },
            ctx.bundlePath,
          );
          return res;
        },
      });
    },
  });
}

function createPlanAppendTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
) {
  return tool({
    description:
      "Append a section to the run's plan.md. " +
      "Use this to write decisions, progress updates, blockers, replans, evidence summaries, and Q&A history. " +
      "Workers/validators must planAppend their evidence before calling recordValidationRun.",
    inputSchema: z.object({
      section: z.string().min(1, "section heading is required"),
      body: z.string().min(1, "body is required"),
      pinId: z.string().optional(),
    }),
    execute: async (input) => {
      return withMutationSideEffects({
        ctx,
        svc,
        chat,
        notifyText: `${ctx.role} ${ctx.sessionId} appended plan section ${input.section}.`,
        fn: async () => {
          try {
            const res = await svc.planAppend(
              {
                runId: ctx.runId,
                section: input.section,
                body: input.body,
                pinId: input.pinId,
              },
              ctx.bundlePath,
            );
            return { ok: true as const, etag: res.etag };
          } catch (err) {
            return {
              ok: false as const,
              error: "plan_append_failed",
              message: errorMessage(err),
            };
          }
        },
      });
    },
  });
}

function createPlanWriteTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
) {
  return tool({
    description:
      "Lead-only. Rewrite the entire plan.md. " +
      "Use for re-plans after major scope changes. Requires `ifMatchEtag`.",
    inputSchema: z.object({
      nextPlanMd: z.string(),
      ifMatchEtag: z.string().min(1),
    }),
    execute: async (input) => {
      return withMutationSideEffects({
        ctx,
        svc,
        chat,
        notifyText: `${ctx.role} ${ctx.sessionId} rewrote the orchestration plan.`,
        fn: async () => {
          try {
            const res = await svc.planWrite(
              {
                runId: ctx.runId,
                nextPlanMd: input.nextPlanMd,
                ifMatchEtag: input.ifMatchEtag,
              },
              ctx.bundlePath,
            );
            if ("error" in res) {
              return { ok: false as const, error: res.error, etag: res.etag };
            }
            return { ok: true as const, etag: res.etag };
          } catch (err) {
            return {
              ok: false as const,
              error: "plan_write_failed",
              message: errorMessage(err),
            };
          }
        },
      });
    },
  });
}

function hashPlanContent(planMd: string): string {
  return crypto.createHash("sha256").update(planMd, "utf8").digest("hex");
}

function createRequestPlanApprovalTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  universalOpts: UniversalToolSetOptions,
) {
  return tool({
    description:
      "Lead-only. Mark the plan ready and surface the plan-pane Implement button — the user approves the live plan.md narrative on the sidebar, not a separate summary. " +
      "Blocked until the deterministic planning sequence is complete: codebase intake recorded, all three deliberation rounds answered, validation steps derived, and a model picked for at least one (role, tag). " +
      "plan.md must cover the required sections (goal, in/out of scope, alternatives, implementation order, agent plan, validation plan, UI decisions or N/A, coordination) with real substance. " +
      "On approval this records approval in the manifest and advances the run into developing so spawnAgent can run; on decline it records changes_requested.",
    inputSchema: z.object({
      /** Optional one-line chat note shown alongside the Implement prompt. */
      note: z.string().optional(),
      question: z.string().optional(),
    }),
    execute: async (input) => withHeartbeat(ctx, svc, async () => {
      if (!universalOpts.onAskUser) {
        return {
          ok: false as const,
          error: "no_ask_user_handler",
          message: "requestPlanApproval requires an onAskUser handler — none configured.",
        };
      }
      // Step 1 — validate the deterministic planning sequence without mutating
      // ready state yet. Structural plan.md readiness runs before the ready
      // manifest transition so failed approval attempts leave planning intact.
      const planningReady = await svc.checkPlanningReady(ctx.runId, ctx.bundlePath);
      if (!planningReady.ok) {
        return {
          ok: false as const,
          error: planningReady.error,
          missing: planningReady.missing,
          message:
            planningReady.error === "planning_incomplete"
              ? `Cannot request approval yet — ${planningReady.message}. Use recordCodebaseIntake, askPlanningRound (functional → UI → extras), derive validation steps, and pick models first.`
              : planningReady.message,
        };
      }
      // Step 2 — structural readiness over the live plan.md + manifest state.
      let bundle;
      try {
        bundle = await svc.bundleRead(ctx.runId, ctx.bundlePath);
      } catch (err) {
        return { ok: false as const, error: "bundle_read_failed", message: errorMessage(err) };
      }
      const readiness = assessPlanReadiness(bundle.manifest, bundle.planMd);
      if (!readiness.ok) {
        return {
          ok: false as const,
          error: "plan_not_ready",
          missing: readiness.missing,
          message:
            "plan.md is not ready for approval. Address: " +
            readiness.missing.map((entry) => `${entry.label} — ${entry.message}`).join(" "),
        };
      }
      const ready = await svc.markPlanningReady(ctx.runId, ctx.bundlePath);
      if (!ready.ok) {
        return {
          ok: false as const,
          error: ready.error,
          missing: ready.missing,
          message:
            ready.error === "planning_incomplete"
              ? `Cannot request approval yet — ${ready.message}. Use recordCodebaseIntake, askPlanningRound (functional → UI → extras), derive validation steps, and pick models first.`
              : ready.message,
        };
      }
      const planContentHash = hashPlanContent(bundle.planMd);
      // Step 3 — surface the Implement button. The desktop renderer approves
      // the live plan narrative in the sidebar; mobile/TUI clients receive the
      // same plan.md bytes here because they do not have that sidebar.
      let response: Awaited<ReturnType<NonNullable<UniversalToolSetOptions["onAskUser"]>>>;
      try {
        response = await universalOpts.onAskUser({
          title: "Plan ready",
          body: [input.note?.trim(), bundle.planMd].filter(Boolean).join("\n\n"),
          question:
            input.question ??
            "Review the plan on the sidebar. Keep refining in chat if anything should change, or click Implement to start the build.",
          pendingInputKind: "plan_approval",
          providerMetadata: {
            orchestrationPlanApproval: true,
            planContentHash,
            planContent: bundle.planMd,
          },
        });
      } catch (err) {
        let resetError: string | undefined;
        try {
          const resetRes = await svc.setPlanApprovalState(ctx.runId, ctx.bundlePath, {
            state: "changes_requested",
            planContentHash,
          });
          if (!resetRes.ok) resetError = resetRes.message;
        } catch (resetErr) {
          resetError = errorMessage(resetErr);
        }
        return {
          ok: false as const,
          error: "approval_prompt_failed",
          message: "Plan is ready, but ADE could not surface the approval prompt. Request approval again.",
          detail: errorMessage(err),
          ...(resetError ? { resetError } : {}),
        };
      }
      const result = typeof response === "string"
        ? { answer: response, decision: undefined as string | undefined, responseText: undefined as string | undefined }
        : response;
      const approved = result.decision === "accept" || result.decision === "accept_for_session";
      if (!approved) {
        // Record changes_requested so the panel's re-approval diff can anchor on
        // the bytes the user last reviewed.
        const rejectRes = await svc.setPlanApprovalState(ctx.runId, ctx.bundlePath, {
          state: "changes_requested",
          planContentHash,
        });
        if (!rejectRes.ok) {
          return {
            ok: false as const,
            error: "manifest_patch_failed",
            message: "Plan changes were requested, but ADE could not record that decision in the manifest.",
            detail: rejectRes.message,
          };
        }
        return {
          ok: false as const,
          error: "plan_rejected",
          decision: result.decision ?? "decline",
          message: result.answer || result.responseText || "User did not approve the plan.",
        };
      }
      // Step 4 — record approval for the exact plan bytes surfaced above.
      // If plan.md changes while the pending input is open, those new bytes
      // must go through a fresh approval request instead of inheriting this one.
      let approvalBundle;
      try {
        approvalBundle = await svc.bundleRead(ctx.runId, ctx.bundlePath);
      } catch (err) {
        return { ok: false as const, error: "bundle_read_failed", message: errorMessage(err) };
      }
      const currentPlanContentHash = hashPlanContent(approvalBundle.planMd);
      if (currentPlanContentHash !== planContentHash) {
        const changedRes = await svc.setPlanApprovalState(ctx.runId, ctx.bundlePath, {
          state: "changes_requested",
          planContentHash,
        });
        if (!changedRes.ok) {
          return {
            ok: false as const,
            error: "manifest_patch_failed",
            message: "Plan changed after approval, but ADE could not record that it needs reapproval.",
            detail: changedRes.message,
          };
        }
        return {
          ok: false as const,
          error: "plan_changed_after_review",
          reviewedPlanContentHash: planContentHash,
          currentPlanContentHash,
          message:
            "plan.md changed while the approval request was open. Review the updated plan and request approval again.",
        };
      }
      const approvalRes = await svc.setPlanApprovalState(ctx.runId, ctx.bundlePath, {
        state: "approved",
        sessionId: ctx.sessionId,
        planContentHash,
      });
      if (!approvalRes.ok) {
        return {
          ok: false as const,
          error: approvalRes.error,
          missing: approvalRes.missing,
          message: approvalRes.message,
        };
      }
      return {
        ok: true as const,
        approvedAt: approvalRes.manifest.leadState.planApprovedAt,
        etag: approvalRes.etag,
      };
    }),
  });
}

function createClaimTaskTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
) {
  return tool({
    description:
      "Claim a task before touching files. Default lease is 30 minutes. " +
      "Heartbeats are automatic; release with `releaseTask` after required validation runs are recorded. " +
      "Validators may only claim validation tasks.",
    inputSchema: z.object({
      taskId: z.string().min(1),
      leaseMs: z
        .number()
        .int()
        .positive()
        .max(24 * 60 * 60 * 1000)
        .optional(),
    }),
    execute: async (input) => {
      return withMutationSideEffects({
        ctx,
        svc,
        chat,
        notifyText: `${ctx.role} ${ctx.sessionId} claimed task ${input.taskId}.`,
        taskId: input.taskId,
        fn: async () => {
          const leaseMs = input.leaseMs ?? 30 * 60 * 1000;
          // Validator-only: refuse non-validation tasks (best-effort surface
          // check — server has the canonical check on patch).
          if (ctx.role === "validator") {
            const manifest = manifestOrThrow(svc, ctx.runId);
            const task = manifest.tasks.find((t) => t.id === input.taskId);
            if (task && task.phaseId !== "validating") {
              return {
                ok: false as const,
                error: "validator_non_validation_task",
                message: `validators may only claim validation tasks (task ${input.taskId} is in phase ${task.phaseId})`,
              };
            }
          }
          try {
            const res = await svc.claimTask(
              {
                runId: ctx.runId,
                taskId: input.taskId,
                sessionId: ctx.sessionId,
                leaseMs,
              },
              ctx.bundlePath,
            );
            return res;
          } catch (err) {
            return {
              ok: false as const,
              error: "claim_failed",
              message: errorMessage(err),
            } as const;
          }
        },
      });
    },
  });
}

function createReleaseTaskTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
) {
  return tool({
    description:
      "Release a previously claimed task by setting its terminal status. " +
      "Use this to hand the task back to the lead (status=done/failed/review).",
    inputSchema: z.object({
      taskId: z.string().min(1),
      status: z.enum(TASK_STATUS_VALUES),
    }),
    execute: async (input) => {
      return withMutationSideEffects({
        ctx,
        svc,
        chat,
        notifyText: `${ctx.role} ${ctx.sessionId} released task ${input.taskId} as ${input.status}.`,
        taskId: input.taskId,
        // A terminal release (done/failed by a worker/validator) already enqueues
        // a structured `completion` entry to the lead. Suppress the generic
        // `lead_status` ping for that transition so the lead is notified once.
        suppressLeadNotify: (result) =>
          Boolean(
            result &&
              typeof result === "object" &&
              "completionEnqueued" in result &&
              (result as { completionEnqueued?: boolean }).completionEnqueued,
          ),
        fn: async () => {
          try {
            const res = await svc.releaseTask(
              {
                runId: ctx.runId,
                taskId: input.taskId,
                sessionId: ctx.sessionId,
                status: input.status as OrchestrationTaskStatus,
              },
              ctx.bundlePath,
            );
            return { ok: true as const, etag: res.etag, completionEnqueued: res.completionEnqueued };
          } catch (err) {
            return {
              ok: false as const,
              error: "release_failed",
              message: errorMessage(err),
            };
          }
        },
      });
    },
  });
}

function createRecordValidationRunTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
) {
  return tool({
    description:
      "Record a validation checklist run for a task/step after appending evidence to plan.md. " +
      "Workers may record only their own required per_worker gates; validators record their assigned validation gates. " +
      "For review-style concerns (dual_review_*, deep_maintainability), pass structured `findings` (severity + locus + fix) — the panel rolls these into a Blocker/High/Medium/Low table and each Blocker/High should carry a `regressionTestTarget`. " +
      "Call this before releaseTask(status='done') when the task has required validation gates.",
    inputSchema: z.object({
      taskId: z.string().min(1),
      stepId: z.string().min(1),
      status: z.enum(VALIDATION_RUN_STATUS_VALUES),
      notes: z.string().optional(),
      attachedEvidence: z.array(z.any()).optional(),
      findings: z
        .array(
          z.object({
            severity: z.enum(["blocker", "high", "medium", "low"]),
            title: z.string().min(1),
            locus: z.string().optional(),
            detail: z.string().optional(),
            fix: z.string().optional(),
            behaviorPreserving: z.boolean().optional(),
            regressionTestTarget: z.string().optional(),
          }),
        )
        .optional(),
      startedAt: z.string().optional(),
      endedAt: z.string().optional(),
    }),
    execute: async (input) => {
      return withMutationSideEffects({
        ctx,
        svc,
        chat,
        notifyText: `${ctx.role} ${ctx.sessionId} recorded validation ${input.stepId} for task ${input.taskId} as ${input.status}.`,
        taskId: input.taskId,
        fn: async () => {
          try {
            const res = await svc.recordValidationRun(
              {
                runId: ctx.runId,
                sessionId: ctx.sessionId,
                taskId: input.taskId,
                stepId: input.stepId,
                status: input.status,
                ...(input.notes ? { notes: input.notes } : {}),
                ...(input.attachedEvidence?.length
                  ? { attachedEvidence: input.attachedEvidence as EvidenceRef[] }
                  : {}),
                ...(input.findings?.length ? { findings: input.findings } : {}),
                ...(input.startedAt ? { startedAt: input.startedAt } : {}),
                ...(input.endedAt ? { endedAt: input.endedAt } : {}),
              },
              ctx.bundlePath,
            );
            return res;
          } catch (err) {
            return {
              ok: false as const,
              error: "record_validation_run_failed",
              message: errorMessage(err),
            };
          }
        },
      });
    },
  });
}

function createRegisterAssetTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
) {
  return tool({
    description:
      "Register an asset under the bundle's artifacts/ tree. Kinds: html_spec, screenshot, " +
      "test_log, doc, plus evidence kinds for externally-visible ADE actions — proof_artifact, " +
      "computer_use, video, pr_link, linear_issue, deeplink (SKILL §13). Pass `externalRef` to " +
      "point the asset at the real artifact (proof-drawer artifactId, PR number/url, Linear id, or deeplink url). " +
      "Path is relative to the bundle root; the file should already be on disk before calling.",
    inputSchema: z.object({
      relPath: z.string().min(1),
      kind: z.enum(ASSET_KIND_VALUES),
      version: z.number().int().positive().optional(),
      approval: z.enum(["pending", "approved", "rejected"]).optional(),
      externalRef: z
        .object({
          url: z.string().optional(),
          prNumber: z.number().int().optional(),
          linearId: z.string().optional(),
          artifactId: z.string().optional(),
        })
        .optional(),
    }),
    execute: async (input) => {
      return withMutationSideEffects({
        ctx,
        svc,
        chat,
        notifyText: `${ctx.role} ${ctx.sessionId} registered ${input.kind} asset ${input.relPath}.`,
        fn: async () => {
          try {
            const res = await svc.assetRegister(
              {
                runId: ctx.runId,
                relPath: input.relPath,
                kind: input.kind as OrchestrationAssetKind,
                version: input.version,
                approval: input.approval,
                ...(input.externalRef
                  ? { externalRef: input.externalRef as OrchestrationAssetExternalRef }
                  : {}),
                registeredBySessionId: ctx.sessionId,
              },
              ctx.bundlePath,
            );
            return { ok: true as const, asset: res.asset, etag: res.etag };
          } catch (err) {
            return {
              ok: false as const,
              error: "asset_register_failed",
              message: errorMessage(err),
            };
          }
        },
      });
    },
  });
}

function createAskUserForModelSelectionTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  universalOpts: UniversalToolSetOptions,
) {
  return tool({
    description:
      "Lead-only. Ask the user to pick a model for a (role, tag) pair via the ADE ModelPicker. " +
      "Unlocked only after codebase intake + the three deliberation rounds are recorded. " +
      "Use once per (role, tag) before spawning any worker on that tag. " +
      "Always include `workDescription` (one sentence on what this agent does) and, when known, `filesHint` (files it will touch) and `dependsOn` (tags/tasks it runs after) so the user can choose a fitting model.",
    inputSchema: z.object({
      role: z.enum(MODEL_SELECTION_ROLE_VALUES),
      tag: z.string().min(1),
      workDescription: z.string().min(1, "Describe in one sentence what this agent will do").optional(),
      filesHint: z.array(z.string().min(1)).optional(),
      dependsOn: z.array(z.string().min(1)).optional(),
      suggested: z
        .object({
          provider: z.string(),
          modelId: z.string(),
          reasoningEffort: z.string().nullable().optional(),
          fastMode: z.boolean().optional(),
        })
        .partial({ reasoningEffort: true, fastMode: true })
        .optional(),
    }),
    execute: async (input) => {
      return withHeartbeat(ctx, svc, async () => {
        if (input.role !== "worker" && input.role !== "validator") {
          return {
            ok: false as const,
            error: "unsupported_model_role",
            message: "Model selection is only supported for spawnable worker or validator roles.",
          };
        }
        const manifest = manifestOrThrow(svc, ctx.runId);
        if (manifest.currentPhase !== "planning") {
          return {
            ok: false as const,
            error: "not_planning",
            message:
              "Model selection must happen during planning — call this before requestPlanApproval, not after.",
          };
        }
        if (!isPlanningReadyForModelSelection(manifest)) {
          return {
            ok: false as const,
            error: "planning_not_ready",
            message:
              "Model selection is locked until codebase intake plus either all three deliberation rounds " +
              "or the condensed light-plan path are recorded. Call recordCodebaseIntake, then either " +
              "askPlanningRound for functional → UI → extras or enterLightPlan, then pick models.",
          };
        }
        if (!universalOpts.onAskUser) {
          return {
            ok: false as const,
            error: "no_ask_user_handler",
            message:
              "askUserForModelSelection requires an onAskUser handler — none configured.",
          };
        }
        const friendlyRole = input.role;
        const workDesc = input.workDescription?.trim();
        try {
          const response = await universalOpts.onAskUser({
            title: `Pick a model for the "${input.tag}" ${friendlyRole}`,
            body: workDesc
              ? workDesc
              : input.suggested
                ? `Suggested: ${input.suggested.provider}/${input.suggested.modelId}`
                : undefined,
            question: `Which model should the "${input.tag}" ${friendlyRole} use?`,
            pendingInputKind: "model_selection",
            providerMetadata: {
              role: input.role,
              tag: input.tag,
              workDescription: workDesc ?? null,
              ...(input.filesHint?.length ? { filesHint: input.filesHint } : {}),
              ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
              ...(input.suggested ? { suggested: input.suggested } : {}),
            },
          });
          const answer = typeof response === "string" ? response : (response.answer ?? "");
          const decision = typeof response === "string" ? undefined : response.decision;
          if (decision === "cancel" || decision === "decline") {
            return {
              ok: false as const,
              error: "model_selection_cancelled",
              role: input.role,
              tag: input.tag,
              raw: answer,
            };
          }
          let parsed: ModelSelection | null = null;
          try {
            parsed = JSON.parse(answer) as ModelSelection;
          } catch {
            // Plain text — let the lead skill parse it.
          }
          if (!parsed?.provider || !parsed.modelId) {
            return { ok: true as const, role: input.role, tag: input.tag, selection: null, raw: answer };
          }

          const writeRouting = async (manifest: OrchestrationManifest, summary: string) =>
            svc.manifestPatch(
              {
                runId: ctx.runId,
                ifMatchEtag: manifest.etag,
                actorRole: "lead",
                actorSessionId: ctx.sessionId,
                summary,
                patches: [{
                  op: "add",
                  path: "/modelRouting/byRoleTag",
                  value: {
                    ...(manifest.modelRouting.byRoleTag ?? {}),
                    [`${input.role}:${input.tag}`]: parsed,
                  },
                }],
              },
              ctx.bundlePath,
            );
          let manifest = manifestOrThrow(svc, ctx.runId);
          let patchRes = await writeRouting(manifest, "model selection");
          if (!patchRes.ok && patchRes.error === "etag_conflict") {
            manifest = patchRes.manifest;
            patchRes = await writeRouting(manifest, "model selection (retry)");
          }
          if (!patchRes.ok) {
            return {
              ok: false as const,
              error: "model_routing_patch_failed",
              role: input.role,
              tag: input.tag,
              selection: parsed,
              raw: answer,
            };
          }
          return {
            ok: true as const,
            role: input.role,
            tag: input.tag,
            selection: parsed,
            raw: answer,
            etag: patchRes.etag,
          };
        } catch (err) {
          return {
            ok: false as const,
            error: "ask_user_failed",
            message: errorMessage(err),
          };
        }
      });
    },
  });
}

function createRecordCodebaseIntakeTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
) {
  return tool({
    description:
      "Lead-only. Record the /context-style codebase intake — the FIRST gated planning step. " +
      "Read the repo first (CLAUDE.md/README, package manifests, CI config, git log/diff, top-level layout), planAppend a human-readable 'Codebase intake' section, then log the structured summary here. " +
      "Set `touchesUiSurface: false` when the change has no user-facing UI — the UI design round is then auto-skipped (recorded as N/A) instead of forcing an empty round. " +
      "Pass `goalSource` when you derived the goal from an attached Linear issue / PR / goal.md, so the run records where the goal came from. " +
      "askPlanningRound, model selection, and approval are all locked until this is recorded.",
    inputSchema: z.object({
      projectShape: z.string().min(1, "describe the project shape + primary languages"),
      testStack: z.string().min(1, "describe the test frameworks/globs, or 'none detected'"),
      inFlightWork: z.string().min(1, "summarize git log/diff in-flight work, or 'fresh lane'"),
      ancillarySurfaces: z.array(z.string().min(1)).optional(),
      docMap: z.string().optional(),
      ciGates: z.array(z.string().min(1)).optional(),
      touchesUiSurface: z.boolean().optional(),
      goalSource: z
        .object({
          kind: z.enum(["linear", "pr", "goalMd", "user"]),
          ref: z.string().optional(),
        })
        .optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () => {
        const res = await svc.recordPlanningIntake(
          ctx.runId,
          ctx.bundlePath,
          {
            recordedAt: new Date().toISOString(),
            projectShape: input.projectShape,
            testStack: input.testStack,
            inFlightWork: input.inFlightWork,
            ancillarySurfaces: input.ancillarySurfaces ?? [],
            ...(input.docMap ? { docMap: input.docMap } : {}),
            ciGates: input.ciGates ?? [],
            ...(typeof input.touchesUiSurface === "boolean"
              ? { touchesUiSurface: input.touchesUiSurface }
              : {}),
          },
          input.goalSource
            ? {
                goalSource: {
                  kind: input.goalSource.kind,
                  ...(input.goalSource.ref ? { ref: input.goalSource.ref } : {}),
                },
              }
            : undefined,
        );
        if (!res.ok) {
          return { ok: false as const, error: res.error, missing: res.missing, message: res.message };
        }
        return {
          ok: true as const,
          etag: res.etag,
          nextStage: res.manifest.leadState.planning?.stage ?? "round_functional",
          uiRoundSkipped: (res.manifest.leadState.planning?.autoSkippedRounds ?? []).includes("ui"),
        };
      }),
  });
}

function roundTitle(kind: PlanningRoundKind): string {
  if (kind === "functional") return "Functional requirements";
  if (kind === "ui") return "UI design";
  return "Extras";
}

function summarizePlanningRoundAnswer(
  options: PlanningRoundOption[] | undefined,
  selectedOptionIds: string[],
  freeText: string,
  fallbackSummary: string,
): string {
  const optionLabelById = new Map((options ?? []).map((option) => [option.id, option.label]));
  const selectedLabels = selectedOptionIds.map((id) => optionLabelById.get(id) ?? id);
  const parts: string[] = [];
  if (selectedLabels.length) {
    parts.push(`Selected: ${selectedLabels.join(", ")}`);
  }
  const flattenedFreeText = freeText.replace(/\s+/g, " ").trim();
  if (flattenedFreeText) {
    const clipped = flattenedFreeText.length > 240
      ? `${flattenedFreeText.slice(0, 237)}...`
      : flattenedFreeText;
    parts.push(`Notes: ${clipped}`);
  }
  return parts.join(". ") || fallbackSummary.trim();
}

function createAskPlanningRoundTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  universalOpts: UniversalToolSetOptions,
) {
  return tool({
    description:
      "Lead-only. Run one /plan deliberation round by asking the user a question with concrete options, then record the answer as gated planning state. " +
      "Round order is enforced: functional → ui → extras. For the UI round, put an ASCII wireframe in each option's `preview`. The extras round should usually be multiSelect. " +
      "For new scope discovered mid-plan, set `cascadedFrom` to run a focused mini-round without disturbing the locked sequence (the /plan cascade rule). " +
      "Provide `lockedSummary` — your one-line locked outcome — which is recorded with the user's answer.",
    inputSchema: z.object({
      kind: z.enum(["functional", "ui", "extras"]),
      question: z.string().min(1),
      header: z.string().optional(),
      options: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            description: z.string().optional(),
            preview: z.string().optional(),
          }),
        )
        .optional(),
      multiSelect: z.boolean().optional(),
      allowFreeText: z.boolean().optional(),
      lockedSummary: z.string().min(1, "Provide your locked one-line outcome for this round"),
      cascadedFrom: z.string().optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () => {
        const manifest = manifestOrThrow(svc, ctx.runId);
        if (manifest.currentPhase !== "planning") {
          return {
            ok: false as const,
            error: "not_planning",
            message: "deliberation rounds only run during the planning phase",
          };
        }
        if (!universalOpts.onAskUser) {
          return {
            ok: false as const,
            error: "no_ask_user_handler",
            message: "askPlanningRound requires an onAskUser handler — none configured.",
          };
        }
        const currentStage = manifest.leadState.planning?.stage;
        const expectedStage: Record<PlanningRoundKind, PlanningStage> = {
          functional: "round_functional",
          ui: "round_ui",
          extras: "round_extras",
        };
        if (input.cascadedFrom?.trim()) {
          if (!currentStage || currentStage === "intake") {
            return {
              ok: false as const,
              error: "stage_conflict",
              message: "cannot ask a cascade round before codebase intake",
            };
          }
        } else if (currentStage !== expectedStage[input.kind]) {
          return {
            ok: false as const,
            error: "stage_conflict",
            message: `the ${input.kind} round can only be asked at stage ${expectedStage[input.kind]}; current stage is ${currentStage ?? "unknown"}`,
          };
        }
        const questionId = `round-${input.kind}`;
        const askedAt = new Date().toISOString();
        const multiSelect = input.multiSelect ?? input.kind === "extras";
        const response = await universalOpts.onAskUser({
          title: `${roundTitle(input.kind)} — deliberation`,
          question: input.question,
          pendingInputKind: "structured_question",
          providerMetadata: {
            orchestrationPlanningRound: true,
            kind: input.kind,
            ...(input.cascadedFrom ? { cascadedFrom: input.cascadedFrom } : {}),
          },
          questions: [
            {
              id: questionId,
              ...(input.header ? { header: input.header } : {}),
              question: input.question,
              multiSelect,
              allowsFreeform: input.allowFreeText ?? true,
              ...(input.options?.length
                ? {
                    options: input.options.map((o) => ({
                      label: o.label,
                      value: o.id,
                      ...(o.description ? { description: o.description } : {}),
                      ...(o.preview ? { preview: o.preview, previewFormat: "markdown" as const } : {}),
                    })),
                  }
                : {}),
            },
          ],
        });
        const result =
          typeof response === "string"
            ? {
                answer: response,
                answers: undefined as Record<string, string[]> | undefined,
                responseText: undefined as string | null | undefined,
                decision: undefined as string | undefined,
              }
            : response;
        if (result.decision === "cancel" || result.decision === "decline") {
          return {
            ok: false as const,
            error: "round_cancelled",
            message: "User dismissed the deliberation round without answering.",
          };
        }
        const answerValues = result.answers?.[questionId] ?? [];
        const optionIds = new Set((input.options ?? []).map((o) => o.id));
        const selectedOptionIds = input.options?.length
          ? answerValues.filter((value) => optionIds.has(value))
          : [];
        const customAnswerText = answerValues
          .filter((value) => !optionIds.has(value))
          .map((value) => value.trim())
          .filter(Boolean)
          .join("\n");
        const responseText =
          typeof result.responseText === "string" ? result.responseText.trim() : "";
        const fallbackAnswer =
          answerValues.length ? "" : (result.answer ?? "").trim();
        const freeText = [responseText, customAnswerText, fallbackAnswer]
          .filter(Boolean)
          .join("\n\n");
        const round: PlanningRoundRecord = {
          id: "",
          kind: input.kind,
          askedAt,
          question: input.question,
          ...(input.options?.length ? { options: input.options as PlanningRoundOption[] } : {}),
          ...(multiSelect ? { multiSelect: true } : {}),
          ...(selectedOptionIds.length ? { selectedOptionIds } : {}),
          ...(freeText ? { freeText } : {}),
          lockedSummary: summarizePlanningRoundAnswer(
            input.options as PlanningRoundOption[] | undefined,
            selectedOptionIds,
            freeText,
            input.lockedSummary,
          ),
          ...(input.cascadedFrom ? { cascadedFrom: input.cascadedFrom } : {}),
          answeredAt: new Date().toISOString(),
        };
        const res = await svc.recordPlanningRound(ctx.runId, ctx.bundlePath, round);
        if (!res.ok) {
          return { ok: false as const, error: res.error, message: res.message };
        }
        return {
          ok: true as const,
          etag: res.etag,
          kind: input.kind,
          selectedOptionIds,
          freeText: freeText || undefined,
        };
      }),
  });
}

function createProposeValidationStepsTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
) {
  return tool({
    description:
      "Lead-only. Return a suggested set of validationStrategy.steps derived from the recorded codebase intake — the /quality dual-review + /test stewardship + parity concerns, seeded with codebase-specific prompts. " +
      "Review and edit them, then write the steps you want via manifestPatch to /validationStrategy/steps and reference their ids from each task's validationGate. Requires codebase intake first.",
    inputSchema: z.object({}),
    execute: async () =>
      withHeartbeat(ctx, svc, async () => {
        const manifest = manifestOrThrow(svc, ctx.runId);
        if (!manifest.leadState.planning?.intake) {
          return {
            ok: false as const,
            error: "no_intake",
            message: "Record codebase intake first (recordCodebaseIntake) — validation derivation reads the intake.",
          };
        }
        const steps = deriveSuggestedValidationSteps(manifest);
        return {
          ok: true as const,
          steps,
          note: "Suggestions only — review, edit, and write the steps you want via manifestPatch to /validationStrategy/steps.",
        };
      }),
  });
}

function createRecoverStaleTasksTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  chat: OrchestrationAgentChatHandle,
) {
  return tool({
    description:
      "Lead-only. Crash-resume: recover tasks whose worker died or whose claim lease expired. " +
      "Resets claimed/in-progress tasks with an expired lease back to pending and clears the assignee so you can re-dispatch them. Use after a worker crash or a long stall.",
    inputSchema: z.object({}),
    execute: async () =>
      withHeartbeat(ctx, svc, async () => {
        const res = await svc.releaseStaleClaims(ctx.runId, ctx.bundlePath);
        if (!res.ok) {
          return { ok: false as const, error: res.error, message: res.message };
        }
        await drainOutbox(svc, chat, ctx);
        return { ok: true as const, recovered: res.recovered, etag: res.etag };
      }),
  });
}

function createRecordPlanningOverrideTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
) {
  return tool({
    description:
      "Lead-only. Record a user-authority override that waives part of the deterministic planning sequence " +
      "(e.g. the user says 'skip the UI round — no UI here' or 'skip validation for this run'). " +
      "The service logs matching UserOverrideEntry records from the literal skipReason; skipped rounds are only treated as satisfied when those entries exist.",
    inputSchema: z.object({
      skippedRounds: z.array(z.enum(["functional", "ui", "extras"])).optional(),
      skipReason: z.string().optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () => {
        const res = await svc.recordPlanningOverride(ctx.runId, ctx.bundlePath, {
          ...(input.skippedRounds?.length
            ? { skippedRounds: input.skippedRounds as PlanningRoundKind[] }
            : {}),
          ...(input.skipReason ? { skipReason: input.skipReason } : {}),
        });
        if (!res.ok) {
          return { ok: false as const, error: res.error, message: res.message };
        }
        return { ok: true as const, etag: res.etag };
      }),
  });
}

function createOfferLightPlanTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  universalOpts: UniversalToolSetOptions,
) {
  return tool({
    description:
      "Lead-only. Offer the lighter planning path for a small / low-risk / single-worker goal. " +
      "Asks the user, in plain words, whether to skip the heavy planning rounds and do a simpler plan, or continue with the full one. " +
      "On acceptance the run takes the condensed path (one plan → single approval → ready) with the same approval-gate rigor. " +
      "Only offer this after codebase intake and before any deliberation round is recorded. You can expand back to the full plan any time before approval.",
    inputSchema: z.object({
      /** Optional plain-language framing shown above the choice. */
      note: z.string().optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () => {
        const manifest = manifestOrThrow(svc, ctx.runId);
        if (manifest.currentPhase !== "planning") {
          return {
            ok: false as const,
            error: "not_planning",
            message: "the lighter path can only be offered during planning",
          };
        }
        if (!universalOpts.onAskUser) {
          return {
            ok: false as const,
            error: "no_ask_user_handler",
            message: "offerLightPlan requires an onAskUser handler — none configured.",
          };
        }
        const questionId = "light-plan-choice";
        const response = await universalOpts.onAskUser({
          title: "How much planning?",
          ...(input.note?.trim() ? { body: input.note.trim() } : {}),
          question:
            "This looks like a lighter task — want me to skip the heavy planning rounds and do a simpler plan, or continue with the full one?",
          pendingInputKind: "structured_question",
          providerMetadata: { orchestrationLightPlanOffer: true },
          questions: [
            {
              id: questionId,
              question:
                "This looks like a lighter task — want me to skip the heavy planning rounds and do a simpler plan, or continue with the full one?",
              multiSelect: false,
              allowsFreeform: false,
              options: [
                {
                  label: "Do a simpler plan",
                  value: "light",
                  description: "Skip the heavy rounds — one condensed plan, then approval.",
                },
                {
                  label: "Continue with the full plan",
                  value: "full",
                  description: "Keep the full functional / UI / extras rounds.",
                },
              ],
            },
          ],
        });
        const { answer, dismissed } = readSingleChoice(response, questionId);
        if (dismissed) {
          return { ok: true as const, chosen: "full" as const, note: "user dismissed — staying on the full plan" };
        }
        if (answer !== "light") {
          return { ok: true as const, chosen: "full" as const };
        }
        const res = await svc.enterLightPlan(ctx.runId, ctx.bundlePath);
        if (!res.ok) {
          return { ok: false as const, error: res.error, message: res.message };
        }
        return { ok: true as const, chosen: "light" as const, etag: res.etag };
      }),
  });
}

function createExpandToFullPlanTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
) {
  return tool({
    description:
      "Lead-only. Expand a condensed light plan back to the full deliberation sequence (functional → UI → extras). " +
      "Only allowed before the plan is approved. Use this if the 'simpler plan' turns out to need the full rounds after all.",
    inputSchema: z.object({}),
    execute: async () =>
      withHeartbeat(ctx, svc, async () => {
        const res = await svc.expandToFullPlan(ctx.runId, ctx.bundlePath);
        if (!res.ok) {
          return { ok: false as const, error: res.error, message: res.message };
        }
        return {
          ok: true as const,
          etag: res.etag,
          nextStage: res.manifest.leadState.planning?.stage,
        };
      }),
  });
}

function createChooseFinishingModeTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  universalOpts: UniversalToolSetOptions,
) {
  return tool({
    description:
      "Lead-only. Ask the dedicated finishing question during planning (both the full and lighter paths): " +
      "when this run finishes, stop at validated code in the worktree, or push the branch + open a PR + update Linear? " +
      "Records the choice in manifest.finishing. When the choice is 'pr', after validation passes you spawn a finishing worker to push, open the PR, update Linear, and register the pr_link / linear_issue / deeplink assets.",
    inputSchema: z.object({
      /** Optional plain-language framing shown above the choice. */
      note: z.string().optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () => {
        if (!universalOpts.onAskUser) {
          return {
            ok: false as const,
            error: "no_ask_user_handler",
            message: "chooseFinishingMode requires an onAskUser handler — none configured.",
          };
        }
        const questionId = "finishing-mode";
        const response = await universalOpts.onAskUser({
          title: "When this run finishes",
          ...(input.note?.trim() ? { body: input.note.trim() } : {}),
          question:
            "When this run finishes: stop at validated code in the worktree, or push the branch + open a PR + update Linear?",
          pendingInputKind: "structured_question",
          providerMetadata: { orchestrationFinishingQuestion: true },
          questions: [
            {
              id: questionId,
              question:
                "When this run finishes: stop at validated code in the worktree, or push the branch + open a PR + update Linear?",
              multiSelect: false,
              allowsFreeform: false,
              options: [
                {
                  label: "Stop at the worktree",
                  value: "worktree",
                  description: "Leave validated code in the lane worktree — no push, no PR.",
                },
                {
                  label: "Push + open a PR",
                  value: "pr",
                  description: "Push the branch, open/update a PR, and update the attached Linear issue.",
                },
              ],
            },
          ],
        });
        const { answer, dismissed } = readSingleChoice(response, questionId);
        if (dismissed) {
          return {
            ok: false as const,
            error: "finishing_unanswered",
            message: "User dismissed the finishing question without answering.",
          };
        }
        const mode = answer === "pr" ? "pr" : "worktree";
        const res = await svc.recordFinishingChoice(ctx.runId, ctx.bundlePath, { mode });
        if (!res.ok) {
          return { ok: false as const, error: res.error, message: res.message };
        }
        return { ok: true as const, mode, etag: res.etag };
      }),
  });
}

function createRecordScheduledFollowupTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
) {
  return tool({
    description:
      "Record a durable follow-up scheduled for after the run (e.g. 're-check CI in 30m'). " +
      "Do the actual scheduling with `ade actions run chat.createScheduledWork` from a shell, then record it here with the returned scheduledWorkId so the bundle owns the durable intent (manifest.scheduledFollowups).",
    inputSchema: z.object({
      summary: z.string().min(1, "plain-language description of the follow-up"),
      scheduledFor: z.string().optional(),
      scheduledWorkId: z.string().optional(),
      status: z.enum(["pending", "scheduled", "fired", "cancelled"]).optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () => {
        const res = await svc.recordScheduledFollowup(ctx.runId, ctx.bundlePath, {
          summary: input.summary,
          ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
          ...(input.scheduledWorkId ? { scheduledWorkId: input.scheduledWorkId } : {}),
          ...(input.status ? { status: input.status } : {}),
        });
        if (!res.ok) {
          return { ok: false as const, error: res.error, message: res.message };
        }
        return { ok: true as const, etag: res.etag };
      }),
  });
}

// ---------------------------------------------------------------------------
// Lead read-only ADE capability tools
// ---------------------------------------------------------------------------

const LEAD_READ_TOOL_NAMES = [
  "searchWorkspace",
  "readLinearIssue",
  "readPr",
  "listProofArtifacts",
  "mintDeeplink",
] as const;

function unavailableResult(capability: string): OrchestrationLeadReadResult {
  return {
    ok: false,
    error: "unavailable",
    message: `${capability} is not available in this ADE runtime.`,
  };
}

/**
 * Wrap a lead read backing so it (a) short-circuits to a clean "unavailable"
 * result when the service is not wired, and (b) never throws — any error is
 * flattened into a structured result. Read-only by construction.
 */
async function runLeadRead(
  capability: string,
  backing: (() => Promise<OrchestrationLeadReadResult>) | undefined,
): Promise<OrchestrationLeadReadResult> {
  if (!backing) return unavailableResult(capability);
  try {
    return await backing();
  } catch (err) {
    return {
      ok: false,
      error: "read_failed",
      message: `${capability} failed: ${errorMessage(err)}`,
    };
  }
}

function createLeadReadTools(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  services: OrchestrationLeadReadServices | undefined,
): OrchestrationToolMap {
  const tools: OrchestrationToolMap = {};

  tools.searchWorkspace = tool({
    description:
      "Lead-only, read-only. Universal search across everything in ADE (chat transcripts, terminal " +
      "scrollback, PRs, commits, branches, Linear issues, proof artifacts, files, lanes) to inform planning. " +
      "Returns matches with deeplinks. Never mutates.",
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
      /** Restrict to a lane; omit to search this run's lane / whole project. */
      laneId: z.string().optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () =>
        runLeadRead("searchWorkspace", services?.searchWorkspace
          ? () => services.searchWorkspace!({
              query: input.query,
              ...(input.limit ? { limit: input.limit } : {}),
              ...(input.laneId ? { laneId: input.laneId } : {}),
            })
          : undefined),
      ),
  });

  tools.readLinearIssue = tool({
    description:
      "Lead-only, read-only. Read an attached/linked Linear issue (title, description, state, comments) " +
      "to derive the goal and acceptance criteria. Never mutates the issue.",
    inputSchema: z.object({
      issueId: z.string().min(1, "Linear issue id or identifier (e.g. ADE-123)"),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () =>
        runLeadRead("readLinearIssue", services?.readLinearIssue
          ? () => services.readLinearIssue!({ issueId: input.issueId })
          : undefined),
      ),
  });

  tools.readPr = tool({
    description:
      "Lead-only, read-only. Read PR summary/status/checks/review state for the lane (or a specific PR id) " +
      "when planning a fix-forward run. Never pushes, opens, merges, or comments.",
    inputSchema: z.object({
      prId: z.string().optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () =>
        runLeadRead("readPr", services?.readPr
          ? () => services.readPr!({ ...(input.prId ? { prId: input.prId } : {}) })
          : undefined),
      ),
  });

  tools.listProofArtifacts = tool({
    description:
      "Lead-only, read-only. List proof-drawer / computer-use artifacts (screenshots, recordings, captures) " +
      "so the lead can reason about the evidence workers/validators produced. Never mutates.",
    inputSchema: z.object({
      limit: z.number().int().positive().max(200).optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () =>
        runLeadRead("listProofArtifacts", services?.listProofArtifacts
          ? () => services.listProofArtifacts!({ ...(input.limit ? { limit: input.limit } : {}) })
          : undefined),
      ),
  });

  tools.mintDeeplink = tool({
    description:
      "Lead-only, read-only. Mint a shareable ADE deeplink (side-effect-free) for a target — e.g. " +
      "`{ kind: 'lane', laneId }`, `{ kind: 'file', path, laneId? }`, `{ kind: 'commit', sha }`, " +
      "`{ kind: 'pr', repoOwner, repoName, prNumber }`, `{ kind: 'linear-issue', issueIdentifier }`. " +
      "Returns the ade:// and https:// forms. Nothing is created or changed.",
    inputSchema: z.object({
      target: z.record(z.string(), z.unknown()),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () =>
        runLeadRead("mintDeeplink", services?.mintDeeplink
          ? () => services.mintDeeplink!({ target: input.target })
          : undefined),
      ),
  });

  return tools;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type OrchestrationToolMap = Record<string, ExecutableTool>;

export function createOrchestrationToolSet(
  opts: OrchestrationToolSetOptions,
): OrchestrationToolMap {
  const {
    cwd,
    interactionMode,
    sessionContext,
    orchestrationService: svc,
    agentChatService: chat,
    universal,
    leadReadServices,
  } = opts;

  // Base from the universal toolset. For lead, we strip all write/bash tools
  // and exitPlanMode — the lead is the planner/dispatcher, edits flow through
  // workers. For worker/validator we keep the full set, but inject the
  // orchestration sandbox config (bundle manifest/plan protected,
  // blockByDefault: true) so the worker bash tool refuses unknown commands.
  const effectiveUniversal: UniversalToolSetOptions =
    interactionMode === "orchestrator-lead"
      ? universal
      : {
          ...universal,
          sandboxConfig: buildOrchestrationSandboxConfig(
            sessionContext.bundlePath,
            universal.sandboxConfig,
          ),
          registerActiveBash: (controller) => {
            const unregisterUpstream = universal.registerActiveBash?.(controller);
            const unregisterCancellation = registerOrchestrationBashCancellation(
              svc,
              sessionContext,
              controller,
            );
            return () => {
              unregisterCancellation();
              if (typeof unregisterUpstream === "function") unregisterUpstream();
            };
          },
        };
  const universalTools = createUniversalToolSet(cwd, effectiveUniversal);
  const tools: OrchestrationToolMap = {};

  if (interactionMode === "orchestrator-lead") {
    for (const [name, t] of Object.entries(universalTools)) {
      if (LEAD_READ_ONLY_BASE.has(name)) {
        tools[name] = t as ExecutableTool;
      }
    }
  } else {
    // worker / validator: keep full universal toolset, including editFile,
    // writeFile, bash.
    for (const [name, t] of Object.entries(universalTools)) {
      tools[name] = t as ExecutableTool;
    }
  }

  // Orchestration tools per role.
  if (interactionMode === "orchestrator-lead") {
    tools.spawnAgent = createSpawnAgentTool(sessionContext, svc, chat);
    tools.messageAgent = createMessageAgentTool({
      ctx: sessionContext,
      chat,
      svc,
      restrictedIntents: false,
    });
    tools.getAgentTranscript = createGetAgentTranscriptTool(sessionContext, chat, svc);
    // Event-driven wait on worker/validator completion (no transcript polling).
    tools.awaitAgent = createAwaitAgentTool(sessionContext, svc);
    tools.manifestPatch = createManifestPatchTool(sessionContext, svc, chat);
    tools.planAppend = createPlanAppendTool(sessionContext, svc, chat);
    tools.planWrite = createPlanWriteTool(sessionContext, svc, chat);
    tools.requestPlanApproval = createRequestPlanApprovalTool(
      sessionContext,
      svc,
      universal,
    );
    tools.askUserForModelSelection = createAskUserForModelSelectionTool(
      sessionContext,
      svc,
      universal,
    );
    // Deterministic planning sequence (gated): intake → 3 rounds → ready.
    tools.recordCodebaseIntake = createRecordCodebaseIntakeTool(sessionContext, svc);
    tools.askPlanningRound = createAskPlanningRoundTool(sessionContext, svc, universal);
    tools.recordPlanningOverride = createRecordPlanningOverrideTool(sessionContext, svc);
    // Lifecycle: lighter plan path, finishing decision, durable follow-ups.
    tools.offerLightPlan = createOfferLightPlanTool(sessionContext, svc, universal);
    tools.expandToFullPlan = createExpandToFullPlanTool(sessionContext, svc);
    tools.chooseFinishingMode = createChooseFinishingModeTool(sessionContext, svc, universal);
    tools.recordScheduledFollowup = createRecordScheduledFollowupTool(sessionContext, svc);
    tools.proposeValidationSteps = createProposeValidationStepsTool(sessionContext, svc);
    tools.recoverStaleTasks = createRecoverStaleTasksTool(sessionContext, svc, chat);
    tools.registerAsset = createRegisterAssetTool(sessionContext, svc, chat);
    // Lead may claim tasks during the planning seed (and to pin "lead is
    // working on planning" semantics). Worker-only edits still gate on lead
    // not having editFile/writeFile/bash.
    tools.claimTask = createClaimTaskTool(sessionContext, svc, chat);
    tools.releaseTask = createReleaseTaskTool(sessionContext, svc, chat);
    tools.recordValidationRun = createRecordValidationRunTool(sessionContext, svc, chat);
    // Curated READ-ONLY ADE capability tools (search / Linear / PR / proof /
    // deeplinks). Each degrades to a clean "unavailable" result when its backing
    // service is not wired — they never throw and never mutate.
    Object.assign(tools, createLeadReadTools(sessionContext, svc, leadReadServices));
    return tools;
  }

  // Worker + validator share most of the orchestration tools; the server
  // enforces patch-path whitelists and per-role restrictions.
  tools.claimTask = createClaimTaskTool(sessionContext, svc, chat);
  tools.releaseTask = createReleaseTaskTool(sessionContext, svc, chat);
  tools.recordValidationRun = createRecordValidationRunTool(sessionContext, svc, chat);
  tools.manifestPatch = createManifestPatchTool(sessionContext, svc, chat);
  tools.planAppend = createPlanAppendTool(sessionContext, svc, chat);
  tools.messageAgent = createMessageAgentTool({
    ctx: sessionContext,
    chat,
    svc,
    restrictedIntents: true,
  });
  tools.getAgentTranscript = createGetAgentTranscriptTool(sessionContext, chat, svc);
  tools.registerAsset = createRegisterAssetTool(sessionContext, svc, chat);
  // The finishing worker may record a durable follow-up it scheduled.
  tools.recordScheduledFollowup = createRecordScheduledFollowupTool(sessionContext, svc);

  return tools;
}

// Re-export validators / types that the IPC layer and tests reuse.
export { validateSpawnBrief };
export type { OrchestrationSpawnAgentRequest };
