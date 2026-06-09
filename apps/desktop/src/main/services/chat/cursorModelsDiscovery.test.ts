import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDescriptor } from "../../../shared/modelRegistry";

const cursorModelsListMock = vi.hoisted(() => vi.fn());
const reportProviderRuntimeAuthFailureMock = vi.hoisted(() => vi.fn());
const reportProviderRuntimeFailureMock = vi.hoisted(() => vi.fn());
const reportProviderRuntimeReadyMock = vi.hoisted(() => vi.fn());
const spawnAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: (...args: unknown[]) => cursorModelsListMock(...args),
    },
  },
}));

vi.mock("../ai/providerRuntimeHealth", () => ({
  reportProviderRuntimeAuthFailure: (...args: unknown[]) => reportProviderRuntimeAuthFailureMock(...args),
  reportProviderRuntimeFailure: (...args: unknown[]) => reportProviderRuntimeFailureMock(...args),
  reportProviderRuntimeReady: (...args: unknown[]) => reportProviderRuntimeReadyMock(...args),
}));

vi.mock("../shared/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/utils")>();
  return {
    ...actual,
    spawnAsync: (...args: unknown[]) => spawnAsyncMock(...args),
  };
});

import {
  clearCursorCliModelsCache,
  discoverCursorCliModelDescriptors,
  discoverCursorSdkModelDescriptors,
  listCursorModelsFromCli,
  listCursorModelsFromSdk,
  mergeCursorModelDescriptorSources,
  parseCursorCliModelsStdout,
  probeCursorSdkModelDiscovery,
  resolveCursorSdkModelSelectionParams,
  resolveCachedCursorModelAvailability,
} from "./cursorModelsDiscovery";

