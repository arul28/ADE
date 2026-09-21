/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./AppleDeviceStage", () => ({
  AppleDeviceStage: (props: { className?: string }) => (
    <div data-testid="apple-stage" data-stage-class={props.className ?? ""} />
  ),
  isWebCodecsAvailable: () => true,
}));

/** Mutable so a test can mount the player BEFORE its first frame. */
const stream = { frameVersion: 1 };

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
    frameVersion: stream.frameVersion,
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
  handoffAppleMiniPlayer,
  noteAppleMiniPlayerLaneDevice,
  noteAppleMiniPlayerPoster,
  resetAppleMiniPlayerForTests,
  takeAppleMiniPlayerPoster,
} = await import("./appleMiniPlayerStore");
const {
  acquireAppleStreamLease,
  appleStreamLeaseCount,
  appleStreamLeaseKey,
  resetAppleStreamLeases,
} = await import("./appleStreamLease");

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
  stream.frameVersion = 1;
  resetAppleStreamLeases();
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
  resetAppleStreamLeases();
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

  /**
   * A5's empty frame: the stage's own box is `flex-1`, which is a height only
   * inside the pane's flex column. Floating, it is a block in an
   * absolutely-positioned host whose every child is absolute — 0px tall — so
   * the flat view measured nothing, the screen box came back null and the
   * decoder stayed parked off-screen. The player must hand the stage a
   * definite height or it draws a picture of nothing.
   */
  it("gives the stage a definite height so the decoder is not parked", () => {
    render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    expect(screen.getByTestId("apple-stage").getAttribute("data-stage-class")).toContain("h-full");
  });

  it("offers eight resize zones", () => {
    render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    expect(document.querySelectorAll("[data-apple-mini-resize]")).toHaveLength(8);
  });

  /*
   * Round 4 §B4: the player used to open on a black box and fill in once the
   * new reader had dialled the helper and been given a keyframe. It now mounts
   * on the pane's own last frame, in the first paint, and the live picture
   * takes over behind it.
   */
  describe("the handover", () => {
    it("paints the pane's last frame in its very first render, on the stage's own box", () => {
      stream.frameVersion = 0;
      noteAppleMiniPlayerPoster("pro", "data:image/jpeg;base64,AAA");
      render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} />);
      act(() => openAppleMiniPlayer(TARGET));
      const poster = document.querySelector("[data-apple-mini-poster]") as HTMLImageElement | null;
      expect(poster?.getAttribute("src")).toBe("data:image/jpeg;base64,AAA");
      // Same `object-contain` rule the flat presenter draws the canvas with,
      // so there is no jump when the decoder catches up.
      expect(poster?.className).toContain("object-contain");
      expect(poster?.className).toContain("pointer-events-none");
      // Claimed: a second player must not repaint a stale session.
      expect(takeAppleMiniPlayerPoster("pro")).toBeNull();
    });

    it("retires the poster the moment a real frame lands", () => {
      stream.frameVersion = 1;
      noteAppleMiniPlayerPoster("pro", "data:image/jpeg;base64,AAA");
      render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} />);
      act(() => openAppleMiniPlayer(TARGET));
      expect(document.querySelector("[data-apple-mini-poster]")).toBeNull();
    });

    it("shows no poster at all when the player was opened by hand", () => {
      stream.frameVersion = 0;
      render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} />);
      act(() => openAppleMiniPlayer(TARGET));
      expect(document.querySelector("[data-apple-mini-poster]")).toBeNull();
    });

    it("hands the handover's lease back once it is mounted, and never lets the count reach zero", () => {
      const key = appleStreamLeaseKey({ pinKey: null, laneId: "lane-1", deviceUdid: "pro" });
      // The pane, open and streaming.
      acquireAppleStreamLease(key, { laneId: "lane-1", deviceUdid: "pro", pinKey: null });
      noteAppleMiniPlayerLaneDevice("lane-1", { udid: "pro", name: "iPhone 17 Pro", runtime: "iOS 26.2", family: "iphone" });
      render(<AppleDeviceMiniPlayer onOpenInPane={vi.fn()} />);

      act(() => {
        // The pane's unmount: the handover takes a hold (2), the player mounts
        // and gives it back (1).
        handoffAppleMiniPlayer({ laneId: "lane-1", chatSessionId: "chat-1", runtimePin: null });
      });
      expect(getAppleMiniPlayerTarget()?.deviceUdid).toBe("pro");
      // The stream hook is mocked out here, so this is the hold alone going
      // back — the pane's own lease is still held and the capture never stopped.
      expect(appleStreamLeaseCount(key)).toBe(1);
    });
  });
});
