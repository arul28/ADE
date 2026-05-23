/**
 * Orchestration tool factory — companion to `createUniversalToolSet`.
 *
 * Gated on `interactionMode === "orchestrator-lead" | "orchestrator-worker" |
 * "orchestrator-validator"`. The factory composes the read-only base from the
 * universal toolset (for lead) and adds the orchestration-specific tools, OR
 * keeps the full edit-capable set (for worker/validator) and layers
 * orchestration tools on top.
 *
 * All tools call into the main-process `OrchestrationService` handle directly
 * — they live inside the chat runtime and do not round-trip through IPC.
 */

import path from "node:path";
import { z } from "zod";
import { executableTool as tool, type ExecutableTool } from "./executableTool";
import { createUniversalToolSet, type UniversalToolSetOptions } from "./universalTools";
import { DEFAULT_WORKER_SANDBOX_CONFIG } from "../../orchestrator/orchestratorConstants";
import type { WorkerSandboxConfig } from "../../../../shared/types";
import type {
  ManifestPatchOp,
  OrchestrationAssetKind,
  OrchestrationEventPayload,
  OrchestrationManifest,
  OrchestrationPingIntent,
  OrchestrationPingKind,
  OrchestrationRole,
  OrchestrationTaskStatus,
  ModelSelection,
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
  resolveOrchestrationModel,
} from "../../orchestration/runtimeProfile";

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
const ASSET_KIND_VALUES = [
  "html_spec",
  "screenshot",
  "test_log",
  "doc",
] as const;
const ROLE_VALUES = ["lead", "worker", "validator"] as const;

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
  "TodoWrite",
  "TodoRead",
  "askUser",
  "findRoutingFiles",
  "findPageComponents",
  "findAppEntryPoints",
  "summarizeFrontendStructure",
]);

export type OrchestrationPlanQualityMissing = {
  id: string;
  label: string;
  message: string;
};

type PlanQualityRequirement = OrchestrationPlanQualityMissing & {
  patterns: RegExp[];
};

const PLAN_QUALITY_REQUIREMENTS: PlanQualityRequirement[] = [
  {
    id: "out_of_scope",
    label: "Out of scope / non-goals",
    message: "Add a clear out-of-scope or non-goals section.",
    patterns: [
      /out[-\s]?of[-\s]?scope/i,
      /non[-\s]?goals?/i,
      /not doing/i,
      /excluded/i,
      /deferred/i,
    ],
  },
  {
    id: "implementation_order",
    label: "Implementation order",
    message: "Add the planned implementation order, dependencies, or phase sequence.",
    patterns: [
      /implementation order/i,
      /execution order/i,
      /planned order/i,
      /work order/i,
      /sequence/i,
      /phases?/i,
      /dependencies?/i,
      /\bfirst\b/i,
      /\bthen\b/i,
      /\bafter\b/i,
      /\bparallel\b/i,
    ],
  },
  {
    id: "agent_plan",
    label: "Agent plan",
    message: "Add which workers/validators to spawn and what each owns.",
    patterns: [
      /agent plan/i,
      /workers?/i,
      /validators?/i,
      /spawn/i,
      /assignee/i,
      /owner/i,
      /tags?/i,
      /role\/tag/i,
      /model routing/i,
      /model picks?/i,
    ],
  },
  {
    id: "validation_plan",
    label: "Validation / proof plan",
    message: "Add concrete validation, proof, or evidence expectations.",
    patterns: [
      /validation/i,
      /validate/i,
      /verify/i,
      /test/i,
      /typecheck/i,
      /lint/i,
      /build/i,
      /smoke/i,
      /proof/i,
      /evidence/i,
      /gates?/i,
      /checks?/i,
    ],
  },
  {
    id: "ui_impact",
    label: "UI decisions or N/A",
    message: "Add UI/user-facing decisions, or explicitly say UI is not applicable.",
    patterns: [
      /\bui\b/i,
      /\bux\b/i,
      /user[-\s]?facing/i,
      /interface/i,
      /screen/i,
      /view/i,
      /visual/i,
      /accessibility/i,
      /not applicable/i,
      /\bn\/a\b/i,
      /no ui/i,
      /non[-\s]?ui/i,
      /backend[-\s]?only/i,
      /cli[-\s]?only/i,
    ],
  },
  {
    id: "coordination_log",
    label: "Coordination / live log",
    message: "Add how plan.md and the manifest stay updated as agents work.",
    patterns: [
      /coordination/i,
      /plan\.md/i,
      /manifest/i,
      /status update/i,
      /progress update/i,
      /live update/i,
      /planAppend/i,
      /messageAgent/i,
      /report back/i,
      /stuck/i,
      /handoff/i,
      /sync(?:ed)?/i,
    ],
  },
  {
    id: "alternatives",
    label: "Alternatives / tradeoffs",
    message: "Add alternatives, options, or tradeoffs considered for major choices.",
    patterns: [
      /alternatives?/i,
      /options?/i,
      /trade[-\s]?offs?/i,
      /considered/i,
      /approach/i,
      /rejected/i,
      /decision/i,
    ],
  },
];

