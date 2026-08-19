import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  startJsonRpcServer,
  type JsonRpcHandler,
  type JsonRpcInternalErrorReport,
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

  pushChunk(chunk: string): void {
    for (const callback of this.callbacks) {
      callback(Buffer.from(chunk, "utf8"));
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

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("startJsonRpcServer", () => {
  it("waits for more data instead of re-entering drain on partial frames", async () => {
    const transport = new MemoryTransport();
    const onError = vi.fn();
    const handler: JsonRpcHandler = vi.fn(async (request) => ({ ok: true, method: request.method }));

    const stop = startJsonRpcServer(handler, transport, {
      nonFatal: true,
      onError,
    });

    transport.pushChunk('{"jsonrpc":"2.0","id":1,"method":"ping"');
    await waitForDrain();

    expect(handler).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(transport.closed).toBe(false);
    expect(transport.writes).toEqual([]);

    transport.pushChunk("}\n");
    await waitForDrain();

    expect(jsonlResponses(transport)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true, method: "ping" },
      },
    ]);

    stop();
  });

  it("dispatches complete requests concurrently on one connection", async () => {
    const transport = new MemoryTransport();
    const slow = deferred<void>();
    const calls: string[] = [];
    const handler: JsonRpcHandler = vi.fn(async (request) => {
      calls.push(request.method ?? "");
      if (request.method === "slow") {
        await slow.promise;
      }
      return { ok: true, method: request.method };
    });

    const stop = startJsonRpcServer(handler, transport, { nonFatal: true });

    transport.push({ jsonrpc: "2.0", id: 1, method: "slow" });
    transport.push({ jsonrpc: "2.0", id: 2, method: "fast" });
    await waitForDrain();

    expect(calls).toEqual(["slow", "fast"]);
    expect(jsonlResponses(transport)).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        result: { ok: true, method: "fast" },
      },
    ]);

    slow.resolve(undefined);
    await waitForDrain();

    expect(jsonlResponses(transport)).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        result: { ok: true, method: "fast" },
      },
      {
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true, method: "slow" },
      },
    ]);

    stop();
  });

  it("keeps session and layout reads responsive during slow lane, GitHub, and mutation calls", async () => {
    const transport = new MemoryTransport();
    const slowSnapshot = deferred<void>();
    const slowGithub = deferred<void>();
    const slowDelete = deferred<void>();
    const calls: string[] = [];
    const handler = (async (request) => {
      const params = request.params as { arguments?: { domain?: string; action?: string } } | undefined;
      const action = params?.arguments?.action ?? request.method ?? "";
      calls.push(action);
      if (action === "listSnapshots") await slowSnapshot.promise;
      if (action === "getStatus") await slowGithub.promise;
      if (action === "delete") await slowDelete.promise;
      return { ok: true, action };
    }) as JsonRpcHandler;

    const stop = startJsonRpcServer(handler, transport, { nonFatal: true });
    const call = (id: number, domain: string, action: string) => transport.push({
      jsonrpc: "2.0",
      id,
      method: "ade/actions/call",
      params: { arguments: { domain, action } },
    });

    call(1, "lane", "listSnapshots");
    call(2, "github", "getStatus");
    call(3, "lane", "delete");
    call(4, "session", "list");
    call(5, "layout", "get");
    await waitForDrain();

    expect(calls).toHaveLength(5);
    expect(calls).toEqual(expect.arrayContaining(["listSnapshots", "getStatus", "delete", "list", "get"]));
    expect(jsonlResponses(transport)).toEqual([
      { jsonrpc: "2.0", id: 4, result: { ok: true, action: "list" } },
      { jsonrpc: "2.0", id: 5, result: { ok: true, action: "get" } },
    ]);

    slowDelete.resolve(undefined);
    slowSnapshot.resolve(undefined);
    slowGithub.resolve(undefined);
    await stop.waitForIdle();
    expect(calls.filter((action) => action === "delete")).toHaveLength(1);
    stop();
  });

  it("waits for active dispatches before reporting idle", async () => {
    const transport = new MemoryTransport();
    const slow = deferred<void>();
    const handler: JsonRpcHandler = vi.fn(async (request) => {
      if (request.method === "slow") {
        await slow.promise;
      }
      return { ok: true, method: request.method };
    });

    const stop = startJsonRpcServer(handler, transport, { nonFatal: true });
    transport.push({ jsonrpc: "2.0", id: 1, method: "slow" });
    await waitForDrain();

    let idle = false;
    const idlePromise = stop.waitForIdle().then(() => {
      idle = true;
    });
    await waitForDrain();
    expect(idle).toBe(false);

    slow.resolve(undefined);
    await idlePromise;

    expect(idle).toBe(true);
    expect(jsonlResponses(transport)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true, method: "slow" },
      },
    ]);

    stop();
  });

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

