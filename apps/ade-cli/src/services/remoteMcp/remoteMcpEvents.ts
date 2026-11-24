import https from "node:https";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getErrorMessage } from "../../../../desktop/src/main/services/shared/utils";
import { isLocalHostname, isPrivateIpAddress, isPublicIpAddress, pinnedLookup } from "../../../../desktop/src/main/services/net/publicHostGuard";
import { redactOutgoingChatText } from "../../../../desktop/src/main/utils/redaction";
import type { RemoteMcpConnectionSummary } from "../../../../desktop/src/shared/types/remoteMcp";
import {
  MCP_EVENT_NAMES,
  mcpChatSource,
  mcpDeletedChat,
  mcpHubCovers,
  mcpHubHead,
  mcpHubPositionAt,
  onMcpEvent,
  readMcpHub,
  type McpEventName,
  type McpHubEntry,
  type McpHubPosition,
} from "./remoteMcpEventHub";
import type { RemoteMcpCallContext, RemoteMcpMachineRouter, RemoteMcpRosterMachine } from "./remoteMcpForward";
import { REMOTE_MCP_VAULT_KIND, REMOTE_MCP_VAULT_SCOPE, type RemoteMcpVault } from "./remoteMcpStore";
import type { RemoteMcpProject } from "./remoteMcpProtocol";

/**
 * ADE MCP Events: SEP-3415 (`io.modelcontextprotocol/events`) over the
 * account address, from the machine hubs (remoteMcpEventHub.ts).
 *
 * - `events/poll` reads every machine of the account: this one directly, the
 *   others by one forwarded call each. The cursor holds one position per
 *   machine, so a machine that was offline catches up when it is back.
 * - `events/subscribe` (webhooks) is kept in the account vault, so every
 *   machine knows it within one sync, and each machine POSTs its own events,
 *   signed per Standard Webhooks. Nothing goes through ADE's servers.
 * - `events/stream` is not offered: the relay holds no open stream.
 *
 * Also accepted for clients built on the draft before the SEP (ChatGPT, the
 * AI SDK): the top-level `events` capability, and `webhook-id` equal to the
 * body's `eventId`, which a webhook makes per subscription (a digest of the
 * subscription and the event), as t3code's bridge does.
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

const NEXT_POLL_MS = 15_000;
const DEFAULT_MAX_EVENTS = 50;
const MAX_EVENTS = 200;
const MAX_REPLY_CHARS = 4_000;
const FORWARD_TIMEOUT_MS = 12_000;
const DEFAULT_TTL_MS = 60 * 60_000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 100;
const SECRET_GRACE_MS = 5 * 60_000;
const POST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_READ_BYTES = 8 * 1024;
const VERIFICATIONS_PER_HOST_PER_MINUTE = 10;
/** A failed endpoint check answers again from memory this long, so retrying a bad URL sends nothing. */
const VERIFICATION_FAILURE_MEMORY_MS = 60_000;
/** Delay before each try of one event: five tries over about 7.5 minutes. */
const RETRY_DELAYS_MS = [0, 30_000, 60_000, 2 * 60_000, 4 * 60_000];
const DELIVERIES_PER_PASS = 20;
const SUBSCRIPTION_KEY_PREFIX = "event-sub:";
/** A turn's reply reaches its transcript file within about 100 ms of the turn's end; a webhook waits this long for it. */
const REPLY_SETTLE_MS = 600;
/** A reply read finds nothing this soon after the turn: read again next time instead of keeping "no reply". */
const REPLY_RETRY_WINDOW_MS = 5_000;
/** An expired subscription its own machine never came back to remove: any machine removes it after this. */
const ORPHAN_AFTER_MS = 24 * 60 * 60_000;
const CURSOR_PREFIX = "ade1_";

// ── Event types ───────────────────────────────────────────────────────────────

const CHAT_EVENT_NAMES = new Set<McpEventName>(["chat.turn_ended", "chat.needs_input", "chat.input_resolved", "chat.deleted"]);

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
    inputs: { ...CHAT_INPUTS, include_reply: { type: "boolean", default: true, description: "Add the turn's final reply (at most 4,000 characters)." } },
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

