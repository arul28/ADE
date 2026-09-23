import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDynamicOpenCodeModelDescriptor } from "../../../shared/modelRegistry";
import { isServedModelMismatch } from "./servedModelMismatch";
import {
  buildOpenCodeDoneUsage,
  buildOpenCodeLiveContextUsage,
  createOpenCodeTurnUsage,
  createOpenCodeUsageAccountResolver,
  parseOpenCodeAuthEntries,
  readOpenCodePlanEmail,
  recordOpenCodeStepFinish,
  resolveOpenCodeServedModel,
  resolveOpenCodeUsageAccount,
} from "./openCodeTurnUsage";

const step = (input: number, output: number, reasoning: number, read: number, write: number, cost?: number) => ({
  tokens: { input, output, reasoning, cache: { read, write } },
  ...(cost !== undefined ? { cost } : {}),
});

describe("OpenCode turn usage", () => {
  it("sums every step into the turn and keeps the last step as the context", () => {
    const turn = createOpenCodeTurnUsage();
    recordOpenCodeStepFinish(turn, "p1", step(1_000, 100, 40, 5_000, 200, 0.01), { describesContext: true });
    recordOpenCodeStepFinish(turn, "p2", step(300, 50, 10, 6_000, 0, 0.02), { describesContext: true });
    recordOpenCodeStepFinish(turn, "p3", step(200, 80, 0, 6_300, 100, 0.03), { describesContext: true });

    const done = buildOpenCodeDoneUsage(turn, 200_000);
    expect(done?.usage).toEqual({
      inputTokens: 1_500,
      outputTokens: 230,
      cacheReadTokens: 17_300,
      cacheCreationTokens: 300,
      reasoningTokens: 50,
      contextWindow: 200_000,
      // Last step's input side only: 200 + 6,300 + 100.
      contextTokens: 6_600,
      requestCount: 3,
    });
    expect(done?.costUsd).toBeCloseTo(0.06, 10);
    expect(done?.costSource).toBe("provider");
  });

  it("counts a re-sent step-finish part once", () => {
    const turn = createOpenCodeTurnUsage();
    recordOpenCodeStepFinish(turn, "p1", step(10, 5, 0, 0, 0, 0.5), { describesContext: true });
    recordOpenCodeStepFinish(turn, "p1", step(10, 5, 0, 0, 0, 0.5), { describesContext: true });
    const done = buildOpenCodeDoneUsage(turn, null);
    expect(done?.usage.requestCount).toBe(1);
    expect(done?.usage.inputTokens).toBe(10);
    expect(done?.costUsd).toBe(0.5);
    expect(done?.usage.contextWindow).toBeUndefined();
  });

  it("totals a compaction summary step but never takes it as the context", () => {
    const turn = createOpenCodeTurnUsage();
    recordOpenCodeStepFinish(turn, "p1", step(100, 10, 0, 2_000, 0), { describesContext: true });
    recordOpenCodeStepFinish(turn, "summary", step(90_000, 800, 0, 0, 0), { describesContext: false });
    const done = buildOpenCodeDoneUsage(turn, 100_000);
    expect(done?.usage.inputTokens).toBe(90_100);
    expect(done?.usage.contextTokens).toBe(2_100);
  });

  it("reports no provider cost when no step carried one, and nothing for an empty turn", () => {
    const turn = createOpenCodeTurnUsage();
    expect(buildOpenCodeDoneUsage(turn, 1_000)).toBeNull();
    recordOpenCodeStepFinish(turn, "p1", { tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } } }, { describesContext: true });
    const done = buildOpenCodeDoneUsage(turn, 1_000);
    expect(done?.costUsd).toBeUndefined();
    expect(done?.costSource).toBeUndefined();
    expect(done?.usage.reasoningTokens).toBe(0);
  });

  it("builds a live context snapshot from one step's input side", () => {
    const turn = createOpenCodeTurnUsage();
    const recorded = recordOpenCodeStepFinish(turn, "p1", step(1_000, 500, 0, 9_000, 0), { describesContext: true });
    const event = buildOpenCodeLiveContextUsage(recorded, 100_000, "opencode/openai/gpt-5.4", "turn-1");
    expect(event).toMatchObject({ type: "context_usage", origin: "live", state: "measured", turnId: "turn-1" });
    expect(event?.usage).toMatchObject({
      totalTokens: 10_000,
      maxTokens: 100_000,
      rawMaxTokens: 100_000,
      percentage: 10,
      inputTokens: 1_000,
      cacheReadTokens: 9_000,
      cacheCreationTokens: 0,
      model: "opencode/openai/gpt-5.4",
    });
    expect(event?.usage.categories.map((entry) => entry.name)).toEqual(["Input", "Cache read"]);
    expect(buildOpenCodeLiveContextUsage(recorded, 0, undefined)).toBeNull();
  });

  it("names the served model only when it differs from the request", () => {
    const requested = { providerID: "openai", modelID: "gpt-5.4" };
    expect(resolveOpenCodeServedModel(requested, { providerID: "openai", modelID: "gpt-5.4" })).toBeNull();
    expect(resolveOpenCodeServedModel(requested, { providerID: "openai", modelID: "gpt-5.4-mini" }))
      .toBe("opencode/openai/gpt-5.4-mini");
    expect(resolveOpenCodeServedModel(requested, null)).toBeNull();
  });

  it("reports a served model under the registry id the chat's model has", () => {
    // OpenRouter model ids carry a `/`, which a registry id encodes.
    const requested = { providerID: "openrouter", modelID: "anthropic/claude-opus-4.7" };
    const chatModelId = createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: "openrouter",
      openCodeModelId: "anthropic/claude-opus-4.7",
    }).id;
    expect(resolveOpenCodeServedModel(requested, { providerID: "openrouter", modelID: "anthropic/claude-opus-4.7" }))
      .toBeNull();

    const served = resolveOpenCodeServedModel(requested, {
      providerID: "openrouter",
      modelID: "anthropic/claude-opus-4.8",
    });
    expect(served).toBe("opencode/openrouter/anthropic%2Fclaude-opus-4.8");
    expect(served).toBe(createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: "openrouter",
      openCodeModelId: "anthropic/claude-opus-4.8",
    }).id);
    expect(isServedModelMismatch(chatModelId, served)).toBe(true);

    // A dated snapshot of the model the chat asked for is the same model to
    // the ledger check and to the mismatch warning.
    const snapshot = resolveOpenCodeServedModel(requested, {
      providerID: "openrouter",
      modelID: "anthropic/claude-opus-4.7-20260416",
    });
    expect(isServedModelMismatch(chatModelId, snapshot)).toBe(false);

    // Another chat asked for GPT-5.4 and OpenRouter answered with this row's
    // model: the served id is this row's id, so the ledger sees one model.
    const answeredByThisRow = resolveOpenCodeServedModel({ providerID: "openrouter", modelID: "openai/gpt-5.4" }, requested);
    expect(answeredByThisRow).toBe(chatModelId);
    expect(isServedModelMismatch(chatModelId, answeredByThisRow)).toBe(false);
  });

  it("compares a served Anthropic alias under its canonical row id", () => {
    // The `opus` row is Claude Opus 5.5, so OpenCode naming the canonical id
    // is the same model.
    const requested = { providerID: "anthropic", modelID: "opus" };
    expect(resolveOpenCodeServedModel(requested, { providerID: "anthropic", modelID: "claude-opus-5-5" })).toBeNull();
    expect(resolveOpenCodeServedModel(requested, { providerID: "anthropic", modelID: "claude-sonnet-5" }))
      .toBe("opencode/anthropic/claude-sonnet-5");
  });
});

