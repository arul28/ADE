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
import { getErrorMessage, terminateChildProcessTree } from "../../shared/utils";
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
import { prepareAcpScratchDir, removeAcpScratchDir } from "./acpScratchDirs";
import { redactProcessOutput } from "../../../utils/redaction";

/** Default ceiling for a single request. A prompt uses its own, much larger. */
export const ACP_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Handshake must be quick. A hung binary must not wedge a chat launch. */
export const ACP_HANDSHAKE_TIMEOUT_MS = 20_000;
/** Grace period between SIGTERM and SIGKILL on disposal. */
export const ACP_TERMINATE_GRACE_MS = 1_500;

/**
 * The agent's own explanation, when it sends one in `data`. Qwen answers a
 * prompt it could not send upstream with a bare "Internal error" and puts
 * "Connection error." in `data.details`; without it the chat shows only the
 * generic text and nothing says the model endpoint is unreachable.
 */
function acpErrorDetailSuffix(payload: AcpRpcErrorPayload): string {
  const data = payload.data;
  const record = data && typeof data === "object" ? data as Record<string, unknown> : null;
  let raw = "";
  if (typeof data === "string") raw = data;
  else if (typeof record?.details === "string") raw = record.details;
  else if (typeof record?.message === "string") raw = record.message;
  const detail = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!detail || payload.message.includes(detail)) return "";
  return ` (${detail})`;
}

