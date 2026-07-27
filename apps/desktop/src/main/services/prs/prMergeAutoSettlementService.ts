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
  const processSnapshot = async ({
    prs,
    polledAt,
  }: {
    prs: PrSummary[];
    polledAt: string;
  }): Promise<void> => {
    const settings = getSessionLifecycleSettings(args.db);
    const state = getPrMergeAutoSettlementState(args.db);
    if (!state) {
      initializePrMergeAutoSettlementState({
        db: args.db,
        currentPrs: prs,
        now: polledAt,
        enabled: settings.autoSettleLaneSessionsOnPrMerge,
      });
      return;
    }
    if (!settings.autoSettleLaneSessionsOnPrMerge || !state.enabledSince) return;

    const enabledSince = state.enabledSince;
    const candidates = prs.filter(
      (pr) =>
        pr.state === "merged"
        && !state.handledPrIds.includes(pr.id)
        && isMergeAtOrAfter(pr.mergedAt, enabledSince),
    );

    for (const pr of candidates) {
      const rows = args.sessionService.list({
        laneId: pr.laneId,
        limit: 500,
      }).filter((session) =>
        !session.archivedAt
        && !session.settledAt
        && (isChatToolType(session.toolType) || isTrackedAgentCliToolType(session.toolType)),
      );

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

      if (settledSessionIds.length > 0) {
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
  };

  return {
    async processSnapshot(snapshot: { prs: PrSummary[]; polledAt: string }): Promise<void> {
      await processSnapshot(snapshot);
    },
  };
}
