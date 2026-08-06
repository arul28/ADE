import type { createAgentChatService } from "../chat/agentChatService";
import type { createSessionService } from "../sessions/sessionService";
import type { AdeDb } from "../state/kvDb";
import type { PrEventPayload, PrSummary } from "../../../shared/types";
import {
  getPrMergeAutoSettlementState,
  getSessionLifecycleSettings,
  initializePrMergeAutoSettlementState,
  savePrMergeAutoSettlementState,
} from "../sessions/sessionLifecycleSettings";
import {
  isTrackedAgentCliToolType,
} from "../../../shared/types";
import { isChatToolType } from "../sessions/chatSessionProjection";

function isMergeAtOrAfter(mergedAt: string | null | undefined, enabledSince: string): boolean {
  const mergedMs = Date.parse(mergedAt ?? "");
  const enabledMs = Date.parse(enabledSince);
  return Number.isFinite(mergedMs) && Number.isFinite(enabledMs) && mergedMs >= enabledMs;
}

export function createPrMergeAutoSettlementService(args: {
  db: Pick<AdeDb, "getJson" | "setJson">;
  sessionService: Pick<ReturnType<typeof createSessionService>, "list" | "settleSessionsWithOutcome">;
  agentChatService: Pick<ReturnType<typeof createAgentChatService>, "getSettlementBlockers">;
  emitEvent: (event: PrEventPayload) => void;
}) {
  /**
   * The currently open or draft PRs in the previous snapshot, so a merge we
   * WATCHED can be told apart from one that was already history when it arrived.
   *
   * `handledPrIds` cannot answer this. It is keyed by `pr.id`, which the GitHub
   * backfill mints with `randomUUID()` per machine — so the same PR carries
   * different ids in different machines' databases and the list never matches
   * across them. Nor can `enabledSince`: it asks "did this merge after we turned
   * the feature on", which is true of every PR merged in the last several weeks.
   *
   * Together those made switching the project tab to another machine announce
   * its entire merge history: that machine reconciles, backfills rows for PRs it
   * had never stored, and every one of them looks brand new and freshly merged.
   *
   * Deliberately in memory. Restarting ADE means we did not watch anything, so
   * treating the first snapshot as history is the correct answer, not a lost
   * one — the same conclusion `lifecycleNotificationKind` reaches when it
   * returns null for a first-sight merged PR.
   */
  // The polling snapshot includes every PR stored for the project, including
  // terminal history. Only currently open or draft PRs can later produce a
  // merge transition, so retain that bounded watch set instead of every state
  // we have ever observed.
  const previouslyWatchablePrIds = new Set<string>();

  const processSnapshot = async ({
    prs,
    polledAt,
  }: {
    prs: PrSummary[];
    polledAt: string;
  }): Promise<void> => {
    // Captured before anything can mutate it, and updated only at the end of a
    // successful pass, so a snapshot that returns early does not silently
    // consume its own evidence.
    const previouslyWatchedPrIds = new Set(previouslyWatchablePrIds);
    const rememberSnapshot = () => {
      previouslyWatchablePrIds.clear();
      for (const pr of prs) {
        if (pr.state === "draft" || pr.state === "open") previouslyWatchablePrIds.add(pr.id);
      }
    };
    const settings = getSessionLifecycleSettings(args.db);
    const state = getPrMergeAutoSettlementState(args.db);
    if (!state) {
      initializePrMergeAutoSettlementState({
        db: args.db,
        currentPrs: prs,
        now: polledAt,
        enabled: settings.autoSettleLaneSessionsOnPrMerge,
      });
      rememberSnapshot();
      return;
    }
    if (!settings.autoSettleLaneSessionsOnPrMerge || !state.enabledSince) {
      rememberSnapshot();
      return;
    }

    const enabledSince = state.enabledSince;
    const candidates = prs.filter(
      (pr) =>
        pr.state === "merged"
        && !state.handledPrIds.includes(pr.id)
        && isMergeAtOrAfter(pr.mergedAt, enabledSince),
    );

    for (const pr of candidates) {
      const linkedChatSessionIds = new Set(
        (pr.chatSessionIds ?? []).map((sessionId) => String(sessionId ?? "").trim()).filter(Boolean),
      );
      const rows = args.sessionService.list({
        laneId: pr.laneId,
        limit: 500,
      }).filter((session) =>
        !session.archivedAt
        && !session.settledAt
        && (isChatToolType(session.toolType) || isTrackedAgentCliToolType(session.toolType)),
      ).filter((session) => linkedChatSessionIds.size === 0 || linkedChatSessionIds.has(session.id));

      const settledSessionIds: string[] = [];
      for (const session of rows) {
        const blockers = await args.agentChatService.getSettlementBlockers(
          session.id,
          { includeCurrentTurn: true },
        );
        const currentSettings = getSessionLifecycleSettings(args.db);
        const currentState = getPrMergeAutoSettlementState(args.db);
        if (
          !currentSettings.autoSettleLaneSessionsOnPrMerge
          || !currentState?.enabledSince
          || currentState.handledPrIds.includes(pr.id)
          || !isMergeAtOrAfter(pr.mergedAt, currentState.enabledSince)
        ) {
          break;
        }
        if (blockers.length === 0) {
          settledSessionIds.push(...args.sessionService.settleSessionsWithOutcome(
            [session.id],
            `PR #${pr.githubPrNumber} merged`,
            polledAt,
            "pr_merge",
          ));
        }
      }

      const finalSettings = getSessionLifecycleSettings(args.db);
      const finalState = getPrMergeAutoSettlementState(args.db);
      if (
        finalSettings.autoSettleLaneSessionsOnPrMerge
        && finalState?.enabledSince
        && !finalState.handledPrIds.includes(pr.id)
        && isMergeAtOrAfter(pr.mergedAt, finalState.enabledSince)
      ) {
        savePrMergeAutoSettlementState(args.db, {
          ...finalState,
          handledPrIds: [...finalState.handledPrIds, pr.id],
        });
      }

      // Settling still happens for a PR we are meeting for the first time —
      // its sessions really are finished and should be filed. Announcing it
      // does not: "PR #977 merged" is news only if you did not already know,
      // and a PR that was merged before we ever laid eyes on it is history.
      //
      // Gated here rather than in the toast so every consumer inherits it —
      // desktop toasts, mobile push, and anything added later.
      const watchedItMerge = previouslyWatchedPrIds.has(pr.id);
      if (settledSessionIds.length > 0 && watchedItMerge) {
        args.emitEvent({
          type: "pr-sessions-auto-settled",
          timestamp: polledAt,
          laneId: pr.laneId,
          prId: pr.id,
          prNumber: pr.githubPrNumber,
          githubUrl: pr.githubUrl,
          settledSessionIds,
          settledCount: settledSessionIds.length,
        });
      }
    }
    rememberSnapshot();
  };

  return {
    async processSnapshot(snapshot: { prs: PrSummary[]; polledAt: string }): Promise<void> {
      await processSnapshot(snapshot);
    },
  };
}
