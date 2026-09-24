import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdeQuotaBurnRate, AdeQuotaSample, AdeTurnUsageRecord } from "../../../shared/types";
import {
  MAX_USAGE_RESEARCH_BODY_BYTES,
  MAX_USAGE_RESEARCH_GROUPS,
  USAGE_RESEARCH_ACCOUNT_REF_PATTERN,
  USAGE_RESEARCH_INSTALL_ID_PATTERN,
  type UsageResearchGroup,
} from "../../../shared/usageResearch";
import {
  buildUsageResearchDailyReport,
  encodeUsageResearchDailyBody,
  researchLabel,
  usageResearchAccountRef,
  usageResearchBodyEncoder,
  usageResearchInstallId,
  usageResearchUtcOffsetMinutes,
  type UsageResearchEnvelope,
  type UsageResearchReportInput,
} from "./usageResearchReport";
import { resetDynamicTokenPricingForTest, setDynamicTokenPricingForTest, tokenPrice } from "./usagePricing";

const SALT = "0123456789abcdef0123456789abcdef";
const DAY = "2026-09-22";
/** Local time on DAY, so hour buckets hold whatever the machine's time zone. */
const at = (hour: number, minute = 0) => new Date(2026, 8, 22, hour, minute).toISOString();

let seq = 0;
function row(overrides: Partial<AdeTurnUsageRecord> = {}): AdeTurnUsageRecord {
  seq += 1;
  const sessionId = overrides.sessionId ?? `session-${seq}`;
  const turnId = overrides.turnId ?? `turn-${seq}`;
  return {
    v: 1,
    key: `${sessionId}:${turnId}`,
    at: at(12),
    startedAt: null,
    sessionId,
    turnId,
    projectRoot: null,
    laneId: null,
    surface: "work",
    parentSessionId: null,
    provider: "claude",
    status: "completed",
    requestedModel: "claude-opus-5-5",
    servedModel: null,
    reasoningEffort: null,
    account: { provider: "claude", kind: "subscription" },
    accountKey: "claude:local",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1_000,
    cacheWriteTokens: 200,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    contextTokens: null,
    contextWindow: null,
    requestCount: 1,
    subagentTokens: null,
    costUsd: null,
    costSource: null,
    apiEquivalentUsd: 0.01,
    planUsage: null,
    factoryCreditsSessionTotal: null,
    usageConfidence: "measured",
    durationMs: null,
    compactions: 0,
    ...overrides,
  };
}

function input(turns: AdeTurnUsageRecord[], extra: Partial<UsageResearchReportInput> = {}): UsageResearchReportInput {
  return { turns, quotaSamples: [], burnRates: [], salt: SALT, ...extra };
}

const ENVELOPE: UsageResearchEnvelope = {
  installId: usageResearchInstallId(SALT),
  day: DAY,
  appVersion: "1.2.78",
  platform: "darwin",
  arch: "arm64",
  utcOffsetMinutes: -420,
};

function groupOf(groups: UsageResearchGroup[], predicate: (group: UsageResearchGroup) => boolean): UsageResearchGroup {
  const found = groups.find(predicate);
  expect(found).toBeDefined();
  return found!;
}

