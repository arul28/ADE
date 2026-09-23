import fs from "node:fs";
import path from "node:path";
import { isLocalProviderFamily, openCodeRegistryIdFor } from "../../../shared/modelRegistry";
import { urlOriginOnly } from "../../../shared/remoteLoopbackUrl";
import type { AgentChatEvent, AgentChatUsageAccount } from "../../../shared/types/chat";
import { openReadOnlyDatabase } from "../projects/readOnlySqlite";
import { openCodeDataDirs } from "../shared/providerConfigHomes";
import { asRecord, evictOldestEntries, finiteNumberOrNull, positiveCountOrZero } from "../shared/utils";
import { contextPercentage, liveContextUsageEvent } from "./liveContextUsageEvent";

/**
 * Turn telemetry for OpenCode chats.
 *
 * OpenCode reports usage once per model request, as a `step-finish` part
 * (`{ cost, tokens: { input, output, reasoning, cache: { read, write } } }`).
 * `input` is the UNCACHED input; the cached part rides in `cache.read`. A turn
 * with tool calls makes several requests, so the turn total is the sum over
 * every step, while the context the next request starts from is the input side
 * of the LAST step only.
 */

export type OpenCodeStepUsage = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD cost OpenCode billed for the step, or null when the step carried none. */
  cost: number | null;
};

export type OpenCodeTurnUsage = {
  /** Keyed by part id: a re-sent `step-finish` part replaces, never double counts. */
  steps: Map<string, OpenCodeStepUsage>;
  /** The last step that describes the live conversation (not a compaction summary). */
  lastContextStep: OpenCodeStepUsage | null;
};

export type OpenCodeDoneUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  contextWindow?: number;
  contextTokens?: number;
  requestCount: number;
};

/** Reads one `step-finish` part. The SDK declares every field; the wire may omit some. */
export function readOpenCodeStepUsage(part: { tokens?: unknown; cost?: unknown }): OpenCodeStepUsage {
  const tokens = asRecord(part.tokens) ?? {};
  const cache = asRecord(tokens.cache) ?? {};
  return {
    input: positiveCountOrZero(tokens.input),
    output: positiveCountOrZero(tokens.output),
    reasoning: positiveCountOrZero(tokens.reasoning),
    cacheRead: positiveCountOrZero(cache.read),
    cacheWrite: positiveCountOrZero(cache.write),
    cost: finiteNumberOrNull(part.cost),
  };
}

export function createOpenCodeTurnUsage(): OpenCodeTurnUsage {
  return { steps: new Map(), lastContextStep: null };
}

/** Context occupancy a step leaves behind: uncached input + cache read + cache write. */
export function openCodeStepContextTokens(step: OpenCodeStepUsage): number {
  return step.input + step.cacheRead + step.cacheWrite;
}

/**
 * Records one parent-session `step-finish` part. A compaction summary step is
 * a real request (it counts toward the totals and the cost) but its input is
 * the conversation being replaced, so it never becomes the context figure.
 */
export function recordOpenCodeStepFinish(
  turn: OpenCodeTurnUsage,
  partId: string,
  part: { tokens?: unknown; cost?: unknown },
  options: { describesContext: boolean },
): OpenCodeStepUsage {
  const step = readOpenCodeStepUsage(part);
  turn.steps.set(partId, step);
  if (options.describesContext) turn.lastContextStep = step;
  return step;
}

/**
 * The done-event usage and provider cost for a finished turn, or null when no
 * step reported anything. Token fields are turn totals; `contextTokens` is the
 * last context step's input side.
 */
export function buildOpenCodeDoneUsage(
  turn: OpenCodeTurnUsage,
  contextWindow: number | null | undefined,
): { usage: OpenCodeDoneUsage; costUsd?: number; costSource?: "provider" } | null {
  if (turn.steps.size === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  let costReported = false;
  for (const step of turn.steps.values()) {
    inputTokens += step.input;
    outputTokens += step.output;
    cacheReadTokens += step.cacheRead;
    cacheCreationTokens += step.cacheWrite;
    reasoningTokens += step.reasoning;
    if (step.cost != null) {
      costUsd += step.cost;
      costReported = true;
    }
  }
  const window = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : undefined;
  return {
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningTokens,
      ...(window ? { contextWindow: window } : {}),
      ...(turn.lastContextStep ? { contextTokens: openCodeStepContextTokens(turn.lastContextStep) } : {}),
      requestCount: turn.steps.size,
    },
    ...(costReported ? { costUsd, costSource: "provider" as const } : {}),
  };
}

/**
 * The composer meter's live sample after one step, in the same shape Claude's
 * automatic snapshots use. Null when the model's context window is unknown: a
 * percentage of nothing would read as an empty meter.
 */
