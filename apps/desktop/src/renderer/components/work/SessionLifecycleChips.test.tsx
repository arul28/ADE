/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import { SessionLifecycleChips } from "./SessionLifecycleChips";

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

describe("SessionLifecycleChips", () => {
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
    const { container } = render(<SessionLifecycleChips sessionId="session-1" />);
    expect(container.textContent).toBe("");
  });

  it("shows a snoozed chip that offers Wake now", async () => {
    seedSessions([makeSession({
      snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      snoozedAt: new Date(Date.now() - 60_000).toISOString(),
    })]);
    render(<SessionLifecycleChips sessionId="session-1" />);

    fireEvent.click(screen.getByTestId("chat-session-snoozed-chip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Wake now" }));

    await waitFor(() => expect(sessionsApi.wakeSession).toHaveBeenCalledWith("session-1", "manual"));
  });

  it("shows a settled chip and unsettles a DERIVED settle through the keep-active override", async () => {
    seedSessions([makeSession({
      toolType: "shell",
      status: "completed",
      runtimeState: "exited",
      endedAt: "2026-07-09T11:00:00.000Z",
      exitCode: 0,
      settledAt: null,
    })]);
    render(<SessionLifecycleChips sessionId="session-1" />);

    fireEvent.click(screen.getByTestId("chat-session-settled-chip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unsettle" }));

    await waitFor(() => expect(sessionsApi.setSettleOverride).toHaveBeenCalledWith("session-1", "active"));
    expect(sessionsApi.unsettle).not.toHaveBeenCalled();
  });

  it("clears a declared settle through the settle column", async () => {
    seedSessions([makeSession({
      status: "completed",
      runtimeState: "exited",
      endedAt: "2026-07-09T11:00:00.000Z",
      settledAt: "2026-07-09T11:01:00.000Z",
    })]);
    render(<SessionLifecycleChips sessionId="session-1" />);

    fireEvent.click(screen.getByTestId("chat-session-settled-chip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unsettle" }));

    await waitFor(() => expect(sessionsApi.unsettle).toHaveBeenCalledWith("session-1"));
    expect(sessionsApi.setSettleOverride).not.toHaveBeenCalled();
  });

  it("surfaces a failed unsettle instead of swallowing it", async () => {
    // Regression: the chip used to call `unsettle` with a bare `.catch(() => {})`,
    // so a rejected write left the settled chip in place with no feedback.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionsApi.unsettle.mockRejectedValue(new Error("host refused"));
    seedSessions([makeSession({
      status: "completed",
      runtimeState: "exited",
      endedAt: "2026-07-09T11:00:00.000Z",
      settledAt: "2026-07-09T11:01:00.000Z",
    })]);
    render(<SessionLifecycleChips sessionId="session-1" />);

    fireEvent.click(screen.getByTestId("chat-session-settled-chip"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unsettle" }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unsettle failed", message: "host refused", tone: "error" }),
    ));
    consoleError.mockRestore();
  });
});
