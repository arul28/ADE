import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export const ADOPT_CHANNEL_CONTEXT = "ade-adopt-v1";
export const ADOPT_CHANNEL_HELLO_OK_CONTEXT = "ade-adopt-v1-hellook";
export const ADOPT_CHANNEL_CHALLENGE_TTL_MS = 60_000;
export const ADOPT_CHANNEL_MAX_CLOCK_SKEW_MS = 120_000;
export const ADOPT_CHANNEL_CHALLENGE_TIMEOUT_MS = 3_000;
export const ADOPT_CHANNEL_NONCE_BYTES = 32;
export const ADOPT_CHANNEL_KEY_BYTES = 32;
export const ADOPT_CHANNEL_AEAD_NONCE_BYTES = 12;
export const ADOPT_CHANNEL_PUBLIC_KEY_BYTES = 32;

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const AEAD_TAG_BYTES = 16;

function assertLength(value: Buffer, expected: number, label: string): void {
  if (value.byteLength !== expected) {
    throw new Error(`${label} must be exactly ${expected} bytes.`);
  }
}

function publicKeyFromRaw(prefix: Buffer, raw: Buffer, label: string): KeyObject {
  assertLength(raw, ADOPT_CHANNEL_PUBLIC_KEY_BYTES, label);
  return createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "spki",
  });
}

export function rawPublicKeyFromSpki(key: KeyObject): Buffer {
  const spki = key.export({ format: "der", type: "spki" });
  if (spki.byteLength < ADOPT_CHANNEL_PUBLIC_KEY_BYTES) {
    throw new Error("Public key SPKI export is malformed.");
  }
  return Buffer.from(spki.subarray(spki.byteLength - ADOPT_CHANNEL_PUBLIC_KEY_BYTES));
}

export function generateX25519EphemeralKeyPair(): {
  privateKey: KeyObject;
  publicKeyRaw: Buffer;
} {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    privateKey,
    publicKeyRaw: rawPublicKeyFromSpki(publicKey),
  };
}

export function decodeCanonicalBase64(
  value: unknown,
  expectedBytes?: number,
): Buffer | null {
  if (typeof value !== "string" || !value) return null;
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value
    || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
  ) {
    return null;
  }
  return decoded;
}

export function buildAdoptChallengeSignatureInput(args: {
  hostDeviceId: string;
  nonce: string;
  clientEphemeralPublicKey: string;
  hostEphemeralPublicKey: string;
  ts: number;
}): string {
  return [
    ADOPT_CHANNEL_CONTEXT,
    args.hostDeviceId,
    args.nonce,
    args.clientEphemeralPublicKey,
    args.hostEphemeralPublicKey,
    String(args.ts),
  ].join("|");
}

export function buildAdoptHelloAad(
  hostDeviceId: string,
  clientDeviceId: string,
): Buffer {
  return Buffer.from(
    `${ADOPT_CHANNEL_CONTEXT}|${hostDeviceId}|${clientDeviceId}`,
    "utf8",
  );
}

export function buildAdoptHelloOkAad(
  hostDeviceId: string,
  clientDeviceId: string,
): Buffer {
  return Buffer.from(
    `${ADOPT_CHANNEL_HELLO_OK_CONTEXT}|${hostDeviceId}|${clientDeviceId}`,
    "utf8",
  );
}

export function deriveAdoptSessionKey(args: {
  privateKey: KeyObject;
  peerPublicKeyRaw: Buffer;
  nonce: Buffer;
}): Buffer {
  assertLength(args.peerPublicKeyRaw, ADOPT_CHANNEL_PUBLIC_KEY_BYTES, "X25519 public key");
  assertLength(args.nonce, ADOPT_CHANNEL_NONCE_BYTES, "Adoption nonce");
  const sharedSecret = diffieHellman({
    privateKey: args.privateKey,
    publicKey: publicKeyFromRaw(
      X25519_SPKI_PREFIX,
      args.peerPublicKeyRaw,
      "X25519 public key",
    ),
  });
  return Buffer.from(hkdfSync(
    "sha256",
    sharedSecret,
    args.nonce,
    Buffer.from(ADOPT_CHANNEL_CONTEXT, "utf8"),
    ADOPT_CHANNEL_KEY_BYTES,
  ));
}

export function seal(
  key: Buffer,
  aad: Buffer,
  plaintext: Buffer,
  nonce: Buffer = randomBytes(ADOPT_CHANNEL_AEAD_NONCE_BYTES),
): string {
  assertLength(key, ADOPT_CHANNEL_KEY_BYTES, "Adoption session key");
  assertLength(nonce, ADOPT_CHANNEL_AEAD_NONCE_BYTES, "AEAD nonce");
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: AEAD_TAG_BYTES,
  });
  cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
}

export function unseal(
  key: Buffer,
  aad: Buffer,
  blobBase64: string,
): Buffer {
  assertLength(key, ADOPT_CHANNEL_KEY_BYTES, "Adoption session key");
  const blob = decodeCanonicalBase64(blobBase64);
  if (
    !blob
    || blob.byteLength < ADOPT_CHANNEL_AEAD_NONCE_BYTES + AEAD_TAG_BYTES
  ) {
    throw new Error("Sealed adoption payload is malformed.");
  }
  const nonce = blob.subarray(0, ADOPT_CHANNEL_AEAD_NONCE_BYTES);
  const tag = blob.subarray(blob.byteLength - AEAD_TAG_BYTES);
  const ciphertext = blob.subarray(
    ADOPT_CHANNEL_AEAD_NONCE_BYTES,
    blob.byteLength - AEAD_TAG_BYTES,
  );
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: AEAD_TAG_BYTES,
  });
  decipher.setAAD(aad, { plaintextLength: ciphertext.byteLength });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function signEd25519(
  privateKey: KeyObject | Buffer,
  message: Buffer | string,
): Buffer {
  const key = Buffer.isBuffer(privateKey)
    ? createPrivateKey({ key: privateKey, format: "der", type: "pkcs8" })
    : privateKey;
  return sign(null, typeof message === "string" ? Buffer.from(message, "utf8") : message, key);
}

export function verifyEd25519(
  publicKeyRaw: Buffer,
  message: Buffer | string,
  signature: Buffer,
): boolean {
  try {
    return verify(
      null,
      typeof message === "string" ? Buffer.from(message, "utf8") : message,
      publicKeyFromRaw(ED25519_SPKI_PREFIX, publicKeyRaw, "Ed25519 public key"),
      signature,
    );
  } catch {
    return false;
  }
}
