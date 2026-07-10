import {
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { WebSocket, type RawData } from "ws";
import type {
  DesktopPairedMachineCredentials,
  PairedRuntimeHelloOkPayload,
} from "../../../shared/types/pairedRuntime";
import type {
  SyncEnvelope,
  SyncHelloErrorPayload,
  SyncHelloPayload,
} from "../../../shared/types/sync";
import {
  buildSyncDpopChallenge,
  sha256Hex,
} from "../../../../../ade-cli/src/services/sync/syncDpop";
import {
  createSyncEnvelopeChunkAssembler,
  decodeStrictBase64,
  encodeSyncEnvelope,
  normalizeChannelId,
  parseSyncEnvelope,
  parseSyncEnvelopeChunkPayload,
  RPC_DATA_CHUNK_BYTES,
  SYNC_CHUNKED_ENVELOPES_CAPABILITY,
  SYNC_RUNTIME_ONLY_CAPABILITY,
  wsDataToText,
  type ParsedSyncEnvelope,
} from "../sync/syncProtocol";
import type { RuntimeRpcTransport } from "./runtimeRpcClient";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

export type SyncEnvelopeConnection = {
  readonly endpoint: string;
  send(type: SyncEnvelope["type"], payload: unknown, requestId?: string | null): void;
  onEnvelope(callback: (envelope: ParsedSyncEnvelope) => void): () => void;
  onError(callback: (error: Error) => void): () => void;
  onClose(callback: () => void): () => void;
  bufferedAmount(): number;
  close(code?: number, reason?: string): void;
};

export type AuthenticatedSyncConnection = SyncEnvelopeConnection & {
  readonly hello: PairedRuntimeHelloOkPayload;
  readonly credentials: DesktopPairedMachineCredentials;
};

export type OpenSyncEnvelopeConnectionOptions = {
  endpoint: string;
  connectTimeoutMs?: number;
  createWebSocket?: (endpoint: string) => WebSocket;
};

export type OpenPairedSyncConnectionOptions = OpenSyncEnvelopeConnectionOptions & {
  credentials: DesktopPairedMachineCredentials;
  authTimeoutMs?: number;
  appVersion?: string;
};

export type OpenSyncRuntimeTransportOptions = Omit<
  OpenPairedSyncConnectionOptions,
  "endpoint"
> & {
  endpoint?: string;
  channelId?: string;
};

export type SyncRuntimeTransport = RuntimeRpcTransport & {
  readonly channelId: string;
  readonly connection: AuthenticatedSyncConnection;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  const timeout = Number(value ?? fallback);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Sync connection timeout must be a finite positive number.");
  }
  return Math.min(2_147_483_647, Math.ceil(timeout));
}

export function normalizeSyncEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("A sync WebSocket endpoint is required.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid sync endpoint: ${trimmed}`);
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Sync endpoints must use ws:// or wss://.");
  }
  if (url.username || url.password) {
    throw new Error("Sync endpoints must not contain embedded credentials.");
  }
  url.hash = "";
  return url.toString();
}

function websocketCloseReason(value: string): string {
  let reason = value;
  while (Buffer.byteLength(reason, "utf8") > 123) {
    reason = reason.slice(0, -1);
  }
  return reason;
}

function channelId(value: string | undefined): string {
  const normalized = value?.trim() || randomUUID();
  if (!normalizeChannelId(normalized)) {
    throw new Error("Sync runtime channelId is invalid.");
  }
  return normalized;
}

function emitCallbacks<T>(callbacks: Set<(value: T) => void>, value: T): void {
  for (const callback of [...callbacks]) {
    try {
      callback(value);
    } catch {
      // A consumer callback must not break delivery to the other consumers.
    }
  }
}

