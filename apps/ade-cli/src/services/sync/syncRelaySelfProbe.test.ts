import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  probeRelayEndToEnd,
  RELAY_SELF_PROBE_TIMEOUT_MS,
} from "./syncRelaySelfProbe";

class ProbeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly closes: Array<{ code: number; reason: string }> = [];
  terminated = false;

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  receive(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }

  close(code = 1000, reason = ""): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006, Buffer.alloc(0));
  }
}

describe("probeRelayEndToEnd", () => {
  it("waits for accepted then ready and closes without sending a frame", async () => {
    const socket = new ProbeWebSocket();
    const createWebSocket = vi.fn(() => socket as unknown as WebSocket);
    const probing = probeRelayEndToEnd({
      relayWsBase: "wss://relay.example/",
      machineKey: "machine-key",
      createWebSocket,
    });

    socket.open();
    socket.receive({ t: "accepted", v: 2 });
    socket.receive({ t: "ready", v: 2 });

    await expect(probing).resolves.toMatchObject({ ok: true });
    expect(createWebSocket).toHaveBeenCalledWith(
      "wss://relay.example/connect/machine-key?ready=2",
    );
    expect(socket.closes).toEqual([
      { code: 1000, reason: "self probe complete" },
    ]);
  });

  it("folds an early close code and reason into the failure", async () => {
    const socket = new ProbeWebSocket();
    const probing = probeRelayEndToEnd({
      relayWsBase: "wss://relay.example",
      machineKey: "machine-key",
      createWebSocket: () => socket as unknown as WebSocket,
    });

    socket.open();
    socket.receive({ t: "accepted", v: 2 });
    socket.close(4501, "host offline");

    await expect(probing).resolves.toEqual({
      ok: false,
      reason: "Relay self-probe closed before ready (4501): host offline.",
    });
  });

  it("times out and terminates the probe socket", async () => {
    vi.useFakeTimers();
    const socket = new ProbeWebSocket();
    const probing = probeRelayEndToEnd({
      relayWsBase: "wss://relay.example",
      machineKey: "machine-key",
      createWebSocket: () => socket as unknown as WebSocket,
    });

    await vi.advanceTimersByTimeAsync(RELAY_SELF_PROBE_TIMEOUT_MS);

    await expect(probing).resolves.toEqual({
      ok: false,
      reason: `Relay self-probe timed out after ${RELAY_SELF_PROBE_TIMEOUT_MS}ms.`,
    });
    expect(socket.terminated).toBe(true);
    vi.useRealTimers();
  });
});
