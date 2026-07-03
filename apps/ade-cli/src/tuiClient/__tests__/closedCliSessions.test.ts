import { describe, expect, it } from "vitest";
import type { ChatTerminalSession } from "../../../../desktop/src/shared/types/sessions";
import {
  closedCliRightPaneRow,
  closedCliSessionStatusKind,
  deriveClosedCliSessions,
  deriveOpenDrawerSessions,
} from "../closedCliSessions";

function terminal(overrides: Partial<ChatTerminalSession> = {}): ChatTerminalSession {
  return {
    terminalId: "terminal-1",
    ptyId: null,
    chatSessionId: null,
    laneId: "lane-1",
    laneName: "Lane 1",
    title: "Codex CLI",
    toolType: "codex",
    goal: null,
    status: "completed",
    runtimeState: "exited",
    active: false,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    exitCode: 0,
    pid: null,
    resumeCommand: "codex resume terminal-1",
    resumeMetadata: { provider: "codex", targetKind: "session", targetId: "terminal-1", launch: {} },
    lastOutputPreview: null,
    summary: null,
    ...overrides,
  };
}

describe("closedCliSessions", () => {
  it("preserves failed terminal signals for closed-session status glyphs", () => {
    const [session] = deriveClosedCliSessions([
      terminal({ status: "failed", exitCode: 1, runtimeState: "killed" }),
    ]);

    expect(session).toBeDefined();
    expect(closedCliSessionStatusKind(session!)).toBe("failed");
    expect(closedCliRightPaneRow(session!, null)).toContain("✗");
  });

  it("treats user-initiated closes as idle, not failed", () => {
    const sessions = deriveClosedCliSessions([
      terminal({ terminalId: "t-sigint", status: "disposed", exitCode: 130, runtimeState: "killed" }),
      terminal({ terminalId: "t-sigterm", status: "disposed", exitCode: 143, runtimeState: "killed" }),
      terminal({ terminalId: "t-clean", status: "completed", exitCode: 0, runtimeState: "exited" }),
      terminal({ terminalId: "t-ui-close", status: "disposed", exitCode: null, runtimeState: "killed" }),
    ]);

    for (const session of sessions) {
      expect(closedCliSessionStatusKind(session)).toBe("idle");
    }
  });

  it("flags genuine non-zero exits as failed", () => {
    const [session] = deriveClosedCliSessions([
      terminal({ terminalId: "t-crash", status: "completed", exitCode: 2, runtimeState: "exited" }),
    ]);

    expect(session).toBeDefined();
    expect(closedCliSessionStatusKind(session!)).toBe("failed");
  });

  it("filters closed CLI sessions out of the open drawer list", () => {
    const [closed] = deriveClosedCliSessions([terminal()]);
    const open = {
      sessionId: "chat-1",
      laneId: "lane-1",
      provider: "codex" as const,
      model: "gpt-5.5",
      status: "idle" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-01-01T00:01:00.000Z",
      lastOutputPreview: null,
      summary: null,
    };

    expect(deriveOpenDrawerSessions([open, closed!], [closed!])).toEqual([open]);
  });
});
