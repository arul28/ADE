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
import type { AgentChatSessionSummary } from "../../../shared/types";

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

/**
 * What a chat's liveness looks like to a caller that is not the chat service.
 *
 * Deliberately `status` alone. The sole consumer (`hasActiveChatTurn`) acts on
 * nothing else — `awaitingInput` is a stable resting state, not a running turn
 * — so carrying it would only invite a future reader to defer on it.
 */
export type ChatLivenessSummary = Pick<AgentChatSessionSummary, "status">;

/**
 * The one adapter from the chat service to a `getChatLiveness` callback.
 *
 * Both hosts that own a PR poller wire it — desktop `main.ts` and the brain's
 * `bootstrap.ts` — and in a normal install it is the BRAIN that polls, so a
 * desktop-only copy would protect nobody. Exported so the two cannot drift into
 * disagreeing about what "live" means.
 *
 * Reports `status` and nothing else; what counts as "active" is the consumer's
 * policy, but no consumer needs any other field to decide it.
 */
export function chatLivenessReader(
  agentChatService: { getSessionSummary: (sessionId: string) => Promise<AgentChatSessionSummary | null> },
): (sessionId: string) => Promise<ChatLivenessSummary | null> {
  return async (sessionId: string) => {
    const summary = await agentChatService.getSessionSummary(sessionId);
    return summary ? { status: summary.status } : null;
  };
}

export function createPrMergeAutoSettlementService(args: {
  db: Pick<AdeDb, "getJson" | "setJson">;
  sessionService: Pick<ReturnType<typeof createSessionService>, "get" | "list" | "settleSessionsReportingAborts">;
  emitEvent: (event: PrEventPayload) => void;
  /**
   * Liveness for a CHAT session, straight from the chat service — see
   * `chatLivenessReader`, which is how both hosts build it.
   *
   * A chat's persisted `terminal_sessions` row is not usable for this. It holds
   * `status = "running"` between turns on purpose, and `runtimeState` is derived
   * from that column, so a raw row read reports a finished chat as still
   * running forever. `chatSessionProjection` is the only thing that resolves an
   * idle chat, and it resolves it from these two fields.
   *
   * Injected as a narrow callback rather than the whole chat service, matching
   * `chatMentionService.listChatSessions` and `laneTeardownDeps.agentChatService`.
   * Absent, or returning null, means "no evidence of a turn" — see
   * `hasActiveChatTurn`.
   */
  getChatLiveness?: (sessionId: string) => Promise<ChatLivenessSummary | null>;
  logger?: { debug: (event: string, meta?: Record<string, unknown>) => void };
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

  /**
   * True only when a chat turn is verifiably running right now.
   *
   * Deliberately the sole reason to defer. The gate mirrors teardown's own
   * refusal, which triggers on `before.active` alone, so anything teardown
   * would accept must not be held back here: `awaitingInput` is a stable
   * resting state, and no answer to a chat's `terminal_sessions` row is
   * evidence of a turn — that column holds `running` for the life of a tracked
   * CLI terminal and between chat turns, so reading it defers forever and no
   * merged PR is ever settled or announced.
   *
   * No liveness (no `getChatLiveness`, or nothing for this session — every
   * non-chat and tracked-CLI row) therefore settles immediately, as it did
   * before this gate existed. Teardown's `mayInterruptActiveTurn` policy is the
   * backstop: if a turn is somehow running it aborts rather than interrupting.
   *
   * A THROWN read is the one case that is not "no liveness": an unreachable
   * liveness source is not evidence the turn ended, so it counts as active and
   * defers this poll. Teardown is not a backstop here — a `readActiveWork` that
   * fails the same way returns `timedOutResidue` with no `abortedBy`, so the
   * settle would go through unnoticed.
   */
  const hasActiveChatTurn = async (sessionId: string): Promise<boolean> => {
    try {
      const chat = await args.getChatLiveness?.(sessionId);
      return chat?.status === "active";
    } catch {
      return true;
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
    // Ids whose merge this pass watched but could not finish filing, because a
    // session became active mid-settle. Kept watchable so the retry can still
    // announce: `watchedItMerge` is what gates the toast, and a merged PR is
    // otherwise dropped from the watchable set at the end of every pass — so
    // without this the retry settles the session silently and the user never
    // learns their PR merged.
    const unfinishedMergePrIds = new Set<string>();
    const rememberSnapshot = () => {
      previouslyWatchablePrIds.clear();
      for (const pr of prs) {
        if (pr.state === "draft" || pr.state === "open") previouslyWatchablePrIds.add(pr.id);
      }
      for (const id of unfinishedMergePrIds) previouslyWatchablePrIds.add(id);
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
      let abandonedThisPr = false;
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
        // The one thing a merge does NOT outrank is a chat turn running right
        // now: teardown refuses to cancel one for a machine-initiated settle,
        // so attempting anyway would abort every poll for as long as the turn
        // runs. That — and nothing else — is deferred, on every attempt, with
        // no time cap. A deferral is never an abandonment; the retry costs one
        // poll.
        if (await hasActiveChatTurn(session.id)) {
          args.logger?.debug("prs.auto_settle_deferred_active_turn", {
            prNumber: pr.githubPrNumber,
            laneId: pr.laneId,
            sessionId: session.id,
          });
          abandonedThisPr = true;
          continue;
        }
        const settleResult = await args.sessionService.settleSessionsReportingAborts([session.id], {
          outcome: `PR #${pr.githubPrNumber} merged`,
          settledAt: polledAt,
          source: "pr_merge",
        });
        settledSessionIds.push(...settleResult.settled);
        if (settleResult.aborted.length) {
          // The session became active while the settle was in flight. Leaving
          // the PR unhandled is the point: a later pass retries, instead of this
          // merge being consumed by a settle that never landed.
          abandonedThisPr = true;
          // No per-reason bookkeeping: the gate above re-reads liveness on
          // every attempt, so every abort reason retries as soon as the
          // session is quiet.
        }
      }

      const finalSettings = getSessionLifecycleSettings(args.db);
      // An abandoned settle must not consume the merge. `handledPrIds` is the
      // only thing that would stop a later pass from retrying, and the whole
      // reason the outcome is typed is so this branch can exist.
      if (abandonedThisPr) unfinishedMergePrIds.add(pr.id);
      const finalState = getPrMergeAutoSettlementState(args.db);
      // Mark this PR handled even when its session had background work, and
      // even when the scope came back `ambiguous` and nothing was filed at all:
      // the merge itself is the explicit override, this one looked and decided,
      // and a later user reactivation belongs to a new lifecycle rather than to
      // this already-consumed merge.
      if (
        !abandonedThisPr
        && finalSettings.autoSettleLaneSessionsOnPrMerge
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
