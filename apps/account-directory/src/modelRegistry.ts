import { authenticate, type CallerTokenEnv } from "./callerToken";
import { logModelRegistryRefresh, logModelRegistryRequest } from "./logging";
import {
  MODEL_REGISTRY_AA_ATTRIBUTION,
  MODEL_REGISTRY_PATH,
  MODEL_REGISTRY_PRICE_CHANNELS,
  MODEL_REGISTRY_SCHEMA_VERSION,
  type ModelRegistryAgentRow,
  type ModelRegistryModel,
  type ModelRegistryPrice,
  type ModelRegistrySnapshot,
  type ModelRegistrySourceStatus,
} from "./modelRegistryContract";
import { sha256Hex } from "./sinkUtils";

/**
 * The model registry: one snapshot a day of what each model scores, costs and
 * how fast it runs, served to signed-in ADE machines at `GET /router/registry`
 * for the model router.
 *
 * Two public sources, read by the minute cron at most once a day:
 *
 * - Artificial Analysis. Any `/models/<slug>` page embeds every model record
 *   (about 684) in its React Server Components payload, and
 *   `/agents/coding-agents` embeds the Coding Agent Index rows. Two page
 *   fetches per refresh, never more. There is no API for this data; the
 *   parser reads the page's own payload, so a redesign of the site can break
 *   it. A broken parse is caught by the count checks below, never stored.
 * - models.dev `api.json`: per-token prices for each channel ADE bills
 *   through.
 *
 * Failure isolation: a source that fails (HTTP error, too few records, a shape
 * the parser does not know) keeps the previous snapshot's data for that
 * source, and the snapshot records `ok: false` with the reason. A snapshot
 * with no models is never stored. The newest seven snapshots are kept.
 *
 * `MODEL_REGISTRY_REFRESH=0` stops every fetch at once; serving goes on from
 * the stored snapshots. See README, "Model registry".
 */

export type ModelRegistryEnv = CallerTokenEnv & {
  /** Optional in the type so a Worker without the binding answers 503 instead of throwing. */
  DB?: D1Database;
  /** `0` stops the daily refresh (no fetches at all). Anything else, or unset, refreshes. */
  MODEL_REGISTRY_REFRESH?: string;
};

export { MODEL_REGISTRY_PATH };

export const MODEL_REGISTRY_ERRORS = {
  unavailable: "model_registry_unavailable",
  methodNotAllowed: "model_registry_method_not_allowed",
} as const;

/** The model page the refresh reads. Any `/models/<slug>` page carries every record. */
export const AA_MODELS_URL = "https://artificialanalysis.ai/models/gpt-6-luna";
export const AA_CODING_AGENTS_URL = "https://artificialanalysis.ai/agents/coding-agents";
export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODEL_REGISTRY_USER_AGENT = "ADE model registry (+https://ade-app.dev)";

/** A model page that yields fewer records than this is a broken parse, not a smaller catalog. */
export const MIN_AA_MODELS = 100;
/** Snapshots kept; older ones are deleted in the same batch as the insert. */
export const MODEL_REGISTRY_KEEP_SNAPSHOTS = 7;
/** A refresh runs when the newest snapshot is at least this old. */
export const MODEL_REGISTRY_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
/** After a refresh that stored nothing, the next attempt waits this long. */
export const MODEL_REGISTRY_RETRY_AFTER_MS = 10 * 60_000;
/**
 * How long a claim holds the refresh. It outlives any refresh (fetches time
 * out at `FETCH_TIMEOUT_MS` each), so an isolate that dies mid-run frees the
 * claim on its own and no two ticks ever refresh at once.
 */
export const MODEL_REGISTRY_CLAIM_TTL_MS = 15 * 60_000;
/**
 * D1 caps a row (and a single string value) at 2 MB. The real snapshot is
 * about 0.52 MB (2026-09-29). A body past this is refused, so a runaway source
 * can never make the insert fail, and the previous snapshot keeps serving.
 */
export const MAX_MODEL_REGISTRY_BODY_BYTES = 1_900_000;

