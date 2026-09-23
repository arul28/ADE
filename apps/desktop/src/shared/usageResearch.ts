/**
 * The daily usage research report: the wire contract between an ADE machine
 * and the account directory Worker's `POST /usage-research/daily`.
 *
 * Each machine sends one compact report for each finished local day, so ADE
 * can learn how to route turns between models: what each provider and model
 * cost, when, on which kind of account, and how fast each subscription window
 * burns. The report holds counts, sums, percentiles, and list prices only. It
 * never holds an email, an account id, a provider instance id, a path, a lane
 * id, a session or turn id, a prompt, a file name, a hostname, or a secret.
 * Accounts are told apart only by `accountRef`, a salted hash whose salt never
 * leaves the machine, so the hash alone does not join refs across installs.
 * Quota readings are account-wide, though: two installs signed in to one
 * account report the same window percentages, which can correlate their refs.
 *
 * The Worker (`apps/account-directory`) keeps its own copy of this contract,
 * because it is a separate deploy unit and must not import from the app.
 * Change one, change both: the Worker's `usageResearchContract.test.ts`
 * imports this file and fails when the two disagree.
 *
 * Deliberately free of Node built-ins, like `diagnosticsUpload.ts`, so any
 * surface can import it.
 *
 * The body has exactly the eight top-level keys of `UsageResearchDailyBody`;
 * the Worker answers 400 to any other key, so a new field goes inside `report`.
 *
 * Responses the client acts on:
 * - 201 `{ "stored": "inserted" }` or 200 `{ "stored": "replaced" }`: stored.
 *   The Worker upserts one row per install and day. An identical repeat costs
 *   the Worker nothing, but the client still never sends a `sent` day again.
 * - 400, 413, or 415: rejected. The client records the day and does not send
 *   it again. (The Worker also answers 400 to a body stream that broke
 *   mid-read, which in practice only a client that went away sees.)
 * - 429 with `error` `usage_research_identity_limit`,
 *   `usage_research_daily_limit`, or `usage_research_storage_full`: the client
 *   stops the run and waits the `retry-after` seconds (to the next UTC
 *   midnight) before it sends again.
 * - 503 `usage_research_unavailable` (no storage, a failed statement, or a
 *   concurrent write to the same install and day won the race), any other
 *   5xx, or a network error: the client tries again next hour.
 * - 409 is never used.
 *
 * The Worker accepts a `day` from the UTC date of (now - 12 h - 8 days) to the
 * UTC date of (now + 14 h), which holds every one of the 7 finished local days
 * in any time zone. There is no CORS: only the brain sends it.
 */

export const USAGE_RESEARCH_SCHEMA_VERSION = 1 as const;
export const USAGE_RESEARCH_DAILY_PATH = "/usage-research/daily";

/** The most bytes one serialized request body can have (the whole body, UTF-8). */
export const MAX_USAGE_RESEARCH_BODY_BYTES = 32 * 1024;
/** The most groups one report holds. Groups past the cap merge into one `_other` group. */
export const MAX_USAGE_RESEARCH_GROUPS = 150;
/** A report covers one of the last this-many finished local days; today is never sent. */
export const USAGE_RESEARCH_MAX_DAYS_BACK = 7;
/** The provider of the group that holds every group merged away for size. */
export const USAGE_RESEARCH_OTHER_PROVIDER = "_other";
/** The 429 `error` codes that tell the client to wait `retry-after` seconds. */
export const USAGE_RESEARCH_IDENTITY_LIMIT_ERROR = "usage_research_identity_limit";
export const USAGE_RESEARCH_DAILY_LIMIT_ERROR = "usage_research_daily_limit";
export const USAGE_RESEARCH_STORAGE_FULL_ERROR = "usage_research_storage_full";
/** The 503 `error` when the Worker has no storage configured. */
export const USAGE_RESEARCH_UNAVAILABLE_ERROR = "usage_research_unavailable";
/** `appVersion`: 1 to this many printable ASCII characters. */
export const MAX_USAGE_RESEARCH_APP_VERSION_CHARS = 40;
/** `platform` and `arch`: 1 to this many printable ASCII characters each. */
export const MAX_USAGE_RESEARCH_PLATFORM_CHARS = 16;
/** `utcOffsetMinutes`: an integer from minus this to this. */
export const MAX_USAGE_RESEARCH_UTC_OFFSET_MINUTES = 840;
/** Entries in `UsageResearchGroup.hours`: one for each local hour of the day. */
export const USAGE_RESEARCH_HOURS = 24;

/**
 * `installId`: the first 32 hex of sha256("ade-usage-research-install:" + the
 * per-install research salt). Nothing else ADE sends derives from that salt,
 * so the id links to neither the analytics installation id nor the account.
 */
export const USAGE_RESEARCH_INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;
/** `accountRef`: the first 12 hex of sha256(perInstallSalt + ":" + accountKey). */
export const USAGE_RESEARCH_ACCOUNT_REF_PATTERN = /^[0-9a-f]{12}$/;
/** `day`: the machine-local calendar day the report covers. */
export const USAGE_RESEARCH_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type UsageResearchAccountKind = "subscription" | "api_key" | "local" | "unknown";
export type UsageResearchRoutedAway = "preset" | "endpoint" | "cloud";
export type UsageResearchBurnConfidence = "none" | "low" | "medium" | "high";

/** Token sums. `input` is uncached input only; `subagent` is not inside the other fields. */
export type UsageResearchTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  subagent: number;
};

