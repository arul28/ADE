import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { RemoteTargetRegistry } from "../../../desktop/src/main/services/remoteRuntime/remoteTargetRegistry";
import type {
  RemoteRuntimeTarget,
  RemoteRuntimeTargetRoute,
} from "../../../desktop/src/shared/types/remoteRuntime";

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

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RemoteRuntimeLayout = {
  channel: "alpha" | "beta" | null;
  homeDirName: string;
  homeDirExpr: string;
  binDirExpr: string;
  runtimeDirExpr: string;
  socketExpr: string;
  binaryExpr: string;
};

export type RemoteRpcAttempt = {
  target: RemoteRuntimeTarget;
  route: RemoteRuntimeTargetRoute;
  layout: RemoteRuntimeLayout;
  command: string;
  sshArgs: string[];
  label: string;
};

export type RemoteRpcSession = {
  client: ProcessJsonRpcClient;
  attempt: RemoteRpcAttempt;
};

export type RemoteBridge = {
  socketUrl: string;
  close: () => Promise<void>;
};

const REMOTE_RPC_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RPC_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 32 * 1024;

class ByteRingBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (this.maxBytes <= 0) return;
    this.chunks.push(buffer);
    this.bytes += buffer.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const overflow = this.bytes - this.maxBytes;
      if (overflow >= first.length) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.bytes -= overflow;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8").trim();
  }

  tailLines(limit = 8): string {
    return this.text().split(/\r?\n/).filter(Boolean).slice(-limit).join("\n");
  }
}

