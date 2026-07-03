import net from "node:net";

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  method?: string;
  params?: unknown;
};

export class JsonRpcClient {
  private nextId = 1;
  private readonly buffer = new RpcByteQueue();
  private pendingContentLength: number | null = null;
  private pending = new Map<string, PendingRequest>();
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly socket: net.Socket,
    private readonly defaultTimeoutMs = 120_000,
  ) {
    socket.on("data", (chunk: Buffer | string) => this.handleData(chunk));
    socket.on("error", (error) => this.handleSocketClosed(error));
    socket.on("close", () => this.handleSocketClosed(new Error("ADE RPC socket closed.")));
  }

  static connect(socketPath: string): Promise<JsonRpcClient> {
    return new Promise((resolve, reject) => {
      let socket: net.Socket;
      if (socketPath.startsWith("tcp://")) {
        const parsed = new URL(socketPath);
        socket = net.createConnection({
          host: parsed.hostname || "127.0.0.1",
          port: Number.parseInt(parsed.port, 10),
        });
      } else {
        socket = net.createConnection(socketPath);
      }
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = () => {
        cleanup();
        resolve(new JsonRpcClient(socket));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("ADE RPC socket is closed."));
    const id = this.nextId++;
    const pendingKey = String(id);
    let timeoutMs: number;
    try {
      timeoutMs = normalizeRpcTimeoutMs(options.timeoutMs ?? this.defaultTimeoutMs);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(pendingKey)) return;
        this.failConnection(
          new Error(`ADE RPC socket timed out waiting for method ${method} (${timeoutMs}ms).`),
        );
      }, timeoutMs);
      this.pending.set(pendingKey, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(pendingKey);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(pendingKey);
        reject(error);
      });
    });
  }

  close(): void {
    // Mark closed before tearing down so the subsequent socket "close" event is
    // treated as intentional and does NOT fire the unexpected-close handlers.
    this.closed = true;
    this.rejectAll(new Error("ADE RPC socket closed."));
    this.socket.end();
    this.socket.destroy();
  }

  /**
   * Register a listener fired when the socket drops unexpectedly (peer close or
   * error) — but NOT on an intentional `close()`. Returns an unsubscribe fn.
   */
  onClose(handler: () => void): () => void {
    if (this.closed) {
      handler();
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  private handleSocketClosed(error: Error): void {
    this.failConnection(error);
  }

  private failConnection(error: Error): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.rejectAll(error);
    if (!wasClosed) {
      try {
        this.socket.destroy();
      } catch {
        // Socket teardown is best-effort after pending requests are rejected.
      }
    }
    if (wasClosed) return;
    for (const handler of [...this.closeHandlers]) {
      try {
        handler();
      } catch {
        // A listener throwing must not break the others or the teardown.
      }
    }
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set<(params: unknown) => void>();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.notificationHandlers.delete(method);
    };
  }

  private handleData(chunk: Buffer | string): void {
    if (this.closed) return;
    this.buffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    while (true) {
      let next: string | null;
      try {
        next = this.takeNextPayload();
      } catch (error) {
        this.failConnection(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!next) return;
      const line = next.trim();
      if (!line) continue;
      let parsed: JsonRpcResponse | JsonRpcResponse[] | null = null;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse | JsonRpcResponse[];
      } catch (error) {
        this.failConnection(new Error(`Failed to parse ADE RPC response: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      const responses = Array.isArray(parsed) ? parsed : [parsed];
      for (const response of responses) this.handleResponse(response);
    }
  }

  private takeNextPayload(): string | null {
    if (this.pendingContentLength != null) {
      return this.takeContentLengthBody();
    }
    while (this.buffer.length) {
      const byte = this.buffer.peekByte(0);
      if (byte == null || !isAsciiWhitespace(byte)) break;
      this.buffer.discard(1);
    }
    if (!this.buffer.length) return null;
    const first = this.buffer.peekByte(0);
    if (first === 0x7b || first === 0x5b) {
      const idx = this.buffer.indexOf(0x0a);
      if (idx < 0) {
        if (this.buffer.length > MAX_RPC_BUFFER_BYTES) {
          throw new Error(`ADE RPC socket sent an oversized partial frame (> ${MAX_RPC_BUFFER_BYTES} bytes).`);
        }
        return null;
      }
      if (idx > MAX_RPC_BUFFER_BYTES) {
        throw new Error(`ADE RPC socket sent an oversized JSON line (> ${MAX_RPC_BUFFER_BYTES} bytes).`);
      }
      const payload = this.buffer.consume(idx).toString("utf8");
      this.buffer.discard(1);
      return payload;
    }
    const probe = this.buffer.peekAscii(Math.min(this.buffer.length, CONTENT_LENGTH_PREFIX.length)).toLowerCase();
    if (!CONTENT_LENGTH_PREFIX.startsWith(probe)) {
      throw new Error("ADE RPC socket sent non-JSON output.");
    }

    const crlfBoundary = this.buffer.indexOfSequence(CRLF_HEADER_BOUNDARY);
    const lfBoundary = this.buffer.indexOfSequence(LF_HEADER_BOUNDARY);
    let boundary: { index: number; length: number } | null = null;
    if (crlfBoundary >= 0) boundary = { index: crlfBoundary, length: 4 };
    else if (lfBoundary >= 0) boundary = { index: lfBoundary, length: 2 };
    if (!boundary && this.buffer.length > MAX_RPC_HEADER_BYTES) {
      throw new Error(`ADE RPC socket sent an oversized Content-Length header (> ${MAX_RPC_HEADER_BYTES} bytes).`);
    }
    if (!boundary) return null;
    const header = this.buffer.consume(boundary.index).toString("ascii");
    this.buffer.discard(boundary.length);
    const match = /^content-length\s*:\s*(\d+)\s*$/im.exec(header);
    if (!match) {
      throw new Error("ADE RPC socket sent a malformed Content-Length frame.");
    }
    const length = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(length) || length < 0 || length > MAX_RPC_BUFFER_BYTES) {
      throw new Error(`ADE RPC socket sent an oversized Content-Length frame (${length} bytes).`);
    }
    this.pendingContentLength = length;
    return this.takeContentLengthBody();
  }

  private takeContentLengthBody(): string | null {
    const length = this.pendingContentLength;
    if (length == null) return null;
    if (this.buffer.length < length) return null;
    this.pendingContentLength = null;
    return this.buffer.consume(length).toString("utf8");
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (response.id == null) {
      if (typeof response.method === "string") {
        for (const handler of this.notificationHandlers.get(response.method) ?? []) {
          handler(response.params);
        }
      }
      return;
    }
    const pendingKey = String(response.id);
    const pending = this.pending.get(pendingKey);
    if (!pending) return;
    this.pending.delete(pendingKey);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }
    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const MAX_RPC_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_RPC_HEADER_BYTES = 64 * 1024;
const MAX_RPC_TIMEOUT_MS = 2_147_483_647;
const CONTENT_LENGTH_PREFIX = "content-length";
const CRLF_HEADER_BOUNDARY = Buffer.from("\r\n\r\n", "ascii");
const LF_HEADER_BOUNDARY = Buffer.from("\n\n", "ascii");

class RpcByteQueue {
  private chunks: Buffer[] = [];
  private bytes = 0;

  get length(): number {
    return this.bytes;
  }

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  peekByte(offset: number): number | undefined {
    if (offset < 0 || offset >= this.bytes) return undefined;
    let cursor = offset;
    for (const chunk of this.chunks) {
      if (cursor < chunk.length) return chunk[cursor];
      cursor -= chunk.length;
    }
    return undefined;
  }

  peekAscii(length: number): string {
    const clamped = Math.max(0, Math.min(length, this.bytes));
    if (clamped === 0) return "";
    const bytes = Buffer.allocUnsafe(clamped);
    for (let index = 0; index < clamped; index += 1) {
      bytes[index] = this.peekByte(index) ?? 0;
    }
    return bytes.toString("ascii");
  }

  indexOf(byte: number): number {
    let offset = 0;
    for (const chunk of this.chunks) {
      const index = chunk.indexOf(byte);
      if (index >= 0) return offset + index;
      offset += chunk.length;
    }
    return -1;
  }

  indexOfSequence(sequence: Buffer): number {
    if (sequence.length === 0) return 0;
    if (this.bytes < sequence.length) return -1;
    const maxStart = this.bytes - sequence.length;
    for (let start = 0; start <= maxStart; start += 1) {
      let matched = true;
      for (let offset = 0; offset < sequence.length; offset += 1) {
        if (this.peekByte(start + offset) !== sequence[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) return start;
    }
    return -1;
  }

  consume(length: number): Buffer {
    const clamped = Math.max(0, Math.min(length, this.bytes));
    if (clamped === 0) return Buffer.alloc(0);
    if (this.chunks.length === 1 && clamped === this.chunks[0]!.length) {
      const only = this.chunks.shift()!;
      this.bytes = 0;
      return only;
    }

    const parts: Buffer[] = [];
    let remaining = clamped;
    while (remaining > 0 && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      if (remaining < first.length) {
        parts.push(first.subarray(0, remaining));
        this.chunks[0] = first.subarray(remaining);
        this.bytes -= remaining;
        remaining = 0;
      } else {
        parts.push(first);
        this.chunks.shift();
        this.bytes -= first.length;
        remaining -= first.length;
      }
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, clamped);
  }

  discard(length: number): void {
    let remaining = Math.max(0, Math.min(length, this.bytes));
    while (remaining > 0 && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      if (remaining < first.length) {
        this.chunks[0] = first.subarray(remaining);
        this.bytes -= remaining;
        return;
      }
      this.chunks.shift();
      this.bytes -= first.length;
      remaining -= first.length;
    }
  }
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function normalizeRpcTimeoutMs(value: number): number {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_RPC_TIMEOUT_MS) {
    throw new Error(
      `ADE RPC timeout must be a finite positive number no greater than ${MAX_RPC_TIMEOUT_MS}.`,
    );
  }
  return Math.ceil(timeoutMs);
}
