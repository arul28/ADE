import {
  MCP_EVENT_NAMES,
  MCP_HUB_RING_MAX,
  type McpEventName,
  type McpHubPosition,
} from "./remoteMcpEventHub";

/**
 * What ADE MCP Events offers and how its arguments and cursors read: the
 * event types (`events/list`), the argument checks, the account cursor, and
 * the `events_poll` tool for apps whose MCP client has no Events support.
 * The reads are in remoteMcpEvents.ts, the webhooks in remoteMcpEventWebhooks.ts.
 */

export const EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";
/** Between machines only: one machine's events for an account-wide poll. Never listed. */
export const EVENTS_HERE_TOOL_NAME = "ade_events_here";
/** The same events as a tool, for an app whose MCP client has no Events support. */
export const EVENTS_POLL_TOOL_NAME = "events_poll";

export const EVENTS_ERROR = {
  invalidParams: -32602,
  notFound: -32023,
  forbidden: -32024,
  resourceExhausted: -32025,
  unsupported: -32026,
  callbackEndpoint: -32027,
} as const;

export class McpEventsError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

export const DEFAULT_MAX_EVENTS = 50;
export const MAX_EVENTS = 200;
export const MAX_REPLY_CHARS = 4_000;
const CURSOR_PREFIX = "ade1_";

// ── Event types ───────────────────────────────────────────────────────────────

export const CHAT_EVENT_NAMES = new Set<McpEventName>(["chat.turn_ended", "chat.needs_input", "chat.input_resolved", "chat.deleted"]);

const FILTER_INPUTS = {
  project: { type: "string", description: "A project id or name: only its events." },
  machine: { type: "string", description: "A machine key or name from machines_list: only its events." },
};
const CHAT_INPUTS = {
  ...FILTER_INPUTS,
  session: { type: "string", description: "A chat id: only that chat's events." },
  include_subagents: { type: "boolean", default: false, description: "Also chats that another chat started." },
};
const CHAT_PAYLOAD = {
  sessionId: { type: "string" },
  title: { type: ["string", "null"] },
  laneId: { type: ["string", "null"] },
  parentSessionId: { type: ["string", "null"], description: "Set for a chat that another chat started." },
  projectId: { type: "string" },
  project: { type: ["string", "null"] },
  machine: { type: "object", properties: { key: { type: "string" }, name: { type: "string" } } },
};

const DESCRIPTORS: Record<McpEventName, { description: string; inputs: Record<string, unknown>; payload: Record<string, unknown> }> = {
  "chat.turn_ended": {
    description: "A chat's turn ended: completed, failed or interrupted. Carries the final reply, so no chat_read is needed.",
    inputs: { ...CHAT_INPUTS, include_reply: { type: "boolean", default: true, description: `Add the turn's final reply (at most ${MAX_REPLY_CHARS.toLocaleString("en-US")} characters).` } },
    payload: {
      ...CHAT_PAYLOAD,
      turnId: { type: ["string", "null"] },
      outcome: { type: "string", enum: ["completed", "failed", "interrupted"] },
      error: { type: "string" },
      reply: { type: "object", properties: { text: { type: "string" }, messageId: { type: ["string", "null"] }, truncated: { type: "boolean" } } },
    },
  },
  "chat.needs_input": {
    description: "A chat waits on an answer: an approval, a question, or a secret. inbox shows it and chat_respond answers it.",
    inputs: CHAT_INPUTS,
    payload: {
      ...CHAT_PAYLOAD,
      itemId: { type: "string" },
      kind: { type: "string" },
      secret: { type: "boolean" },
      description: { type: "string" },
    },
  },
  "chat.input_resolved": {
    description: "A chat's question or approval was answered, declined or cancelled.",
    inputs: CHAT_INPUTS,
    payload: { ...CHAT_PAYLOAD, itemId: { type: "string" }, resolution: { type: "string", enum: ["accepted", "declined", "cancelled"] } },
  },
  "chat.deleted": {
    description: "A chat was deleted. [\"chat\",\"deleted\",\"reopen\",<id>] through the ade tool brings it back.",
    inputs: CHAT_INPUTS,
    payload: CHAT_PAYLOAD,
  },
  "pr.changed": {
    description: "A pull request was opened, closed, merged or reopened, or its checks or reviews changed.",
    inputs: FILTER_INPUTS,
    payload: {
      kind: { type: "string" },
      prNumber: { type: "integer" },
      title: { type: "string" },
      repo: { type: "string" },
      url: { type: "string" },
      laneId: { type: "string" },
      state: { type: "string" },
      checksStatus: { type: "string" },
      reviewStatus: { type: "string" },
      previousState: { type: "string" },
      previousChecksStatus: { type: "string" },
      previousReviewStatus: { type: "string" },
      projectId: { type: "string" },
      project: { type: ["string", "null"] },
      machine: { type: "object", properties: { key: { type: "string" }, name: { type: "string" } } },
    },
  },
};

