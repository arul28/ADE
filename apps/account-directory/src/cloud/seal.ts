import { logCloud, type CloudEnv } from "./store";

/**
 * The per-user seal for everything ADE Cloud keeps for a person: saved chats,
 * CLI and shell copies, Git summaries, fork capsules and queued messages.
 *
 * One random key per user, sealed with `CLOUD_CHAT_MASTER_KEY` and kept in
 * D1 (`cloud_user_keys`), apart from the data it seals. **Platform
 * encryption, not end-to-end**: whoever holds the Worker's secret can read
 * the data; a dump of the bucket or the database alone reveals nothing.
 * Each sealed value names what it is in its AES-GCM additional data, so a
 * value moved to another row or another user does not open.
 */

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function masterKey(env: Pick<CloudEnv, "CLOUD_CHAT_MASTER_KEY">): Promise<CryptoKey | null> {
  const raw = env.CLOUD_CHAT_MASTER_KEY?.trim();
  if (!raw) return null;
  // Exactly 32 bytes, base64: a weak or misshapen secret must be loud, as in the vault.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(raw);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** `v1.<iv>.<ciphertext+tag>`, both base64: for a D1 column. */
export async function sealText(key: CryptoKey, aad: string, value: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    value as Uint8Array<ArrayBuffer>,
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}

export async function openText(key: CryptoKey, aad: string, stored: string): Promise<Uint8Array | null> {
  const parts = stored.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parts[1]!), additionalData: encoder.encode(aad) },
      key,
      fromBase64(parts[2]!),
    );
    return new Uint8Array(opened);
  } catch {
    return null;
  }
}

/** `iv || ciphertext+tag`: for an R2 object. */
export async function sealBytes(key: CryptoKey, aad: string, value: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    value as Uint8Array<ArrayBuffer>,
  ));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return out;
}

export async function openBytes(key: CryptoKey, aad: string, stored: Uint8Array): Promise<Uint8Array | null> {
  if (stored.length <= 12) return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: stored.slice(0, 12), additionalData: encoder.encode(aad) },
      key,
      stored.slice(12),
    );
    return new Uint8Array(opened);
  } catch {
    return null;
  }
}

export type UserKeys = { aes: CryptoKey; mac: CryptoKey };

const userKeyAad = (userId: string): string => `ade.cloud.chat.user-key.v1\0${userId}`;

/** This user's key, made on first use. Null when `CLOUD_CHAT_MASTER_KEY` is missing or wrong. */
export async function userKeys(env: Pick<CloudEnv, "DB" | "CLOUD_CHAT_MASTER_KEY">, userId: string, now: number): Promise<UserKeys | null> {
  const master = await masterKey(env);
  if (!master) {
    logCloud("cloud.chat_key_unavailable", { userId });
    return null;
  }
  const read = () => env.DB.prepare("select sealed_key from cloud_user_keys where user_id = ?").bind(userId).first<{ sealed_key: string }>();
  let row = await read();
  if (!row) {
    // Insert first, then read back: two first writes race and both must use the winner.
    const fresh = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealText(master, userKeyAad(userId), fresh);
    await env.DB.prepare("insert or ignore into cloud_user_keys (user_id, sealed_key, created_at) values (?, ?, ?)").bind(userId, sealed, now).run();
    row = await read();
    if (!row) return null;
  }
  const raw = await openText(master, userKeyAad(userId), row.sealed_key);
  if (!raw || raw.length !== 32) {
    // A rotated or wrong master key: report it rather than treat the data as gone.
    logCloud("cloud.chat_key_unreadable", { userId });
    return null;
  }
  // Separate keys for sealing and for the part digest, from the one stored secret.
  const macMaterial = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...encoder.encode("ade.cloud.chat.mac.v1\0"), ...raw])));
  const [aes, mac] = await Promise.all([
    crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    crypto.subtle.importKey("raw", macMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ]);
  return { aes, mac };
}

/** An HMAC of `value` under the user's digest key, base64: equal values give equal digests. */
export async function digestFor(keys: UserKeys, value: Uint8Array): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", keys.mac, value as Uint8Array<ArrayBuffer>)));
}

/** Seals a JSON value for a D1 column. */
export async function sealJson(keys: UserKeys, aad: string, value: unknown): Promise<string> {
  return sealText(keys.aes, aad, encoder.encode(JSON.stringify(value)));
}

/** Opens a JSON value sealed with `sealJson`; undefined when it does not open or is not JSON. */
export async function openJson(keys: UserKeys, aad: string, stored: string | null): Promise<unknown> {
  if (!stored) return undefined;
  const opened = await openText(keys.aes, aad, stored);
  if (!opened) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(opened)) as unknown;
  } catch {
    return undefined;
  }
}
