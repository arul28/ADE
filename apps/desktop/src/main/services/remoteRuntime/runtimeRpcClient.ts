import type { JsonRpcId, JsonRpcRequest, JsonRpcTransport } from "../../../../../ade-cli/src/jsonrpc";

export type RuntimeRpcTransportCloseInfo = {
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string | null;
};

export type RuntimeRpcTransport = JsonRpcTransport & {
  onClose?: (callback: (info?: RuntimeRpcTransportCloseInfo) => void) => void;
  onError?: (callback: (error: Error) => void) => void;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_RPC_BUFFER_CHARS = 16 * 1024 * 1024;
// Head of an oversized line retained to identify which request it answers.
// The JSON-RPC envelope id appears within the first few dozen chars of a
// response; 4 KiB is generous while keeping discarded-line memory bounded.
const OVERSIZED_LINE_PREFIX_CHARS = 4096;
const MAX_RPC_TIMEOUT_MS = 2_147_483_647;

type RuntimeRpcCallOptions = {
  timeoutMs?: number;
};

function formatRpcErrorData(data: unknown): string {
  if (data && typeof data === "object") return JSON.stringify(data);
  if (typeof data === "string" && data.trim()) return data.trim();
  return "";
}

function normalizeRuntimeRpcTimeoutMs(value: number): number {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_RPC_TIMEOUT_MS) {
    throw new Error(
      `Runtime RPC timeout must be a finite positive number no greater than ${MAX_RPC_TIMEOUT_MS}.`,
    );
  }
  return Math.ceil(timeoutMs);
}

type OversizedLineState = {
  prefix: string;
  discardedChars: number;
};

export class RuntimeRpcClient {
  private nextId = 1;
  private buffer = "";
  private oversizedLine: OversizedLineState | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly disconnectCallbacks = new Set<(error: Error) => void>();
  private closedError: Error | null = null;

