import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type {
  BudgetCapScope,
  BudgetCapProvider,
  BudgetCapAction,
  BudgetCapType,
  BudgetCheckResult,
  BudgetCapConfig,
  BudgetPreset,
  UsageSnapshot
} from "../../../shared/types/usage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO week key: "2026-W10" */
function currentWeekKey(now = new Date()): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Resolve preset to effective weekly percent cap. */
function presetToWeeklyPercent(preset: BudgetPreset): number {
  switch (preset) {
    case "conservative":
      return 60;
    case "maximize":
      return 90;
    case "fixed":
      return 100;
  }
}

function normalizeBudgetConfig(input: BudgetCapConfig): BudgetCapConfig {
  const clampPercent = (value: unknown): number | undefined => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.max(0, Math.min(100, Math.round(parsed)));
  };
  const clampPositive = (value: unknown): number | undefined => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.round(parsed * 100) / 100;
  };
  const preset = input.preset === "conservative" || input.preset === "maximize" || input.preset === "fixed"
    ? input.preset
    : undefined;
  const refreshIntervalMin = clampPositive(input.refreshIntervalMin);
  const alertAtWeeklyPercent = clampPercent(input.alertAtWeeklyPercent);
  return {
    ...(preset ? { preset } : {}),
    ...(refreshIntervalMin != null ? { refreshIntervalMin } : {}),
    ...(alertAtWeeklyPercent != null ? { alertAtWeeklyPercent } : {}),
    ...(Array.isArray(input.budgetCaps)
      ? {
          budgetCaps: input.budgetCaps
            .map((cap) => ({
              scope: cap.scope,
              ...(typeof cap.scopeId === "string" && cap.scopeId.trim().length > 0 ? { scopeId: cap.scopeId.trim() } : {}),
              capType: cap.capType,
              provider: cap.provider,
              limit: clampPositive(cap.limit) ?? 0,
              action: cap.action,
            }))
            .filter((cap) => cap.limit > 0),
        }
      : {}),
  };
}

type CapConfigRaw = {
  scope: BudgetCapScope;
  scopeId?: string;
  capType: BudgetCapType;
  provider: BudgetCapProvider;
  limit: number;
  action: BudgetCapAction;
};

// ---------------------------------------------------------------------------
// Service types
// ---------------------------------------------------------------------------

type ProjectConfigService = {
  getEffective(): { ai?: unknown; [k: string]: unknown };
  get(): { local: { usage?: BudgetCapConfig; [k: string]: unknown }; shared?: Record<string, unknown>; [k: string]: unknown };
  save(candidate: { shared?: Record<string, unknown>; local?: Record<string, unknown> }): { local?: Record<string, unknown> };
};

type UsageTrackingService = {
  getUsageSnapshot(): UsageSnapshot | null;
};