export function assessOrchestrationPlanQuality(planSummary: string): {
  ok: boolean;
  missing: OrchestrationPlanQualityMissing[];
} {
  const text = planSummary.trim();
  const missing = PLAN_QUALITY_REQUIREMENTS
    .filter((requirement) => !requirement.patterns.some((pattern) => pattern.test(text)))
    .map(({ id, label, message }) => ({ id, label, message }));
  return { ok: missing.length === 0, missing };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a `WorkerSandboxConfig` for orchestration workers/validators by
 * extending the platform default with:
 *   - bundle `manifest.json` + `plan.md` as protected paths
 *   - `blockByDefault: true` so unknown commands fall through to a reject
 *
 * The `<bundlePath>/artifacts/**` tree remains writable through the standard
 * `allowedPaths` rule (project root contains the bundle).
 */
export function buildOrchestrationSandboxConfig(
  bundlePath: string,
  base: WorkerSandboxConfig = DEFAULT_WORKER_SANDBOX_CONFIG,
): WorkerSandboxConfig {
  const manifestPath = path.join(bundlePath, "manifest.json");
  const planPath = path.join(bundlePath, "plan.md");
  const extraProtected = [
    // anchor with start/end so a substring like "plan.md.bak" doesn't trip it
    `^${escapeRegExp(manifestPath)}$`,
    `^${escapeRegExp(planPath)}$`,
    // Also block bundle manifest/plan when referenced via the bundle dir.
    `${escapeRegExp(path.join(bundlePath, "manifest.json"))}`,
    `${escapeRegExp(path.join(bundlePath, "plan.md"))}`,
  ];
  return {
    ...base,
    protectedFiles: [...base.protectedFiles, ...extraProtected],
    blockByDefault: true,
  };
}

function manifestOrThrow(
  svc: ReturnType<typeof createOrchestrationService>,
  runId: string,
): OrchestrationManifest {
  const manifest = svc.getManifestForRun(runId);
  if (!manifest) {
    throw new Error(
      `Orchestration run ${runId} not loaded — call orchestrationBundleRead first.`,
    );
  }
  return manifest;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function touchHeartbeat(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
): Promise<void> {
  await svc.agentHeartbeat({
    runId: ctx.runId,
    sessionId: ctx.sessionId,
  }, ctx.bundlePath).catch(() => undefined);
}

function leadSessionIdFor(
  manifest: OrchestrationManifest,
  ctx: OrchestrationSessionContext,
): string | null {
  const explicit = ctx.leadSessionId?.trim();
  if (explicit) return explicit;
  return manifest.agents.find((agent) => agent.role === "lead")?.sessionId ?? null;
}

async function notifyLeadStatus(args: {
  ctx: OrchestrationSessionContext;
  svc: ReturnType<typeof createOrchestrationService>;
  chat: OrchestrationAgentChatHandle;
  text: string;
  taskId?: string;
}): Promise<void> {
  if (args.ctx.role === "lead") return;
  const manifest = args.svc.getManifestForRun(args.ctx.runId);
  if (!manifest) return;
  const leadSessionId = leadSessionIdFor(manifest, args.ctx);
  if (!leadSessionId || leadSessionId === args.ctx.sessionId) return;
  await args.chat.steer({
    sessionId: leadSessionId,
    text: args.text,
    metadata: {
      orchestrationOrigin: {
        runId: args.ctx.runId,
        fromSessionId: args.ctx.sessionId,
        kind: "queue" as OrchestrationPingKind,
        intent: "status" as OrchestrationPingIntent,
        ...(args.taskId ? { taskId: args.taskId } : {}),
      },
    },
  }).catch(() => undefined);
}

function toolResultOk(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  if (!("ok" in result)) return true;
  return (result as { ok?: unknown }).ok === true;
}

async function withHeartbeat<T>(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } finally {
    await touchHeartbeat(ctx, svc);
  }
}

async function withMutationSideEffects<T>(args: {
  ctx: OrchestrationSessionContext;
  svc: ReturnType<typeof createOrchestrationService>;
  chat: OrchestrationAgentChatHandle;
  notifyText: string;
  taskId?: string;
  fn: () => Promise<T>;
}): Promise<T> {
  let result: T;
  try {
    result = await args.fn();
  } finally {
    await touchHeartbeat(args.ctx, args.svc);
  }
  if (toolResultOk(result)) {
    await notifyLeadStatus({
      ctx: args.ctx,
      svc: args.svc,
      chat: args.chat,
      text: args.notifyText,
      ...(args.taskId ? { taskId: args.taskId } : {}),
    });
  }
  return result;
}

type CancellationRegistry = {
  controllers: Set<AbortController>;
  unsubscribe: (() => void) | null;
};

const cancellationRegistries = new WeakMap<
  ReturnType<typeof createOrchestrationService>,
  Map<string, CancellationRegistry>
>();

function cancellationRegistryKey(ctx: OrchestrationSessionContext): string {
  return `${ctx.runId}\u0000${ctx.sessionId}`;
}

function manifestRequestsCancellation(
  manifest: OrchestrationManifest | null | undefined,
  sessionId: string,
): boolean {
  return manifest?.agents.some(
    (agent) =>
      agent.sessionId === sessionId &&
      agent.cancellationRequested === true,
  ) === true;
}

function registerOrchestrationBashCancellation(
  svc: ReturnType<typeof createOrchestrationService>,
  ctx: OrchestrationSessionContext,
  controller: AbortController,
): () => void {
  if (manifestRequestsCancellation(svc.getManifestForRun(ctx.runId), ctx.sessionId)) {
    controller.abort("orchestration cancellation requested");
    return () => {};
  }

  let byService = cancellationRegistries.get(svc);
  if (!byService) {
    byService = new Map();
    cancellationRegistries.set(svc, byService);
  }
  const key = cancellationRegistryKey(ctx);
  let registry = byService.get(key);
  if (!registry) {
    registry = { controllers: new Set(), unsubscribe: null };
    const onEvent = (payload: OrchestrationEventPayload) => {
      if (payload.runId !== ctx.runId || payload.kind !== "manifest") return;
      const manifest = payload.manifest ?? svc.getManifestForRun(ctx.runId);
      if (!manifestRequestsCancellation(manifest, ctx.sessionId)) return;
      for (const active of registry?.controllers ?? []) {
        active.abort("orchestration cancellation requested");
      }
    };
    registry.unsubscribe = svc.on("event", onEvent);
    byService.set(key, registry);
  }

  registry.controllers.add(controller);
  return () => {
    const current = byService?.get(key);
    if (!current) return;
    current.controllers.delete(controller);
    if (current.controllers.size > 0) return;
    current.unsubscribe?.();
    byService?.delete(key);
  };
}

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
      stepId: z.string().optional(),
      initialMessage: z.string().min(1, "initialMessage is required"),
      modelOverride: z
        .object({
          provider: z.string(),
          modelId: z.string(),
          reasoningEffort: z.string().nullable().optional(),
          codexFastMode: z.boolean().optional(),
        })
        .partial({ reasoningEffort: true, codexFastMode: true })
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
            codexFastMode: routedSelection.codexFastMode,
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
              codexFastMode: routedSelection.codexFastMode,
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
          return {
            ok: false as const,
            error: "manifest_patch_failed",
            message:
              "Created session but failed to append agent row: " +
              ("error" in patchRes
                ? String(patchRes.error)
                : "unknown"),
            sessionId: created.id,
          };
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
        // but a direct caller could still attempt it. Cast through unknown to
        // bypass the narrowed type for the runtime check.
        if (
          args.restrictedIntents &&
          ((input.intent as unknown) === "cancellation")
        ) {
          return {
            ok: false as const,
            error: "intent_not_allowed",
            message:
              "Workers and validators cannot send cancellation directives.",
          };
        }
        const origin = {
          runId: args.ctx.runId,
          fromSessionId: args.ctx.sessionId,
          kind: input.kind,
          intent: input.intent,
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
      "Workers/validators must planAppend their evidence before ticking a checklist run.",
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

function createRequestPlanApprovalTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
  universalOpts: UniversalToolSetOptions,
) {
  return tool({
    description:
      "Lead-only. Mark the orchestration plan as ready and surface the plan-pane Implement button. " +
      "Plan summaries must include the minimum orchestration sections: out of scope, implementation order, agent plan, validation/proof, UI impact or N/A, live coordination/logging, and alternatives/tradeoffs. " +
      "When the user clicks Implement or otherwise approves, this records approval in the manifest and advances the run into developing so spawnAgent can run.",
    inputSchema: z.object({
      planSummary: z.string().min(1, "planSummary is required"),
      question: z.string().optional(),
    }),
    execute: async (input) => withHeartbeat(ctx, svc, async () => {
      const quality = assessOrchestrationPlanQuality(input.planSummary);
      if (!quality.ok) {
        return {
          ok: false as const,
          error: "plan_quality_missing_sections",
          missing: quality.missing,
          message:
            "Plan approval requires the minimum orchestration sections before asking the user: " +
            quality.missing.map((entry) => entry.label).join(", ") +
            ". Add those sections to the plan summary and call requestPlanApproval again.",
        };
      }
      if (!universalOpts.onAskUser) {
        return {
          ok: false as const,
          error: "no_ask_user_handler",
          message:
            "requestPlanApproval requires an onAskUser handler — none configured.",
        };
      }
      const response = await universalOpts.onAskUser({
        title: "Plan ready",
        body: input.planSummary,
        question: input.question ?? "Review the plan pane. Continue planning in chat if anything should change, or click Implement when ready.",
        pendingInputKind: "plan_approval",
        providerMetadata: {
          orchestrationPlanApproval: true,
          planContent: input.planSummary,
          planQuality: quality,
        },
      });
      const result = typeof response === "string"
        ? { answer: response, decision: undefined as string | undefined }
        : response;
      const approved = result.decision === "accept"
        || result.decision === "accept_for_session"
        || /\b(approve|approved|yes|start|proceed)\b/i.test(result.answer ?? "");
      if (!approved) {
        return {
          ok: false as const,
          error: "plan_rejected",
          decision: result.decision ?? "decline",
          message: result.answer || result.responseText || "User did not approve the plan.",
        };
      }

      const approvedAt = new Date().toISOString();
      const buildPatchRequest = (manifest: OrchestrationManifest, summary: string) => ({
        runId: ctx.runId,
        ifMatchEtag: manifest.etag,
        actorRole: "lead" as const,
        actorSessionId: ctx.sessionId,
        summary,
        patches: [
          { op: "add" as const, path: "/leadState/planApprovedAt", value: approvedAt },
          { op: "add" as const, path: "/leadState/planApprovedBySessionId", value: ctx.sessionId },
          { op: "add" as const, path: "/leadState/planApprovalSummary", value: input.planSummary },
          { op: "replace" as const, path: "/currentPhase", value: "developing" },
          { op: "replace" as const, path: "/phases/{id:planning}/status", value: "done" },
          { op: "add" as const, path: "/phases/{id:planning}/completedAt", value: approvedAt },
          { op: "replace" as const, path: "/phases/{id:developing}/status", value: "active" },
          { op: "add" as const, path: "/phases/{id:developing}/startedAt", value: approvedAt },
        ] satisfies ManifestPatchOp[],
      });
      let manifest = manifestOrThrow(svc, ctx.runId);
      let patchRes = await svc.manifestPatch(
        buildPatchRequest(manifest, "plan approved"),
        ctx.bundlePath,
      );
      if (!patchRes.ok && patchRes.error === "etag_conflict") {
        manifest = patchRes.manifest;
        patchRes = await svc.manifestPatch(
          buildPatchRequest(manifest, "plan approved (retry)"),
          ctx.bundlePath,
        );
      }
      if (!patchRes.ok) {
        return {
          ok: false as const,
          error: "manifest_patch_failed",
          message: "Plan was approved, but ADE could not record approval in the manifest.",
          detail: "message" in patchRes ? patchRes.message : patchRes.error,
        };
      }
      return {
        ok: true as const,
        approvedAt,
        etag: patchRes.etag,
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
      "Heartbeats are automatic; release with `releaseTask` once you patch status=done/failed. " +
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
      "Use this once per (role, tag) during planning before spawning any worker on that tag.",
    inputSchema: z.object({
      role: z.enum(ROLE_VALUES),
      tag: z.string().min(1),
      suggested: z
        .object({
          provider: z.string(),
          modelId: z.string(),
          reasoningEffort: z.string().nullable().optional(),
          codexFastMode: z.boolean().optional(),
        })
        .partial({ reasoningEffort: true, codexFastMode: true })
        .optional(),
    }),
    execute: async (input) => {
      return withHeartbeat(ctx, svc, async () => {
        if (!universalOpts.onAskUser) {
          return {
            ok: false as const,
            error: "no_ask_user_handler",
            message:
              "askUserForModelSelection requires an onAskUser handler — none configured.",
          };
        }
        try {
          const response = await universalOpts.onAskUser({
            title: `Pick a model for ${input.role}:${input.tag}`,
            body: input.suggested
              ? `Suggested: ${input.suggested.provider}/${input.suggested.modelId}`
              : undefined,
            question: `Which model should the ${input.role} on tag '${input.tag}' use?`,
            pendingInputKind: "model_selection",
            providerMetadata: {
              role: input.role,
              tag: input.tag,
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
    tools.registerAsset = createRegisterAssetTool(sessionContext, svc, chat);
    // Lead may claim tasks during the planning seed (and to pin "lead is
    // working on planning" semantics). Worker-only edits still gate on lead
    // not having editFile/writeFile/bash.
    tools.claimTask = createClaimTaskTool(sessionContext, svc, chat);
    tools.releaseTask = createReleaseTaskTool(sessionContext, svc, chat);
    return tools;
  }

  // Worker + validator share most of the orchestration tools; the server
  // enforces patch-path whitelists and per-role restrictions.
  tools.claimTask = createClaimTaskTool(sessionContext, svc, chat);
  tools.releaseTask = createReleaseTaskTool(sessionContext, svc, chat);
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
