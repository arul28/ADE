import { describe, expect, it } from "vitest";
import { shortToolTypeLabel } from "./sessions";

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
