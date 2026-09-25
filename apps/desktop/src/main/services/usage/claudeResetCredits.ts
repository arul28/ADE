/**
 * Claude banked resets — Claude Code's `cedar_ember` program.
 *
 * Claude Code hands out reset credits the way Codex does: the CLI reads the
 * grants from its OAuth usage endpoint and claims one against the account's
 * organization. ADE mirrors that read and claim using the OAuth token the CLI
 * keeps on disk. It deliberately never reads the macOS Keychain: that lookup is
 * reserved for the credential path's explicit refresh, and turning it into an
 * unattended HTTP call is exactly the refresh storm the credential hygiene in
 * `providerCredentialSources.ts` exists to prevent. On macOS the feature is
 * therefore simply not offered, and this module returns "no resets" without
 * sending anything.
 *
 * Every failure reads as "no resets" so the live usage bars never break on this
 * optional extra; a claim that did not happen is never reported as one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageResetCreditResult } from "../../../shared/types";
import { getErrorMessage, isRecord, safeJsonParse } from "../shared/utils";

const CLAUDE_API_BASE = "https://api.anthropic.com";
const CLAUDE_USAGE_PATH = "/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_RESET_PROGRAM = "cedar_ember";
const CLAUDE_RESET_READ_TIMEOUT_MS = 10_000;
const CLAUDE_RESET_CONSUME_TIMEOUT_MS = 25_000;
/**
 * Last-resort `user-agent` version. The CLI sends `claude-cli/<version>`; ADE
 * resolves the installed version from the native install's version directory
 * and falls back to this when it cannot, rather than inventing a per-request
 * value. The read endpoint accepts the request without a versioned agent, so a
 * wrong guess costs nothing.
 */
const CLAUDE_CLI_FALLBACK_VERSION = "2.1.0";

const GRANT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COMPLETE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Banked Claude resets, shaped to the generic `UsageAccount.resetCredits`
 * contract plus the grant id the claim needs.
 *
 * `nextCreditId` never leaves the main process — it is the single grant the
 * server named as next and it is the only one that may be claimed, so it is
 * carried here rather than re-derived from a re-read at claim time.
 */
export type ClaudeResetCredits = {
  availableCount: number;
  nextExpiresAt?: string;
  nextCreditId?: string;
};

/** The outcome of one claim, plus whether a retry must reuse the same request id. */
export type ClaudeResetConsumeAttempt = {
  result: UsageResetCreditResult;
  /**
   * True when nothing confirmed the claim (a transport failure, a 5xx, or the
   * server's `unavailable`): the same request id must be sent again so a retry
   * asks about the original claim instead of minting a second one.
   */
  retrySameClaim: boolean;
};

/** Rejects unparseable and calendar-invalid timestamps such as February 30. */
function isFutureTimestamp(value: string, nowMs: number): boolean {
  if (!COMPLETE_TIMESTAMP.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= nowMs) return false;
  return Date.UTC(year, month - 1, day) <= Date.UTC(year, month, 0);
}

type ClaudeResetGrant = {
  id: string;
  resetsLeft: number;
  endsAt: string | null;
  paused: boolean;
  usableNow: boolean;
};

function parseGrant(value: unknown): ClaudeResetGrant | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  if (!id || !GRANT_ID_PATTERN.test(id)) return null;
  const resetsLeft = typeof value.resets_left === "number" && Number.isInteger(value.resets_left)
    ? value.resets_left
    : null;
  if (resetsLeft == null || resetsLeft < 0) return null;
  return {
    id,
    resetsLeft,
    endsAt: typeof value.ends_at === "string" ? value.ends_at : null,
    paused: value.paused === true,
    usableNow: value.usable_now === true,
  };
}

/**
 * Map the usage response's `cedar_ember` block to the reset-credit contract.
 *
 * Paused grants, grants that are not usable now, and grants past `ends_at` are
 * not counted. `availableCount` is the sum of the live grants' `resets_left`
 * only when the server named a next grant among them — with nothing redeemable
 * the count is zero, which is what hides the control.
 */