const FETCH_TIMEOUT_MS = 60_000;
const encoder = new TextEncoder();

export function isModelRegistryRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === MODEL_REGISTRY_PATH;
}

// ---------------------------------------------------------------------------
// Artificial Analysis page parsing
// ---------------------------------------------------------------------------

const RSC_CHUNK_START = 'self.__next_f.push([1,"';

/**
 * The page's React Server Components payload as one string.
 *
 * Next.js writes the payload as `self.__next_f.push([1,"..."])` script chunks,
 * each a JSON-escaped string literal. A record can straddle two chunks, so the
 * chunks are decoded one by one and joined before anything is searched.
 * `JSON.parse` of the quoted literal is the exact inverse of how the server
 * wrote it, raw non-ASCII included (a byte-level `unicode_escape` decode
 * mangles UTF-8). A chunk that does not decode is dropped; the count checks
 * catch a page where that mattered.
 */
export function readRscPayload(html: string): string {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const start = html.indexOf(RSC_CHUNK_START, from);
    if (start < 0) break;
    const bodyStart = start + RSC_CHUNK_START.length;
    let end = bodyStart;
    while (end < html.length) {
      const char = html.charCodeAt(end);
      if (char === 92 /* \ */) end += 2;
      else if (char === 34 /* " */) break;
      else end += 1;
    }
    try {
      parts.push(JSON.parse(`"${html.slice(bodyStart, end)}"`) as string);
    } catch {
      // Dropped; see above.
    }
    from = end + 1;
  }
  return parts.join("");
}

/**
 * The JSON value that starts at `start`, found by bracket depth outside
 * strings. Null when it never closes.
 */