describe("internal error replies", () => {
  async function failWith(error: unknown, options?: { onInternalError?: (report: JsonRpcInternalErrorReport) => void }) {
    const transport = new MemoryTransport();
    const stop = startJsonRpcServer(async () => {
      throw error;
    }, transport, {
      nonFatal: true,
      ...(options?.onInternalError ? { onInternalError: options.onInternalError } : {}),
    });
    transport.push({ jsonrpc: "2.0", id: 1, method: "ade/actions/call" });
    await waitForDrain();
    stop();
    return jsonlResponses(transport)[0] as {
      error: { code: number; message: string; data?: { code?: string; errorId?: string } };
    };
  }

  it("never forwards a raw filesystem errno, and logs it against a reference", async () => {
    // The production shape: macOS EDEADLK, which libuv cannot name.
    const raw = Object.assign(
      new Error("Unknown system error -11: Unknown system error -11, read"),
      { errno: -11, code: "EDEADLK", syscall: "read" },
    );
    const reports: JsonRpcInternalErrorReport[] = [];
    const response = await failWith(raw, { onInternalError: (report) => reports.push(report) });

    expect(response.error.code).toBe(-32603);
    expect(response.error.message).not.toContain("Unknown system error");
    expect(response.error.message).toMatch(/^Internal error in ade\/actions\/call \(ref [0-9a-f]+\)$/);
    expect(response.error.data?.errorId).toMatch(/^[0-9a-f]+$/);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.method).toBe("ade/actions/call");
    expect(reports[0]?.errorId).toBe(response.error.data?.errorId);
    expect(reports[0]?.error).toBe(raw);
  });

  it("redacts path-bearing fs errors and runtime faults", async () => {
    const enoent = Object.assign(
      new Error("ENOENT: no such file or directory, open '/Users/someone/private/ade.db'"),
      { errno: -2, code: "ENOENT", syscall: "open" },
    );
    expect((await failWith(enoent)).error.message).not.toContain("/Users/someone");

    const fault = new TypeError("Cannot read properties of undefined (reading 'db')");
    expect((await failWith(fault)).error.message).not.toContain("undefined");

    expect((await failWith("boom")).error.message).not.toContain("boom");
  });

  it("redacts Node's own internal codes, which quote absolute paths", async () => {
    // A packaged build that lost a file reaches the boundary as a plain Error
    // whose code is a Node internal one — not an errno — and whose message
    // names the path. Both shapes must take the reference path, not the
    // "service verdict" path that forwards the message verbatim.
    for (const code of ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_FS_EISDIR"]) {
      const reports: JsonRpcInternalErrorReport[] = [];
      const error = Object.assign(
        new Error("Cannot find module '/Users/someone/ADE/apps/ade-cli/dist/brain.js'"),
        { code },
      );
      const response = await failWith(error, {
        onInternalError: (report) => reports.push(report),
      });

      expect(response.error.message).not.toContain("/Users/someone");
      expect(response.error.message).toMatch(/^Internal error in ade\/actions\/call \(ref [0-9a-f]+\)$/);
      expect(response.error.data?.code).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]?.error).toBe(error);
    }
  });

  it("forwards a service's coded verdict so the caller can act on it", async () => {
    const response = await failWith(Object.assign(
      new Error("ADE couldn't read this project's data at /tmp/p/.ade/ade.db."),
      { code: "storage_read_failed" },
    ));

    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toBe(
      "storage_read_failed: ADE couldn't read this project's data at /tmp/p/.ade/ade.db.",
    );
    expect(response.error.data?.code).toBe("storage_read_failed");
  });

  it("keeps a message that merely starts with an identifier and a colon", async () => {
    // Only the error's OWN code may be stripped off the front. A message whose
    // first word happens to be an identifier followed by a colon — a `gh`
    // failure relayed verbatim, a Windows drive letter — would otherwise lose
    // its head on the way out and reach the caller decapitated.
    for (const [message, expected] of [
      ["gh: not authenticated. Run `gh auth login`.", "gh: not authenticated. Run `gh auth login`."],
      ["C:\\Users\\Ada\\project is not a git repository.", "C:\\Users\\Ada\\project is not a git repository."],
    ] as const) {
      const response = await failWith(Object.assign(new Error(message), {
        code: "github_cli_unavailable",
      }));

      expect(response.error.message).toBe(`github_cli_unavailable: ${expected}`);
      expect(response.error.data?.code).toBe("github_cli_unavailable");
    }
  });

  it("keeps a service-authored refusal readable", async () => {
    const response = await failWith(new Error("Project root does not exist: /tmp/gone"));
    expect(response.error.message).toBe("Project root does not exist: /tmp/gone");
    expect(response.error.data).toBeUndefined();
  });
});
