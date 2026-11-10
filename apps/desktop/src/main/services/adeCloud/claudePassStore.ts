/**
 * Claude passes for ADE Cloud, as the account vault keeps them.
 *
 * A pass is one `claude setup-token` token: one approve by the person, for
 * cloud computers only, for about a year (cloudClaudeSignIn.ts makes it).
 * The person keeps one pass for each Claude account.
 *
 * - One vault item per pass: scope `all`, kind `provider_login`, key
 *   `claude-pass/<12 random hex>`. The key is plain text on the relay, so it
 *   holds no email and no hash of one; the email is inside the sealed value.
 * - A Renew, or a new approve for an email that has a pass, overwrites that
 *   pass's key. So keys grow with accounts, never with time.
 * - The single item of older versions (`integration/cloud-claude-token`)
 *   becomes the pass `claude-pass/legacy`. The fixed key means two computers
 *   that adopt it at once write one item.
 *
 * No function here returns, logs or throws with a token in it. Status
 * summaries carry dates, labels and keys only.
 */

import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type {
  ClaudePassCheck,
  ClaudePassLabelSource,
  ClaudePassState,
  ClaudePassUpload,
  CloudClaudeLocalAccount,
  CloudClaudePass,
  CloudClaudePassUnreadable,
} from "../../../shared/cloudSignIns";
import { CLAUDE_TOKEN_PATTERN } from "./cloudSignInStore";

export const CLAUDE_PASS_VAULT_KIND = "provider_login";
export const CLAUDE_PASS_KEY_PREFIX = "claude-pass/";
export const CLAUDE_PASS_LEGACY_KEY = "claude-pass/legacy";
const CLAUDE_PASS_KEY_PATTERN = /^claude-pass\/(?:legacy|[0-9a-f]{12})$/;

const DAY_MS = 24 * 60 * 60_000;
/** A pass lasts about a year; ADE's estimate until Claude Code reports the date. */
export const CLAUDE_PASS_LIFETIME_MS = 365 * DAY_MS;
/** The tile line starts here. */
export const CLAUDE_PASS_ENDING_SOON_MS = 14 * DAY_MS;
/** The one notice with Renew is due here. */
export const CLAUDE_PASS_NOTICE_MS = 7 * DAY_MS;

type Logger = { warn?(event: string, meta?: Record<string, unknown>): void } | null | undefined;

/** The vault value of one pass. */
export type ClaudePassPayload = {
  v: 1;
  kind: "claude_pass";
  token: string;
  account: { email: string | null; check: ClaudePassCheck; labelSource: ClaudePassLabelSource };
  createdAt: number;
  renewedAt: number | null;
  madeOn: { machineKey12: string; label: string } | null;
  expiresAt: number;
  expiresAtSource: "estimate" | "claude";
  /**
   * When Claude refused this token as no longer valid (claudePassSync.ts
   * `endPass`). Absent while it works; a Renew writes a new payload without it.
   */
  endedAt?: number;
};

/** The computer an approve ran on, as a pass records it. */
export type ClaudePassMachineStamp = { machineKey12: string; label: string };

/**
 * The account vault reduced to Claude passes. Null-safe callers build it only when signed in.
 *
 * The vault writes on this computer first and sends the write to the account
 * after (accountCacheStore.ts). So a `set` that answers true is not yet in
 * the account: `upload` sends it now, and `uploadState` says where it is.
 */
export type ClaudePassVault = {
  /** Every pass key the vault knows, with tombstones (a removed pass). */
  list(): Array<{ key: string; deleted: boolean; readable?: boolean }>;
  get(key: string): string | null;
  set(key: string, value: string, options?: { expectedAccountUserId?: string }): boolean;
  remove(key: string, options?: { expectedAccountUserId?: string }): boolean;
  /** Sends what waits, and pulls; false when the account could not be reached. */
  upload?(): Promise<boolean>;
  /** Where a pass's last write is. Without it, every pass counts as in the account. */
  uploadState?(key: string): ClaudePassUpload;
};

