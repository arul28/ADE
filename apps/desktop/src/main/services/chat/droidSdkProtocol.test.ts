import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  abortedBefore,
  droidEditedSpecContentForRequest,
  droidInteractionModeValue,
  droidMcpToolsToDisable,
  droidModelDefaultReasoningEffort,
  normalizeDroidSdkTokenUsage,
  rejectAfterDeadline,
  resolveDroidReasoningEffortUpdate,
} from "./droidSdkProtocol";

describe("droidMcpToolsToDisable", () => {
  it("disables enabled user MCP tools while retaining ADE's leased server", () => {
    expect(droidMcpToolsToDisable([
      { serverName: "ade-cto", name: "list_lanes", isEnabled: true },
      { serverName: "filesystem", name: "write_file", isEnabled: true },
      { serverName: "filesystem", name: "read_file", isEnabled: false },
      { serverName: "linear", name: "search", isEnabled: true },
    ], ["ade-cto"])).toEqual([
      { serverName: "filesystem", toolName: "write_file" },
      { serverName: "linear", toolName: "search" },
    ]);
  });

  it("ignores malformed entries and fails closed for unknown MCP state", () => {
    expect(droidMcpToolsToDisable([
      { serverName: "", name: "write_file", isEnabled: true },
      { serverName: "filesystem", name: "", isEnabled: true },
      { serverName: "filesystem", name: "write_file", isEnabled: false },
      { serverName: "filesystem", name: "unknown_state" },
    ], [])).toEqual([
      { serverName: "filesystem", toolName: "unknown_state" },
    ]);
  });
});

describe("droidInteractionModeValue", () => {
  const table = { Auto: "AUTO", Spec: "SPEC", AGI: "AGI" } as const;

  it("returns undefined for an omitted mode so the user's settings decide", () => {
    // The regression: the worker mapped undefined onto Auto, which restated the
    // mode at the highest precedence and undid the omission the service had
    // deliberately made. A live probe showed omission resolves each key from the
    // user's own ~/.factory/settings.json.
    expect(droidInteractionModeValue(table, undefined)).toBeUndefined();
  });

  it("maps every stated mode onto its SDK enum value", () => {
    expect(droidInteractionModeValue(table, "auto")).toBe("AUTO");
    expect(droidInteractionModeValue(table, "spec")).toBe("SPEC");
    expect(droidInteractionModeValue(table, "agi")).toBe("AGI");
  });
});

describe("droidEditedSpecContentForRequest", () => {
  it("returns the ExitSpecMode plan so proceed_edit can carry required content", () => {
    expect(droidEditedSpecContentForRequest([
      { details: { type: "exit_spec_mode", plan: "## Plan\n1. Do the thing" } },
    ])).toBe("## Plan\n1. Do the thing");
  });

  it("returns null when no exit_spec_mode plan is present, so the worker fails closed", () => {
    expect(droidEditedSpecContentForRequest([
      { details: { type: "execute", fullCommand: "rm -rf /" } },
      { details: { type: "exit_spec_mode", plan: 42 } },
    ])).toBeNull();
    expect(droidEditedSpecContentForRequest([])).toBeNull();
    expect(droidEditedSpecContentForRequest(undefined)).toBeNull();
    expect(droidEditedSpecContentForRequest([
      { details: null },
      { details: "not-an-object" },
      {},
    ])).toBeNull();
  });
});

