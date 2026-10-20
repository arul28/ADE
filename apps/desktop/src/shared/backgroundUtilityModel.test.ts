import { describe, expect, it } from "vitest";
import {
  adeBackgroundUtilityProvider,
  adeBackgroundUtilityProviderFromToolType,
  BACKGROUND_UTILITY_CLAUDE_MODEL_ID,
  BACKGROUND_UTILITY_CODEX_MODEL_ID,
  BACKGROUND_UTILITY_CURSOR_MODEL_ID,
  backgroundUtilityModelId,
  backgroundUtilityReasoningEffort,
} from "./backgroundUtilityModel";

describe("backgroundUtilityModel", () => {
  it("keys cheap models off the ADE provider, not a registry family", () => {
    expect(adeBackgroundUtilityProvider("claude")).toBe("claude");
    expect(adeBackgroundUtilityProvider("codex")).toBe("codex");
    expect(adeBackgroundUtilityProvider("cursor")).toBe("cursor");
    expect(adeBackgroundUtilityProvider("opencode")).toBeNull();
    expect(adeBackgroundUtilityProvider("droid")).toBeNull();
    expect(adeBackgroundUtilityProvider("pi")).toBeNull();
    expect(backgroundUtilityModelId("claude")).toBe(BACKGROUND_UTILITY_CLAUDE_MODEL_ID);
    expect(backgroundUtilityModelId("codex")).toBe(BACKGROUND_UTILITY_CODEX_MODEL_ID);
    expect(backgroundUtilityModelId("cursor")).toBe(BACKGROUND_UTILITY_CURSOR_MODEL_ID);
  });

  it("maps tracked CLI and ADE-chat tool types onto the same ADE providers", () => {
    expect(adeBackgroundUtilityProviderFromToolType("claude-chat")).toBe("claude");
    expect(adeBackgroundUtilityProviderFromToolType("codex")).toBe("codex");
    expect(adeBackgroundUtilityProviderFromToolType("cursor-cli")).toBe("cursor");
    expect(adeBackgroundUtilityProviderFromToolType("opencode-chat")).toBeNull();
    expect(adeBackgroundUtilityProviderFromToolType("shell")).toBeNull();
  });

  it.each([
    ["Haiku and Luna list low first", ["low", "medium", "high", "xhigh", "max"], "low"],
    ["a model that can switch thinking off", ["none", "minimal", "low", "medium", "high"], "none"],
    ["a Pi model, whose lowest level is off", ["off", "minimal", "low", "medium"], "off"],
    ["OpenCode variants out of order, with non-effort keys", ["xhigh", "free", "medium", "budget"], "medium"],
    ["Composer, which lists no tiers", undefined, null],
    ["a model whose variants are not efforts", ["free", "budget"], null],
  ])("runs background calls at the model's lowest tier: %s", (_label, reasoningTiers, expected) => {
    expect(backgroundUtilityReasoningEffort({ reasoningTiers })).toBe(expected);
  });
});