/** A deterministic shuffle, so an order test never depends on Math.random. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  let state = 7;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

beforeEach(() => {
  seq = 0;
  resetDynamicTokenPricingForTest({ disableDiskCache: true });
});

afterEach(() => {
  resetDynamicTokenPricingForTest({ disableDiskCache: true });
});

describe("ids", () => {
  it("derives the install id from the per-install research salt", () => {
    const id = usageResearchInstallId(SALT);
    expect(id).toMatch(USAGE_RESEARCH_INSTALL_ID_PATTERN);
    expect(id).toBe(createHash("sha256").update(`ade-usage-research-install:${SALT}`).digest("hex").slice(0, 32));
    // Its own namespace: not the salted account-ref hash of anything.
    expect(id.slice(0, 12)).not.toBe(usageResearchAccountRef(SALT, "claude", "install"));
  });

  it("salts account refs per install and gives the unnamed login none", () => {
    const ref = usageResearchAccountRef(SALT, "claude", "claude:work");
    expect(ref).toMatch(USAGE_RESEARCH_ACCOUNT_REF_PATTERN);
    expect(ref).toBe(createHash("sha256").update(`${SALT}:claude:work`).digest("hex").slice(0, 12));
    expect(usageResearchAccountRef(SALT, "claude", "claude:work")).toBe(ref);
    expect(usageResearchAccountRef("f".repeat(32), "claude", "claude:work")).not.toBe(ref);
    expect(usageResearchAccountRef(SALT, "claude", "claude:local")).toBeNull();
    expect(usageResearchAccountRef(SALT, "claude", "  ")).toBeNull();
  });

  it("cuts the envelope to the Worker's limits", () => {
    const encoded = encodeUsageResearchDailyBody(
      { ...ENVELOPE, appVersion: `1.2.78-beta+${"é".repeat(5)}${"x".repeat(60)}`, platform: "a-very-long-platform-name", arch: " ", utcOffsetMinutes: 900.4 },
      input([row()]),
    );
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(Object.keys(encoded.body)).toEqual(["schemaVersion", "installId", "day", "appVersion", "platform", "arch", "utcOffsetMinutes", "report"]);
    expect(encoded.body.appVersion).toBe(`1.2.78-beta+${"x".repeat(28)}`);
    expect(encoded.body.platform).toBe("a-very-long-plat");
    expect(encoded.body.arch).toBe("unknown");
    expect(encoded.body.utcOffsetMinutes).toBe(840);
  });

  it("states the UTC offset at local noon of the day, east positive", () => {
    expect(usageResearchUtcOffsetMinutes(DAY)).toBe(-new Date(2026, 8, 22, 12).getTimezoneOffset() || 0);
    expect(usageResearchUtcOffsetMinutes("not-a-day")).toBe(0);
  });
});

describe("privacy", () => {
  it("never puts an email, path, id, endpoint, or account key into the body", () => {
    const secrets = {
      email: "alice.private@example.com",
      instanceId: "instance-secret-42",
      accountId: "acct-secret-77",
      endpoint: "http://10.0.0.5:1234/v1",
      projectRoot: "/Users/alice/secret-project",
      laneId: "lane-secret-9",
      sessionId: "session-secret-1",
      turnId: "turn-secret-1",
      parentSessionId: "parent-secret-3",
    };
    const turns = [
      row({
        sessionId: secrets.sessionId,
        turnId: secrets.turnId,
        projectRoot: secrets.projectRoot,
        laneId: secrets.laneId,
        parentSessionId: secrets.parentSessionId,
        account: {
          provider: "claude",
          kind: "subscription",
          email: secrets.email,
          instanceId: secrets.instanceId,
          accountId: secrets.accountId,
          endpoint: secrets.endpoint,
          plan: "max",
        },
        accountKey: `claude:${secrets.instanceId}`,
      }),
      row({
        provider: "codex",
        requestedModel: "gpt-6-sol",
        account: { provider: "codex", kind: "subscription", email: secrets.email },
        accountKey: `codex:${secrets.email}`,
      }),
      // A local model named after its file, a vendor that is a URL, an effort that is an email.
      row({
        provider: "opencode",
        requestedModel: "/Users/alice/models/llama-3-8b.gguf",
        servedModel: "C:\\models\\qwen.gguf",
        reasoningEffort: secrets.email,
        account: { provider: "opencode", kind: "local", upstream: "http://localhost:1234", endpoint: secrets.endpoint },
        accountKey: "opencode:local",
      }),
    ];
    const quotaSamples: AdeQuotaSample[] = [
      { v: 1, at: at(9), provider: "codex", accountId: `codex:${secrets.email}`, windowType: "five_hour", percentUsed: 12, resetsAt: at(14) },
    ];
    const burnRates: AdeQuotaBurnRate[] = [{
      provider: "claude",
      accountId: `claude:${secrets.instanceId}`,
      windowType: "weekly",
      usdPerPercent: 1.5,
      turnsPerPercent: 2,
      observedPercent: 4,
      observedUsd: 6,
      observedTurns: 8,
      latestPercentUsed: 40,
      latestResetsAt: at(20),
      headroomUsd: 90,
      confidence: "low",
    }];

    const encoded = encodeUsageResearchDailyBody(ENVELOPE, input(turns, { quotaSamples, burnRates }));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    for (const secret of [...Object.values(secrets), "alice", "10.0.0.5", "localhost", "gguf", SALT]) {
      expect(encoded.json).not.toContain(secret);
    }
    const local = groupOf(encoded.body.report.groups, (group) => group.provider === "opencode");
    expect(local).toMatchObject({
      requestedModel: "_redacted",
      servedModel: "_redacted",
      reasoningEffort: "_redacted",
      upstream: "_redacted",
      accountKind: "local",
      accountRef: null,
    });
    const claude = groupOf(encoded.body.report.groups, (group) => group.provider === "claude");
    expect(claude.accountRef).toBe(usageResearchAccountRef(SALT, "claude", `claude:${secrets.instanceId}`));
    expect(claude.subagentChat).toBe(true);
    // The burn rate and the turn of one account carry one ref, so they join.
    expect(encoded.body.report.burnRates[0]!.accountRef).toBe(claude.accountRef);
    const codex = groupOf(encoded.body.report.groups, (group) => group.provider === "codex");
    expect(encoded.body.report.quota[0]!.accountRef).toBe(codex.accountRef);
  });

  it("keeps a model version after an @ and cuts an overlong label", () => {
    expect(researchLabel("claude-opus-4@20250514")).toBe("claude-opus-4@20250514");
    expect(researchLabel("x".repeat(200))).toHaveLength(64);
    expect(researchLabel("  ")).toBeNull();
    expect(researchLabel("~/models/a.gguf")).toBe("_redacted");
  });
});

describe("groups", () => {
  it("groups turns by every dimension and sums each group", () => {
    const report = buildUsageResearchDailyReport(input([
      row({ status: "completed", apiEquivalentUsd: 0.5, costUsd: 0.4, costSource: "list_price", compactions: 1 }),
      row({ status: "interrupted", apiEquivalentUsd: 0.25, requestCount: 3, cacheWrite1hTokens: 100, subagentTokens: 900 }),
      row({ status: "failed", apiEquivalentUsd: null, usageConfidence: "estimated", planUsage: [{ unit: "premium_request", amount: 1.5 }] }),
      row({ reasoningEffort: "high", apiEquivalentUsd: 1 }),
      row({ provider: "codex", requestedModel: "gpt-6-sol", servedModel: "gpt-6-luna", accountKey: "codex:work", costUsd: 2, costSource: "provider", apiEquivalentUsd: 3, account: { provider: "codex", kind: "api_key" } }),
      row({ surface: "automation", apiEquivalentUsd: 0.1 }),
      row({ parentSessionId: "parent", apiEquivalentUsd: 0.1 }),
      row({ account: { provider: "claude", kind: "subscription", routedAway: "cloud", upstream: "anthropic" }, apiEquivalentUsd: 0.1 }),
    ]));

    expect(report.totals).toEqual({ turns: 8, apiEquivalentUsd: 5.05, providerCostUsd: 2, listPriceCostUsd: 0.4 });
    expect(report.groups).toHaveLength(6);
    const base = groupOf(report.groups, (group) => group.provider === "claude" && group.reasoningEffort == null
      && group.surface === "work" && !group.subagentChat && group.routedAway == null);
    expect(base).toMatchObject({
      turns: 3,
      completed: 1,
      interrupted: 1,
      failed: 1,
      tokens: { input: 300, output: 150, cacheRead: 3_000, cacheWrite: 600, cacheWrite1h: 100, reasoning: 0, subagent: 900 },
      requests: 5,
      apiEquivalentUsd: 0.75,
      pricedTurns: 2,
      providerCostUsd: 0,
      listPriceCostUsd: 0.4,
      planUsage: { premium_request: 1.5 },
      confidence: { measured: 2, derived: 0, estimated: 1 },
      servedMismatches: 0,
      compactions: 1,
      accountKind: "subscription",
      accountRef: null,
    });
    expect(groupOf(report.groups, (group) => group.provider === "codex")).toMatchObject({
      requestedModel: "gpt-6-sol",
      servedModel: "gpt-6-luna",
      accountKind: "api_key",
      servedMismatches: 1,
      providerCostUsd: 2,
      apiEquivalentUsd: 3,
    });
    expect(groupOf(report.groups, (group) => group.routedAway === "cloud")).toMatchObject({ upstream: "anthropic", turns: 1 });
    // No group but the codex one has a served model that differs.
    expect(report.groups.filter((group) => group.servedMismatches > 0).map((group) => group.provider)).toEqual(["codex"]);
    // Biggest list-price dollars first.
    expect(report.groups.map((group) => group.apiEquivalentUsd)).toEqual([3, 1, 0.75, 0.1, 0.1, 0.1]);
  });

  it("counts a served model as a mismatch only when it is another model", () => {
    const report = buildUsageResearchDailyReport(input([
      // A harness prefix and a build variant of the same Grok model.
      row({ provider: "grok", requestedModel: "xai/grok-4-5", servedModel: "grok-4.5-build", apiEquivalentUsd: 3 }),
      // A router pick is never a mismatch: the user asked the provider to choose.
      row({ provider: "cursor", requestedModel: "auto", servedModel: "claude-sonnet-5", apiEquivalentUsd: 2 }),
      // A different model is.
      row({ provider: "codex", requestedModel: "gpt-6-sol", servedModel: "gpt-6-luna", apiEquivalentUsd: 1 }),
    ]));
    expect(report.groups.map((group) => [group.provider, group.servedMismatches])).toEqual([
      ["grok", 0],
      ["cursor", 0],
      ["codex", 1],
    ]);
  });

  it("keeps the plan tier as its own group dimension", () => {
    const report = buildUsageResearchDailyReport(input([
      row({ accountKey: "claude:work", account: { provider: "claude", kind: "subscription", plan: "max" }, apiEquivalentUsd: 2 }),
      row({ accountKey: "claude:work", account: { provider: "claude", kind: "subscription", plan: "pro" }, apiEquivalentUsd: 1 }),
      row({ accountKey: "claude:work", account: { provider: "claude", kind: "subscription" }, apiEquivalentUsd: 0.5 }),
    ]));
    expect(report.groups.map((group) => group.plan)).toEqual(["max", "pro", null]);
  });

  it("gives nearest-rank context and duration percentiles and a turn-start hour histogram", () => {
    const turns = Array.from({ length: 10 }, (_, index) => row({
      contextTokens: (index + 1) * 1_000,
      contextWindow: index === 3 ? 1_000_000 : 200_000,
      durationMs: (index + 1) * 100,
      // Started at 9:50 or 10:50, finished at 11:10: the start hour counts.
      startedAt: at(index < 4 ? 9 : 10, 50),
      at: at(11, 10),
    }));
    turns.push(row({ contextTokens: null, durationMs: null, at: at(23, 5) }));
    const [group] = buildUsageResearchDailyReport(input(turns)).groups;
    expect(group!.context).toEqual({ p50: 5_000, p90: 9_000, max: 10_000, windowMax: 1_000_000 });
    expect(group!.durationMs).toEqual({ p50: 500, p90: 900, sum: 5_500 });
    const hours = group!.hours!;
    expect(hours).toHaveLength(24);
    expect(hours[9]).toBe(4);
    expect(hours[10]).toBe(6);
    expect(hours[23]).toBe(1);
    expect(hours.reduce((total, n) => total + n, 0)).toBe(11);
  });

  it("merges the groups past the cap into one _other group at the end", () => {
    const turns = Array.from({ length: MAX_USAGE_RESEARCH_GROUPS + 11 }, (_, index) => row({
      requestedModel: `model-${String(index).padStart(3, "0")}`,
      apiEquivalentUsd: 1_000 - index,
      contextTokens: 1_000 + index,
    }));
    const report = buildUsageResearchDailyReport(input(turns));
    expect(report.groups).toHaveLength(MAX_USAGE_RESEARCH_GROUPS);
    const other = report.groups[report.groups.length - 1]!;
    expect(other).toMatchObject({
      provider: "_other",
      requestedModel: null,
      servedModel: null,
      accountRef: null,
      turns: 12,
      mergedGroups: 12,
      context: { max: 1_000 + MAX_USAGE_RESEARCH_GROUPS + 10 },
    });
    expect(report.groups[MAX_USAGE_RESEARCH_GROUPS - 2]!.requestedModel).toBe("model-148");
    expect(report.totals.turns).toBe(MAX_USAGE_RESEARCH_GROUPS + 11);
    expect(report.groups.reduce((total, group) => total + group.turns, 0)).toBe(MAX_USAGE_RESEARCH_GROUPS + 11);
  });
});

describe("quota and prices", () => {
  it("sums the day's readings of each window and counts its reset instances", () => {
    const sample = (hour: number, percentUsed: number, resetsAt: string, overrides: Partial<AdeQuotaSample> = {}): AdeQuotaSample => ({
      v: 1, at: at(hour), provider: "claude", accountId: "claude:local", windowType: "five_hour", percentUsed, resetsAt, ...overrides,
    });
    const report = buildUsageResearchDailyReport(input([row()], {
      quotaSamples: [
        sample(8, 10.123, at(12)),
        sample(9, 40, at(12, 1)),
        sample(13, 5, at(17)),
        sample(9, 30, at(23), { windowType: "weekly" }),
        sample(10, 31, at(23), { windowType: "weekly" }),
      ],
    }));
    expect(report.quota).toEqual([
      { provider: "claude", windowType: "five_hour", accountRef: null, minPercent: 5, maxPercent: 40, resetInstances: 2, samples: 3 },
      { provider: "claude", windowType: "weekly", accountRef: null, minPercent: 30, maxPercent: 31, resetInstances: 1, samples: 2 },
    ]);
  });

  it("lists the list price of each group's priced model, tiers included, and leaves out an unknown model", () => {
    setDynamicTokenPricingForTest({
      "claude-opus-5-5": tokenPrice(5, 25),
      "gpt-6-luna": {
        ...tokenPrice(2, 16, 0.2, 2),
        tiers: [{ aboveContextTokens: 272_000, ...tokenPrice(4, 24, 0.4, 4) }],
      },
    });
    const report = buildUsageResearchDailyReport(input([
      row(),
      row({ provider: "codex", requestedModel: "gpt-6-sol", servedModel: "gpt-6-luna" }),
      row({ provider: "opencode", requestedModel: "totally-unknown-model-xyz" }),
    ]));
    expect(Object.keys(report.prices)).toEqual(["claude-opus-5-5", "gpt-6-luna"]);
    expect(report.prices["claude-opus-5-5"]).toEqual({
      inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25, source: "list",
    });
    expect(report.prices["gpt-6-luna"]).toEqual({
      inputPer1M: 2,
      outputPer1M: 16,
      cacheReadPer1M: 0.2,
      cacheWritePer1M: 2,
      tiers: [{ aboveContextTokens: 272_000, inputPer1M: 4, outputPer1M: 24, cacheReadPer1M: 0.4, cacheWritePer1M: 4 }],
      source: "list",
    });
  });
});

describe("serialization", () => {
  it("serializes the same day to the same bytes whatever order its rows and readings arrive in", () => {
    const turns = Array.from({ length: 60 }, (_, index) => row({
      provider: ["claude", "codex", "cursor"][index % 3]!,
      requestedModel: `m-${index % 7}`,
      reasoningEffort: index % 2 ? "high" : null,
      // Equal dollars in many groups: ties fall back to turns, then the dimensions.
      apiEquivalentUsd: index % 5 === 0 ? null : 0.1 + (index % 4) * 0.2,
      contextTokens: 500 * index,
      durationMs: 37 * index,
      at: at(index % 24, index % 60),
    }));
    const samples: AdeQuotaSample[] = Array.from({ length: 6 }, (_, index) => ({
      v: 1, at: at(index + 1), provider: index % 2 ? "codex" : "claude", accountId: "x:local", windowType: "five_hour", percentUsed: index * 3, resetsAt: at(23),
    }));
    const first = encodeUsageResearchDailyBody(ENVELOPE, input(turns, { quotaSamples: samples }));
    const second = encodeUsageResearchDailyBody(ENVELOPE, input(shuffled(turns), { quotaSamples: shuffled(samples) }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.json).toBe(first.json);
    expect(first.bytes).toBe(Buffer.byteLength(first.json, "utf8"));
  });

  it("drops the hour histograms first, then merges the smallest groups, to fit the byte cap", () => {
    const turns = Array.from({ length: 20 }, (_, index) => row({ requestedModel: `model-${index}`, apiEquivalentUsd: 100 - index }));
    const full = encodeUsageResearchDailyBody(ENVELOPE, input(turns));
    expect(full.ok && !full.droppedHours && full.mergedGroups === 0).toBe(true);
    if (!full.ok) return;

    const withoutHours = encodeUsageResearchDailyBody(ENVELOPE, input(turns), { maxBytes: full.bytes - 1 });
    expect(withoutHours).toMatchObject({ ok: true, droppedHours: true, mergedGroups: 0 });
    if (!withoutHours.ok) return;
    expect(withoutHours.body.report.groups.every((group) => group.hours === undefined)).toBe(true);

    const merged = encodeUsageResearchDailyBody(ENVELOPE, input(turns), { maxBytes: Math.floor(withoutHours.bytes / 2) });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.bytes).toBeLessThanOrEqual(Math.floor(withoutHours.bytes / 2));
    expect(merged.mergedGroups).toBeGreaterThan(0);
    const groups = merged.body.report.groups;
    // The biggest groups survive; the smallest are in `_other`.
    expect(groups[0]!.requestedModel).toBe("model-0");
    expect(groups[groups.length - 1]).toMatchObject({ provider: "_other", mergedGroups: merged.mergedGroups });
    expect(merged.body.report.totals.turns).toBe(20);

    expect(encodeUsageResearchDailyBody(ENVELOPE, input(turns), { maxBytes: 200 })).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("finds the same fit a one-at-a-time walk down from the cap finds", () => {
    // 60 groups of uneven size: long labels, plan units, and varied numbers.
    const turns = Array.from({ length: 60 }, (_, index) => row({
      provider: ["claude", "codex", "copilot", "opencode"][index % 4]!,
      requestedModel: `model-${index}-${"m".repeat(index % 9 * 7)}`,
      reasoningEffort: index % 3 ? "high" : null,
      apiEquivalentUsd: 100 - index * 1.37,
      planUsage: index % 5 === 0 ? [{ unit: "premium_request", amount: index }] : null,
      contextTokens: 1_000 * (index + 1),
      durationMs: 123 * index,
    }));
    const { capped, encode } = usageResearchBodyEncoder(ENVELOPE, input(turns));
    // Every rendering the walk could try, encoded once.
    const full = encode(capped, true);
    const byKeep = Array.from({ length: capped + 1 }, (_, keep) => encode(keep, false));
    /** The walk this search replaced: every `keep` from the cap down, first one that fits. */
    const linear = (maxBytes: number) => {
      if (full.bytes <= maxBytes) return { ok: true, ...full };
      for (let keep = capped; keep >= 0; keep -= 1) {
        if (byKeep[keep]!.bytes <= maxBytes) return { ok: true, ...byKeep[keep]! };
      }
      return { ok: false, reason: "too_large", bytes: byKeep[0]!.bytes };
    };
    const largest = full.bytes;
    const smallest = byKeep[0]!.bytes;
    let checked = 0;
    for (let maxBytes = smallest - 50; maxBytes <= largest + 50; maxBytes += 97) {
      const expected = linear(maxBytes);
      const actual = encodeUsageResearchDailyBody(ENVELOPE, input(turns), { maxBytes });
      expect({ maxBytes, actual: "json" in actual ? actual.json : actual }).toEqual({ maxBytes, actual: "json" in expected ? expected.json : expected });
      expect(actual.ok).toBe(expected.ok);
      if (actual.ok && "mergedGroups" in expected) expect(actual.mergedGroups).toBe(expected.mergedGroups);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("fits a busy 200-turn day well under the cap", () => {
    setDynamicTokenPricingForTest({
      "claude-opus-5-5": tokenPrice(5, 25),
      "claude-sonnet-5": tokenPrice(3, 15),
      "gpt-6-sol": tokenPrice(2, 16),
      "gpt-6-luna": tokenPrice(0.5, 4),
    });
    const encoded = encodeUsageResearchDailyBody(ENVELOPE, input(realisticDay(), {
      quotaSamples: realisticQuota(),
      burnRates: realisticBurnRates(),
    }));
    expect(encoded).toMatchObject({ ok: true, droppedHours: false, mergedGroups: 0 });
    if (!encoded.ok) return;
    expect(encoded.body.report.totals.turns).toBe(200);
    expect(encoded.bytes).toBeLessThan(MAX_USAGE_RESEARCH_BODY_BYTES / 2);
  });
});