beforeEach(() => {
  cursorModelsListMock.mockReset();
  reportProviderRuntimeAuthFailureMock.mockReset();
  reportProviderRuntimeFailureMock.mockReset();
  reportProviderRuntimeReadyMock.mockReset();
  spawnAsyncMock.mockReset();
  clearCursorCliModelsCache();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parseCursorCliModelsStdout", () => {
  it("parses table lines with optional (current) suffix", () => {
    const raw = [
      "\x1b[2mLoading models…\x1b[0m",
      "Available models",
      "",
      "auto - Auto  (current)",
      "composer-2 - Composer 2",
      "claude-4.6-sonnet-medium - Sonnet 4.6 1M",
    ].join("\n");

    const rows = parseCursorCliModelsStdout(raw);
    expect(rows.map((r) => r.id)).toEqual(["auto", "composer-2", "claude-4.6-sonnet-medium"]);
    expect(rows[0]?.displayName).toBe("Auto");
    expect(rows[1]?.displayName).toBe("Composer 2");
  });

  it("dedupes repeated ids", () => {
    const rows = parseCursorCliModelsStdout("auto - Auto\nauto - Auto");
    expect(rows).toHaveLength(1);
  });

  it("warms exact Cursor SDK models only in cached-or-fallback mode", async () => {
    let resolveModels!: (rows: Array<{ id: string; displayName?: string }>) => void;
    cursorModelsListMock.mockReturnValue(new Promise<Array<{ id: string; displayName?: string }>>((resolve) => {
      resolveModels = resolve;
    }));

    const initial = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "cached-or-fallback" });

    expect(initial).toEqual([]);
    await vi.waitFor(() => {
      expect(cursorModelsListMock).toHaveBeenCalledWith({ apiKey: "crsr_test" });
    });

    resolveModels([
      { id: "claude-4.6-sonnet-medium", displayName: "Sonnet 4.6 Medium" },
      { id: "auto", displayName: "Auto" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const warmed = await discoverCursorSdkModelDescriptors("crsr_test");
    expect(warmed.map((descriptor) => descriptor.id)).toEqual([
      "cursor/auto",
      "cursor/claude-4.6-sonnet-medium",
    ]);
    expect(cursorModelsListMock).toHaveBeenCalledTimes(1);
  });

  it("does not probe Cursor SDK models in cached-only mode", async () => {
    let resolveModels!: (rows: Array<{ id: string; displayName?: string }>) => void;
    cursorModelsListMock.mockReturnValue(new Promise<Array<{ id: string; displayName?: string }>>((resolve) => {
      resolveModels = resolve;
    }));

    const initial = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "cached-only" });

    expect(initial).toEqual([]);
    expect(cursorModelsListMock).not.toHaveBeenCalled();

    void discoverCursorSdkModelDescriptors("crsr_test", { mode: "cached-or-fallback" });
    await vi.waitFor(() => {
      expect(cursorModelsListMock).toHaveBeenCalledWith({ apiKey: "crsr_test" });
    });
    resolveModels([
      { id: "claude-4.6-sonnet-medium", displayName: "Sonnet 4.6 Medium" },
      { id: "auto", displayName: "Auto" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const warmed = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "cached-only" });
    expect(warmed.map((descriptor) => descriptor.id)).toEqual([
      "cursor/auto",
      "cursor/claude-4.6-sonnet-medium",
    ]);
  });

  it("probes exact Cursor SDK models when requested", async () => {
    cursorModelsListMock.mockResolvedValue([
      { id: "claude-4.6-sonnet-medium", displayName: "Sonnet 4.6 Medium" },
      { id: "composer-2", displayName: "Composer 2", aliases: ["composer-latest"] },
      { id: "auto", displayName: "Auto" },
    ]);

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "cursor/auto",
      "cursor/claude-4.6-sonnet-medium",
      "cursor/composer-2",
    ]);
    expect(descriptors.find((descriptor) => descriptor.id === "cursor/composer-2")?.aliases).toContain("composer-latest");
    expect(cursorModelsListMock).toHaveBeenCalledWith({ apiKey: "crsr_test" });
    expect(reportProviderRuntimeReadyMock).toHaveBeenCalledWith("cursor");
  });

  it("keeps Cursor SDK aliases on the canonical model row instead of creating duplicate rows", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        aliases: ["composer-2-5", "composer-latest", "composer"],
      },
    ]);

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["cursor/composer-2.5"]);
    expect(descriptors[0]?.aliases).toEqual(["composer-2-5", "composer-latest", "composer"]);
  });

  it("merges Cursor CLI aliases into SDK canonical rows", async () => {
    const cliDescriptors = [
      {
        id: "cursor/composer",
        shortId: "composer",
        displayName: "Composer CLI",
        family: "cursor",
        authTypes: ["api-key"],
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        capabilities: { tools: true, vision: true, reasoning: true, streaming: true },
        color: "#A78BFA",
        providerRoute: "cursor-sdk",
        providerModelId: "composer",
        cliCommand: "cursor",
        isCliWrapped: false,
      } satisfies ModelDescriptor,
    ];
    const sdkDescriptors = [
      {
        ...cliDescriptors[0]!,
        id: "cursor/composer-2.5",
        shortId: "composer-2.5",
        displayName: "Composer 2.5",
        providerModelId: "composer-2.5",
        aliases: ["composer"],
      } satisfies ModelDescriptor,
    ];

    const merged = mergeCursorModelDescriptorSources({ cliDescriptors, sdkDescriptors });

    expect(merged.map((descriptor) => descriptor.id)).toEqual(["cursor/composer-2.5"]);
    expect(merged[0]?.cursorAvailability).toEqual({ cli: true, sdk: true });
    expect(merged[0]?.aliases).toContain("composer");
  });

  it("merges Cursor CLI and SDK model availability by provider id", async () => {
    cursorModelsListMock.mockResolvedValue([
      { id: "composer-2", displayName: "Composer 2 SDK" },
      { id: "chat-only", displayName: "Chat Only" },
    ]);

    const sdkDescriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });
    const cliRows = parseCursorCliModelsStdout("auto - Auto\ncomposer-2 - Composer 2 CLI\n");
    const cliDescriptors = mergeCursorModelDescriptorSources({
      cliDescriptors: cliRows.map((row): ModelDescriptor => ({
        id: `cursor/${row.id}`,
        shortId: row.id,
        displayName: row.displayName ?? row.id,
        family: "cursor",
        authTypes: ["api-key"],
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        capabilities: { tools: true, vision: true, reasoning: true, streaming: true },
        color: "#A78BFA",
        providerRoute: "cursor-sdk",
        providerModelId: row.id,
        cliCommand: "cursor",
        isCliWrapped: false,
      })),
      sdkDescriptors: [],
    });

    const merged = mergeCursorModelDescriptorSources({ cliDescriptors, sdkDescriptors });

    expect(merged.find((descriptor) => descriptor.id === "cursor/auto")?.cursorAvailability).toEqual({
      cli: true,
      sdk: false,
    });
    expect(merged.find((descriptor) => descriptor.id === "cursor/composer-2")?.cursorAvailability).toEqual({
      cli: true,
      sdk: true,
    });
    expect(merged.find((descriptor) => descriptor.id === "cursor/chat-only")?.cursorAvailability).toEqual({
      cli: false,
      sdk: true,
    });

    expect(mergeCursorModelDescriptorSources({ cliDescriptors: [], sdkDescriptors: [] })).toEqual([]);
  });

  it("uses cached CLI rows to block SDK sends before SDK discovery warms", async () => {
    spawnAsyncMock.mockResolvedValueOnce({
      status: 0,
      stdout: "auto - Auto\n",
      stderr: "",
    });

    await listCursorModelsFromCli("/usr/local/bin/cursor-agent");

    expect(resolveCachedCursorModelAvailability("cursor/auto", "crsr_test")).toEqual({
      cli: true,
      sdk: false,
    });
    expect(resolveCachedCursorModelAvailability("cursor/chat-only", "crsr_test")).toBeNull();
  });

  it("preserves Cursor CLI JSON parameters as runtime reasoning and service tiers", async () => {
    spawnAsyncMock.mockResolvedValueOnce({
      status: 0,
      stdout: JSON.stringify([
        {
          id: "composer-2",
          displayName: "Composer 2",
          parameters: [
            {
              id: "reasoning_effort",
              displayName: "Reasoning effort",
              values: [
                { value: "low", displayName: "Low" },
                { value: "high", displayName: "High" },
              ],
            },
            {
              id: "speed",
              displayName: "Speed",
              values: [{ value: "fast", displayName: "Fast" }],
            },
          ],
        },
      ]),
      stderr: "",
    });

    const rows = await listCursorModelsFromCli("/usr/local/bin/cursor-agent");
    const descriptors = await discoverCursorCliModelDescriptors("/usr/local/bin/cursor-agent", { mode: "cached-only" });

    expect(rows[0]).toMatchObject({
      id: "composer-2",
      reasoningTiers: ["low", "high"],
      serviceTiers: ["fast"],
    });
    expect(descriptors[0]).toMatchObject({
      id: "cursor/composer-2",
      reasoningTiers: ["low", "high"],
      serviceTiers: ["fast"],
    });
  });

  it("folds Cursor CLI -fast rows into the base model descriptor", async () => {
    spawnAsyncMock.mockResolvedValueOnce({
      status: 0,
      stdout: [
        "composer-2.5 - Composer 2.5",
        "composer-2.5-fast - Composer 2.5 Fast (default)",
      ].join("\n"),
      stderr: "",
    });

    const rows = await listCursorModelsFromCli("/usr/local/bin/cursor-agent");
    const descriptors = await discoverCursorCliModelDescriptors("/usr/local/bin/cursor-agent", { mode: "cached-only" });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "composer-2.5",
      aliases: ["composer-2.5-fast"],
      serviceTiers: ["fast"],
      cliVariants: [
        { modelId: "composer-2.5", fastMode: false },
        { modelId: "composer-2.5-fast", fastMode: true },
      ],
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: "cursor/composer-2.5",
      aliases: ["composer-2.5-fast"],
      serviceTiers: ["fast"],
      cursorCliVariants: [
        { modelId: "composer-2.5", fastMode: false },
        { modelId: "composer-2.5-fast", fastMode: true },
      ],
    });
    expect(resolveCachedCursorModelAvailability("cursor/composer-2.5-fast", "crsr_test")).toEqual({
      cli: true,
      sdk: false,
    });
  });

  it("folds Cursor CLI reasoning and fast concrete rows into an abstract base descriptor", async () => {
    spawnAsyncMock.mockResolvedValueOnce({
      status: 0,
      stdout: [
        "claude-opus-4-7-thinking-low - Opus 4.7 1M Low Thinking",
        "claude-opus-4-7-thinking-low-fast - Opus 4.7 1M Low Thinking Fast",
        "claude-opus-4-7-thinking-medium - Opus 4.7 1M Medium Thinking",
        "claude-opus-4-7-thinking-medium-fast - Opus 4.7 1M Medium Thinking Fast",
      ].join("\n"),
      stderr: "",
    });

    const rows = await listCursorModelsFromCli("/usr/local/bin/cursor-agent");
    const descriptors = await discoverCursorCliModelDescriptors("/usr/local/bin/cursor-agent", { mode: "cached-only" });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "claude-opus-4-7-thinking",
      displayName: "Opus 4.7 1M Thinking",
      aliases: [
        "claude-opus-4-7-thinking-low",
        "claude-opus-4-7-thinking-low-fast",
        "claude-opus-4-7-thinking-medium",
        "claude-opus-4-7-thinking-medium-fast",
      ],
      reasoningTiers: ["low", "medium"],
      serviceTiers: ["fast"],
      cliVariants: [
        { modelId: "claude-opus-4-7-thinking-low", reasoningEffort: "low", fastMode: false },
        { modelId: "claude-opus-4-7-thinking-low-fast", reasoningEffort: "low", fastMode: true },
        { modelId: "claude-opus-4-7-thinking-medium", reasoningEffort: "medium", fastMode: false },
        { modelId: "claude-opus-4-7-thinking-medium-fast", reasoningEffort: "medium", fastMode: true },
      ],
    });
    expect(descriptors[0]).toMatchObject({
      id: "cursor/claude-opus-4-7-thinking",
      reasoningTiers: ["low", "medium"],
      serviceTiers: ["fast"],
      cursorCliVariants: [
        { modelId: "claude-opus-4-7-thinking-low", reasoningEffort: "low", fastMode: false },
        { modelId: "claude-opus-4-7-thinking-low-fast", reasoningEffort: "low", fastMode: true },
        { modelId: "claude-opus-4-7-thinking-medium", reasoningEffort: "medium", fastMode: false },
        { modelId: "claude-opus-4-7-thinking-medium-fast", reasoningEffort: "medium", fastMode: true },
      ],
    });
  });

  it("preserves Cursor SDK parameters and variants as runtime reasoning and service tiers", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "composer-2",
        displayName: "Composer 2",
        aliases: ["composer-latest"],
        parameters: [
          {
            id: "reasoning_effort",
            displayName: "Reasoning effort",
            values: [
              { value: "low", displayName: "Low" },
              { value: "high", displayName: "High" },
            ],
          },
          {
            id: "speed",
            displayName: "Speed",
            values: [{ value: "fast", displayName: "Fast" }],
          },
        ],
        variants: [
          {
            displayName: "Fast High",
            params: [
              { id: "reasoning_effort", value: "high" },
              { id: "speed", value: "fast" },
            ],
          },
        ],
      },
    ]);

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(descriptors[0]).toMatchObject({
      id: "cursor/composer-2",
      reasoningTiers: ["low", "high"],
      serviceTiers: ["fast"],
    });
    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-2",
      reasoningEffort: "high",
      fastMode: true,
    })).toEqual([
      { id: "reasoning_effort", value: "high" },
      { id: "speed", value: "fast" },
    ]);
    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-latest",
      reasoningEffort: "high",
      fastMode: true,
    })).toEqual([
      { id: "reasoning_effort", value: "high" },
      { id: "speed", value: "fast" },
    ]);
  });

  it("passes explicit standard service tier params when Cursor fast mode is off", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [
          {
            id: "speed",
            displayName: "Speed",
            values: [
              { value: "standard", displayName: "Standard" },
              { value: "fast", displayName: "Fast" },
            ],
          },
        ],
        variants: [
          {
            displayName: "Standard",
            params: [{ id: "speed", value: "standard" }],
          },
          {
            displayName: "Fast",
            params: [{ id: "speed", value: "fast" }],
          },
        ],
      },
    ]);

    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-2.5",
      fastMode: false,
    })).toEqual([{ id: "speed", value: "standard" }]);
    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-2.5",
      fastMode: true,
    })).toEqual([{ id: "speed", value: "fast" }]);
  });

  it("does not let standard tier variants overwrite selected Cursor reasoning params", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [
          {
            id: "reasoning_effort",
            displayName: "Reasoning effort",
            values: [
              { value: "low", displayName: "Low" },
              { value: "high", displayName: "High" },
            ],
          },
          {
            id: "speed",
            displayName: "Speed",
            values: [
              { value: "standard", displayName: "Standard" },
              { value: "fast", displayName: "Fast" },
            ],
          },
        ],
        variants: [
          {
            displayName: "High reasoning",
            params: [{ id: "reasoning_effort", value: "high" }],
          },
          {
            displayName: "Standard",
            params: [
              { id: "speed", value: "standard" },
              { id: "reasoning_effort", value: "low" },
            ],
          },
        ],
      },
    ]);

    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-2.5",
      reasoningEffort: "high",
      fastMode: false,
    })).toEqual([
      { id: "reasoning_effort", value: "high" },
      { id: "speed", value: "standard" },
    ]);
  });

  it("falls back to Cursor's official models API when SDK model listing fails", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("SDK model listing failed"));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: ["claude-4-sonnet-thinking", "o3", "claude-4-opus-thinking"],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "cursor/claude-4-opus-thinking",
      "cursor/claude-4-sonnet-thinking",
      "cursor/o3",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cursor.com/v0/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer crsr_test",
        }),
      }),
    );
    expect(reportProviderRuntimeReadyMock).not.toHaveBeenCalled();
  });

  it("returns no Cursor SDK rows when model APIs cannot enumerate", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("SDK model listing failed"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });
    expect(descriptors).toEqual([]);
  });

  it("does not show fallback models when Cursor rejects agent/model auth", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("AuthenticationError (status=401, endpoint=GET /v1/models)"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));

    await expect(probeCursorSdkModelDiscovery("crsr_test", { timeoutMs: 1_000 })).resolves.toMatchObject({
      rows: [],
      failureKind: "auth",
    });

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });
    expect(descriptors).toEqual([]);
  });

  it("does not reuse cached Cursor SDK rows for explicit probe verification", async () => {
    cursorModelsListMock.mockResolvedValueOnce([{ id: "cached-model", name: "Cached Model" }]);
    await expect(probeCursorSdkModelDiscovery("crsr_test", { timeoutMs: 1_000 })).resolves.toMatchObject({
      rows: [{ id: "cached-model" }],
      failureKind: null,
    });

    cursorModelsListMock.mockRejectedValue(new Error("AuthenticationError (status=401, endpoint=GET /v1/models)"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));

    const freshProbe = await probeCursorSdkModelDiscovery("crsr_test", { timeoutMs: 1_000 });
    expect(freshProbe).toMatchObject({
      rows: [],
      failureKind: "auth",
    });
    expect(freshProbe.fromCache).toBeUndefined();
  });

  it("suppresses warmed Cursor SDK cache after an SDK runtime failure", async () => {
    cursorModelsListMock.mockResolvedValueOnce([{ id: "cached-model", displayName: "Cached Model" }]);
    await expect(probeCursorSdkModelDiscovery("crsr_test", { timeoutMs: 1_000 })).resolves.toMatchObject({
      rows: [{ id: "cached-model", displayName: "Cached Model" }],
      failureKind: null,
    });

    cursorModelsListMock.mockRejectedValue(new Error("Cannot find package '@cursor/sdk' imported from /Applications/ADE Beta.app/Contents/Resources/ade-cli/cli.js"));

    await expect(probeCursorSdkModelDiscovery("crsr_test", { timeoutMs: 1_000 })).resolves.toMatchObject({
      rows: [],
      failureKind: "unavailable",
    });

    await expect(discoverCursorSdkModelDescriptors("crsr_test", { mode: "cached-only" })).resolves.toEqual([]);
    expect(resolveCachedCursorModelAvailability("cursor/cached-model", "crsr_test")).toBeNull();
    expect(reportProviderRuntimeFailureMock).toHaveBeenCalledWith(
      "cursor",
      expect.stringContaining("Cannot find package '@cursor/sdk'"),
    );
  });

  it("suppresses fallback rows after a warm auth failure", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("AuthenticationError (status=401, endpoint=GET /v1/models)"));
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const initial = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "cached-or-fallback" });
    expect(initial).toEqual([]);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    cursorModelsListMock.mockClear();
    fetchMock.mockClear();

    const afterFailure = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "cached-or-fallback" });
    expect(afterFailure).toEqual([]);
    expect(cursorModelsListMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds direct Cursor SDK model list discovery with a timeout", async () => {
    vi.useFakeTimers();
    cursorModelsListMock.mockReturnValue(new Promise(() => undefined));

    const rowsPromise = listCursorModelsFromSdk("crsr_test", { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(26);

    await expect(rowsPromise).resolves.toEqual([]);
  });
});