function balancedJson(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (inString) {
      if (char === 92 /* \ */) index += 1;
      else if (char === 34 /* " */) inString = false;
    } else if (char === 34) {
      inString = true;
    } else if (char === 123 /* { */ || char === 91 /* [ */) {
      depth += 1;
    } else if (char === 125 /* } */ || char === 93 /* ] */) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every object that starts with `startPattern` and has `requiredKey` as its
 * own key, deduplicated on `id`. The payload repeats a record where more than
 * one component uses it, sometimes with nested objects replaced by `$`
 * references, so the longest copy wins.
 */
function extractObjects(payload: string, startPattern: RegExp, requiredKey: string): JsonObject[] {
  const byId = new Map<string, { text: string; value: JsonObject }>();
  const pattern = new RegExp(startPattern.source, "g");
  for (let match = pattern.exec(payload); match; match = pattern.exec(payload)) {
    const text = balancedJson(payload, match.index);
    if (!text) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    // Own key, not a substring: an outer object that merely CONTAINS a record
    // (a host row carrying its model) must not be read as one.
    if (!isObject(value) || !(requiredKey in value) || typeof value.id !== "string") continue;
    const previous = byId.get(value.id);
    if (!previous || text.length > previous.text.length) byId.set(value.id, { text, value });
  }
  return [...byId.values()].map((entry) => entry.value);
}

/** A finite number, else null. The payload writes absent values as `"$undefined"` or null. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value && !value.startsWith("$") ? value : null;
}

function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function aaModel(record: JsonObject): ModelRegistryModel | null {
  const slug = str(record.slug);
  const name = str(record.name);
  if (!slug || !name) return null;
  return {
    slug,
    releaseSlug: str(field(record.release, "slug")) ?? slug,
    name,
    shortName: str(record.shortName),
    creator: str(field(record.creator, "name")),
    releaseDate: str(record.releaseDate),
    deprecated: record.deprecated === true,
    effort: str(field(record.effort, "slug")),
    reasoning: record.isReasoning === true,
    openWeights: record.isOpenWeights === true,
    contextWindow: num(record.contextWindowTokens),
    intelligenceIndex: num(record.intelligenceIndex),
    intelligenceIndexEstimated: record.intelligenceIndexIsEstimated === true,
    terminalBench40: num(record.terminalBench40),
    sciCode: num(record.scicode),
    longContextReasoning: num(record.lcr),
    humanitysLastExam: num(record.hle),
    gpqa: num(record.gpqa),
    ifBench: num(record.ifbench),
    costPerIndexTaskUsd: num(field(field(record.intelligenceIndexCostPerTask, "cost"), "total")),
    secondsPerIndexTask: num(record.intelligenceIndexTimePerTask),
    outputTokensPerSecond: num(field(record.timescaleData, "medianOutputSpeed")),
    // Seconds, on AA's "long" prompt workload, to the first streamed chunk.
    // For a reasoning model that does not stream its thinking, that includes
    // the whole hidden reasoning time: Claude Opus 5.5 at max effort reads
    // about 692 s here while Sonnet 5.5 at low reads about 1 s, and
    // `timeToFirstAnswerToken.input` carries the same number with
    // `.reasoning` at 0. Read it as "seconds until the user sees output".
    timeToFirstTokenSeconds: num(field(record.timescaleData, "medianTimeToFirstChunk")),
    price: {
      input: num(record.price1mInputTokens),
      output: num(record.price1mOutputTokens),
      cacheRead: num(record.cacheHitPrice),
      cacheWrite: num(record.cacheWritePrice),
    },
  };
}

const AA_MODEL_START = /\{"id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}","slug":"/;
const AA_AGENT_START = /\{"id":"[0-9a-f]{32}","isDefault":/;

/** Every model variant on an Artificial Analysis model page, sorted by slug. */
export function parseArtificialAnalysisModels(html: string): ModelRegistryModel[] {
  return extractObjects(readRscPayload(html), AA_MODEL_START, "intelligenceIndexIsEstimated")
    .map(aaModel)
    .filter((model): model is ModelRegistryModel => model !== null)
    .sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
}

function matchKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Name → slug over every record's `shortName` and `name`. A key two records
 * share maps to null: an ambiguous name is never guessed.
 */
function modelNameIndex(models: ModelRegistryModel[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const model of models) {
    for (const label of [model.shortName, model.name]) {
      if (!label) continue;
      const key = matchKey(label);
      if (!key) continue;
      const existing = index.get(key);
      if (existing === undefined) index.set(key, model.slug);
      else if (existing !== model.slug) index.set(key, null);
    }
  }
  return index;
}

/**
 * The variant an agent row ran, or null.
 *
 * The row's model label and the model records name the same variant
 * differently: `Sonnet 5.5 (max)` against `Claude Sonnet 5.5 (max with
 * fallback)`, `GLM-5.3 ({'reasoning_effort': 'max'})` against `GLM-5.3 (max)`.
 * The label is normalized, then matched exactly (letters and digits only)
 * against each record's short and long name, with and without a `Claude `
 * prefix and a ` with fallback` effort suffix. Failing that, the row's own
 * `hostModelSlug` (`zai_glm-5-3`) names a record exactly once the host prefix
 * is dropped. Anything else is null.
 */
function agentModelSlug(
  modelLabel: string,
  hostModelSlug: string | null,
  index: Map<string, string | null>,
  slugs: Set<string>,
): string | null {
  // The effort dict repeats an effort the label may already name
  // (`GPT-6 Luna (max) ({'reasoning_effort': 'max'})`); it only stands in for
  // one when the label has none (`GLM-5.3 ({...})`).
  const label = modelLabel
    .replace(/\s*\(\{[^)]*?:\s*'([^']+)'\s*\}\)/g, (_match, effort: string, offset: number, whole: string) =>
      /\)\s*$/.test(whole.slice(0, offset)) ? "" : ` (${effort})`)
    .replace(/\s*\(with fallback\)/gi, "")
    .trim();
  const candidates: string[] = [];
  for (const base of [label, `Claude ${label}`]) {
    candidates.push(base, base.replace(/\(([^()]+)\)\s*$/, "($1 with fallback)"));
  }
  for (const candidate of candidates) {
    const slug = index.get(matchKey(candidate));
    if (slug) return slug;
  }
  const hostSlug = hostModelSlug?.includes("_") ? hostModelSlug.slice(hostModelSlug.indexOf("_") + 1) : null;
  return hostSlug && slugs.has(hostSlug) ? hostSlug : null;
}

