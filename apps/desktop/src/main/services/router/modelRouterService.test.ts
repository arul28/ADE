import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatModelInfo } from "../../../shared/types/chat";
import type { AdeQuotaBurnRate } from "../../../shared/types/turnUsage";
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
    ["explore the sync code", "explore", "read_only"],
    ["fix the parser bug", null, "light_edit"],
    ["implement the new router", null, "heavy_edit"],
    ["review this diff", null, "review"],
    ["run the tests", null, "test_run"],
    ["hello", null, "unknown"],
  ] as const)("classifies task %s (agent %s) as %s", (description, agentType, kind) => {
    expect(classifyRouterTask(description, agentType)).toBe(kind);
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
    readTurns: async () => [],
    readQuotaSamples: async () => [],
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
  it("records a decision for a subagent that inherits the session model, then its outcome", async () => {
    const dir = makeDir();
    const service = makeService({ dir, snapshot: baseSnapshot() });
    const session = { provider: "claude", model: OPUS, modelId: OPUS, reasoningEffort: null };

    service.observe("sess1", {
      type: "subagent_started",
      taskId: "task-1",
      taskType: "subagent",
      model: "inherit",
      description: "fix the parser",
      agentType: "general",
    }, session);
    await vi.waitFor(() => expect(readRows(dir).length).toBe(1));

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
    expect(decided.key).toBe("sess1:task-1");
    expect(decided.kind).toBe("light_edit");
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
    await vi.waitFor(() => expect(readRows(dir).length).toBe(1));

    const rows = readRows(dir) as RouterShadowDecisionRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskId).toBe("keep");
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
