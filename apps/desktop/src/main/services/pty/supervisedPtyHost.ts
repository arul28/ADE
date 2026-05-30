import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IPty, IWindowsPtyForkOptions } from "node-pty";
import type * as ptyNs from "node-pty";
import type { Logger } from "../logging/logger";

type SpawnRequest = {
  type: "spawn";
  requestId: string;
  ptyId: string;
  command: string;
  args: string[] | string;
  options: IWindowsPtyForkOptions;
};

type ChildRequest =
  | SpawnRequest
  | { type: "write"; ptyId: string; data: string }
  | { type: "resize"; ptyId: string; cols: number; rows: number }
  | { type: "kill"; ptyId: string; signal?: string }
  | { type: "dispose"; ptyId: string };

type HostErrorPayload = {
  message?: string;
  stack?: string;
  code?: string;
};

type HostMessage =
  | {
      type: "spawned";
      requestId: string;
      ptyId: string;
      pid: number | null;
      process: string;
      cols: number;
      rows: number;
    }
  | { type: "spawnError"; requestId: string; ptyId: string; error?: HostErrorPayload }
  | { type: "data"; ptyId: string; data: string }
  | { type: "exit"; ptyId: string; exitCode: number | null; signal?: number | string | null }
  | { type: "operationError"; ptyId: string; operation: string; error?: HostErrorPayload }
  | { type: "fatal"; error?: HostErrorPayload };

type PendingSpawn = {
  ptyId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: void) => void;
  reject: (error: Error) => void;
};

type QueuedRequest = Exclude<ChildRequest, SpawnRequest>;

type HostChildState = {
  child: ChildProcess;
  ptyIds: Set<string>;
  stdoutTail: string;
  stderrTail: string;
  ipcSendQueue: ChildRequest[];
  ipcDrainListenerAttached: boolean;
};

const HOST_KILL_GRACE_MS = 3_000;
const HOST_SIGKILL_GRACE_MS = 500;
const HOST_SPAWN_TIMEOUT_MS = 15_000;

export type HostedPty = IPty & {
  __adePtyHostReady: Promise<void>;
  __adePtyHostId: string;
};

function hostErrorToError(prefix: string, payload?: HostErrorPayload): Error {
  const message = payload?.message?.trim() || "Unknown error";
  const error = new Error(`${prefix}: ${message}`);
  if (payload?.stack) error.stack = payload.stack;
  if (payload?.code) {
    (error as NodeJS.ErrnoException).code = payload.code;
  }
  return error;
}