type EventFilter = {
  names: ReadonlySet<McpEventName>;
  project: string | null;
  machine: string | null;
  session: string | null;
  includeSubagents: boolean;
  includeReply: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const invalid = (message: string): McpEventsError => new McpEventsError(EVENTS_ERROR.invalidParams, message);

function eventName(value: unknown): McpEventName {
  if (typeof value !== "string" || !value) throw invalid("Name the event: one of " + MCP_EVENT_NAMES.join(", ") + ".");
  if (!(MCP_EVENT_NAMES as readonly string[]).includes(value)) {
    throw new McpEventsError(EVENTS_ERROR.notFound, `No event "${value}". ADE has ${MCP_EVENT_NAMES.join(", ")}.`, { kind: "event" });
  }
  return value as McpEventName;
}

/** Checks `arguments` against every named event's inputSchema. */
function parseFilter(names: readonly McpEventName[], raw: unknown): EventFilter {
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

function boundedInteger(value: unknown, key: string, fallback: number | null, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`\`${key}\` must be a number.`);
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Canonical JSON: keys sorted, so equal arguments name one subscription. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// ── Cursors ──────────────────────────────────────────────────────────────────

/**
 * One position per machine, and when the cursor began: a machine with no
 * position yet gives its events since then.
 */
type AccountCursor = { t: number; m: Record<string, string> };

function encodeCursor(cursor: AccountCursor): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): AccountCursor | null {
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

const encodePosition = (position: McpHubPosition): string => `${position.boot}.${position.seq}`;
function decodePosition(value: unknown): McpHubPosition | null {
  if (typeof value !== "string") return null;
  const dot = value.lastIndexOf(".");
  const seq = Number(value.slice(dot + 1));
  return dot > 0 && Number.isInteger(seq) && seq >= 0 ? { boot: value.slice(0, dot), seq } : null;
}

// ── Webhook transport ────────────────────────────────────────────────────────

export type McpWebhookFailure = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

export type McpWebhookPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
  readBody: boolean,
) => Promise<{ status: number; body?: string; failure?: McpWebhookFailure; privateAddress?: boolean }>;

/** A public https URL, or why it can't be one. */
export function webhookUrlProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "`delivery.url` is required.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "`delivery.url` isn't a valid URL.";
  }
  if (url.protocol !== "https:") return "`delivery.url` must use https.";
  if (url.username || url.password) return "`delivery.url` can't carry a user name or password.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) ? isPrivateIpAddress(host) : isLocalHostname(host)) {
    return "`delivery.url` must be a public address, not this computer or a private network.";
  }
  return null;
}

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i;

/**
 * POSTs to the address the name resolved to, checked public, so DNS can't
 * swap in a private one between the check and the request. Never follows a
 * redirect, and reads at most 8 KiB of the answer, only when asked.
 */
export const postWebhook: McpWebhookPost = async (rawUrl, headers, body, readBody) => {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let target: { address: string; family: number };
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
      return { status: 0, failure: "connection_refused", privateAddress: true };
    }
    target = addresses[0]!;
  } catch {
    return { status: 0, failure: "connection_refused" };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: Awaited<ReturnType<McpWebhookPost>>) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = https.request(url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup: pinnedLookup(target.address, target.family === 6 ? 6 : 4),
      timeout: POST_TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const failure: McpWebhookFailure | undefined = status >= 500 ? "http_5xx" : status >= 300 ? "http_4xx" : undefined;
      if (!readBody) {
        response.resume();
        finish({ status, ...(failure ? { failure } : {}) });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        if (size >= MAX_RESPONSE_READ_BYTES) return;
        chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_RESPONSE_READ_BYTES) response.destroy();
      });
      const done = () => finish({ status, body: Buffer.concat(chunks).subarray(0, MAX_RESPONSE_READ_BYTES).toString("utf8"), ...(failure ? { failure } : {}) });
      response.on("end", done);
      response.on("close", done);
    });
    request.on("timeout", () => {
      finish({ status: 0, failure: "timeout" });
      request.destroy();
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      finish({ status: 0, failure: TLS_CODES.test(error.code ?? "") ? "tls_error" : "connection_refused" });
    });
    request.end(body);
  });
};

function secretBytes(secret: string): Buffer | null {
  if (!/^whsec_[A-Za-z0-9+/]+=*$/.test(secret)) return null;
  const bytes = Buffer.from(secret.slice("whsec_".length), "base64");
  return bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
}

/** Standard Webhooks headers; a second secret during rotation adds a second signature. */
function signedHeaders(args: { secrets: string[]; webhookId: string; subscriptionId: string; body: string }): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signatures = args.secrets.flatMap((secret) => {
    const key = secretBytes(secret);
    return key ? [`v1,${createHmac("sha256", key).update(`${args.webhookId}.${timestamp}.${args.body}`).digest("base64")}`] : [];
  });
  return {
    "content-type": "application/json",
    "user-agent": "ADE MCP events",
    "webhook-id": args.webhookId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures.join(" "),
    "x-mcp-subscription-id": args.subscriptionId,
  };
}

const controlMessageId = (type: string): string => `msg_${type}_${randomBytes(12).toString("base64url")}`;

// ── Subscriptions (account vault) ────────────────────────────────────────────

type StoredSubscription = {
  v: 1;
  id: string;
  /** The ADE MCP connection that subscribed: the principal. */
  connectionId: string;
  name: McpEventName;
  arguments: Record<string, unknown>;
  url: string;
  secret: string;
  previousSecret?: string;
  previousSecretUntil?: number;
  createdAt: number;
  /** Events since then: what a machine delivers first. */
  startAt: number;
  refreshBefore: number;
  /** The client's last cursor, for a machine starting this subscription after a restart. */
  cursor: string | null;
  /** `arguments.machine` resolved: only that machine delivers. */
  machineKey: string | null;
  /** The machine that took the subscribe: it removes it once expired or revoked. */
  servedBy: string;
};

function parseSubscription(raw: string | null): StoredSubscription | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.v !== 1 || typeof value.id !== "string" || typeof value.connectionId !== "string") return null;
    if (typeof value.url !== "string" || typeof value.secret !== "string" || typeof value.refreshBefore !== "number") return null;
    if (!(MCP_EVENT_NAMES as readonly string[]).includes(String(value.name))) return null;
    return value as unknown as StoredSubscription;
  } catch {
    return null;
  }
}

