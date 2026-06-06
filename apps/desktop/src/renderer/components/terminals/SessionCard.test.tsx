/* @vitest-environment jsdom */

import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { SessionCard } from "./SessionCard";

const useSessionDeltaMock = vi.hoisted(() =>
  vi.fn((_sessionId: string | null, _enabled: boolean) => null),
);

vi.mock("./useSessionDelta", () => ({
  useSessionDelta: (sessionId: string | null, enabled: boolean) =>
    useSessionDeltaMock(sessionId, enabled),
}));

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "Lane 1",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: "Build the plan panel",
    toolType: "codex-chat",
    title: "Codex chat",
    status: "running",
    startedAt: "2026-05-23T10:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "idle",
    resumeCommand: null,
    ...overrides,
  };
}

const lane = {
  id: "lane-1",
  name: "Lane 1",
  laneType: "worktree",
  archivedAt: null,
} as LaneSummary;

beforeEach(() => {
  useSessionDeltaMock.mockClear();
  useAppStore.setState({
    projectBinding: {
      kind: "local",
      key: "local:/tmp/project",
      rootPath: "/tmp/project",
      displayName: "project",
    },
  });
});

describe("SessionCard orchestration identity", () => {
  it("uses the orchestration role as the primary sidebar label", () => {
    render(
      <SessionCard
        session={makeSession({
          orchestrationRunId: "R-1",
          orchestrationRole: "worker",
          orchestrationTag: "ui",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("Worker · ui")).toBeTruthy();
    expect(screen.getByText("WORKER · ui")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Worker · ui: Build the plan panel/ })).toBeTruthy();
  });

  it("defers remote delta loading until a session card is selected", () => {
    useAppStore.setState({
      projectBinding: {
        kind: "remote",
        key: "remote:target:project",
        targetId: "target",
        runtimeName: "Mac Studio",
        projectId: "project",
        rootPath: "/Users/admin/Projects/perf pass",
        displayName: "perf pass",
      },
    });

    render(
      <SessionCard
        session={makeSession()}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onInfoClick={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(useSessionDeltaMock).toHaveBeenCalledWith("session-1", false);
  });

  it("loads deltas for the selected remote session card", () => {
    useAppStore.setState({
      projectBinding: {
        kind: "remote",
        key: "remote:target:project",
        targetId: "target",
        runtimeName: "Mac Studio",
        projectId: "project",
        rootPath: "/Users/admin/Projects/perf pass",
        displayName: "perf pass",
      },
    });

    render(
      <SessionCard
        session={makeSession()}
        lane={lane}
        isSelected
        onSelect={vi.fn()}
        onInfoClick={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(useSessionDeltaMock).toHaveBeenCalledWith("session-1", true);
  });
});
