/* @vitest-environment jsdom */

/**
 * The compact usage-limit pill above the composer and its anchored popover.
 *
 * What is worth pinning here is the wiring, not the markup: which state renders
 * which one-liner, and which bridge call each button in the popover makes. The
 * copy itself is covered by the shared presentation helper's own unit tests, so
 * these assertions stay at the level of "this button hit that API".
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentChatUsageLimitResume } from "../../../shared/types";
import { usageLimitResumePill } from "../../../shared/usageLimitResumePresentation";
import { ChatUsageLimitResumePill } from "./ChatUsageLimitResumePill";

const NOW = Date.parse("2026-09-08T19:28:00.000Z");

function resume(patch: Partial<AgentChatUsageLimitResume> = {}): AgentChatUsageLimitResume {
  return {
    state: "armed",
    provider: "claude",
    fireAt: new Date(NOW + 3 * 60_000).toISOString(),
    resetAt: new Date(NOW + 90_000).toISOString(),
    scheduleId: "auto-resume:session-1",
    attempts: 1,
    providerDetail: "Resets at 7:31 PM ET",
    turnId: "turn-limit",
    updatedAt: new Date(NOW).toISOString(),
    ...patch,
  };
}

type Bridge = {
  updateSession: ReturnType<typeof vi.fn>;
  resumeUsageLimitNow?: ReturnType<typeof vi.fn>;
};

function installBridge(options: { withResumeNow?: boolean } = {}): Bridge {
  const bridge: Bridge = { updateSession: vi.fn(async () => ({})) };
  if (options.withResumeNow !== false) {
    bridge.resumeUsageLimitNow = vi.fn(async () => ({ ok: true, turnId: "turn-resumed" }));
  }
  (window as unknown as { ade: unknown }).ade = { agentChat: bridge };
  return bridge;
}

function openPopover() {
  fireEvent.click(screen.getByTestId("usage-limit-resume-pill"));
  return screen.getByTestId("usage-limit-resume-popover");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ChatUsageLimitResumePill", () => {
  it("renders nothing when the host reports no live usage limit", () => {
    installBridge();
    const { container } = render(
      <ChatUsageLimitResumePill sessionId="session-1" resume={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one line per state, tagged with the state it came from", () => {
    installBridge();
    for (const state of ["armed", "resuming", "opted_out", "no_reset"] as const) {
      const value = resume(state === "no_reset" ? { state, fireAt: null, resetAt: null } : { state });
      render(<ChatUsageLimitResumePill sessionId="session-1" resume={value} />);
      const pill = screen.getByTestId("usage-limit-resume-pill");
      expect(pill.getAttribute("data-usage-limit-state")).toBe(state);
      // The accessible name carries the whole one-liner; `textContent` drops the
      // padding around the `·` separators, which are decorative spans. The copy
      // itself belongs to the shared presentation helper (and is asserted by its
      // own unit tests), so this pins the wiring, not a second copy of the words.
      expect(pill.getAttribute("aria-label")).toBe(usageLimitResumePill(value, NOW).ariaLabel);
      cleanup();
    }
  });

  it("ticks the countdown down without a second timer", () => {
    installBridge();
    render(
      <ChatUsageLimitResumePill sessionId="session-1" resume={resume()} />,
    );
    expect(screen.getByTestId("usage-limit-resume-pill").textContent).toContain("in 3 min");
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(screen.getByTestId("usage-limit-resume-pill").textContent).toContain("in 2 min 29 s");
  });

  it("sends the continue prompt through resumeUsageLimitNow", async () => {
    const bridge = installBridge();
    render(<ChatUsageLimitResumePill sessionId="session-1" resume={resume()} />);
    openPopover();

    fireEvent.click(screen.getByTestId("usage-limit-resume-primary"));
    await vi.waitFor(() => expect(bridge.resumeUsageLimitNow)
      .toHaveBeenCalledWith({ sessionId: "session-1" }, null));
    expect(bridge.updateSession).not.toHaveBeenCalled();
  });

  it("closes the popover once the host acknowledges the send", async () => {
    installBridge();
    render(<ChatUsageLimitResumePill sessionId="session-1" resume={resume()} />);
    openPopover();

    fireEvent.click(screen.getByTestId("usage-limit-resume-primary"));
    await vi.waitFor(() => expect(screen.queryByTestId("usage-limit-resume-popover")).toBeNull());
  });

  it("shows the host's refusal verbatim and keeps the popover open", async () => {
    // The host declines a stale or racing press and sends nothing. That is not
    // an error, but it has the same requirement: say why the button did
    // nothing, with Fork and Don't continue still under the cursor.
    const bridge = installBridge();
    bridge.resumeUsageLimitNow!.mockResolvedValue({
      ok: false,
      reason: "resume_in_flight",
      message: "This chat is already resuming. Wait for the current turn to start.",
    });
    render(<ChatUsageLimitResumePill sessionId="session-1" resume={resume()} />);
    openPopover();

    fireEvent.click(screen.getByTestId("usage-limit-resume-primary"));
    const alert = await vi.waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toBe("This chat is already resuming. Wait for the current turn to start.");
    expect(screen.getByTestId("usage-limit-resume-popover")).toBeTruthy();
    expect(screen.getByTestId("usage-limit-resume-fork")).toBeTruthy();
  });

  it("explains itself instead of throwing when the runtime has no resume bridge yet", async () => {
    installBridge({ withResumeNow: false });
    render(<ChatUsageLimitResumePill sessionId="session-1" resume={resume()} />);
    openPopover();

    fireEvent.click(screen.getByTestId("usage-limit-resume-primary"));
    const alert = await vi.waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain("can't resume yet");
    // The popover stays open so the user can still fork or opt out.
    expect(screen.getByTestId("usage-limit-resume-popover")).toBeTruthy();
  });

  it("opts the chat out through updateSession", async () => {
    const bridge = installBridge();
    render(
      <ChatUsageLimitResumePill sessionId="session-1" resume={resume()} runtimePin={null} />,
    );
    openPopover();

    fireEvent.click(screen.getByTestId("usage-limit-resume-opt-out"));
    await vi.waitFor(() => expect(bridge.updateSession).toHaveBeenCalledWith(
      { sessionId: "session-1", autoContinueAtUsageLimit: false },
      null,
    ));
  });

  it("re-arms a paused streak with Try again rather than resuming it", async () => {
    const bridge = installBridge();
    render(
      <ChatUsageLimitResumePill
        sessionId="session-1"
        resume={resume({ state: "paused", attempts: 2 })}
      />,
    );
    const popover = openPopover();
    expect(popover.textContent).toContain("Try again");

    fireEvent.click(screen.getByTestId("usage-limit-resume-primary"));
    await vi.waitFor(() => expect(bridge.updateSession).toHaveBeenCalledWith(
      { sessionId: "session-1", autoContinueAtUsageLimit: true },
      null,
    ));
    expect(bridge.resumeUsageLimitNow).not.toHaveBeenCalled();
  });

  it("hides Don't continue once auto-resume is already off", () => {
    installBridge();
    render(
      <ChatUsageLimitResumePill sessionId="session-1" resume={resume({ state: "opted_out" })} />,
    );
    openPopover();
    expect(screen.queryByTestId("usage-limit-resume-opt-out")).toBeNull();
    expect(screen.getByTestId("usage-limit-resume-primary").textContent).toBe("Turn on");
  });

  it("forks through the same card-action event the quota card dispatches", () => {
    installBridge();
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener("ade:chat:card-action", listener);
    try {
      render(<ChatUsageLimitResumePill sessionId="session-1" resume={resume()} />);
      openPopover();
      fireEvent.click(screen.getByTestId("usage-limit-resume-fork"));
    } finally {
      window.removeEventListener("ade:chat:card-action", listener);
    }
    expect(seen).toEqual([{ actionId: "fork-local", sessionId: "session-1" }]);
    // Forking hands the chat over to the handoff pane, so the popover gets out of the way.
    expect(screen.queryByTestId("usage-limit-resume-popover")).toBeNull();
  });

  it("shows the provider's own sentence verbatim, behind the details toggle", () => {
    installBridge();
    render(
      <ChatUsageLimitResumePill
        sessionId="session-1"
        resume={resume({ providerDetail: "5-hour limit resets at 7:31 PM ET" })}
      />,
    );
    openPopover();
    expect(screen.queryByTestId("usage-limit-resume-details")).toBeNull();

    fireEvent.click(screen.getByTestId("usage-limit-resume-details-toggle"));
    expect(screen.getByTestId("usage-limit-resume-details").textContent)
      .toBe("5-hour limit resets at 7:31 PM ET");
  });

  it("orphans an action the host state outran, instead of letting it publish late", async () => {
    // The pill's state is replaced under it while a press is in flight — the
    // host armed a resume, or the user opted out from another surface. The old
    // promise must land on the floor: no refusal sentence about a state nobody
    // is looking at, and no `busy` clear stealing the newer press.
    const bridge = installBridge();
    let settle: ((value: { ok: boolean; reason: string; message: string }) => void) | null = null;
    bridge.resumeUsageLimitNow!.mockReturnValue(new Promise((resolveWith) => { settle = resolveWith; }));
    const view = render(
      <ChatUsageLimitResumePill sessionId="session-1" resume={resume()} />,
    );
    openPopover();
    fireEvent.click(screen.getByTestId("usage-limit-resume-primary"));
    expect(screen.getByTestId("usage-limit-resume-primary").hasAttribute("disabled")).toBe(true);

    // The host publishes a new state while the send is still in flight.
    view.rerender(<ChatUsageLimitResumePill sessionId="session-1" resume={resume({ state: "resuming" })} />);
    expect(screen.getByTestId("usage-limit-resume-primary").hasAttribute("disabled")).toBe(false);

    await act(async () => {
      settle!({ ok: false, reason: "resume_in_flight", message: "This chat is already resuming." });
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("usage-limit-resume-popover")).toBeTruthy();

    // And the freed pill still takes a new press.
    fireEvent.click(screen.getByTestId("usage-limit-resume-primary"));
    expect(bridge.resumeUsageLimitNow).toHaveBeenCalledTimes(2);
  });

  it("does not carry an open popover, an error, or a stale send across a chat switch", async () => {
    // The pane renders ONE pill instance and swaps its `sessionId`, so nothing
    // that belongs to the outgoing chat may survive the swap.
    const bridge = installBridge();
    let settle: ((value: { ok: boolean; reason: string; message: string }) => void) | null = null;
    bridge.resumeUsageLimitNow!.mockReturnValue(new Promise((resolveWith) => { settle = resolveWith; }));
    const view = render(
      <ChatUsageLimitResumePill sessionId="session-1" resume={resume()} />,
    );
    openPopover();
    fireEvent.click(screen.getByTestId("usage-limit-resume-primary"));

    view.rerender(<ChatUsageLimitResumePill sessionId="session-2" resume={resume()} />);
    expect(screen.queryByTestId("usage-limit-resume-popover")).toBeNull();

    await act(async () => {
      settle!({ ok: false, reason: "no_live_usage_limit", message: "Nothing to resume." });
      await Promise.resolve();
    });
    // Session 1's refusal must not surface under session 2.
    openPopover();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByTestId("usage-limit-resume-primary"));
    expect(bridge.resumeUsageLimitNow).toHaveBeenLastCalledWith({ sessionId: "session-2" }, null);
  });

  it("closes on Escape", () => {
    installBridge();
    render(<ChatUsageLimitResumePill sessionId="session-1" resume={resume()} />);
    openPopover();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("usage-limit-resume-popover")).toBeNull();
  });
});
