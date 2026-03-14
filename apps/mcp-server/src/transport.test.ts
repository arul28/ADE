import { afterEach, describe, expect, it, vi } from "vitest";
import { createStdioTransport, createSocketTransport, type JsonRpcTransport } from "./transport";
import { startJsonRpcServer } from "./jsonrpc";

// ---------------------------------------------------------------------------
// Test helper: mock transport for JSON-RPC server integration tests
// ---------------------------------------------------------------------------
function createTestTransport() {
  let dataCallback: ((chunk: Buffer) => void) | null = null;
  const written: string[] = [];
  return {
    transport: {
      onData(cb: (chunk: Buffer) => void) { dataCallback = cb; },
      write(data: string) { written.push(data); },
      close() {}
    } satisfies JsonRpcTransport,
    send(data: string) {
      dataCallback?.(Buffer.from(data + "\n", "utf8"));
    },
    written
  };
}

// ---------------------------------------------------------------------------
// createStdioTransport
// ---------------------------------------------------------------------------
describe("createStdioTransport", () => {
  it("returns a transport object with onData, write, and close", () => {
    const transport = createStdioTransport();
    expect(typeof transport.onData).toBe("function");
    expect(typeof transport.write).toBe("function");
    expect(typeof transport.close).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// createSocketTransport
// ---------------------------------------------------------------------------
describe("createSocketTransport", () => {
  it("rejects when the socket path does not exist", async () => {
    await expect(createSocketTransport("/tmp/ade-nonexistent-test-socket-" + Date.now() + ".sock"))
      .rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// startJsonRpcServer with mock transport
// ---------------------------------------------------------------------------
describe("startJsonRpcServer with mock transport", () => {
  it("dispatches a valid JSON-RPC request and writes the response", async () => {
    const { transport, send, written } = createTestTransport();
    const handler = vi.fn().mockResolvedValue({ ok: true });

    const stop = startJsonRpcServer(handler, transport);

    send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/echo", params: { a: 1 } }));

    // Give the async drain a tick to process
    await new Promise((r) => setTimeout(r, 20));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ method: "test/echo", params: { a: 1 } })
    );

    expect(written.length).toBe(1);
    const parsed = JSON.parse(written[0]!);
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });

    stop();
  });

  it("handles notifications (no id) without writing a response", async () => {
    const { transport, send, written } = createTestTransport();
    const handler = vi.fn().mockResolvedValue(null);

    const stop = startJsonRpcServer(handler, transport);

    send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/test" }));

    await new Promise((r) => setTimeout(r, 20));

    expect(handler).toHaveBeenCalledOnce();
    expect(written.length).toBe(0);

    stop();
  });

  it("returns a parse error for invalid JSON", async () => {
    const { transport, send, written } = createTestTransport();
    const handler = vi.fn();

    const stop = startJsonRpcServer(handler, transport);

    send("{not valid json");

    await new Promise((r) => setTimeout(r, 20));

    expect(handler).not.toHaveBeenCalled();
    expect(written.length).toBe(1);
    const parsed = JSON.parse(written[0]!);
    expect(parsed.error.code).toBe(-32700);

    stop();
  });

  it("handles batch requests", async () => {
    const { transport, send, written } = createTestTransport();
    let callCount = 0;
    const handler = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve({ n: callCount });
    });

    const stop = startJsonRpcServer(handler, transport);

    send(JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "a" },
      { jsonrpc: "2.0", id: 2, method: "b" }
    ]));

    await new Promise((r) => setTimeout(r, 20));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(written.length).toBe(1);
    const parsed = JSON.parse(written[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);

    stop();
  });

  it("stop function prevents further processing", async () => {
    const { transport, send, written } = createTestTransport();
    const handler = vi.fn().mockResolvedValue({ ok: true });

    const stop = startJsonRpcServer(handler, transport);
    stop();

    send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }));

    await new Promise((r) => setTimeout(r, 20));

    expect(handler).not.toHaveBeenCalled();
    expect(written.length).toBe(0);
  });
});
