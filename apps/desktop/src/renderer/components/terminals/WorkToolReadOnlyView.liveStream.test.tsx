/* @vitest-environment jsdom */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkToolsLaneState, WorkToolsMacDesktopState } from "../../../shared/types/workTools";
import type { SyncMacDesktopStreamRecordPayload } from "../../../shared/types/sync";
import {
  WORK_TOOL_READ_ONLY_LIVE_POLL_MS,
  WORK_TOOL_READ_ONLY_POLL_MS,
  WorkToolReadOnlyView,
  createMacDesktopStreamSource,
} from "./WorkToolReadOnlyView";

/**
 * The live-picture half of the Mac Desktop read-only pane: the pushed-record
 * gate and the poll/still bookkeeping that follows the canvas's `playing`
 * status. C's file covers the control affordance, so this one stays additive.
 */

const DATA_URL = "data:image/png;base64,AAAA";

type RecordHandler = (record: SyncMacDesktopStreamRecordPayload) => void;

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  state = "unconfigured";
  configure = vi.fn(() => {
    this.state = "configured";
  });
  close = vi.fn(() => {
    this.state = "closed";
  });
  decode = vi.fn(() => {
    // The real decoder answers with the drawn frame; a chunk accepted and then
    // never drawn is what the playing-status test is about.
    if (this.drawOnDecode) this.init.output({ displayWidth: 16, displayHeight: 9, close: () => {} });
  });
  private readonly init: {
    output: (frame: { displayWidth: number; displayHeight: number; close: () => void }) => void;
    error: (error: Error) => void;
  };

  constructor(init: FakeVideoDecoder["init"]) {
    this.init = init;
    FakeVideoDecoder.instances.push(this);
  }

  drawOnDecode = false;
}

class FakeEncodedVideoChunk {
  constructor(readonly init: unknown) {}
}

