// ---------------------------------------------------------------------------
// Usage dashboard types
// ---------------------------------------------------------------------------

export type UsageModelBreakdown = {
  provider: string;
  model: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costEstimateUsd: number;
};

export type UsageRecentSession = {
  id: string;
  feature: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  success: boolean;
  timestamp: string;
};

export type UsageActiveSession = {
  id: string;
  feature: string;
  provider: string;
  model: string;
  startedAt: string;
  elapsedMs: number;
};

export type AggregatedUsageStats = {
  summary: {
    totalSessions: number;
    activeSessions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
    totalCostEstimateUsd: number;
  };
  byModel: UsageModelBreakdown[];
  recentSessions: UsageRecentSession[];
  activeSessions: UsageActiveSession[];
};

export type GetAggregatedUsageArgs = {
  since?: string | null;
  limit?: number;
};

export const ADE_USAGE_RANGE_PRESETS = ["today", "7d", "30d", "year", "all"] as const;

export type AdeUsageRangePreset = (typeof ADE_USAGE_RANGE_PRESETS)[number];

export function isAdeUsageRangePreset(value: unknown): value is AdeUsageRangePreset {
  return typeof value === "string"
    && (ADE_USAGE_RANGE_PRESETS as readonly string[]).includes(value);
}

export type AdeUsageClientSurface = "desktop" | "mobile" | "tui" | "web" | "api";

/**
 * Scope of provider-ledger metrics.
 * - `account` — every machine on the ADE account, merged from published rollups.
 * - `machine` — every session found in the provider's local ledgers (codeburn-comparable).
 * - `project` — only sessions attributable to the current project root (cwd match).
 * GitHub and ADE-DB metrics are always project/repo scoped regardless of this value.
 *
 * The three are mutually exclusive rather than two independent axes. A project
 * normally lives on one machine, so "this project across all machines" is a
 * combination worth neither the second control nor the four states to test.
 *
 * `account` deliberately does not change the live quota windows: provider rate
 * limits are tied to the provider account, not the machine, so every machine
 * already reports the same window and splitting it per machine would imply a
 * difference that does not exist.
 */
export const ADE_USAGE_SCOPES = ["account", "machine", "project"] as const;

export type AdeUsageScope = (typeof ADE_USAGE_SCOPES)[number];

export function isAdeUsageScope(value: unknown): value is AdeUsageScope {
  return typeof value === "string" && (ADE_USAGE_SCOPES as readonly string[]).includes(value);
}

/**
 * How a provider's token counts were obtained.
 * - `exact` — provider-recorded token counts.
 * - `chars` — estimated from character length (chars/4).
 * - `distribution` — real session totals spread across calls/days (per-day values synthetic).
 * - `mixed` — some entries exact, some estimated.
 */
export type AdeUsageEstimationKind = "exact" | "chars" | "distribution" | "mixed";

export type GetAdeUsageStatsArgs = {
  preset?: AdeUsageRangePreset;
  /** Custom timestamps are widened to include the whole machine-local calendar day. */
  since?: string | null;
  /** Custom timestamps are widened to include the whole machine-local calendar day. */
  until?: string | null;
  /** Defaults to "machine" (legacy behavior). */
  scope?: AdeUsageScope;
  /**
   * Bypass the account fan-out's rate floor for this read.
   *
   * Set only by an explicit user action (the Refresh button). The floor exists
   * because an account-scoped read starts a refresh whose update causes another
   * read; a user pressing Refresh is outside that loop and must not be silently
   * suppressed merely because the page already read on mount.
   */
  force?: boolean;
};

/**
 * Where the rates behind a cost figure came from.
 *
 * `list` = the maintained public rate list (BerriAI/litellm's published JSON,
 * fetched or from its cache), which is authoritative; `fallback` = ADE's
 * built-in table, used when the list is unavailable or does not price the
 * model; `mixed` = both, across different models.
 */
export type AdeUsagePricingSource = "list" | "fallback" | "mixed";

export type AdeUsageProviderSummary = {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  rangeCostUsd: number;
  todayCostUsd: number;
  last30dCostUsd: number;
  /** Omitted/`exact` when counts are provider-recorded. */
  estimation?: AdeUsageEstimationKind;
  /**
   * Which rate card priced this provider's tokens: the maintained public rate
   * list, ADE's built-in fallback, or both across different models.
   */
  pricingSource?: AdeUsagePricingSource;
  /** False when this provider's ledger cannot be filtered to a project (machine-only). */
  scopeSupported?: boolean;
  /** Tokens attributed to ADE-originated sessions (subset of totalTokens). */
  adeOriginatedTokens?: number;
  /** Tokens from sessions launched outside ADE (subset of totalTokens). */
  externalTokens?: number;
};

