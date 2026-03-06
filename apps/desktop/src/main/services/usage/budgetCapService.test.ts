import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { createBudgetCapService } from "./budgetCapService";
import type {
  BudgetCapConfig,
  BudgetCapScope,
  BudgetCapProvider,
  UsageSnapshot
} from "../../../shared/types/usage";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type SqlValue = string | number | null | Uint8Array;

function mapExecRows(rows: { columns: string[]; values: unknown[][] }[]): Record<string, unknown>[] {
  const first = rows[0];
  if (!first) return [];
  const { columns, values } = first;
  const out: Record<string, unknown>[] = [];
  for (const row of values) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i] ?? String(i)] = row[i];
    }
    out.push(obj);
  }
  return out;
}

let SQL: SqlJsStatic;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const wasmDir = path.dirname(wasmPath);
  SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir, file)
  });
});

function createInMemoryDb() {
  const raw = new SQL.Database();
  raw.run(`
    create table budget_usage_records (
      id text primary key,
      scope text not null,
      scope_id text not null,
      provider text not null,
      tokens_used integer not null default 0,
      cost_usd real not null default 0,
      week_key text not null,
      recorded_at text not null
    )
  `);
  raw.run("create index idx_budget_scope_week on budget_usage_records(scope, scope_id, week_key)");

  const run = (sql: string, params: SqlValue[] = []) => raw.run(sql, params);
  const all = <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: SqlValue[] = []
  ): T[] => mapExecRows(raw.exec(sql, params)) as T[];
  const get = <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: SqlValue[] = []
  ): T | null => all<T>(sql, params)[0] ?? null;

  return {
    raw,
    db: {
      run,
      all,
      get,
      getJson: () => null,
      setJson: () => {},
      flushNow: () => {},
      close: () => raw.close()
    } as any
  };
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function createMockConfigService(usageConfig: BudgetCapConfig = {}) {
  return {
    getEffective: () => ({}),
    get: () => ({ local: { usage: usageConfig }, shared: {}, effective: {}, validation: { ok: true, issues: [] }, trust: { sharedHash: "", localHash: "", approvedSharedHash: null, requiresSharedTrust: false }, paths: { sharedPath: "", localPath: "" } })
  };
}

function createMockUsageTrackingService(snapshot: UsageSnapshot | null = null) {
  return { getSnapshot: () => snapshot };
}

function makeUsageSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    windows: [],
    pacing: { status: "on-track", projectedWeeklyPercent: 50, weekElapsedPercent: 50 },
    costs: [],
    lastPolledAt: new Date().toISOString(),
    errors: [],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("budgetCapService", () => {
  describe("recordUsage", () => {
    it("inserts a budget usage record", () => {
      const { db, raw } = createInMemoryDb();
      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService()
      });

      svc.recordUsage("automation-rule", "rule-1", {
        tokensUsed: 5000,
        costUsd: 0.15,
        provider: "claude"
      });

      const rows = mapExecRows(raw.exec("select * from budget_usage_records"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.scope).toBe("automation-rule");
      expect(rows[0]!.scope_id).toBe("rule-1");
      expect(rows[0]!.provider).toBe("claude");
      expect(rows[0]!.tokens_used).toBe(5000);
      expect(rows[0]!.cost_usd).toBe(0.15);
    });

    it("records multiple entries and accumulates", () => {
      const { db } = createInMemoryDb();
      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService()
      });

      svc.recordUsage("automation-rule", "rule-1", { tokensUsed: 1000, costUsd: 0.05, provider: "claude" });
      svc.recordUsage("automation-rule", "rule-1", { tokensUsed: 2000, costUsd: 0.10, provider: "claude" });

      const result = svc.getCumulativeUsage("automation-rule", "rule-1", "claude");
      expect(result.totalTokens).toBe(3000);
      expect(result.totalCostUsd).toBeCloseTo(0.15);
    });
  });

  describe("getCumulativeUsage", () => {
    it("returns zero for no records", () => {
      const { db } = createInMemoryDb();
      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService()
      });

      const result = svc.getCumulativeUsage("global", "all");
      expect(result.totalTokens).toBe(0);
      expect(result.totalCostUsd).toBe(0);
    });

    it("filters by provider when specified", () => {
      const { db } = createInMemoryDb();
      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService()
      });

      svc.recordUsage("automation-rule", "rule-1", { tokensUsed: 1000, costUsd: 0.05, provider: "claude" });
      svc.recordUsage("automation-rule", "rule-1", { tokensUsed: 2000, costUsd: 0.10, provider: "codex" });

      const claudeResult = svc.getCumulativeUsage("automation-rule", "rule-1", "claude");
      expect(claudeResult.totalTokens).toBe(1000);

      const anyResult = svc.getCumulativeUsage("automation-rule", "rule-1", "any");
      expect(anyResult.totalTokens).toBe(3000);
    });
  });

  describe("getGlobalCumulativeUsage", () => {
    it("sums across all scopes", () => {
      const { db } = createInMemoryDb();
      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService()
      });

      svc.recordUsage("automation-rule", "rule-1", { tokensUsed: 1000, costUsd: 0.05, provider: "claude" });
      svc.recordUsage("night-shift-run", "ns-1", { tokensUsed: 3000, costUsd: 0.20, provider: "claude" });

      const result = svc.getGlobalCumulativeUsage("any");
      expect(result.totalTokens).toBe(4000);
      expect(result.totalCostUsd).toBeCloseTo(0.25);
    });
  });

  describe("checkBudget", () => {
    it("allows when no caps are configured", () => {
      const { db } = createInMemoryDb();
      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService()
      });

      const result = svc.checkBudget("automation-rule", "rule-1", "claude");
      expect(result.allowed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it("blocks when weekly-percent cap is exceeded", () => {
      const { db } = createInMemoryDb();
      const usageSnapshot = makeUsageSnapshot({
        windows: [
          { provider: "claude" as any, windowType: "weekly", percentUsed: 92, resetsAt: "", resetsInMs: 0 }
        ]
      });

      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          budgetCaps: [
            { scope: "global", capType: "weekly-percent", provider: "any", limit: 90, action: "block" }
          ]
        }),
        usageTrackingService: createMockUsageTrackingService(usageSnapshot)
      });

      const result = svc.checkBudget("automation-rule", "rule-1", "claude");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("exceeds cap of 90%");
    });

    it("warns but allows when cap action is warn", () => {
      const { db } = createInMemoryDb();
      const usageSnapshot = makeUsageSnapshot({
        windows: [
          { provider: "claude" as any, windowType: "weekly", percentUsed: 92, resetsAt: "", resetsInMs: 0 }
        ]
      });

      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          budgetCaps: [
            { scope: "global", capType: "weekly-percent", provider: "any", limit: 90, action: "warn" }
          ]
        }),
        usageTrackingService: createMockUsageTrackingService(usageSnapshot)
      });

      const result = svc.checkBudget("automation-rule", "rule-1", "claude");
      expect(result.allowed).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("exceeds cap of 90%");
    });

    it("blocks when usd-per-run cap is exceeded", () => {
      const { db } = createInMemoryDb();
      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          budgetCaps: [
            { scope: "automation-rule", capType: "usd-per-run", provider: "any", limit: 1.0, action: "block" }
          ]
        })
      });

      // Accumulate usage past the cap
      svc.recordUsage("automation-rule", "rule-1", { tokensUsed: 50000, costUsd: 0.60, provider: "claude" });
      svc.recordUsage("automation-rule", "rule-1", { tokensUsed: 50000, costUsd: 0.50, provider: "claude" });

      const result = svc.checkBudget("automation-rule", "rule-1", "any");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("exceeds cap of $1.00");
      expect(result.remainingUsd).toBe(0);
    });

    it("allows when under usd-per-run cap", () => {
      const { db } = createInMemoryDb();
      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          budgetCaps: [
            { scope: "automation-rule", capType: "usd-per-run", provider: "any", limit: 5.0, action: "block" }
          ]
        })
      });

      svc.recordUsage("automation-rule", "rule-1", { tokensUsed: 10000, costUsd: 0.50, provider: "claude" });

      const result = svc.checkBudget("automation-rule", "rule-1", "any");
      expect(result.allowed).toBe(true);
      expect(result.remainingUsd).toBeCloseTo(4.5);
    });

    it("blocks Night Shift reserve for daytime automations", () => {
      const { db } = createInMemoryDb();
      const usageSnapshot = makeUsageSnapshot({
        windows: [
          { provider: "claude" as any, windowType: "weekly", percentUsed: 85, resetsAt: "", resetsInMs: 0 }
        ]
      });

      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          nightShiftReservePercent: 20
        }),
        usageTrackingService: createMockUsageTrackingService(usageSnapshot)
      });

      // Daytime automation should be blocked (85% >= 80% = 100-20)
      const result = svc.checkBudget("automation-rule", "rule-1", "claude");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Night Shift reserve");
    });

    it("allows Night Shift runs even when reserve is active", () => {
      const { db } = createInMemoryDb();
      const usageSnapshot = makeUsageSnapshot({
        windows: [
          { provider: "claude" as any, windowType: "weekly", percentUsed: 85, resetsAt: "", resetsInMs: 0 }
        ]
      });

      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          nightShiftReservePercent: 20
        }),
        usageTrackingService: createMockUsageTrackingService(usageSnapshot)
      });

      // Night shift scope should pass through
      const result = svc.checkBudget("night-shift-run", "ns-1", "claude");
      expect(result.allowed).toBe(true);
    });

    it("emits alert threshold warning", () => {
      const { db } = createInMemoryDb();
      const usageSnapshot = makeUsageSnapshot({
        windows: [
          { provider: "claude" as any, windowType: "weekly", percentUsed: 82, resetsAt: "", resetsInMs: 0 }
        ]
      });

      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          alertAtWeeklyPercent: 80
        }),
        usageTrackingService: createMockUsageTrackingService(usageSnapshot)
      });

      const result = svc.checkBudget("automation-rule", "rule-1", "claude");
      expect(result.allowed).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("alert threshold of 80%");
    });

    it("blocks when preset cap is exceeded", () => {
      const { db } = createInMemoryDb();
      const usageSnapshot = makeUsageSnapshot({
        windows: [
          { provider: "claude" as any, windowType: "weekly", percentUsed: 65, resetsAt: "", resetsInMs: 0 }
        ]
      });

      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          preset: "conservative" // 60%
        }),
        usageTrackingService: createMockUsageTrackingService(usageSnapshot)
      });

      const result = svc.checkBudget("automation-rule", "rule-1", "claude");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("conservative");
      expect(result.reason).toContain("60%");
    });

    it("allows when under preset cap", () => {
      const { db } = createInMemoryDb();
      const usageSnapshot = makeUsageSnapshot({
        windows: [
          { provider: "claude" as any, windowType: "weekly", percentUsed: 50, resetsAt: "", resetsInMs: 0 }
        ]
      });

      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          preset: "conservative" // 60%
        }),
        usageTrackingService: createMockUsageTrackingService(usageSnapshot)
      });

      const result = svc.checkBudget("automation-rule", "rule-1", "claude");
      expect(result.allowed).toBe(true);
    });

    it("handles five-hour-percent cap", () => {
      const { db } = createInMemoryDb();
      const usageSnapshot = makeUsageSnapshot({
        windows: [
          { provider: "claude" as any, windowType: "five_hour", percentUsed: 95, resetsAt: "", resetsInMs: 0 }
        ]
      });

      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          budgetCaps: [
            { scope: "global", capType: "five-hour-percent", provider: "any", limit: 90, action: "block" }
          ]
        }),
        usageTrackingService: createMockUsageTrackingService(usageSnapshot)
      });

      const result = svc.checkBudget("automation-rule", "rule-1", "claude");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("5-hour usage");
    });

    it("handles multiple caps - block wins over warn", () => {
      const { db } = createInMemoryDb();
      const usageSnapshot = makeUsageSnapshot({
        windows: [
          { provider: "claude" as any, windowType: "weekly", percentUsed: 95, resetsAt: "", resetsInMs: 0 }
        ]
      });

      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          budgetCaps: [
            { scope: "global", capType: "weekly-percent", provider: "any", limit: 90, action: "warn" },
            { scope: "global", capType: "weekly-percent", provider: "any", limit: 95, action: "block" }
          ]
        }),
        usageTrackingService: createMockUsageTrackingService(usageSnapshot)
      });

      const result = svc.checkBudget("automation-rule", "rule-1", "claude");
      expect(result.allowed).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("scoped caps only match their scope", () => {
      const { db } = createInMemoryDb();
      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService({
          budgetCaps: [
            { scope: "automation-rule", scopeId: "rule-X", capType: "usd-per-run", provider: "any", limit: 1.0, action: "block" }
          ]
        })
      });

      svc.recordUsage("automation-rule", "rule-X", { tokensUsed: 100000, costUsd: 5.0, provider: "claude" });

      // rule-X should be blocked
      const blockedResult = svc.checkBudget("automation-rule", "rule-X", "any");
      expect(blockedResult.allowed).toBe(false);

      // rule-Y should pass (different scopeId)
      const passResult = svc.checkBudget("automation-rule", "rule-Y", "any");
      expect(passResult.allowed).toBe(true);
    });
  });

  describe("getConfig", () => {
    it("returns the config from project config service", () => {
      const { db } = createInMemoryDb();
      const config: BudgetCapConfig = {
        nightShiftReservePercent: 20,
        alertAtWeeklyPercent: 80,
        preset: "conservative"
      };
      const svc = createBudgetCapService({
        db,
        logger: createLogger(),
        projectConfigService: createMockConfigService(config)
      });

      const result = svc.getConfig();
      expect(result.nightShiftReservePercent).toBe(20);
      expect(result.preset).toBe("conservative");
    });
  });
});
