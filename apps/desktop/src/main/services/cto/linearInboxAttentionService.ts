import type { Logger } from "../logging/logger";
import type { LaneSummary, LinearInboxNotification } from "../../../shared/types";

/**
 * Raises "needs you" on a lane's chat when the connected person gets a Linear
 * inbox item (a mention, a comment, an assignment) about an issue that lane is
 * linked to. Items about other issues stay in the Linear pane's inbox.
 *
 * Only items newer than the stored watermark count, so turning this on never
 * floods Work with old notifications.
 */
const WATERMARK_KEY = "linear.inbox.attentionWatermark.v1";
const POLL_INTERVAL_MS = 2 * 60_000;
// Types worth interrupting a lane for. Reactions and subscriptions are not.
const ATTENTION_TYPES = new Set([
  "issueMention",
  "issueCommentMention",
  "issueNewComment",
  "issueAssignedToYou",
  "issueStatusChanged",
  "issuePriorityUrgent",
]);

const VERBS: Record<string, string> = {
  issueMention: "mentioned you on",
  issueCommentMention: "mentioned you in a comment on",
  issueNewComment: "commented on",
  issueAssignedToYou: "assigned you",
  issueStatusChanged: "changed the status of",
  issuePriorityUrgent: "marked urgent",
};

export function createLinearInboxAttentionService(deps: {
  logger: Logger;
  kv: { getJson<T>(key: string): T | null; setJson(key: string, value: unknown): void };
  isLinearConnected: () => boolean;
  listNotifications: () => Promise<LinearInboxNotification[]>;
  listLanes: () => Promise<Pick<LaneSummary, "id" | "linearIssue" | "linearIssueLinks">[]>;
  /** Most recent chat or CLI session in the lane, if any. */
  latestSessionInLane: (laneId: string) => string | null;
  requestAttention: (sessionId: string, message: string) => void;
}) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running || !deps.isLinearConnected()) return;
    running = true;
    try {
      const watermark = deps.kv.getJson<string>(WATERMARK_KEY);
      const notifications = await deps.listNotifications();
      const newest = notifications.reduce<string | null>((max, item) => (!max || item.createdAt > max ? item.createdAt : max), watermark);
      if (!watermark) {
        // First run: start from now.
        deps.kv.setJson(WATERMARK_KEY, newest ?? new Date().toISOString());
        return;
      }
      const fresh = notifications.filter((item) => item.createdAt > watermark && item.issueId && ATTENTION_TYPES.has(item.type));
      if (fresh.length > 0) {
        const lanes = await deps.listLanes();
        const laneByIssue = new Map<string, string>();
        for (const lane of lanes) {
          if (lane.linearIssue?.id) laneByIssue.set(lane.linearIssue.id, lane.id);
          for (const link of lane.linearIssueLinks ?? []) {
            if (link.issue?.id && !laneByIssue.has(link.issue.id)) laneByIssue.set(link.issue.id, lane.id);
          }
        }
        for (const item of fresh) {
          const laneId = laneByIssue.get(item.issueId!);
          if (!laneId) continue;
          const sessionId = deps.latestSessionInLane(laneId);
          if (!sessionId) continue;
          const verb = VERBS[item.type] ?? "updated";
          const preview = item.commentBody ? `: “${item.commentBody.replace(/\s+/g, " ").slice(0, 160)}”` : "";
          deps.requestAttention(sessionId, `${item.actorName ?? "Someone"} ${verb} ${item.issueIdentifier ?? "the issue"} in Linear${preview}`);
        }
      }
      if (newest) deps.kv.setJson(WATERMARK_KEY, newest);
    } catch (error) {
      deps.logger.warn("linear_inbox.attention_poll_failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    pollNow: tick,
  };
}
