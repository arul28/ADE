import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  encodeCodedErrorMessage,
  isErrnoLikeCode,
  parseCodedErrorMessage,
  stripElectronErrorWrapper,
  UNKNOWN_SYSTEM_ERRNO_PATTERN,
} from "../../desktop/src/shared/codedError";

export type JsonRpcId = string | number | null;

export type JsonRpcTransport = {
  onData(callback: (chunk: Buffer) => void): void;
  write(data: string): void;
  close(): void;
};

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcHandler = (request: JsonRpcRequest) => Promise<unknown | null>;

export const JsonRpcErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  policyDenied: -32010,
  toolFailed: -32011
} as const;

export class JsonRpcError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

type TransportMode = "jsonl" | "framed";

export type JsonRpcServerErrorContext =
  | "notification"
  | "dispatch"
  | "write";

type JsonRpcServerErrorReporter = (
  error: unknown,
  context: JsonRpcServerErrorContext,
) => void;

/**
 * An unclassified handler failure, reported in full to the process log while
 * only `errorId` crosses the wire. Callers correlate the two.
 */
export type JsonRpcInternalErrorReport = {
  errorId: string;
  method: string;
  error: unknown;
  /** The file a filesystem failure named, when it named one. */
  path?: string;
};

export type JsonRpcInternalErrorReporter = (report: JsonRpcInternalErrorReport) => void;

function nextErrorId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Services signal known failures with a string `Error.code` (the same
 * convention the desktop's `codedError` uses). Those messages are authored for
 * people, so they may cross the boundary; everything else is an internal
 * detail — a libuv errno, a Node internal code, a stack-bearing message, a
 * path — and must not.
 *
 * The wire format itself is not this file's to invent: the desktop parses these
 * replies with `parseCodedErrorMessage`, so the same module both reads the
 * incoming error and writes the outgoing message.
 */
function readCodedErrorShape(
  error: unknown,
): { code: string; message: string; rootPath?: string } | null {
  if (!(error instanceof Error)) return null;
  const rawCode = (error as Error & { code?: unknown }).code;
  if (typeof rawCode !== "string" || !rawCode.trim()) return null;
  if (isErrnoLikeCode(rawCode)) return null;
  const parsed = parseCodedErrorMessage(error);
  const code = parsed.code ?? rawCode.trim();
  // `parseCodedErrorMessage` drops ANY leading `identifier:` from the message,
  // which is right for one this encoder already wrote ("storage_read_failed:
  // …") and wrong for a service sentence that merely begins that way — "gh:
  // not authenticated", or a Windows "C:\Users\… is not a repository" — whose
  // first word would be silently eaten before the message is re-encoded below.
  // So the strip is accepted only when the prefix WAS this error's own code.
  const body = messageBody(error, parsed.rootPath);
  return {
    code,
    message: body.startsWith(`${code}:`) ? parsed.message : body,
    ...(parsed.rootPath ? { rootPath: parsed.rootPath } : {}),
  };
}

/**
 * Everything `parseCodedErrorMessage` removes EXCEPT its leading-identifier
 * rule: the rootPath tail and the transport wrappers.
 *
 * `parsed.rootPath` is the message's own bytes after the delimiter, preserved
 * verbatim, so trimming it back off by length is exact.
 */
function messageBody(error: Error, rootPath: string | undefined): string {
  const raw = error.message;
  return stripElectronErrorWrapper(
    rootPath ? raw.slice(0, raw.length - rootPath.length - 1) : raw,
  );
}

/**
 * Whether the failure came from the runtime or the operating system rather
 * than from a service deciding something about the caller's request.
 *
 * Only these are redacted. RPC handlers throw `JsonRpcError` for protocol
 * failures and plain `Error`s carrying sentences meant for the person who
 * asked ("Project root does not exist: …"), and blanking those would turn
 * every actionable refusal into a reference number. What must never cross is
 * the other kind: an errno the platform could not even name, a filesystem
 * message quoting a path, or a runtime fault carrying a stack — the class of
 * message that produced "Unknown system error -11: … read" on a user's screen.
 */
function isInternalRuntimeError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const raw = error as Error & { code?: unknown; errno?: unknown; syscall?: unknown };
  if (typeof raw.syscall === "string" && raw.syscall.length > 0) return true;
  if (typeof raw.errno === "number") return true;
  if (isErrnoLikeCode(raw.code)) return true;
  // An errno the platform could not name reaches Node as its own `code`, not
  // only as message text: "Unknown system error -11" is the literal code on the
  // macOS File-Provider read that produced this bug. It matches no errno shape,
  // so without this the coded-error branch below reads it as a service verdict.
  if (typeof raw.code === "string" && UNKNOWN_SYSTEM_ERRNO_PATTERN.test(raw.code)) return true;
  if (UNKNOWN_SYSTEM_ERRNO_PATTERN.test(error.message)) return true;
  // Runtime faults (TypeError, RangeError, …) are always programming errors.
  return /^(?:Type|Range|Reference|Syntax|Eval|URI)Error$/.test(error.name);
}

