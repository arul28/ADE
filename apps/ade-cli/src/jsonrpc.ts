import { Buffer } from "node:buffer";

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

function toErrorResponse(id: JsonRpcId, error: unknown): JsonRpcFailure {
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

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: JsonRpcErrorCode.internalError,
      message: error instanceof Error ? error.message : String(error)
    }
  };
}

function isValidRequest(payload: unknown): payload is JsonRpcRequest {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload);
}

async function handleSingleMessage(
  message: unknown,
  handler: JsonRpcHandler
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
    await handler(request);
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
    return toErrorResponse(id, error);
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
}): Promise<void> {
  const { payloadText, handler, transport, writeFn } = args;
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
      await Promise.all(parsed.map((entry) => handleSingleMessage(entry, handler)))
    ).filter((entry): entry is JsonRpcResponse => entry != null);

    if (results.length) {
      writeMessage(results, transport, writeFn);
    }
    return;
  }

  const response = await handleSingleMessage(parsed, handler);
  if (response) {
    writeMessage(response, transport, writeFn);
  }
}

const MAX_BUFFER_BYTES = 64 * 1024 * 1024; // 64 MB
const MAX_BATCH_SIZE = 100;

export type JsonRpcServerHandle = (() => void) & {
  notify: (method: string, params?: unknown) => void;
};

export interface JsonRpcServerOptions {
  /** When true, oversized buffers close the connection instead of calling process.exit(1). */
  nonFatal?: boolean;
}

export function startJsonRpcServer(handler: JsonRpcHandler, transport: JsonRpcTransport, options?: JsonRpcServerOptions): JsonRpcServerHandle {
  const writeFn = transport.write.bind(transport);
  let buffer: Buffer = Buffer.alloc(0);
  let stopped = false;
  let draining = false;
  let responseTransport: TransportMode | null = null;

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

        await dispatchPayload({
          payloadText: parsed.payloadText,
          handler,
          transport: responseTransport ?? "framed",
          writeFn
        });
      }
    } finally {
      draining = false;
      if (!stopped && buffer.length) {
        void drain();
      }
    }
  };

  const onData = (chunk: Buffer | string): void => {
    if (stopped) return;

    const part: Buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    buffer = buffer.length ? (Buffer.concat([buffer, part]) as Buffer) : part;

    if (buffer.length > MAX_BUFFER_BYTES) {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JsonRpcErrorCode.parseError,
          message: `Input buffer exceeded maximum size of ${MAX_BUFFER_BYTES} bytes`
        }
      }, responseTransport ?? "framed", writeFn);
      stopped = true;
      transport.close();
      if (!options?.nonFatal) {
        process.nextTick(() => process.exit(1));
      }
      return;
    }

    void drain();
  };

  transport.onData(onData);

  const stop = (() => {
    stopped = true;
    transport.close();
  }) as JsonRpcServerHandle;

  stop.notify = (method: string, params?: unknown): void => {
    if (stopped) return;
    writeMessage({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    }, responseTransport ?? "framed", writeFn);
  };

  return stop;
}