/** The parts of the brain's account vault store that passes use. */
export type ClaudePassVaultStoreLike = {
  list(scope?: string): Array<{ kind: string; key: string; deleted?: boolean; readable?: boolean }>;
  get(scope: string, kind: typeof CLAUDE_PASS_VAULT_KIND, key: string): string | null;
  set(scope: string, kind: typeof CLAUDE_PASS_VAULT_KIND, key: string, value: string, options?: { expectedAccountUserId?: string }): boolean;
  remove(scope: string, kind: typeof CLAUDE_PASS_VAULT_KIND, key: string, options?: { expectedAccountUserId?: string }): boolean;
  sync?(): Promise<string>;
  pendingKeys?(scope: string, kind: typeof CLAUDE_PASS_VAULT_KIND): string[];
  /** Writes the account service refused for themselves (kept here, retried hourly). */
  parkedKeys?(scope: string, kind: typeof CLAUDE_PASS_VAULT_KIND): string[];
};

export function claudePassVaultFromStore(store: ClaudePassVaultStoreLike): ClaudePassVault {
  return {
    list: () => store.list(ACCOUNT_SCOPE_ALL)
      .filter((row) => row.kind === CLAUDE_PASS_VAULT_KIND && isClaudePassKey(row.key))
      .map((row) => ({ key: row.key, deleted: row.deleted === true, readable: row.readable !== false })),
    get: (key) => store.get(ACCOUNT_SCOPE_ALL, CLAUDE_PASS_VAULT_KIND, key),
    set: (key, value, options) => store.set(ACCOUNT_SCOPE_ALL, CLAUDE_PASS_VAULT_KIND, key, value, options),
    remove: (key, options) => store.remove(ACCOUNT_SCOPE_ALL, CLAUDE_PASS_VAULT_KIND, key, options),
    upload: async () => (store.sync ? (await store.sync()) === "ready" : true),
    uploadState: (key) => {
      if (store.parkedKeys?.(ACCOUNT_SCOPE_ALL, CLAUDE_PASS_VAULT_KIND).includes(key)) return "refused";
      if (store.pendingKeys?.(ACCOUNT_SCOPE_ALL, CLAUDE_PASS_VAULT_KIND).includes(key)) return "pending";
      return "account";
    },
  };
}

/** How long a save waits for the account before it reports "only on this computer". */
export const CLAUDE_PASS_UPLOAD_WAIT_MS = 15_000;

/**
 * Sends a just-saved pass to the account, waiting at most `waitMs`, and says
 * where it is. Never throws. A pass that did not arrive stays in this
 * computer's vault queue: "pending" is retried on every sync, "refused" every
 * hour (accountCacheStore.ts), so it is not lost.
 */
