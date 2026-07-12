import { describe, it, expect } from "vitest";
import { providerDisplayLabel, providerDisplayName, pendingInputHeaderLabel } from "./pendingInputLabels";

describe("providerDisplayName", () => {
  it("maps known runtime sources to branded names", () => {
    expect(providerDisplayName("claude")).toBe("Claude");
    expect(providerDisplayName("anthropic")).toBe("Claude");
    expect(providerDisplayName("codex")).toBe("Codex");
    expect(providerDisplayName("openai")).toBe("Codex");
    expect(providerDisplayName("cursor")).toBe("Cursor");
    expect(providerDisplayName("droid")).toBe("Droid");
    expect(providerDisplayName("factory")).toBe("Droid");
    expect(providerDisplayName("opencode")).toBe("OpenCode");
  });

  it("is case-insensitive and trims", () => {
    expect(providerDisplayName("  Claude  ")).toBe("Claude");
    expect(providerDisplayName("CURSOR")).toBe("Cursor");
  });

  it("title-cases unknown sources and falls back to Agent for empty", () => {
    expect(providerDisplayName("mistral")).toBe("Mistral");
    expect(providerDisplayName("my_provider-runtime")).toBe("My Provider Runtime");
    expect(providerDisplayName("")).toBe("Agent");
    expect(providerDisplayName(null)).toBe("Agent");
    expect(providerDisplayName(undefined)).toBe("Agent");
  });
});

describe("providerDisplayLabel", () => {
  it("uses canonical chat provider names and a caller-owned empty fallback", () => {
    expect(["claude", "codex", "cursor", "droid", "opencode"].map((provider) =>
      providerDisplayLabel(provider, "fallback")
    )).toEqual(["Claude", "Codex", "Cursor", "Droid", "OpenCode"]);
    expect(providerDisplayLabel("custom-runtime", "fallback")).toBe("Custom Runtime");
    expect(providerDisplayLabel(null, "This chat")).toBe("This chat");
  });
});

describe("pendingInputHeaderLabel", () => {
  it("reads '{Provider} asks' for question kinds", () => {
    expect(pendingInputHeaderLabel("claude", "question")).toBe("Claude asks");
    expect(pendingInputHeaderLabel("codex", "structured_question")).toBe("Codex asks");
  });

  it("reads '{Provider} · Plan ready' for plan approvals", () => {
    expect(pendingInputHeaderLabel("claude", "plan_approval")).toBe("Claude · Plan ready");
    expect(pendingInputHeaderLabel("cursor", "plan_approval")).toBe("Cursor · Plan ready");
  });

  it("covers the remaining kinds", () => {
    expect(pendingInputHeaderLabel("droid", "permissions")).toBe("Droid · Permission");
    expect(pendingInputHeaderLabel("opencode", "approval")).toBe("OpenCode · Approval");
    expect(pendingInputHeaderLabel("codex", "model_selection")).toBe("Codex · Pick a model");
  });

  it("never repeats the source twice (the old double-labelling)", () => {
    const label = pendingInputHeaderLabel("claude", "question");
    expect(label.toLowerCase().split("claude").length - 1).toBe(1);
  });
});
