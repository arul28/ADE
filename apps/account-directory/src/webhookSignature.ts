/**
 * Standard Webhooks (what Svix sends, for Clerk and for the cloud provider):
 * HMAC-SHA256 over `{id}.{timestamp}.{body}`, keyed with the base64-decoded
 * secret after `whsec_`, compared in constant time with each `v1,<base64>` in
 * the signature header (space separated, so a key rotation can send two). The
 * timestamp must lie within five minutes of now.
 */

/** Svix's own replay window. */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

const textEncoder = new TextEncoder();

/** `secret_unreadable`: the configured secret isn't base64 (a setup mistake, not a forged delivery). */
export type WebhookSignatureCheck = "valid" | "invalid" | "secret_unreadable";

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function verifyWebhookSignature(args: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
  signatureHeader: string;
  nowSeconds: number;
}): Promise<WebhookSignatureCheck> {
  const timestamp = Number(args.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(args.nowSeconds - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
    return "invalid";
  }
  const keyBytes = base64ToBytes(args.secret.trim().replace(/^whsec_/, ""));
  if (!keyBytes || keyBytes.length === 0) return "secret_unreadable";
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = bytesToBase64(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(`${args.id}.${args.timestamp}.${args.body}`)),
  );
  let matched = false;
  for (const entry of args.signatureHeader.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    // Every candidate is compared, so the time taken never says which one matched.
    if (constantTimeEqual(entry.slice(comma + 1), expected)) matched = true;
  }
  return matched ? "valid" : "invalid";
}