function createSubscriptionStore(vault: RemoteMcpVault, warn: (event: string, data: Record<string, unknown>) => void) {
  let cache = new Map<string, { updatedAt: string; subscription: StoredSubscription | null }>();
  const keyOf = (id: string) => `${SUBSCRIPTION_KEY_PREFIX}${id}`;
  return {
    list(): StoredSubscription[] {
      const next = new Map<string, { updatedAt: string; subscription: StoredSubscription | null }>();
      const out: StoredSubscription[] = [];
      for (const row of vault.list(REMOTE_MCP_VAULT_SCOPE)) {
        if (row.kind !== REMOTE_MCP_VAULT_KIND || !row.key.startsWith(SUBSCRIPTION_KEY_PREFIX) || row.deleted || !row.readable) continue;
        const cached = cache.get(row.key);
        const subscription = cached && cached.updatedAt === row.updatedAt
          ? cached.subscription
          : parseSubscription(vault.get(REMOTE_MCP_VAULT_SCOPE, REMOTE_MCP_VAULT_KIND, row.key));
        // The key names the record; a value claiming another id is not trusted.
        const trusted = subscription && keyOf(subscription.id) === row.key ? subscription : null;
        next.set(row.key, { updatedAt: row.updatedAt, subscription: trusted });
        if (trusted) out.push(trusted);
      }
      cache = next;
      return out;
    },
    save(subscription: StoredSubscription): void {
      if (!vault.set(REMOTE_MCP_VAULT_SCOPE, REMOTE_MCP_VAULT_KIND, keyOf(subscription.id), JSON.stringify(subscription))) {
        throw new Error("ADE couldn't save the subscription to your account vault. Try again shortly.");
      }
    },
    remove(id: string): void {
      try {
        vault.remove(REMOTE_MCP_VAULT_SCOPE, REMOTE_MCP_VAULT_KIND, keyOf(id));
      } catch (error) {
        warn("remote_mcp.events_unsubscribe_failed", { id, error: getErrorMessage(error) });
      }
    },
  };
}

// ── The service ──────────────────────────────────────────────────────────────

export type McpOccurrence = { eventId: string; name: McpEventName; timestamp: string; data: Record<string, unknown>; cursor?: string | null };

/** One machine's answer to an account-wide read. */
type MachineRead = { events: Array<{ occurrence: McpOccurrence; seq: number }>; part: string; truncated: boolean; hasMore: boolean };

export type McpEventsDeps = {
  machines: RemoteMcpMachineRouter;
  listProjects: () => RemoteMcpProject[];
  vault: RemoteMcpVault;
  /** The connection behind a principal, or null when it was removed. */
  connection: (id: string) => RemoteMcpConnectionSummary | null;
  /** This machine answers ADE MCP now; one that doesn't sends no webhooks. */
  servingHere: () => boolean;
  /** Pushes the vault soon, so the other machines see a new subscription. */
  syncSoon: () => void;
  post?: McpWebhookPost;
  warn?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
};

