import type { SyncGetStatusArgs, SyncRoleSnapshot } from "../../../shared/types";
import { isSyncServiceUnavailableError } from "../../../shared/runtimeErrors";
import { LOCAL_RUNTIME_SYNC_STATUS_OVERALL_TIMEOUT_MS } from "../localRuntime/localRuntimeTimeoutPolicy";
import type { Logger } from "../logging/logger";
import { withDeadline } from "../shared/withTimeout";
import { buildMachineOnlySyncSnapshot } from "./machineOnlySyncSnapshot";

export type SyncStatusParams = {
  includeTransferReadiness: boolean;
  forceTransferReadiness: boolean;
};

export type SyncStatusReadersOptions = {
  getLogger: () => Pick<Logger, "warn">;
  /**
   * The machine-scope read on the local runtime, or null without one. Its
   * transport budget must start after connect (see
   * LOCAL_RUNTIME_SYNC_STATUS_READ_TIMEOUT_MS); the cap here covers connect.
   */
  readMachineFromRuntime: ((params: SyncStatusParams) => Promise<SyncRoleSnapshot>) | null;
  /** The in-process sync service, used when there is no runtime to ask. */
  readMachineFromService: (params: SyncStatusParams) => Promise<SyncRoleSnapshot>;
};

/** How long one degradation reason stays quiet in the log while it persists. */
const DEGRADED_WARN_INTERVAL_MS = 60_000;

/** The one normalization of a status request: the cache key and the read both use it. */
export function syncStatusParams(arg?: SyncGetStatusArgs): SyncStatusParams {
  return {
    includeTransferReadiness: arg?.includeTransferReadiness === true,
    forceTransferReadiness: arg?.forceTransferReadiness === true,
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The two sync status reads the renderer polls: this machine's
 * (`sync.getLocalStatus`) and the window's project (`sync.getStatus`).
 *
 * Both share one contract. A read that does not answer by
 * LOCAL_RUNTIME_SYNC_STATUS_OVERALL_TIMEOUT_MS (25s on macOS, 45s on Windows,
 * connect included) is answered with the synthesized machine-only snapshot,
 * whose `degradedReason` tells every reader "this is not a reading". The
 * renderer's IPC timer for both channels sits above that cap, so the reader
 * sees this answer instead of the opaque "IPC handler timed out".
 */
export function createSyncStatusReaders(options: SyncStatusReadersOptions) {
  // A degraded local runtime stays degraded for as long as it takes a human to
  // fix it, and every renderer read logs the same sentence. Report the edge into
  // a reason, then at most once a minute while it persists — same shape as the
  // account publisher's warnOnce. A recovered read clears the latch, so the next
  // outage is reported immediately.
  let lastDegradedWarnReason: string | null = null;
  let lastDegradedWarnAtMs = 0;
  const warnDegraded = (reason: string): void => {
    const nowMs = Date.now();
    const suppressed =
      lastDegradedWarnReason === reason
      && nowMs - lastDegradedWarnAtMs < DEGRADED_WARN_INTERVAL_MS;
    if (suppressed) return;
    lastDegradedWarnReason = reason;
    lastDegradedWarnAtMs = nowMs;
    options.getLogger().warn("sync.local_status_degraded", { error: reason });
  };

  const readMachineUncapped = async (arg?: SyncGetStatusArgs): Promise<SyncRoleSnapshot> => {
    const params = syncStatusParams(arg);
    if (options.readMachineFromRuntime) {
      try {
        // Machine-level call: intentionally bypasses the window's local/remote
        // project binding so Connections can always describe this computer.
        const snapshot = await options.readMachineFromRuntime(params);
        lastDegradedWarnReason = null;
        return snapshot;
      } catch (error) {
        if (!isSyncServiceUnavailableError(error)) {
          // This is the ONLY source for the This-Machine card, and the card is
          // mostly about identity — the machine's name, platform and whether it
          // is reachable — which the desktop can answer without the background
          // service. Rejecting here blanked the whole card behind "Couldn't
          // load connection details" whenever the local runtime was down.
          // Answer with a machine-only snapshot whose routes are honestly all
          // down and whose blocking text carries the real reason instead.
          warnDegraded(reasonOf(error));
          return buildMachineOnlySyncSnapshot(error);
        }
      }
    }
    try {
      return await options.readMachineFromService(params);
    } catch (error) {
      return buildMachineOnlySyncSnapshot(error);
    }
  };

  /** This machine's status. Never rejects. */
  const readMachine = async (arg?: SyncGetStatusArgs): Promise<SyncRoleSnapshot> =>
    await withDeadline(
      readMachineUncapped(arg),
      LOCAL_RUNTIME_SYNC_STATUS_OVERALL_TIMEOUT_MS,
      () => new Error(
        `The background service did not answer within ${LOCAL_RUNTIME_SYNC_STATUS_OVERALL_TIMEOUT_MS}ms.`,
      ),
    ).catch((error: unknown) => {
      warnDegraded(reasonOf(error));
      return buildMachineOnlySyncSnapshot(error);
    });

  // Concurrent reads of the same project's status share one runtime call.
  // Connections re-reads every 5s and on every sync-status broadcast, so while
  // a cold runtime is still registering the project those reads used to pile
  // up, each holding its own wait.
  const projectReads = new Map<string, Promise<SyncRoleSnapshot>>();

  /**
   * A project's status. `rootKey` names what `read` routes to (the window's
   * local project root, or null for the machine-level fallback); reads with the
   * same key and flags share one call, and `read` gets the normalized flags
   * the key was built from. A real failure still rejects with its
   * own reason; only running out of time is answered for.
   */
  const readProject = async (
    rootKey: string | null,
    arg: SyncGetStatusArgs | undefined,
    read: (params: SyncStatusParams) => Promise<SyncRoleSnapshot>,
  ): Promise<SyncRoleSnapshot> => {
    const params = syncStatusParams(arg);
    // An omitted `includeTransferReadiness` is its own request: the in-process
    // service reads it as "include", unlike an explicit false.
    const key = JSON.stringify([
      rootKey,
      arg?.includeTransferReadiness === undefined,
      params.includeTransferReadiness,
      params.forceTransferReadiness,
    ]);
    const existing = projectReads.get(key);
    if (existing) return await existing;
    const deadlineError = new Error(
      "This project's background service did not answer in time. ADE will check again shortly.",
    );
    const pending: Promise<SyncRoleSnapshot> = withDeadline(
      read(params),
      LOCAL_RUNTIME_SYNC_STATUS_OVERALL_TIMEOUT_MS,
      () => deadlineError,
    ).catch((error: unknown) => {
      if (error !== deadlineError) throw error;
      warnDegraded(deadlineError.message);
      return buildMachineOnlySyncSnapshot(deadlineError);
    }).finally(() => {
      if (projectReads.get(key) === pending) projectReads.delete(key);
    });
    projectReads.set(key, pending);
    return await pending;
  };

  return { readMachine, readProject };
}
