/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { ChatLifecycleBanner } from "./ChatLifecycleBanner";

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

/** A session with a declared settle at rest — the only way to reach `settled`. */
function settledOverrides(): Partial<TerminalSessionSummary> {
  return {
    status: "completed",
    runtimeState: "exited",
    endedAt: "2026-07-09T11:00:00.000Z",
    settledAt: "2026-07-09T11:01:00.000Z",
  };
}

function snoozedOverrides(): Partial<TerminalSessionSummary> {
  return {
    snoozedAt: new Date(Date.now() - 60_000).toISOString(),
    snoozedUntil: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  };
}

function seedSessions(sessions: TerminalSessionSummary[]): void {
  useAppStore.setState({
    project: { rootPath: PROJECT_ROOT } as never,
    projectBinding: null,
    sessionsCacheByProject: { [PROJECT_ROOT]: sessions },
  });
}

describe("ChatLifecycleBanner", () => {
  let sessionsApi: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    sessionsApi = {
      wakeSession: vi.fn().mockResolvedValue(true),
      unsettle: vi.fn().mockResolvedValue(undefined),
      unsettleMany: vi.fn().mockResolvedValue(undefined),
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

  it("renders nothing for a live chat, so the composer never moves", () => {
    seedSessions([makeSession()]);
    const { container } = render(<ChatLifecycleBanner sessionId="session-1" />);
    // Not an empty placeholder box: literally no node.
    expect(container.firstChild).toBeNull();
  });

  it("renders the settled variant with copy that matches ADE's settle semantics", () => {
    seedSessions([makeSession(settledOverrides())]);
    render(<ChatLifecycleBanner sessionId="session-1" />);

    const banner = screen.getByTestId("chat-lifecycle-banner");
    expect(banner.getAttribute("data-lifecycle-variant")).toBe("settled");
    expect(banner.textContent).toContain("This chat is settled");
    // `settledAt` is cleared at the write site on real activity, so sending is
    // what un-settles it.
    expect(banner.textContent).toContain("Sending a message clears the settle");
    // Emerald means "finished cleanly"; amber is reserved for "your move".
    expect(banner.className).toContain("emerald");
    expect(banner.className).not.toContain("amber");
  });

  it("renders the snoozed variant naming when it comes back, in neutral chrome", () => {
    seedSessions([makeSession(snoozedOverrides())]);
    render(<ChatLifecycleBanner sessionId="session-1" />);

    const banner = screen.getByTestId("chat-lifecycle-banner");
    expect(banner.getAttribute("data-lifecycle-variant")).toBe("snoozed");
    expect(banner.textContent).toContain("This chat is snoozed");
    expect(banner.textContent).toContain("Hidden from the sidebar until");
    // Snooze is a visibility overlay, so it gets neither emerald nor amber.
    expect(banner.className).not.toContain("emerald");
    expect(banner.className).not.toContain("amber");
  });

  it("names the open-ended wake condition rather than a ~100-year date", () => {
    seedSessions([makeSession({
      snoozedAt: new Date(Date.now() - 60_000).toISOString(),
      snoozedUntil: new Date(Date.now() + 100 * 365 * 24 * 3_600_000).toISOString(),
    })]);
    render(<ChatLifecycleBanner sessionId="session-1" />);

    expect(screen.getByTestId("chat-lifecycle-banner").textContent).toContain(
      "until when you're asked",
    );
  });

  it("gives Un-settle and Wake now the same fill on hover and on keyboard focus", () => {
    // The one control that undoes the state the banner describes, so it has to
    // read as pressable for pointer AND keyboard users — focus-visible mirrors
    // hover rather than relying on a default outline.
    seedSessions([makeSession(settledOverrides())]);
    render(<ChatLifecycleBanner sessionId="session-1" />);
    const settledButton = screen.getByTestId("chat-lifecycle-unsettle");
    expect(settledButton.className).toContain("hover:bg-emerald-400/[0.13]");
    expect(settledButton.className).toContain("focus-visible:bg-emerald-400/[0.13]");

    cleanup();
    seedSessions([makeSession(snoozedOverrides())]);
    render(<ChatLifecycleBanner sessionId="session-1" />);
    const snoozedButton = screen.getByTestId("chat-lifecycle-wake");
    expect(snoozedButton.className).toContain("hover:bg-white/[0.07]");
    expect(snoozedButton.className).toContain("focus-visible:bg-white/[0.07]");
  });

  it("lets snooze win when a chat is both snoozed and settled", () => {
    // Matches the overlay precedence in `sessionStatusPresentation`: the overlay
    // is resolved above the phase.
    seedSessions([makeSession({ ...settledOverrides(), ...snoozedOverrides() })]);
    render(<ChatLifecycleBanner sessionId="session-1" />);

    expect(screen.getByTestId("chat-lifecycle-banner").getAttribute("data-lifecycle-variant"))
      .toBe("snoozed");
    expect(screen.getByTestId("chat-lifecycle-wake")).toBeTruthy();
    expect(screen.queryByTestId("chat-lifecycle-unsettle")).toBeNull();
  });

  it("clears the settle through the pin-aware single-session write", async () => {
    seedSessions([makeSession(settledOverrides())]);
    render(<ChatLifecycleBanner sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Un-settle" }));

    await waitFor(() => expect(sessionsApi.unsettle).toHaveBeenCalledWith("session-1"));
    // `unsettleMany` exists but ignores the runtime pin and reports no failure;
    // the shared lifecycle action is the one both the sidebar and the header
    // chip use.
    expect(sessionsApi.unsettleMany).not.toHaveBeenCalled();
    expect(sessionsApi.setSettleOverride).not.toHaveBeenCalled();
  });

  it("wakes a snoozed chat with the manual reason", async () => {
    seedSessions([makeSession(snoozedOverrides())]);
    render(<ChatLifecycleBanner sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Wake now" }));

    await waitFor(() => expect(sessionsApi.wakeSession).toHaveBeenCalledWith("session-1", "manual"));
  });
});
