/**
 * Sealing for the GitHub App tokens and PKCE verifiers at rest.
 *
 * AES-256-GCM with `GITHUB_APP_TOKEN_KEY` (32 random bytes, base64). Each
 * value is `v1.<iv>.<ciphertext>` (base64url) and is bound by its additional
 * data to the row it belongs to, so a value copied to another account's row
 * does not open.
 */

const SEAL_VERSION = "v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedKey: { raw: string; key: CryptoKey } | null = null;

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/**
 * The sealing key, or null when the secret is missing or is not 32 bytes of
 * base64. Hashing whatever is set would accept a weak secret in silence; the
 * shape check makes a wrong value a clear 503 (the vault does the same).
 */
export async function tokenKey(raw: string | undefined): Promise<CryptoKey | null> {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (cachedKey?.raw === trimmed) return cachedKey.key;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(trimmed);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  cachedKey = { raw: trimmed, key };
  return key;
}

export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  );
  return `${SEAL_VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

/** Throws when the value is not ours, was moved to another row, or the key changed. */
export async function unseal(key: CryptoKey, sealed: string, aad: string): Promise<string> {
  const [version, iv, ciphertext, ...rest] = sealed.split(".");
  if (version !== SEAL_VERSION || !iv || !ciphertext || rest.length) throw new Error("github_app_seal_unreadable");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(iv), additionalData: encoder.encode(aad) },
    key,
    base64UrlToBytes(ciphertext),
  );
  return decoder.decode(plaintext);
}

/** The additional data of a grant's tokens: the ADE account id. */
export const grantAad = (userId: string, field: "access" | "refresh"): string => `ade.github-app.v1:${userId}:${field}`;
/** The additional data of a sign-in's PKCE verifier. */
export const signInAad = (signInId: string, userId: string): string => `ade.github-app.v1:sign-in:${signInId}:${userId}`;
/** The additional data of the tokens a sign-in holds while it waits for the person's confirmation. */
export const signInTokensAad = (signInId: string, userId: string): string => `ade.github-app.v1:sign-in-tokens:${signInId}:${userId}`;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export const randomBase64Url = (size: number): string => bytesToBase64Url(crypto.getRandomValues(new Uint8Array(size)));

export const randomHex = (size: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(size)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Equal-time compare of two strings of hex or base64url. */
export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}
