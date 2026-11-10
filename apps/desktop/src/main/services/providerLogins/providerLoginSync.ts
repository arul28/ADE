/**
 * The sign-in sync service in the brain (P5), step 1: capture.
 *
 * On each vault tick (the account vault's own 30 s timer, so no new timer)
 * and a few seconds after a sign-in on this computer, it looks at each
 * carried provider's login files with `stat` only. It reads a file only when
 * its (mtime, size, inode) moved, and only when the read is stable: the file
 * is at least 2 s old, and a `stat` before and after the read agree. A login
 * that changed goes into the account as one vault item per sign-in
 * (`providerLoginPayload.ts`).
 *
 * Capture is off unless all of these hold (`captureOffReason`): a full brain
 * (not embedded), a release build, account sync on, signed in to an ADE
 * account that has ADE Cloud, ADE Cloud's sign-ins switched on, and a vault
 * that synced. An account without ADE Cloud never has a login uploaded.
 *
 * Apply on cloud computers and renewal are P5 steps 2 and 3.
 *
 * Never logs a value, a hash or a file's content: events carry the provider,
 * the slot, sizes and reason codes.
 */

import fs from "node:fs";
import os from "node:os";

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import {
  isClaudePassKey,
  isProviderLoginProvider,
  type ProviderLoginApplied,
  type ProviderLoginApplyState,
  type ProviderLoginCaptureOffReason,
  type ProviderLoginLocalState,
  type ProviderLoginProvider,
  type ProviderLoginSignIn,
  type ProviderLoginStatus,
} from "../../../shared/types/providerLogins";
import { CLOUD_SIGN_INS } from "../../../shared/cloudSignIns";
import { noteProviderLoginChanged, onProviderLoginChanged } from "../ai/providerLoginChanged";
import { isRecord } from "../shared/utils";
import { PROVIDER_LOGIN_CARRY, carryRow, type CarryBundle, type CarryContext, type CarryRow, type ParsedLogin } from "./providerLoginCarry";
import {
  adoptOldCodexKeyFile,
  applyCodexKey,
  appliedFilesUnchanged,
  applySignIn,
  emptyAppliedState,
  readAppliedState,
  readBackLoginHashes,
  removeApplied,
  writeAppliedState,
  type AppliedEntry,
  type AppliedStateFile,
} from "./providerLoginApply";
import {
  installProviderLoginGate,
  notifyProviderLoginPass,
  notifyProviderLoginsChanged,
  readProviderLoginStatusParts,
  restartProviderRuntimesWhenIdle,
} from "./providerLoginHooks";
import { takeCloudSignInEnv } from "./providerLoginBoot";
import {
  PROVIDER_LOGIN_MAX_CHARS,
  PROVIDER_LOGIN_VAULT_KIND,
  buildProviderLoginPayload,
  loginContentHash,
  originId,
  parseProviderLoginKey,
  providerLoginKey,
  readProviderLoginMeta,
  readProviderLoginPayload,
  shortHash,
  type ProviderLoginMachine,
} from "./providerLoginPayload";
import {
  readProviderLoginState,
  removeProviderLoginState,
  sameMarks,
  writeProviderLoginState,
  type FileMark,
  type ProviderLoginStateFile,
} from "./providerLoginState";

/** The account setting that holds ADE Cloud's choices (P5 §2.2). Only the person writes it. */
export const PROVIDER_LOGINS_CLOUD_SETTING = "providerLogins.cloud";

/** A file younger than this may still be in the middle of a write. */
const STABLE_AGE_MS = 2_000;
/** A login file gone this long (and on two passes) means the person signed out there. */
const ABSENT_REMOVE_MS = 60_000;
/** Wait after a sign-in here, so the CLI finishes its write first. */
const DEFAULT_SETTLE_MS = 2_000;
/** When the ADE Cloud answer could not be read: the first re-check, then double, up to the cap. */
const ACCESS_RECHECK_MIN_MS = 60_000;
const ACCESS_RECHECK_MAX_MS = 30 * 60_000;
/** The gate before a turn: a vault pull only when the last one is older than this. */
const GATE_MAX_AGE_MS = 30_000;
/** The gate never holds a turn longer than this. */
const GATE_LIMIT_MS = 5_000;

/**
 * The saved ADE Cloud keys (`integration/cloud-key-<id>`) by the provider they
 * sign in. Claude's token is P6's and is not here. A key with no carried
 * provider (Copilot, Muse, OpenRouter) is always in its env variable when
 * saved; a carried provider's key only when ADE Cloud uses the key for it.
 */
const SAVED_KEYS: ReadonlyArray<{ id: string; env: string; provider: ProviderLoginProvider | null }> = CLOUD_SIGN_INS
  .filter((spec) => spec.id !== "claude")
  .map((spec) => ({
    id: spec.id,
    env: spec.env,
    provider: spec.id === "openrouter" ? null : (spec.id as ProviderLoginProvider),
  }));

/** Local states under which apply may replace the file here: the login is safe in the account, or is the account's. */
const OVERWRITE_SAFE: ReadonlySet<ProviderLoginLocalState> = new Set([
  "not_signed_in", "captured", "removed_from_account", "other_owner_newer", "from_account",
]);

const APPLY_MESSAGES: Record<ProviderLoginApplyState, string> = {
  applied: "The account's sign-in is on this cloud computer.",
  own: "The sign-in in use was made on this cloud computer.",
  key: "The saved ADE Cloud key is in use.",
  none: "No sign-in is in use on ADE Cloud for this provider.",
  kept_local: "A sign-in made on this cloud computer is not in your account yet, so ADE did not replace it.",
  failed: "ADE couldn't write this sign-in here. It tries again on the next pass.",
};

export type CloudAccessState = "ready" | "no_access" | "signed_out" | "unreadable";

type VaultRow = {
  scope: string;
  kind: string;
  key: string;
  updatedAt: string;
  readable: boolean;
  refreshOwner: string | null;
  deleted?: boolean;
};

export type ProviderLoginVault = {
  list(scope?: string): VaultRow[];
  /** `provider_login` items, and on a cloud computer the saved ADE Cloud keys (`integration`). */
  get(scope: string, kind: typeof PROVIDER_LOGIN_VAULT_KIND | "integration", key: string): string | null;
  set(scope: string, kind: typeof PROVIDER_LOGIN_VAULT_KIND, key: string, value: string, options?: { refreshOwner?: string | null }): boolean;
  remove(scope: string, kind: typeof PROVIDER_LOGIN_VAULT_KIND, key: string): boolean;
  health(): { state: "ok" | "failing" | "unavailable"; syncReady?: boolean };
  /** Keys of this kind the account service refused (an older relay); retried hourly by the store. */
  parkedKeys?(scope: string, kind: typeof PROVIDER_LOGIN_VAULT_KIND): string[];
  startPeriodicSync(intervalMs?: number, onSync?: (status: "ready" | "unavailable" | "failed") => void): () => void;
  /** With `maxAgeMs`, no network when the last pull is younger (the gate before a turn). */
  sync?(options?: { maxAgeMs?: number } | null): Promise<"ready" | "unavailable" | "failed">;
};

export type ProviderLoginSettings = {
  get(scope: string, key: string): unknown;
  set?(scope: string, key: string, value: unknown): boolean;
  startPeriodicSync?(intervalMs?: number): () => void;
};

type Logger = {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
};