function createConnection(
  endpoint: string,
  ws: WebSocket,
): SyncEnvelopeConnection {
  const envelopeCallbacks = new Set<(envelope: ParsedSyncEnvelope) => void>();
  const errorCallbacks = new Set<(error: Error) => void>();
  const closeCallbacks = new Set<() => void>();
  const chunkAssembler = createSyncEnvelopeChunkAssembler();
  let closeEmitted = false;

  const emitError = (error: unknown): void => {
    emitCallbacks(errorCallbacks, asError(error));
  };
  const emitClose = (): void => {
    if (closeEmitted) return;
    closeEmitted = true;
    chunkAssembler.reset();
    for (const callback of [...closeCallbacks]) {
      try {
        callback();
      } catch {
        // Continue notifying the remaining consumers.
      }
    }
  };
  const acceptText = (text: string): void => {
    let envelope: ParsedSyncEnvelope;
    try {
      envelope = parseSyncEnvelope(text);
      if (envelope.type === "envelope_chunk") {
        const chunk = parseSyncEnvelopeChunkPayload(envelope.payload);
        if (!chunk) throw new Error("Invalid sync envelope chunk payload.");
        const assembled = chunkAssembler.add(chunk);
        if (assembled == null) return;
        envelope = parseSyncEnvelope(assembled);
        if (envelope.type === "envelope_chunk") {
          throw new Error("Nested sync envelope chunks are not supported.");
        }
      }
    } catch (error) {
      emitError(error);
      try {
        ws.close(1003, "Invalid sync envelope");
      } catch {
        // The socket may already be closing.
      }
      return;
    }
    emitCallbacks(envelopeCallbacks, envelope);
  };

  ws.on("message", (data: RawData) => acceptText(wsDataToText(data)));
  ws.on("error", emitError);
  ws.on("close", emitClose);

  return {
    endpoint,
    send(type, payload, requestId) {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("Sync WebSocket is not open.");
      }
      ws.send(encodeSyncEnvelope({ type, payload, requestId }));
    },
    onEnvelope(callback) {
      envelopeCallbacks.add(callback);
      return () => envelopeCallbacks.delete(callback);
    },
    onError(callback) {
      errorCallbacks.add(callback);
      return () => errorCallbacks.delete(callback);
    },
    onClose(callback) {
      if (closeEmitted) {
        queueMicrotask(callback);
        return () => {};
      }
      closeCallbacks.add(callback);
      return () => closeCallbacks.delete(callback);
    },
    bufferedAmount: () => ws.bufferedAmount,
    close(code = 1000, reason = "Sync connection closed.") {
      if (ws.readyState === WebSocket.CLOSED) {
        emitClose();
        return;
      }
      try {
        ws.close(code, websocketCloseReason(reason));
      } catch (error) {
        emitError(error);
        emitClose();
      }
    },
  };
}

