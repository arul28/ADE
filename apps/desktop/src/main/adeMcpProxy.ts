import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Buffer } from "node:buffer";
import { resolveAdeLayout } from "../shared/adeLayout";

process.env.ADE_STDIO_TRANSPORT ??= "1";

type RuntimeRoots = {
  projectRoot: string;
  workspaceRoot: string;
};

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
  raw: Buffer<ArrayBufferLike>;
  rest: Buffer<ArrayBufferLike>;
};

function resolveCliArg(flag: string): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value !== flag) continue;
    const next = args[i + 1];
    if (next?.trim()) return path.resolve(next.trim());
  }
  return null;
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function resolveRuntimeRoots(): RuntimeRoots {
  const projectRoot = (() => {
    const fromEnv = process.env.ADE_PROJECT_ROOT?.trim();
    if (fromEnv) return path.resolve(fromEnv);
    return resolveCliArg("--project-root") ?? process.cwd();
  })();

  const workspaceRoot = (() => {
    const fromEnv = process.env.ADE_WORKSPACE_ROOT?.trim();
    if (fromEnv) return path.resolve(fromEnv);
    return resolveCliArg("--workspace-root") ?? projectRoot;
  })();

  return {
    projectRoot,
    workspaceRoot,
  };
}

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
  if (contentLength == null || contentLength < 0) return null;
  const bodyStart = boundary.index + boundary.delimiterLength;
  const bodyEnd = bodyStart + contentLength;
  if (buffer.length < bodyEnd) return null;

  return {
    transport: "framed",
    payloadText: buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
    raw: buffer.subarray(0, bodyEnd),
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
  const mergedIdentity: Record<string, unknown> = { ...existingIdentity };

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

  return JSON.stringify({
    ...payload,
    params: {
      ...params,
      identity: mergedIdentity,
    },
  });
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

async function main(): Promise<void> {
  const roots = resolveRuntimeRoots();
  const socketPath = process.env.ADE_MCP_SOCKET_PATH?.trim() || resolveAdeLayout(roots.projectRoot).socketPath;

  if (hasFlag("--probe")) {
    process.stdout.write(JSON.stringify({
      ok: true,
      mode: "bundled_proxy",
      projectRoot: roots.projectRoot,
      workspaceRoot: roots.workspaceRoot,
      socketPath,
      socketExists: fs.existsSync(socketPath),
    }));
    process.exit(0);
  }

  const socket = net.createConnection(socketPath);
  let connected = false;

  socket.on("error", (err) => {
    const prefix = connected ? "[ade-mcp-proxy]" : "[ade-mcp-proxy] Failed to connect";
    process.stderr.write(`${prefix}: ${err.message}\n`);
    process.exit(1);
  });

  socket.on("connect", () => {
    connected = true;
    process.stdin.resume();
    relayProxyInputWithIdentity(socket);
    socket.pipe(process.stdout);
  });

  socket.on("close", () => {
    process.exit(connected ? 0 : 1);
  });
}

void main().catch((error) => {
  process.stderr.write(`[ade-mcp-proxy] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
