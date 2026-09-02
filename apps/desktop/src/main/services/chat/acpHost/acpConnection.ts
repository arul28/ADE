/**
 * ACP transport: one child process, NDJSON JSON-RPC over its stdio.
 *
 * ## Why a direct child process and not a forked worker
 *
 * `droidSdkPool.ts` and `piSdkPool.ts` fork a Node worker. They do that because
 * each wraps a vendor SDK: a large ESM library with its own transport, its own
 * lifecycle, and its own crash modes. The worker gives that library a process
 * to fail in, and it keeps an ESM dependency out of the CommonJS main bundle.
 *
 * ACP has no library to isolate. It is a line-delimited JSON-RPC dialogue with
 * a process ADE already spawns. A forked worker would add a second process, a
 * second IPC hop, and a second serialization of every stream chunk, and it
 * would put the process-tree kill one level further from the code that needs
 * it. The agent process is already the isolation boundary. So this module
 * spawns the agent and speaks the protocol in the main process.
 *
 * The house rules from those two pools still apply, and this module keeps them:
 * pending requests reject on exit, stderr goes to the logger, disposal uses
 * `terminateChildProcessTree`, and the pool holds a generation counter.
 *
 * ## Windows parity
 *
 * `resolveCliSpawnInvocation` rewrites a `.cmd`, `.bat`, or `.ps1` shim into
 * the form Node will spawn after CVE-2024-27980. `windowsHide` keeps the
 * console window hidden. `terminateChildProcessTree` uses `taskkill /T /F` on
 * win32 and the process group elsewhere. Prompt text never rides the command
 * line here; it always travels over stdio.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "../../logging/logger";
import { resolveCliSpawnInvocation } from "../../shared/processExecution";
import { terminateChildProcessTree } from "../../shared/utils";
import {
  ACP_METHOD,
  ACP_PROTOCOL_VERSION,
  ACP_RPC_METHOD_NOT_FOUND,
  normalizeAcpRpcError,
  normalizeAcpRpcFrame,
  normalizeAcpRpcId,
  normalizeAcpSessionNotification,
  type AcpClientCapabilities,
  type AcpInitializeResponse,
  type AcpRpcErrorPayload,
  type AcpRpcId,
  type AcpSessionNotification,
} from "./acpProtocolTypes";
import type { AcpDialect, AcpSpawnPlan } from "./acpHostTypes";

/** Default ceiling for a single request. A prompt uses its own, much larger. */
export const ACP_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Handshake must be quick. A hung binary must not wedge a chat launch. */
export const ACP_HANDSHAKE_TIMEOUT_MS = 20_000;
/** Grace period between SIGTERM and SIGKILL on disposal. */
export const ACP_TERMINATE_GRACE_MS = 1_500;

/** A JSON-RPC error the agent returned. */
export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(method: string, payload: AcpRpcErrorPayload) {
    super(`ACP ${method} failed (${payload.code}): ${payload.message}`);
    this.name = "AcpRpcError";
    this.code = payload.code;
    this.data = payload.data;
    this.method = method;
  }

  /** True when the agent does not implement the method at all. */
  get isMethodNotFound(): boolean {
    return this.code === ACP_RPC_METHOD_NOT_FOUND;
  }
}

/** The connection went away before the request settled. */
export class AcpConnectionClosedError extends Error {
  constructor(reason: string) {
    super(`ACP connection closed: ${reason}`);
    this.name = "AcpConnectionClosedError";
  }
}

/** The request did not settle inside its deadline. */
export class AcpRequestTimeoutError extends Error {
  readonly method: string;

  constructor(method: string, timeoutMs: number) {
    super(`ACP ${method} did not answer within ${timeoutMs}ms.`);
    this.name = "AcpRequestTimeoutError";
    this.method = method;
  }
}

export type AcpReverseRequestHandler = (params: unknown) => Promise<unknown>;
export type AcpReverseRequestMatcher = (params: unknown) => boolean;

export type AcpConnectionExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Text the agent last wrote to stderr. Explains most startup failures. */
  stderrTail: string;
};

