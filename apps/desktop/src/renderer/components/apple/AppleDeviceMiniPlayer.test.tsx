/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./AppleDeviceStage", () => ({
  AppleDeviceStage: (props: { className?: string; interactive?: boolean }) => (
    <div
      data-testid="apple-stage"
      data-stage-class={props.className ?? ""}
      data-stage-interactive={String(Boolean(props.interactive))}
    >
      {/* The decoder's canvas, which picture-in-picture captures. */}
      <canvas />
    </div>
  ),
  isWebCodecsAvailable: () => true,
}));

/** Mutable so a test can mount the player BEFORE its first frame. */
const stream = {
  frameVersion: 1,
  state: "live" as string,
  /** What the player last asked the stream for — `hidden` is the lease. */
  lastArgs: null as null | { hidden: boolean; enabled: boolean },
};

vi.mock("./useAppleDeviceStream", () => ({
  useAppleDeviceStream: (args: { hidden: boolean; enabled: boolean }) => {
    stream.lastArgs = args;
    return {
      state: stream.state,
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
    };
  },
}));

/** The PiP window, faked: jsdom has none. Each entry is one session opened. */
const pipSessions: { video: HTMLVideoElement; stop: ReturnType<typeof vi.fn> }[] = [];

vi.mock("../work/workLiveIosPictureInPicture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../work/workLiveIosPictureInPicture")>();
  return {
    ...actual,
    enterCanvasPictureInPicture: vi.fn(async () => {
      const session = { video: document.createElement("video"), stop: vi.fn() };
      pipSessions.push(session);
      return session;
    }),
  };
});

