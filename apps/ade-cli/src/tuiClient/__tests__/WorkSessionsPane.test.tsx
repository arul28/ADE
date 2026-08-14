import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { ChatTerminalSession } from "../../../../desktop/src/shared/types/sessions";
import { WorkSessionsPane } from "../components/WorkSessionsPane";
import {
  closedCliRightPaneRow,
  closedCliSessionStatusKind,
  deriveClosedCliSessions,
  deriveOpenWorkSessions,
  terminalSessionToChatSummary,
} from "../closedCliSessions";
import type { TuiChatSessionSummary } from "../adeApi";
import { buildWorkListModel, foreignRowsFromAttention, type WorkListShelfKind } from "../workListModel";
import type { AttentionItem } from "../../../../desktop/src/shared/types/attention";
import { ATTENTION_CONTRACT_VERSION } from "../../../../desktop/src/shared/types/attention";

const NOW = "2026-05-12T12:00:00.000Z";

function stripAnsi(text: string): string {
  return text.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

/** The rendered line a piece of text landed on, for per-row assertions. */
function rowFor(frame: string, needle: string): string {
  return frame.split("\n").find((line) => line.includes(needle)) ?? "";
}

function lane(id: string, name: string, overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id,
    name,
    laneType: "worktree",
    baseRef: "main",
    branchRef: `feature/${id}`,
    worktreePath: `/tmp/${id}`,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function session(
  overrides: Partial<TuiChatSessionSummary> & { sessionId: string; laneId: string },
): TuiChatSessionSummary {
  return {
    provider: "claude",
    model: "claude-code",
    title: "A chat",
    status: "idle",
    startedAt: "2026-05-12T11:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-05-12T11:50:00.000Z",
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
    ...overrides,
  } as TuiChatSessionSummary;
}

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

function paneFrame(args: {
  lanes: LaneSummary[];
  sessions: TuiChatSessionSummary[];
  activeSessionId?: string | null;
  selectedKey?: string | null;
  expandedShelves?: Set<WorkListShelfKind>;
  draftSessionIds?: Set<string>;
  unavailableLaneIds?: Set<string>;
  foreign?: ReturnType<typeof foreignRowsFromAttention>;
  focused?: boolean;
  pickerMode?: boolean;
  width?: number;
}): string {
  const model = buildWorkListModel({
    lanes: args.lanes,
    sessions: args.sessions,
    foreign: args.foreign,
    activeSessionId: args.activeSessionId ?? null,
    draftSessionIds: args.draftSessionIds,
    expandedShelves: args.expandedShelves,
    unavailableLaneIds: args.unavailableLaneIds,
    hideNewChat: args.pickerMode,
  });
  return stripAnsi(render(
    <WorkSessionsPane
      model={model}
      selectedKey={args.selectedKey ?? null}
      panelHeight={40}
      width={args.width ?? 44}
      focused={args.focused ?? true}
      pickerMode={args.pickerMode}
    />,
  ).lastFrame() ?? "");
}

function attentionItem(overrides: Partial<AttentionItem> & { id: string }): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    revision: 1,
    fingerprint: overrides.id,
    kind: "agent",
    eventKind: "agent_running",
    phase: "running",
    machine: { machineKey: "mac-b", name: "Studio", online: true, lastSeenAt: null },
    project: { projectId: "uuid-b", canonicalId: "project_abc", name: "ADE" },
    title: "Remote chat",
    preview: "building",
    privacyPreview: "",
    destination: { kind: "session", sessionId: "remote-1" },
    actions: [],
    occurredAt: "2026-05-12T11:00:00.000Z",
    updatedAt: "2026-05-12T11:55:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...overrides,
  } as AttentionItem;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("closed CLI sessions", () => {
  it("projects durable schedule state onto tracked CLI summaries", () => {
    const summary = terminalSessionToChatSummary(terminal({ terminalId: "cli-scheduled" }), {
      sessionId: "cli-scheduled",
      paused: true,
      nextWakeAt: "2026-07-16T21:00:00.000Z",
      items: [],
    });

    expect(summary).toMatchObject({
      sessionId: "cli-scheduled",
      scheduledWorkPaused: true,
      nextWakeAt: "2026-07-16T21:00:00.000Z",
      scheduledWork: [],
    });
  });

  it("projects spawn lineage from tracked CLI resume metadata", () => {
    const summary = terminalSessionToChatSummary(terminal({
      terminalId: "cli-subagent",
      resumeMetadata: {
        provider: "codex",
        targetKind: "session",
        targetId: "cli-subagent",
        launch: {},
        orchestrationParentSessionId: "parent-chat",
        spawnKind: "subagent",
      },
    }));

    expect(summary).toMatchObject({
      orchestrationParentSessionId: "parent-chat",
      spawnKind: "subagent",
    });
  });

  it("projects native CLI waiting input into the shared attention state", () => {
    const summary = terminalSessionToChatSummary(terminal({
      status: "running",
      runtimeState: "waiting-input",
      endedAt: null,
      exitCode: null,
    }));

    expect(summary.awaitingInput).toBe(true);
    expect(summary.status).toBe("active");
    expect(summary.terminalRuntimeState).toBe("waiting-input");
  });

  it.each([
    ["failed status", { status: "failed", exitCode: 1, runtimeState: "killed" }, "failed"],
    ["non-zero exit", { status: "completed", exitCode: 2, runtimeState: "exited" }, "failed"],
    ["user close", { status: "disposed", exitCode: 130, runtimeState: "killed" }, "idle"],
    ["clean close", { status: "completed", exitCode: 0, runtimeState: "exited" }, "idle"],
  ] as const)("classifies %s for closed-session glyphs", (_label, overrides, expected) => {
    const [closed] = deriveClosedCliSessions([terminal({
      terminalId: `t-${_label.replace(/\s+/g, "-")}`,
      ...overrides,
    })]);

    expect(closed).toBeTruthy();
    expect(closedCliSessionStatusKind(closed!)).toBe(expected);
    expect(closedCliRightPaneRow(closed!, null)).toContain(expected === "failed" ? "✗" : "○");
  });

  it("filters closed CLI sessions out of the open work list", () => {
    const [closed] = deriveClosedCliSessions([terminal()]);
    const open: AgentChatSessionSummary = {
      sessionId: "chat-1",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      status: "idle",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-01-01T00:01:00.000Z",
      lastOutputPreview: null,
      summary: null,
      nextWakeAt: null,
    };

    expect(closed).toBeTruthy();
    expect(deriveOpenWorkSessions([open, closed!], [closed!])).toEqual([open]);
  });
});

describe("WorkSessionsPane cards", () => {
  it("renders a singleton lane as one desktop-shaped card, with no WORK chrome or new-chat row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const frame = paneFrame({
      lanes: [lane("lane-1", "Feature")],
      sessions: [session({
        sessionId: "chat-a",
        laneId: "lane-1",
        title: "Wire the pane",
        status: "active",
        runtimeState: "running",
        toolType: "claude",
        currentTurnStartedAt: "2026-05-12T11:52:00.000Z",
        lastOutputPreview: "[32mtests green[0m",
      })],
      activeSessionId: "chat-a",
    });

    expect(frame).not.toContain("WORK");
    expect(frame).not.toContain("+ new chat");
    // line 1: lane name �� glyph, then Working, then elapsed (desktop order)
    const where = rowFor(frame, "Feature");
    expect(where).toContain("Working");
    expect(where).toContain("8m");
    const glyphAt = where.indexOf("\u25D0");
    expect(glyphAt).toBeGreaterThanOrEqual(0);
    expect(glyphAt).toBeLessThan(where.indexOf("Working"));
    expect(where.indexOf("Working")).toBeLessThan(where.indexOf("8m"));
    expect(where).toContain("\u25DD");
    // line 2: title, no status word
    expect(rowFor(frame, "Wire the pane")).not.toContain("Working");
    // line 3: preview, no provider mark
    expect(frame).toContain("tests green");
    expect(frame).not.toContain("✻");
  });

  it("keeps a lane header when the lane has more than one live chat", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const frame = paneFrame({
      lanes: [lane("lane-1", "Feature", { color: "#dc2626", icon: "star" })],
      sessions: [
        session({ sessionId: "chat-a", laneId: "lane-1", title: "Alpha", lastActivityAt: "2026-05-12T11:50:00.000Z" }),
        session({ sessionId: "chat-b", laneId: "lane-1", title: "Beta", lastActivityAt: "2026-05-12T11:40:00.000Z" }),
      ],
    });

    expect(rowFor(frame, "Feature")).toContain("★");
    expect(rowFor(frame, "Feature")).toContain("─");
    expect(rowFor(frame, "Feature")).not.toContain("Working");
    const lines = frame.split("\n");
    const titleIndex = lines.findIndex((line) => line.includes("Alpha"));
    expect(titleIndex).toBeGreaterThan(0);
    expect(lines[titleIndex - 1]).toMatch(/\d+m|now/);
    expect(lines[titleIndex]).toContain("Alpha");
    expect(lines[titleIndex]).not.toMatch(/\d+m|now/);
    const betaIndex = lines.findIndex((line) => line.includes("Beta"));
    // 3-line card + 1 blank between chats: titles are 4 lines apart.
    expect(betaIndex - titleIndex).toBeGreaterThanOrEqual(4);
  });

  it("shows the draft pencil only for chats holding an unsent composer draft", () => {
    const sessions = [
      session({ sessionId: "chat-draft", laneId: "lane-1", title: "Has draft" }),
      session({ sessionId: "chat-clean", laneId: "lane-1", title: "No draft" }),
    ];
    const frame = paneFrame({
      lanes: [lane("lane-1", "Feature")],
      sessions,
      draftSessionIds: new Set(["chat-draft"]),
    });

    const lines = frame.split("\n");
    const draftIndex = lines.findIndex((line) => line.includes("Has draft"));
    const cleanIndex = lines.findIndex((line) => line.includes("No draft"));
    // The pencil rides line 3 of its own card.
    expect(lines.slice(draftIndex, draftIndex + 3).join("\n")).toContain("✎");
    expect(lines.slice(cleanIndex, cleanIndex + 3).join("\n")).not.toContain("✎");
  });

  it("marks the open chat and drops the new-chat row for a missing worktree", () => {
    const withChat = paneFrame({
      lanes: [lane("lane-1", "Feature")],
      sessions: [session({ sessionId: "chat-a", laneId: "lane-1", title: "Open one" })],
      activeSessionId: "chat-a",
    });
    const openLines = withChat.split("\n");
    const titleIndex = openLines.findIndex((line) => line.includes("Open one"));
    expect(openLines.slice(Math.max(0, titleIndex - 1), titleIndex + 1).join("\n")).toContain("◝");

    const missing = paneFrame({
      lanes: [lane("lane-1", "Feature")],
      sessions: [],
      unavailableLaneIds: new Set(["lane-1"]),
    });
    expect(missing).not.toContain("+ new chat");
    expect(missing).toContain("no worktree");
  });

  it("hints at its own keys when focused, and picker copy in add mode", () => {
    const normal = paneFrame({ lanes: [lane("lane-1", "Feature")], sessions: [] });
    expect(normal).toContain("↑↓ move");
    expect(normal).toContain("↵ open");
    expect(normal).toContain("esc chat");
    // The drawer's lanes/chats mode switching is gone: no Tab hint survives.
    expect(normal).not.toContain("tab section");

    const picker = paneFrame({
      lanes: [lane("lane-1", "Feature")],
      sessions: [session({ sessionId: "chat-a", laneId: "lane-1" })],
      pickerMode: true,
    });
    expect(picker).toContain("PICK CHAT");
    expect(picker).toContain("↵ add");
    expect(picker).not.toContain("+ new chat");
  });
});

