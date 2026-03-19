import { gunzipSync, gzipSync } from "node:zlib";
import type { SyncCompressionCodec, SyncEnvelope, SyncPeerPlatform, SyncProtocolVersion } from "../../../shared/types";
import { safeJsonParse } from "../shared/utils";

export const SYNC_PROTOCOL_VERSION: SyncProtocolVersion = 1;
export const DEFAULT_SYNC_HOST_PORT = 8787;
export const DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES = 4 * 1024;

export function mapPlatform(platform: NodeJS.Platform): SyncPeerPlatform {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

export function wsDataToText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return String(data);
}

export type ParsedSyncEnvelope = {
  version: SyncProtocolVersion;
  type: SyncEnvelope["type"];
  requestId: string | null;
  compression: SyncCompressionCodec;
  payload: unknown;
  raw: SyncEnvelope;
};

type EncodeEnvelopeArgs = {
  type: SyncEnvelope["type"];
  requestId?: string | null;
  payload: unknown;
  compressionThresholdBytes?: number;
};

function asSyncEnvelope(value: unknown): SyncEnvelope {
  return value as SyncEnvelope;
}

export function encodeSyncEnvelope(args: EncodeEnvelopeArgs): string {
  const payloadJson = JSON.stringify(args.payload ?? null);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const requestId = typeof args.requestId === "string" && args.requestId.trim().length > 0
    ? args.requestId.trim()
    : null;
  const threshold = Math.max(0, Math.floor(args.compressionThresholdBytes ?? DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES));

  if (payloadBytes >= threshold) {
    const compressed = gzipSync(Buffer.from(payloadJson, "utf8"));
    return JSON.stringify(asSyncEnvelope({
      version: SYNC_PROTOCOL_VERSION,
      type: args.type,
      requestId,
      compression: "gzip",
      payloadEncoding: "base64",
      payload: compressed.toString("base64"),
      uncompressedBytes: payloadBytes,
    }));
  }

  return JSON.stringify(asSyncEnvelope({
    version: SYNC_PROTOCOL_VERSION,
    type: args.type,
    requestId,
    compression: "none",
    payloadEncoding: "json",
    payload: args.payload ?? null,
  }));
}

export function parseSyncEnvelope(rawText: string): ParsedSyncEnvelope {
  const decoded = safeJsonParse<SyncEnvelope | null>(rawText, null);
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid sync envelope JSON.");
  }
  if (decoded.version !== SYNC_PROTOCOL_VERSION) {
    throw new Error(`Unsupported sync protocol version: ${String((decoded as { version?: unknown }).version ?? "unknown")}`);
  }

  const requestId = typeof decoded.requestId === "string" && decoded.requestId.trim().length > 0
    ? decoded.requestId.trim()
    : null;

  if (decoded.compression === "gzip") {
    if (decoded.payloadEncoding !== "base64" || typeof decoded.payload !== "string") {
      throw new Error("Compressed sync envelopes must use base64 payload encoding.");
    }
    const uncompressed = gunzipSync(Buffer.from(decoded.payload, "base64")).toString("utf8");
    return {
      version: decoded.version,
      type: decoded.type,
      requestId,
      compression: "gzip",
      payload: safeJsonParse(uncompressed, null),
      raw: decoded,
    };
  }

  if (decoded.payloadEncoding !== "json") {
    throw new Error("Uncompressed sync envelopes must use JSON payload encoding.");
  }

  return {
    version: decoded.version,
    type: decoded.type,
    requestId,
    compression: "none",
    payload: decoded.payload,
    raw: decoded,
  };
}