export type AcpConnection = {
  readonly pid: number | null;
  readonly spawnPlan: AcpSpawnPlan;
  /**
   * Filled by `initializeAcpConnection`. Null before the handshake completes.
   * Only that function writes it; everything else reads it for diagnostics.
   */
  initializeResult: AcpInitializeResponse | null;
  isAlive(): boolean;
  request<TResult>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<TResult>;
  notify(method: string, params?: unknown): void;
  /** Register a handler for `session/update`. Returns an unsubscribe function. */
  onSessionUpdate(handler: (notification: AcpSessionNotification) => void): () => void;
  /** Register a handler for any notification method. Returns unsubscribe. */
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  /**
   * Answer an agent-to-client request. A matcher scopes a handler to one
   * protocol object (for example, one session inside a pooled process).
   * Returns unsubscribe.
   */
  onRequest(
    method: string,
    handler: AcpReverseRequestHandler,
    options?: { matches?: AcpReverseRequestMatcher },
  ): () => void;
  onExit(handler: (exit: AcpConnectionExit) => void): () => void;
  /** Resolves when the process has actually gone. */
  waitForExit(): Promise<AcpConnectionExit>;
  dispose(reason: string): void;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
};

type ReverseRequestRegistration = {
  handler: AcpReverseRequestHandler;
  matches?: AcpReverseRequestMatcher;
};

const STDERR_TAIL_LIMIT = 4_000;

/** Split a byte stream into complete lines. Holds the partial tail. */
function createLineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.length) onLine(line);
      index = buffer.indexOf("\n");
    }
  };
}

function buildClientCapabilities(dialect: AcpDialect): AcpClientCapabilities {
  const capabilities: AcpClientCapabilities = {};
  // Honest by default. ADE does not serve the agent's file reads, so it must
  // not claim it can. An agent that believes the client owns the file system
  // will route binary reads through a text channel and corrupt them.
  if (dialect.advertiseFsCapability) {
    capabilities.fs = { readTextFile: true, writeTextFile: true };
  }
  if (dialect.advertiseTerminalCapability) capabilities.terminal = true;
  return capabilities;
}

export type CreateAcpConnectionArgs = {
  dialect: AcpDialect;
  spawnPlan: AcpSpawnPlan;
  logger?: Logger;
  /** Test seam. Replaces the real spawn with a scripted process. */
  spawnOverride?: (plan: AcpSpawnPlan) => ChildProcessWithoutNullStreams;
};

/**
 * Start the agent process and open the JSON-RPC channel.
 *
 * The returned connection is live but not yet initialized. Call
 * `initializeAcpConnection` next.
 */
