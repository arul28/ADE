/**
 * Per-turn cost and served model for Cursor chats, from Cursor's web dashboard.
 *
 * ADE drives Cursor chats through the Cursor SDK, but `agent.getUsage()`
 * answers `feature_unavailable` on some accounts, so ADE never learns what a
 * Cursor turn cost or which model actually served it (an "auto" pick, for
 * example). The dashboard's usage-event list has both. Each event's
 * `conversationId` is the SDK agent id ADE stores for the chat
 * (`agent-<uuid>`); the Cursor IDE's own events carry other id shapes or none,
 * so matching on the exact agent id keeps IDE usage out of ADE's turns.
 *
 * The feed corrects the per-turn ledger only. It writes no Usage-tab rows:
 * those come from `getUsage` (`cursorBilledUsageStore.ts`).
 *
 * The endpoint is private and undocumented. Every field is read as untrusted,
 * a body that is not the expected shape fails closed, and the Cursor session
 * token never leaves the request headers.
 */
import { homedir } from "node:os";
import { asRecord, finiteNumberFromNumeric, isEnvFlagOff, positiveCountOrZero, toOptionalString } from "../shared/utils";
import { cursorSessionCookie, cursorStateDbPath, readCursorSessionToken, usableSessionToken } from "./extraProviderQuota";
import { centsToUsd } from "./cursorUsageMapping";

const CURSOR_DASHBOARD_USAGE_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * How far before the turn's first event a dashboard event may sit and still
 * belong to the turn. Small, because the previous turn of the same agent ends
 * just before this one starts.
 */
export const CURSOR_TURN_START_SKEW_MS = 10_000;

/**
 * Cursor writes a usage event some time after the turn ends. ADE re-checks
 * the dashboard at these delays after a turn and stops at the first check that
 * finds the turn's events, so a slow write still lands without polling forever.
 */
export const CURSOR_DASHBOARD_RECONCILE_DELAYS_MS = [20_000, 90_000, 300_000] as const;

/** One dashboard usage event, normalized. Missing numbers are null, missing token counts 0. */
export type CursorDashboardUsageEvent = {
  timestampMs: number;
  conversationId: string | null;
  model: string | null;
  kind: string | null;
  requestsCosts: number | null;
  chargedCents: number | null;
  totalCents: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  isChargeable: boolean | null;
  isHeadless: boolean | null;
  subscriptionProductId: string | null;
};

/** Returns Cursor's stored access token, or null when there is none. */
export type CursorAccessTokenReader = () => Promise<string | null> | string | null;

export type CursorDashboardFetchResult =
  | { ok: true; events: CursorDashboardUsageEvent[] }
  | { ok: false; reason: "no_token" | "http_error" | "bad_body" | "network_error"; status?: number };

/** What one Cursor turn cost and which model served it, summed over its dashboard events. */
export type CursorTurnReconciliation = {
  servedModel: string | null;
  costUsd: number | null;
  requests: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  eventKeys: string[];
  chargeable: boolean;
};

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/** The raw event list, or null when the body is not the verified shape. */
function readEventList(body: unknown): unknown[] | null {
  const list = asRecord(body)?.usageEventsDisplay;
  return Array.isArray(list) ? list : null;
}

function parseEvent(raw: unknown): CursorDashboardUsageEvent | null {
  const record = asRecord(raw);
  if (!record) return null;
  const timestampMs = finiteNumberFromNumeric(record.timestamp);
  if (timestampMs == null || timestampMs <= 0) return null;
  const tokens = asRecord(record.tokenUsage) ?? {};
  return {
    timestampMs,
    conversationId: toOptionalString(record.conversationId),
    model: toOptionalString(record.model),
    kind: toOptionalString(record.kind),
    requestsCosts: finiteNumberFromNumeric(record.requestsCosts),
    chargedCents: finiteNumberFromNumeric(record.chargedCents),
    totalCents: finiteNumberFromNumeric(tokens.totalCents),
    inputTokens: positiveCountOrZero(tokens.inputTokens),
    outputTokens: positiveCountOrZero(tokens.outputTokens),
    cacheReadTokens: positiveCountOrZero(tokens.cacheReadTokens),
    cacheWriteTokens: positiveCountOrZero(tokens.cacheWriteTokens),
    isChargeable: readBoolean(record.isChargeable),
    isHeadless: readBoolean(record.isHeadless),
    subscriptionProductId: toOptionalString(record.subscriptionProductId),
  };
}

/**
 * Parses a `get-filtered-usage-events` body. The endpoint is private, so this
 * never throws: an unexpected body yields [], and an event without a usable
 * timestamp is skipped because it cannot be placed in any turn.
 */
export function parseCursorDashboardUsageEvents(body: unknown): CursorDashboardUsageEvent[] {
  const list = readEventList(body);
  if (!list) return [];
  const events: CursorDashboardUsageEvent[] = [];
  for (const raw of list) {
    const event = parseEvent(raw);
    if (event) events.push(event);
  }
  return events;
}

/** Stable identity for one dashboard event, so a re-fetched event is used for one turn only. */
export function cursorDashboardEventKey(event: Pick<CursorDashboardUsageEvent, "conversationId" | "timestampMs">): string {
  return `cursor:dashboard:${event.conversationId}:${event.timestampMs}`;
}

/**
 * Cursor's stored access token from its `state.vscdb`, read-only. Null when
 * there is none, the file cannot be read, or the token has expired: an expired
 * token would only earn a 401.
 */
export async function readCursorDashboardAccessToken(
  dbPath = cursorStateDbPath({ homeDir: homedir(), platform: process.platform, env: process.env }),
  nowMs = Date.now(),
): Promise<string | null> {
  return usableSessionToken((await readCursorSessionToken(dbPath)).token, nowMs);
}

