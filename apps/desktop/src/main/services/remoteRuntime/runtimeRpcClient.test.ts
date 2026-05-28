import { describe, expect, it, vi } from "vitest";
import { RuntimeRpcClient, type RuntimeRpcTransport } from "./runtimeRpcClient";

class MockTransport implements RuntimeRpcTransport {
  readonly writes: string[] = [];
  private readonly dataCallbacks = new Set<(chunk: Buffer) => void>();
  private readonly closeCallbacks = new Set<() => void>();
  private readonly errorCallbacks = new Set<(error: Error) => void>();
  writeError: Error | null = null;
  closed = false;

  onData(callback: (chunk: Buffer) => void): void {
    this.dataCallbacks.add(callback);
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.add(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.add(callback);
  }

  write(data: string): void {
    if (this.writeError) throw this.writeError;
    this.writes.push(data);
  }

  close(): void {
    this.closed = true;
    this.emitClose();
  }

  emitData(message: unknown): void {
    const chunk = typeof message === "string" ? message : `${JSON.stringify(message)}\n`;
    for (const callback of this.dataCallbacks) {
      callback(Buffer.from(chunk, "utf8"));
    }
  }

  emitClose(): void {
    for (const callback of this.closeCallbacks) {
      callback();
    }
  }

  emitError(error: Error): void {
    for (const callback of this.errorCallbacks) {
      callback(error);
    }
  }
}

function requestId(write: string): number {
  const parsed = JSON.parse(write.trim()) as { id?: unknown };
  if (typeof parsed.id !== "number") throw new Error("Expected numeric JSON-RPC id.");
  return parsed.id;
}

describe("RuntimeRpcClient", () => {
  it("resolves calls from JSON-RPC responses", async () => {
    const transport = new MockTransport();
    const client = new RuntimeRpcClient(transport);

    const pending = client.call("projects.list", {});
    transport.emitData({ jsonrpc: "2.0", id: requestId(transport.writes[0]!), result: ["project"] });

    await expect(pending).resolves.toEqual(["project"]);
  });

  it("rejects pending and future calls when the transport closes", async () => {
    const transport = new MockTransport();
    const client = new RuntimeRpcClient(transport);

    const pending = client.call("projects.list", {});
    transport.emitClose();

    await expect(pending).rejects.toThrow("Remote ADE service connection closed.");
    await expect(client.call("projects.list", {})).rejects.toThrow("Remote ADE service connection closed.");
  });

  it("rejects pending calls and notifies disconnect listeners when the transport errors", async () => {
    const transport = new MockTransport();
    const client = new RuntimeRpcClient(transport);
    const onDisconnect = vi.fn();
    client.onDisconnect(onDisconnect);

    const pending = client.call("projects.list", {});
    transport.emitError(new Error("ECONNRESET"));
    transport.emitClose();

    await expect(pending).rejects.toThrow("Remote ADE service connection failed: ECONNRESET");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect.mock.calls[0]?.[0]).toMatchObject({
      message: "Remote ADE service connection failed: ECONNRESET",
    });
  });

  it("includes the failed method, JSON-RPC code, and details in remote errors", async () => {
    const transport = new MockTransport();
    const client = new RuntimeRpcClient(transport);

    const pending = client.call("projects.create", { name: "ADE" });
    transport.emitData({
      jsonrpc: "2.0",
      id: requestId(transport.writes[0]!),
      error: {
        code: -32601,
        message: "Method not found",
        data: { method: "projects.create" },
      },
    });

    await expect(pending).rejects.toThrow(
      'Remote ADE service method projects.create failed (code -32601): Method not found Details: {"method":"projects.create"}',
    );
  });

  it("clears pending calls when writes fail", async () => {
    const transport = new MockTransport();
    transport.writeError = new Error("broken pipe");
    const client = new RuntimeRpcClient(transport);

    await expect(client.call("projects.list", {})).rejects.toThrow("broken pipe");
  });

  it("rejects only the timed-out call and keeps the connection open", async () => {
    vi.useFakeTimers();
    try {
      const transport = new MockTransport();
      const client = new RuntimeRpcClient(transport, 60_000);
      const onDisconnect = vi.fn();
      client.onDisconnect(onDisconnect);

      const pending = client.call("projects.list", {}, { timeoutMs: 25 });
      const assertion = expect(pending).rejects.toThrow(
        "Remote ADE service timed out waiting for method projects.list (25ms).",
      );
      await vi.advanceTimersByTimeAsync(25);

      await assertion;
      expect(onDisconnect).not.toHaveBeenCalled();

      // Subsequent calls go out fine — connection is still alive.
      const followup = client.call("projects.list", {});
      transport.emitData({ jsonrpc: "2.0", id: 2, result: { ok: true } });
      await expect(followup).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid per-call timeout overrides before writing requests", async () => {
    const transport = new MockTransport();
    const client = new RuntimeRpcClient(transport);

    await expect(client.call("projects.list", {}, { timeoutMs: 0 })).rejects.toThrow(
      "Runtime RPC timeout must be a finite positive number",
    );
    await expect(client.call("projects.list", {}, { timeoutMs: Number.NaN })).rejects.toThrow(
      "Runtime RPC timeout must be a finite positive number",
    );
    await expect(client.call("projects.list", {}, { timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "Runtime RPC timeout must be a finite positive number",
    );
    expect(transport.writes).toEqual([]);
  });

  it("dispatches JSON-RPC notifications without resolving pending calls", async () => {
    const transport = new MockTransport();
    const client = new RuntimeRpcClient(transport);
    const onRuntimeEvent = vi.fn();
    const unsubscribe = client.onNotification("runtime/event", onRuntimeEvent);

    const pending = client.call("projects.list", {});
    transport.emitData({ jsonrpc: "2.0", method: "runtime/event", params: { projectId: "project-1" } });
    expect(onRuntimeEvent).toHaveBeenCalledWith({ projectId: "project-1" });

    transport.emitData({ jsonrpc: "2.0", id: requestId(transport.writes[0]!), result: ["project"] });
    await expect(pending).resolves.toEqual(["project"]);

    unsubscribe();
    transport.emitData({ jsonrpc: "2.0", method: "runtime/event", params: { projectId: "project-2" } });
    expect(onRuntimeEvent).toHaveBeenCalledTimes(1);
  });
});
