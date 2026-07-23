/**
 * Runtime infrastructure helpers for orchestration tool execution.
 *
 * Handles heartbeats, cancellation wiring, lead notification, manifest
 * lookups, and the sandbox config builder. Extracted from
 * `orchestrationTools.ts` so tool factory functions stay focused on
 * their schemas and execute bodies.
 */

import path from "node:path";
import type {
  OrchestrationEventPayload,
  OrchestrationManifest,
  OrchestrationPingIntent,
  OrchestrationPingKind,
} from "../../../../shared/types/orchestration";
import type { WorkerSandboxConfig } from "../../../../shared/types";
import { DEFAULT_WORKER_SANDBOX_CONFIG } from "./workerSandboxDefaults";
import type { createOrchestrationService } from "../../orchestration/orchestrationService";
import type { OrchestrationAgentChatHandle, OrchestrationSessionContext } from "./orchestrationTools";
import { drainOutbox } from "./orchestrationOutbox";

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Manifest lookup
// ---------------------------------------------------------------------------

export function manifestOrThrow(
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

// ---------------------------------------------------------------------------
// Lead session resolution
// ---------------------------------------------------------------------------

export function leadSessionIdFor(
  manifest: OrchestrationManifest,
  ctx: OrchestrationSessionContext,
): string | null {
  const explicit = ctx.leadSessionId?.trim();
  if (explicit) return explicit;
  return manifest.agents.find((agent) => agent.role === "lead")?.sessionId ?? null;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export async function touchHeartbeat(
  ctx: OrchestrationSessionContext,
  svc: ReturnType<typeof createOrchestrationService>,
): Promise<void> {
  await svc.agentHeartbeat({
    runId: ctx.runId,
    sessionId: ctx.sessionId,
  }, ctx.bundlePath).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Lead notification
// ---------------------------------------------------------------------------

export async function notifyLeadStatus(args: {
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
  try {
    const enqueued = await args.svc.enqueueOutbox(
      args.ctx.runId,
      args.ctx.bundlePath,
      [{
        kind: "lead_status",
        targetSessionId: leadSessionId,
        delivery: {
          op: "steer",
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
        },
      }],
    );
    if (!enqueued.ok) return;
    await drainOutbox(args.svc, args.chat, args.ctx);
  } catch {
    // The mutation wrapper remains best-effort at its call boundary. Once the
    // enqueue succeeds, the manifest outbox preserves the delivery for retry.
  }
}

// ---------------------------------------------------------------------------
// Result inspection
// ---------------------------------------------------------------------------

function toolResultOk(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  if (!("ok" in result)) return true;
  return (result as { ok?: unknown }).ok === true;
}

// ---------------------------------------------------------------------------
// Execution wrappers
// ---------------------------------------------------------------------------

export async function withHeartbeat<T>(
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

export async function withMutationSideEffects<T>(args: {
  ctx: OrchestrationSessionContext;
  svc: ReturnType<typeof createOrchestrationService>;
  chat: OrchestrationAgentChatHandle;
  notifyText: string;
  taskId?: string;
  fn: () => Promise<T>;
  /**
   * When provided and it returns true for the successful result, the generic
   * `lead_status` ping is suppressed — the mutation already enqueued a richer,
   * structured entry for this transition (e.g. a terminal `releaseTask` enqueues
   * a `completion` entry), and a second ping would double-notify the lead. The
   * outbox is still drained so that structured entry is delivered promptly.
   */
  suppressLeadNotify?: (result: T) => boolean;
}): Promise<T> {
  let result: T;
  try {
    result = await args.fn();
  } finally {
    await touchHeartbeat(args.ctx, args.svc);
  }
  if (toolResultOk(result)) {
    if (args.suppressLeadNotify?.(result)) {
      // Deliver whatever the mutation enqueued (the structured entry) without a
      // duplicate generic ping. notifyLeadStatus would normally trigger this
      // drain, so we drain directly here.
      if (args.ctx.role !== "lead") {
        await drainOutbox(args.svc, args.chat, args.ctx);
      }
    } else {
      await notifyLeadStatus({
        ctx: args.ctx,
        svc: args.svc,
        chat: args.chat,
        text: args.notifyText,
        ...(args.taskId ? { taskId: args.taskId } : {}),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cancellation registry for orchestration bash calls
// ---------------------------------------------------------------------------

type CancellationRegistry = {
  controllers: Set<AbortController>;
  unsubscribe: (() => void) | null;
};

const cancellationRegistries = new WeakMap<
  ReturnType<typeof createOrchestrationService>,
  Map<string, CancellationRegistry>
>();

function cancellationRegistryKey(ctx: OrchestrationSessionContext): string {
  return `${ctx.runId}:${ctx.sessionId}`;
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

export function registerOrchestrationBashCancellation(
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
// Sandbox config builder
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Commands a finishing worker (`manifest.finishing.mode === "pr"`) must run once
 * validation passes: push the branch, open/inspect the PR, and drive the `ade`
 * CLI (Linear sync, deeplink mint, asset registration, and
 * `ade actions run chat.createScheduledWork`). Allow-listed narrowly — only
 * `git push`, `gh pr <sub>`, and `ade <sub>` — so the finishing role can complete
 * a run under `blockByDefault: true` without opening the sandbox to arbitrary
 * commands. `gh` is scoped to its `pr` subcommands; everything dangerous stays
 * in `blockedCommands` (checked first, always rejected).
 *
 * IMPORTANT — does this block actually bite? Real finishing workers are spawned
 * as native-provider workers (Claude `Bash`, Codex shell, …) whose shell
 * BYPASSES this TS sandbox entirely (see SKILL §4 step 5 / §4.5), so they can
 * already push/gh/ade regardless. This allowance only governs the ADE-SDK
 * `createBashTool` path (`checkWorkerSandbox`); we fix it for consistency so a
 * finishing worker driven through that path can also finish the run.
 */
export const FINISHING_WORKER_SAFE_COMMANDS: readonly string[] = [
  "^git(\\.exe)?\\s+push\\b",
  "^gh(\\.exe)?\\s+pr\\b",
  "^ade(\\.cmd)?\\s",
];

/**
 * Build a `WorkerSandboxConfig` for orchestration workers/validators by
 * extending the platform default with bundle `manifest.json` + `plan.md`
 * as protected paths and `blockByDefault: true`.
 *
 * When `allowFinishingCommands` is set, the finishing command set
 * (`FINISHING_WORKER_SAFE_COMMANDS`) is added to the safe list. The finishing
 * role is not tagged separately at sandbox-build time (it is a plain `worker`
 * spawned via `spawnAgent`), so callers scope this as narrowly as the mechanism
 * allows — to orchestration WORKERS (never validators, which must not push or
 * open PRs) — rather than to finishing-workers only.
 */
export function buildOrchestrationSandboxConfig(
  bundlePath: string,
  base: WorkerSandboxConfig = DEFAULT_WORKER_SANDBOX_CONFIG,
  opts: { allowFinishingCommands?: boolean } = {},
): WorkerSandboxConfig {
  const extraProtected = [
    escapeRegExp(path.join(bundlePath, "manifest.json")),
    escapeRegExp(path.join(bundlePath, "plan.md")),
  ];
  const safeCommands = base.safeCommands.filter(
    (pattern) => !/^\^(?:node|tsx)(?:\(|\\|\[|\.|$)/.test(pattern),
  );
  const withFinishing = opts.allowFinishingCommands
    ? [...safeCommands, ...FINISHING_WORKER_SAFE_COMMANDS]
    : safeCommands;
  return {
    ...base,
    safeCommands: withFinishing,
    protectedFiles: [...base.protectedFiles, ...extraProtected],
    blockByDefault: true,
  };
}
