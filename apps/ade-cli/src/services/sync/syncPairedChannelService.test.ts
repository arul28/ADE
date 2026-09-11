import { EventEmitter } from "node:events";
import type net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairedRuntimeSyncEnvelope } from "../../../../desktop/src/shared/types/pairedRuntime";
import {
  createSyncPairedChannelService,
  type SyncRuntimeRpcHandler,
} from "./syncPairedChannelService";
import { RPC_CHANNEL_BACKPRESSURE_BYTES } from "./syncProtocol";
import { isRuntimeHostPairingRecord } from "./syncHostService";
import type { SyncPairingRecord } from "./syncPairingStore";

type Peer = { id: string };
type SentEnvelope = {
  type: PairedRuntimeSyncEnvelope["type"];
  payload: Record<string, unknown>;
};

function pairingRecord(peerDeviceType: string): SyncPairingRecord {
  return {
    secretHash: "hash",
    createdAt: "2026-07-10T00:00:00.000Z",
    lastUsedAt: null,
    peerName: "Paired peer",
    peerPlatform: "macOS",
    peerDeviceType,
    runtimeHostGranted: peerDeviceType === "desktop",
  };
}

afterEach(() => {
  vi.useRealTimers();
});

class FakeForwardSocket extends EventEmitter {
  writableLength = 0;
  paused = false;
  destroyed = false;
  readonly writes: Buffer[] = [];
  readonly timeoutValues: number[] = [];

  constructor(private readonly echoWrites = false) {
    super();
  }

