/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { CliSessionWorkSurfaceHeader } from "./CliSessionWorkSurfaceHeader";

vi.mock("../chat/ChatGitToolbar", () => ({
  ChatGitToolbar: ({ laneId }: { laneId: string }) => (
    <div data-testid="chat-git-toolbar" data-lane-id={laneId} />
  ),
}));

vi.mock("../run/QuickRunMenu", () => ({
  QuickRunMenu: ({ laneId }: { laneId: string }) => (
    <div data-testid="quick-run-menu" data-lane-id={laneId} />
  ),
}));

vi.mock("./LaneChip", () => ({
  LaneChip: ({ laneName, onClick }: { laneName: string; onClick?: () => void }) => (
    <button data-testid="lane-chip" onClick={onClick}>
      {laneName}
    </button>
  ),
  SessionLaneHeaderLabel: () => null,
}));

vi.mock("../shared/ClaudeCacheTtlBadge", () => ({
  ClaudeCacheTtlBadge: ({ idleSinceAt }: { idleSinceAt: string | null }) => (
    <span data-testid="cache-badge" data-idle-since={idleSinceAt ?? "null"} />
  ),
}));

afterEach(() => cleanup());

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "fix-login",
    label: "Investigation",
    toolType: "claude",
    status: "running",
    runtimeState: "running",
    summary: null,
    lastOutputPreview: null,
    pendingInputItemId: null,
    chatIdleSinceAt: null,
    endedAt: null,
    exitCode: null,
    ptyId: "pty-1",
    workflowName: null,
    description: null,
    ...overrides,
  } as TerminalSessionSummary;
}

const lanes: LaneSummary[] = [
  { id: "lane-1", name: "fix-login", isDefault: false } as unknown as LaneSummary,
];

function renderHeader(overrides: Partial<TerminalSessionSummary> = {}, callbacks: {
  onInfoClick?: () => void;
  onContextMenu?: () => void;
} = {}) {
  const session = makeSession(overrides);
  return render(
    <MemoryRouter>
      <CliSessionWorkSurfaceHeader
        session={session}
        lanes={lanes}
        onInfoClick={callbacks.onInfoClick}
        onContextMenu={callbacks.onContextMenu}
      />
    </MemoryRouter>,
  );
}

describe("CliSessionWorkSurfaceHeader", () => {
  it("renders the canonical work surface header with lane chip and git toolbar", () => {
    renderHeader();
    expect(screen.getByTestId("work-cli-session-header")).toBeTruthy();
    expect(screen.getByTestId("lane-chip").textContent).toBe("fix-login");
    expect(screen.getByTestId("chat-git-toolbar").getAttribute("data-lane-id")).toBe("lane-1");
    expect(screen.getByTestId("quick-run-menu").getAttribute("data-lane-id")).toBe("lane-1");
  });

  it("renders the Claude cache badge for Claude Code CLI sessions while the cache window is warm", () => {
    // shouldShowClaudeCacheTtl requires provider="claude", status="idle",
    // !awaitingInput, and a recent idleSinceAt. Use a fresh ISO timestamp so
    // the TTL hasn't expired.
    const recentIdle = new Date().toISOString();
    renderHeader({
      toolType: "claude",
      runtimeState: "idle",
      chatIdleSinceAt: recentIdle,
    });
    const badge = screen.queryByTestId("cache-badge");
    expect(badge).toBeTruthy();
    expect(badge?.getAttribute("data-idle-since")).toBe(recentIdle);
  });

  it("hides the cache badge for non-Claude tool types", () => {
    const recentIdle = new Date().toISOString();
    renderHeader({
      toolType: "codex",
      runtimeState: "idle",
      chatIdleSinceAt: recentIdle,
    });
    expect(screen.queryByTestId("cache-badge")).toBeNull();
  });

  it("fires onInfoClick when the Info button is pressed", () => {
    const onInfoClick = vi.fn();
    renderHeader({}, { onInfoClick });
    fireEvent.click(screen.getByLabelText("Session info"));
    expect(onInfoClick).toHaveBeenCalledTimes(1);
  });

  it("fires onContextMenu when the kebab is pressed", () => {
    const onContextMenu = vi.fn();
    renderHeader({}, { onContextMenu });
    fireEvent.click(screen.getByLabelText("Session actions"));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it("does not render a stop button (stopping flow moved to the sidebar card / chat composer)", () => {
    renderHeader();
    expect(screen.queryByLabelText(/stop/i)).toBeNull();
  });
});
