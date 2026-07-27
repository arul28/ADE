import { describe, expect, it } from "vitest";
import type { TerminalSessionSummary } from "../../shared/types";
import {
  canBulkDeleteSession,
  canBulkStopSession,
  getStaleRunningCliSessionAgeHours,
  isChatToolType,
  normalizeSessionLabel,
  preferredSessionLabel,
  shortToolTypeLabel,
} from "./sessions";

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
    expect(isChatToolType("claude")).toBe(false);
    expect(isChatToolType("codex")).toBe(false);
    expect(isChatToolType("cursor-cli")).toBe(false);
    expect(isChatToolType("droid")).toBe(false);
    expect(isChatToolType("opencode")).toBe(false);
  });
});

describe("shortToolTypeLabel", () => {
  it('returns "Shell" for null, undefined, or "shell"', () => {
    expect(shortToolTypeLabel(null)).toBe("Shell");
    expect(shortToolTypeLabel(undefined)).toBe("Shell");
    expect(shortToolTypeLabel("shell")).toBe("Shell");
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
    expect(shortToolTypeLabel("cursor-cli")).toBe("Cursor");
    expect(shortToolTypeLabel("droid")).toBe("Droid");
    expect(shortToolTypeLabel("aider")).toBe("Aider");
    expect(shortToolTypeLabel("continue")).toBe("Continue");
  });

  it("replaces hyphens with spaces for unknown tool types", () => {
    expect(shortToolTypeLabel("my-custom-tool")).toBe("my custom tool");
  });
});

describe("bulk session actions", () => {
  it("treats running chats as deletable and running terminals as stoppable", () => {
    expect(canBulkDeleteSession({ status: "running", toolType: "codex-chat" })).toBe(true);
    expect(canBulkStopSession({ status: "running", toolType: "codex-chat" })).toBe(false);

    expect(canBulkDeleteSession({ status: "running", toolType: "shell" })).toBe(false);
    expect(canBulkStopSession({ status: "running", toolType: "shell" })).toBe(true);

    expect(canBulkDeleteSession({ status: "completed", toolType: "shell" })).toBe(true);
    expect(canBulkStopSession({ status: "completed", toolType: "shell" })).toBe(false);
  });
});

describe("session labels", () => {
  it("removes terminal controls before normalizing labels", () => {
    expect(normalizeSessionLabel("\u001b7Claude Code\u001b8 ready")).toBe("Claude Code ready");
    expect(preferredSessionLabel("Ran task \u001b[31mfailed\u001b[0m")).toBe("Ran task failed");
  });

  it("removes Claude fullscreen chrome from persisted terminal summaries", () => {
    const label = "Ran Say exactly: patched exit works (FAIL, exit code 143, \u001b7\u001b8╭───Claude Codev2.1.141────)";
    expect(normalizeSessionLabel(label)).toBe("Ran Say exactly: patched exit works (STOPPED, exit code 143)");
  });
});

describe("getStaleRunningCliSessionAgeHours", () => {
  const HOUR = 60 * 60 * 1_000;
  const NOW = Date.parse("2026-06-06T00:00:00.000Z");

  const session = (overrides: Partial<TerminalSessionSummary>): TerminalSessionSummary =>
    ({
      status: "running",
      toolType: "shell",
      startedAt: new Date(NOW - 100 * HOUR).toISOString(),
      lastActivityAt: null,
      ...overrides,
    }) as TerminalSessionSummary;

  it("flags a non-chat session whose last activity is 24h+ ago", () => {
    const result = getStaleRunningCliSessionAgeHours(
      session({ lastActivityAt: new Date(NOW - 30 * HOUR).toISOString() }),
      NOW,
    );
    expect(result).toBe(30);
  });

  it("does NOT flag an old session that is still actively producing output", () => {
    // Started 100h ago, but produced output 2h ago — not stale.
    const result = getStaleRunningCliSessionAgeHours(
      session({ lastActivityAt: new Date(NOW - 2 * HOUR).toISOString() }),
      NOW,
    );
    expect(result).toBeNull();
  });

  it("uses a 24h threshold (23h idle is not yet stale)", () => {
    expect(
      getStaleRunningCliSessionAgeHours(
        session({ lastActivityAt: new Date(NOW - 23 * HOUR).toISOString() }),
        NOW,
      ),
    ).toBeNull();
    expect(
      getStaleRunningCliSessionAgeHours(
        session({ lastActivityAt: new Date(NOW - 25 * HOUR).toISOString() }),
        NOW,
      ),
    ).toBe(25);
  });

  it("falls back to startedAt when there is no activity timestamp yet", () => {
    const result = getStaleRunningCliSessionAgeHours(
      session({ startedAt: new Date(NOW - 40 * HOUR).toISOString(), lastActivityAt: null }),
      NOW,
    );
    expect(result).toBe(40);
  });

  it("never flags chat, run-owned, or non-running sessions", () => {
    const idle = new Date(NOW - 50 * HOUR).toISOString();
    expect(getStaleRunningCliSessionAgeHours(session({ toolType: "claude-chat", lastActivityAt: idle }), NOW)).toBeNull();
    expect(getStaleRunningCliSessionAgeHours(session({ status: "detached", lastActivityAt: idle }), NOW)).toBeNull();
  });
});
