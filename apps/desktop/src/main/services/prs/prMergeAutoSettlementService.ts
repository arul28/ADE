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

/**
 * The abort reasons that mean "something is running right now". Only these make
 * a retry wait: the others either resolve on their own or, in the case of
 * `teardown_failed`, describe work that is still running and still needs stopping.
 */
const ACTIVITY_ABORTS = new Set<string>(["turn_start", "turn_failed", "attention_requested"]);
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

export function createPrMergeAutoSettlementService(args: {
  db: Pick<AdeDb, "getJson" | "setJson">;
  sessionService: Pick<ReturnType<typeof createSessionService>, "get" | "list" | "settleSessionsReportingAborts">;
  emitEvent: (event: PrEventPayload) => void;
  /**
   * Liveness for a CHAT session, straight from the chat service.
   *
   * A chat's persisted `terminal_sessions` row is not usable for this. It holds
   * `status = "running"` between turns on purpose, and `runtimeState` is derived
   * from that column, so a raw row read reports a finished chat as still
   * running forever. `chatSessionProjection` is the only thing that resolves an
   * idle chat, and it resolves it from these two fields.
   *
   * Injected as a narrow callback rather than the whole chat service, matching
   * `chatMentionService.listChatSessions` and `laneTeardownDeps.agentChatService`.
   * Absent (or returning null) means "not a chat" — the caller then falls back
   * to the persisted row, which IS authoritative for tracked CLI sessions.
   */
  getChatLiveness?: (
    sessionId: string,
  ) => Promise<Pick<AgentChatSessionSummary, "status" | "awaitingInput"> | null>;
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
   * Sessions whose auto-settle was aborted by activity and that have not been
   * seen at rest since. Service-scoped on purpose: the retry happens on a LATER
   * poll, so a per-snapshot set would forget and retry unconditionally.
   *
   * In-memory only. After a restart the first poll retries once without waiting,
   * which is the pre-existing behavior and is bounded by the abort itself: if the
   * work is still running, the settle aborts again and re-arms this.
   */
  const abortedSessionIds = new Set<string>();

  /**
   * True when a session is not mid-turn, so a previously-aborted settle may
   * retry. Chat liveness comes from the chat service; everything else reads the
   * persisted row, which is authoritative for tracked CLI sessions.
   */
  const isAtRest = async (sessionId: string): Promise<boolean> => {
    const chat = await args.getChatLiveness?.(sessionId).catch(() => null);
    if (chat) return !chat.awaitingInput && chat.status !== "active";
    const row = args.sessionService.get(sessionId);
    if (!row) return true;
    const runtime = (row.runtimeState ?? "").toLowerCase();
    if (runtime) return runtime !== "running" && runtime !== "waiting-input";
    return (row.status ?? "").toLowerCase() !== "running";
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
        // A settle that already lost this race does not retry while the work
        // that won it is still going. Once step 3 attaches real teardown, an
        // unconditional retry would stop that work, once per poll.
        //
        // Three earlier gates were each wrong in a different way, so the
        // predicate below is deliberately narrow: a lifecycle-revision check
        // never re-arms (a turn COMPLETING does not touch the settle tuple), a
        // timer re-arms mid-turn, and the persisted row is blind to chat
        // liveness. Ask the chat service; fall back to the row only for the
        // tracked CLI sessions whose row does not lie.
        if (abortedSessionIds.has(session.id)) {
          if (!(await isAtRest(session.id))) {
            abandonedThisPr = true;
            continue;
          }
          abortedSessionIds.delete(session.id);
        }
        const settleResult = args.sessionService.settleSessionsReportingAborts([session.id], {
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
          // ONLY an activity abort waits for the turn to end. `teardown_failed`
          // means the stop itself failed while the work kept running — making it
          // wait for inactivity would never stop that work again, because the
          // work is exactly what it would be waiting on. `lifecycle_changed` and
          // `joined_in_flight` are momentary and clear on their own.
          if (settleResult.aborted.some((entry) => ACTIVITY_ABORTS.has(entry.reason))) {
            abortedSessionIds.add(session.id);
          }
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