export type ProviderLoginSyncDeps = {
  /** The machine's ADE home: the state file lives under it. */
  adeDir: string;
  /** Fixed for the life of the process; any one keeps every store closed. */
  staticOff: Extract<ProviderLoginCaptureOffReason, "embedded" | "dev_brain" | "sync_off"> | null;
  vault: () => ProviderLoginVault | null;
  settings: () => ProviderLoginSettings | null;
  accountUserId: () => string | null;
  machine: () => ProviderLoginMachine | null;
  /** The account's ADE Cloud answer (cached in `cloudAccess.ts`, asked at most every 10 minutes). */
  cloudAccess: () => Promise<CloudAccessState>;
  /** Hear a change of the cached ADE Cloud answer, whoever asked (`onCloudAccessAnswerChanged`). */
  onCloudAccessChanged?: (listener: () => void) => () => void;
  cloudComputer: boolean;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  settleMs?: number;
};

const OFF_MESSAGES: Record<ProviderLoginCaptureOffReason, string> = {
  not_this_runtime: "This ADE process does not copy sign-ins. The ADE brain on this computer does.",
  embedded: "This runtime keeps its own sign-ins, so ADE does not copy them.",
  dev_brain: "This is a development build of ADE. It never copies sign-ins to your account.",
  sync_off: "Account sync is off in this ADE brain, so ADE does not copy sign-ins.",
  signed_out: "Sign in to ADE to copy this computer's sign-ins to your account.",
  no_ade_cloud: "ADE Cloud isn't available on this account, so ADE does not copy sign-ins.",
  ade_cloud_unknown: "ADE couldn't check this account's ADE Cloud access. It checks again in a few minutes.",
  all_off: "Sign-ins for ADE Cloud are switched off for this account.",
  vault_unavailable: "ADE hasn't synced with your account yet, so it waits before it copies sign-ins.",
};

const LOCAL_MESSAGES: Record<ProviderLoginLocalState, string> = {
  captured: "In your account.",
  not_signed_in: "Not signed in on this computer.",
  os_store: "The sign-in is in the OS keychain or keyring. ADE does not read it in the background.",
  settling: "The login file just changed. ADE reads it on the next pass.",
  too_large: "This sign-in is too big for your account.",
  unreadable: "ADE found a login file but could not read a sign-in from it.",
  removed_from_account: "You removed this sign-in from your account. Sign in again here to add it back.",
  other_owner_newer: "Another computer renews this sign-in, and its copy is newer.",
  from_saved_key: "This file came from a saved ADE Cloud key. It stays a key.",
  from_account: "This is the account's sign-in. ADE wrote it on this cloud computer.",
  account_refused: "Your account service doesn't take sign-ins yet. ADE keeps this one on this computer and tries again every hour.",
  not_checked: "Not checked on this computer.",
};

/** When one provider has several sign-ins (Pi), the state that says the most wins. */
const LOCAL_STATE_RANK: ProviderLoginLocalState[] = [
  "account_refused", "too_large", "unreadable", "settling", "other_owner_newer", "removed_from_account", "captured",
  "from_account", "from_saved_key", "os_store", "not_signed_in", "not_checked",
];

type CloudSetting = { enabled: boolean; inUse: Record<string, string>; off: string[] };

export function readCloudSetting(raw: unknown): CloudSetting {
  const record = isRecord(raw) ? raw : {};
  const inUse: Record<string, string> = {};
  if (isRecord(record.inUse)) {
    for (const [provider, key] of Object.entries(record.inUse)) if (typeof key === "string") inUse[provider] = key;
  }
  return {
    enabled: record.enabled !== false,
    inUse,
    off: Array.isArray(record.off) ? record.off.filter((key): key is string => typeof key === "string") : [],
  };
}

/**
 * What ADE Cloud picks one sign-in for. One per provider, except Pi, whose
 * sub-providers (xAI, OpenRouter, ...) are separate logins: `pi:<sub>`.
 */
export function cloudChoiceKey(provider: ProviderLoginProvider, slot: string): string {
  return provider === "pi" ? `pi:${slot}` : provider;
}

type LoginMemo = { slot: string; key: string; contentHash: string; familyHash: string; class: ParsedLogin["class"]; expiresAt: number | null };
type BundleMemo = { logins: LoginMemo[]; skipped: Array<{ slot: string; state: ProviderLoginLocalState }> };

type BundleObservation =
  | { kind: "absent" }
  | { kind: "settling" }
  | { kind: "unreadable" }
  | { kind: "parsed"; logins: Array<{ memo: LoginMemo; full: ParsedLogin | null }>; skipped: BundleMemo["skipped"] };