  constructor(
    private readonly transport: RuntimeRpcTransport,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {
    this.transport.onData((chunk) => this.onData(chunk.toString("utf8")));
    this.transport.onError?.((error) => {
      this.failConnection(new Error(`Remote ADE service connection failed: ${error.message}`));
    });
    this.transport.onClose?.((info) => {
      const details = [
        info?.exitCode != null ? `exit code ${info.exitCode}` : null,
        info?.signal ? `signal ${info.signal}` : null,
        info?.stderr?.trim() ? `stderr: ${info.stderr.trim()}` : null,
      ].filter((value): value is string => value != null);
      this.failConnection(new Error(
        details.length > 0
          ? `Remote ADE service connection closed (${details.join(", ")}).`
          : "Remote ADE service connection closed.",
      ));
    });
  }

  async initialize(
    clientName: string,
    version: string,
    options: {
      desktopBridgeAuthToken?: string | null;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    return await this.call("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: clientName, version },
      identity: {
        callerId: `${clientName}:${process.pid}`,
        role: "cto",
      },
      ...(options.desktopBridgeAuthToken?.trim()
        ? { desktopBridgeAuthToken: options.desktopBridgeAuthToken.trim() }
        : {}),
    }, {
      ...(options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  call(
    method: string,
    params?: Record<string, unknown>,
    options: RuntimeRpcCallOptions = {},
  ): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: id as JsonRpcId,
      method,
      ...(params ? { params } : {}),
    };
    let timeoutMs: number;
    try {
      timeoutMs = normalizeRuntimeRpcTimeoutMs(options.timeoutMs ?? this.timeoutMs);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.takePending(id);
        if (!pending) return;
        pending.reject(
          new Error(`Remote ADE service timed out waiting for method ${pending.method} (${timeoutMs}ms).`),
        );
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.transport.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.takePending(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onDisconnect(callback: (error: Error) => void): () => void {
    if (this.closedError) {
      const error = this.closedError;
      queueMicrotask(() => callback(error));
      return () => {};
    }
    this.disconnectCallbacks.add(callback);
    return () => {
      this.disconnectCallbacks.delete(callback);
    };
  }

  onNotification(method: string, callback: (params: unknown) => void): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set<(params: unknown) => void>();
    handlers.add(callback);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(callback);
      if (handlers.size === 0) {
        this.notificationHandlers.delete(method);
      }
    };
  }

  close(): void {
    this.failConnection(new Error("Remote ADE service connection closed."));
    try {
      this.transport.close();
    } catch {
      // Best-effort close. Pending callers have already been rejected.
    }
  }

  isClosed(): boolean {
    return this.closedError != null;
  }

  private onData(chunk: string): void {
    if (this.closedError) return;
    if (this.oversizedLine) {
      // An oversized line is being discarded as it streams. Drop chunks until
      // its terminating newline, then resume normal parsing on the remainder.
      const newline = chunk.indexOf("\n");
      if (newline < 0) {
        this.oversizedLine.discardedChars += chunk.length;
        return;
      }
      const oversized = this.oversizedLine;
      this.oversizedLine = null;
      oversized.discardedChars += newline;
      this.rejectOversizedLine(oversized);
      chunk = chunk.slice(newline + 1);
    }
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
      if (this.closedError) return;
    }
    // The leftover is one partial line. If it has outgrown the buffer cap,
    // reject only the request it answers and discard the rest of the line as
    // it streams — a single oversized response must not take down the shared
    // connection (every project pane multiplexes over it). Note the cap
    // bounds PARTIAL-LINE ACCUMULATION, not message size: a complete line
    // delivered within one chunk is parsed regardless of length. Real
    // transports chunk at ~64 KB, so any >16 MiB line lands here in practice.
    if (this.buffer.length > MAX_RPC_BUFFER_CHARS) {
      this.oversizedLine = {
        prefix: this.buffer.slice(0, OVERSIZED_LINE_PREFIX_CHARS),
        discardedChars: this.buffer.length,
      };
      this.buffer = "";
    }
  }

  private takePending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  /**
   * Fail the single request answered by a discarded oversized line. The
   * envelope id is recovered from the retained line head; a `"method"` key
   * appearing before `"id"` marks the line as a notification (its params may
   * embed unrelated `"id"` fields), in which case nothing is rejected.
   *
   * Heuristic assumption: the daemon serializes response envelopes with the
   * top-level `id` before `result` (jsonrpc.ts writeMessage key order), so
   * the first `"id"` in a response line is the envelope id, never one nested
   * inside the result. If a misfire ever happens anyway, the failure mode is
   * benign: no pending entry matches, the line is warn-logged and dropped,
   * and the real caller times out instead of receiving a wrong rejection.
   */
  private rejectOversizedLine(oversized: OversizedLineState): void {
    const idMatch = /"id"\s*:\s*(\d+)/.exec(oversized.prefix);
    const methodMatch = /"method"\s*:/.exec(oversized.prefix);
    const responseId = idMatch && (!methodMatch || idMatch.index < methodMatch.index)
      ? Number(idMatch[1])
      : null;
    const approxMiB = (oversized.discardedChars / (1024 * 1024)).toFixed(1);
    const pending = responseId != null ? this.takePending(responseId) : undefined;
    if (!pending || responseId == null) {
      console.warn("Remote ADE service sent an oversized message; discarded", {
        approxMiB,
        hasResponseId: responseId != null,
      });
      return;
    }
    pending.reject(new Error(
      `Remote ADE service response for method ${pending.method} exceeded 16 MiB (~${approxMiB} MiB) and was discarded.`,
    ));
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.failConnection(new Error(`Failed to parse remote ADE service response: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const response = parsed as Record<string, unknown>;
    const id = typeof response.id === "number" ? response.id : null;
    if (id == null) {
      const method = typeof response.method === "string" ? response.method : "";
      if (!method) return;
      for (const handler of this.notificationHandlers.get(method) ?? []) {
        try {
          handler(response.params);
        } catch (error) {
          console.error("Remote ADE notification handler failed", { method, error });
        }
      }
      return;
    }
    const pending = this.takePending(id);
    if (!pending) return;
    const error = response.error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const rpcError = error as { code?: unknown; message?: unknown; data?: unknown };
      const message = String(rpcError.message ?? "Remote ADE service request failed.");
      const code = typeof rpcError.code === "number" ? ` (code ${rpcError.code})` : "";
      const data = formatRpcErrorData(rpcError.data);
      pending.reject(new Error(
        `Remote ADE service method ${pending.method} failed${code}: ${message}${data ? ` Details: ${data}` : ""}`,
      ));
      return;
    }
    pending.resolve(response.result);
  }

  private failConnection(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.rejectAll(error);
    for (const callback of this.disconnectCallbacks) {
      try {
        callback(error);
      } catch {
        // Disconnect observers are best-effort; the connection is already failed.
      }
    }
    this.disconnectCallbacks.clear();
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