function isAbortError(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Reads usage events between `startMs` and `endMs`, newest first, across up to
 * `maxPages` pages. It stops early at a short page or once a page reaches past
 * `startMs`. One timeout covers every page. It never throws, and no result
 * carries the token or the cookie. A failure on any page fails the whole
 * fetch: a partial list would undercount a turn that ADE then marks settled.
 */
export async function fetchCursorDashboardUsageEvents(args: {
  startMs: number;
  endMs: number;
  pageSize?: number;
  maxPages?: number;
  readAccessToken?: CursorAccessTokenReader;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<CursorDashboardFetchResult> {
  let token: string | null;
  try {
    token = (await (args.readAccessToken ?? readCursorDashboardAccessToken)())?.trim() || null;
  } catch {
    token = null;
  }
  if (!token) return { ok: false, reason: "no_token" };

  const pageSize = Math.max(1, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE));
  const maxPages = Math.max(1, Math.floor(args.maxPages ?? DEFAULT_MAX_PAGES));
  const fetchImpl = args.fetchImpl ?? fetch;
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: "https://cursor.com",
    Referer: "https://cursor.com/dashboard",
    Cookie: `WorkosCursorSessionToken=${encodeURIComponent(cursorSessionCookie(token))}`,
  };
  const timeoutMs = args.timeoutMs != null && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
    ? Math.floor(args.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  const events: CursorDashboardUsageEvent[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page += 1) {
    let response: Response;
    try {
      response = await fetchImpl(CURSOR_DASHBOARD_USAGE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          startDate: String(args.startMs),
          endDate: String(args.endMs),
          page,
          pageSize,
        }),
        credentials: "omit",
        signal,
      });
    } catch {
      return { ok: false, reason: "network_error" };
    }
    if (!response.ok) return { ok: false, reason: "http_error", status: response.status };
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return isAbortError(error) ? { ok: false, reason: "network_error" } : { ok: false, reason: "bad_body" };
    }
    const list = readEventList(body);
    if (!list) return { ok: false, reason: "bad_body" };

    let oldestMs = Number.POSITIVE_INFINITY;
    for (const event of parseCursorDashboardUsageEvents(body)) {
      oldestMs = Math.min(oldestMs, event.timestampMs);
      // Pages are offsets into a live list; a new event shifts the next page onto a repeat.
      const key = cursorDashboardEventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
    if (list.length < pageSize || oldestMs < args.startMs) break;
  }
  return { ok: true, events };
}

/**
 * The events that belong to one ADE turn: same agent id, no older than the
 * turn start minus a clock-skew allowance, and not already reconciled. Oldest
 * first, one event per key.
 */
export function selectCursorTurnEvents(
  events: readonly CursorDashboardUsageEvent[],
  args: { agentId: string; turnStartedAtMs: number; seenKeys?: ReadonlySet<string>; skewMs?: number },
): CursorDashboardUsageEvent[] {
  const agentId = args.agentId.trim();
  if (!agentId) return [];
  const skewMs = args.skewMs != null && Number.isFinite(args.skewMs) ? Math.max(0, args.skewMs) : CURSOR_TURN_START_SKEW_MS;
  const earliestMs = args.turnStartedAtMs - skewMs;
  const picked = new Map<string, CursorDashboardUsageEvent>();
  for (const event of events) {
    if (event.conversationId !== agentId || event.timestampMs < earliestMs) continue;
    const key = cursorDashboardEventKey(event);
    if (args.seenKeys?.has(key) || picked.has(key)) continue;
    picked.set(key, event);
  }
  return [...picked.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

/**
 * Sums one turn's events. The served model is the one that billed the most
 * (ties go to the latest event), because an "auto" turn can touch a cheap
 * helper model alongside the model that did the work. Cost and request counts
 * stay null when no event reported them, so "unknown" never reads as "free".
 */
export function summarizeCursorTurnEvents(
  events: readonly CursorDashboardUsageEvent[],
): CursorTurnReconciliation | null {
  if (events.length === 0) return null;
  let served: CursorDashboardUsageEvent | null = null;
  let chargedCents: number | null = null;
  let requests: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let chargeable = false;
  const eventKeys: string[] = [];
  for (const event of events) {
    eventKeys.push(cursorDashboardEventKey(event));
    inputTokens += event.inputTokens;
    outputTokens += event.outputTokens;
    cacheReadTokens += event.cacheReadTokens;
    cacheWriteTokens += event.cacheWriteTokens;
    if (event.chargedCents != null) chargedCents = (chargedCents ?? 0) + event.chargedCents;
    if (event.requestsCosts != null) requests = (requests ?? 0) + event.requestsCosts;
    if (event.isChargeable === true) chargeable = true;
    if (event.model == null) continue;
    if (!served) {
      served = event;
      continue;
    }
    const cost = event.chargedCents ?? Number.NEGATIVE_INFINITY;
    const bestCost = served.chargedCents ?? Number.NEGATIVE_INFINITY;
    if (cost > bestCost || (cost === bestCost && event.timestampMs >= served.timestampMs)) served = event;
  }
  return {
    servedModel: served?.model ?? null,
    costUsd: centsToUsd(chargedCents),
    requests: requests == null ? null : roundTo(requests, 4),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    eventKeys,
    chargeable,
  };
}

/**
 * Whether ADE may read Cursor's dashboard usage. On by default. The endpoint
 * is private and can change without notice, so a shape change must fail closed
 * (no turn amendment) and show up in logs as `bad_body`;
 * `ADE_CURSOR_DASHBOARD_USAGE=0|false|off|no` turns the whole read off.
 */
export function cursorDashboardUsageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isEnvFlagOff(env.ADE_CURSOR_DASHBOARD_USAGE);
}
