// What a webhook request is, independent of where it came from: header and
// query normalization, body parsing, and the signature schemes ADE verifies
// (HMAC with a configurable header/prefix/encoding, and Stripe's `t=…,v1=…`).
// Pure functions; the service, the drain and Send test share them.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { AutomationWebhookSignatureConfig } from "../../../shared/types";

const STRIPE_TOLERANCE_SECONDS = 5 * 60;

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseJsonRecord(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function lowerCaseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

export function queryRecord(search: string | URLSearchParams): Record<string, string> {
  const params = typeof search === "string" ? new URLSearchParams(search.replace(/^\?/, "")) : search;
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

/**
 * JSON, form-encoded, or text. GitHub's form mode wraps the JSON in a
 * `payload` field; that is unwrapped so `{{trigger.body.*}}` reads the same
 * either way.
 */
export function parseWebhookBody(rawBody: Buffer, contentType: string | null): unknown {
  const text = rawBody.toString("utf8");
  if (!text.trim()) return {};
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded")) {
    const form = queryRecord(text);
    if (typeof form.payload === "string") {
      try {
        return JSON.parse(form.payload) as unknown;
      } catch {
        // Not JSON after all; keep the form.
      }
    }
    return form;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Returns null when valid, otherwise the outcome and one plain sentence. */
export function verifyWebhookSignature(args: {
  signature: AutomationWebhookSignatureConfig;
  secret: string;
  headers: Record<string, string>;
  rawBody: Buffer;
  /** Stripe timestamps are checked against when the request reached ADE. */
  receivedAtMs: number;
}): { outcome: "missing_signature" | "bad_signature"; detail: string } | null {
  const presented = args.headers[args.signature.header.toLowerCase()]?.trim() ?? "";
  if (!presented) {
    return { outcome: "missing_signature", detail: `The request had no ${args.signature.header} header, so ADE could not prove who sent it.` };
  }
  if (args.signature.scheme === "stripe") {
    const parts = presented.split(",").map((part) => part.trim());
    const timestamp = Number(parts.find((part) => part.startsWith("t="))?.slice(2));
    const candidates = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
    if (!Number.isFinite(timestamp) || !candidates.length) {
      return { outcome: "bad_signature", detail: "The Stripe-Signature header was not in Stripe's t=…,v1=… format." };
    }
    if (Math.abs(args.receivedAtMs / 1000 - timestamp) > STRIPE_TOLERANCE_SECONDS) {
      return { outcome: "bad_signature", detail: "The Stripe signature is more than 5 minutes old." };
    }
    const expected = createHmac("sha256", args.secret).update(`${timestamp}.`).update(args.rawBody).digest("hex");
    return candidates.some((candidate) => safeEqual(candidate, expected))
      ? null
      : { outcome: "bad_signature", detail: "The Stripe signature did not match. Check that the signing secret (whsec_…) is the one for this endpoint." };
  }
  const digest = createHmac("sha256", args.secret).update(args.rawBody).digest(args.signature.encoding === "base64" ? "base64" : "hex");
  const expected = `${args.signature.prefix ?? ""}${digest}`;
  return safeEqual(presented, expected)
    ? null
    : { outcome: "bad_signature", detail: `The ${args.signature.header} signature did not match. The secret saved in ADE is different from the one the sender uses.` };
}

/** Sign a body the way the configured sender would, for Send test. */
export function signWebhookBody(signature: AutomationWebhookSignatureConfig, secret: string, body: Buffer, nowMs = Date.now()): string {
  if (signature.scheme === "stripe") {
    const timestamp = Math.floor(nowMs / 1000);
    const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
    return `t=${timestamp},v1=${digest}`;
  }
  const digest = createHmac("sha256", secret).update(body).digest(signature.encoding === "base64" ? "base64" : "hex");
  return `${signature.prefix ?? ""}${digest}`;
}
