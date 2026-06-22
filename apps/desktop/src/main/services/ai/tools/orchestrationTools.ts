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
import { createUniversalToolSet, type UniversalToolSetOptions } from "./universalTools";
import type {
  EvidenceRef,
  ManifestPatchOp,
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
import type { createOrchestrationService } from "../../orchestration/orchestrationService";
import { validateSpawnBrief } from "../../orchestration/orchestrationService";
import {
  applyOrchestrationPermissionProfile,
  isOrchestrationPlanApproved,
  isPlanningReadyForModelSelection,
  resolveOrchestrationModel,
} from "../../orchestration/runtimeProfile";

import { assessPlanReadiness } from "./orchestrationPlanQuality";
import { deriveSuggestedValidationSteps } from "./orchestrationValidationDerivation";
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
] as const;
const MODEL_SELECTION_ROLE_VALUES = ["worker", "validator"] as const;

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
            orchestrationTag: input.tag,
            orchestrationStepId: input.stepId,
            orchestrationBundlePath: ctx.bundlePath,
            goal: input.goalSummary,
          });
        } catch (err) {
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
        const buildPatchRequest = (ifMatchEtag: string, summary: string) => ({
          runId: ctx.runId,
          ifMatchEtag,
          actorRole: "lead" as const,
          actorSessionId: ctx.sessionId,
          summary,
          patches: [patch],
        });
        let patchRes = await svc.manifestPatch(
          buildPatchRequest(manifest.etag, "spawn agent"),
          ctx.bundlePath,
        );
        if (!patchRes.ok && patchRes.error === "etag_conflict") {
          patchRes = await svc.manifestPatch(
            buildPatchRequest(patchRes.manifest.etag, "spawn agent (retry)"),
            ctx.bundlePath,
          );
        }
        if (!patchRes.ok) {
          // Clean up the orphaned session since manifest registration failed
          try {
            await chat.deleteSession({ sessionId: created.id });
          } catch (_cleanupErr) {
            // Best-effort cleanup — log suppressed to avoid masking the root error
          }
          return {
            ok: false as const,
            error: "manifest_patch_failed",
            message:
              "Created session but failed to append agent row (session cleaned up): " +
              ("error" in patchRes
                ? String(patchRes.error)
                : "unknown"),
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
        try {
          await chat.sendMessage(
            {
              sessionId: created.id,
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
            { awaitDispatch: false },
          );
        } catch (err) {
          return {
            ok: true as const,
            sessionId: created.id,
            etag: patchRes.etag,
            warning: `agent spawned but initial message delivery failed: ${errorMessage(err)}`,
          };
        }
        return {
          ok: true as const,
          sessionId: created.id,
          etag: patchRes.etag,
        };
      });
    },
  });
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
        if (intent === "cancellation") {
          const cancelledAt = new Date().toISOString();
          const buildCancellationPatch = (
            current: OrchestrationManifest,
            summary: string,
          ) => ({
            runId: args.ctx.runId,
            ifMatchEtag: current.etag,
            actorRole: args.ctx.role,
            actorSessionId: args.ctx.sessionId,
            summary,
            patches: [
              {
                op: "add" as const,
                path: `/agents/{sessionId:${input.targetSessionId}}/cancellationRequested`,
                value: true,
              },
              {
                op: "add" as const,
                path: "/decisions/-",
                value: {
                  id: `D-cancel-${cancelledAt.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
                  at: cancelledAt,
                  source: args.ctx.role,
                  summary: `Cancellation requested for ${input.targetSessionId}: ${input.cancellation?.reason ?? input.text}`,
                  ...(input.taskId ? { refs: { taskId: input.taskId } } : {}),
                },
              },
            ] satisfies ManifestPatchOp[],
          });
          let patchRes = await args.svc.manifestPatch(
            buildCancellationPatch(manifest, "cancellation requested"),
            args.ctx.bundlePath,
          );
          if (!patchRes.ok && patchRes.error === "etag_conflict") {
            patchRes = await args.svc.manifestPatch(
              buildCancellationPatch(patchRes.manifest, "cancellation requested (retry)"),
              args.ctx.bundlePath,
            );
          }
          if (!patchRes.ok) {
            return {
              ok: false as const,
              error: "cancellation_patch_failed",
              message: "Cancellation could not be recorded in the manifest.",
              detail: "message" in patchRes ? patchRes.message : patchRes.error,
            };
          }
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
        try {
          if (input.kind === "queue") {
            await args.chat.steer({
              sessionId: input.targetSessionId,
              text: input.text,
              metadata,
            });
          } else if (input.kind === "interrupt-replace") {
            await args.chat.interrupt({ sessionId: input.targetSessionId });
            await args.chat.sendMessage(
              {
                sessionId: input.targetSessionId,
                text: input.text,
                metadata,
              },
              { awaitDispatch: false },
            );
          } else {
            await args.chat.sendMessage(
              {
                sessionId: input.targetSessionId,
                text: input.text,
                metadata,
              },
              { awaitDispatch: false },
            );
          }
          return { ok: true as const };
        } catch (err) {
          return {
            ok: false as const,
            error: "delivery_failed",
            message: errorMessage(err),
          };
        }
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
            return { ok: true as const, etag: res.etag };
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
      "Register an asset (html spec, screenshot, test log, doc) under the bundle's artifacts/ tree. " +
      "Path is relative to the bundle root; the file should already be on disk before calling.",
    inputSchema: z.object({
      relPath: z.string().min(1),
      kind: z.enum(ASSET_KIND_VALUES),
      version: z.number().int().positive().optional(),
      approval: z.enum(["pending", "approved", "rejected"]).optional(),
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
              "Model selection is locked until codebase intake and all three deliberation rounds are recorded. " +
              "Call recordCodebaseIntake, then askPlanningRound for functional → UI → extras, then pick models.",
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
      "askPlanningRound, model selection, and approval are all locked until this is recorded.",
    inputSchema: z.object({
      projectShape: z.string().min(1, "describe the project shape + primary languages"),
      testStack: z.string().min(1, "describe the test frameworks/globs, or 'none detected'"),
      inFlightWork: z.string().min(1, "summarize git log/diff in-flight work, or 'fresh lane'"),
      ancillarySurfaces: z.array(z.string().min(1)).optional(),
      docMap: z.string().optional(),
      ciGates: z.array(z.string().min(1)).optional(),
    }),
    execute: async (input) =>
      withHeartbeat(ctx, svc, async () => {
        const res = await svc.recordPlanningIntake(ctx.runId, ctx.bundlePath, {
          recordedAt: new Date().toISOString(),
          projectShape: input.projectShape,
          testStack: input.testStack,
          inFlightWork: input.inFlightWork,
          ancillarySurfaces: input.ancillarySurfaces ?? [],
          ...(input.docMap ? { docMap: input.docMap } : {}),
          ciGates: input.ciGates ?? [],
        });
        if (!res.ok) {
          return { ok: false as const, error: res.error, missing: res.missing, message: res.message };
        }
        return {
          ok: true as const,
          etag: res.etag,
          nextStage: res.manifest.leadState.planning?.stage ?? "round_functional",
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
    tools.proposeValidationSteps = createProposeValidationStepsTool(sessionContext, svc);
    tools.recoverStaleTasks = createRecoverStaleTasksTool(sessionContext, svc);
    tools.registerAsset = createRegisterAssetTool(sessionContext, svc, chat);
    // Lead may claim tasks during the planning seed (and to pin "lead is
    // working on planning" semantics). Worker-only edits still gate on lead
    // not having editFile/writeFile/bash.
    tools.claimTask = createClaimTaskTool(sessionContext, svc, chat);
    tools.releaseTask = createReleaseTaskTool(sessionContext, svc, chat);
    tools.recordValidationRun = createRecordValidationRunTool(sessionContext, svc, chat);
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

  return tools;
}

// Re-export validators / types that the IPC layer and tests reuse.
export { validateSpawnBrief };
export type { OrchestrationSpawnAgentRequest };
