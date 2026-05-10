import net from "node:net";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
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
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer | string) => this.handleData(chunk));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => {
      this.closed = true;
      this.rejectAll(new Error("ADE RPC socket closed."));
    });
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

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("ADE RPC socket is closed."));
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    this.closed = true;
    this.rejectAll(new Error("ADE RPC socket closed."));
    this.socket.end();
    this.socket.destroy();
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
    this.buffer = Buffer.concat([
      this.buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
    ]);
    while (true) {
      const next = this.takeNextPayload();
      if (!next) return;
      const line = next.trim();
      if (!line) continue;
      let parsed: JsonRpcResponse | JsonRpcResponse[] | null = null;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse | JsonRpcResponse[];
      } catch {
        continue;
      }
      const responses = Array.isArray(parsed) ? parsed : [parsed];
      for (const response of responses) this.handleResponse(response);
    }
  }

  private takeNextPayload(): string | null {
    while (this.buffer.length && /\s/.test(String.fromCharCode(this.buffer[0]!))) {
      this.buffer = this.buffer.subarray(1);
    }
    if (!this.buffer.length) return null;
    const first = String.fromCharCode(this.buffer[0]!);
    if (first === "{" || first === "[") {
      const idx = this.buffer.indexOf(0x0a);
      if (idx < 0) return null;
      const payload = this.buffer.subarray(0, idx).toString("utf8");
      this.buffer = this.buffer.subarray(idx + 1);
      return payload;
    }

    const crlfBoundary = this.buffer.indexOf("\r\n\r\n");
    const lfBoundary = this.buffer.indexOf("\n\n");
    let boundary: { index: number; length: number } | null = null;
    if (crlfBoundary >= 0) boundary = { index: crlfBoundary, length: 4 };
    else if (lfBoundary >= 0) boundary = { index: lfBoundary, length: 2 };
    if (!boundary) return null;
    const header = this.buffer.subarray(0, boundary.index).toString("ascii");
    const match = /^content-length\s*:\s*(\d+)\s*$/im.exec(header);
    if (!match) {
      this.buffer = this.buffer.subarray(boundary.index + boundary.length);
      return "";
    }
    const length = Number.parseInt(match[1]!, 10);
    const bodyStart = boundary.index + boundary.length;
    const bodyEnd = bodyStart + length;
    if (this.buffer.length < bodyEnd) return null;
    const payload = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    this.buffer = this.buffer.subarray(bodyEnd);
    return payload;
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (typeof response.id !== "number") {
      if (typeof response.method === "string") {
        for (const handler of this.notificationHandlers.get(response.method) ?? []) {
          handler(response.params);
        }
      }
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }
    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
