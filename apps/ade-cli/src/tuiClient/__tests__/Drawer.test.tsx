import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import { Drawer } from "../components/Drawer";

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function lane(id: string, name: string, branchRef: string, createdAt: string, ahead = 0, behind = 0, laneType: LaneSummary["laneType"] = "worktree", overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id,
    name,
    laneType,
    baseRef: "main",
    branchRef,
    worktreePath: `/tmp/${id}`,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: ahead > 0 || behind > 0,
      ahead,
      behind,
      remoteBehind: 0,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    createdAt,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Drawer diff stats", () => {
  it("renders every lane's diff stats inline (not just the selected one) and shows no timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));

    const lanes = [
      lane("lane-1", "TUI", "feat", "2026-05-12T11:55:00.000Z", 99, 88),
      lane("lane-2", "Drawer", "draw", "2026-05-12T11:57:00.000Z", 42, 24),
    ];
    const diffByLaneId = {
      "lane-1": { additions: 64, deletions: 18, files: 5 },
      "lane-2": { additions: 428, deletions: 112, files: 6 },
    };

    const frame = stripAnsi(render(
      <Drawer
        lanes={lanes}
        sessions={[]}
        activeLaneId="lane-1"
        activeSessionId={null}
        browsingLaneId="lane-1"
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={30}
        diffByLaneId={diffByLaneId}
      />,
    ).lastFrame() ?? "");

    // The diff is shown on every lane card, selected or not — it replaced the
    // green "run" chip and refreshes in place.
    expect(frame).toContain("+64");
    expect(frame).toContain("−18");
    expect(frame).toContain("+428");
    expect(frame).toContain("−112");
    // ahead/behind line stats are not surfaced, and the lane card no longer
    // carries a "Xm" age timestamp.
    expect(frame).not.toContain("+141 / −112");
    expect(frame).not.toContain("-18");
    expect(frame).not.toContain("5m");
  });
});

