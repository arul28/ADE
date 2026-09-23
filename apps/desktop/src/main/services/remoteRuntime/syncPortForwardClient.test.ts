import { EventEmitter } from "node:events";
import type net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { BACKPRESSURE_POLL_MS, type ParsedSyncEnvelope } from "../sync/syncProtocol";
import { SyncPortForwardClient } from "./syncPortForwardClient";
import type { AuthenticatedSyncConnection } from "./syncRuntimeTransport";

class FakeLocalSocket extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  paused = false;
  readonly writes: Buffer[] = [];

  write(data: Uint8Array): boolean {
    this.writes.push(Buffer.from(data));
    return true;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  send(data: Uint8Array): void {
    this.emit("data", Buffer.from(data));
  }
}

class FakeServer extends EventEmitter {
  private listening = false;

  constructor(private readonly acceptCallback: (socket: net.Socket) => void) {
    super();
  }

  listen(_port: number, _host: string, callback: () => void): this {
    this.listening = true;
    queueMicrotask(callback);
    return this;
  }

  address(): net.AddressInfo | null {
    return this.listening
      ? { address: "127.0.0.1", family: "IPv4", port: 43123 }
      : null;
  }

  close(callback?: () => void): this {
    if (!this.listening) return this;
    this.listening = false;
    queueMicrotask(() => {
      this.emit("close");
      callback?.();
    });
    return this;
  }

  accept(): FakeLocalSocket {
    const socket = new FakeLocalSocket();
    this.acceptCallback(socket as unknown as net.Socket);
    return socket;
  }
}