export async function openSyncEnvelopeConnection(
  options: OpenSyncEnvelopeConnectionOptions,
): Promise<SyncEnvelopeConnection> {
  const endpoint = normalizeSyncEndpoint(options.endpoint);
  const timeoutMs = normalizeTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
  const ws = options.createWebSocket?.(endpoint) ?? new WebSocket(endpoint);
  const connection = createConnection(endpoint, ws);

  if (ws.readyState === WebSocket.OPEN) return connection;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      connection.close(1000, "Sync connection timed out.");
      reject(new Error(`Timed out connecting to sync endpoint after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      connection.close(1000, "Sync connection failed.");
      reject(new Error(`Failed to connect to sync endpoint: ${error.message}`));
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Sync endpoint closed before the connection opened."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
  return connection;
}

export function createDesktopSyncDpopProof(
  credentials: Pick<
    DesktopPairedMachineCredentials,
    "deviceId" | "secret" | "dpopPrivateKey" | "dpopPublicKey"
  >,
) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(18).toString("base64url");
  const challenge = buildSyncDpopChallenge({
    deviceId: credentials.deviceId,
    secretSha256Hex: sha256Hex(credentials.secret),
    timestamp,
    nonce,
  });
  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: Buffer.from(credentials.dpopPrivateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch (error) {
    throw new Error(`Stored desktop pairing key is invalid: ${asError(error).message}`);
  }
  return {
    publicKey: credentials.dpopPublicKey,
    timestamp,
    nonce,
    signature: sign("sha256", Buffer.from(challenge, "utf8"), privateKey).toString("base64"),
  };
}

export function buildDesktopPairedHello(
  credentials: DesktopPairedMachineCredentials,
  appVersion?: string,
): SyncHelloPayload {
  return {
    peer: {
      deviceId: credentials.deviceId,
      deviceName: credentials.deviceName,
      platform: process.platform === "darwin"
        ? "macOS"
        : process.platform === "win32"
          ? "windows"
          : process.platform === "linux"
            ? "linux"
            : "unknown",
      deviceType: "desktop",
      siteId: credentials.siteId,
      dbVersion: 0,
      capabilities: [
        SYNC_CHUNKED_ENVELOPES_CAPABILITY,
        SYNC_RUNTIME_ONLY_CAPABILITY,
      ],
      ...(appVersion?.trim() ? { appVersion: appVersion.trim() } : {}),
    },
    auth: {
      kind: "paired",
      deviceId: credentials.deviceId,
      secret: credentials.secret,
      dpop: createDesktopSyncDpopProof(credentials),
    },
  };
}

export async function waitForSyncEnvelope(
  connection: SyncEnvelopeConnection,
  predicate: (envelope: ParsedSyncEnvelope) => boolean,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
): Promise<ParsedSyncEnvelope> {
  const normalizedTimeout = normalizeTimeout(timeoutMs, DEFAULT_AUTH_TIMEOUT_MS);
  return await new Promise<ParsedSyncEnvelope>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeEnvelope();
      removeError();
      removeClose();
      action();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for sync response after ${normalizedTimeout}ms.`)));
    }, normalizedTimeout);
    timer.unref?.();
    const removeEnvelope = connection.onEnvelope((envelope) => {
      if (predicate(envelope)) finish(() => resolve(envelope));
    });
    const removeError = connection.onError((error) => finish(() => reject(error)));
    const removeClose = connection.onClose(() => {
      finish(() => reject(new Error("Sync connection closed before the expected response arrived.")));
    });
  });
}

function helloError(payload: unknown): Error {
  const value = payload as Partial<SyncHelloErrorPayload> | null;
  const message = typeof value?.message === "string" && value.message.trim()
    ? value.message.trim()
    : "Sync authentication failed.";
  return new Error(message);
}

export async function openPairedSyncConnection(
  options: OpenPairedSyncConnectionOptions,
): Promise<AuthenticatedSyncConnection> {
  const connection = await openSyncEnvelopeConnection(options);
  const requestId = `hello-${randomUUID()}`;
  let response: Promise<ParsedSyncEnvelope> | null = null;
  try {
    const helloPayload = buildDesktopPairedHello(options.credentials, options.appVersion);
    response = waitForSyncEnvelope(
      connection,
      (envelope) => envelope.requestId === requestId
        && (envelope.type === "hello_ok" || envelope.type === "hello_error"),
      options.authTimeoutMs,
    );
    connection.send(
      "hello",
      helloPayload,
      requestId,
    );
    const envelope = await response;
    if (envelope.type === "hello_error") throw helloError(envelope.payload);
    const hello = envelope.payload as PairedRuntimeHelloOkPayload;
    const actualHostId = hello?.brain?.deviceId?.trim();
    const expectedHostId = options.credentials.hostIdentity.deviceId.trim();
    if (!actualHostId || actualHostId !== expectedHostId) {
      throw new Error(
        `Sync endpoint identity mismatch (expected ${expectedHostId || "unknown"}, received ${actualHostId || "unknown"}).`,
      );
    }
    return Object.assign(connection, {
      hello,
      credentials: options.credentials,
    });
  } catch (error) {
    void response?.catch(() => {});
    connection.close(1000, "Sync authentication failed.");
    throw error;
  }
}

