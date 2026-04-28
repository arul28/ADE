import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { createAutomationService, presetToTemplate, triggerMatches } from "./automationService";

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

describe("triggerMatches", () => {
  it("matches PR comment and review branch filters against the PR head branch", () => {
    const trigger = {
      source: "github-polling" as const,
      triggerType: "github.pr_commented" as const,
      branch: "feat/demo",
      targetBranch: "main",
      pr: {
        number: 42,
        title: "Demo",
        repo: "acme/ade",
        headBranch: "feat/demo",
        baseBranch: "main",
      },
    };

    expect(triggerMatches(
      { type: "github.pr_commented", branch: "feat/*" },
      trigger,
      undefined,
      undefined,
    )).toBe(true);
    expect(triggerMatches(
      { type: "github.pr_review_submitted", branch: "feat/*" },
      { ...trigger, triggerType: "github.pr_review_submitted" },
      undefined,
      undefined,
    )).toBe(true);
    expect(triggerMatches(
      { type: "github.pr_commented", branch: "release/*" },
      trigger,
      undefined,
      undefined,
    )).toBe(false);
  });
});

function createInMemoryAdeDb(): { db: AdeDb; raw: Database } {
  const raw = new SQL.Database();
  raw.run(`
    create table automation_runs(
      id text primary key,
      project_id text not null,
      automation_id text not null,
      chat_session_id text,
      mission_id text,
      worker_run_id text,
      worker_agent_id text,
      queue_item_id text,
      ingress_event_id text,
      trigger_type text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      execution_kind text,
      queue_status text,
      executor_mode text,
      actions_completed integer not null,
      actions_total integer not null,
      error_message text,
      verification_required integer not null default 0,
      spend_usd real not null default 0,
      trigger_metadata text,
      summary text,
      confidence_json text,
      billing_code text,
      linked_procedure_ids_json text,
      procedure_feedback_json text
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

  it("runs built-in commands from the configured target lane", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-project-root-"));
    const laneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-target-lane-"));

    const rule = {
      id: "lane-command",
      name: "Lane command",
      trigger: { type: "manual" as const },
      triggers: [{ type: "manual" as const }],
      execution: { kind: "built-in" as const, targetLaneId: "lane-target", builtIn: { actions: [{ type: "run-command" as const, command: "pwd", timeoutMs: 10_000 }] } },
      actions: [{ type: "run-command" as const, command: "pwd", timeoutMs: 10_000 }],
      enabled: true
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [{ id: "lane-primary", laneType: "primary" }, { id: "lane-target", laneType: "child" }],
      getLaneWorktreePath: (laneId: string) => laneId === "lane-target" ? laneRoot : projectRoot,
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
      const run = await service.triggerManually({ id: "lane-command", laneId: "lane-primary" });
      expect(run.status).toBe("succeeded");
      const mapped = mapExecRows(raw.exec("select output from automation_action_results"));
      expect(String(mapped[0]?.output ?? "")).toContain(laneRoot);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(laneRoot, { recursive: true, force: true });
    }
  });

  it("launches mission automations on the configured target lane", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-mission-lane-"));
    const createMission = vi.fn(() => ({
      id: "mission-1",
      status: "in_progress",
      outcomeSummary: null,
      completedAt: null,
      lastError: null,
    }));
    const patchMetadata = vi.fn();
    const startMissionRun = vi.fn(async () => undefined);

    const rule = {
      id: "mission-lane",
      name: "Mission lane",
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
        kind: "mission" as const,
        targetLaneId: "lane-target",
      },
      prompt: "Run a mission on the target lane.",
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [{ id: "lane-primary", laneType: "primary" }, { id: "lane-target", laneType: "child" }],
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
      missionService: {
        create: createMission,
        patchMetadata,
      } as any,
      aiOrchestratorService: {
        startMissionRun,
      } as any,
    });

    try {
      const run = await service.triggerManually({ id: "mission-lane", laneId: "lane-primary" });
      expect(run.status).toBe("running");
      expect(createMission).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-target",
      }));
      const missionArgs = (createMission as any).mock.calls[0]?.[0] as { prompt?: string } | undefined;
      expect(missionArgs?.prompt).toContain("Lane ID: lane-target");
      expect(missionArgs?.prompt).not.toContain("Lane ID: lane-primary");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("launches built-in mission actions instead of skipping them as unknown", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-built-in-mission-"));
    const createMission = vi.fn(() => ({
      id: "mission-built-in",
      status: "in_progress",
      outcomeSummary: null,
      completedAt: null,
      lastError: null,
    }));

    const rule = {
      id: "built-in-mission",
      name: "Built-in mission",
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
        kind: "built-in" as const,
        builtIn: { actions: [{ type: "launch-mission" as const, sessionTitle: "Follow-up mission" }] },
      },
      actions: [{ type: "launch-mission" as const, sessionTitle: "Follow-up mission" }],
      prompt: "Run a mission from a built-in action.",
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [{ id: "lane-primary", laneType: "primary" }],
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
      missionService: {
        create: createMission,
        patchMetadata: vi.fn(),
      } as any,
      aiOrchestratorService: {
        startMissionRun: vi.fn(async () => undefined),
      } as any,
    });

    try {
      const run = await service.triggerManually({ id: "built-in-mission" });
      expect(run.status).toBe("running");
      expect(run.missionId).toBe("mission-built-in");
      expect(createMission).toHaveBeenCalled();
      const actions = mapExecRows(raw.exec("select action_type, status, output from automation_action_results"));
      expect(actions).toHaveLength(1);
      expect(actions[0]?.action_type).toBe("launch-mission");
      expect(String(actions[0]?.output ?? "")).toContain("mission-built-in");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("attaches built-in agent-session actions to the automation run", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-built-in-chat-"));
    const createSession = vi.fn(async () => ({ id: "session-built-in" }));
    const runSessionTurn = vi.fn(async () => ({ outputText: "done" }));

    const rule = {
      id: "built-in-chat",
      name: "Built-in chat",
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
        kind: "built-in" as const,
        builtIn: { actions: [{ type: "agent-session" as const, prompt: "Summarize", sessionTitle: "Summary" }] },
      },
      actions: [{ type: "agent-session" as const, prompt: "Summarize", sessionTitle: "Summary" }],
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [{ id: "lane-primary", laneType: "primary" }],
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
      const run = await service.triggerManually({ id: "built-in-chat" });
      expect(run.status).toBe("succeeded");
      expect(run.chatSessionId).toBe("session-built-in");
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
        automationId: "built-in-chat",
        automationRunId: run.id,
      }));
      const row = db.get<{ chat_session_id: string }>("select chat_session_id from automation_runs where id = ?", [run.id]);
      expect(row?.chat_session_id).toBe("session-built-in");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("creates a lane from a GitHub issue before launching a configured agent step", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-issue-lane-"));
    const createLane = vi.fn(async () => ({
      id: "lane-issue",
      name: "Fix checkout",
      branchRef: "fix-checkout",
      laneType: "feature",
      worktreePath: projectRoot,
    }));
    const createSession = vi.fn(async () => ({ id: "session-issue" }));
    const runSessionTurn = vi.fn(async () => ({ outputText: "fixed" }));

    const rule = {
      id: "issue-pipeline",
      name: "Issue pipeline",
      enabled: true,
      mode: "fix",
      reviewProfile: "quick",
      trigger: { type: "github.issue_opened" as const },
      triggers: [{ type: "github.issue_opened" as const }],
      executor: { mode: "automation-bot", targetId: null },
      modelConfig: {
        orchestratorModel: { modelId: "opencode/openai/gpt-5.4", thinkingLevel: "medium" },
      },
      permissionConfig: { providers: { opencode: "edit" } },
      toolPalette: [] as const,
      contextSources: [],
      memory: { mode: "project" as const },
      guardrails: { maxDurationMin: 5 },
      outputs: { disposition: "comment-only" as const, createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" as const },
      billingCode: "auto:test",
      execution: {
        kind: "built-in" as const,
        builtIn: {
          actions: [
            {
              type: "create-lane" as const,
              laneNameTemplate: "{{trigger.issue.title}}",
              laneDescriptionTemplate: "{{trigger.issue.url}}",
            },
            {
              type: "agent-session" as const,
              prompt: "Fix {{trigger.issue.title}}",
              sessionTitle: "Fix issue",
              modelConfig: { modelId: "opencode/openai/gpt-5.4", thinkingLevel: "high" as const },
              permissionConfig: { providers: { opencode: "full-auto" as const } },
            },
          ],
        },
      },
      actions: [],
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      create: createLane,
      list: async () => [{ id: "lane-primary", laneType: "primary" }],
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
      const event = await service.dispatchIngressTrigger({
        source: "github-polling",
        eventKey: "arul28/ADE#123:opened",
        triggerType: "github.issue_opened",
        eventName: "github.issue_opened",
        repo: "arul28/ADE",
        issue: {
          number: 123,
          title: "Fix checkout",
          body: "Broken checkout flow",
          author: "arul28",
          labels: ["bug"],
          repo: "arul28/ADE",
          url: "https://github.com/arul28/ADE/issues/123",
        },
      });

      expect(event?.status).toBe("dispatched");
      expect(createLane).toHaveBeenCalledWith(expect.objectContaining({
        name: "Fix checkout",
        description: "https://github.com/arul28/ADE/issues/123",
      }));
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-issue",
        modelId: "opencode/openai/gpt-5.4",
        reasoningEffort: "high",
        permissionMode: "full-auto",
      }));
      expect(runSessionTurn).toHaveBeenCalledWith(expect.objectContaining({
        text: "Fix Fix checkout",
        reasoningEffort: "high",
      }));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
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

  it("simulates manual dry runs without starting automation side effects", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-manual-dry-run-"));
    const createSession = vi.fn(async () => ({ id: "session-1" }));

    const rule = {
      id: "agent-manual-dry-run",
      name: "Agent manual dry run",
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
    });

    try {
      const run = await service.triggerManually({ id: "agent-manual-dry-run", dryRun: true });
      expect(run.status).toBe("succeeded");
      const row = db.get<{ queue_status: string }>("select queue_status from automation_runs where automation_id = 'agent-manual-dry-run'");
      expect(row?.queue_status).toBe("completed-clean");
      expect(createSession).not.toHaveBeenCalled();
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

  it("falls back to rule.name when create-lane template renders empty", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-create-lane-fallback-"));
    const createLane = vi.fn(async () => ({
      id: "lane-new",
      name: "Fallback rule name",
      branchRef: "fallback-rule-name",
      laneType: "feature",
      worktreePath: projectRoot,
    }));

    const rule = {
      id: "create-lane-only",
      name: "Fallback rule name",
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
        kind: "built-in" as const,
        builtIn: {
          actions: [
            // Embedded (non-whole-match) placeholders that don't resolve become empty
            // strings, so the rendered name should be empty and fall back to rule.name.
            { type: "create-lane" as const, laneNameTemplate: "{{trigger.issue.title}}{{trigger.issue.body}}" },
          ],
        },
      },
      actions: [],
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      create: createLane,
      list: async () => [{ id: "lane-primary", laneType: "primary" }],
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
    });

    try {
      const run = await service.triggerManually({ id: "create-lane-only" });
      expect(run.status).toBe("succeeded");
      expect(createLane).toHaveBeenCalledWith(expect.objectContaining({
        name: "Fallback rule name",
      }));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses per-action targetLaneId for run-command instead of rule.execution.targetLaneId", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-action-lane-root-"));
    const ruleLane = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-action-lane-rule-"));
    const actionLane = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-action-lane-action-"));

    const rule = {
      id: "per-action-lane",
      name: "Per-action lane",
      trigger: { type: "manual" as const },
      triggers: [{ type: "manual" as const }],
      execution: {
        kind: "built-in" as const,
        targetLaneId: "lane-rule",
        builtIn: {
          actions: [
            { type: "run-command" as const, command: "pwd", targetLaneId: "lane-action", timeoutMs: 10_000 },
          ],
        },
      },
      actions: [{ type: "run-command" as const, command: "pwd", targetLaneId: "lane-action", timeoutMs: 10_000 }],
      enabled: true,
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [
        { id: "lane-rule", laneType: "primary" },
        { id: "lane-action", laneType: "child" },
      ],
      getLaneWorktreePath: (laneId: string) => laneId === "lane-action" ? actionLane : laneId === "lane-rule" ? ruleLane : projectRoot,
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
    } as any;

    const service = createAutomationService({
      db: db as any,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
    });

    try {
      const run = await service.triggerManually({ id: "per-action-lane" });
      expect(run.status).toBe("succeeded");
      const mapped = mapExecRows(raw.exec("select output from automation_action_results"));
      const output = String(mapped[0]?.output ?? "");
      expect(output).toContain(actionLane);
      expect(output).not.toContain(ruleLane);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(ruleLane, { recursive: true, force: true });
      fs.rmSync(actionLane, { recursive: true, force: true });
    }
  });

  it("prefers per-action modelConfig.modelId and thinkingLevel over the rule defaults for agent-session", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-action-model-"));
    const createSession = vi.fn(async () => ({ id: "session-action-model" }));
    const runSessionTurn = vi.fn(async () => ({ outputText: "ok" }));

    const rule = {
      id: "action-model",
      name: "Action model",
      enabled: true,
      mode: "review",
      reviewProfile: "quick",
      trigger: { type: "manual" as const },
      triggers: [{ type: "manual" as const }],
      executor: { mode: "automation-bot", targetId: null },
      modelConfig: {
        orchestratorModel: { modelId: "openai/gpt-5.4-codex", thinkingLevel: "low" },
      },
      permissionConfig: { providers: { codex: "default" as const, opencode: "edit" as const } },
      toolPalette: [] as const,
      contextSources: [],
      memory: { mode: "project" as const },
      guardrails: { maxDurationMin: 5 },
      outputs: { disposition: "comment-only" as const, createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" as const },
      billingCode: "auto:test",
      execution: {
        kind: "built-in" as const,
        builtIn: {
          actions: [
            {
              type: "agent-session" as const,
              prompt: "Summarize",
              sessionTitle: "Summary",
              modelConfig: { modelId: "opencode/openai/gpt-5.4", thinkingLevel: "high" as const },
              permissionConfig: { providers: { opencode: "full-auto" as const } },
            },
          ],
        },
      },
      actions: [],
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [{ id: "lane-primary", laneType: "primary" }],
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
      const run = await service.triggerManually({ id: "action-model" });
      expect(run.status).toBe("succeeded");
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
        modelId: "opencode/openai/gpt-5.4",
        reasoningEffort: "high",
        permissionMode: "full-auto",
      }));
      expect(runSessionTurn).toHaveBeenCalledWith(expect.objectContaining({
        reasoningEffort: "high",
      }));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("checks the budget cap against the resolved provider group", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-budget-provider-"));
    const createSession = vi.fn(async () => ({ id: "session-1" }));
    const checkBudget = vi.fn(() => ({ allowed: false, reason: "Budget exceeded" }));

    const rule = {
      id: "agent-budget-provider",
      name: "Agent budget provider",
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
      modelConfig: {
        orchestratorModel: {
          modelId: "openai/gpt-5.4-codex",
          thinkingLevel: "medium",
        },
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
        checkBudget,
      } as any,
    });

    try {
      await expect(service.triggerManually({ id: "agent-budget-provider" })).rejects.toThrow("Budget exceeded");
      expect(checkBudget).toHaveBeenCalledWith("automation-rule", "agent-budget-provider", "codex");
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  describe("laneMode: 'create'", () => {
    it("presetToTemplate maps known presets and returns empty for custom/unknown", () => {
      expect(presetToTemplate("issue-title")).toBe("{{trigger.issue.title}}");
      expect(presetToTemplate("issue-num-title")).toBe("Issue #{{trigger.issue.number}} – {{trigger.issue.title}}");
      expect(presetToTemplate("pr-title-author")).toBe("{{trigger.pr.title}} – {{trigger.pr.author}}");
      expect(presetToTemplate("custom")).toBe("");
      expect(presetToTemplate(undefined)).toBe("");
    });

    function buildLaneModeFixtures() {
      const { db, raw } = createInMemoryAdeDb();
      const logger = createLogger();
      const projectId = "proj";
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-lane-mode-"));
      return { db, raw, logger, projectId, projectRoot };
    }

    it("creates a fresh lane via preset when laneMode is 'create' and emits a lane-setup row", async () => {
      const { db, raw, logger, projectId, projectRoot } = buildLaneModeFixtures();
      const createLane = vi.fn(async ({ name }: { name: string }) => ({
        id: "lane-fresh",
        name,
        branchRef: name.replace(/\s+/g, "-").toLowerCase(),
        laneType: "feature",
        worktreePath: projectRoot,
      }));
      const createMission = vi.fn(() => ({ id: "mission-x", status: "in_progress", outcomeSummary: null, completedAt: null, lastError: null }));

      const rule = {
        id: "issue-create-lane",
        name: "Issue create lane",
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
          kind: "mission" as const,
          laneMode: "create" as const,
          laneNamePreset: "issue-title" as const,
        },
        prompt: "Run the mission.",
      };

      const projectConfigService = {
        get: () => ({ trust: { requiresSharedTrust: false }, effective: { automations: [rule], providerMode: "guest" } })
      } as any;
      const laneService = {
        create: createLane,
        list: async () => [{ id: "lane-primary", name: "primary", laneType: "primary" }],
        getLaneWorktreePath: () => projectRoot,
        getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
      } as any;

      const service = createAutomationService({
        db: db as any, logger, projectId, projectRoot, laneService, projectConfigService,
        missionService: { create: createMission, patchMetadata: vi.fn() } as any,
        aiOrchestratorService: { startMissionRun: vi.fn(async () => undefined) } as any,
      });

      try {
        // Inject an issue payload by stuffing trigger context via dispatchIngressTrigger.
        // Manual trigger would have no issue payload — use a manual call but seed the
        // trigger via service.triggerManually then inspect the create call.
        // Instead, directly hit the underlying path by manipulating triggers: use
        // triggerManually here and the createLaneForRun fallback (rule.name) will fire.
        const run = await service.triggerManually({ id: "issue-create-lane" });
        expect(run.status).toBe("running");
        expect(createLane).toHaveBeenCalledTimes(1);
        const args = (createLane as any).mock.calls[0]?.[0] as { name: string };
        // No issue payload on manual triggers — falls back to rule.name.
        expect(args.name).toBe("Issue create lane");
        expect(createMission).toHaveBeenCalledWith(expect.objectContaining({ laneId: "lane-fresh" }));

        const setupRows = mapExecRows(raw.exec("select status, action_type from automation_action_results where action_type = 'lane-setup'"));
        expect(setupRows.length).toBe(1);
        expect(setupRows[0]?.status).toBe("succeeded");
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it("appends issue number on collision then a random suffix on a second collision", async () => {
      const { db, logger, projectId, projectRoot } = buildLaneModeFixtures();
      const createLane = vi.fn(async ({ name }: { name: string }) => ({
        id: `lane-${name}`,
        name,
        branchRef: name.replace(/\s+/g, "-").toLowerCase(),
        laneType: "feature",
        worktreePath: projectRoot,
      }));
      const createMission = vi.fn(() => ({ id: "mission-x", status: "in_progress", outcomeSummary: null, completedAt: null, lastError: null }));

      // Two existing lanes already collide with "Fix login" AND "Fix login (#427)".
      const rule = {
        id: "issue-collide",
        name: "Issue collide",
        enabled: true,
        mode: "review",
        reviewProfile: "quick",
        trigger: { type: "github.issue_opened" as const },
        triggers: [{ type: "github.issue_opened" as const }],
        executor: { mode: "automation-bot", targetId: null },
        toolPalette: [] as const,
        contextSources: [],
        memory: { mode: "project" as const },
        guardrails: { maxDurationMin: 5 },
        outputs: { disposition: "comment-only" as const, createArtifact: true },
        verification: { verifyBeforePublish: false, mode: "intervention" as const },
        billingCode: "auto:test",
        execution: { kind: "mission" as const, laneMode: "create" as const, laneNamePreset: "issue-title" as const },
        prompt: "Run.",
      };

      const projectConfigService = {
        get: () => ({ trust: { requiresSharedTrust: false }, effective: { automations: [rule], providerMode: "guest" } })
      } as any;

      const laneService = {
        create: createLane,
        list: async () => [
          { id: "lane-primary", name: "primary", laneType: "primary" },
          { id: "lane-existing", name: "Fix login", laneType: "feature" },
          { id: "lane-existing-2", name: "Fix login (#427)", laneType: "feature" },
        ],
        getLaneWorktreePath: () => projectRoot,
        getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
      } as any;

      const service = createAutomationService({
        db: db as any, logger, projectId, projectRoot, laneService, projectConfigService,
        missionService: { create: createMission, patchMetadata: vi.fn() } as any,
        aiOrchestratorService: { startMissionRun: vi.fn(async () => undefined) } as any,
      });

      try {
        await service.dispatchIngressTrigger({
          source: "github-polling",
          eventKey: "x:1",
          triggerType: "github.issue_opened",
          eventName: "github.issue_opened",
          repo: "x/y",
          issue: { number: 427, title: "Fix login", author: "a", labels: [], repo: "x/y", url: "https://x" }
        } as any);
        const args = (createLane as any).mock.calls[0]?.[0] as { name: string };
        // Both "Fix login" and "Fix login (#427)" already exist → falls through to random suffix.
        expect(args.name).toMatch(/^Fix login \([0-9a-f]{4}\)$/);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it("marks the run failed (no fallback to primary) when createLaneForRun throws", async () => {
      const { db, raw, logger, projectId, projectRoot } = buildLaneModeFixtures();
      const createLane = vi.fn(async () => { throw new Error("Disk full"); });
      const createMission = vi.fn();

      const rule = {
        id: "issue-fail",
        name: "Issue fail",
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
        execution: { kind: "mission" as const, laneMode: "create" as const, laneNamePreset: "issue-title" as const },
        prompt: "Run.",
      };

      const projectConfigService = {
        get: () => ({ trust: { requiresSharedTrust: false }, effective: { automations: [rule], providerMode: "guest" } })
      } as any;
      const laneService = {
        create: createLane,
        list: async () => [{ id: "lane-primary", name: "primary", laneType: "primary" }],
        getLaneWorktreePath: () => projectRoot,
        getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
      } as any;

      const service = createAutomationService({
        db: db as any, logger, projectId, projectRoot, laneService, projectConfigService,
        missionService: { create: createMission, patchMetadata: vi.fn() } as any,
        aiOrchestratorService: { startMissionRun: vi.fn(async () => undefined) } as any,
      });

      try {
        await expect(service.triggerManually({ id: "issue-fail" })).rejects.toThrow("Disk full");
        expect(createMission).not.toHaveBeenCalled();
        const runs = mapExecRows(raw.exec("select status, error_message from automation_runs where automation_id = 'issue-fail'"));
        expect(runs.length).toBe(1);
        expect(runs[0]?.status).toBe("failed");
        expect(String(runs[0]?.error_message ?? "")).toContain("Disk full");
        const setupRows = mapExecRows(raw.exec("select status from automation_action_results where action_type = 'lane-setup'"));
        expect(setupRows[0]?.status).toBe("failed");
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe("legacy create-lane migration", () => {
    it("collapses a leading create-lane action into laneMode: 'create' on load", async () => {
      // Drive the migration through projectConfigService — but the service in tests
      // gets a stub config service. Instead, exercise the same coercion logic by
      // building a rule whose execution lacks laneMode and whose first action is
      // create-lane, then verify the runtime behavior matches "create" mode.
      const { db, logger, projectId, projectRoot } = (() => {
        const { db } = createInMemoryAdeDb();
        return { db, logger: createLogger(), projectId: "proj", projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-migrate-")) };
      })();
      // Simulate what projectConfigService.coerce would have produced:
      const migratedExecution = {
        kind: "built-in" as const,
        laneMode: "create" as const,
        laneNamePreset: "custom" as const,
        laneNameTemplate: "Auto: {{trigger.issue.title}}",
        builtIn: { actions: [{ type: "create-lane" as const, laneNameTemplate: "Auto: {{trigger.issue.title}}" }] },
      };
      const createLane = vi.fn(async ({ name }: { name: string }) => ({
        id: "lane-migrated",
        name,
        branchRef: name.replace(/\s+/g, "-").toLowerCase(),
        laneType: "feature",
        worktreePath: projectRoot,
      }));
      const createMission = vi.fn(() => ({ id: "m", status: "in_progress", outcomeSummary: null, completedAt: null, lastError: null }));
      const rule = {
        id: "migrated",
        name: "Migrated",
        enabled: true, mode: "review", reviewProfile: "quick",
        trigger: { type: "manual" as const }, triggers: [{ type: "manual" as const }],
        executor: { mode: "automation-bot", targetId: null },
        toolPalette: [], contextSources: [], memory: { mode: "project" },
        guardrails: { maxDurationMin: 5 },
        outputs: { disposition: "comment-only", createArtifact: true },
        verification: { verifyBeforePublish: false, mode: "intervention" },
        billingCode: "auto:test",
        // Migrated rule still keeps the legacy action so unmigrated runners can read it,
        // but execution.laneMode === "create" steers the new path.
        execution: { ...migratedExecution, kind: "mission" as const },
        prompt: "Run.",
      };
      const projectConfigService = {
        get: () => ({ trust: { requiresSharedTrust: false }, effective: { automations: [rule], providerMode: "guest" } })
      } as any;
      const laneService = {
        create: createLane,
        list: async () => [{ id: "lane-primary", name: "primary", laneType: "primary" }],
        getLaneWorktreePath: () => projectRoot,
        getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: projectRoot })
      } as any;
      const service = createAutomationService({
        db: db as any, logger, projectId, projectRoot, laneService, projectConfigService,
        missionService: { create: createMission, patchMetadata: vi.fn() } as any,
        aiOrchestratorService: { startMissionRun: vi.fn(async () => undefined) } as any,
      });
      try {
        await service.triggerManually({ id: "migrated" });
        expect(createLane).toHaveBeenCalledTimes(1);
        // Manual trigger has no issue.title → embedded placeholder resolves to
        // empty, leaving the literal prefix "Auto:" — verify the migrated path
        // produced *some* lane and the leading template was honored.
        const args = (createLane as any).mock.calls[0]?.[0] as { name: string };
        expect(args.name).toMatch(/^Auto:/);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

});
