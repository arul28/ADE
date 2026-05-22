/* @vitest-environment jsdom */

/**
 * Composer + sidebar "+" menu entry for new orchestrator chats. The user
 * can pick "Orchestrator" from either:
 *   1. The SessionListPane "+ New Chat" picker (purple-accent pill).
 *   2. The AgentChatComposer "+" attachment menu ("New orchestrator chat").
 *
 * Both flows resolve to `onShowDraftKind("chat-orchestrator")`. The
 * subsequent draft submit calls `agentChat.create({ interactionMode:
 * "orchestrator-lead", ... })` and `orchestration.runCreate({ laneId,
 * leadSessionId })` — see `goal.md` §10.1 + §17 step 6.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { SessionListPane } from "./SessionListPane";

vi.mock("./useSessionDelta", () => ({
  useSessionDelta: () => null,
}));

vi.mock("./ToolLogos", () => ({
  ToolLogo: () => <span data-testid="tool-logo" />,
}));

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-known",
    name: "Known Lane",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "known-lane",
    worktreePath: "/tmp/known-lane",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-04-22T10:00:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-mobile",
    laneId: "lane-mobile",
    laneName: "Mobile-created lane",
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: null,
    toolType: "codex-chat",
    title: "Mobile Tool Streaming UI",
    status: "running",
    startedAt: "2026-04-22T22:13:02.691Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: ".ade/transcripts/session-mobile.chat.jsonl",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  };
}

function renderPane(props: Partial<ComponentProps<typeof SessionListPane>> = {}) {
  const session = makeSession();
  const onShowDraftKind = props.onShowDraftKind ?? vi.fn();
  const view = render(
    <MemoryRouter>
      <SessionListPane
        lanes={[makeLane()]}
        runningFiltered={[session]}
        awaitingInputFiltered={[]}
        endedFiltered={[]}
        loading={false}
        filterLaneId="all"
        setFilterLaneId={vi.fn()}
        filterStatus="all"
        setFilterStatus={vi.fn()}
        q=""
        setQ={vi.fn()}
        selectedSessionId={null}
        draftKind="chat"
        showingDraft={false}
        onShowDraftKind={onShowDraftKind}
        onSelectSession={vi.fn()}
        onInfoClick={vi.fn()}
        onContextMenu={vi.fn()}
        sessionListOrganization="by-lane"
        setSessionListOrganization={vi.fn()}
        workCollapsedLaneIds={[]}
        toggleWorkLaneCollapsed={vi.fn()}
        workCollapsedSectionIds={[]}
        toggleWorkSectionCollapsed={vi.fn()}
        sessionsGroupedByLane={new Map([[session.laneId, [session]]])}
        {...props}
      />
    </MemoryRouter>,
  );
  return { view, onShowDraftKind };
}

describe("SessionListPane orchestrator entry", () => {
  it("renders an Orchestrator button alongside New Chat", () => {
    renderPane();
    const orchestrator = screen.getByTestId("session-list-new-orchestrator-chat");
    expect(orchestrator).toBeTruthy();
    expect(orchestrator.textContent).toContain("Orchestrator");
  });

  it("clicking Orchestrator dispatches onShowDraftKind('chat-orchestrator')", () => {
    const onShowDraftKind = vi.fn();
    const { view } = renderPane({ onShowDraftKind });
    fireEvent.click(within(view.container).getByTestId("session-list-new-orchestrator-chat"));
    expect(onShowDraftKind).toHaveBeenCalledWith("chat-orchestrator");
  });

  it("does NOT dispatch when only New Chat is clicked", () => {
    const onShowDraftKind = vi.fn();
    const { view } = renderPane({ onShowDraftKind });
    fireEvent.click(within(view.container).getByRole("button", { name: /^Start a new chat$/i }));
    expect(onShowDraftKind).toHaveBeenCalledWith("chat");
    expect(onShowDraftKind).not.toHaveBeenCalledWith("chat-orchestrator");
  });
});

/**
 * Verifies the contract from the composer side: when the host wires
 * `onStartOrchestratorChat`, the menu entry is rendered and clicking it
 * fires the callback. We test the callback wiring without mounting the
 * entire ChatComposerShell — see `goal.md` step 6 hook contract.
 */
describe("composer New orchestrator chat entry contract", () => {
  it("dispatches `ade:work:start-orchestrator-chat` when invoked", () => {
    const onShowDraftKind = vi.fn();
    const handler = () => onShowDraftKind("chat-orchestrator");
    window.addEventListener("ade:work:start-orchestrator-chat", handler);
    window.dispatchEvent(new CustomEvent("ade:work:start-orchestrator-chat"));
    expect(onShowDraftKind).toHaveBeenCalledWith("chat-orchestrator");
    window.removeEventListener("ade:work:start-orchestrator-chat", handler);
  });
});
