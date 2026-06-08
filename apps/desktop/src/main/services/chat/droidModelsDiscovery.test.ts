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
  parseDroidExecHelpModelIds,
  parseDroidExecHelpModels,
} from "./droidModelsDiscovery";

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
      "  custom:claude-sonnet-4-6-thinking-32000   Claude Sonnet 4.6 (High)",
      "  custom:gpt-5.4(xhigh)                     GPT-5.4 (XHigh)",
      "",
      "Model details:",
    ].join("\n");

    expect(parseDroidExecHelpModels(raw)).toEqual([
      {
        id: "custom:claude-sonnet-4-6-thinking-32000",
        displayName: "Claude Sonnet 4.6 (High)",
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
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
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
      "droid/claude-sonnet-4-6",
      "droid/custom:gpt-5.4(xhigh)",
    ]);
    expect(descriptors[1]).toMatchObject({
      displayName: "GPT-5.4 (XHigh)",
      customProxy: true,
    });
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
            model: "claude-sonnet-4-6-thinking-32000",
            model_display_name: "Claude Sonnet 4.6 (High)",
          },
        ],
      }),
      "utf8",
    );
    mockCreateSession.mockResolvedValueOnce({
      initResult: {
        availableModels: [
          {
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
          },
        ],
      },
      close: vi.fn(async () => {}),
    });

    const descriptors = await discoverDroidCliModelDescriptors("/mock/bin/droid");

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "droid/claude-sonnet-4-6",
      "droid/custom:claude-sonnet-4-6-thinking-32000",
    ]);
    expect(descriptors[1]).toMatchObject({
      displayName: "Claude Sonnet 4.6 (High)",
      customProxy: true,
    });
  });
});
