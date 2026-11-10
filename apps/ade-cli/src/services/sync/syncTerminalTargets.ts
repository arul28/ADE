import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { toOptionalString } from "../../../../desktop/src/main/services/shared/utils";
import type { SyncEnvelope } from "../../../../desktop/src/shared/types";
import type { ParsedSyncEnvelope } from "./syncProtocol";
import type { SyncTerminalProjectRuntime, SyncTerminalTarget } from "./syncTerminalStreams";

// Where a phone's `terminal_*` envelope goes: the project it names, and the
// terminal services of that project when it is open on this machine.

/** The project a `terminal_*` envelope names, for an ingress with no project of its own. */
export function syncTerminalProjectTarget(envelope: ParsedSyncEnvelope): SyncTerminalTarget | null {
  const projectId = toOptionalString(envelope.projectId);
  if (!projectId) return null;
  const payload = envelope.payload as { projectRootPath?: unknown } | null;
  return {
    kind: "project",
    projectId,
    projectRootPath: toOptionalString(payload?.projectRootPath),
  };
}

const SYNC_TERMINAL_ENVELOPE_TYPES = new Set<SyncEnvelope["type"]>([
  "terminal_subscribe",
  "terminal_unsubscribe",
  "terminal_input",
  "terminal_resize",
  "terminal_history",
]);

export function isSyncTerminalEnvelopeType(type: SyncEnvelope["type"]): boolean {
  return SYNC_TERMINAL_ENVELOPE_TYPES.has(type);
}

/** The terminal services of a booted project scope, or null when it has none. */
function syncTerminalRuntimeFromScope(scope: unknown): SyncTerminalProjectRuntime | null {
  const runtime = (scope as { runtime?: Partial<SyncTerminalProjectRuntime> } | null | undefined)?.runtime;
  if (!runtime?.ptyService || !runtime.sessionService || typeof runtime.eventBuffer?.subscribe !== "function") {
    return null;
  }
  return runtime as SyncTerminalProjectRuntime;
}

/** How long a subscribe waits for a project that is still opening. */
const TERMINAL_PROJECT_BOOT_WAIT_MS = 5_000;

/**
 * A project that is open (or opening) on this machine. Never boots one: a
 * project that is not open, failed to open, or is still opening after
 * `TERMINAL_PROJECT_BOOT_WAIT_MS`, gives null. The wait is bounded because
 * the subscribe holds the socket's message queue.
 */
export async function resolveBootedTerminalProject(
  scopes: { getIfBooted(projectId: string): Promise<unknown> | null },
  projectId: string,
  logger: Pick<Logger, "warn">,
): Promise<SyncTerminalProjectRuntime | null> {
  const pending = scopes.getIfBooted(projectId);
  if (!pending) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timedOut");
  try {
    const scope = await Promise.race([
      pending,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), TERMINAL_PROJECT_BOOT_WAIT_MS);
      }),
    ]);
    if (scope === timedOut) {
      logger.warn("sync.terminal_project_resolve_timed_out", { projectId, waitMs: TERMINAL_PROJECT_BOOT_WAIT_MS });
      return null;
    }
    return syncTerminalRuntimeFromScope(scope);
  } catch (error) {
    logger.warn("sync.terminal_project_resolve_failed", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