function aaAgentRow(
  row: JsonObject,
  index: Map<string, string | null>,
  slugs: Set<string>,
): ModelRegistryAgentRow | null {
  const id = str(row.id);
  const agent = str(field(row.display, "agent")) ?? str(row.agentName);
  const label = str(row.displayLabel);
  if (!id || !agent || !label) return null;
  // `displayLabel` is "<agent> - <model>" and keeps the effort dict that
  // `display.model` sometimes drops; prefer it for the model half.
  const prefix = `${agent} - `;
  const modelLabel = label.startsWith(prefix) ? label.slice(prefix.length) : str(field(row.display, "model")) ?? label;
  const pair = /\s\+\s/.test(modelLabel);
  const mean = field(row, "mean");
  const wallSeconds = num(field(mean, "agentWallTimeSec"));
  return {
    id,
    agent,
    label,
    modelSlug: pair ? null : agentModelSlug(modelLabel, str(row.hostModelSlug), index, slugs),
    pair,
    score: num(field(mean, "reward")) ?? num(row.indexScore),
    evals: (Array.isArray(row.evals) ? row.evals : [])
      .filter(isObject)
      .map((entry) => ({ name: str(entry.datasetIndexName) ?? "", score: num(field(entry.mean, "reward")) }))
      .filter((entry) => entry.name),
    costUsdPerTask: num(field(mean, "costUsd")),
    minutesPerTask: wallSeconds === null ? null : wallSeconds / 60,
    stepsPerTask: num(field(mean, "steps")),
    cacheHitRate: num(field(mean, "cacheHitRate")),
    tokensPerTask: num(field(mean, "totalTokens")),
  };
}

/**
 * Every Coding Agent Index row on the coding-agents page, each mapped to the
 * model variant it ran when the name says so exactly (see `agentModelSlug`).
 * Sorted by score, best first, then id.
 */
export function parseArtificialAnalysisAgents(html: string, models: ModelRegistryModel[]): ModelRegistryAgentRow[] {
  const index = modelNameIndex(models);
  const slugs = new Set(models.map((model) => model.slug));
  return extractObjects(readRscPayload(html), AA_AGENT_START, "agentName")
    .map((row) => aaAgentRow(row, index, slugs))
    .filter((row): row is ModelRegistryAgentRow => row !== null)
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1) || (left.id < right.id ? -1 : 1));
}

// ---------------------------------------------------------------------------
// models.dev prices
// ---------------------------------------------------------------------------

function modelsDevPrice(cost: JsonObject): ModelRegistryPrice {
  const price: ModelRegistryPrice = {
    input: num(cost.input),
    output: num(cost.output),
    cacheRead: num(cost.cache_read),
    cacheWrite: num(cost.cache_write),
  };
  // `context_over_200k` is models.dev's older spelling of the first context
  // tier and repeats it; only `tiers` is read.
  const tiers = (Array.isArray(cost.tiers) ? cost.tiers : [])
    .filter(isObject)
    .filter((tier) => field(tier.tier, "type") === "context" && num(field(tier.tier, "size")) !== null)
    .map((tier) => ({
      aboveContextTokens: num(field(tier.tier, "size"))!,
      input: num(tier.input),
      output: num(tier.output),
      cacheRead: num(tier.cache_read),
      cacheWrite: num(tier.cache_write),
    }))
    .sort((left, right) => left.aboveContextTokens - right.aboveContextTokens);
  if (tiers.length) price.tiers = tiers;
  return price;
}

/**
 * Prices by channel, then by the channel's own model id, for every channel in
 * `MODEL_REGISTRY_PRICE_CHANNELS` that models.dev lists. A channel models.dev
 * dropped is absent from the result; the caller keeps its previous prices.
 */
