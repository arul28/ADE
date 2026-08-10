import { randomUUID } from "node:crypto";
import { deflateSync, gunzipSync, gzipSync, inflateSync } from "node:zlib";
import {
  SYNC_APPLICATION_COMPRESSION_CODECS,
  SYNC_APPLICATION_COMPRESSION_THRESHOLD_BYTES,
  SYNC_BINARY_ENVELOPES_CAPABILITY,
  SYNC_CHUNKED_ENVELOPES_CAPABILITY,
  type SyncApplicationCompressionCodec,
  type SyncCompressionCodec,
  type SyncEnvelope,
  type SyncEnvelopeChunkPayload,
  type SyncHelloErrorPayload,
  type SyncPeerPlatform,
  type SyncProtocolVersion,
} from "../../../../desktop/src/shared/types";
import { safeJsonParse } from "../../../../desktop/src/main/services/shared/utils";
import {
  decodeSyncBinaryFrame,
  encodeSyncBinaryFrame,
  isSyncBinaryFrame,
  syncFrameByteLength,
} from "./syncBinaryFrame";

export const SYNC_PROTOCOL_VERSION: SyncProtocolVersion = 1;
export const SYNC_PROTOCOL_MIN_SUPPORTED = 1;
export const SYNC_PROTOCOL_VERSION_MISMATCH_CLOSE_CODE = 4406;
export const DEFAULT_SYNC_HOST_PORT = 8787;
export const SYNC_HOST_MAX_PORT = 8999;
export const DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES = 4 * 1024;
export const MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES = 25 * 1024 * 1024;
export const RPC_DATA_CHUNK_BYTES = 256 * 1024;
export const FORWARD_DATA_CHUNK_BYTES = 64 * 1024;
export const PEER_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
export const BACKPRESSURE_POLL_MS = 25;
export const MAX_CHANNEL_ID_CHARS = 128;
export const MAX_ENVELOPE_CHUNK_ID_BYTES = 128;

/** Hello capability a client declares when it can reassemble envelope_chunk frames. */
export { SYNC_CHUNKED_ENVELOPES_CAPABILITY };

/** Hello capability a client declares when it can decode binary envelope frames. */
export { SYNC_BINARY_ENVELOPES_CAPABILITY };

export { syncFrameByteLength };

/** A single websocket frame: JSON text, or a binary envelope container. */
export type SyncWireFrame = string | Buffer;

/**
 * permessage-deflate settings for both sync WebSocket servers. The transport
 * compresses the frame *before* it is written, with a persistent per-connection
 * dictionary (context takeover) — which is strictly better than compressing
 * each payload independently at the application layer, because the table names,
 * column names, site ids and UUIDs that dominate changeset traffic are then
 * encoded once per connection instead of once per envelope.
 *
 * Measured on 26.2 MiB of this machine's real CRR rows, batched live-broadcast
 * sized and counted as bytes written to the socket: 7.34 MiB with today's
 * app-level deflate+base64, 4.14 MiB with permessage-deflate and no app-level
 * compression — 1.78x better. Doing both lands at 5.31 MiB, worse than either
 * done alone, which is why `shouldSkipApplicationCompression` exists.
 *
 * iOS is unaffected: `URLSessionWebSocketTask` cannot negotiate the extension,
 * so phones keep the application-level codec and the binary envelope container.
 */
export const SYNC_PER_MESSAGE_DEFLATE_OPTIONS = {
  threshold: SYNC_APPLICATION_COMPRESSION_THRESHOLD_BYTES,
  // Bound how many zlib jobs the pool runs at once so a burst of large frames
  // cannot pile unbounded native memory onto the brain process.
  concurrencyLimit: 10,
} as const;

/**
 * True when the transport already compresses this connection's frames. Running
 * the application codec underneath permessage-deflate compresses bytes that are
 * already compressed: it costs CPU on both ends and measures *worse* than
 * either layer alone.
 */
