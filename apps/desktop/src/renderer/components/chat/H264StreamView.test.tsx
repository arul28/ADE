/* @vitest-environment jsdom */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IOS_VIDEO_RECORD_FLAG_KEYFRAME,
  IOS_VIDEO_RECORD_HEADER_BYTES,
  IOS_VIDEO_RECORD_MAGIC,
  IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT,
  IOS_VIDEO_RECORD_TYPE_CONFIG,
} from "../../../shared/types/iosSimulator";
import { H264StreamView } from "./H264StreamView";
import type { H264PushSource, H264RecordHandlers } from "./h264StreamPlayer";

/**
 * WebCodecs, fetch and WebSocket are the boundaries: jsdom has none of them,
 * so each is faked and everything between them is the real player.
 */

type DecoderInit = {
  output: (frame: { displayWidth: number; displayHeight: number; close: () => void }) => void;
  error: (error: Error) => void;
};

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  state = "unconfigured";
  decodeQueueSize = 0;
  configure = vi.fn(() => {
    this.state = "configured";
  });
  close = vi.fn(() => {
    this.state = "closed";
  });
  decode = vi.fn();
  private readonly init: DecoderInit;

  constructor(init: DecoderInit) {
    this.init = init;
    FakeVideoDecoder.instances.push(this);
  }

  drawFrame(): { close: ReturnType<typeof vi.fn> } {
    const frame = { displayWidth: 16, displayHeight: 9, close: vi.fn() };
    this.init.output(frame);
    return frame;
  }

  /** WebCodecs closes a decoder that errors, then calls back. */
  fail(message: string): void {
    this.state = "closed";
    this.init.error(new Error(message));
  }
}

class FakeEncodedVideoChunk {
  constructor(readonly init: unknown) {}
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  closeWith(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const decoders = () => FakeVideoDecoder.instances;

/** One framed record, written the way the host writes it. */
function framed(type: number, payload: Uint8Array, keyframe = false): Uint8Array {
  const record = new Uint8Array(IOS_VIDEO_RECORD_HEADER_BYTES + payload.byteLength);
  const view = new DataView(record.buffer);
  view.setUint32(0, IOS_VIDEO_RECORD_MAGIC, false);
  view.setUint8(4, type);
  view.setUint8(5, keyframe ? IOS_VIDEO_RECORD_FLAG_KEYFRAME : 0);
  view.setUint32(8, payload.byteLength, false);
  record.set(payload, IOS_VIDEO_RECORD_HEADER_BYTES);
  return record;
}

/** A config record and a keyframe, as the host sends to a reader that attaches. */
function attachBytes(): Uint8Array {
  const config = framed(
    IOS_VIDEO_RECORD_TYPE_CONFIG,
    new TextEncoder().encode(JSON.stringify({ codec: "avc1.640032", width: 1179, height: 2556 })),
  );
  const keyframe = framed(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, new Uint8Array([1, 2, 3]), true);
  const out = new Uint8Array(config.byteLength + keyframe.byteLength);
  out.set(config, 0);
  out.set(keyframe, config.byteLength);
  return out;
}

/** A fetch whose bodies the test writes to, one per dial. */
function installFetch() {
  const dials: Array<{ url: string; init: RequestInit; write: (bytes: Uint8Array) => void }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
      },
    });
    init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    dials.push({ url, init, write: (bytes) => controller.enqueue(bytes) });
    return { ok: true, status: 200, body } as unknown as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { dials, fetchMock };
}

const CONFIG_RECORD = {
  kind: "config" as const,
  codec: "avc1.640032",
  width: 2560,
  height: 1440,
  annexB: true,
};

function accessUnit(keyframe: boolean, seq?: number) {
  return { kind: "access-unit" as const, keyframe, seq, bytes: new Uint8Array([1, 2, 3]) };
}

function createPushSource() {
  let handlers: H264RecordHandlers | null = null;
  const unsubscribe = vi.fn(() => {
    handlers = null;
  });
  const source: H264PushSource = {
    kind: "push",
    subscribe(next) {
      handlers = next;
      return unsubscribe;
    },
  };
  return {
    source,
    unsubscribe,
    push: (record: Parameters<H264RecordHandlers["onRecord"]>[0]) => handlers?.onRecord(record),
  };
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeVideoDecoder.instances = [];
  FakeWebSocket.instances = [];
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.VideoDecoder = FakeVideoDecoder;
  scope.EncodedVideoChunk = FakeEncodedVideoChunk;
  scope.WebSocket = FakeWebSocket;
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as never;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  const scope = globalThis as unknown as Record<string, unknown>;
  delete scope.VideoDecoder;
  delete scope.EncodedVideoChunk;
});

