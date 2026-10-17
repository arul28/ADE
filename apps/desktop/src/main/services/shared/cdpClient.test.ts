import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpClient } from "./cdpClient";

/**
 * A browser that accepts the TCP connection but never answers the WebSocket
 * upgrade — what Chrome does while its "Allow remote debugging?" prompt is up.
 */
async function stalledBrowser(): Promise<{ url: string; connections: () => number; closed: Promise<void>; stop: () => void }> {
  let connections = 0;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.push(socket);
    socket.resume();
    socket.on("error", () => {});
    socket.on("close", () => markClosed());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/test`,
    connections: () => connections,
    closed,
    stop: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe("CdpClient.connect cancellation", () => {
  it("aborting while the browser holds the handshake rejects and closes the browser's socket", async () => {
    const browser = await stalledBrowser();
    stops.push(browser.stop);
    const abort = new AbortController();

    const connecting = CdpClient.connect(browser.url, { timeoutMs: 60_000, signal: abort.signal });
    await vi.waitFor(() => expect(browser.connections()).toBe(1));
    abort.abort();

    await expect(connecting).rejects.toThrow(/cancelled/i);
    // The browser sees the socket go away, which is what takes its prompt down.
    await expect(browser.closed).resolves.toBeUndefined();
  });

  it("an already-aborted signal rejects without opening a connection", async () => {
    const browser = await stalledBrowser();
    stops.push(browser.stop);
    const abort = new AbortController();
    abort.abort();

    await expect(CdpClient.connect(browser.url, { timeoutMs: 60_000, signal: abort.signal })).rejects.toThrow(/cancelled/i);
    expect(browser.connections()).toBe(0);
  });
});