export type BudgetCapService = ReturnType<typeof createBudgetCapService>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBudgetCapService({
  db,
  logger,
  projectConfigService,
  usageTrackingService
}: {
  db: AdeDb;
  logger: Logger;
  projectConfigService: ProjectConfigService;
  usageTrackingService?: UsageTrackingService;
}) {
  // ------------------------------------------------------------------
  // Config reading
  // ------------------------------------------------------------------

  function readConfig(): BudgetCapConfig {
    try {
      const snapshot = projectConfigService.get();
      return (snapshot.local?.usage as BudgetCapConfig) ?? {};
    } catch {
      return {};
    }
  }

  // ------------------------------------------------------------------
  // Cumulative usage queries
  // ------------------------------------------------------------------

  type CumulativeRow = { total_tokens: number; total_cost: number };

  const EMPTY_CUMULATIVE: CumulativeRow = { total_tokens: 0, total_cost: 0 };

  function queryCumulative(
    whereClause: string,
    baseParams: (string | number)[],
    provider: BudgetCapProvider
  ): CumulativeRow {
    const providerClause = provider === "any" ? "" : " and provider = ?";
    const params = provider === "any" ? baseParams : [...baseParams, provider];

    const row = db.get<CumulativeRow>(
      `select coalesce(sum(tokens_used), 0) as total_tokens,
              coalesce(sum(cost_usd), 0) as total_cost
       from budget_usage_records
       where ${whereClause}${providerClause}`,
      params
    );
    return row ?? EMPTY_CUMULATIVE;
  }

  function getCumulativeUsage(
    scope: BudgetCapScope,
    scopeId: string,
    provider: BudgetCapProvider,
    weekKey: string
  ): CumulativeRow {
    return queryCumulative("scope = ? and scope_id = ? and week_key = ?", [scope, scopeId, weekKey], provider);
  }

  function getGlobalCumulativeUsage(weekKey: string, provider: BudgetCapProvider): CumulativeRow {
    return queryCumulative("week_key = ?", [weekKey], provider);
  }

  // ------------------------------------------------------------------
  // Snapshot window helpers
  // ------------------------------------------------------------------

  function getMaxWindowPercent(
    windowType: "weekly" | "five_hour",
    provider: BudgetCapProvider = "any"
  ): number | null {
    const snapshot = usageTrackingService?.getUsageSnapshot();
    if (!snapshot) return null;

    const windows = snapshot.windows.filter((w) => w.windowType === windowType);
    const relevant = provider === "any" ? windows : windows.filter((w) => w.provider === provider);
    if (relevant.length === 0) return null;

    return Math.max(...relevant.map((w) => w.percentUsed));
  }

  // ------------------------------------------------------------------
  // Cap evaluation
  // ------------------------------------------------------------------

  function evaluateCap(
    cap: CapConfigRaw,
    weekKey: string,
    scope: BudgetCapScope,
    scopeId: string
  ): { exceeded: boolean; message: string; remainingPercent?: number; remainingUsd?: number } {
    const { capType, limit, provider } = cap;

    if (capType === "weekly-percent" || capType === "five-hour-percent") {
      const windowType = capType === "weekly-percent" ? "weekly" as const : "five_hour" as const;
      const label = capType === "weekly-percent" ? "Weekly" : "5-hour";

      const maxPct = getMaxWindowPercent(windowType, provider);
      if (maxPct == null) return { exceeded: false, message: "No usage data available" };

      const remaining = Math.max(0, limit - maxPct);

      if (maxPct >= limit) {
        return {
          exceeded: true,
          message: `${label} usage at ${maxPct.toFixed(1)}% exceeds cap of ${limit}%`,
          remainingPercent: 0
        };
      }
      return { exceeded: false, message: `${label} usage at ${maxPct.toFixed(1)}%`, remainingPercent: remaining };
    }

    if (capType === "usd-per-run") {
      const cumulative = getCumulativeUsage(scope, scopeId, provider, weekKey);
      const remaining = Math.max(0, limit - cumulative.total_cost);

      if (cumulative.total_cost >= limit) {
        return {
          exceeded: true,
          message: `Run cost $${cumulative.total_cost.toFixed(2)} exceeds cap of $${limit.toFixed(2)}`,
          remainingUsd: 0
        };
      }
      return { exceeded: false, message: `Run cost $${cumulative.total_cost.toFixed(2)}`, remainingUsd: remaining };
    }

    if (capType === "usd-per-day") {
      const today = new Date().toISOString().slice(0, 10);
      const row = db.get<{ total_cost: number }>(
        `select coalesce(sum(cost_usd), 0) as total_cost
         from budget_usage_records
         where scope = ? and scope_id = ? and date(recorded_at) = ?${provider !== "any" ? " and provider = ?" : ""}`,
        provider !== "any" ? [scope, scopeId, today, provider] : [scope, scopeId, today]
      );
      const cost = row?.total_cost ?? 0;
      const remaining = Math.max(0, limit - cost);

      if (cost >= limit) {
        return {
          exceeded: true,
          message: `Daily cost $${cost.toFixed(2)} exceeds cap of $${limit.toFixed(2)}`,
          remainingUsd: 0
        };
      }
      return { exceeded: false, message: `Daily cost $${cost.toFixed(2)}`, remainingUsd: remaining };
    }

    return { exceeded: false, message: "Unknown cap type" };
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  return {
    /**
     * Check budget before dispatching an automation run.
     */
    checkBudget(
      scope: BudgetCapScope,
      scopeId: string,
      provider: BudgetCapProvider
    ): BudgetCheckResult {
      const config = readConfig();
      const weekKey = currentWeekKey();
      const warnings: string[] = [];

      // 1. Alert threshold check (soft warning)
      const alertAt = config.alertAtWeeklyPercent;
      if (alertAt != null && alertAt > 0) {
        const maxPct = getMaxWindowPercent("weekly") ?? 0;
        if (maxPct >= alertAt) {
          const msg = `Weekly usage at ${maxPct.toFixed(1)}% has reached alert threshold of ${alertAt}%`;
          warnings.push(msg);
          logger.warn("budgetCap.alertThreshold", { scope, scopeId, maxPct, alertAt });
        }
      }

      // 2. Preset-based global cap check
      if (config.preset) {
        const presetLimit = presetToWeeklyPercent(config.preset);
        const maxPct = getMaxWindowPercent("weekly") ?? 0;
        if (maxPct >= presetLimit) {
          const reason = `Budget preset "${config.preset}" cap of ${presetLimit}% exceeded (current: ${maxPct.toFixed(1)}%)`;
          logger.warn("budgetCap.presetExceeded", { scope, scopeId, preset: config.preset, presetLimit, maxPct });
          return { allowed: false, reason, remainingPercent: 0, warnings };
        }
      }

      // 3. Evaluate explicit budget caps
      const caps = config.budgetCaps ?? [];
      let blocked = false;
      let blockReason: string | undefined;
      let minRemainingPercent: number | undefined;
      let minRemainingUsd: number | undefined;

      for (const cap of caps) {
        // Match scope: global caps apply to all, scoped caps match exact scope+scopeId
        const scopeMatch =
          cap.scope === "global" ||
          (cap.scope === scope && (!cap.scopeId || cap.scopeId === scopeId));
        if (!scopeMatch) continue;

        // Match provider
        const providerMatch = cap.provider === "any" || cap.provider === provider || provider === "any";
        if (!providerMatch) continue;

        const result = evaluateCap(cap, weekKey, scope, scopeId);

        if (result.remainingPercent != null) {
          minRemainingPercent =
            minRemainingPercent == null ? result.remainingPercent : Math.min(minRemainingPercent, result.remainingPercent);
        }
        if (result.remainingUsd != null) {
          minRemainingUsd =
            minRemainingUsd == null ? result.remainingUsd : Math.min(minRemainingUsd, result.remainingUsd);
        }

        if (result.exceeded) {
          if (cap.action === "warn") {
            warnings.push(result.message);
          } else if (cap.action === "block" || cap.action === "pause") {
            blocked = true;
            blockReason = result.message;
            logger.warn("budgetCap.blocked", { scope, scopeId, capAction: cap.action, message: result.message });
          }
        }
      }

      if (blocked) {
        return {
          allowed: false,
          reason: blockReason,
          remainingPercent: minRemainingPercent,
          remainingUsd: minRemainingUsd,
          warnings
        };
      }

      return {
        allowed: true,
        remainingPercent: minRemainingPercent,
        remainingUsd: minRemainingUsd,
        warnings
      };
    },

    /**
     * Record usage after an automation run completes.
     */
    recordUsage(
      scope: BudgetCapScope,
      scopeId: string,
      usage: { tokensUsed: number; costUsd: number; provider: string }
    ): void {
      const id = randomUUID();
      const weekKey = currentWeekKey();
      const now = new Date().toISOString();

      db.run(
        `insert into budget_usage_records (id, scope, scope_id, provider, tokens_used, cost_usd, week_key, recorded_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, scope, scopeId, usage.provider, usage.tokensUsed, usage.costUsd, weekKey, now]
      );

      logger.info("budgetCap.recordUsage", {
        id,
        scope,
        scopeId,
        provider: usage.provider,
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
        weekKey
      });
    },

    /**
     * Get cumulative usage for a scope in the current week.
     */
    getCumulativeUsage(
      scope: BudgetCapScope,
      scopeId: string,
      provider: BudgetCapProvider = "any"
    ): { totalTokens: number; totalCostUsd: number; weekKey: string } {
      const weekKey = currentWeekKey();
      const row = getCumulativeUsage(scope, scopeId, provider, weekKey);
      return { totalTokens: row.total_tokens, totalCostUsd: row.total_cost, weekKey };
    },

    /**
     * Get global cumulative usage across all scopes for the current week.
     */
    getGlobalCumulativeUsage(
      provider: BudgetCapProvider = "any"
    ): { totalTokens: number; totalCostUsd: number; weekKey: string } {
      const weekKey = currentWeekKey();
      const row = getGlobalCumulativeUsage(weekKey, provider);
      return { totalTokens: row.total_tokens, totalCostUsd: row.total_cost, weekKey };
    },

    /**
     * Read the current budget config from project config.
     */
    getConfig(): BudgetCapConfig {
      return readConfig();
    },

    updateConfig(nextConfig: BudgetCapConfig): BudgetCapConfig {
      const snapshot = projectConfigService.get();
      const normalized = normalizeBudgetConfig(nextConfig);
      const saved = projectConfigService.save({
        shared: (snapshot.shared as Record<string, unknown> | undefined) ?? {},
        local: {
          ...(snapshot.local ?? {}),
          usage: normalized,
        },
      });
      logger.info("budgetCap.updateConfig", {
        preset: normalized.preset ?? null,
        capCount: normalized.budgetCaps?.length ?? 0,
      });
      return (saved.local?.usage as BudgetCapConfig) ?? normalized;
    },

    /** Exposed for testing. */
    _currentWeekKey: currentWeekKey
  };
}
