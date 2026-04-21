/**
 * Apple Push Notification service client for the desktop host.
 *
 * We talk HTTP/2 to APNs directly with `node:http2` + JWT signed via
 * `node:crypto` — this avoids a native dependency for what's otherwise a
 * thin wrapper. A `@parse/node-apn`-shaped transport can be swapped in via
 * the `transport` option; the unit tests exercise that seam with a mock.
 *
 * Key material is never written in plaintext: the `.p8` bytes are persisted
 * to `<userData>/apns.key.enc` via Electron `safeStorage.encryptString`.
 * Decrypted key lives in memory only while a notification is being signed.
 */

import { createSign, createPrivateKey, type KeyObject } from "node:crypto";
import * as http2 from "node:http2";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";

const APNS_HOST_PRODUCTION = "api.push.apple.com";
const APNS_HOST_SANDBOX = "api.sandbox.push.apple.com";
const APNS_PORT = 443;
/** APNs JWTs must be refreshed ~every hour (Apple enforces ≤60 min). */
const APNS_JWT_MAX_AGE_MS = 50 * 60 * 1000;
const APNS_REQUEST_TIMEOUT_MS = 30_000;

export type ApnsEnvironment = "sandbox" | "production";

export type ApnsPushType = "alert" | "liveactivity" | "background" | "voip";

export type ApnsPriority = 5 | 10;

export type ApnsEnvelope = {
  deviceToken: string;
  /** Per-device routing environment; falls back to service config when absent. */
  env?: ApnsEnvironment;
  pushType: ApnsPushType;
  /** `bundleId`, or `bundleId + .push-type.liveactivity` for Live Activities. */
  topic: string;
  priority: ApnsPriority;
  payload: Record<string, unknown>;
  /** Used by APNs for de-duplication of rapid updates for the same entity. */
  collapseId?: string;
  /** Apple's `apns-expiration` header value (epoch seconds). `0` = drop if undeliverable. */
  expirationEpochSeconds?: number;
};

export type ApnsConfigureOptions = {
  keyP8Pem: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  env: ApnsEnvironment;
};

export type ApnsSendResult = {
  ok: boolean;
  status: number;
  reason?: string;
  apnsId?: string | null;
  timestamp?: number;
};

/**
 * APNs rejection codes that mean the token is dead and should be purged.
 * See https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
 */
export const APNS_INVALID_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
]);

export type ApnsTokenInvalidatedEvent = {
  deviceToken: string;
  reason: string;
  timestampMs: number;
};

/**
 * Minimal HTTP transport seam. The default implementation hits `api.push.apple.com`
 * over HTTP/2; tests inject a mock that records requests and returns canned responses.
 */
export interface ApnsTransport {
  send(args: {
    host: string;
    headers: Record<string, string | number>;
    path: string;
    body: Buffer;
  }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>;
  close(): Promise<void>;
}

export class Http2ApnsTransport implements ApnsTransport {
  private sessions = new Map<string, http2.ClientHttp2Session>();

  private getSession(host: string): http2.ClientHttp2Session {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(`https://${host}:${APNS_PORT}`);
    session.on("error", () => {
      this.sessions.delete(host);
    });
    session.on("close", () => {
      this.sessions.delete(host);
    });
    this.sessions.set(host, session);
    return session;
  }

  send(args: {
    host: string;
    headers: Record<string, string | number>;
    path: string;
    body: Buffer;
  }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((resolve, reject) => {
      const session = this.getSession(args.host);
      const req = session.request({
        ...args.headers,
        ":method": "POST",
        ":path": args.path,
      });
      req.setEncoding("utf8");
      let status = 0;
      let responseHeaders: Record<string, string | string[] | undefined> = {};
      const chunks: string[] = [];
      let settled = false;
      const resolveOnce = (value: { status: number; headers: Record<string, string | string[] | undefined>; body: string }) => {
        if (settled) return;
        settled = true;
        req.setTimeout(0);
        resolve(value);
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        req.setTimeout(0);
        reject(error);
      };
      req.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => {
        rejectOnce(new Error(`APNs request timed out after ${APNS_REQUEST_TIMEOUT_MS}ms`));
        req.close(http2.constants.NGHTTP2_CANCEL);
      });
      req.on("response", (headers) => {
        status = Number(headers[":status"]) || 0;
        responseHeaders = headers as Record<string, string | string[] | undefined>;
      });
      req.on("data", (chunk: string) => chunks.push(chunk));
      req.on("end", () => {
        resolveOnce({ status, headers: responseHeaders, body: chunks.join("") });
      });
      req.on("error", (error) => rejectOnce(error));
      req.end(args.body);
    });
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.close();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }
}

