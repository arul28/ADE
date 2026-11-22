/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastStack } from "./ToastStack";
import { dismissToast, getToasts, showToast, updateToast } from "./toastStore";

afterEach(() => {
  cleanup();
  for (const toast of getToasts()) dismissToast(toast.id);
  vi.useRealTimers();
});

describe("ToastStack", () => {

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