function createLoopbackConnection(): AuthenticatedSyncConnection {
  const envelopeCallbacks = new Set<(envelope: ParsedSyncEnvelope) => void>();
  const errorCallbacks = new Set<(error: Error) => void>();
  const closeCallbacks = new Set<() => void>();
  return {
    endpoint: "ws://loopback.test/",
    hello: { features: { rpcChannel: true, portForward: true } },
    credentials: {},
    send(
      type: Parameters<AuthenticatedSyncConnection["send"]>[0],
      payload: unknown,
    ) {
      if (type !== "fwd_data") return;
      const envelope = {
        version: 1,
        type: "fwd_data",
        projectId: null,
        requestId: null,
        compression: "none",
        payload,
        raw: {} as never,
      } as ParsedSyncEnvelope;
      queueMicrotask(() => {
        for (const callback of [...envelopeCallbacks]) callback(envelope);
      });
    },
    onEnvelope(callback: (envelope: ParsedSyncEnvelope) => void) {
      envelopeCallbacks.add(callback);
      return () => envelopeCallbacks.delete(callback);
    },
    onError(callback: (error: Error) => void) {
      errorCallbacks.add(callback);
      return () => errorCallbacks.delete(callback);
    },
    onClose(callback: () => void) {
      closeCallbacks.add(callback);
      return () => closeCallbacks.delete(callback);
    },
    bufferedAmount: () => 0,
    close() {
      for (const callback of [...closeCallbacks]) callback();
    },
  } as unknown as AuthenticatedSyncConnection;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SyncPortForwardClient", () => {
  it("binds an ephemeral loopback listener and echoes local bytes through fwd envelopes", async () => {
    let server: FakeServer | null = null;
    const createServer = ((callback: (socket: net.Socket) => void) => {
      server = new FakeServer(callback);
      return server as unknown as net.Server;
    }) as typeof net.createServer;
    const client = new SyncPortForwardClient(createLoopbackConnection(), { createServer });

    const forward = await client.ensureForward("localhost", 4173);
    expect(forward).toMatchObject({
      remoteHost: "localhost",
      remotePort: 4173,
      localHost: "127.0.0.1",
      localPort: 43123,
      localUrl: "http://127.0.0.1:43123",
    });
    const socket = server!.accept();
    const payload = Buffer.from("forwarded over the paired sync channel", "utf8");
    socket.send(payload);
    await flushMicrotasks();
    expect(Buffer.concat(socket.writes)).toEqual(payload);

    const reused = await client.ensureForward("localhost", 4173);
    expect(reused.localPort).toBe(forward.localPort);
    expect(reused.lastUsedAt).toBeGreaterThanOrEqual(forward.lastUsedAt);
    client.dispose();
    expect(socket.destroyed).toBe(true);
  });

  it("delivers a payload larger than 4MB when the local reader drains", async () => {
    let server: FakeServer | null = null;
    const createServer = ((callback: (socket: net.Socket) => void) => {
      server = new FakeServer(callback);
      return server as unknown as net.Server;
    }) as typeof net.createServer;
    const sent: string[] = [];
    const connection = createPushConnection(sent);
    const client = new SyncPortForwardClient(connection.connection, { createServer });
    await client.ensureForward("localhost", 5175);
    const socket = server!.accept();
    // Node stops accepting once the high-water mark is crossed; the old client
    // kept writing until 4MB and then killed the forward.
    const highWater = 64 * 1024;
    socket.write = (data: Uint8Array) => {
      socket.writes.push(Buffer.from(data));
      socket.writableLength += data.byteLength;
      const accepted = socket.writableLength <= highWater;
      if (!accepted) socket.paused = true;
      return accepted;
    };

    const payload = Buffer.alloc(5 * 1024 * 1024, 7);
    const chunkBytes = 64 * 1024;
    for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) {
      if (sent.includes("fwd_pause")) {
        socket.writableLength = 0;
        socket.paused = false;
        socket.emit("drain");
        await waitForSent(sent, "fwd_resume");
        sent.length = 0;
      }
      connection.deliver(
        payload.subarray(offset, Math.min(payload.byteLength, offset + chunkBytes)),
      );
      await flushMicrotasks();
    }
    if (sent.includes("fwd_pause") || socket.writableLength > 0) {
      socket.writableLength = 0;
      socket.paused = false;
      socket.emit("drain");
      await flushMicrotasks();
    }

    expect(socket.destroyed).toBe(false);
    expect(Buffer.concat(socket.writes)).toEqual(payload);
    client.dispose();
  });

  it("does not retain an unbounded buffer when the local reader never drains", async () => {
    let server: FakeServer | null = null;
    const createServer = ((callback: (socket: net.Socket) => void) => {
      server = new FakeServer(callback);
      return server as unknown as net.Server;
    }) as typeof net.createServer;
    const sent: string[] = [];
    const connection = createPushConnection(sent);
    const hardCap = 256 * 1024;
    const client = new SyncPortForwardClient(connection.connection, {
      createServer,
      inboundPauseBytes: 64 * 1024,
      inboundHardCapBytes: hardCap,
      inboundStallMs: 60_000,
    });
    await client.ensureForward("localhost", 5175);
    const socket = server!.accept();
    socket.write = (data: Uint8Array) => {
      socket.writes.push(Buffer.from(data));
      socket.writableLength += data.byteLength;
      return false;
    };

    const flood = Buffer.alloc(2 * 1024 * 1024, 3);
    const chunkBytes = 32 * 1024;
    for (let offset = 0; offset < flood.byteLength; offset += chunkBytes) {
      connection.deliver(flood.subarray(offset, Math.min(flood.byteLength, offset + chunkBytes)));
      await flushMicrotasks();
      if (socket.destroyed) break;
    }

    expect(sent).toContain("fwd_pause");
    expect(socket.destroyed).toBe(true);
    expect(Buffer.concat(socket.writes).byteLength).toBeLessThan(hardCap);
    const close = sent.includes("fwd_close");
    expect(close).toBe(true);
  });

  it("closes a forward that stays paused because the local socket never drains", async () => {
    let server: FakeServer | null = null;
    const createServer = ((callback: (socket: net.Socket) => void) => {
      server = new FakeServer(callback);
      return server as unknown as net.Server;
    }) as typeof net.createServer;
    const sent: string[] = [];
    const closeReasons: string[] = [];
    const connection = createPushConnection(sent, closeReasons);
    const client = new SyncPortForwardClient(connection.connection, {
      createServer,
      inboundPauseBytes: 1024,
      inboundHardCapBytes: 1024 * 1024,
      inboundStallMs: 30,
    });
    await client.ensureForward("localhost", 5175);
    const socket = server!.accept();
    socket.write = (data: Uint8Array) => {
      socket.writes.push(Buffer.from(data));
      socket.writableLength += data.byteLength;
      return false;
    };
    connection.deliver(Buffer.alloc(64, 1));
    await flushMicrotasks();
    expect(socket.destroyed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(socket.destroyed).toBe(true);
    expect(sent).toContain("fwd_close");
    // A stall is not an overflow. The peer must see why the forward closed.
    expect(closeReasons).toEqual(["Local forward socket did not drain in time."]);
    client.dispose();
  });

  it("keeps one drain listener while the poll flushes a paused queue", async () => {
    let server: FakeServer | null = null;
    const createServer = ((callback: (socket: net.Socket) => void) => {
      server = new FakeServer(callback);
      return server as unknown as net.Server;
    }) as typeof net.createServer;
    const sent: string[] = [];
    const connection = createPushConnection(sent);
    const client = new SyncPortForwardClient(connection.connection, {
      createServer,
      inboundPauseBytes: 1024,
      inboundHardCapBytes: 1024 * 1024,
      inboundStallMs: 60_000,
    });
    await client.ensureForward("localhost", 5175);
    const socket = server!.accept();
    // Every write reports a full socket, so each poll flush blocks again.
    socket.write = (data: Uint8Array) => {
      socket.writes.push(Buffer.from(data));
      socket.writableLength += data.byteLength;
      return false;
    };
    vi.useFakeTimers();
    try {
      for (let index = 0; index < 20; index += 1) connection.deliver(Buffer.alloc(512, index));
      expect(sent).toContain("fwd_pause");
      for (let poll = 0; poll < 15; poll += 1) {
        // The reader empties the socket, but `drain` does not fire before the poll.
        socket.writableLength = 0;
        vi.advanceTimersByTime(BACKPRESSURE_POLL_MS);
        expect(socket.listenerCount("drain")).toBe(1);
      }
      expect(socket.writes.length).toBeGreaterThan(10);
      expect(socket.destroyed).toBe(false);
    } finally {
      vi.useRealTimers();
      client.dispose();
    }
  });
});