export function spawnRemoteRpcProcess(attempt: RemoteRpcAttempt): ChildProcessWithoutNullStreams {
  return spawn("ssh", attempt.sshArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export class ProcessJsonRpcClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stderrTail = new ByteRingBuffer(MAX_STDERR_TAIL_BYTES);
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer | string) => this.handleData(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail.push(chunk);
    });
    child.on("error", (error) => this.handleClosed(error));
    child.on("close", (code, signal) => {
      this.handleClosed(new Error(this.closeMessage(code, signal)));
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Remote ADE RPC connection is closed."));
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise<T>((resolve, reject) => {
      const pendingKey = String(id);
      const timer = setTimeout(() => {
        if (!this.pending.has(pendingKey)) return;
        this.handleClosed(
          new Error(`Remote ADE RPC timed out waiting for method ${method} (${REMOTE_RPC_REQUEST_TIMEOUT_MS}ms).`),
        );
        this.child.kill();
      }, REMOTE_RPC_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(pendingKey, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(pendingKey);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(pendingKey);
        reject(error);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("Remote ADE RPC connection closed."));
    this.child.stdin.end();
    this.child.kill();
  }

  private closeMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const detail = this.stderrTail.tailLines(8);
    const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    return detail
      ? `Remote ADE RPC exited with ${status}: ${detail}`
      : `Remote ADE RPC exited with ${status}.`;
  }

  private handleClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(error);
  }

  private handleData(chunk: Buffer | string): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([
      this.buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
    ]);
    if (this.buffer.length > MAX_RPC_BUFFER_BYTES) {
      this.handleClosed(new Error(`Remote ADE RPC sent an oversized partial frame (> ${MAX_RPC_BUFFER_BYTES} bytes).`));
      this.child.kill();
      return;
    }
    while (true) {
      let next: string | null;
      try {
        next = this.takeNextPayload();
      } catch (error) {
        this.handleClosed(error instanceof Error ? error : new Error(String(error)));
        this.child.kill();
        return;
      }
      if (!next) return;
      const payload = next.trim();
      if (!payload) continue;
      let parsed: JsonRpcResponse | JsonRpcResponse[] | null = null;
      try {
        parsed = JSON.parse(payload) as JsonRpcResponse | JsonRpcResponse[];
      } catch (error) {
        this.handleClosed(new Error(`Failed to parse remote ADE RPC response: ${error instanceof Error ? error.message : String(error)}`));
        this.child.kill();
        return;
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
      if (idx > MAX_RPC_BUFFER_BYTES) {
        throw new Error(`Remote ADE RPC sent an oversized JSON line (> ${MAX_RPC_BUFFER_BYTES} bytes).`);
      }
      const payload = this.buffer.subarray(0, idx).toString("utf8");
      this.buffer = this.buffer.subarray(idx + 1);
      return payload;
    }
    const probe = this.buffer.subarray(0, Math.min(this.buffer.length, "content-length".length)).toString("ascii").toLowerCase();
    if (!"content-length".startsWith(probe)) {
      throw new Error("Remote ADE RPC sent non-JSON output on stdout.");
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
      throw new Error("Remote ADE RPC sent a malformed Content-Length frame.");
    }
    const length = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(length) || length < 0 || length > MAX_RPC_BUFFER_BYTES) {
      throw new Error(`Remote ADE RPC sent an oversized Content-Length frame (${length} bytes).`);
    }
    const bodyStart = boundary.index + boundary.length;
    const bodyEnd = bodyStart + length;
    if (this.buffer.length < bodyEnd) return null;
    const payload = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    this.buffer = this.buffer.subarray(bodyEnd);
    return payload;
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (response.id == null) return;
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

export async function startRemoteBridge(args: {
  target: RemoteRuntimeTarget;
  initialAttempt?: RemoteRpcAttempt;
  openRemoteRpcSession: (target: RemoteRuntimeTarget) => Promise<RemoteRpcSession>;
}): Promise<RemoteBridge> {
  const activeSockets = new Set<net.Socket>();
  const activeChildren = new Set<ChildProcessWithoutNullStreams>();
  const bridgeDir = process.platform === "win32"
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-remote-"));
  if (bridgeDir) {
    try {
      fs.chmodSync(bridgeDir, 0o700);
    } catch {}
  }
  const bridgeSocketPath = bridgeDir ? path.join(bridgeDir, "bridge.sock") : null;
  let closing = false;

  const currentTarget = (): RemoteRuntimeTarget => {
    try {
      return new RemoteTargetRegistry().get(args.target.id) ?? args.target;
    } catch {
      return args.target;
    }
  };

  let firstBridgeAttempt: RemoteRpcAttempt | null = args.initialAttempt ?? null;
  const selectBridgeAttempt = async (): Promise<RemoteRpcAttempt> => {
    if (firstBridgeAttempt) {
      const attempt = firstBridgeAttempt;
      firstBridgeAttempt = null;
      return attempt;
    }
    const session = await args.openRemoteRpcSession(currentTarget());
    const attempt = session.attempt;
    session.client.close();
    return attempt;
  };

  const server = net.createServer((socket) => {
    activeSockets.add(socket);
    socket.pause();
    let child: ChildProcessWithoutNullStreams | null = null;
    let settled = false;
    const stderrTail = new ByteRingBuffer(MAX_STDERR_TAIL_BYTES);
    const teardown = (reason?: string): void => {
      if (settled) return;
      settled = true;
      activeSockets.delete(socket);
      if (child) activeChildren.delete(child);
      if (!closing && reason) {
        const detail = stderrTail.tailLines(8);
        process.stderr.write(
          detail
            ? `Remote ADE bridge closed: ${reason}\n${detail}\n`
            : `Remote ADE bridge closed: ${reason}\n`,
        );
      }
      socket.destroy();
      if (child) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill();
      }
    };
    socket.on("error", (error) => teardown(error.message));
    socket.on("close", () => teardown());
    void selectBridgeAttempt()
      .then((attempt) => {
        if (settled || closing) return;
        child = spawnRemoteRpcProcess(attempt);
        activeChildren.add(child);
        child.stderr.on("data", (chunk: Buffer | string) => stderrTail.push(chunk));
        child.on("error", (error) => teardown(error.message));
        child.on("close", (code, signal) => {
          const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
          teardown(`ssh child exited with ${status}`);
        });
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
        socket.resume();
      })
      .catch((error) => {
        teardown(error instanceof Error ? error.message : String(error));
      });
  });
  server.maxConnections = 1;

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    if (bridgeSocketPath) server.listen(bridgeSocketPath);
    else server.listen(0, "127.0.0.1");
  });

  let socketUrl: string;
  if (bridgeSocketPath) {
    socketUrl = bridgeSocketPath;
  } else {
    const address = server.address() as AddressInfo | null;
    if (!address) {
      throw new Error("Remote bridge did not bind a local port.");
    }
    socketUrl = `tcp://127.0.0.1:${address.port}`;
  }
  return {
    socketUrl,
    close: async () => {
      closing = true;
      for (const socket of [...activeSockets]) socket.destroy();
      for (const child of [...activeChildren]) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (bridgeSocketPath) {
        try {
          fs.unlinkSync(bridgeSocketPath);
        } catch {}
      }
      if (bridgeDir) {
        try {
          fs.rmdirSync(bridgeDir);
        } catch {}
      }
    },
  };
}
