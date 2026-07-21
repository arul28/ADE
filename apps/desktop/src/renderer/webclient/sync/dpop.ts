import type { SyncDpopProof } from "../../../shared/types/sync";
import { randomHex } from "./ids";

const DPOP_CONTEXT = "ade-dpop-v1";
const RELAY_REAUTH_CONTEXT = "ade-relay-reauth-v1";
const P256_RAW_SIGNATURE_BYTES = 64;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === "function") return btoa(binary);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  throw new Error("No base64 encoder is available.");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function trimIntegerBytes(bytes: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < bytes.length - 1 && bytes[offset] === 0) offset += 1;
  let trimmed = bytes.slice(offset);
  if (trimmed[0] & 0x80) {
    const padded = new Uint8Array(trimmed.length + 1);
    padded.set(trimmed, 1);
    trimmed = padded;
  }
  return trimmed;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const parts: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    parts.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | parts.length, ...parts]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function rawEcdsaSignatureToDer(rawSignature: ArrayBuffer | Uint8Array): Uint8Array {
  const raw = rawSignature instanceof Uint8Array ? rawSignature : new Uint8Array(rawSignature);
  if (raw.length !== P256_RAW_SIGNATURE_BYTES) {
    throw new Error(`Expected a ${P256_RAW_SIGNATURE_BYTES}-byte P-256 ECDSA signature.`);
  }
  const r = trimIntegerBytes(raw.slice(0, 32));
  const s = trimIntegerBytes(raw.slice(32, 64));
  const body = concatBytes([
    new Uint8Array([0x02]),
    derLength(r.length),
    r,
    new Uint8Array([0x02]),
    derLength(s.length),
    s,
  ]);
  return concatBytes([new Uint8Array([0x30]), derLength(body.length), body]);
}

export function buildDpopChallenge(args: {
  deviceId: string;
  secretSha256Hex: string;
  timestamp: number;
  nonce: string;
}): string {
  return [
    DPOP_CONTEXT,
    args.deviceId,
    args.secretSha256Hex,
    String(Math.floor(args.timestamp)),
    args.nonce,
  ].join("\n");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(utf8Bytes(value)));
  return bytesToHex(new Uint8Array(digest));
}

export async function generateDpopKeyPair(options: { extractable?: boolean } = {}): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    options.extractable ?? false,
    ["sign"],
  );
}

export async function exportPublicKeyX963Base64(publicKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  return bytesToBase64(new Uint8Array(raw));
}

export async function signDpopProof(args: {
  privateKey: CryptoKey;
  publicKeyX963Base64: string;
  deviceId: string;
  secret: string;
  nowSeconds?: number;
  nonce?: string;
}): Promise<SyncDpopProof> {
  const timestamp = Math.floor(args.nowSeconds ?? Date.now() / 1000);
  const nonce = (args.nonce ?? randomHex(16)).slice(0, 128);
  const challenge = buildDpopChallenge({
    deviceId: args.deviceId,
    secretSha256Hex: await sha256Hex(args.secret),
    timestamp,
    nonce,
  });
  const rawSignature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    args.privateKey,
    toArrayBuffer(utf8Bytes(challenge)),
  );
  return {
    publicKey: args.publicKeyX963Base64,
    timestamp,
    nonce,
    signature: bytesToBase64(rawEcdsaSignatureToDer(rawSignature)),
  };
}

export async function signRelayReauthorizationProof(args: {
  privateKey: CryptoKey;
  deviceId: string;
  relayAccountToken: string;
  challenge: string;
  nowSeconds?: number;
  nonce?: string;
}): Promise<SyncDpopProof> {
  const timestamp = Math.floor(args.nowSeconds ?? Date.now() / 1_000);
  const nonce = (args.nonce ?? randomHex(16)).slice(0, 128);
  const canonical = [
    RELAY_REAUTH_CONTEXT,
    args.deviceId,
    await sha256Hex(args.relayAccountToken),
    args.challenge,
    String(timestamp),
    nonce,
  ].join("\n");
  const rawSignature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    args.privateKey,
    toArrayBuffer(utf8Bytes(canonical)),
  );
  return {
    timestamp,
    nonce,
    signature: bytesToBase64(rawEcdsaSignatureToDer(rawSignature)),
  };
}
