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
  it("keeps a resting agent live while its background work is", () => {
    // The Lanes agent list read "idle" for the whole of a background fleet's
    // run, because the turn had ended and nothing downstream looked at what the
    // session still owned.
    const [working, monitoring, quiet] = buildLaneAgents(
      [
        chat({
          sessionId: "c-working",
          status: "idle",
          lastOutputPreview: "Turn finished",
          activeBackgroundTaskCount: 2,
          backgroundWork: { workingCount: 1, monitoringCount: 1 },
        }),
        chat({
          sessionId: "c-monitoring",
          status: "idle",
          lastOutputPreview: "Turn finished",
          activeBackgroundTaskCount: 1,
          backgroundWork: { workingCount: 0, monitoringCount: 1 },
        }),
        chat({ sessionId: "c-quiet", status: "idle", lastOutputPreview: "Turn finished" }),
      ],
      [],
    );

    // Live rows sort ahead of the genuinely idle one, working ahead of watching.
    expect(working.sessionId).toBe("c-working");
    expect(working.activity).toBe("working");
    expect(monitoring.sessionId).toBe("c-monitoring");
    expect(monitoring.activity).toBe("monitoring");
    expect(quiet.activity).toBe("idle");

    // The hint reports what is still running rather than the finished turn's
    // stale preview.
    expect(working.lastHint).toBe("2 background jobs still running");
    expect(monitoring.lastHint).toBe("1 monitor still running");
    expect(quiet.lastHint).toBe("Turn finished");
  });

  it("counts a split-less CLI summary as working, and never over a live turn", () => {
    // An older peer or a remote runtime mid-upgrade sends only the total. It
    // must not be assumed passive, and a live turn's own output still wins.
    const [resting] = buildLaneAgents([], [
      cli({ id: "t-resting", runtimeState: "waiting-input", activeBackgroundTaskCount: 3 }),
    ]);
    expect(resting.activity).toBe("working");
    expect(resting.lastHint).toBe("3 background jobs still running");

    const [live] = buildLaneAgents([], [
      cli({ id: "t-live", runtimeState: "running", lastOutputPreview: "compiling", activeBackgroundTaskCount: 3 }),
    ]);
    expect(live.activity).toBe("working");
    expect(live.lastHint).toBe("compiling");
  });

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

  it("marks provider-structured CLI attention as awaiting input", () => {
    const agents = buildLaneAgents([], [cli({
      id: "provider-waiting",
      runtimeState: "waiting-input",
      attentionSource: "provider_structured",
    })]);
    expect(agents[0]?.activity).toBe("awaiting-input");
    expect(agents[0]?.lastHint).toBe("Awaiting your input");
  });

  it("marks awaiting-input chats with a hint", () => {
    const agents = buildLaneAgents([chat({ sessionId: "c", awaitingInput: true })], []);
    expect(agents[0]?.activity).toBe("awaiting-input");
    expect(agents[0]?.lastHint).toBe("Awaiting your input");
  });
});
