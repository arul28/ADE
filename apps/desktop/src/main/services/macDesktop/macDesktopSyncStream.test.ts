import { describe, expect, it, vi } from "vitest";

import {
  IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT,
  IOS_VIDEO_RECORD_TYPE_CONFIG,
} from "../../../shared/types/iosSimulator";
import type { MacDesktopEventPayload } from "../../../shared/types/macDesktop";
import type {
  SyncMacDesktopStreamEndedPayload,
  SyncMacDesktopStreamRecordPayload,
} from "../../../shared/types/sync";
import { encodeVideoRecord } from "../media/videoRecords";
import {
  MAC_DESKTOP_SYNC_STREAM_PENDING_LIMIT_BYTES,
  createMacDesktopSyncStream,
  type MacDesktopSyncStreamReader,
} from "./macDesktopSyncStream";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CONFIG_JSON = JSON.stringify({
  codec: "avc1.640032",
  width: 2560,
  height: 1440,
  annexB: true,
});

function configRecord(): Buffer {
  return Buffer.from(encodeVideoRecord(IOS_VIDEO_RECORD_TYPE_CONFIG, Buffer.from(CONFIG_JSON, "utf8")));
}

function frameRecord(payload: Buffer, keyframe: boolean): Buffer {
  return Buffer.from(encodeVideoRecord(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, payload, { keyframe }));
}

function createFakeReader() {
  const chunkHandlers: Array<(chunk: Buffer) => void> = [];
  const endHandlers: Array<() => void> = [];
  const errorHandlers: Array<(message: string) => void> = [];
  const state = { closed: false };
  const reader: MacDesktopSyncStreamReader = {
    onChunk: (callback) => chunkHandlers.push(callback),
    onEnd: (callback) => endHandlers.push(callback),
    onError: (callback) => errorHandlers.push(callback),
    close: () => {
      state.closed = true;
    },
  };
  return {
    reader,
    state,
    push: (bytes: Uint8Array) => {
      for (const handler of chunkHandlers) handler(Buffer.from(bytes));
    },
    end: () => {
      for (const handler of endHandlers) handler();
    },
    fail: (message: string) => {
      for (const handler of errorHandlers) handler(message);
    },
  };
}

function createSink(connectionId = "conn-1") {
  const records: SyncMacDesktopStreamRecordPayload[] = [];
  const ended: SyncMacDesktopStreamEndedPayload[] = [];
  let pending = 0;
  return {
    records,
    ended,
    setPendingBytes: (value: number) => {
      pending = value;
    },
    sink: {
      connectionId,
      sendRecord: (record: SyncMacDesktopStreamRecordPayload) => {
        records.push(record);
      },
      sendEnded: (event: SyncMacDesktopStreamEndedPayload) => {
        ended.push(event);
      },
      pendingBytes: () => pending,
    },
  };
}

function createHarness(options: {
  reader?: ReturnType<typeof createFakeReader>;
  startStream?: (args: { laneId: string; ownerId: string }) => Promise<{
    url: string;
    width: number | null;
    height: number | null;
    codec: string | null;
  }>;
} = {}) {
  const reader = options.reader ?? createFakeReader();
  const startStream = vi.fn(options.startStream ?? (async () => ({
    url: "http://127.0.0.1:9/mac-desktop/stream?lane=lane-1&token=t",
    width: 2560,
    height: 1440,
    codec: "avc1.640032",
  })));
  const releaseOwner = vi.fn();
  const eventListeners: Array<(event: MacDesktopEventPayload) => void> = [];
  let clock = 0;
  const stream = createMacDesktopSyncStream({
    logger,
    startStream,
    releaseOwner,
    subscribeEvents: (listener) => {
      eventListeners.push(listener);
      return () => {
        const index = eventListeners.indexOf(listener);
        if (index >= 0) eventListeners.splice(index, 1);
      };
    },
    now: () => {
      clock += 1_000;
      return clock;
    },
    openReader: () => reader.reader,
  });
  return {
    stream,
    reader,
    startStream,
    releaseOwner,
    emitEvent: (event: MacDesktopEventPayload) => {
      for (const listener of [...eventListeners]) listener(event);
    },
  };
}