describe("Drawer lane and chat navigation layout", () => {
  it("puts the primary lane first and removes old header/footer controls", () => {
    const frame = stripAnsi(render(
      <Drawer
        lanes={[
          lane("lane-2", "Work lane", "feature/work", "2026-05-12T11:57:00.000Z"),
          lane("primary", "Primary", "main", "2026-05-12T11:50:00.000Z", 0, 0, "primary"),
        ]}
        sessions={[]}
        activeLaneId="primary"
        activeSessionId={null}
        browsingLaneId="primary"
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={30}
      />,
    ).lastFrame() ?? "");

    expect(frame.indexOf("Primary")).toBeLessThan(frame.indexOf("Work lane"));
    expect(frame).not.toContain("new / filter");
    expect(frame).not.toContain(" run ");
    expect(frame).not.toContain(" wait ");
    expect(frame).not.toContain("↑↓ view");
    expect(frame).not.toContain("↵ open");
    expect(frame).toContain("+ new lane");
  });

  it("expands chats under the selected lane in lane mode and highlights chats in chat mode", () => {
    const sessions: AgentChatSessionSummary[] = [
      {
        sessionId: "chat-1",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        title: "First chat",
        status: "idle",
        startedAt: "2026-05-12T11:30:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-05-12T11:31:00.000Z",
        lastOutputPreview: null,
        summary: null,
      },
    ];

    const baseProps = {
      lanes: [lane("lane-1", "Feature", "feature/chat-nav", "2026-05-12T11:55:00.000Z")],
      sessions,
      activeLaneId: "lane-1",
      activeSessionId: "chat-1",
      browsingLaneId: "lane-1",
      selectedLaneIndex: 0,
      panelHeight: 30,
    };

    const laneModeFrame = stripAnsi(render(
      <Drawer {...baseProps} selectedChatIndex={-1} mode="lanes" focused />,
    ).lastFrame() ?? "");
    const chatModeFrame = stripAnsi(render(
      <Drawer {...baseProps} selectedChatIndex={1} mode="chats" focused />,
    ).lastFrame() ?? "");

    expect(laneModeFrame).toContain("First chat");
    expect(laneModeFrame).toContain("enter chats");
    expect(laneModeFrame).not.toContain("││");
    // The expanded chat list no longer carries a "CHATS · N" sub-header — a
    // selected lane looks like a collapsed one plus its violet border and the
    // trailing "+ new chat" row.
    expect(chatModeFrame).not.toContain("CHATS ·");
    expect(chatModeFrame).toContain("First chat");
    expect(chatModeFrame.indexOf("First chat")).toBeLessThan(chatModeFrame.indexOf("+ new chat"));
    expect(chatModeFrame).not.toContain("││");
    // Chats-mode footer now hints at how to escape the chat list since arrows
    // no longer pop back into lanes on their own.
    expect(chatModeFrame).toContain("esc lanes");
    expect(chatModeFrame).toContain("select chat");
    // Old "lane card" / "next lane" hints are gone now that arrows stay in
    // chats.
    expect(chatModeFrame).not.toContain("lane card");
    expect(chatModeFrame).not.toContain("next lane");
  });

  it("previews chats under non-selected lanes and hides branch refs from lane cards", () => {
    const sessions: AgentChatSessionSummary[] = [
      {
        sessionId: "chat-other",
        laneId: "lane-2",
        provider: "codex",
        model: "gpt-5.5",
        title: "Sidechat",
        status: "idle",
        startedAt: "2026-05-12T11:30:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-05-12T11:31:00.000Z",
        lastOutputPreview: null,
        summary: null,
      },
    ];

    const frame = stripAnsi(render(
      <Drawer
        lanes={[
          lane("lane-1", "Selected lane", "feature/selected-branch", "2026-05-12T11:55:00.000Z"),
          lane("lane-2", "Other lane", "feature/other-branch", "2026-05-12T11:56:00.000Z"),
        ]}
        sessions={sessions}
        activeLaneId="lane-1"
        activeSessionId={null}
        browsingLaneId="lane-1"
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={40}
        mode="lanes"
        focused
      />,
    ).lastFrame() ?? "");

    // The non-selected lane's chat is visible without entering the lane.
    expect(frame).toContain("Sidechat");
    // Branch refs no longer render inside lane cards.
    expect(frame).not.toContain("feature/selected-branch");
    expect(frame).not.toContain("feature/other-branch");
  });

  it("makes split add mode obvious in the drawer chrome", () => {
    const sessions: AgentChatSessionSummary[] = [
      {
        sessionId: "chat-1",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        title: "First chat",
        status: "idle",
        startedAt: "2026-05-12T11:30:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-05-12T11:31:00.000Z",
        lastOutputPreview: null,
        summary: null,
      },
    ];

    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("lane-1", "Feature", "feature/chat-nav", "2026-05-12T11:55:00.000Z")]}
        sessions={sessions}
        activeLaneId="lane-1"
        activeSessionId="chat-1"
        browsingLaneId="lane-1"
        selectedLaneIndex={0}
        selectedChatIndex={0}
        panelHeight={30}
        mode="chats"
        focused
        addMode
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("PICK CHAT");
    expect(frame).toContain("select chat in left pane");
    expect(frame).toContain("↵/click");
  });

  it("does not offer a new chat action for a missing lane worktree", () => {
    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("missing", "ui audit lane 1", "ade/ui-audit-lane-1", "2026-05-12T11:55:00.000Z")]}
        sessions={[]}
        activeLaneId="missing"
        activeSessionId={null}
        browsingLaneId="missing"
        selectedLaneIndex={0}
        selectedChatIndex={0}
        panelHeight={30}
        mode="chats"
        focused
        unavailableLaneIds={new Set(["missing"])}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("miss");
    expect(frame).toContain("worktree missing");
    expect(frame).toContain("lane unavailable");
    expect(frame).not.toContain("+ new chat");
  });
});

