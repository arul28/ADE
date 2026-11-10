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
  type ProviderLoginCaptureOffReason,
  type ProviderLoginLocalState,
  type ProviderLoginProvider,
  type ProviderLoginSignIn,
  type ProviderLoginStatus,
} from "../../../shared/types/providerLogins";
import { onProviderLoginChanged } from "../ai/providerLoginChanged";
import { isRecord } from "../shared/utils";
import { PROVIDER_LOGIN_CARRY, type CarryBundle, type CarryContext, type CarryRow, type ParsedLogin } from "./providerLoginCarry";
import {
  PROVIDER_LOGIN_MAX_CHARS,
  PROVIDER_LOGIN_VAULT_KIND,
  buildProviderLoginPayload,
  loginContentHash,
  originId,
  parseProviderLoginKey,
  providerLoginKey,
  readProviderLoginMeta,
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
  get(scope: string, kind: typeof PROVIDER_LOGIN_VAULT_KIND, key: string): string | null;
  set(scope: string, kind: typeof PROVIDER_LOGIN_VAULT_KIND, key: string, value: string, options?: { refreshOwner?: string | null }): boolean;
  remove(scope: string, kind: typeof PROVIDER_LOGIN_VAULT_KIND, key: string): boolean;
  health(): { state: "ok" | "failing" | "unavailable" };
  startPeriodicSync(intervalMs?: number, onSync?: (status: "ready" | "unavailable" | "failed") => void): () => void;
};

export type ProviderLoginSettings = {
  get(scope: string, key: string): unknown;
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
  not_checked: "Not checked on this computer.",
};

/** When one provider has several sign-ins (Pi), the state that says the most wins. */
const LOCAL_STATE_RANK: ProviderLoginLocalState[] = [
  "too_large", "unreadable", "settling", "other_owner_newer", "removed_from_account", "captured",
  "from_saved_key", "os_store", "not_signed_in", "not_checked",
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
    if (vault.health().state !== "ok") return "vault_unavailable";
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
    const written = vault.set(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, memo.key, value, {
      refreshOwner: login.class === "renewing" ? machine.deviceId : null,
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
    if (off) return;
    const vault = deps.vault()!;
    const machine = deps.machine();
    const accountUserId = deps.accountUserId();
    if (!machine || !accountUserId) return;
    const origin12 = originId(machine.machineKey);
    const state = loadState(accountUserId);
    const before = JSON.stringify(state);
    const rows = new Map<string, VaultRow>();
    for (const row of vault.list(ACCOUNT_SCOPE_ALL)) {
      if (row.kind === PROVIDER_LOGIN_VAULT_KIND) rows.set(row.key, row);
    }
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
          seenKeys.add(memo.key);
          const pushed = state.pushed[memo.key];
          if (pushed) {
            pushed.absentSince = null;
            pushed.absentPasses = 0;
          }
          const decision = decide(memo, vault, rows, state, machine);
          const local = decision.push && full
            ? push(row.provider, full, memo, vault, rows, state, machine)
            : decision.push ? "settling" : decision.state;
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
    };
  }

  return {
    /** Join the vault's tick and hear sign-ins on this computer. Does nothing when capture can never run here. */
    start(): void {
      if (deps.staticOff || releases.length) return;
      const vault = deps.vault();
      if (vault) {
        releases.push(vault.startPeriodicSync(undefined, (syncStatus) => {
          if (syncStatus === "ready") void pass();
        }));
      }
      const releaseSettings = deps.settings()?.startPeriodicSync?.();
      if (releaseSettings) releases.push(releaseSettings);
      releases.push(onProviderLoginChanged((provider) => {
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
    },
    stop(): void {
      for (const release of releases.splice(0)) release();
      for (const timer of settleTimers.values()) clearTimeout(timer);
      settleTimers.clear();
    },
    pass,
    status,
    /** The person's "look now": one pass (still behind every gate), then the status. */
    async captureNow(provider?: ProviderLoginProvider | null): Promise<ProviderLoginStatus> {
      await pass(provider ? [provider] : null);
      return await status(provider);
    },
    /** On ADE sign-out: drop the marks; the vault purge removes the account copy here. */
    forgetAccount(): void {
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
