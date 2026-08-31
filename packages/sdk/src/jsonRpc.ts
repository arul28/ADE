import net from "node:net";
import { AdeError, toError } from "./errors.js";

/**
 * Newline-delimited JSON-RPC 2.0 over a unix socket or Windows named pipe.
 *
 * ADE's server mirrors the transport mode of the first frame it receives
 * (`apps/ade-cli/src/jsonrpc.ts` → `writeMessage`), so a client that only ever
 * writes NDJSON only ever gets NDJSON back. That is why this reimplementation
 * does not carry the reference client's `Content-Length` reader: unreachable
 * code on this path, and a second framing mode is a second place to get the
 * byte accounting wrong.
 *
 * Reimplemented from (not imported from) `apps/ade-cli/src/tuiClient/
 * jsonRpcClient.ts` — the package must build standalone.
 */

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const NEWLINE = 0x0a;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
};

export type NotificationHandler = (params: unknown) => void;

export class JsonRpcConnection {
  private nextId = 1;
  private readonly queue = new ByteQueue();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly closeHandlers = new Set<(error: Error) => void>();
  private closed = false;

  private constructor(
    private readonly socket: net.Socket,
    private readonly defaultTimeoutMs: number,
  ) {
    socket.on("data", (chunk: Buffer | string) => this.handleData(chunk));
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () =>
      this.fail(new AdeError("transport_closed", "The ADE runtime socket closed.")),
    );
  }

  /** Connect once. Callers that need retry/backoff wrap this. */
  static connect(
    endpoint: string,
    options: { timeoutMs?: number } = {},
  ): Promise<JsonRpcConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      const cleanup = (): void => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = (): void => {
        cleanup();
        resolve(new JsonRpcConnection(socket, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      };
      const onError = (error: Error): void => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new AdeError("transport_closed", `The ADE runtime socket is closed (${method}).`),
      );
    }
    let timeoutMs: number;
    try {
      timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? this.defaultTimeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.nextId++;
    const key = String(id);
    const payload = {
      jsonrpc: "2.0" as const,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(key)) return;
        // A timed-out request means the framing is no longer trustworthy: the
        // response may still arrive and desynchronise every later id. Kill the
        // connection rather than leave a half-understood stream in place.
        this.fail(
          new AdeError(
            "rpc_timeout",
            `The ADE runtime did not answer ${method} within ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(key, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        const entry = this.pending.get(key);
        if (entry) clearTimeout(entry.timer);
        this.pending.delete(key);
        reject(new AdeError("transport_closed", `Failed to send ${method}.`, { cause: error }));
      });
    });
  }

  /** Fire-and-forget notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const payload = {
      jsonrpc: "2.0" as const,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.socket.write(`${JSON.stringify(payload)}\n`, "utf8", () => {});
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers =
      this.notificationHandlers.get(method) ?? new Set<NotificationHandler>();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.notificationHandlers.delete(method);
    };
  }

  /** Fires only on an unexpected drop, never on an intentional `close()`. */
  onClose(handler: (error: Error) => void): () => void {
    if (this.closed) return () => {};
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(): void {
    // Marked closed BEFORE teardown so the socket's own "close" event is read
    // as intentional and does not fire the unexpected-drop handlers.
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new AdeError("transport_closed", "The ADE runtime socket closed."));
    try {
      this.socket.end();
      this.socket.destroy();
    } catch {
      // Teardown is best-effort once pending requests are settled.
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(error);
    try {
      this.socket.destroy();
    } catch {
      // Best-effort.
    }
    for (const handler of [...this.closeHandlers]) {
      try {
        handler(error);
      } catch {
        // One listener throwing must not break the others or the teardown.
      }
    }
    this.closeHandlers.clear();
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private handleData(chunk: Buffer | string): void {
    if (this.closed) return;
    this.queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    while (true) {
      let line: string | null;
      try {
        line = this.queue.takeLine(MAX_FRAME_BYTES);
      } catch (error) {
        this.fail(toError(error));
        return;
      }
      if (line == null) return;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: JsonRpcMessage | JsonRpcMessage[];
      try {
        parsed = JSON.parse(trimmed) as JsonRpcMessage | JsonRpcMessage[];
      } catch (error) {
        this.fail(
          new AdeError("protocol_error", "The ADE runtime sent a non-JSON frame.", {
            cause: error,
          }),
        );
        return;
      }
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        this.handleMessage(message);
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id == null) {
      if (typeof message.method !== "string") return;
      for (const handler of this.notificationHandlers.get(message.method) ?? []) {
        try {
          handler(message.params);
        } catch {
          // A subscriber throwing must not stall the read loop.
        }
      }
      return;
    }
    const entry = this.pending.get(String(message.id));
    if (!entry) return;
    this.pending.delete(String(message.id));
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        new AdeError(
          "rpc_error",
          `${entry.method} failed: ${message.error.message}`,
          { cause: message.error },
        ),
      );
      return;
    }
    entry.resolve(message.result);
  }
}

function normalizeTimeoutMs(value: number): number {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new AdeError(
      "invalid_option",
      `RPC timeout must be a finite positive number no greater than ${MAX_TIMEOUT_MS}.`,
    );
  }
  return Math.ceil(timeoutMs);
}

/**
 * Chunk list with newline scanning, so a frame split across TCP/pipe reads is
 * assembled without repeatedly concatenating the whole backlog.
 */
class ByteQueue {
  private chunks: Buffer[] = [];
  private bytes = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  /** Returns the next newline-terminated frame, or null when incomplete. */
  takeLine(maxBytes: number): string | null {
    const index = this.indexOfByte(NEWLINE);
    if (index < 0) {
      if (this.bytes > maxBytes) {
        throw new AdeError(
          "protocol_error",
          `The ADE runtime sent an oversized frame (> ${maxBytes} bytes).`,
        );
      }
      return null;
    }
    if (index > maxBytes) {
      throw new AdeError(
        "protocol_error",
        `The ADE runtime sent an oversized frame (> ${maxBytes} bytes).`,
      );
    }
    const payload = this.consume(index).toString("utf8");
    this.discard(1);
    return payload;
  }

  private indexOfByte(byte: number): number {
    let offset = 0;
    for (const chunk of this.chunks) {
      const index = chunk.indexOf(byte);
      if (index >= 0) return offset + index;
      offset += chunk.length;
    }
    return -1;
  }

  private consume(length: number): Buffer {
    const clamped = Math.max(0, Math.min(length, this.bytes));
    if (clamped === 0) return Buffer.alloc(0);
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

  private discard(length: number): void {
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
