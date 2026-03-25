import type { Buffer } from "node:buffer";

export type ProxyIdentity = {
  missionId: string | null;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  role: string | null;
};

export type ParsedInboundMessage = {
  transport: "jsonl" | "framed";
  payloadText: string;
  raw: Buffer<ArrayBufferLike>;
  rest: Buffer<ArrayBufferLike>;
};

export function asTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasProxyIdentity(identity: ProxyIdentity): boolean {
  return Boolean(identity.missionId || identity.runId || identity.stepId || identity.attemptId || identity.role);
}

export function findHeaderBoundary(buffer: Buffer): { index: number; delimiterLength: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n", 0, "utf8");
  const lf = buffer.indexOf("\n\n", 0, "utf8");
  if (crlf === -1 && lf === -1) return null;
  if (crlf === -1) return { index: lf, delimiterLength: 2 };
  if (lf === -1) return { index: crlf, delimiterLength: 4 };
  return crlf < lf ? { index: crlf, delimiterLength: 4 } : { index: lf, delimiterLength: 2 };
}

export function parseContentLength(headerBlock: string): number | null {
  const lines = headerBlock.split(/\r?\n/);
  for (const line of lines) {
    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line.trim());
    if (!match) continue;
    return Number.parseInt(match[1] ?? "", 10);
  }
  return null;
}

export function takeNextInboundMessage(buffer: Buffer): ParsedInboundMessage | null {
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

export function injectIdentityIntoInitializePayload(payloadText: string, identity: ProxyIdentity): string {
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

  const identityKeys = ["missionId", "runId", "stepId", "attemptId", "role"] as const;
  for (const key of identityKeys) {
    if (!identity[key]) continue;
    const existing = existingIdentity[key];
    if (typeof existing === "string" && existing.trim()) continue;
    mergedIdentity[key] = identity[key];
  }

  return JSON.stringify({
    ...payload,
    params: {
      ...params,
      identity: mergedIdentity,
    },
  });
}
