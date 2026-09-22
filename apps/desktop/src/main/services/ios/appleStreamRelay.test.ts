import { describe, expect, it, vi } from "vitest";

import {
  APPLE_STREAM_PATH_PREFIX,
  APPLE_STREAM_TICKET_TTL_MS,
  createAppleStreamRelay,
  splitAppleStreamRecords,
  type AppleStreamSource,
  type AppleStreamUpstream,
  type AppleStreamViewerSocket,
} from "./appleStreamRelay";
import {
  IOS_VIDEO_RECORD_FLAG_KEYFRAME,
  IOS_VIDEO_RECORD_HEADER_BYTES,
  IOS_VIDEO_RECORD_MAGIC,
  IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT,
  IOS_VIDEO_RECORD_TYPE_CONFIG,
} from "../../../shared/types/iosSimulator";

function record(type: number, payload: Uint8Array, keyframe = false): Uint8Array {
  const bytes = new Uint8Array(IOS_VIDEO_RECORD_HEADER_BYTES + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, IOS_VIDEO_RECORD_MAGIC, false);
  view.setUint8(4, type);
  view.setUint8(5, keyframe ? IOS_VIDEO_RECORD_FLAG_KEYFRAME : 0);
  view.setUint32(8, payload.byteLength, false);
  bytes.set(payload, IOS_VIDEO_RECORD_HEADER_BYTES);
  return bytes;
}

const configRecord = record(
  IOS_VIDEO_RECORD_TYPE_CONFIG,
  new TextEncoder().encode(JSON.stringify({ codec: "avc1.42E01E", width: 393, height: 852, annexB: true })),
);
const keyframeRecord = record(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, new Uint8Array([1, 2, 3, 4]), true);
const deltaRecord = record(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, new Uint8Array([9, 9]), false);

function fakeUpstream(): AppleStreamUpstream & { push(chunk: Uint8Array): void; end(error?: Error): void; closed: () => boolean } {
  let data: ((chunk: Uint8Array) => void) | null = null;
  let end: ((error?: Error) => void) | null = null;
  let closed = false;
  return {
    onData: (listener) => {
      data = listener;
    },
    onEnd: (listener) => {
      end = listener;
    },
    close: () => {
      closed = true;
    },
    push: (chunk) => data?.(chunk),
    end: (error) => end?.(error),
    closed: () => closed,
  };
}

