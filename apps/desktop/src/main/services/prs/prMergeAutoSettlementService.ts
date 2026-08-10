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
import {
  stopSettledSessionMachinery,
  type SessionMachineryTeardownDeps,
} from "../sessions/sessionMachineryTeardown";

function isMergeAtOrAfter(mergedAt: string | null | undefined, enabledSince: string): boolean {
  const mergedMs = Date.parse(mergedAt ?? "");
  const enabledMs = Date.parse(enabledSince);
  return Number.isFinite(mergedMs) && Number.isFinite(enabledMs) && mergedMs >= enabledMs;
}

/** Which of a lane's sessions a merged PR is entitled to file. */
type MergeSettlementScope =
  /** The PR declared its chats; settle exactly those. */
  | { kind: "linked"; sessionIds: Set<string> }
  /** The PR declared none; sweep the lane minus what other PRs claim. */
  | { kind: "sweep"; claimedByOtherPrs: Set<string> }
  /** The PR declared none and a sibling is still live; settle nothing. */
  | { kind: "ambiguous" };

/**
 * A PR only carries `chatSessionIds` when it was opened or linked through ADE
 * with a session in hand. PRs created from a terminal (`gh pr create`) or
 * backfilled by GitHub polling arrive with none, and for those the lane-wide
 * sweep is the only thing that ever files their work — so it stays.
 *
 * But a sweep is a guess, and this path deliberately bypasses settlement
 * blockers, so it is bounded to lanes where it cannot be wrong: another live PR
 * in the lane means ownership is genuinely ambiguous and that PR's own merge
 * should file its work, and a session another PR explicitly claims belongs to
 * that PR's lifecycle rather than to this merge.
 *
 * A declaration always wins: when this PR names its sessions we settle exactly
 * those, even if a sibling claims them too.
 */
function resolveMergeSettlementScope(pr: PrSummary, snapshot: PrSummary[]): MergeSettlementScope {
  const declared = new Set(
    (pr.chatSessionIds ?? []).map((sessionId) => String(sessionId ?? "").trim()).filter(Boolean),
  );
  if (declared.size > 0) return { kind: "linked", sessionIds: declared };

  const claimedByOtherPrs = new Set<string>();
  for (const other of snapshot) {
    if (other.id === pr.id || other.laneId !== pr.laneId) continue;
    if (other.state === "open" || other.state === "draft") return { kind: "ambiguous" };
    for (const sessionId of other.chatSessionIds ?? []) {
      const trimmed = String(sessionId ?? "").trim();
      if (trimmed) claimedByOtherPrs.add(trimmed);
    }
  }
  return { kind: "sweep", claimedByOtherPrs };
}

export function createPrMergeAutoSettlementService(args: {
  db: Pick<AdeDb, "getJson" | "setJson">;
  sessionService: Pick<ReturnType<typeof createSessionService>, "get" | "list" | "settleSessionsWithOutcome">;
  /**
   * Optional so the service stays constructible in tests and headless hosts
   * without a chat runtime. Absent, the settle still files the row — it just
   * cannot stop what the row owns, which is the pre-teardown behaviour.
   */
  agentChatService?: SessionMachineryTeardownDeps["agentChatService"];
  logger?: SessionMachineryTeardownDeps["logger"];
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

  /**
   * The sessions a merged PR may consider, before the archived/settled/tool-type
   * filter that applies to all three scopes.
   *
   * Declared sessions are looked up by id rather than found inside a lane page:
   * the PR named them, so a long-lived lane whose session list runs past the
   * page size must not silently drop the ones it named. The explicit lane check
   * reproduces what the lane-scoped listing gave for free — a declared link can
   * outlive a lane move, and only this lane's work is this merge's to file.
   *
   * The sweep keeps the bounded listing: it is a guess, and a guess should stay
   * bounded.
   */
  const candidateSessionsFor = (scope: MergeSettlementScope, pr: PrSummary) => {
    switch (scope.kind) {
      case "ambiguous":
        return [];
      case "linked":
        return [...scope.sessionIds]
          .map((sessionId) => args.sessionService.get(sessionId))
          .filter((session): session is NonNullable<typeof session> => session != null)
          .filter((session) => session.laneId === pr.laneId);
      case "sweep":
        return args.sessionService.list({ laneId: pr.laneId, limit: 500 })
          .filter((session) => !scope.claimedByOtherPrs.has(session.id));
    }
  };

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
      const scope = resolveMergeSettlementScope(pr, prs);

      const rows = candidateSessionsFor(scope, pr).filter((session) =>
        !session.archivedAt
        && !session.settledAt
        && (isChatToolType(session.toolType) || isTrackedAgentCliToolType(session.toolType)),
      );

      const settledSessionIds: string[] = [];
      for (const session of rows) {
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
        // A merged PR is an explicit lifecycle decision: file the linked
        // session even when it still owns scheduled work, a background task,
        // or another normal settlement blocker. Real activity can unsettle it
        // again, while handledPrIds prevents this PR from filing it twice.
        //
        // Because this path deliberately bypasses the settlement blockers, it
        // is the one most likely to file a session that IS still running
        // something — which is exactly why the teardown has to run here too.
        // Without it, the merged lane's monitors kept polling and woke the
        // thread hours after the PR landed.
        await stopSettledSessionMachinery(
          {
            sessionService: args.sessionService,
            agentChatService: args.agentChatService ?? null,
            logger: args.logger ?? null,
          },
          [session.id],
        );
        settledSessionIds.push(...args.sessionService.settleSessionsWithOutcome(
          [session.id],
          `PR #${pr.githubPrNumber} merged`,
          polledAt,
          "pr_merge",
        ));
      }

      const finalSettings = getSessionLifecycleSettings(args.db);
      const finalState = getPrMergeAutoSettlementState(args.db);
      // Mark this PR handled even when its session had background work, and
      // even when the scope came back `ambiguous` and nothing was filed at all:
      // the merge itself is the explicit override, this one looked and decided,
      // and a later user reactivation belongs to a new lifecycle rather than to
      // this already-consumed merge.
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

      // Filing still happens for a PR we are meeting for the first time — the
      // merge is an explicit decision to file its linked sessions. Announcing
      // it does not: "PR #977 merged" is news only if you did not already
      // know, and a PR that was merged before we ever laid eyes on it is
      // history.
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
