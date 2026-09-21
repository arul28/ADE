/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import { APPLE_TEXT_SIZES, useAppleDeviceControls } from "./useAppleDeviceControls";

const pinRef = { current: null as OpenProjectBinding | null };

function settings(overrides: Record<string, unknown> = {}) {
  return {
    deviceUdid: "pro",
    appearance: "light",
    contentSize: "medium",
    accessibility: {},
    location: null,
    statusBarOverridden: false,
    readAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function install(api: Record<string, unknown>) {
  (window as unknown as { ade: unknown }).ade = { iosSimulator: api };
}

const render = (deviceUdid: string | null = "pro", visible = true) =>
  renderHook(() => useAppleDeviceControls({
    deviceUdid,
    laneId: "lane-1",
    chatSessionId: "chat-1",
    visible,
    runtimePinRef: pinRef,
  }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("useAppleDeviceControls", () => {
  it("shows only what the device confirmed", async () => {
    const setAppearance = vi.fn(async () => settings({ appearance: "dark" }));
    install({ getDeviceSettings: vi.fn(async () => settings()), setAppearance });
    const { result } = render();
    await waitFor(() => expect(result.current.settings?.appearance).toBe("light"));

    await act(async () => {
      await result.current.act({ type: "setAppearance", value: "dark" });
    });
    // Not an optimistic flip: the value came back off the simulator.
    expect(setAppearance).toHaveBeenCalledWith(
      { deviceUdid: "pro", laneId: "lane-1", chatSessionId: "chat-1", appearance: "dark" },
      null,
    );
    expect(result.current.settings?.appearance).toBe("dark");
  });

  it("keeps the last confirmed value when a write is refused", async () => {
    install({
      getDeviceSettings: vi.fn(async () => settings()),
      setAppearance: vi.fn(async () => {
        throw new Error("APPLE_BUTTON_UNSUPPORTED");
      }),
    });
    const { result } = render();
    await waitFor(() => expect(result.current.settings?.appearance).toBe("light"));
    await act(async () => {
      await result.current.act({ type: "setAppearance", value: "dark" });
    });
    expect(result.current.settings?.appearance).toBe("light");
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("serializes: a second click while one write is in flight is dropped", async () => {
    let settle: ((value: unknown) => void) | null = null;
    const setContentSize = vi.fn(() => new Promise((resolve) => {
      settle = resolve;
    }));
    install({ getDeviceSettings: vi.fn(async () => settings()), setContentSize });
    const { result } = render();
    await waitFor(() => expect(result.current.settings).not.toBeNull());

    act(() => {
      void result.current.act({ type: "setTextSize", value: "large" });
      void result.current.act({ type: "setTextSize", value: "small" });
    });
    expect(setContentSize).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle?.(settings({ contentSize: "large" }));
    });
    expect(result.current.settings?.contentSize).toBe("large");
  });

  it("is disabled until the device answers, and whenever it is not visible", async () => {
    install({ getDeviceSettings: vi.fn(async () => settings()) });
    const { result } = render();
    expect(result.current.disabled).toBe(true);
    await waitFor(() => expect(result.current.disabled).toBe(false));

    const hidden = render("pro", false);
    expect(hidden.result.current.disabled).toBe(true);
    expect(hidden.result.current.settings).toBeNull();
  });

  it("asks nothing of a lane with no device", () => {
    const getDeviceSettings = vi.fn(async () => settings());
    install({ getDeviceSettings });
    render(null);
    expect(getDeviceSettings).not.toHaveBeenCalled();
  });

  it("offers the four text sizes §5 names", () => {
    expect(APPLE_TEXT_SIZES.map((entry) => entry.label))
      .toEqual(["Small", "Default", "Large", "Extra large"]);
  });
});
