import { createHash, randomBytes } from "node:crypto";
import type { AgentChatEventEnvelope, AgentChatIdentity } from "../../../../desktop/src/shared/types/chat";
import type { PrChecksStatus, PrEventPayload, PrReviewStatus, PrState, PrSummary } from "../../../../desktop/src/shared/types/prs";
import type { TrackedCliTurnEndedEvent } from "../../../../desktop/src/main/services/pty/cliTurnSignals";
import { readPendingInputRequest } from "../../../../desktop/src/shared/pendingInputRequest";
import { redactOutgoingChatText } from "../../../../desktop/src/main/utils/redaction";

/**
 * The turning points of this machine's chats and PRs, for ADE MCP Events
 * (SEP-3415): a turn ended, a chat waits on an answer, a chat was deleted,
 * a PR changed. Apps poll them or get them by webhook (remoteMcpEvents.ts).
 *
 * One per process, like the ADE MCP service: every project runtime in the
 * brain feeds it. It keeps the newest 1,000 in memory only, so a brain
 * restart starts it empty, and a cursor from before then reads as a gap.
 *
 * Recording is a few field reads on the few chat events that matter. Names,
 * titles and final replies are read only when an app asks (`McpChatSource`).
 */

export const MCP_EVENT_NAMES = [
  "chat.turn_ended",
  "chat.needs_input",
  "chat.input_resolved",
  "chat.deleted",
  "pr.changed",
] as const;

export type McpEventName = (typeof MCP_EVENT_NAMES)[number];

export type McpHubEntry = {
  /** Position in this brain's run; only grows. */
  seq: number;
  eventId: string;
  name: McpEventName;
  /** When this brain recorded it, so it only grows with `seq`. */
  at: number;
  projectId: string;
  sessionId: string | null;
  turnId: string | null;
  /** For a turn end: when the turn began, so its reply is one written after it. */
  turnStartedAt: number | null;
  /** For a turn end: when the chat's next turn began, so its reply is one written before that. */
  nextTurnStartedAt: number | null;
  data: Record<string, unknown>;
};

/** A position in one machine's events: this brain run, and the last event at or before it. */
export type McpHubPosition = { boot: string; seq: number };

/** What an event says about its chat: its name, its lane, and the chat that started it. */
export type McpChatIdentity = AgentChatIdentity;

/** How a project's runtime answers for its chats when an app reads an event. */
export type McpChatSource = {
  /** The chat's name, lane and parent; null when it is gone. */
  identity(sessionId: string): Promise<McpChatIdentity | null>;
  /**
   * The turn's last assistant message, written between `sinceMs` and `untilMs`, and before
   * `beforeMs` (the next turn's start), when given; null when it has none.
   */
  finalReply(sessionId: string, turnId: string | null, sinceMs: number | null, untilMs: number | null, beforeMs: number | null): Promise<McpTurnReply | null>;
};

export const MCP_HUB_RING_MAX = 1_000;
const MAX_TEXT_CHARS = 500;
/** Sessions whose last ended turn is remembered, so a turn reported twice (status, then done) counts once. */
const MAX_TRACKED_SESSIONS = 2_000;

const bootId = randomBytes(6).toString("base64url");
/** When this brain run began: what happened before it is not kept. */
const bootAt = Date.now();
let lastSeq = 0;
/** The newest event's time: the next is never older, even when the wall clock goes back. */
let lastAt = 0;
let ring: McpHubEntry[] = [];
/** When the newest event that fell out of the ring happened. */
let droppedThroughAt: number | null = null;
const sources = new Map<string, McpChatSource>();
const listeners = new Set<(entry: McpHubEntry) => void>();
/** The newest error of each running turn, told with the turn's end. */
const turnErrors = new Map<string, string>();
/** Each session's last ended turn, and the event that told it, so a second report of it can add to it. */
const endedTurns = new Map<string, { turnId: string | null; at: number; entry: McpHubEntry }>();
/** When each session's running turn began. */
const turnStarts = new Map<string, number>();
/**
 * How long a turn end told by status waits for its done: done has the turn's
 * id and HTTP status, and an app must get one finished event, not one that
 * changes after it read it.
 */