export function shouldSkipApplicationCompression(extensions: unknown): boolean {
  return typeof extensions === "string" && extensions.includes("permessage-deflate");
}

/** Hello capability for paired desktop clients that consume only rpc/fwd envelopes. */
export const SYNC_RUNTIME_ONLY_CAPABILITY = "runtimeOnly";

// URLSessionWebSocketTask buffers at most ~1 MiB per message by default and
// kills the whole connection ("Message too long") past that. Keep every frame
// comfortably under that even after the base64 + wrapper overhead of a chunk.
export const DEFAULT_SYNC_MAX_FRAME_BYTES = 720 * 1024;
export const SYNC_ENVELOPE_CHUNK_REASSEMBLY_TIMEOUT_MS = 30_000;

export function normalizeSyncApplicationCompressionOffer(
  value: unknown,
): SyncApplicationCompressionCodec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const supported = SYNC_APPLICATION_COMPRESSION_CODECS as readonly string[];
  return value.filter(
    (codec): codec is SyncApplicationCompressionCodec =>
      typeof codec === "string" && supported.includes(codec),
  );
}

export function negotiateSyncApplicationCompression(
  offered: readonly string[] | null | undefined,
): SyncApplicationCompressionCodec | null {
  if (!Array.isArray(offered)) return null;
  const supported = SYNC_APPLICATION_COMPRESSION_CODECS as readonly string[];
  return offered.find(
    (codec): codec is SyncApplicationCompressionCodec => supported.includes(codec),
  ) ?? null;
}

export function isSyncProtocolVersionSupported(
  value: unknown,
  minSupportedVersion = SYNC_PROTOCOL_MIN_SUPPORTED,
  currentVersion = SYNC_PROTOCOL_VERSION,
): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= minSupportedVersion
    && value <= currentVersion;
}

export function decodeStrictBase64(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return null;
  }
  return Buffer.from(value, "base64");
}

export function normalizeChannelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > MAX_CHANNEL_ID_CHARS) return null;
  return /^[A-Za-z0-9._:-]+$/.test(id) ? id : null;
}

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
  projectId: string | null;
  requestId: string | null;
  compression: SyncCompressionCodec;
  payload: unknown;
  raw: SyncEnvelope;
  /**
   * Raw slice of a binary `envelope_chunk`, whose part is the frame body rather
   * than a base64 string in `payload`. Typed here rather than smuggled through
   * `raw` so the chunk branch does not have to cast its way back to a Buffer.
   */
  binaryChunk?: { chunkId: string; index: number; total: number; body: Buffer };
};

export class SyncProtocolVersionMismatchError extends Error {
  readonly code = "protocol_version_mismatch";
  readonly updateTarget: "client" | "host";

  constructor(
    readonly receivedVersion: number,
    readonly requestId: string | null,
  ) {
    const updateTarget = receivedVersion < SYNC_PROTOCOL_MIN_SUPPORTED ? "client" : "host";
    const supported = SYNC_PROTOCOL_MIN_SUPPORTED === SYNC_PROTOCOL_VERSION
      ? String(SYNC_PROTOCOL_VERSION)
      : `${SYNC_PROTOCOL_MIN_SUPPORTED}-${SYNC_PROTOCOL_VERSION}`;
    super(
      `Sync protocol version ${receivedVersion} is incompatible with this ADE host (supported: ${supported}).`,
    );
    this.name = "SyncProtocolVersionMismatchError";
    this.updateTarget = updateTarget;
  }

  toHelloErrorPayload(): Extract<SyncHelloErrorPayload, { code: "protocol_version_mismatch" }> {
    return {
      code: this.code,
      message: this.message,
      receivedVersion: this.receivedVersion,
      currentVersion: SYNC_PROTOCOL_VERSION,
      minSupportedVersion: SYNC_PROTOCOL_MIN_SUPPORTED,
      updateTarget: this.updateTarget,
    };
  }
}

type VersionMismatchSocket = {
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
};