export async function uploadClaudePass(
  vault: ClaudePassVault,
  key: string,
  options: { waitMs?: number; logger?: Logger } = {},
): Promise<ClaudePassUpload> {
  if (vault.upload) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        vault.upload(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.waitMs ?? CLAUDE_PASS_UPLOAD_WAIT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      options.logger?.warn?.("claude_pass.upload_threw", { reason: error instanceof Error ? error.name : "unknown" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  let state: ClaudePassUpload = "account";
  try {
    state = vault.uploadState?.(key) ?? "account";
  } catch {
    state = "pending";
  }
  if (state !== "account") options.logger?.warn?.("claude_pass.not_in_account", { key, state });
  return state;
}

export function isClaudePassKey(key: unknown): key is string {
  return typeof key === "string" && CLAUDE_PASS_KEY_PATTERN.test(key);
}

export function newClaudePassKey(random: () => string = () => randomBytes(6).toString("hex")): string {
  return `${CLAUDE_PASS_KEY_PREFIX}${random()}`;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimmedEmail(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.includes("@") && text.length <= 320 ? text : null;
}

export function sameClaudeEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

const CHECKS: readonly ClaudePassCheck[] = ["match", "kept_other", "unchecked"];
const LABEL_SOURCES: readonly ClaudePassLabelSource[] = ["checked", "pressed", "typed", "none"];

/** A stored pass, or null for anything that is not one (never an error with the value in it). */
export function parseClaudePass(raw: string | null | undefined): ClaudePassPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.v !== 1 || value.kind !== "claude_pass") return null;
  if (typeof value.token !== "string" || !CLAUDE_TOKEN_PATTERN.test(value.token)) return null;
  const createdAt = finite(value.createdAt);
  const expiresAt = finite(value.expiresAt);
  if (createdAt == null || expiresAt == null) return null;
  const account = value.account && typeof value.account === "object" ? value.account as Record<string, unknown> : {};
  const madeOn = value.madeOn && typeof value.madeOn === "object" ? value.madeOn as Record<string, unknown> : null;
  return {
    v: 1,
    kind: "claude_pass",
    token: value.token,
    account: {
      email: trimmedEmail(account.email),
      check: CHECKS.includes(account.check as ClaudePassCheck) ? account.check as ClaudePassCheck : "unchecked",
      labelSource: LABEL_SOURCES.includes(account.labelSource as ClaudePassLabelSource)
        ? account.labelSource as ClaudePassLabelSource
        : "none",
    },
    createdAt,
    renewedAt: finite(value.renewedAt),
    madeOn: madeOn && typeof madeOn.machineKey12 === "string" && typeof madeOn.label === "string"
      ? { machineKey12: madeOn.machineKey12, label: madeOn.label }
      : null,
    expiresAt,
    expiresAtSource: value.expiresAtSource === "claude" ? "claude" : "estimate",
    ...(finite(value.endedAt) != null ? { endedAt: finite(value.endedAt)! } : {}),
  };
}

type StoredPass = { key: string; pass: ClaudePassPayload };

/** Every live pass the vault holds, newest first. */
export function listClaudePasses(vault: ClaudePassVault): StoredPass[] {
  const passes: StoredPass[] = [];
  for (const row of vault.list()) {
    if (row.deleted) continue;
    const pass = parseClaudePass(vault.get(row.key));
    if (pass) passes.push({ key: row.key, pass });
  }
  return passes.sort((a, b) => (b.pass.renewedAt ?? b.pass.createdAt) - (a.pass.renewedAt ?? a.pass.createdAt));
}

/**
 * The key a new pass is saved under: the renewed pass, else the pass of the
 * same email (one pass per account), else a new random key.
 */
export function chooseClaudePassKey(
  passes: readonly StoredPass[],
  args: { email: string | null; renewKey?: string | null },
  newKey: () => string = newClaudePassKey,
): string {
  if (args.renewKey && passes.some((entry) => entry.key === args.renewKey)) return args.renewKey;
  const sameAccount = args.email ? passes.find((entry) => sameClaudeEmail(entry.pass.account.email, args.email)) : null;
  return sameAccount?.key ?? newKey();
}

/** The payload a save writes; a pass it replaces keeps its creation date. */
export function buildClaudePass(
  previous: ClaudePassPayload | null,
  args: {
    token: string;
    email: string | null;
    check: ClaudePassCheck;
    labelSource: ClaudePassLabelSource;
    madeOn: ClaudePassMachineStamp | null;
    now: number;
  },
): ClaudePassPayload {
  return {
    v: 1,
    kind: "claude_pass",
    token: args.token,
    account: { email: trimmedEmail(args.email), check: args.check, labelSource: args.labelSource },
    createdAt: previous?.createdAt ?? args.now,
    renewedAt: previous ? args.now : null,
    madeOn: args.madeOn,
    expiresAt: args.now + CLAUDE_PASS_LIFETIME_MS,
    expiresAtSource: "estimate",
  };
}

/**
 * Keeps one pass. Returns its key, or null when the account refused the
 * write. Other passes of the same email are removed, so two computers that
 * saved one account at once end with one pass.
 */
export function saveClaudePass(
  vault: ClaudePassVault,
  args: {
    token: string;
    email: string | null;
    check: ClaudePassCheck;
    labelSource: ClaudePassLabelSource;
    renewKey?: string | null;
    madeOn: ClaudePassMachineStamp | null;
    now?: number;
    expectedAccountUserId?: string;
    newKey?: () => string;
  },
  logger?: Logger,
): string | null {
  const now = args.now ?? Date.now();
  const passes = listClaudePasses(vault);
  const key = chooseClaudePassKey(passes, { email: args.email, renewKey: args.renewKey }, args.newKey);
  const previous = passes.find((entry) => entry.key === key)?.pass ?? null;
  const payload = buildClaudePass(previous, { ...args, now });
  const writeOptions = args.expectedAccountUserId ? { expectedAccountUserId: args.expectedAccountUserId } : undefined;
  let ok = false;
  try {
    ok = vault.set(key, JSON.stringify(payload), writeOptions);
  } catch (error) {
    logger?.warn?.("claude_pass.save_threw", { reason: error instanceof Error ? error.name : "unknown" });
    return null;
  }
  if (!ok) {
    logger?.warn?.("claude_pass.save_refused", { key });
    return null;
  }
  for (const entry of passes) {
    if (entry.key === key || !payload.account.email || !sameClaudeEmail(entry.pass.account.email, payload.account.email)) continue;
    try {
      vault.remove(entry.key, writeOptions);
    } catch (error) {
      logger?.warn?.("claude_pass.duplicate_remove_threw", { reason: error instanceof Error ? error.name : "unknown" });
    }
  }
  return key;
}

/** Removes every pass (the old Settings card's Remove). False when the account refused one. */
export function removeAllClaudePasses(vault: ClaudePassVault, logger?: Logger): boolean {
  let ok = true;
  for (const row of vault.list()) {
    if (row.deleted) continue;
    try {
      ok = vault.remove(row.key) && ok;
    } catch (error) {
      logger?.warn?.("claude_pass.remove_threw", { reason: error instanceof Error ? error.name : "unknown" });
      ok = false;
    }
  }
  return ok;
}

/** The value of the single item of older versions: `{v:1, token, savedAt}` (cloudSignInStore.ts). */
function parseLegacyItem(raw: string | null | undefined): { token: string; savedAt: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; token?: unknown; savedAt?: unknown };
    if (parsed?.v !== 1 || typeof parsed.token !== "string" || !CLAUDE_TOKEN_PATTERN.test(parsed.token)) return null;
    return { token: parsed.token, savedAt: finite(parsed.savedAt) ?? 0 };
  } catch {
    return null;
  }
}