const STATUS_END_WAIT_MS = 1_500;
type HeldEnd = { projectId: string; outcome: "completed" | "failed" | "interrupted"; turnId: string | null; statusMessage: string | null; timer: ReturnType<typeof setTimeout> };
/** Turn ends told by status, waiting for done. */
const heldEnds = new Map<string, HeldEnd>();
/** What each deleted chat was: its earlier events are still read after its summary is gone. */
const deletedChats = new Map<string, McpChatIdentity>();
type PrField = "state" | "checks" | "review";
/** The poll (its `polledAt`) that last sent notifications for each PR, and the fields they told, so a change is not told twice. */
const prNotifiedPolls = new Map<string, { polledAt: string; fields: Set<PrField> }>();
/** What each PR notification tells: a lifecycle kind its state, the rest its checks or review. */
const PR_NOTIFICATION_FIELDS: Record<string, readonly PrField[]> = {
  opened: ["state"],
  reopened: ["state"],
  closed: ["state"],
  merged: ["state"],
  checks_failing: ["checks"],
  review_requested: ["review"],
  changes_requested: ["review"],
  merge_ready: ["checks", "review"],
};

const clip = (text: string, max = MAX_TEXT_CHARS): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const cleanText = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  return clip(redactOutgoingChatText(value.trim()));
};

const remember = <V>(map: Map<string, V>, key: string, value: V): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_SESSIONS) map.delete(map.keys().next().value!);
};

const push = (entry: Omit<McpHubEntry, "seq" | "eventId" | "at" | "turnStartedAt" | "nextTurnStartedAt"> & { turnStartedAt?: number | null }): McpHubEntry => {
  const seq = ++lastSeq;
  // Header-safe and the same wherever it is read, so an app can drop a repeat.
  const eventId = `evt_${createHash("sha256").update(`${bootId}:${seq}`).digest("base64url").slice(0, 22)}`;
  lastAt = Math.max(Date.now(), lastAt);
  const full: McpHubEntry = { ...entry, turnStartedAt: entry.turnStartedAt ?? null, nextTurnStartedAt: null, seq, eventId, at: lastAt };
  ring.push(full);
  if (ring.length > MCP_HUB_RING_MAX) {
    const dropped = ring.length - MCP_HUB_RING_MAX;
    droppedThroughAt = ring[dropped - 1]!.at;
    ring = ring.slice(dropped);
  }
  for (const listener of listeners) {
    try {
      listener(full);
    } catch {
      // A listener's failure never reaches chat event handling.
    }
  }
  return full;
};

/** Why a failed turn failed, from the provider's HTTP status when no message says. */
const httpStatusError = (status: number): string =>
  status === 429 ? "The provider refused the turn: a rate or plan limit (HTTP 429)."
    : status === 529 ? "The provider is overloaded (HTTP 529)."
      : `The provider answered HTTP ${status}.`;