/**
 * The file a filesystem failure was about, when it named one.
 *
 * A path is an internal detail on the wire and the one detail that makes the
 * process log actionable, so it travels only in the internal-error report — and
 * inside the reported error's own text, because the reporter renders a stack,
 * and a stack never quotes the path. The unnameable-errno message does not
 * quote it either ("Unknown system error -11, read"), which is how the log of
 * the original incident named no file at all.
 */
function annotateFailingPath(error: unknown): { error: unknown; path?: string } {
  if (!(error instanceof Error)) return { error };
  const failingPath = (error as Error & { path?: unknown }).path;
  if (typeof failingPath !== "string" || !failingPath.trim()) return { error };
  const annotated = new Error(`${error.message} (path ${failingPath})`);
  annotated.name = error.name;
  const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at\s/.test(line));
  annotated.stack = [`${annotated.name}: ${annotated.message}`, ...frames].join("\n");
  const source = error as Error & { code?: unknown; errno?: unknown; syscall?: unknown };
  return {
    error: Object.assign(annotated, {
      ...(source.code !== undefined ? { code: source.code } : {}),
      ...(source.errno !== undefined ? { errno: source.errno } : {}),
      ...(source.syscall !== undefined ? { syscall: source.syscall } : {}),
      path: failingPath,
    }),
    path: failingPath,
  };
}

function writeMessage(
  message: JsonRpcResponse | JsonRpcResponse[] | JsonRpcNotification,
  mode: TransportMode,
  writeFn: (data: string) => void,
): void {
  const payload = JSON.stringify(message);
  if (mode === "jsonl") {
    writeFn(`${payload}\n`);
    return;
  }
  const framed = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
  writeFn(framed);
}

function toErrorResponse(
  id: JsonRpcId,
  error: unknown,
  context: { method: string; onInternalError?: JsonRpcInternalErrorReporter },
): JsonRpcFailure {
  if (error instanceof JsonRpcError) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: error.code,
        message: error.message,
        ...(error.data !== undefined ? { data: error.data } : {})
      }
    };
  }

  // The runtime check runs FIRST, ahead of the coded branch. A platform error
  // whose `code` is neither an errno shape nor a Node internal one — the macOS
  // File-Provider read whose code is the sentence "Unknown system error -11" —
  // satisfies `readCodedErrorShape`, so a coded-first order forwarded the raw
  // platform message to the caller AND skipped `onInternalError` entirely: no
  // log line, no auto-diagnostics, and the errno on the user's screen.
  if (isInternalRuntimeError(error)) {
    // The message and stack go to the process log — which `ade report-issue`
    // collects — and the caller gets only the reference that finds them.
    const errorId = nextErrorId();
    const reported = annotateFailingPath(error);
    try {
      context.onInternalError?.({
        errorId,
        method: context.method,
        error: reported.error,
        ...(reported.path ? { path: reported.path } : {}),
      });
    } catch {
      // Reporting must not become a second failure path.
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: JsonRpcErrorCode.internalError,
        message: `Internal error in ${context.method} (ref ${errorId})`,
        data: { errorId },
      }
    };
  }

  // A coded failure is a verdict the service already made and worded; forward
  // the code so the caller can act on it, in the `code: message` shape the
  // desktop already parses.
  const coded = readCodedErrorShape(error);
  if (coded) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: JsonRpcErrorCode.internalError,
        message: encodeCodedErrorMessage(
          coded.code,
          coded.message,
          coded.rootPath ? { rootPath: coded.rootPath } : undefined,
        ),
        data: { code: coded.code },
      }
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: JsonRpcErrorCode.internalError,
      message: (error as Error).message,
    }
  };
}

function isValidRequest(payload: unknown): payload is JsonRpcRequest {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload);
}

