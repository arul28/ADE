import crypto from "node:crypto";

/**
 * Authenticator codes (TOTP, RFC 6238) for saved logins.
 *
 * A login keeps its authenticator as an `otpauth://totp/...` URI, the form
 * every authenticator app and password manager exports. A bare base32 key (what
 * a site shows under "can't scan the code?") is turned into one on save.
 */

export type TotpParams = {
  secret: Buffer;
  digits: 6 | 7 | 8;
  period: number;
  algorithm: "sha1" | "sha256" | "sha512";
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function decodeBase32(input: string): Buffer | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code parameters in an `otpauth://totp/` URI or a bare base32 key; null when it is neither. */
export function parseTotp(input: string): TotpParams | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^otpauth:\/\//i.test(trimmed)) {
    const secret = decodeBase32(trimmed);
    return secret && secret.length >= 10 ? { secret, digits: 6, period: 30, algorithm: "sha1" } : null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.host.toLowerCase() !== "totp") return null;
  const secret = decodeBase32(url.searchParams.get("secret") ?? "");
  if (!secret || secret.length < 10) return null;
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const period = Number(url.searchParams.get("period") ?? 30);
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase().replace("-", "");
  if (![6, 7, 8].includes(digits) || !Number.isInteger(period) || period < 5 || period > 300) return null;
  if (algorithm !== "sha1" && algorithm !== "sha256" && algorithm !== "sha512") return null;
  return { secret, digits: digits as 6 | 7 | 8, period, algorithm };
}

/** A normalized `otpauth://totp/` URI for what the person pasted, or null when it is not one. */
export function normalizeTotpInput(input: string, label: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^otpauth:\/\//i.test(trimmed)) return parseTotp(trimmed) ? trimmed : null;
  const params = parseTotp(trimmed);
  if (!params) return null;
  const secret = trimmed.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  return `otpauth://totp/${encodeURIComponent(label || "ADE")}?secret=${secret}`;
}

/** The code for a moment (now by default), and how many seconds it stays valid. */
export function totpCode(params: TotpParams, atMs: number = Date.now()): { code: string; secondsLeft: number } {
  const counter = Math.floor(atMs / 1000 / params.period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(params.algorithm, params.secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  const code = String(binary % 10 ** params.digits).padStart(params.digits, "0");
  const secondsLeft = params.period - (Math.floor(atMs / 1000) % params.period);
  return { code, secondsLeft };
}