function installFakeWebCodecs(options: { drawOnDecode: boolean }): void {
  FakeVideoDecoder.instances = [];
  class ConfiguredFakeVideoDecoder extends FakeVideoDecoder {
    constructor(init: FakeVideoDecoder["init"]) {
      super(init);
      this.drawOnDecode = options.drawOnDecode;
    }
  }
  (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder = ConfiguredFakeVideoDecoder;
  (globalThis as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk = FakeEncodedVideoChunk;
}

function macDesktopState(overrides: Partial<WorkToolsMacDesktopState> = {}): WorkToolsMacDesktopState {
  return {
    supported: true,
    display: {
      laneId: "lane-1",
      displayId: 7,
      name: "ADE · lane-1",
      mode: "virtual",
      width: 2560,
      height: 1440,
      scale: 2,
      origin: { x: 0, y: 0 },
      createdAt: "2026-09-18T10:00:00.000Z",
      windowCount: 0,
      lastActivityAt: "2026-09-18T10:00:30.000Z",
    },
    windows: [],
    lease: null,
    stream: { running: true, idle: false, fps: 30, bitrateKbps: 900, lastError: null },
    permissions: { screenRecording: "granted", accessibility: "granted" },
    lastObservation: {
      id: "obs-1",
      capturedAt: "2026-09-18T10:00:20.000Z",
      caption: "Sign in",
      screenshotPath: "/tmp/obs/obs-1.png",
    },
    hostIsLocal: false,
    ...overrides,
  };
}

function laneState(overrides: Partial<WorkToolsLaneState> = {}): WorkToolsLaneState {
  return {
    laneId: "lane-1",
    activeTool: "mac-desktop",
    openTools: ["mac-desktop"],
    activeToolUpdatedAt: "2026-01-01T00:00:00.000Z",
    browser: null,
    browserUnavailable: null,
    agentBrowserPresence: [],
    macDesktop: macDesktopState(),
    appControl: null,
    capturedAt: "2026-01-02T00:00:01.000Z",
    ...overrides,
  };
}

function configRecord(subscriptionId: string, seq: number): SyncMacDesktopStreamRecordPayload {
  const json = JSON.stringify({ codec: "avc1.640032", width: 2560, height: 1440, annexB: true });
  return {
    subscriptionId,
    seq,
    kind: "config",
    keyframe: false,
    timestampUs: 0,
    data: btoa(json),
  };
}

function frameRecord(
  subscriptionId: string,
  seq: number,
  keyframe: boolean,
): SyncMacDesktopStreamRecordPayload {
  return {
    subscriptionId,
    seq,
    kind: "frame",
    keyframe,
    timestampUs: seq * 33_333,
    data: btoa(String.fromCharCode(0x65, 0x88)),
  };
}

/** A web `macDesktop` namespace whose record pushes the test drives. */
function controlledApi() {
  const recordHandlers: RecordHandler[] = [];
  const streamSubscribe = vi.fn(async (args: { laneId: string; subscriptionId: string }) => {
    void args;
    return { ok: true, width: 2560, height: 1440, codec: "avc1.640032" };
  });
  const api = {
    supportsLiveStream: () => true,
    streamSubscribe,
    streamUnsubscribe: vi.fn(async () => ({ ok: true })),
    onStreamRecord: (handler: RecordHandler) => {
      recordHandlers.push(handler);
      return () => {
        const index = recordHandlers.indexOf(handler);
        if (index >= 0) recordHandlers.splice(index, 1);
      };
    },
    onStreamEnded: () => () => {},
    onConnectionChange: () => () => {},
  };
  return {
    api,
    streamSubscribe,
    push: (record: SyncMacDesktopStreamRecordPayload) => {
      for (const handler of [...recordHandlers]) handler(record);
    },
  };
}

describe("createMacDesktopStreamSource", () => {
  it("withholds P-frames after a sequence gap until the next keyframe", () => {
    const { api, push } = controlledApi();
    const received: Array<{ keyframe: boolean; seq?: number }> = [];
    const source = createMacDesktopStreamSource({
      api: api as never,
      laneId: "lane-1",
      subscriptionId: "sub-1",
      viewerLabel: "ADE Web",
    });
    const unsubscribe = source.subscribe({
      onRecord: (record) => {
        if (record.kind === "access-unit") received.push({ keyframe: record.keyframe, seq: record.seq });
      },
      onError: vi.fn(),
      onEnd: vi.fn(),
    });

    push(configRecord("sub-1", 0));
    push(frameRecord("sub-1", 1, true));
    push(frameRecord("sub-1", 2, false));
    expect(received).toHaveLength(2);

    // The host skipped 3 and 4 under backpressure.
    push(frameRecord("sub-1", 5, false));
    push(frameRecord("sub-1", 6, false));
    expect(received).toHaveLength(2);

    push(frameRecord("sub-1", 7, true));
    expect(received).toHaveLength(3);
    expect(received[2]).toEqual({ keyframe: true, seq: 7 });

    // Another subscription's records never reach this source.
    push(frameRecord("sub-other", 8, true));
    expect(received).toHaveLength(3);
    unsubscribe();
  });
});

describe("WorkToolReadOnlyView live poll", () => {
  beforeEach(() => {
    (window as unknown as { ade?: unknown }).ade = undefined;
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as never;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder;
    delete (globalThis as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk;
  });

  it("skips the still fetch and lengthens the poll while the live picture plays", async () => {
    installFakeWebCodecs({ drawOnDecode: true });
    const { api, streamSubscribe, push } = controlledApi();
    const readObservationPreview = vi.fn(async () => ({
      dataUrl: DATA_URL,
      mimeType: "image/png",
      byteLength: 4,
    }));
    const getLaneState = vi.fn(async () => laneState());
    (window as unknown as { ade: unknown }).ade = {
      workTools: { getLaneState, readObservationPreview },
      macDesktop: api,
    };

    const intervals: Array<{ callback: TimerHandler; delay?: number }> = [];
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    setIntervalSpy.mockImplementation(((callback: TimerHandler, delay?: number) => {
      intervals.push({ callback, delay });
      return 0;
    }) as unknown as typeof window.setInterval);
    // testing-library's waitFor polls on its own 50ms interval; only the
    // component's two poll cadences are this test's business.
    const pollIntervals = () => intervals.filter((entry) =>
      entry.delay === WORK_TOOL_READ_ONLY_POLL_MS || entry.delay === WORK_TOOL_READ_ONLY_LIVE_POLL_MS);

    const { unmount } = render(<WorkToolReadOnlyView tool="mac-desktop" laneId="lane-1" />);

    // Before the picture: one still fetch and the four-second poll.
    await waitFor(() => expect(readObservationPreview).toHaveBeenCalledTimes(1));
    expect(pollIntervals().at(-1)?.delay).toBe(WORK_TOOL_READ_ONLY_POLL_MS);

    await waitFor(() => expect(streamSubscribe).toHaveBeenCalledTimes(1));
    const subscriptionId = streamSubscribe.mock.calls[0]![0].subscriptionId;
    push(configRecord(subscriptionId, 0));
    push(frameRecord(subscriptionId, 1, true));
    await waitFor(() =>
      expect(document.querySelector("canvas")?.getAttribute("data-status")).toBe("playing"));
    await waitFor(() => expect(pollIntervals().at(-1)?.delay).toBe(WORK_TOOL_READ_ONLY_LIVE_POLL_MS));

    // A later poll notices a new observation path. The live picture replaces
    // the still, so it must not be fetched.
    getLaneState.mockResolvedValue(laneState({
      macDesktop: macDesktopState({
        lastObservation: {
          id: "obs-2",
          capturedAt: "2026-01-02T00:00:05.000Z",
          caption: "Newer frame",
          screenshotPath: "/tmp/obs/obs-2.png",
        },
      }),
    }));
    const poll = pollIntervals().at(-1)?.callback;
    expect(typeof poll).toBe("function");
    (poll as () => void)();
    await waitFor(() => expect(getLaneState.mock.calls.length).toBeGreaterThan(1));
    expect(readObservationPreview).toHaveBeenCalledTimes(1);

    unmount();
  });
});
