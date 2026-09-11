/**
 * providerAccountIdentity.ts
 *
 * Which account the live quota numbers belong to.
 *
 * A quota card that says "Claude · 78% of the weekly window" is ambiguous the
 * moment a machine has ever been signed into two accounts: the number is real,
 * but the reader cannot tell whose limit it is. The email is the only identity
 * both providers expose locally, so the poller stamps it onto the per-provider
 * status and every client (desktop, iOS, web) renders the same line.
 *
 * Nothing here reads or returns a token. Codex's `auth.json` holds an OIDC
 * `id_token` whose payload carries `email`; we decode the payload (base64url,
 * no signature check — we are reading a file we already trust, not accepting a
 * bearer assertion) and keep only the address. Claude's credential file has no
 * email at all; the CLI records the signed-in account in `.claude.json` under
 * `oauthAccount.emailAddress`, which is plain config, not a secret.
 *
 * Windows/Linux parity: every path comes from `os.homedir()` (or the provider's
 * own env override) and no branch depends on the macOS Keychain. Claude's
 * Keychain item holds credentials only — never an email — so there is nothing
 * platform-specific to fall back from. Unknown stays `undefined` rather than
 * being guessed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageProvider } from "../../../shared/types";
import { isRecord, safeJsonParse } from "../shared/utils";

/** What a provider's local config says about the signed-in account. */
export type ProviderAccountIdentity = {
  email?: string;
  /** Subscription label, e.g. "ChatGPT Pro" / "Claude Max". Absent when unknown. */
  plan?: string;
};

/**
 * What one resolve pass learned about every provider it can read.
 *
 * `identities` holds every provider with an identity to show, including one
 * carried over from the last successful read when this pass could not read the
 * config. `unreadable` marks those carried-over providers, for callers that
 * want to report the read failure itself. A provider in neither map is
 * authoritatively signed out, and its account line must be cleared rather than
 * carried forward forever — that clearing is already done here, so callers are
 * plain reads of `identities`.
 */
export type ProviderAccountResolution = {
  identities: Partial<Record<UsageProvider, ProviderAccountIdentity>>;
  unreadable: Partial<Record<UsageProvider, boolean>>;
};

/** Re-reading two small JSON files on every poll is pointless; the signed-in account changes rarely. */
const ACCOUNT_EMAIL_TTL_MS = 5 * 60_000;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 254) return undefined;
  return EMAIL_SHAPE.test(trimmed) ? trimmed : undefined;
}

/**
 * The `email` claim of a JWT, read from the payload segment only.
 *
 * Deliberately does not verify the signature: the token came out of a file in
 * the user's own home directory that we are already trusting for the access
 * token, and we are extracting a display string, not authorizing anything. A
 * malformed token yields `undefined`, never a throw — this runs inside the
 * poll loop.
 */
export function decodeJwtClaims(token: string | undefined | null): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const segments = token.split(".");
  if (segments.length < 2) return null;
  const payload = segments[1];
  if (!payload) return null;
  try {
    const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = safeJsonParse<Record<string, unknown>>(decoded, {});
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function decodeJwtEmail(token: string | undefined | null): string | undefined {
  const claims = decodeJwtClaims(token);
  if (!claims) return undefined;
  return normalizeEmail(claims.email) ?? normalizeEmail(claims.preferred_username) ?? undefined;
}

/**
 * "pro" → "ChatGPT Pro". Codex reports a plan slug on the OpenAI auth claim; a
 * slug ADE has no name for is title-cased rather than dropped, so a new tier
 * still reads as something.
 */
export function formatCodexPlan(slug: unknown): string | undefined {
  if (typeof slug !== "string") return undefined;
  const trimmed = slug.trim();
  if (!trimmed || trimmed.length > 40) return undefined;
  const known: Record<string, string> = {
    free: "ChatGPT Free",
    plus: "ChatGPT Plus",
    pro: "ChatGPT Pro",
    business: "ChatGPT Business",
    team: "ChatGPT Team",
    enterprise: "ChatGPT Enterprise",
    edu: "ChatGPT Edu",
  };
  const lower = trimmed.toLowerCase();
  if (known[lower]) return known[lower];
  const words = lower.replace(/[_-]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return `ChatGPT ${words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")}`;
}

/** "max" / "claude_max" → "Claude Max". */
export function formatClaudePlan(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return undefined;
  const words = trimmed
    .replace(/^claude[\s_-]*/i, "")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return undefined;
  return `Claude ${words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")}`;
}

/**
 * A provider config that EXISTS but could not be read or parsed.
 *
 * The distinction matters downstream: an absent config is the authoritative
 * answer "nobody is signed in", and the poller must clear the account line on
 * it. An unreadable one is transient (a half-written file, a permissions
 * hiccup) and must not blank a line that was correct a second ago.
 */
export class ProviderAccountUnreadableError extends Error {
  constructor(filePath: string) {
    super(`Provider account config could not be read: ${filePath}`);
    this.name = "ProviderAccountUnreadableError";
  }
}

/** `null` means "not there"; a throw means "there but unreadable". */
async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT/ENOTDIR/EISDIR are all "no config here" on every platform;
    // anything else (EACCES, EBUSY, EIO) is a read we cannot trust.
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw new ProviderAccountUnreadableError(filePath);
  }
  // `null` fallback, not `{}`: an empty object is a legitimate config, so a
  // `{}` fallback would make unparsable JSON look like a valid signed-out one.
  const parsed = safeJsonParse<Record<string, unknown> | null>(raw, null);
  if (!isRecord(parsed)) throw new ProviderAccountUnreadableError(filePath);
  return parsed;
}

