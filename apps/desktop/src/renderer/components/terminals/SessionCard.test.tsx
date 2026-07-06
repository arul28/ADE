/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import { setLaneNaming } from "../../state/laneNamingStore";

vi.mock("./useSessionDelta", () => ({
  useSessionDelta: () => null,
}));

afterEach(() => {
  cleanup();
  setLaneNaming("lane-1", false);
});

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

  it("shows the awaiting badge for chat pending input", () => {
    render(
      <SessionCard
        session={makeSession({
          runtimeState: "waiting-input",
          pendingInputItemId: "pending-1",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Awaiting your input")).toBeTruthy();
  });

  it("does not label plain CLI prompts as chat questions", () => {
    render(
      <SessionCard
        session={makeSession({
          toolType: "codex",
          title: "Codex CLI",
          runtimeState: "waiting-input",
          pendingInputItemId: null,
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Awaiting your input")).toBeNull();
  });
});

describe("SessionCard auto-naming status", () => {
  it("shows the auto-naming status in place of the preview while the lane is being named", () => {
    setLaneNaming("lane-1", true);
    render(
      <SessionCard
        session={makeSession({ lastOutputPreview: "running the build" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByText(/Auto-naming lane underway/i)).toBeTruthy();
    expect(screen.queryByText(/running the build/i)).toBeNull();
  });

  it("shows the normal preview line when the lane is not being named", () => {
    render(
      <SessionCard
        session={makeSession({ lastOutputPreview: "running the build" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Auto-naming lane underway/i)).toBeNull();
    expect(screen.getByText(/running the build/i)).toBeTruthy();
  });
});

describe("SessionCard attention capsule", () => {
  it("shows a Failed capsule for a non-zero exit", () => {
    render(
      <SessionCard
        session={makeSession({ toolType: "codex", status: "failed", exitCode: 1 })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("shows a Stale capsule for a long-silent running session", () => {
    render(
      <SessionCard
        session={makeSession({
          toolType: "codex",
          status: "running",
          runtimeState: "running",
          lastActivityAt: "2020-01-01T00:00:00.000Z",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(screen.getByText("Stale")).toBeTruthy();
  });

  it("renders no capsule for a calm running session", () => {
    render(
      <SessionCard
        session={makeSession({ toolType: "codex", status: "running", runtimeState: "running" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(screen.queryByText(/^(Needs you|Failed|Stale)$/)).toBeNull();
  });

  it("does not double up the amber pill for a chat waiting on input", () => {
    render(
      <SessionCard
        session={makeSession({
          toolType: "codex-chat",
          runtimeState: "waiting-input",
          pendingInputItemId: "pending-1",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    // The chat-specific "Awaiting you" chip covers this; the canonical capsule
    // is suppressed so the card never shows two amber pills.
    expect(screen.getByLabelText("Awaiting your input")).toBeTruthy();
    expect(screen.queryByText("Needs you")).toBeNull();
  });
});
