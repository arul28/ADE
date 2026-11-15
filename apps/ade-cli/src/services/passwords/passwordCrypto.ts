/**
 * Passwords: how one saved item is sealed and opened.
 *
 * Every item (a login, a secret) is encrypted on the device or cloud lane that
 * writes it, with AES-256-GCM under the account's vault key (the "DEK"). The
 * server only ever stores the sealed envelope, an item id, a revision and a
 * deleted flag: site names, usernames and passwords are all inside the
 * ciphertext.
 *
 * The additional data binds a sealed item to its account, its id and the
 * key epoch, so a row copied to another account or item, or replayed from
 * before a reset, fails to open instead of opening as the wrong thing.
 *
 * The vault key itself never touches this module's callers as raw bytes
 * beyond the store that caches it; see `passwordStore.ts`.
 */
import crypto from "node:crypto";

/** Bump only with a migration that re-seals every item. */
export const PASSWORD_ENVELOPE_VERSION = 1;
const AAD_PREFIX = "ade.passwords.v1";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type PasswordEnvelope = {
  v: typeof PASSWORD_ENVELOPE_VERSION;
  /** Which vault key sealed it; a reset starts a new epoch. */
  epoch: number;
  nonce: string;
  /** Ciphertext followed by the 16-byte GCM tag, base64. */
  ct: string;
};

export type PasswordItemBinding = {
  accountId: string;
  itemId: string;
  epoch: number;
};

function additionalData(binding: PasswordItemBinding): Buffer {
  // Newline-separated, with ids that can't contain a newline: no two
  // bindings produce the same bytes.
  for (const part of [binding.accountId, binding.itemId]) {
    if (!part || /[\n\r]/.test(part)) throw new Error("Invalid password item binding.");
  }
  if (!Number.isSafeInteger(binding.epoch) || binding.epoch < 1) throw new Error("Invalid password key epoch.");
  return Buffer.from(`${AAD_PREFIX}\n${binding.accountId}\n${binding.itemId}\n${binding.epoch}`, "utf8");
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error("Invalid password vault key.");
}


/** Seal one item's JSON. A fresh random nonce every time. */
export function sealPasswordItem(key: Buffer, binding: PasswordItemBinding, plaintext: unknown): PasswordEnvelope {
  assertKey(key);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(binding));
  const body = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { v: PASSWORD_ENVELOPE_VERSION, epoch: binding.epoch, nonce: nonce.toString("base64"), ct: body.toString("base64") };
}

/**
 * Open one item. Throws on any mismatch (wrong key, wrong account or item,
 * an older epoch, tampering), with a message that never quotes the content.
 */
export function openPasswordItem<T = unknown>(key: Buffer, binding: PasswordItemBinding, envelope: PasswordEnvelope): T {
  assertKey(key);
  if (!envelope || envelope.v !== PASSWORD_ENVELOPE_VERSION || envelope.epoch !== binding.epoch) {
    throw new Error("This saved item belongs to a different vault key.");
  }
  const nonce = Buffer.from(envelope.nonce, "base64");
  const body = Buffer.from(envelope.ct, "base64");
  if (nonce.length !== NONCE_BYTES || body.length <= TAG_BYTES) throw new Error("This saved item is damaged.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(additionalData(binding));
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error("This saved item could not be opened with this vault key.");
  }
  return JSON.parse(plain.toString("utf8")) as T;
}

/** Parse a stored envelope string, or null if it is not one. */
export function parsePasswordEnvelope(raw: string): PasswordEnvelope | null {
  try {
    const value = JSON.parse(raw) as Partial<PasswordEnvelope>;
    if (
      value
      && value.v === PASSWORD_ENVELOPE_VERSION
      && Number.isSafeInteger(value.epoch)
      && typeof value.nonce === "string"
      && typeof value.ct === "string"
    ) {
      return value as PasswordEnvelope;
    }
  } catch {
    // not an envelope
  }
  return null;
}

/**
 * A generated password for a new account: 20 characters from a set every
 * site accepts, with at least one of each class sites commonly require.
 */
export function generateSitePassword(length = 20): string {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "-_.!@#%";
  const all = lower + upper + digits + symbols;
  const pick = (set: string) => set[crypto.randomInt(set.length)]!;
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  while (chars.length < Math.max(12, length)) chars.push(pick(all));
  // Fisher–Yates with a CSPRNG, so the required classes are not always first.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}
