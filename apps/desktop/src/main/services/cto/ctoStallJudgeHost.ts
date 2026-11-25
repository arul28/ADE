import type { AgentChatProvider, AgentChatSessionSummary, PendingInputRequest } from "../../../shared/types/chat";
import type { CtoNeedsSnapshot } from "../../../shared/types/cto";
import type { PrSummary } from "../../../shared/types/prs";
import type { TerminalSessionDetail } from "../../../shared/types/sessions";
import type { Logger } from "../logging/logger";
import { getErrorMessage, nowIso } from "../shared/utils";
import {
  createCtoStallJudge,
  ctoChildMovedAt,
  type CtoChildFacts,
  type CtoNeedChild,
  type CtoStallJudge,
} from "./ctoStallJudge";

/**
 * The chat service's side of the CTO stall judge: it reads the CTO's children
 * out of the chat service (loaded chats, saved rows, summaries, the PR cache)
 * as the judge's facts, and answers the CTO's `setNeed` and the clients'
 * `getNeeds`. Children on this machine only: a chat the CTO started on another
 * machine has no parent link here and keeps its check-back schedule.
 */

type KvDb = { getJson: (key: string) => unknown; setJson: (key: string, value: unknown) => void };

/** What the host reads about a chat loaded in this brain. Memory only, so it is cheap on every chat event. */
export type CtoHostLoadedChat = { parentId: string | null; identityKey: string | null; deleted: boolean };

export type CtoStallJudgeHostDeps = {
  logger: Pick<Logger, "info" | "warn">;
  db: KvDb | null;
  /** A chat loaded in this brain, or null. */
  loadedChat: (sessionId: string) => CtoHostLoadedChat | null;
  loadedChatIds: () => Iterable<string>;
  /** The cards a loaded chat shows; undefined when the chat is not loaded here. */
  pendingRequests: (sessionId: string) => readonly PendingInputRequest[] | undefined;
  /** The CTO is mid-turn or blocked on the person. */
  ctoBusy: (ctoSessionId: string) => boolean;
  /** The chat's saved row. */
  sessionRow: (sessionId: string) => TerminalSessionDetail | null;
  summary: (sessionId: string) => Promise<AgentChatSessionSummary | null>;
  /** Every unarchived chat, for the one-time list of the CTO's children. */
  listChats: () => Promise<AgentChatSessionSummary[]>;
  /** Every CTO thread, newest first, for the one-time list of CTOs. */
  listCtoChats: () => Promise<AgentChatSessionSummary[]>;
  /** Another live brain runs this chat. */
  ownedByAnotherBrain: (sessionId: string) => boolean;
  prForLane: (laneId: string) => PrSummary | null;
  defaultTitle: (provider: AgentChatProvider) => string;
  wakeCto: (ctoSessionId: string, text: string) => Promise<void>;
};

export type CtoStallJudgeHost = {
  judge: CtoStallJudge;
  /** The CTO's "Waiting on you" lines. Read-only. */
  getCtoNeeds: () => Promise<CtoNeedsSnapshot>;
  /** The CTO's `setNeed`. Refused for a chat this CTO did not start. */
  setCtoNeed: (args: { ctoSessionId: string; childSessionId: string; line: string | null }) => Promise<{ set: boolean; line: string | null }>;
};

/** A chat silent this long that is not loaded is history; its summary is not read. */
const HISTORY_MS = 25 * 60 * 60_000;

