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
      `(${ORCHESTRATION_SPAWN_BRIEF_REQUIRED_SECTIONS.join(", ")}).`,
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
      const interactionMode =
        input.role === "validator"
          ? "orchestrator-validator"
          : "orchestrator-worker";
      let created: { id: string };
      try {
        created = await chat.createSession({
          laneId: ctx.laneId,
          interactionMode,
          surface: "work",
          orchestrationRunId: ctx.runId,
          orchestrationRole: input.role,
          orchestrationParentSessionId: ctx.sessionId,
          orchestrationTag: input.tag,
          orchestrationStepId: input.stepId,
          orchestrationBundlePath: ctx.bundlePath,
          goal: input.goalSummary,
          ...(input.modelOverride
            ? {
                provider: input.modelOverride.provider,
                model: input.modelOverride.modelId,
                reasoningEffort: input.modelOverride.reasoningEffort ?? null,
                codexFastMode: input.modelOverride.codexFastMode,
              }
            : {}),
        });
      } catch (err) {
        return {
          ok: false as const,
          error: "create_session_failed",
          message: errorMessage(err),
        };
      }
      // Append the agent row in the manifest. Best-effort; if the etag is
      // stale we surface the failure so the caller can retry/refresh.
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
        },
      };
      const patchRes = await svc.manifestPatch(
        {
          runId: ctx.runId,
          ifMatchEtag: manifest.etag,
          actorRole: "lead",
          actorSessionId: ctx.sessionId,
          summary: "spawn agent",
          patches: [patch],
        },
        ctx.bundlePath,
      );
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
      // Deliver the brief as the first message to the new session.
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
    },
  });
}

function createManifestPatchTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
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
}

function createPlanAppendTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
) {
  return tool({
    description:
      "Append a section to the run's plan.md. " +
      "Use this to write decisions, evidence summaries, and Q&A history. " +
      "Workers/validators must planAppend their evidence before ticking a checklist run.",
    inputSchema: z.object({
      section: z.string().min(1, "section heading is required"),
      body: z.string().min(1, "body is required"),
      pinId: z.string().optional(),
    }),
    execute: async (input) => {
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
}

function createPlanWriteTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
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
}

function createClaimTaskTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
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
}

function createReleaseTaskTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
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
}

function createRegisterAssetTool(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
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
}

function createAskUserForModelSelectionTool(
  ctx: OrchestrationSessionContext,
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
        });
        const answer = typeof response === "string" ? response : (response.answer ?? "");
        let parsed: ModelSelection | null = null;
        try {
          parsed = JSON.parse(answer) as ModelSelection;
        } catch {
          // Plain text — let the lead skill parse it.
        }
        return { ok: true as const, role: input.role, tag: input.tag, selection: parsed, raw: answer };
      } catch (err) {
        return {
          ok: false as const,
          error: "ask_user_failed",
          message: errorMessage(err),
        };
      }
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
    tools.manifestPatch = createManifestPatchTool(sessionContext, svc);
    tools.planAppend = createPlanAppendTool(sessionContext, svc);
    tools.planWrite = createPlanWriteTool(sessionContext, svc);
    tools.askUserForModelSelection = createAskUserForModelSelectionTool(
      sessionContext,
      universal,
    );
    tools.registerAsset = createRegisterAssetTool(sessionContext, svc);
    // Lead may claim tasks during the planning seed (and to pin "lead is
    // working on planning" semantics). Worker-only edits still gate on lead
    // not having editFile/writeFile/bash.
    tools.claimTask = createClaimTaskTool(sessionContext, svc);
    tools.releaseTask = createReleaseTaskTool(sessionContext, svc);
    return tools;
  }

  // Worker + validator share most of the orchestration tools; the server
  // enforces patch-path whitelists and per-role restrictions.
  tools.claimTask = createClaimTaskTool(sessionContext, svc);
  tools.releaseTask = createReleaseTaskTool(sessionContext, svc);
  tools.manifestPatch = createManifestPatchTool(sessionContext, svc);
  tools.planAppend = createPlanAppendTool(sessionContext, svc);
  tools.messageAgent = createMessageAgentTool({
    ctx: sessionContext,
    chat,
    svc,
    restrictedIntents: true,
  });
  tools.getAgentTranscript = createGetAgentTranscriptTool(sessionContext, chat, svc);
  tools.registerAsset = createRegisterAssetTool(sessionContext, svc);

  return tools;
}

// Re-export validators / types that the IPC layer and tests reuse.
export { validateSpawnBrief };
export type { OrchestrationSpawnAgentRequest };
