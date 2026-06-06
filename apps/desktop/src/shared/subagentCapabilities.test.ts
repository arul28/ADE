import { describe, expect, it } from "vitest";
import {
  NO_SUBAGENT_CAPABILITY,
  resolveSubagentCapability,
  SUBAGENT_CAPABILITIES,
} from "./subagentCapabilities";

describe("resolveSubagentCapability", () => {
  it("resolves each known runtime by provider", () => {
    expect(resolveSubagentCapability("codex")).toBe(SUBAGENT_CAPABILITIES.codex);
    expect(resolveSubagentCapability("claude")).toBe(SUBAGENT_CAPABILITIES.claude);
    expect(resolveSubagentCapability("opencode")).toBe(SUBAGENT_CAPABILITIES.opencode);
    expect(resolveSubagentCapability("cursor")).toBe(SUBAGENT_CAPABILITIES.cursor);
    expect(resolveSubagentCapability("droid")).toBe(SUBAGENT_CAPABILITIES.droid);
  });

  it("prefers the live runtime kind over the persisted provider", () => {
    // Opened-from-history Codex session whose runtime is momentarily 'cursor'
    // (contrived): the live runtime kind wins.
    expect(resolveSubagentCapability("codex", "cursor")).toBe(SUBAGENT_CAPABILITIES.cursor);
    // Idle session (no runtime) falls back to the provider.
    expect(resolveSubagentCapability("codex", null)).toBe(SUBAGENT_CAPABILITIES.codex);
  });

  it("returns the no-op descriptor for unknown / null runtimes (lmstudio, none)", () => {
    expect(resolveSubagentCapability(null)).toBe(NO_SUBAGENT_CAPABILITY);
    expect(resolveSubagentCapability(undefined)).toBe(NO_SUBAGENT_CAPABILITY);
    expect(resolveSubagentCapability("lmstudio")).toBe(NO_SUBAGENT_CAPABILITY);
    expect(resolveSubagentCapability("some-future-provider")).toBe(NO_SUBAGENT_CAPABILITY);
  });

  it("encodes the transcript-takeover matrix: only codex/claude/opencode can take over", () => {
    expect(SUBAGENT_CAPABILITIES.codex.canViewFullTranscript).toBe(true);
    expect(SUBAGENT_CAPABILITIES.claude.canViewFullTranscript).toBe(true);
    expect(SUBAGENT_CAPABILITIES.opencode.canViewFullTranscript).toBe(true);
    // Cursor + Droid list subagents but expose no child transcript → drawer only.
    expect(SUBAGENT_CAPABILITIES.cursor.canViewFullTranscript).toBe(false);
    expect(SUBAGENT_CAPABILITIES.cursor.canList).toBe(true);
    expect(SUBAGENT_CAPABILITIES.droid.canViewFullTranscript).toBe(false);
    expect(SUBAGENT_CAPABILITIES.droid.canList).toBe(true);
  });

  it("only codex advertises rich per-agent metadata (immediate takeover for running agents)", () => {
    expect(SUBAGENT_CAPABILITIES.codex.hasRichMetadata).toBe(true);
    expect(SUBAGENT_CAPABILITIES.claude.hasRichMetadata).toBe(false);
    expect(SUBAGENT_CAPABILITIES.opencode.hasRichMetadata).toBe(false);
  });
});
