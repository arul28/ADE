/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastStack } from "./ToastStack";
import { ToastViewport, toastViewportLift } from "./ToastViewport";
import { dismissToast, getToasts, showToast, updateToast } from "./toastStore";
import { publishCornerObstacle, resetCornerObstacleForTests } from "./toastViewportInsets";

afterEach(() => {
  cleanup();
  for (const toast of getToasts()) dismissToast(toast.id);
  resetCornerObstacleForTests();
  vi.useRealTimers();
});

describe("ToastStack", () => {
  it("renders the rich fields: badge, eyebrow, chips, message, error and pill actions", () => {
    render(<ToastStack />);
    act(() => {
      showToast({
        id: "rich",
        tone: "error",
        badge: "Checks failing",
        eyebrow: "#1287",
        title: "Fix the flaky suite",
        chips: [{ label: "lane-a" }, { label: "feature -> main" }],
        message: "2 checks failed.",
        error: "Couldn't undo the link. Try again.",
        actions: [
          { label: "Open in ADE", variant: "secondary", onClick: () => {} },
          { label: "Open on GitHub", variant: "solid", onClick: () => {} },
        ],
      });
    });
    expect(screen.getByText("Checks failing")).toBeTruthy();
    expect(screen.getByText("#1287")).toBeTruthy();
    expect(screen.getByText("Fix the flaky suite")).toBeTruthy();
    expect(screen.getByText("lane-a")).toBeTruthy();
    expect(screen.getByText("feature -> main")).toBeTruthy();
    expect(screen.getByText("2 checks failed.")).toBeTruthy();
    expect(screen.getByText("Couldn't undo the link. Try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in ADE" }).getAttribute("data-variant")).toBe("secondary");
    expect(screen.getByRole("button", { name: "Open on GitHub" }).getAttribute("data-variant")).toBe("solid");
    // Failures announce as alerts.
    expect(document.querySelector('[data-notice-tone="error"]')?.getAttribute("role")).toBe("alert");
  });

  it("dismisses after an action unless the action keeps it open", () => {
    const run = vi.fn();
    const keep = vi.fn();
    render(<ToastStack />);
    act(() => {
      showToast({
        id: "t",
        title: "Hello",
        actions: [
          { label: "Keep", keepOpen: true, onClick: keep },
          { label: "Go", onClick: run },
        ],
        durationMs: 0,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(keep).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(0);
  });

  it("fires onClose only when the user closes with ×, not on action or auto-dismiss", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<ToastStack />);
    act(() => {
      showToast({ id: "a", title: "Auto", onClose, durationMs: 1000 });
      showToast({ id: "b", title: "Acted", onClose, actions: [{ label: "Do", onClick: () => {} }], durationMs: 0 });
      showToast({ id: "c", title: "Closed", onClose, closeTitle: "Dismiss for an hour", durationMs: 0 });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(getToasts().map((toast) => toast.id)).toEqual(["b", "c"]);
    fireEvent.click(screen.getByRole("button", { name: "Do" }));
    expect(onClose).not.toHaveBeenCalled();
    const close = screen.getByRole("button", { name: "Dismiss: Closed" });
    expect(close.getAttribute("title")).toBe("Dismiss for an hour");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(0);
  });

  it("keeps sticky toasts (durationMs <= 0) until dismissed, and hides × when not dismissible", () => {
    vi.useFakeTimers();
    render(<ToastStack />);
    act(() => {
      showToast({ id: "sticky", title: "Sticky", durationMs: 0, dismissible: false });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(getToasts()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Dismiss/ })).toBeNull();
  });

  it("caps the stack at five, dropping the oldest", () => {
    for (let index = 0; index < 7; index += 1) {
      showToast({ id: `t${index}`, title: `Toast ${index}`, durationMs: 0 });
    }
    expect(getToasts().map((toast) => toast.id)).toEqual(["t2", "t3", "t4", "t5", "t6"]);
  });

  it("updates a toast in place without moving it", () => {
    render(<ToastStack />);
    act(() => {
      showToast({ id: "first", title: "First", durationMs: 0 });
      showToast({ id: "undo", title: "Auto-linked PR #7", actions: [{ label: "Undo", keepOpen: true }], durationMs: 0 });
      showToast({ id: "last", title: "Last", durationMs: 0 });
    });
    act(() => {
      updateToast("undo", {
        error: "Couldn't undo the link. Try again.",
        actions: [{ label: "Retry undo", keepOpen: true }],
      });
    });
    expect(getToasts().map((toast) => toast.id)).toEqual(["first", "undo", "last"]);
    expect(screen.getByRole("button", { name: "Retry undo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    act(() => {
      updateToast("undo", { actions: [{ label: "Retry undo", keepOpen: true, busy: true }] });
    });
    expect((screen.getByRole("button", { name: "Retry undo" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ToastViewport", () => {
  it("stays mounted when empty and renders the slot below the stack", () => {
    const { rerender } = render(<ToastViewport />);
    expect(screen.getByTestId("toast-viewport")).toBeTruthy();
    act(() => {
      showToast({ id: "x", title: "Store toast", durationMs: 0 });
    });
    rerender(<ToastViewport slot={<div data-testid="slot">Launches</div>} />);
    const viewport = screen.getByTestId("toast-viewport");
    const text = viewport.textContent ?? "";
    expect(text.indexOf("Store toast")).toBeLessThan(text.indexOf("Launches"));
  });

  it("lifts the stack above a HUD in its column and not otherwise", () => {
    const container = { right: 1000, bottom: 800 };
    expect(toastViewportLift(container, 380, null)).toBe(0);
    // HUD pinned to the same corner, 60px tall: stack sits 8px above it.
    const lift = toastViewportLift(container, 380, { top: 728, bottom: 788, left: 800, right: 988 });
    expect(800 - 12 - lift).toBe(728 - 8);
    // Dragged to the left half of the window: no overlap, no lift.
    expect(toastViewportLift(container, 380, { top: 728, bottom: 788, left: 100, right: 300 })).toBe(0);
    // Dragged up away from the corner: no lift.
    expect(toastViewportLift(container, 380, { top: 100, bottom: 160, left: 800, right: 988 })).toBe(0);
  });

  it("applies the lift while a HUD is published", () => {
    render(<ToastViewport />);
    const viewport = screen.getByTestId("toast-viewport");
    expect(viewport.style.bottom).toBe("12px");
    act(() => {
      // jsdom lays everything out at 0×0, so the container's bottom is 0.
      publishCornerObstacle({ top: -60, bottom: -12, left: -200, right: -12 });
    });
    expect(viewport.style.bottom).not.toBe("12px");
    act(() => {
      publishCornerObstacle(null);
    });
    expect(viewport.style.bottom).toBe("12px");
  });
});
