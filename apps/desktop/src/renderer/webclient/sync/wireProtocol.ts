import type {
  SyncApplicationCompressionCodec,
  SyncEnvelope,
  SyncEnvelopeChunkPayload,
  SyncMobileProjectSummary,
  SyncProjectCatalogChunkPayload,
  SyncProjectCatalogPayload,
} from "../../../shared/types/sync";

export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_PROTOCOL_MIN_SUPPORTED = 1;
export const MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_SYNC_MAX_FRAME_BYTES = 720 * 1024;
export const ENVELOPE_CHUNK_REASSEMBLY_TIMEOUT_MS = 30_000;

export type EncodeEnvelopeInput = {
  type: SyncEnvelope["type"];
  projectId?: string | null;
  requestId?: string | null;
  payload?: unknown;
};

export class BrowserSyncProtocolVersionMismatchError extends Error {
  readonly code = "protocol_version_mismatch";
  readonly updateTarget: "client" | "host";

  constructor(readonly receivedVersion: number) {
    const supported = SYNC_PROTOCOL_MIN_SUPPORTED === SYNC_PROTOCOL_VERSION
      ? String(SYNC_PROTOCOL_VERSION)
      : `${SYNC_PROTOCOL_MIN_SUPPORTED}-${SYNC_PROTOCOL_VERSION}`;
    const updateTarget = receivedVersion < SYNC_PROTOCOL_MIN_SUPPORTED ? "host" : "client";
    super(updateTarget === "host"
      ? `Update ADE on your Mac. It uses sync protocol ${receivedVersion}; this browser supports ${supported}.`
      : `Update ADE in this browser. The Mac uses sync protocol ${receivedVersion}; this browser supports ${supported}.`);
    this.name = "BrowserSyncProtocolVersionMismatchError";
    this.updateTarget = updateTarget;
  }
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  throw new Error("No base64 decoder is available.");
}

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    const chunkBytes = 32 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkBytes));
    }
    return btoa(binary);
  }
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  throw new Error("No base64 encoder is available.");
}