type JwtCacheEntry = {
  token: string;
  mintedAtMs: number;
};

type KeyStoreArgs = {
  /**
   * Absolute path where the encrypted `.p8` lives, e.g.
   * `app.getPath("userData")/apns.key.enc`.
   */
  encryptedKeyPath: string;
  /**
   * Electron's `safeStorage` bindings, passed via the service graph so
   * the module remains unit-testable without spinning up Electron.
   */
  safeStorage?: {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(buffer: Buffer): string;
  };
};

export class ApnsKeyStore {
  constructor(private readonly args: KeyStoreArgs) {}

  save(p8Pem: string): void {
    if (!this.args.safeStorage || !this.args.safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage is unavailable; refusing to persist .p8 in plaintext.");
    }
    fs.mkdirSync(path.dirname(this.args.encryptedKeyPath), { recursive: true });
    const encrypted = this.args.safeStorage.encryptString(p8Pem);
    fs.writeFileSync(this.args.encryptedKeyPath, encrypted, { mode: 0o600 });
  }

  load(): string | null {
    if (!fs.existsSync(this.args.encryptedKeyPath)) return null;
    if (!this.args.safeStorage || !this.args.safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage is unavailable; cannot decrypt .p8.");
    }
    const encrypted = fs.readFileSync(this.args.encryptedKeyPath);
    return this.args.safeStorage.decryptString(encrypted);
  }

  clear(): void {
    if (fs.existsSync(this.args.encryptedKeyPath)) {
      fs.rmSync(this.args.encryptedKeyPath);
    }
  }

  has(): boolean {
    return fs.existsSync(this.args.encryptedKeyPath);
  }
}

export type ApnsServiceArgs = {
  logger: Logger;
  transport?: ApnsTransport;
  /** Injectable clock for tests. */
  now?: () => number;
};

/**
 * Signs a JWT for the APNs provider token auth flow.
 *
 * APNs accepts an ES256-signed JWT where:
 *   header  = { alg: "ES256", kid: <keyId> }
 *   claims  = { iss: <teamId>, iat: <unix> }
 */
export function signApnsJwt(args: {
  keyPem: string;
  keyId: string;
  teamId: string;
  issuedAtSeconds: number;
}): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: args.keyId }));
  const claims = base64UrlEncode(
    JSON.stringify({ iss: args.teamId, iat: args.issuedAtSeconds }),
  );
  const signingInput = `${header}.${claims}`;
  let keyObject: KeyObject;
  try {
    keyObject = createPrivateKey(args.keyPem);
  } catch (error) {
    throw new Error(`Invalid APNs .p8 key: ${error instanceof Error ? error.message : String(error)}`);
  }
  const signer = createSign("sha256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: keyObject, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64UrlEncodeBuffer(signature)}`;
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBuffer(Buffer.from(value, "utf8"));
}

