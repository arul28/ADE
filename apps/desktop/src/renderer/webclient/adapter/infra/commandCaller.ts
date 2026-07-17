import type { SyncRemoteCommandDescriptor } from "../../../../shared/types/sync";
import type { AdeSyncClient } from "../../sync";
import { stableCacheKey } from "./cacheKey";
import type { AdapterProjectState } from "./projectState";

type Fallback<T> = T | (() => T | Promise<T>);

export type CommandCallOptions<T> = {
  fallback: Fallback<T>;
  /** Mutation guard: false prevents this call from ever entering the read cache. */
  idempotent?: boolean;
  requireProject?: boolean;
  timeoutMs?: number;
  cacheTtlMs?: number;
};

const RECOVERABLE_CODES = new Set([
  "missing_project",
  "project_not_open",
  "host_unavailable",
  "disconnected",
  "not_connected",
  "unknown_action",
  "unsupported_action",
  "command_rejected",
]);

export class CommandCaller {
  private readonly readCache = new Map<string, {
    action: string;
    expiresAt: number;
    promise: Promise<unknown>;
  }>();

  constructor(
    private readonly client: AdeSyncClient,
    private readonly projectState: AdapterProjectState
  ) {}

  invalidateCache(actionPrefixes?: string[]): void {
    if (!actionPrefixes?.length) {
      this.readCache.clear();
      return;
    }
    for (const [key, entry] of this.readCache) {
      if (actionPrefixes.some((prefix) => entry.action.startsWith(prefix))) {
        this.readCache.delete(key);
      }
    }
  }

  getDescriptor(action: string): SyncRemoteCommandDescriptor | null {
    return this.client.getCommandDescriptors().find((descriptor) => descriptor.action === action) ?? null;
  }

  hasAction(action: string): boolean {
    return Boolean(this.getDescriptor(action));
  }

  async call<T>(
    action: string,
    args: Record<string, unknown> = {},
    options: CommandCallOptions<T>
  ): Promise<T> {
    const descriptor = this.getDescriptor(action);
    if (!descriptor) return await resolveFallback(options.fallback);

    const requireProject = options.requireProject ?? descriptor.scope === "project";
    const projectId = descriptor.scope === "project" ? this.projectState.getProjectId() : null;
    if (requireProject && descriptor.scope === "project" && !projectId) {
      return await resolveFallback(options.fallback);
    }

    const cacheKey = options.cacheTtlMs !== undefined && options.idempotent !== false
      ? `${projectId ?? "runtime"}\u0000${action}\u0000${stableCacheKey(args)}`
      : null;
    if (cacheKey) {
      const cached = this.readCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return await cached.promise as T;
      }
      if (cached) this.readCache.delete(cacheKey);
    }

    const request = (async (): Promise<T> => {
      try {
        return (await this.client.sendCommand(action, args, {
          projectId,
          timeoutMs: options.timeoutMs,
        })) as T;
      } catch (error) {
        // The relay transport already owns reconnect/replay. An immediate
        // adapter retry doubles billable relay traffic and normally repeats
        // the same unavailable-project failure, so recover locally instead.
        if (isRecoverable(error)) return await resolveFallback(options.fallback);
        throw error;
      }
    })();

    if (cacheKey && options.cacheTtlMs !== undefined) {
      const entry = {
        action,
        // Keep concurrent callers joined even when the relay itself takes
        // longer than the TTL; start the freshness window after resolution.
        expiresAt: Number.POSITIVE_INFINITY,
        promise: request as Promise<unknown>,
      };
      this.readCache.set(cacheKey, entry);
      void request.then(
        () => {
          if (this.readCache.get(cacheKey) === entry) {
            entry.expiresAt = Date.now() + Math.max(0, options.cacheTtlMs!);
          }
        },
        () => {
          if (this.readCache.get(cacheKey) === entry) this.readCache.delete(cacheKey);
        },
      );
    }

    return await request;
  }
}

async function resolveFallback<T>(fallback: Fallback<T>): Promise<T> {
  if (typeof fallback === "function") {
    return await (fallback as () => T | Promise<T>)();
  }
  return fallback;
}

function isRecoverable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (RECOVERABLE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("missing_project") ||
    message.includes("project_not_open") ||
    message.includes("host_unavailable") ||
    message.includes("not connected") ||
    message.includes("unsupported")
  );
}
