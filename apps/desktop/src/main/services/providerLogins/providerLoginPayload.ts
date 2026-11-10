/**
 * The vault item of one sign-in: its key, its value (payload v1), and the
 * hashes that compare two copies without keeping either.
 *
 * Key: `<provider>/<origin12>.<slot>`. `origin12` is the first 12 hex of
 * sha256(machineKey), so the key names the computer without naming it, and a
 * new sign-in or a renewal on the same computer writes the same key. Keys
 * never grow with time.
 */

import crypto from "node:crypto";

import { isProviderLoginProvider, type ProviderLoginClass, type ProviderLoginProvider } from "../../../shared/types/providerLogins";
import { isRecord } from "../shared/utils";
import type { CarriedFile, ParsedLogin } from "./providerLoginCarry";

export const PROVIDER_LOGIN_VAULT_KIND = "provider_login" as const;
/** The relay's limit for this kind (push-relay `accountVault.ts`). */
export const PROVIDER_LOGIN_MAX_CHARS = 16_000;

export type ProviderLoginMachine = { machineKey: string; deviceId: string; label: string; platform: string };

export type ProviderLoginPayload = {
  v: 1;
  provider: ProviderLoginProvider;
  slot: string;
  class: ProviderLoginClass;
  origin: { machineKey: string; deviceId: string; label: string; platform: string };
  account: { email: string | null; id: string | null } | null;
  capturedAt: number;
  renewedAt: number | null;
  renewedBy: { machineKey: string; label: string } | null;
  expiresAt: number | null;
  familyHash: string;
  contentHash: string;
  files: CarriedFile[];
  parts?: Record<string, unknown>;
};

/** What `status` may know about an item: everything but the login. */
export type ProviderLoginPayloadMeta = Omit<ProviderLoginPayload, "files" | "parts" | "familyHash" | "contentHash">;

/** 16 hex of SHA-256: enough to compare, nothing to recover a token from. */
export function shortHash(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function originId(machineKey: string): string {
  return crypto.createHash("sha256").update(machineKey).digest("hex").slice(0, 12);
}

export function providerLoginKey(provider: ProviderLoginProvider, origin12: string, slot: string): string {
  return `${provider}/${origin12}.${slot}`;
}

export function parseProviderLoginKey(key: string): { provider: ProviderLoginProvider; origin12: string; slot: string } | null {
  const match = /^([a-z]+)\/([0-9a-f]{12})\.([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(key);
  if (!match || !isProviderLoginProvider(match[1])) return null;
  return { provider: match[1], origin12: match[2]!, slot: match[3]! };
}

/** The hash of what would be written on another computer: files and parts, in a fixed order. */
export function loginContentHash(login: Pick<ParsedLogin, "files" | "parts">): string {
  const files = [...login.files]
    .sort((left, right) => `${left.root}/${left.rel}`.localeCompare(`${right.root}/${right.rel}`))
    .map((entry) => [entry.root, entry.rel, entry.enc, entry.data]);
  return shortHash(JSON.stringify({ files, parts: login.parts ?? null }));
}

export function buildProviderLoginPayload(args: {
  provider: ProviderLoginProvider;
  login: ParsedLogin;
  machine: ProviderLoginMachine;
  previous: ProviderLoginPayloadMeta & { familyHash: string } | null;
  now: number;
}): ProviderLoginPayload {
  const familyHash = shortHash(args.login.familySecret);
  const sameFamily = args.previous?.familyHash === familyHash;
  return {
    v: 1,
    provider: args.provider,
    slot: args.login.slot,
    class: args.login.class,
    origin: { machineKey: args.machine.machineKey, deviceId: args.machine.deviceId, label: args.machine.label, platform: args.machine.platform },
    account: args.login.account,
    // A new family is a new sign-in; the same family changed is a renewal.
    capturedAt: sameFamily ? args.previous!.capturedAt : args.now,
    renewedAt: sameFamily ? args.now : null,
    renewedBy: sameFamily ? { machineKey: args.machine.machineKey, label: args.machine.label } : null,
    expiresAt: args.login.expiresAt,
    familyHash,
    contentHash: loginContentHash(args.login),
    files: args.login.files,
    ...(args.login.parts ? { parts: args.login.parts } : {}),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * The parts of a stored value that are not the login, or null for a value
 * that is not payload v1. The login itself is dropped here, before the
 * result reaches any caller.
 */
export function readProviderLoginMeta(value: string | null): (ProviderLoginPayloadMeta & { familyHash: string; contentHash: string }) | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isProviderLoginProvider(parsed.provider)) return null;
  const origin = isRecord(parsed.origin) ? parsed.origin : {};
  const account = isRecord(parsed.account) ? parsed.account : null;
  const renewedBy = isRecord(parsed.renewedBy) ? parsed.renewedBy : null;
  return {
    v: 1,
    provider: parsed.provider,
    slot: stringOr(parsed.slot, "base"),
    class: parsed.class === "renewing" ? "renewing" : "fixed",
    origin: {
      machineKey: stringOr(origin.machineKey, ""),
      deviceId: stringOr(origin.deviceId, ""),
      label: stringOr(origin.label, ""),
      platform: stringOr(origin.platform, ""),
    },
    account: account
      ? { email: typeof account.email === "string" ? account.email : null, id: typeof account.id === "string" ? account.id : null }
      : null,
    capturedAt: numberOrNull(parsed.capturedAt) ?? 0,
    renewedAt: numberOrNull(parsed.renewedAt),
    renewedBy: renewedBy ? { machineKey: stringOr(renewedBy.machineKey, ""), label: stringOr(renewedBy.label, "") } : null,
    expiresAt: numberOrNull(parsed.expiresAt),
    familyHash: stringOr(parsed.familyHash, ""),
    contentHash: stringOr(parsed.contentHash, ""),
  };
}

/**
 * The whole stored value, login included, for apply on a cloud computer
 * (P5 step 2), or null for a value that is not payload v1. Only apply reads
 * this; it never reaches a status, a log or an action result.
 */
export function readProviderLoginPayload(value: string | null): (ReturnType<typeof readProviderLoginMeta> & object & {
  files: CarriedFile[];
  parts: Record<string, unknown> | null;
}) | null {
  const meta = readProviderLoginMeta(value);
  if (!meta || !value) return null;
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const files: CarriedFile[] = [];
  for (const entry of Array.isArray(parsed.files) ? parsed.files : []) {
    if (!isRecord(entry)) return null;
    if (typeof entry.root !== "string" || typeof entry.rel !== "string" || typeof entry.data !== "string") return null;
    if (entry.enc !== "utf8" && entry.enc !== "base64") return null;
    files.push({ root: entry.root as CarriedFile["root"], rel: entry.rel, enc: entry.enc, data: entry.data });
  }
  return { ...meta, files, parts: isRecord(parsed.parts) ? parsed.parts : null };
}

/** The bytes of one carried file. */
export function carriedFileBytes(file: CarriedFile): Buffer {
  return file.enc === "base64" ? Buffer.from(file.data, "base64") : Buffer.from(file.data, "utf8");
}