function fakeSocket(): AppleStreamViewerSocket & {
  sent: Uint8Array[];
  emit(event: "message" | "close" | "error", ...args: unknown[]): void;
  closeCode: number | null;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const sent: Uint8Array[] = [];
  let closeCode: number | null = null;
  return {
    sent,
    get closeCode() {
      return closeCode;
    },
    send: (data: Uint8Array) => {
      sent.push(data);
    },
    close: (code?: number) => {
      closeCode = code ?? 1000;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  } as never;
}

function harness(overrides: Partial<Parameters<typeof createAppleStreamRelay>[0]> = {}) {
  const upstream = fakeUpstream();
  const openSource = vi.fn(async (): Promise<AppleStreamSource> => ({
    url: "http://127.0.0.1:52341/stream",
    token: "helper-token",
  }));
  const closeSource = vi.fn(async () => {});
  let nowMs = 1_700_000_000_000;
  const relay = createAppleStreamRelay({
    openSource,
    closeSource,
    connect: () => upstream,
    now: () => nowMs,
    ...overrides,
  });
  return {
    relay,
    upstream,
    openSource,
    closeSource,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("splitAppleStreamRecords", () => {
  it("returns whole records and keeps the partial tail", () => {
    const stream = new Uint8Array(configRecord.byteLength + keyframeRecord.byteLength + 5);
    stream.set(configRecord, 0);
    stream.set(keyframeRecord, configRecord.byteLength);
    stream.set(new Uint8Array(5), configRecord.byteLength + keyframeRecord.byteLength);
    // Feed everything but the last two bytes so the second record is complete
    // and a 3-byte fragment of a third is left over.
    const { records, rest } = splitAppleStreamRecords(stream.subarray(0, stream.byteLength - 2));
    expect(records).toHaveLength(2);
    expect(records[0]?.type).toBe(IOS_VIDEO_RECORD_TYPE_CONFIG);
    expect(records[1]?.keyframe).toBe(true);
    expect(rest.byteLength).toBe(3);
  });

  it("refuses a stream that is not framed as expected", () => {
    expect(() => splitAppleStreamRecords(new Uint8Array(IOS_VIDEO_RECORD_HEADER_BYTES)))
      .toThrow(/not framed as expected/);
  });
});

describe("createAppleStreamRelay tickets", () => {
  it("issues a single-use ticket carrying the path, token, and geometry", () => {
    const { relay } = harness();
    const ticket = relay.issue({ laneId: "lane-a", codec: "avc1.42E01E", width: 393, height: 852 });
    expect(ticket.path.startsWith(APPLE_STREAM_PATH_PREFIX)).toBe(true);
    expect(ticket.token).toHaveLength(43);
    expect(ticket.codec).toBe("avc1.42E01E");
    expect(ticket.width).toBe(393);
    expect(relay.ticketFromUrl(`${ticket.path}?token=x`)).toBe(ticket.ticket);
    expect(relay.ticketFromUrl("/other/path")).toBeNull();
  });

  it("builds an absolute url when the host knows its own origin", () => {
    const { relay } = harness({ publicOrigin: () => "ws://10.0.0.4:8787/" });
    const ticket = relay.issue({ laneId: "lane-a" });
    expect(ticket.url).toBe(`ws://10.0.0.4:8787${ticket.path}?token=${ticket.token}`);
  });

  it("refuses an expired ticket and closes the socket", async () => {
    const { relay, advance } = harness();
    const ticket = relay.issue({ laneId: "lane-a" });
    advance(APPLE_STREAM_TICKET_TTL_MS + 1);
    const socket = fakeSocket();
    await expect(relay.attach(socket, { ticket: ticket.ticket, token: ticket.token })).resolves.toBe(false);
    expect(socket.closeCode).toBe(4401);
  });

  it("refuses a wrong token and cannot be replayed once used", async () => {
    const { relay } = harness();
    const ticket = relay.issue({ laneId: "lane-a" });
    const wrong = fakeSocket();
    await expect(relay.attach(wrong, { ticket: ticket.ticket, token: "nope" })).resolves.toBe(false);

    const first = fakeSocket();
    await expect(relay.attach(first, { ticket: ticket.ticket, token: ticket.token })).resolves.toBe(true);
    const replay = fakeSocket();
    await expect(relay.attach(replay, { ticket: ticket.ticket, token: ticket.token })).resolves.toBe(false);
    expect(replay.closeCode).toBe(4401);
  });
});

describe("createAppleStreamRelay forwarding", () => {
  it("passes records through unchanged, one frame per record", async () => {
    const { relay, upstream } = harness();
    const ticket = relay.issue({ laneId: "lane-a" });
    const socket = fakeSocket();
    await relay.attach(socket, { ticket: ticket.ticket, token: ticket.token });

    // Split across chunk boundaries the way a real body does.
    const joined = new Uint8Array(configRecord.byteLength + keyframeRecord.byteLength);
    joined.set(configRecord, 0);
    joined.set(keyframeRecord, configRecord.byteLength);
    upstream.push(joined.subarray(0, configRecord.byteLength + 3));
    upstream.push(joined.subarray(configRecord.byteLength + 3));

    expect(socket.sent).toHaveLength(2);
    expect(Buffer.from(socket.sent[0]!)).toEqual(Buffer.from(configRecord));
    expect(Buffer.from(socket.sent[1]!)).toEqual(Buffer.from(keyframeRecord));
  });

  it("primes a late joiner with the cached config and keyframe", async () => {
    const { relay, upstream } = harness();
    const first = relay.issue({ laneId: "lane-a" });
    const firstSocket = fakeSocket();
    await relay.attach(firstSocket, { ticket: first.ticket, token: first.token });
    upstream.push(configRecord);
    upstream.push(keyframeRecord);
    upstream.push(deltaRecord);

    const second = relay.issue({ laneId: "lane-a" });
    const secondSocket = fakeSocket();
    await relay.attach(secondSocket, { ticket: second.ticket, token: second.token });
    expect(secondSocket.sent.map((bytes) => Buffer.from(bytes))).toEqual([
      Buffer.from(configRecord),
      Buffer.from(keyframeRecord),
    ]);
  });

  it("starts capture once for a lane no matter how many viewers attach", async () => {
    const { relay, openSource } = harness();
    for (let index = 0; index < 3; index += 1) {
      const ticket = relay.issue({ laneId: "lane-a" });
      // eslint-disable-next-line no-await-in-loop
      await relay.attach(fakeSocket(), { ticket: ticket.ticket, token: ticket.token });
    }
    expect(openSource).toHaveBeenCalledTimes(1);
    expect(openSource).toHaveBeenCalledWith({ laneId: "lane-a" });
    expect(relay.viewerCount("lane-a")).toBe(3);
  });

  it("stops forwarding on hidden and resumes on visible", async () => {
    const { relay, upstream, openSource } = harness();
    const ticket = relay.issue({ laneId: "lane-a" });
    const socket = fakeSocket();
    await relay.attach(socket, { ticket: ticket.ticket, token: ticket.token });
    upstream.push(configRecord);
    upstream.push(keyframeRecord);
    socket.sent.length = 0;

    socket.emit("message", JSON.stringify({ t: "hidden" }), false);
    expect(relay.visibleViewerCount("lane-a")).toBe(0);
    upstream.push(deltaRecord);
    expect(socket.sent).toHaveLength(0);

    socket.emit("message", JSON.stringify({ t: "visible" }), false);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(relay.visibleViewerCount("lane-a")).toBe(1);
    // The resumed viewer is re-primed so it can decode without waiting for an IDR.
    expect(openSource).toHaveBeenCalledTimes(2);
    expect(socket.sent.length).toBeGreaterThan(0);
  });

  it("asks the service to stop capture when the last remote viewer hides and no local viewer is watching", async () => {
    const { relay, upstream, closeSource } = harness();
    const ticket = relay.issue({ laneId: "lane-a" });
    const socket = fakeSocket();
    await relay.attach(socket, { ticket: ticket.ticket, token: ticket.token });
    socket.emit("message", JSON.stringify({ t: "hidden" }), false);
    expect(closeSource).toHaveBeenCalledWith({ laneId: "lane-a", localViewers: false });
    expect(upstream.closed()).toBe(true);
  });

  it("keeps capture up for a local viewer", async () => {
    const hasLocalViewer = vi.fn(() => true);
    const { relay, closeSource } = harness({ hasLocalViewer });
    const ticket = relay.issue({ laneId: "lane-a" });
    const socket = fakeSocket();
    await relay.attach(socket, { ticket: ticket.ticket, token: ticket.token });
    socket.emit("close");
    expect(closeSource).toHaveBeenCalledWith({ laneId: "lane-a", localViewers: true });
  });

  it("drops every viewer when the upstream body ends", async () => {
    const { relay, upstream } = harness();
    const ticket = relay.issue({ laneId: "lane-a" });
    const socket = fakeSocket();
    await relay.attach(socket, { ticket: ticket.ticket, token: ticket.token });
    upstream.end(new Error("helper went away"));
    expect(socket.closeCode).toBe(1012);
    expect(relay.viewerCount("lane-a")).toBe(0);
  });
});