describe("Drawer PR pill", () => {
  it("renders open PR number and check counts inline", () => {
    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("lane-1", "opt prs tab", "ade/opt-prs-tab", "2026-05-12T11:55:00.000Z")]}
        sessions={[]}
        activeLaneId={null}
        activeSessionId={null}
        browsingLaneId={null}
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={20}
        prByLaneId={{
          "lane-1": { number: 168, state: "open", checksPassed: 4, checksTotal: 6 },
        }}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("[#168 ·4/6]");
  });

  it("does not render closed or merged PR pills", () => {
    for (const state of ["closed", "merged"] as const) {
      const frame = stripAnsi(render(
        <Drawer
          lanes={[lane("lane-1", "opt prs tab", "ade/opt-prs-tab", "2026-05-12T11:55:00.000Z")]}
          sessions={[]}
          activeLaneId={null}
          activeSessionId={null}
          browsingLaneId={null}
          selectedLaneIndex={0}
          selectedChatIndex={-1}
          panelHeight={20}
          prByLaneId={{
            "lane-1": { number: 168, state, checksPassed: 4, checksTotal: 6 },
          }}
        />,
      ).lastFrame() ?? "");

      expect(frame).not.toContain("[#168");
    }
  });

  it("skips the pill in mini drawer density", () => {
    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("lane-1", "opt prs tab", "ade/opt-prs-tab", "2026-05-12T11:55:00.000Z")]}
        sessions={[]}
        activeLaneId={null}
        activeSessionId={null}
        browsingLaneId={null}
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={20}
        density="mini"
        prByLaneId={{
          "lane-1": { number: 168, state: "open", checksPassed: 4, checksTotal: 6 },
        }}
      />,
    ).lastFrame() ?? "");

    expect(frame).not.toContain("[#168");
  });
});

describe("Drawer macOS VM badge", () => {
  it("flags lanes with runtimePlacement=macos-vm with a VM badge", () => {
    const frame = stripAnsi(render(
      <Drawer
        lanes={[
          lane(
            "lane-vm",
            "vm lane",
            "feature/vm",
            "2026-05-12T11:55:00.000Z",
            0,
            0,
            "worktree",
            { runtimePlacement: "macos-vm" },
          ),
        ]}
        sessions={[]}
        activeLaneId={null}
        activeSessionId={null}
        browsingLaneId={null}
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={20}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("VM");
  });

  it("omits the VM badge for local lanes", () => {
    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("lane-local", "local lane", "feature/local", "2026-05-12T11:55:00.000Z")]}
        sessions={[]}
        activeLaneId={null}
        activeSessionId={null}
        browsingLaneId={null}
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={20}
      />,
    ).lastFrame() ?? "");

    // Status chip is "idle" for plain worktree lanes; ensure no VM token leaks.
    const lines = frame.split("\n");
    expect(lines.some((line) => /\bVM\b/.test(line))).toBe(false);
  });
});

describe("Drawer active chat indicator", () => {
  it("uses a spinning frame for active chats", () => {
    const activeSession: AgentChatSessionSummary = {
      sessionId: "chat-1",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      title: "Implement polish",
      status: "active",
      startedAt: "2026-05-12T12:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-05-12T12:00:00.000Z",
      lastOutputPreview: null,
      summary: null,
    };

    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("lane-1", "feature", "feature/spinner", "2026-05-12T12:00:00.000Z")]}
        sessions={[activeSession]}
        activeLaneId="lane-1"
        activeSessionId="chat-1"
        browsingLaneId="lane-1"
        selectedLaneIndex={0}
        selectedChatIndex={0}
        panelHeight={40}
        mode="chats"
        focused
      />,
    ).lastFrame() ?? "");

    // The active chat carries a live spinner (no "now"/age text — the panel
    // shows no timestamps).
    expect(frame).toMatch(/[◐◓◑◒]/);
    expect(frame).not.toContain("now");
  });
});
