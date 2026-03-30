import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
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
      trigger: { type: "git.commit" as const, branch: "main" },
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

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService
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

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService
    });

    const run = await service.triggerManually({ id: "echo" });
    expect(run.status).toBe("succeeded");

    const actionRows = raw.exec("select status, output from automation_action_results");
    const mapped = mapExecRows(actionRows);
    expect(mapped.length).toBe(1);
    expect(String(mapped[0]?.status)).toBe("succeeded");
    expect(String(mapped[0]?.output ?? "")).toContain("hello");
  });

  it("rejects run-command cwd values that escape through symlinks", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-runtime-root-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-runtime-outside-"));
    const symlinkPath = path.join(projectRoot, "linked-outside");
    fs.symlinkSync(outsideDir, symlinkPath);

    const rule = {
      id: "escape",
      name: "Escape",
      trigger: { type: "manual" as const },
      actions: [{ type: "run-command" as const, command: "echo hello", cwd: "linked-outside", timeoutMs: 10_000 }],
      enabled: true
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [],
      getLaneWorktreePath: () => projectRoot,
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
    } as any;

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService
    });

    try {
      const run = await service.triggerManually({ id: "escape" });
      expect(run.status).toBe("failed");
      expect(run.errorMessage).toContain("Unsafe cwd");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("computes nextRunAt for scheduled rules", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = "/tmp";

    const rule = {
      id: "daily",
      name: "Daily summary",
      triggers: [{ type: "schedule" as const, cron: "0 9 * * 1-5" }],
      trigger: { type: "schedule" as const, cron: "0 9 * * 1-5" },
      actions: [],
      enabled: true,
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        shared: {},
        local: { automations: [rule] },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [],
      getLaneWorktreePath: () => projectRoot,
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
    } as any;

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService
    });

    const listed = service.list();
    expect(listed[0]?.nextRunAt).toBeTruthy();
  });

  it("dispatches git.pr_merged automations on merge transitions", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = "/tmp";

    const rule = {
      id: "on-pr-merge",
      name: "On PR merge",
      triggers: [{ type: "git.pr_merged" as const, targetBranch: "main" }],
      trigger: { type: "git.pr_merged" as const, targetBranch: "main" },
      actions: [{ type: "run-command" as const, command: "echo merged", timeoutMs: 10_000 }],
      enabled: true
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [],
      getLaneWorktreePath: () => projectRoot,
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "feat/demo", worktreePath: projectRoot })
    } as any;

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService
    });

    service.onPullRequestChanged({
      pr: {
        id: "pr-1",
        laneId: "lane1",
        projectId: "proj",
        repoOwner: "acme",
        repoName: "ade",
        githubPrNumber: 42,
        githubUrl: "https://github.com/acme/ade/pull/42",
        githubNodeId: null,
        title: "Ship automation upgrades",
        state: "merged",
        baseBranch: "main",
        headBranch: "feat/demo",
        checksStatus: "passing",
        reviewStatus: "approved",
        additions: 10,
        deletions: 2,
        lastSyncedAt: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      previousState: "open",
    });

    const start = Date.now();
    while (Date.now() - start < 3_000) {
      const rows = mapExecRows(raw.exec("select status from automation_runs where automation_id = 'on-pr-merge'"));
      if (rows.length) {
        expect(String(rows[0]?.status)).toMatch(/succeeded|failed|running/);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    throw new Error("Timed out waiting for PR merge automation run");
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

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService
    });

    await expect(service.triggerManually({ id: "echo" })).rejects.toThrow(/untrusted/i);
  });

  it("runs agent-session automations in plan mode when publish verification is required", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-agent-session-"));
    const createSession = vi.fn(async () => ({ id: "session-1" }));
    const runSessionTurn = vi.fn(async () => ({ outputText: "Prepared a review summary." }));

    const rule = {
      id: "agent-review",
      name: "Agent review",
      enabled: true,
      mode: "review",
      reviewProfile: "quick",
      trigger: { type: "manual" as const },
      triggers: [{ type: "manual" as const }],
      executor: { mode: "automation-bot", targetId: null },
      toolPalette: ["github"] as const,
      contextSources: [],
      memory: { mode: "project" as const },
      guardrails: { maxDurationMin: 5 },
      outputs: { disposition: "comment-only" as const, createArtifact: true },
      verification: { verifyBeforePublish: true, mode: "intervention" as const },
      billingCode: "auto:test",
      execution: {
        kind: "agent-session" as const,
        session: { title: "Review output" },
      },
      modelConfig: {
        orchestratorModel: {
          modelId: "openai/gpt-5.4-codex",
          thinkingLevel: "medium",
        },
      },
      prompt: "Review the latest PR status.",
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [{ id: "lane-1", laneType: "primary" }],
      getLaneWorktreePath: () => projectRoot,
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
    } as any;

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      agentChatService: {
        createSession,
        runSessionTurn,
      } as any,
    });

    try {
      const run = await service.triggerManually({ id: "agent-review" });
      expect(run.status).toBe("succeeded");
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
        permissionMode: "plan",
      }));
      const row = mapExecRows(raw.exec("select queue_status from automation_runs where automation_id = 'agent-review'"))[0];
      expect(String(row?.queue_status)).toBe("verification-required");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("blocks agent-session automations when the budget cap rejects the run", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-budget-"));
    const createSession = vi.fn(async () => ({ id: "session-1" }));

    const rule = {
      id: "agent-budget",
      name: "Agent budget",
      enabled: true,
      mode: "review",
      reviewProfile: "quick",
      trigger: { type: "manual" as const },
      triggers: [{ type: "manual" as const }],
      executor: { mode: "automation-bot", targetId: null },
      toolPalette: [] as const,
      contextSources: [],
      memory: { mode: "project" as const },
      guardrails: { maxDurationMin: 5 },
      outputs: { disposition: "comment-only" as const, createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" as const },
      billingCode: "auto:test",
      execution: {
        kind: "agent-session" as const,
      },
      prompt: "Summarize the current state.",
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [{ id: "lane-1", laneType: "primary" }],
      getLaneWorktreePath: () => projectRoot,
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
    } as any;

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      agentChatService: {
        createSession,
      } as any,
      budgetCapService: {
        checkBudget: vi.fn(() => ({ allowed: false, reason: "Budget exceeded" })),
      } as any,
    });

    try {
      await expect(service.triggerManually({ id: "agent-budget" })).rejects.toThrow("Budget exceeded");
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

});
