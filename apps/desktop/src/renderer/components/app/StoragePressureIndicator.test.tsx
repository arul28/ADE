/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiskPressureSnapshot, DiskPressureState } from "../../../main/services/storage/diskPressure";
import { StoragePressureIndicator } from "./StoragePressureIndicator";

function snapshot(state: DiskPressureState): DiskPressureSnapshot {
  return {
    state,
    freeBytes: state === "normal" ? 50 * 1024 ** 3 : 2 * 1024 ** 3,
    totalBytes: 500 * 1024 ** 3,
    freeFraction: state === "normal" ? 0.1 : 0.004,
    perRoot: [],
    sampledAt: "2026-07-12T12:00:00.000Z",
  };
}

describe("StoragePressureIndicator", () => {
  const getPressure = vi.fn<[], Promise<DiskPressureSnapshot>>();

  beforeEach(() => {
    getPressure.mockReset();
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { storage: { getPressure } },
    });
    window.location.hash = "";
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders nothing at normal pressure", async () => {
    getPressure.mockResolvedValue(snapshot("normal"));
    render(<StoragePressureIndicator enabled />);

    await waitFor(() => expect(getPressure).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders an amber warning with the warning tooltip copy", async () => {
    getPressure.mockResolvedValue(snapshot("warning"));
    render(<StoragePressureIndicator enabled />);

    const indicator = await screen.findByRole("status");
    expect(indicator.getAttribute("data-ade-storage-pressure-state")).toBe("warning");
    expect(indicator.getAttribute("style")).toContain("color: rgb(251, 191, 36)");
    expect(indicator.title).toBe("Storage is running low — ADE and your active projects may create more files while agents work. Click to review ADE storage.");
  });

  it.each(["critical", "exhausted"] as const)("renders %s pressure in red with critical copy", async (state) => {
    getPressure.mockResolvedValue(snapshot(state));
    render(<StoragePressureIndicator enabled />);

    const indicator = await screen.findByRole("status");
    expect(indicator.getAttribute("data-ade-storage-pressure-state")).toBe(state);
    expect(indicator.getAttribute("style")).toContain("color: rgb(248, 113, 113)");
    expect(indicator.title).toBe("Your Mac is almost out of storage — ADE paused new agent work to protect your chats and projects. Click to review ADE storage.");
  });

  it("does not poll while disabled and refreshes on focus when enabled", async () => {
    vi.useFakeTimers();
    getPressure.mockResolvedValue(snapshot("normal"));
    const view = render(<StoragePressureIndicator enabled={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(getPressure).not.toHaveBeenCalled();

    view.rerender(<StoragePressureIndicator enabled />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(getPressure).toHaveBeenCalledTimes(1);

    fireEvent.focus(window);
    await act(async () => {
      await Promise.resolve();
    });
    expect(getPressure).toHaveBeenCalledTimes(2);
  });

  it("opens ADE storage settings when clicked", async () => {
    getPressure.mockResolvedValue(snapshot("warning"));
    render(<StoragePressureIndicator enabled />);

    fireEvent.click(await screen.findByRole("status"));
    expect(window.location.hash).toBe("#/settings?tab=storage");
  });
});
