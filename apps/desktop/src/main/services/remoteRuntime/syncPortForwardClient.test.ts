import { EventEmitter } from "node:events";
import type net from "node:net";
import { describe, expect, it } from "vitest";
import type { ParsedSyncEnvelope } from "../sync/syncProtocol";
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
});
