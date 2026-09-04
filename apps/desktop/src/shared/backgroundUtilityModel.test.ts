import { describe, expect, it } from "vitest";
import {
  adeBackgroundUtilityProvider,
  adeBackgroundUtilityProviderFromToolType,
  BACKGROUND_UTILITY_CLAUDE_MODEL_ID,
  BACKGROUND_UTILITY_CODEX_MODEL_ID,
  BACKGROUND_UTILITY_CODEX_REASONING_EFFORT,
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

  it("pins Codex Luna to low reasoning and leaves other cheap models unset", () => {
    expect(backgroundUtilityReasoningEffort(BACKGROUND_UTILITY_CODEX_MODEL_ID))
      .toBe(BACKGROUND_UTILITY_CODEX_REASONING_EFFORT);
    expect(backgroundUtilityReasoningEffort(BACKGROUND_UTILITY_CLAUDE_MODEL_ID)).toBeNull();
    expect(backgroundUtilityReasoningEffort(BACKGROUND_UTILITY_CURSOR_MODEL_ID)).toBeNull();
  });
});