const turnEnded = (
  projectId: string,
  sessionId: string,
  outcome: "completed" | "failed" | "interrupted",
  turnId: string | null,
  statusMessage: string | null,
  httpStatus: number | null,
): void => {
  const at = Date.now();
  const last = endedTurns.get(sessionId);
  // A runtime reports a turn's end twice: by status, then by done. Only done
  // always has the turn's id, so without one on either side, time decides.
  const repeat = last && (turnId && last.turnId ? last.turnId === turnId : at - last.at < 2_000);
  if (repeat) {
    // The second report can know more (done carries the HTTP status); the
    // first one's event is still the one apps read, so it gains it.
    const data = last.entry.data;
    if (data.outcome === "failed" && httpStatus && data.httpStatus === undefined) {
      data.httpStatus = httpStatus;
      if (!data.error) data.error = httpStatusError(httpStatus);
    }
    if (turnId && !last.entry.turnId) last.entry.turnId = turnId;
    return;
  }
  const message = outcome === "failed" ? turnErrors.get(sessionId) ?? statusMessage : null;
  const error = message ?? (outcome === "failed" && httpStatus ? httpStatusError(httpStatus) : null);
  turnErrors.delete(sessionId);
  const turnStartedAt = turnStarts.get(sessionId) ?? null;
  turnStarts.delete(sessionId);
  const entry = push({
    name: "chat.turn_ended",
    projectId,
    sessionId,
    turnId,
    turnStartedAt,
    data: { outcome, ...(error ? { error } : {}), ...(outcome === "failed" && httpStatus ? { httpStatus } : {}) },
  });
  remember(endedTurns, sessionId, { turnId, at, entry });
};

/** Publishes a held status end now: its done did not come in time, or the chat moved on. */
const releaseHeldEnd = (sessionId: string): void => {
  const held = heldEnds.get(sessionId);
  if (!held) return;
  clearTimeout(held.timer);
  heldEnds.delete(sessionId);
  turnEnded(held.projectId, sessionId, held.outcome, held.turnId, held.statusMessage, null);
};

/** One chat event from a project runtime; only turn ends, cards and errors count. */
export function noteChatEventForMcp(projectId: string, envelope: AgentChatEventEnvelope): void {
  const event = envelope.event;
  const type = event.type;
  if (type !== "status" && type !== "done" && type !== "error" && type !== "approval_request" && type !== "pending_input_resolved") return;
  const sessionId = envelope.sessionId;
  const turnId = ("turnId" in event && typeof event.turnId === "string" && event.turnId.trim()) || null;
  // Anything after a held end but its done comes after that end.
  if (event.type !== "done" && event.type !== "error") releaseHeldEnd(sessionId);
  if (event.type === "status") {
    if (event.turnStatus === "started") {
      const startedAt = Date.now();
      const ended = endedTurns.get(sessionId);
      if (ended) ended.entry.nextTurnStartedAt = startedAt;
      turnErrors.delete(sessionId);
      endedTurns.delete(sessionId);
      remember(turnStarts, sessionId, startedAt);
      return;
    }
    const statusMessage = cleanText(event.message);
    // Done tells what this lacks: hold it a moment, so the event goes out whole.
    if ((!turnId || event.turnStatus === "failed") && !endedTurns.has(sessionId)) {
      const timer = setTimeout(() => releaseHeldEnd(sessionId), STATUS_END_WAIT_MS);
      timer.unref?.();
      heldEnds.set(sessionId, { projectId, outcome: event.turnStatus, turnId, statusMessage, timer });
      if (heldEnds.size > MAX_TRACKED_SESSIONS) releaseHeldEnd(heldEnds.keys().next().value!);
      return;
    }
    turnEnded(projectId, sessionId, event.turnStatus, turnId, statusMessage, null);
  } else if (event.type === "done") {
    const httpStatus = typeof event.apiErrorStatus === "number" && event.apiErrorStatus >= 400 ? event.apiErrorStatus : null;
    const held = heldEnds.get(sessionId);
    if (held) {
      clearTimeout(held.timer);
      heldEnds.delete(sessionId);
    }
    turnEnded(projectId, sessionId, event.status, turnId ?? held?.turnId ?? null, held?.statusMessage ?? null, httpStatus);
  } else if (event.type === "error") {
    const message = cleanText(event.message);
    if (message) remember(turnErrors, sessionId, message);
  } else if (event.type === "approval_request") {
    const detail = event.detail && typeof event.detail === "object" ? event.detail as Record<string, unknown> : null;
    const request = readPendingInputRequest(detail?.request);
    const secret = Boolean(request?.questions?.some((question) => question.isSecret));
    const description = cleanText(request?.title ?? event.description);
    push({
      name: "chat.needs_input",
      projectId,
      sessionId,
      turnId,
      data: {
        itemId: event.itemId,
        kind: event.requestKind ?? request?.kind ?? "approval",
        ...(secret ? { secret: true } : {}),
        ...(description ? { description } : {}),
      },
    });
  } else {
    push({
      name: "chat.input_resolved",
      projectId,
      sessionId,
      turnId,
      data: { itemId: event.itemId, resolution: event.resolution },
    });
  }
}