const { AppleDeviceMiniPlayer } = await import("./AppleDeviceMiniPlayer");
const {
  APPLE_STREAM_HANDOVER_HOLD_MS,
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
  releaseAppleStreamLease,
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

/** A session of the device's own lane, on the window's own machine. */
const SURFACE = { laneId: "lane-1", runtimePin: null, boundBinding: null };

beforeEach(() => {
  stream.frameVersion = 1;
  stream.state = "live";
  pipSessions.length = 0;
  stream.lastArgs = null;
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
    const { container } = render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the picture with a dot and no rail", () => {
    render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
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
    render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} recording />);
    act(() => openAppleMiniPlayer(TARGET));
    expect(document.querySelector("[data-apple-mini-dot='recording']")).toBeTruthy();
  });

  it("expands into Open in pane / Close on hover", () => {
    const onOpenInPane = vi.fn();
    render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={onOpenInPane} />);
    act(() => openAppleMiniPlayer(TARGET));
    fireEvent.pointerEnter(screen.getByRole("group", { name: "iPhone 17 Pro, floating" }));
    expect(screen.getByRole("button", { name: "Picture in picture" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in pane" }));
    expect(onOpenInPane).toHaveBeenCalledWith(TARGET);
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  it("closes from the hover bar", () => {
    render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
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
    render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    expect(screen.getByTestId("apple-stage").getAttribute("data-stage-class")).toContain("h-full");
  });

  it("offers eight resize zones", () => {
    render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
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
      render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
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
      render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
      act(() => openAppleMiniPlayer(TARGET));
      expect(document.querySelector("[data-apple-mini-poster]")).toBeNull();
    });

    it("shows no poster at all when the player was opened by hand", () => {
      stream.frameVersion = 0;
      render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
      act(() => openAppleMiniPlayer(TARGET));
      expect(document.querySelector("[data-apple-mini-poster]")).toBeNull();
    });

    it("refuses picture-in-picture until a frame has actually been drawn", () => {
      /*
       * A decoder canvas is 300×150 until its first frame sizes it — landscape,
       * and black under `alpha: false`. PiP takes its shape from the first
       * frame it is handed and does not reshape itself afterwards, so entering
       * early pins a black landscape window over a portrait phone.
       */
      // jsdom has no PiP at all, so support is stubbed in: without this the
      // button is disabled for the OTHER reason and the test proves nothing.
      Object.defineProperty(document, "pictureInPictureEnabled", { value: true, configurable: true });
      (HTMLVideoElement.prototype as unknown as { requestPictureInPicture: unknown })
        .requestPictureInPicture = vi.fn();

      stream.frameVersion = 0;
      const view = render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
      act(() => openAppleMiniPlayer(TARGET));
      fireEvent.pointerEnter(screen.getByRole("group", { name: "iPhone 17 Pro, floating" }));
      expect((screen.getByRole("button", { name: "Picture in picture" }) as HTMLButtonElement).disabled).toBe(true);

      // Disabled, never hidden: the control keeps its place in the bar.
      stream.frameVersion = 1;
      view.rerender(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
      fireEvent.pointerEnter(screen.getByRole("group", { name: "iPhone 17 Pro, floating" }));
      expect((screen.getByRole("button", { name: "Picture in picture" }) as HTMLButtonElement).disabled).toBe(false);

      Reflect.deleteProperty(document, "pictureInPictureEnabled");
      Reflect.deleteProperty(HTMLVideoElement.prototype, "requestPictureInPicture");
    });

    it("hands the handover's lease back once it is mounted, and never lets the count reach zero", () => {
      const key = appleStreamLeaseKey({ pinKey: null, laneId: "lane-1", deviceUdid: "pro" });
      // The pane, open and streaming.
      acquireAppleStreamLease(key, { laneId: "lane-1", deviceUdid: "pro", pinKey: null });
      noteAppleMiniPlayerLaneDevice("lane-1", { udid: "pro", name: "iPhone 17 Pro", runtime: "iOS 26.2", family: "iphone" });
      render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);

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

/*
 * The owner's 2026-09-23 report: a lane's simulator floated over the new-chat
 * screen — "it shouldn't have done that". The player belongs over surfaces of
 * its own lane on its own machine, and nowhere else; elsewhere it hides
 * WITHOUT closing, so coming back to the lane brings it back.
 */
describe("AppleDeviceMiniPlayer, per surface", () => {
  const STUDIO = {
    kind: "remote" as const,
    key: "remote:target-studio:project-a",
    targetId: "target-studio",
    runtimeName: "Mac Studio",
    projectId: "project-a",
    rootPath: "/remote/repo-a",
    displayName: "repo-a",
  };
  const MACBOOK = {
    kind: "local" as const,
    key: "local:/repo-a",
    rootPath: "/repo-a",
    displayName: "repo-a",
  };
  const player = () => screen.queryByRole("group", { name: "iPhone 17 Pro, floating" });

  it("shows over another session of the same lane", () => {
    render(<AppleDeviceMiniPlayer surface={{ laneId: "lane-1", runtimePin: null, boundBinding: null }} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    expect(player()).toBeTruthy();
    expect(stream.lastArgs?.hidden).toBe(false);
  });

  it("hides over a session of a different lane, and stops asking for frames", () => {
    render(<AppleDeviceMiniPlayer surface={{ laneId: "lane-2", runtimePin: null, boundBinding: null }} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    expect(player()).toBeNull();
    expect(document.querySelector("[data-apple-mini-player='pro']")?.hasAttribute("hidden")).toBe(true);
    // Hidden gives the lease back, exactly as an unmount would.
    expect(stream.lastArgs?.hidden).toBe(true);
    // Hidden is not closed.
    expect(getAppleMiniPlayerTarget()?.deviceUdid).toBe("pro");
  });

  it("hides on the new-chat screen, where there is no session in front", () => {
    render(<AppleDeviceMiniPlayer surface={null} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    expect(player()).toBeNull();
    expect(stream.lastArgs?.hidden).toBe(true);
    expect(getAppleMiniPlayerTarget()?.deviceUdid).toBe("pro");
  });

  it("hides over the same lane id on another machine", () => {
    // A lane id is not an identity across machines: the Studio's lane-1 is
    // not the MacBook's.
    render(<AppleDeviceMiniPlayer surface={{ laneId: "lane-1", runtimePin: STUDIO, boundBinding: MACBOOK }} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer({ ...TARGET, runtimePin: MACBOOK }));
    expect(player()).toBeNull();
  });

  it("shows when a null pin and an explicit pin name the same machine", () => {
    // The target froze the bound machine at open; the session in front rides
    // the bound path with no pin. Both are the MacBook.
    render(<AppleDeviceMiniPlayer surface={{ laneId: "lane-1", runtimePin: null, boundBinding: MACBOOK }} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer({ ...TARGET, runtimePin: MACBOOK }));
    expect(player()).toBeTruthy();
  });

  it("floats a lane-less device only over lane-less sessions", () => {
    const view = render(<AppleDeviceMiniPlayer surface={{ laneId: "lane-1", runtimePin: null, boundBinding: null }} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer({ ...TARGET, laneId: null }));
    expect(player()).toBeNull();
    view.rerender(<AppleDeviceMiniPlayer surface={{ laneId: null, runtimePin: null, boundBinding: null }} onOpenInPane={vi.fn()} />);
    expect(player()).toBeTruthy();
  });

  it("comes back on the same target, in the same box, when the lane is in front again", () => {
    const sameLane = { laneId: "lane-1", runtimePin: null, boundBinding: null };
    const view = render(<AppleDeviceMiniPlayer surface={sameLane} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    const before = document.querySelector("[data-apple-mini-player='pro']");
    expect(player()).toBeTruthy();

    view.rerender(<AppleDeviceMiniPlayer surface={null} onOpenInPane={vi.fn()} />);
    expect(player()).toBeNull();
    expect(getAppleMiniPlayerTarget()).toEqual(TARGET);

    view.rerender(<AppleDeviceMiniPlayer surface={{ laneId: "lane-2", runtimePin: null, boundBinding: null }} onOpenInPane={vi.fn()} />);
    expect(player()).toBeNull();

    view.rerender(<AppleDeviceMiniPlayer surface={sameLane} onOpenInPane={vi.fn()} />);
    expect(player()).toBeTruthy();
    expect(stream.lastArgs?.hidden).toBe(false);
    expect(getAppleMiniPlayerTarget()).toEqual(TARGET);
    // Never unmounted, so the dragged position and size survive the trip.
    expect(document.querySelector("[data-apple-mini-player='pro']")).toBe(before);
  });

  it("leaves a handover's hold to expire when it floats onto a surface it does not belong to", () => {
    vi.useFakeTimers();
    try {
      const stopStream = vi.fn(() => Promise.resolve());
      (window as unknown as { ade: unknown }).ade = { iosSimulator: { tap: vi.fn(), stopStream } };
      const key = appleStreamLeaseKey({ pinKey: null, laneId: "lane-1", deviceUdid: "pro" });
      const pane = acquireAppleStreamLease(key, { laneId: "lane-1", deviceUdid: "pro", pinKey: null });
      noteAppleMiniPlayerLaneDevice("lane-1", { udid: "pro", name: "iPhone 17 Pro", runtime: "iOS 26.2", family: "iphone" });
      // The pane closes while the new-chat screen is in front.
      render(<AppleDeviceMiniPlayer surface={null} onOpenInPane={vi.fn()} />);
      act(() => {
        handoffAppleMiniPlayer({ laneId: "lane-1", chatSessionId: "chat-1", runtimePin: null });
      });
      // The hidden player takes no lease, so it must not give the hold back:
      // that release never stops a capture, and would leave one running for
      // nobody. The pane's own release is not the last.
      expect(appleStreamLeaseCount(key)).toBe(2);
      releaseAppleStreamLease(key, pane.epoch);
      expect(appleStreamLeaseCount(key)).toBe(1);
      // Nobody came back: the hold's expiry stops the capture.
      act(() => {
        vi.advanceTimersByTime(APPLE_STREAM_HANDOVER_HOLD_MS + 1);
      });
      expect(appleStreamLeaseCount(key)).toBe(0);
      expect(stopStream).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the handover's hold back once the player is shown after all", () => {
    const key = appleStreamLeaseKey({ pinKey: null, laneId: "lane-1", deviceUdid: "pro" });
    acquireAppleStreamLease(key, { laneId: "lane-1", deviceUdid: "pro", pinKey: null });
    noteAppleMiniPlayerLaneDevice("lane-1", { udid: "pro", name: "iPhone 17 Pro", runtime: "iOS 26.2", family: "iphone" });
    const view = render(<AppleDeviceMiniPlayer surface={null} onOpenInPane={vi.fn()} />);
    act(() => {
      handoffAppleMiniPlayer({ laneId: "lane-1", chatSessionId: "chat-1", runtimePin: null });
    });
    expect(appleStreamLeaseCount(key)).toBe(2);
    view.rerender(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    expect(player()).toBeTruthy();
    // The stream hook is mocked, so this is the hold alone going back.
    expect(appleStreamLeaseCount(key)).toBe(1);
  });
});

/*
 * The owner's 2026-09-23 ask: while the device plays in a PiP window, the box
 * inside ADE goes away, and it comes back when PiP closes. The PiP window is
 * fed from the box's own canvas, so "away" must keep the stream.
 */
describe("AppleDeviceMiniPlayer, picture in picture", () => {
  const host = () => document.querySelector("[data-apple-mini-player='pro']") as HTMLElement;
  const box = (node: HTMLElement) => ({
    left: node.style.left,
    top: node.style.top,
    width: node.style.width,
    height: node.style.height,
  });

  beforeEach(() => {
    Object.defineProperty(document, "pictureInPictureEnabled", { value: true, configurable: true });
    (HTMLVideoElement.prototype as unknown as { requestPictureInPicture: unknown })
      .requestPictureInPicture = vi.fn();
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "pictureInPictureEnabled");
    Reflect.deleteProperty(HTMLVideoElement.prototype, "requestPictureInPicture");
  });

  async function enterPip() {
    fireEvent.pointerEnter(host());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Picture in picture" }));
    });
    expect(pipSessions).toHaveLength(1);
  }

  function leavePip() {
    act(() => {
      pipSessions[0]!.video.dispatchEvent(new Event("leavepictureinpicture"));
    });
  }

  it("conceals the box on PiP start and keeps its stream", async () => {
    render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    const before = box(host());
    await enterPip();

    const node = host();
    expect(node.hasAttribute("data-apple-mini-pip")).toBe(true);
    expect(node.style.opacity).toBe("0.002");
    expect(node.style.pointerEvents).toBe("none");
    expect(node.getAttribute("aria-hidden")).toBe("true");
    // Concealed, not hidden: `hidden` would drop the lease and the decoder.
    expect(node.hasAttribute("hidden")).toBe(false);
    expect(stream.lastArgs?.hidden).toBe(false);
    expect(node.querySelector("canvas")).toBeTruthy();
    // The concealed screen takes no input, and the hover bar is closed.
    expect(screen.getByTestId("apple-stage").getAttribute("data-stage-interactive")).toBe("false");
    expect(document.querySelector("[data-apple-mini-dot]")).toBeTruthy();
    expect(box(node)).toEqual(before);
    expect(pipSessions[0]!.stop).not.toHaveBeenCalled();
  });

  it("shows the box again, in the same place, when the PiP window closes", async () => {
    render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    const element = host();
    const before = box(element);
    await enterPip();

    // The PiP window's close button and "back to tab" both arrive as this.
    leavePip();
    expect(host()).toBe(element);
    expect(element.hasAttribute("data-apple-mini-pip")).toBe(false);
    expect(element.style.opacity).toBe("");
    expect(element.style.pointerEvents).toBe("");
    expect(element.hasAttribute("aria-hidden")).toBe(false);
    expect(box(element)).toEqual(before);
    expect(screen.getByRole("group", { name: "iPhone 17 Pro, floating" })).toBe(element);
    expect(screen.getByTestId("apple-stage").getAttribute("data-stage-interactive")).toBe("true");
    expect(pipSessions[0]!.stop).toHaveBeenCalled();
  });

  it("keeps streaming into PiP while another lane or the new-chat screen is in front", async () => {
    const view = render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    await enterPip();

    view.rerender(<AppleDeviceMiniPlayer surface={{ laneId: "lane-2", runtimePin: null, boundBinding: null }} onOpenInPane={vi.fn()} />);
    expect(stream.lastArgs?.hidden).toBe(false);
    expect(host().hasAttribute("hidden")).toBe(false);
    expect(host().hasAttribute("data-apple-mini-pip")).toBe(true);

    view.rerender(<AppleDeviceMiniPlayer surface={null} onOpenInPane={vi.fn()} />);
    expect(stream.lastArgs?.hidden).toBe(false);
    expect(host().querySelector("canvas")).toBeTruthy();
    expect(pipSessions[0]!.stop).not.toHaveBeenCalled();
    expect(getAppleMiniPlayerTarget()?.deviceUdid).toBe("pro");
  });

  it("hides the box and drops the stream when PiP closes over another surface", async () => {
    const view = render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    await enterPip();
    view.rerender(<AppleDeviceMiniPlayer surface={null} onOpenInPane={vi.fn()} />);

    leavePip();
    expect(host().hasAttribute("hidden")).toBe(true);
    expect(stream.lastArgs?.hidden).toBe(true);
    expect(getAppleMiniPlayerTarget()?.deviceUdid).toBe("pro");

    // Back on the lane, it is the ordinary visible box again.
    view.rerender(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    expect(host().hasAttribute("hidden")).toBe(false);
    expect(host().hasAttribute("data-apple-mini-pip")).toBe(false);
    expect(stream.lastArgs?.hidden).toBe(false);
  });

  it("ends PiP and shows the box when the device's stream stops", async () => {
    const view = render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    await enterPip();

    stream.state = "error";
    view.rerender(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    expect(pipSessions[0]!.stop).toHaveBeenCalled();
    expect(host().hasAttribute("data-apple-mini-pip")).toBe(false);
    expect(host().hasAttribute("hidden")).toBe(false);
  });

  it("ends PiP when the player closes", async () => {
    render(<AppleDeviceMiniPlayer surface={SURFACE} onOpenInPane={vi.fn()} />);
    act(() => openAppleMiniPlayer(TARGET));
    await enterPip();
    act(() => closeAppleMiniPlayer("pro"));
    expect(host()).toBeNull();
    expect(pipSessions[0]!.stop).toHaveBeenCalled();
  });
});
