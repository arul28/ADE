/**
 * Claude passes on a cloud computer: each pass of the ADE account is one
 * normal Claude account here (P6 §3).
 *
 * `reconcile` runs at the end of each pass of the brain's sign-in sync
 * (`onProviderLoginPass`: a signed-in account with ADE Cloud and a ready
 * vault) and before each Claude turn on a cloud computer (the sign-in gate).
 * It reads only this computer's vault cache and the account setting, and
 * writes `provider-instances.json` only on a change.
 *
 * On every brain it adopts the single Claude item of older versions into
 * `claude-pass/legacy`. On a cloud computer it also:
 * - adopts the boot token (`CLAUDE_CODE_OAUTH_TOKEN`, given as instance env
 *   by older versions) into the account, then takes it out of `process.env`
 *   (also when the account's legacy pass holds a newer token: the account wins);
 * - makes one account `pass-<id>` for each pass that is on, removes the
 *   others, and sets "New chats" and smart balance from the account setting;
 * - gives a Claude process with no account the "New chats" pass, unless the
 *   base Claude home holds a login someone made on this computer;
 * - keeps each pass's token in memory for `withClaudePassEnv`
 *   (claudePassLaunch.ts), and restarts idle Claude chats on a pass that
 *   changed (a running turn ends at its settle).
 *
 * No function here logs, returns or writes a token, except the vault write of
 * the adopted boot token.
 */

import fs from "node:fs";
import path from "node:path";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type { ClaudePassStatusEntry } from "../../../shared/cloudSignIns";
import type { CloudPassAccount } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import {
  CLAUDE_PASS_LEGACY_KEY,
  CLAUDE_PASS_VAULT_KIND,
  adoptLegacyClaudePass,
  claudePassVaultFromStore,
  listClaudePasses,
  parseClaudePass,
  readClaudePassSummaries,
  sameClaudeEmail,
  type ClaudePassVaultStoreLike,
} from "../adeCloud/claudePassStore";
import { cloudSignInVaultKey } from "../adeCloud/cloudSignInStore";
import { claudeConfigHome } from "../shared/providerConfigHomes";
import { setClaudePassLaunchState } from "./claudePassLaunch";
import { claudePassUseOf, flushClaudePassUse, keepClaudePassUse } from "./claudePassUse";

const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** The whole value is one Claude Code long-lived token. */
const WHOLE_CLAUDE_TOKEN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/;
/** The base Claude account (`~/.claude`, no `CLAUDE_CONFIG_DIR`). */
const BASE_ACCOUNT_ID = "claude";
const CLOUD_SETTING_KEY = "providerLogins.cloud";

type Logger = {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
} | null | undefined;

/** The parts of the brain's account vault store the reconcile uses. */
export type ClaudePassSyncVault = ClaudePassVaultStoreLike & {
  get(scope: string, kind: typeof CLAUDE_PASS_VAULT_KIND | "integration", key: string): string | null;
  health(): { state: string; syncReady?: boolean };
};

/** The parts of the provider account store the reconcile uses. */
export type ClaudePassSyncStore = {
  syncCloudPasses(args: { passes: readonly CloudPassAccount[]; defaultId: string | null; smartBalance: boolean | null }): {
    added: string[];
    removed: string[];
    changed: string[];
    wrote: boolean;
  };
  list(provider: "claude"): Array<{ id: string; signedIn: boolean; sameLoginAs?: string; account?: { email?: string } }>;
};

export type ClaudePassSyncDeps = {
  cloudComputer: boolean;
  adeDir: string;
  vault: () => ClaudePassSyncVault | null;
  settings: () => { get(scope: string, key: string): unknown } | null;
  store: () => ClaudePassSyncStore | null;
  /** The signed-in ADE account, for the gate (the pass hook names its own). */
  accountUserId: () => string | null;
  /** End idle Claude processes of these accounts; busy ones end at their settle. */
  restart: (provider: "claude", options: { instanceIds: readonly string[] }) => void;
  /** Claude's sign-in changed here (caches, model lists). */
  noteChanged: (provider: "claude") => void;
  /** The brain's own env; the boot token is taken from it. */
  env?: NodeJS.ProcessEnv;
  /**
   * True when the base Claude home holds a login someone made on this
   * computer. Default: a non-empty `.credentials.json` in it (a stat; the
   * file is never read).
   */
  baseHomeHasLogin?: () => boolean;
  logger?: Logger;
  now?: () => number;
};

export type ClaudePassReconcileResult = {
  ran: boolean;
  /** Why it did nothing: no vault, a vault not synced yet, or not signed in. */
  skipped?: "no_vault" | "vault_not_ready" | "signed_out";
  legacyAdopted: boolean;
  envToken: "none" | "found" | "adopted" | "removed" | "superseded" | "kept" | null;
  /** Cloud computer only: the base Claude home holds its own login, so a process with no account keeps it. */
  baseHomeLogin: boolean;
  added: string[];
  removed: string[];
  restarted: string[];
  wrote: boolean;
};

