export type JsonRpcId = string | number | null;

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

type ParserOutput = {
  messages: JsonRpcMessage[];
  parseErrors: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asJsonRpcMessage(value: unknown): JsonRpcMessage | null {
  if (!isObject(value)) return null;
  if (typeof value.method === "string") {
    if ("id" in value) {
      return {
        jsonrpc: value.jsonrpc === "2.0" ? "2.0" : undefined,
        id: (value.id ?? null) as JsonRpcId,
        method: value.method,
        params: value.params
      };
    }
    return {
      jsonrpc: value.jsonrpc === "2.0" ? "2.0" : undefined,
      method: value.method,
      params: value.params
    };
  }
  if ("id" in value && ("result" in value || "error" in value)) {
    const errorRaw = value.error;
    const error =
      isObject(errorRaw) && typeof errorRaw.code === "number" && typeof errorRaw.message === "string"
        ? {
            code: errorRaw.code,
            message: errorRaw.message,
            data: errorRaw.data
          }
        : undefined;
    return {
      jsonrpc: value.jsonrpc === "2.0" ? "2.0" : undefined,
      id: (value.id ?? null) as JsonRpcId,
      result: value.result,
      error
    };
  }
  return null;
}

export class JsonRpcLineParser {
  private buffer = "";

  push(chunk: Buffer | string): ParserOutput {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    return this.consumeAvailableLines();
  }

  flush(): ParserOutput {
    const trailing = this.buffer.trim();
    if (!trailing.length) {
      this.buffer = "";
      return { messages: [], parseErrors: [] };
    }

    this.buffer = "";
    try {
      const parsed = JSON.parse(trailing);
      const message = asJsonRpcMessage(parsed);
      if (!message) {
        return {
          messages: [],
          parseErrors: ["Trailing JSON was not a valid JSON-RPC message"]
        };
      }
      return { messages: [message], parseErrors: [] };
    } catch (error) {
      return {
        messages: [],
        parseErrors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  private consumeAvailableLines(): ParserOutput {
    const messages: JsonRpcMessage[] = [];
    const parseErrors: string[] = [];

    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const raw = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!raw.length) continue;

      try {
        const parsed = JSON.parse(raw);
        const message = asJsonRpcMessage(parsed);
        if (!message) {
          parseErrors.push("Parsed JSON line was not a valid JSON-RPC message");
          continue;
        }
        messages.push(message);
      } catch (error) {
        parseErrors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return { messages, parseErrors };
  }
}

export function encodeJsonRpcLine(message: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
}