export function createAcpConnection(args: CreateAcpConnectionArgs): AcpConnection {
  const { dialect, spawnPlan, logger } = args;
  const invocation = resolveCliSpawnInvocation(spawnPlan.command, spawnPlan.args);
  const child = args.spawnOverride
    ? args.spawnOverride(spawnPlan)
    : (spawn(invocation.command, invocation.args, {
        cwd: spawnPlan.cwd,
        env: spawnPlan.env,
        stdio: ["pipe", "pipe", "pipe"],
        // A process group on POSIX so the whole tree takes the signal. Windows
        // uses `taskkill /T /F` inside terminateChildProcessTree instead.
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      }) as ChildProcessWithoutNullStreams);

  const pending = new Map<AcpRpcId, PendingRequest>();
  const sessionUpdateHandlers = new Set<(notification: AcpSessionNotification) => void>();
  const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  const requestHandlers = new Map<string, Set<ReverseRequestRegistration>>();
  const exitHandlers = new Set<(exit: AcpConnectionExit) => void>();

  let nextRequestId = 1;
  let disposed = false;
  let exited: AcpConnectionExit | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let stderrTail = "";
  let initializeResult: AcpInitializeResponse | null = null;
  const exitWaiters = new Set<(exit: AcpConnectionExit) => void>();

  const logEvent = (level: "debug" | "info" | "warn" | "error", event: string, meta?: Record<string, unknown>) => {
    logger?.[level](event, { provider: dialect.providerId, pid: child.pid ?? null, ...meta });
  };

  const writeFrame = (frame: Record<string, unknown>): boolean => {
    if (exited || !child.stdin || child.stdin.destroyed) return false;
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (error) {
      logEvent("warn", "agent_chat.acp_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const settleExit = (exit: AcpConnectionExit) => {
    if (exited) return;
    exited = exit;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    const closedError = new AcpConnectionClosedError(
      `${dialect.providerId} exited (code ${exit.code ?? "none"}, signal ${exit.signal ?? "none"})`,
    );
    for (const [, waiter] of pending) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(closedError);
    }
    pending.clear();
    for (const handler of exitHandlers) {
      try {
        handler(exit);
      } catch (error) {
        logEvent("warn", "agent_chat.acp_exit_handler_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const waiter of exitWaiters) waiter(exit);
    exitWaiters.clear();
  };

  const answerReverseRequest = (id: AcpRpcId, method: string, params: unknown) => {
    const registrations = requestHandlers.get(method);
    const registration = [...(registrations ?? [])].find((candidate) => {
      if (!candidate.matches) return true;
      try {
        return candidate.matches(params);
      } catch (error) {
        logEvent("warn", "agent_chat.acp_request_matcher_failed", {
          method,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    });
    if (!registration) {
      // An unhandled agent-to-client request must be answered, or the agent
      // waits forever. Method-not-found is the honest answer, and it is what a
      // capability the client never advertised deserves.
      writeFrame({
        jsonrpc: "2.0",
        id,
        error: { code: ACP_RPC_METHOD_NOT_FOUND, message: `ADE does not implement ${method}.` },
      });
      return;
    }
    void (async () => {
      try {
        const result = await registration.handler(params);
        writeFrame({ jsonrpc: "2.0", id, result: result ?? {} });
      } catch (error) {
        writeFrame({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })();
  };

  const handleFrame = (frame: Record<string, unknown>) => {
    const id = normalizeAcpRpcId(frame.id);
    const method = typeof frame.method === "string" ? frame.method : null;

    if (method && id !== undefined && id !== null) {
      answerReverseRequest(id, method, frame.params);
      return;
    }

    if (method) {
      if (method === ACP_METHOD.sessionUpdate) {
        const notification = normalizeAcpSessionNotification(frame.params);
        if (notification) {
          for (const handler of sessionUpdateHandlers) {
            try {
              handler(notification);
            } catch (error) {
              logEvent("warn", "agent_chat.acp_session_update_handler_failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
        return;
      }
      const handlers = notificationHandlers.get(method);
      if (!handlers?.size) {
        logEvent("debug", "agent_chat.acp_unhandled_notification", { method });
        return;
      }
      for (const handler of handlers) {
        try {
          handler(frame.params);
        } catch (error) {
          logEvent("warn", "agent_chat.acp_notification_handler_failed", {
            method,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return;
    }

    if (id === undefined || id === null) {
      logEvent("debug", "agent_chat.acp_frame_without_id", {});
      return;
    }
    const waiter = pending.get(id);
    if (!waiter) {
      logEvent("debug", "agent_chat.acp_response_without_request", { id: String(id) });
      return;
    }
    pending.delete(id);
    if (waiter.timer) clearTimeout(waiter.timer);
    const errorPayload = normalizeAcpRpcError(frame.error);
    if (errorPayload) {
      waiter.reject(new AcpRpcError(waiter.method, errorPayload));
      return;
    }
    waiter.resolve(frame.result);
  };

  const readStdoutLine = createLineSplitter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      // Some CLIs print a banner or an update notice before the first frame.
      // That text is not a protocol error, so it must not kill the connection.
      logEvent("debug", "agent_chat.acp_stdout_non_protocol", { text: trimmed.slice(0, 400) });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logEvent("warn", "agent_chat.acp_stdout_unparsable", { text: trimmed.slice(0, 400) });
      return;
    }
    const frame = normalizeAcpRpcFrame(parsed);
    if (!frame) return;
    handleFrame(frame);
  });

  child.stdout?.on("data", readStdoutLine);
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stderrTail = `${stderrTail}${text}`.slice(-STDERR_TAIL_LIMIT);
    const trimmed = text.trim();
    if (trimmed.length) logEvent("warn", "agent_chat.acp_stderr", { text: trimmed.slice(0, 1_000) });
  });
  child.on("error", (error) => {
    logEvent("error", "agent_chat.acp_process_error", { error: error.message });
    settleExit({ code: null, signal: null, stderrTail: `${stderrTail}\n${error.message}`.trim() });
  });
  child.on("exit", (code, signal) => {
    logEvent("info", "agent_chat.acp_process_exit", { code, signal });
    settleExit({ code, signal, stderrTail });
  });

  const connection: AcpConnection = {
    get pid() {
      return child.pid ?? null;
    },
    spawnPlan,
    get initializeResult() {
      return initializeResult;
    },
    set initializeResult(value: AcpInitializeResponse | null) {
      initializeResult = value;
    },
    isAlive: () => !disposed && !exited,
    request: <TResult>(method: string, params?: unknown, options?: { timeoutMs?: number }) => {
      return new Promise<TResult>((resolve, reject) => {
        if (exited) {
          reject(new AcpConnectionClosedError(`${dialect.providerId} is not running`));
          return;
        }
        const id = nextRequestId++;
        const timeoutMs = options?.timeoutMs ?? ACP_DEFAULT_REQUEST_TIMEOUT_MS;
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                if (!pending.delete(id)) return;
                reject(new AcpRequestTimeoutError(method, timeoutMs));
              }, timeoutMs)
            : null;
        timer?.unref?.();
        pending.set(id, {
          method,
          resolve: (value) => resolve(value as TResult),
          reject,
          timer,
        });
        const sent = writeFrame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
        if (!sent && pending.delete(id)) {
          if (timer) clearTimeout(timer);
          reject(new AcpConnectionClosedError(`${dialect.providerId} stdin is not writable`));
        }
      });
    },
    notify: (method, params) => {
      writeFrame({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    onSessionUpdate: (handler) => {
      sessionUpdateHandlers.add(handler);
      return () => sessionUpdateHandlers.delete(handler);
    },
    onNotification: (method, handler) => {
      const handlers = notificationHandlers.get(method) ?? new Set();
      handlers.add(handler);
      notificationHandlers.set(method, handlers);
      return () => {
        handlers.delete(handler);
        if (!handlers.size) notificationHandlers.delete(method);
      };
    },
    onRequest: (method, handler, options) => {
      const registration: ReverseRequestRegistration = {
        handler,
        ...(options?.matches ? { matches: options.matches } : {}),
      };
      const registrations = requestHandlers.get(method) ?? new Set<ReverseRequestRegistration>();
      registrations.add(registration);
      requestHandlers.set(method, registrations);
      return () => {
        const current = requestHandlers.get(method);
        if (!current) return;
        current.delete(registration);
        if (!current.size) requestHandlers.delete(method);
      };
    },
    onExit: (handler) => {
      if (exited) {
        handler(exited);
        return () => undefined;
      }
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    waitForExit: () =>
      new Promise<AcpConnectionExit>((resolve) => {
        if (exited) {
          resolve(exited);
          return;
        }
        exitWaiters.add(resolve);
      }),
    dispose: (reason) => {
      if (disposed) return;
      disposed = true;
      logEvent("info", "agent_chat.acp_dispose", { reason });
      for (const [, waiter] of pending) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new AcpConnectionClosedError(reason));
      }
      pending.clear();
      try {
        child.stdin?.end();
      } catch {
        // The pipe may already be gone. The kill below still runs.
      }
      if (!exited) {
        killTimer = terminateChildProcessTree(child, null, ACP_TERMINATE_GRACE_MS);
        killTimer.unref?.();
      }
    },
  };

  return connection;
}

export type InitializeAcpConnectionResult = {
  response: AcpInitializeResponse;
  /** True when the agent answered with a protocol version this host speaks. */
  protocolVersionAccepted: boolean;
};

/**
 * Run the `initialize` handshake.
 *
 * The client capabilities come from the dialect, and they are honest: ADE
 * claims only what it actually serves.
 */
export async function initializeAcpConnection(args: {
  connection: AcpConnection;
  dialect: AcpDialect;
  timeoutMs?: number;
}): Promise<InitializeAcpConnectionResult> {
  const { connection, dialect } = args;
  const response = await connection.request<AcpInitializeResponse>(
    ACP_METHOD.initialize,
    {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: buildClientCapabilities(dialect),
      clientInfo: dialect.clientInfo,
      ...(dialect.initializeMeta ? { _meta: { ...dialect.initializeMeta } } : {}),
    },
    { timeoutMs: args.timeoutMs ?? ACP_HANDSHAKE_TIMEOUT_MS },
  );
  connection.initializeResult = response;
  return {
    response,
    protocolVersionAccepted: response.protocolVersion <= ACP_PROTOCOL_VERSION,
  };
}
