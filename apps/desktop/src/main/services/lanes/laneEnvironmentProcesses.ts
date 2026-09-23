import type { ChildProcess } from "node:child_process";
import type { LaneEnvInitEvent } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { isPathInside } from "../shared/pathCompare";
import { signalChildProcessTree } from "../shared/utils";

/**
 * Runtime bookkeeping for lane env init: the event fan-out, the setup
 * processes still running per lane, and the cooperative cancellation flags an
 * archive/delete/aborted launch raises against an in-flight init.
 */
export function createLaneEnvironmentProcesses({
  logger,
  broadcastToRuntime,
}: {
  logger: Logger;
  broadcastToRuntime: (ev: LaneEnvInitEvent) => void;
}) {
  // In-process observers (the chat-launch service mirrors a lane's env steps
  // into its launch card) see exactly what the runtime event stream sees.
  const eventListeners = new Set<(ev: LaneEnvInitEvent) => void>();

  // Setup commands still running, by working directory, so an aborted launch
  // can stop an `npm install` or setup script inside the lane it is deleting
  // instead of letting it outlive the worktree.
  const activeChildren = new Map<ChildProcess, string>();

  /**
   * Lanes whose cleanup is waiting behind an in-flight init.
   *
   * Serializing is not enough on its own: a full init can legitimately run for
   * minutes (dependency installs and `docker compose up` have 120s/300s budgets
   * each, and lane creation kicks init off detached), so an archive or delete
   * arriving mid-init would sit in the queue that whole time with no signal.
   * The cleanup wrapper raises the flag before it enqueues and `runPlannedInit`
   * reads it at every step boundary, so init stops at the next boundary instead
   * of running the rest of a sequence whose lane is about to go away.
   *
   * Cooperative by design: already-spawned children keep their own timeouts,
   * they are not killed here (only `abortLaneEnvironment` kills them).
   */
  const cleanupRequested = new Set<string>();

  /** Inits that have been enqueued and not yet settled, per lane. */
  const inFlightInits = new Map<string, number>();

  return {
    broadcastEvent(ev: LaneEnvInitEvent): void {
      broadcastToRuntime(ev);
      for (const listener of [...eventListeners]) {
        try {
          listener(ev);
        } catch (error) {
          logger.warn("lane_env_init.listener_failed", {
            laneId: ev.progress.laneId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },

    /** Observe every env-init progress update for every lane. Returns the unsubscribe. */
    onEvent(listener: (ev: LaneEnvInitEvent) => void): () => void {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    /** Track a spawned setup command until it closes or errors. */
    trackChild(child: ChildProcess, cwd: string): void {
      activeChildren.set(child, cwd);
      child.once("close", () => activeChildren.delete(child));
      child.once("error", () => activeChildren.delete(child));
    },

    noteInitStarted(laneId: string): void {
      inFlightInits.set(laneId, (inFlightInits.get(laneId) ?? 0) + 1);
    },

    noteInitSettled(laneId: string): void {
      const remaining = (inFlightInits.get(laneId) ?? 1) - 1;
      if (remaining > 0) inFlightInits.set(laneId, remaining);
      else inFlightInits.delete(laneId);
    },

    hasInFlightInit(laneId: string): boolean {
      return inFlightInits.has(laneId);
    },

    requestCleanup(laneId: string): void {
      cleanupRequested.add(laneId);
    },

    isCleanupRequested(laneId: string): boolean {
      return cleanupRequested.has(laneId);
    },

    clearCleanupRequest(laneId: string): void {
      cleanupRequested.delete(laneId);
    },

    /**
     * Stop a lane's environment setup now: the running init stops at its next
     * step boundary and every setup command still running inside the lane's
     * worktree is killed. Used when a launch that owns the lane is cancelled —
     * the lane is about to be deleted, so there is nothing to wait for.
     */
    abortLaneEnvironment(laneId: string, worktreePath: string | null | undefined): number {
      if (inFlightInits.has(laneId)) cleanupRequested.add(laneId);
      if (!worktreePath) return 0;
      let killed = 0;
      for (const [child, cwd] of activeChildren) {
        if (!isPathInside(cwd, worktreePath)) continue;
        signalChildProcessTree(child, "SIGKILL");
        activeChildren.delete(child);
        killed += 1;
      }
      if (killed > 0) logger.info("lane_env_init.aborted", { laneId, killed });
      return killed;
    },

    /** Drop cancellation bookkeeping on service dispose. */
    reset(): void {
      cleanupRequested.clear();
      inFlightInits.clear();
    },
  };
}

export type LaneEnvironmentProcesses = ReturnType<typeof createLaneEnvironmentProcesses>;
