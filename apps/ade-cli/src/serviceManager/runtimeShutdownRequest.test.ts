import net from "node:net";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { requestAdeRuntimeShutdown } from "./runtimeShutdownRequest";

/**
 * A stand-in for the brain's JSON-RPC endpoint. `replies` maps a method to the
 * result it answers with; anything absent is simply not answered, which is how
 * a wedged brain behaves. `closeOnShutdown` models the brain whose orderly exit
 * drops the socket before its own response gets out.
 */
function fakeEndpoint(
  replies: Record<string, unknown>,
  options: { closeOnShutdown?: boolean } = {},
): {
  socket: net.Socket;
  written: string[];
} {
  const written: string[] = [];
  const socket = new EventEmitter() as unknown as net.Socket & { destroy: () => void };
  let buffer = "";
  (socket as unknown as { write: unknown }).write = (payload: string) => {
    written.push(payload);
    buffer += payload;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line) as { id: number; method: string };
      if (options.closeOnShutdown && message.method === "shutdown") {
        queueMicrotask(() => socket.emit("close"));
        continue;
      }
      if (!(message.method in replies)) continue;
      queueMicrotask(() => {
        socket.emit(
          "data",
          Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: replies[message.method] })}\n`),
        );
      });
    }
    return true;
  };
  (socket as unknown as { destroy: () => void }).destroy = () => {};
  queueMicrotask(() => socket.emit("connect"));
  return { socket, written };
}

describe("requestAdeRuntimeShutdown", () => {
  const socketPath = String.raw`\\.\pipe\ade-runtime-stable-0123456789abcdef`;

  it("identifies the endpoint before asking it to leave", async () => {
    const endpoint = fakeEndpoint({ "runtime/info": { pid: 4242 }, shutdown: {} });
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath,
      connect: () => endpoint.socket,
    });
    expect(result).toEqual({ requested: true });
    const methods = endpoint.written.map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods).toEqual(["runtime/info", "shutdown"]);
  });

  it("refuses to shut down a pid the endpoint does not belong to", async () => {
    // A pid scraped from a port diagnosis or a supervisor record can have been
    // recycled; shutting down whoever happens to answer would be a stranger.
    const endpoint = fakeEndpoint({ "runtime/info": { pid: 999 }, shutdown: {} });
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath,
      connect: () => endpoint.socket,
    });
    expect(result.requested).toBe(false);
    const methods = endpoint.written.map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods).toEqual(["runtime/info"]);
  });

  /**
   * The orderly exit this path asks for tears down the brain's listening
   * socket, which races the JSON-RPC response back to us. Reading the close as
   * a refusal would send the caller to `taskkill /F` and cut the flush short.
   */
  it("treats a close after the request as the shutdown taking effect", async () => {
    const endpoint = fakeEndpoint({ "runtime/info": { pid: 4242 } }, { closeOnShutdown: true });
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath,
      connect: () => endpoint.socket,
    });
    expect(result).toEqual({ requested: true });
  });

  it("reports a close before the request as the endpoint hanging up", async () => {
    const endpoint = fakeEndpoint({});
    queueMicrotask(() => endpoint.socket.emit("close"));
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath,
      connect: () => endpoint.socket,
    });
    expect(result).toEqual({
      requested: false,
      reason: "the runtime endpoint closed before it could be asked to stop",
    });
  });

  it("gives up on a wedged endpoint instead of hanging the caller", async () => {
    const endpoint = fakeEndpoint({});
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath,
      timeoutMs: 250,
      connect: () => endpoint.socket,
    });
    expect(result).toEqual({
      requested: false,
      reason: "the runtime endpoint did not answer within 250ms",
    });
  });

  it("never dials a tcp runtime endpoint", async () => {
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath: "tcp://127.0.0.1:9999?token=secret",
      connect: () => {
        throw new Error("must not connect");
      },
    });
    expect(result.requested).toBe(false);
  });
});
