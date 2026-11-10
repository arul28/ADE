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
  /** The computer that renewed this copy last; `cloud` when it was an ADE Cloud computer that took the renewal over (step 3b). */
  renewedBy: { machineKey: string; label: string; cloud?: boolean } | null;
  expiresAt: number | null;
  familyHash: string;
  /**
   * The family hashes this sign-in had before `familyHash`, newest first, at
   * most `PROVIDER_LOGIN_LINEAGE_MAX`, since the last new sign-in. A refresh
   * token that rotates on each renewal changes the family; the lineage says
   * the new copy still comes from the same sign-in (the write-back, step 3b).
   */
  lineage?: string[];
  /**
   * The family the origin's login file held when a cloud computer took the
   * renewal over (step 3c). Kept for as long as cloud computers renew the
   * sign-in, outside the lineage's window, so the origin writes back after a
   * takeover of any length. The origin's claim back and its own next push
   * clear it.
   */
  takenFrom?: string;
  contentHash: string;
  files: CarriedFile[];
  parts?: Record<string, unknown>;
};

/** What `status` may know about an item: everything but the login. */
export type ProviderLoginPayloadMeta = Omit<ProviderLoginPayload, "files" | "parts" | "familyHash" | "contentHash" | "lineage" | "takenFrom">;

/** How many earlier family hashes a payload keeps: about 4 days of Grok renewals (one each ~6 h), 16 x 17 characters. */
export const PROVIDER_LOGIN_LINEAGE_MAX = 16;

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
  previous: ProviderLoginPayloadMeta & { familyHash: string; lineage?: string[]; takenFrom?: string | null } | null;
  now: number;
  /**
   * This computer renewed the sign-in another computer made (a cloud
   * computer that took the renewal over, step 3b): the origin stays the
   * previous one, and a new family is a renewal, not a new sign-in.
   */
  renewal?: { cloud: boolean } | null;
}): ProviderLoginPayload {
  const familyHash = shortHash(args.login.familySecret);
  const previous = args.previous;
  const sameFamily = previous?.familyHash === familyHash;
  const renewal = Boolean(previous && (sameFamily || args.renewal));
  const lineage = renewal && previous
    ? [...new Set([previous.familyHash, ...(previous.lineage ?? [])])].filter((hash) => hash && hash !== familyHash).slice(0, PROVIDER_LOGIN_LINEAGE_MAX)
    : [];
  const origin = args.renewal && previous?.origin.machineKey ? previous.origin : args.machine;
  // A cloud computer's renewal keeps the family the takeover started from (the
  // first takeover push takes the previous family); any other push drops it.
  const takenFrom = args.renewal?.cloud && previous ? previous.takenFrom || previous.familyHash : "";
  return {
    v: 1,
    provider: args.provider,
    slot: args.login.slot,
    class: args.login.class,
    origin: { machineKey: origin.machineKey, deviceId: origin.deviceId, label: origin.label, platform: origin.platform },
    account: args.login.account,
    // A new family is a new sign-in; the same family changed (or a takeover's renewal) is a renewal.
    capturedAt: renewal ? previous!.capturedAt : args.now,
    renewedAt: renewal ? args.now : null,
    renewedBy: renewal
      ? { machineKey: args.machine.machineKey, label: args.machine.label, ...(args.renewal?.cloud ? { cloud: true } : {}) }
      : null,
    expiresAt: args.login.expiresAt,
    familyHash,
    ...(lineage.length ? { lineage } : {}),
    ...(takenFrom && takenFrom !== familyHash ? { takenFrom } : {}),
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
export function readProviderLoginMeta(value: string | null): (ProviderLoginPayloadMeta & { familyHash: string; contentHash: string; lineage: string[]; takenFrom: string | null }) | null {
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
    renewedBy: renewedBy
      ? { machineKey: stringOr(renewedBy.machineKey, ""), label: stringOr(renewedBy.label, ""), ...(renewedBy.cloud === true ? { cloud: true } : {}) }
      : null,
    expiresAt: numberOrNull(parsed.expiresAt),
    familyHash: stringOr(parsed.familyHash, ""),
    lineage: Array.isArray(parsed.lineage)
      ? parsed.lineage.filter((hash): hash is string => typeof hash === "string" && /^[0-9a-f]{16}$/.test(hash)).slice(0, PROVIDER_LOGIN_LINEAGE_MAX)
      : [],
    takenFrom: typeof parsed.takenFrom === "string" && /^[0-9a-f]{16}$/.test(parsed.takenFrom) ? parsed.takenFrom : null,
    contentHash: stringOr(parsed.contentHash, ""),
  };
}

/** The same stored value without `takenFrom`: what the origin's claim back writes (step 3c). Null when there is nothing to drop. */
export function withoutTakenFrom(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.takenFrom === undefined) return null;
    const { takenFrom: _dropped, ...rest } = parsed;
    return JSON.stringify(rest);
  } catch {
    return null;
  }
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
