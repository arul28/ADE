import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { ChatTerminalSession } from "../../../../desktop/src/shared/types/sessions";
import { Drawer, drawerChatLabelWidth } from "../components/Drawer";
import {
  closedCliRightPaneRow,
  closedCliSessionStatusKind,
  deriveClosedCliSessions,
  deriveOpenDrawerSessions,
  terminalSessionToChatSummary,
  type ClosedCliSessionSummary,
} from "../closedCliSessions";
import type { TuiChatSessionSummary } from "../adeApi";

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

describe("Drawer closed CLI sessions", () => {
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
    const [session] = deriveClosedCliSessions([terminal({
      terminalId: `t-${_label.replace(/\s+/g, "-")}`,
      ...overrides,
    })]);

    expect(session).toBeTruthy();
    expect(closedCliSessionStatusKind(session!)).toBe(expected);
    expect(closedCliRightPaneRow(session!, null)).toContain(expected === "failed" ? "✗" : "○");
  });

  it("filters closed CLI sessions out of the open drawer list", () => {
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
    expect(deriveOpenDrawerSessions([open, closed!], [closed!])).toEqual([open]);
  });
});

describe("Drawer lane and chat navigation layout", () => {
  it("renders compact spawn-kind markers for chat and tracked CLI rows", () => {
    const chat: AgentChatSessionSummary = {
      sessionId: "chat-subagent",
      laneId: "lane-1",
      provider: "claude",
      model: "claude-code",
      title: "Chat child",
      status: "idle",
      startedAt: "2026-05-12T11:30:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-05-12T11:31:00.000Z",
      lastOutputPreview: null,
      summary: null,
      nextWakeAt: null,
      orchestrationParentSessionId: "parent-chat",
      spawnKind: "subagent",
    };
    const cli = terminalSessionToChatSummary(terminal({
      terminalId: "cli-peer",
      resumeMetadata: {
        provider: "codex",
        targetKind: "session",
        targetId: "cli-peer",
        launch: {},
        orchestrationParentSessionId: "parent-chat",
        spawnKind: "peer",
      },
    }));

    const baseProps = {
      lanes: [lane("lane-1", "Feature", "feature/spawn-kind", "2026-05-12T11:55:00.000Z")],
      activeLaneId: "lane-1",
      activeSessionId: null,
      browsingLaneId: "lane-1",
      selectedLaneIndex: 0,
      selectedChatIndex: -1,
      panelHeight: 30,
    };
    const chatFrame = stripAnsi(render(
      <Drawer
        {...baseProps}
        sessions={[chat]}
      />,
    ).lastFrame() ?? "");
    const cliFrame = stripAnsi(render(
      <Drawer
        {...baseProps}
        sessions={[cli]}
      />,
    ).lastFrame() ?? "");

    expect(chatFrame).toContain("Chat child sub");
    expect(cliFrame).toContain("Codex CLI peer");
  });

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
        nextWakeAt: null,
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

  it("renders lifecycle asks, settled outcomes, and last-output fallbacks in chat rows", () => {
    const sessions: TuiChatSessionSummary[] = [
      {
        sessionId: "chat-ask",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        title: "Blocked chat",
        status: "idle",
        startedAt: "2026-05-12T11:30:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-05-12T11:31:00.000Z",
        lastOutputPreview: null,
        summary: null,
        nextWakeAt: null,
        attentionRequestedAt: "2026-05-12T11:32:00.000Z",
        attentionMessage: "Which account?",
      },
      {
        sessionId: "chat-settled",
        laneId: "lane-1",
        provider: "claude",
        model: "claude-code",
        title: "Finished chat",
        status: "idle",
        startedAt: "2026-05-12T11:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-05-12T11:20:00.000Z",
        lastOutputPreview: null,
        summary: null,
        nextWakeAt: null,
        settledAt: "2026-05-12T11:21:00.000Z",
        statusNote: "PR merged",
      },
      {
        sessionId: "chat-output",
        laneId: "lane-1",
        provider: "droid",
        model: "droid cli",
        title: "Build chat",
        status: "idle",
        startedAt: "2026-05-12T10:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-05-12T10:05:00.000Z",
        lastOutputPreview: "\u001b[32mtests green\u001b[0m",
        summary: "Older summary",
        nextWakeAt: null,
      },
    ];

    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("lane-1", "Feature", "feature/lifecycle", "2026-05-12T11:55:00.000Z")]}
        sessions={sessions}
        activeLaneId="lane-1"
        activeSessionId={null}
        browsingLaneId="lane-1"
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={30}
        width={48}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("◔");
    expect(frame).toContain("Which account?");
    expect(frame).toContain("○");
    expect(frame).toContain("done: PR merged");
    expect(frame).toContain("tests green");
    expect(frame).not.toContain("Older summary");
  });

  it("renders ended tracked CLI sessions behind the closed group in chat mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));

    const openSession: AgentChatSessionSummary = {
      sessionId: "chat-open",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      title: "Open chat",
      status: "idle",
      startedAt: "2026-05-12T11:30:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-05-12T11:31:00.000Z",
      lastOutputPreview: null,
      summary: null,
      nextWakeAt: null,
    };
    const closedSession: ClosedCliSessionSummary = {
      sessionId: "term-1",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      title: "CLI",
      status: "idle",
      startedAt: "2026-05-12T10:00:00.000Z",
      endedAt: "2026-05-12T11:45:00.000Z",
      lastActivityAt: "2026-05-12T11:45:00.000Z",
      lastOutputPreview: null,
      summary: null,
      nextWakeAt: null,
      terminalStatus: "failed",
      terminalExitCode: 1,
      terminalRuntimeState: "killed",
    };

    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("lane-1", "Feature", "feature/closed-cli", "2026-05-12T11:55:00.000Z")]}
        sessions={[openSession]}
        closedSessions={[closedSession]}
        closedCliExpandedLaneIds={new Set(["lane-1"])}
        activeLaneId="lane-1"
        activeSessionId="chat-open"
        browsingLaneId="lane-1"
        selectedLaneIndex={0}
        selectedChatIndex={2}
        panelHeight={30}
        mode="chats"
        focused
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("▾ closed (1)");
    expect(frame).toContain("CLI");
    expect(frame).toContain("· 15m ago");
    expect(frame).toContain("✗");
    expect(frame).toContain("◎");
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
        nextWakeAt: null,
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
        nextWakeAt: null,
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

  it("renders native stack position inside the PR pill", () => {
    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("lane-1", "stack ui", "ade/stack-ui", "2026-05-12T11:55:00.000Z")]}
        sessions={[]}
        activeLaneId={null}
        activeSessionId={null}
        browsingLaneId={null}
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={20}
        width={48}
        prByLaneId={{
          "lane-1": {
            number: 168,
            state: "open",
            checksPassed: 4,
            checksTotal: 6,
            stack: {
              id: "stack-18",
              number: 18,
              size: 3,
              position: 2,
              baseBranch: "main",
            },
          },
        }}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("[#168 ≋2/3 ·4/6]");
  });

  // ADE-135: the counts are producer-blind, so a PR whose only checks are
  // preview/review bots arrives here as N/N. The pill must not spend a number
  // on that at all — "no ci" is the fact.
  it("renders no-ci in the PR pill when the rollup says nothing verified the commit", () => {
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
          "lane-1": {
            number: 988,
            state: "open",
            checksPassed: 3,
            checksTotal: 3,
            checksStatus: "not_run",
          },
        }}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("[#988 ·no ci]");
    expect(frame).not.toContain("3/3");
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
      nextWakeAt: null,
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