/**
 * The pass the single item of older versions becomes, or null when there is
 * nothing to adopt. Pure. The rule: adopt only when the vault has never had
 * `claude-pass/legacy` (a live row or a tombstone: a Renew or a Remove of the
 * legacy pass is the last word) and no pass carries that token already.
 */
export function planLegacyClaudePass(args: {
  legacyRaw: string | null | undefined;
  passKeys: readonly { key: string; deleted: boolean }[];
  passes: readonly StoredPass[];
  now: number;
}): ClaudePassPayload | null {
  const legacy = parseLegacyItem(args.legacyRaw);
  if (!legacy) return null;
  if (args.passKeys.some((row) => row.key === CLAUDE_PASS_LEGACY_KEY)) return null;
  if (args.passes.some((entry) => entry.pass.token === legacy.token)) return null;
  const savedAt = legacy.savedAt > 0 ? legacy.savedAt : args.now;
  return {
    v: 1,
    kind: "claude_pass",
    token: legacy.token,
    account: { email: null, check: "unchecked", labelSource: "none" },
    createdAt: savedAt,
    renewedAt: null,
    madeOn: null,
    expiresAt: savedAt + CLAUDE_PASS_LIFETIME_MS,
    expiresAtSource: "estimate",
  };
}

/**
 * Writes the legacy pass when `planLegacyClaudePass` says so. Not called yet:
 * the vault tick calls it once P5's service pass has a hook (P6 step 2).
 * True when it wrote the pass.
 */
