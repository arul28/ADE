import type { JsonRpcId, JsonRpcRequest, JsonRpcTransport } from "../../../../../ade-cli/src/jsonrpc";

export type RuntimeRpcTransport = JsonRpcTransport & {
  onClose?: (callback: () => void) => void;
  onError?: (callback: (error: Error) => void) => void;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_RPC_BUFFER_CHARS = 16 * 1024 * 1024;
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

export class RuntimeRpcClient {
  private nextId = 1;
  private buffer = "";
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
    this.transport.onClose?.(() => {
      this.failConnection(new Error("Remote ADE service connection closed."));
    });
  }

  async initialize(clientName: string, version: string): Promise<unknown> {
    return await this.call("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: clientName, version },
      identity: {
        callerId: `${clientName}:${process.pid}`,
        role: "cto",
      },
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
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(
          new Error(`Remote ADE service timed out waiting for method ${method} (${timeoutMs}ms).`),
        );
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.transport.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
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
    this.buffer += chunk;
    if (this.buffer.length > MAX_RPC_BUFFER_CHARS) {
      this.failConnection(new Error("Remote ADE service response buffer exceeded 16 MiB."));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
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
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
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
      callback(error);
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
