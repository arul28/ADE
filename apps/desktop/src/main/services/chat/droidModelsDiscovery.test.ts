import { describe, expect, it } from "vitest";
import { parseDroidExecHelpModelIds, parseDroidExecHelpModels } from "./droidModelsDiscovery";

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