async function handleSingleMessage(
  message: unknown,
  handler: JsonRpcHandler,
  onError?: JsonRpcServerErrorReporter,
  onInternalError?: JsonRpcInternalErrorReporter,
): Promise<JsonRpcResponse | null> {
  if (!isValidRequest(message)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JsonRpcErrorCode.invalidRequest,
        message: "Invalid JSON-RPC request payload"
      }
    };
  }

  const request = message;
  const id = request.id ?? null;

  if (!request.method || typeof request.method !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: JsonRpcErrorCode.invalidRequest,
        message: "JSON-RPC request is missing a string method"
      }
    };
  }

  if (request.jsonrpc != null && request.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: JsonRpcErrorCode.invalidRequest,
        message: "Unsupported JSON-RPC version"
      }
    };
  }

  if (request.id === undefined) {
    try {
      await handler(request);
    } catch (error) {
      onError?.(error, "notification");
    }
    return null;
  }

  try {
    const result = await handler(request);
    return {
      jsonrpc: "2.0",
      id,
      result: result ?? {}
    };
  } catch (error) {
    return toErrorResponse(id, error, { method: request.method, onInternalError });
  }
}

function isWhitespaceByte(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

function findHeaderBoundary(buffer: Buffer, start: number): { index: number; delimiterLength: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n", start, "utf8");
  const lf = buffer.indexOf("\n\n", start, "utf8");

  if (crlf === -1 && lf === -1) return null;
  if (crlf === -1) {
    return { index: lf, delimiterLength: 2 };
  }
  if (lf === -1) {
    return { index: crlf, delimiterLength: 4 };
  }
  if (crlf < lf) {
    return { index: crlf, delimiterLength: 4 };
  }
  return { index: lf, delimiterLength: 2 };
}

function parseContentLength(headerBlock: string): number | null {
  const lines = headerBlock.split(/\r?\n/);
  for (const line of lines) {
    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line.trim());
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

type ParsedPayload =
  | {
      kind: "payload";
      payloadText: string;
      transport: TransportMode;
      rest: Buffer;
    }
  | {
      kind: "frame_error";
      transport: TransportMode;
      response: JsonRpcFailure;
      rest: Buffer;
    };

function takeNextPayload(buffer: Buffer): ParsedPayload | null {
  if (!buffer.length) return null;

  let offset = 0;
  while (offset < buffer.length && isWhitespaceByte(buffer[offset]!)) {
    offset += 1;
  }
  if (offset >= buffer.length) {
    return null;
  }

  const first = buffer[offset]!;

  // Compatibility mode for newline-delimited local tests.
  if (first === 0x7b || first === 0x5b) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) return null;

    const payloadText = buffer.slice(offset, newline).toString("utf8").trim();
    return {
      kind: "payload",
      payloadText,
      transport: "jsonl",
      rest: buffer.slice(newline + 1)
    };
  }

  const boundary = findHeaderBoundary(buffer, offset);
  if (!boundary) return null;

  const headerBlock = buffer.slice(offset, boundary.index).toString("utf8");
  const contentLength = parseContentLength(headerBlock);
  const bodyStart = boundary.index + boundary.delimiterLength;

  if (contentLength == null) {
    return {
      kind: "frame_error",
      transport: "framed",
      response: {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JsonRpcErrorCode.parseError,
          message: "Missing Content-Length header"
        }
      },
      rest: buffer.slice(bodyStart)
    };
  }

  if (buffer.length < bodyStart + contentLength) {
    return null;
  }

  const payloadText = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
  return {
    kind: "payload",
    payloadText,
    transport: "framed",
    rest: buffer.slice(bodyStart + contentLength)
  };
}

async function dispatchPayload(args: {
  payloadText: string;
  handler: JsonRpcHandler;
  transport: TransportMode;
  writeFn: (data: string) => void;
  onError?: JsonRpcServerErrorReporter;
  onInternalError?: JsonRpcInternalErrorReporter;
}): Promise<void> {
  const { payloadText, handler, transport, writeFn, onError, onInternalError } = args;
  const trimmed = payloadText.trim();
  if (!trimmed.length) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JsonRpcErrorCode.parseError,
        message: "Failed to parse JSON input",
        data: error instanceof Error ? error.message : String(error)
      }
    }, transport, writeFn);
    return;
  }

  if (Array.isArray(parsed)) {
    if (!parsed.length) {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JsonRpcErrorCode.invalidRequest,
          message: "JSON-RPC batch requests cannot be empty"
        }
      }, transport, writeFn);
      return;
    }

    if (parsed.length > MAX_BATCH_SIZE) {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JsonRpcErrorCode.invalidRequest,
          message: `JSON-RPC batch size ${parsed.length} exceeds maximum of ${MAX_BATCH_SIZE}`
        }
      }, transport, writeFn);
      return;
    }

    const results = (
      await Promise.all(parsed.map((entry) => handleSingleMessage(entry, handler, onError, onInternalError)))
    ).filter((entry): entry is JsonRpcResponse => entry != null);

    if (results.length) {
      writeMessage(results, transport, writeFn);
    }
    return;
  }

  const response = await handleSingleMessage(parsed, handler, onError, onInternalError);
  if (response) {
    writeMessage(response, transport, writeFn);
  }
}