export async function openSyncRuntimeTransport(
  options: OpenSyncRuntimeTransportOptions,
): Promise<SyncRuntimeTransport> {
  const endpoint = options.endpoint?.trim() || options.credentials.endpoints[0]?.trim();
  if (!endpoint) throw new Error("The paired machine has no sync endpoint.");
  const connection = await openPairedSyncConnection({ ...options, endpoint });
  if (connection.hello.features?.rpcChannel !== true) {
    connection.close(1000, "Runtime RPC is unavailable.");
    throw new Error("The paired machine does not advertise runtime RPC support.");
  }

  const id = channelId(options.channelId);
  const dataCallbacks = new Set<(chunk: Buffer) => void>();
  const errorCallbacks = new Set<(error: Error) => void>();
  const closeCallbacks = new Set<() => void>();
  let closed = false;
  let closeNotified = false;
  let removeEnvelope = () => {};
  let removeError = () => {};
  let removeClose = () => {};

  const notifyClose = (): void => {
    if (closeNotified) return;
    closeNotified = true;
    for (const callback of [...closeCallbacks]) {
      try {
        callback();
      } catch {
        // Continue notifying the remaining transport consumers.
      }
    }
  };
  const cleanup = (): void => {
    removeEnvelope();
    removeError();
    removeClose();
    removeEnvelope = () => {};
    removeError = () => {};
    removeClose = () => {};
  };
  const fail = (error: Error, closeConnection: boolean): void => {
    if (closed) return;
    closed = true;
    cleanup();
    emitCallbacks(errorCallbacks, error);
    notifyClose();
    if (closeConnection) connection.close(1000, "Runtime RPC channel closed.");
  };

  removeEnvelope = connection.onEnvelope((envelope) => {
    if (envelope.type !== "rpc_data" && envelope.type !== "rpc_close") return;
    const payload = envelope.payload as {
      channelId?: unknown;
      data?: unknown;
      reason?: unknown;
    };
    if (payload.channelId !== id) return;
    if (envelope.type === "rpc_close") {
      const reason = typeof payload.reason === "string" && payload.reason.trim()
        ? payload.reason.trim()
        : "Runtime RPC channel closed.";
      fail(new Error(reason), true);
      return;
    }
    const bytes = decodeStrictBase64(payload.data);
    if (!bytes) {
      fail(new Error("Runtime RPC channel received invalid base64 data."), false);
      connection.close(1003, "Invalid runtime RPC data.");
      return;
    }
    emitCallbacks(dataCallbacks, bytes);
  });
  removeError = connection.onError((error) => fail(error, true));
  removeClose = connection.onClose(() => {
    if (closed) return;
    closed = true;
    cleanup();
    notifyClose();
  });

  const transport: SyncRuntimeTransport = {
    channelId: id,
    connection,
    onData(callback) {
      dataCallbacks.add(callback);
    },
    onError(callback) {
      errorCallbacks.add(callback);
    },
    onClose(callback) {
      if (closeNotified) queueMicrotask(callback);
      else closeCallbacks.add(callback);
    },
    write(data) {
      if (closed) throw new Error("Runtime RPC channel is closed.");
      const bytes = Buffer.from(data, "utf8");
      for (let offset = 0; offset < bytes.byteLength; offset += RPC_DATA_CHUNK_BYTES) {
        connection.send("rpc_data", {
          channelId: id,
          data: bytes.subarray(
            offset,
            Math.min(bytes.byteLength, offset + RPC_DATA_CHUNK_BYTES),
          ).toString("base64"),
        });
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        connection.send("rpc_close", { channelId: id, reason: "Desktop RPC client closed." });
      } catch {
        // Closing the WebSocket below is sufficient when the frame cannot send.
      }
      cleanup();
      connection.close(1000, "Desktop RPC client closed.");
      notifyClose();
    },
  };

  try {
    connection.send("rpc_open", { channelId: id });
    return transport;
  } catch (error) {
    transport.close();
    throw error;
  }
}
