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
 * Build a `WorkerSandboxConfig` for orchestration workers/validators by
 * extending the platform default with bundle `manifest.json` + `plan.md`
 * as protected paths and `blockByDefault: true`.
 */
export function buildOrchestrationSandboxConfig(
  bundlePath: string,
  base: WorkerSandboxConfig = DEFAULT_WORKER_SANDBOX_CONFIG,
): WorkerSandboxConfig {
  const extraProtected = [
    escapeRegExp(path.join(bundlePath, "manifest.json")),
    escapeRegExp(path.join(bundlePath, "plan.md")),
  ];
  const safeCommands = base.safeCommands.filter(
    (pattern) => !/^\^(?:node|tsx)(?:\(|\\|\[|\.|$)/.test(pattern),
  );
  return {
    ...base,
    safeCommands,
    protectedFiles: [...base.protectedFiles, ...extraProtected],
    blockByDefault: true,
  };
}
