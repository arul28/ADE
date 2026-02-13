import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { createAutomationService } from "./automationService";

type SqlValue = string | number | null | Uint8Array;

type AdeDb = {
  run: (sql: string, params?: SqlValue[]) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T | null;
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T[];
};

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

function createInMemoryAdeDb(): { db: AdeDb; raw: Database } {
  const raw = new SQL.Database();
  raw.run(`
    create table automation_runs(
      id text primary key,
      project_id text not null,
      automation_id text not null,
      trigger_type text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      actions_completed integer not null,
      actions_total integer not null,
      error_message text,
      trigger_metadata text
    )
  `);
  raw.run(`
    create table automation_action_results(
      id text primary key,
      project_id text not null,
      run_id text not null,
      action_index integer not null,
      action_type text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      error_message text,
      output text
    )
  `);

  const run = (sql: string, params: SqlValue[] = []) => raw.run(sql, params);
  const all = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] =>
    mapExecRows(raw.exec(sql, params)) as T[];
  const get = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | null =>
    all<T>(sql, params)[0] ?? null;

  return { raw, db: { run, all, get } };
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

describe("automationService integration", () => {
  it("dispatches commit trigger and logs the run", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = "/tmp";

    const rule = {
      id: "on-commit",
      name: "On commit",
      trigger: { type: "commit" as const, branch: "main" },
      actions: [{ type: "run-command" as const, command: "echo commit", timeoutMs: 10_000 }],
      enabled: true
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [{ id: "lane1", laneType: "primary", branchRef: "main" }],
      getLaneWorktreePath: () => projectRoot,
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
    } as any;

    const packService = { refreshLanePack: async () => {}, refreshProjectPack: async () => {} } as any;

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      packService
    });

    service.onHeadChanged({ laneId: "lane1", preHeadSha: null, postHeadSha: "abc", reason: "test" });

    const start = Date.now();
    while (Date.now() - start < 3_000) {
      const rows = mapExecRows(raw.exec("select status from automation_runs where automation_id = 'on-commit'"));
      if (rows.length) {
        expect(String(rows[0]?.status)).toMatch(/succeeded|failed|running/);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Timed out waiting for commit automation run");
  });

  it("logs a successful run-command execution", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = "/tmp";

    const rule = {
      id: "echo",
      name: "Echo",
      trigger: { type: "manual" as const },
      actions: [{ type: "run-command" as const, command: "echo hello", timeoutMs: 10_000 }],
      enabled: true
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      }),
      save: () => {
        throw new Error("not used");
      }
    } as any;

    const laneService = {
      list: async () => [],
      getLaneWorktreePath: () => projectRoot,
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
    } as any;

    const packService = { refreshLanePack: async () => {}, refreshProjectPack: async () => {} } as any;

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      packService
    });

    const run = await service.triggerManually({ id: "echo" });
    expect(run.status).toBe("succeeded");

    const actionRows = raw.exec("select status, output from automation_action_results");
    const mapped = mapExecRows(actionRows);
    expect(mapped.length).toBe(1);
    expect(String(mapped[0]?.status)).toBe("succeeded");
    expect(String(mapped[0]?.output ?? "")).toContain("hello");
  });

  it("blocks sync-to-mirror without calling hosted services", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = "/tmp";

    const rule = {
      id: "mirror",
      name: "Mirror",
      trigger: { type: "manual" as const },
      actions: [{ type: "sync-to-mirror" as const }],
      enabled: true
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      }),
      save: () => {
        throw new Error("not used");
      }
    } as any;

    const laneService = {
      list: async () => [],
      getLaneWorktreePath: () => projectRoot,
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
    } as any;

    const packService = { refreshLanePack: async () => {}, refreshProjectPack: async () => {} } as any;

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      packService
    });

    const run = await service.triggerManually({ id: "mirror" });
    expect(run.status).toBe("failed");

    const actionRows = raw.exec("select status, error_message from automation_action_results");
    const mapped = mapExecRows(actionRows);
    expect(String(mapped[0]?.status)).toBe("failed");
    expect(String(mapped[0]?.error_message ?? "")).toContain("not supported");
  });

  it("blocks execution when shared config trust is required", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = "/tmp";

    const rule = {
      id: "echo",
      name: "Echo",
      trigger: { type: "manual" as const },
      actions: [{ type: "run-command" as const, command: "echo hello", timeoutMs: 10_000 }],
      enabled: true
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: true },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [],
      getLaneWorktreePath: () => projectRoot,
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
    } as any;

    const packService = { refreshLanePack: async () => {}, refreshProjectPack: async () => {} } as any;

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      packService
    });

    await expect(service.triggerManually({ id: "echo" })).rejects.toThrow(/untrusted/i);
  });
});
