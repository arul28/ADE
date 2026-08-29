/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { SessionSnoozeChip } from "./SessionLifecycleChips";

const PROJECT_ROOT = "/tmp/project";

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "Lane 1",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "codex-chat",
    title: "Codex chat",
    status: "running",
    startedAt: "2026-07-09T10:00:00.000Z",
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

function seedSessions(sessions: TerminalSessionSummary[]): void {
  useAppStore.setState({
    project: { rootPath: PROJECT_ROOT } as never,
    projectBinding: null,
    sessionsCacheByProject: { [PROJECT_ROOT]: sessions },
    crossMachineLanesByMachineId: {},
  });
}

function seedForeignSessions(sessions: TerminalSessionSummary[]): void {
  useAppStore.setState({
    project: { rootPath: PROJECT_ROOT } as never,
    projectBinding: null,
    sessionsCacheByProject: { [PROJECT_ROOT]: [] },
    crossMachineLanesByMachineId: {
      "machine-foreign": {
        machineId: "machine-foreign",
        machineName: "Mac Studio (12)",
        targetId: "target-foreign",
        projectId: "project-foreign",
        binding: {
          kind: "remote",
          key: "remote:target-foreign:project-foreign",
          targetId: "target-foreign",
          runtimeName: "Mac Studio (12)",
          projectId: "project-foreign",
          rootPath: "/repo-foreign",
          displayName: "Foreign repo",
        },
        online: true,
        lanes: [],
        sessions,
        prs: [],
        lastSyncedAtMs: Date.now(),
        error: null,
      },
    },
  } as never);
}

describe("SessionSnoozeChip", () => {
  let sessionsApi: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    sessionsApi = {
      wakeSession: vi.fn().mockResolvedValue(true),
    };
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { sessions: sessionsApi },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    useAppStore.setState({ sessionsCacheByProject: {} });
    useAppStore.setState({ crossMachineLanesByMachineId: {} });
    Reflect.deleteProperty(window, "ade");
    vi.clearAllMocks();
  });

  it("renders nothing for a live chat", () => {
    seedSessions([makeSession()]);
    const { container } = render(<SessionSnoozeChip sessionId="session-1" />);
    expect(container.textContent).toBe("");
  });

  it("shows a snoozed chip that offers Wake now", async () => {
    seedSessions([makeSession({
      snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      snoozedAt: new Date(Date.now() - 60_000).toISOString(),
    })]);
    render(<SessionSnoozeChip sessionId="session-1" />);

    fireEvent.click(screen.getByTestId("chat-session-snoozed-chip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Wake now" }));

    await waitFor(() => expect(sessionsApi.wakeSession).toHaveBeenCalledWith("session-1", "manual"));
  });

  it("does not render a header chip for settled sessions", () => {
    seedSessions([makeSession({
      status: "completed",
      runtimeState: "exited",
      endedAt: "2026-07-09T11:00:00.000Z",
      settledAt: "2026-07-09T11:01:00.000Z",
    })]);
    const { container } = render(<SessionSnoozeChip sessionId="session-1" />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("chat-session-settled-chip")).toBeNull();
  });

  it("resolves a foreign snoozed row and routes Wake now to its owning runtime", async () => {
    const foreign = makeSession({
      id: "foreign-session-1",
      snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      snoozedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const runtimePin = {
      kind: "remote" as const,
      key: "remote:target-foreign:project-foreign",
      targetId: "target-foreign",
      runtimeName: "Mac Studio (12)",
      projectId: "project-foreign",
      rootPath: "/repo-foreign",
      displayName: "Foreign repo",
    };
    seedForeignSessions([foreign]);
    render(<SessionSnoozeChip sessionId={foreign.id} runtimePin={runtimePin} />);

    expect(screen.getByTestId("chat-session-snoozed-chip")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-session-snoozed-chip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Wake now" }));

    await waitFor(() => expect(sessionsApi.wakeSession).toHaveBeenCalledWith(
      foreign.id,
      "manual",
      runtimePin,
    ));
  });

  it("repaints a foreign snoozed chip when its deadline expires", () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
    vi.setSystemTime(nowMs);
    seedForeignSessions([makeSession({
      id: "foreign-session-expiring",
      snoozedUntil: new Date(nowMs + 1_000).toISOString(),
      snoozedAt: new Date(nowMs - 60_000).toISOString(),
    })]);
    const { container } = render(<SessionSnoozeChip sessionId="foreign-session-expiring" />);

    expect(screen.getByTestId("chat-session-snoozed-chip")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1_250);
    });

    expect(container.firstChild).toBeNull();
  });
});
