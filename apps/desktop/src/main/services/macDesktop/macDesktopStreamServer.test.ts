import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { MAC_DESKTOP_STREAM_PATH } from "../../../shared/types/macDesktop";
import { createMacDesktopStreamServer } from "./macDesktopStreamServer";

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

  it("streams the helper's bytes through to a reader holding the token", async () => {
    const payload = Buffer.from("framed-access-unit");
    const upstream = await startUpstream(payload);
    cleanups.push(upstream.close);
    const server = createMacDesktopStreamServer({ logger });
    cleanups.push(() => server.dispose());
    const transport = await server.start({ laneId: "lane-1", sourcePort: upstream.port });

    const response = await fetch(transport.url);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    const first = await reader!.read();
    expect(Buffer.from(first.value!).toString()).toBe("framed-access-unit");
    expect(server.clientCount("lane-1")).toBe(1);
    await reader!.cancel();
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