describe("Drawer next-wake marker", () => {
  function wakeSession(nextWakeAt: string | null): AgentChatSessionSummary {
    return {
      sessionId: "chat-wake",
      laneId: "lane-1",
      provider: "claude",
      model: "claude-opus-4-8",
      title: "Nightly sweep",
      status: "ended",
      startedAt: "2026-05-12T12:00:00.000Z",
      endedAt: "2026-05-12T12:05:00.000Z",
      lastActivityAt: "2026-05-12T12:05:00.000Z",
      lastOutputPreview: null,
      summary: null,
      nextWakeAt,
    };
  }

  function renderWith(nextWakeAt: string | null, width = 48): string {
    return stripAnsi(render(
      <Drawer
        lanes={[lane("lane-1", "feature", "feature/wake", "2026-05-12T12:00:00.000Z")]}
        sessions={[wakeSession(nextWakeAt)]}
        activeLaneId="lane-1"
        activeSessionId={null}
        browsingLaneId="lane-1"
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={40}
        mode="chats"
        focused
        width={width}
      />,
    ).lastFrame() ?? "");
  }

  it("shows a ⏰ marker for an armed future wake", () => {
    const nextWakeAt = new Date(Date.now() + 12 * 60_000).toISOString();
    const frame = renderWith(nextWakeAt);
    expect(frame).toContain("⏰");
    expect(frame).toContain("12m");
  });

  it("drops the title before the wake marker can overlap in a narrow drawer", () => {
    const nextWakeAt = new Date(Date.now() + 12 * 60_000).toISOString();
    const frame = renderWith(nextWakeAt, 32);
    const wakeRow = frame.split("\n").find((line) => line.includes("⏰12m")) ?? "";

    expect(drawerChatLabelWidth(8, "12m".length + 3)).toBe(0);
    expect(wakeRow).toContain("⏰12m");
  });

  it("omits the marker when there is no armed wake (null or past)", () => {
    expect(renderWith(null)).not.toContain("⏰");
    expect(renderWith(new Date(Date.now() - 60_000).toISOString())).not.toContain("⏰");
  });
});