async function decompressWithCap(
  compressed: Uint8Array,
  codec: SyncApplicationCompressionCodec | "gzip",
): Promise<Uint8Array> {
  if (compressed.byteLength > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES) {
    throw new Error(`Compressed sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
  }
  if (typeof DecompressionStream !== "function") {
    throw new Error(`This browser does not support ${codec} sync envelopes.`);
  }
  const transform = new DecompressionStream(codec) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  }).pipeThrough(transform);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancellation failures from already-failed streams
      }
      throw new Error(`Decoded sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  return concatBytes(chunks, total);
}

async function compress(
  uncompressed: Uint8Array,
  codec: SyncApplicationCompressionCodec,
): Promise<Uint8Array> {
  if (typeof CompressionStream !== "function") {
    throw new Error(`This browser does not support ${codec} sync envelopes.`);
  }
  const transform = new CompressionStream(codec) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const source = Uint8Array.from(uncompressed).buffer;
  const compressed = await new Response(
    new Blob([source]).stream().pipeThrough(transform),
  ).arrayBuffer();
  return new Uint8Array(compressed);
}

export function encodeEnvelopeText(envelope: EncodeEnvelopeInput): string {
  const requestId = normalizeOptionalString(envelope.requestId);
  const projectId = normalizeOptionalString(envelope.projectId);
  return JSON.stringify({
    version: SYNC_PROTOCOL_VERSION,
    type: envelope.type,
    ...(projectId ? { projectId } : {}),
    requestId,
    compression: "none",
    payloadEncoding: "json",
    payload: envelope.payload ?? null,
  } as SyncEnvelope);
}

export async function encodeEnvelopeTextWithCompression(
  envelope: EncodeEnvelopeInput,
  negotiation: {
    codec: SyncApplicationCompressionCodec;
    thresholdBytes: number;
  } | null,
): Promise<string> {
  if (!negotiation) return encodeEnvelopeText(envelope);
  const payloadJson = JSON.stringify(envelope.payload ?? null);
  const payloadBytes = new TextEncoder().encode(payloadJson);
  if (payloadBytes.byteLength < negotiation.thresholdBytes) {
    return encodeEnvelopeText(envelope);
  }
  const requestId = normalizeOptionalString(envelope.requestId);
  const projectId = normalizeOptionalString(envelope.projectId);
  const compressed = await compress(payloadBytes, negotiation.codec);
  return JSON.stringify({
    version: SYNC_PROTOCOL_VERSION,
    type: envelope.type,
    ...(projectId ? { projectId } : {}),
    requestId,
    compression: negotiation.codec,
    payloadEncoding: "base64",
    payload: bytesToBase64(compressed),
    uncompressedBytes: payloadBytes.byteLength,
  } as SyncEnvelope);
}

export async function encodeEnvelopeFrames(
  envelope: EncodeEnvelopeInput,
  options: {
    compression: {
      codec: SyncApplicationCompressionCodec;
      thresholdBytes: number;
    } | null;
    maxFrameBytes: number | null;
  },
): Promise<string[]> {
  const text = await encodeEnvelopeTextWithCompression(envelope, options.compression);
  const maxFrameBytes = options.maxFrameBytes;
  const raw = new TextEncoder().encode(text);
  if (!maxFrameBytes || raw.byteLength <= maxFrameBytes) return [text];
  if (maxFrameBytes <= 1_024) throw new Error("Invalid sync frame budget.");

  const partBytes = Math.max(16 * 1024, Math.floor(((maxFrameBytes - 1_024) * 3) / 4));
  const total = Math.ceil(raw.byteLength / partBytes);
  const chunkId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const frames: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const frame = encodeEnvelopeText({
      type: "envelope_chunk",
      requestId: envelope.requestId,
      payload: {
        chunkId,
        index,
        total,
        part: bytesToBase64(raw.subarray(index * partBytes, Math.min(raw.byteLength, (index + 1) * partBytes))),
      } satisfies SyncEnvelopeChunkPayload,
    });
    if (new TextEncoder().encode(frame).byteLength > maxFrameBytes) {
      throw new Error("Could not fit a sync chunk inside the negotiated frame budget.");
    }
    frames.push(frame);
  }
  return frames;
}

export async function decodeEnvelopeText(text: string): Promise<SyncEnvelope> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid sync envelope JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Invalid sync envelope JSON.");
  }
  const envelope = decoded as SyncEnvelope;
  const receivedVersion = (decoded as { version?: unknown }).version;
  if (
    typeof receivedVersion === "number"
    && Number.isInteger(receivedVersion)
    && (
      receivedVersion < SYNC_PROTOCOL_MIN_SUPPORTED
      || receivedVersion > SYNC_PROTOCOL_VERSION
    )
  ) {
    throw new BrowserSyncProtocolVersionMismatchError(receivedVersion);
  }
  if (receivedVersion !== SYNC_PROTOCOL_VERSION) {
    throw new Error(`Invalid sync protocol version: ${String(receivedVersion ?? "unknown")}`);
  }
  if (envelope.compression === "gzip" || envelope.compression === "deflate") {
    if (envelope.payloadEncoding !== "base64" || typeof envelope.payload !== "string") {
      throw new Error("Compressed sync envelopes must use base64 payload encoding.");
    }
    if (
      typeof envelope.uncompressedBytes === "number"
      && envelope.uncompressedBytes > MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES
    ) {
      throw new Error(`Decoded sync envelope exceeds ${MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES} bytes.`);
    }
    const uncompressed = await decompressWithCap(
      base64ToBytes(envelope.payload),
      envelope.compression,
    );
    if (
      typeof envelope.uncompressedBytes === "number"
      && envelope.uncompressedBytes !== uncompressed.byteLength
    ) {
      throw new Error("Decoded sync envelope size does not match declared uncompressedBytes.");
    }
    const payloadText = new TextDecoder().decode(uncompressed);
    return {
      ...envelope,
      compression: "none",
      payloadEncoding: "json",
      payload: JSON.parse(payloadText),
    } as SyncEnvelope;
  }
  if (envelope.compression !== "none") {
    throw new Error(`Unsupported sync envelope compression: ${String((envelope as { compression?: unknown }).compression)}`);
  }
  if (envelope.payloadEncoding !== "json") {
    throw new Error("Uncompressed sync envelopes must use JSON payload encoding.");
  }
  return envelope;
}

export function parseEnvelopeChunkPayload(payload: unknown): SyncEnvelopeChunkPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Partial<SyncEnvelopeChunkPayload>;
  const chunkId = typeof value.chunkId === "string" && value.chunkId.trim() ? value.chunkId : null;
  const index = typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0 ? value.index : null;
  const total = typeof value.total === "number" && Number.isInteger(value.total) && value.total > 0 ? value.total : null;
  const part = typeof value.part === "string" ? value.part : null;
  if (!chunkId || index == null || total == null || !part || index >= total) return null;
  return { chunkId, index, total, part };
}