function resolvePtyHostWorkerPath(): string {
  const candidates = [
    path.join(__dirname, "ptyHostWorker.cjs"),
    path.join(process.cwd(), "dist", "main", "ptyHostWorker.cjs"),
    path.join(process.cwd(), "dist", "ptyHostWorker.cjs"),
    path.join(process.cwd(), "apps", "desktop", "dist", "main", "ptyHostWorker.cjs"),
    path.join(process.cwd(), "apps", "ade-cli", "dist", "ptyHostWorker.cjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

function trimWorkerLogLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 2_000 ? `${collapsed.slice(0, 2_000)}...` : collapsed;
}

function appendWorkerLogTail(previous: string, chunk: unknown): string {
  const next = `${previous}${String(chunk)}`;
  return next.length > 8_000 ? next.slice(-8_000) : next;
}

class RemotePty implements HostedPty {
  private readonly emitter = new EventEmitter();
  private readonly pendingRequests: QueuedRequest[] = [];
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readySettled = false;
  private spawned = false;
  private exited = false;

  readonly __adePtyHostReady: Promise<void>;
  readonly __adePtyHostId: string;
  handleFlowControl = false;
  pid = 0;
  cols: number;
  rows: number;
  process = "";

  constructor(
    private readonly host: SupervisedPtyHost,
    ptyId: string,
    cols: number,
    rows: number,
  ) {
    this.__adePtyHostId = ptyId;
    this.cols = cols;
    this.rows = rows;
    this.__adePtyHostReady = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  markSpawned(args: { pid: number | null; process: string; cols: number; rows: number }): void {
    this.spawned = true;
    this.pid = args.pid ?? 0;
    this.process = args.process;
    this.cols = args.cols;
    this.rows = args.rows;
    this.resolveReady();
    this.flushPending();
  }

  markSpawnFailed(error: Error): void {
    this.rejectReady(error);
    this.markHostExited(1);
  }

  emitData(data: string): void {
    if (this.exited) return;
    this.emitter.emit("data", data);
  }

  emitExit(exitCode: number | null, signal?: number | string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveReady();
    this.emitter.emit("exit", { exitCode: exitCode ?? 1, signal: signal ?? undefined });
    this.emitter.removeAllListeners();
  }

  markHostExited(exitCode: number | null): void {
    this.pendingRequests.length = 0;
    if (!this.readySettled) {
      this.rejectReady(new Error("PTY host exited before terminal spawn completed."));
    }
    this.emitExit(exitCode, null);
  }

  onData(callback: (data: string) => void): { dispose: () => void } {
    this.emitter.on("data", callback);
    return { dispose: () => this.emitter.removeListener("data", callback) };
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.emitter.on("exit", callback);
    return { dispose: () => this.emitter.removeListener("exit", callback) };
  }

  write(data: string): void {
    if (this.exited) return;
    this.sendOrQueue({ type: "write", ptyId: this.__adePtyHostId, data });
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.cols = cols;
    this.rows = rows;
    this.sendOrQueue({ type: "resize", ptyId: this.__adePtyHostId, cols, rows });
  }

  kill(signal?: string): void {
    if (this.exited) return;
    this.sendOrQueue({ type: "kill", ptyId: this.__adePtyHostId, ...(signal ? { signal } : {}) });
  }

  pause(): void {
    // node-pty exposes flow-control hooks, but ADE does not use them.
  }

  resume(): void {
    // node-pty exposes flow-control hooks, but ADE does not use them.
  }

  clear(): void {
    // Keep the proxy API shape compatible with node-pty.
  }

  disposeFromParent(): void {
    if (this.exited) return;
    if (!this.spawned) {
      this.markSpawnFailed(new Error("PTY host disposed before terminal spawn completed."));
      return;
    }
    this.sendOrQueue({ type: "dispose", ptyId: this.__adePtyHostId });
    this.emitExit(0, null);
  }

  private sendOrQueue(request: QueuedRequest): void {
    if (!this.readySettled) {
      this.pendingRequests.push(request);
      return;
    }
    this.host.send(request);
  }

  private flushPending(): void {
    const pending = this.pendingRequests.splice(0);
    for (const request of pending) {
      this.host.send(request);
    }
  }

  private resolveReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyResolve();
  }

  private rejectReady(error: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyReject(error);
  }
}

class SupervisedPtyHost {
  private readonly ptys = new Map<string, RemotePty>();
  private readonly pendingSpawns = new Map<string, PendingSpawn>();
  private readonly childrenByPty = new Map<string, HostChildState>();
  private readonly killTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly workerPath = resolvePtyHostWorkerPath();
  private restartCount = 0;

  constructor(private readonly logger: Logger) {}

  spawn(command: string, args: string[] | string, options: IWindowsPtyForkOptions): IPty {
    const ptyId = randomUUID();
    const remote = new RemotePty(this, ptyId, options.cols ?? 80, options.rows ?? 24);
    this.ptys.set(ptyId, remote);
    remote.__adePtyHostReady.catch(() => {
      this.ptys.delete(ptyId);
    });
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      const pending = this.takePendingSpawn(requestId);
      if (!pending) return;
      const error = new Error("PTY host spawn timed out.");
      this.logger.warn("pty.host_spawn_timeout", { ptyId });
      this.ptys.delete(ptyId);
      this.detachPtyFromChild(ptyId, "SIGKILL");
      pending.reject(error);
    }, HOST_SPAWN_TIMEOUT_MS);
    timer.unref?.();
    this.pendingSpawns.set(requestId, {
      ptyId,
      timer,
      resolve: () => {},
      reject: (error) => remote.markSpawnFailed(error),
    });
    const childState = this.startChildForPty(ptyId);
    this.sendToChild(childState, {
      type: "spawn",
      requestId,
      ptyId,
      command,
      args,
      options,
    });
    return remote;
  }

  send(request: ChildRequest): void {
    if (request.type === "spawn") {
      const childState = this.childrenByPty.get(request.ptyId) ?? this.startChildForPty(request.ptyId);
      this.sendToChild(childState, request);
      return;
    }
    const childState = this.childrenByPty.get(request.ptyId);
    if (!childState || childState.child.killed || !childState.child.connected) {
      this.logger.warn("pty.host_missing_for_request", {
        type: request.type,
        ptyId: request.ptyId,
      });
      this.ptys.get(request.ptyId)?.markHostExited(1);
      this.ptys.delete(request.ptyId);
      this.childrenByPty.delete(request.ptyId);
      return;
    }
    this.sendToChild(childState, request);
    if (request.type === "kill" || request.type === "dispose") {
      this.scheduleForcedDetach(request.ptyId, request.type === "kill" ? request.signal : "SIGTERM");
    }
  }

  private ensureChildDrainListener(childState: HostChildState): void {
    if (childState.ipcDrainListenerAttached) return;
    childState.ipcDrainListenerAttached = true;
    childState.child.on("drain", () => {
      this.flushChildSendQueue(childState);
    });
  }

  private flushChildSendQueue(childState: HostChildState): void {
    while (childState.ipcSendQueue.length > 0) {
      const request = childState.ipcSendQueue[0]!;
      if (!this.trySendToChild(childState, request)) {
        return;
      }
      childState.ipcSendQueue.shift();
    }
  }

  private trySendToChild(childState: HostChildState, request: ChildRequest): boolean {
    try {
      const accepted = childState.child.send(request, (error) => {
        if (!error) return;
        this.logger.warn("pty.host_ipc_send_failed", {
          type: request.type,
          ptyId: "ptyId" in request ? request.ptyId : null,
          error: error instanceof Error ? error.message : String(error),
        });
        this.handleSendFailure(request, error instanceof Error ? error : new Error(String(error)));
      });
      if (!accepted) {
        this.logger.debug("pty.host_ipc_backpressure", {
          type: request.type,
          ptyId: "ptyId" in request ? request.ptyId : null,
          queuedDepth: childState.ipcSendQueue.length,
        });
      }
      return accepted;
    } catch (error) {
      this.logger.warn("pty.host_ipc_send_failed", {
        type: request.type,
        ptyId: "ptyId" in request ? request.ptyId : null,
        error: error instanceof Error ? error.message : String(error),
      });
      this.handleSendFailure(request, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private sendToChild(childState: HostChildState, request: ChildRequest): void {
    if (this.trySendToChild(childState, request)) {
      return;
    }
    childState.ipcSendQueue.push(request);
    this.ensureChildDrainListener(childState);
  }

  private handleSendFailure(request: ChildRequest, error: Error): void {
    if (request.type === "spawn") {
      const pending = this.takePendingSpawn(request.requestId);
      this.ptys.delete(request.ptyId);
      this.detachPtyFromChild(request.ptyId, "SIGTERM");
      pending?.reject(error);
      return;
    }
    const remote = this.ptys.get(request.ptyId);
    this.ptys.delete(request.ptyId);
    this.detachPtyFromChild(request.ptyId, "SIGTERM");
    remote?.markHostExited(1);
  }

  disposeAll(): void {
    for (const [requestId, pending] of [...this.pendingSpawns.entries()]) {
      const settled = this.takePendingSpawn(requestId);
      settled?.reject(new Error("PTY host disposed before terminal spawn completed."));
      this.ptys.delete(pending.ptyId);
    }
    for (const remote of this.ptys.values()) {
      try {
        remote.disposeFromParent();
      } catch {
        // The host may already be gone during project/runtime teardown.
      }
    }
    this.ptys.clear();
    this.pendingSpawns.clear();
    for (const timer of this.killTimers.values()) {
      clearTimeout(timer);
    }
    this.killTimers.clear();
    const childStates = new Set(this.childrenByPty.values());
    this.childrenByPty.clear();
    for (const childState of childStates) {
      this.stopChild(childState, "SIGTERM");
    }
  }

  private startChildForPty(ptyId: string): HostChildState {
    const child = fork(this.workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [],
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ADE_PTY_HOST: "1",
      },
    });
    const childState: HostChildState = {
      child,
      ptyIds: new Set([ptyId]),
      stdoutTail: "",
      stderrTail: "",
      ipcSendQueue: [],
      ipcDrainListenerAttached: false,
    };
    this.childrenByPty.set(ptyId, childState);
    this.restartCount += 1;
    this.logger.info("pty.host_started", {
      workerPath: this.workerPath,
      restartCount: this.restartCount,
      ptyId,
    });

    child.stdout?.on("data", (chunk) => {
      childState.stdoutTail = appendWorkerLogTail(childState.stdoutTail, chunk);
      const lines = childState.stdoutTail.split(/\r?\n/u);
      childState.stdoutTail = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = trimWorkerLogLine(line);
        if (trimmed) this.logger.debug("pty.host_stdout", { line: trimmed });
      }
    });
    child.stderr?.on("data", (chunk) => {
      childState.stderrTail = appendWorkerLogTail(childState.stderrTail, chunk);
      const lines = childState.stderrTail.split(/\r?\n/u);
      childState.stderrTail = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = trimWorkerLogLine(line);
        if (trimmed) this.logger.warn("pty.host_stderr", { line: trimmed });
      }
    });
    child.on("message", (message) => {
      try {
        this.handleMessage(childState, message as HostMessage);
      } catch (error) {
        this.logger.warn("pty.host_message_handler_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    child.once("exit", (code, signal) => this.handleExit(childState, code, signal));
    child.once("error", (error) => {
      this.logger.warn("pty.host_process_error", {
        ptyIds: [...childState.ptyIds],
        error: error instanceof Error ? error.message : String(error),
      });
      for (const pending of [...this.pendingSpawns.entries()]) {
        const [requestId, spawn] = pending;
        if (!childState.ptyIds.has(spawn.ptyId)) continue;
        this.takePendingSpawn(requestId)?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return childState;
  }

  private handleMessage(childState: HostChildState, message: HostMessage): void {
    if (!message || typeof message !== "object") return;
    if (message.type === "spawned") {
      const pending = this.takePendingSpawn(message.requestId);
      const remote = this.ptys.get(message.ptyId);
      remote?.markSpawned({
        pid: message.pid,
        process: message.process,
        cols: message.cols,
        rows: message.rows,
      });
      pending?.resolve();
      return;
    }
    if (message.type === "spawnError") {
      const pending = this.takePendingSpawn(message.requestId);
      const error = hostErrorToError("PTY host spawn failed", message.error);
      this.ptys.delete(message.ptyId);
      this.clearKillTimer(message.ptyId);
      childState.ptyIds.delete(message.ptyId);
      this.childrenByPty.delete(message.ptyId);
      if (childState.ptyIds.size === 0) this.stopChild(childState, "SIGTERM");
      pending?.reject(error);
      return;
    }
    if (message.type === "data") {
      this.ptys.get(message.ptyId)?.emitData(message.data);
      return;
    }
    if (message.type === "exit") {
      const remote = this.ptys.get(message.ptyId);
      this.ptys.delete(message.ptyId);
      this.clearKillTimer(message.ptyId);
      childState.ptyIds.delete(message.ptyId);
      this.childrenByPty.delete(message.ptyId);
      remote?.emitExit(message.exitCode, message.signal);
      if (childState.ptyIds.size === 0) this.stopChild(childState, "SIGTERM");
      return;
    }
    if (message.type === "operationError") {
      this.logger.warn("pty.host_operation_failed", {
        ptyId: message.ptyId,
        operation: message.operation,
        error: message.error?.message ?? "Unknown error",
        code: message.error?.code ?? null,
      });
      return;
    }
    if (message.type === "fatal") {
      this.logger.error("pty.host_fatal", {
        error: message.error?.message ?? "Unknown error",
        code: message.error?.code ?? null,
      });
    }
  }

  private handleExit(childState: HostChildState, code: number | null, signal: NodeJS.Signals | null): void {
    this.logger.warn("pty.host_exited", {
      code,
      signal,
      activePtys: childState.ptyIds.size,
      ptyIds: [...childState.ptyIds],
      pendingSpawns: [...this.pendingSpawns.values()].filter((pending) => childState.ptyIds.has(pending.ptyId)).length,
    });
    const exitCode = code ?? (signal ? 1 : null);
    for (const ptyId of [...childState.ptyIds]) {
      this.childrenByPty.delete(ptyId);
      this.clearKillTimer(ptyId);
      const remote = this.ptys.get(ptyId);
      this.ptys.delete(ptyId);
      remote?.markHostExited(exitCode);
    }
    childState.ptyIds.clear();
    childState.ipcSendQueue.length = 0;
    for (const [requestId, pending] of [...this.pendingSpawns.entries()]) {
      if (this.childrenByPty.has(pending.ptyId)) continue;
      this.takePendingSpawn(requestId)?.reject(new Error("PTY host exited before spawn completed."));
    }
    childState.child.removeAllListeners();
  }

  private stopChild(childState: HostChildState, signal: NodeJS.Signals): void {
    try {
      if (!childState.child.killed) {
        childState.child.kill(signal);
      }
    } catch {
      // ignore best-effort host teardown
    }
  }

  private detachPtyFromChild(ptyId: string, signal: NodeJS.Signals): void {
    const childState = this.childrenByPty.get(ptyId);
    this.clearKillTimer(ptyId);
    if (!childState) return;
    childState.ptyIds.delete(ptyId);
    this.childrenByPty.delete(ptyId);
    if (childState.ptyIds.size === 0) this.stopChild(childState, signal);
  }

  private scheduleForcedDetach(ptyId: string, signal?: string): void {
    this.clearKillTimer(ptyId);
    const timer = setTimeout(() => {
      const childState = this.childrenByPty.get(ptyId);
      if (!childState) return;
      this.logger.warn("pty.host_kill_timeout", {
        ptyId,
        signal: signal ?? null,
      });
      const remote = this.ptys.get(ptyId);
      this.ptys.delete(ptyId);
      this.detachPtyFromChild(ptyId, "SIGKILL");
      remote?.markHostExited(1);
    }, signal === "SIGKILL" ? HOST_SIGKILL_GRACE_MS : HOST_KILL_GRACE_MS);
    timer.unref?.();
    this.killTimers.set(ptyId, timer);
  }

  private clearKillTimer(ptyId: string): void {
    const timer = this.killTimers.get(ptyId);
    if (!timer) return;
    clearTimeout(timer);
    this.killTimers.delete(ptyId);
  }

  private takePendingSpawn(requestId: string): PendingSpawn | null {
    const pending = this.pendingSpawns.get(requestId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pendingSpawns.delete(requestId);
    return pending;
  }
}

export function createSupervisedPtyLoader(args: { logger: Logger }): (() => typeof ptyNs) & { dispose: () => void } {
  const host = new SupervisedPtyHost(args.logger);
  const loader = (() => ({
    spawn: host.spawn.bind(host),
  })) as (() => typeof ptyNs) & { dispose: () => void };
  loader.dispose = () => host.disposeAll();
  return loader;
}