/** 200 turns across Claude and Codex, two accounts each, subagent chats, and a few other providers. */
function realisticDay(): AdeTurnUsageRecord[] {
  const shapes: Array<Partial<AdeTurnUsageRecord>> = [
    { provider: "claude", requestedModel: "claude-opus-5-5", reasoningEffort: "high", accountKey: "claude:work", account: { provider: "claude", kind: "subscription" } },
    { provider: "claude", requestedModel: "claude-opus-5-5", reasoningEffort: "medium", accountKey: "claude:personal", account: { provider: "claude", kind: "subscription" } },
    { provider: "claude", requestedModel: "claude-sonnet-5", reasoningEffort: "medium", accountKey: "claude:work", account: { provider: "claude", kind: "subscription" }, parentSessionId: "p" },
    { provider: "codex", requestedModel: "gpt-6-sol", reasoningEffort: "high", accountKey: "codex:a@example.com", account: { provider: "codex", kind: "subscription" } },
    { provider: "codex", requestedModel: "gpt-6-luna", reasoningEffort: "medium", accountKey: "codex:a@example.com", account: { provider: "codex", kind: "subscription" }, surface: "automation" },
    { provider: "codex", requestedModel: "gpt-6-sol", reasoningEffort: "xhigh", accountKey: "codex:key", account: { provider: "codex", kind: "api_key" } },
    { provider: "opencode", requestedModel: "anthropic/claude-sonnet-5", accountKey: "opencode:local", account: { provider: "opencode", kind: "api_key", upstream: "anthropic" } },
    { provider: "cursor", requestedModel: "auto", servedModel: "claude-sonnet-5", accountKey: "cursor:local", account: { provider: "cursor", kind: "subscription" }, costUsd: 0.04, costSource: "provider" },
    { provider: "copilot", requestedModel: "gpt-6-luna", accountKey: "copilot:local", account: { provider: "copilot", kind: "subscription" }, planUsage: [{ unit: "premium_request", amount: 1 }] },
  ];
  return Array.from({ length: 200 }, (_, index) => {
    const shape = shapes[index % shapes.length]!;
    const hour = 8 + (index % 14);
    return row({
      ...shape,
      at: at(hour, (index * 7) % 60),
      startedAt: at(hour, 0),
      status: index % 17 === 0 ? "interrupted" : index % 29 === 0 ? "failed" : "completed",
      inputTokens: 200 + index * 13,
      outputTokens: 800 + index * 31,
      cacheReadTokens: 40_000 + index * 997,
      cacheWriteTokens: 3_000 + index * 11,
      reasoningTokens: 300 + index,
      contextTokens: 30_000 + index * 811,
      contextWindow: 400_000,
      requestCount: 1 + (index % 9),
      apiEquivalentUsd: 0.05 + (index % 13) * 0.137,
      durationMs: 4_000 + index * 523,
      compactions: index % 40 === 0 ? 1 : 0,
      usageConfidence: index % 3 === 0 ? "derived" : "measured",
    });
  });
}