export function createCtoStallJudgeHost(deps: CtoStallJudgeHostDeps): CtoStallJudgeHost {
  /** The CTO thread a loaded chat reports to, when both are loaded here. */
  const ctoParentOf = (sessionId: string): string | null => {
    const parentId = deps.loadedChat(sessionId)?.parentId?.trim();
    if (!parentId || parentId === sessionId) return null;
    return deps.loadedChat(parentId)?.identityKey === "cto" ? parentId : null;
  };

  /**
   * A list read once and kept (it costs a summary per chat), retried after a
   * failure. The loaded chats add whatever came later.
   */
  const onceList = <T>(read: () => Promise<T[]>, what: string) => {
    let cached: Promise<T[]> | null = null;
    return async (): Promise<T[]> => {
      cached ??= read().catch((error: unknown) => {
        cached = null;
        deps.logger.warn("cto.stall_judge.list_failed", { what, error: getErrorMessage(error) });
        throw error;
      });
      return await cached;
    };
  };
  const seededChildLinks = onceList(async () => (await deps.listChats()).flatMap((row) => {
    const parentId = row.orchestrationParentSessionId?.trim();
    return parentId ? [{ parentId, childId: row.sessionId }] : [];
  }), "children");
  const seededCtoIds = onceList(async () => (await deps.listCtoChats()).map((cto) => cto.sessionId), "ctos");

  /** The CTO threads: loaded ones first, then the ones the one-time list found. */
  const ctoIds = async (): Promise<string[]> => {
    const ids = new Set<string>();
    for (const id of deps.loadedChatIds()) {
      const chat = deps.loadedChat(id);
      if (chat && !chat.deleted && chat.identityKey === "cto") ids.add(id);
    }
    for (const id of await seededCtoIds()) ids.add(id);
    return [...ids];
  };

  /** The CTO's children: the ones the one-time list found, plus every loaded one. */
  const ctoChildIds = async (ctoSessionId: string): Promise<string[]> => {
    const ids = new Set<string>();
    for (const link of await seededChildLinks()) {
      if (link.parentId === ctoSessionId) ids.add(link.childId);
    }
    for (const id of deps.loadedChatIds()) {
      const chat = deps.loadedChat(id);
      if (chat && !chat.deleted && chat.parentId?.trim() === ctoSessionId) ids.add(id);
    }
    ids.delete(ctoSessionId);
    return [...ids];
  };

  /** The first card a loaded chat shows, or null; undefined when the chat is not loaded here. */
  const loadedCard = (sessionId: string): { key: string; kind: "question" | "permission"; text: string | null } | null | undefined => {
    const requests = deps.pendingRequests(sessionId);
    if (requests === undefined) return undefined;
    const request = requests[0];
    if (!request) return null;
    const kind = request.kind === "approval" || request.kind === "permissions" ? "permission" : "question";
    const text = request.title?.trim() || request.questions[0]?.question?.trim() || request.description?.trim() || null;
    return { key: request.itemId ?? request.requestId, kind, text };
  };

  /** When the judge first saw each child's current card. Memory only: it times the wait, never a key. */
  const cardFirstSeen = new Map<string, { key: string; at: string }>();
  const cardSeenAt = (sessionId: string, key: string | null | undefined): string | null => {
    if (!key) {
      cardFirstSeen.delete(sessionId);
      return null;
    }
    const seen = cardFirstSeen.get(sessionId);
    if (seen?.key === key) return seen.at;
    const at = nowIso();
    cardFirstSeen.set(sessionId, { key, at });
    return at;
  };

  /**
   * What every reader of a child agrees on: its title, last output, running
   * turn, failed turn, and the card it waits on. The card's key is the saved
   * `pendingInputItemId` first, so a restart (child not loaded) reads the same
   * key; else the loaded card's. Null when it waits on nothing; undefined when
   * that is not known here.
   */
  const childBasics = (sessionId: string, row: TerminalSessionDetail, summary: AgentChatSessionSummary) => {
    const awaitingInput = Boolean(summary.awaitingInput || summary.pendingInputItemId);
    const card = awaitingInput ? loadedCard(sessionId) : null;
    const savedKey = summary.pendingInputItemId?.trim();
    const pendingKey: string | null | undefined = !awaitingInput ? null
      : savedKey ? savedKey
        : card === undefined ? undefined : (card?.key ?? null);
    return {
      title: summary.title?.trim() || row.title?.trim() || deps.defaultTitle(summary.provider),
      // The child's last output, else its start. The summary's time also moves
      // when its saved state is rewritten, which is not a move.
      lastActivityAt: row.lastActivityAt || row.startedAt || summary.startedAt,
      // A turn start is a move even before any output.
      turnStartedAt: summary.currentTurnStartedAt?.trim() || summary.turnAcceptedAt?.trim() || null,
      lastTurnFailedAt: row.lastTurnFailedAt ?? null,
      awaitingInput,
      card,
      pendingKey,
    };
  };

  const readChildFacts = async (childSessionId: string, nowMs: number): Promise<CtoChildFacts | null> => {
    const row = deps.sessionRow(childSessionId);
    if (!row || row.archivedAt) return null;
    // Cheap skip before a summary: a chat that has not moved in a day is history.
    const rowSeenMs = Date.parse(row.lastActivityAt ?? row.startedAt ?? "");
    if (Number.isFinite(rowSeenMs) && nowMs - rowSeenMs > HISTORY_MS && !deps.loadedChat(childSessionId)) return null;
    let summary: AgentChatSessionSummary | null;
    try {
      summary = await deps.summary(childSessionId);
    } catch (error) {
      deps.logger.warn("cto.stall_judge.child_read_failed", { childSessionId, error: getErrorMessage(error) });
      return null;
    }
    if (!summary) return null;
    const basics = childBasics(childSessionId, row, summary);
    const snoozedUntilMs = row.snoozedUntil ? Date.parse(row.snoozedUntil) : Number.NaN;
    const pr = deps.prForLane(summary.laneId);
    const prIsThisChats = Boolean(pr && (!pr.chatSessionIds?.length || pr.chatSessionIds.includes(childSessionId)));
    return {
      sessionId: childSessionId,
      title: basics.title,
      lastActivityAt: basics.lastActivityAt,
      turnStartedAt: basics.turnStartedAt,
      lastTurnFailedAt: basics.lastTurnFailedAt,
      ended: Boolean(summary.archivedAt),
      turnActive: summary.status === "active" || Boolean(summary.currentTurnStartedAt) || Boolean(summary.turnAcceptedAt),
      awaitingInput: basics.awaitingInput,
      pendingKind: basics.card?.kind ?? null,
      pendingText: basics.card?.text ?? null,
      pendingKey: basics.pendingKey,
      pendingSeenAt: cardSeenAt(childSessionId, basics.pendingKey),
      quietOnPurpose: Boolean(row.settledAt)
        || (Number.isFinite(snoozedUntilMs) && snoozedUntilMs > nowMs)
        || Boolean(summary.usageLimitParkedUntil)
        || Boolean(summary.awaitingOwnWorkAt)
        || Boolean(summary.nextWakeAt)
        || Boolean(summary.activePrWatch)
        || (summary.activeBackgroundTaskCount ?? 0) > 0,
      pr: pr && prIsThisChats && (pr.state === "open" || pr.state === "draft")
        ? {
            number: pr.githubPrNumber,
            state: pr.state,
            mergeConflicts: pr.mergeConflicts === true,
            checks: pr.checksStatus,
            behindBaseBy: pr.behindBaseBy ?? null,
            review: pr.reviewStatus,
          }
        : null,
      lastWords: summary.lastOutputPreview?.trim() || summary.summary?.trim() || null,
    };
  };

  /** What a need reads about its child. Null only when the chat is gone; a failed read throws. */
  const readNeedChild = async (childSessionId: string): Promise<CtoNeedChild | null> => {
    const row = deps.sessionRow(childSessionId);
    if (!row) return null;
    const summary = await deps.summary(childSessionId);
    if (!summary) return null;
    const basics = childBasics(childSessionId, row, summary);
    return {
      title: basics.title,
      laneId: summary.laneId ?? null,
      movedAt: ctoChildMovedAt(basics),
      ended: Boolean(row.archivedAt || summary.archivedAt),
      pendingKey: basics.pendingKey,
    };
  };

  const judge = createCtoStallJudge({
    logger: deps.logger,
    db: deps.db,
    // A CTO another live brain runs is that brain's to nudge, or both would.
    listCtoSessionIds: async () => (await ctoIds()).filter((sessionId) => !deps.ownedByAnotherBrain(sessionId)),
    readChildren: async (ctoSessionId) => {
      const nowMs = Date.now();
      const facts: CtoChildFacts[] = [];
      for (const childSessionId of await ctoChildIds(ctoSessionId)) {
        const child = await readChildFacts(childSessionId, nowMs);
        if (child) facts.push(child);
      }
      return facts;
    },
    readNeedChild,
    ctoBusy: deps.ctoBusy,
    wakeCto: deps.wakeCto,
    ctoParentOf,
    isCtoSession: (sessionId) => deps.loadedChat(sessionId)?.identityKey === "cto",
  });

  return {
    judge,
    getCtoNeeds: async () => {
      const ctoSessionId = (await ctoIds())[0];
      if (!ctoSessionId) return { needs: [] };
      return { needs: await judge.listNeeds(ctoSessionId) };
    },
    setCtoNeed: async (args) => {
      const childSessionId = args.childSessionId.trim();
      // A read that fails is an error, not "not your chat".
      const summary = await deps.summary(childSessionId);
      const parentId = deps.loadedChat(childSessionId)?.parentId?.trim() || summary?.orchestrationParentSessionId?.trim() || null;
      if (parentId !== args.ctoSessionId) {
        throw new Error(`Chat '${childSessionId}' was not started by this CTO, so it cannot have a "Waiting on you" line.`);
      }
      const row = deps.sessionRow(childSessionId);
      const basics = summary && row ? childBasics(childSessionId, row, summary) : null;
      return judge.setNeed({
        ctoSessionId: args.ctoSessionId,
        childSessionId,
        line: args.line,
        // A need set on a card ends when that card is answered.
        pendingKey: basics?.pendingKey ?? null,
        childTitle: basics?.title,
        laneId: summary?.laneId ?? null,
      });
    },
  };
}
