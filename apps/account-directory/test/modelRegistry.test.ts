import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AA_CODING_AGENTS_URL,
  AA_MODELS_URL,
  handleModelRegistryRequest,
  MIN_AA_MODELS,
  MODEL_REGISTRY_KEEP_SNAPSHOTS,
  MODELS_DEV_URL,
  parseArtificialAnalysisAgents,
  parseArtificialAnalysisModels,
  parseModelsDevPrices,
  refreshModelRegistry,
  runModelRegistryCron,
  type ModelRegistryEnv,
} from "../src/modelRegistry";
import type { ModelRegistrySnapshot } from "../src/modelRegistryContract";
import { FakeD1Database } from "./fakeD1";
import { ISSUER, jwksEndpoint, mintToken, OAUTH_CLIENT_ID } from "./jwks";

/**
 * The fixtures are trimmed from real captures (2026-09-29): eight model
 * records and eight Coding Agent Index rows, kept in the page's own
 * `self.__next_f.push` chunk format. The model page also carries a
 * reference-stubbed repeat of one record, an outer row that contains a record,
 * a record split across two chunks, and non-ASCII text, because the real
 * payload has each of those.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const MODELS_PAGE = fixture("aa-models-page.html");
const AGENTS_PAGE = fixture("aa-coding-agents-page.html");
const MODELS_DEV = fixture("models-dev.json");

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const HOUR_MS = 3_600_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("Artificial Analysis parsing", () => {
  const models = parseArtificialAnalysisModels(MODELS_PAGE);
  const bySlug = new Map(models.map((model) => [model.slug, model]));

  it("reads every record once, and nothing that only contains one", () => {
    expect(models.map((model) => model.slug)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5-5-high",
      "glm-5-3",
      "gpt-6-1-sol-xhigh",
      "gpt-6-luna",
      "kimi-k3",
    ]);
  });

  it("maps a record's fields, keeping the full copy over a reference-stubbed repeat", () => {
    expect(bySlug.get("claude-sonnet-5-5")).toEqual({
      slug: "claude-sonnet-5-5",
      releaseSlug: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5 (Adaptive Reasoning, Max Effort, Default Fallback)",
      shortName: "Claude Sonnet 5.5 (max with fallback)",
      creator: "Anthropic",
      releaseDate: expect.any(String),
      deprecated: false,
      effort: "max",
      reasoning: true,
      openWeights: false,
      contextWindow: expect.any(Number),
      intelligenceIndex: expect.any(Number),
      intelligenceIndexEstimated: false,
      terminalBench40: expect.any(Number),
      sciCode: expect.any(Number),
      longContextReasoning: expect.any(Number),
      humanitysLastExam: expect.any(Number),
      gpqa: null,
      ifBench: null,
      costPerIndexTaskUsd: expect.any(Number),
      secondsPerIndexTask: expect.any(Number),
      outputTokensPerSecond: expect.any(Number),
      timeToFirstTokenSeconds: expect.any(Number),
      price: { input: expect.any(Number), output: expect.any(Number), cacheRead: expect.any(Number), cacheWrite: expect.any(Number) },
    });
    const opus = bySlug.get("claude-opus-5-5")!;
    expect({
      intelligenceIndex: opus.intelligenceIndex,
      costPerIndexTaskUsd: opus.costPerIndexTaskUsd,
      secondsPerIndexTask: opus.secondsPerIndexTask,
      outputTokensPerSecond: opus.outputTokensPerSecond,
      timeToFirstTokenSeconds: opus.timeToFirstTokenSeconds,
      price: opus.price,
    }).toEqual({
      intelligenceIndex: 57.6223698102963,
      costPerIndexTaskUsd: 5.982012019521066,
      secondsPerIndexTask: 806.5411912319673,
      outputTokensPerSecond: 92.5191493491242,
      timeToFirstTokenSeconds: 692.632423122,
      price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    });
  });

  it("decodes non-ASCII text and a record split across chunks", () => {
    expect(bySlug.get("kimi-k3")?.creator).toBe("Moonshot AI (月之暗面)");
    expect(bySlug.get("glm-5-3")).toMatchObject({ creator: "Z AI", effort: "max", releaseSlug: "glm-5-3" });
  });

  it.each([
    ["Claude Code - Sonnet 5.5 (max)", "claude-sonnet-5-5", false],
    ["Claude Code - Fable 5.1 (max) (with fallback)", "claude-fable-5-1", false],
    ["Opencode - GLM-5.3 ({'reasoning_effort': 'max'})", "glm-5-3", false],
    ["Codex - GPT-6 Luna (max) ({'reasoning_effort': 'max'})", "gpt-6-luna", false],
    ["Codex - GPT-6.1 Sol (xhigh) ({'reasoning_effort': 'xhigh'})", "gpt-6-1-sol-xhigh", false],
    // No effort in the name; the row's own host slug names the record.
    ["Kimi Code CLI - Kimi K3", "kimi-k3", false],
    ["Devin Fusion CLI - GPT-6 Astra XHigh + SWE-2 Medium", null, true],
    // Its record is not on the page: unmatched, never guessed.
    ["Claude Code - Qwen3.8 Max", null, false],
  ])("maps agent row %s to %s", (label, modelSlug, pair) => {
    const row = parseArtificialAnalysisAgents(AGENTS_PAGE, models).find((entry) => entry.label === label);
    expect(row).toMatchObject({ modelSlug, pair });
  });

  it("maps an agent row's metrics", () => {
    const row = parseArtificialAnalysisAgents(AGENTS_PAGE, models)
      .find((entry) => entry.label === "Claude Code - Sonnet 5.5 (max)")!;
    expect(row).toEqual({
      id: "a2c87c062f3cef73d8525e7578f14742",
      agent: "Claude Code",
      label: "Claude Code - Sonnet 5.5 (max)",
      modelSlug: "claude-sonnet-5-5",
      pair: false,
      score: 0.6835783373750831,
      evals: [
        { name: "deep-swe-v1.1", score: 0.71976401179941 },
        { name: "swe-atlas-qna", score: 0.669354838709677 },
        { name: "terminal-bench-v4", score: 0.661616161616162 },
      ],
      costUsdPerTask: 14.190800796369649,
      minutesPerTask: 5244.965372937293 / 60,
      stepsPerTask: 265.93069306930687,
      cacheHitRate: 0.9506214943317096,
      tokensPerTask: 27742337.233773403,
    });
  });
});

describe("models.dev prices", () => {
  it("copies the listed channels' costs, with context tiers, and skips the rest", () => {
    const prices = parseModelsDevPrices(JSON.parse(MODELS_DEV));
    expect(Object.keys(prices).sort()).toEqual(["anthropic", "openai"]);
    expect(prices.anthropic!["claude-haiku-4-5"]).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
    expect(prices.openai!["gpt-5.4"]).toEqual({
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: null,
      tiers: [{ aboveContextTokens: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: null }],
    });
  });
});

// ---------------------------------------------------------------------------
// Refresh and route
// ---------------------------------------------------------------------------

/** A model page with `count` records, in the page's chunk format. */
function syntheticModelsPage(count: number, tag = "a"): string {
  const template = parseArtificialAnalysisModels(MODELS_PAGE)[0]!;
  const records = Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    slug: `model-${tag}-${String(index).padStart(3, "0")}`,
    name: `Model ${tag} ${index}`,
    shortName: `Model ${tag} ${index}`,
    intelligenceIndexIsEstimated: false,
    intelligenceIndex: template.intelligenceIndex,
  }));
  return `<script>self.__next_f.push([1,${JSON.stringify(`3:${JSON.stringify(records)}\n`)}])</script>`;
}