describe("WorkSessionsPane quiet shelves", () => {
  const lanes = [lane("lane-1", "Feature")];
  const sessions = [
    session({ sessionId: "chat-live", laneId: "lane-1", title: "Live chat" }),
    session({
      sessionId: "chat-snoozed",
      laneId: "lane-1",
      title: "Snoozed chat",
      snoozedUntil: "2026-05-12T15:00:00.000Z",
      snoozedAt: "2026-05-12T11:59:00.000Z",
    }),
    session({
      sessionId: "chat-settled",
      laneId: "lane-1",
      title: "Settled chat",
      settledAt: "2026-05-12T11:30:00.000Z",
    }),
  ];

  it("collapses quiet rows into shelves at the bottom", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const frame = paneFrame({ lanes, sessions });
    expect(frame).toContain("▸ snoozed (1)");
    expect(frame).toContain("▸ settled (1)");
    expect(frame).not.toContain("Snoozed chat");
    expect(frame).toContain("Live chat");
  });

  it("expands a shelf in place and keeps every state readable with no color at all", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const frame = paneFrame({
      lanes,
      sessions: [
        ...sessions,
        session({
          sessionId: "chat-woke",
          laneId: "lane-1",
          title: "Woken chat",
          wokeAt: "2026-05-12T11:58:00.000Z",
          wokeReason: "needs_you",
        }),
      ],
      expandedShelves: new Set<WorkListShelfKind>(["snoozed", "settled"]),
    });

    expect(frame).toContain("▾ snoozed (1)");
    // Status words sit on line 1 with the timestamp; markers stay on line 3.
    const lines = frame.split("\n");
    const snoozedIndex = lines.findIndex((line) => line.includes("Snoozed chat"));
    expect(lines[snoozedIndex - 1]).toContain("wakes in 3h");
    const wokenIndex = lines.findIndex((line) => line.includes("Woken chat"));
    expect(lines[wokenIndex - 1]).toContain("Woke");
    expect(lines.slice(snoozedIndex, snoozedIndex + 3).join("\n")).toContain(" z");
    const settledIndex = lines.findIndex((line) => line.includes("Settled chat"));
    expect(lines.slice(settledIndex, settledIndex + 3).join("\n")).toContain("done");
    expect(frame).not.toContain("");
  });
});