function realisticQuota(): AdeQuotaSample[] {
  const samples: AdeQuotaSample[] = [];
  for (const [provider, accountId] of [["claude", "claude:work"], ["claude", "claude:personal"], ["codex", "codex:a@example.com"]] as const) {
    for (let hour = 8; hour < 22; hour += 1) {
      samples.push({ v: 1, at: at(hour), provider, accountId, windowType: "five_hour", percentUsed: (hour % 5) * 18, resetsAt: at(hour - (hour % 5) + 5) });
      samples.push({ v: 1, at: at(hour, 30), provider, accountId, windowType: "weekly", percentUsed: 20 + hour, resetsAt: "2026-09-27T00:00:00.000Z" });
    }
  }
  return samples;
}

function realisticBurnRates(): AdeQuotaBurnRate[] {
  return ["claude:work", "claude:personal", "codex:a@example.com"].flatMap((accountId) => ["five_hour", "weekly"].map((windowType) => ({
    provider: accountId.split(":")[0]!,
    accountId,
    windowType,
    usdPerPercent: 0.8123,
    turnsPerPercent: 1.33,
    observedPercent: 42.5,
    observedUsd: 34.52,
    observedTurns: 57,
    latestPercentUsed: 61,
    latestResetsAt: null,
    headroomUsd: 31.67,
    confidence: "high" as const,
  })));
}
