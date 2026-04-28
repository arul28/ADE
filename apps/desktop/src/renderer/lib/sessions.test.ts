import { describe, expect, it } from "vitest";
import { isChatToolType, shortToolTypeLabel } from "./sessions";

describe("isChatToolType", () => {
  it("returns false for null, undefined, or empty input", () => {
    expect(isChatToolType(null)).toBe(false);
    expect(isChatToolType(undefined)).toBe(false);
    expect(isChatToolType("")).toBe(false);
    expect(isChatToolType("   ")).toBe(false);
  });

  it("recognizes the canonical chat tool types", () => {
    expect(isChatToolType("codex-chat")).toBe(true);
    expect(isChatToolType("claude-chat")).toBe(true);
    expect(isChatToolType("opencode-chat")).toBe(true);
    expect(isChatToolType("cursor")).toBe(true);
  });

  it("matches any tool type ending in -chat", () => {
    expect(isChatToolType("custom-chat")).toBe(true);
    expect(isChatToolType("aider-chat")).toBe(true);
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(isChatToolType("Claude-Chat")).toBe(true);
    expect(isChatToolType("  CODEX-CHAT  ")).toBe(true);
    expect(isChatToolType("\tCursor\n")).toBe(true);
  });

  it("returns false for orchestrated sessions and non-chat tool types", () => {
    expect(isChatToolType("claude-orchestrated")).toBe(false);
    expect(isChatToolType("codex-orchestrated")).toBe(false);
    expect(isChatToolType("opencode-orchestrated")).toBe(false);
    expect(isChatToolType("shell")).toBe(false);
    expect(isChatToolType("run-shell")).toBe(false);
    expect(isChatToolType("claude")).toBe(false);
    expect(isChatToolType("codex")).toBe(false);
  });
});

describe("shortToolTypeLabel", () => {
  it('returns "Shell" for null, undefined, or "shell"', () => {
    expect(shortToolTypeLabel(null)).toBe("Shell");
    expect(shortToolTypeLabel(undefined)).toBe("Shell");
    expect(shortToolTypeLabel("shell")).toBe("Shell");
  });

  it('returns "Run" for run-shell', () => {
    expect(shortToolTypeLabel("run-shell")).toBe("Run");
  });

  it('returns "Claude" for any claude-prefixed tool type', () => {
    expect(shortToolTypeLabel("claude")).toBe("Claude");
    expect(shortToolTypeLabel("claude-chat")).toBe("Claude");
    expect(shortToolTypeLabel("claude-orchestrated")).toBe("Claude");
  });

  it('returns "Codex" for any codex-prefixed tool type', () => {
    expect(shortToolTypeLabel("codex")).toBe("Codex");
    expect(shortToolTypeLabel("codex-chat")).toBe("Codex");
    expect(shortToolTypeLabel("codex-orchestrated")).toBe("Codex");
  });

  it('returns "OpenCode" for any opencode-prefixed tool type', () => {
    expect(shortToolTypeLabel("opencode")).toBe("OpenCode");
    expect(shortToolTypeLabel("opencode-chat")).toBe("OpenCode");
    expect(shortToolTypeLabel("opencode-orchestrated")).toBe("OpenCode");
  });

  it("returns exact labels for known single-name tools", () => {
    expect(shortToolTypeLabel("cursor")).toBe("Cursor");
    expect(shortToolTypeLabel("aider")).toBe("Aider");
    expect(shortToolTypeLabel("continue")).toBe("Continue");
  });

  it("replaces hyphens with spaces for unknown tool types", () => {
    expect(shortToolTypeLabel("my-custom-tool")).toBe("my custom tool");
  });
});