describe("H264StreamView over a loopback body", () => {
  /*
   * The reader's one security-relevant contract: the helper's frame server
   * authorises on `Authorization: bearer <token>` and STRIPS the query string
   * before it matches the path. A token carried in the URL is therefore never
   * read, and the request is answered 403 — which is what happened until the
   * reader started sending the header.
   */
  it.each([
    { token: "s3cret", headers: { authorization: "bearer s3cret" } },
    { token: null, headers: undefined },
  ])("sends token $token as the Authorization header only", async ({ token, headers }) => {
    const { dials } = installFetch();
    render(<H264StreamView source={{ kind: "http", url: "http://127.0.0.1:51234/ios-simulator-video", bearerToken: token }} />);

    await waitFor(() => expect(dials).toHaveLength(1));
    expect(dials[0]!.url).toBe("http://127.0.0.1:51234/ios-simulator-video");
    expect(dials[0]!.init.headers).toEqual(headers);
  });

  it("redials when the token changes, not only when the url does", async () => {
    const { dials } = installFetch();
    const url = "http://127.0.0.1:51234/ios-simulator-video";
    const { rerender } = render(<H264StreamView source={{ kind: "http", url, bearerToken: "first" }} />);
    await waitFor(() => expect(dials).toHaveLength(1));

    // An equal source rebuilt by a re-render is the same stream.
    rerender(<H264StreamView source={{ kind: "http", url, bearerToken: "first" }} />);
    // A stream restart rotates the token on the same loopback port, so a reader
    // keyed only on the url would keep presenting a token the helper has
    // already invalidated.
    rerender(<H264StreamView source={{ kind: "http", url, bearerToken: "second" }} />);
    await waitFor(() => expect(dials).toHaveLength(2));
    expect(dials[1]!.init.headers).toEqual({ authorization: "bearer second" });
    expect(dials[0]!.init.signal?.aborted).toBe(true);
  });

  it("names a 403 as a refused token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
    const onStatus = vi.fn();
    render(
      <H264StreamView
        source={{ kind: "http", url: "http://127.0.0.1:51234/x", bearerToken: "bad" }}
        streamName="simulator video stream"
        onStatus={onStatus}
      />,
    );
    await waitFor(() => {
      expect(onStatus).toHaveBeenCalledWith("error", "The simulator video stream refused this token.");
    });
  });

  it("redials on a decoder failure, and gives up only on the third inside the window", async () => {
    const { dials } = installFetch();
    const onStatus = vi.fn();
    render(
      <H264StreamView
        source={{ kind: "http", url: "http://127.0.0.1:51234/ios-simulator-video", bearerToken: "t" }}
        streamGoneCode="APPLE_STREAM_NOT_RUNNING"
        onStatus={onStatus}
      />,
    );
    const attachAndFail = async (dial: number, draw = false) => {
      await waitFor(() => expect(dials).toHaveLength(dial + 1));
      dials[dial]!.write(attachBytes());
      await waitFor(() => expect(decoders()[dial]?.decode).toHaveBeenCalledTimes(1));
      if (draw) decoders()[dial]!.drawFrame();
      decoders()[dial]!.fail("bad access unit");
    };

    // One rejected access unit is not a dead stream: a new reader gets the
    // host's config and a fresh keyframe.
    await attachAndFail(0);
    await attachAndFail(1);
    // A stream that draws again has recovered, so its count starts over.
    await attachAndFail(2, true);
    await attachAndFail(3);
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());

    await attachAndFail(4);
    await waitFor(() => {
      expect(onStatus).toHaveBeenLastCalledWith("error", "APPLE_STREAM_NOT_RUNNING: bad access unit");
    });
    expect(dials).toHaveLength(5);
  });
});

describe("H264StreamView over the brain's relay socket", () => {
  it("says visible on open and hidden on teardown", async () => {
    const { unmount } = render(<H264StreamView source={{ kind: "socket", url: "wss://brain.test/apple/stream/t1" }} />);
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toBe("wss://brain.test/apple/stream/t1");
    socket.open();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ t: "visible" }));

    unmount();
    await waitFor(() => expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ t: "hidden" })));
    expect(socket.close).toHaveBeenCalled();
  });

  it("names a 4401 close as a refused ticket", async () => {
    const onStatus = vi.fn();
    render(
      <H264StreamView
        source={{ kind: "socket", url: "wss://brain.test/apple/stream/t1" }}
        streamName="simulator video stream"
        onStatus={onStatus}
      />,
    );
    FakeWebSocket.instances[0]!.closeWith(4401);
    await waitFor(() => {
      expect(onStatus).toHaveBeenCalledWith("error", "The simulator video stream refused this ticket.");
    });
  });
});