/**
 * A provider's own CLI in an ADE terminal: its turn ends come from the CLI's
 * hooks or output (cliTurnSignals.ts), not chat events, and carry no turn id
 * or reply. A CLI that stops on its own prompt reads as waiting on an answer.
 */
export function noteCliTurnEndedForMcp(projectId: string, event: TrackedCliTurnEndedEvent): void {
  const surface = { surface: "cli", laneId: event.laneId };
  if (event.outcome === "needs-input") {
    push({ name: "chat.needs_input", projectId, sessionId: event.sessionId, turnId: null, data: { kind: "cli_prompt", ...surface } });
    return;
  }
  push({
    name: "chat.turn_ended",
    projectId,
    sessionId: event.sessionId,
    turnId: null,
    data: { outcome: event.outcome === "failed" ? "failed" : "completed", ...surface },
  });
}

/** `chat`: the deleted chat's name, lane and parent, read before its files went; nothing can read them after. */
export function noteChatDeletedForMcp(projectId: string, sessionId: string, chat: McpChatIdentity): void {
  releaseHeldEnd(sessionId);
  turnErrors.delete(sessionId);
  endedTurns.delete(sessionId);
  turnStarts.delete(sessionId);
  const known: McpChatIdentity = {
    title: chat.title?.trim() || null,
    laneId: chat.laneId?.trim() || null,
    parentSessionId: chat.parentSessionId?.trim() || null,
  };
  remember(deletedChats, sessionId, known);
  push({ name: "chat.deleted", projectId, sessionId, turnId: null, data: { ...known } });
}

/** A deleted chat's name, lane and parent, while the hub still remembers it. */
export function mcpDeletedChat(sessionId: string): McpChatIdentity | null {
  return deletedChats.get(sessionId) ?? null;
}

/** A PR event from a project runtime: each PR notification counts, of any kind. */
export function notePrEventForMcp(projectId: string, event: PrEventPayload): void {
  if (event.type !== "pr-notification") return;
  const told = prNotifiedPolls.get(event.prId);
  const fields = told && told.polledAt === event.polledAt ? told.fields : new Set<PrField>();
  // A kind this hub doesn't know tells every field: never a second event for it.
  for (const field of PR_NOTIFICATION_FIELDS[event.kind] ?? ["state", "checks", "review"]) fields.add(field);
  remember(prNotifiedPolls, event.prId, { polledAt: event.polledAt, fields });
  push({
    name: "pr.changed",
    projectId,
    sessionId: null,
    turnId: null,
    data: {
      kind: event.kind,
      prId: event.prId,
      prNumber: event.prNumber,
      title: clip(event.prTitle || event.title || "", 300),
      laneId: event.laneId,
      repo: `${event.repoOwner}/${event.repoName}`,
      url: event.githubUrl,
      state: event.state,
      checksStatus: event.checksStatus,
      reviewStatus: event.reviewStatus,
      ...(cleanText(event.message) ? { message: cleanText(event.message) } : {}),
    },
  });
}

/** One PR's change as the PR poller found it (`onPullRequestsChanged`). */
export type McpPrChange = {
  pr: PrSummary;
  previousState: PrState | null;
  previousChecksStatus: PrChecksStatus | null;
  previousReviewStatus: PrReviewStatus | null;
};