export function sendSyncProtocolVersionMismatchAndClose(
  socket: VersionMismatchSocket,
  error: SyncProtocolVersionMismatchError,
  beforeClose?: () => void,
): Extract<SyncHelloErrorPayload, { code: "protocol_version_mismatch" }> {
  const payload = error.toHelloErrorPayload();
  const response = encodeSyncEnvelope({
    type: "hello_error",
    requestId: error.requestId,
    payload,
    compressionThresholdBytes: Number.POSITIVE_INFINITY,
    compressionCodec: "none",
  });
  let closed = false;
  const closeForMismatch = (): void => {
    if (closed) return;
    closed = true;
    beforeClose?.();
    try {
      socket.close(
        SYNC_PROTOCOL_VERSION_MISMATCH_CLOSE_CODE,
        "Sync protocol version mismatch",
      );
    } catch {
      // The typed frame was already attempted.
    }
  };
  try {
    socket.send(response, closeForMismatch);
    const fallback = setTimeout(closeForMismatch, 1_000);
    fallback.unref?.();
  } catch {
    closeForMismatch();
  }
  return payload;
}

type EncodeEnvelopeArgs = {
  type: SyncEnvelope["type"];
  projectId?: string | null;
  requestId?: string | null;
  payload: unknown;
  compressionThresholdBytes?: number;
  /**
   * Defaults to legacy gzip so existing callers and non-negotiating peers
   * retain byte-for-byte wire behavior.
   */
  compressionCodec?: Exclude<SyncCompressionCodec, "none"> | "none";
};

function asSyncEnvelope(value: unknown): SyncEnvelope {
  return value as SyncEnvelope;
}

type PreparedEnvelope = {
  header: {
    version: SyncProtocolVersion;
    type: SyncEnvelope["type"];
    projectId?: string;
    requestId: string | null;
  };
  /** Non-null only when the payload cleared the compression threshold. */
  compressed: { codec: Exclude<SyncCompressionCodec, "none">; body: Buffer; uncompressedBytes: number } | null;
  payload: unknown;
};

function prepareSyncEnvelope(args: EncodeEnvelopeArgs): PreparedEnvelope {
  const payloadJson = JSON.stringify(args.payload ?? null);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const requestId = typeof args.requestId === "string" && args.requestId.trim().length > 0
    ? args.requestId.trim()
    : null;
  const projectId = typeof args.projectId === "string" && args.projectId.trim().length > 0
    ? args.projectId.trim()
    : null;
  const threshold = Math.max(0, Math.floor(args.compressionThresholdBytes ?? DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES));
  const compressionCodec = args.compressionCodec ?? "gzip";
  const header = {
    version: SYNC_PROTOCOL_VERSION,
    type: args.type,
    ...(projectId ? { projectId } : {}),
    requestId,
  };

  if (compressionCodec !== "none" && payloadBytes >= threshold) {
    const source = Buffer.from(payloadJson, "utf8");
    return {
      header,
      compressed: {
        codec: compressionCodec,
        body: compressionCodec === "deflate" ? deflateSync(source) : gzipSync(source),
        uncompressedBytes: payloadBytes,
      },
      payload: args.payload ?? null,
    };
  }

  return { header, compressed: null, payload: args.payload ?? null };
}

export function encodeSyncEnvelope(args: EncodeEnvelopeArgs): string {
  const prepared = prepareSyncEnvelope(args);
  if (prepared.compressed) {
    return JSON.stringify(asSyncEnvelope({
      ...prepared.header,
      compression: prepared.compressed.codec,
      payloadEncoding: "base64",
      payload: prepared.compressed.body.toString("base64"),
      uncompressedBytes: prepared.compressed.uncompressedBytes,
    }));
  }
  return JSON.stringify(asSyncEnvelope({
    ...prepared.header,
    compression: "none",
    payloadEncoding: "json",
    payload: prepared.payload,
  }));
}

