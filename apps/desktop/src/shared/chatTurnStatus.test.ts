import { describe, expect, it } from "vitest";
import {
  chatTurnStatusExitCode,
  deriveChatTurnStatus,
  formatChatTurnStatus,
  formatCompactDuration,
} from "./chatTurnStatus";

describe("chat turn status", () => {
  it("maps RUNNING / IDLE / BLOCKED to exit codes 0 / 1 / 2", () => {
    expect(chatTurnStatusExitCode("running")).toBe(0);
    expect(chatTurnStatusExitCode("idle")).toBe(1);
    expect(chatTurnStatusExitCode("blocked")).toBe(2);
  });

  it("formats a running tree with background and files-returned suffixes", () => {
    const status = deriveChatTurnStatus({
      sessionId: "48e654c9",
      provider: "claude",
      sessionStatus: "active",
      currentTurnStartedAt: "2026-05-01T00:00:00.000Z",
      lastActivityAt: "2026-05-01T00:04:04.000Z",
      queuedMessageCount: 1,
      currentTool: { name: "Bash", detail: "npm install --prefix apps/desktop" },
      nowMs: Date.parse("2026-05-01T00:04:12.000Z"),
      subagents: [
        {
          taskId: "root",
          agentId: "root",
          description: "typecheck desktop",
          status: "running",
          background: true,
          durationMs: 124_000,
          startedAt: "2026-05-01T00:02:08.000Z",
        },
        {
          taskId: "child",
          agentId: "child",
          parentAgentId: "root",
          description: "explore chat tests",
          status: "running",
          durationMs: 72_000,
          startedAt: "2026-05-01T00:03:00.000Z",
        },
        {
          taskId: "leaf",
          agentId: "leaf",
          parentAgentId: "child",
          description: "read fixtures",
          status: "completed",
          durationMs: 18_000,
          startedAt: "2026-05-01T00:03:54.000Z",
          resourceLinks: [{ path: "a.ts" }, { path: "a.ts" }, { name: "label-only" }],
        },
      ],
    });
    expect(status.phase).toBe("running");
    const text = formatChatTurnStatus(status);
    expect(text).toContain("● RUNNING");
    expect(text).toContain("turn 4m12s");
    expect(text).toContain("last activity 8s ago");
    expect(text).toContain("tool       Bash · npm install --prefix apps/desktop");
    expect(text).toContain("queued     1 message waiting");
    expect(text).toContain("typecheck desktop");
    expect(text).toContain("└ explore chat tests");
    expect(text).toContain("▸ 1 file returned");
    expect(text).not.toContain("▸ 3 files returned");
    expect(text).toContain("● bg");
  });

  it("marks a blocked Claude permission ask as stranded with no dialog expiry", () => {
    const status = deriveChatTurnStatus({
      sessionId: "blocked-1",
      provider: "claude",
      awaitingInput: true,
      pendingTitle: "Allow Bash?",
      pendingDescription: "Bash(rm -rf build/)",
      currentTurnStartedAt: "2026-05-01T00:00:00.000Z",
      nowMs: Date.parse("2026-05-01T00:15:03.000Z"),
    });
    expect(status.phase).toBe("blocked");
    expect(status.ask?.stranded).toBe(true);
    const text = formatChatTurnStatus(status);
    expect(text).toContain("● BLOCKED");
    expect(text).toContain("Allow Bash?");
    expect(text).not.toContain("awaiting permission");
    expect(text).toContain("stranded — no deadline set (dialogExpiry: never)");
    expect(text).toContain("ask        Bash(rm -rf build/)");
    expect(chatTurnStatusExitCode(status.phase)).toBe(2);
  });

  it("formats idle when no turn is live", () => {
    const status = deriveChatTurnStatus({
      sessionId: "idle-1",
      sessionStatus: "idle",
      lastActivityAt: "2026-05-01T00:00:00.000Z",
      nowMs: Date.parse("2026-05-01T00:12:00.000Z"),
    });
    expect(status.phase).toBe("idle");
    expect(formatChatTurnStatus(status)).toContain("○ IDLE");
    expect(formatChatTurnStatus(status)).toContain("last turn ended 12m00s ago");
    expect(formatCompactDuration(12_000)).toBe("12s");
  });
});
