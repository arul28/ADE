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
  get(): { local: { usage?: BudgetCapConfig; [k: string]: unknown }; [k: string]: unknown };
};

type UsageTrackingService = {
  getSnapshot(): UsageSnapshot | null;
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

  function getCumulativeUsage(
    scope: BudgetCapScope,
    scopeId: string,
    provider: BudgetCapProvider,
    weekKey: string
  ): CumulativeRow {
    const providerClause =
      provider === "any"
        ? ""
        : " and provider = ?";
    const params: (string | number)[] = [scope, scopeId, weekKey];
    if (provider !== "any") params.push(provider);

    const row = db.get<{ total_tokens: number; total_cost: number }>(
      `select coalesce(sum(tokens_used), 0) as total_tokens,
              coalesce(sum(cost_usd), 0) as total_cost
       from budget_usage_records
       where scope = ? and scope_id = ? and week_key = ?${providerClause}`,
      params
    );
    return row ?? { total_tokens: 0, total_cost: 0 };
  }

  function getGlobalCumulativeUsage(weekKey: string, provider: BudgetCapProvider): CumulativeRow {
    const providerClause = provider === "any" ? "" : " and provider = ?";
    const params: (string | number)[] = [weekKey];
    if (provider !== "any") params.push(provider);

    const row = db.get<{ total_tokens: number; total_cost: number }>(
      `select coalesce(sum(tokens_used), 0) as total_tokens,
              coalesce(sum(cost_usd), 0) as total_cost
       from budget_usage_records
       where week_key = ?${providerClause}`,
      params
    );
    return row ?? { total_tokens: 0, total_cost: 0 };
  }

  // ------------------------------------------------------------------
  // Night Shift reserve check
  // ------------------------------------------------------------------

  function isNightShiftReserveBlocked(
    scope: BudgetCapScope,
    weekKey: string,
    config: BudgetCapConfig
  ): { blocked: boolean; reason?: string } {
    const reservePct = config.nightShiftReservePercent;
    if (!reservePct || reservePct <= 0) return { blocked: false };

    // Only block daytime (non-night-shift) scopes
    if (scope === "night-shift-run" || scope === "night-shift-global") {
      return { blocked: false };
    }

    // Get current weekly percent from live usage tracking
    const snapshot = usageTrackingService?.getSnapshot();
    if (!snapshot) return { blocked: false };

    const weeklyWindows = snapshot.windows.filter((w) => w.windowType === "weekly");
    if (weeklyWindows.length === 0) return { blocked: false };

    // Use the highest percent-used across providers
    const maxWeeklyPct = Math.max(...weeklyWindows.map((w) => w.percentUsed));
    const maxAllowed = 100 - reservePct;

    if (maxWeeklyPct >= maxAllowed) {
      return {
        blocked: true,
        reason: `Night Shift reserve active: ${reservePct}% reserved. Weekly usage at ${maxWeeklyPct.toFixed(1)}%, max allowed for daytime: ${maxAllowed}%`
      };
    }

    return { blocked: false };
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

    if (capType === "weekly-percent") {
      // Get live usage percent from tracking service
      const snapshot = usageTrackingService?.getSnapshot();
      if (!snapshot) return { exceeded: false, message: "No usage data available" };

      const weeklyWindows = snapshot.windows.filter((w) => w.windowType === "weekly");
      const relevantWindows =
        provider === "any"
          ? weeklyWindows
          : weeklyWindows.filter((w) => w.provider === provider);

      if (relevantWindows.length === 0) return { exceeded: false, message: "No matching windows" };

      const maxPct = Math.max(...relevantWindows.map((w) => w.percentUsed));
      const remaining = Math.max(0, limit - maxPct);

      if (maxPct >= limit) {
        return {
          exceeded: true,
          message: `Weekly usage at ${maxPct.toFixed(1)}% exceeds cap of ${limit}%`,
          remainingPercent: 0
        };
      }
      return { exceeded: false, message: `Weekly usage at ${maxPct.toFixed(1)}%`, remainingPercent: remaining };
    }

    if (capType === "five-hour-percent") {
      const snapshot = usageTrackingService?.getSnapshot();
      if (!snapshot) return { exceeded: false, message: "No usage data available" };

      const fiveHourWindows = snapshot.windows.filter((w) => w.windowType === "five_hour");
      const relevantWindows =
        provider === "any"
          ? fiveHourWindows
          : fiveHourWindows.filter((w) => w.provider === provider);

      if (relevantWindows.length === 0) return { exceeded: false, message: "No matching windows" };

      const maxPct = Math.max(...relevantWindows.map((w) => w.percentUsed));
      const remaining = Math.max(0, limit - maxPct);

      if (maxPct >= limit) {
        return {
          exceeded: true,
          message: `5-hour usage at ${maxPct.toFixed(1)}% exceeds cap of ${limit}%`,
          remainingPercent: 0
        };
      }
      return { exceeded: false, message: `5-hour usage at ${maxPct.toFixed(1)}%`, remainingPercent: remaining };
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
     * Check budget before dispatching an automation or Night Shift run.
     */
    checkBudget(
      scope: BudgetCapScope,
      scopeId: string,
      provider: BudgetCapProvider
    ): BudgetCheckResult {
      const config = readConfig();
      const weekKey = currentWeekKey();
      const warnings: string[] = [];

      // 1. Night Shift reserve check
      const nsReserve = isNightShiftReserveBlocked(scope, weekKey, config);
      if (nsReserve.blocked) {
        logger.warn("budgetCap.nightShiftReserveBlocked", { scope, scopeId, reason: nsReserve.reason });
        return {
          allowed: false,
          reason: nsReserve.reason,
          warnings: [nsReserve.reason!]
        };
      }

      // 2. Alert threshold check (soft warning)
      const alertAt = config.alertAtWeeklyPercent;
      if (alertAt != null && alertAt > 0) {
        const snapshot = usageTrackingService?.getSnapshot();
        if (snapshot) {
          const weeklyWindows = snapshot.windows.filter((w) => w.windowType === "weekly");
          const maxPct = weeklyWindows.length > 0 ? Math.max(...weeklyWindows.map((w) => w.percentUsed)) : 0;
          if (maxPct >= alertAt) {
            const msg = `Weekly usage at ${maxPct.toFixed(1)}% has reached alert threshold of ${alertAt}%`;
            warnings.push(msg);
            logger.warn("budgetCap.alertThreshold", { scope, scopeId, maxPct, alertAt });
          }
        }
      }

      // 3. Preset-based global cap check
      if (config.preset) {
        const presetLimit = presetToWeeklyPercent(config.preset);
        const snapshot = usageTrackingService?.getSnapshot();
        if (snapshot) {
          const weeklyWindows = snapshot.windows.filter((w) => w.windowType === "weekly");
          const maxPct = weeklyWindows.length > 0 ? Math.max(...weeklyWindows.map((w) => w.percentUsed)) : 0;
          if (maxPct >= presetLimit) {
            const reason = `Budget preset "${config.preset}" cap of ${presetLimit}% exceeded (current: ${maxPct.toFixed(1)}%)`;
            logger.warn("budgetCap.presetExceeded", { scope, scopeId, preset: config.preset, presetLimit, maxPct });
            return { allowed: false, reason, remainingPercent: 0, warnings };
          }
        }
      }

      // 4. Evaluate explicit budget caps
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
     * Record usage after an automation/Night Shift run completes.
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

    /** Exposed for testing. */
    _currentWeekKey: currentWeekKey
  };
}