export function buildOpenCodeLiveContextUsage(
  step: OpenCodeStepUsage,
  maxTokens: number | null | undefined,
  model: string | undefined,
  turnId?: string,
): Extract<AgentChatEvent, { type: "context_usage" }> | null {
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) return null;
  const category = (name: string, tokens: number) => ({
    name,
    tokens,
    percentage: contextPercentage(tokens, maxTokens),
  });
  return liveContextUsageEvent({
    used: openCodeStepContextTokens(step),
    max: maxTokens,
    rawMaxTokens: maxTokens,
    model,
    turnId,
    state: "measured",
    categories: [
      category("Input", step.input),
      category("Cache read", step.cacheRead),
      category("Cache creation", step.cacheWrite),
    ].filter((entry) => entry.tokens > 0),
    breakdown: {
      inputTokens: step.input,
      cacheReadTokens: step.cacheRead,
      cacheCreationTokens: step.cacheWrite,
    },
  });
}

/**
 * The model that answered, when it is not the one ADE asked for (a
 * provider-side fallback or an `auto` pick). Both sides take the registry id a
 * picker row gets (`opencode/<provider>/<encoded model>`), so an OpenRouter
 * `anthropic/claude-opus-4.7` compares in one form with the chat's model id.
 */
export function resolveOpenCodeServedModel(
  requested: { providerID: string; modelID: string },
  served: { providerID?: string | null; modelID?: string | null } | null,
): string | null {
  const providerID = served?.providerID?.trim();
  const modelID = served?.modelID?.trim();
  if (!providerID || !modelID) return null;
  const servedId = openCodeRegistryIdFor(providerID, modelID);
  return servedId === openCodeRegistryIdFor(requested.providerID, requested.modelID) ? null : servedId;
}

// ── Who paid for the turn ─────────────────────────────────────────────────

/** Only the non-secret fields of one `auth.json` entry. */
export type OpenCodeAuthEntry = { type: string | null; accountId: string | null };

const OPENCODE_PLAN_PROVIDERS = new Set(["opencode", "opencode-go"]);

/**
 * Maps OpenCode's credential for the upstream provider to an account. Local
 * servers are free and named by endpoint; OpenCode Zen/Go are OpenCode's own
 * plans; everything else is whatever `auth.json` says the credential is.
 * A provider with no entry (a key from the environment or config) is `unknown`.
 */
export function resolveOpenCodeUsageAccount(args: {
  providerID: string;
  auth: OpenCodeAuthEntry | null;
  localEndpoint?: string | null;
  planEmail?: string | null;
}): AgentChatUsageAccount {
  const upstream = args.providerID;
  if (isLocalProviderFamily(upstream)) {
    // Only the origin rides on a done event: a user-typed endpoint can carry
    // `user:pass@`, a path, or a query token. A LAN host stays named, since a
    // local-family server need not run on this machine.
    const endpoint = urlOriginOnly(args.localEndpoint);
    return {
      provider: "opencode",
      kind: "local",
      upstream,
      ...(endpoint ? { endpoint } : {}),
    };
  }
  if (OPENCODE_PLAN_PROVIDERS.has(upstream)) {
    return {
      provider: "opencode",
      kind: "subscription",
      upstream,
      ...(args.planEmail ? { email: args.planEmail } : {}),
    };
  }
  const type = args.auth?.type?.toLowerCase() ?? null;
  const kind = type === "api" ? "api_key" : type === "oauth" ? "subscription" : "unknown";
  return {
    provider: "opencode",
    kind,
    upstream,
    ...(kind === "subscription" && args.auth?.accountId ? { accountId: args.auth.accountId } : {}),
  };
}

/**
 * Parses `auth.json` keeping only `type` and `accountId` per provider. Token
 * fields are never copied out of the parsed object.
 */
export function parseOpenCodeAuthEntries(raw: string): Map<string, OpenCodeAuthEntry> {
  const entries = new Map<string, OpenCodeAuthEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return entries;
  }
  const record = asRecord(parsed);
  if (!record) return entries;
  for (const [providerID, value] of Object.entries(record)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const type = typeof entry.type === "string" && entry.type.trim() ? entry.type.trim() : null;
    const accountId = typeof entry.accountId === "string" && entry.accountId.trim() ? entry.accountId.trim() : null;
    entries.set(providerID, { type, accountId });
  }
  return entries;
}

/**
 * Email of the OpenCode Zen/Go account, from the tiny `account` table. The
 * database itself can be tens of gigabytes, so this touches nothing else and
 * never selects a token column.
 */
