import { describe, expect, it } from "vitest";
import type { AgentChatSessionSummary, TerminalSessionSummary } from "../../../shared/types";
import { buildLaneAgents } from "./laneAgents";

function chat(overrides: Partial<AgentChatSessionSummary>): AgentChatSessionSummary {
  return {
    sessionId: "c1",
    laneId: "lane-1",
    provider: "claude",
    model: "opus",
    status: "active",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    lastOutputPreview: null,
    summary: null,
    ...overrides,
  } as AgentChatSessionSummary;
}

function cli(overrides: Partial<TerminalSessionSummary>): TerminalSessionSummary {
  return {
    id: "t1",
    laneId: "lane-1",
    laneName: "lane",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "codex",
    title: "Codex CLI",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  } as TerminalSessionSummary;
}

describe("buildLaneAgents", () => {
  it("excludes plain shells", () => {
    const agents = buildLaneAgents(
      [],
      [
        cli({ id: "shell", toolType: "shell" }),
        cli({ id: "codex", toolType: "codex" }),
      ],
    );
    expect(agents.map((a) => a.sessionId)).toEqual(["codex"]);
  });

  it("excludes child terminals spawned by a chat", () => {
    const agents = buildLaneAgents([], [cli({ id: "child", toolType: "codex", chatSessionId: "c1" })]);
    expect(agents).toHaveLength(0);
  });

  it("prefers chat summaries when the same chat session is mirrored through sessions.list", () => {
    const agents = buildLaneAgents(
      [chat({ sessionId: "same-session", title: "Chat row", provider: "codex" })],
      [cli({ id: "same-session", toolType: "codex-chat", title: "Terminal mirror" })],
    );

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      sessionId: "same-session",
      kind: "chat",
      name: "Chat row",
    });
  });

  it("collapses duplicate terminal summaries for the same session", () => {
    const agents = buildLaneAgents(
      [],
      [
        cli({ id: "duplicated", title: "First terminal row" }),
        cli({ id: "duplicated", title: "Second terminal row" }),
      ],
    );

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      sessionId: "duplicated",
      kind: "cli",
      name: "First terminal row",
    });
  });

  it("merges chat + CLI agents and sorts live before ended", () => {
    const agents = buildLaneAgents(
      [
        chat({ sessionId: "ended", status: "ended" }),
        chat({ sessionId: "working", status: "active" }),
      ],
      [cli({ id: "waiting", runtimeState: "waiting-input", attentionRequestedAt: "2026-01-01T00:00:01.000Z" })],
    );
    expect(agents.map((a) => a.sessionId)).toEqual(["working", "waiting", "ended"]);
    expect(agents.find((a) => a.sessionId === "ended")?.activity).toBe("ended");
    expect(agents.find((a) => a.sessionId === "waiting")?.activity).toBe("awaiting-input");
  });

  it("does not infer awaiting input from a CLI runtime marker alone", () => {
    const agents = buildLaneAgents([], [cli({ id: "waiting", runtimeState: "waiting-input" })]);
    expect(agents[0]?.activity).toBe("idle");
    expect(agents[0]?.lastHint).toBeNull();
  });

  it("marks awaiting-input chats with a hint", () => {
    const agents = buildLaneAgents([chat({ sessionId: "c", awaitingInput: true })], []);
    expect(agents[0]?.activity).toBe("awaiting-input");
    expect(agents[0]?.lastHint).toBe("Awaiting your input");
  });
});
