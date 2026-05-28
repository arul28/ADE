import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  startJsonRpcServer,
  type JsonRpcHandler,
  type JsonRpcTransport,
} from "./jsonrpc";

class MemoryTransport implements JsonRpcTransport {
  readonly writes: string[] = [];
  readonly callbacks: Array<(chunk: Buffer) => void> = [];
  closed = false;
  throwOnWrite = false;

  onData(callback: (chunk: Buffer) => void): void {
    this.callbacks.push(callback);
  }

  write(data: string): void {
    if (this.throwOnWrite) {
      throw new Error("write failed");
    }
    this.writes.push(data);
  }

  close(): void {
    this.closed = true;
  }

  push(payload: unknown): void {
    const line = typeof payload === "string" ? payload : JSON.stringify(payload);
    for (const callback of this.callbacks) {
      callback(Buffer.from(`${line}\n`, "utf8"));
    }
  }
}

async function waitForDrain(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function jsonlResponses(transport: MemoryTransport): unknown[] {
  return transport.writes
    .flatMap((write) => write.trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe("startJsonRpcServer", () => {
  it("contains notification handler failures without closing the connection", async () => {
    const transport = new MemoryTransport();
    const onError = vi.fn();
    const handler: JsonRpcHandler = vi.fn(async (request) => {
      if (request.method === "explode") {
        throw new Error("notification failed");
      }
      return { ok: true, method: request.method };
    });

    const stop = startJsonRpcServer(handler, transport, {
      nonFatal: true,
      onError,
    });

    transport.push({ jsonrpc: "2.0", method: "explode" });
    await waitForDrain();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe("notification");
    expect(transport.closed).toBe(false);
    expect(transport.writes).toEqual([]);

    transport.push({ jsonrpc: "2.0", id: 1, method: "ping" });
    await waitForDrain();

    expect(jsonlResponses(transport)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true, method: "ping" },
      },
    ]);
    expect(transport.closed).toBe(false);

    stop();
  });

  it("keeps batch request responses when a batch notification fails", async () => {
    const transport = new MemoryTransport();
    const onError = vi.fn();
    const handler: JsonRpcHandler = vi.fn(async (request) => {
      if (request.method === "bad-notification") {
        throw new Error("bad notification");
      }
      return { ok: true };
    });

    const stop = startJsonRpcServer(handler, transport, {
      nonFatal: true,
      onError,
    });

    transport.push([
      { jsonrpc: "2.0", method: "bad-notification" },
      { jsonrpc: "2.0", id: 2, method: "ok-request" },
    ]);
    await waitForDrain();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe("notification");
    expect(jsonlResponses(transport)).toEqual([
      [
        {
          jsonrpc: "2.0",
          id: 2,
          result: { ok: true },
        },
      ],
    ]);
    expect(transport.closed).toBe(false);

    stop();
  });

  it("contains notify write failures and closes only the affected transport", () => {
    const transport = new MemoryTransport();
    const onError = vi.fn();
    const stop = startJsonRpcServer(async () => ({}), transport, {
      nonFatal: true,
      onError,
    });

    transport.throwOnWrite = true;

    expect(() => stop.notify("runtime/event", { ok: true })).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe("write");
    expect(transport.closed).toBe(true);
  });
});