/**
 * The PR poller's changes, after it sent its notifications for the same poll.
 * A PR notification is sent only for some changes (a draft's checks passing is
 * none), so a change of state, checks or review that no notification of this
 * poll told is told here, once: `checks_changed`, `review_changed` or
 * `state_changed`, with what it was before. A PR seen for the first time is
 * not a change.
 */
export function notePrChangesForMcp(projectId: string, polledAt: string, changes: readonly McpPrChange[]): void {
  for (const { pr, previousState, previousChecksStatus, previousReviewStatus } of changes) {
    if (previousState === null) continue;
    const told = prNotifiedPolls.get(pr.id);
    const toldNow = told && told.polledAt === polledAt ? told.fields : null;
    const stateMoved = previousState !== pr.state && !toldNow?.has("state");
    const checksMoved = previousChecksStatus !== pr.checksStatus && !toldNow?.has("checks");
    const reviewMoved = previousReviewStatus !== pr.reviewStatus && !toldNow?.has("review");
    if (!stateMoved && !checksMoved && !reviewMoved) continue;
    push({
      name: "pr.changed",
      projectId,
      sessionId: null,
      turnId: null,
      data: {
        kind: stateMoved ? "state_changed" : checksMoved ? "checks_changed" : "review_changed",
        prId: pr.id,
        prNumber: pr.githubPrNumber,
        title: clip(pr.title ?? "", 300),
        laneId: pr.laneId,
        repo: `${pr.repoOwner}/${pr.repoName}`,
        url: pr.githubUrl,
        state: pr.state,
        checksStatus: pr.checksStatus,
        reviewStatus: pr.reviewStatus,
        ...(stateMoved ? { previousState } : {}),
        ...(checksMoved ? { previousChecksStatus } : {}),
        ...(reviewMoved ? { previousReviewStatus } : {}),
      },
    });
  }
}

/** A transcript entry as `turnFinalReply` reads it. */
export type McpTranscriptEntry = { role: string; text: string; timestamp: string; turnId?: string | null; messageId?: string | null };

export type McpTurnReply = { text: string; messageId: string | null };

/** Slack for clock rounding before the turn began, and for a reply written just after its end was reported. */
const REPLY_BEFORE_START_MS = 5;
const REPLY_AFTER_END_MS = 1_000;

/**
 * A turn's final reply among transcript entries: the last assistant entry
 * written between the turn's start and its end (an entry with no readable
 * time counts). The turn's own entry wins when the provider tags entries with
 * turns; else the newest untagged one, so a provider that tags only some
 * entries still finds its reply. Null when the turn wrote none, so a turn with
 * no text never gets the reply of the turn before or after it.
 */
function turnFinalReply(
  entries: readonly McpTranscriptEntry[],
  turnId: string | null,
  sinceMs: number | null,
  untilMs: number | null,
  beforeMs: number | null,
): McpTurnReply | null {
  const replies = entries.filter((entry) => {
    if (entry.role !== "assistant") return false;
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at)) return true;
    return (sinceMs === null || at >= sinceMs - REPLY_BEFORE_START_MS)
      && (untilMs === null || at <= untilMs + REPLY_AFTER_END_MS)
      // The next turn's reply, written within the slack after this one's end, is not this turn's.
      && (beforeMs === null || at < beforeMs);
  }).reverse();
  const reply = (turnId ? replies.find((entry) => entry.turnId === turnId) : null)
    ?? replies.find((entry) => !turnId || !entry.turnId);
  return reply ? { text: reply.text, messageId: reply.messageId ?? null } : null;
}

/** How many of a chat's newest entries the first reply lookup reads. */
const MCP_REPLY_RECENT_ENTRIES = 40;

/**
 * Finds a turn's final reply in a chat's transcript. Reads the newest entries
 * first (cheap, and enough for a recent turn); when the turn began before the
 * oldest of them, reads again from the turn's start, so an app that catches up
 * on a backlog still gets older turns' replies. `read` is `readTranscript`.
 */
