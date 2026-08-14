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

describe("parseDroidExecHelpModelIds", () => {
  it("parses built-in and custom models from droid exec help", () => {
    const raw = [
      "Usage: droid exec [options] [prompt]",
      "",
      "Available Models:",
      "  claude-opus-4-6                           Claude Opus 4.6 (default)",
      "  gpt-5.3-codex                             GPT-5.3-Codex",
      "",
      "Custom Models:",
      "  custom:claude-opus-4-6-thinking-32000     Claude Opus 4.6 (High)",
      "  custom:gpt-5.4(xhigh)                     GPT-5.4 (XHigh)",
      "",
      "Model details:",
      "  - Claude Opus 4.6: supports reasoning: Yes",
    ].join("\n");

    expect(parseDroidExecHelpModelIds(raw)).toEqual([
      "claude-opus-4-6",
      "gpt-5.3-codex",
      "custom:claude-opus-4-6-thinking-32000",
      "custom:gpt-5.4(xhigh)",
    ]);
  });
});

describe("parseDroidExecHelpModels", () => {
  it("keeps the CLI display name for custom models", () => {
    const raw = [
      "Usage: droid exec [options] [prompt]",
      "",
      "Custom Models:",
      "  custom:claude-sonnet-5-thinking-32000   Claude Sonnet 5 (High)",
      "  custom:gpt-5.4(xhigh)                     GPT-5.4 (XHigh)",
      "",
      "Model details:",
    ].join("\n");

    expect(parseDroidExecHelpModels(raw)).toEqual([
      {
        id: "custom:claude-sonnet-5-thinking-32000",
        displayName: "Claude Sonnet 5 (High)",
      },
      {
        id: "custom:gpt-5.4(xhigh)",
        displayName: "GPT-5.4 (XHigh)",
      },
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
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8 1M" },
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    ]));

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "droid/claude-opus-4-8",
      "droid/claude-opus-5",
      "droid/claude-sonnet-5",
    ]);
    expect(descriptors.map((descriptor) => descriptor.displayName)).toEqual([
      "Opus 4.8 1M",
      "Opus 5",
      "Sonnet 5 (1.2x)",
    ]);
    expect(descriptors.map((descriptor) => descriptor.providerModelId)).toEqual([
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
  });

  it("reroutes removed Droid runtime ids when canonical replacements are absent", async () => {
    mockSpawnAsync.mockResolvedValueOnce(helpFromModels([
      { id: "sonnet-4-6", displayName: "Sonnet 4.6" },
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
      { id: "claude-opus-4-6-fast", displayName: "Claude Opus 4.6 Fast Mode" },
      { id: "opus-4-6", displayName: "Opus 4.6" },
      { id: "opus", displayName: "Opus" },
    ]));

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(descriptors.find((descriptor) => descriptor.id === "droid/claude-sonnet-5")).toMatchObject({
      displayName: "Sonnet 5 (1.2x)",
      providerModelId: "claude-sonnet-5",
      capabilities: expect.objectContaining({
        vision: true,
        reasoning: true,
      }),
      reasoningTiers: ["low", "medium", "high", "max"],
    });
    expect(descriptors.find((descriptor) => descriptor.id === "droid/claude-opus-5")).toMatchObject({
      displayName: "Opus 5",
      providerModelId: "claude-opus-5",
      capabilities: expect.objectContaining({
        vision: true,
        reasoning: true,
      }),
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    });
    expect(descriptors.find((descriptor) => descriptor.id === "droid/claude-opus-5")?.serviceTiers).toBeUndefined();
  });

  it("prefers canonical Droid rows over normalized retired aliases", async () => {
    mockSpawnAsync.mockResolvedValueOnce(helpFromModels([
      { id: "sonnet-4-6", displayName: "Sonnet 4.6" },
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    ]));

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(descriptors.filter((descriptor) => descriptor.id === "droid/claude-sonnet-5")).toHaveLength(1);
    expect(descriptors.find((descriptor) => descriptor.id === "droid/claude-sonnet-5")).toMatchObject({
      providerModelId: "claude-sonnet-5",
    });
  });

  it("does not invent SDK-only reasoning metadata from CLI help rows", async () => {
    mockSpawnAsync.mockResolvedValueOnce(helpFromModels([
      { id: "gpt-5.4", displayName: "GPT-5.4" },
    ]));

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(descriptors[0]).toMatchObject({
      id: "droid/gpt-5.4",
      displayName: "GPT-5.4",
    });
    expect(descriptors[0]?.serviceTiers).toBeUndefined();
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

  it("normalizes retired Factory config custom aliases while preserving the custom proxy", async () => {
    fs.mkdirSync(path.join(tmpHome, ".factory"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".factory", "config.json"),
      JSON.stringify({
        custom_models: [
          {
            model: "sonnet-4-6",
            model_display_name: "Retired Sonnet custom alias",
          },
          {
            model: "opus-4-7",
            model_display_name: "Retired Opus custom alias",
          },
          {
            model: "opus",
            model_display_name: "Current Opus custom alias",
          },
          {
            model: "custom-real-model",
            model_display_name: "Custom Real Model",
          },
        ],
      }),
      "utf8",
    );
    mockSpawnAsync.mockResolvedValueOnce(emptyHelp());

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(new Set(descriptors.map((descriptor) => descriptor.id))).toEqual(new Set([
      "droid/custom:claude-opus-4-8",
      "droid/custom:claude-opus-5",
      "droid/custom:claude-sonnet-5",
      "droid/custom:custom-real-model",
    ]));
    expect(descriptors.find((descriptor) => descriptor.id === "droid/custom:claude-sonnet-5")).toMatchObject({
      providerModelId: "custom:claude-sonnet-5",
      displayName: "Sonnet 5 (1.2x)",
      customProxy: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningTiers: ["low", "medium", "high", "max"],
    });
    expect(descriptors.find((descriptor) => descriptor.id === "droid/custom:claude-opus-4-8")).toMatchObject({
      providerModelId: "custom:claude-opus-4-8",
      displayName: "Opus 4.8 1M",
      customProxy: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      serviceTiers: ["fast"],
      reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultracode"],
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
    expect(
      descriptors.find((descriptor) => descriptor.id === "droid/custom:claude-opus-5")?.serviceTiers,
    ).toBeUndefined();
    expect(descriptors.find((descriptor) => descriptor.id === "droid/custom:custom-real-model")).toMatchObject({
      displayName: "Custom Real Model",
      customProxy: true,
    });
  });

  it("adds canonical metadata to Factory config custom models that already use canonical ids", async () => {
    fs.mkdirSync(path.join(tmpHome, ".factory"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".factory", "config.json"),
      JSON.stringify({
        custom_models: [
          {
            model: "claude-sonnet-5",
            model_display_name: "Canonical Sonnet custom proxy",
          },
          {
            model: "claude-opus-4-8",
            model_display_name: "Canonical Opus custom proxy",
          },
        ],
      }),
      "utf8",
    );
    mockSpawnAsync.mockResolvedValueOnce(emptyHelp());

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(descriptors.find((descriptor) => descriptor.id === "droid/custom:claude-sonnet-5")).toMatchObject({
      providerModelId: "custom:claude-sonnet-5",
      customProxy: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningTiers: ["low", "medium", "high", "max"],
    });
    expect(descriptors.find((descriptor) => descriptor.id === "droid/custom:claude-opus-4-8")).toMatchObject({
      providerModelId: "custom:claude-opus-4-8",
      customProxy: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      serviceTiers: ["fast"],
      reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultracode"],
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