/**
 * `~/.codex/auth.json` → `tokens.id_token` → `email` and the OpenAI auth claim's
 * `chatgpt_plan_type`. Honours `CODEX_HOME`.
 */
export async function readCodexAccount(home: string = os.homedir()): Promise<ProviderAccountIdentity> {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const parsed = await readJsonFile(path.join(codexHome, "auth.json"));
  if (!parsed) return {};
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : parsed;
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
  const claims = decodeJwtClaims(idToken);
  if (!claims) return {};
  const auth = isRecord(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] : null;
  // The email/preferred_username fallback lives in `decodeJwtEmail`; the raw
  // claim set is still needed here for the OpenAI plan claim.
  const email = decodeJwtEmail(idToken);
  const plan = formatCodexPlan(auth?.chatgpt_plan_type);
  return { ...(email ? { email } : {}), ...(plan ? { plan } : {}) };
}

/**
 * Claude's signed-in account, from the CLI's own config.
 *
 * `.claude.json` normally sits beside the home directory; a `CLAUDE_CONFIG_DIR`
 * install keeps it inside that directory instead, so both are checked in the
 * order the CLI itself resolves them.
 */
export async function readClaudeAccount(home: string = os.homedir()): Promise<ProviderAccountIdentity> {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  const candidates = [
    ...(configDir ? [path.join(configDir, ".claude.json")] : []),
    path.join(home, ".claude.json"),
    path.join(home, ".claude", ".claude.json"),
  ];
  for (const candidate of candidates) {
    const parsed = await readJsonFile(candidate);
    if (!parsed) continue;
    const account = isRecord(parsed.oauthAccount) ? parsed.oauthAccount : null;
    const email = normalizeEmail(account?.emailAddress)
      ?? normalizeEmail(account?.email)
      ?? normalizeEmail(parsed.oauthAccountEmail);
    // Only subscription *tier* fields: `billingType` says "stripe_subscription",
    // which is a payment rail, not a plan the user would recognise.
    const plan = formatClaudePlan(
      account?.subscriptionType ?? account?.subscription_type ?? account?.rateLimitTier,
    );
    if (email || plan) {
      return {
        ...(email ? { email } : {}),
        ...(plan ? { plan } : { ...(await claudeCredentialPlan(home)) }),
      };
    }
  }
  return { ...(await claudeCredentialPlan(home)) };
}

/**
 * The tier recorded next to the OAuth credentials, used when the CLI config has
 * no account block. Only `subscriptionType`/`rateLimitTier` are read — the
 * tokens in that file are never touched.
 */
async function claudeCredentialPlan(home: string): Promise<ProviderAccountIdentity> {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const parsed = await readJsonFile(path.join(configDir, ".credentials.json"));
  const oauth = parsed && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
  const plan = formatClaudePlan(oauth?.subscriptionType ?? oauth?.rateLimitTier);
  return plan ? { plan } : {};
}

type CacheEntry = { at: number; identity: ProviderAccountIdentity };
const cache = new Map<UsageProvider, CacheEntry>();

/**
 * Account identity for the providers that expose one locally. Cursor has no
 * local account record ADE already reads, so it is deliberately absent rather
 * than probed.
 */
export async function resolveProviderAccounts(
  nowMs: number = Date.now(),
): Promise<ProviderAccountResolution> {
  const identities: Partial<Record<UsageProvider, ProviderAccountIdentity>> = {};
  const unreadable: Partial<Record<UsageProvider, boolean>> = {};
  const readers: Array<[UsageProvider, () => Promise<ProviderAccountIdentity>]> = [
    ["claude", () => readClaudeAccount()],
    ["codex", () => readCodexAccount()],
  ];
  // Total by construction: this is the ONE guard for account identity. Callers
  // (the usage poller, `buildProviderConnections`) used to wrap it in a catch
  // each, which is two guards for a call that already swallows every IO and
  // parse error in its readers — and two places for the contract to drift.
  await Promise.all(readers.map(async ([provider, read]) => {
    try {
      const cached = cache.get(provider);
      if (cached && nowMs - cached.at < ACCOUNT_EMAIL_TTL_MS) {
        if (cached.identity.email || cached.identity.plan) identities[provider] = cached.identity;
        return;
      }
      const identity = await read();
      cache.set(provider, { at: nowMs, identity });
      if (identity.email || identity.plan) identities[provider] = identity;
    } catch {
      // Identity is a display string. A provider whose config exists but cannot
      // be read must not blank a line that was correct a second ago, so the
      // last identity this module actually read is carried forward and the
      // provider is also flagged `unreadable`. Carrying happens HERE, once, so
      // every caller is a plain read of `identities` and two surfaces can never
      // name different accounts for one provider.
      //
      // A successful read always overwrites the cache — including with `{}` —
      // so a sign-out that is followed by an unreadable pass carries nothing.
      unreadable[provider] = true;
      const carried = cache.get(provider)?.identity;
      if (carried && (carried.email || carried.plan)) identities[provider] = carried;
    }
  }));
  return { identities, unreadable };
}

/**
 * Drops both the TTL cache and the carry-forward identity it doubles as, so a
 * test can start from "this process has never read an account".
 */
export function clearProviderAccountCache(): void {
  cache.clear();
}