const MAX_BUFFER_BYTES = 64 * 1024 * 1024; // 64 MB
const MAX_BATCH_SIZE = 100;

export type JsonRpcServerHandle = (() => void) & {
  notify: (method: string, params?: unknown) => void;
  waitForIdle: () => Promise<void>;
};

export interface JsonRpcServerOptions {
  /** When true, oversized buffers close the connection instead of calling process.exit(1). */
  nonFatal?: boolean;
  /** Called for transport or notification failures that are contained by the server. */
  onError?: JsonRpcServerErrorReporter;
  /**
   * Called with the full error behind a redacted `internalError` reply. Wire it
   * to the process log: the reply carries only the matching `errorId`.
   */
  onInternalError?: JsonRpcInternalErrorReporter;
}

export function startJsonRpcServer(handler: JsonRpcHandler, transport: JsonRpcTransport, options?: JsonRpcServerOptions): JsonRpcServerHandle {
  let buffer: Buffer = Buffer.alloc(0);
  let stopped = false;
  let draining = false;
  let responseTransport: TransportMode | null = null;
  const activeDispatches = new Set<Promise<void>>();
  const idleWaiters = new Set<() => void>();
  const writeFn = (data: string): void => {
    if (stopped) return;
    transport.write(data);
  };

  const resolveIdleWaiters = (): void => {
    if (activeDispatches.size > 0) return;
    for (const resolve of idleWaiters) {
      resolve();
    }
    idleWaiters.clear();
  };

  const reportError = (error: unknown, context: JsonRpcServerErrorContext): void => {
    try {
      options?.onError?.(error, context);
    } catch {
      // Error reporters must not become a second runtime-killing error path.
    }
  };

  const closeTransport = (): void => {
    stopped = true;
    try {
      transport.close();
    } catch (error) {
      reportError(error, "write");
    }
  };

  const dispatch = (args: {
    payloadText: string;
    transport: TransportMode;
  }): void => {
    const dispatchPromise = dispatchPayload({
      payloadText: args.payloadText,
      handler,
      transport: args.transport,
      writeFn,
      onError: reportError,
      ...(options?.onInternalError ? { onInternalError: options.onInternalError } : {}),
    })
      .catch((error) => {
        reportError(error, "dispatch");
        closeTransport();
      })
      .finally(() => {
        activeDispatches.delete(dispatchPromise);
        resolveIdleWaiters();
      });
    activeDispatches.add(dispatchPromise);
  };

  const drain = async (): Promise<void> => {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped) {
        const parsed = takeNextPayload(buffer);
        if (!parsed) break;

        buffer = parsed.rest as Buffer;
        if (responseTransport == null) {
          responseTransport = parsed.transport;
        }

        if (parsed.kind === "frame_error") {
          writeMessage(parsed.response, responseTransport ?? "framed", writeFn);
          continue;
        }

        dispatch({
          payloadText: parsed.payloadText,
          transport: responseTransport ?? "framed",
        });
      }
    } catch (error) {
      reportError(error, "dispatch");
      closeTransport();
    } finally {
      draining = false;
    }
  };

  const onData = (chunk: Buffer | string): void => {
    if (stopped) return;

    const part: Buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    buffer = buffer.length ? (Buffer.concat([buffer, part]) as Buffer) : part;

    if (buffer.length > MAX_BUFFER_BYTES) {
      try {
        writeMessage({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: JsonRpcErrorCode.parseError,
            message: `Input buffer exceeded maximum size of ${MAX_BUFFER_BYTES} bytes`
          }
        }, responseTransport ?? "framed", writeFn);
      } catch (error) {
        reportError(error, "write");
      }
      closeTransport();
      if (!options?.nonFatal) {
        process.nextTick(() => process.exit(1));
      }
      return;
    }

    void drain();
  };

  transport.onData(onData);

  const stop = (() => {
    activeDispatches.clear();
    resolveIdleWaiters();
    closeTransport();
  }) as JsonRpcServerHandle;

  stop.notify = (method: string, params?: unknown): void => {
    if (stopped) return;
    try {
      writeMessage({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
      }, responseTransport ?? "framed", writeFn);
    } catch (error) {
      reportError(error, "write");
      closeTransport();
    }
  };

  stop.waitForIdle = (): Promise<void> => {
    if (activeDispatches.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      idleWaiters.add(resolve);
    });
  };

  return stop;
}
