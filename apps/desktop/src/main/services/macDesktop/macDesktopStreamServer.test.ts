import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { MAC_DESKTOP_STREAM_PATH } from "../../../shared/types/macDesktop";
import {
  IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT,
  IOS_VIDEO_RECORD_TYPE_CONFIG,
} from "../../../shared/types/iosSimulator";
import { encodeVideoRecord } from "../media/videoRecords";
// The renderer's own reader, used as the assertion: a test that re-implements
// the framing proves the test agrees with itself and nothing else.
import { createIosSimVideoRecordParser } from "../../../renderer/components/chat/iosSimVideoRecords";
import { createMacDesktopStreamServer } from "./macDesktopStreamServer";

/** What the Swift driver actually writes: the config payload is a bare codec. */
const driverConfigRecord = (codec: string): Buffer =>
  Buffer.from(encodeVideoRecord(IOS_VIDEO_RECORD_TYPE_CONFIG, Buffer.from(codec, "utf8")));

const driverAccessUnit = (payload: Buffer, keyframe: boolean): Buffer =>
  Buffer.from(encodeVideoRecord(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, payload, { keyframe }));

/** Reads the response body until `count` records have been parsed, or it ends. */
async function readRecords(response: Response, count: number) {
  const parser = createIosSimVideoRecordParser();
  const reader = response.body!.getReader();
  const records: ReturnType<typeof parser.push> = [];
  while (records.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) records.push(...parser.push(value));
  }
  await reader.cancel().catch(() => {});
  return records;
}

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Stands in for the helper's raw H.264 socket. */
async function startUpstream(payload: Buffer): Promise<{ port: number; close: () => void; server: Server }> {
  const server = createServer((socket) => {
    socket.write(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { port: address.port, close: () => server.close(), server };
}

describe("macDesktopStreamServer", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("refuses a request with no token, a wrong token, and an unknown lane", async () => {
    const upstream = await startUpstream(Buffer.from([1, 2, 3]));
    cleanups.push(upstream.close);
    const server = createMacDesktopStreamServer({ logger });
    cleanups.push(() => server.dispose());
    const transport = await server.start({ laneId: "lane-1", sourcePort: upstream.port });

    const base = `http://127.0.0.1:${transport.port}${MAC_DESKTOP_STREAM_PATH}`;
    const noToken = await fetch(`${base}?lane=lane-1`);
    expect(noToken.status).toBe(403);
    await noToken.arrayBuffer();

    const wrongToken = await fetch(`${base}?lane=lane-1&token=${"0".repeat(64)}`);
    expect(wrongToken.status).toBe(403);
    await wrongToken.arrayBuffer();

    // A lane that exists with the right-looking token still gets one answer:
    // distinguishing "no such lane" would leak which lanes run on this Mac.
    const unknownLane = await fetch(`${base}?lane=lane-2&token=${transport.token}`);
    expect(unknownLane.status).toBe(403);
    await unknownLane.arrayBuffer();

    const wrongPath = await fetch(`http://127.0.0.1:${transport.port}/nope?lane=lane-1&token=${transport.token}`);
    expect(wrongPath.status).toBe(404);
    await wrongPath.arrayBuffer();
  });

  it("rewrites the helper's bare-codec config into the record the renderer parses", async () => {
    // The driver writes `avc1.640032` as the config payload; the renderer
    // JSON.parses it. Forwarding it untouched is what produced "The video
    // stream sent an unreadable configuration." in the panel.
    const accessUnit = Buffer.from([0, 0, 0, 1, 0x65, 0xb8, 0x10]);
    const upstream = await startUpstream(Buffer.concat([
      driverConfigRecord("avc1.640032"),
      driverAccessUnit(accessUnit, true),
    ]));
    cleanups.push(upstream.close);
    const server = createMacDesktopStreamServer({ logger });
    cleanups.push(() => server.dispose());
    const transport = await server.start({
      laneId: "lane-1",
      sourcePort: upstream.port,
      width: 1512,
      height: 945,
    });

    const response = await fetch(transport.url);
    expect(response.status).toBe(200);
    const records = await readRecords(response, 2);
    expect(records[0]).toEqual({
      kind: "config",
      codec: "avc1.640032",
      width: 1512,
      height: 945,
      annexB: true,
    });
    expect(records[1]?.kind).toBe("access-unit");
    expect(records[1]!.kind === "access-unit" && records[1]!.keyframe).toBe(true);
    expect(Buffer.from((records[1] as { bytes: Uint8Array }).bytes)).toEqual(accessUnit);
    // The codec the helper only learns at its first keyframe is now the
    // server's too, so a status read reports it.
    expect(server.metrics("lane-1")?.codec).toBe("avc1.640032");
  });

  it("sends one config per reader when the helper repeats it", async () => {
    const upstream = await startUpstream(Buffer.concat([
      driverConfigRecord("avc1.640032"),
      driverConfigRecord("avc1.640032"),
      driverAccessUnit(Buffer.from([1, 2, 3]), true),
    ]));
    cleanups.push(upstream.close);
    const server = createMacDesktopStreamServer({ logger });
    cleanups.push(() => server.dispose());
    const transport = await server.start({ laneId: "lane-1", sourcePort: upstream.port });

    const records = await readRecords(await fetch(transport.url), 2);
    // A second config record would make the renderer rebuild its decoder and
    // wait for another keyframe.
    expect(records.filter((record) => record.kind === "config")).toHaveLength(1);
    expect(records[1]?.kind).toBe("access-unit");
  });

  it("passes a config the helper already wrote as JSON through unchanged", async () => {
    const json = JSON.stringify({ codec: "avc1.42E01E", width: 800, height: 600, annexB: true });
    const upstream = await startUpstream(Buffer.concat([
      Buffer.from(encodeVideoRecord(IOS_VIDEO_RECORD_TYPE_CONFIG, Buffer.from(json, "utf8"))),
      driverAccessUnit(Buffer.from([9]), true),
    ]));
    cleanups.push(upstream.close);
    const server = createMacDesktopStreamServer({ logger });
    cleanups.push(() => server.dispose());
    const transport = await server.start({ laneId: "lane-1", sourcePort: upstream.port, width: 1, height: 2 });

    const records = await readRecords(await fetch(transport.url), 1);
    expect(records[0]).toEqual({
      kind: "config",
      codec: "avc1.42E01E",
      width: 800,
      height: 600,
      annexB: true,
    });
  });

  it("drops a reader when the helper's bytes are not framed at all", async () => {
    const upstream = await startUpstream(Buffer.from("not-a-record-at-all"));
    cleanups.push(upstream.close);
    const server = createMacDesktopStreamServer({ logger });
    cleanups.push(() => server.dispose());
    const transport = await server.start({ laneId: "lane-1", sourcePort: upstream.port });

    const response = await fetch(transport.url);
    await response.body?.getReader().read().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.clientCount("lane-1")).toBe(0);
    expect(server.metrics("lane-1")?.lastError).toContain("not framed");
  });

  it("keeps the token — and the reader — when a second viewer starts the same lane", async () => {
    const upstream = await startUpstream(Buffer.from([1]));
    cleanups.push(upstream.close);
    const server = createMacDesktopStreamServer({ logger });
    cleanups.push(() => server.dispose());
    const first = await server.start({ laneId: "lane-1", sourcePort: upstream.port });
    const response = await fetch(first.url);
    expect(response.status).toBe(200);

    // The second chat opening the same lane's tab must not evict the first:
    // a rotated token would leave the running reader holding a dead URL.
    const second = await server.start({ laneId: "lane-1", sourcePort: upstream.port });
    expect(second.token).toBe(first.token);
    expect(second.url).toBe(first.url);
    expect(server.clientCount("lane-1")).toBe(1);
    await response.body?.cancel();
  });

  it("reports the running transport without starting anything", async () => {
    const upstream = await startUpstream(Buffer.from([1]));
    cleanups.push(upstream.close);
    const server = createMacDesktopStreamServer({ logger });
    cleanups.push(() => server.dispose());
    expect(server.getTransport("lane-1")).toBeNull();
    const started = await server.start({ laneId: "lane-1", sourcePort: upstream.port });
    expect(server.getTransport("lane-1")).toEqual(started);
    server.stop("lane-1");
    expect(server.getTransport("lane-1")).toBeNull();
  });

  it("mints a new token for a run started after the last one stopped", async () => {
    const upstream = await startUpstream(Buffer.from([1]));
    cleanups.push(upstream.close);
    const server = createMacDesktopStreamServer({ logger });
    cleanups.push(() => server.dispose());
    const first = await server.start({ laneId: "lane-1", sourcePort: upstream.port });
    server.stop("lane-1");
    const second = await server.start({ laneId: "lane-1", sourcePort: upstream.port });
    expect(second.token).not.toBe(first.token);
    const stale = await fetch(`http://127.0.0.1:${second.port}${MAC_DESKTOP_STREAM_PATH}?lane=lane-1&token=${first.token}`);
    expect(stale.status).toBe(403);
    await stale.arrayBuffer();
  });

  it("drops to the idle rate after quiet, and back to full on activity", async () => {
    const upstream = await startUpstream(Buffer.from([1]));
    cleanups.push(upstream.close);
    const rates: number[] = [];
    const server = createMacDesktopStreamServer({
      logger,
      setRate: ({ fps }) => {
        rates.push(fps);
      },
    });
    cleanups.push(() => server.dispose());
    await server.start({ laneId: "lane-1", sourcePort: upstream.port, fps: 30, idleFps: 3 });
    expect(server.metrics("lane-1")?.fps).toBe(30);

    await new Promise((resolve) => setTimeout(resolve, 5_100));
    expect(rates).toContain(3);
    expect(server.metrics("lane-1")?.idle).toBe(true);

    server.noteActivity("lane-1");
    expect(rates).toContain(30);
    expect(server.metrics("lane-1")?.idle).toBe(false);
  }, 10_000);

  it("stops reporting a lane once it is stopped", async () => {
    const upstream = await startUpstream(Buffer.from([1]));
    cleanups.push(upstream.close);
    const server = createMacDesktopStreamServer({ logger });
    cleanups.push(() => server.dispose());
    const transport = await server.start({ laneId: "lane-1", sourcePort: upstream.port });
    expect(server.isStreaming("lane-1")).toBe(true);
    expect(server.stop("lane-1")).toBe(true);
    expect(server.isStreaming("lane-1")).toBe(false);
    const after = await fetch(transport.url);
    expect(after.status).toBe(403);
    await after.arrayBuffer();
  });
});
