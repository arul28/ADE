import {
  adeReviewRemarkKey,
  buildPrWatchWakeCard,
  buildPrWatchWakeText,
  evaluatePrWatch,
  summarizePrWatchChanges,
  type PrChatWatchSummary,
  type PrWatchRemark,
} from "../../../shared/prWatch";
import type { AgentChatMessageSessionArgs } from "../../../shared/types/chat";
import type { PrActionRun, PrCheck, PrComment, PrEventPayload, PrReview, PrSummary } from "../../../shared/types/prs";
import { isChatToolType } from "../../../shared/sessionSpawnNesting";
import type { Logger } from "../logging/logger";
import { getErrorMessage, nowIso } from "../shared/utils";
import { prChatWatchSummary, type PrChatWatchRecord, type PrChatWatchStore } from "./prChatWatchStore";

/** How often every live watch re-reads its PR. */
const PR_WATCH_TICK_MS = 60_000;
/**
 * A watch re-reads checks and comments when the PR row changed, and at least
 * this often otherwise — GitHub does not always bump a PR's `updated_at` for a
 * check run.
 */
const PR_WATCH_DETAIL_REFRESH_MS = 3 * 60_000;
/** Log a failing wake delivery on the first attempt and every this many after. */
const PR_WATCH_DELIVERY_FAILURE_LOG_EVERY = 5;

type PrWatchChatState = {
  /** Settled chats keep their watch but are not woken until unsettled. */
  settled: boolean;
  archived: boolean;
};

export type PrWatchServiceDeps = {
  logger: Logger;
  prService: {
    listAll: () => PrSummary[];
    refresh: (args: { prIds: string[] }) => Promise<PrSummary[]>;
    getChecks: (prId: string) => Promise<PrCheck[]>;
    getComments: (prId: string) => Promise<PrComment[]>;
    getReviews: (prId: string) => Promise<PrReview[]>;
    /** Ship reads the head from the newest run when the PR row lags a push. */
    getActionRuns?: (prId: string) => Promise<PrActionRun[]>;
    chatWatchStore: PrChatWatchStore;
  };
  /** The chat's row; a missing or non-chat row ends its watch. */
  sessionService: {
    get: (sessionId: string) => { toolType?: string | null; settledAt?: string | null; archivedAt?: string | null } | null;
  };
  messageSession: (args: AgentChatMessageSessionArgs) => Promise<unknown>;
  emitPrEvent: (event: PrEventPayload) => void;
  getGithubBackgroundPauseUntilMs?: () => number | null | Promise<number | null>;
  tickMs?: number;
  now?: () => number;
};

type WatchMemory = {
  lastDetailAtMs: number;
  lastPrUpdatedAt: string | null;
  lastHeadSha: string | null;
  deliveryFailures: number;
};

function toRemarks(comments: PrComment[] | null, reviews: PrReview[] | null, ignored: Set<string>): {
  remarks: PrWatchRemark[] | null;
  ignored: Set<string>;
} {
  if (comments === null && reviews === null) return { remarks: null, ignored };
  const out: PrWatchRemark[] = [];
  const ignoredWithReviews = new Set(ignored);
  for (const comment of comments ?? []) {
    // ADE records a comment it posted by the id GitHub answered with; the
    // comment list keys the same comment as `issue:<node id>` /
    // `review:<node id>`. Any of the forms marks it as ADE's own.
    const keys = [
      comment.id,
      comment.id.replace(/^(?:issue|review):/, ""),
      comment.nodeId ?? "",
      comment.githubId != null ? String(comment.githubId) : "",
    ].filter(Boolean);
    if (keys.some((key) => ignored.has(key))) ignoredWithReviews.add(comment.id);
    out.push({
      id: comment.id,
      author: comment.author,
      authorIsBot: comment.authorIsBot,
      body: comment.body,
      path: comment.path,
      line: comment.line,
      url: comment.url,
      createdAt: comment.createdAt,
      kind: comment.source === "review" ? "review_comment" : "comment",
    });
  }
  for (const review of reviews ?? []) {
    if (!review.submittedAt || review.state === "pending") continue;
    const id = `review:${review.submittedAt}:${review.reviewer}`;
    if (ignored.has(adeReviewRemarkKey(review.submittedAt))) ignoredWithReviews.add(id);
    out.push({
      id,
      author: review.reviewer,
      authorIsBot: review.reviewerIsBot,
      body: review.body,
      createdAt: review.submittedAt,
      kind: "review",
      reviewState: review.state,
    });
  }
  return { remarks: out, ignored: ignoredWithReviews };
}

/**
 * The PR Watch / Ship reactor.
 *
 * Every minute, and right away when the PR poller reports a change, it
 * re-reads each live watch's PR, asks `evaluatePrWatch` what the agent has not
 * been told, wakes the chat through the ordinary message path (a wake starts a
 * turn on an idle chat and queues at the boundary of a running one), and only
 * after that delivery succeeds records what was told. A pass whose watch was
 * stopped or restarted meanwhile is discarded by `commitPass`.
 */
