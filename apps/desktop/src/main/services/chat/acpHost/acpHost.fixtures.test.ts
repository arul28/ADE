/**
 * Dialect claims vs captured initialize responses from real binaries.
 *
 * These fixtures were recorded on 2026-09-18 against Copilot CLI 1.0.86,
 * ACP agent 1.0.4, Grok 1.0.13, Qwen Code 0.24.0, and the Kimi Code 0.39.1
 * compatibility baseline. Kimi Code 2.0.0's current ACP reference is covered
 * by the dialect contract assertions below.
 * Qwen Code 0.24.0 was captured separately on 2026-09-18.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copilotDialect, grokDialect, kimiDialect, qwenDialect, readGrokPromptUsage } from "./acpDialects";
import { normalizeAcpConfigOptions, type AcpInitializeResponse } from "./acpProtocolTypes";

const fixturesDir = path.join(__dirname, "fixtures");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as T;
}

describe("captured initialize fixtures", () => {
  it("copilot 1.0.86 advertises load, close, MCP, and image, not resume", () => {
    const init = loadFixture<AcpInitializeResponse>("copilot.initialize.json");
    expect(init.protocolVersion).toBe(1);
    expect(init.agentInfo?.version).toBe("1.0.86");
    expect(init.agentCapabilities?.loadSession).toBe(true);
    expect(init.agentCapabilities?.mcpCapabilities).toEqual({ http: true, sse: true });
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({ close: {}, list: {} });
    expect(init.agentCapabilities?.sessionCapabilities).not.toHaveProperty("resume");
    expect(copilotDialect.sessionConfig.declared).toBe(true);
    expect(copilotDialect.configOptionIds).toEqual(["mode", "allow_all"]);
    expect(copilotDialect.closeStyle).toBe("close_request");
    expect(copilotDialect.loadPolicy).toBe("load_only");
    expect(copilotDialect.resumeSession.declared).toBe(false);
    expect(copilotDialect.cancelStyle).toBe("notification");
    expect(copilotDialect.imagePrompts.declared).toBe(true);
    expect(copilotDialect.mcpInjection.declared).toBe(true);
  });

  it("grok remains first-class while preserving its honest capability gates", () => {
    const init = loadFixture<AcpInitializeResponse>("grok.initialize.json");
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities?.loadSession).toBe(true);
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(false);
    expect(init.agentCapabilities?.mcpCapabilities).toEqual({ http: true, sse: true });
    expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({
      list: {},
      resume: {},
      close: {},
    });
    expect(grokDialect.loadPolicy).toBe("resume_preferred");
    expect(grokDialect.tier).toBe("first_class");
    expect(grokDialect.closeStyle).toBe("close_request");
    expect(grokDialect.imagePrompts.declared).toBe(false);
    expect(grokDialect.mcpInjection.declared).toBe(true);
    expect(grokDialect.cancelStyle).toBe("notification");
    expect(grokDialect.advertiseFsCapability).toBe(false);
  });

  it("grok usage reader accepts the nested 1.0.13 prompt _meta", () => {
    const meta = loadFixture<Record<string, unknown>>("grok.promptResult.meta.json");
    const usage = readGrokPromptUsage(meta);

    // Sanity-check dollars against token counts and published rates, not against
    // GROK_COST_TICKS_PER_USD. The fixture is 29805 input (5888 cached) + 32
    // output. docs.x.ai/developers/pricing (2026-08-31): grok-4.6 <200k is
    // $2.00/M input, $0.50/M cached, $6.00/M output → about $0.051. A ~$3/$15
    // public band on the same tokens is about $0.09. $86.65 is a 1000x
    // mis-scale of 86_649_000 ticks, not a real bill.
    const uncachedInput = 29_805 - 5_888;
    const publishedGrok46Usd = (uncachedInput * 2 + 5_888 * 0.5 + 32 * 6) / 1_000_000;
    const threeDollarBandUsd = (29_805 * 3 + 32 * 15) / 1_000_000;
    expect(publishedGrok46Usd).toBeGreaterThan(0.04);
    expect(publishedGrok46Usd).toBeLessThan(0.07);
    expect(threeDollarBandUsd).toBeGreaterThan(0.08);
    expect(threeDollarBandUsd).toBeLessThan(0.10);

    expect(usage?.costUsd).toBeCloseTo(0.086649, 5);
    expect(usage?.costUsd).toBeGreaterThan(0.04);
    expect(usage?.costUsd).toBeLessThan(0.12);
    // `inputTokens` on the wire counts the cache; ADE reports the uncached
    // share, with the cache in its own field.
    expect(usage).toMatchObject({
      cacheReadTokens: 5888,
      cacheWriteTokens: 0,
      inputTokens: 29805 - 5888,
      outputTokens: 32,
      reasoningTokens: 27,
      totalTokens: 29837,
      requestCount: 1,
      servedModel: "grok-4.6-build",
    });
  });

  it("a later live Grok ping also lands in cents, not hundreds of dollars", () => {
    const report = loadFixture<{
      steps: Array<{
        step: string;
        usage?: { rawMeta?: Record<string, unknown>; inputTokens?: number; outputTokens?: number; cachedReadTokens?: number };
      }>;
    }>("grok.followup-probe.json");
    const ping = report.steps.find((step) => step.step === "cheap-ping");
    const meta = ping?.usage?.rawMeta;
    expect(meta).toBeTruthy();
    const usage = readGrokPromptUsage(meta);
    const input = ping?.usage?.inputTokens ?? 0;
    const output = ping?.usage?.outputTokens ?? 0;
    const cached = ping?.usage?.cachedReadTokens ?? 0;
    const uncached = Math.max(0, input - cached);
    // grok-4.5 list: $2.00/M input, $0.30/M cached, $6.00/M output.
    const publishedUsd = (uncached * 2 + cached * 0.3 + output * 6) / 1_000_000;
    expect(publishedUsd).toBeGreaterThan(0.01);
    expect(publishedUsd).toBeLessThan(0.1);
    expect(usage?.costUsd).toBeGreaterThan(0.01);
    expect(usage?.costUsd).toBeLessThan(1);
  });

  it("copilot config_option_update currentValue maps onto ADE value/id", () => {
    const raw = loadFixture<unknown[]>("copilot.config-options.json");
    const options = normalizeAcpConfigOptions(raw);
    const mode = options.find((option) => option.id === "mode");
    expect(mode?.value).toBe("https://agentclientprotocol.com/protocol/session-modes#agent");
    expect(mode?.options?.map((entry) => entry.id)).toEqual([
      "https://agentclientprotocol.com/protocol/session-modes#agent",
      "https://agentclientprotocol.com/protocol/session-modes#plan",
      "https://agentclientprotocol.com/protocol/session-modes#autopilot",
    ]);
    expect(options.find((option) => option.id === "allow_all")?.value).toBe("off");
  });

  it("qwen 0.24.0 advertises resume and image/audio, not close", () => {
    const init = loadFixture<AcpInitializeResponse>("qwen.initialize.json");
    expect(init.protocolVersion).toBe(1);
    expect(init.agentInfo?.version).toBe("0.24.0");
    expect(init.agentCapabilities?.loadSession).toBe(true);
    expect(init.agentCapabilities?.promptCapabilities).toEqual({
      image: true,
      audio: true,
      embeddedContext: true,
    });
    expect(init.agentCapabilities?.mcpCapabilities).toEqual({ sse: true, http: true });
    expect(init.agentCapabilities?.sessionCapabilities).toEqual({ list: {}, resume: {} });
    expect(init.agentCapabilities?.sessionCapabilities).not.toHaveProperty("close");
    expect(init.authMethods?.map((method) => method.id)).toEqual(["openai", "openai-responses"]);
    expect(qwenDialect.closeStyle).toBe("kill_process");
    expect(qwenDialect.oneProcessPerSession).toBe(true);
    expect(qwenDialect.loadPolicy).toBe("resume_preferred");
    expect(qwenDialect.imagePrompts.declared).toBe(true);
    expect(qwenDialect.authProbe.methodId).toBe("openai");
  });

  it("kimi 0.39.1 baseline advertises close, login terminal-auth, and reads usage_update", () => {
    const init = loadFixture<AcpInitializeResponse>("kimi.initialize.json");
    expect(init.protocolVersion).toBe(1);
    expect(init.agentInfo?.version).toBe("0.39.1");
    expect(init.agentCapabilities?.loadSession).toBe(true);
    expect(init.agentCapabilities?.promptCapabilities).toEqual({
      image: true,
      audio: false,
      embeddedContext: true,
    });
    expect(init.agentCapabilities?.mcpCapabilities).toEqual({ http: true, sse: true });
    expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({
      list: {},
      resume: {},
      close: {},
    });
    expect(init.authMethods?.[0]).toMatchObject({
      id: "login",
      type: "terminal",
    });
    expect(kimiDialect.closeStyle).toBe("close_request");
    expect(kimiDialect.oneProcessPerSession).toBe(false);
    expect(kimiDialect.usageUpdateAfterTurn).toBe(true);
    expect(kimiDialect.authProbe.methodId).toBe("login");
    expect(kimiDialect.imagePrompts.declared).toBe(true);
    expect(kimiDialect.sessionConfig.declared).toBe(true);
    expect([...kimiDialect.configOptionIds]).toEqual(["mode", "model", "thinking"]);
  });
});
