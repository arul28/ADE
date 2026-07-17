import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import {
  createAutomationService,
  normalizeRuntimeRule,
  presetToTemplate,
  resolveLaneNameTemplate,
  triggerMatches,
} from "./automationService";
import { buildLinearAutomationDispatches } from "./linearAutomationDispatch";
import type { LinearIngressEventRecord } from "../../../shared/types/linearSync";

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

  it("matches linear.issue_labeled against the added labels only", () => {
    // The dispatch carries only the added label names in `labels`; the issue's
    // full label set lives in `linear.issue.labels`.
    const trigger = {
      triggerType: "linear.issue_labeled" as const,
      labels: ["ready-for-ade"],
      linear: {
        issue: {
          id: "issue-1",
          title: "Fix OAuth",
          team: "ENG",
          labels: ["bug", "ready-for-ade", "p1"],
        },
      },
    };

    // Configured label is among the added labels → matches.
    expect(triggerMatches(
      { type: "linear.issue_labeled", labels: ["ready-for-ade"] },
      trigger,
      undefined,
      undefined,
    )).toBe(true);

    // A label that's on the issue but was NOT just added must not match.
    expect(triggerMatches(
      { type: "linear.issue_labeled", labels: ["p1"] },
      trigger,
      undefined,
      undefined,
    )).toBe(false);
  });

  it("requires at least one added label for a label rule with no configured label", () => {
    const base = {
      triggerType: "linear.issue_labeled" as const,
      linear: { issue: { id: "issue-2", title: "X", team: "ENG", labels: ["x"] } },
    };
    expect(triggerMatches(
      { type: "linear.issue_labeled" },
      { ...base, labels: ["x"] },
      undefined,
      undefined,
    )).toBe(true);
    expect(triggerMatches(
      { type: "linear.issue_labeled" },
      { ...base, labels: [] },
      undefined,
      undefined,
    )).toBe(false);
  });

  it("matches lane.merged name and branch globs against lane context", () => {
    const trigger = {
      triggerType: "lane.merged" as const,
      laneId: "lane-42",
      laneName: "Release train",
      branch: "release/2026-07",
      pr: { number: 42, title: "Release", merged: true },
    };

    expect(triggerMatches(
      { type: "lane.merged", namePattern: "Release*", branch: "release/*" },
      trigger,
      trigger.branch,
      trigger.laneName,
    )).toBe(true);
    expect(triggerMatches(
      { type: "lane.merged", namePattern: "Nightly*" },
      trigger,
      trigger.branch,
      trigger.laneName,
    )).toBe(false);
    expect(triggerMatches(
      { type: "lane.created", namePattern: "Release*" },
      trigger,
      trigger.branch,
      trigger.laneName,
    )).toBe(false);
  });
});

