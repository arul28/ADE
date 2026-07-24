/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  BrainRecoveryNotice,
  formatRecoveryCommand,
  formatRecoveryTime,
  RECOVERY_ACK_STORAGE_KEY,
  shouldShowRecoveryNotice,
} from "./BrainRecoveryNotice";

const wedge = (ts: string, lastCommand = "npm run build") => ({
  ts,
  lastCommand,
  blockedMs: 4200,
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(RECOVERY_ACK_STORAGE_KEY);
  Reflect.deleteProperty(window, "ade");
});

describe("BrainRecoveryNotice lifecycle", () => {
  it("subscribes before the initial read and preserves a reconnect event that wins the race", async () => {
    const order: string[] = [];
    let statusListener: ((status: never) => void) | null = null;
    let resolveInfo: ((info: never) => void) | null = null;
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        app: {
          onRuntimeStatusChanged: vi.fn((listener: (status: never) => void) => {
            order.push("subscribe");
            statusListener = listener;
            return vi.fn();
          }),
          getInfo: vi.fn(() => {
            order.push("read");
            return new Promise((resolve) => {
              resolveInfo = resolve;
            });
          }),
        },
      },
    });

    render(React.createElement(BrainRecoveryNotice));
    await waitFor(() => expect(order).toEqual(["subscribe", "read"]));

    act(() => {
      statusListener?.({
        lastWedge: wedge("2026-07-23T11:00:00Z", "chat.send"),
      } as never);
    });
    expect(await screen.findByText(/chat\.send/)).toBeTruthy();

    await act(async () => {
      resolveInfo?.({ localRuntime: { lastWedge: null } } as never);
      await Promise.resolve();
    });
    expect(screen.getByText(/chat\.send/)).toBeTruthy();
  });
});

describe("shouldShowRecoveryNotice", () => {
  it("is hidden when there is no wedge", () => {
    expect(shouldShowRecoveryNotice(null, null)).toBe(false);
    expect(shouldShowRecoveryNotice(undefined, null)).toBe(false);
  });

  it("shows an unacknowledged wedge", () => {
    expect(shouldShowRecoveryNotice(wedge("2026-07-23T10:00:00Z"), null)).toBe(true);
  });

  it("hides a wedge that was already acknowledged", () => {
    const ts = "2026-07-23T10:00:00Z";
    expect(shouldShowRecoveryNotice(wedge(ts), ts)).toBe(false);
  });

  it("re-shows when a newer wedge supersedes an old acknowledgment", () => {
    expect(
      shouldShowRecoveryNotice(wedge("2026-07-23T11:00:00Z"), "2026-07-23T10:00:00Z"),
    ).toBe(true);
  });
});

describe("formatRecoveryCommand", () => {
  it("falls back when the command is blank", () => {
    expect(formatRecoveryCommand("   ")).toBe("background task");
  });

  it("passes short commands through trimmed", () => {
    expect(formatRecoveryCommand("  git status  ")).toBe("git status");
  });

  it("truncates long commands with an ellipsis", () => {
    const long = "run-a-really-long-background-command-that-keeps-going-forever";
    const out = formatRecoveryCommand(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(48);
  });
});

describe("formatRecoveryTime", () => {
  it("returns the raw value for an unparseable timestamp", () => {
    expect(formatRecoveryTime("not-a-date")).toBe("not-a-date");
  });

  it("formats a parseable timestamp to a short local time", () => {
    const out = formatRecoveryTime("2026-07-23T10:05:00Z");
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});