export function createPrWatchService(deps: PrWatchServiceDeps) {
  const { logger, prService } = deps;
  const store = prService.chatWatchStore;
  const now = deps.now ?? (() => Date.now());
  const memory = new Map<string, WatchMemory>();
  const inFlight = new Set<string>();
  /** Watches poked mid-pass (armed, switched): they run again right after. */
  const rerun = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const chatStateFor = (sessionId: string): PrWatchChatState | null => {
    const row = deps.sessionService.get(sessionId);
    if (!row || !isChatToolType(row.toolType)) return null;
    return { settled: Boolean(row.settledAt), archived: Boolean(row.archivedAt) };
  };

  /** Clients get the live watch, or null once it has stopped. */
  const emitWatchChanged = (record: PrChatWatchRecord, current: PrChatWatchRecord | null, pr: PrSummary | null) =>
    deps.emitPrEvent({
      type: "pr-chat-watch-changed",
      sessionId: record.sessionId,
      prId: record.prId,
      watch: current && !current.stoppedAt ? prChatWatchSummary(current, { githubPrNumber: pr?.githubPrNumber ?? null }) : null,
    });

  const stopWatch = (record: PrChatWatchRecord, reason: Parameters<PrChatWatchStore["stop"]>[1], pr: PrSummary | null) => {
    const stopped = store.stop(record.id, reason);
    memory.delete(record.id);
    emitWatchChanged(record, stopped, pr);
  };

  const runPass = async (record: PrChatWatchRecord, prs: Map<string, PrSummary>, force: boolean): Promise<void> => {
    const chat = chatStateFor(record.sessionId);
    let pr = prs.get(record.prId) ?? null;
    if (!chat || chat.archived) {
      stopWatch(record, "chat_gone", pr);
      return;
    }
    if (!pr) {
      stopWatch(record, "closed", null);
      return;
    }
    // A settled chat is asleep on purpose. Its watch resumes, with nothing
    // lost, when the chat is unsettled.
    if (chat.settled) return;

    const mem = memory.get(record.id) ?? { lastDetailAtMs: 0, lastPrUpdatedAt: null, lastHeadSha: null, deliveryFailures: 0 };
    memory.set(record.id, mem);
    const nowMs = now();

    if (pr.state === "open" || pr.state === "draft") {
      try {
        const refreshed = await prService.refresh({ prIds: [pr.id] });
        pr = refreshed.find((entry) => entry.id === pr!.id) ?? pr;
      } catch (error) {
        logger.debug("prs.watch_refresh_failed", { prId: pr.id, error: getErrorMessage(error) });
      }
    }

    const terminal = pr.state === "merged" || pr.state === "closed";
    const prChanged = pr.updatedAt !== mem.lastPrUpdatedAt || (pr.headSha ?? null) !== mem.lastHeadSha;
    const holding = record.state.held.length > 0;
    const detailDue = force || terminal || prChanged || holding || nowMs - mem.lastDetailAtMs >= PR_WATCH_DETAIL_REFRESH_MS;
    if (!detailDue) return;

    let checks: PrCheck[] | null = null;
    let comments: PrComment[] | null = null;
    let reviews: PrReview[] | null = null;
    if (!terminal) {
      [checks, comments, reviews] = await Promise.all([
        prService.getChecks(pr.id).catch(() => null),
        prService.getComments(pr.id).catch(() => null),
        prService.getReviews(pr.id).catch(() => null),
      ]);
    } else {
      // The last word before a merge or close still counts.
      [comments, reviews] = await Promise.all([
        prService.getComments(pr.id).catch(() => null),
        prService.getReviews(pr.id).catch(() => null),
      ]);
    }
    mem.lastDetailAtMs = nowMs;
    mem.lastPrUpdatedAt = pr.updatedAt;
    mem.lastHeadSha = pr.headSha ?? null;

    // Ship's review-bot grace counts from the head's first sighting, and the
    // PR row can lag a push that the check results already reflect. The newest
    // Actions run names the head those checks ran on.
    if (record.mode === "ship" && checks && prService.getActionRuns) {
      const runs = await prService.getActionRuns(pr.id).catch(() => null);
      const newest = (runs ?? []).reduce<PrActionRun | null>(
        (latest, run) => (!latest || run.createdAt > latest.createdAt ? run : latest),
        null,
      );
      if (newest?.headSha && newest.headSha !== pr.headSha) pr = { ...pr, headSha: newest.headSha };
    }

    const { remarks, ignored } = toRemarks(comments, reviews, store.adeCommentIds(pr.id));
    const evaluation = evaluatePrWatch({
      mode: record.mode,
      state: record.state,
      pr,
      checks,
      remarks,
      ignoredRemarkIds: ignored,
      nowMs,
    });

    let told: { summary: string; at: string } | null = null;
    if (evaluation.changes.length > 0) {
      const deliveredAt = nowIso();
      const ctx = {
        mode: record.mode,
        pr: {
          githubPrNumber: pr.githubPrNumber,
          githubUrl: pr.githubUrl,
          baseBranch: pr.baseBranch,
          headSha: pr.headSha ?? null,
        },
        changes: evaluation.changes,
        stop: evaluation.stop,
      };
      const summary = summarizePrWatchChanges(evaluation.changes);
      try {
        await deps.messageSession({
          sessionId: record.sessionId,
          kind: "wake",
          text: buildPrWatchWakeText(ctx),
          metadata: {
            prWatchWake: {
              watchId: record.id,
              prId: pr.id,
              githubPrNumber: pr.githubPrNumber,
              mode: record.mode,
              card: {
                ...buildPrWatchWakeCard({ ...ctx, watchId: record.id, deliveredAt }),
                navTarget: {
                  kind: "pr",
                  prId: pr.id,
                  prNumber: pr.githubPrNumber,
                  laneId: pr.laneId,
                  repoOwner: pr.repoOwner,
                  repoName: pr.repoName,
                  detailTab: evaluation.changes.some((change) => change.kind === "checks_failed") ? "checks" : "overview",
                },
                actions: [{ id: "open", label: "Open PR", kind: "primary" }],
              },
            },
          },
        });
        mem.deliveryFailures = 0;
        told = { summary, at: deliveredAt };
      } catch (error) {
        mem.deliveryFailures += 1;
        if (mem.deliveryFailures === 1 || mem.deliveryFailures % PR_WATCH_DELIVERY_FAILURE_LOG_EVERY === 0) {
          logger.warn("prs.watch_wake_delivery_failed", {
            watchId: record.id,
            sessionId: record.sessionId,
            prId: pr.id,
            attempts: mem.deliveryFailures,
            error: getErrorMessage(error),
          });
        }
        // Nothing is recorded: the same news is offered again next pass.
        return;
      }
    }

    const heldBefore = record.state.held.length > 0;
    const committed = store.commitPass({
      watchId: record.id,
      expectedStartedAt: record.startedAt,
      state: evaluation.next,
      told,
      stopReason: evaluation.stop,
    });
    if (!committed) return;
    if (evaluation.stop) memory.delete(record.id);
    if (told) {
      logger.info("prs.watch_woke_chat", {
        watchId: record.id,
        sessionId: record.sessionId,
        prId: pr.id,
        mode: record.mode,
        changes: evaluation.changes.map((change) => change.kind),
        stop: evaluation.stop,
      });
    }
    const heldAfter = evaluation.next.held.length > 0;
    if (told || evaluation.stop || heldBefore !== heldAfter) {
      emitWatchChanged(record, store.get(record.id), pr);
    }
  };

  const evaluate = async (options: { prIds?: readonly string[]; force?: boolean } = {}): Promise<void> => {
    if (disposed) return;
    // GitHub rate-limited ADE's background reads: wait it out like the poller.
    const pauseUntil = (await deps.getGithubBackgroundPauseUntilMs?.()) ?? 0;
    if (pauseUntil > now()) return;
    const records = store.list({ activeOnly: true })
      .filter((record) => !options.prIds || options.prIds.includes(record.prId));
    if (records.length === 0) return;
    const prs = new Map(prService.listAll().map((pr) => [pr.id, pr] as const));
    await Promise.all(records.map(async (record) => {
      if (inFlight.has(record.id)) {
        if (options.force) rerun.add(record.id);
        return;
      }
      inFlight.add(record.id);
      try {
        await runPass(record, prs, options.force === true);
      } catch (error) {
        logger.warn("prs.watch_pass_failed", { watchId: record.id, error: getErrorMessage(error) });
      } finally {
        inFlight.delete(record.id);
      }
      if (rerun.delete(record.id)) void evaluate({ prIds: [record.prId], force: true });
    }));
  };

  return {
    start(): void {
      if (timer || disposed) return;
      timer = setInterval(() => {
        void evaluate();
      }, deps.tickMs ?? PR_WATCH_TICK_MS);
      timer.unref?.();
      void evaluate();
    },
    /** A watch just armed takes its first look now, not on the next tick. */
    onPrEvent(event: PrEventPayload): void {
      if (event.type === "pr-chat-watch-changed" && event.watch?.status === "active") {
        void evaluate({ prIds: [event.prId], force: true });
      }
    },
    /** The PR poller saw these PRs change: re-read their watches now. */
    onPullRequestsChanged(prIds: readonly string[]): void {
      if (prIds.length === 0) return;
      void evaluate({ prIds, force: true });
    },
    evaluate,
    dispose(): void {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type PrWatchService = ReturnType<typeof createPrWatchService>;
