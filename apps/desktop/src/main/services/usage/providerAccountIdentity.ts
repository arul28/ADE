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

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const parsed = safeJsonParse<Record<string, unknown>>(raw, {});
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const claims = decodeJwtClaims(typeof tokens.id_token === "string" ? tokens.id_token : undefined);
  if (!claims) return {};
  const auth = isRecord(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] : null;
  const email = normalizeEmail(claims.email) ?? normalizeEmail(claims.preferred_username);
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
): Promise<Partial<Record<UsageProvider, ProviderAccountIdentity>>> {
  const out: Partial<Record<UsageProvider, ProviderAccountIdentity>> = {};
  const readers: Array<[UsageProvider, () => Promise<ProviderAccountIdentity>]> = [
    ["claude", () => readClaudeAccount()],
    ["codex", () => readCodexAccount()],
  ];
  await Promise.all(readers.map(async ([provider, read]) => {
    const cached = cache.get(provider);
    if (cached && nowMs - cached.at < ACCOUNT_EMAIL_TTL_MS) {
      if (cached.identity.email || cached.identity.plan) out[provider] = cached.identity;
      return;
    }
    const identity = await read();
    cache.set(provider, { at: nowMs, identity });
    if (identity.email || identity.plan) out[provider] = identity;
  }));
  return out;
}

export function clearProviderAccountCache(): void {
  cache.clear();
}
