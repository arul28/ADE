import fs from "node:fs";
import { Buffer } from "node:buffer";
import net from "node:net";
import path from "node:path";
import { createAdeMcpRuntime } from "./bootstrap";
import { startJsonRpcServer } from "./jsonrpc";
import { createMcpRequestHandler } from "./mcpServer";
import { createStdioTransport } from "./transport";

process.env.ADE_STDIO_TRANSPORT ??= "1";

function resolveProjectRoot(): string {
  const fromEnv = process.env.ADE_PROJECT_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--project-root") {
      const next = args[i + 1];
      if (next?.trim()) return path.resolve(next.trim());
    }
  }

  return process.cwd();
}

type ProxyIdentity = {
  missionId: string | null;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  role: string | null;
};

type ParsedInboundMessage = {
  transport: "jsonl" | "framed";
  payloadText: string;
  raw: Buffer;
  rest: Buffer;
};

function asTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function resolveProxyIdentityFromEnv(): ProxyIdentity {
  return {
    missionId: asTrimmed(process.env.ADE_MISSION_ID),
    runId: asTrimmed(process.env.ADE_RUN_ID),
    stepId: asTrimmed(process.env.ADE_STEP_ID),
    attemptId: asTrimmed(process.env.ADE_ATTEMPT_ID),
    role: asTrimmed(process.env.ADE_DEFAULT_ROLE),
  };
}

function hasProxyIdentity(identity: ProxyIdentity): boolean {
  return Boolean(identity.missionId || identity.runId || identity.stepId || identity.attemptId || identity.role);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findHeaderBoundary(buffer: Buffer): { index: number; delimiterLength: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n", 0, "utf8");
  const lf = buffer.indexOf("\n\n", 0, "utf8");
  if (crlf === -1 && lf === -1) return null;
  if (crlf === -1) return { index: lf, delimiterLength: 2 };
  if (lf === -1) return { index: crlf, delimiterLength: 4 };
  return crlf < lf ? { index: crlf, delimiterLength: 4 } : { index: lf, delimiterLength: 2 };
}

function parseContentLength(headerBlock: string): number | null {
  const lines = headerBlock.split(/\r?\n/);
  for (const line of lines) {
    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line.trim());
    if (!match) continue;
    return Number.parseInt(match[1] ?? "", 10);
  }
  return null;
}

function takeNextInboundMessage(buffer: Buffer): ParsedInboundMessage | null {
  if (!buffer.length) return null;
  const first = buffer[0]!;

  if (first === 0x7b || first === 0x5b) {
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) return null;
    const raw = buffer.subarray(0, newline + 1);
    const payloadText = buffer.subarray(0, newline).toString("utf8").trim();
    return {
      transport: "jsonl",
      payloadText,
      raw,
      rest: buffer.subarray(newline + 1),
    };
  }

  const boundary = findHeaderBoundary(buffer);
  if (!boundary) return null;
  const headerBlock = buffer.subarray(0, boundary.index).toString("utf8");
  const contentLength = parseContentLength(headerBlock);
  if (contentLength == null || contentLength < 0) {
    return null;
  }
  const bodyStart = boundary.index + boundary.delimiterLength;
  const bodyEnd = bodyStart + contentLength;
  if (buffer.length < bodyEnd) return null;
  const raw = buffer.subarray(0, bodyEnd);
  const payloadText = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
  return {
    transport: "framed",
    payloadText,
    raw,
    rest: buffer.subarray(bodyEnd),
  };
}