export function parseModelsDevPrices(apiJson: unknown): Record<string, Record<string, ModelRegistryPrice>> {
  const prices: Record<string, Record<string, ModelRegistryPrice>> = {};
  if (!isObject(apiJson)) return prices;
  for (const channel of MODEL_REGISTRY_PRICE_CHANNELS) {
    const models = field(apiJson[channel], "models");
    if (!isObject(models)) continue;
    const channelPrices: Record<string, ModelRegistryPrice> = {};
    for (const id of Object.keys(models).sort()) {
      const cost = field(models[id], "cost");
      if (isObject(cost)) channelPrices[id] = modelsDevPrice(cost);
    }
    if (Object.keys(channelPrices).length) prices[channel] = channelPrices;
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export type ModelRegistryRefreshOptions = {
  now?: () => number;
  fetchImpl?: typeof fetch;
};

export type ModelRegistryRefreshResult =
  | { stored: true; bytes: number; models: number; agents: number; sources: ModelRegistrySnapshot["sources"] }
  | { stored: false; reason: string; sources?: ModelRegistrySnapshot["sources"] };

class SourceError extends Error {}

async function fetchText(fetchImpl: typeof fetch, url: string, accept: string): Promise<string> {
  // No `redirect: "error"`: the Workers runtime throws on it.
  const response = await fetchImpl(url, {
    headers: { "user-agent": MODEL_REGISTRY_USER_AGENT, accept },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceError(`http_${response.status}`);
  }
  return response.text();
}

function errorText(error: unknown): string {
  const text = error instanceof SourceError
    ? error.message
    : error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  return text.slice(0, 200);
}

async function readNewestSnapshot(db: D1Database): Promise<ModelRegistrySnapshot | null> {
  const row = await db
    .prepare("select body from model_registry_snapshots order by id desc limit 1")
    .first<{ body: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.body) as ModelRegistrySnapshot;
    return parsed.schemaVersion === MODEL_REGISTRY_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function failedStatus(previous: ModelRegistrySourceStatus | undefined, error: unknown): ModelRegistrySourceStatus {
  // `fetchedAt` stays the age of the data actually served.
  return { fetchedAt: previous?.fetchedAt ?? null, ok: false, error: errorText(error) };
}

/**
 * Builds a new snapshot from both sources and stores it. No gating here: the
 * cron calls `runModelRegistryCron`, which decides whether a refresh is due
 * and holds the claim.
 *
 * Stores nothing, and says why, when the result would have no models: the
 * previous snapshot keeps serving instead.
 */
export async function refreshModelRegistry(
  env: ModelRegistryEnv,
  options: ModelRegistryRefreshOptions = {},
): Promise<ModelRegistryRefreshResult> {
  const db = env.DB;
  if (!db) return { stored: false, reason: "no_database" };
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const previous = await readNewestSnapshot(db);

  let models = previous?.models ?? [];
  let agents = previous?.agents ?? [];
  let artificialAnalysis: ModelRegistrySourceStatus;
  try {
    const parsed = parseArtificialAnalysisModels(await fetchText(fetchImpl, AA_MODELS_URL, "text/html"));
    if (parsed.length < MIN_AA_MODELS) throw new SourceError(`models_too_few:${parsed.length}`);
    models = parsed;
    const fetchedAt = new Date(now()).toISOString();
    // The agents page is the second half of the same source. When only it
    // fails, the new models are kept and the previous rows stay.
    try {
      const parsedAgents = parseArtificialAnalysisAgents(
        await fetchText(fetchImpl, AA_CODING_AGENTS_URL, "text/html"),
        models,
      );
      if (!parsedAgents.length) throw new SourceError("agents_none");
      agents = parsedAgents;
      artificialAnalysis = { fetchedAt, ok: true };
    } catch (error) {
      artificialAnalysis = { fetchedAt, ok: false, error: `agents: ${errorText(error)}` };
    }
  } catch (error) {
    artificialAnalysis = failedStatus(previous?.sources.artificialAnalysis, error);
  }

  let prices = previous?.prices ?? {};
  let modelsDev: ModelRegistrySourceStatus;
  try {
    const parsed = parseModelsDevPrices(JSON.parse(await fetchText(fetchImpl, MODELS_DEV_URL, "application/json")));
    if (!Object.keys(parsed).length) throw new SourceError("prices_none");
    // A channel models.dev stopped listing keeps its previous prices.
    prices = { ...prices, ...parsed };
    modelsDev = { fetchedAt: new Date(now()).toISOString(), ok: true };
  } catch (error) {
    modelsDev = failedStatus(previous?.sources.modelsDev, error);
  }

  const sources = { artificialAnalysis, modelsDev };
  if (!models.length) return { stored: false, reason: "no_models", sources };
  if (!artificialAnalysis.ok && !modelsDev.ok) return { stored: false, reason: "all_sources_failed", sources };

  const generatedAtMs = now();
  const snapshot: ModelRegistrySnapshot = {
    schemaVersion: MODEL_REGISTRY_SCHEMA_VERSION,
    generatedAt: new Date(generatedAtMs).toISOString(),
    attribution: MODEL_REGISTRY_AA_ATTRIBUTION,
    sources,
    models,
    agents,
    prices,
  };
  const body = JSON.stringify(snapshot);
  const bytes = encoder.encode(body).byteLength;
  if (bytes > MAX_MODEL_REGISTRY_BODY_BYTES) return { stored: false, reason: `too_large:${bytes}`, sources };
  const etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
  // One batch: the insert and the pruning land together or not at all.
  await db.batch([
    db.prepare("insert into model_registry_snapshots (generated_at, body, bytes, etag) values (?, ?, ?, ?)")
      .bind(generatedAtMs, body, bytes, etag),
    db.prepare(
      "delete from model_registry_snapshots where id not in (select id from model_registry_snapshots order by id desc limit ?)",
    ).bind(MODEL_REGISTRY_KEEP_SNAPSHOTS),
  ]);
  return { stored: true, bytes, models: models.length, agents: agents.length, sources };
}

export type ModelRegistryCronResult =
  | { ran: false; reason: "disabled" | "no_database" | "fresh" | "claimed" }
  | { ran: true; result: ModelRegistryRefreshResult };

/**
 * The cron's entry point, called every minute. Refreshes only when the newest
 * snapshot is a day old, never while another tick holds the claim, and not
 * again for `MODEL_REGISTRY_RETRY_AFTER_MS` after a refresh that stored
 * nothing. A tick that has nothing to do costs one indexed read.
 *
 * The claim row doubles as the retry wait: a failed refresh leaves its claim
 * in place until the wait is over, a stored one releases it at once.
 */
export async function runModelRegistryCron(
  env: ModelRegistryEnv,
  options: ModelRegistryRefreshOptions = {},
): Promise<ModelRegistryCronResult> {
  if (env.MODEL_REGISTRY_REFRESH?.trim() === "0") return { ran: false, reason: "disabled" };
  const db = env.DB;
  if (!db) return { ran: false, reason: "no_database" };
  const now = options.now ?? Date.now;
  const nowMs = now();
  const newest = await db
    .prepare("select generated_at from model_registry_snapshots order by id desc limit 1")
    .first<{ generated_at: number }>();
  if (newest && nowMs - Number(newest.generated_at) < MODEL_REGISTRY_REFRESH_INTERVAL_MS) {
    return { ran: false, reason: "fresh" };
  }
  // Check and take in one statement: the upsert only overwrites a claim that
  // has run out, so of two ticks racing here exactly one sees a change.
  const claim = await db
    .prepare(
      "insert into model_registry_refresh_claim (id, claimed_at, expires_at) values (1, ?, ?) "
        + "on conflict (id) do update set claimed_at = excluded.claimed_at, expires_at = excluded.expires_at "
        + "where model_registry_refresh_claim.expires_at <= ?",
    )
    .bind(nowMs, nowMs + MODEL_REGISTRY_CLAIM_TTL_MS, nowMs)
    .run();
  if (!claim.meta.changes) return { ran: false, reason: "claimed" };

  const startedAt = Date.now();
  let result: ModelRegistryRefreshResult;
  try {
    result = await refreshModelRegistry(env, options);
  } catch (error) {
    result = { stored: false, reason: `error: ${errorText(error)}` };
  }
  // Release, or hold until the retry wait is over. Only this tick's claim.
  await db
    .prepare("update model_registry_refresh_claim set expires_at = ? where id = 1 and claimed_at = ?")
    .bind(result.stored ? now() : now() + MODEL_REGISTRY_RETRY_AFTER_MS, nowMs)
    .run();
  logModelRegistryRefresh({
    stored: result.stored,
    reason: result.stored ? undefined : result.reason,
    bytes: result.stored ? result.bytes : 0,
    models: result.stored ? result.models : 0,
    agents: result.stored ? result.agents : 0,
    artificialAnalysisError: result.sources?.artificialAnalysis.error,
    modelsDevError: result.sources?.modelsDev.error,
    durationMs: Date.now() - startedAt,
  });
  return { ran: true, result };
}

// ---------------------------------------------------------------------------
// GET /router/registry
// ---------------------------------------------------------------------------

const CACHE_CONTROL = "private, max-age=3600";

function json(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** True when `If-None-Match` names `etag` (weak or strong) or is `*`. */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

/**
 * `GET`/`HEAD /router/registry`: the newest snapshot, for a signed-in account.
 *
 * - `401 {error: <reason>}` without a valid account bearer; `503` when this
 *   Worker cannot verify tokens at all (same split as the account routes).
 * - `200` with the snapshot, an `ETag` and `Cache-Control: private,
 *   max-age=3600`; `304` when `If-None-Match` names the current ETag. A 304
 *   reads only the ETag, never the body.
 * - `503 model_registry_unavailable` before the first snapshot exists, with no
 *   D1 binding, or when D1 refuses the read.
 * - `405` for any other method.
 *
 * No CORS headers: only the ADE brain calls this, never a browser.
 */
export async function handleModelRegistryRequest(request: Request, env: ModelRegistryEnv): Promise<Response> {
  const startedAt = performance.now();
  const finish = (response: Response, reason?: string): Response => {
    logModelRegistryRequest({
      method: request.method,
      status: response.status,
      reason,
      durationMs: performance.now() - startedAt,
    });
    return response;
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    return finish(json({ error: MODEL_REGISTRY_ERRORS.methodNotAllowed }, 405, { allow: "GET, HEAD" }), "method_not_allowed");
  }
  const authentication = await authenticate(request, env);
  if (!authentication.ok) {
    const status = authentication.reason === "authentication unavailable" ? 503 : 401;
    return finish(json({ error: authentication.reason }, status), authentication.reason);
  }
  const db = env.DB;
  if (!db) return finish(json({ error: MODEL_REGISTRY_ERRORS.unavailable }, 503), "no_database");
  try {
    const newest = await db
      .prepare("select id, etag from model_registry_snapshots order by id desc limit 1")
      .first<{ id: number; etag: string }>();
    if (!newest) return finish(json({ error: MODEL_REGISTRY_ERRORS.unavailable }, 503), "no_snapshot");
    const headers = { etag: newest.etag, "cache-control": CACHE_CONTROL };
    if (matchesEtag(request.headers.get("if-none-match"), newest.etag)) {
      return finish(new Response(null, { status: 304, headers }));
    }
    if (request.method === "HEAD") {
      return finish(new Response(null, { status: 200, headers: { "content-type": "application/json", ...headers } }));
    }
    const row = await db
      .prepare("select body from model_registry_snapshots where id = ?")
      .bind(newest.id)
      .first<{ body: string }>();
    // Pruned between the two reads: the next request sees the newer row.
    if (!row) return finish(json({ error: MODEL_REGISTRY_ERRORS.unavailable }, 503), "no_snapshot");
    return finish(new Response(row.body, { status: 200, headers: { "content-type": "application/json", ...headers } }));
  } catch {
    return finish(json({ error: MODEL_REGISTRY_ERRORS.unavailable }, 503), "database_error");
  }
}