describe("WorkSessionsPane cross-machine rows", () => {
  it("chips the machine on a foreign row and groups unmatched lanes under the machine", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const frame = paneFrame({
      lanes: [lane("lane-1", "Feature")],
      sessions: [session({ sessionId: "chat-a", laneId: "lane-1", title: "Local chat" })],
      foreign: foreignRowsFromAttention({
        items: [
          attentionItem({
            id: "matched",
            laneName: "Feature",
            title: "Remote in Feature",
            destination: { kind: "session", sessionId: "remote-matched" },
          }),
          attentionItem({
            id: "orphan",
            laneName: "Other lane",
            title: "Remote elsewhere",
            phase: "needs_you",
            machine: { machineKey: "mac-c", name: "Desk", online: false, lastSeenAt: "2026-05-12T10:00:00.000Z" },
            destination: { kind: "session", sessionId: "remote-orphan" },
          }),
        ],
        projectCanonicalId: "project_abc",
        localSessionIds: new Set(["chat-a"]),
      }),
    });

    expect(rowFor(frame, "Remote in Feature")).toBeTruthy();
    const lines = frame.split("\n");
    const matchedIndex = lines.findIndex((line) => line.includes("Remote in Feature"));
    expect(lines.slice(matchedIndex, matchedIndex + 3).join("\n")).toContain("⧉ Studio");
    expect(frame).toContain("⧉ Desk");
    expect(frame).toContain("last seen");
    // A local row never wears a machine chip.
    const localIndex = lines.findIndex((line) => line.includes("Local chat"));
    expect(lines.slice(localIndex, localIndex + 3).join("\n")).not.toContain("⧉");
  });
});