describe("normalizeDroidSdkTokenUsage", () => {
  it("reads the tokenUsage shape from a worker settings fixture", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-droid-usage-"));
    try {
      const settingsPath = path.join(root, "worker.settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify({
        modelId: "claude-sonnet-5",
        tokenUsage: {
          inputTokens: 120,
          outputTokens: 80,
          cacheCreationTokens: 12,
          cacheReadTokens: 34,
          thinkingTokens: 56,
        },
      }), "utf8");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
      expect(normalizeDroidSdkTokenUsage(settings)).toEqual({
        inputTokens: 120,
        outputTokens: 80,
        cacheCreationTokens: 12,
        cacheReadTokens: 34,
        thinkingTokens: 56,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Droid reasoning effort updates", () => {
  // Rows shaped like @factory/droid-sdk 0.9 `listModels()` ModelInfo.
  const catalog = [
    { id: "claude-sonnet-4-6", supportedReasoningEfforts: ["off", "low", "medium", "high"], defaultReasoningEffort: "medium" },
    { id: "gpt-5.5", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "high" },
  ];

  it("reads Droid's own default for a model from its catalog", () => {
    expect(droidModelDefaultReasoningEffort(catalog, "gpt-5.5")).toBe("high");
    expect(droidModelDefaultReasoningEffort(catalog, " claude-sonnet-4-6 ")).toBe("medium");
    expect(droidModelDefaultReasoningEffort(catalog, "custom:unknown")).toBeNull();
    expect(droidModelDefaultReasoningEffort(null, "gpt-5.5")).toBeNull();
  });

  it("states the effort the chat picked", async () => {
    const loadModels = vi.fn(async () => catalog);
    await expect(resolveDroidReasoningEffortUpdate({ requested: "low", stated: "high", modelId: "gpt-5.5", loadModels }))
      .resolves.toEqual({ effort: "low", stated: "low" });
    expect(loadModels).not.toHaveBeenCalled();
  });

  // The bug: an update without an effort kept the one ADE stated earlier, and
  // the protocol has no null reset for `reasoningEffort`.
  it("resets an effort the chat cleared to Droid's default for the model", async () => {
    const loadModels = vi.fn(async () => catalog);
    await expect(resolveDroidReasoningEffortUpdate({ requested: undefined, stated: "xhigh", modelId: "gpt-5.5", loadModels }))
      .resolves.toEqual({ effort: "high", stated: null });
    await expect(resolveDroidReasoningEffortUpdate({ requested: null, stated: "high", modelId: "claude-sonnet-4-6", loadModels }))
      .resolves.toEqual({ effort: "medium", stated: null });
  });

  it("leaves an effort ADE never stated to Droid and the user's settings", async () => {
    const loadModels = vi.fn(async () => catalog);
    await expect(resolveDroidReasoningEffortUpdate({ requested: undefined, stated: null, modelId: "gpt-5.5", loadModels }))
      .resolves.toEqual({ stated: null });
    expect(loadModels).not.toHaveBeenCalled();
  });

  it("keeps the stated effort, and says why, when Droid's default cannot be read", async () => {
    await expect(resolveDroidReasoningEffortUpdate({
      requested: undefined,
      stated: "xhigh",
      modelId: "custom:mine",
      loadModels: async () => catalog,
    })).resolves.toEqual({ stated: "xhigh", resetError: expect.stringContaining("custom:mine") });
    await expect(resolveDroidReasoningEffortUpdate({
      requested: undefined,
      stated: "xhigh",
      modelId: "gpt-5.5",
      loadModels: async () => { throw new Error("droid exited"); },
    })).resolves.toEqual({ stated: "xhigh", resetError: "droid exited" });
  });

  // A model list that never loads must not hold the send: the reset is an
  // error after the deadline, and the effort stays stated for a retry.
  it("keeps the stated effort when Droid's model list misses the deadline", async () => {
    vi.useFakeTimers();
    try {
      const update = resolveDroidReasoningEffortUpdate({
        requested: undefined,
        stated: "xhigh",
        modelId: "gpt-5.5",
        loadModels: () => rejectAfterDeadline(new Promise<never>(() => {}), 8_000, () => new Error("model list timed out")),
      });
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(update).resolves.toEqual({ stated: "xhigh", resetError: "model list timed out" });
    } finally {
      vi.useRealTimers();
    }
    await expect(rejectAfterDeadline(Promise.resolve([1]), 8_000, () => new Error("late"))).resolves.toEqual([1]);
  });

  it("ends a send's settings wait on a Stop, and otherwise waits for the settings", async () => {
    const stop = new AbortController();
    const stalled = abortedBefore(new Promise<never>(() => {}), stop.signal);
    stop.abort();
    await expect(stalled).resolves.toBe(true);
    await expect(abortedBefore(Promise.resolve(), new AbortController().signal)).resolves.toBe(false);
    await expect(abortedBefore(Promise.reject(new Error("settings failed")), new AbortController().signal))
      .rejects.toThrow("settings failed");
  });
});