/**
 * Encode one envelope into a single frame, using the binary container when the
 * peer supports it and the payload actually compressed. An uncompressed payload
 * stays JSON text: there are no bytes to save, and small frames staying
 * human-readable on the wire is worth more than uniformity.
 */
function encodeSyncEnvelopeFrame(args: EncodeEnvelopeArgs & { binaryFrames?: boolean }): SyncWireFrame {
  if (!args.binaryFrames) return encodeSyncEnvelope(args);
  const prepared = prepareSyncEnvelope(args);
  if (!prepared.compressed) {
    return JSON.stringify(asSyncEnvelope({
      ...prepared.header,
      compression: "none",
      payloadEncoding: "json",
      payload: prepared.payload,
    }));
  }
  return encodeSyncBinaryFrame({
    ...prepared.header,
    compression: prepared.compressed.codec,
    payloadEncoding: "binary",
    uncompressedBytes: prepared.compressed.uncompressedBytes,
  }, prepared.compressed.body);
}

/**
 * Encode an envelope into one or more websocket frames. When the encoded
 * envelope exceeds `maxFrameBytes`, it is sliced into `envelope_chunk` frames
 * the client reassembles by concatenating base64 `part`s in `index` order.
 * Pass a null/undefined `maxFrameBytes` for peers that did not declare the
 * chunkedEnvelopes capability — they get the single full frame, same as today.
 */
export function encodeSyncEnvelopeFrames(
  args: EncodeEnvelopeArgs & { maxFrameBytes?: number | null; binaryFrames?: boolean },
): SyncWireFrame[] {
  const encoded = encodeSyncEnvelopeFrame(args);
  const maxFrameBytes = args.maxFrameBytes ?? null;
  if (!maxFrameBytes || syncFrameByteLength(encoded) <= maxFrameBytes) {
    return [encoded];
  }
  const raw = typeof encoded === "string" ? Buffer.from(encoded, "utf8") : encoded;
  const chunkId = randomUUID();

  // A binary chunk carries its slice raw, so the only overhead is the small
  // header; a text chunk still pays base64's 4/3 expansion inside a JSON
  // wrapper and has to budget the slice down to compensate.
  if (args.binaryFrames) {
    const partBytes = Math.max(16 * 1024, maxFrameBytes - 1024);
    const total = Math.ceil(raw.byteLength / partBytes);
    const frames: SyncWireFrame[] = [];
    for (let index = 0; index < total; index += 1) {
      frames.push(encodeSyncBinaryFrame({
        version: SYNC_PROTOCOL_VERSION,
        type: "envelope_chunk",
        requestId: args.requestId ?? null,
        compression: "none",
        payloadEncoding: "binary",
        chunkId,
        index,
        total,
      }, raw.subarray(index * partBytes, Math.min(raw.byteLength, (index + 1) * partBytes))));
    }
    return frames;
  }

  // Each part is base64 (4/3 expansion) inside a small JSON wrapper; budget
  // the decoded slice so the wrapped chunk frame stays under maxFrameBytes.
  const partBytes = Math.max(16 * 1024, Math.floor(((maxFrameBytes - 1024) * 3) / 4));
  const total = Math.ceil(raw.byteLength / partBytes);
  const frames: SyncWireFrame[] = [];
  for (let index = 0; index < total; index += 1) {
    const payload: SyncEnvelopeChunkPayload = {
      chunkId,
      index,
      total,
      part: raw.subarray(index * partBytes, Math.min(raw.byteLength, (index + 1) * partBytes)).toString("base64"),
    };
    frames.push(encodeSyncEnvelope({
      type: "envelope_chunk",
      requestId: args.requestId,
      payload,
      // base64 of (usually gzipped) data does not compress again.
      compressionThresholdBytes: Number.POSITIVE_INFINITY,
      compressionCodec: "none",
    }));
  }
  return frames;
}

/**
 * Chunk metadata carried in a binary `envelope_chunk` header. The body is the
 * raw slice, so unlike the text form there is no `part` string to validate.
 */