export function adoptLegacyClaudePass(
  vault: ClaudePassVault,
  legacyRaw: string | null | undefined,
  options: { now?: number; expectedAccountUserId?: string } = {},
  logger?: Logger,
): boolean {
  const payload = planLegacyClaudePass({
    legacyRaw,
    passKeys: vault.list(),
    passes: listClaudePasses(vault),
    now: options.now ?? Date.now(),
  });
  if (!payload) return false;
  try {
    return vault.set(
      CLAUDE_PASS_LEGACY_KEY,
      JSON.stringify(payload),
      options.expectedAccountUserId ? { expectedAccountUserId: options.expectedAccountUserId } : undefined,
    );
  } catch (error) {
    logger?.warn?.("claude_pass.legacy_adopt_threw", { reason: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

function dateLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A pass as a window sees it: no token. */
export function summarizeClaudePass(
  key: string,
  pass: ClaudePassPayload,
  now: number,
  localAccounts: readonly CloudClaudeLocalAccount[] = [],
  upload: ClaudePassUpload = "account",
): CloudClaudePass {
  const left = pass.expiresAt - now;
  // Only Claude's refusal ends a pass; a past estimate is only a date.
  const state: ClaudePassState = pass.endedAt != null
    ? "ended"
    : left <= 0 ? "estimate_passed" : left <= CLAUDE_PASS_ENDING_SOON_MS ? "ending_soon" : "active";
  const email = pass.account.email;
  const local = email ? localAccounts.find((account) => sameClaudeEmail(account.email, email)) : undefined;
  return {
    key,
    label: email ?? `Claude pass from ${dateLabel(pass.createdAt)}`,
    email,
    check: pass.account.check,
    legacy: key === CLAUDE_PASS_LEGACY_KEY,
    madeOnLabel: pass.madeOn?.label ?? null,
    createdAt: pass.createdAt,
    renewedAt: pass.renewedAt,
    expiresAt: pass.expiresAt,
    expiresAtSource: pass.expiresAtSource,
    endsInDays: Math.max(0, Math.floor(left / DAY_MS)),
    state,
    endedAt: pass.endedAt ?? null,
    noticeDueAt: pass.expiresAt - CLAUDE_PASS_NOTICE_MS,
    unreadable: false,
    localInstanceId: local?.instanceId ?? null,
    // The account side fills it from this computer's usage (cloudSignInActions.ts).
    use: { state: "none_seen" },
    upload,
  };
}

/**
 * Every pass for the status, newest first. Until the vault tick adopts the
 * single item of older versions, it shows as the legacy pass it will become.
 */
export function readClaudePassSummaries(
  vault: ClaudePassVault,
  legacyRaw: string | null | undefined,
  localAccounts: readonly CloudClaudeLocalAccount[],
  now: number = Date.now(),
): Array<CloudClaudePass | CloudClaudePassUnreadable> {
  const passes = listClaudePasses(vault);
  const uploadOf = (key: string): ClaudePassUpload => {
    try {
      return vault.uploadState?.(key) ?? "account";
    } catch {
      return "pending";
    }
  };
  const summaries: Array<CloudClaudePass | CloudClaudePassUnreadable> = passes
    .map((entry) => summarizeClaudePass(entry.key, entry.pass, now, localAccounts, uploadOf(entry.key)));
  const rows = vault.list();
  const legacy = planLegacyClaudePass({ legacyRaw, passKeys: rows, passes, now });
  if (legacy) summaries.push(summarizeClaudePass(CLAUDE_PASS_LEGACY_KEY, legacy, now, localAccounts));
  // A live row that is not a pass here (the relay could not open it, or a
  // newer payload): shown as unknown, never hidden. No other data.
  const readKeys = new Set(passes.map((entry) => entry.key));
  for (const row of rows) {
    if (!row.deleted && !readKeys.has(row.key)) summaries.push({ key: row.key, unreadable: true });
  }
  return summaries;
}

/**
 * This computer as a pass records it: the first 12 hex of the machine key's
 * hash (P5's `origin12`) and the name the machine directory shows. Null when
 * the identity can't be read; a pass is still saved without it.
 */
export async function localClaudePassMachine(): Promise<ClaudePassMachineStamp | null> {
  try {
    const { getOrCreateLocalAccountMachineIdentity } = await import("../account/localMachineIdentity");
    const identity = getOrCreateLocalAccountMachineIdentity();
    let label = os.hostname();
    try {
      const { resolveDeviceDisplayName } = await import("../../../../../ade-cli/src/services/sync/deviceRegistryService");
      label = resolveDeviceDisplayName().trim() || label;
    } catch {
      // The hostname stands in.
    }
    return { machineKey12: createHash("sha256").update(identity.machineKey).digest("hex").slice(0, 12), label };
  } catch {
    return null;
  }
}
