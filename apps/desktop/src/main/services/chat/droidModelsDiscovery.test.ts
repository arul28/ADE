import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnAsync = vi.hoisted(() => vi.fn());
const mockHome = vi.hoisted(() => ({ path: "" }));

vi.mock("../shared/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/utils")>();
  return {
    ...actual,
    spawnAsync: mockSpawnAsync,
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    homedir: () => mockHome.path,
  };
});

import {
  clearDroidCliModelsCache,
  discoverDroidCliModelDescriptors,
  markDroidModelCachesStale,
  parseDroidExecHelpModelIds,
  parseDroidExecHelpModels,
} from "./droidModelsDiscovery";

function helpFromModels(rows: Array<{ id: string; displayName?: string }>) {
  const body = rows
    .map((row) => `  ${row.id.padEnd(40)}${row.displayName ?? row.id}`)
    .join("\n");
  return { status: 0, stdout: `Available Models:\n${body}\n`, stderr: "" };
}

function emptyHelp() {
  return { status: 0, stdout: "Usage: droid exec\n", stderr: "" };
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(tmpdir(), "ade-droid-models-"));
  mockHome.path = tmpHome;
  clearDroidCliModelsCache();
  mockSpawnAsync.mockReset();
  mockSpawnAsync.mockResolvedValue(emptyHelp());
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("parseDroidExecHelpModels", () => {
  it("parses built-in and custom rows with CLI display names and stops at the next section", () => {
    const raw = [
      "Usage: droid exec [options] [prompt]",
      "",
      "Available Models:",
      "  claude-opus-4-6                           Claude Opus 4.6 (default)",
      "",
      "Custom Models:",
      "  custom:gpt-5.4(xhigh)                     GPT-5.4 (XHigh)",
      "",
      "Model details:",
      "  - Claude Opus 4.6: supports reasoning: Yes",
    ].join("\n");

    expect(parseDroidExecHelpModels(raw)).toEqual([
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6 (default)" },
      { id: "custom:gpt-5.4(xhigh)", displayName: "GPT-5.4 (XHigh)" },
    ]);
  });
});