export type { ClaudePassStatusEntry } from "../../../shared/cloudSignIns";

/** `claude-pass/<12 hex>` → `pass-<12 hex>`; `claude-pass/legacy` → `pass-legacy`. */
export function claudePassInstanceId(key: string): string {
  return `pass-${key.slice("claude-pass/".length)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type CloudSettingView = { enabled: boolean; inUseClaude: string | null; off: Set<string>; smartBalance: boolean };

/** The account setting `providerLogins.cloud`, read as P5 writes it; `claude.smartBalance` absent = false. */
export function readClaudeCloudSetting(raw: unknown): CloudSettingView {
  const record = isRecord(raw) ? raw : {};
  const inUse = isRecord(record.inUse) ? record.inUse : {};
  const claude = isRecord(record.claude) ? record.claude : {};
  return {
    enabled: record.enabled !== false,
    inUseClaude: typeof inUse.claude === "string" ? inUse.claude : null,
    off: new Set(Array.isArray(record.off) ? record.off.filter((key): key is string => typeof key === "string") : []),
    smartBalance: claude.smartBalance === true,
  };
}

export function createClaudePassSync(deps: ClaudePassSyncDeps) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const logger = deps.logger;
  /** Pass account id → its token, as last given to the launch helper. */
  let tokens = new Map<string, string>();
  let keyById = new Map<string, string>();
  let initialized = false;
  let managed = false;
  const homeHasLogin = new Set<string>();
  let keptLogged = false;
  /**
   * What a Claude process with no account signs in with: the boot token until
   * the first reconcile, then the "New chats" pass (claudePassLaunch.ts).
   * Kept to restart base-account chats when it changes. A token, memory only.
   */
  let accountlessToken: string | null = env[TOKEN_ENV]?.trim() || null;

  const homeOf = (id: string): string => path.join(deps.adeDir, "provider-homes", "claude", id);
  const baseHomeHasLogin = deps.baseHomeHasLogin ?? (() => {
    try {
      const stat = fs.statSync(path.join(claudeConfigHome({ env, homeDir: env.HOME }), ".credentials.json"));
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  });

  /** The boot token: found in a pass, adopted as the legacy pass, or removed by the person. */
  function takeEnvToken(passVault: ReturnType<typeof claudePassVaultFromStore>, accountUserId: string | null): ClaudePassReconcileResult["envToken"] {
    const token = env[TOKEN_ENV]?.trim();
    if (!token) return "none";
    // Not Claude Code's token shape: not a pass. Claude processes stop getting it once managed.
    if (!WHOLE_CLAUDE_TOKEN.test(token)) return "none";
    let outcome: ClaudePassReconcileResult["envToken"];
    if (listClaudePasses(passVault).some((entry) => entry.pass.token === token)) {
      outcome = "found";
    } else if (adoptLegacyClaudePass(
      passVault,
      JSON.stringify({ v: 1, token, savedAt: now() }),
      { now: now(), ...(accountUserId ? { expectedAccountUserId: accountUserId } : {}) },
      logger ?? undefined,
    )) {
      outcome = "adopted";
    } else if (passVault.list().some((row) => row.key === CLAUDE_PASS_LEGACY_KEY && row.deleted)) {
      // The person removed the legacy pass: the boot copy goes too.
      outcome = "removed";
    } else if (listClaudePasses(passVault).some((entry) => entry.key === CLAUDE_PASS_LEGACY_KEY)) {
      // The legacy pass holds a newer token the person saved again: the account wins.
      outcome = "superseded";
    } else {
      // The account refused the adoption write: keep today's behavior until a later pass.
      if (!keptLogged) logger?.warn("claude_pass.env_token_kept", { reason: "adopt_refused" });
      keptLogged = true;
      return "kept";
    }
    delete env[TOKEN_ENV];
    logger?.info("claude_pass.env_token_taken", { outcome });
    return outcome;
  }

  function reconcile(info: { accountUserId: string | null }): ClaudePassReconcileResult {
    const result: ClaudePassReconcileResult = {
      ran: false, legacyAdopted: false, envToken: null, baseHomeLogin: false, added: [], removed: [], restarted: [], wrote: false,
    };
    const vault = deps.vault();
    if (!vault) return { ...result, skipped: "no_vault" };
    if (vault.health().syncReady === false) return { ...result, skipped: "vault_not_ready" };
    const accountUserId = info.accountUserId?.trim() || null;
    if (!accountUserId) return { ...result, skipped: "signed_out" };
    const passVault = claudePassVaultFromStore(vault);
    const writeOptions = { expectedAccountUserId: accountUserId };
    result.ran = true;

    // Every brain: the single item of older versions becomes the legacy pass (once).
    result.legacyAdopted = adoptLegacyClaudePass(
      passVault,
      vault.get(ACCOUNT_SCOPE_ALL, "integration", cloudSignInVaultKey("claude")),
      writeOptions,
      logger ?? undefined,
    );
    if (result.legacyAdopted) logger?.info("claude_pass.legacy_adopted", { key: CLAUDE_PASS_LEGACY_KEY });
    if (!deps.cloudComputer) return result;

    result.envToken = takeEnvToken(passVault, accountUserId);
    const setting = readClaudeCloudSetting(deps.settings()?.get(ACCOUNT_SCOPE_ALL, CLOUD_SETTING_KEY));
    const passes = listClaudePasses(passVault);
    const desired = setting.enabled ? passes.filter((entry) => !setting.off.has(entry.key)) : [];
    const accounts: CloudPassAccount[] = desired.map((entry) => ({
      id: claudePassInstanceId(entry.key),
      key: entry.key,
      email: entry.pass.account.email,
      check: entry.pass.account.check,
      expiresAt: entry.pass.expiresAt,
      createdAt: entry.pass.createdAt,
      ...(entry.pass.endedAt != null ? { endedAt: entry.pass.endedAt } : {}),
    }));
    // An ended pass stays an account (its chats keep it and show the sign-in
    // card), but it is never "New chats".
    const working = accounts.filter((account) => account.endedAt == null);
    const inUse = setting.inUseClaude ? working.find((account) => account.key === setting.inUseClaude) : undefined;
    // "New chats": the pass in use, else the newest working pass that is on.
    const defaultId = (inUse ?? working[0])?.id ?? null;
    const store = deps.store();
    if (!store) return result;
    const synced = store.syncCloudPasses({ passes: accounts, defaultId, smartBalance: setting.smartBalance });
    result.added = synced.added;
    result.removed = synced.removed;
    result.wrote = synced.wrote;

    const nextTokens = new Map<string, string>();
    for (const entry of desired) nextTokens.set(claudePassInstanceId(entry.key), entry.pass.token);
    const changedIds = new Set<string>([...synced.added, ...synced.removed]);
    for (const [id, token] of nextTokens) {
      const before = tokens.get(id);
      // A renewed pass; or, on the first run after a start, a chat that began before the token was known.
      if (before !== undefined ? before !== token : !initialized) changedIds.add(id);
    }
    for (const id of tokens.keys()) if (!nextTokens.has(id)) changedIds.add(id);
    for (const id of synced.added) {
      const key = desired.find((entry) => claudePassInstanceId(entry.key) === id)?.key ?? id;
      logger?.info("claude_pass.applied", { key });
      // Someone signed in inside a pass folder: kept, and named in the status.
      try {
        if (fs.existsSync(path.join(homeOf(id), ".credentials.json"))) {
          homeHasLogin.add(key);
          logger?.warn("claude_pass.home_has_login", { key });
        }
      } catch {
        // The status just doesn't say it.
      }
    }
    for (const id of synced.removed) logger?.info("claude_pass.removed", { key: keyById.get(id) ?? id });

    managed = result.envToken !== "kept";
    // A sign-in someone made in the base home wins for a process with no account.
    result.baseHomeLogin = baseHomeHasLogin();
    const accountlessPassId = managed && !result.baseHomeLogin ? defaultId : null;
    tokens = nextTokens;
    keyById = new Map(desired.map((entry) => [claudePassInstanceId(entry.key), entry.key]));
    setClaudePassLaunchState({
      homes: [...nextTokens].map(([id, token]) => ({ configHome: homeOf(id), token })),
      // Unmanaged (the boot token kept) or a login in the base home: a process
      // with no account gets no pass. Managed, a stray env token still leaves.
      defaultHome: accountlessPassId ? homeOf(accountlessPassId) : null,
      managed,
    });
    const nextAccountless = managed
      ? (accountlessPassId ? nextTokens.get(accountlessPassId) ?? null : null)
      : env[TOKEN_ENV]?.trim() || null;
    if (nextAccountless !== accountlessToken) changedIds.add(BASE_ACCOUNT_ID);
    accountlessToken = nextAccountless;
    const tokenOrAccountChanged = changedIds.size > 0 || synced.changed.length > 0;
    if (synced.wrote || tokenOrAccountChanged) deps.noteChanged("claude");
    if (changedIds.size) {
      result.restarted = [...changedIds];
      deps.restart("claude", { instanceIds: result.restarted });
    }
    initialized = true;
    // The use of a removed pass goes with it; a changed use reaches the file at most once a minute.
    keepClaudePassUse(new Set(passes.map((entry) => entry.key)));
    flushClaudePassUse(now());
    return result;
  }

  /** Pass key → the token whose end this brain already handled (memory only). */
  const endedTokenByKey = new Map<string, string>();

  /**
   * Claude refused pass account `instanceId` as no longer valid
   * (claudePassEnd.ts). Writes `endedAt` into the pass item ONCE for this
   * token, then reconciles so "New chats" moves on. The guard, in order:
   *   1. this brain already handled this token's end → nothing;
   *   2. the vault item now holds another token (a Renew came first) → nothing;
   *   3. the item already carries `endedAt` (another computer wrote it) → nothing;
   *   4. else one `set` of the same item with `endedAt`.
   * Two chats that fail at the same moment run one after the other on this
   * thread; the second stops at step 1. No retry and no loop: a refused write
   * is logged and left for the person (Renew or Remove).
   */
  function endPass(instanceId: string): "ended" | "already" | "skipped" {
    const key = keyById.get(instanceId);
    const token = tokens.get(instanceId);
    if (!key || !token) return "skipped";
    if (endedTokenByKey.get(key) === token) return "already";
    endedTokenByKey.set(key, token);
    const vault = deps.vault();
    const accountUserId = deps.accountUserId();
    if (!vault || !accountUserId) return "skipped";
    const passVault = claudePassVaultFromStore(vault);
    const pass = parseClaudePass(passVault.get(key));
    if (!pass || pass.token !== token) return "skipped";
    if (pass.endedAt != null) return "already";
    const wrote = passVault.set(key, JSON.stringify({ ...pass, endedAt: now() }), { expectedAccountUserId: accountUserId });
    logger?.warn("claude_pass.ended", { key, wrote });
    if (!wrote) return "skipped";
    reconcile({ accountUserId });
    return "ended";
  }

  /** `claudePasses` for `provider_logins.status` on this brain. */
  function statusEntries(): ClaudePassStatusEntry[] | null {
    const vault = deps.vault();
    if (!vault) return null;
    const passVault = claudePassVaultFromStore(vault);
    const setting = readClaudeCloudSetting(deps.settings()?.get(ACCOUNT_SCOPE_ALL, CLOUD_SETTING_KEY));
    let localAccounts: Array<{ instanceId: string; email: string; isDefault: boolean }> = [];
    try {
      localAccounts = (deps.store()?.list("claude") ?? [])
        .filter((instance) => instance.signedIn && !instance.sameLoginAs && !/^pass-/.test(instance.id) && instance.account?.email)
        .map((instance) => ({ instanceId: instance.id, email: instance.account!.email!, isDefault: false }));
    } catch {
      // No local account names; the passes still show.
    }
    const summaries = readClaudePassSummaries(
      passVault,
      vault.get(ACCOUNT_SCOPE_ALL, "integration", cloudSignInVaultKey("claude")),
      localAccounts,
      now(),
    );
    const inUseKey = setting.inUseClaude;
    const onKeys = summaries.filter((pass) => !pass.unreadable && setting.enabled && !setting.off.has(pass.key)).map((pass) => pass.key);
    const newChatsKey = inUseKey && onKeys.includes(inUseKey) ? inUseKey : onKeys[0] ?? null;
    return summaries.map((pass): ClaudePassStatusEntry => {
      if (pass.unreadable) return { key: pass.key, unreadable: true };
      return {
        key: pass.key,
        unreadable: false,
        label: pass.label,
        email: pass.email,
        check: pass.check,
        legacy: pass.legacy,
        on: onKeys.includes(pass.key),
        newChats: pass.key === newChatsKey,
        madeOnLabel: pass.madeOnLabel,
        createdAt: pass.createdAt,
        renewedAt: pass.renewedAt,
        expiresAt: pass.expiresAt,
        expiresAtSource: pass.expiresAtSource,
        endsInDays: pass.endsInDays,
        state: pass.state,
        noticeDueAt: pass.noticeDueAt,
        upload: pass.upload,
        localInstanceId: pass.email
          ? localAccounts.find((account) => sameClaudeEmail(account.email, pass.email))?.instanceId ?? null
          : null,
        appliedHere: deps.cloudComputer && tokens.has(claudePassInstanceId(pass.key)),
        homeHasLogin: deps.cloudComputer && homeHasLogin.has(pass.key),
        smartBalance: setting.smartBalance,
        endedAt: pass.endedAt,
        use: claudePassUseOf(pass.key, now()),
      };
    });
  }

  return {
    reconcile,
    /** Before a Claude turn (the gate): the last signed-in account; local reads only. */
    reconcileForTurn(): ClaudePassReconcileResult {
      return reconcile({ accountUserId: deps.accountUserId() });
    },
    statusEntries,
    endPass,
  };
}

export type ClaudePassSync = ReturnType<typeof createClaudePassSync>;