describe("OpenCode usage account", () => {
  it("maps the auth.json credential type to the account kind", () => {
    expect(resolveOpenCodeUsageAccount({ providerID: "anthropic", auth: { type: "api", accountId: null } }))
      .toEqual({ provider: "opencode", kind: "api_key", upstream: "anthropic" });
    expect(resolveOpenCodeUsageAccount({ providerID: "openai", auth: { type: "oauth", accountId: "acct-1" } }))
      .toEqual({ provider: "opencode", kind: "subscription", upstream: "openai", accountId: "acct-1" });
    expect(resolveOpenCodeUsageAccount({ providerID: "deepseek", auth: null }))
      .toEqual({ provider: "opencode", kind: "unknown", upstream: "deepseek" });
  });

  it("names local servers by endpoint and OpenCode plans by email", () => {
    expect(resolveOpenCodeUsageAccount({ providerID: "lmstudio", auth: null, localEndpoint: "http://127.0.0.1:1234" }))
      .toEqual({ provider: "opencode", kind: "local", upstream: "lmstudio", endpoint: "http://127.0.0.1:1234" });
    expect(resolveOpenCodeUsageAccount({ providerID: "opencode-go", auth: null, planEmail: "me@example.com" }))
      .toEqual({ provider: "opencode", kind: "subscription", upstream: "opencode-go", email: "me@example.com" });
  });

  it("puts only a local endpoint's origin on the account", () => {
    expect(resolveOpenCodeUsageAccount({
      providerID: "ollama",
      auth: null,
      localEndpoint: "http://user:secret@127.0.0.1:11434/v1?token=abc",
    })).toEqual({ provider: "opencode", kind: "local", upstream: "ollama", endpoint: "http://127.0.0.1:11434" });
    for (const localEndpoint of ["file:///tmp/sock", "  ", "not a url"]) {
      expect(resolveOpenCodeUsageAccount({ providerID: "ollama", auth: null, localEndpoint }), localEndpoint)
        .toEqual({ provider: "opencode", kind: "local", upstream: "ollama" });
    }
    expect(resolveOpenCodeUsageAccount({ providerID: "lmstudio", auth: null, localEndpoint: "http://192.168.1.5:1234/v1" }).endpoint)
      .toBe("http://192.168.1.5:1234");
  });

  it("keeps only type and accountId from auth.json", () => {
    const entries = parseOpenCodeAuthEntries(JSON.stringify({
      openai: { type: "oauth", access: "secret-a", refresh: "secret-r", accountId: "acct-9", expires: 1 },
      anthropic: { type: "api", key: "secret-k" },
      broken: "nope",
    }));
    expect([...entries.entries()]).toEqual([
      ["openai", { type: "oauth", accountId: "acct-9" }],
      ["anthropic", { type: "api", accountId: null }],
    ]);
    expect(JSON.stringify([...entries.values()])).not.toContain("secret");
    expect(parseOpenCodeAuthEntries("{not json").size).toBe(0);
  });

  describe("resolver cache", () => {
    let dataDir: string;
    beforeEach(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-opencode-account-"));
    });
    afterEach(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("reads auth.json once per TTL, not once per turn", () => {
      fs.writeFileSync(path.join(dataDir, "auth.json"), JSON.stringify({ anthropic: { type: "api", key: "k" } }));
      let reads = 0;
      let now = 0;
      const resolve = createOpenCodeUsageAccountResolver({
        dataDirs: () => [dataDir],
        readText: (filePath) => {
          reads += 1;
          return fs.readFileSync(filePath, "utf8");
        },
        readPlanEmail: () => null,
        now: () => now,
      });
      expect(resolve({ providerID: "anthropic" }).kind).toBe("api_key");
      expect(resolve({ providerID: "anthropic" }).kind).toBe("api_key");
      expect(reads).toBe(1);
      fs.writeFileSync(path.join(dataDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth" } }));
      now = 10 * 60_000;
      expect(resolve({ providerID: "anthropic" }).kind).toBe("subscription");
      expect(reads).toBe(2);
    });

    it("reads the active Zen account's email from opencode.db without touching tokens", () => {
      // A runtime require: the test bundler rewrites a static `node:sqlite` import.
      const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
      const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
      const dbPath = path.join(dataDir, "opencode.db");
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT NOT NULL, url TEXT NOT NULL, access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL, token_expiry INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
        CREATE TABLE account_state (id INTEGER PRIMARY KEY NOT NULL, active_account_id TEXT, active_org_id TEXT);
        INSERT INTO account VALUES ('a1', 'old@example.com', 'u', 'secret', 'secret', NULL, 1, 9);
        INSERT INTO account VALUES ('a2', 'active@example.com', 'u', 'secret', 'secret', NULL, 1, 2);
        INSERT INTO account_state VALUES (1, 'a2', NULL);
      `);
      db.close();
      expect(readOpenCodePlanEmail(dbPath)).toBe("active@example.com");
      expect(readOpenCodePlanEmail(path.join(dataDir, "missing.db"))).toBeNull();
    });

    it("answers null at once when opencode.db is locked", () => {
      const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
      const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
      const dbPath = path.join(dataDir, "opencode.db");
      const writer = new DatabaseSync(dbPath);
      writer.exec(`
        CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT NOT NULL, time_updated INTEGER NOT NULL);
        CREATE TABLE account_state (id INTEGER PRIMARY KEY NOT NULL, active_account_id TEXT);
        INSERT INTO account VALUES ('a1', 'me@example.com', 1);
      `);
      writer.exec("BEGIN EXCLUSIVE");
      try {
        const started = Date.now();
        expect(readOpenCodePlanEmail(dbPath)).toBeNull();
        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
      expect(readOpenCodePlanEmail(dbPath)).toBe("me@example.com");
    });

    it("reads an isolated server's own store when the call names it", () => {
      const isolatedDir = path.join(dataDir, "isolated", "opencode");
      fs.mkdirSync(isolatedDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth" } }));
      fs.writeFileSync(path.join(isolatedDir, "auth.json"), JSON.stringify({ anthropic: { type: "api", key: "k" } }));
      const resolve = createOpenCodeUsageAccountResolver({ dataDirs: () => [dataDir], readPlanEmail: () => null });
      expect(resolve({ providerID: "anthropic" }).kind).toBe("subscription");
      expect(resolve({ providerID: "anthropic", dataDirs: [isolatedDir] }).kind).toBe("api_key");
      expect(resolve({ providerID: "anthropic", dataDirs: [path.join(dataDir, "empty")] }).kind).toBe("unknown");
    });

    it("asks for a local endpoint once per TTL and only for local servers", () => {
      const asked: string[] = [];
      let now = 0;
      const resolve = createOpenCodeUsageAccountResolver({
        dataDirs: () => [dataDir],
        readText: () => null,
        readPlanEmail: () => null,
        localEndpoint: (providerID) => {
          asked.push(providerID);
          return "http://127.0.0.1:1234/v1";
        },
        now: () => now,
      });
      expect(resolve({ providerID: "lmstudio" }).endpoint).toBe("http://127.0.0.1:1234");
      resolve({ providerID: "lmstudio" });
      resolve({ providerID: "anthropic" });
      expect(asked).toEqual(["lmstudio"]);
      now = 2 * 60_000;
      resolve({ providerID: "lmstudio" });
      expect(asked).toEqual(["lmstudio", "lmstudio"]);
    });

    it("looks the plan email up only for OpenCode's own providers", () => {
      const emailReads: string[] = [];
      const resolve = createOpenCodeUsageAccountResolver({
        dataDirs: () => [dataDir],
        readText: () => null,
        readPlanEmail: (dbPath) => {
          emailReads.push(dbPath);
          return "zen@example.com";
        },
      });
      expect(resolve({ providerID: "openai" }).kind).toBe("unknown");
      expect(emailReads).toEqual([]);
      expect(resolve({ providerID: "opencode" })).toEqual({
        provider: "opencode",
        kind: "subscription",
        upstream: "opencode",
        email: "zen@example.com",
      });
      expect(emailReads).toEqual([path.join(dataDir, "opencode.db")]);
    });
  });
});
