import type { createAgentChatService } from "../../../../desktop/src/main/services/chat/agentChatService";
import type { LaneShareRightsStore } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";
import { laneShareRightsEnded } from "../../../../desktop/src/shared/laneShareRights";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { activeLaneShareGrantsFor, LANE_SHARE_GRANT_MAX_AGE_MS, type LaneShareGrantSnapshot } from "./laneShareGrantService";
import { laneShareSessionWithinLocks, type LaneShareSessionModes } from "./laneShareGuestPolicy";

/**
 * The messages a lane share guest queued in a chat on this host (the rights
 * store's "steer" items), connected or not. A queued message runs later,
 * when the chat's turn ends, so the share is checked again as it starts
 * (`admit`, called by the chat service), on every grant refresh (`mayStart`
 * from the guest host), and when the share closes (`removeQueued`).
 */
export function createLaneShareGuestQueue(deps: {
  laneShareRights: LaneShareRightsStore | null;
  /** The last good grant list, or null before the first. */
  grants: () => LaneShareGrantSnapshot | null;
  chat: () => Pick<ReturnType<typeof createAgentChatService>, "cancelSteer"> | null;
  laneState: (laneId: string) => "active" | "archived" | "missing";
  rightsMatchLane: (grantId: string, laneId: string) => boolean;
  logger: Pick<Logger, "info" | "warn">;
}) {
  const { laneShareRights: store, logger } = deps;

  /** Grants whose guest has messages queued. */
  function grantsWithQueued(): string[] {
    try {
      return store?.grantsWithItems("steer") ?? [];
    } catch (error) {
      logger.warn("sync_host.lane_share_queue_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /**
   * Whether a guest message of `grantId` may start now, by this host's own
   * records: the rights row (sending, end date, lane not paused) and the last
   * grant list, which must be younger than the age bound and name the grant
   * active for `userId` (the grant's receiver when null).
   */
  function mayStart(grantId: string, userId: string | null): boolean {
    const nowMs = Date.now();
    let record: ReturnType<LaneShareRightsStore["get"]> = null;
    try {
      record = store?.get(grantId) ?? null;
    } catch (error) {
      // Fails closed: the queued message does not start.
      logger.warn("sync_host.lane_share_queue_read_failed", { grantId, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    const rights = record?.rights ?? null;
    if (!record || !rights || (!rights.speak.send && !rights.speak.steer) || laneShareRightsEnded(rights, nowMs)) return false;
    if (deps.laneState(record.laneId) !== "active") return false;
    const current = deps.grants();
    if (!current || nowMs - current.fetchedAtMs > LANE_SHARE_GRANT_MAX_AGE_MS || current.closedIds?.includes(grantId)) return false;
    const receiver = userId ?? current.grants.find((grant) => grant.id === grantId)?.receiverUserId ?? null;
    return receiver != null && activeLaneShareGrantsFor(current, receiver, nowMs)
      .some((grant) => grant.grantId === grantId && deps.rightsMatchLane(grant.grantId, grant.laneId));
  }

  /**
   * The chat's model and mode, as they are when the message starts, against
   * the grant's rights as they are now. No chat to compare fails closed.
   */
  function withinLocksNow(grantId: string, session: LaneShareSessionModes | null): boolean {
    if (!session) return false;
    try {
      const rights = store?.get(grantId)?.rights ?? null;
      return rights != null && laneShareSessionWithinLocks(rights, session) == null;
    } catch (error) {
      logger.warn("sync_host.lane_share_queue_read_failed", { grantId, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /** A message that left the queue: no longer the guest's to remove. */
  function forget(steerId: string): string | null {
    try {
      const grantId = store?.itemGrant("steer", steerId) ?? null;
      if (grantId) store?.removeItem(grantId, "steer", steerId);
      return grantId;
    } catch (error) {
      logger.warn("sync_host.lane_share_queue_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * The chat service asks as a queued guest message starts. The message is
   * no longer queued either way; it runs only when its share still allows
   * it. A message no grant recorded (not yet, or no more) does not run.
   */
  function admit(input: { steerId: string; author: { userId: string }; session?: LaneShareSessionModes | null }): boolean {
    const grantId = forget(input.steerId);
    const admitted = grantId != null && mayStart(grantId, input.author.userId) && withinLocksNow(grantId, input.session ?? null);
    if (!admitted) logger.info("sync_host.lane_share_queued_message_dropped", { grantId });
    return admitted;
  }

  /**
   * Removes the messages a grant's guest queued that have not started. Runs
   * when the share ends, expires or is left, and when the share may no longer
   * send. Returns how many it removed.
   */
  async function removeQueued(grantId: string): Promise<number> {
    const chat = deps.chat();
    if (!store || !chat) return 0;
    let removed = 0;
    for (const steer of store.listItems(grantId, "steer")) {
      if (!steer.sessionId) continue;
      try {
        await chat.cancelSteer({ sessionId: steer.sessionId, steerId: steer.itemId, requireQueued: true });
        removed += 1;
      } catch {
        // Already started or gone: nothing to remove.
      }
      store.removeItem(grantId, "steer", steer.itemId);
    }
    return removed;
  }

  /** `removeQueued` started from a sync path; a failure is logged. */
  function dropQueuedSoon(grantId: string): void {
    void removeQueued(grantId).catch((error) => {
      logger.warn("sync_host.lane_share_queue_drop_failed", {
        grantId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return { grantsWithQueued, mayStart, forget, admit, removeQueued, dropQueuedSoon };
}
