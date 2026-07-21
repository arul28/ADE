import type { SyncRemoteCommandDescriptor } from "../../../../shared/types/sync";
import type { AdeSyncClient } from "../../sync";
import { stableCacheKey } from "./cacheKey";
import { createCoalescingReadCache } from "./coalescingReadCache";
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
  "unknown_action",
  "unsupported_action",
  "command_rejected",
]);

const TRANSPORT_FAILURE_CODES = new Set([
  "host_unavailable",
  "disconnected",
  "not_connected",
  "connection_lost_outcome_unknown",
  "restoration_missing",
  "timeout",
]);

const READ_CACHE_TTL_MS = 3_000;

type CommandResult<T> = {
  value: T;
  cacheable: boolean;
};

export class CommandCaller {
  private readonly readCache = createCoalescingReadCache(READ_CACHE_TTL_MS);
  private readonly lastSuccessfulReads = new Map<string, unknown>();

  constructor(
    private readonly client: AdeSyncClient,
    private readonly projectState: AdapterProjectState
  ) {}

  invalidateCache(actionPrefixes?: string[]): void {
    if (!actionPrefixes?.length) {
      this.readCache.clear();
      this.lastSuccessfulReads.clear();
      return;
    }
    this.readCache.invalidate((key) => {
      const actionStart = key.indexOf("\u0000") + 1;
      return actionPrefixes.some((prefix) => key.startsWith(prefix, actionStart));
    });
    for (const key of this.lastSuccessfulReads.keys()) {
      const actionStart = key.indexOf("\u0000") + 1;
      if (actionPrefixes.some((prefix) => key.startsWith(prefix, actionStart))) {
        this.lastSuccessfulReads.delete(key);
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

    const readKey = options.idempotent !== false
      ? `${projectId ?? "runtime"}\u0000${action}\u0000${stableCacheKey(args)}`
      : null;
    const fetchCommand = async (): Promise<CommandResult<T>> => {
      try {
        const value = (await this.client.sendCommand(action, args, {
          projectId,
          timeoutMs: options.timeoutMs,
        })) as T;
        if (readKey) this.rememberSuccessfulRead(readKey, value);
        return {
          value,
          cacheable: true,
        };
      } catch (error) {
        // A mutation that reached the transport can have an unknown outcome.
        // Never fabricate success from its UI fallback: callers such as the
        // chat composer rely on rejection to preserve the user's draft.
        if (options.idempotent === false) throw error;
        if (isTransportFailure(error)) {
          if (readKey && this.lastSuccessfulReads.has(readKey)) {
            return {
              value: this.lastSuccessfulReads.get(readKey) as T,
              cacheable: false,
            };
          }
          // Without prior data, an empty fallback would turn a transient
          // reconnect into a false empty state. Let the mounted surface retain
          // its current data and render the connection status instead.
          throw error;
        }
        if (isRecoverable(error)) {
          return {
            value: await resolveFallback(options.fallback),
            cacheable: false,
          };
        }
        throw error;
      }
    };

    const result = readKey && options.cacheTtlMs !== undefined
      ? await this.readCache.coalesce(readKey, fetchCommand, {
          cacheResult: (next) => next.cacheable,
          ttlMs: options.cacheTtlMs,
        })
      : await fetchCommand();
    return result.value;
  }

  private rememberSuccessfulRead(key: string, value: unknown): void {
    this.lastSuccessfulReads.delete(key);
    this.lastSuccessfulReads.set(key, value);
    while (this.lastSuccessfulReads.size > 500) {
      const oldest = this.lastSuccessfulReads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.lastSuccessfulReads.delete(oldest);
    }
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
    message.includes("unsupported")
  );
}

function isTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (TRANSPORT_FAILURE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("host_unavailable")
    || message.includes("not connected")
    || message.includes("connection lost")
    || message.includes("reconnecting")
    || message.includes("timed out")
  );
}