function injectIdentityIntoInitializePayload(payloadText: string, identity: ProxyIdentity): string {
  if (!hasProxyIdentity(identity)) return payloadText;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return payloadText;
  }
  if (!isRecord(payload) || payload.method !== "initialize") {
    return payloadText;
  }

  const params = isRecord(payload.params) ? { ...payload.params } : {};
  const existingIdentity = isRecord(params.identity) ? { ...params.identity } : {};
  const mergedIdentity: Record<string, unknown> = {
    ...existingIdentity,
  };

  if ((!isRecord(existingIdentity) || typeof existingIdentity.missionId !== "string" || !existingIdentity.missionId.trim()) && identity.missionId) {
    mergedIdentity.missionId = identity.missionId;
  }
  if ((!isRecord(existingIdentity) || typeof existingIdentity.runId !== "string" || !existingIdentity.runId.trim()) && identity.runId) {
    mergedIdentity.runId = identity.runId;
  }
  if ((!isRecord(existingIdentity) || typeof existingIdentity.stepId !== "string" || !existingIdentity.stepId.trim()) && identity.stepId) {
    mergedIdentity.stepId = identity.stepId;
  }
  if ((!isRecord(existingIdentity) || typeof existingIdentity.attemptId !== "string" || !existingIdentity.attemptId.trim()) && identity.attemptId) {
    mergedIdentity.attemptId = identity.attemptId;
  }
  if ((!isRecord(existingIdentity) || typeof existingIdentity.role !== "string" || !existingIdentity.role.trim()) && identity.role) {
    mergedIdentity.role = identity.role;
  }

  params.identity = mergedIdentity;
  const nextPayload = {
    ...payload,
    params,
  };
  return JSON.stringify(nextPayload);
}

function relayProxyInputWithIdentity(socket: net.Socket): void {
  const identity = resolveProxyIdentityFromEnv();
  if (!hasProxyIdentity(identity)) {
    process.stdin.pipe(socket);
    process.stdin.on("end", () => {
      socket.end();
      process.exit(0);
    });
    return;
  }

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    while (true) {
      const parsed = takeNextInboundMessage(pending);
      if (!parsed) break;
      pending = parsed.rest;
      const payloadText = injectIdentityIntoInitializePayload(parsed.payloadText, identity);
      if (payloadText === parsed.payloadText) {
        socket.write(parsed.raw);
        continue;
      }
      if (parsed.transport === "jsonl") {
        socket.write(`${payloadText}\n`);
        continue;
      }
      const framed = `Content-Length: ${Buffer.byteLength(payloadText, "utf8")}\r\n\r\n${payloadText}`;
      socket.write(framed);
    }
  });
  process.stdin.on("end", () => {
    if (pending.length > 0) {
      socket.write(pending);
      pending = Buffer.alloc(0);
    }
    socket.end();
    process.exit(0);
  });
}

async function startHeadless(projectRoot: string): Promise<void> {
  process.stderr.write("[ade-mcp] Starting in headless mode\n");
  const runtime = await createAdeMcpRuntime(projectRoot);
  const version = "0.1.0";
  const handler = createMcpRequestHandler({ runtime, serverVersion: version });
  const transport = createStdioTransport();
  const stop = startJsonRpcServer(handler, transport);

  const shutdown = () => {
    try { stop(); } catch {}
    try { runtime.dispose(); } catch {}
  };

  process.on("SIGINT", () => { shutdown(); process.exit(0); });
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });
  process.on("exit", () => { shutdown(); });
}

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const socketPath = path.join(projectRoot, ".ade", "mcp.sock");

  if (fs.existsSync(socketPath)) {
    // Desktop is running — proxy mode: relay stdio <-> socket
    const socket = net.createConnection(socketPath);

    socket.on("error", (err) => {
      // Socket file exists but desktop isn't listening — fall back to headless
      process.stderr.write(`[ade-mcp] Socket connect failed, falling back to headless: ${err.message}\n`);
      void startHeadless(projectRoot);
    });

    socket.on("connect", () => {
      process.stderr.write("[ade-mcp] Connected to desktop app (proxy mode)\n");
      relayProxyInputWithIdentity(socket);
      socket.pipe(process.stdout);

      socket.on("close", () => process.exit(0));
    });
  } else {
    // No desktop running — headless mode
    await startHeadless(projectRoot);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