export async function findTurnFinalReply(
  read: (limit: number | undefined, since: string | undefined) => Promise<readonly McpTranscriptEntry[]>,
  turnId: string | null,
  sinceMs: number | null,
  untilMs: number | null,
  beforeMs: number | null = null,
): Promise<McpTurnReply | null> {
  const recent = await read(MCP_REPLY_RECENT_ENTRIES, undefined);
  const found = turnFinalReply(recent, turnId, sinceMs, untilMs, beforeMs);
  if (found || sinceMs === null || recent.length < MCP_REPLY_RECENT_ENTRIES) return found;
  const oldest = Date.parse(recent[0]?.timestamp ?? "");
  if (Number.isNaN(oldest) || oldest <= sinceMs) return null;
  const since = new Date(sinceMs - REPLY_BEFORE_START_MS).toISOString();
  return turnFinalReply(await read(undefined, since), turnId, sinceMs, untilMs, beforeMs);
}

/** A project runtime's reader for its chats. Returns its removal. */
export function registerMcpChatSource(projectId: string, source: McpChatSource): () => void {
  sources.set(projectId, source);
  return () => {
    if (sources.get(projectId) === source) sources.delete(projectId);
  };
}

export function mcpChatSource(projectId: string): McpChatSource | null {
  return sources.get(projectId) ?? null;
}

/** Called after each new event. Returns its removal. */
export function onMcpEvent(listener: (entry: McpHubEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function mcpHubHead(): McpHubPosition {
  return { boot: bootId, seq: lastSeq };
}

/** The position just before the first event at or after `ms`. */
export function mcpHubPositionAt(ms: number): McpHubPosition {
  const first = ring.find((entry) => entry.at >= ms);
  return { boot: bootId, seq: first ? first.seq - 1 : lastSeq };
}

/**
 * True when this machine still has every event since `ms`: this brain run
 * began before it, and none since then fell out of the 1,000 kept. Reading
 * from a time it doesn't cover is a gap.
 */
export function mcpHubCovers(ms: number): boolean {
  return ms >= bootAt && (droppedThroughAt === null || droppedThroughAt < ms);
}

export type McpHubPage = {
  entries: McpHubEntry[];
  /** Pass back for the next page. */
  next: McpHubPosition;
  /** Events after the position given were dropped: the brain restarted, or they fell out of the 1,000 kept. */
  truncated: boolean;
  hasMore: boolean;
};

/**
 * The matching events after `after`, oldest first. Null `after` starts now.
 * A position from an earlier brain run starts at the oldest event kept.
 */
export function readMcpHub(args: {
  after: McpHubPosition | null;
  match: (entry: McpHubEntry) => boolean;
  max: number;
  /** Skip events older than this; skipping any counts as a gap. */
  notBefore?: number | null;
}): McpHubPage {
  const head = mcpHubHead();
  if (!args.after) return { entries: [], next: head, truncated: false, hasMore: false };
  const oldest = ring[0]?.seq ?? lastSeq + 1;
  const sameRun = args.after.boot === bootId;
  const from = sameRun ? Math.min(args.after.seq, lastSeq) : 0;
  // Another run's position: what happened between it and this run's start is unknown.
  let truncated = !sameRun || from < oldest - 1;
  const entries: McpHubEntry[] = [];
  let next = head;
  let hasMore = false;
  // The ring holds consecutive positions, so the first one after `from` is found by subtraction.
  const start = ring.length ? Math.max(0, from - ring[0]!.seq + 1) : 0;
  for (let index = start; index < ring.length; index += 1) {
    const entry = ring[index]!;
    if (args.notBefore != null && entry.at < args.notBefore) {
      truncated = true;
      continue;
    }
    if (!args.match(entry)) continue;
    if (entries.length >= args.max) {
      hasMore = true;
      next = { boot: bootId, seq: entries[entries.length - 1]!.seq };
      break;
    }
    entries.push(entry);
  }
  return { entries, next, truncated, hasMore };
}
