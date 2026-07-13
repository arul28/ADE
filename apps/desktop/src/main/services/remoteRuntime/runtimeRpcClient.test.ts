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

    const first = client.call("projects.list", {});
    const second = client.call("runtime/info", {});
    const firstAssertion = expect(first).rejects.toThrow("Remote ADE service connection closed.");
    const secondAssertion = expect(second).rejects.toThrow("Remote ADE service connection closed.");
    transport.emitClose();

    await firstAssertion;
    await secondAssertion;
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

  it("expires only one request while pending calls, event subscriptions, and later calls stay live", async () => {
    vi.useFakeTimers();
    try {
      const transport = new MockTransport();
      const client = new RuntimeRpcClient(transport, 60_000);
      const onDisconnect = vi.fn();
      const onRuntimeEvent = vi.fn();
      client.onDisconnect(onDisconnect);
      client.onNotification("runtime/event", onRuntimeEvent);

      const subscribe = client.call("runtimeEvents.subscribe", { projectId: "project-1" });
      transport.emitData({
        jsonrpc: "2.0",
        id: requestId(transport.writes[0]!),
        result: { subscriptionId: "runtime-events-1" },
      });
      await expect(subscribe).resolves.toEqual({ subscriptionId: "runtime-events-1" });

      const timedOutMutation = client.call(
        "ade/actions/call",
        { name: "run_ade_action" },
        { timeoutMs: 25 },
      );
      const unrelated = client.call("projects.list", {});
      let unrelatedSettled = false;
      void unrelated.then(
        () => { unrelatedSettled = true; },
        () => { unrelatedSettled = true; },
      );
      const timedOutId = requestId(transport.writes[1]!);
      const unrelatedId = requestId(transport.writes[2]!);
      const timeoutAssertion = expect(timedOutMutation).rejects.toThrow(
        "Remote ADE service timed out waiting for method ade/actions/call (25ms).",
      );
      await vi.advanceTimersByTimeAsync(25);

      await timeoutAssertion;
      expect(client.isClosed()).toBe(false);
      expect(onDisconnect).not.toHaveBeenCalled();
      expect(transport.closed).toBe(false);

      transport.emitData({
        jsonrpc: "2.0",
        method: "runtime/event",
        params: { subscriptionId: "runtime-events-1", event: { id: 1 } },
      });
      expect(onRuntimeEvent).toHaveBeenCalledWith({
        subscriptionId: "runtime-events-1",
        event: { id: 1 },
      });

      // A late completion for the expired mutation is ignored and cannot
      // resolve another caller.
      transport.emitData({ jsonrpc: "2.0", id: timedOutId, result: { ok: true } });
      await Promise.resolve();
      expect(unrelatedSettled).toBe(false);

      transport.emitData({ jsonrpc: "2.0", id: unrelatedId, result: ["project"] });
      await expect(unrelated).resolves.toEqual(["project"]);

      const subsequent = client.call("runtime/info", {});
      transport.emitData({
        jsonrpc: "2.0",
        id: requestId(transport.writes[3]!),
        result: { version: "1.0.0" },
      });
      await expect(subsequent).resolves.toEqual({ version: "1.0.0" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats malformed JSON framing as connection-fatal and rejects every pending call", async () => {
    const transport = new MockTransport();
    const client = new RuntimeRpcClient(transport);
    const onDisconnect = vi.fn();
    client.onDisconnect(onDisconnect);

    const first = client.call("projects.list", {});
    const second = client.call("runtime/info", {});
    const firstAssertion = expect(first).rejects.toThrow("Failed to parse remote ADE service response");
    const secondAssertion = expect(second).rejects.toThrow("Failed to parse remote ADE service response");

    transport.emitData('{"jsonrpc":"2.0",invalid}\n');

    await firstAssertion;
    await secondAssertion;
    expect(client.isClosed()).toBe(true);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    await expect(client.call("ping", {})).rejects.toThrow("Failed to parse remote ADE service response");
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

  it("rejects only the request answered by an oversized response and keeps the connection alive", async () => {
    const transport = new MockTransport();
    const client = new RuntimeRpcClient(transport);

    const oversized = client.call("chat.getChatEventHistory", {});
    const unrelated = client.call("projects.list", {});
    const oversizedId = requestId(transport.writes[0]!);
    const unrelatedId = requestId(transport.writes[1]!);

    // Stream a single >16 MiB response line in chunks, as a socket would.
    const head = `{"jsonrpc":"2.0","id":${oversizedId},"result":{"events":["`;
    transport.emitData(head);
    const filler = "x".repeat(1024 * 1024);
    for (let i = 0; i < 17; i++) transport.emitData(filler);
    transport.emitData(`"]}}\n`);

    await expect(oversized).rejects.toThrow(
      /response for method chat\.getChatEventHistory exceeded 16 MiB .* and was discarded/,
    );
    expect(client.isClosed()).toBe(false);

    // The unrelated in-flight call and brand-new calls still complete.
    transport.emitData({ jsonrpc: "2.0", id: unrelatedId, result: ["project"] });
    await expect(unrelated).resolves.toEqual(["project"]);
    const after = client.call("projects.list", {});
    transport.emitData({ jsonrpc: "2.0", id: requestId(transport.writes[2]!), result: ["still-alive"] });
    await expect(after).resolves.toEqual(["still-alive"]);
  });

  it("parses lines that arrive in the same chunk after an oversized line ends", async () => {
    const transport = new MockTransport();
    const client = new RuntimeRpcClient(transport);

    const oversized = client.call("chat.getChatEventHistory", {});
    const follower = client.call("projects.list", {});
    const oversizedId = requestId(transport.writes[0]!);
    const followerId = requestId(transport.writes[1]!);

    transport.emitData(`{"jsonrpc":"2.0","id":${oversizedId},"result":"`);
    transport.emitData("y".repeat(17 * 1024 * 1024));
    // The oversized line terminator and the follower response share a chunk.
    transport.emitData(`"}\n{"jsonrpc":"2.0","id":${followerId},"result":"ok"}\n`);

    await expect(oversized).rejects.toThrow(/exceeded 16 MiB/);
    await expect(follower).resolves.toBe("ok");
    expect(client.isClosed()).toBe(false);
  });

  it("discards an oversized notification without rejecting pending calls", async () => {
    const transport = new MockTransport();
    const client = new RuntimeRpcClient(transport);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pending = client.call("projects.list", {});
      const pendingId = requestId(transport.writes[0]!);

      // A notification whose params embed an "id" field matching the pending
      // call must not be mistaken for that call's response.
      transport.emitData(`{"jsonrpc":"2.0","method":"runtime/event","params":{"id":${pendingId},"blob":"`);
      transport.emitData("z".repeat(17 * 1024 * 1024));
      transport.emitData(`"}}\n`);

      expect(client.isClosed()).toBe(false);
      transport.emitData({ jsonrpc: "2.0", id: pendingId, result: ["project"] });
      await expect(pending).resolves.toEqual(["project"]);
    } finally {
      warn.mockRestore();
    }
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