export function parseSyncBinaryChunkHeader(
  header: Record<string, unknown>,
): { chunkId: string; index: number; total: number } | null {
  const chunkId = typeof header.chunkId === "string"
    && header.chunkId.trim()
    && Buffer.byteLength(header.chunkId, "utf8") <= MAX_ENVELOPE_CHUNK_ID_BYTES
    ? header.chunkId
    : null;
  const index = typeof header.index === "number" && Number.isInteger(header.index) && header.index >= 0
    ? header.index
    : null;
  const total = typeof header.total === "number" && Number.isInteger(header.total) && header.total > 0
    ? header.total
    : null;
  if (chunkId == null || index == null || total == null || index >= total) return null;
  return { chunkId, index, total };
}

export function parseSyncEnvelopeChunkPayload(payload: unknown): SyncEnvelopeChunkPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const chunkId = typeof record.chunkId === "string"
    && record.chunkId.trim()
    && Buffer.byteLength(record.chunkId, "utf8") <= MAX_ENVELOPE_CHUNK_ID_BYTES
    ? record.chunkId
    : null;
  const index = typeof record.index === "number" && Number.isInteger(record.index) && record.index >= 0 ? record.index : null;
  const total = typeof record.total === "number" && Number.isInteger(record.total) && record.total > 0 ? record.total : null;
  const part = typeof record.part === "string" ? record.part : null;
  if (chunkId == null || index == null || total == null || part == null || index >= total) return null;
  return { chunkId, index, total, part };
}

/**
 * Client-side reassembly helper: collects envelope_chunk payloads by chunkId
 * and returns the full encoded envelope text once every part has arrived.
 * Keeps only a handful of in-flight chunk ids so a malicious or broken host
 * cannot grow the buffer unboundedly.
 */