export function readOpenCodePlanEmail(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: ReturnType<typeof openReadOnlyDatabase> | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    // A running OpenCode may hold a write lock; answer "no email" at once
    // rather than wait on it (the answer is cached for minutes either way).
    db.exec("PRAGMA busy_timeout = 0");
    const row = db.prepare(`
      SELECT a.email AS email
        FROM account a
        LEFT JOIN account_state s ON s.active_account_id = a.id
       ORDER BY (s.active_account_id IS NOT NULL) DESC, a.time_updated DESC
       LIMIT 1
    `).get() as { email?: unknown } | undefined;
    const email = typeof row?.email === "string" ? row.email.trim() : "";
    return email || null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle cannot lose anything.
    }
  }
}

const OPENCODE_ACCOUNT_CACHE_TTL_MS = 5 * 60_000;
/** A local endpoint is ADE's own setting, so a change shows up sooner. */
const OPENCODE_LOCAL_ENDPOINT_TTL_MS = 60_000;
/** Distinct OpenCode data homes remembered at once (the user's, plus isolated servers). */
const OPENCODE_ACCOUNT_CACHE_MAX_HOMES = 8;

type TimedValue<T> = { at: number; value: T };

/**
 * Per-provider account lookup with a cache, so a turn never re-reads
 * `auth.json`, the database, or ADE's config. A re-login shows up within the
 * TTL.
 *
 * `dataDirs` on a call names the data home of the OpenCode server that ran the
 * turn, for a server launched with its own `XDG_DATA_HOME`; without it the
 * user's own (`openCodeDataDirs()`) is read.
 */
export function createOpenCodeUsageAccountResolver(options: {
  dataDirs?: () => string[];
  /** The endpoint ADE hands OpenCode for a local server (`lmstudio`, `ollama`). */
  localEndpoint?: (providerID: string) => string | null;
  readText?: (filePath: string) => string | null;
  readPlanEmail?: (dbPath: string) => string | null;
  now?: () => number;
} = {}): (args: { providerID: string; dataDirs?: readonly string[] }) => AgentChatUsageAccount {
  const defaultDataDirs = options.dataDirs ?? (() => openCodeDataDirs());
  const readText = options.readText ?? ((filePath: string) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  });
  const readPlanEmail = options.readPlanEmail ?? readOpenCodePlanEmail;
  const now = options.now ?? Date.now;
  const authCache = new Map<string, TimedValue<Map<string, OpenCodeAuthEntry>>>();
  const planEmailCache = new Map<string, TimedValue<string | null>>();
  const endpointCache = new Map<string, TimedValue<string | null>>();

  const cached = <T>(cache: Map<string, TimedValue<T>>, key: string, ttlMs: number, load: () => T): T => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = load();
    cache.delete(key);
    cache.set(key, { at: now(), value });
    evictOldestEntries(cache, OPENCODE_ACCOUNT_CACHE_MAX_HOMES);
    return value;
  };

  const authEntries = (dirs: readonly string[]): Map<string, OpenCodeAuthEntry> =>
    cached(authCache, dirs.join("\0"), OPENCODE_ACCOUNT_CACHE_TTL_MS, () => {
      for (const dir of dirs) {
        const raw = readText(path.join(dir, "auth.json"));
        if (raw != null) return parseOpenCodeAuthEntries(raw);
      }
      return new Map<string, OpenCodeAuthEntry>();
    });

  const planEmail = (dirs: readonly string[]): string | null =>
    cached(planEmailCache, dirs.join("\0"), OPENCODE_ACCOUNT_CACHE_TTL_MS, () => {
      for (const dir of dirs) {
        const email = readPlanEmail(path.join(dir, "opencode.db"));
        if (email) return email;
      }
      return null;
    });

  const localEndpoint = (providerID: string): string | null => {
    const read = options.localEndpoint;
    if (!read) return null;
    return cached(endpointCache, providerID, OPENCODE_LOCAL_ENDPOINT_TTL_MS, () => {
      try {
        return read(providerID);
      } catch {
        return null;
      }
    });
  };

  return ({ providerID, dataDirs }) => {
    if (isLocalProviderFamily(providerID)) {
      return resolveOpenCodeUsageAccount({ providerID, auth: null, localEndpoint: localEndpoint(providerID) });
    }
    const dirs = dataDirs ?? defaultDataDirs();
    if (OPENCODE_PLAN_PROVIDERS.has(providerID)) {
      return resolveOpenCodeUsageAccount({ providerID, auth: null, planEmail: planEmail(dirs) });
    }
    return resolveOpenCodeUsageAccount({ providerID, auth: authEntries(dirs).get(providerID) ?? null });
  };
}