  write(data: Uint8Array): boolean {
    if (this.destroyed) return false;
    const bytes = Buffer.from(data);
    this.writes.push(bytes);
    if (this.echoWrites) queueMicrotask(() => this.emit("data", bytes));
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

  setTimeout(timeoutMs: number): this {
    this.timeoutValues.push(timeoutMs);
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  connect(): void {
    this.emit("connect");
  }

  push(data: string | Buffer): void {
    this.emit("data", Buffer.from(data));
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createHarness(options: {
  createRpcHandler?: () => SyncRuntimeRpcHandler;
  bufferedAmount?: () => number;
  rpcBackpressureBytes?: number;
  forwardPendingBytes?: number;
  backpressurePollMs?: number;
  forwardConnectTimeoutMs?: number;
  connectForward?: () => FakeForwardSocket;
} = {}) {
  const sent: SentEnvelope[] = [];
  const service = createSyncPairedChannelService<Peer>({
    logger: { warn: vi.fn() },
    createRpcHandler: options.createRpcHandler,
    getBufferedAmount: options.bufferedAmount ?? (() => 0),
    rpcBackpressureBytes: options.rpcBackpressureBytes,
    forwardPendingBytes: options.forwardPendingBytes,
    backpressurePollMs: options.backpressurePollMs,
    forwardConnectTimeoutMs: options.forwardConnectTimeoutMs,
    connectForward: options.connectForward
      ? () => options.connectForward!() as unknown as net.Socket
      : undefined,
    send: (_peer, type, payload) => {
      sent.push({ type, payload: payload as unknown as Record<string, unknown> });
      return true;
    },
  });
  return { service, sent, peer: { id: "desktop" } };
}

function rpcText(sent: SentEnvelope[], channelId: string): string {
  return Buffer.concat(sent.flatMap((envelope) => {
    if (envelope.type !== "rpc_data" || envelope.payload.channelId !== channelId) return [];
    return [Buffer.from(String(envelope.payload.data), "base64")];
  })).toString("utf8");
}

describe("createSyncPairedChannelService", () => {
  it("bridges chunked newline JSON-RPC bytes through a fresh handler and closes it", async () => {
    const disposed = vi.fn();
    let initialized = false;
    const createRpcHandler = vi.fn(() => {
      initialized = false;
      const handler = (async (request) => {
        if (request.method === "ade/initialize") {
          initialized = true;
          return { runtimeInfo: { multiProject: true } };
        }
        if (request.method === "ping") {
          if (!initialized) throw new Error("not initialized");
          return { pong: true };
        }
        return null;
      }) as SyncRuntimeRpcHandler;
      handler.dispose = disposed;
      return handler;
    });
    const { service, sent, peer } = createHarness({ createRpcHandler });

    await service.handleEnvelope(peer, "rpc_open", { channelId: "rpc-1" }, true, true);
    const initialize = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: { protocolVersion: "2025-06-18" },
    })}\n`;
    const ping = `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`;
    const bytes = Buffer.from(initialize + ping, "utf8");
    await service.handleEnvelope(peer, "rpc_data", {
      channelId: "rpc-1",
      data: bytes.subarray(0, 17).toString("base64"),
    }, true, true);
    await service.handleEnvelope(peer, "rpc_data", {
      channelId: "rpc-1",
      data: bytes.subarray(17).toString("base64"),
    }, true, true);

    await waitFor(() => rpcText(sent, "rpc-1").split("\n").filter(Boolean).length === 2, "RPC responses");
    const responses = rpcText(sent, "rpc-1")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: number; result: unknown });
    expect(responses).toEqual([
      { jsonrpc: "2.0", id: 1, result: { runtimeInfo: { multiProject: true } } },
      { jsonrpc: "2.0", id: 2, result: { pong: true } },
    ]);
    expect(createRpcHandler).toHaveBeenCalledTimes(1);

    await service.handleEnvelope(peer, "rpc_close", { channelId: "rpc-1", reason: "done" }, true, true);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(sent.some((envelope) => envelope.type === "rpc_close")).toBe(false);
    service.dispose();
  });

  it("drops an RPC response instead of queueing it when the peer is backpressured", async () => {
    // `rpc_data` is a REQUIRED send: the host will not drop it, it buffers and
    // then closes the entire peer at the required-send ceiling — taking chat,
    // changesets and phone sync down with the RPC channel. So a runtime that
    // outruns the link must be refused at the door, exactly as `fwd_data`
    // already is, and only this channel pays for it.
    let bufferedAmount = 0;
    const createRpcHandler = vi.fn(() => (async () => ({ ok: true })) as SyncRuntimeRpcHandler);
    const { service, sent, peer } = createHarness({
      createRpcHandler,
      bufferedAmount: () => bufferedAmount,
    });

    await service.handleEnvelope(peer, "rpc_open", { channelId: "rpc-1" }, true, true);
    const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`;
    await service.handleEnvelope(peer, "rpc_data", {
      channelId: "rpc-1",
      data: Buffer.from(request, "utf8").toString("base64"),
    }, true, true);
    await waitFor(() => rpcText(sent, "rpc-1").length > 0, "the healthy RPC response");

    // Past the RPC ceiling — below the host's own peer-kill mark, which is
    // the point: the channel gives out before the connection does.
    bufferedAmount = RPC_CHANNEL_BACKPRESSURE_BYTES;
    const before = sent.filter((envelope) => envelope.type === "rpc_data").length;
    await service.handleEnvelope(peer, "rpc_data", {
      channelId: "rpc-1",
      data: Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`, "utf8")
        .toString("base64"),
    }, true, true);
    await waitFor(
      () => sent.some((envelope) => envelope.type === "rpc_close"),
      "the RPC channel close",
    );

    // Nothing extra was handed to the transport, and the channel — not the
    // peer connection — is what closed.
    expect(sent.filter((envelope) => envelope.type === "rpc_data").length).toBe(before);
    expect(sent.find((envelope) => envelope.type === "rpc_close")?.payload).toMatchObject({
      channelId: "rpc-1",
      reason: "Runtime RPC channel fell behind the sync connection.",
    });
    // A normal large response — over the droppable-traffic mark but well
    // inside what the link drains — must still go out. Gating at 4 MiB killed
    // the channel every few seconds on a healthy connection.
    expect(RPC_CHANNEL_BACKPRESSURE_BYTES).toBeGreaterThan(4 * 1024 * 1024);
    expect(RPC_CHANNEL_BACKPRESSURE_BYTES).toBeLessThan(16 * 1024 * 1024);
    service.dispose();
  });

  it("counts the payload it is about to write against the RPC ceiling", async () => {
    // Gating on the *pre-existing* buffer alone let one big response (a
    // screenshot data URL, a wide artifact list) walk a buffer that was under
    // the ceiling straight past the host's required-send kill mark — the exact
    // 4001 the gate exists to prevent.
    const ceiling = 4 * 1024 * 1024;
    const big = "x".repeat(3 * 1024 * 1024);
    const { service, sent, peer } = createHarness({
      createRpcHandler: () => (async () => ({ big })) as SyncRuntimeRpcHandler,
      // Comfortably under the ceiling on its own; over it once the response lands.
      bufferedAmount: () => 2 * 1024 * 1024,
      rpcBackpressureBytes: ceiling,
    });

    await service.handleEnvelope(peer, "rpc_open", { channelId: "rpc-big" }, true, true);
    await service.handleEnvelope(peer, "rpc_data", {
      channelId: "rpc-big",
      data: Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "read" })}\n`, "utf8")
        .toString("base64"),
    }, true, true);

    await waitFor(
      () => sent.some((envelope) => envelope.type === "rpc_close"),
      "the RPC channel close",
    );
    expect(sent.some((envelope) => envelope.type === "rpc_data")).toBe(false);
    expect(sent.find((envelope) => envelope.type === "rpc_close")?.payload).toMatchObject({
      channelId: "rpc-big",
      reason: "Runtime RPC channel fell behind the sync connection.",
    });
    service.dispose();
  });

  it("re-reads the RPC ceiling between chunks so a mid-payload stall stops the write", async () => {
    // Mirrors `handleForwardSocketData`, which re-reads the buffered amount
    // inside its own chunk loop: a link that stalls part-way through a payload
    // must be caught before the remaining chunks are handed over.
    const ceiling = 4 * 1024 * 1024;
    const big = "x".repeat(2 * 1024 * 1024);
    const sentRef: { current: SentEnvelope[] } = { current: [] };
    const harness = createHarness({
      createRpcHandler: () => (async () => ({ big })) as SyncRuntimeRpcHandler,
      // The link stops draining: every chunk handed over stays buffered.
      bufferedAmount: () => sentRef.current
        .filter((envelope) => envelope.type === "rpc_data")
        .length * 1024 * 1024,
      rpcBackpressureBytes: ceiling,
    });
    sentRef.current = harness.sent;
    const { service, sent, peer } = harness;

    await service.handleEnvelope(peer, "rpc_open", { channelId: "rpc-stall" }, true, true);
    await service.handleEnvelope(peer, "rpc_data", {
      channelId: "rpc-stall",
      data: Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "read" })}\n`, "utf8")
        .toString("base64"),
    }, true, true);

    await waitFor(
      () => sent.some((envelope) => envelope.type === "rpc_close"),
      "the RPC channel close",
    );
    const chunks = sent.filter((envelope) => envelope.type === "rpc_data").length;
    // Some chunks made it out before the stall was noticed, and the rest of the
    // payload was refused rather than pushed onto a buffer that had stopped moving.
    expect(chunks).toBeGreaterThan(0);
    expect(chunks).toBeLessThan(Math.ceil(big.length / (256 * 1024)));
    service.dispose();
  });

  it("keeps the peer's port forwards alive when one RPC channel outruns the link", async () => {
    // The backpressure kill is a per-channel budget failure. Forwards belong to
    // the peer, not to the channel, so tearing them all down drops unrelated
    // lanes' live previews because one agent pulled a large response.
    const socket = new FakeForwardSocket();
    const ceiling = 1024 * 1024;
    const big = "x".repeat(2 * 1024 * 1024);
    const { service, sent, peer } = createHarness({
      createRpcHandler: () => (async () => ({ big })) as SyncRuntimeRpcHandler,
      bufferedAmount: () => 0,
      rpcBackpressureBytes: ceiling,
      connectForward: () => socket,
    });

    await service.handleEnvelope(peer, "rpc_open", { channelId: "rpc-hungry" }, true, true);
    await service.handleEnvelope(peer, "fwd_open", {
      forwardId: "fwd-preview",
      host: "127.0.0.1",
      port: 4173,
    }, true, true);
    socket.connect();
    await service.handleEnvelope(peer, "rpc_data", {
      channelId: "rpc-hungry",
      data: Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "read" })}\n`, "utf8")
        .toString("base64"),
    }, true, true);

    await waitFor(
      () => sent.some((envelope) => envelope.type === "rpc_close"),
      "the RPC channel close",
    );
    expect(socket.destroyed).toBe(false);
    expect(sent.some((envelope) => envelope.type === "fwd_close")).toBe(false);
    service.dispose();
  });

  it("rejects runtime and forward opens that did not use paired authentication", async () => {
    const createRpcHandler = vi.fn();
    const { service, sent, peer } = createHarness({ createRpcHandler });

    await service.handleEnvelope(peer, "rpc_open", { channelId: "rpc-denied" }, false);
    await service.handleEnvelope(peer, "fwd_open", {
      forwardId: "fwd-denied",
      host: "127.0.0.1",
      port: 80,
    }, false);

    expect(createRpcHandler).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: "rpc_close",
        payload: {
          channelId: "rpc-denied",
          reason: "Paired device authentication is required.",
        },
      },
      {
        type: "fwd_close",
        payload: {
          forwardId: "fwd-denied",
          reason: "Paired device authentication is required.",
        },
      },
    ]);
    service.dispose();
  });

  it("tears down the peer's forwards when its RPC channel closes", async () => {
    const socket = new FakeForwardSocket();
    const { service, sent, peer } = createHarness({
      createRpcHandler: () => async () => null,
      connectForward: () => socket,
    });
    await service.handleEnvelope(peer, "rpc_open", { channelId: "rpc-owner" }, true, true);
    await service.handleEnvelope(peer, "fwd_open", {
      forwardId: "fwd-owned",
      host: "127.0.0.1",
      port: 4173,
    }, true, true);
    socket.connect();

    await service.handleEnvelope(peer, "rpc_close", {
      channelId: "rpc-owner",
      reason: "runtime closed",
    }, true, true);

    expect(socket.destroyed).toBe(true);
    expect(sent).toContainEqual({
      type: "fwd_close",
      payload: {
        forwardId: "fwd-owned",
        reason: "RPC channel closed by peer.",
      },
    });
    service.dispose();
  });

  it("rejects authenticated forwards outside the host loopback interface", async () => {
    const connectForward = vi.fn(() => new FakeForwardSocket());
    const { service, sent, peer } = createHarness({ connectForward });

    await service.handleEnvelope(peer, "fwd_open", {
      forwardId: "fwd-public",
      host: "192.0.2.10",
      port: 443,
    }, true, true);

    expect(connectForward).not.toHaveBeenCalled();
    expect(sent).toContainEqual({
      type: "fwd_close",
      payload: {
        forwardId: "fwd-public",
        reason: "Port forwards may connect only to 127.0.0.1 or localhost.",
      },
    });
    service.dispose();
  });

  it("echoes forwarded TCP bytes and propagates remote close", async () => {
    const socket = new FakeForwardSocket(true);
    const { service, sent, peer } = createHarness({ connectForward: () => socket });

    await service.handleEnvelope(peer, "fwd_open", {
      forwardId: "fwd-echo",
      host: "localhost",
      port: 4173,
    }, true, true);
    socket.connect();
    expect(socket.timeoutValues).toEqual([10_000, 0]);
    await service.handleEnvelope(peer, "fwd_data", {
      forwardId: "fwd-echo",
      data: Buffer.from("hello over sync", "utf8").toString("base64"),
    }, true, true);

    await waitFor(
      () => sent.some((envelope) => envelope.type === "fwd_data"),
      "forward echo",
    );
    const echoed = Buffer.concat(sent.flatMap((envelope) =>
      envelope.type === "fwd_data"
        ? [Buffer.from(String(envelope.payload.data), "base64")]
        : []
    )).toString("utf8");
    expect(echoed).toBe("hello over sync");

    socket.destroy();
    await waitFor(
      () => sent.some((envelope) => envelope.type === "fwd_close"),
      "forward close",
    );
    expect(sent.find((envelope) => envelope.type === "fwd_close")?.payload).toMatchObject({
      forwardId: "fwd-echo",
    });
    service.dispose();
  });

  it("closes a loopback forward when its TCP connection times out", async () => {
    const socket = new FakeForwardSocket();
    const { service, sent, peer } = createHarness({
      connectForward: () => socket,
      forwardConnectTimeoutMs: 25,
    });

    await service.handleEnvelope(peer, "fwd_open", {
      forwardId: "fwd-timeout",
      host: "127.0.0.1",
      port: 4173,
    }, true, true);
    socket.emit("timeout");

    expect(socket.timeoutValues).toEqual([25]);
    expect(socket.destroyed).toBe(true);
    expect(sent).toContainEqual({
      type: "fwd_close",
      payload: {
        forwardId: "fwd-timeout",
        reason: "Remote TCP connection timed out.",
      },
    });
    service.dispose();
  });

  it("pauses forwarded output while the peer is backpressured and resumes below 4 MiB", async () => {
    const socket = new FakeForwardSocket();
    let bufferedAmount = 4 * 1024 * 1024;
    const { service, sent, peer } = createHarness({
      bufferedAmount: () => bufferedAmount,
      backpressurePollMs: 5,
      connectForward: () => socket,
    });

    await service.handleEnvelope(peer, "fwd_open", {
      forwardId: "fwd-pressure",
      host: "127.0.0.1",
      port: 4173,
    }, true, true);
    socket.connect();
    socket.push("queued");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent.some((envelope) => envelope.type === "fwd_data")).toBe(false);

    bufferedAmount = 0;
    await waitFor(
      () => sent.some((envelope) => envelope.type === "fwd_data"),
      "backpressure recovery",
    );
    expect(Buffer.from(
      String(sent.find((envelope) => envelope.type === "fwd_data")?.payload.data),
      "base64",
    ).toString("utf8")).toBe("queued");
    service.dispose();
  });

  it("rejects runtime and forward opens when phone/browser pairing records claim desktop in hello metadata", async () => {
    const spoofedHelloMetadata = { deviceType: "desktop" };
    expect(spoofedHelloMetadata.deviceType).toBe("desktop");
    for (const peerDeviceType of ["phone", "browser"]) {
      const createRpcHandler = vi.fn();
      const connectForward = vi.fn(() => new FakeForwardSocket());
      const { service, sent, peer } = createHarness({ createRpcHandler, connectForward });
      const authorizedForRuntimeHost = isRuntimeHostPairingRecord(pairingRecord(peerDeviceType));
      await service.handleEnvelope(peer, "rpc_open", { channelId: `rpc-${peerDeviceType}` }, true, authorizedForRuntimeHost);
      await service.handleEnvelope(peer, "fwd_open", {
        forwardId: `fwd-${peerDeviceType}`,
        host: "127.0.0.1",
        port: 4173,
      }, true, authorizedForRuntimeHost);

      expect(createRpcHandler).not.toHaveBeenCalled();
      expect(connectForward).not.toHaveBeenCalled();
      expect(sent).toEqual([
        {
          type: "rpc_close",
          payload: {
            channelId: `rpc-${peerDeviceType}`,
            reason: "Runtime channel is only available to desktop clients.",
          },
        },
        {
          type: "fwd_close",
          payload: {
            forwardId: `fwd-${peerDeviceType}`,
            reason: "Runtime channel is only available to desktop clients.",
          },
        },
      ]);
      service.dispose();
    }
  });

  it("allows runtime and forward opens for a genuine desktop pairing record", async () => {
    const createRpcHandler = vi.fn(() => (async () => null) as SyncRuntimeRpcHandler);
    const connectForward = vi.fn(() => new FakeForwardSocket());
    const { service, peer } = createHarness({ createRpcHandler, connectForward });
    const authorizedForRuntimeHost = isRuntimeHostPairingRecord(pairingRecord("desktop"));

    await service.handleEnvelope(peer, "rpc_open", { channelId: "rpc-desktop" }, true, authorizedForRuntimeHost);
    await service.handleEnvelope(peer, "fwd_open", {
      forwardId: "fwd-desktop",
      host: "127.0.0.1",
      port: 4173,
    }, true, authorizedForRuntimeHost);

    expect(createRpcHandler).toHaveBeenCalledTimes(1);
    expect(connectForward).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("caps concurrent RPC channels per peer", async () => {
    const createRpcHandler = vi.fn(() => (async () => null) as SyncRuntimeRpcHandler);
    const { service, sent, peer } = createHarness({ createRpcHandler });

    // MAX_RPC_CHANNELS_PER_PEER = 32
    for (let i = 0; i < 32; i += 1) {
      await service.handleEnvelope(peer, "rpc_open", { channelId: `rpc-${i}` }, true, true);
    }
    expect(createRpcHandler).toHaveBeenCalledTimes(32);

    await service.handleEnvelope(peer, "rpc_open", { channelId: "rpc-over" }, true, true);
    expect(createRpcHandler).toHaveBeenCalledTimes(32);
    expect(sent).toContainEqual({
      type: "rpc_close",
      payload: { channelId: "rpc-over", reason: "Too many open runtime channels." },
    });

    // Re-opening an already-open channel id replaces it, not exceeding the cap.
    await service.handleEnvelope(peer, "rpc_open", { channelId: "rpc-0" }, true, true);
    expect(createRpcHandler).toHaveBeenCalledTimes(33);
    service.dispose();
  });

  it("caps concurrent forwards per peer", async () => {
    const connectForward = vi.fn(() => new FakeForwardSocket());
    const { service, sent, peer } = createHarness({ connectForward });

    // MAX_FORWARDS_PER_PEER = 64
    for (let i = 0; i < 64; i += 1) {
      await service.handleEnvelope(peer, "fwd_open", {
        forwardId: `fwd-${i}`,
        host: "127.0.0.1",
        port: 4173,
      }, true, true);
    }
    expect(connectForward).toHaveBeenCalledTimes(64);

    await service.handleEnvelope(peer, "fwd_open", {
      forwardId: "fwd-over",
      host: "127.0.0.1",
      port: 4173,
    }, true, true);
    expect(connectForward).toHaveBeenCalledTimes(64);
    expect(sent).toContainEqual({
      type: "fwd_close",
      payload: { forwardId: "fwd-over", reason: "Too many open port forwards." },
    });
    service.dispose();
  });
});