describe("normalizeRuntimeRule", () => {
  it("normalizes legacy prompt-at-run lane mode to require-on-trigger", () => {
    const normalized = normalizeRuntimeRule({
      id: "legacy-prompt-at-run",
      name: "Legacy prompt at run",
      enabled: true,
      mode: "review",
      triggers: [{ type: "manual" }],
      trigger: { type: "manual" },
      execution: { kind: "agent-session", laneMode: "prompt-at-run" } as any,
      executor: { mode: "automation-bot" },
      prompt: "Run in the supplied lane.",
      reviewProfile: "quick",
      toolPalette: ["repo"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:test",
      actions: [],
    });

    expect(normalized.execution?.laneMode).toBe("require-on-trigger");
  });
});

describe("automation ingress enable gating", () => {
  function makeProjectConfigHarness(rule: any, ui: Record<string, unknown> = {}) {
    let snapshot: any = {
      trust: { requiresSharedTrust: false },
      shared: {},
      local: { automations: [{ id: rule.id, enabled: rule.enabled }] },
      effective: { automations: [rule], providerMode: "guest", ui },
    };
    return {
      service: {
        get: () => snapshot,
        save: (next: any) => {
          const nextLocal = next.local ?? snapshot.local;
          snapshot = {
            ...snapshot,
            ...next,
            effective: {
              ...snapshot.effective,
              ui: nextLocal.ui ?? snapshot.effective.ui,
              automations: nextLocal.automations?.map((entry: any) => ({ ...rule, ...entry })) ?? snapshot.effective.automations,
            },
          };
          return snapshot;
        },
      } as any,
      getSnapshot: () => snapshot,
    };
  }

  function createServiceForRule(
    rule: any,
    ui: Record<string, unknown> = {},
    capabilities: { githubPollingAvailable?: () => boolean; linearIngressAvailable?: () => boolean } = {},
  ) {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectConfig = makeProjectConfigHarness(rule, ui);
    const service = createAutomationService({
      db: db as any,
      logger,
      projectId: "proj",
      projectRoot: "/tmp",
      laneService: {
        getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: "/tmp" }),
        getLaneWorktreePath: () => "/tmp",
      } as any,
      projectConfigService: projectConfig.service,
      ...capabilities,
    });
    return { service, projectConfig };
  }

  it("blocks Linear rules without event ingress and allows them once the capability is connected", () => {
    const rule = normalizeRuntimeRule({
      id: "linear-label",
      name: "Linear label",
      enabled: false,
      mode: "review",
      triggers: [{ type: "linear.issue_labeled" }],
      trigger: { type: "linear.issue_labeled" },
      execution: { kind: "agent-session", session: {} },
      executor: { mode: "automation-bot" },
      prompt: "Smoke test",
      reviewProfile: "quick",
      toolPalette: ["linear"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:linear-label",
      actions: [],
    });
    const { service } = createServiceForRule(rule);

    expect(() => service.toggle({ id: rule.id, enabled: true })).toThrow("Connect Linear events in Automations settings.");
    service.setLinearIngressAvailable(() => true);
    expect(() => service.toggle({ id: rule.id, enabled: true })).not.toThrow();
    expect(service.list()[0]?.enabled).toBe(true);
    expect(service.hasEnabledLinearRules()).toBe(true);
  });

  it("allows GitHub rules with direct polling and blocks them without any ingress path", () => {
    const rule = normalizeRuntimeRule({
      id: "github-polling-gate",
      name: "GitHub polling gate",
      enabled: false,
      mode: "review",
      triggers: [{ type: "github.issue_labeled" }],
      trigger: { type: "github.issue_labeled" },
      execution: { kind: "built-in", builtIn: { actions: [] } },
      executor: { mode: "automation-bot" },
      reviewProfile: "quick",
      toolPalette: ["github"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:github-polling-gate",
      actions: [],
    });
    const blocked = createServiceForRule(rule, {}, { githubPollingAvailable: () => false });
    expect(() => blocked.service.toggle({ id: rule.id, enabled: true })).toThrow(/Connect a GitHub repository/);

    const allowed = createServiceForRule(rule, {}, { githubPollingAvailable: () => true });
    expect(() => allowed.service.toggle({ id: rule.id, enabled: true })).not.toThrow();
    expect(allowed.service.hasEnabledGithubRules()).toBe(true);
  });

  it("allows external event automations when a public gateway URL is configured", () => {
    const rule = normalizeRuntimeRule({
      id: "github-label",
      name: "GitHub label",
      enabled: false,
      mode: "review",
      triggers: [{ type: "github.issue_labeled" }],
      trigger: { type: "github.issue_labeled" },
      execution: { kind: "agent-session", session: {} },
      executor: { mode: "automation-bot" },
      prompt: "Smoke test",
      reviewProfile: "quick",
      toolPalette: ["github"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:github-label",
      actions: [],
    });
    const { service, projectConfig } = createServiceForRule(rule, {
      webhookGatewayPublicUrl: "https://ade.example.com/ade-webhooks",
    });

    expect(() => service.toggle({ id: rule.id, enabled: true })).not.toThrow();
    expect(projectConfig.getSnapshot().local.automations[0]?.enabled).toBe(true);
  });

  it("does not treat a saved Tailscale URL as ready before Funnel is verified", () => {
    const rule = normalizeRuntimeRule({
      id: "github-label",
      name: "GitHub label",
      enabled: false,
      mode: "review",
      triggers: [{ type: "github.issue_labeled" }],
      trigger: { type: "github.issue_labeled" },
      execution: { kind: "agent-session", session: {} },
      executor: { mode: "automation-bot" },
      prompt: "Smoke test",
      reviewProfile: "quick",
      toolPalette: ["github"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:github-label",
      actions: [],
    });
    const { service } = createServiceForRule(rule, {
      webhookGatewayPublicUrl: "https://ade-dev.tail000000.ts.net/ade-webhooks",
    });

    const status = service.getIngressStatus().webhookGateway;
    expect(status.publicUrl).toBe("https://ade-dev.tail000000.ts.net/ade-webhooks");
    expect(status.ready).toBe(false);
    expect(status.status).toBe("pending-approval");
    expect(() => service.toggle({ id: rule.id, enabled: true })).toThrow(/Connect a GitHub repository/);
  });

  it("reports GitHub relay delivery as ready", () => {
    const rule = normalizeRuntimeRule({
      id: "github-relay-delivery",
      name: "GitHub relay delivery",
      enabled: false,
      mode: "review",
      triggers: [{ type: "github.issue_labeled" }],
      trigger: { type: "github.issue_labeled" },
      execution: { kind: "built-in", builtIn: { actions: [] } },
      executor: { mode: "automation-bot" },
      reviewProfile: "quick",
      toolPalette: ["github"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:github-relay-delivery",
      actions: [],
    });
    const { service } = createServiceForRule(rule, {}, { githubPollingAvailable: () => false });

    service.updateIngressStatus({
      githubRelay: { configured: true, healthy: true, status: "ready" },
    });

    expect(service.getIngressStatus().delivery?.github).toEqual({
      ready: true,
      via: "github-relay",
      setupError: null,
    });
  });

  it("does not count an errored GitHub relay as a delivery path", () => {
    const rule = normalizeRuntimeRule({
      id: "github-relay-error",
      name: "GitHub relay error",
      enabled: false,
      mode: "review",
      triggers: [{ type: "github.issue_labeled" }],
      trigger: { type: "github.issue_labeled" },
      execution: { kind: "built-in", builtIn: { actions: [] } },
      executor: { mode: "automation-bot" },
      reviewProfile: "quick",
      toolPalette: ["github"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:github-relay-error",
      actions: [],
    });
    const { service } = createServiceForRule(rule, {}, { githubPollingAvailable: () => false });

    service.updateIngressStatus({
      githubRelay: { configured: true, healthy: false, status: "error" },
    });

    expect(service.getIngressStatus().delivery?.github).toEqual({
      ready: false,
      via: null,
      setupError: "Connect a GitHub repository, configure the GitHub relay, or start the local webhook server in Automations settings.",
    });
    expect(() => service.toggle({ id: rule.id, enabled: true })).toThrow(/Connect a GitHub repository/);
  });

  it("treats legacy git.pr_* triggers as GitHub delivery for enable-gating", () => {
    const rule = normalizeRuntimeRule({
      id: "legacy-git-pr",
      name: "Legacy git.pr trigger",
      enabled: false,
      mode: "review",
      triggers: [{ type: "git.pr_opened" }],
      trigger: { type: "git.pr_opened" },
      execution: { kind: "built-in", builtIn: { actions: [] } },
      executor: { mode: "automation-bot" },
      reviewProfile: "quick",
      toolPalette: ["github"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:legacy-git-pr",
      actions: [],
    });
    const { service } = createServiceForRule(rule, {}, { githubPollingAvailable: () => false });

    expect(() => service.toggle({ id: rule.id, enabled: true })).toThrow(/Connect a GitHub repository/);

    service.updateIngressStatus({
      githubRelay: { configured: true, healthy: true, status: "ready" },
    });
    const summaries = service.toggle({ id: rule.id, enabled: true });
    expect(summaries.find((r) => r.id === rule.id)?.enabled).toBe(true);
    expect(service.getIngressStatus().delivery?.github.ready).toBe(true);
  });

  it("reports unavailable GitHub delivery and mirrors Linear ingress capability", () => {
    const rule = normalizeRuntimeRule({
      id: "ingress-delivery-status",
      name: "Ingress delivery status",
      enabled: false,
      mode: "review",
      triggers: [{ type: "manual" }],
      trigger: { type: "manual" },
      execution: { kind: "built-in", builtIn: { actions: [] } },
      executor: { mode: "automation-bot" },
      reviewProfile: "quick",
      toolPalette: [],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:ingress-delivery-status",
      actions: [],
    });
    let linearAvailable = true;
    const { service } = createServiceForRule(rule, {}, {
      githubPollingAvailable: () => false,
      linearIngressAvailable: () => linearAvailable,
    });

    const available = service.getIngressStatus().delivery;
    expect(available?.github).toEqual({
      ready: false,
      via: null,
      setupError: "Connect a GitHub repository, configure the GitHub relay, or start the local webhook server in Automations settings.",
    });
    expect(available?.linear).toEqual({
      ready: true,
      via: "linear-relay",
      setupError: null,
    });

    linearAvailable = false;
    expect(service.getIngressStatus().delivery?.linear).toEqual({
      ready: false,
      via: null,
      setupError: "Connect Linear events in Automations settings.",
    });
  });

  it("saves and clears the public gateway URL through the automation runtime", async () => {
    const rule = normalizeRuntimeRule({
      id: "manual-smoke",
      name: "Manual smoke",
      enabled: true,
      mode: "review",
      triggers: [{ type: "manual" }],
      trigger: { type: "manual" },
      execution: { kind: "agent-session", session: {} },
      executor: { mode: "automation-bot" },
      prompt: "Smoke test",
      reviewProfile: "quick",
      toolPalette: ["repo"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:manual-smoke",
      actions: [],
    });
    const { service, projectConfig } = createServiceForRule(rule);

    const saved = await service.setWebhookGatewayPublicUrl({
      publicUrl: "https://ade.example.com/ade-webhooks/",
    });
    expect(saved.publicUrl).toBe("https://ade.example.com/ade-webhooks");
    expect(saved.ready).toBe(true);
    expect(projectConfig.getSnapshot().local.ui.webhookGatewayPublicUrl).toBe("https://ade.example.com/ade-webhooks");

    const cleared = await service.setWebhookGatewayPublicUrl({ publicUrl: null });
    expect(cleared.publicUrl).toBeNull();
    expect(projectConfig.getSnapshot().local.ui.webhookGatewayPublicUrl).toBeUndefined();
  });

  it("rejects non-HTTPS public gateway URLs", async () => {
    const rule = normalizeRuntimeRule({
      id: "manual-smoke",
      name: "Manual smoke",
      enabled: true,
      mode: "review",
      triggers: [{ type: "manual" }],
      trigger: { type: "manual" },
      execution: { kind: "agent-session", session: {} },
      executor: { mode: "automation-bot" },
      prompt: "Smoke test",
      reviewProfile: "quick",
      toolPalette: ["repo"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:manual-smoke",
      actions: [],
    });
    const { service } = createServiceForRule(rule);

    await expect(service.setWebhookGatewayPublicUrl({ publicUrl: "http://localhost:3000" })).rejects.toThrow(/HTTPS/);
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
  raw.run(`
    create table automation_ingress_events(
      id text primary key,
      project_id text not null,
      source text not null,
      event_key text not null,
      automation_ids_json text not null,
      trigger_type text not null,
      event_name text,
      status text not null,
      summary text,
      error_message text,
      cursor text,
      raw_payload_json text,
      received_at text not null
    )
  `);
  raw.run(`
    create table automation_ingress_cursors(
      project_id text not null,
      source text not null,
      cursor text,
      updated_at text not null,
      primary key(project_id, source)
    )
  `);
  raw.run("create table kv(key text primary key, value text not null)");

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

  it("serializes concurrent manual triggers into distinct runs", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = "/tmp";

    const rule = {
      id: "slow-manual",
      name: "Slow manual",
      trigger: { type: "manual" as const },
      actions: [{ type: "run-command" as const, command: "node -e \"setTimeout(() => {}, 150)\"", timeoutMs: 10_000 }],
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

    const [first, second] = await Promise.all([
      service.triggerManually({ id: "slow-manual" }),
      service.triggerManually({ id: "slow-manual" }),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    const mapped = mapExecRows(raw.exec("select id from automation_runs where automation_id = 'slow-manual'"));
    expect(mapped).toHaveLength(2);
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

  it("requires manual triggers to pass laneId when laneMode is require-on-trigger", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-require-lane-"));

    const rule = {
      id: "manual-require-lane",
      name: "Manual require lane",
      trigger: { type: "manual" as const },
      triggers: [{ type: "manual" as const }],
      execution: {
        kind: "built-in" as const,
        laneMode: "require-on-trigger" as const,
        builtIn: { actions: [{ type: "run-command" as const, command: "pwd", timeoutMs: 10_000 }] },
      },
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
      projectConfigService
    });

    try {
      await expect(service.triggerManually({ id: "manual-require-lane" })).rejects.toThrow(/requires a lane/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses the supplied laneId for require-on-trigger manual runs", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-require-project-"));
    const suppliedLaneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-require-supplied-"));
    const actionLaneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-require-action-"));

    const rule = {
      id: "manual-supplied-lane",
      name: "Manual supplied lane",
      trigger: { type: "manual" as const },
      triggers: [{ type: "manual" as const }],
      execution: {
        kind: "built-in" as const,
        laneMode: "require-on-trigger" as const,
        builtIn: { actions: [{ type: "run-command" as const, command: "pwd", targetLaneId: "lane-action", timeoutMs: 10_000 }] },
      },
      actions: [{ type: "run-command" as const, command: "pwd", targetLaneId: "lane-action", timeoutMs: 10_000 }],
      enabled: true
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: false },
        effective: { automations: [rule], providerMode: "guest" }
      })
    } as any;

    const laneService = {
      list: async () => [{ id: "lane-primary", laneType: "primary" }, { id: "lane-supplied", laneType: "worktree" }, { id: "lane-action", laneType: "worktree" }],
      getLaneWorktreePath: (laneId: string) => laneId === "lane-supplied" ? suppliedLaneRoot : laneId === "lane-action" ? actionLaneRoot : projectRoot,
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
      const run = await service.triggerManually({ id: "manual-supplied-lane", laneId: "lane-supplied" });
      expect(run.status).toBe("succeeded");
      const mapped = mapExecRows(raw.exec("select output from automation_action_results"));
      expect(String(mapped[0]?.output ?? "")).toContain(suppliedLaneRoot);
      expect(String(mapped[0]?.output ?? "")).not.toContain(actionLaneRoot);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(suppliedLaneRoot, { recursive: true, force: true });
      fs.rmSync(actionLaneRoot, { recursive: true, force: true });
    }
  });

  it("fails non-manual require-on-trigger runs when the event has no lane", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-require-event-"));

    const rule = {
      id: "event-require-lane",
      name: "Event require lane",
      trigger: { type: "github.issue_opened" as const },
      triggers: [{ type: "github.issue_opened" as const }],
      execution: {
        kind: "built-in" as const,
        laneMode: "require-on-trigger" as const,
        builtIn: { actions: [{ type: "run-command" as const, command: "pwd", timeoutMs: 10_000 }] },
      },
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
      projectConfigService
    });

    try {
      const event = await service.dispatchIngressTrigger({
        source: "github-polling",
        eventKey: "issue:require-lane",
        triggerType: "github.issue_opened",
        eventName: "github.issue_opened",
        issue: { number: 1, title: "No lane", labels: [] },
      } as any);
      expect(event?.status).toBe("dispatched");
      const runs = mapExecRows(raw.exec("select status, error_message from automation_runs where automation_id = 'event-require-lane'"));
      expect(runs[0]?.status).toBe("failed");
      expect(String(runs[0]?.error_message ?? "")).toContain("trigger payload to include a laneId");
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
      modelConfig: { modelId: "opencode/openai/gpt-5.4", thinkingLevel: "medium" },
      permissionConfig: { providers: { opencode: "edit" } },
      toolPalette: [] as const,
      contextSources: [],
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

  it("runs local-only automations while shared config trust is required", async () => {
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
        shared: { automations: [] },
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

    await expect(service.triggerManually({ id: "echo" })).resolves.toMatchObject({
      status: "succeeded",
      automationId: "echo",
    });
  });

  it("blocks shared automations when shared config trust is required", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = "/tmp";

    const rule = {
      id: "shared-echo",
      name: "Shared echo",
      trigger: { type: "manual" as const },
      actions: [{ type: "run-command" as const, command: "echo hello", timeoutMs: 10_000 }],
      enabled: true
    };

    const projectConfigService = {
      get: () => ({
        trust: { requiresSharedTrust: true },
        shared: { automations: [{ id: rule.id }] },
        local: {},
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

    await expect(service.triggerManually({ id: rule.id })).rejects.toThrow(
      "Shared project config (.ade/ade.yaml) changed and is untrusted. Review and trust it from the Automations tab to run shared automations.",
    );
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

  it("passes Codex fast mode to rule-level agent-session automations", async () => {
    const { db } = createInMemoryAdeDb();
    const logger = createLogger();
    const projectId = "proj";
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-fast-rule-"));
    const createSession = vi.fn(async () => ({ id: "session-fast-rule" }));
    const runSessionTurn = vi.fn(async () => ({ outputText: "ok" }));

    const rule = {
      id: "agent-fast-rule",
      name: "Agent fast rule",
      enabled: true,
      mode: "review",
      reviewProfile: "quick",
      trigger: { type: "manual" as const },
      triggers: [{ type: "manual" as const }],
      executor: { mode: "automation-bot", targetId: null },
      modelConfig: { modelId: "openai/gpt-5.5", thinkingLevel: "xhigh" as const },
      permissionConfig: { providers: { codex: "default" as const } },
      toolPalette: [] as const,
      contextSources: [],
      guardrails: { maxDurationMin: 5 },
      outputs: { disposition: "comment-only" as const, createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" as const },
      billingCode: "auto:test",
      execution: {
        kind: "agent-session" as const,
        session: { fastMode: true, reasoningEffort: "xhigh" },
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
        runSessionTurn,
      } as any,
    });

    try {
      const run = await service.triggerManually({ id: "agent-fast-rule" });
      expect(run.status).toBe("succeeded");
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
        modelId: "openai/gpt-5.5",
        fastMode: true,
        reasoningEffort: "xhigh",
      }));
      expect(runSessionTurn).toHaveBeenCalledWith(expect.objectContaining({
        reasoningEffort: "xhigh",
      }));
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
    const budgetCapService = {
      checkBudget: vi.fn(() => ({ allowed: false, reason: "Budget exceeded" })),
    };

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
      budgetCapService: budgetCapService as any,
    });

    try {
      await expect(service.triggerManually({ id: "agent-budget" })).rejects.toThrow("Budget exceeded");
      expect(budgetCapService.checkBudget).toHaveBeenCalledWith(
        "automation-rule",
        "agent-budget",
        expect.any(String),
        { runScopeId: expect.any(String) },
      );
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
      modelConfig: { modelId: "openai/gpt-5.4", thinkingLevel: "low" },
      permissionConfig: { providers: { codex: "default" as const, opencode: "edit" as const } },
      toolPalette: [] as const,
      contextSources: [],
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
              modelConfig: { modelId: "openai/gpt-5.5", thinkingLevel: "high" as const },
              fastMode: true,
              permissionConfig: { providers: { codex: "full-auto" as const } },
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
        modelId: "openai/gpt-5.5",
        fastMode: true,
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
      guardrails: { maxDurationMin: 5 },
      outputs: { disposition: "comment-only" as const, createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" as const },
      billingCode: "auto:test",
      execution: {
        kind: "agent-session" as const,
      },
      modelConfig: {
          modelId: "openai/gpt-5.4",
          thinkingLevel: "medium",
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
      expect(checkBudget).toHaveBeenCalledWith("automation-rule", "agent-budget-provider", "codex", {
        runScopeId: expect.any(String),
      });
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  describe("lane lifecycle automation contracts", () => {
    const buildRule = (args: {
      id: string;
      actions: any[];
      trigger?: { type: "manual" | "lane.merged"; namePattern?: string };
    }) => {
      const trigger = args.trigger ?? { type: "manual" as const };
      return {
        id: args.id,
        name: args.id,
        enabled: true,
        mode: "review" as const,
        reviewProfile: "quick" as const,
        trigger,
        triggers: [trigger],
        executor: { mode: "automation-bot" as const },
        toolPalette: ["repo"] as const,
        contextSources: [],
        guardrails: { maxDurationMin: 5 },
        outputs: { disposition: "comment-only" as const, createArtifact: true },
        verification: { verifyBeforePublish: false, mode: "intervention" as const },
        billingCode: `auto:${args.id}`,
        execution: { kind: "built-in" as const, builtIn: { actions: args.actions } },
        actions: [],
      };
    };

    const createHarness = (rule: ReturnType<typeof buildRule>, laneOverrides: Record<string, unknown> = {}) => {
      const { db, raw } = createInMemoryAdeDb();
      const laneService = {
        list: async () => [{ id: "lane-1", name: "Feature lane", laneType: "worktree", branchRef: "feature/lane" }],
        getLaneWorktreePath: () => "/tmp",
        getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "feature/lane", worktreePath: "/tmp" }),
        ...laneOverrides,
      } as any;
      const service = createAutomationService({
        db: db as any,
        logger: createLogger(),
        projectId: "proj",
        projectRoot: "/tmp",
        laneService,
        projectConfigService: {
          get: () => ({ trust: { requiresSharedTrust: false }, effective: { automations: [rule], providerMode: "guest" } }),
        } as any,
      });
      return { service, raw, laneService };
    };

    it("deduplicates lane.merged delivery while preserving lane and PR trigger context", async () => {
      const rule = buildRule({
        id: "lane-merged-dedupe",
        trigger: { type: "lane.merged", namePattern: "Feature*" },
        actions: [{ type: "run-command", command: "echo merged", timeoutMs: 10_000 }],
      });
      const { service, raw } = createHarness(rule);
      try {
        const notification = {
          laneId: "lane-1",
          laneName: "Feature lane",
          branch: "feature/lane",
          prNumber: 42,
          prUrl: "https://github.com/acme/repo/pull/42",
          prTitle: "Ship feature",
          targetBranch: "main",
          repo: "acme/repo",
        };
        await expect(service.notifyLaneMerged(notification)).resolves.toBe(true);
        await expect(service.notifyLaneMerged(notification)).resolves.toBe(false);
        const started = Date.now();
        while (Date.now() - started < 2_000) {
          const rows = mapExecRows(raw.exec("select trigger_metadata from automation_runs where automation_id = 'lane-merged-dedupe'"));
          if (rows.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const runs = mapExecRows(raw.exec("select trigger_metadata from automation_runs where automation_id = 'lane-merged-dedupe'"));
        expect(runs).toHaveLength(1);
        expect(JSON.parse(String(runs[0]?.trigger_metadata))).toMatchObject({
          laneId: "lane-1",
          laneName: "Feature lane",
          branch: "feature/lane",
          pr: { number: 42, url: "https://github.com/acme/repo/pull/42", merged: true },
        });
      } finally {
        service.dispose();
      }
    });

    it("deletes the explicitly targeted lane immediately with configured options", async () => {
      const deleteLane = vi.fn(async () => undefined);
      const rule = buildRule({
        id: "delete-lane-now",
        actions: [{
          type: "delete-lane",
          targetLaneId: "lane-1",
          laneDeleteOptions: { deleteBranch: false, deleteRemoteBranch: true, force: true },
        }],
      });
      const { service, raw } = createHarness(rule, { delete: deleteLane });
      try {
        const run = await service.triggerManually({ id: rule.id });
        expect(run.status).toBe("succeeded");
        expect(deleteLane).toHaveBeenCalledWith({
          laneId: "lane-1",
          deleteBranch: false,
          deleteRemoteBranch: true,
          force: true,
        });
        expect(mapExecRows(raw.exec("select status, output from automation_action_results"))).toMatchObject([
          { status: "succeeded", output: expect.stringContaining('"status":"deleted"') },
        ]);
      } finally {
        service.dispose();
      }
    });

    it("fails delete-lane clearly when no explicit, chain-created, or trigger lane exists", async () => {
      const deleteLane = vi.fn(async () => undefined);
      const rule = buildRule({ id: "delete-lane-no-target", actions: [{ type: "delete-lane" }] });
      const { service, raw } = createHarness(rule, { delete: deleteLane });
      try {
        const run = await service.triggerManually({ id: rule.id });
        expect(run.status).toBe("failed");
        expect(run.errorMessage).toContain("requires an explicit target lane");
        expect(deleteLane).not.toHaveBeenCalled();
        expect(mapExecRows(raw.exec("select status from automation_action_results"))).toEqual([{ status: "failed" }]);
      } finally {
        service.dispose();
      }
    });

    it("runs alwaysRun cleanup after an earlier step aborts and preserves the original failure", async () => {
      const deleteLane = vi.fn(async () => undefined);
      const rule = buildRule({
        id: "always-run-delete",
        actions: [
          { type: "run-command", command: "exit 9", timeoutMs: 10_000 },
          { type: "delete-lane", targetLaneId: "lane-1", alwaysRun: true },
        ],
      });
      const { service, raw } = createHarness(rule, { delete: deleteLane });
      try {
        const run = await service.triggerManually({ id: rule.id });
        expect(run.status).toBe("failed");
        expect(run.errorMessage).toContain("Command exited with code 9");
        expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-1" });
        expect(mapExecRows(raw.exec("select action_type, status from automation_action_results order by action_index"))).toEqual([
          { action_type: "run-command", status: "failed" },
          { action_type: "delete-lane", status: "succeeded" },
        ]);
      } finally {
        service.dispose();
      }
    });

    it("persists deferred cleanup and executes due work with an appended history result", async () => {
      const deleteLane = vi.fn(async () => undefined);
      const rule = buildRule({
        id: "delete-lane-deferred",
        actions: [{ type: "delete-lane", targetLaneId: "lane-1", afterMinutes: 10, laneDeleteOptions: { force: true } }],
      });
      const { service, raw } = createHarness(rule, { delete: deleteLane });
      try {
        const run = await service.triggerManually({ id: rule.id });
        const scheduled = service.listScheduledCleanups();
        expect(run.status).toBe("succeeded");
        expect(deleteLane).not.toHaveBeenCalled();
        expect(scheduled).toMatchObject([{ laneId: "lane-1", status: "scheduled", options: { force: true } }]);

        raw.run("update automation_scheduled_cleanups set due_at = '2000-01-01T00:00:00.000Z'");
        await service.runScheduledCleanupSweep();

        expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-1", force: true });
        expect(service.listScheduledCleanups()[0]?.status).toBe("executed");
        expect(mapExecRows(raw.exec("select action_type, status from automation_action_results order by action_index"))).toEqual([
          { action_type: "delete-lane", status: "succeeded" },
          { action_type: "delete-lane", status: "succeeded" },
        ]);
      } finally {
        service.dispose();
      }
    });

    it("treats an already-missing deferred lane as executed instead of failed", async () => {
      const deleteLane = vi.fn(async () => undefined);
      const rule = buildRule({
        id: "delete-lane-missing",
        actions: [{ type: "delete-lane", targetLaneId: "lane-gone", afterMinutes: 1 }],
      });
      const { service, raw } = createHarness(rule, { list: async () => [], delete: deleteLane });
      try {
        await service.triggerManually({ id: rule.id });
        raw.run("update automation_scheduled_cleanups set due_at = '2000-01-01T00:00:00.000Z'");
        await service.runScheduledCleanupSweep();

        expect(deleteLane).not.toHaveBeenCalled();
        expect(service.listScheduledCleanups()).toMatchObject([{ status: "executed", error: null }]);
        expect(mapExecRows(raw.exec("select status, output from automation_action_results order by action_index desc limit 1"))).toMatchObject([
          { status: "succeeded", output: expect.stringContaining("already deleted") },
        ]);
      } finally {
        service.dispose();
      }
    });

    it("cancels scheduled cleanup idempotently and excludes it from later sweeps", async () => {
      const deleteLane = vi.fn(async () => undefined);
      const rule = buildRule({
        id: "delete-lane-cancel",
        actions: [{ type: "delete-lane", targetLaneId: "lane-1", afterMinutes: 1 }],
      });
      const { service, raw } = createHarness(rule, { delete: deleteLane });
      try {
        await service.triggerManually({ id: rule.id });
        const cleanupId = service.listScheduledCleanups()[0]!.id;
        expect(service.cancelScheduledCleanup(cleanupId)).toBe(true);
        expect(service.cancelScheduledCleanup(cleanupId)).toBe(false);
        raw.run("update automation_scheduled_cleanups set due_at = '2000-01-01T00:00:00.000Z'");
        await service.runScheduledCleanupSweep();
        expect(deleteLane).not.toHaveBeenCalled();
        expect(service.listScheduledCleanups()[0]?.status).toBe("cancelled");
      } finally {
        service.dispose();
      }
    });
  });

  describe("laneMode: 'create'", () => {
    it("presetToTemplate maps known presets and returns empty for custom/unknown", () => {
      expect(presetToTemplate("issue-title")).toBe("{{trigger.issue.title}}");
      expect(presetToTemplate("issue-num-title")).toBe("Issue #{{trigger.issue.number}} – {{trigger.issue.title}}");
      expect(presetToTemplate("pr-title-author")).toBe("{{trigger.pr.title}} – {{trigger.pr.author}}");
      expect(presetToTemplate("custom")).toBe("");
      expect(presetToTemplate(undefined)).toBe("");
    });

    it("resolves date, time, rule.name, and trigger placeholders in lane names", () => {
      const scheduled = new Date(2026, 6, 9, 21, 7, 0);
      const resolved = resolveLaneNameTemplate(
        "{{rule.name}} {{date}} {{time}} {{trigger.laneName}}",
        { triggerType: "schedule", scheduledAt: scheduled.toISOString(), laneName: "audit" },
        "Nightly audit",
      );

      expect(resolved).toContain("Nightly audit");
      expect(resolved).toContain("2026-07-09 21:07");
      expect(resolved.endsWith("audit")).toBe(true);
    });

    function buildLaneModeFixtures() {
      const { db, raw } = createInMemoryAdeDb();
      const logger = createLogger();
      const projectId = "proj";
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-lane-mode-"));
      return { db, raw, logger, projectId, projectRoot };
    }

    it("reuses the created lane for every built-in step in the run", async () => {
      const { db, raw, logger, projectId, projectRoot } = buildLaneModeFixtures();
      const laneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-automation-lane-mode-created-"));
      const createLane = vi.fn(async ({ name }: { name: string }) => ({
        id: "lane-fresh",
        name,
        branchRef: name.replace(/\s+/g, "-").toLowerCase(),
        laneType: "feature",
        worktreePath: laneRoot,
      }));

      const rule = {
        id: "built-in-create-lane",
        name: "Built-in create lane",
        enabled: true,
        mode: "review",
        reviewProfile: "quick",
        trigger: { type: "manual" as const },
        triggers: [{ type: "manual" as const }],
        executor: { mode: "automation-bot", targetId: null },
        toolPalette: [] as const,
        contextSources: [],
        guardrails: { maxDurationMin: 5 },
        outputs: { disposition: "comment-only" as const, createArtifact: true },
        verification: { verifyBeforePublish: false, mode: "intervention" as const },
        billingCode: "auto:test",
        execution: {
          kind: "built-in" as const,
          laneMode: "create" as const,
          laneNamePreset: "issue-title" as const,
          builtIn: {
            actions: [
              { type: "run-command" as const, command: "pwd", timeoutMs: 10_000 },
              { type: "run-command" as const, command: "pwd", timeoutMs: 10_000 },
            ],
          },
        },
        actions: [],
      };

      const projectConfigService = {
        get: () => ({ trust: { requiresSharedTrust: false }, effective: { automations: [rule], providerMode: "guest" } })
      } as any;
      const laneService = {
        create: createLane,
        list: async () => [{ id: "lane-primary", name: "primary", laneType: "primary" }],
        getLaneWorktreePath: (laneId: string) => laneId === "lane-fresh" ? laneRoot : projectRoot,
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
        const run = await service.triggerManually({ id: "built-in-create-lane" });
        expect(run.status).toBe("succeeded");
        expect(createLane).toHaveBeenCalledTimes(1);
        const commandRows = mapExecRows(raw.exec("select output from automation_action_results where action_type = 'run-command' order by action_index asc"));
        expect(commandRows).toHaveLength(2);
        expect(String(commandRows[0]?.output ?? "")).toContain(laneRoot);
        expect(String(commandRows[1]?.output ?? "")).toContain(laneRoot);
        const setupRows = mapExecRows(raw.exec("select status from automation_action_results where action_type = 'lane-setup'"));
        expect(setupRows).toHaveLength(1);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
        fs.rmSync(laneRoot, { recursive: true, force: true });
      }
    });

  });

});

// Folded from the former linearAutomationDispatch.test.ts: the Linear webhook →
// automation-trigger mapping (label-add one-shot diffing) is part of the same
// automation-trigger contract, so it lives here rather than in its own file.
function makeLinearEvent(overrides: Partial<LinearIngressEventRecord> = {}): LinearIngressEventRecord {
  return {
    id: "row-1",
    source: "relay",
    deliveryId: "delivery-1",
    kind: "issue.update",
    eventId: "evt-1",
    entityType: "Issue",
    action: "update",
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    summary: "ENG-1: Fix OAuth",
    payload: null,
    createdAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildLinearAutomationDispatches", () => {
  it("returns nothing for events without an issue id", () => {
    expect(buildLinearAutomationDispatches(makeLinearEvent({ issueId: null }))).toEqual([]);
  });

  it("emits issue_updated for a plain edit with no label change", () => {
    const event = makeLinearEvent({
      payload: {
        data: { title: "Fix OAuth", labelIds: ["l1"], labels: [{ id: "l1", name: "bug" }] },
        updatedFrom: { title: "Old" },
      },
    });
    const dispatches = buildLinearAutomationDispatches(event);
    expect(dispatches.map((d) => d.triggerType)).toEqual(["linear.issue_updated"]);
  });

  it("emits a one-shot issue_labeled and suppresses issue_updated for a pure label add", () => {
    const event = makeLinearEvent({
      payload: {
        data: {
          labelIds: ["l1", "l2"],
          labels: [
            { id: "l1", name: "bug" },
            { id: "l2", name: "ready-for-ade" },
          ],
        },
        updatedFrom: { labelIds: ["l1"] },
      },
    });
    const dispatches = buildLinearAutomationDispatches(event);
    // Only the labeled event fires — no duplicate issue_updated.
    expect(dispatches.map((d) => d.triggerType)).toEqual(["linear.issue_labeled"]);
    const labeled = dispatches[0]!;
    // The matchable labels are the *added* names only.
    expect(labeled.labels).toEqual(["ready-for-ade"]);
    expect(labeled.eventKey).toContain("labeled");
    expect((labeled.rawPayload as { addedLabels?: string[] })?.addedLabels).toEqual(["ready-for-ade"]);
  });

  it("keeps a concurrent status change alongside the labeled event", () => {
    const event = makeLinearEvent({
      payload: {
        data: {
          state: { name: "In Progress" },
          labelIds: ["l1", "l2"],
          labels: [
            { id: "l1", name: "bug" },
            { id: "l2", name: "ready-for-ade" },
          ],
        },
        updatedFrom: { labelIds: ["l1"], state: { name: "Todo" } },
      },
    });
    const dispatches = buildLinearAutomationDispatches(event);
    // Both fire: the labeled one-shot and the real status transition.
    expect(dispatches.map((d) => d.triggerType).sort()).toEqual([
      "linear.issue_labeled",
      "linear.issue_status_changed",
    ]);
    const status = dispatches.find((d) => d.triggerType === "linear.issue_status_changed")!;
    expect(status.stateTransition).toBe("Todo->In Progress");
  });

  it("keeps a concurrent assignment alongside the labeled event", () => {
    const event = makeLinearEvent({
      payload: {
        data: {
          assigneeId: "user-2",
          labelIds: ["l1", "l2"],
          labels: [
            { id: "l1", name: "bug" },
            { id: "l2", name: "ready-for-ade" },
          ],
        },
        updatedFrom: { labelIds: ["l1"], assigneeId: "user-1" },
      },
    });
    const dispatches = buildLinearAutomationDispatches(event);
    expect(dispatches.map((d) => d.triggerType).sort()).toEqual([
      "linear.issue_assigned",
      "linear.issue_labeled",
    ]);
  });

  it("does not treat a removed label as an add", () => {
    const event = makeLinearEvent({
      payload: {
        data: { labelIds: ["l1"], labels: [{ id: "l1", name: "bug" }] },
        updatedFrom: { labelIds: ["l1", "l2"] },
      },
    });
    const dispatches = buildLinearAutomationDispatches(event);
    expect(dispatches.map((d) => d.triggerType)).toEqual(["linear.issue_updated"]);
  });

  it("does not emit issue_labeled on create even when labels are present", () => {
    const event = makeLinearEvent({
      action: "create",
      payload: {
        data: { labelIds: ["l1"], labels: [{ id: "l1", name: "bug" }] },
      },
    });
    const dispatches = buildLinearAutomationDispatches(event);
    expect(dispatches.map((d) => d.triggerType)).toEqual(["linear.issue_created"]);
  });

  it("ignores an added label id with no resolvable name", () => {
    const event = makeLinearEvent({
      payload: {
        // l2 was added but has no entry in `labels`, so we can't name it → skip.
        data: { labelIds: ["l1", "l2"], labels: [{ id: "l1", name: "bug" }] },
        updatedFrom: { labelIds: ["l1"] },
      },
    });
    const dispatches = buildLinearAutomationDispatches(event);
    // No nameable added label → fall through to the plain update event.
    expect(dispatches.map((d) => d.triggerType)).toEqual(["linear.issue_updated"]);
  });
});

describe("automation ingress storage bounds", () => {
  function createIngressService(
    db: AdeDb,
    logger = createLogger(),
  ): ReturnType<typeof createAutomationService> {
    return createAutomationService({
      db: db as any,
      logger,
      projectId: "proj",
      projectRoot: "/tmp",
      laneService: {
        list: async () => [],
        getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "main", worktreePath: "/tmp" }),
        getLaneWorktreePath: () => "/tmp",
      } as any,
      projectConfigService: {
        get: () => ({
          trust: { requiresSharedTrust: false },
          effective: { automations: [], providerMode: "guest" },
        }),
      } as any,
    });
  }

  it("keeps only 2,000 slim rows during an insert storm and preserves the seven-day dedup window", async () => {
    const { db, raw } = createInMemoryAdeDb();
    const service = createIngressService(db);

    try {
      for (let index = 0; index < 10_000; index += 1) {
        await service.dispatchIngressTrigger({
          source: "github-relay",
          eventKey: `storm-${index}`,
          triggerType: "github.issue_opened",
          eventName: "github.issue_opened",
          rawPayload: { index, body: "payload that must never reach disk" },
        });
      }

      const count = Number(mapExecRows(raw.exec(
        "select count(*) as count from automation_ingress_events where project_id = 'proj'",
      ))[0]?.count ?? 0);
      expect(count).toBe(2_000);
      expect(mapExecRows(raw.exec(
        "select count(*) as count from automation_ingress_events where raw_payload_json is not null",
      ))[0]?.count).toBe(0);

      const original = await service.dispatchIngressTrigger({
        source: "github-relay",
        eventKey: "storm-9999",
        triggerType: "github.issue_opened",
        rawPayload: { replay: "within-window" },
      });
      expect(original).not.toBeNull();
      const storedOriginal = mapExecRows(raw.exec(
        "select id from automation_ingress_events where event_key = 'storm-9999'",
      ));
      expect(storedOriginal).toHaveLength(1);
      expect(original?.id).toBe(storedOriginal[0]?.id);

      raw.run(
        "update automation_ingress_events set received_at = ? where event_key = 'storm-9999'",
        [new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString()],
      );
      await service.dispatchIngressTrigger({
        source: "github-relay",
        eventKey: "ttl-prune-trigger",
        triggerType: "github.issue_opened",
      });
      const replayed = await service.dispatchIngressTrigger({
        source: "github-relay",
        eventKey: "storm-9999",
        triggerType: "github.issue_opened",
        rawPayload: { replay: "after-window" },
      });
      expect(replayed?.id).not.toBe(original?.id);
      expect(mapExecRows(raw.exec(
        "select count(*) as count from automation_ingress_events where raw_payload_json is not null",
      ))[0]?.count).toBe(0);

      // Dispatched rows are exempt from the count cap; an equally-old ignored
      // row beyond the newest 2,000 is not. Both are within the 7-day window so
      // the age prune leaves them; only the count cap acts.
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000).toISOString();
      raw.run(
        `insert into automation_ingress_events(id, project_id, source, event_key, automation_ids_json, trigger_type, status, raw_payload_json, received_at)
         values ('keep-dispatched', 'proj', 'github-relay', 'keep-dispatched', '[]', 'github.issue_opened', 'dispatched', null, ?)`,
        [fiveDaysAgo],
      );
      raw.run(
        `insert into automation_ingress_events(id, project_id, source, event_key, automation_ids_json, trigger_type, status, raw_payload_json, received_at)
         values ('drop-ignored', 'proj', 'github-relay', 'drop-ignored', '[]', 'github.issue_opened', 'ignored', null, ?)`,
        [fiveDaysAgo],
      );
      // A fresh dispatch runs prune-on-insert.
      await service.dispatchIngressTrigger({
        source: "github-relay",
        eventKey: "count-cap-trigger",
        triggerType: "github.issue_opened",
      });
      expect(mapExecRows(raw.exec(
        "select count(*) as count from automation_ingress_events where event_key = 'keep-dispatched'",
      ))[0]?.count).toBe(1);
      expect(mapExecRows(raw.exec(
        "select count(*) as count from automation_ingress_events where event_key = 'drop-ignored'",
      ))[0]?.count).toBe(0);
    } finally {
      service.dispose();
    }
  }, 120_000);

  it("reclaims legacy payloads and local caches once, in bounded chunks", () => {
    const { db, raw } = createInMemoryAdeDb();
    raw.run("create table review_run_artifacts(id text primary key, created_at text not null)");
    raw.run("create table pull_request_snapshots(pr_id text primary key, updated_at text not null)");

    const recent = new Date().toISOString();
    const oldIngress = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
    const oldReview = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString();
    const oldSnapshot = new Date(Date.now() - 61 * 24 * 60 * 60 * 1_000).toISOString();
    raw.run("begin");
    const insert = raw.prepare(`
      insert into automation_ingress_events(
        id, project_id, source, event_key, automation_ids_json, trigger_type,
        status, raw_payload_json, received_at
      ) values (?, 'proj', 'github-relay', ?, '[]', 'github.issue_opened', ?, ?, ?)
    `);
    for (let index = 0; index < 2_205; index += 1) {
      insert.run([
        `legacy-${index}`,
        `legacy-key-${index}`,
        index < 2_202 ? "ignored" : "dispatched",
        JSON.stringify({ index, body: "legacy payload" }),
        index < 100 ? oldIngress : recent,
      ]);
    }
    insert.free();
    raw.run("commit");
    raw.run("insert into review_run_artifacts values ('old-review', ?), ('new-review', ?)", [oldReview, recent]);
    raw.run("insert into pull_request_snapshots values ('old-pr', ?), ('new-pr', ?)", [oldSnapshot, recent]);

    const info = vi.fn();
    const logger = { ...createLogger(), info } as any;
    const first = createIngressService(db, logger);
    try {
      expect(mapExecRows(raw.exec(
        "select count(*) as count from automation_ingress_events where raw_payload_json is not null",
      ))[0]?.count).toBe(0);
      // 2,000 newest non-dispatched rows + the 3 dispatched rows (exempt from
      // the count cap) survive; the 100 aged-out rows are pruned by age.
      expect(mapExecRows(raw.exec(
        "select count(*) as count from automation_ingress_events where project_id = 'proj'",
      ))[0]?.count).toBe(2_003);
      expect(mapExecRows(raw.exec("select id from review_run_artifacts order by id"))).toEqual([{ id: "new-review" }]);
      expect(mapExecRows(raw.exec("select pr_id from pull_request_snapshots order by pr_id"))).toEqual([{ pr_id: "new-pr" }]);
      expect(info).toHaveBeenCalledWith("automations.ingress_payload_reclaim", {
        rowsCleared: 2_205,
        bytesCleared: expect.any(Number),
      });
      expect(Number(info.mock.calls[0]?.[1]?.bytesCleared ?? 0)).toBeGreaterThan(0);

      const logCount = info.mock.calls.length;
      const second = createIngressService(db, logger);
      second.dispose();
      expect(info).toHaveBeenCalledTimes(logCount);
      expect(mapExecRows(raw.exec(
        "select count(*) as count from automation_ingress_events where project_id = 'proj'",
      ))[0]?.count).toBe(2_003);
    } finally {
      first.dispose();
    }
  });

  it("survives a failure while reclaiming legacy ingress payloads", () => {
    const { db, raw } = createInMemoryAdeDb();
    raw.run(
      `insert into automation_ingress_events(id, project_id, source, event_key, automation_ids_json, trigger_type, status, raw_payload_json, received_at)
       values ('legacy-1', 'proj', 'github-relay', 'legacy-key-1', '[]', 'github.issue_opened', 'ignored', ?, ?)`,
      [JSON.stringify({ body: "legacy" }), new Date().toISOString()],
    );
    const warn = vi.fn();
    const logger = { ...createLogger(), warn } as any;
    // Force the reclaim UPDATE to throw; every other statement runs normally.
    const failingDb: AdeDb = {
      ...db,
      run: (sql: string, params?: SqlValue[]) => {
        if (typeof sql === "string" && sql.includes("set raw_payload_json = null")) {
          throw new Error("reclaim boom");
        }
        return db.run(sql, params);
      },
    };
    const service = createIngressService(failingDb, logger);
    service.dispose();
    expect(warn).toHaveBeenCalledWith(
      "automations.ingress_payload_reclaim_failed",
      expect.objectContaining({ error: expect.stringContaining("reclaim boom") }),
    );
    // Construction still succeeded and the legacy row is left in place to retry.
    expect(mapExecRows(raw.exec(
      "select count(*) as count from automation_ingress_events where raw_payload_json is not null",
    ))[0]?.count).toBe(1);
  });
});
