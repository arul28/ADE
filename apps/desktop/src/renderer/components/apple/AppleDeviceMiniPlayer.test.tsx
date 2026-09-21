/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./AppleDeviceStage", () => ({
  AppleDeviceStage: () => <div data-testid="apple-stage" />,
  isWebCodecsAvailable: () => true,
}));

vi.mock("./useAppleDeviceStream", () => ({
  useAppleDeviceStream: () => ({
    state: "live",
    url: "http://127.0.0.1:1/stream",
    token: "t",
    reconnectNonce: 0,
    width: 1_179,
    height: 2_556,
    error: null,
    chip: null,
    frameVersion: 1,
    streamStatus: null,
    handleReaderStatus: vi.fn(),
    handleDimensions: vi.fn(),
    noteFrame: vi.fn(),
    reconnect: vi.fn(),
    applyStreamEvent: vi.fn(),
  }),
}));

const { AppleDeviceMiniPlayer } = await import("./AppleDeviceMiniPlayer");
const {
  openAppleMiniPlayer,
  closeAppleMiniPlayer,
  getAppleMiniPlayerTarget,
  resetAppleMiniPlayerForTests,
} = await import("./appleMiniPlayerStore");

const TARGET = {
  laneId: "lane-1",
  chatSessionId: "chat-1",
  deviceUdid: "pro",
  deviceName: "iPhone 17 Pro",
  deviceRuntime: "iOS 26.2",
  family: "iphone" as const,
  runtimePin: null,
};

beforeEach(() => {
  resetAppleMiniPlayerForTests();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  (window as unknown as { ade: unknown }).ade = { iosSimulator: { tap: vi.fn() } };
});

afterEach(() => {
  cleanup();
  resetAppleMiniPlayerForTests();
});

describe("appleMiniPlayerStore", () => {
  it("floats exactly one device at a time", () => {
    openAppleMiniPlayer(TARGET);
    expect(getAppleMiniPlayerTarget()?.deviceUdid).toBe("pro");
    openAppleMiniPlayer({ ...TARGET, deviceUdid: "max", deviceName: "iPhone 17 Pro Max" });
    expect(getAppleMiniPlayerTarget()?.deviceUdid).toBe("max");
  });

  it("ignores a close aimed at a device that is no longer floating", () => {
    openAppleMiniPlayer(TARGET);
    closeAppleMiniPlayer("some-other-udid");
    expect(getAppleMiniPlayerTarget()).not.toBeNull();
    closeAppleMiniPlayer("pro");
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });
});

describe("AppleDeviceMiniPlayer", () => {
  it("renders nothing until a device is floated", () => {
    const { container } = render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the picture with a dot and no rail", () => {
    render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    expect(screen.getByRole("group", { name: "iPhone 17 Pro, floating" })).toBeTruthy();
    expect(screen.getByTestId("apple-stage")).toBeTruthy();
    expect(document.querySelector("[data-apple-mini-dot='idle']")).toBeTruthy();
    // §7: no rail on the floating player.
    expect(screen.queryByRole("complementary", { name: "Device controls" })).toBeNull();
    // The bar is hidden until the pointer arrives.
    expect(screen.queryByRole("button", { name: "Open in pane" })).toBeNull();
  });

  it("pulses the dot red while a recording runs", () => {
    render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} recording />);
    act(() => openAppleMiniPlayer(TARGET));
    expect(document.querySelector("[data-apple-mini-dot='recording']")).toBeTruthy();
  });

  it("expands into Open in pane / Close on hover", () => {
    const onOpenInPane = vi.fn();
    render(<AppleDeviceMiniPlayer onOpenInPane={onOpenInPane} />);
    act(() => openAppleMiniPlayer(TARGET));
    fireEvent.pointerEnter(screen.getByRole("group", { name: "iPhone 17 Pro, floating" }));
    expect(screen.getByRole("button", { name: "Picture in picture" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in pane" }));
    expect(onOpenInPane).toHaveBeenCalledWith(TARGET);
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  it("closes from the hover bar", () => {
    render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    fireEvent.pointerEnter(screen.getByRole("group", { name: "iPhone 17 Pro, floating" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  it("offers eight resize zones", () => {
    render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    expect(document.querySelectorAll("[data-apple-mini-resize]")).toHaveLength(8);
  });
});
