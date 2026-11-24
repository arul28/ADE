import { createHash, randomBytes } from "node:crypto";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import type { PrEventPayload } from "../../../../desktop/src/shared/types/prs";
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
  data: Record<string, unknown>;
};

/** A position in one machine's events: this brain run, and the last event at or before it. */
export type McpHubPosition = { boot: string; seq: number };

/** How a project's runtime answers for its chats when an app reads an event. */
export type McpChatSource = {
  summary(sessionId: string): Promise<Record<string, unknown> | null>;
  /** The turn's last assistant message, written at or after `sinceMs` when given; null when it has none. */
  finalReply(sessionId: string, turnId: string | null, sinceMs: number | null): Promise<{ text: string; messageId: string | null } | null>;
};

const RING_MAX = 1_000;
const MAX_TEXT_CHARS = 500;
/** Sessions whose last ended turn is remembered, so a turn reported twice (status, then done) counts once. */
const MAX_TRACKED_SESSIONS = 2_000;

const bootId = randomBytes(6).toString("base64url");
/** When this brain run began: what happened before it is not kept. */
const bootAt = Date.now();
let lastSeq = 0;
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
/** What each deleted chat was: its earlier events are still read after its summary is gone. */
const deletedChats = new Map<string, { title: string | null; laneId: string | null; parentSessionId: string | null }>();

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

const push = (entry: Omit<McpHubEntry, "seq" | "eventId" | "at" | "turnStartedAt"> & { turnStartedAt?: number | null }): McpHubEntry => {
  const seq = ++lastSeq;
  // Header-safe and the same wherever it is read, so an app can drop a repeat.
  const eventId = `evt_${createHash("sha256").update(`${bootId}:${seq}`).digest("base64url").slice(0, 22)}`;
  const full: McpHubEntry = { ...entry, turnStartedAt: entry.turnStartedAt ?? null, seq, eventId, at: Date.now() };
  ring.push(full);
  if (ring.length > RING_MAX) {
    const dropped = ring.length - RING_MAX;
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

/** One chat event from a project runtime; only turn ends, cards and errors count. */
export function noteChatEventForMcp(projectId: string, envelope: AgentChatEventEnvelope): void {
  const event = envelope.event;
  const type = event.type;
  if (type !== "status" && type !== "done" && type !== "error" && type !== "approval_request" && type !== "pending_input_resolved") return;
  const sessionId = envelope.sessionId;
  const turnId = ("turnId" in event && typeof event.turnId === "string" && event.turnId.trim()) || null;
  if (event.type === "status") {
    if (event.turnStatus === "started") {
      turnErrors.delete(sessionId);
      endedTurns.delete(sessionId);
      remember(turnStarts, sessionId, Date.now());
      return;
    }
    turnEnded(projectId, sessionId, event.turnStatus, turnId, cleanText(event.message), null);
  } else if (event.type === "done") {
    const httpStatus = typeof event.apiErrorStatus === "number" && event.apiErrorStatus >= 400 ? event.apiErrorStatus : null;
    turnEnded(projectId, sessionId, event.status, turnId, null, httpStatus);
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

/** A deleted chat's name, lane and parent, read before its files went: nothing can read them after. */
export type McpDeletedChat = { title?: string | null; laneId?: string | null; parentSessionId?: string | null };

export function noteChatDeletedForMcp(projectId: string, sessionId: string, chat?: McpDeletedChat): void {
  turnErrors.delete(sessionId);
  endedTurns.delete(sessionId);
  turnStarts.delete(sessionId);
  const known = {
    title: chat?.title?.trim() || null,
    laneId: chat?.laneId?.trim() || null,
    parentSessionId: chat?.parentSessionId?.trim() || null,
  };
  remember(deletedChats, sessionId, known);
  push({ name: "chat.deleted", projectId, sessionId, turnId: null, data: { ...known } });
}

/** A deleted chat's name, lane and parent, while the hub still remembers it. */
export function mcpDeletedChat(sessionId: string): { title: string | null; laneId: string | null; parentSessionId: string | null } | null {
  return deletedChats.get(sessionId) ?? null;
}

/** A PR event from a project runtime; only an opened, merged, closed or checks change counts. */
export function notePrEventForMcp(projectId: string, event: PrEventPayload): void {
  if (event.type !== "pr-notification") return;
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
