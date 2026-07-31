/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, PrSummary, TerminalSessionSummary } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import {
  SESSION_HOVER_CARD_DELAY_MS,
  resetSessionHoverCardGroupForTests,
} from "./SessionHoverCard";
import { setLaneNaming } from "../../state/laneNamingStore";

const { navigateMock, sessionDeltaMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  // Rows have no diff unless a test says so; `mockReturnValue` per test.
  sessionDeltaMock: vi.fn<[], { insertions: number; deletions: number } | null>(() => null),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("./useSessionDelta", () => ({
  useSessionDelta: () => sessionDeltaMock(),
}));

vi.mock("./ToolLogos", () => ({
  ToolLogo: ({ toolType }: { toolType?: string | null }) => (
    <span data-testid="tool-logo">{toolType ?? "shell"}</span>
  ),
}));

afterEach(() => {
  cleanup();
  // The hover-card warm window is module state shared by every row, so it has
  // to be cleared or one test's card makes the next one open instantly.
  resetSessionHoverCardGroupForTests();
  setLaneNaming("lane-1", false);
  vi.useRealTimers();
  navigateMock.mockReset();
  sessionDeltaMock.mockReset();
  sessionDeltaMock.mockReturnValue(null);
  delete (window as unknown as { ade?: unknown }).ade;
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

function rowWrapper(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector("[data-session-row]");
  if (!wrapper) throw new Error("session row wrapper not found");
  return wrapper as HTMLElement;
}

/** Rest the pointer on a row until the detail card's hover intent fires. Requires fake timers. */
function openRowTooltip(container: HTMLElement): HTMLElement {
  fireEvent.mouseEnter(rowWrapper(container));
  act(() => {
    vi.advanceTimersByTime(SESSION_HOVER_CARD_DELAY_MS + 50);
  });
  return screen.getByTestId("session-hover-card");
}

/** The row of the open detail card carrying `id`, e.g. `lane` or `branch`. */
function hoverRow(id: string): HTMLElement {
  const element = document.querySelector(`[data-session-hover-row="${id}"]`);
  if (!element) throw new Error(`hover-card row "${id}" not found`);
  return element as HTMLElement;
}

function row(container: HTMLElement): HTMLElement {
  const element = container.querySelector('[data-session-row] [role="button"]');
  if (!element) throw new Error("session row not found");
  return element as HTMLElement;
}

describe("SessionCard orchestration identity", () => {
  it("names the row with its orchestration role for assistive tech", () => {
    const { container } = render(
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

    expect(screen.getByRole("button", { name: /Worker · ui: Build the plan panel/ })).toBeTruthy();
    // The role PILL is gone from row 1 — the fact moved to the hover tooltip.
    expect(container.querySelector("[data-orchestration-role]")).toBeNull();
  });

  it("moves the role, spawn kind and Claude tag into the hover detail card", () => {
    vi.useFakeTimers();
    const { container } = render(
      <SessionCard
        session={makeSession({
          toolType: "claude-chat",
          claudeTag: "customer-ready",
          orchestrationRole: "worker",
          orchestrationTag: "ui",
          spawnKind: "subagent",
          orchestrationParentSessionId: "parent-1",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        liveChildrenCount={3}
      />,
    );

    // None of these have a permanent seat on the row any more.
    expect(screen.queryByText("WORKER · ui")).toBeNull();
    expect(screen.queryByText("SUBAGENT")).toBeNull();
    expect(screen.queryByText("customer-ready")).toBeNull();

    // Icon-led rows: the icon is the label, so no "Label:" prefix survives.
    const card = openRowTooltip(container);
    expect(card.textContent).not.toContain("Role:");
    expect(hoverRow("role").textContent).toContain("Worker · ui");
    expect(hoverRow("spawn").textContent).toContain("Subagent");
    expect(hoverRow("tag").textContent).toContain("customer-ready");
    expect(hoverRow("live-children").textContent).toContain("3 spawned chats still running");
    expect(hoverRow("lane").textContent).toContain("Lane 1");
    expect(hoverRow("provider").textContent).toContain("Claude chat");
  });

  it("shows the Needs you status for chat pending input", () => {
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

    expect(screen.getAllByText("Needs you")).toHaveLength(1);
  });

  it("does not infer Needs you from a CLI runtime marker", () => {
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

    expect(screen.queryByText("Needs you")).toBeNull();
  });
});

describe("SessionCard lineage", () => {
  it("shows the lane's native stack position on a chat row", () => {
    render(
      <SessionCard
        session={makeSession()}
        lane={lane}
        githubStack={{
          id: "stack-18",
          number: 18,
          size: 3,
          position: 2,
          baseBranch: "main",
        }}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("GitHub Stack 2 of 3")).toBeTruthy();
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

  it("labels the badge with the spawn kind, then the role, then a plain fallback", () => {
    const props = {
      lane,
      isSelected: false,
      onSelect: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const { rerender } = render(
      <SessionCard
        {...props}
        session={makeSession({
          orchestrationParentSessionId: "parent-1",
          spawnKind: "subagent",
        })}
      />,
    );
    expect(screen.getByTestId("session-spawn-lineage").textContent).toContain("Subagent");

    rerender(
      <SessionCard
        {...props}
        session={makeSession({
          orchestrationParentSessionId: "parent-1",
          spawnKind: "peer",
        })}
      />,
    );
    expect(screen.getByTestId("session-spawn-lineage").textContent).toContain("Peer");

    // No spawn kind: the orchestration role is the next most specific truth.
    rerender(
      <SessionCard
        {...props}
        session={makeSession({
          orchestrationParentSessionId: "parent-1",
          spawnKind: "none",
          orchestrationRole: "validator",
        })}
      />,
    );
    expect(screen.getByTestId("session-spawn-lineage").textContent).toContain("Validator");

    rerender(
      <SessionCard
        {...props}
        session={makeSession({ orchestrationParentSessionId: "parent-1" })}
      />,
    );
    expect(screen.getByTestId("session-spawn-lineage").textContent).toContain("Spawned");
  });

  it("never says 'another chat' and exposes parent navigation to the keyboard", () => {
    const onSelect = vi.fn();
    const dispatched: CustomEvent[] = [];
    const handler = (event: Event) => dispatched.push(event as CustomEvent);
    window.addEventListener("ade:work:select-session", handler);
    try {
      const { container } = render(
        <SessionCard
          session={makeSession({ orchestrationParentSessionId: "parent-9" })}
          lane={lane}
          isSelected={false}
          onSelect={onSelect}
          onContextMenu={vi.fn()}
          // The common real case: the parent is not in the visible list, so no
          // title is available. The badge must still say something specific.
          parentSessionTitle={null}
        />,
      );

      const lineage = screen.getByTestId("session-spawn-lineage");
      expect(container.textContent).not.toContain("another chat");
      expect(lineage.tagName).toBe("BUTTON");
      expect(lineage.getAttribute("aria-label")).toBe("Open parent thread");

      act(() => {
        lineage.click();
      });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.detail).toMatchObject({ sessionId: "parent-9" });
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("ade:work:select-session", handler);
    }
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

  it("renders the preview line italic so it reads as commentary on the title", () => {
    // Typographic separation, not decoration: the title is what you scan for,
    // this line is what it is saying about itself. Matches the auto-naming line.
    const { container } = render(
      <SessionCard
        session={makeSession({ statusNote: "running the build" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const preview = container.querySelector("[data-session-preview-source]") as HTMLElement;
    expect(preview.className).toContain("italic");
    // Colour and size are unchanged — italics carry the whole distinction.
    expect(preview.className).not.toContain("text-[");
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

describe("SessionCard status slot", () => {
  it("swaps the status label out of flow on row hover so the actions can claim its width", () => {
    const { container } = render(
      <SessionCard
        session={makeSession({
          toolType: "codex",
          status: "completed",
          runtimeState: "exited",
          exitCode: 0,
          endedAt: "2026-05-23T11:00:00.000Z",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const label = screen.getByTestId("session-status-label");
    expect(label.className).toContain("group-hover/v2-row:absolute");
    expect(label.className).toContain("group-hover/v2-row:opacity-0");

    // The action cluster is the mirror image: absolute + transparent at rest,
    // static + opaque on hover. Going `static` is what makes the swap free.
    const settle = screen.getByTestId("session-settle-button");
    const cluster = settle.parentElement!;
    expect(cluster.className).toContain("absolute");
    expect(cluster.className).toContain("group-hover/v2-row:static");
    expect(cluster.className).toContain("group-hover/v2-row:opacity-100");
    expect(container.querySelector("[data-session-status-slot]")?.className).toContain("ml-auto");
  });

  it("keeps the status label pointer-events-none so it cannot eat the action clicks", () => {
    // Regression guard: while hovered the label is painted ON TOP of the
    // in-flow buttons. Without pointer-events-none it swallows every click.
    render(
      <SessionCard
        session={makeSession()}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByTestId("session-status-label").className).toContain("pointer-events-none");
  });

  it("settles the session without selecting the row", async () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { ade: unknown }).ade = {
      sessions: { settle, unsettle: vi.fn() },
    };
    const onSelect = vi.fn();
    render(
      <SessionCard
        session={makeSession({
          status: "completed",
          runtimeState: "exited",
          exitCode: 0,
          endedAt: "2026-05-23T11:00:00.000Z",
        })}
        lane={lane}
        isSelected={false}
        onSelect={onSelect}
        onContextMenu={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("session-settle-button"));
    await waitFor(() => expect(settle).toHaveBeenCalledWith("session-1", undefined));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("routes settle to the owning remote runtime instead of the active project", async () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { ade: unknown }).ade = {
      sessions: { settle, unsettle: vi.fn() },
    };
    const runtimePin = {
      kind: "remote" as const,
      key: "remote:target-studio:project-a",
      targetId: "target-studio",
      runtimeName: "Mac Studio",
      projectId: "project-a",
      rootPath: "/remote/repo-a",
      displayName: "repo-a",
    };
    render(
      <SessionCard
        session={makeSession({
          status: "completed",
          runtimeState: "exited",
          exitCode: 0,
          endedAt: "2026-05-23T11:00:00.000Z",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        runtimePin={runtimePin}
      />,
    );

    fireEvent.click(screen.getByTestId("session-settle-button"));
    await waitFor(() => expect(settle).toHaveBeenCalledWith(
      "session-1",
      undefined,
      runtimePin,
    ));
  });

  it("does not offer settle while a session is actively running", () => {
    render(
      <SessionCard
        session={makeSession({ status: "running", runtimeState: "running" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("session-settle-button")).toBeNull();
    expect(screen.getByTestId("session-snooze-button")).toBeTruthy();
  });

  it("offers un-settle on an already settled row and shows its timestamp instead of a status", () => {
    const unsettle = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { ade: unknown }).ade = {
      sessions: { settle: vi.fn(), unsettle },
    };
    render(
      <SessionCard
        session={makeSession({
          status: "completed",
          runtimeState: "exited",
          exitCode: 0,
          endedAt: "2026-05-23T11:00:00.000Z",
          settledAt: "2026-05-23T11:00:05.000Z",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const button = screen.getByTestId("session-settle-button");
    expect(button.getAttribute("aria-label")).toBe("Un-settle session");
    fireEvent.click(button);
    expect(unsettle).toHaveBeenCalledWith("session-1");
  });

  it("gives the row actions a hover fill in both settle states, not just brighter text", () => {
    // Text that only brightens reads as text. The pill is what makes Snooze,
    // Settle and Un-settle read as controls, and keyboard users — who never
    // see hover — get the identical fill on focus-visible.
    const props = {
      session: makeSession(),
      lane,
      isSelected: false,
      onSelect: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const { rerender } = render(<SessionCard {...props} />);

    const assertHoverPill = () => {
      for (const testId of ["session-snooze-button", "session-settle-button"]) {
        const button = screen.getByTestId(testId);
        expect(button.className).toContain("hover:bg-white/[0.06]");
        expect(button.className).toContain("focus-visible:bg-white/[0.06]");
        expect(button.className).toContain("hover:text-fg");
        // Still a real button in the tab order.
        expect(button.getAttribute("tabindex")).toBeNull();
      }
    };

    assertHoverPill();
    rerender(
      <SessionCard
        {...props}
        session={makeSession({
          status: "completed",
          runtimeState: "exited",
          exitCode: 0,
          endedAt: "2026-05-23T11:00:00.000Z",
          settledAt: "2026-05-23T11:00:05.000Z",
        })}
      />,
    );
    expect(screen.getByTestId("session-settle-button").getAttribute("aria-label")).toBe(
      "Un-settle session",
    );
    assertHoverPill();
  });

  it("pins the slot open while the snooze popover is up", () => {
    // The pointer is over the portalled menu, not the row, so the hover-driven
    // actions would fade out from under it without this pin.
    render(
      <SessionCard
        session={makeSession()}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const label = screen.getByTestId("session-status-label");
    const cluster = screen.getByTestId("session-settle-button").parentElement!;
    expect(label.className).not.toContain("absolute right-0 opacity-0");
    expect(cluster.className).not.toContain("static opacity-100");

    fireEvent.click(screen.getByRole("button", { name: "Snooze session" }));

    expect(screen.getByTestId("session-status-label").className).toContain("absolute right-0 opacity-0");
    expect(screen.getByTestId("session-settle-button").parentElement!.className).toContain(
      "static opacity-100",
    );
  });

  it("un-pins the slot if the row is blocked while the popover is open", () => {
    // Derived, not raw: the snooze button unmounts without reporting `false`,
    // and a stale pin would hide the status label forever.
    const props = {
      session: makeSession(),
      lane,
      isSelected: false,
      onSelect: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const { rerender } = render(<SessionCard {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Snooze session" }));
    expect(screen.getByTestId("session-status-label").className).toContain("absolute right-0 opacity-0");

    rerender(<SessionCard {...props} disabledReason="Removing lane" />);
    expect(screen.getByTestId("session-status-label").className).not.toContain(
      "absolute right-0 opacity-0",
    );
  });

  it("hides the actions entirely while the row is blocked", () => {
    render(
      <SessionCard
        session={makeSession()}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        disabledReason="Removing lane"
      />,
    );

    expect(screen.queryByTestId("session-settle-button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Snooze session" })).toBeNull();
  });
});

describe("SessionCard status vocabulary", () => {
  it("shows Failed for a non-zero exit", () => {
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
    expect(screen.getByText("EXIT 1")).toBeTruthy();
  });

  it("shows Stopped once, with no duplicate STOPPED chip, for a disposed CLI session", () => {
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
    expect(screen.getAllByText("Stopped")).toHaveLength(1);
    expect(screen.queryByText("STOPPED")).toBeNull();
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("renders a stale session as neutral with the elapsed silence, not green Running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    const { container } = render(
      <SessionCard
        session={makeSession({
          toolType: "codex",
          status: "running",
          runtimeState: "running",
          lastActivityAt: "2026-07-09T08:00:00.000Z",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const status = container.querySelector("[data-session-status]")!;
    expect(status.getAttribute("data-session-status")).toBe("Stale");
    // Neutral, not emerald: the process is alive but nothing is happening.
    expect(status.getAttribute("data-session-tone")).toBe("neutral");
    expect(status.className).toContain("text-muted-fg/60");
    expect(status.textContent).toContain("4h");
    // The old amber WarningCircle is gone — amber is reserved for "your move".
    expect(screen.queryByLabelText("Idle session")).toBeNull();
  });

  it("keeps the stale memory-hygiene advice in the detail card", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    const { container } = render(
      <SessionCard
        session={makeSession({
          toolType: "codex",
          status: "running",
          runtimeState: "running",
          // Past the 24h memory-hygiene threshold, not just the stale threshold.
          lastActivityAt: "2026-07-06T12:00:00.000Z",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(openRowTooltip(container).textContent).toContain("consider closing it to free memory");
  });

  it("ticks the working duration every second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    const { container } = render(
      <SessionCard
        session={makeSession({
          toolType: "codex",
          status: "running",
          runtimeState: "running",
          lastActivityAt: "2026-07-09T11:59:46.000Z",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const status = () => container.querySelector("[data-session-status]")!;
    expect(status().getAttribute("data-session-status")).toBe("Working");
    expect(status().textContent).toContain("14s");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(status().textContent).toContain("16s");
  });

  it("puts role=status on the label alone so the ticker is not announced every second", () => {
    render(
      <SessionCard
        session={makeSession({ toolType: "codex", status: "running", runtimeState: "running" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const live = screen.getByRole("status");
    expect(live.textContent).toBe("Working");
  });

  it("reads a resting chat as Done", () => {
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

    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByText("Needs you")).toBeNull();
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

describe("SessionCard recede rule", () => {
  it("recedes a working row and leaves a Needs-you row at full strength", () => {
    const { container, rerender } = render(
      <SessionCard
        session={makeSession({ toolType: "codex", status: "running", runtimeState: "running" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(row(container).getAttribute("data-session-recede")).toBe("true");
    expect(row(container).className).toContain("opacity-70");

    rerender(
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
    expect(row(container).getAttribute("data-session-recede")).toBeNull();
  });

  it("never recedes the row you are looking at", () => {
    const { container } = render(
      <SessionCard
        session={makeSession({ toolType: "codex", status: "running", runtimeState: "running" })}
        lane={lane}
        isSelected
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(row(container).getAttribute("data-session-recede")).toBeNull();
    expect(row(container).className).toContain("bg-white/[0.06]");
  });

  it("spends surface on interaction only — no lane tint, border or shadow at rest", () => {
    const { container } = render(
      <SessionCard
        session={makeSession({
          toolType: "codex-chat",
          runtimeState: "waiting-input",
          pendingInputItemId: "pending-1",
        })}
        lane={{ ...lane, color: "#ff8800" } as LaneSummary}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const element = row(container);
    expect(element.className).toContain("bg-transparent");
    expect(element.className).toContain("hover:bg-white/[0.035]");
    expect(element.getAttribute("style") ?? "").not.toContain("box-shadow");
    expect(element.getAttribute("style") ?? "").not.toContain("border");
  });

  it("pins the full-bleed geometry: 12px left, 12px+scrollbar right, on the containment box", () => {
    /* Twice now the fill has stopped short of the sidebar edges, so this test
       pins the resolved geometry rather than "it has some negative margin".
       Two things have to hold and both are invisible in jsdom, hence the class
       assertions:

       1. WHERE. The bleed must sit on the SAME element as
          `content-visibility: auto`. That property implies paint containment,
          so a negative margin on any descendant is clipped straight back to
          this box — which is exactly how the last two attempts failed.
       2. HOW MUCH. `SessionListPane` insets each row by its scroll container's
          `px-1` (4px) plus the section stack's `px-2` (8px) = 12px per side,
          and the inner layout pays all of it back as padding so no content
          moves. The amount is a variable so a 6px stack can correct it and so
          an indented lane group can zero the LEFT side only — a grouped row
          bleeds to its group's edge, never through the indent rail. */
    const props = {
      session: makeSession(),
      lane,
      isSelected: false,
      onSelect: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const { container, rerender } = render(<SessionCard {...props} />);

    const assertFullBleed = () => {
      const wrapper = container.querySelector("[data-session-row]") as HTMLElement;
      // (1) the bleed and the containment live together.
      expect(wrapper.className).toContain("[content-visibility:auto]");
      expect(wrapper.className).toContain(
        "[--session-row-bleed-left:var(--session-row-bleed,12px)]",
      );
      // The right side also clears the 6px classic scrollbar that
      // `index.css` reserves. Measured in the running app: a plain 12px bleed
      // left the row exactly flush on the LEFT and 5.9px short on the RIGHT —
      // the scrollbar track, not a padding error.
      expect(wrapper.className).toContain("[--session-row-scrollbar:6px]");
      expect(wrapper.className).toContain(
        "[--session-row-bleed-right:calc(var(--session-row-bleed,12px)_+_var(--session-row-scrollbar))]",
      );
      expect(wrapper.className).toContain("ml-[calc(-1*var(--session-row-bleed-left))]");
      expect(wrapper.className).toContain("mr-[calc(-1*var(--session-row-bleed-right))]");
      expect(wrapper.className).toContain(
        "w-[calc(100%_+_var(--session-row-bleed-left)_+_var(--session-row-bleed-right))]",
      );
      // An indented lane group's rail is a hierarchy cue, not padding to eat.
      expect(wrapper.className).toContain("[[data-indented]_&]:[--session-row-bleed-left:0px]");
      // Its animated parent clips overflow, so the right bleed must also stop
      // at the group edge or the clip shears the row's right radius square.
      expect(wrapper.className).toContain("[[data-indented]_&]:[--session-row-bleed-right:0px]");

      const element = row(container);
      // Nothing inside the containment box may try to bleed on its own again.
      expect(element.className).toContain("w-full");
      expect(element.className).not.toMatch(/(?:^|\s)-m[xl]-/);
      // Small radius, not a card's.
      expect(element.className).toContain("rounded-md");
      expect(element.className).not.toContain("rounded-lg");

      // (2) the bleed is paid back, with the same 6px content inset as a lane
      // header so singleton glyphs and full header glyphs share one column.
      const inner = element.firstElementChild as HTMLElement;
      expect(inner.className).toContain("pl-[calc(var(--session-row-bleed-left)_+_0.375rem)]");
      expect(inner.className).toContain("pr-[calc(var(--session-row-bleed-right)_+_0.375rem)]");
    };

    assertFullBleed();
    rerender(<SessionCard {...props} compact />);
    assertFullBleed();
  });
});

describe("SessionCard where line", () => {
  const branchLane = {
    ...lane,
    color: "#ff8800",
    branchRef: "refs/heads/redesign-new-chat-ui",
  } as LaneSummary;

  /** Already resolved by the list — the card never reads PR data itself. */
  const lanePr = {
    id: "pr-1",
    laneId: "lane-1",
    githubPrNumber: 959,
    state: "open",
    updatedAt: "2026-07-28T10:00:00.000Z",
  } as PrSummary;

  /**
   * The worktree HEAD has walked off the lane's own branch. This is the ONLY
   * case where a grouped row's branch is news rather than a fourth copy of the
   * label already sitting in the divider above it.
   */
  const driftedLane = {
    ...branchLane,
    branchDrift: {
      expectedBranchRef: "refs/heads/redesign-new-chat-ui",
      headBranchRef: "refs/heads/hotfix-crash-on-open",
    },
  } as LaneSummary;

  /** Drifted onto an `ade/`-prefixed ref — every lane branch this product creates looks like this. */
  const prefixedDriftLane = {
    ...branchLane,
    branchDrift: {
      expectedBranchRef: "refs/heads/redesign-new-chat-ui",
      headBranchRef: "refs/heads/ade/investigate-fix-ade-missing-initial-0687d8e1",
    },
  } as LaneSummary;

  it("shows the lane and NOT the branch on a singleton row", () => {
    // Singletons have no divider above them, so lane + derived branch would
    // both land on the busiest line saying nearly the same thing. The
    // human-chosen lane name wins; the branch survives in the tooltip.
    vi.useFakeTimers();
    const { container } = render(
      <SessionCard
        session={makeSession()}
        lane={branchLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        showLaneIdentity
      />,
    );

    const laneIdentity = container.querySelector("[data-session-lane-identity]") as HTMLElement;
    expect(laneIdentity.getAttribute("data-session-lane-identity")).toBe("Lane 1");
    expect(laneIdentity.style.color).toBe("rgb(255, 136, 0)");
    expect(laneIdentity.querySelector(".ade-vcs-lane-icon")).toBeTruthy();
    expect(laneIdentity.querySelector(".rounded-full")).toBeNull();

    expect(container.querySelector("[data-session-branch]")).toBeNull();
    openRowTooltip(container);
    expect(hoverRow("branch").textContent).toContain("redesign-new-chat-ui");
  });

  it("hides the branch on a grouped row when it is the lane's own — the divider already said it", () => {
    vi.useFakeTimers();
    const { container } = render(
      <SessionCard
        session={makeSession()}
        lane={branchLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(container.querySelector("[data-session-branch]")).toBeNull();
    // Nothing is lost: the detail card carries the branch unconditionally.
    openRowTooltip(container);
    expect(hoverRow("branch").textContent).toContain("redesign-new-chat-ui");
  });

  it("keeps the branch, muted, on a grouped row whose branch differs from its lane's", () => {
    const { container } = render(
      <SessionCard
        session={makeSession()}
        lane={driftedLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const branch = container.querySelector("[data-session-branch]") as HTMLElement;
    expect(branch.getAttribute("data-session-branch")).toBe("hotfix-crash-on-open");
    // Muted, always. Colour is the only thing separating lane from branch.
    expect(branch.className).toContain("text-muted-fg/70");
    expect(branch.style.color).toBe("");
    expect(branch.querySelector(".ade-vcs-branch-icon")).toBeTruthy();
  });

  it("strips the ade/ prefix from the branch label without touching the real value", () => {
    vi.useFakeTimers();
    const { container } = render(
      <SessionCard
        session={makeSession()}
        lane={prefixedDriftLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const branch = container.querySelector("[data-session-branch]") as HTMLElement;
    // Display only.
    expect(branch.textContent).toBe("investigate-fix-ade-missing-initial-0687d8e1");
    // Everything functional still sees the real branch name.
    expect(branch.getAttribute("data-session-branch")).toBe(
      "ade/investigate-fix-ade-missing-initial-0687d8e1",
    );
    // The card trims the prefix exactly as the row does — same helper.
    openRowTooltip(container);
    expect(hoverRow("branch").textContent).toBe(
      "investigate-fix-ade-missing-initial-0687d8e1",
    );
  });

  it("carries the lane's PR badge on a singleton row and deep-links it", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <SessionCard
        session={makeSession()}
        lane={branchLane}
        isSelected={false}
        onSelect={onSelect}
        onContextMenu={vi.fn()}
        showLaneIdentity
        lanePr={lanePr}
      />,
    );

    const badge = screen.getByLabelText("Pull request #959, Open");
    // Fixed width at the end of the "where" slot: the lane name is the elastic
    // part, because a truncated PR number says nothing.
    expect(badge.className).toContain("shrink-0");
    const whereSlot = badge.parentElement!;
    const laneIdentity = container.querySelector("[data-session-lane-identity]")!;
    expect(whereSlot.contains(laneIdentity)).toBe(true);
    expect(laneIdentity.compareDocumentPosition(badge)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.click(badge);
    expect(navigateMock).toHaveBeenCalledWith("/prs?tab=normal&prId=pr-1");
    // The chip is nested inside the row's own click target, so it must not also
    // select the session.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("leaves the PR badge to the lane divider when the row is not a singleton", () => {
    render(
      <SessionCard
        session={makeSession()}
        lane={branchLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        lanePr={lanePr}
      />,
    );

    expect(screen.queryByLabelText("Pull request #959, Open")).toBeNull();
  });

  it("omits the lane identity by default, and shows the branch only when it differs", () => {
    const props = {
      session: makeSession(),
      isSelected: false,
      onSelect: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const { container, rerender } = render(<SessionCard {...props} lane={branchLane} />);

    expect(container.querySelector("[data-session-lane-identity]")).toBeNull();
    expect(container.querySelector("[data-session-branch]")).toBeNull();

    rerender(<SessionCard {...props} lane={driftedLane} />);
    expect(container.querySelector("[data-session-branch]")).toBeTruthy();
  });

  it("falls back to the last-activity time when a plain row has no other where part", () => {
    // No machine, no pin, no lineage, a branch the lane already implies and no
    // diff — the slot would be empty, so the time takes it and keeps the status
    // slot right-anchored.
    const { container } = render(
      <SessionCard
        session={makeSession()}
        lane={branchLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(container.querySelector("[data-session-branch]")).toBeNull();
    expect(screen.queryByTestId("session-spawn-lineage")).toBeNull();
    const statusSlot = container.querySelector("[data-session-status-slot]") as HTMLElement;
    const line = statusSlot.parentElement!;
    expect(line.children).toHaveLength(2);
    const floor = line.firstElementChild as HTMLElement;
    expect(floor.className).toContain("flex-1");
    expect(floor.getAttribute("data-session-last-activity")).toBe("");
    expect(floor.textContent?.trim()).toBeTruthy();
  });

  it("puts the diff chips on line 1 instead of line 3, leaving the preview flexible", () => {
    sessionDeltaMock.mockReturnValue({ insertions: 42, deletions: 8 });
    const { container } = render(
      <SessionCard
        session={makeSession({ lastOutputPreview: "Report sent to parent session" })}
        lane={branchLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const statusSlot = container.querySelector("[data-session-status-slot]") as HTMLElement;
    const line1 = statusSlot.parentElement!;
    const delta = container.querySelector("[data-session-delta]") as HTMLElement;
    expect(delta.textContent).toContain("+42");
    expect(delta.textContent).toContain("−8");
    // On line 1 — and there is no second copy anywhere, so line 3 lost it.
    expect(line1.contains(delta)).toBe(true);
    expect(container.querySelectorAll("[data-session-delta]")).toHaveLength(1);
    // The time backstop only appears when there is no diff.
    expect(container.querySelector("[data-session-last-activity]")).toBeNull();

    // Line 3's preview is the element that absorbs the freed width.
    const preview = container.querySelector("[data-session-preview-source]") as HTMLElement;
    expect(preview.className).toContain("flex-1");
    expect(preview.className).toContain("min-w-0");
    expect(preview.parentElement!.contains(delta)).toBe(false);
  });

  it("gives the freed slot to a lineage badge, with navigation left on the hover card", () => {
    const { container } = render(
      <SessionCard
        session={makeSession({
          orchestrationParentSessionId: "parent-9",
          spawnKind: "subagent",
        })}
        lane={branchLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        parentSessionTitle="Lead orchestrator"
      />,
    );

    const lineage = screen.getByTestId("session-spawn-lineage");
    // ADE's own spawn primitive, not the parent's title.
    expect(lineage.textContent).toContain("Subagent");
    expect(lineage.textContent).not.toContain("Lead orchestrator");
    // It sits on line 1, in the slot the repeated branch used to occupy.
    const statusSlot = container.querySelector("[data-session-status-slot]") as HTMLElement;
    expect(statusSlot.parentElement!.contains(lineage)).toBe(true);
    expect(container.querySelector("[data-session-branch]")).toBeNull();
  });

  it("keeps the cross-machine marker as identity, outside the status slot", () => {
    const { container } = render(
      <SessionCard
        session={makeSession()}
        lane={branchLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        runtimePin={{
          kind: "remote",
          key: "remote:studio",
          targetId: "studio",
          runtimeName: "Mac Studio",
          projectId: "p1",
          rootPath: "/repo",
          displayName: "ADE",
        }}
      />,
    );

    const marker = container.querySelector("[data-session-machine]") as HTMLElement;
    expect(marker.getAttribute("data-session-machine")).toBe("Mac Studio");
    expect(container.querySelector("[data-session-status-slot]")?.contains(marker)).toBe(false);
  });

  it("labels a local runtime pin with the machine, not the project display name", () => {
    const { container } = render(
      <SessionCard
        session={makeSession()}
        lane={branchLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        runtimePin={{
          kind: "local",
          key: "local:/repo",
          rootPath: "/repo",
          displayName: "t3code-6754bb34",
        }}
      />,
    );

    const marker = container.querySelector("[data-session-machine]") as HTMLElement;
    expect(marker.getAttribute("data-session-machine")).toBe("This Mac");
    expect(marker.textContent).not.toContain("t3code-6754bb34");
  });

  it("drops the machine chip when the lane header already names the machine — but keeps the fact", () => {
    // Every row under that header is on that machine, so the chip is pure
    // repetition. Suppression is about the ROW, not about losing the fact: the
    // detail card still answers "which machine is this on?".
    vi.useFakeTimers();
    const { container } = render(
      <SessionCard
        session={makeSession()}
        lane={branchLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        runtimePin={{
          kind: "remote",
          key: "remote:studio",
          targetId: "studio",
          runtimeName: "Mac Studio",
          projectId: "p1",
          rootPath: "/repo",
          displayName: "ADE",
        }}
        suppressMachineChip
      />,
    );

    expect(container.querySelector("[data-session-machine]")).toBeNull();
    openRowTooltip(container);
    expect(hoverRow("machine").textContent).toContain("Mac Studio");
  });
});

describe("SessionCard snooze and woke overlays", () => {
  it("shows a snoozed row's return ticket as its status and offers Wake now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    const { container } = render(
      <SessionCard
        session={makeSession({
          snoozedUntil: "2026-07-09T15:00:00.000Z",
          snoozedAt: "2026-07-09T11:00:00.000Z",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const status = container.querySelector("[data-session-status]")!;
    expect(status.getAttribute("data-session-status")).toBe("wakes in 3h");
    expect(status.getAttribute("data-session-tone")).toBe("neutral");
    expect(screen.getByRole("button", { name: "Wake session now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Snooze session" })).toBeNull();
  });

  it("reads a woken row as Woke and keeps the reason in the tooltip-free status slot", () => {
    const { container } = render(
      <SessionCard
        session={makeSession({
          wokeAt: "2026-07-09T12:00:00.000Z",
          wokeReason: "needs_you",
        })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    const status = container.querySelector("[data-session-status]")!;
    expect(status.getAttribute("data-session-status")).toBe("Woke");
    expect(status.getAttribute("data-session-tone")).toBe("amber");
  });

  it("labels the hover control for a row that is not snoozed", () => {
    render(
      <SessionCard
        session={makeSession()}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Snooze session" })).toBeTruthy();
  });

  it("moves the next-wake countdown into the detail card", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    const { container } = render(
      <SessionCard
        session={makeSession({ nextWakeAt: "2026-07-09T12:05:00.000Z" })}
        lane={lane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.queryByText("⏰ 5m")).toBeNull();
    openRowTooltip(container);
    // The countdown is recomputed on render, so it reflects the fake clock at
    // the moment the card opened, not at mount.
    expect(hoverRow("next-wake").textContent).toContain("Wakes in 5m");
  });
});

describe("SessionCard hover detail card", () => {
  const accentLane = {
    ...lane,
    color: "#ff8800",
    branchRef: "refs/heads/ade/redesign-new-chat-ui",
  } as LaneSummary;

  function renderCard(overrides: Partial<TerminalSessionSummary> = {}) {
    return render(
      <SessionCard
        session={makeSession(overrides)}
        lane={accentLane}
        isSelected={false}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
  }

  it("stays closed while the pointer is only skimming the row", () => {
    vi.useFakeTimers();
    const { container } = renderCard();

    fireEvent.mouseEnter(rowWrapper(container));
    act(() => {
      vi.advanceTimersByTime(SESSION_HOVER_CARD_DELAY_MS - 100);
    });
    // A detail card, not a tooltip: skimming a list must never open one.
    expect(screen.queryByTestId("session-hover-card")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("session-hover-card")).toBeTruthy();
  });

  it("cancels the pending card when the pointer leaves before the delay", () => {
    vi.useFakeTimers();
    const { container } = renderCard();

    fireEvent.mouseEnter(rowWrapper(container));
    act(() => {
      vi.advanceTimersByTime(SESSION_HOVER_CARD_DELAY_MS - 500);
    });
    fireEvent.mouseLeave(rowWrapper(container));
    act(() => {
      vi.advanceTimersByTime(SESSION_HOVER_CARD_DELAY_MS * 2);
    });

    expect(screen.queryByTestId("session-hover-card")).toBeNull();
  });

  it("hands an open hover card directly to the next session with no delay", () => {
    vi.useFakeTimers();
    const { container } = render(
      <>
        <SessionCard
          session={makeSession({ id: "session-a", title: "First chat", manuallyNamed: true })}
          lane={accentLane}
          isSelected={false}
          onSelect={vi.fn()}
          onContextMenu={vi.fn()}
        />
        <SessionCard
          session={makeSession({ id: "session-b", title: "Second chat", manuallyNamed: true })}
          lane={accentLane}
          isSelected={false}
          onSelect={vi.fn()}
          onContextMenu={vi.fn()}
        />
      </>,
    );
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>("[data-session-row]"),
    );

    fireEvent.mouseEnter(first!);
    act(() => {
      vi.advanceTimersByTime(SESSION_HOVER_CARD_DELAY_MS);
    });
    expect(screen.getByTestId("session-hover-card").textContent).toContain("First chat");

    fireEvent.mouseLeave(first!, { relatedTarget: second });
    fireEvent.mouseEnter(second!, { relatedTarget: first });

    const handedOffCard = screen.getByTestId("session-hover-card");
    expect(handedOffCard.textContent).toContain("Second chat");
    expect(handedOffCard.textContent).not.toContain("First chat");
    expect(screen.getAllByTestId("session-hover-card")).toHaveLength(1);
  });

  it("starts the full delay when the next session is entered from outside a session row", () => {
    vi.useFakeTimers();
    const { container } = render(
      <>
        <SessionCard
          session={makeSession({ id: "session-a", title: "First chat", manuallyNamed: true })}
          lane={accentLane}
          isSelected={false}
          onSelect={vi.fn()}
          onContextMenu={vi.fn()}
        />
        <SessionCard
          session={makeSession({ id: "session-b", title: "Second chat", manuallyNamed: true })}
          lane={accentLane}
          isSelected={false}
          onSelect={vi.fn()}
          onContextMenu={vi.fn()}
        />
      </>,
    );
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>("[data-session-row]"),
    );

    fireEvent.mouseEnter(first!);
    act(() => {
      vi.advanceTimersByTime(SESSION_HOVER_CARD_DELAY_MS);
    });
    fireEvent.mouseLeave(first!, { relatedTarget: document.body });
    fireEvent.mouseEnter(second!, { relatedTarget: document.body });

    act(() => {
      vi.advanceTimersByTime(SESSION_HOVER_CARD_DELAY_MS - 1);
    });
    expect(screen.queryByTestId("session-hover-card")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("session-hover-card").textContent).toContain("Second chat");
  });

  it("closes an open card on pointer-leave and on scroll", () => {
    vi.useFakeTimers();
    const { container } = renderCard();

    openRowTooltip(container);
    fireEvent.mouseLeave(rowWrapper(container));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId("session-hover-card")).toBeNull();

    // Reopen from the row after the full cold delay, then cancel on scroll.
    fireEvent.mouseEnter(rowWrapper(container));
    act(() => {
      vi.advanceTimersByTime(SESSION_HOVER_CARD_DELAY_MS);
    });
    expect(screen.getByTestId("session-hover-card")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByTestId("session-hover-card")).toBeNull();
  });

  it("cancels a pending card when the list scrolls during the open delay", () => {
    vi.useFakeTimers();
    const { container } = renderCard();

    fireEvent.mouseEnter(rowWrapper(container));
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(SESSION_HOVER_CARD_DELAY_MS + 50);
    });

    expect(screen.queryByTestId("session-hover-card")).toBeNull();
  });

  it("keeps the lane accented and the branch muted, never crossed", () => {
    vi.useFakeTimers();
    const { container } = renderCard();

    openRowTooltip(container);

    const laneIcon = hoverRow("lane").querySelector(".ade-vcs-lane-icon") as SVGElement;
    expect(laneIcon).toBeTruthy();
    expect(laneIcon.style.color).toBe("rgb(255, 136, 0)");

    const branchRow = hoverRow("branch");
    const branchIcon = branchRow.querySelector(".ade-vcs-branch-icon") as SVGElement;
    expect(branchIcon).toBeTruthy();
    // Muted class, and NO lane accent leaking onto the branch.
    expect(branchIcon.getAttribute("class")).toContain("text-muted-fg");
    expect(branchIcon.style.color).toBe("");
    // Same display trim as the row; the real ref is untouched elsewhere.
    expect(branchRow.textContent).toBe("redesign-new-chat-ui");
  });

  it("opens the parent thread from the lineage row", () => {
    vi.useFakeTimers();
    const dispatched: CustomEvent[] = [];
    const handler = (event: Event) => dispatched.push(event as CustomEvent);
    window.addEventListener("ade:work:select-session", handler);
    try {
      const { container } = renderCard({ orchestrationParentSessionId: "parent-7" });
      openRowTooltip(container);

      act(() => {
        screen.getByTestId("session-hover-parent-thread").click();
      });

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.detail).toMatchObject({ sessionId: "parent-7" });
    } finally {
      window.removeEventListener("ade:work:select-session", handler);
    }
  });
});
