import { describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { deleteTerminalSessionWithRuntimeCleanup } from "./deleteTerminalSession";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "./sessionService";

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "Primary",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "shell",
    title: "Shell",
    status: "completed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:01:00.000Z",
    exitCode: 0,
    transcriptPath: "/tmp/transcript",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "exited",
    resumeCommand: null,
    ...overrides,
  };
}

function makeServices(session: TerminalSessionSummary | null) {
  const deleteSession = vi.fn().mockReturnValue(true);
  const sessionService = {
    get: vi.fn().mockReturnValue(session),
    deleteSession,
  } as unknown as ReturnType<typeof createSessionService>;
  const ptyService = {
    enrichSessions: vi.fn((sessions: TerminalSessionSummary[]) => sessions),
    isSessionOwnedByLivePeerRuntime: vi.fn().mockReturnValue(false),
    dispose: vi.fn(),
  } as unknown as ReturnType<typeof createPtyService>;
  return { deleteSession, ptyService, sessionService };
}

describe("deleteTerminalSessionWithRuntimeCleanup", () => {
  it("deletes a session this runtime owns", () => {
    const { deleteSession, ptyService, sessionService } = makeServices(makeSession());

    expect(deleteTerminalSessionWithRuntimeCleanup({
      sessionId: "session-1",
      sessionService,
      ptyService,
    })).toBe(true);
    expect(deleteSession).toHaveBeenCalledWith("session-1");
  });

  it("treats a session this runtime does not have as already deleted", () => {
    // Delete is idempotent: the goal state is "not here", and it already holds.
    // Throwing surfaced a red "Delete failed" banner over a list that was
    // correct — the renderer routinely asks a runtime to delete a row that
    // never persisted there, or that another window already removed.
    const { deleteSession, ptyService, sessionService } = makeServices(null);

    expect(deleteTerminalSessionWithRuntimeCleanup({
      sessionId: "missing-session",
      sessionService,
      ptyService,
    })).toBe(false);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("still rejects an empty session id", () => {
    const { ptyService, sessionService } = makeServices(makeSession());

    expect(() => deleteTerminalSessionWithRuntimeCleanup({
      sessionId: "   ",
      sessionService,
      ptyService,
    })).toThrow("Session id is required.");
  });

  it("still refuses a chat session", () => {
    const { ptyService, sessionService } = makeServices(makeSession({ toolType: "codex-chat" }));

    expect(() => deleteTerminalSessionWithRuntimeCleanup({
      sessionId: "session-1",
      sessionService,
      ptyService,
    })).toThrow("Use the chat delete flow instead.");
  });
});
