import { WebSocket, type RawData } from "ws";

/**
 * A minimal Chrome DevTools Protocol client over one WebSocket.
 *
 * Shared by App Control (one page target per connection) and the user-browser
 * attachment (one browser-level connection, with each tab reached through a
 * flattened `Target.attachToTarget` session). `session(id)` is the second
 * case: the same socket, every command stamped with the session id and every
 * event filtered to it.
 */

const CDP_COMMAND_TIMEOUT_MS = 15_000;

type CdpPendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** The slice of a CDP connection a caller sends commands and hears events on. */
export type CdpCommandChannel = {
  send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  on: (method: string, listener: (params: unknown) => void) => () => void;
};

/** Listener-map key for a session-scoped event. NUL cannot appear in a method name. */
function sessionEventKey(sessionId: string, method: string): string {
  return `${sessionId}\u0000${method}`;
}

export class CdpClient implements CdpCommandChannel {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, CdpPendingCommand>();
  private readonly methodListeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private readonly closeWaiters = new Set<() => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: RawData) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const method = typeof message.method === "string" ? message.method : null;
      if (method) {
        const sessionId = typeof message.sessionId === "string" ? message.sessionId : null;
        const key = sessionId ? sessionEventKey(sessionId, method) : method;
        const listeners = this.methodListeners.get(key);
        if (listeners) {
          for (const listener of listeners) {
            try { listener(message.params); } catch { /* ignore */ }
          }
        }
        return;
      }
      const id = typeof message.id === "number" ? message.id : null;
      if (id == null) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error && typeof message.error === "object") {
        const error = message.error as { message?: string };
        pending.reject(new Error(error.message ?? "CDP command failed."));
      } else {
        pending.resolve(message.result);
      }
    });
    ws.on("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed."));
      }
      this.pending.clear();
      for (const resolve of this.closeWaiters) resolve();
      this.closeWaiters.clear();
      for (const listener of [...this.closeListeners]) {
        try { listener(); } catch { /* ignore */ }
      }
      this.closeListeners.clear();
    });
    ws.on("error", (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.pending.clear();
    });
  }

  /**
   * Open a connection. `timeoutMs` bounds the handshake; without it the
   * socket library's own behavior applies (App Control's historic default).
   */
  static connect(wsUrl: string, options: { timeoutMs?: number } = {}): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      const timer = options.timeoutMs
        ? setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.terminate();
          reject(new Error(`Timed out connecting to ${wsUrl} after ${options.timeoutMs}ms.`));
        }, options.timeoutMs)
        : null;
      ws.once("open", () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.sendRaw<T>(method, params, null);
  }

  private sendRaw<T>(method: string, params: Record<string, unknown> | undefined, sessionId: string | null): Promise<T> {
    if (this.isClosed()) return Promise.reject(new Error("CDP connection closed."));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${CDP_COMMAND_TIMEOUT_MS}ms.`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.ws.send(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    return this.addListener(method, listener);
  }

  private addListener(key: string, listener: (params: unknown) => void): () => void {
    let listeners = this.methodListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.methodListeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.methodListeners.get(key);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.methodListeners.delete(key);
    };
  }

  /**
   * A flattened target session on this connection (`Target.attachToTarget`
   * with `flatten: true`): commands carry the session id, and only that
   * session's events reach its listeners.
   */
  session(sessionId: string): CdpCommandChannel {
    return {
      send: <T = unknown>(method: string, params?: Record<string, unknown>) =>
        this.sendRaw<T>(method, params, sessionId),
      on: (method, listener) => this.addListener(sessionEventKey(sessionId, method), listener),
    };
  }

  /** Called once when the socket closes, for whatever reason. */
  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  isClosed(): boolean {
    return this.closed || this.ws.readyState === this.ws.CLOSING || this.ws.readyState === this.ws.CLOSED;
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.ws.readyState === this.ws.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.closeWaiters.add(resolve);
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.close();
      } else if (this.ws.readyState === this.ws.CLOSING) {
        // Already waiting for the close event.
      } else {
        this.ws.terminate();
      }
    });
  }
}
