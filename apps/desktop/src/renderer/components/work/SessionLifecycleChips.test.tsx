/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { SessionSnoozeChip } from "./SessionLifecycleChips";

vi.mock("../app/toast/toastStore", () => ({
  showToast: vi.fn(),
}));

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
  });
}

describe("SessionSnoozeChip", () => {
  let sessionsApi: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    sessionsApi = {
      wakeSession: vi.fn().mockResolvedValue(true),
      unsettle: vi.fn().mockResolvedValue(undefined),
      setSettleOverride: vi.fn().mockResolvedValue(true),
    };
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { sessions: sessionsApi },
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ sessionsCacheByProject: {} });
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
    expect(sessionsApi.unsettle).not.toHaveBeenCalled();
    expect(sessionsApi.setSettleOverride).not.toHaveBeenCalled();
  });
});