export function listMcpEventTypes(): Array<Record<string, unknown>> {
  return MCP_EVENT_NAMES.map((name) => ({
    name,
    description: DESCRIPTORS[name].description,
    delivery: ["poll", "webhook"],
    inputSchema: { type: "object", properties: DESCRIPTORS[name].inputs, additionalProperties: false },
    payloadSchema: { type: "object", properties: DESCRIPTORS[name].payload },
  }));
}

// ── Arguments ────────────────────────────────────────────────────────────────

export type EventFilter = {
  names: ReadonlySet<McpEventName>;
  project: string | null;
  machine: string | null;
  session: string | null;
  includeSubagents: boolean;
  includeReply: boolean;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const invalid = (message: string): McpEventsError => new McpEventsError(EVENTS_ERROR.invalidParams, message);

export function eventName(value: unknown): McpEventName {
  if (typeof value !== "string" || !value) throw invalid("Name the event: one of " + MCP_EVENT_NAMES.join(", ") + ".");
  if (!(MCP_EVENT_NAMES as readonly string[]).includes(value)) {
    throw new McpEventsError(EVENTS_ERROR.notFound, `No event "${value}". ADE has ${MCP_EVENT_NAMES.join(", ")}.`, { kind: "event" });
  }
  return value as McpEventName;
}

/** Checks `arguments` against every named event's inputSchema. */
export function parseFilter(names: readonly McpEventName[], raw: unknown): EventFilter {
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(input)) throw invalid("`arguments` must be an object.");
  const allowed = new Set(names.flatMap((name) => Object.keys(DESCRIPTORS[name].inputs)));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw invalid(`Unknown argument "${key}". This event takes ${[...allowed].join(", ")}.`);
  }
  const text = (key: string): string | null => {
    const value = input[key];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw invalid(`\`${key}\` must be a string.`);
    return value.trim() || null;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const value = input[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "boolean") throw invalid(`\`${key}\` must be true or false.`);
    return value;
  };
  return {
    names: new Set(names),
    project: text("project"),
    machine: text("machine"),
    session: text("session"),
    includeSubagents: flag("include_subagents", false),
    includeReply: flag("include_reply", true),
  };
}

export function boundedInteger(value: unknown, key: string, fallback: number, min: number, max: number): number;
export function boundedInteger(value: unknown, key: string, fallback: null, min: number, max: number): number | null;
export function boundedInteger(value: unknown, key: string, fallback: number | null, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`\`${key}\` must be a number.`);
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Canonical JSON: keys sorted, so equal arguments name one subscription. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// ── Reads ────────────────────────────────────────────────────────────────────

export type McpOccurrence = { eventId: string; name: McpEventName; timestamp: string; data: Record<string, unknown>; cursor?: string | null };

/** One machine's answer to an account-wide read. */
export type MachineRead = { events: Array<{ occurrence: McpOccurrence; seq: number }>; part: string; truncated: boolean; hasMore: boolean };