function createPushConnection(sent: string[], closeReasons: string[] = []): {
  connection: AuthenticatedSyncConnection;
  deliver: (bytes: Buffer) => void;
} {
  const envelopeCallbacks = new Set<(envelope: ParsedSyncEnvelope) => void>();
  let forwardId = "";
  const connection = {
    endpoint: "ws://loopback.test/",
    hello: { features: { rpcChannel: true, portForward: true } },
    credentials: {},
    send(type: string, payload: unknown) {
      sent.push(type);
      if (type === "fwd_close") closeReasons.push(String((payload as { reason?: unknown }).reason));
      if (type !== "fwd_open") return;
      const id = (payload as { forwardId?: unknown }).forwardId;
      if (typeof id === "string") forwardId = id;
    },
    onEnvelope(callback: (envelope: ParsedSyncEnvelope) => void) {
      envelopeCallbacks.add(callback);
      return () => envelopeCallbacks.delete(callback);
    },
    onError() {
      return () => {};
    },
    onClose() {
      return () => {};
    },
    bufferedAmount: () => 0,
    close() {},
  } as unknown as AuthenticatedSyncConnection;
  return {
    connection,
    deliver(bytes: Buffer) {
      const envelope = {
        version: 1,
        type: "fwd_data",
        projectId: null,
        requestId: null,
        compression: "none",
        payload: { forwardId, data: bytes.toString("base64") },
        raw: {} as never,
      } as ParsedSyncEnvelope;
      for (const callback of [...envelopeCallbacks]) callback(envelope);
    },
  };
}

async function waitForSent(sent: string[], type: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!sent.includes(type)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${type}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