export type AdeUsageModelSummary = {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type AdeUsageAgentProviderSummary = {
  provider: string;
  sessions: number;
  models: number;
  latestAt: string | null;
};

export type AdeUsageAgentModelSummary = {
  provider: string;
  model: string;
  sessions: number;
  latestAt: string | null;
};

export type AdeUsageFeatureSummary = {
  feature: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  successRate: number;
};

export type AdeUsageLaneSummary = {
  laneId: string;
  laneName: string;
  sessions: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type AdeUsageActivitySummary = {
  kind: string;
  count: number;
};

export type AdeUsageClientSummary = {
  client: AdeUsageClientSurface;
  interactions: number;
  activeDays: number;
  sessions: number;
  lastActiveAt: string | null;
};

/** One provider's contribution to a single day. */
export type AdeUsageDailyProviderPoint = {
  totalTokens: number;
  /**
   * Cost of this provider's tokens for the day, at full API rates. Not money
   * spent — subscription plans bill separately.
   */
  costUsd: number;
};

export type AdeUsageDailyPoint = {
  /** Local calendar day (YYYY-MM-DD in the machine's timezone). */
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cache-read tokens for the day (provider ledgers). */
  cachedTokens?: number;
  /** Local (ADE DB / git operations) measures — never merged with GitHub values. */
  commits: number;
  prs: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
  sessions: number;
  durationMs?: number;
  interactions?: number;
  clients?: Partial<Record<AdeUsageClientSurface, number>>;
  /**
   * Per-provider split of this day's tokens and cost, keyed by provider id.
   *
   * The flat `totalTokens` above answers "how much", but the daily chart plots
   * one series per provider, which cannot be recovered from a sum. Optional
   * because hosts predating this field still report the flat totals, and the
   * chart falls back to a single combined series rather than rendering empty.
   */
  byProvider?: Record<string, AdeUsageDailyProviderPoint>;
  /** GitHub-reported measures for the same day, kept separate from local ones. */
  githubCommits?: number;
  githubPrs?: number;
  githubAdditions?: number;
  githubDeletions?: number;
};

/** GitHub-scoped activity, reported separately from local activity (never max-merged). */
export type AdeUsageGithubActivity = {
  commits: number;
  prsTracked: number;
  prsOpen: number;
  prsMerged: number;
  prsClosed: number;
  prAdditions: number;
  prDeletions: number;
};

/** Current-project ADE DB / git-operation activity, reported separately from GitHub. */
export type AdeUsageLocalActivity = {
  commits: number;
  pushOperations: number;
  prLandings: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type AdeUsageStats = {
  generatedAt: string;
  /** Scope the provider-ledger metrics were computed at. Absent = machine (legacy hosts). */
  scope?: AdeUsageScope;
  range: {
    preset: AdeUsageRangePreset;
    since: string | null;
    until: string;
  };
  summary: {
    totalTokens: number;
    tokenTotalSource: "provider_logs" | "ade_db" | "combined";
    observedProviderTokens: number;
    observedProviderInputTokens: number;
    observedProviderOutputTokens: number;
    observedProviderCachedTokens: number;
    observedProviderCostRangeUsd: number;
    observedProviderCost30dUsd: number;
    observedProviderCostTodayUsd: number;
    adeRuntimeTokens?: number;
    adeRuntimeInputTokens?: number;
    adeRuntimeOutputTokens?: number;
    adeRuntimeCachedTokens?: number;
    adeRuntimeCostRangeUsd?: number;
    adeRuntimeCost30dUsd?: number;
    adeRuntimeCostTodayUsd?: number;
    adeTotalTokens?: number;
    adeTotalCostRangeUsd?: number;
    trackedAdeTokens?: number;
    trackedAdeInputTokens?: number;
    trackedAdeOutputTokens?: number;
    trackedAdeCalls?: number;
    trackedAdeDurationMs?: number;
    workerTokens?: number;
    workerCostUsd?: number;
    chatSessions?: number;
    terminalSessions?: number;
    activeLanes?: number;
    lanesCreated?: number;
    lanesArchived?: number;
    lanesDeleted?: number;
    commitsCreated: number;
    pushOperations: number;
    prLandings: number;
    prsTracked: number;
    prsOpen: number;
    prsMerged: number;
    prsClosed: number;
    prAdditions: number;
    prDeletions: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
    artifactsCaptured?: number;
    automationRuns?: number;
    workerRuns?: number;
    totalInteractions?: number;
    activeDays?: number;
    currentStreakDays?: number;
    longestStreakDays?: number;
    longestSessionMs?: number;
  };
  /**
   * GitHub vs local activity as separate labeled groups. When present, the UI
   * must prefer these over the legacy max-merged summary fields.
   */
  githubActivity?: AdeUsageGithubActivity;
  localActivity?: AdeUsageLocalActivity;
  providers: AdeUsageProviderSummary[];
  models: AdeUsageModelSummary[];
  adeProviders?: AdeUsageProviderSummary[];
  adeModels?: AdeUsageModelSummary[];
  agentProviders?: AdeUsageAgentProviderSummary[];
  agentModels?: AdeUsageAgentModelSummary[];
  features?: AdeUsageFeatureSummary[];
  lanes?: AdeUsageLaneSummary[];
  activities?: AdeUsageActivitySummary[];
  clients?: AdeUsageClientSummary[];
  daily: AdeUsageDailyPoint[];
  github: {
    repo: string | null;
    available: boolean;
    lastFetchedAt: string | null;
    error: string | null;
  };
  sourceNotes?: string[];
  /**
   * When the loaded copy of the public rate list was fetched. Null = none is
   * loaded, so every cost here came from the built-in fallback table.
   */
  pricingUpdatedAt?: string | null;
  freshness?: {
    state: "fresh" | "refreshing" | "stale";
    providerUpdatedAt: string | null;
    githubUpdatedAt: string | null;
  };
  /**
   * Which machines contributed to an `account`-scoped result, and how well.
   * Optional so a host predating account scope still returns a valid payload —
   * the UI then shows the single-machine numbers with no machine list.
   */
  machines?: AdeUsageMachineContribution[];
};

// ---------------------------------------------------------------------------
// Account-wide (multi-machine) usage merge
// ---------------------------------------------------------------------------

/**
 * How one machine ended up in (or out of) an account-scoped total.
 *
 * - `live`    — refreshed directly from the machine while the page was open.
 * - `rollup`  — counted from the machine's last published daily rollup.
 * - `stale`   — counted from a rollup older than the freshness horizon. Still
 *               in the totals; the UI should say the numbers lag.
 * - `deduped` — excluded because another machine reads the same transcript
 *               source (synced home directory, shared mount). Counting both
 *               would double every token.
 * - `failed`  — reported nothing usable. Missing from the totals, never an
 *               error that empties the page.
 */
export type AdeUsageMachineState = "live" | "rollup" | "stale" | "deduped" | "failed";

export type AdeUsageMachineContribution = {
  machineKey: string;
  /** Best available display label (custom name, then hostname, then key). */
  label: string;
  platform: string | null;
  /** True for the machine that produced this response. */
  isLocal: boolean;
  state: AdeUsageMachineState;
  /** When this machine's counted data was captured. */
  lastReportedAt: string | null;
  /** Machine key this one was deduped against, when `state` is "deduped". */
  dedupedAgainstMachineKey?: string | null;
  /** Tokens this machine contributed to the merged range total (0 when excluded). */
  totalTokens: number;
  /** Cost this machine contributed to the merged range total (0 when excluded). */
  costUsd: number;
  /** Log-free reason for `failed`/`stale`, safe to show. */
  message?: string | null;
};

/** One day × provider × model aggregate row. Never a transcript record. */
export type AdeUsageRollupRow = {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
};

/**
 * Identity of the transcript files a machine read.
 *
 * Two machines that mount the same home directory read the same marker id
 * (`sourceId`, written into that directory so it travels with the files) and
 * fold the same paths into the same `roots`.
 *
 * The rule the merge applies (`isSameTranscriptSource`): when both sides carry
 * a marker, equal ids are the same source and different ids are not — full
 * stop. When either side has no marker, the folded `roots` must match exactly.
 *
 * A marker is a file, so a disk image or a restored backup hands two genuinely
 * separate machines the same id and they merge, under-counting. That is a
 * deliberate trade for a rule with no moving parts, and it shows up in the
 * machine list rather than silently — see `accountUsageSource.ts`.
 */
export type AdeUsageTranscriptSource = {
  /** Marker id read from the transcript home, or null when unavailable. */
  sourceId: string | null;
  /**
   * sha256 digests of the comparison-normalized transcript roots, sorted.
   * Digested, not raw: no absolute path leaves the machine that scanned it.
   */
  roots: string[];
};

/** A machine's compact, self-describing contribution to account totals. */
export type AdeUsageRollup = {
  /** Rollup wire version. Bump when the row shape changes meaning. */
  version: 1;
  machineKey: string;
  label: string;
  platform: string | null;
  /** When the underlying ledger scan produced these rows. */
  capturedAt: string;
  source: AdeUsageTranscriptSource;
  rows: AdeUsageRollupRow[];
};

// ---------------------------------------------------------------------------
// Live quota tracking types (Claude/Codex API windows plus local runtime cost scans)
// ---------------------------------------------------------------------------

export type UsageProvider = "claude" | "codex" | "cursor";

export type UsageWindowType = "five_hour" | "weekly" | "monthly" | "weekly_oauth_apps" | "weekly_cowork";

export type UsageWindow = {
  provider: UsageProvider;
  windowType: UsageWindowType;
  modelBreakdown?: Record<string, number>;
  percentUsed: number;
  resetsAt: string;
  resetsInMs: number;
  windowDurationMs?: number;
  /** Pace of this specific window (ahead/behind a steady burn). Computed per-window. */
  pacing?: UsagePacing;
};

export type UsagePacingStatus =
  | "far-behind"
  | "behind"
  | "slightly-behind"
  | "on-track"
  | "slightly-ahead"
  | "ahead"
  | "far-ahead";

export type UsagePacing = {
  status: UsagePacingStatus;
  /** Projected usage % at the end of the tracked quota window. */
  projectedWeeklyPercent: number;
  /** % of the tracked quota window that has elapsed. */
  weekElapsedPercent: number;
  /** Expected usage % at this point if usage were perfectly linear */
  expectedPercent: number;
  /** Actual - expected (positive = using faster than pace) */
  deltaPercent: number;
  /** Hours until 100% at current rate, null if rate is ~0 */
  etaHours: number | null;
  /** Whether current rate will last until the tracked reset */
  willLastToReset: boolean;
  /** Hours until the tracked window resets */
  resetsInHours: number;
};

export type UsagePacingByProvider = Partial<Record<UsageProvider, UsagePacing>>;

/**
 * Per-provider freshness/health for the most recent poll. Lets the UI keep
 * showing last-good numbers while signalling a quiet retry, instead of wiping
 * data and surfacing a raw error string.
 *
 * - `ok`       — this poll returned fresh windows.
 * - `stale`    — this poll failed, but we are still showing carried-forward data.
 * - `unauthed` — no credentials for this provider (sign-in required).
 * - `error`    — this poll failed and there is no prior data to fall back to.
 */
export type UsageProviderState = "ok" | "stale" | "unauthed" | "error";

export type UsageProviderSource = "oauth" | "http" | "cli";

export type UsageProviderErrorKind =
  | "auth"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "timeout"
  | "network"
  | "invalid_response"
  | "unavailable"
  | "unknown";

export type UsageProviderStatus = {
  state: UsageProviderState;
  /** ISO timestamp of the last poll that returned real windows, if any. */
  lastSuccessAt: string | null;
  /** Provider source that produced the displayed windows. */
  source?: UsageProviderSource;
  /** ISO timestamp of the data currently being displayed. */
  updatedAt?: string | null;
  /** ISO timestamp of the most recent attempted refresh. */
  lastAttemptAt?: string | null;
  /** Typed failure classification for stale/error/unauthed states. */
  errorKind?: UsageProviderErrorKind;
  /** ISO timestamp before which automatic refresh should remain backed off. */
  nextRetryAt?: string | null;
  /** Friendly, log-free reason for a non-ok state (e.g. "Couldn't reach Claude"). */
  message?: string;
};

export type UsageProviderStatusMap = Partial<Record<UsageProvider, UsageProviderStatus>>;

export type CostTokenBreakdown = {
  input: number;
  output: number;
  cached: number;
  cacheWrite?: number;
  costUsd?: number;
};

export type CostSnapshot = {
  provider: string;
  last30dCostUsd: number;
  todayCostUsd: number;
  costUsdByPreset?: Partial<Record<AdeUsageRangePreset, number>>;
  tokenBreakdown: Record<string, CostTokenBreakdown>;
  tokenBreakdownByPreset?: Partial<Record<AdeUsageRangePreset, Record<string, CostTokenBreakdown>>>;
  dailyTokenBreakdownByPreset?: Partial<Record<AdeUsageRangePreset, Record<string, Record<string, CostTokenBreakdown>>>>;
  dailyTokensByPreset?: Partial<Record<AdeUsageRangePreset, Record<string, number>>>;
  /** How this provider's token counts were obtained. Omitted = exact. */
  estimation?: AdeUsageEstimationKind;
  /** Which rate card priced this provider's models. */
  pricingSource?: AdeUsagePricingSource;
  /** False when this ledger cannot be filtered to a project scope. */
  scopeSupported?: boolean;
  /** Tokens attributed to ADE-originated sessions, by preset. */
  adeOriginatedTokensByPreset?: Partial<Record<AdeUsageRangePreset, number>>;
  /** Tokens attributed to ADE-originated sessions by local day, by preset. */
  adeOriginatedDailyTokensByPreset?: Partial<Record<AdeUsageRangePreset, Record<string, number>>>;
};

export type ExtraUsage = {
  provider: UsageProvider;
  isEnabled: boolean;
  usedCreditsUsd: number;
  monthlyLimitUsd: number;
  utilization: number | null;
  currency: string;
};

export type UsageProviderMessage = {
  provider: UsageProvider;
  id: string;
  kind: "headline" | "announcement" | "unknown";
  message: string;
  createdAt?: string | null;
};

export type UsageSnapshot = {
  windows: UsageWindow[];
  /** Codex account-level spend control state. Omitted when the server does not report it. */
  spendControlReached?: boolean;
  pacing: UsagePacing;
  pacingByProvider?: UsagePacingByProvider;
  /** Per-provider freshness/health for the latest poll (drives quiet-retry UI). */
  providerStatus?: UsageProviderStatusMap;
  providerMessages?: UsageProviderMessage[];
  costs: CostSnapshot[];
  /** Local runtime usage that can be attributed specifically to ADE-originated sessions. */
  adeCosts?: CostSnapshot[];
  extraUsage: ExtraUsage[];
  /** Per-provider daily token usage for the last 7 calendar days, oldest first. */
  dailyUsage7d?: Partial<Record<UsageProvider, number[]>>;
  /** ISO timestamp of the last poll that included local cost/history scans. */
  costsLastPolledAt?: string;
  lastPolledAt: string;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Budget cap types for shared automation usage enforcement
// ---------------------------------------------------------------------------

export type BudgetCapScope =
  | "global"
  | "automation-rule";

export type BudgetCapType =
  | "weekly-percent"
  | "five-hour-percent"
  | "usd-per-run"
  | "usd-per-day";

export type BudgetCapAction = "pause" | "warn" | "block";

export type BudgetCapProvider = "claude" | "codex" | "any";

export type BudgetCap = {
  id: string;
  scope: BudgetCapScope;
  scopeId?: string;
  capType: BudgetCapType;
  provider: BudgetCapProvider;
  limit: number;
  action: BudgetCapAction;
};

export type BudgetCheckResult = {
  allowed: boolean;
  reason?: string;
  remainingPercent?: number;
  remainingUsd?: number;
  warnings: string[];
};

export type BudgetCheckContext = {
  /** Usage records for `usd-per-run` are keyed to the active run, not the rule. */
  runScopeId?: string | null;
};

export type BudgetCheckArgs = {
  scope: BudgetCapScope;
  scopeId?: string;
  provider: BudgetCapProvider;
  runScopeId?: string | null;
};

export type BudgetUsageRecord = {
  id: string;
  scope: BudgetCapScope;
  scopeId: string;
  provider: string;
  tokensUsed: number;
  costUsd: number;
  weekKey: string;
  recordedAt: string;
};

export type BudgetPreset = "conservative" | "maximize" | "fixed";

export type BudgetCapConfig = {
  refreshIntervalMin?: number;
  budgetCaps?: Array<{
    scope: BudgetCapScope;
    scopeId?: string;
    capType: BudgetCapType;
    provider: BudgetCapProvider;
    limit: number;
    action: BudgetCapAction;
  }>;
  alertAtWeeklyPercent?: number;
  preset?: BudgetPreset;
};