/** This machine's matching events after its part of a cursor (or since `sinceMs` without one). */
export type ReadHereArgs = { filter: EventFilter; part: string | null; sinceMs: number | null; max: number; maxAgeMs: number | null };

// ── Cursors ──────────────────────────────────────────────────────────────────

/**
 * One position per machine, and when the cursor began: a machine with no
 * position yet gives its events since then.
 */
export type AccountCursor = { t: number; m: Record<string, string> };

export function encodeCursor(cursor: AccountCursor): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: unknown): AccountCursor | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.startsWith(CURSOR_PREFIX)) throw invalid("That cursor isn't one ADE gave. Pass null to start from now.");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"));
    if (!isRecord(parsed) || typeof parsed.t !== "number" || !isRecord(parsed.m)) throw new Error("shape");
    const m: Record<string, string> = {};
    for (const [key, part] of Object.entries(parsed.m)) if (typeof part === "string") m[key] = part;
    return { t: parsed.t, m };
  } catch {
    throw invalid("That cursor isn't one ADE gave. Pass null to start from now.");
  }
}

export const encodePosition = (position: McpHubPosition): string => `${position.boot}.${position.seq}`;
export function decodePosition(value: unknown): McpHubPosition | null {
  if (typeof value !== "string") return null;
  const dot = value.lastIndexOf(".");
  const seq = Number(value.slice(dot + 1));
  return dot > 0 && Number.isInteger(seq) && seq >= 0 ? { boot: value.slice(0, dot), seq } : null;
}


// ── The events_poll tool ─────────────────────────────────────────────────────

/**
 * `events_poll`'s inputs: every event type's, by type only (the tool's
 * description says what they do), except `machine`, which names where its
 * values come from. Each byte is sent to every app on every tools/list.
 */
const EVENTS_POLL_INPUTS: Record<string, unknown> = Object.fromEntries(
  Object.entries(DESCRIPTORS["chat.turn_ended"].inputs).map(([key, schema]) =>
    [key, key === "machine" || !isRecord(schema) ? schema : { type: schema.type }]),
);

/** `events_poll`: every event type's inputs, plus which types, the cursor and a page size. */
export function eventsPollToolDefinition() {
  return {
    name: EVENTS_POLL_TOOL_NAME,
    title: "Chat and PR events",
    description: "What happened on every machine since `cursor`: turns ended (with the final reply), waits on an answer, "
      + "answers, deleted chats, PR changes (`names`, default all). Omit `cursor` to start now, then pass back each answer's.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cursor: { type: "string" },
        names: { type: "array", items: { type: "string", enum: [...MCP_EVENT_NAMES] } },
        ...EVENTS_POLL_INPUTS,
        max: { type: "integer", maximum: MAX_EVENTS },
      } as Record<string, unknown>,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
}

/** One line per event, then what the page means for the next call. */
export function eventsPollText(page: {
  events: Array<{ name: string; timestamp: string; data: Record<string, unknown> }>;
  truncated: boolean;
  hasMore: boolean;
  unread: Array<{ name: string }>;
  cursor: string;
}): string {
  const lines = page.events.map((event) => {
    const data = event.data;
    const what = [data.outcome, data.kind, data.resolution].find((value) => typeof value === "string");
    const title = typeof data.title === "string" && data.title ? ` "${data.title}"` : "";
    return `${event.timestamp} ${event.name}${what ? ` ${String(what)}` : ""}${title} ${String(data.sessionId ?? data.url ?? "")}`.trimEnd();
  });
  return [
    lines.length ? lines.join("\n") : "No new events.",
    page.truncated ? `Some events were missed (a machine restarted or more than ${MCP_HUB_RING_MAX.toLocaleString("en-US")} happened); check chat_status.` : "",
    page.hasMore ? "More follow: call again with this cursor now." : "",
    page.unread.length ? `Not read now: ${page.unread.map((machine) => machine.name).join(", ")}. Their events come on a later call.` : "",
    `cursor: ${page.cursor}`,
  ].filter(Boolean).join("\n");
}
