/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LaneLifecycleEvent,
  RebaseRun,
  RebaseRunEventPayload,
} from "../../../../shared/types";

import {
  dismissToast,
  getToasts,
  pauseToast,
  resumeToast,
  showToast,
  updateToast,
} from "./toastStore";
import { ToastStack } from "./ToastStack";
import { useLaneEventToasts } from "./useLaneEventToasts";
import { useAutoDiagnosticsToast } from "./useAutoDiagnosticsToast";
import type { DiagnosticsAutoSentPayload } from "../../../../shared/types/diagnostics";

// The store is a module-level singleton with no reset hook; each test clears
// the stack it created so state doesn't leak between cases.
function clearAll(): void {
  for (const toast of [...getToasts()]) dismissToast(toast.id);
}

describe("toastStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAll();
  });

  afterEach(() => {
    cleanup();
    clearAll();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("caps the stack at 4, dropping the oldest and keeping newest at the end", () => {
    const ids = [1, 2, 3, 4, 5].map((n) => showToast({ title: `t${n}` }));
    const stack = getToasts();
    expect(stack).toHaveLength(4);
    // Oldest (ids[0]) dropped; order is oldest -> newest.
    expect(stack.map((t) => t.id)).toEqual([ids[1], ids[2], ids[3], ids[4]]);
    expect(stack[stack.length - 1].title).toBe("t5");
  });

  it("auto-dismisses after the default duration", () => {
    showToast({ title: "hi" });
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(5999);
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0);
  });

  it("honors an explicit durationMs", () => {
    showToast({ id: "a", title: "hi", durationMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0);
  });

  it("does not auto-dismiss when durationMs <= 0", () => {
    showToast({ id: "sticky", title: "hi", durationMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(getToasts()).toHaveLength(1);
  });

  it("pauses and resumes with the remaining time", () => {
    showToast({ id: "a", title: "hi", durationMs: 6000 });
    vi.advanceTimersByTime(2000);
    pauseToast("a");
    // Frozen: no amount of time dismisses it while paused.
    vi.advanceTimersByTime(10_000);
    expect(getToasts()).toHaveLength(1);
    resumeToast("a");
    // 4000ms remained (6000 - 2000 elapsed).
    vi.advanceTimersByTime(3999);
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0);
  });

  it("resume is a no-op when never paused", () => {
    showToast({ id: "a", title: "hi", durationMs: 6000 });
    resumeToast("a");
    vi.advanceTimersByTime(6000);
    expect(getToasts()).toHaveLength(0);
  });

  it("merge-patches an existing toast without touching untouched fields", () => {
    showToast({ id: "a", title: "orig", message: "m", tone: "info" });
    updateToast("a", { title: "patched" });
    const toast = getToasts().find((t) => t.id === "a");
    expect(toast?.title).toBe("patched");
    expect(toast?.message).toBe("m");
    expect(toast?.tone).toBe("info");
  });

  it("updateToast resets the timer only when durationMs is patched", () => {
    showToast({ id: "a", title: "hi", durationMs: 6000 });
    vi.advanceTimersByTime(5000);
    // Patch without durationMs: timer keeps counting from the original start.
    updateToast("a", { title: "still counting" });
    vi.advanceTimersByTime(1000);
    expect(getToasts()).toHaveLength(0);
  });

  it("updateToast with durationMs restarts the countdown", () => {
    showToast({ id: "a", title: "hi", durationMs: 6000 });
    vi.advanceTimersByTime(5000);
    updateToast("a", { durationMs: 3000 });
    // Old timer would have fired at 6000; new one runs a fresh 3000.
    vi.advanceTimersByTime(1000);
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(getToasts()).toHaveLength(0);
  });

  it("updateToast is a no-op for unknown ids", () => {
    updateToast("nope", { title: "x" });
    expect(getToasts()).toHaveLength(0);
  });

  it("showToast with an existing id replaces in place and keeps position", () => {
    const a = showToast({ title: "a" });
    showToast({ title: "b" });
    showToast({ id: a, title: "a-updated" });
    const stack = getToasts();
    expect(stack).toHaveLength(2);
    expect(stack[0].id).toBe(a);
    expect(stack[0].title).toBe("a-updated");
  });

  it("dismissToast removes the toast and clears its timer", () => {
    showToast({ id: "a", title: "hi", durationMs: 6000 });
    dismissToast("a");
    expect(getToasts()).toHaveLength(0);
    // No lingering timer should fire and error.
    vi.advanceTimersByTime(6000);
    expect(getToasts()).toHaveLength(0);
  });
});

type LaneEventHarnessProps = {
  navigate: Parameters<typeof useLaneEventToasts>[0];
};

function LaneEventHarness({ navigate }: LaneEventHarnessProps) {
  useLaneEventToasts(navigate);
  return null;
}

function installLaneEventApi() {
  let lifecycleListener: ((event: LaneLifecycleEvent) => void) | null = null;
  let rebaseListener: ((event: RebaseRunEventPayload) => void) | null = null;
  const lanes = {
    onLifecycleEvent: vi.fn((listener: (event: LaneLifecycleEvent) => void) => {
      lifecycleListener = listener;
      return () => {
        if (lifecycleListener === listener) lifecycleListener = null;
      };
    }),
    rebaseSubscribe: vi.fn((listener: (event: RebaseRunEventPayload) => void) => {
      rebaseListener = listener;
      return () => {
        if (rebaseListener === listener) rebaseListener = null;
      };
    }),
  };

  Object.defineProperty(window, "ade", {
    configurable: true,
    value: { lanes },
  });

  return {
    lanes,
    emitLifecycle: (event: LaneLifecycleEvent) => lifecycleListener?.(event),
    emitRebase: (event: RebaseRunEventPayload) => rebaseListener?.(event),
    hasLifecycleListener: () => lifecycleListener !== null,
    hasRebaseListener: () => rebaseListener !== null,
  };
}

function makeRebaseRun(overrides: Partial<RebaseRun> = {}): RebaseRun {
  return {
    runId: "run-1",
    rootLaneId: "lane-1",
    scope: "lane_only",
    pushMode: "none",
    state: "completed",
    startedAt: "2026-07-02T12:00:00.000Z",
    finishedAt: "2026-07-02T12:00:01.000Z",
    actor: "auto",
    baseBranch: null,
    lanes: [
      {
        laneId: "lane-1",
        laneName: "Root Lane",
        parentLaneId: null,
        status: "succeeded",
        preHeadSha: null,
        postHeadSha: "sha-after",
        error: null,
        conflictingFiles: [],
        pushed: false,
      },
    ],
    currentLaneId: null,
    failedLaneId: null,
    error: null,
    pushedLaneIds: [],
    canRollback: false,
    ...overrides,
  };
}

describe("useLaneEventToasts", () => {
  it("turns lane-created lifecycle events into navigable success toasts", () => {
    const api = installLaneEventApi();
    const navigate = vi.fn();
    render(React.createElement(LaneEventHarness, { navigate }));

    expect(api.lanes.onLifecycleEvent).toHaveBeenCalledTimes(1);
    expect(api.hasLifecycleListener()).toBe(true);

    api.emitLifecycle({
      type: "lane-created",
      laneId: "lane-1",
      laneName: "Feature Lane",
      color: "#ffaa00",
    });

    const [toast] = getToasts();
    expect(toast).toMatchObject({
      id: "lane-lane-created-lane-1",
      title: "Feature Lane",
      message: "Lane created",
      tone: "success",
      colorDot: "#ffaa00",
    });
    expect(toast?.action?.label).toBe("View");

    toast?.action?.onClick();
    expect(navigate).toHaveBeenCalledWith("/lanes?laneId=lane-1&focus=single");
  });

  it("skips user rebase success toasts but surfaces automated success and failures", () => {
    const api = installLaneEventApi();
    render(React.createElement(LaneEventHarness, { navigate: vi.fn() }));

    expect(api.lanes.rebaseSubscribe).toHaveBeenCalledTimes(1);
    expect(api.hasRebaseListener()).toBe(true);
    clearAll();
    expect(getToasts()).toHaveLength(0);

    api.emitRebase({
      type: "rebase-run-updated",
      run: makeRebaseRun({ actor: "user", runId: "run-user" }),
      timestamp: "2026-07-02T12:00:01.000Z",
    });
    expect(getToasts()).toHaveLength(0);

    api.emitRebase({
      type: "rebase-run-updated",
      run: makeRebaseRun({ actor: "auto", runId: "run-auto" }),
      timestamp: "2026-07-02T12:00:02.000Z",
    });
    expect(getToasts()[0]).toMatchObject({
      id: "lane-rebase-run-auto",
      title: "Root Lane",
      message: "Rebase completed",
      tone: "success",
    });

    api.emitRebase({
      type: "rebase-run-updated",
      run: makeRebaseRun({
        runId: "run-failed",
        state: "failed",
        failedLaneId: "lane-2",
        error: "conflict on package-lock.json",
        lanes: [
          {
            laneId: "lane-1",
            laneName: "Root Lane",
            parentLaneId: null,
            status: "succeeded",
            preHeadSha: null,
            postHeadSha: "sha-after",
            error: null,
            conflictingFiles: [],
            pushed: false,
          },
          {
            laneId: "lane-2",
            laneName: "Child Lane",
            parentLaneId: "lane-1",
            status: "conflict",
            preHeadSha: "sha-before",
            postHeadSha: null,
            error: "conflict on package-lock.json",
            conflictingFiles: ["package-lock.json"],
            pushed: false,
          },
        ],
      }),
      timestamp: "2026-07-02T12:00:03.000Z",
    });
    expect(getToasts()[1]).toMatchObject({
      id: "lane-rebase-run-failed",
      title: "Child Lane",
      message: "conflict on package-lock.json",
      tone: "error",
    });
  });
});

describe("useAutoDiagnosticsToast", () => {
  /** The real pairing: the subscriber and the toast host, as `AppShell` mounts them. */
  function AutoDiagnosticsHarness(): React.ReactElement {
    useAutoDiagnosticsToast();
    return React.createElement(ToastStack);
  }

  /** Subscriber with NO toast host — a notice that is queued and never shown. */
  function SubscriberOnlyHarness(): React.ReactElement | null {
    useAutoDiagnosticsToast();
    return null;
  }

  function installDiagnosticsApi() {
    let listener: ((payload: DiagnosticsAutoSentPayload) => void) | null = null;
    const bridge = {
      diagnostics: {
        openIssue: vi.fn(),
        onAutoSent: vi.fn((cb: (payload: DiagnosticsAutoSentPayload) => void) => {
          listener = cb;
          return () => {
            listener = null;
          };
        }),
        revealReport: vi.fn(async () => {}),
        setSharing: vi.fn(async () => ({ enabled: false, sendsInWindow: 1, limit: 3 })),
        ackAutoSent: vi.fn(async () => {}),
      },
    };
    Object.defineProperty(window, "ade", { value: bridge, configurable: true, writable: true });
    return {
      bridge,
      // Wrapped in `act` because the store update this triggers re-renders the
      // toast host, and the render is what reports delivery.
      emit: (payload: DiagnosticsAutoSentPayload) => {
        act(() => {
          listener?.(payload);
        });
      },
    };
  }

  beforeEach(() => {
    // The store is a module singleton and the suites above leave toasts behind.
    cleanup();
    clearAll();
  });

  afterEach(() => {
    delete (window as { ade?: unknown }).ade;
  });

  it("tells the user what was sent, and offers the report and the off switch", () => {
    const api = installDiagnosticsApi();
    render(React.createElement(AutoDiagnosticsHarness));

    api.emit({ failureCode: "disk_full", reportPath: "/reports/x.md", reference: "abcd1234" });

    const [toast] = getToasts();
    expect(toast).toMatchObject({
      title: "A diagnostic report was sent to ADE",
      message: "Reference abcd1234",
    });
    expect(toast?.action?.label).toBe("View");
    expect(toast?.secondaryAction?.label).toBe("Turn off");

    toast?.action?.onClick();
    expect(api.bridge.diagnostics.revealReport).toHaveBeenCalledWith("/reports/x.md");
    toast?.secondaryAction?.onClick();
    expect(api.bridge.diagnostics.setSharing).toHaveBeenCalledWith(false);
  });

  it("tells main the toast exists, so the next launch does not repeat it", () => {
    // The ack is the ONLY thing that retires a notice: main cannot tell that
    // `webContents.send` reached a live toast host, and listing the pending
    // ones on subscribe deliberately clears nothing. It goes out after the
    // toast, so a renderer that dies mid-render repeats one rather than
    // swallowing it.
    const api = installDiagnosticsApi();
    render(React.createElement(AutoDiagnosticsHarness));

    api.emit({ failureCode: "disk_full", reportPath: "/reports/x.md", reference: "abcd1234" });

    expect(getToasts()).toHaveLength(1);
    expect(api.bridge.diagnostics.ackAutoSent).toHaveBeenCalledWith(["abcd1234"]);
  });

  it("acknowledges an automatic diagnostic only after the toast is rendered", () => {
    // Regression: the ack used to fire beside `showToast`, which only queues.
    // React had committed nothing at that point, so a window that died before
    // the paint retired a notice the user never saw — and main, which trusts
    // the ack completely, would never offer it again.
    const api = installDiagnosticsApi();
    render(React.createElement(SubscriberOnlyHarness));

    api.emit({ failureCode: "disk_full", reportPath: "/reports/x.md", reference: "abcd1234" });

    // Queued, not shown: nothing may claim delivery yet.
    expect(getToasts()).toHaveLength(1);
    expect(api.bridge.diagnostics.ackAutoSent).not.toHaveBeenCalled();

    // The commit is the claim.
    render(React.createElement(ToastStack));
    expect(api.bridge.diagnostics.ackAutoSent).toHaveBeenCalledWith(["abcd1234"]);
  });

  it("says so when turning sharing off did not save", async () => {
    // `ToastStack` dismisses the toast as soon as the click returns, so a
    // refused write would otherwise leave the user believing auto-send is off.
    const api = installDiagnosticsApi();
    api.bridge.diagnostics.setSharing.mockResolvedValue({
      enabled: true,
      sendsInWindow: 1,
      limit: 3,
    });
    render(React.createElement(AutoDiagnosticsHarness));

    api.emit({ failureCode: "disk_full", reportPath: "/reports/x.md", reference: "abcd1234" });
    const [toast] = getToasts();
    act(() => {
      toast?.secondaryAction?.onClick();
    });

    await waitFor(() => {
      expect(getToasts().some((entry) => entry.title === "ADE could not turn this off")).toBe(true);
    });
  });

  it("shows one toast for a report delivered twice", () => {
    // Main keeps a successful send marked pending REGARDLESS of whether a
    // window was sent the notice, because `webContents.send` cannot report that
    // anything received it. So the fast-path send and the replay on subscribe
    // can both arrive; keying on the reference is what makes that safe, and the
    // repeated ack is a no-op on main.
    const api = installDiagnosticsApi();
    render(React.createElement(AutoDiagnosticsHarness));

    const payload = { failureCode: "disk_full", reportPath: "/reports/x.md", reference: "abcd1234" };
    api.emit(payload);
    api.emit(payload);

    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]?.id).toBe("diagnostics-auto-sent-abcd1234");
  });

  it("still offers the off switch when the local copy could not be written", () => {
    const api = installDiagnosticsApi();
    render(React.createElement(AutoDiagnosticsHarness));

    api.emit({ failureCode: "disk_full", reportPath: "", reference: "abcd1234" });

    const [toast] = getToasts();
    // Nothing to reveal, so no dead "View" button — but turning it off must
    // always be one click away from the message that says it happened.
    expect(toast?.action).toBeUndefined();
    expect(toast?.secondaryAction?.label).toBe("Turn off");
  });
});