export function createSyncEnvelopeChunkAssembler(options: {
  maxConcurrentChunks?: number;
  maxTotalParts?: number;
  maxEnvelopeBytes?: number;
  maxBufferedBytes?: number;
  timeoutMs?: number;
} = {}) {
  const maxConcurrentChunks = options.maxConcurrentChunks ?? 8;
  const maxTotalParts = options.maxTotalParts ?? 512;
  const maxEnvelopeBytes = options.maxEnvelopeBytes ?? 32 * 1024 * 1024;
  const maxBufferedBytes = options.maxBufferedBytes ?? maxEnvelopeBytes;
  const timeoutMs = options.timeoutMs ?? SYNC_ENVELOPE_CHUNK_REASSEMBLY_TIMEOUT_MS;
  let bufferedBytes = 0;
  const buffers = new Map<string, {
    total: number;
    parts: Map<number, Buffer>;
    bytes: number;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  const remove = (chunkId: string): void => {
    const buffer = buffers.get(chunkId);
    if (!buffer) return;
    clearTimeout(buffer.timeout);
    bufferedBytes -= buffer.bytes;
    buffers.delete(chunkId);
  };

  const ingest = (
    meta: { chunkId: string; index: number; total: number },
    decodedPart: Buffer,
  ): Buffer | null => {
    if (meta.total > maxTotalParts) return null;
    if (decodedPart.byteLength > maxEnvelopeBytes) {
      remove(meta.chunkId);
      return null;
    }
    let buffer = buffers.get(meta.chunkId);
    if (!buffer) {
      while (buffers.size >= maxConcurrentChunks) {
        const oldest = buffers.keys().next().value;
        if (oldest == null) break;
        remove(oldest);
      }
      const timeout = setTimeout(() => remove(meta.chunkId), timeoutMs);
      timeout.unref?.();
      buffer = { total: meta.total, parts: new Map(), bytes: 0, timeout };
      buffers.set(meta.chunkId, buffer);
    }
    if (buffer.total !== meta.total) {
      remove(meta.chunkId);
      return null;
    }
    const previous = buffer.parts.get(meta.index);
    const nextBytes = buffer.bytes - (previous?.byteLength ?? 0) + decodedPart.byteLength;
    const nextBufferedBytes = bufferedBytes
      - (previous?.byteLength ?? 0)
      + decodedPart.byteLength;
    if (nextBytes > maxEnvelopeBytes || nextBufferedBytes > maxBufferedBytes) {
      remove(meta.chunkId);
      return null;
    }
    buffer.parts.set(meta.index, decodedPart);
    buffer.bytes = nextBytes;
    bufferedBytes = nextBufferedBytes;
    if (buffer.parts.size < buffer.total) return null;
    remove(meta.chunkId);
    const segments: Buffer[] = [];
    for (let index = 0; index < buffer.total; index += 1) {
      const part = buffer.parts.get(index);
      if (part == null) return null;
      segments.push(part);
    }
    return Buffer.concat(segments);
  };

  return {
    add(payload: SyncEnvelopeChunkPayload): string | null {
      const decodedPart = decodeStrictBase64(payload.part);
      if (!decodedPart) {
        remove(payload.chunkId);
        return null;
      }
      return ingest(payload, decodedPart)?.toString("utf8") ?? null;
    },
    /**
     * Binary chunks carry their slice raw, and reassemble into the binary
     * envelope frame itself — returning a Buffer, not text, because utf8
     * decoding those bytes would corrupt them.
     */
    addBinary(meta: { chunkId: string; index: number; total: number }, body: Buffer): Buffer | null {
      return ingest(meta, body);
    },
    reset(): void {
      for (const chunkId of buffers.keys()) remove(chunkId);
    },
    pendingCount(): number {
      return buffers.size;
    },
  };
}

function inflateSyncEnvelopeBody(
  compressed: Buffer,
  codec: "gzip" | "deflate",
  declaredBytes: number | undefined,
  requestId: string | null,
  projectId: string | null,
): Buffer {
  if (typeof declaredBytes === "number" && declaredBytes > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES) {
    throw new Error(`Decoded sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
  }
  let uncompressed: Buffer;
  try {
    uncompressed = codec === "deflate"
      ? inflateSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES })
      : gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES });
  } catch (error) {
    throw new Error(`Failed to decode ${codec} sync envelope${requestId ? ` ${requestId}` : ""}${projectId ? ` for project ${projectId}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (uncompressed.byteLength > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES) {
    throw new Error(`Decoded sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
  }
  if (typeof declaredBytes === "number" && declaredBytes !== uncompressed.byteLength) {
    throw new Error("Decoded sync envelope size does not match declared uncompressedBytes.");
  }
  return uncompressed;
}

/**
 * Parse a frame that may be either JSON text or a binary envelope container.
 * Anything without the binary magic takes the text path unchanged, so a peer
 * that never negotiated binary frames sees byte-identical behavior.
 */
export function parseSyncEnvelopeFrame(raw: unknown): ParsedSyncEnvelope {
  // `ws` delivers RawData as a single Buffer by default, but as Buffer[] when a
  // socket is in fragments mode. Concatenating first means the magic sniff sees
  // the real first four bytes instead of failing the check and sending a binary
  // frame down the utf8 text path.
  const frame = Array.isArray(raw) ? Buffer.concat(raw as Buffer[]) : raw;
  if (isSyncBinaryFrame(frame)) return parseSyncBinaryEnvelope(frame);
  return parseSyncEnvelope(wsDataToText(frame));
}

export function parseSyncBinaryEnvelope(raw: Buffer): ParsedSyncEnvelope {
  const decoded = decodeSyncBinaryFrame(raw);
  if (!decoded) throw new Error("Invalid binary sync envelope frame.");
  const header = decoded.header;
  const receivedVersion = header.version;
  const rawRequestId = header.requestId;
  const requestId = typeof rawRequestId === "string" && rawRequestId.trim() ? rawRequestId.trim() : null;
  if (
    typeof receivedVersion === "number"
    && Number.isInteger(receivedVersion)
    && !isSyncProtocolVersionSupported(receivedVersion)
  ) {
    throw new SyncProtocolVersionMismatchError(receivedVersion, requestId);
  }
  if (!isSyncProtocolVersionSupported(receivedVersion)) {
    throw new Error(`Invalid sync protocol version: ${String(receivedVersion ?? "unknown")}`);
  }
  const projectId = typeof header.projectId === "string" && header.projectId.trim()
    ? header.projectId.trim()
    : null;
  const compression = header.compression;
  const type = header.type as SyncEnvelope["type"];

  if (compression === "none") {
    // Only chunk frames ride the binary container uncompressed; their body is
    // the raw slice rather than a base64 payload.
    const chunk = parseSyncBinaryChunkHeader(header);
    if (!chunk) throw new Error("Invalid binary envelope_chunk header.");
    return {
      version: receivedVersion as SyncProtocolVersion,
      type,
      projectId,
      requestId,
      compression: "none",
      payload: null,
      raw: header as unknown as SyncEnvelope,
      binaryChunk: { ...chunk, body: decoded.body },
    };
  }

  if (compression !== "gzip" && compression !== "deflate") {
    throw new Error(`Unsupported binary sync envelope compression: ${String(compression ?? "unknown")}`);
  }
  const uncompressed = inflateSyncEnvelopeBody(
    decoded.body,
    compression,
    typeof header.uncompressedBytes === "number" ? header.uncompressedBytes : undefined,
    requestId,
    projectId,
  );
  return {
    version: receivedVersion as SyncProtocolVersion,
    type,
    projectId,
    requestId,
    compression,
    payload: safeJsonParse(uncompressed.toString("utf8"), null),
    raw: header as unknown as SyncEnvelope,
  };
}

export function parseSyncEnvelope(rawText: string): ParsedSyncEnvelope {
  const decoded = safeJsonParse<SyncEnvelope | null>(rawText, null);
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid sync envelope JSON.");
  }
  const receivedVersion = (decoded as { version?: unknown }).version;
  if (
    typeof receivedVersion === "number"
    && Number.isInteger(receivedVersion)
    && !isSyncProtocolVersionSupported(receivedVersion)
  ) {
    const rawRequestId = (decoded as { requestId?: unknown }).requestId;
    throw new SyncProtocolVersionMismatchError(
      receivedVersion,
      typeof rawRequestId === "string" && rawRequestId.trim() ? rawRequestId.trim() : null,
    );
  }
  if (!isSyncProtocolVersionSupported(receivedVersion)) {
    throw new Error(`Invalid sync protocol version: ${String(receivedVersion ?? "unknown")}`);
  }

  const requestId = typeof decoded.requestId === "string" && decoded.requestId.trim().length > 0
    ? decoded.requestId.trim()
    : null;
  const projectId = typeof decoded.projectId === "string" && decoded.projectId.trim().length > 0
    ? decoded.projectId.trim()
    : null;

  if (decoded.compression === "gzip" || decoded.compression === "deflate") {
    if (decoded.payloadEncoding !== "base64" || typeof decoded.payload !== "string") {
      throw new Error("Compressed sync envelopes must use base64 payload encoding.");
    }
    if (
      typeof decoded.uncompressedBytes === "number"
      && decoded.uncompressedBytes > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES
    ) {
      throw new Error(`Decoded sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
    }
    const uncompressedBuffer = inflateSyncEnvelopeBody(
      Buffer.from(decoded.payload, "base64"),
      decoded.compression,
      decoded.uncompressedBytes,
      requestId,
      projectId,
    );
    const uncompressed = uncompressedBuffer.toString("utf8");
    return {
      version: decoded.version,
      type: decoded.type,
      projectId,
      requestId,
      compression: decoded.compression,
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
    projectId,
    requestId,
    compression: "none",
    payload: decoded.payload,
    raw: decoded,
  };
}