export function parseClaudeResetCredits(block: unknown, nowMs: number): ClaudeResetCredits | null {
  if (!isRecord(block) || block.eligible !== true) return null;
  const rawGrants = Array.isArray(block.grants) ? block.grants : [];
  const live = rawGrants
    .map(parseGrant)
    .filter((grant): grant is ClaudeResetGrant => grant != null)
    .filter((grant) => !grant.paused && grant.usableNow
      && (grant.endsAt == null || isFutureTimestamp(grant.endsAt, nowMs)));
  const nextGrantId = typeof block.next_grant_id === "string" ? block.next_grant_id : null;
  const next = nextGrantId ? live.find((grant) => grant.id === nextGrantId) ?? null : null;
  if (!next) return { availableCount: 0 };
  return {
    availableCount: live.reduce((sum, grant) => sum + grant.resetsLeft, 0),
    ...(next.endsAt ? { nextExpiresAt: new Date(next.endsAt).toISOString() } : {}),
    nextCreditId: next.id,
  };
}

export function claudeResetCreditsFromUsagePayload(
  payload: unknown,
  nowMs: number,
): ClaudeResetCredits | null {
  if (!isRecord(payload)) return null;
  return parseClaudeResetCredits(payload.cedar_ember, nowMs);
}

function claudeCredentialsFile(configHome: string | undefined): string {
  const scoped = configHome?.trim();
  return scoped
    ? path.join(path.resolve(scoped), ".credentials.json")
    : path.join(os.homedir(), ".claude", ".credentials.json");
}

/**
 * `.claude.json` sits beside the home directory for the default account, and
 * inside a `CLAUDE_CONFIG_DIR` for a scoped one. Both are tried for the default
 * because older installs wrote the home copy in one of two places.
 */
function claudeAccountConfigFiles(configHome: string | undefined): string[] {
  const scoped = configHome?.trim();
  return scoped
    ? [path.join(path.resolve(scoped), ".claude.json")]
    : [path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude", ".claude.json")];
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return safeJsonParse<unknown>(await fs.promises.readFile(file, "utf8"), null);
  } catch {
    return null;
  }
}

export async function readClaudeAccessToken(configHome?: string): Promise<string | null> {
  const parsed = await readJsonFile(claudeCredentialsFile(configHome));
  if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) return null;
  const token = typeof parsed.claudeAiOauth.accessToken === "string"
    ? parsed.claudeAiOauth.accessToken.trim()
    : "";
  return token || null;
}

export async function readClaudeOrganizationUuid(configHome?: string): Promise<string | null> {
  for (const file of claudeAccountConfigFiles(configHome)) {
    const parsed = await readJsonFile(file);
    if (!isRecord(parsed) || !isRecord(parsed.oauthAccount)) continue;
    const organization = typeof parsed.oauthAccount.organizationUuid === "string"
      ? parsed.oauthAccount.organizationUuid.trim()
      : "";
    if (organization) return organization;
  }
  return null;
}

let cachedClaudeCliVersion: string | null = null;

/** The installed Claude Code version, from the native install's version dir. */
async function resolveClaudeCliVersion(): Promise<string> {
  if (cachedClaudeCliVersion) return cachedClaudeCliVersion;
  try {
    const dir = path.join(os.homedir(), ".local", "share", "claude", "versions");
    const entries = await fs.promises.readdir(dir);
    const versions = entries
      .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry))
      .sort((a, b) => {
        const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
        const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
        return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
      });
    const latest = versions[versions.length - 1];
    if (latest) cachedClaudeCliVersion = latest;
  } catch {
    // No native install directory; the fallback agent is fine.
  }
  return cachedClaudeCliVersion ?? CLAUDE_CLI_FALLBACK_VERSION;
}

function claudeHeaders(token: string, version: string, withBody: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "anthropic-beta": CLAUDE_OAUTH_BETA,
    "user-agent": `claude-cli/${version} (external, cli)`,
    ...(withBody ? { "content-type": "application/json" } : {}),
  };
}

/**
 * Read one account's banked resets. Any failure — macOS, no credentials file,
 * a non-2xx response, a malformed body — reads as "no resets", never an error.
 */