export function createRemoteMcpEvents(deps: McpEventsDeps) {
  const now = deps.now ?? Date.now;
  const post = deps.post ?? postWebhook;
  const warn = (event: string, data: Record<string, unknown> = {}) => deps.warn?.(event, data);
  const store = createSubscriptionStore(deps.vault, warn);
  const selfKey = (): string => deps.machines.thisMachine().key || "here";

  // ── Reading this machine's events ──────────────────────────────────────────

  const summaries = new WeakMap<McpHubEntry, Promise<Record<string, unknown> | null>>();
  const replies = new WeakMap<McpHubEntry, Promise<Record<string, unknown> | null>>();

  const summaryOf = (entry: McpHubEntry): Promise<Record<string, unknown> | null> => {
    let pending = summaries.get(entry);
    if (!pending) {
      const source = entry.sessionId ? mcpChatSource(entry.projectId) : null;
      pending = source && entry.sessionId ? source.summary(entry.sessionId).catch(() => null) : Promise.resolve(null);
      summaries.set(entry, pending);
    }
    return pending;
  };

  const replyOf = (entry: McpHubEntry): Promise<Record<string, unknown> | null> => {
    let pending = replies.get(entry);
    if (!pending) {
      const source = mcpChatSource(entry.projectId);
      pending = source && entry.sessionId
        ? source.finalReply(entry.sessionId, entry.turnId, entry.turnStartedAt).then((reply) => {
          if (!reply?.text.trim()) return null;
          const text = redactOutgoingChatText(reply.text.trim());
          return {
            text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS - 1)}…` : text,
            messageId: reply.messageId,
            ...(text.length > MAX_REPLY_CHARS ? { truncated: true } : {}),
          };
        }).catch(() => null)
        : Promise.resolve(null);
      replies.set(entry, pending);
      // Just after the turn, the reply may still be on its way to the file.
      void pending.then((reply) => {
        if (!reply && now() - entry.at < REPLY_RETRY_WINDOW_MS && replies.get(entry) === pending) replies.delete(entry);
      });
    }
    return pending;
  };

  /** This machine's projects a `project` argument names: by id, account id, name or folder name. */
  const projectIdsNamed = (requested: string): Set<string> => {
    const lower = requested.toLowerCase();
    return new Set(deps.listProjects().filter((project) =>
      project.projectId === requested
      || project.accountProjectId === requested
      || project.displayName.toLowerCase() === lower
      || project.rootPath === requested
      || project.rootPath.split(/[\\/]/).pop()?.toLowerCase() === lower).map((project) => project.projectId));
  };

  const occurrenceOf = async (entry: McpHubEntry, filter: EventFilter): Promise<McpOccurrence | null> => {
    const chat = CHAT_EVENT_NAMES.has(entry.name);
    // A deleted chat has no summary left: the hub kept what it was.
    const summary: Record<string, unknown> | null = chat ? await summaryOf(entry) ?? (entry.sessionId ? mcpDeletedChat(entry.sessionId) : null) : null;
    const parentRaw = summary?.orchestrationParentSessionId ?? summary?.parentSessionId;
    const parentSessionId = typeof parentRaw === "string" && parentRaw.trim() ? parentRaw.trim() : null;
    if (parentSessionId && !filter.includeSubagents) return null;
    const self = deps.machines.thisMachine();
    const project = deps.listProjects().find((candidate) => candidate.projectId === entry.projectId);
    const data: Record<string, unknown> = chat
      ? {
        title: typeof summary?.title === "string" ? summary.title : null,
        laneId: typeof summary?.laneId === "string" ? summary.laneId : null,
        ...entry.data,
        sessionId: entry.sessionId,
        parentSessionId,
        ...(entry.name === "chat.deleted" ? {} : { turnId: entry.turnId }),
      }
      : { ...entry.data };
    if (entry.name === "chat.turn_ended" && filter.includeReply) {
      const reply = await replyOf(entry);
      if (reply) data.reply = reply;
    }
    data.projectId = entry.projectId;
    data.project = project?.displayName ?? null;
    data.machine = { key: self.key, name: self.name };
    return { eventId: entry.eventId, name: entry.name, timestamp: new Date(entry.at).toISOString(), data };
  };

  /** This machine's matching events after its part of a cursor (or since `sinceMs` without one). */
  const readHere = async (args: {
    filter: EventFilter;
    part: string | null;
    sinceMs: number | null;
    max: number;
    maxAgeMs: number | null;
  }): Promise<MachineRead> => {
    const given = decodePosition(args.part);
    const after = given ?? (args.sinceMs !== null ? mcpHubPositionAt(args.sinceMs) : null);
    // No position here yet: a start before this brain run (or before the oldest event kept) is a gap.
    const sinceGap = !given && args.sinceMs !== null && !mcpHubCovers(args.sinceMs);
    const projects = args.filter.project ? projectIdsNamed(args.filter.project) : null;
    const page = readMcpHub({
      after,
      match: (entry) => args.filter.names.has(entry.name)
        && (!projects || projects.has(entry.projectId))
        && (!args.filter.session || entry.sessionId === args.filter.session),
      max: 1_000,
      notBefore: args.maxAgeMs !== null ? now() - args.maxAgeMs : null,
    });
    const events: MachineRead["events"] = [];
    let next = page.next;
    let hasMore = page.hasMore;
    for (const entry of page.entries) {
      if (events.length >= args.max) {
        hasMore = true;
        next = { boot: next.boot, seq: events[events.length - 1]!.seq };
        break;
      }
      const occurrence = await occurrenceOf(entry, args.filter);
      if (occurrence) events.push({ occurrence, seq: entry.seq });
    }
    return { events, part: encodePosition(next), truncated: page.truncated || sinceGap, hasMore };
  };

  // ── Machines ───────────────────────────────────────────────────────────────

  type Target = { key: string; name: string; here: boolean; machine: RemoteMcpRosterMachine | null; reason: string | null };

  /** The machines a read covers: all the connection reaches, or the one `machine` names. */
  const targetsFor = async (connection: RemoteMcpConnectionSummary, machine: string | null): Promise<Target[]> => {
    const router = deps.machines;
    const self = router.thisMachine();
    let onlyKey = connection.onlyMachine?.machineKey ?? null;
    if (machine) {
      const resolved = await router.resolve(machine);
      if (resolved.kind === "error") throw invalid(resolved.message);
      const key = resolved.kind === "here" ? resolved.machine.key : resolved.machine.machineKey;
      if (onlyKey && key !== onlyKey) throw new McpEventsError(EVENTS_ERROR.forbidden, "This connection reaches one machine only, and that isn't it.");
      onlyKey = key;
    }
    const roster = await router.roster();
    const targets: Target[] = [];
    if (!onlyKey || onlyKey === self.key) targets.push({ key: self.key || "here", name: self.name, here: true, machine: null, reason: null });
    for (const entry of roster) {
      if (entry.isThisMachine || !entry.included || (onlyKey && entry.machineKey !== onlyKey)) continue;
      targets.push({ key: entry.machineKey, name: entry.name, here: false, machine: entry, reason: router.unavailableReason(entry) });
    }
    return targets;
  };

  const readThere = async (
    target: Target,
    connection: RemoteMcpConnectionSummary,
    context: RemoteMcpCallContext,
    request: { names: McpEventName[]; arguments: Record<string, unknown>; part: string | null; since: number; max: number; maxAgeMs: number | null },
  ): Promise<MachineRead | null> => {
    if (!target.machine || target.reason) return null;
    const result = await deps.machines.forward(target.machine, { name: EVENTS_HERE_TOOL_NAME, arguments: request }, context, FORWARD_TIMEOUT_MS)
      .catch(() => null);
    const read = result && !result.isError ? result.structuredContent : null;
    if (!isRecord(read) || !Array.isArray(read.events) || typeof read.part !== "string") return null;
    return read as unknown as MachineRead;
  };

  /** One forwarded `ade_events_here` call: this machine's part of an account-wide read. */
  const answerHere = async (input: Record<string, unknown>): Promise<MachineRead> => {
    const names = Array.isArray(input.names) ? input.names.map(eventName) : [eventName(input.name)];
    return await readHere({
      filter: parseFilter(names, input.arguments),
      part: typeof input.part === "string" ? input.part : null,
      sinceMs: typeof input.since === "number" ? input.since : null,
      max: boundedInteger(input.max, "max", DEFAULT_MAX_EVENTS, 1, MAX_EVENTS)!,
      maxAgeMs: boundedInteger(input.maxAgeMs, "maxAgeMs", null, 0, Number.MAX_SAFE_INTEGER),
    });
  };

  /** Every machine's matching events after the cursor, oldest first. */
  const pollAccount = async (
    connection: RemoteMcpConnectionSummary,
    context: RemoteMcpCallContext,
    request: { names: McpEventName[]; arguments: unknown; cursor: unknown; maxEvents: unknown; maxAgeMs: unknown },
  ) => {
    const filter = parseFilter(request.names, request.arguments);
    const max = boundedInteger(request.maxEvents, "maxEvents", DEFAULT_MAX_EVENTS, 1, MAX_EVENTS)!;
    const maxAgeMs = boundedInteger(request.maxAgeMs, "maxAgeMs", null, 0, Number.MAX_SAFE_INTEGER);
    const cursor = decodeCursor(request.cursor);
    const targets = await targetsFor(connection, filter.machine);
    // Null starts now: no machine needs asking, each starts at this moment.
    if (!cursor) return { events: [] as McpOccurrence[], cursor: encodeCursor({ t: now(), m: {} }), truncated: false, hasMore: false, unread: [] as Array<{ key: string; name: string; reason: string }> };
    const argumentsForward = isRecord(request.arguments) ? { ...request.arguments } : {};
    delete argumentsForward.machine;
    const reads = await Promise.all(targets.map(async (target) => {
      const part = cursor.m[target.key] ?? null;
      const read = target.here
        ? await readHere({ filter, part, sinceMs: cursor.t, max, maxAgeMs })
        : await readThere(target, connection, context, { names: request.names, arguments: argumentsForward, part, since: cursor.t, max, maxAgeMs });
      return { target, read };
    }));
    const merged = reads.flatMap(({ target, read }) => (read?.events ?? []).map((event) => ({ ...event, key: target.key })))
      .sort((left, right) => left.occurrence.timestamp.localeCompare(right.occurrence.timestamp));
    const kept = merged.slice(0, max);
    const parts: Record<string, string> = { ...cursor.m };
    let hasMore = merged.length > kept.length;
    for (const { target, read } of reads) {
      // Unreachable now: its position stays, and it catches up when it is back.
      if (!read) continue;
      const mine = kept.filter((event) => event.key === target.key);
      const cut = mine.length < read.events.length;
      parts[target.key] = cut
        ? `${read.part.slice(0, read.part.lastIndexOf("."))}.${mine.length ? mine[mine.length - 1]!.seq : Math.max(0, read.events[0]!.seq - 1)}`
        : read.part;
      if (read.hasMore) hasMore = true;
    }
    return {
      events: kept.map((event) => event.occurrence),
      cursor: encodeCursor({ t: cursor.t, m: parts }),
      truncated: reads.some(({ read }) => read?.truncated === true),
      hasMore,
      // Offline, asleep, or on an ADE without Events: their events come on a later poll.
      unread: reads.filter(({ read }) => !read).map(({ target }) => ({ key: target.key, name: target.name, reason: target.reason ?? "no_answer" })),
    };
  };

  // ── Webhook subscriptions ──────────────────────────────────────────────────

  const verifiedRecently = new Map<string, number>();
  const verificationsByHost = new Map<string, number[]>();
  /** Per (connection, url): a check running now, or one that failed lately. */
  const verificationsRunning = new Map<string, Promise<void>>();
  const verificationFailures = new Map<string, { at: number; error: McpEventsError }>();

  /** One check per (connection, url) at a time; a failure is remembered for a minute. */
  const verifyOnce = async (pairKey: string, subscriptionId: string, url: string, secret: string): Promise<void> => {
    const failed = verificationFailures.get(pairKey);
    if (failed && now() - failed.at < VERIFICATION_FAILURE_MEMORY_MS) throw failed.error;
    let running = verificationsRunning.get(pairKey);
    if (!running) {
      running = verify(subscriptionId, url, secret).then(() => {
        verificationFailures.delete(pairKey);
        verifiedRecently.set(pairKey, now());
      }, (error: unknown) => {
        // The rate limit is about this minute, not about the endpoint: not remembered.
        if (error instanceof McpEventsError && error.code !== EVENTS_ERROR.resourceExhausted) {
          verificationFailures.set(pairKey, { at: now(), error });
          if (verificationFailures.size > 1_000) verificationFailures.delete(verificationFailures.keys().next().value!);
        }
        throw error;
      }).finally(() => verificationsRunning.delete(pairKey));
      verificationsRunning.set(pairKey, running);
    }
    await running;
  };

  const verify = async (subscriptionId: string, url: string, secret: string): Promise<void> => {
    const host = new URL(url).hostname;
    const recent = (verificationsByHost.get(host) ?? []).filter((at) => now() - at < 60_000);
    if (recent.length >= VERIFICATIONS_PER_HOST_PER_MINUTE) {
      throw new McpEventsError(EVENTS_ERROR.resourceExhausted, `Too many endpoint checks for ${host} this minute. Try again shortly.`, { limit: "verifications" });
    }
    verificationsByHost.set(host, [...recent, now()]);
    const challenge = randomBytes(24).toString("base64url");
    const body = JSON.stringify({ type: "verification", challenge });
    const answer = await post(url, signedHeaders({ secrets: [secret], webhookId: controlMessageId("verification"), subscriptionId, body }), body, true);
    if (answer.privateAddress) throw invalid("`delivery.url` resolves to a private address. Use a public https URL.");
    if (answer.failure || answer.status < 200 || answer.status >= 300) {
      throw new McpEventsError(EVENTS_ERROR.callbackEndpoint, "The webhook endpoint didn't accept ADE's check.", { reason: answer.failure ?? "http_4xx" });
    }
    let echoed: unknown = null;
    try {
      echoed = isRecord(JSON.parse(answer.body ?? "")) ? (JSON.parse(answer.body ?? "") as Record<string, unknown>).challenge : null;
    } catch {
      echoed = null;
    }
    const expected = Buffer.from(challenge);
    const given = Buffer.from(typeof echoed === "string" ? echoed : "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new McpEventsError(EVENTS_ERROR.callbackEndpoint, "The webhook endpoint didn't echo ADE's challenge.", { reason: "challenge_failed" });
    }
  };

  const subscriptionId = (connectionId: string, url: string, name: string, args: unknown): string =>
    `sub_${createHash("sha256").update(canonicalJson([connectionId, url, name, args ?? {}])).digest("base64url").slice(0, 22)}`;

  const subscribe = async (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>) => {
    const name = eventName(params.name);
    const filter = parseFilter([name], params.arguments);
    const delivery = isRecord(params.delivery) ? params.delivery : null;
    if (!delivery) throw invalid("`delivery` is required: {mode: \"webhook\", url, secret}.");
    if (delivery.mode !== undefined && delivery.mode !== "webhook") {
      throw new McpEventsError(EVENTS_ERROR.unsupported, "ADE delivers events by poll or webhook.", { feature: "deliveryMode", value: delivery.mode });
    }
    const urlProblem = webhookUrlProblem(delivery.url);
    if (urlProblem) throw invalid(urlProblem);
    const url = String(delivery.url).trim();
    const secret = typeof delivery.secret === "string" ? delivery.secret.trim() : "";
    if (!secretBytes(secret)) throw invalid("`delivery.secret` must be `whsec_` and the base64 of 24 to 64 random bytes.");
    const cursor = params.cursor === undefined || params.cursor === null ? null : String(params.cursor);
    decodeCursor(cursor);
    const ttlMs = params.ttlMs === undefined
      ? DEFAULT_TTL_MS
      // No expiry is not granted: a day, refreshed like any other.
      : params.ttlMs === null ? MAX_TTL_MS : boundedInteger(params.ttlMs, "ttlMs", DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS)!;
    const args = isRecord(params.arguments) ? params.arguments : {};
    const id = subscriptionId(connection.id, url, name, args);
    const all = store.list();
    const existing = all.find((entry) => entry.id === id) ?? null;
    const live = existing && existing.refreshBefore > now() ? existing : null;
    if (!live && all.filter((entry) => entry.connectionId === connection.id && entry.refreshBefore > now()).length >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
      throw new McpEventsError(EVENTS_ERROR.resourceExhausted, `One app can keep at most ${MAX_SUBSCRIPTIONS_PER_CONNECTION} subscriptions.`, { limit: "subscriptions", max: MAX_SUBSCRIPTIONS_PER_CONNECTION });
    }
    const machineKey = filter.machine ? (await targetsFor(connection, filter.machine))[0]?.key ?? null : connection.onlyMachine?.machineKey ?? null;
    const pairKey = `${connection.id}\n${url}`;
    const known = all.some((entry) => entry.connectionId === connection.id && entry.url === url && entry.refreshBefore > now())
      || (verifiedRecently.get(pairKey) ?? 0) > now() - MAX_TTL_MS;
    if (!known) await verifyOnce(pairKey, id, url, secret);
    const at = now();
    const rotated = live && live.secret !== secret;
    const record: StoredSubscription = {
      v: 1,
      id,
      connectionId: connection.id,
      name,
      arguments: args,
      url,
      secret,
      ...(rotated ? { previousSecret: live.secret, previousSecretUntil: at + SECRET_GRACE_MS } : {}),
      ...(!rotated && live?.previousSecret && (live.previousSecretUntil ?? 0) > at
        ? { previousSecret: live.previousSecret, previousSecretUntil: live.previousSecretUntil }
        : {}),
      createdAt: live?.createdAt ?? at,
      startAt: live?.startAt ?? at,
      refreshBefore: at + ttlMs,
      cursor: cursor ?? live?.cursor ?? null,
      machineKey,
      servedBy: selfKey(),
    };
    store.save(record);
    deps.syncSoon();
    kick();
    const lane = lanes.get(id);
    return {
      id,
      refreshBefore: new Date(record.refreshBefore).toISOString(),
      cursor: encodeCursor({ t: record.startAt, m: lane ? { [selfKey()]: encodePosition(lane.after) } : {} }),
      truncated: false,
      ...(live && lane
        ? {
          deliveryStatus: {
            active: true,
            lastDeliveryAt: lane.lastDeliveryAt ? new Date(lane.lastDeliveryAt).toISOString() : null,
            lastError: lane.lastError,
            ...(lane.failedSince ? { failedSince: new Date(lane.failedSince).toISOString() } : {}),
          },
        }
        : {}),
    };
  };

  const unsubscribe = (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>): void => {
    const name = eventName(params.name);
    const delivery = isRecord(params.delivery) ? params.delivery : null;
    const url = typeof delivery?.url === "string" ? delivery.url.trim() : "";
    if (!url) throw invalid("`delivery.url` is required.");
    const id = subscriptionId(connection.id, url, name, isRecord(params.arguments) ? params.arguments : {});
    if (!store.list().some((entry) => entry.id === id)) {
      throw new McpEventsError(EVENTS_ERROR.notFound, "No subscription matches that event, arguments and URL.", { kind: "subscription" });
    }
    store.remove(id);
    lanes.delete(id);
    deps.syncSoon();
  };

  // ── Delivery (each machine sends its own events) ───────────────────────────

  type Pending = { eventId: string; seq: number; body: string; attempts: number; nextAt: number };
  type Lane = {
    after: McpHubPosition;
    /** This run started after the subscription did: tell the app it may have missed events. */
    gapOwed: boolean;
    /** Waiting for a turn's reply to reach its file, until then. */
    settleAt: number | null;
    pending: Pending | null;
    lastDeliveryAt: number | null;
    lastError: McpWebhookFailure | null;
    failedSince: number | null;
  };
  const lanes = new Map<string, Lane>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerun = false;
  let disposed = false;

  const secretsOf = (subscription: StoredSubscription): string[] =>
    subscription.previousSecret && (subscription.previousSecretUntil ?? 0) > now()
      ? [subscription.secret, subscription.previousSecret]
      : [subscription.secret];

  const sendControl = async (subscription: StoredSubscription, body: Record<string, unknown>): Promise<void> => {
    const text = JSON.stringify(body);
    await post(subscription.url, signedHeaders({
      secrets: secretsOf(subscription),
      webhookId: controlMessageId(String(body.type)),
      subscriptionId: subscription.id,
      body: text,
    }), text, false).catch(() => undefined);
  };

  const laneFor = (subscription: StoredSubscription): Lane => {
    let lane = lanes.get(subscription.id);
    if (!lane) {
      // After a restart, the client's cursor is where to resume when it is from this run.
      const fromCursor = (() => {
        try {
          return decodePosition(decodeCursor(subscription.cursor)?.m[selfKey()]);
        } catch {
          return null;
        }
      })();
      const resumed = fromCursor && fromCursor.boot === mcpHubHead().boot ? fromCursor : null;
      const after = resumed ?? mcpHubPositionAt(subscription.startAt);
      const gapOwed = !resumed && !mcpHubCovers(subscription.startAt);
      lane = { after, gapOwed, settleAt: null, pending: null, lastDeliveryAt: null, lastError: null, failedSince: null };
      lanes.set(subscription.id, lane);
    }
    return lane;
  };

  /** True when the event is finished with: delivered, refused for good, or out of tries. */
  const attempt = async (subscription: StoredSubscription, lane: Lane, pending: Pending): Promise<boolean> => {
    const answer = await post(subscription.url, signedHeaders({
      secrets: secretsOf(subscription),
      // The draft bridge: the body's per-subscription `eventId`, reused on every retry.
      webhookId: pending.eventId,
      subscriptionId: subscription.id,
      body: pending.body,
    }), pending.body, false);
    if (answer.status >= 200 && answer.status < 300) {
      lane.lastDeliveryAt = now();
      lane.lastError = null;
      lane.failedSince = null;
      return true;
    }
    lane.lastError = answer.failure ?? "http_4xx";
    lane.failedSince ??= now();
    pending.attempts += 1;
    const delay = RETRY_DELAYS_MS[pending.attempts];
    if (answer.privateAddress || answer.status === 410 || answer.status === 413 || delay === undefined) {
      warn("remote_mcp.events_delivery_dropped", { subscriptionId: subscription.id, status: answer.status, attempts: pending.attempts });
      return true;
    }
    pending.nextAt = now() + delay;
    return false;
  };

  const deliver = async (subscription: StoredSubscription): Promise<void> => {
    const lane = laneFor(subscription);
    const filter = parseFilter([subscription.name], subscription.arguments);
    for (let sent = 0; sent < DELIVERIES_PER_PASS; sent += 1) {
      if (!lane.pending) {
        const read = await readHere({ filter, part: encodePosition(lane.after), sinceMs: null, max: 1, maxAgeMs: null });
        const first = read.events[0];
        if (read.truncated || lane.gapOwed) {
          lane.gapOwed = false;
          // Past the gap, so the next pass doesn't report it again.
          if (read.truncated) lane.after = first ? { boot: mcpHubHead().boot, seq: first.seq - 1 } : decodePosition(read.part) ?? lane.after;
          await sendControl(subscription, { type: "gap", cursor: encodeCursor({ t: subscription.startAt, m: { [selfKey()]: encodePosition(lane.after) } }) });
        }
        if (!first) {
          lane.after = decodePosition(read.part) ?? lane.after;
          return;
        }
        const age = now() - Date.parse(first.occurrence.timestamp);
        if (first.occurrence.name === "chat.turn_ended" && filter.includeReply && !first.occurrence.data.reply && age < REPLY_SETTLE_MS) {
          lane.settleAt = now() + (REPLY_SETTLE_MS - age);
          return;
        }
        lane.settleAt = null;
        const entryPosition = { boot: mcpHubHead().boot, seq: first.seq };
        // Clients built on the draft before the SEP require `webhook-id` = body `eventId`. One
        // per subscription, so two subscriptions on one URL never share an id a receiver drops.
        const deliveryId = `evt_${createHash("sha256").update(`${subscription.id}:${first.occurrence.eventId}`).digest("base64url").slice(0, 22)}`;
        const occurrence: McpOccurrence = {
          ...first.occurrence,
          eventId: deliveryId,
          // Safe to keep: everything up to this event is delivered or given up on.
          cursor: encodeCursor({ t: subscription.startAt, m: { [selfKey()]: encodePosition(entryPosition) } }),
        };
        lane.pending = { eventId: deliveryId, seq: first.seq, body: JSON.stringify(occurrence), attempts: 0, nextAt: now() };
      }
      const pending = lane.pending;
      if (pending.nextAt > now()) return;
      const finished = await attempt(subscription, lane, pending);
      if (!finished) return;
      lane.after = { boot: mcpHubHead().boot, seq: pending.seq };
      lane.pending = null;
    }
    // More waiting: the next pass sends them.
    rerun = true;
  };

  const run = async (): Promise<void> => {
    if (disposed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      const subscriptions = store.list();
      const self = selfKey();
      const ids = new Set(subscriptions.map((entry) => entry.id));
      for (const id of lanes.keys()) if (!ids.has(id)) lanes.delete(id);
      const serving = deps.servingHere();
      for (const subscription of subscriptions) {
        const owner = subscription.servedBy === self;
        if (subscription.refreshBefore <= now()) {
          // Its own machine removes it; any machine does once that one stayed away a day.
          if (owner || subscription.refreshBefore <= now() - ORPHAN_AFTER_MS) store.remove(subscription.id);
          lanes.delete(subscription.id);
          continue;
        }
        const connection = deps.connection(subscription.connectionId);
        if (!connection) {
          if (owner) {
            await sendControl(subscription, { type: "terminated", error: { code: EVENTS_ERROR.forbidden, message: "Access revoked: the app's ADE MCP connection was removed." } });
            store.remove(subscription.id);
          }
          lanes.delete(subscription.id);
          continue;
        }
        const onlyKey = subscription.machineKey ?? connection.onlyMachine?.machineKey ?? null;
        if (!serving || (onlyKey && onlyKey !== self)) continue;
        await deliver(subscription).catch((error: unknown) => warn("remote_mcp.events_delivery_failed", { subscriptionId: subscription.id, error: getErrorMessage(error) }));
      }
    } finally {
      running = false;
      scheduleRetry();
      if (rerun) {
        rerun = false;
        kick();
      }
    }
  };

  const scheduleRetry = (): void => {
    if (timer || disposed) return;
    const next = Math.min(...[...lanes.values()].flatMap((lane) => [
      ...(lane.pending ? [lane.pending.nextAt] : []),
      ...(lane.settleAt !== null ? [lane.settleAt] : []),
    ]));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, Math.max(250, next - now()));
    timer.unref?.();
  };

  /** Checks the subscriptions soon: a new event, a new subscription, or the service's refresh. */
  const kick = (): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, 250);
    timer.unref?.();
  };

  // Only when some subscription exists: a machine with none does nothing per event.
  let hasSubscriptions = false;
  const noticeSubscriptions = (): void => {
    hasSubscriptions = store.list().length > 0;
  };
  noticeSubscriptions();
  const stopListening = onMcpEvent(() => {
    if (hasSubscriptions) kick();
  });

  return {
    list: listMcpEventTypes,
    poll: async (connection: RemoteMcpConnectionSummary, context: RemoteMcpCallContext, params: Record<string, unknown>) => {
      const { unread, ...page } = await pollAccount(connection, context, {
        names: [eventName(params.name)],
        arguments: params.arguments,
        cursor: params.cursor,
        maxEvents: params.maxEvents,
        maxAgeMs: params.maxAgeMs,
      });
      return { ...page, nextPollMs: NEXT_POLL_MS, ...(unread.length ? { _meta: { "dev.ade/unreadMachines": unread } } : {}) };
    },
    /** The `events_poll` tool: every event name unless `names` picks some. */
    pollTool: async (connection: RemoteMcpConnectionSummary, context: RemoteMcpCallContext, input: Record<string, unknown>) => {
      const names = input.names === undefined || input.names === null
        ? [...MCP_EVENT_NAMES]
        : Array.isArray(input.names) ? input.names.map(eventName) : [eventName(input.names)];
      const { cursor, names: _names, max, ...rest } = input;
      return await pollAccount(connection, context, { names, arguments: rest, cursor, maxEvents: max, maxAgeMs: undefined });
    },
    answerHere,
    subscribe: async (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>) => {
      const answer = await subscribe(connection, params);
      hasSubscriptions = true;
      return answer;
    },
    unsubscribe: (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>) => {
      unsubscribe(connection, params);
      noticeSubscriptions();
    },
    /** The service's periodic refresh: subscriptions from other machines, expiry and revocation. */
    refresh(): void {
      noticeSubscriptions();
      if (hasSubscriptions || lanes.size) kick();
    },
    dispose(): void {
      disposed = true;
      stopListening();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export type RemoteMcpEvents = ReturnType<typeof createRemoteMcpEvents>;
