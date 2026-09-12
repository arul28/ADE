import { beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import {
  ONE_SHOT_DEFAULT_MAX_RUNS,
  createAutomationService,
  normalizeRuntimeRule,
  resolvePlaceholders,
  triggerMatches,
} from "./automationService";
import type { AutomationRuleInput, TriggerContext } from "./automationService";
import type { AutomationAction } from "../../../shared/types";

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
  SQL = await initSqlJs({ locateFile: (file) => path.join(path.dirname(wasmPath), file) });
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
  raw.run(`
    create table pull_requests(
      id text primary key,
      project_id text not null,
      lane_id text not null,
      state text not null,
      detached_at text
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
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
}

function makeRule(overrides: Partial<AutomationRuleInput> & { id: string }): AutomationRuleInput {
  return {
    name: overrides.name ?? overrides.id,
    enabled: true,
    mode: "monitor",
    triggers: [{ type: "manual" }],
    trigger: { type: "manual" },
    executor: { mode: "automation-bot" },
    reviewProfile: "quick",
    toolPalette: ["repo"],
    contextSources: [],
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: `auto:${overrides.id}`,
    actions: [],
    ...overrides,
  } as AutomationRuleInput;
}

/**
 * Config harness whose `effective.automations` is derived from `shared` +
 * `local`, so a rule that deletes itself really disappears — and a shared rule,
 * which this process must never rewrite, really does not.
 */
function makeProjectConfigHarness(rules: AutomationRuleInput[], sharedRules: AutomationRuleInput[] = []) {
  let local: any = { automations: rules.map((rule) => ({ ...rule })) };
  let shared: any = { automations: sharedRules.map((rule) => ({ ...rule })) };
  const snapshot = () => ({
    trust: { requiresSharedTrust: false },
    shared,
    local,
    effective: {
      automations: [...(shared.automations ?? []), ...(local.automations ?? [])]
        .map((rule: any) => normalizeRuntimeRule(rule)),
      providerMode: "guest",
      ui: {},
    },
  });
  return {
    service: {
      get: () => snapshot(),
      save: (next: any) => {
        local = next.local ?? local;
        shared = next.shared ?? shared;
        return snapshot();
      },
    } as any,
    listLocalIds: () => (local.automations ?? []).map((rule: any) => rule.id),
    listSharedIds: () => (shared.automations ?? []).map((rule: any) => rule.id),
  };
}

/** Lanes the service asked laneService to create, newest last. Reset per service. */
const lanesCreated: Array<{ id: string; name: string; branchRef: string }> = [];

function createService(args: {
  rules: AutomationRuleInput[];
  /** Rules that live in `.ade/ade.yaml`, which this process may never rewrite. */
  sharedRules?: AutomationRuleInput[];
  agentChatService?: unknown;
  db?: { db: AdeDb; raw: Database };
}) {
  const store = args.db ?? createInMemoryAdeDb();
  const projectConfig = makeProjectConfigHarness(args.rules, args.sharedRules ?? []);
  const events: Array<Record<string, unknown>> = [];
  lanesCreated.length = 0;
  const service = createAutomationService({
    db: store.db as any,
    logger: createLogger(),
    projectId: "proj",
    projectRoot: "/tmp",
    laneService: {
      getLaneBaseAndBranch: () => ({ baseRef: "main", branchRef: "feat/demo", worktreePath: "/tmp" }),
      getLaneWorktreePath: () => "/tmp",
      list: async () => [{ id: "lane-1", name: "Demo lane" }],
      create: async ({ name }: { name: string }) => {
        const lane = {
          id: `lane-new-${lanesCreated.length + 1}`,
          name,
          branchRef: `ade/${lanesCreated.length + 1}`,
        };
        lanesCreated.push(lane);
        return lane;
      },
    } as any,
    projectConfigService: projectConfig.service,
    ...(args.agentChatService ? { agentChatService: args.agentChatService as any } : {}),
    onEvent: (payload) => { events.push(payload as Record<string, unknown>); },
  });
  return { service, projectConfig, store, events };
}

describe("rule provenance normalization", () => {
  it("defaults origin to user when the config has none", () => {
    const normalized = normalizeRuntimeRule(makeRule({ id: "legacy-rule" }));
    expect(normalized.origin).toBe("user");
    expect(normalized.scope).toBeUndefined();
    expect(normalized.oneShot).toBeUndefined();
  });

  it("keeps a recorded origin, scope, originRequest, and oneShot", () => {
    const normalized = normalizeRuntimeRule(makeRule({
      id: "chat-rule",
      origin: "chat-menu",
      scope: { sessionId: "chat-123", sessionTitle: "Fix the flaky test" },
      originRequest: "when this chat hits its limit, hand off to Sol",
      oneShot: true,
    }));
    expect(normalized.origin).toBe("chat-menu");
    // The title lives on the rule so a deleted chat still has a readable label.
    expect(normalized.scope).toEqual({ sessionId: "chat-123", sessionTitle: "Fix the flaky test" });
    expect(normalized.originRequest).toBe("when this chat hits its limit, hand off to Sol");
    expect(normalized.oneShot).toBe(true);
  });

  it("rejects an unknown origin and a scope with no session id", () => {
    const normalized = normalizeRuntimeRule(makeRule({
      id: "bad-provenance",
      origin: "robot" as never,
      scope: { sessionId: "   ", sessionTitle: "Ghost" },
    }));
    expect(normalized.origin).toBe("user");
    expect(normalized.scope).toBeUndefined();
  });
});

describe("session trigger filters", () => {
  const trigger: TriggerContext = {
    triggerType: "session.limit_reached",
    sessionId: "chat-123",
    laneId: "lane-1",
    session: {
      sessionId: "chat-123",
      provider: "claude",
      modelId: "anthropic/claude-sonnet-5",
      laneId: "lane-1",
      resetAt: "2026-09-11T18:00:00.000Z",
    },
  };

  it("matches only the scoped session", () => {
    expect(triggerMatches({ type: "session.limit_reached", sessionId: "chat-123" }, trigger, undefined, undefined)).toBe(true);
    expect(triggerMatches({ type: "session.limit_reached", sessionId: "chat-999" }, trigger, undefined, undefined)).toBe(false);
    // No sessionId on the rule means "any chat".
    expect(triggerMatches({ type: "session.limit_reached" }, trigger, undefined, undefined)).toBe(true);
  });

  it("matches the provider allow-list case-insensitively", () => {
    expect(triggerMatches({ type: "session.limit_reached", providers: ["Claude"] }, trigger, undefined, undefined)).toBe(true);
    expect(triggerMatches({ type: "session.limit_reached", providers: ["codex", "cursor"] }, trigger, undefined, undefined)).toBe(false);
    expect(triggerMatches({ type: "session.limit_reached", providers: [] }, trigger, undefined, undefined)).toBe(true);
  });

  it("does not match a provider filter when the event carries no provider", () => {
    const bare: TriggerContext = { triggerType: "session.failed", sessionId: "chat-5", session: { sessionId: "chat-5" } };
    expect(triggerMatches({ type: "session.failed", providers: ["claude"] }, bare, undefined, undefined)).toBe(false);
    expect(triggerMatches({ type: "session.failed" }, bare, undefined, undefined)).toBe(true);
  });
});

describe("{{trigger.session.*}} placeholders", () => {
  it("resolves session fields and blanks unknown ones", () => {
    const trigger: TriggerContext = {
      triggerType: "session.limit_reached",
      session: {
        sessionId: "chat-123",
        provider: "claude",
        modelId: "anthropic/claude-sonnet-5",
        laneId: "lane-1",
        resetAt: "2026-09-11T18:00:00.000Z",
      },
    };
    expect(resolvePlaceholders(
      "{{trigger.session.provider}} hit its limit until {{trigger.session.resetAt}}",
      trigger,
    )).toBe("claude hit its limit until 2026-09-11T18:00:00.000Z");
    // A whole-string placeholder returns the raw value.
    expect(resolvePlaceholders("{{trigger.session.sessionId}}", trigger)).toBe("chat-123");
    expect(resolvePlaceholders("note: {{trigger.session.nope}}", trigger)).toBe("note: ");
  });
});

describe("handoff action", () => {
  const handoffAction: AutomationAction = {
    type: "handoff",
    handoffMode: "brief",
    targetModelId: "openai/gpt-5.6-sol",
    promptTemplate: "Continue from {{trigger.session.modelId}} — limit resets at {{trigger.session.resetAt}}.",
    reasoningEffort: "high",
  };

  function handoffRule(overrides: Partial<AutomationRuleInput> = {}): AutomationRuleInput {
    return makeRule({
      id: "handoff-on-limit",
      name: "Hand off on limit",
      triggers: [{ type: "session.limit_reached" }],
      trigger: { type: "session.limit_reached" },
      execution: { kind: "built-in", builtIn: { actions: [handoffAction] } },
      ...overrides,
    });
  }

  type HandoffArgs = Record<string, unknown>;

  function agentChatStub() {
    return {
      handoffSession: vi.fn(async (_args: HandoffArgs) => ({
        session: { id: "chat-new", laneId: "lane-1" },
        usedFallbackSummary: false,
      })),
    };
  }

  function failingAgentChatStub() {
    return {
      handoffSession: vi.fn(async (_args: HandoffArgs) => {
        throw new Error("provider refused the handoff");
      }),
    };
  }

  const limitSignal = {
    kind: "limit_reached" as const,
    sessionId: "chat-123",
    provider: "claude",
    laneId: "lane-1",
  };

  it("calls handoffSession with the resolved arguments and reports the new session id", async () => {
    const agentChatService = agentChatStub();
    const { service, store, events } = createService({ rules: [handoffRule()], agentChatService });

    service.onSessionSignal({
      kind: "limit_reached",
      sessionId: "chat-123",
      provider: "claude",
      modelId: "anthropic/claude-sonnet-5",
      laneId: "lane-1",
      resetAt: "2026-09-11T18:00:00.000Z",
    });

    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    });
    expect(agentChatService.handoffSession).toHaveBeenCalledWith({
      sourceSessionId: "chat-123",
      targetModelId: "openai/gpt-5.6-sol",
      mode: "brief",
      // No targetLaneMode on the action: the trigger's lane, which for a
      // session trigger is the source chat's own lane.
      targetLaneId: "lane-1",
      handoffNote: "Continue from anthropic/claude-sonnet-5 — limit resets at 2026-09-11T18:00:00.000Z.",
      reasoningEffort: "high",
    });

    await vi.waitFor(() => {
      const rows = store.db.all<{ chat_session_id: string | null; status: string; output: string }>(
        `select r.chat_session_id, r.status, a.output
           from automation_runs r join automation_action_results a on a.run_id = r.id`,
      );
      expect(rows).toHaveLength(1);
      // The new chat is on the run itself...
      expect(rows[0]?.chat_session_id).toBe("chat-new");
      expect(JSON.parse(rows[0]?.output ?? "{}")).toMatchObject({ sessionId: "chat-new", mode: "brief" });
    });

    // ...and on the runs-updated event, which is how the renderer learns the id
    // it needs to build its own (renderer-only) HandoffLaunchJob.
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "runs-updated" && event.handoffSessionId === "chat-new")).toBe(true);
    });

    service.dispose();
  });

  it("fails the action when the trigger carries no session", async () => {
    const agentChatService = agentChatStub();
    const rule = handoffRule({ id: "handoff-manual", triggers: [{ type: "manual" }], trigger: { type: "manual" } });
    const { service, store } = createService({ rules: [rule], agentChatService });

    await service.triggerManually({ id: "handoff-manual" });

    expect(agentChatService.handoffSession).not.toHaveBeenCalled();
    const rows = store.db.all<{ status: string; error_message: string | null }>(
      "select status, error_message from automation_action_results",
    );
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error_message).toContain("chat session id");

    service.dispose();
  });

  it("passes no lane when neither the action nor the trigger names one", async () => {
    const agentChatService = agentChatStub();
    const rule = handoffRule({ id: "handoff-no-lane" });
    const { service } = createService({ rules: [rule], agentChatService });

    // No laneId on the signal: handoffSession resolves the source chat's lane.
    service.onSessionSignal({ kind: "limit_reached", sessionId: "chat-123", provider: "claude" });

    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    });
    expect(agentChatService.handoffSession.mock.calls[0]![0]).not.toHaveProperty("targetLaneId");

    service.dispose();
  });

  it("uses the named lane for targetLaneMode explicit", async () => {
    const agentChatService = agentChatStub();
    const rule = handoffRule({
      id: "handoff-explicit",
      execution: {
        kind: "built-in",
        builtIn: {
          actions: [{
            ...handoffAction,
            targetLaneMode: "explicit",
            targetLaneId: "lane-chosen",
          }],
        },
      },
    });
    const { service } = createService({ rules: [rule], agentChatService });

    service.onSessionSignal(limitSignal);

    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    });
    // The explicit lane beats the trigger lane, matching how every other
    // action resolves an action-level targetLaneId first.
    expect(agentChatService.handoffSession.mock.calls[0]![0]).toMatchObject({ targetLaneId: "lane-chosen" });

    service.dispose();
  });

  it("rejects targetLaneMode explicit with no lane", async () => {
    const agentChatService = agentChatStub();
    const rule = handoffRule({
      id: "handoff-explicit-empty",
      execution: {
        kind: "built-in",
        builtIn: { actions: [{ ...handoffAction, targetLaneMode: "explicit" }] },
      },
    });
    const { service, store } = createService({ rules: [rule], agentChatService });

    service.onSessionSignal(limitSignal);

    await vi.waitFor(() => {
      const rows = store.db.all<{ status: string; error_message: string | null }>(
        "select status, error_message from automation_action_results",
      );
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.error_message).toContain("requires targetLaneId");
    });
    // It must not silently fall back to the trigger or source lane.
    expect(agentChatService.handoffSession).not.toHaveBeenCalled();

    service.dispose();
  });

  it("rejects a fork that tries to move lane", async () => {
    const agentChatService = agentChatStub();
    const rule = handoffRule({
      id: "handoff-fork-move",
      execution: {
        kind: "built-in",
        builtIn: {
          actions: [{ ...handoffAction, handoffMode: "fork", targetLaneMode: "new" }],
        },
      },
    });
    const { service, store } = createService({ rules: [rule], agentChatService });

    service.onSessionSignal(limitSignal);

    await vi.waitFor(() => {
      const rows = store.db.all<{ status: string; error_message: string | null }>(
        "select status, error_message from automation_action_results",
      );
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.error_message).toContain("must stay in its source lane");
    });
    expect(agentChatService.handoffSession).not.toHaveBeenCalled();
    expect(lanesCreated).toHaveLength(0);

    service.dispose();
  });

  it("never steers a fork's lane, even when the trigger carries one", async () => {
    const agentChatService = agentChatStub();
    const rule = handoffRule({
      id: "handoff-fork-same",
      execution: {
        kind: "built-in",
        builtIn: { actions: [{ ...handoffAction, handoffMode: "fork" }] },
      },
    });
    const { service } = createService({ rules: [rule], agentChatService });

    service.onSessionSignal(limitSignal);

    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    });
    const args = agentChatService.handoffSession.mock.calls[0]![0];
    expect(args.mode).toBe("fork");
    // handoffSession keys a fork's transcript to the source lane worktree, so
    // main hands it no lane at all.
    expect(args).not.toHaveProperty("targetLaneId");

    service.dispose();
  });

  it("creates a lane for targetLaneMode new and hands off into it", async () => {
    const agentChatService = agentChatStub();
    const rule = handoffRule({
      id: "handoff-new-lane",
      scope: { sessionId: "chat-123", sessionTitle: "Fix the flaky test" },
      execution: {
        kind: "built-in",
        builtIn: { actions: [{ ...handoffAction, targetLaneMode: "new" }] },
      },
    });
    const { service, store } = createService({ rules: [rule], agentChatService });

    service.onSessionSignal(limitSignal);

    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    });
    expect(lanesCreated).toHaveLength(1);
    // Named from the chat's stored title, through the shared lane-creation
    // helper, so collisions get the same suffix treatment as every other
    // automation-created lane.
    expect(lanesCreated[0]?.name).toBe("Fix the flaky test");
    expect(agentChatService.handoffSession.mock.calls[0]![0]).toMatchObject({ targetLaneId: "lane-new-1" });

    await vi.waitFor(() => {
      const rows = store.db.all<{ output: string }>("select output from automation_action_results");
      expect(JSON.parse(rows[0]?.output ?? "{}")).toMatchObject({
        targetLaneMode: "new",
        createdLaneName: "Fix the flaky test",
      });
    });

    service.dispose();
  });

  it("deletes a one-shot rule after a successful run", async () => {
    const agentChatService = agentChatStub();
    const { service, projectConfig } = createService({
      rules: [handoffRule({ oneShot: true })],
      agentChatService,
    });

    expect(projectConfig.listLocalIds()).toContain("handoff-on-limit");

    service.onSessionSignal(limitSignal);

    await vi.waitFor(() => {
      expect(projectConfig.listLocalIds()).not.toContain("handoff-on-limit");
    });
    // A second signal finds no rule and must not run anything else.
    service.onSessionSignal(limitSignal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("keeps a one-shot rule when the run failed, and leaves the failure in history", async () => {
    const agentChatService = failingAgentChatStub();
    const { service, projectConfig, store } = createService({
      rules: [handoffRule({ oneShot: true, maxRuns: 3 })],
      agentChatService,
    });

    service.onSessionSignal(limitSignal);

    await vi.waitFor(() => {
      expect(store.db.all("select id from automation_runs where status = 'failed'")).toHaveLength(1);
    });
    // The rule did not do its job, so it stays and can try again.
    expect(projectConfig.listLocalIds()).toContain("handoff-on-limit");

    service.onSessionSignal(limitSignal);
    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(2);
    });
    expect(projectConfig.listLocalIds()).toContain("handoff-on-limit");

    service.dispose();
  });

  it("deletes a failing one-shot rule once it reaches maxRuns", async () => {
    const agentChatService = failingAgentChatStub();
    const { service, projectConfig } = createService({
      rules: [handoffRule({ oneShot: true, maxRuns: 2 })],
      agentChatService,
    });

    service.onSessionSignal(limitSignal);
    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    });
    expect(projectConfig.listLocalIds()).toContain("handoff-on-limit");

    service.onSessionSignal(limitSignal);
    await vi.waitFor(() => {
      // Second failure exhausts the budget: the rule retires instead of
      // retrying forever on a repeating trigger.
      expect(projectConfig.listLocalIds()).not.toContain("handoff-on-limit");
    });

    service.dispose();
  });

  it("caps an un-configured one-shot rule at the default budget", async () => {
    const agentChatService = failingAgentChatStub();
    const { service, projectConfig } = createService({
      rules: [handoffRule({ oneShot: true })],
      agentChatService,
    });

    for (let attempt = 1; attempt <= ONE_SHOT_DEFAULT_MAX_RUNS; attempt += 1) {
      service.onSessionSignal(limitSignal);
      await vi.waitFor(() => {
        expect(agentChatService.handoffSession).toHaveBeenCalledTimes(attempt);
      });
    }

    await vi.waitFor(() => {
      expect(projectConfig.listLocalIds()).not.toContain("handoff-on-limit");
    });

    service.dispose();
  });

  it("retires an UNSCOPED rule at maxRuns even though it is not one-shot", async () => {
    const agentChatService = agentChatStub();
    // "Make it a rule for all" writes no scope and no oneShot, but it does
    // write the Retries the user picked. The cap has to bound a rule that keeps
    // SUCCEEDING too, or a chat that ends the same way every time feeds it
    // forever.
    const { service, projectConfig } = createService({
      rules: [handoffRule({ maxRuns: 2 })],
      agentChatService,
    });

    service.onSessionSignal(limitSignal);
    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    });
    expect(projectConfig.listLocalIds()).toContain("handoff-on-limit");

    service.onSessionSignal(limitSignal);
    await vi.waitFor(() => {
      expect(projectConfig.listLocalIds()).not.toContain("handoff-on-limit");
    });

    // And it really is retired: a third signal runs nothing.
    service.onSessionSignal(limitSignal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agentChatService.handoffSession).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  it("claims the attempt before the run, so two triggers cannot both spend the last one", async () => {
    const agentChatService = agentChatStub();
    // Two Run-now presses landing together. Both find the rule (the lookup is
    // synchronous), both get past it, and the budget used to be recorded only
    // after a run finished — so a one-run rule created two chats and two lanes.
    const rule = handoffRule({
      id: "handoff-manual",
      triggers: [{ type: "manual" }],
      trigger: { type: "manual" },
      maxRuns: 1,
    });
    const { service, store, projectConfig } = createService({ rules: [rule], agentChatService });

    const outcomes = await Promise.allSettled([
      service.triggerManually({ id: "handoff-manual" }),
      service.triggerManually({ id: "handoff-manual" }),
    ]);

    expect(store.db.all("select id from automation_runs")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(projectConfig.listLocalIds()).not.toContain("handoff-manual");
    // The refused attempt was handed back, so the counter never ran past the cap.
    const counter = store.db.get<{ value: string }>(
      "select value from kv where key = 'automations.run-count.v1:proj:handoff-manual'",
    );
    expect(counter?.value ?? null).toBeNull();

    service.dispose();
  });

  it("stops dispatching a SHARED rule at its ceiling instead of firing forever", async () => {
    const agentChatService = agentChatStub();
    // `.ade/ade.yaml` belongs to the repo, so a spent shared rule is never
    // deleted. It still has to STOP: the counter is the gate, and it used to
    // just keep climbing while the rule ran on every future trigger.
    const { service, projectConfig, store } = createService({
      rules: [],
      sharedRules: [handoffRule({ maxRuns: 1 })],
      agentChatService,
    });

    service.onSessionSignal(limitSignal);
    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    });

    service.onSessionSignal(limitSignal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    expect(store.db.all("select id from automation_runs")).toHaveLength(1);
    // Kept, because this process does not rewrite shared config...
    expect(projectConfig.listSharedIds()).toContain("handoff-on-limit");
    // ...and parked at the ceiling rather than counting up forever.
    const counter = store.db.get<{ value: string }>(
      "select value from kv where key = 'automations.run-count.v1:proj:handoff-on-limit'",
    );
    expect(counter?.value).toBe("1");

    service.dispose();
  });

  it("never hands off a chat its own handoff created", async () => {
    const agentChatService = agentChatStub();
    // The self-feeding shape: one rule, every chat, "hand it off when it ends".
    const rule = handoffRule({
      id: "handoff-every-chat",
      triggers: [{ type: "session.ended_without_pr" }],
      trigger: { type: "session.ended_without_pr" },
    });
    const { service, store } = createService({ rules: [rule], agentChatService });

    service.onSessionEnded({ laneId: "lane-1", sessionId: "chat-123", provider: "claude" });
    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    });

    // The chat the handoff just created ends the same way. Without the origin
    // marker this is link two of an unbounded chain of chats (and of lanes,
    // for targetLaneMode "new").
    service.onSessionEnded({ laneId: "lane-1", sessionId: "chat-new", provider: "openai" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(agentChatService.handoffSession).toHaveBeenCalledTimes(1);
    expect(store.db.all("select id from automation_runs")).toHaveLength(1);

    // A different chat still triggers it: the guard is about provenance, not a
    // blanket cooldown.
    service.onSessionEnded({ laneId: "lane-1", sessionId: "chat-999", provider: "claude" });
    await vi.waitFor(() => {
      expect(agentChatService.handoffSession).toHaveBeenCalledTimes(2);
    });

    service.dispose();
  });
});

describe("agent-session run budget", () => {
  /** Lane resolution refuses before the session is ever created. */
  function laneRequiredRule(overrides: Partial<AutomationRuleInput> = {}): AutomationRuleInput {
    return makeRule({
      id: "agent-needs-lane",
      triggers: [{ type: "session.limit_reached" }],
      trigger: { type: "session.limit_reached" },
      execution: { kind: "agent-session", laneMode: "require-on-trigger" },
      ...overrides,
    });
  }

  it("spends an attempt when the run fails before it starts, and retires at the cap", async () => {
    const agentChatService = { handoffSession: vi.fn(), createSession: vi.fn(), runSessionTurn: vi.fn() };
    const { service, projectConfig, store } = createService({
      rules: [laneRequiredRule({ oneShot: true, maxRuns: 2 })],
      agentChatService,
    });

    // No lane on the signal, and the rule demands one from the trigger, so the
    // dispatch throws before any chat exists.
    service.onSessionSignal({ kind: "limit_reached", sessionId: "chat-123", provider: "claude" });
    await vi.waitFor(() => {
      expect(store.db.all("select id from automation_runs where status = 'failed'")).toHaveLength(1);
    });
    expect(agentChatService.createSession).not.toHaveBeenCalled();
    expect(projectConfig.listLocalIds()).toContain("agent-needs-lane");

    service.onSessionSignal({ kind: "limit_reached", sessionId: "chat-123", provider: "claude" });
    await vi.waitFor(() => {
      // A rule that can never resolve a lane used to keep its whole budget
      // forever and retry on every future trigger.
      expect(projectConfig.listLocalIds()).not.toContain("agent-needs-lane");
    });

    service.dispose();
  });
});

describe("session.ended_without_pr", () => {
  function endedRule(): AutomationRuleInput {
    return makeRule({
      id: "no-pr-nudge",
      triggers: [{ type: "session.ended_without_pr" }],
      trigger: { type: "session.ended_without_pr" },
      execution: { kind: "built-in", builtIn: { actions: [{ type: "predict-conflicts", condition: "false" }] } },
    });
  }

  it("fires when the lane has no open PR", async () => {
    const { service, store } = createService({ rules: [endedRule()] });
    service.onSessionEnded({ laneId: "lane-1", sessionId: "chat-9", provider: "codex" });
    await vi.waitFor(() => {
      const rows = store.db.all<{ trigger_type: string }>("select trigger_type from automation_runs");
      expect(rows.map((row) => row.trigger_type)).toContain("session.ended_without_pr");
    });
    service.dispose();
  });

  it("stays quiet when the lane already has an open PR", async () => {
    const store = createInMemoryAdeDb();
    store.db.run(
      "insert into pull_requests(id, project_id, lane_id, state, detached_at) values (?, ?, ?, ?, null)",
      ["pr-1", "proj", "lane-1", "open"],
    );
    const { service } = createService({ rules: [endedRule()], db: store });
    service.onSessionEnded({ laneId: "lane-1", sessionId: "chat-9" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.db.all("select id from automation_runs")).toHaveLength(0);
    service.dispose();
  });
});