export async function readClaudeResetCredits(args: {
  configHome?: string;
  nowMs?: number;
  platform?: NodeJS.Platform;
  cliVersion?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<ClaudeResetCredits | null> {
  if ((args.platform ?? process.platform) === "darwin") return null;
  const token = await readClaudeAccessToken(args.configHome);
  if (!token) return null;
  const version = args.cliVersion ?? await resolveClaudeCliVersion();
  const fetchImpl = args.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `${CLAUDE_API_BASE}${CLAUDE_USAGE_PATH}?cedar_ember=1&skip_spend=1`,
      {
        method: "GET",
        headers: claudeHeaders(token, version, false),
        signal: AbortSignal.timeout(CLAUDE_RESET_READ_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const payload = safeJsonParse<unknown>(await response.text(), null);
    return claudeResetCreditsFromUsagePayload(payload, args.nowMs ?? Date.now());
  } catch {
    return null;
  }
}

/**
 * Claim `grantId` for the account's organization.
 *
 * The ids are checked before anything is sent, so a malformed credit never
 * becomes a request. Claude's own result vocabulary is mapped onto the shared
 * outcome statuses; `cooldown`, `429`, and a signed-out answer are settled (a
 * retry is a fresh claim), while an unanswered or unconfirmed claim keeps its
 * request id.
 */
export async function consumeClaudeResetCredit(args: {
  configHome?: string;
  grantId: string;
  requestId: string;
  platform?: NodeJS.Platform;
  cliVersion?: string;
  fetchImpl?: typeof fetch;
}): Promise<ClaudeResetConsumeAttempt> {
  const failure = (message: string, retrySameClaim = false): ClaudeResetConsumeAttempt => ({
    result: { ok: false, status: "failure", message },
    retrySameClaim,
  });
  if ((args.platform ?? process.platform) === "darwin") {
    return failure("Claude reset credits are not available on this computer.");
  }
  if (!GRANT_ID_PATTERN.test(args.grantId) || !REQUEST_ID_PATTERN.test(args.requestId)) {
    return failure("Claude returned a malformed reset credit.");
  }
  const [token, organization] = await Promise.all([
    readClaudeAccessToken(args.configHome),
    readClaudeOrganizationUuid(args.configHome),
  ]);
  if (!token || !organization) return failure("Sign in to Claude again to redeem resets.");

  const version = args.cliVersion ?? await resolveClaudeCliVersion();
  const fetchImpl = args.fetchImpl ?? fetch;
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(
      `${CLAUDE_API_BASE}/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
      {
        method: "POST",
        headers: claudeHeaders(token, version, true),
        body: JSON.stringify({
          program: CLAUDE_RESET_PROGRAM,
          grant_id: args.grantId,
          request_id: args.requestId,
        }),
        signal: AbortSignal.timeout(CLAUDE_RESET_CONSUME_TIMEOUT_MS),
      },
    );
  } catch (error) {
    return failure(`Could not reach Claude to spend the reset: ${getErrorMessage(error)}`, true);
  }

  if (response.status === 429) {
    return failure("Claude is rate limiting resets. Try again soon.");
  }
  if (response.status === 401 || response.status === 403) {
    return failure("Sign in to Claude again to redeem resets.");
  }
  if (!response.ok) {
    return failure("Claude could not redeem the reset.", true);
  }
  const body = safeJsonParse<unknown>(await response.text(), null);
  const result = isRecord(body) && typeof body.result === "string" ? body.result : null;
  switch (result) {
    case "reset":
      return { result: { ok: true, status: "reset" }, retrySameClaim: false };
    case "not_limited":
      return { result: { ok: false, status: "nothingToReset" }, retrySameClaim: false };
    case "already_used":
      return { result: { ok: false, status: "alreadyRedeemed" }, retrySameClaim: false };
    case "ineligible":
      return { result: { ok: false, status: "noCredit" }, retrySameClaim: false };
    case "cooldown":
      return failure("Claude resets are cooling down. Try again later.");
    case "unavailable":
      return failure(
        "Claude could not confirm the reset. If you are still limited in a moment, try again.",
        true,
      );
    default:
      return failure("Claude could not redeem the reset.", true);
  }
}
