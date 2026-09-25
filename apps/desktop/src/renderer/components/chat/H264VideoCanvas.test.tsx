/* @vitest-environment jsdom */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { H264VideoCanvas, type H264VideoRecordSource } from "./H264VideoCanvas";

type DecoderInit = {
  output: (frame: { displayWidth: number; displayHeight: number; close: () => void }) => void;
  error: (error: Error) => void;
};

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  state = "unconfigured";
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

  drawFrame(): void {
    this.init.output({ displayWidth: 16, displayHeight: 9, close: () => {} });
  }

  fail(message: string): void {
    this.init.error(new Error(message));
  }
}

class FakeEncodedVideoChunk {
  constructor(readonly init: unknown) {}
}

const CONFIG_RECORD = {
  kind: "config" as const,
  codec: "avc1.640032",
  width: 2560,
  height: 1440,
  annexB: true,
};

function accessUnit(keyframe: boolean, seq: number, bytes = new Uint8Array([1, 2, 3])) {
  return { kind: "access-unit" as const, keyframe, seq, bytes };
}

function createSource() {
  let handlers: Parameters<H264VideoRecordSource["subscribe"]>[0] | null = null;
  const source: H264VideoRecordSource = {
    subscribe(next) {
      handlers = next;
      return () => {
        handlers = null;
      };
    },
  };
  return {
    source,
    push: (record: Parameters<NonNullable<typeof handlers>["onRecord"]>[0]) => handlers?.onRecord(record),
  };
}

describe("H264VideoCanvas", () => {
  beforeEach(() => {
    FakeVideoDecoder.instances = [];
    (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder = FakeVideoDecoder;
    (globalThis as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk = FakeEncodedVideoChunk;
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: vi.fn(),
    })) as never;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder;
    delete (globalThis as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk;
  });

  it("reports playing only once a frame has been drawn", async () => {
    const { source, push } = createSource();
    const { container } = render(<H264VideoCanvas source={source} />);
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();

    push(CONFIG_RECORD);
    push(accessUnit(true, 0));
    // The chunk was submitted, but nothing has reached the canvas yet: a
    // decoder that accepted bytes is not a picture on screen.
    expect(FakeVideoDecoder.instances[0]!.decode).toHaveBeenCalledTimes(1);
    expect(canvas!.getAttribute("data-status")).toBe("connecting");

    FakeVideoDecoder.instances[0]!.drawFrame();
    await waitFor(() => expect(canvas!.getAttribute("data-status")).toBe("playing"));
  });

  it("holds P-frames after a sequence gap until the keyframe", () => {
    const { source, push } = createSource();
    render(<H264VideoCanvas source={source} />);
    push(CONFIG_RECORD);
    push(accessUnit(true, 1));
    push(accessUnit(false, 2));
    expect(FakeVideoDecoder.instances[0]!.decode).toHaveBeenCalledTimes(2);

    // Backpressure skipped 3 and 4: nothing may be submitted until the host's
    // next keyframe, whatever the P-frames in between claim.
    push(accessUnit(false, 5));
    push(accessUnit(false, 6));
    expect(FakeVideoDecoder.instances[0]!.decode).toHaveBeenCalledTimes(2);

    push(accessUnit(true, 7));
    expect(FakeVideoDecoder.instances[0]!.decode).toHaveBeenCalledTimes(3);
  });

  it("holds P-frames after a decoder error until the next keyframe", () => {
    const { source, push } = createSource();
    render(<H264VideoCanvas source={source} />);
    push(CONFIG_RECORD);
    push(accessUnit(true, 0));
    expect(FakeVideoDecoder.instances[0]!.decode).toHaveBeenCalledTimes(1);

    FakeVideoDecoder.instances[0]!.fail("decoder exploded");
    push(accessUnit(false, 1));
    expect(FakeVideoDecoder.instances[0]!.decode).toHaveBeenCalledTimes(1);

    push(accessUnit(true, 2));
    expect(FakeVideoDecoder.instances[0]!.decode).toHaveBeenCalledTimes(2);
  });

  it("waits for a keyframe after a config rebuilds the decoder", () => {
    const { source, push } = createSource();
    render(<H264VideoCanvas source={source} />);
    push(CONFIG_RECORD);
    push(accessUnit(true, 0));
    expect(FakeVideoDecoder.instances[0]!.decode).toHaveBeenCalledTimes(1);

    push(CONFIG_RECORD);
    push(accessUnit(false, 1));
    expect(FakeVideoDecoder.instances[1]!.decode).not.toHaveBeenCalled();

    push(accessUnit(true, 2));
    expect(FakeVideoDecoder.instances[1]!.decode).toHaveBeenCalledTimes(1);
  });
});