function base64UrlEncodeBuffer(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class ApnsService extends EventEmitter {
  private readonly logger: Logger;
  private readonly transport: ApnsTransport;
  private readonly now: () => number;
  private config: ApnsConfigureOptions | null = null;
  private jwt: JwtCacheEntry | null = null;

  constructor(args: ApnsServiceArgs) {
    super();
    this.logger = args.logger;
    this.transport = args.transport ?? new Http2ApnsTransport();
    this.now = args.now ?? (() => Date.now());
  }

  /** Load key + metadata; throws on malformed input. */
  configure(options: ApnsConfigureOptions): void {
    if (!options.keyP8Pem.trim()) throw new Error("APNs .p8 PEM must not be empty.");
    if (!/^\w{10}$/.test(options.keyId)) throw new Error("APNs keyId must be 10 alphanumerics.");
    if (!/^\w{10}$/.test(options.teamId)) throw new Error("APNs teamId must be 10 alphanumerics.");
    if (!options.bundleId.trim()) throw new Error("APNs bundleId must not be empty.");
    // Probe that the PEM actually parses now so we fail fast instead of at first send.
    createPrivateKey(options.keyP8Pem);
    this.config = options;
    this.jwt = null;
  }

  isConfigured(): boolean {
    return this.config != null;
  }

  async reset(): Promise<void> {
    this.config = null;
    this.jwt = null;
    await this.transport.close().catch(() => {});
  }

  onTokenInvalidated(listener: (event: ApnsTokenInvalidatedEvent) => void): () => void {
    this.on("tokenInvalidated", listener);
    return () => this.off("tokenInvalidated", listener);
  }

  /** Build and send a single push envelope. */
  async send(envelope: ApnsEnvelope): Promise<ApnsSendResult> {
    if (!this.config) {
      throw new Error("ApnsService is not configured. Call configure() first.");
    }
    const env = envelope.env ?? this.config.env;
    const host = env === "production" ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
    const body = Buffer.from(JSON.stringify(envelope.payload), "utf8");
    const sendOnce = async (jwt: string) => {
      const headers: Record<string, string | number> = {
        authorization: `bearer ${jwt}`,
        "apns-topic": envelope.topic,
        "apns-push-type": envelope.pushType,
        "apns-priority": envelope.priority,
      };
      if (envelope.collapseId) headers["apns-collapse-id"] = envelope.collapseId;
      if (typeof envelope.expirationEpochSeconds === "number") {
        headers["apns-expiration"] = envelope.expirationEpochSeconds;
      }
      return await this.transport.send({
        host,
        headers,
        path: `/3/device/${envelope.deviceToken}`,
        body,
      });
    };
    let status = 0;
    let rawBody = "";
    let responseHeaders: Record<string, string | string[] | undefined> = {};
    try {
      let response = await sendOnce(this.mintJwtIfStale());
      status = response.status;
      rawBody = response.body;
      responseHeaders = response.headers;
      if (status !== 200 && parseApnsReason(rawBody) === "ExpiredProviderToken") {
        this.jwt = null;
        response = await sendOnce(this.mintJwtIfStale());
        status = response.status;
        rawBody = response.body;
        responseHeaders = response.headers;
      }
    } catch (error) {
      this.logger.warn("apns.transport_error", {
        error: error instanceof Error ? error.message : String(error),
        host,
        // NEVER log envelope.deviceToken or payload verbatim.
      });
      return { ok: false, status: 0, reason: "TransportError" };
    }

    if (status === 200) {
      return {
        ok: true,
        status,
        apnsId: stringHeader(responseHeaders["apns-id"]) ?? null,
      };
    }
    const reason = parseApnsReason(rawBody);
    const timestamp = parseApnsTimestamp(rawBody);
    if (reason && APNS_INVALID_TOKEN_REASONS.has(reason)) {
      this.emit("tokenInvalidated", {
        deviceToken: envelope.deviceToken,
        reason,
        timestampMs: this.now(),
      } satisfies ApnsTokenInvalidatedEvent);
    }
    if (reason === "ExpiredProviderToken") {
      // The retry above still failed; force a re-mint on the next send too.
      this.jwt = null;
    }
    this.logger.warn("apns.push_rejected", {
      status,
      reason: reason ?? null,
      apnsId: stringHeader(responseHeaders["apns-id"]) ?? null,
      host,
    });
    return { ok: false, status, reason: reason ?? undefined, timestamp };
  }

  /** Explicit teardown; called from main.ts on quit. */
  async dispose(): Promise<void> {
    await this.reset();
    this.removeAllListeners();
  }

  private mintJwtIfStale(): string {
    const config = this.config;
    if (!config) throw new Error("ApnsService not configured.");
    const now = this.now();
    if (this.jwt && now - this.jwt.mintedAtMs < APNS_JWT_MAX_AGE_MS) {
      return this.jwt.token;
    }
    const issuedAtSeconds = Math.floor(now / 1000);
    const token = signApnsJwt({
      keyPem: config.keyP8Pem,
      keyId: config.keyId,
      teamId: config.teamId,
      issuedAtSeconds,
    });
    this.jwt = { token, mintedAtMs: now };
    return token;
  }
}

function parseApnsReason(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

function parseApnsTimestamp(body: string): number | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { timestamp?: unknown };
    return typeof parsed.timestamp === "number" ? parsed.timestamp : undefined;
  } catch {
    return undefined;
  }
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