export function createProviderLoginSync(deps: ProviderLoginSyncDeps) {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const ctx: CarryContext = { env, homeDir, platform, cloudComputer: deps.cloudComputer };
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;

  const bundleMemos = new Map<string, BundleMemo>();
  const localStates = new Map<ProviderLoginProvider, Map<string, { state: ProviderLoginLocalState; key: string | null }>>();
  const metaMemo = new Map<string, { updatedAt: string; meta: ReturnType<typeof readProviderLoginMeta> }>();
  let lastPassAt: number | null = null;
  // The marks file, read once per account and written only when it changed.
  let stateCache: ProviderLoginStateFile | null = null;
  const loadState = (accountUserId: string): ProviderLoginStateFile => {
    if (stateCache?.accountUserId !== accountUserId) stateCache = readProviderLoginState(deps.adeDir, accountUserId);
    return stateCache;
  };
  let inFlight: Promise<void> | null = null;
  let rerun: { providers: Set<ProviderLoginProvider> | null } | null = null;
  const releases: Array<() => void> = [];
  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const cloudSetting = (): CloudSetting => readCloudSetting(deps.settings()?.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGINS_CLOUD_SETTING));

  async function captureOffReason(): Promise<ProviderLoginCaptureOffReason | null> {
    if (deps.staticOff) return deps.staticOff;
    const vault = deps.vault();
    if (!deps.accountUserId()) return "signed_out";
    if (!vault) return "vault_unavailable";
    const access = await deps.cloudAccess().catch((): CloudAccessState => "unreadable");
    if (access === "signed_out") return "signed_out";
    if (access === "no_access") return "no_ade_cloud";
    if (access === "unreadable") return "ade_cloud_unknown";
    if (!cloudSetting().enabled) return "all_off";
    // "failing" only because the account service refused some items (parked)
    // still lets capture run: those items wait in the store, every other works.
    const health = vault.health();
    if (health.state !== "ok" && !health.syncReady) return "vault_unavailable";
    return null;
  }

  function setLocal(provider: ProviderLoginProvider, slotId: string, state: ProviderLoginLocalState, key: string | null): void {
    let slots = localStates.get(provider);
    if (!slots) {
      slots = new Map();
      localStates.set(provider, slots);
    }
    slots.set(slotId, { state, key });
  }

  async function statFile(abs: string, rel: string): Promise<FileMark> {
    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) return { rel, missing: true };
      return { rel, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
    } catch {
      return { rel, missing: true };
    }
  }

  async function statBundle(bundle: CarryBundle): Promise<FileMark[]> {
    return await Promise.all(bundle.files.map((spec) => statFile(spec.abs, spec.rel)));
  }

  /** Read every present file once, then check that nothing moved under the read. */
  async function stableRead(bundle: CarryBundle, marks: FileMark[]): Promise<Map<string, Buffer> | null> {
    const newest = Math.max(...marks.map((mark) => ("missing" in mark ? 0 : mark.mtimeMs)));
    if (now() - newest < STABLE_AGE_MS) return null;
    const contents = new Map<string, Buffer>();
    for (const [index, spec] of bundle.files.entries()) {
      if ("missing" in marks[index]!) continue;
      try {
        contents.set(spec.rel, await fs.promises.readFile(spec.abs));
      } catch {
        return null;
      }
    }
    const after = await statBundle(bundle);
    return sameMarks(marks, after) ? contents : null;
  }

  async function observeBundle(
    row: CarryRow,
    bundle: CarryBundle,
    state: ProviderLoginStateFile,
    origin12: string,
    forceRead: boolean,
  ): Promise<BundleObservation> {
    const marks = await statBundle(bundle);
    if (bundle.files.some((spec, index) => spec.required && "missing" in marks[index]!)) {
      state.bundles[bundle.id] = { files: marks };
      bundleMemos.delete(bundle.id);
      return { kind: "absent" };
    }
    const memo = bundleMemos.get(bundle.id);
    if (!forceRead && memo && sameMarks(state.bundles[bundle.id]?.files, marks)) {
      return { kind: "parsed", logins: memo.logins.map((login) => ({ memo: login, full: null })), skipped: memo.skipped };
    }
    const contents = await stableRead(bundle, marks);
    // Not stable yet: keep the old marks, so the next pass reads it again.
    if (!contents) return { kind: "settling" };
    const parsed = row.parse!(bundle, contents, ctx);
    state.bundles[bundle.id] = { files: marks };
    if ("unreadable" in parsed) {
      bundleMemos.set(bundle.id, { logins: [], skipped: [{ slot: bundle.id, state: "unreadable" }] });
      return { kind: "unreadable" };
    }
    const logins = parsed.logins.map((login) => ({
      memo: {
        slot: login.slot,
        key: providerLoginKey(row.provider, origin12, login.slot),
        contentHash: loginContentHash(login),
        familyHash: shortHash(login.familySecret),
        class: login.class,
        expiresAt: login.expiresAt,
      },
      full: login,
    }));
    bundleMemos.set(bundle.id, { logins: logins.map((login) => login.memo), skipped: parsed.skipped });
    return { kind: "parsed", logins, skipped: parsed.skipped };
  }

  type PushDecision = { push: false; state: ProviderLoginLocalState } | { push: true };

  function decide(
    login: LoginMemo,
    vault: ProviderLoginVault,
    rows: Map<string, VaultRow>,
    state: ProviderLoginStateFile,
    machine: ProviderLoginMachine,
  ): PushDecision {
    const row = rows.get(login.key);
    const pushed = state.pushed[login.key];
    if (row?.deleted) {
      // The person removed this sign-in; the same family stays removed. A new sign-in adds it back.
      if (pushed && pushed.familyHash === login.familyHash) return { push: false, state: "removed_from_account" };
      return { push: true };
    }
    if (!row) return { push: true };
    if (pushed?.pushedHash === login.contentHash) return { push: false, state: "captured" };
    const meta = readProviderLoginMeta(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, login.key));
    if (meta?.contentHash === login.contentHash) {
      state.pushed[login.key] = { pushedHash: login.contentHash, familyHash: login.familyHash, pushedAt: now(), absentSince: null, absentPasses: 0 };
      return { push: false, state: "captured" };
    }
    // Another computer renews this family, and its copy is not older: never overwrite it with this one.
    if (
      login.class === "renewing"
      && row.refreshOwner
      && row.refreshOwner !== machine.deviceId
      && meta?.familyHash === login.familyHash
      && (meta.expiresAt ?? 0) >= (login.expiresAt ?? 0)
    ) {
      return { push: false, state: "other_owner_newer" };
    }
    return { push: true };
  }

  function push(
    provider: ProviderLoginProvider,
    login: ParsedLogin,
    memo: LoginMemo,
    vault: ProviderLoginVault,
    rows: Map<string, VaultRow>,
    state: ProviderLoginStateFile,
    machine: ProviderLoginMachine,
  ): ProviderLoginLocalState {
    const row = rows.get(memo.key);
    const previous = row && !row.deleted
      ? readProviderLoginMeta(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, memo.key))
      : null;
    const payload = buildProviderLoginPayload({ provider, login, machine, previous, now: now() });
    const value = JSON.stringify(payload);
    if (value.length > PROVIDER_LOGIN_MAX_CHARS) {
      deps.logger.warn("provider_login.capture_too_large", { provider, slot: memo.slot, chars: value.length });
      return "too_large";
    }
    // Every write names the owner: the store would clear it otherwise (P4 §4).
    // A cloud computer is never the owner in step 2a, even of a sign-in made on
    // it: no renewal, takeover or write-back runs there yet (step 3).
    const written = vault.set(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, memo.key, value, {
      refreshOwner: login.class === "renewing" && !deps.cloudComputer ? machine.deviceId : null,
    });
    if (!written) {
      deps.logger.warn("provider_login.capture_write_refused", { provider, slot: memo.slot });
      return "not_checked";
    }
    state.pushed[memo.key] = { pushedHash: memo.contentHash, familyHash: memo.familyHash, pushedAt: now(), absentSince: null, absentPasses: 0 };
    deps.logger.info("provider_login.captured", { provider, slot: memo.slot, class: login.class, chars: value.length });
    return "captured";
  }

  async function runPass(providers: Set<ProviderLoginProvider> | null): Promise<void> {
    const off = await captureOffReason();
    lastPassAt = now();
    // The account lost ADE Cloud or signed out between two answers: stop riding the ticks.
    if (off === "no_ade_cloud" || off === "signed_out") leaveTicks();
    if (off === "all_off") {
      // Nothing is captured. On a cloud computer the switched-off sign-ins
      // leave and its saved keys stay managed (the switch covers sign-ins only).
      const vault = deps.vault();
      const machine = deps.machine();
      const accountUserId = deps.accountUserId();
      if (vault && machine && accountUserId) {
        if (deps.cloudComputer) await runApply(vault, accountUserId, originId(machine.machineKey), providers, false);
        notifyProviderLoginPass({ accountUserId, cloudComputer: deps.cloudComputer, providers: providers ? [...providers] : null, captureOff: "all_off" });
      }
      return;
    }
    if (off) return;
    const vault = deps.vault()!;
    const machine = deps.machine();
    const accountUserId = deps.accountUserId();
    if (!machine || !accountUserId) return;
    const origin12 = originId(machine.machineKey);
    // On a cloud computer, what apply wrote here is known before capture looks.
    if (deps.cloudComputer) await loadApplied(accountUserId);
    const state = loadState(accountUserId);
    const before = JSON.stringify(state);
    let accountChanged = false;
    const rows = new Map<string, VaultRow>();
    for (const row of vault.list(ACCOUNT_SCOPE_ALL)) {
      if (row.kind === PROVIDER_LOGIN_VAULT_KIND) rows.set(row.key, row);
    }
    const parked = new Set(vault.parkedKeys?.(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND) ?? []);
    const seenKeys = new Set<string>();
    const uncertain = new Set<ProviderLoginProvider>();

    for (const row of PROVIDER_LOGIN_CARRY) {
      if (row.carry !== "carried" || !row.locate || !row.parse) continue;
      if (providers && !providers.has(row.provider)) continue;
      localStates.set(row.provider, new Map());
      for (const bundle of row.locate(ctx)) {
        let observation = await observeBundle(row, bundle, state, origin12, false);
        if (observation.kind === "absent") {
          setLocal(row.provider, bundle.id, "not_signed_in", null);
          continue;
        }
        if (observation.kind === "settling" && deps.cloudComputer && isAppliedBundle(row.provider, bundle)) {
          // Apply wrote these files a moment ago and nobody changed them since.
          setLocal(row.provider, bundle.id, "from_account", null);
          uncertain.add(row.provider);
          continue;
        }
        if (observation.kind === "settling" || observation.kind === "unreadable") {
          uncertain.add(row.provider);
          setLocal(row.provider, bundle.id, observation.kind, null);
          continue;
        }
        for (const skipped of observation.skipped) setLocal(row.provider, `${bundle.id}:${skipped.slot}`, skipped.state, null);
        // A login that must go up but came from the memo is read again, in full.
        const needsFull = observation.logins.some((login) => !login.full && decide(login.memo, vault, rows, state, machine).push);
        if (needsFull) {
          observation = await observeBundle(row, bundle, state, origin12, true);
          if (observation.kind !== "parsed") {
            uncertain.add(row.provider);
            setLocal(row.provider, bundle.id, observation.kind === "absent" ? "not_signed_in" : "settling", null);
            continue;
          }
        }
        for (const { memo, full } of observation.logins) {
          if (deps.cloudComputer && appliedLoginHashes.has(memo.contentHash)) {
            // The account's sign-in that apply wrote here: never captured back, and
            // the sign-in it replaced (made here) is not "signed out here".
            setLocal(row.provider, `${bundle.id}:${memo.slot}`, "from_account", null);
            uncertain.add(row.provider);
            continue;
          }
          seenKeys.add(memo.key);
          const pushed = state.pushed[memo.key];
          if (pushed) {
            pushed.absentSince = null;
            pushed.absentPasses = 0;
          }
          const decision = decide(memo, vault, rows, state, machine);
          let local: ProviderLoginLocalState = decision.push && full
            ? push(row.provider, full, memo, vault, rows, state, machine)
            : decision.push ? "settling" : decision.state;
          if (decision.push && full && local === "captured") accountChanged = true;
          // Written here, but the account service will not take it: say so, never "in your account".
          if (local === "captured" && parked.has(memo.key)) local = "account_refused";
          setLocal(row.provider, `${bundle.id}:${memo.slot}`, local, memo.key);
        }
      }
    }

    // This computer's sign-ins that are gone here: two passes 60 s apart remove them from the account.
    for (const [key, pushed] of Object.entries(state.pushed)) {
      const parsedKey = parseProviderLoginKey(key);
      if (!parsedKey || parsedKey.origin12 !== origin12 || seenKeys.has(key)) continue;
      if (providers && !providers.has(parsedKey.provider)) continue;
      if (uncertain.has(parsedKey.provider)) continue;
      pushed.absentSince ??= now();
      pushed.absentPasses += 1;
      if (pushed.absentPasses < 2 || now() - pushed.absentSince < ABSENT_REMOVE_MS) continue;
      const row = rows.get(key);
      if (row && !row.deleted) {
        if (vault.remove(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key)) {
          accountChanged = true;
          deps.logger.info("provider_login.removed", { provider: parsedKey.provider, slot: parsedKey.slot, reason: "signed_out_at_origin" });
        }
      }
      // Forget it: if the login comes back, the next pass captures it again into the same key.
      delete state.pushed[key];
    }

    if (JSON.stringify(state) !== before) {
      try {
        writeProviderLoginState(deps.adeDir, state);
      } catch (error) {
        deps.logger.warn("provider_login.state_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
      }
    }
    if (accountChanged) notifyProviderLoginsChanged();
    if (deps.cloudComputer) await runApply(vault, accountUserId, origin12, providers, true);
    notifyProviderLoginPass({
      accountUserId,
      cloudComputer: deps.cloudComputer,
      providers: providers ? [...providers] : null,
      captureOff: null,
    });
  }

  /** One pass at a time; a request during a pass runs once more after it. */
  function pass(providers: ProviderLoginProvider[] | null = null): Promise<void> {
    const wanted = providers ? new Set(providers) : null;
    if (inFlight) {
      if (!rerun) rerun = { providers: wanted };
      else if (!wanted || !rerun.providers) rerun.providers = null;
      else for (const provider of wanted) rerun.providers.add(provider);
      return inFlight;
    }
    inFlight = (async () => {
      try {
        await runPass(wanted);
        while (rerun) {
          const next = rerun;
          rerun = null;
          await runPass(next.providers);
        }
      } catch (error) {
        deps.logger.warn("provider_login.pass_failed", {
          name: error instanceof Error ? error.name : "unknown",
          code: (error as NodeJS.ErrnoException)?.code ?? null,
        });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function signInsFromVault(vault: ProviderLoginVault | null, origin12: string | null, setting: CloudSetting): ProviderLoginSignIn[] {
    if (!vault) return [];
    const signIns: ProviderLoginSignIn[] = [];
    for (const row of vault.list(ACCOUNT_SCOPE_ALL)) {
      if (row.kind !== PROVIDER_LOGIN_VAULT_KIND || row.deleted || !row.readable) continue;
      const parsedKey = parseProviderLoginKey(row.key);
      if (!parsedKey) continue;
      let cached = metaMemo.get(row.key);
      if (!cached || cached.updatedAt !== row.updatedAt) {
        cached = { updatedAt: row.updatedAt, meta: readProviderLoginMeta(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, row.key)) };
        metaMemo.set(row.key, cached);
      }
      const meta = cached.meta;
      if (!meta) continue;
      const iso = (value: number | null) => (value ? new Date(value).toISOString() : null);
      signIns.push({
        key: row.key,
        provider: parsedKey.provider,
        slot: parsedKey.slot,
        class: meta.class,
        origin: { label: meta.origin.label, platform: meta.origin.platform, thisComputer: parsedKey.origin12 === origin12 },
        account: meta.account,
        capturedAt: iso(meta.capturedAt),
        renewedAt: iso(meta.renewedAt),
        renewedBy: meta.renewedBy?.label ?? null,
        expiresAt: iso(meta.expiresAt),
        onForCloud: !setting.off.includes(row.key),
        inUseOnCloud: false,
      });
    }
    // In use on ADE Cloud: the person's choice, else the newest switched-on sign-in.
    const byProvider = new Map<string, ProviderLoginSignIn[]>();
    for (const signIn of signIns) {
      const place = cloudChoiceKey(signIn.provider, signIn.slot);
      byProvider.set(place, [...(byProvider.get(place) ?? []), signIn]);
    }
    for (const [place, list] of byProvider) {
      const chosen = setting.inUse[place];
      if (chosen === "key") continue;
      const on = list.filter((signIn) => signIn.onForCloud);
      const pick = on.find((signIn) => signIn.key === chosen)
        ?? [...on].sort((left, right) => (right.renewedAt ?? right.capturedAt ?? "").localeCompare(left.renewedAt ?? left.capturedAt ?? ""))[0];
      if (pick && setting.enabled) pick.inUseOnCloud = true;
    }
    return signIns.sort((left, right) => left.key.localeCompare(right.key));
  }

  async function status(provider?: ProviderLoginProvider | null): Promise<ProviderLoginStatus> {
    const off = await captureOffReason();
    const vault = deps.staticOff ? null : deps.vault();
    const machine = deps.staticOff ? null : deps.machine();
    const setting = cloudSetting();
    const origin12 = machine ? originId(machine.machineKey) : null;
    const signIns = signInsFromVault(deps.accountUserId() ? vault : null, origin12, setting)
      .filter((signIn) => !provider || signIn.provider === provider);
    const providers = PROVIDER_LOGIN_CARRY
      .filter((row) => !provider || row.provider === provider)
      .map((row) => {
        const slots = [...(localStates.get(row.provider)?.values() ?? [])];
        let best = slots.sort((left, right) => LOCAL_STATE_RANK.indexOf(left.state) - LOCAL_STATE_RANK.indexOf(right.state))[0]
          ?? { state: "not_checked" as ProviderLoginLocalState, key: null };
        if (off || row.carry !== "carried") best = { state: "not_checked", key: null };
        if ((best.state === "not_signed_in" || best.state === "not_checked") && row.carry !== "never" && row.osStore?.(ctx)) {
          best = { state: "os_store", key: null };
        }
        const message = row.carry === "carried" && best.state !== "not_checked" ? LOCAL_MESSAGES[best.state] : row.message;
        return { provider: row.provider, carry: row.carry, message, local: { state: best.state, key: best.key } };
      });
    return {
      thisComputer: {
        capture: off ? "off" : "on",
        reason: off,
        message: off ? OFF_MESSAGES[off] : null,
        label: machine?.label ?? null,
        cloudComputer: deps.cloudComputer,
        lastPassAt: lastPassAt ? new Date(lastPassAt).toISOString() : null,
      },
      cloud: { enabled: setting.enabled },
      signIns,
      providers,
      applied: deps.cloudComputer && !deps.staticOff ? appliedStatus(provider ?? null) : null,
      // Fields other packages add (P6: `claudePasses`), never the sync's own.
      ...(deps.staticOff ? {} : await readProviderLoginStatusParts(provider ?? null)),
    };
  }

  function appliedStatus(provider: ProviderLoginProvider | null): ProviderLoginApplied[] {
    const entries = appliedCache?.applied ?? {};
    const places = [...new Set([...applyStates.keys(), ...Object.keys(entries)])].sort();
    return places
      .map((place): ProviderLoginApplied => {
        const placeProvider = place.startsWith("pi:") ? "pi" : place;
        const entry = entries[place] ?? null;
        const local = applyStates.get(place) ?? { state: entry ? "applied" as const : "none" as const, key: entry?.source ?? null };
        return {
          place,
          provider: isProviderLoginProvider(placeProvider) ? placeProvider : null,
          state: local.state,
          key: local.key,
          accessOnly: entry?.accessOnly ?? false,
          renewalSafe: entry?.renewalSafe ?? true,
          appliedAt: entry ? new Date(entry.appliedAt).toISOString() : null,
          message: APPLY_MESSAGES[local.state],
        };
      })
      .filter((entry) => !provider || entry.provider === provider);
  }

  // ── The person's writes (P5 §8.1): only the desktop's Settings calls them ──

  async function writableStores(): Promise<{ vault: ProviderLoginVault; settings: ProviderLoginSettings & { set: NonNullable<ProviderLoginSettings["set"]> } }> {
    if (deps.staticOff) throw new Error(OFF_MESSAGES[deps.staticOff]);
    const off = await captureOffReason();
    // The off switch for all and a vault that has not synced yet still take a change.
    if (off && off !== "all_off" && off !== "vault_unavailable") throw new Error(OFF_MESSAGES[off]);
    const vault = deps.vault();
    const settings = deps.settings();
    if (!vault || !settings?.set) throw new Error(OFF_MESSAGES.vault_unavailable);
    return { vault, settings: settings as ProviderLoginSettings & { set: NonNullable<ProviderLoginSettings["set"]> } };
  }

  function liveSignInKeys(vault: ProviderLoginVault): Set<string> {
    return new Set(vault.list(ACCOUNT_SCOPE_ALL)
      .filter((row) => row.kind === PROVIDER_LOGIN_VAULT_KIND && !row.deleted)
      .map((row) => row.key));
  }

  /**
   * Save the setting, without entries whose sign-in is gone (§2.2: a write
   * prunes). A Claude pass key (P6) is never pruned here, only dropped by its
   * own removal (`dropKey`). Fields this code does not know (P6:
   * `claude.smartBalance`) are kept as they are.
   */
  async function saveSetting(next: CloudSetting, dropKey: string | null = null): Promise<ProviderLoginStatus> {
    const { vault, settings } = await writableStores();
    const live = liveSignInKeys(vault);
    const keep = (key: string) => key !== dropKey && (isClaudePassKey(key) || live.has(key));
    const inUse = Object.fromEntries(Object.entries(next.inUse).filter(([, key]) => key === "key" || keep(key)));
    const off = [...new Set(next.off.filter(keep))].sort();
    const raw = settings.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGINS_CLOUD_SETTING);
    const unknownFields = isRecord(raw) ? raw : {};
    if (!settings.set(ACCOUNT_SCOPE_ALL, PROVIDER_LOGINS_CLOUD_SETTING, { ...unknownFields, v: 1, enabled: next.enabled, inUse, off })) {
      throw new Error("ADE couldn't save that to your account. Try again in a moment.");
    }
    return await afterWrite();
  }

  async function afterWrite(): Promise<ProviderLoginStatus> {
    notifyProviderLoginsChanged();
    // On a cloud computer the change applies now; elsewhere the status reads it.
    if (deps.cloudComputer) await pass();
    return await status();
  }

  /** A live key of the account: a carried sign-in (with its place), or a Claude pass (P6, place "claude"). */
  function existingKey(vault: ProviderLoginVault, key: string): { provider: ProviderLoginProvider; slot: string | null; place: string; pass: boolean } {
    if (!liveSignInKeys(vault).has(key)) throw new Error("That sign-in is not in your account.");
    if (isClaudePassKey(key)) return { provider: "claude", slot: null, place: "claude", pass: true };
    const parsedKey = parseProviderLoginKey(key);
    if (!parsedKey) throw new Error("That sign-in is not in your account.");
    return { provider: parsedKey.provider, slot: parsedKey.slot, place: cloudChoiceKey(parsedKey.provider, parsedKey.slot), pass: false };
  }

  const writes = {
    /**
     * ADE Cloud uses this sign-in (a vault key; for Claude a pass key), the
     * saved key ("key"), or the newest (null). Picking a key also switches it on.
     */
    async use(args: { provider: ProviderLoginProvider; key: string | null; slot?: string | null }): Promise<ProviderLoginStatus> {
      const { vault } = await writableStores();
      const setting = cloudSetting();
      if (args.key && args.key !== "key") {
        const found = existingKey(vault, args.key);
        if (found.provider !== args.provider) throw new Error("That sign-in belongs to another provider.");
        setting.inUse[found.place] = args.key;
        setting.off = setting.off.filter((key) => key !== args.key);
      } else if (args.key === "key") {
        if (args.provider === "pi" || args.provider === "claude") throw new Error(`${args.provider === "pi" ? "Pi" : "Claude"} has no saved ADE Cloud key.`);
        setting.inUse[args.provider] = "key";
      } else {
        delete setting.inUse[args.provider === "claude" ? "claude" : cloudChoiceKey(args.provider, args.slot ?? "base")];
      }
      return await saveSetting(setting);
    },
    /** Switch one sign-in (or Claude pass) on or off for ADE Cloud. */
    async setCloud(args: { key: string; on: boolean }): Promise<ProviderLoginStatus> {
      const { vault } = await writableStores();
      const found = existingKey(vault, args.key);
      const setting = cloudSetting();
      setting.off = args.on ? setting.off.filter((key) => key !== args.key) : [...setting.off, args.key];
      // A pass's pick is P6's to change; a carried sign-in switched off stops being the pick.
      if (!found.pass && !args.on && setting.inUse[found.place] === args.key) delete setting.inUse[found.place];
      return await saveSetting(setting);
    },
    /** The one off switch for all of ADE Cloud's sign-ins. */
    async setCloudAll(args: { on: boolean }): Promise<ProviderLoginStatus> {
      const setting = cloudSetting();
      setting.enabled = args.on;
      return await saveSetting(setting);
    },
    /** Remove one sign-in or Claude pass from the account (a tombstone every computer hears), and its setting entries. */
    async remove(args: { key: string }): Promise<ProviderLoginStatus> {
      const { vault } = await writableStores();
      const found = existingKey(vault, args.key);
      if (!vault.remove(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, args.key)) {
        throw new Error("ADE couldn't remove that sign-in from your account. Try again in a moment.");
      }
      deps.logger.info("provider_login.removed", { provider: found.provider, slot: found.slot ?? "pass", reason: "removed_by_person" });
      return await saveSetting(cloudSetting(), args.key);
    },
  };

  // ── Apply on a cloud computer (step 2a) ──────────────────────────────
  // Never on any other computer. The capture pass runs first in the same
  // pass, so the local states say whether a file here is safe to replace.

  type Want =
    | { kind: "signin"; place: string; provider: ProviderLoginProvider; slot: string; key: string; contentHash: string; class: ParsedLogin["class"]; own: boolean }
    | { kind: "key"; place: string; provider: ProviderLoginProvider; id: string; token: string; contentHash: string };

  let appliedCache: AppliedStateFile | null = null;
  /** What the first apply took out of the env (fix B1); null until then. Values stay in memory only. */
  let envTaken: Readonly<Record<string, string>> | null = null;
  const applyStates = new Map<string, { state: ProviderLoginApplyState; key: string | null }>();
  let appliedLoginHashes = new Set<string>();

  const rememberAppliedHashes = (state: AppliedStateFile): void => {
    appliedLoginHashes = new Set(Object.values(state.applied).flatMap((entry) => entry.loginHashes ?? []));
  };

  /** Undo every file and env key this computer applied (sign-out, account switch). */
  async function removeAllApplied(state: AppliedStateFile, reason: string): Promise<void> {
    const providers = new Set<string>();
    for (const [place, entry] of Object.entries(state.applied)) {
      try {
        await removeApplied(entry);
      } catch (error) {
        deps.logger.warn("provider_login.remove_failed", { place, code: (error as NodeJS.ErrnoException)?.code ?? null });
      }
      providers.add(entry.provider);
      deps.logger.info("provider_login.removed", { provider: entry.provider, place, reason });
    }
    for (const [name, valueHash] of Object.entries(state.env)) {
      const value = env[name];
      if (value != null && shortHash(value) === valueHash) delete env[name];
    }
    state.applied = {};
    state.env = {};
    for (const provider of providers) afterApplyChange(provider);
  }

  /**
   * Every present file of this bundle is one apply wrote, unchanged (Kimi's
   * config, where apply adds only a section, is left out of the check). Read
   * only for a bundle that is still settling, so only just after an apply.
   */
  function isAppliedBundle(provider: ProviderLoginProvider, bundle: CarryBundle): boolean {
    const entries = Object.values(appliedCache?.applied ?? {}).filter((entry) => entry.provider === provider);
    const files = entries.flatMap((entry) => entry.files);
    if (!files.length) return false;
    const kimiConfigs = new Set(entries.flatMap((entry) => (entry.kimiConfig ? [entry.kimiConfig.path] : [])));
    let present = 0;
    for (const spec of bundle.files) {
      if (kimiConfigs.has(spec.abs)) continue;
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(spec.abs);
      } catch {
        continue;
      }
      present += 1;
      const hash = shortHash(bytes);
      if (!files.some((file) => file.abs === spec.abs && file.hash === hash)) return false;
    }
    return present > 0;
  }

  function afterApplyChange(provider: string): void {
    noteProviderLoginChanged(provider);
    restartProviderRuntimesWhenIdle(provider);
  }

  async function loadApplied(accountUserId: string): Promise<AppliedStateFile> {
    if (appliedCache?.accountUserId === accountUserId) return appliedCache;
    const onDisk = readAppliedState(deps.adeDir);
    if (onDisk && onDisk.accountUserId !== accountUserId) {
      // Another account's sign-ins must not stay on this computer.
      await removeAllApplied(onDisk, "account_switch");
    }
    appliedCache = onDisk && onDisk.accountUserId === accountUserId ? onDisk : emptyAppliedState(accountUserId);
    rememberAppliedHashes(appliedCache);
    return appliedCache;
  }

  function savedKeyToken(id: string, vault: ProviderLoginVault): string | null {
    const raw = vault.get(ACCOUNT_SCOPE_ALL, "integration", `cloud-key-${id}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) && parsed.v === 1 && typeof parsed.token === "string" && parsed.token ? parsed.token : null;
    } catch {
      return null;
    }
  }

  function metaFor(vault: ProviderLoginVault, row: VaultRow): ReturnType<typeof readProviderLoginMeta> {
    let cached = metaMemo.get(row.key);
    if (!cached || cached.updatedAt !== row.updatedAt) {
      cached = { updatedAt: row.updatedAt, meta: readProviderLoginMeta(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, row.key)) };
      metaMemo.set(row.key, cached);
    }
    return cached.meta;
  }

  /** What ADE Cloud uses for each place now (P5 §4.2), from the vault and the setting. */
  function desiredPlaces(vault: ProviderLoginVault, setting: CloudSetting, origin12: string): Map<string, Want> {
    const candidates = new Map<string, Array<{ row: VaultRow; meta: NonNullable<ReturnType<typeof readProviderLoginMeta>>; provider: ProviderLoginProvider; slot: string }>>();
    if (setting.enabled) {
      for (const row of vault.list(ACCOUNT_SCOPE_ALL)) {
        if (row.kind !== PROVIDER_LOGIN_VAULT_KIND || row.deleted || !row.readable || setting.off.includes(row.key)) continue;
        const parsedKey = parseProviderLoginKey(row.key);
        if (!parsedKey || carryRow(parsedKey.provider).carry !== "carried") continue;
        const meta = metaFor(vault, row);
        if (!meta) continue;
        const place = cloudChoiceKey(parsedKey.provider, parsedKey.slot);
        candidates.set(place, [...(candidates.get(place) ?? []), { row, meta, provider: parsedKey.provider, slot: parsedKey.slot }]);
      }
    }
    const wants = new Map<string, Want>();
    const keyWant = (place: string, provider: ProviderLoginProvider, id: string, token: string): Want =>
      ({ kind: "key", place, provider, id, token, contentHash: shortHash(token) });
    for (const [place, list] of candidates) {
      const chosen = setting.inUse[place];
      const saved = list[0]!.provider === "pi" ? null : SAVED_KEYS.find((spec) => spec.provider === list[0]!.provider) ?? null;
      const savedToken = saved && chosen === "key" ? savedKeyToken(saved.id, vault) : null;
      if (saved && savedToken) {
        wants.set(place, keyWant(place, list[0]!.provider, saved.id, savedToken));
        continue;
      }
      const pick = list.find((entry) => entry.row.key === chosen)
        ?? [...list].sort((left, right) => (right.meta.renewedAt ?? right.meta.capturedAt) - (left.meta.renewedAt ?? left.meta.capturedAt))[0]!;
      const parsedKey = parseProviderLoginKey(pick.row.key)!;
      wants.set(place, {
        kind: "signin",
        place,
        provider: pick.provider,
        slot: pick.slot,
        key: pick.row.key,
        contentHash: pick.meta.contentHash,
        class: pick.meta.class,
        own: parsedKey.origin12 === origin12,
      });
    }
    // A carried provider with no sign-in in use falls back to its saved key; a key-only provider always uses it.
    for (const spec of SAVED_KEYS) {
      if (!spec.provider) continue;
      if (wants.has(spec.provider)) continue;
      const token = savedKeyToken(spec.id, vault);
      if (token) wants.set(spec.provider, keyWant(spec.provider, spec.provider, spec.id, token));
    }
    return wants;
  }

  /** May apply replace this provider's file here? Only when the login in it is safe in the account, or is the account's. */
  function mayOverwrite(provider: ProviderLoginProvider, place: string, have: AppliedEntry | null): boolean {
    const slots = localStates.get(provider);
    if (!slots) return true;
    const slot = provider === "pi" ? place.slice("pi:".length) : null;
    for (const [slotId, local] of slots) {
      // Pi: only this sub-provider's entry, and the file as a whole.
      if (slot && slotId.includes(":") && !slotId.endsWith(`:${slot}`)) continue;
      if (OVERWRITE_SAFE.has(local.state)) continue;
      if (local.state === "from_saved_key" && have?.source.startsWith("key:")) continue;
      return false;
    }
    return true;
  }

  /** The sign-in in use was made here and the file here is it: nothing to write, never cut to access-only. */
  function isOwnLoginHere(provider: ProviderLoginProvider, key: string): boolean {
    for (const local of localStates.get(provider)?.values() ?? []) {
      if (local.key === key && (local.state === "captured" || local.state === "account_refused")) return true;
    }
    return false;
  }

  /** Bring the files and env keys here in line with what the account picked. Cloud computers only. */
  /**
   * Without a capture pass just before (the off switch for all), the local
   * states are old: replace only a file ADE wrote and nobody changed, or write
   * where no sign-in is.
   */
  function mayOverwriteUnobserved(provider: ProviderLoginProvider, place: string, have: AppliedEntry | null): boolean {
    if (have) return appliedFilesUnchanged(have);
    return readBackLoginHashes(provider, provider === "pi" ? place.slice("pi:".length) : null, ctx).length === 0;
  }

  async function runApply(vault: ProviderLoginVault, accountUserId: string, origin12: string, providers: Set<ProviderLoginProvider> | null, captureRan: boolean): Promise<void> {
    const state = await loadApplied(accountUserId);
    const before = JSON.stringify(state);
    // Fix B1: the boot leaves the sign-in variables the desktop sent in the env
    // (the old path). They leave at the first apply, which runs only with a
    // signed-in account and a ready vault, so a key leaves only when the vault
    // can give it back. A process that started earlier keeps its env until the
    // idle restart that the changed providers get below.
    const envBefore = new Map(SAVED_KEYS.map((spec) => [spec.env, env[spec.env]]));
    const takeover = !envTaken;
    if (takeover) {
      envTaken = takeCloudSignInEnv(env);
      deps.logger.info("provider_login.env_taken", { names: Object.keys(envTaken) });
    }
    if (!state.applied.codex && !state.env.OPENAI_API_KEY) {
      // The Codex file the old cloud boot wrote from the computer's instance env: managed from now on.
      const bootKey = envTaken?.OPENAI_API_KEY;
      const adopted = bootKey ? adoptOldCodexKeyFile(bootKey, ctx, now()) : null;
      if (adopted) {
        state.applied.codex = adopted;
        deps.logger.info("provider_login.adopted", { provider: "codex", source: "old_cloud_boot" });
      }
    }
    const setting = cloudSetting();
    const wants = desiredPlaces(vault, setting, origin12);
    const changed = new Set<string>();
    const places = new Set([...wants.keys(), ...Object.keys(state.applied)]);
    for (const place of places) {
      const provider = (place.startsWith("pi:") ? "pi" : place) as ProviderLoginProvider;
      if (providers && !providers.has(provider)) continue;
      const want = wants.get(place) ?? null;
      const have = state.applied[place] ?? null;
      const fileLess = want?.kind === "key" && want.provider !== "codex";
      if (!want || fileLess) {
        applyStates.set(place, { state: want ? "key" : "none", key: want ? "key" : null });
        if (!have) continue;
        await removeApplied(have);
        delete state.applied[place];
        localStates.get(provider)?.delete(`applied:${place}`);
        changed.add(provider);
        deps.logger.info("provider_login.removed", { provider, place, reason: want ? "key_in_use" : "not_in_use" });
        continue;
      }
      const source = want.kind === "key" ? `key:${want.id}` : want.key;
      if (have && have.source === source && have.contentHash === want.contentHash) {
        applyStates.set(place, { state: want.kind === "key" ? "key" : have.files.length || have.pi || have.qwen ? "applied" : "own", key: want.kind === "key" ? "key" : want.key });
        continue;
      }
      if (want.kind === "signin" && want.own && isOwnLoginHere(provider, want.key)) {
        state.applied[place] = { provider, source, contentHash: want.contentHash, accessOnly: false, renewalSafe: true, files: [], loginHashes: [], appliedAt: now() };
        applyStates.set(place, { state: "own", key: want.key });
        continue;
      }
      if (captureRan ? !mayOverwrite(provider, place, have) : !mayOverwriteUnobserved(provider, place, have)) {
        applyStates.set(place, { state: "kept_local", key: want.kind === "key" ? "key" : want.key });
        continue;
      }
      let result: Awaited<ReturnType<typeof applySignIn>>;
      if (want.kind === "key") {
        result = applyCodexKey(source, want.token, ctx, have, now());
      } else {
        const payload = readProviderLoginPayload(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, want.key));
        result = payload && payload.provider === provider
          ? await applySignIn({
            place,
            provider,
            source,
            contentHash: payload.contentHash,
            slot: payload.slot,
            class: payload.class,
            files: payload.files,
            parts: payload.parts,
          }, have, ctx, now())
          : { ok: false, reason: "nothing_to_write" };
      }
      if (!result.ok) {
        applyStates.set(place, { state: "failed", key: want.kind === "key" ? "key" : want.key });
        deps.logger.warn("provider_login.apply_failed", { provider, place, reason: result.reason, code: result.code ?? null });
        continue;
      }
      state.applied[place] = result.entry;
      applyStates.set(place, { state: want.kind === "key" ? "key" : "applied", key: want.kind === "key" ? "key" : want.key });
      // Until the next pass reads the file back, the status says whose it is.
      if (want.kind === "signin") setLocal(provider, `applied:${place}`, "from_account", null);
      changed.add(provider);
      deps.logger.info("provider_login.applied", {
        provider,
        place,
        key: want.kind === "key" ? "key" : want.key,
        accessOnly: result.entry.accessOnly,
        renewalSafe: result.entry.renewalSafe,
      });
    }

    // Env keys: a saved key is in its variable only while it is in use, so it never outranks a carried sign-in.
    // The pass that took the boot variables puts back every one the account still has, whatever `providers` says.
    const envProviders = takeover ? null : providers;
    if (!envProviders || SAVED_KEYS.some((spec) => spec.provider && envProviders.has(spec.provider))) {
      for (const spec of SAVED_KEYS) {
        if (envProviders && (!spec.provider || !envProviders.has(spec.provider))) continue;
        const want = spec.provider ? wants.get(spec.provider) : null;
        const token = spec.provider
          ? (want?.kind === "key" && want.id === spec.id ? want.token : null)
          : savedKeyToken(spec.id, vault);
        const setHash = state.env[spec.env];
        if (token) {
          if (env[spec.env] !== token) env[spec.env] = token;
          state.env[spec.env] = shortHash(token);
        } else if (setHash) {
          const current = env[spec.env];
          if (current != null && shortHash(current) === setHash) delete env[spec.env];
          delete state.env[spec.env];
        }
      }
    }
    // A provider whose variable now differs from before this pass (set, changed, or taken away) restarts when idle.
    for (const spec of SAVED_KEYS) {
      if (env[spec.env] !== envBefore.get(spec.env)) changed.add(spec.provider ?? spec.id);
    }

    if (JSON.stringify(state) !== before) {
      rememberAppliedHashes(state);
      try {
        writeAppliedState(deps.adeDir, state);
      } catch (error) {
        deps.logger.warn("provider_login.applied_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
      }
    }
    for (const provider of changed) afterApplyChange(provider);
    if (changed.size) notifyProviderLoginsChanged();
  }

  /** The gate before a turn or a CLI start, on a cloud computer: a fresh vault, then this provider applied. */
  async function gate(provider: string): Promise<void> {
    // A new cloud computer's first turn can come while the ADE Cloud answer is still being read.
    if (!ticks.length && accessPending) await Promise.race([accessPending, new Promise((resolve) => setTimeout(resolve, GATE_LIMIT_MS).unref?.())]);
    if (!ticks.length) return;
    const providerId = provider.trim().toLowerCase();
    const gated = PROVIDER_LOGIN_CARRY.some((row) => row.provider === providerId && row.carry === "carried")
      || SAVED_KEYS.some((spec) => spec.provider === providerId);
    if (!gated) return;
    const started = now();
    const limit = <T>(promise: Promise<T> | undefined): Promise<T | "timeout" | undefined> => {
      if (!promise) return Promise.resolve(undefined);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, GATE_LIMIT_MS - (now() - started)));
        timer.unref?.();
      });
      return Promise.race([promise.catch(() => undefined), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };
    const synced = await limit(deps.vault()?.sync?.({ maxAgeMs: GATE_MAX_AGE_MS }));
    const applied = synced === "timeout" ? "timeout" : await limit(pass([providerId as ProviderLoginProvider]));
    const waitedMs = now() - started;
    if (waitedMs >= 100 || synced === "timeout" || applied === "timeout") {
      deps.logger.info("provider_login.gate", { provider: providerId, waitedMs, result: synced === "timeout" || applied === "timeout" ? "timeout" : "ok" });
    }
  }

  // ── Joining the shared ticks only for an account with ADE Cloud (F1) ──
  // An account without ADE Cloud, or a signed-out one, gets no periodic sync
  // and no timer from this service: the ticks are left, and the answer is not
  // asked again on a timer. A change is heard from `cloudAccess.ts` whenever
  // any caller in this process asks, and at account sign-in and sign-out.
  const ticks: Array<() => void> = [];
  let accessRecheck: ReturnType<typeof setTimeout> | null = null;
  let accessRecheckDelayMs = ACCESS_RECHECK_MIN_MS;
  let accessGeneration = 0;

  function joinTicks(): void {
    if (ticks.length) return;
    const vault = deps.vault();
    if (vault) {
      ticks.push(vault.startPeriodicSync(undefined, (syncStatus) => {
        if (syncStatus === "ready") void pass();
      }));
    }
    const releaseSettings = deps.settings()?.startPeriodicSync?.();
    if (releaseSettings) ticks.push(releaseSettings);
    if (!ticks.length) return;
    deps.logger.info("provider_login.ticks_joined", {});
    // One pass now from the cached vault (no network): capture starts, and a
    // cloud computer applies at boot without waiting for the first tick.
    void pass();
  }

  function leaveTicks(): void {
    if (!ticks.length) return;
    for (const release of ticks.splice(0)) release();
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
    deps.logger.info("provider_login.ticks_left", {});
  }

  function clearAccessRecheck(): void {
    if (accessRecheck) clearTimeout(accessRecheck);
    accessRecheck = null;
  }

  /** Read the ADE Cloud answer (free when cached) and join or leave the ticks to match. */
  let accessPending: Promise<CloudAccessState | null> | null = null;
  function refreshAccess(): Promise<CloudAccessState | null> {
    const pending = readAndMatchAccess().finally(() => {
      if (accessPending === pending) accessPending = null;
    });
    accessPending = pending;
    return pending;
  }

  async function readAndMatchAccess(): Promise<CloudAccessState | null> {
    if (deps.staticOff) return null;
    const generation = ++accessGeneration;
    const state: CloudAccessState = !deps.accountUserId() || !deps.vault()
      ? "signed_out"
      : await deps.cloudAccess().catch((): CloudAccessState => "unreadable");
    // A newer check (a sign-out during the ask) decides instead.
    if (generation !== accessGeneration) return state;
    if (state === "ready") joinTicks();
    else leaveTicks();
    if (state === "unreadable") {
      // Not an answer about the account: ask again later, backing off, until there is one.
      clearAccessRecheck();
      accessRecheck = setTimeout(() => {
        accessRecheck = null;
        void refreshAccess();
      }, accessRecheckDelayMs);
      accessRecheck.unref?.();
      accessRecheckDelayMs = Math.min(accessRecheckDelayMs * 2, ACCESS_RECHECK_MAX_MS);
    } else {
      clearAccessRecheck();
      accessRecheckDelayMs = ACCESS_RECHECK_MIN_MS;
    }
    return state;
  }

  return {
    /**
     * Hear sign-ins on this computer and check the account's ADE Cloud answer
     * once. The vault and settings ticks are joined only while that answer is
     * "ready" (`refreshAccess`). Does nothing when capture can never run here.
     */
    start(): void {
      if (deps.staticOff || releases.length) return;
      releases.push(onProviderLoginChanged((provider) => {
        if (!ticks.length) return;
        const row = PROVIDER_LOGIN_CARRY.find((entry) => entry.provider === provider);
        if (!row || row.carry !== "carried") return;
        clearTimeout(settleTimers.get(provider));
        const timer = setTimeout(() => {
          settleTimers.delete(provider);
          void pass([row.provider]);
        }, settleMs);
        timer.unref?.();
        settleTimers.set(provider, timer);
      }));
      const releaseAccess = deps.onCloudAccessChanged?.(() => void refreshAccess());
      if (releaseAccess) releases.push(releaseAccess);
      if (deps.cloudComputer) {
        installProviderLoginGate(gate);
        releases.push(() => installProviderLoginGate(null));
      }
      void refreshAccess();
    },
    stop(): void {
      for (const release of releases.splice(0)) release();
      leaveTicks();
      clearAccessRecheck();
      for (const timer of settleTimers.values()) clearTimeout(timer);
      settleTimers.clear();
    },
    refreshAccess,
    ...writes,
    pass,
    status,
    /** The person's "look now": one pass (still behind every gate), then the status. */
    async captureNow(provider?: ProviderLoginProvider | null): Promise<ProviderLoginStatus> {
      await pass(provider ? [provider] : null);
      return await status(provider);
    },
    /** On ADE sign-out: drop the marks; the vault purge removes the account copy here. */
    forgetAccount(): void {
      if (deps.cloudComputer) {
        // The account's sign-ins leave this cloud computer with the account.
        const onDisk = appliedCache ?? readAppliedState(deps.adeDir);
        appliedCache = null;
        applyStates.clear();
        appliedLoginHashes = new Set();
        if (onDisk && (Object.keys(onDisk.applied).length || Object.keys(onDisk.env).length)) {
          void removeAllApplied(onDisk, "signed_out").then(() => {
            try {
              writeAppliedState(deps.adeDir, emptyAppliedState(null));
            } catch {
              // Paths and hashes only; the next account's load starts it over.
            }
          });
        }
      }
      bundleMemos.clear();
      localStates.clear();
      metaMemo.clear();
      stateCache = null;
      try {
        removeProviderLoginState(deps.adeDir);
      } catch {
        // Nothing secret is in it; the next account's load starts it over anyway.
      }
    },
  };
}

export type ProviderLoginSync = ReturnType<typeof createProviderLoginSync>;

let processSync: ProviderLoginSync | null = null;

/** The brain installs its one service here at start; the actions read it. */
export function installProviderLoginSync(sync: ProviderLoginSync | null): void {
  processSync?.stop();
  processSync = sync;
  sync?.start();
}

export function providerLoginSync(): ProviderLoginSync | null {
  return processSync;
}

export const PROVIDER_LOGIN_NOT_THIS_RUNTIME = OFF_MESSAGES.not_this_runtime;