/** A JSON-RPC error the agent returned. */
export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(method: string, payload: AcpRpcErrorPayload) {
    super(`ACP ${method} failed (${payload.code}): ${payload.message}${acpErrorDetailSuffix(payload)}`);
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
  /**
   * The agent's captured stderr so far. Readable even when the connection is
   * already dead, which is the only way a handshake crash (before any exit
   * handler is registered) can still hand its diagnostics to the caller.
   */
  readStderrTail(): string;
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
  /**
   * Every complete line the agent writes outside the protocol: stderr, and
   * stdout text that is not a JSON-RPC frame. Unredacted, so a reader can
   * pick a sign-in URL out of it; never log what it receives. Returns
   * unsubscribe.
   */
  onDiagnosticLine(handler: (line: string, stream: AcpDiagnosticStream) => void): () => void;
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
/**
 * The longest unfinished stderr line kept for whole-line redaction. A longer
 * one (a progress bar redrawn with `\r`) is dropped through its next newline:
 * a fragment cut from it could hold half a secret.
 */
const STDERR_LINE_LIMIT = 16_000;

/**
 * OAuth query values and secrets never reach a log line or an error message.
 * Antigravity prints its Google sign-in URL (with `state`) on stderr; a
 * callback URL would carry the `code`; an agent that fails to start may print
 * its environment or config, API keys included.
 */
export function redactAcpDiagnosticText(text: string): string {
  return redactProcessOutput(text);
}

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

/** Which non-protocol stream a diagnostic line came from. */
export type AcpDiagnosticStream = "stderr" | "stdout";

/**
 * Start the agent process and open the JSON-RPC channel.
 *
 * The returned connection is live but not yet initialized. Call
 * `initializeAcpConnection` next.
 */
export function createAcpConnection(args: CreateAcpConnectionArgs): AcpConnection {
  const { dialect, spawnPlan, logger } = args;
  const invocation = resolveCliSpawnInvocation(spawnPlan.command, spawnPlan.args);
  // The agent's own temp directory exists before it starts and goes when it
  // exits (see acpScratchDirs.ts).
  if (spawnPlan.scratchDir) prepareAcpScratchDir(spawnPlan.scratchDir);
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
  const diagnosticLineHandlers = new Set<(line: string, stream: AcpDiagnosticStream) => void>();
  const emitDiagnosticLine = (line: string, stream: AcpDiagnosticStream) => {
    for (const handler of diagnosticLineHandlers) {
      try {
        handler(line, stream);
      } catch {
        // A diagnostic reader must never break the transport.
      }
    }
  };

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
        error: getErrorMessage(error),
      });
      return false;
    }
  };

  const settleExit = (exit: AcpConnectionExit) => {
    if (exited) return;
    exited = exit;
    if (spawnPlan.scratchDir) removeAcpScratchDir(spawnPlan.scratchDir);
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
          error: getErrorMessage(error),
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
          error: getErrorMessage(error),
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
            message: getErrorMessage(error),
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
                error: getErrorMessage(error),
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
            error: getErrorMessage(error),
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
      logEvent("debug", "agent_chat.acp_stdout_non_protocol", { text: redactAcpDiagnosticText(trimmed.slice(0, 400)) });
      emitDiagnosticLine(trimmed, "stdout");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logEvent("warn", "agent_chat.acp_stdout_unparsable", { text: redactAcpDiagnosticText(trimmed.slice(0, 400)) });
      return;
    }
    const frame = normalizeAcpRpcFrame(parsed);
    if (!frame) return;
    handleFrame(frame);
  });

  child.stdout?.on("data", readStdoutLine);
  const readStderrLine = createLineSplitter((line) => emitDiagnosticLine(line, "stderr"));
  /**
   * Stderr is redacted a whole line at a time: a secret split across two
   * chunks (`?state` then `=value`) is matched only once both halves arrive.
   * The exit reports the unfinished last line (redacted) in its tail; the log
   * gets that line once stderr closes, since stderr can still deliver its
   * rest after `exit`.
   */
  let stderrPartial = "";
  let droppingStderrLine = false;
  const appendStderr = (text: string) => {
    const safe = redactAcpDiagnosticText(text);
    stderrTail = `${stderrTail}${safe}`.slice(-STDERR_TAIL_LIMIT);
    const trimmed = safe.trim();
    if (trimmed.length) logEvent("warn", "agent_chat.acp_stderr", { text: trimmed.slice(0, 1_000) });
  };
  const flushStderrPartial = () => {
    if (stderrPartial) appendStderr(stderrPartial);
    stderrPartial = "";
  };
  const stderrTailWithPartial = () =>
    stderrPartial ? `${stderrTail}${redactAcpDiagnosticText(stderrPartial)}`.slice(-STDERR_TAIL_LIMIT) : stderrTail;
  child.stderr?.once("close", flushStderrPartial);
  child.stderr?.on("data", (chunk: Buffer | string) => {
    let text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (diagnosticLineHandlers.size) readStderrLine(chunk);
    if (droppingStderrLine) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      text = text.slice(newline + 1);
      droppingStderrLine = false;
    }
    text = `${stderrPartial}${text}`;
    const end = text.lastIndexOf("\n") + 1;
    stderrPartial = text.slice(end);
    if (end > 0) appendStderr(text.slice(0, end));
    if (stderrPartial.length > STDERR_LINE_LIMIT) {
      logEvent("warn", "agent_chat.acp_stderr_line_dropped", { length: stderrPartial.length });
      stderrPartial = "";
      droppingStderrLine = true;
    }
  });
  child.on("error", (error) => {
    logEvent("error", "agent_chat.acp_process_error", { error: error.message });
    flushStderrPartial();
    settleExit({ code: null, signal: null, stderrTail: `${stderrTail}\n${error.message}`.trim() });
  });
  child.on("exit", (code, signal) => {
    logEvent("info", "agent_chat.acp_process_exit", { code, signal });
    settleExit({ code, signal, stderrTail: stderrTailWithPartial() });
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
    readStderrTail: stderrTailWithPartial,
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
    onDiagnosticLine: (handler) => {
      diagnosticLineHandlers.add(handler);
      return () => diagnosticLineHandlers.delete(handler);
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

/**
 * Run the `initialize` handshake.
 *
 * The client capabilities come from the dialect, and they are honest: ADE
 * claims only what it actually serves.
 */
/** Error shape `initializeAcpConnection` augments with the agent's last stderr. */
export type AcpStderrCarryingError = { acpStderrTail?: string };

/**
 * Recover the stderr tail `initializeAcpConnection` attached to a handshake
 * failure. Returns `""` for any error that carries none.
 */
export function readAcpStderrTailFromError(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const tail = (error as AcpStderrCarryingError).acpStderrTail;
  return typeof tail === "string" ? tail : "";
}

export async function initializeAcpConnection(args: {
  connection: AcpConnection;
  dialect: AcpDialect;
  timeoutMs?: number;
}): Promise<AcpInitializeResponse> {
  const { connection, dialect } = args;
  try {
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
    const advertised = typeof response.protocolVersion === "number" && Number.isFinite(response.protocolVersion)
      ? response.protocolVersion
      : null;
    if (advertised === null) {
      // ACP requires the agent to name the protocol version it selected. An
      // answer without one has not established compatibility at all.
      throw new Error(
        `${dialect.displayName} answered the ACP handshake without a protocol version, so ADE cannot tell `
        + `whether it speaks ACP ${ACP_PROTOCOL_VERSION}. Update ${dialect.displayName}, or update ADE.`,
      );
    }
    if (advertised > ACP_PROTOCOL_VERSION) {
      // The agent speaks a newer protocol than this build of ADE. Continuing
      // would fail later on an unrecognized request or session update, so stop
      // at the handshake with a message that names the CLI and both ways out.
      throw new Error(
        `${dialect.displayName} answered with ACP protocol version ${advertised}, but this build of ADE speaks `
        + `version ${ACP_PROTOCOL_VERSION}. Update ADE, or update ${dialect.displayName} to a build that speaks `
        + `ACP ${ACP_PROTOCOL_VERSION}.`,
      );
    }
    connection.initializeResult = response;
    return response;
  } catch (error) {
    // A crash during the handshake precedes every exit handler, so the pool's
    // rethrow is the only chance to pass the agent's stderr to the caller.
    const tail = connection.readStderrTail();
    if (tail.trim() && error && typeof error === "object") {
      (error as AcpStderrCarryingError).acpStderrTail = tail;
    }
    throw error;
  }
}