export function createEnvelopeChunkAssembler(options: {
  maxConcurrentChunks?: number;
  maxTotalParts?: number;
  maxEnvelopeBytes?: number;
  timeoutMs?: number;
} = {}) {
  const maxConcurrentChunks = options.maxConcurrentChunks ?? 8;
  const maxTotalParts = options.maxTotalParts ?? 512;
  const maxEnvelopeBytes = options.maxEnvelopeBytes ?? 32 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? ENVELOPE_CHUNK_REASSEMBLY_TIMEOUT_MS;
  const chunks = new Map<string, {
    total: number;
    parts: Map<number, Uint8Array>;
    bytes: number;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const remove = (chunkId: string): void => {
    const entry = chunks.get(chunkId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    chunks.delete(chunkId);
  };
  return {
    add(payload: SyncEnvelopeChunkPayload): string | null {
      if (payload.total > maxTotalParts) return null;
      let decoded: Uint8Array;
      try {
        decoded = base64ToBytes(payload.part);
      } catch {
        remove(payload.chunkId);
        return null;
      }
      if (decoded.byteLength > maxEnvelopeBytes) {
        remove(payload.chunkId);
        return null;
      }
      let entry = chunks.get(payload.chunkId);
      if (!entry) {
        while (chunks.size >= maxConcurrentChunks) {
          const oldest = chunks.keys().next().value;
          if (oldest == null) break;
          remove(oldest);
        }
        const timeout = setTimeout(() => remove(payload.chunkId), timeoutMs);
        entry = { total: payload.total, parts: new Map(), bytes: 0, timeout };
        chunks.set(payload.chunkId, entry);
      }
      if (entry.total !== payload.total) {
        remove(payload.chunkId);
        return null;
      }
      const previous = entry.parts.get(payload.index);
      const nextBytes = entry.bytes - (previous?.byteLength ?? 0) + decoded.byteLength;
      if (nextBytes > maxEnvelopeBytes) {
        remove(payload.chunkId);
        return null;
      }
      entry.parts.set(payload.index, decoded);
      entry.bytes = nextBytes;
      if (entry.parts.size < entry.total) return null;
      remove(payload.chunkId);
      const bytes: Uint8Array[] = [];
      let totalBytes = 0;
      for (let index = 0; index < entry.total; index += 1) {
        const part = entry.parts.get(index);
        if (!part) return null;
        bytes.push(part);
        totalBytes += part.byteLength;
      }
      return new TextDecoder().decode(concatBytes(bytes, totalBytes));
    },
    reset(): void {
      for (const chunkId of chunks.keys()) remove(chunkId);
    },
    pendingCount(): number {
      return chunks.size;
    },
  };
}

export function assembleProjectCatalogChunks(chunks: SyncProjectCatalogChunkPayload[]): SyncProjectCatalogPayload | null {
  if (chunks.length === 0) return null;
  const catalogId = chunks[0].catalogId;
  const total = chunks[0].total;
  if (!catalogId || !Number.isInteger(total) || total <= 0) return null;
  const byIndex = new Map<number, SyncProjectCatalogChunkPayload>();
  for (const chunk of chunks) {
    if (chunk.catalogId !== catalogId || chunk.total !== total || chunk.index < 0 || chunk.index >= total) return null;
    byIndex.set(chunk.index, chunk);
  }
  if (byIndex.size !== total) return null;
  const projects: SyncMobileProjectSummary[] = [];
  for (let index = 0; index < total; index += 1) {
    const chunk = byIndex.get(index);
    if (!chunk) return null;
    projects.push(...chunk.projects);
  }
  return { projects };
}

export function createProjectCatalogChunkAssembler(options: { maxCatalogs?: number } = {}) {
  const maxCatalogs = options.maxCatalogs ?? 4;
  const catalogs = new Map<string, Map<number, SyncProjectCatalogChunkPayload>>();
  return {
    add(chunk: SyncProjectCatalogChunkPayload): SyncProjectCatalogPayload | null {
      if (!chunk.catalogId || chunk.total <= 0 || chunk.index < 0 || chunk.index >= chunk.total) return null;
      let catalog = catalogs.get(chunk.catalogId);
      if (!catalog) {
        while (catalogs.size >= maxCatalogs) {
          const oldest = catalogs.keys().next().value;
          if (oldest == null) break;
          catalogs.delete(oldest);
        }
        catalog = new Map();
        catalogs.set(chunk.catalogId, catalog);
      }
      catalog.set(chunk.index, chunk);
      if (catalog.size < chunk.total && !chunk.done) return null;
      const assembled = assembleProjectCatalogChunks(Array.from(catalog.values()));
      if (assembled) catalogs.delete(chunk.catalogId);
      return assembled;
    },
    reset(): void {
      catalogs.clear();
    },
  };
}
