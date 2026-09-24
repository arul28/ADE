/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiskPressureSnapshot, DiskPressureState } from "../../../shared/types/storage";
import { StoragePressureIndicator } from "./StoragePressureIndicator";
import { settingsRouteFor } from "../settings/settingsManifest";

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

  it("shows an actionable warning when storage is running low", async () => {
    getPressure.mockResolvedValue(snapshot("warning"));
    render(<StoragePressureIndicator enabled />);

    const indicator = await screen.findByRole("status");
    expect(indicator.getAttribute("data-ade-storage-pressure-state")).toBe("warning");
    expect(indicator.title).toMatch(/Storage is running low/i);
    expect(indicator.title).toMatch(/click to review ADE storage/i);
  });

  it.each(["critical", "exhausted"] as const)("shows actionable guidance for %s storage pressure", async (state) => {
    getPressure.mockResolvedValue(snapshot(state));
    render(<StoragePressureIndicator enabled />);

    const indicator = await screen.findByRole("status");
    expect(indicator.getAttribute("data-ade-storage-pressure-state")).toBe(state);
    expect(indicator.title).toMatch(/computer is almost out of storage/i);
    expect(indicator.title).toMatch(/click to review ADE storage/i);
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
    expect(window.location.hash).toBe(`#${settingsRouteFor("storage.usage")}`);
  });
});