/**
 * The turns of one day that share every dimension below. USD values have 6
 * decimals. Percentiles are nearest-rank and null when no turn reported the
 * value.
 */
export type UsageResearchGroup = {
  provider: string;
  requestedModel: string | null;
  servedModel: string | null;
  accountKind: UsageResearchAccountKind | null;
  /** Null for a turn with no named account (`<provider>:local`). */
  accountRef: string | null;
  /**
   * The plan tier the provider reports (`max`, `pro`, `plus`), when known.
   * Not identifying; it puts dollars-per-percent of a quota window in context.
   */
  plan: string | null;
  routedAway: UsageResearchRoutedAway | null;
  /** The model vendor behind a multi-vendor harness (`anthropic`, `lmstudio`). */
  upstream: string | null;
  reasoningEffort: string | null;
  surface: string | null;
  /** True for the turns of a chat that another chat spawned. */
  subagentChat: boolean;
  turns: number;
  completed: number;
  interrupted: number;
  failed: number;
  tokens: UsageResearchTokens;
  requests: number;
  /** The turns at the served model's public list price, whatever the account paid. */
  apiEquivalentUsd: number;
  /** Turns that had a list price. */
  pricedTurns: number;
  /** The provider's own bill, where the provider reported one. */
  providerCostUsd: number;
  /** A runtime's own list-price figure (Claude's `total_cost_usd`). */
  listPriceCostUsd: number;
  /** Plan units by unit (`premium_request`, `factory_credit`, ...). */
  planUsage: Record<string, number>;
  /** Input side of each turn's last request, and the largest context window seen. */
  context: { p50: number | null; p90: number | null; max: number | null; windowMax: number | null };
  durationMs: { p50: number | null; p90: number | null; sum: number };
  /** Turns by how their usage was obtained. */
  confidence: { measured: number; derived: number; estimated: number };
  /** Turns whose served model differs from the requested model. */
  servedMismatches: number;
  compactions: number;
  /**
   * Turns by the local hour they started, 24 entries. Absent when the report
   * had to shrink to fit `MAX_USAGE_RESEARCH_BODY_BYTES`.
   */
  hours?: number[];
  /** On the `_other` group only: how many groups it holds. */
  mergedGroups?: number;
};

/** The quota readings of one window of one account on the day. Percents have 2 decimals. */
export type UsageResearchQuota = {
  provider: string;
  windowType: string;
  accountRef: string | null;
  minPercent: number;
  maxPercent: number;
  /** Window instances (reset times) the readings covered. */
  resetInstances: number;
  samples: number;
};

/** What one percent of a subscription window cost, as of the end of the day (14-day lookback). */
export type UsageResearchBurnRate = {
  provider: string;
  windowType: string;
  accountRef: string | null;
  usdPerPercent: number | null;
  turnsPerPercent: number | null;
  observedPercent: number;
  observedUsd: number;
  observedTurns: number;
  confidence: UsageResearchBurnConfidence;
};

export type UsageResearchPriceRates = {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
};

/** A model's list price in USD per million tokens, with its long-context tiers. */
export type UsageResearchPrice = UsageResearchPriceRates & {
  tiers?: Array<{ aboveContextTokens: number } & UsageResearchPriceRates>;
  /** `list` is models.dev; `fallback` is ADE's registry price. */
  source: "list" | "fallback";
};

export type UsageResearchDailyReport = {
  /** Every turn of the day, before any group merges. */
  totals: { turns: number; apiEquivalentUsd: number; providerCostUsd: number; listPriceCostUsd: number };
  /**
   * Sorted by `apiEquivalentUsd` descending, then turns descending, then the
   * group's dimensions. The `_other` group, when present, is last.
   */
  groups: UsageResearchGroup[];
  /** Sorted by provider, window type, then account ref. */
  quota: UsageResearchQuota[];
  /** Sorted by provider, window type, then account ref. */
  burnRates: UsageResearchBurnRate[];
  /** The priced model of each group (served, else requested), keys sorted. A model with no known price is left out. */
  prices: Record<string, UsageResearchPrice>;
};

/** The request body of `POST /usage-research/daily`. */
export type UsageResearchDailyBody = {
  schemaVersion: typeof USAGE_RESEARCH_SCHEMA_VERSION;
  installId: string;
  day: string;
  /** 1 to 40 printable ASCII characters. */
  appVersion: string;
  /** `process.platform` (`darwin`, `win32`, `linux`); 1 to 16 printable ASCII characters. */
  platform: string;
  /** `process.arch` (`arm64`, `x64`); 1 to 16 printable ASCII characters. */
  arch: string;
  /** Minutes east of UTC at local noon of `day` (UTC+5:30 is 330, PDT is -420); an integer, -840 to 840. */
  utcOffsetMinutes: number;
  report: UsageResearchDailyReport;
};

/**
 * An envelope text field as the Worker accepts it: printable ASCII only, cut
 * to `maxChars`, and `unknown` when nothing is left.
 */
export function usageResearchEnvelopeText(value: string | null | undefined, maxChars: number): string {
  const text = (value ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, maxChars).trim();
  return text || "unknown";
}

/** An offset as the Worker accepts it: a whole number of minutes, -840 to 840. */
export function usageResearchUtcOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const limit = MAX_USAGE_RESEARCH_UTC_OFFSET_MINUTES;
  return Math.max(-limit, Math.min(limit, Math.round(value))) || 0;
}

export function usageResearchDailyUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${USAGE_RESEARCH_DAILY_PATH}`;
}
