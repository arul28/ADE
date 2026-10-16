import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatModelInfo } from "../../../shared/types/chat";
import type { AdeQuotaBurnRate, AdeQuotaSample, AdeTurnUsageRecord } from "../../../shared/types/turnUsage";
import {
  MODEL_REGISTRY_AA_ATTRIBUTION,
  type ModelRegistryAgentRow,
  type ModelRegistryModel,
  type ModelRegistrySnapshot,
} from "../../../shared/routerRegistry";
import {
  buildModelRoutes,
  registryFamilyForModelId,
  routeBillingFor,
  type CatalogModel,
  type ModelRoute,
} from "./routeCatalog";
import {
  classifyRouterTask,
  pickRoute,
  planStatesFromBurnRates,
  routeCost,
} from "./routerCore";
import {
  attachSharedModelRouter,
  createModelRouterService,
  type ModelRouterService,
  type RouterShadowDecisionRow,
  type RouterShadowOutcomeRow,
} from "./modelRouterService";
import type { ModelRegistryStatus, ModelRegistryStore } from "./modelRegistryStore";

const NOW = Date.UTC(2026, 8, 29, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const WEEK_RESET = iso(NOW + 3 * 86_400_000);

function model(
  slug: string,
  index: number,
  costPerIndexTaskUsd: number,
  secondsPerIndexTask: number,
): ModelRegistryModel {
  return {
    slug,
    releaseSlug: slug,
    name: slug,
    shortName: null,
    creator: null,
    releaseDate: null,
    deprecated: false,
    effort: null,
    reasoning: true,
    openWeights: false,
    contextWindow: 200_000,
    intelligenceIndex: index,
    intelligenceIndexEstimated: false,
    terminalBench40: null,
    sciCode: null,
    longContextReasoning: null,
    humanitysLastExam: null,
    gpqa: null,
    ifBench: null,
    costPerIndexTaskUsd,
    secondsPerIndexTask,
    outputTokensPerSecond: null,
    timeToFirstTokenSeconds: null,
    price: { input: null, output: null, cacheRead: null, cacheWrite: null },
  };
}

function agentRow(agent: string, modelSlug: string, score: number): ModelRegistryAgentRow {
  return {
    id: `${agent}:${modelSlug}`,
    agent,
    label: `${agent} - ${modelSlug}`,
    modelSlug,
    pair: false,
    score,
    evals: [],
    costUsdPerTask: null,
    minutesPerTask: null,
    stepsPerTask: null,
    cacheHitRate: null,
    tokensPerTask: null,
  };
}

function snapshot(models: ModelRegistryModel[], agents: ModelRegistryAgentRow[]): ModelRegistrySnapshot {
  return {
    schemaVersion: 1,
    generatedAt: iso(NOW),
    attribution: MODEL_REGISTRY_AA_ATTRIBUTION,
    sources: {
      artificialAnalysis: { fetchedAt: iso(NOW), ok: true },
      modelsDev: { fetchedAt: iso(NOW), ok: true },
    },
    models,
    agents,
    prices: {},
  };
}

function catalogModel(provider: string, modelId: string): CatalogModel {
  const info: AgentChatModelInfo = { id: modelId, displayName: modelId, isDefault: false, modelId };
  return { provider, info };
}

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const SOL = "gpt-6-sol";

function baseCatalog(): CatalogModel[] {
  return [
    catalogModel("claude", OPUS),
    catalogModel("claude", SONNET),
    catalogModel("codex", SOL),
  ];
}

function baseSnapshot(): ModelRegistrySnapshot {
  return snapshot(
    [model(OPUS, 60, 6, 800), model(SONNET, 50, 2, 400), model(SOL, 55, 1, 500)],
    [
      agentRow("Claude Code", OPUS, 0.70),
      agentRow("Claude Code", SONNET, 0.66),
      agentRow("Codex", SOL, 0.50),
    ],
  );
}

function claudePlan(percentUsed: number, confidence: AdeQuotaBurnRate["confidence"] = "high"): AdeQuotaBurnRate {
  return {
    provider: "claude",
    accountId: "claude:local",
    windowType: "weekly",
    usdPerPercent: 0.5,
    turnsPerPercent: 1,
    observedPercent: 10,
    observedUsd: 5,
    observedTurns: 5,
    latestPercentUsed: percentUsed,
    latestResetsAt: WEEK_RESET,
    headroomUsd: null,
    confidence,
  };
}

function codexPlan(percentUsed: number): AdeQuotaBurnRate {
  return {
    provider: "codex",
    accountId: "codex:local",
    windowType: "weekly",
    usdPerPercent: 0.5,
    turnsPerPercent: 1,
    observedPercent: 10,
    observedUsd: 5,
    observedTurns: 5,
    latestPercentUsed: percentUsed,
    latestResetsAt: WEEK_RESET,
    headroomUsd: null,
    confidence: "high",
  };
}

function routeFor(routes: readonly ModelRoute[], modelId: string): ModelRoute {
  const route = routes.find((entry) => entry.modelId === modelId);
  expect(route, `route for ${modelId}`).toBeDefined();
  return route!;
}

describe("route catalog", () => {
  it.each([
    ["openai/gpt-5.6-sol", "gpt-5-6-sol"],
    ["claude-opus-5-5-20260101", "claude-opus-5-5"],
    ["claude-haiku-4-5", "claude-4-5-haiku"],
    ["glm-5p3", "glm-5-3"],
    ["deepseek-flash", "deepseek-v4-1-flash"],
    ["some-model-free", "some-model"],
  ])("maps ADE model id %s to registry family %s", (modelId, family) => {
    expect(registryFamilyForModelId(modelId)).toBe(family);
  });

  it.each([
    ["claude", "claude-opus-5-5", { kind: "plan", plan: "claude" }],
    ["codex", "gpt-6-sol", { kind: "plan", plan: "codex" }],
    ["cursor", "auto", { kind: "plan", plan: "cursor" }],
    ["opencode", "opencode/opencode-go/glm-5", { kind: "plan", plan: "opencode-go" }],
    ["opencode", "opencode/opencode/glm-5", { kind: "metered", channel: "opencode-zen" }],
    ["opencode", "opencode/big-pickle-free", { kind: "free" }],
    ["claude", "claude-free-tier-5", { kind: "plan", plan: "claude" }],
  ] as const)("classifies %s/%s billing as %o", (harness, modelId, billing) => {
    expect(routeBillingFor(harness, modelId)).toEqual(billing);
  });

  it("rates a measured route from its Coding Agent row and an unmeasured one from the index fit", () => {
    const routes = buildModelRoutes(baseCatalog(), baseSnapshot());
    const opus = routeFor(routes, OPUS);
    expect(opus.quality).toMatchObject({ score: 0.7, source: "aa_agent_row" });
    expect(opus.billing).toEqual({ kind: "plan", plan: "claude" });
    expect(opus.costPerIndexTaskUsd).toBe(6);

    // The fitting line is read off the snapshot's own agent rows, so a model
    // with no agent row still gets a plausible score.
    const fitOnly = buildModelRoutes(
      [catalogModel("claude", OPUS), catalogModel("claude", "claude-haiku-5")],
      snapshot(
        [model(OPUS, 60, 6, 800), model("claude-haiku-5", 58, 0.5, 300)],
        [agentRow("Claude Code", OPUS, 0.7)],
      ),
    );
    const haiku = routeFor(fitOnly, "claude-haiku-5");
    expect(haiku.quality.source).toBe("aa_index_fit");
    expect(haiku.quality.score).toBeGreaterThan(0.6);
    expect(haiku.quality.score).toBeLessThan(0.7);
  });

  it("emits one route per reasoning effort the catalog offers", () => {
    const info: AgentChatModelInfo = {
      id: "claude-opus-5-5",
      displayName: "Opus",
      isDefault: true,
      modelId: OPUS,
      reasoningEfforts: [
        { effort: "high", description: "" },
        { effort: "low", description: "" },
      ],
    };
    const routes = buildModelRoutes([{ provider: "claude", info }], baseSnapshot());
    expect(routes.map((route) => route.effort).sort()).toEqual(["high", "low"]);
    expect(routes.every((route) => route.harness === "claude")).toBe(true);
  });
});

describe("router core", () => {
  it.each([
    ["explore the sync code", "explore", null, "read_only"],
    ["fix the parser bug", null, null, "light_edit"],
    ["implement the new router", null, null, "heavy_edit"],
    ["review this diff", null, null, "review"],
    ["run the tests", null, null, "test_run"],
    ["hello", null, null, "unknown"],
    // An edit that starts by reading is still an edit.
    ["Read the file and fix the parser bug", null, null, "light_edit"],
    // A workflow agent is named for its job.
    ["/root/quality_correctness", "/root/quality_correctness", null, "review"],
    // The brief decides when the label says too little.
    ["Quality Track A correctness", "general-purpose", "You are Track A. Do NOT edit any files; return findings only.", "review"],
    // A ban on every edit outranks the label's verb.
    ["Fix parser", null, "Do not edit any files. Find why the parser fails on CRLF.", "read_only"],
    ["Fix parser", null, "This is a read-only task. Investigate the bug.", "read_only"],
    // The earlier of an opening edit clause and a no-edit rule wins.
    ["Long-tail extractors", null, "Task: write read-only log extractors for these providers.", "light_edit"],
    ["Review the fixes", null, "READ-ONLY: do not edit, commit, or push anything. Work only in the lane worktree.", "review"],
    // "Doing read-only analysis" is one step of an edit brief.
    ["Fix async job errors", null, "You work in /x. Start by doing read-only analysis, then confine your edits to the job module.", "light_edit"],
  ] as const)("classifies task %s (agent %s, brief %s) as %s", (description, agentType, prompt, kind) => {
    expect(classifyRouterTask(description, agentType, prompt)).toBe(kind);
  });

  it("picks the cheaper same-harness route and reports the saving", () => {
    const routes = buildModelRoutes(baseCatalog(), baseSnapshot());
    const plans = planStatesFromBurnRates([claudePlan(10)], NOW);
    const pick = pickRoute({
      routes,
      reference: routeFor(routes, OPUS),
      kind: "light_edit",
      plans,
      trusted: new Set(),
    });
    expect(pick.reference?.route.modelId).toBe(OPUS);
    expect(pick.sameHarness?.route.modelId).toBe(SONNET);
    // $6 vs $2 per index task, both on the same 0.5 usd/percent plan.
    expect(pick.sameHarness?.cost.units).toBeLessThan(pick.reference!.cost.units!);
    expect(pick.sameHarness?.savingShare).toBeCloseTo(1 - 2 / 6, 3);
    expect(pick.sameHarness?.qualityDelta).toBeCloseTo(0.66 - 0.7, 3);
  });

  it("keeps the reference when every candidate is below the quality floor", () => {
    const routes = buildModelRoutes(
      baseCatalog(),
      snapshot(
        [model(OPUS, 60, 6, 800), model(SONNET, 50, 2, 400), model(SOL, 55, 1, 500)],
        [
          agentRow("Claude Code", OPUS, 0.7),
          agentRow("Claude Code", SONNET, 0.6),
          agentRow("Codex", SOL, 0.5),
        ],
      ),
    );
    const plans = planStatesFromBurnRates([claudePlan(10), codexPlan(10)], NOW);
    const pick = pickRoute({
      routes,
      reference: routeFor(routes, OPUS),
      kind: "light_edit",
      plans,
      trusted: new Set(),
    });
    expect(pick.sameHarness).toBeNull();
    expect(pick.anyHarness).toBeNull();
    expect(pick.keptBecause).toBeTruthy();
  });

  it("never picks an untrusted fitted route, even when it is cheaper", () => {
    const routes = buildModelRoutes(
      baseCatalog(),
      snapshot(
        [model(OPUS, 60, 6, 800), model(SONNET, 55, 2, 400), model(SOL, 55, 1, 500)],
        [agentRow("Claude Code", OPUS, 0.7)],
      ),
    );
    const plans = planStatesFromBurnRates([claudePlan(10)], NOW);
    const pick = pickRoute({
      routes,
      reference: routeFor(routes, OPUS),
      kind: "read_only",
      plans,
      trusted: new Set(),
    });
    // Sonnet fits above the read_only floor and is cheaper, but this machine
    // has never run it: an untrusted route is skipped.
    expect(pick.sameHarness).toBeNull();
    expect(pick.keptBecause).toBeTruthy();
  });

  it("never picks a route more than 1.5x slower than the reference", () => {
    const routes = buildModelRoutes(
      [catalogModel("claude", OPUS), catalogModel("claude", "claude-slow")],
      snapshot(
        [model(OPUS, 60, 6, 800), model("claude-slow", 58, 1, 2_000)],
        [agentRow("Claude Code", OPUS, 0.7), agentRow("Claude Code", "claude-slow", 0.68)],
      ),
    );
    const plans = planStatesFromBurnRates([claudePlan(10)], NOW);
    const pick = pickRoute({
      routes,
      reference: routeFor(routes, OPUS),
      kind: "read_only",
      plans,
      trusted: new Set(),
    });
    expect(routeFor(routes, "claude-slow").secondsPerIndexTask! / 800).toBeGreaterThan(1.5);
    expect(pick.sameHarness).toBeNull();
    expect(pick.keptBecause).toBeTruthy();
  });

  it("chooses the plan account with the most headroom and blocks a window at 95%", () => {
    const rates = [
      { ...claudePlan(96), accountId: "claude:a" },
      { ...claudePlan(10), accountId: "claude:b" },
    ];
    const states = planStatesFromBurnRates(rates, NOW);
    const claude = states.get("claude")!;
    expect(claude.accountId).toBe("claude:b");
    expect(claude.blockedReason).toBeNull();

    const blocked = planStatesFromBurnRates([claudePlan(96)], NOW).get("claude")!;
    expect(blocked.blockedReason).toContain("96%");
    const routes = buildModelRoutes([catalogModel("claude", OPUS)], baseSnapshot());
    expect(routeCost(routeFor(routes, OPUS), new Map([["claude", blocked]])).blockedReason)
      .toContain("96%");
  });

  it("allows a dearer route once the reference's own plan is blocked", () => {
    const routes = buildModelRoutes(
      [catalogModel("claude", OPUS), catalogModel("codex", SOL)],
      snapshot(
        [model(OPUS, 60, 6, 800), model(SOL, 55, 20, 500)],
        [agentRow("Claude Code", OPUS, 0.7), agentRow("Codex", SOL, 0.68)],
      ),
    );
    const input = (refPercent: number) => ({
      routes,
      reference: routeFor(routes, OPUS),
      kind: "light_edit" as const,
      plans: planStatesFromBurnRates([claudePlan(refPercent), codexPlan(10)], NOW),
      trusted: new Set<string>(),
    });
    // Codex is dearer ($20 vs $6), so normally the reference is kept...
    expect(pickRoute(input(10)).anyHarness).toBeNull();
    // ...but a blocked claude plan makes it the only runnable route.
    expect(pickRoute(input(96)).anyHarness?.route.modelId).toBe(SOL);
  });
});

function makeService(args: {
  dir: string;
  snapshot: ModelRegistrySnapshot;
  catalog?: CatalogModel[];
  enabled?: boolean;
  turns?: AdeTurnUsageRecord[];
  quotaSamples?: AdeQuotaSample[];
}): ModelRouterService {
  const status: ModelRegistryStatus = {
    source: "worker",
    generatedAt: args.snapshot.generatedAt,
    fetchedAt: args.snapshot.generatedAt,
    lastError: null,
    models: args.snapshot.models.length,
    agents: args.snapshot.agents.length,
  };
  const registry: ModelRegistryStore = {
    getSnapshot: () => args.snapshot,
    refresh: () => Promise.resolve(status),
    status: () => status,
  };
  const catalog = args.catalog ?? baseCatalog();
  return createModelRouterService({
    usageDir: args.dir,
    registry,
    getAvailableModels: async (provider) => catalog.filter((entry) => entry.provider === provider).map((entry) => entry.info),
    readTurns: async () => args.turns ?? [],
    readQuotaSamples: async () => args.quotaSamples ?? [],
    nowMs: () => NOW,
    enabled: args.enabled,
  });
}

function readRows(dir: string): Array<RouterShadowDecisionRow | RouterShadowOutcomeRow> {
  const file = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((name) => name.startsWith("router-shadow-"))
    : undefined;
  if (!file) return [];
  return fs
    .readFileSync(path.join(dir, file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RouterShadowDecisionRow | RouterShadowOutcomeRow);
}

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-router-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("shadow router service", () => {
  it("records what a subagent ran, with its brief and reported effort, when it finishes", async () => {
    const dir = makeDir();
    const service = makeService({ dir, snapshot: baseSnapshot() });
    const session = { provider: "claude", model: OPUS, modelId: OPUS, reasoningEffort: "high" };

    // The Agent tool call carries the brief; the start names its tool use.
    service.observe("sess1", {
      type: "tool_call",
      tool: "Agent",
      itemId: "toolu-1",
      args: { description: "fix the parser", prompt: "Read-only: do not edit any files. Explain why the parser fails." },
    }, session);
    service.observe("sess1", {
      type: "subagent_started",
      taskId: "task-1",
      taskType: "subagent",
      model: "inherit",
      description: "fix the parser",
      agentType: "general",
      parentToolUseId: "toolu-1",
    }, session);
    // Nothing is logged until the child reports its effort and finishes.
    service.observe("sess1", { type: "subagent_progress", taskId: "task-1", parentToolUseId: "toolu-1", summary: "", reasoningEffort: "medium" }, session);
    expect(readRows(dir)).toHaveLength(0);

    service.observe("sess1", {
      type: "subagent_result",
      taskId: "task-1",
      status: "completed",
      summary: "",
      usage: { totalTokens: 1200, toolUses: 4, durationMs: 900 },
    }, session);
    await vi.waitFor(() => expect(readRows(dir).length).toBe(2));

    const [decision, outcome] = readRows(dir);
    expect(decision.type).toBe("decision");
    const decided = decision as RouterShadowDecisionRow;
    expect(decided).toMatchObject({ v: 2, key: "sess1:task-1", kind: "read_only", kindSource: "prompt" });
    // The child's own report wins over the parent's "high".
    expect(decided.requested).toEqual({ harness: "claude", model: OPUS, modelSource: "inherited", effort: "medium", effortSource: "reported" });
    expect(decided.reference?.routeId).toContain(OPUS);
    expect(outcome.type).toBe("outcome");
    const result = outcome as RouterShadowOutcomeRow;
    expect(result.key).toBe("sess1:task-1");
    expect(result.status).toBe("completed");
    expect(result.totalTokens).toBe(1200);
    expect(result.toolUses).toBe(4);
  });

  it("skips a resumed subagent and a non-subagent task", async () => {
    const dir = makeDir();
    const service = makeService({ dir, snapshot: baseSnapshot() });
    const session = { provider: "claude", model: OPUS, modelId: OPUS };
    const started = (taskId: string, extra: Record<string, unknown>) => ({
      type: "subagent_started" as const,
      taskId,
      description: "explore the code",
      ...extra,
    });

    service.observe("sess1", started("keep", { taskType: "subagent" }), session);
    service.observe("sess1", started("resumed", { taskType: "subagent", resumed: true }), session);
    service.observe("sess1", started("background", { taskType: "background" }), session);
    for (const taskId of ["keep", "resumed", "background"]) {
      service.observe("sess1", { type: "subagent_result", taskId, status: "completed", summary: "" }, session);
    }
    await vi.waitFor(() => expect(readRows(dir).length).toBe(2));

    const rows = readRows(dir).filter((row): row is RouterShadowDecisionRow => row.type === "decision");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskId).toBe("keep");
  });

  it("logs a follow-up run of the same task as its own decision and drops the replaced run's late result", async () => {
    const dir = makeDir();
    const service = makeService({ dir, snapshot: baseSnapshot() });
    const session = { provider: "claude", model: OPUS, modelId: OPUS, reasoningEffort: "medium" };
    const start = (toolUse: string) => service.observe("sess1", {
      type: "subagent_started", taskId: "agent-1", taskType: "subagent", model: "inherit", description: "review the diff", parentToolUseId: toolUse,
    }, session);
    const result = (toolUse: string, totalTokens: number) => service.observe("sess1", {
      type: "subagent_result", taskId: "agent-1", parentToolUseId: toolUse, status: "completed", summary: "", usage: { totalTokens },
    }, session);

    start("toolu-first");
    // A correction of the same run (same tool call) is not a new run.
    start("toolu-first");
    // The parent messages the agent again before the first run's result lands.
    start("toolu-followup");
    result("toolu-first", 111);
    result("toolu-followup", 222);
    await vi.waitFor(() => expect(readRows(dir).length).toBe(3));

    const rows = readRows(dir);
    const decisions = rows.filter((row): row is RouterShadowDecisionRow => row.type === "decision").map((row) => row.key);
    expect(decisions.sort()).toEqual(["sess1:agent-1", "sess1:agent-1#2"]);
    const outcomes = rows.filter((row): row is RouterShadowOutcomeRow => row.type === "outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ key: "sess1:agent-1#2", totalTokens: 222 });
  });

  it("writes nothing when the shadow log is disabled", () => {
    const dir = makeDir();
    const service = makeService({ dir, snapshot: baseSnapshot(), enabled: false });
    service.observe("sess1", {
      type: "subagent_started",
      taskId: "task-1",
      taskType: "subagent",
      description: "fix it",
    }, { provider: "claude", model: OPUS, modelId: OPUS });
    // `enabled: false` returns before scheduling anything, so nothing is in
    // flight and the file cannot exist yet.
    expect(readRows(dir)).toHaveLength(0);
    expect(fs.existsSync(dir) && fs.readdirSync(dir).length).toBe(0);
  });

  it("exposes routes and a dry-run pick for the CLI", async () => {
    const dir = makeDir();
    const service = makeService({ dir, snapshot: baseSnapshot() });

    const listed = await service.routes({ provider: "claude" });
    expect(listed.routes).toHaveLength(2);
    expect(listed.routes[0]!.modelId).toBe(OPUS);
    expect(listed.registry.models).toBe(3);

    const pick = await service.preview({
      description: "summarize how sync works",
      provider: "claude",
      model: OPUS,
    });
    expect(pick.kind).toBe("read_only");
    expect(pick.reference?.route.modelId).toBe(OPUS);
  });

  it("never throws from observe for an unmatched or malformed event", () => {
    const dir = makeDir();
    const service = makeService({ dir, snapshot: baseSnapshot() });
    const session = { provider: "claude", model: OPUS, modelId: OPUS };
    expect(() => service.observe("sess1", {
      type: "subagent_result",
      taskId: "never-started",
      status: "failed",
      summary: "",
    }, session)).not.toThrow();
    expect(() => service.observe("sess1", { type: "subagent_started" } as never, session)).not.toThrow();
  });
});

const MINUTE = 60_000;

function ledgerTurn(fields: Partial<AdeTurnUsageRecord> & { sessionId: string; startMs: number; usd: number }): AdeTurnUsageRecord {
  const { startMs, usd, ...rest } = fields;
  return {
    v: 1,
    key: `${fields.sessionId}:${startMs}`,
    at: iso(startMs + MINUTE),
    startedAt: iso(startMs),
    turnId: String(startMs),
    projectRoot: null,
    laneId: null,
    surface: "work",
    parentSessionId: null,
    provider: "claude",
    status: "completed",
    requestedModel: OPUS,
    servedModel: null,
    reasoningEffort: null,
    account: null,
    accountKey: "claude:local",
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 10_000,
    cacheWriteTokens: 500,
    cacheWrite1hTokens: 500,
    reasoningTokens: null,
    contextTokens: null,
    contextWindow: null,
    requestCount: null,
    subagentTokens: null,
    costUsd: null,
    costSource: null,
    apiEquivalentUsd: usd,
    planUsage: null,
    factoryCreditsSessionTotal: null,
    usageConfidence: "measured",
    durationMs: MINUTE,
    compactions: 0,
    ...rest,
  };
}

/** The Claude weekly window moved 20 percent over the ledger's turns, so one percent costs a twentieth of their dollars. */
function claudeWeekMoved(fromMs: number, toMs: number): AdeQuotaSample[] {
  const sample = (atMs: number, percentUsed: number): AdeQuotaSample => ({
    v: 1,
    at: iso(atMs),
    provider: "claude",
    accountId: "claude:local",
    windowType: "weekly",
    percentUsed,
    resetsAt: WEEK_RESET,
  });
  return [sample(fromMs, 10), sample(toMs, 30)];
}

/** Sonnet within the lead tolerance of Opus, at a third of its cost per task. */
function replaySnapshot(): ModelRegistrySnapshot {
  return snapshot(
    [
      model(OPUS, 60, 6, 800),
      model(SONNET, 58, 2, 400),
      model("deepseek-v4-1-flash", 40, 0.1, 300),
    ],
    [agentRow("Claude Code", OPUS, 0.70), agentRow("Claude Code", SONNET, 0.69)],
  );
}

describe("router efficiency", () => {
  it("replays each thread at its free switch points and prices the pick against what ran", async () => {
    const t0 = NOW - 10 * 3_600_000;
    const turns = [
      // A lead thread on the 1-hour cache: a 10-minute pause keeps its segment.
      ledgerTurn({ sessionId: "lead", startMs: t0, usd: 3 }),
      ledgerTurn({ sessionId: "lead", startMs: t0 + 10 * MINUTE, usd: 3, compactions: 1 }),
      ledgerTurn({ sessionId: "lead", startMs: t0 + 20 * MINUTE, usd: 3 }),
      ledgerTurn({ sessionId: "lead", startMs: t0 + 3 * 3_600_000, usd: 3 }),
      ledgerTurn({ sessionId: "lead", startMs: t0 + 3 * 3_600_000 + 5 * MINUTE, usd: 3, reasoningEffort: "high" }),
      // A thread that writes only the 5-minute cache: a 10-minute pause is a free switch point.
      ledgerTurn({ sessionId: "short-cache", startMs: t0, usd: 3, cacheWrite1hTokens: 0 }),
      ledgerTurn({ sessionId: "short-cache", startMs: t0 + 10 * MINUTE, usd: 3, cacheWrite1hTokens: 0 }),
      // A harness the router does not cover.
      ledgerTurn({ sessionId: "other", startMs: t0, usd: 1, provider: "devin", requestedModel: "devin/adaptive" }),
      // An OpenCode Go model whose family is also served by a metered gateway.
      ledgerTurn({ sessionId: "go", startMs: t0, usd: 0.5, provider: "opencode", requestedModel: "opencode/opencode-go/deepseek-v4.1-flash" }),
    ];
    const service = makeService({
      dir: makeDir(),
      snapshot: replaySnapshot(),
      catalog: [
        ...baseCatalog(),
        catalogModel("opencode", "opencode/deepseek/deepseek-v4.1-flash"),
        catalogModel("opencode", "opencode/opencode-go/deepseek-v4.1-flash"),
      ],
      turns,
      quotaSamples: claudeWeekMoved(t0 - MINUTE, NOW - MINUTE),
    });

    const { threads } = await service.efficiency({ days: 7 });

    expect(threads.threads).toBe(4);
    expect(threads.turns).toBe(9);
    // lead: start, compaction, cache expired, route changed; short-cache: start, cache expired; other and go: start.
    expect(threads.segmentsByStart).toEqual({ thread_start: 4, compaction: 1, cache_expired: 2, route_changed: 1 });
    // Every Claude segment moves to Sonnet at a third of Opus's cost per task.
    expect(threads.switchedSegments.sameHarness).toBe(6);
    expect(threads.actualUsd).toBe(22.5);
    expect(threads.sameHarnessUsd).toBe(8.5);
    // One row per plan account: the turns' unnamed `claude:local` login is the account the window was read on.
    const claudePlanRow = threads.byBilling.find((row) => row.billing === "claude plan · claude:local");
    expect(claudePlanRow).toMatchObject({ actualUsd: 21, sameHarnessUsd: 7, actualPercent: 20, sameHarnessPercent: 6.67 });
    // The Go model stays on the Go plan, not the metered gateway of the same family.
    expect(threads.byBilling.find((row) => row.billing === "opencode-go plan")?.actualUsd).toBe(0.5);
    expect(threads.byBilling.some((row) => row.billing.startsWith("metered"))).toBe(false);
    expect(threads.kept.map((row) => row.reason)).toEqual(expect.arrayContaining([
      "the devin harness is not routed",
      "no burn rate for the opencode-go plan yet",
    ]));
  });

  it("weights subagent savings by tokens and prices the subagents that report a cost", async () => {
    const dir = makeDir();
    const t0 = NOW - 3_600_000;
    const service = makeService({
      dir,
      snapshot: replaySnapshot(),
      turns: [ledgerTurn({ sessionId: "parent", startMs: t0, usd: 20 })],
      quotaSamples: claudeWeekMoved(t0 - MINUTE, NOW - MINUTE),
    });
    const session = { provider: "claude", model: OPUS, modelId: OPUS, reasoningEffort: null };
    const start = (taskId: string) => service.observe("parent", {
      type: "subagent_started",
      taskId,
      taskType: "subagent",
      model: "inherit",
      description: "summarize how sync works",
    }, session);
    start("finished");
    start("running");
    service.observe("parent", {
      type: "subagent_result",
      taskId: "finished",
      status: "completed",
      summary: "",
      usage: { totalTokens: 4_000, costUsd: 3 },
    }, session);
    // The running subagent is not logged until it finishes.
    await vi.waitFor(() => expect(readRows(dir).length).toBe(2));

    const decision = readRows(dir).find((row): row is RouterShadowDecisionRow => row.type === "decision" && row.taskId === "finished")!;
    const saving = decision.sameHarness?.savingShare;
    expect(saving, "the finished subagent got a cheaper pick").toBeGreaterThan(0);

    const { subagents } = await service.efficiency({ days: 1 });
    expect(subagents).toMatchObject({ decisions: 1, withOutcome: 1, sameHarnessPicks: 1, tokens: 4_000, pricedSubagents: 1, actualUsd: 3, legacyDecisionsSkipped: 0 });
    expect(subagents.sameHarnessSaving).toBeCloseTo(saving!, 3);
    expect(subagents.sameHarnessUsd).toBeCloseTo(3 * (1 - saving!), 2);
  });

  it.each([
    ["a word", "abc", 7],
    ["an object", {}, 7],
    ["zero", 0, 1],
    ["more than 90", 500, 90],
    ["a fraction", 2.9, 2],
  ])("reads %s as a day count the reports accept", async (_label, days, expected) => {
    const service = makeService({ dir: makeDir(), snapshot: baseSnapshot() });
    await expect(service.efficiency({ days: days as number })).resolves.toMatchObject({ days: expected });
    await expect(service.shadowSummary({ days: days as number })).resolves.toMatchObject({ days: expected });
  });

  it("lists models from every open project, newest first, and skips a project that fails", async () => {
    let listModels: ((provider: "claude" | "opencode") => Promise<AgentChatModelInfo[]>) | null = null;
    const dispose = vi.fn();
    const create = (getAvailableModels: typeof listModels) => {
      listModels = getAvailableModels;
      return { dispose } as unknown as ModelRouterService;
    };
    const info = (id: string, displayName: string): AgentChatModelInfo => ({ id, displayName, isDefault: false, modelId: id });
    const adeDir = makeDir();
    const older = attachSharedModelRouter({
      adeDir,
      create: create as never,
      modelSource: async (provider) => provider === "opencode" ? [info("go-model", "Go")] : [info(OPUS, "Opus (older project)")],
    });
    const broken = attachSharedModelRouter({ adeDir, create: create as never, modelSource: async () => { throw new Error("no catalog"); } });
    const newer = attachSharedModelRouter({
      adeDir,
      create: create as never,
      modelSource: async (provider) => provider === "opencode" ? [] : [info(OPUS, "Opus (newer project)"), info(SONNET, "Sonnet")],
    });

    expect((await listModels!("opencode")).map((entry) => entry.id)).toEqual(["go-model"]);
    expect((await listModels!("claude")).map((entry) => entry.displayName)).toEqual(["Opus (newer project)", "Sonnet"]);
    newer.detach();
    expect((await listModels!("claude")).map((entry) => entry.displayName)).toEqual(["Opus (older project)"]);
    broken.detach();
    expect(dispose).not.toHaveBeenCalled();
    // The last scope to leave stops the router's timer.
    older.detach();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