describe("discoverDroidCliModelDescriptors", () => {
  it("uses droid exec --help for the model catalog and does not open an SDK session", async () => {
    mockSpawnAsync.mockResolvedValueOnce(helpFromModels([
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { id: "custom:gpt-5.4(xhigh)", displayName: "GPT-5.4 (XHigh)" },
    ]));

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(mockSpawnAsync).toHaveBeenCalledWith(
      "/mock/bin/droid",
      ["exec", "--help"],
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "droid/claude-sonnet-5",
      "droid/custom:gpt-5.4(xhigh)",
    ]);
    expect(descriptors[1]).toMatchObject({
      displayName: "GPT-5.4 (XHigh)",
      providerModelId: "custom:gpt-5.4(xhigh)",
    });
  });

  it("normalizes removed Droid factory model IDs before surfacing them", async () => {
    mockSpawnAsync.mockResolvedValueOnce(helpFromModels([
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      { id: "sonnet-4-6", displayName: "Sonnet 4.6" },
      { id: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
      { id: "opus-4-7", displayName: "Opus 4.7" },
      { id: "claude-opus-4-6-fast", displayName: "Claude Opus 4.6 Fast Mode" },
      { id: "opus", displayName: "Opus" },
      { id: "claude-fable-5", displayName: "Claude Fable 5" },
      { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    ]));

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "droid/claude-fable-5-1",
      "droid/claude-opus-5",
      "droid/claude-opus-5-5",
      "droid/claude-sonnet-5",
    ]);
    expect(descriptors.map((descriptor) => descriptor.displayName)).toEqual([
      "Fable 5.1",
      "Opus 5",
      "Opus 5.5",
      "Sonnet 5 (1.2x)",
    ]);
    expect(descriptors.map((descriptor) => descriptor.providerModelId)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
    ]);
  });

  it("merges existing Factory config custom models with CLI help models", async () => {
    fs.mkdirSync(path.join(tmpHome, ".factory"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".factory", "config.json"),
      JSON.stringify({
        custom_models: [
          {
            model: "claude-sonnet-5-thinking-32000",
            model_display_name: "Claude Sonnet 5 (High)",
          },
        ],
      }),
      "utf8",
    );
    mockSpawnAsync.mockResolvedValueOnce(helpFromModels([
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    ]));

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "droid/claude-sonnet-5",
      "droid/custom:claude-sonnet-5-thinking-32000",
    ]);
    expect(descriptors[1]).toMatchObject({
      displayName: "Claude Sonnet 5 (High)",
      customProxy: true,
    });
  });

  it("gives retired and canonical Factory config custom models canonical metadata while preserving the custom proxy", async () => {
    fs.mkdirSync(path.join(tmpHome, ".factory"), { recursive: true });
    const customModels: Array<[string, string]> = [
      // Retired aliases first, then the canonical ids they map to.
      ["sonnet-4-6", "Retired Sonnet custom alias"],
      ["opus-4-7", "Retired Opus custom alias"],
      ["opus", "Current Opus custom alias"],
      ["claude-sonnet-5", "Canonical Sonnet custom proxy"],
      ["claude-opus-5", "Canonical Opus custom proxy"],
      ["claude-opus-5-5", "Canonical Opus 5.5 custom proxy"],
      ["custom-real-model", "Custom Real Model"],
    ];
    fs.writeFileSync(
      path.join(tmpHome, ".factory", "config.json"),
      JSON.stringify({
        custom_models: customModels.map(([model, name]) => ({ model, model_display_name: name })),
      }),
      "utf8",
    );
    mockSpawnAsync.mockResolvedValueOnce(emptyHelp());

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(new Set(descriptors.map((descriptor) => descriptor.id))).toEqual(new Set([
      "droid/custom:claude-opus-5",
      "droid/custom:claude-opus-5-5",
      "droid/custom:claude-sonnet-5",
      "droid/custom:custom-real-model",
    ]));
    expect(descriptors.find((descriptor) => descriptor.id === "droid/custom:claude-sonnet-5")).toMatchObject({
      providerModelId: "custom:claude-sonnet-5",
      displayName: "Sonnet 5 (1.2x)",
      customProxy: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: expect.objectContaining({ vision: true, reasoning: true }),
      reasoningTiers: ["low", "medium", "high", "max"],
    });
    expect(descriptors.find((descriptor) => descriptor.id === "droid/custom:claude-opus-5")).toMatchObject({
      providerModelId: "custom:claude-opus-5",
      displayName: "Opus 5",
      customProxy: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    });
    expect(descriptors.find((descriptor) => descriptor.id === "droid/custom:claude-opus-5-5")).toMatchObject({
      providerModelId: "custom:claude-opus-5-5",
      displayName: "Opus 5.5",
      customProxy: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
    });
    expect(descriptors.find((descriptor) => descriptor.id === "droid/custom:custom-real-model")).toMatchObject({
      displayName: "Custom Real Model",
      customProxy: true,
    });
  });

  it("serves last-known-good rows past the freshness window and revalidates once in the background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T00:00:00.000Z"));
    try {
      mockSpawnAsync.mockResolvedValueOnce(helpFromModels([{ id: "claude-sonnet-5" }]));
      const seeded = await discoverDroidCliModelDescriptors("/mock/bin/droid");
      expect(seeded.map((d) => d.id)).toEqual(["droid/claude-sonnet-5"]);
      expect(mockSpawnAsync).toHaveBeenCalledTimes(1);

      markDroidModelCachesStale();
      mockSpawnAsync.mockRejectedValue(new Error("droid help unavailable"));

      const stale = await discoverDroidCliModelDescriptors("/mock/bin/droid", { mode: "cached-or-fallback" });
      expect(stale.map((d) => d.id)).toEqual(["droid/claude-sonnet-5"]);
      const warmCalls = mockSpawnAsync.mock.calls.length;
      expect(warmCalls).toBeGreaterThan(1);

      const again = await discoverDroidCliModelDescriptors("/mock/bin/droid", { mode: "cached-or-fallback" });
      expect(again.map((d) => d.id)).toEqual(["droid/claude-sonnet-5"]);
      expect(mockSpawnAsync).toHaveBeenCalledTimes(warmCalls);
    } finally {
      vi.useRealTimers();
    }
  });
});