describe("H264StreamView over pushed records", () => {
  it("reports playing once, and only once a frame has been drawn", async () => {
    const { source, push, unsubscribe } = createPushSource();
    const onStatus = vi.fn();
    const onFrame = vi.fn();
    const { container, unmount } = render(<H264StreamView source={source} onStatus={onStatus} onFrame={onFrame} />);
    const canvas = container.querySelector("canvas")!;

    push(CONFIG_RECORD);
    push(accessUnit(true, 0));
    // The chunk was submitted, but nothing has reached the canvas yet: a
    // decoder that accepted bytes is not a picture on screen.
    expect(decoders()[0]!.decode).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalledWith("playing", null);

    const frames = [decoders()[0]!.drawFrame(), decoders()[0]!.drawFrame(), decoders()[0]!.drawFrame()];
    await waitFor(() => expect(canvas.getAttribute("data-status")).toBe("playing"));
    expect(onStatus.mock.calls.filter(([status]) => status === "playing")).toHaveLength(1);
    expect(onFrame).toHaveBeenCalledTimes(3);
    // A VideoFrame holds a GPU buffer; one left open stalls the decoder.
    for (const frame of frames) expect(frame.close).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(decoders()[0]!.close).toHaveBeenCalled();
  });

  it("holds P-frames after a sequence gap until the keyframe", () => {
    const { source, push } = createPushSource();
    render(<H264StreamView source={source} />);
    push(CONFIG_RECORD);
    push(accessUnit(true, 1));
    push(accessUnit(false, 2));
    expect(decoders()[0]!.decode).toHaveBeenCalledTimes(2);

    // Backpressure skipped 3 and 4: nothing may be submitted until the host's
    // next keyframe, whatever the P-frames in between claim.
    push(accessUnit(false, 5));
    push(accessUnit(false, 6));
    expect(decoders()[0]!.decode).toHaveBeenCalledTimes(2);

    push(accessUnit(true, 7));
    expect(decoders()[0]!.decode).toHaveBeenCalledTimes(3);
  });

  it("rebuilds the decoder after an error and holds P-frames until the next keyframe", () => {
    const { source, push } = createPushSource();
    const onStatus = vi.fn();
    render(<H264StreamView source={source} onStatus={onStatus} />);
    push(CONFIG_RECORD);
    push(accessUnit(true, 0));

    decoders()[0]!.fail("decoder exploded");
    // Pushed records cannot be redialled: the next keyframe restarts the
    // picture on a new decoder built from the last config.
    expect(decoders()).toHaveLength(2);
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
    push(accessUnit(false, 1));
    expect(decoders()[1]!.decode).not.toHaveBeenCalled();

    push(accessUnit(true, 2));
    expect(decoders()[1]!.decode).toHaveBeenCalledTimes(1);
  });

  it("waits for a keyframe after a config rebuilds the decoder", () => {
    const { source, push } = createPushSource();
    render(<H264StreamView source={source} />);
    push(CONFIG_RECORD);
    push(accessUnit(true, 0));
    expect(decoders()[0]!.decode).toHaveBeenCalledTimes(1);

    push(CONFIG_RECORD);
    expect(decoders()[0]!.close).toHaveBeenCalled();
    push(accessUnit(false, 1));
    expect(decoders()[1]!.decode).not.toHaveBeenCalled();

    push(accessUnit(true, 2));
    expect(decoders()[1]!.decode).toHaveBeenCalledTimes(1);
  });

  it("skips to the next keyframe when the decoder falls behind, but not for a burst", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { source, push } = createPushSource();
    render(<H264StreamView source={source} />);
    const decode = () => decoders()[0]!.decode;
    const nextTurn = () => act(() => {
      vi.runOnlyPendingTimers();
    });

    // A burst read in one go fills the queue by itself and drains in
    // milliseconds: every frame of it is decoded.
    push(CONFIG_RECORD);
    push(accessUnit(true, 1));
    decoders()[0]!.decodeQueueSize = 3;
    push(accessUnit(false, 2));
    push(accessUnit(false, 3));
    expect(decode()).toHaveBeenCalledTimes(3);

    // A turn later the decoder still holds them: it is behind. The delta is
    // skipped, and so is every delta after it — they reference the skipped
    // one — until a keyframe, even once the queue has drained.
    nextTurn();
    push(accessUnit(false, 4));
    expect(decode()).toHaveBeenCalledTimes(3);
    decoders()[0]!.decodeQueueSize = 0;
    nextTurn();
    push(accessUnit(false, 5));
    expect(decode()).toHaveBeenCalledTimes(3);

    push(accessUnit(true, 6));
    push(accessUnit(false, 7));
    expect(decode()).toHaveBeenCalledTimes(5);
  });
});
