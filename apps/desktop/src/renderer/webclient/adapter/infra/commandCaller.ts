import type { SyncRemoteCommandDescriptor } from "../../../../shared/types/sync";
import type { AdeSyncClient } from "../../sync";
import type { AdapterProjectState } from "./projectState";

type Fallback<T> = T | (() => T | Promise<T>);

export type CommandCallOptions<T> = {
  fallback: Fallback<T>;
  idempotent?: boolean;
  requireProject?: boolean;
  timeoutMs?: number;
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
  constructor(
    private readonly client: AdeSyncClient,
    private readonly projectState: AdapterProjectState
  ) {}

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

    try {
      return (await this.client.sendCommand(action, args, {
        projectId,
        timeoutMs: options.timeoutMs,
      })) as T;
    } catch (error) {
      if (options.idempotent && isRecoverable(error)) {
        try {
          return (await this.client.sendCommand(action, args, {
            projectId,
            timeoutMs: options.timeoutMs,
          })) as T;
        } catch (retryError) {
          if (isRecoverable(retryError)) return await resolveFallback(options.fallback);
          throw retryError;
        }
      }
      if (isRecoverable(error)) return await resolveFallback(options.fallback);
      throw error;
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
    message.includes("host_unavailable") ||
    message.includes("not connected") ||
    message.includes("unsupported")
  );
}