describe("macDesktopSyncStream", () => {
  it("pushes a config first, then the keyframe and the frames that follow it", async () => {
    const harness = createHarness();
    const sink = createSink();
    const result = await harness.stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-1",
      connectionId: "conn-1",
      sink: sink.sink,
    });

    expect(result).toEqual({ ok: true, width: 2560, height: 1440, codec: "avc1.640032" });
    expect(harness.startStream).toHaveBeenCalledWith({ laneId: "lane-1", ownerId: "sub-1" });

    const keyframe = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]);
    const delta = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x9a]);
    harness.reader.push(configRecord());
    harness.reader.push(frameRecord(keyframe, true));
    harness.reader.push(frameRecord(delta, false));

    expect(sink.records.map((record) => [record.kind, record.keyframe])).toEqual([
      ["config", false],
      ["frame", true],
      ["frame", false],
    ]);
    expect(sink.records.map((record) => record.seq)).toEqual([0, 1, 2]);
    expect(sink.records[0]?.subscriptionId).toBe("sub-1");
    expect(Buffer.from(sink.records[0]!.data, "base64").toString("utf8")).toBe(CONFIG_JSON);
    expect(Buffer.from(sink.records[1]!.data, "base64")).toEqual(keyframe);
    expect(Buffer.from(sink.records[2]!.data, "base64")).toEqual(delta);
    expect(sink.records[1]!.timestampUs).toBeGreaterThan(0);
    expect(sink.records[2]!.timestampUs).toBeGreaterThanOrEqual(sink.records[1]!.timestampUs);
  });

  it("drops frames above the pending limit until the next keyframe arrives", async () => {
    const harness = createHarness();
    const sink = createSink();
    await harness.stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-1",
      connectionId: "conn-1",
      sink: sink.sink,
    });

    harness.reader.push(configRecord());
    harness.reader.push(frameRecord(Buffer.from([1]), false));
    expect(sink.records.map((record) => record.kind)).toEqual(["config", "frame"]);

    sink.setPendingBytes(MAC_DESKTOP_SYNC_STREAM_PENDING_LIMIT_BYTES + 1);
    harness.reader.push(frameRecord(Buffer.from([2]), false));
    harness.reader.push(frameRecord(Buffer.from([3]), false));
    expect(sink.records).toHaveLength(2);

    // The keyframe is the one record that can restart the reference chain, so
    // it goes even while the sink is still over the limit.
    harness.reader.push(frameRecord(Buffer.from([4]), true));
    expect(sink.records).toHaveLength(3);
    expect(sink.records[2]!.keyframe).toBe(true);

    // The limit is re-checked per frame, not latched: once the sink drains, a
    // P-frame is deliverable again.
    sink.setPendingBytes(0);
    harness.reader.push(frameRecord(Buffer.from([5]), false));
    expect(sink.records).toHaveLength(4);
    expect(harness.stream.droppedFrameCount("sub-1")).toBe(2);
    // `seq` counts source records: the two dropped frames leave a gap (1 → 4)
    // so a client can hold P-frames until the keyframe that follows it.
    expect(sink.records.map((record) => record.seq)).toEqual([0, 1, 4, 5]);
  });

  it("releases the owner and tells the client when it unsubscribes", async () => {
    const harness = createHarness();
    const sink = createSink();
    await harness.stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-1",
      connectionId: "conn-1",
      sink: sink.sink,
    });

    harness.stream.unsubscribe("sub-1");

    expect(harness.reader.state.closed).toBe(true);
    expect(harness.releaseOwner).toHaveBeenCalledWith("sub-1");
    expect(sink.ended).toEqual([{ subscriptionId: "sub-1", reason: "unsubscribed" }]);
    expect(harness.stream.subscriptionCount()).toBe(0);
  });

  it("releases the owner without notifying when the sync connection closes", async () => {
    const harness = createHarness();
    const sink = createSink("conn-2");
    await harness.stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-2",
      connectionId: "conn-2",
      sink: sink.sink,
    });

    harness.stream.releaseConnection("conn-2");

    expect(harness.reader.state.closed).toBe(true);
    expect(harness.releaseOwner).toHaveBeenCalledWith("sub-2");
    // The socket is gone; an ended notice has nowhere to go.
    expect(sink.ended).toHaveLength(0);
    expect(harness.stream.subscriptionCount()).toBe(0);
  });

  it("releases the owner when the display is destroyed or the stream stops", async () => {
    const harness = createHarness();
    const sink = createSink();
    await harness.stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-1",
      connectionId: "conn-1",
      sink: sink.sink,
    });

    harness.emitEvent({ type: "display-destroyed", laneId: "lane-1", reason: "idle" });
    expect(sink.ended).toEqual([{ subscriptionId: "sub-1", reason: "display_destroyed" }]);
    expect(harness.releaseOwner).toHaveBeenCalledWith("sub-1");
    expect(harness.reader.state.closed).toBe(true);

    harness.emitEvent({
      type: "display-destroyed",
      laneId: "lane-2",
      reason: "stopped",
    });
    expect(sink.ended).toHaveLength(1);
  });

  it("releases an owner whose unsubscribe raced the start call", async () => {
    let resolveStart: ((value: {
      url: string;
      width: number | null;
      height: number | null;
      codec: string | null;
    }) => void) | null = null;
    const harness = createHarness({
      startStream: () => new Promise((resolve) => {
        resolveStart = resolve;
      }),
    });
    const sink = createSink();

    const starting = harness.stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-race",
      connectionId: "conn-1",
      sink: sink.sink,
    });
    harness.stream.unsubscribe("sub-race");
    resolveStart!({ url: "http://127.0.0.1:9/stream", width: null, height: null, codec: null });
    await starting;

    expect(harness.releaseOwner).toHaveBeenCalledWith("sub-race");
    expect(harness.stream.subscriptionCount()).toBe(0);
    expect(harness.reader.state.closed).toBe(false);
  });

  it("ends a subscription with an error when the framed bytes are unreadable", async () => {
    const harness = createHarness();
    const sink = createSink();
    await harness.stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-1",
      connectionId: "conn-1",
      sink: sink.sink,
    });

    harness.reader.push(Buffer.from("not-a-record"));

    expect(sink.ended).toHaveLength(1);
    expect(sink.ended[0]!.reason).toBe("error");
    expect(sink.ended[0]!.message).toContain("not framed as expected");
    expect(harness.releaseOwner).toHaveBeenCalledWith("sub-1");
  });

  it("cleans up on dispose and refuses later subscribes", async () => {
    const harness = createHarness();
    const sink = createSink();
    await harness.stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-1",
      connectionId: "conn-1",
      sink: sink.sink,
    });

    harness.stream.dispose();

    expect(sink.ended).toHaveLength(0);
    expect(harness.releaseOwner).toHaveBeenCalledWith("sub-1");
    await expect(harness.stream.subscribe({
      laneId: "lane-1",
      subscriptionId: "sub-2",
      connectionId: "conn-1",
      sink: sink.sink,
    })).rejects.toThrow(/disposed/);
  });
});
