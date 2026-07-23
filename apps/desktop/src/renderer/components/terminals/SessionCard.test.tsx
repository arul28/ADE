/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import { setLaneNaming } from "../../state/laneNamingStore";

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("./useSessionDelta", () => ({
  useSessionDelta: () => null,
}));

vi.mock("./ToolLogos", () => ({
  ToolLogo: ({ toolType }: { toolType?: string | null }) => (
    <span data-testid="tool-logo">{toolType ?? "shell"}</span>
  ),
}));

afterEach(() => {
  cleanup();
  setLaneNaming("lane-1", false);
  vi.useRealTimers();
  navigateMock.mockReset();
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

  it("shows the unified Needs you badge for chat pending input", () => {
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

    expect(screen.getByLabelText("Needs you")).toBeTruthy();
  });

  it("uses the same Needs you copy for CLI input prompts", () => {
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

    expect(screen.getByLabelText("Needs you")).toBeTruthy();
  });

  it("renders a Claude session tag beside the title", () => {
    render(
      <SessionCard
        session={makeSession({ toolType: "claude-chat", claudeTag: "customer-ready" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("customer-ready").getAttribute("title")).toBe("customer-ready");
  });
});

describe("SessionCard spawn type + live children", () => {
  it("renders the SUBAGENT pill for a subagent-spawned session", () => {
    render(
      <SessionCard
        session={makeSession({ spawnKind: "subagent", orchestrationParentSessionId: "parent-1" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const pill = screen.getByText("SUBAGENT");
    expect(pill).toBeTruthy();
    expect(pill.getAttribute("data-spawn-kind")).toBe("subagent");
  });

  it("renders the PEER pill for a peer-spawned session", () => {
    render(
      <SessionCard
        session={makeSession({ spawnKind: "peer", orchestrationParentSessionId: "parent-1" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("PEER")).toBeTruthy();
  });

  it("hides the spawn-type pill for none/undefined spawnKind", () => {
    render(
      <SessionCard
        session={makeSession({ spawnKind: "none" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.queryByText("SUBAGENT")).toBeNull();
    expect(screen.queryByText("PEER")).toBeNull();
  });

  it("renders the lineage glyph for a spawned session and not for a top-level one", () => {
    const { rerender } = render(
      <SessionCard
        session={makeSession({ orchestrationParentSessionId: "parent-1" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(screen.getByTestId("session-spawn-lineage")).toBeTruthy();

    rerender(
      <SessionCard
        session={makeSession({ orchestrationParentSessionId: undefined })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("session-spawn-lineage")).toBeNull();
  });

  it("navigates to the parent chat on glyph click without triggering card selection", () => {
    const onSelect = vi.fn();
    const dispatched: CustomEvent[] = [];
    const handler = (event: Event) => dispatched.push(event as CustomEvent);
    window.addEventListener("ade:work:select-session", handler);
    try {
      render(
        <SessionCard
          session={makeSession({ orchestrationParentSessionId: "parent-9" })}
          lane={lane}
          isSelected={false}
          onSelect={onSelect}
          onContextMenu={vi.fn()}
        />,
      );

      act(() => {
        screen.getByTestId("session-spawn-lineage").click();
      });

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.detail).toMatchObject({ sessionId: "parent-9" });
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("ade:work:select-session", handler);
    }
  });

  it("shows the parent title in the lineage glyph tooltip when provided", () => {
    render(
      <SessionCard
        session={makeSession({ orchestrationParentSessionId: "parent-1" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        parentSessionTitle="Lead orchestrator"
      />,
    );
    expect(
      screen.getByTestId("session-spawn-lineage").getAttribute("title"),
    ).toBe('Spawned by "Lead orchestrator" — click to open parent thread');
  });

  it("shows the live-children badge when children are running", () => {
    render(
      <SessionCard
        session={makeSession()}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        liveChildrenCount={3}
      />,
    );

    expect(screen.getByLabelText("3 live spawned chats")).toBeTruthy();
  });

  it("hides the live-children badge when there are none", () => {
    render(
      <SessionCard
        session={makeSession()}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        liveChildrenCount={0}
      />,
    );

    expect(screen.queryByLabelText(/live spawned chat/)).toBeNull();
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
        session={makeSession({ statusNote: "running the build" })}
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

describe("SessionCard preview links", () => {
  it("links a PR token in a status note through the by-number PR route", () => {
    const onSelect = vi.fn();
    render(
      <SessionCard
        session={makeSession({ statusNote: "merged #841" })}
        lane={lane}
        isSelected={false}
        onSelect={onSelect}
        onContextMenu={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "#841" }));
    expect(navigateMock).toHaveBeenCalledWith("/prs?pr=841");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("leaves PR-shaped text in a plain summary unlinked", () => {
    render(
      <SessionCard
        session={makeSession({ summary: "merged #841" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("merged #841")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "#841" })).toBeNull();
  });

  it("uses ask, note, output, summary, then goal precedence", () => {
    const base = makeSession({
      title: "Named chat",
      manuallyNamed: true,
      goal: "Goal fallback",
      summary: "Summary fallback",
      lastOutputPreview: "\u001b[32mOutput fallback\u001b[0m",
      statusNote: "Agent note",
      attentionRequestedAt: "2026-07-23T12:00:00.000Z",
      attentionMessage: "Which environment?",
    });
    const view = render(
      <SessionCard
        session={base}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const preview = () => view.container.querySelector("[data-session-preview-source]");
    expect(preview()?.getAttribute("data-session-preview-source")).toBe("ask");
    expect(preview()?.textContent).toBe("Which environment?");

    view.rerender(
      <SessionCard
        session={{ ...base, attentionRequestedAt: null, attentionMessage: null }}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(preview()?.getAttribute("data-session-preview-source")).toBe("note");
    expect(preview()?.textContent).toBe("Agent note");

    view.rerender(
      <SessionCard
        session={{
          ...base,
          attentionRequestedAt: null,
          attentionMessage: null,
          statusNote: null,
        }}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(preview()?.getAttribute("data-session-preview-source")).toBe("output");
    expect(preview()?.textContent).toBe("Output fallback");

    view.rerender(
      <SessionCard
        session={{
          ...base,
          attentionRequestedAt: null,
          attentionMessage: null,
          statusNote: null,
          lastOutputPreview: null,
        }}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(preview()?.getAttribute("data-session-preview-source")).toBe("summary");

    view.rerender(
      <SessionCard
        session={{
          ...base,
          attentionRequestedAt: null,
          attentionMessage: null,
          statusNote: null,
          lastOutputPreview: null,
          summary: null,
        }}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(preview()?.getAttribute("data-session-preview-source")).toBe("goal");
  });

  it("keeps output fallback plain even when it contains issue-shaped tokens", () => {
    render(
      <SessionCard
        session={makeSession({
          title: "Named chat",
          manuallyNamed: true,
          goal: null,
          lastOutputPreview: "checking #841 and ADE-122",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("checking #841 and ADE-122")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
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

  it("shows stopped inline text, not a Failed capsule, for a disposed CLI session", () => {
    render(
      <SessionCard
        session={makeSession({
          toolType: "claude",
          status: "disposed",
          runtimeState: "killed",
          exitCode: null,
          resumeCommand: "claude --resume session-1",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.getAllByTitle("Stopped")).toHaveLength(2);
    expect(screen.queryByText("Failed")).toBeNull();
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

  it("renders exactly one Needs you capsule for a chat waiting on input", () => {
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
    expect(screen.getAllByLabelText("Needs you")).toHaveLength(1);
    expect(screen.getAllByText("Needs you")).toHaveLength(1);
  });

  it("keeps quiet Ready to the amber dot without a badge", () => {
    render(
      <SessionCard
        session={makeSession({
          toolType: "codex-chat",
          runtimeState: "idle",
          pendingInputItemId: null,
          attentionRequestedAt: null,
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.queryByText("Needs you")).toBeNull();
    expect(screen.getByTitle("Ready")).toBeTruthy();
  });

  it("pulses once when an existing card transitions into Needs you", () => {
    vi.useFakeTimers();
    const baseProps = {
      lane,
      isSelected: false,
      onSelect: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const view = render(
      <SessionCard
        {...baseProps}
        session={makeSession({ runtimeState: "running" })}
      />,
    );
    expect(view.container.querySelector("[data-needs-you-pulse]")).toBeNull();

    view.rerender(
      <SessionCard
        {...baseProps}
        session={makeSession({
          runtimeState: "waiting-input",
          pendingInputItemId: "pending-1",
        })}
      />,
    );
    expect(view.container.querySelector('[data-needs-you-pulse="true"]')).toBeTruthy();

    act(() => vi.advanceTimersByTime(900));
    expect(view.container.querySelector("[data-needs-you-pulse]")).toBeNull();
  });

  it("clears the Needs you pulse immediately when the session resumes", () => {
    vi.useFakeTimers();
    const baseProps = {
      lane,
      isSelected: false,
      onSelect: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const view = render(
      <SessionCard
        {...baseProps}
        session={makeSession({ runtimeState: "running" })}
      />,
    );

    view.rerender(
      <SessionCard
        {...baseProps}
        session={makeSession({
          runtimeState: "waiting-input",
          pendingInputItemId: "pending-1",
        })}
      />,
    );
    expect(view.container.querySelector('[data-needs-you-pulse="true"]')).toBeTruthy();

    view.rerender(
      <SessionCard
        {...baseProps}
        session={makeSession({
          runtimeState: "running",
          pendingInputItemId: null,
        })}
      />,
    );
    expect(view.container.querySelector("[data-needs-you-pulse]")).toBeNull();

    act(() => vi.advanceTimersByTime(900));
    expect(view.container.querySelector("[data-needs-you-pulse]")).toBeNull();
  });
});

describe("SessionCard next wake chip", () => {
  it("shows a compact countdown for a valid future wake and refreshes every 30 seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    render(
      <SessionCard
        session={makeSession({ nextWakeAt: "2026-07-09T12:01:01.000Z" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("⏰ 2m")).toBeTruthy();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText("⏰ 1m")).toBeTruthy();
    act(() => vi.advanceTimersByTime(31_000));
    expect(screen.queryByLabelText(/Next scheduled wake/)).toBeNull();
  });

  it.each([null, "not-a-date", "2026-07-09T11:59:59.000Z"])(
    "hides a null, invalid, or past wake timestamp (%s)",
    (nextWakeAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
      render(
        <SessionCard
          session={makeSession({ nextWakeAt })}
          lane={lane}
          isSelected={false}
          onSelect={vi.fn()}
          onContextMenu={vi.fn()}
        />,
      );

      expect(screen.queryByLabelText(/Next scheduled wake/)).toBeNull();
    },
  );
});
