import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateSession = vi.hoisted(() => vi.fn());
const mockHome = vi.hoisted(() => ({ path: "" }));

vi.mock("@factory/droid-sdk", () => ({
  createSession: mockCreateSession,
}));

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

function sessionWithModels(ids: string[]) {
  return {
    initResult: {
      availableModels: ids.map((id) => ({ id, displayName: id })),
    },
    close: vi.fn(async () => {}),
  };
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(tmpdir(), "ade-droid-models-"));
  mockHome.path = tmpHome;
  clearDroidCliModelsCache();
  mockCreateSession.mockReset();
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
  it("uses the Droid SDK model catalog before fallback models", async () => {
    const close = vi.fn(async () => {});
    mockCreateSession.mockResolvedValueOnce({
      initResult: {
        availableModels: [
          {
            id: "claude-sonnet-5",
            displayName: "Claude Sonnet 5",
          },
          {
            id: "custom:gpt-5.4(xhigh)",
            displayName: "GPT-5.4 (XHigh)",
            isCustom: true,
          },
        ],
      },
      close,
    });

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      execPath: "/mock/bin/droid",
    }));
    expect(close).toHaveBeenCalled();
    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "droid/claude-sonnet-5",
      "droid/custom:gpt-5.4(xhigh)",
    ]);
    expect(descriptors[1]).toMatchObject({
      displayName: "GPT-5.4 (XHigh)",
      customProxy: true,
    });
  });

  it("normalizes removed Droid factory model IDs before surfacing them", async () => {
    mockCreateSession.mockResolvedValueOnce({
      initResult: {
        availableModels: [
          { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
          { id: "sonnet-4-6", displayName: "Sonnet 4.6" },
          { id: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
          { id: "opus-4-7", displayName: "Opus 4.7" },
          { id: "opus", displayName: "Opus" },
          { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
        ],
      },
      close: vi.fn(async () => {}),
    });

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "droid/claude-opus-4-8",
      "droid/claude-sonnet-5",
    ]);
    expect(descriptors.map((descriptor) => descriptor.displayName)).toEqual([
      "Opus 4.8 1M",
      "Sonnet 5 (1.2x)",
    ]);
  });

  it("preserves Droid SDK reasoning and media metadata without exposing tier as a toggle", async () => {
    const close = vi.fn(async () => {});
    mockCreateSession.mockResolvedValueOnce({
      initResult: {
        availableModels: [
          {
            id: "gpt-5.4",
            displayName: "GPT-5.4",
            supportedReasoningEfforts: ["low", "high", "max"],
            defaultReasoningEffort: "high",
            tier: "fast",
            noImageSupport: true,
          },
        ],
      },
      close,
    });

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(descriptors[0]).toMatchObject({
      id: "droid/gpt-5.4",
      reasoningTiers: ["high", "low", "max"],
      capabilities: expect.objectContaining({
        vision: false,
        reasoning: true,
      }),
    });
    expect(descriptors[0]?.serviceTiers).toBeUndefined();
  });

  it("merges existing Factory config custom models with SDK models", async () => {
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
    mockCreateSession.mockResolvedValueOnce({
      initResult: {
        availableModels: [
          {
            id: "claude-sonnet-5",
            displayName: "Claude Sonnet 5",
          },
        ],
      },
      close: vi.fn(async () => {}),
    });

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

  it("serves last-known-good rows past the freshness window and revalidates once in the background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T00:00:00.000Z"));
    try {
      mockCreateSession.mockResolvedValueOnce(sessionWithModels(["claude-sonnet-5"]));
      const seeded = await discoverDroidCliModelDescriptors("/mock/bin/droid");
      expect(seeded.map((d) => d.id)).toEqual(["droid/claude-sonnet-5"]);
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      // Generic readiness invalidation ages the cache without dropping rows.
      markDroidModelCachesStale();
      // The background revalidation fails (e.g. droid is mid-reauth), so the
      // aged last-known-good rows must remain the served answer.
      mockCreateSession.mockRejectedValue(new Error("droid session unavailable"));

      // A passive read past the 120s window still returns the cached rows
      // synchronously and kicks off exactly one background SDK session.
      const stale = await discoverDroidCliModelDescriptors("/mock/bin/droid", { mode: "cached-or-fallback" });
      expect(stale.map((d) => d.id)).toEqual(["droid/claude-sonnet-5"]);
      expect(mockCreateSession).toHaveBeenCalledTimes(2);

      // Backoff: a second passive read inside the same freshness window must
      // NOT spawn another session, even though the cache is still aged and the
      // warm just failed — without backoff a broken droid gets a session per call.
      const again = await discoverDroidCliModelDescriptors("/mock/bin/droid", { mode: "cached-or-fallback" });
      expect(again.map((d) => d.id)).toEqual(["droid/claude-sonnet-5"]);
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