type Source = string | number | Error;

function sources(overrides: Partial<Record<"models" | "agents" | "modelsDev", Source>> = {}) {
  const table: Record<string, Source> = {
    [AA_MODELS_URL]: overrides.models ?? syntheticModelsPage(MIN_AA_MODELS),
    [AA_CODING_AGENTS_URL]: overrides.agents ?? AGENTS_PAGE,
    [MODELS_DEV_URL]: overrides.modelsDev ?? MODELS_DEV,
  };
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const source = table[url];
    if (source instanceof Error) throw source;
    if (typeof source === "number") return new Response("nope", { status: source });
    return new Response(source ?? "missing", { status: source === undefined ? 404 : 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeEnv(overrides: Partial<ModelRegistryEnv> = {}): ModelRegistryEnv & { DB: FakeD1Database } {
  return {
    DB: new FakeD1Database(),
    CLERK_JWKS_URL: jwksEndpoint(),
    CLERK_ISSUER: ISSUER,
    CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
    ...overrides,
  } as ModelRegistryEnv & { DB: FakeD1Database };
}

function newest(env: { DB: FakeD1Database }): ModelRegistrySnapshot {
  return JSON.parse(env.DB.modelRegistrySnapshots.at(-1)!.body) as ModelRegistrySnapshot;
}

describe("refreshModelRegistry", () => {
  it("stores a snapshot from both sources", async () => {
    const env = makeEnv();
    const result = await refreshModelRegistry(env, { now: () => NOW, fetchImpl: sources().fetchImpl });
    expect(result).toMatchObject({ stored: true, models: MIN_AA_MODELS, agents: 8 });
    const snapshot = newest(env);
    expect(snapshot.sources).toEqual({
      artificialAnalysis: { fetchedAt: new Date(NOW).toISOString(), ok: true },
      modelsDev: { fetchedAt: new Date(NOW).toISOString(), ok: true },
    });
    expect(Object.keys(snapshot.prices).sort()).toEqual(["anthropic", "openai"]);
  });

  it.each([
    ["the models page answers an error", { models: 503 }, "http_503"],
    ["the models page parses too few records", { models: syntheticModelsPage(MIN_AA_MODELS - 1, "b") }, `models_too_few:${MIN_AA_MODELS - 1}`],
    ["the fetch throws", { models: new TypeError("network down") }, "TypeError: network down"],
  ] as const)("keeps the previous Artificial Analysis data when %s", async (_case, failure, error) => {
    const env = makeEnv();
    await refreshModelRegistry(env, { now: () => NOW, fetchImpl: sources().fetchImpl });
    const before = newest(env);

    const later = NOW + 25 * HOUR_MS;
    const result = await refreshModelRegistry(env, { now: () => later, fetchImpl: sources(failure).fetchImpl });
    expect(result.stored).toBe(true);
    const after = newest(env);
    expect(after.models).toEqual(before.models);
    expect(after.agents).toEqual(before.agents);
    expect(after.sources.artificialAnalysis).toEqual({ fetchedAt: before.sources.artificialAnalysis.fetchedAt, ok: false, error });
    expect(after.sources.modelsDev).toEqual({ fetchedAt: new Date(later).toISOString(), ok: true });
  });

  it("keeps the new models but the previous agent rows when only the agents page fails", async () => {
    const env = makeEnv();
    await refreshModelRegistry(env, { now: () => NOW, fetchImpl: sources().fetchImpl });
    const before = newest(env);

    await refreshModelRegistry(env, {
      now: () => NOW + HOUR_MS,
      fetchImpl: sources({ models: syntheticModelsPage(MIN_AA_MODELS + 1, "c"), agents: "<html></html>" }).fetchImpl,
    });
    const after = newest(env);
    expect(after.models).toHaveLength(MIN_AA_MODELS + 1);
    expect(after.agents).toEqual(before.agents);
    expect(after.sources.artificialAnalysis).toMatchObject({ ok: false, error: "agents: agents_none" });
  });

  it("keeps the previous prices when models.dev fails", async () => {
    const env = makeEnv();
    await refreshModelRegistry(env, { now: () => NOW, fetchImpl: sources().fetchImpl });
    const before = newest(env);

    await refreshModelRegistry(env, { now: () => NOW + HOUR_MS, fetchImpl: sources({ modelsDev: "{not json" }).fetchImpl });
    const after = newest(env);
    expect(after.prices).toEqual(before.prices);
    expect(after.sources.modelsDev).toMatchObject({ fetchedAt: before.sources.modelsDev.fetchedAt, ok: false });
  });

  it.each([
    ["with no previous snapshot, Artificial Analysis fails", false, { models: 500 }, "no_models"],
    ["both sources fail", true, { models: 500, modelsDev: 500 }, "all_sources_failed"],
  ] as const)("stores nothing when %s", async (_case, seeded, failure, reason) => {
    const env = makeEnv();
    if (seeded) await refreshModelRegistry(env, { now: () => NOW, fetchImpl: sources().fetchImpl });
    const count = env.DB.modelRegistrySnapshots.length;
    const result = await refreshModelRegistry(env, { now: () => NOW + HOUR_MS, fetchImpl: sources(failure).fetchImpl });
    expect(result).toMatchObject({ stored: false, reason });
    expect(env.DB.modelRegistrySnapshots).toHaveLength(count);
  });

  it("keeps only the newest snapshots", async () => {
    const env = makeEnv();
    for (let day = 0; day < MODEL_REGISTRY_KEEP_SNAPSHOTS + 2; day += 1) {
      await refreshModelRegistry(env, { now: () => NOW + day * 24 * HOUR_MS, fetchImpl: sources().fetchImpl });
    }
    expect(env.DB.modelRegistrySnapshots.map((row) => row.generated_at)).toEqual(
      Array.from({ length: MODEL_REGISTRY_KEEP_SNAPSHOTS }, (_, index) => NOW + (index + 2) * 24 * HOUR_MS),
    );
  });
});

describe("runModelRegistryCron", () => {
  it("refreshes only when the newest snapshot is a day old", async () => {
    quiet();
    const env = makeEnv();
    const first = sources();
    expect(await runModelRegistryCron(env, { now: () => NOW, fetchImpl: first.fetchImpl })).toMatchObject({ ran: true });
    expect(first.calls).toHaveLength(3);

    const early = sources();
    expect(await runModelRegistryCron(env, { now: () => NOW + 23 * HOUR_MS, fetchImpl: early.fetchImpl }))
      .toEqual({ ran: false, reason: "fresh" });
    expect(early.calls).toEqual([]);

    expect(await runModelRegistryCron(env, { now: () => NOW + 24 * HOUR_MS, fetchImpl: sources().fetchImpl }))
      .toMatchObject({ ran: true, result: { stored: true } });
  });

  it("runs one refresh when two ticks race", async () => {
    quiet();
    const env = makeEnv();
    const shared = sources();
    const results = await Promise.all([
      runModelRegistryCron(env, { now: () => NOW, fetchImpl: shared.fetchImpl }),
      runModelRegistryCron(env, { now: () => NOW, fetchImpl: shared.fetchImpl }),
    ]);
    expect(results.filter((result) => result.ran)).toHaveLength(1);
    expect(results).toContainEqual({ ran: false, reason: "claimed" });
    expect(shared.calls).toHaveLength(3);
    expect(env.DB.modelRegistrySnapshots).toHaveLength(1);
  });

  it("waits ten minutes after a refresh that stored nothing", async () => {
    quiet();
    const env = makeEnv();
    await runModelRegistryCron(env, { now: () => NOW, fetchImpl: sources({ models: 500 }).fetchImpl });

    const waiting = sources();
    expect(await runModelRegistryCron(env, { now: () => NOW + 9 * 60_000, fetchImpl: waiting.fetchImpl }))
      .toEqual({ ran: false, reason: "claimed" });
    expect(waiting.calls).toEqual([]);

    expect(await runModelRegistryCron(env, { now: () => NOW + 10 * 60_000, fetchImpl: sources().fetchImpl }))
      .toMatchObject({ ran: true, result: { stored: true } });
  });

  it("backs the retry wait off after repeat failures and resets it on success", async () => {
    quiet();
    const env = makeEnv();
    const fail = () => sources({ models: 500 }).fetchImpl;

    // First failure: the retry waits ten minutes.
    await runModelRegistryCron(env, { now: () => NOW, fetchImpl: fail() });
    // Second failure at +10m: the wait doubles, so the next attempt is +30m.
    await runModelRegistryCron(env, { now: () => NOW + 10 * 60_000, fetchImpl: fail() });

    const early = sources();
    expect(await runModelRegistryCron(env, { now: () => NOW + 25 * 60_000, fetchImpl: early.fetchImpl }))
      .toEqual({ ran: false, reason: "claimed" });
    expect(early.calls).toEqual([]);
    expect(env.DB.modelRegistryClaim?.failures).toBe(2);

    // The third attempt lands at +30m, stores a snapshot, and clears the count.
    expect(await runModelRegistryCron(env, { now: () => NOW + 30 * 60_000, fetchImpl: sources().fetchImpl }))
      .toMatchObject({ ran: true, result: { stored: true } });
    expect(env.DB.modelRegistryClaim?.failures).toBe(0);
  });

  it("fetches nothing when MODEL_REGISTRY_REFRESH is 0", async () => {
    const env = makeEnv({ MODEL_REGISTRY_REFRESH: "0" });
    const off = sources();
    expect(await runModelRegistryCron(env, { now: () => NOW, fetchImpl: off.fetchImpl })).toEqual({ ran: false, reason: "disabled" });
    expect(off.calls).toEqual([]);
  });
});

describe("GET /router/registry", () => {
  const URL_ = "https://directory.test/router/registry";

  async function get(env: ModelRegistryEnv, headers: Record<string, string> = {}, method = "GET"): Promise<Response> {
    return handleModelRegistryRequest(new Request(URL_, { method, headers }), env);
  }

  it.each([
    ["no bearer", async () => ({})],
    ["an invalid token", async () => ({ authorization: `Bearer ${await mintToken({ useBadKey: true })}` })],
    ["an expired token", async () => ({ authorization: `Bearer ${await mintToken({ expired: true })}` })],
  ])("answers 401 with %s", async (_case, headers) => {
    quiet();
    const env = makeEnv();
    await refreshModelRegistry(env, { now: () => NOW, fetchImpl: sources().fetchImpl });
    const response = await get(env, await headers());
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("models");
  });

  it("answers 503 before the first snapshot exists", async () => {
    quiet();
    const response = await get(makeEnv(), { authorization: `Bearer ${await mintToken()}` });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "model_registry_unavailable" });
  });

  it("serves the newest snapshot with an ETag, and 304 when it has not changed", async () => {
    quiet();
    const env = makeEnv();
    await refreshModelRegistry(env, { now: () => NOW, fetchImpl: sources().fetchImpl });
    await refreshModelRegistry(env, { now: () => NOW + HOUR_MS, fetchImpl: sources({ models: syntheticModelsPage(MIN_AA_MODELS + 5, "d") }).fetchImpl });
    const authorization = `Bearer ${await mintToken()}`;

    const response = await get(env, { authorization });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const body = (await response.json()) as ModelRegistrySnapshot;
    expect(body.generatedAt).toBe(new Date(NOW + HOUR_MS).toISOString());
    expect(body.models).toHaveLength(MIN_AA_MODELS + 5);

    const revalidated = await get(env, { authorization, "if-none-match": `W/${etag}` });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(await revalidated.text()).toBe("");

    const head = await get(env, { authorization }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(etag);

    // A new snapshot changes the ETag, so the old one no longer revalidates.
    await refreshModelRegistry(env, { now: () => NOW + 2 * HOUR_MS, fetchImpl: sources().fetchImpl });
    const changed = await get(env, { authorization, "if-none-match": etag! });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });
});
