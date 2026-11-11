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
 * Apply on cloud computers is step 2. Step 3a adds renewal ahead of expiry
 * on the owner computer (`providerLoginRenew.ts`), the short wait before a
 * turn on a cloud computer whose copy is about to expire, and the person's
 * one Keychain read on a Mac (`allowKeychain`).
 *
 * Step 3b (the owner's yes of 2026-11-10): when the owner computer is off
 * and the copy is past its expiry + 60 s, the cloud computer whose turn
 * waits takes the renewal over (`decideRotatingRenewal`, 60 s grace), gets
 * the full copy, renews it and pushes it as the new owner. The origin, when
 * it wakes, writes that newer copy of its OWN sign-in into its login file
 * (the write-back), and claims the renewal back by the normal rule.
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
  type ProviderLoginChatNotice,
  type ProviderLoginGhCliStatus,
  type ProviderLoginGateOptions,
  type ProviderLoginGateOutcome,
  type ProviderLoginLocalState,
  type ProviderLoginProvider,
  type ProviderLoginProviderStatus,
  type ProviderLoginSignIn,
  type ProviderLoginStatus,
} from "../../../shared/types/providerLogins";
import { CLOUD_SIGN_INS } from "../../../shared/cloudSignIns";
import {
  ROTATING_CLAIM_SETTLE_MS,
  decideRotatingRenewal,
  rotatingRenewalRole,
  type RotatingCredentialVault,
  type RotatingRenewalVerdict,
} from "../account/rotatingCredentialOwner";
import { noteProviderLoginChanged, onProviderLoginChanged } from "../ai/providerLoginChanged";
import { isRecord } from "../shared/utils";
import {
  ANTIGRAVITY_SETTINGS_REL,
  GH_BUNDLE_ID,
  GH_READ_PART,
  GH_TOKEN_PART,
  PROVIDER_LOGIN_CARRY,
  antigravityBundle,
  carryRow,
  parseAntigravitySettings,
  type CarryBundle,
  type CarryContext,
  type CarryRow,
  type ParsedLogin,
} from "./providerLoginCarry";
import {
  antigravityKeychainAccount,
  decodeKeychainSecret,
  readKeychainSecret,
  type AntigravityKeychainSlot,
} from "./providerLoginKeychain";
import { createOwnerRenewal, type OwnerRenewTarget, type ProviderLoginRenewer } from "./providerLoginRenew";
import { copilotCarriedHash, setCopilotCarriedToken } from "./providerLoginCopilotEnv";
import {
  GH_READ_MESSAGES,
  ghReadEnv,
  isClassicGitHubToken,
  readGhHostsGithubCom,
  runGhAuthToken,
  type GhTokenRead,
  type GhTokenRunner,
} from "./providerLoginGhCli";
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
  writeBackSignIn,
  type AppliedEntry,
  type AppliedStateFile,
} from "./providerLoginApply";
import {
  installProviderLoginGate,
  notifyProviderLoginPass,
  notifyProviderLoginsChanged,
  readProviderLoginStatusParts,
  restartProviderRuntimesWhenIdle,
  type ProviderLoginRestartOptions,
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
  withoutTakenFrom,
  type ProviderLoginMachine,
} from "./providerLoginPayload";
import {
  readProviderLoginState,
  removeProviderLoginState,
  sameMarks,
  writeProviderLoginState,
  type FileMark,
  type GhCliChoice,
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
/** A copy here with less than this left makes a turn wait for a fresh one (§5.3 steps 1 and 2). */
const SHORT_WAIT_LEFT_MS = 60_000;
/** The owner may be renewing right now while the copy is no more than this past its expiry. */
const SHORT_WAIT_RENEWING_MS = 60_000;
const SHORT_WAIT_POLL_MS = 5_000;
const SHORT_WAIT_POLL_LIMIT_MS = 20_000;
/** The whole gate, with the short wait and a takeover, never passes this. Then the turn goes ahead (`owner_off`). */
const SHORT_WAIT_GATE_LIMIT_MS = 45_000;
/** A cloud computer takes the renewal over only this long past the copy's expiry (and its last write), P5 §5.2. */
const TAKEOVER_GRACE_MS = 60_000;

/**
 * The providers a cloud computer can take the renewal over for, and how it
 * renews: "renew" by ADE's renew call (the provider's CLI, one process),
 * "cli" by the provider's own CLI when the turn starts on the full copy.
 * Droid has no expiry ADE can read, so no turn ever waits for it. Pi's
 * Anthropic login is never carried. Every other carried provider is Fixed.
 */
const TAKEOVER_HOW: Partial<Record<ProviderLoginProvider, "renew" | "cli">> = {
  codex: "renew",
  grok: "renew",
  kimi: "cli",
  pi: "cli",
};

const PROVIDER_NAMES: Partial<Record<ProviderLoginProvider, string>> = {
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  pi: "Pi",
  droid: "Droid",
};

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
  /** Keys with a write the account service has not taken yet (queued, or parked). */
  pendingKeys?(scope: string, kind: typeof PROVIDER_LOGIN_VAULT_KIND): string[];
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
  /**
   * Renewal ahead of expiry on the owner computer (step 3a): the proxy's renew
   * call and shared machine lock, from the brain. Absent: no renewal ahead.
   */
  renewer?: ProviderLoginRenewer | null;
  /**
   * Whether the account has at least one cloud computer now. Asked only when a
   * sign-in owned here is otherwise due a planned renewal. null (unknown) or
   * absent: no renewal ahead, no timer.
   */
  cloudComputerExists?: () => Promise<boolean | null>;
  /** The `security` command for the person's Keychain read. The scratch checks pass a fake one. */
  keychainCommand?: string;
  /**
   * The one `gh auth token --hostname github.com` read for Copilot's GitHub
   * CLI login (G1). Default: the real, reaped process. The scratch checks pass
   * a fake one and count its calls.
   */
  ghTokenRunner?: GhTokenRunner;
  /**
   * The account vault as `decideRotatingRenewal` reads it (the brain passes
   * `createHeadlessAccountVaultBridge` over the same store). Absent: no
   * takeover on a cloud computer and no claim back on the origin (step 3b).
   */
  rotatingVault?: () => RotatingCredentialVault | null;
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

/**
 * Capture off for these reasons still takes the GitHub CLI choice (G1): the
 * one read runs at once, and nothing leaves the computer until capture is on.
 */
const GH_ALLOW_WHILE_OFF: ReadonlySet<ProviderLoginCaptureOffReason> = new Set(["all_off", "vault_unavailable"]);
/** The read on the person's click waits for a keychain or keyring prompt; a read after a file change does not wait as long. */
const GH_READ_ON_CLICK_MS = 120_000;
const GH_READ_MS = 20_000;

const LOCAL_MESSAGES: Record<ProviderLoginLocalState, string> = {
  captured: "In your account.",
  not_signed_in: "Not signed in on this computer.",
  os_store: "The sign-in is in the OS keychain or keyring. ADE does not read it in the background.",
  settling: "The login file just changed. ADE reads it on the next pass.",
  too_large: "This sign-in is too big for your account.",
  unreadable: "ADE found a login file but could not read a sign-in from it.",
  removed_from_account: "You removed this sign-in from your account. Sign in again here to add it back.",
  other_owner_newer: "Another computer renews this sign-in, so your account keeps that computer's copy.",
  written_back: "A cloud computer renewed this sign-in while this computer was off. ADE wrote the newer copy into the login file here.",
  from_saved_key: "This file came from a saved ADE Cloud key. It stays a key.",
  from_account: "This is the account's sign-in. ADE wrote it on this cloud computer.",
  account_refused: "Your account service doesn't take sign-ins yet. ADE keeps this one on this computer and tries again every hour.",
  not_checked: "Not checked on this computer.",
};

/** When one provider has several sign-ins (Pi), the state that says the most wins. */
const LOCAL_STATE_RANK: ProviderLoginLocalState[] = [
  "account_refused", "too_large", "unreadable", "settling", "other_owner_newer", "removed_from_account", "written_back", "captured",
  "from_account", "from_saved_key", "os_store", "not_signed_in", "not_checked",
];

/** `smartBalance` is read only for the status; its writes go through `setCloudBalance` (P6 reads it too). */
type CloudSetting = { enabled: boolean; inUse: Record<string, string>; off: string[]; smartBalance: boolean };

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
    // Absent = false: the switch is off at the start.
    smartBalance: isRecord(record.claude) && record.claude.smartBalance === true,
  };
}

/**
 * What ADE Cloud picks one sign-in for. One per provider, except Pi, whose
 * sub-providers (xAI, OpenRouter, ...) are separate logins: `pi:<sub>`.
 */
export function cloudChoiceKey(provider: ProviderLoginProvider, slot: string): string {
  return provider === "pi" ? `pi:${slot}` : provider;
}

type LoginMemo = {
  slot: string;
  key: string;
  contentHash: string;
  familyHash: string;
  class: ParsedLogin["class"];
  expiresAt: number | null;
  account: ParsedLogin["account"];
};

/** The same account identity: both unknown, or every field either side knows is the same. */
function sameAccount(left: ParsedLogin["account"], right: ParsedLogin["account"]): boolean {
  if (!left || !right) return !left && !right;
  const fields = ([["email", left.email, right.email], ["id", left.id, right.id]] as const)
    .filter(([, mine, theirs]) => mine != null || theirs != null);
  return fields.length > 0 && fields.every(([, mine, theirs]) => mine === theirs);
}

const accountHash = (account: ParsedLogin["account"]): string => shortHash(JSON.stringify(account ?? null));

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, Math.max(0, ms));
  timer.unref?.();
});
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
  // Copilot's GitHub CLI login (G1): the last read by the marks of hosts.yml
  // (memory only; it holds the token so a forced re-read never runs gh again),
  // and the person's click that forces the next read.
  const ghRunner = deps.ghTokenRunner ?? runGhAuthToken;
  let ghMemo: { mark: string; read: GhTokenRead } | null = null;
  let ghForce = false;

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
    if (bundle.id === GH_BUNDLE_ID && !forceRead && !memo) {
      // After a restart of the brain: the gh login read before, unchanged since, and in the account. No gh process.
      const restored = restoreGhMemo(bundle, marks, state, origin12);
      if (restored) return restored;
    }
    const contents = await stableRead(bundle, marks);
    // Not stable yet: keep the old marks, so the next pass reads it again.
    if (!contents) return { kind: "settling" };
    if (bundle.id === GH_BUNDLE_ID) await ghTokenStep(contents, JSON.stringify(marks), state);
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
        account: login.account,
      },
      full: login,
    }));
    bundleMemos.set(bundle.id, { logins: logins.map((login) => login.memo), skipped: parsed.skipped });
    return { kind: "parsed", logins, skipped: parsed.skipped };
  }

  /**
   * Copilot's GitHub CLI login (G1): give the parse the token. The file's own
   * token (gh's plain-text storage) needs no process. Otherwise one `gh auth
   * token` runs, only after the person turned it on, and only when hosts.yml
   * changed since the last read or the person pressed again. A read that gave
   * no token waits for the file to change (no retry on the tick).
   */
  async function ghTokenStep(contents: Map<string, Buffer>, mark: string, state: ProviderLoginStateFile): Promise<void> {
    const choice = state.ghCli;
    if (!choice) return;
    const host = readGhHostsGithubCom(contents.get("hosts.yml")?.toString("utf8") ?? null);
    const record = (result: NonNullable<GhCliChoice["read"]>["result"]) => {
      choice.read = { mark, at: now(), result, user: host.user };
    };
    if (!host.user && !host.token) {
      if (choice.read?.mark !== mark) record("no_token");
      return;
    }
    if (host.token) {
      if (choice.read?.mark !== mark) record(isClassicGitHubToken(host.token) ? "classic_token" : "ok");
      return;
    }
    let read: GhTokenRead | null = null;
    if (!ghForce && ghMemo?.mark === mark) {
      read = ghMemo.read;
    } else if (!ghForce && choice.read?.mark === mark && choice.read.result !== "ok") {
      // The last read gave no token and the file has not changed: wait for a change or the person's click.
      contents.set(GH_READ_PART, Buffer.from(choice.read.result));
      return;
    }
    if (!read) {
      const timeoutMs = ghForce ? GH_READ_ON_CLICK_MS : GH_READ_MS;
      ghForce = false;
      read = await ghRunner({ env: ghReadEnv(env, platform), timeoutMs }).catch((): GhTokenRead => ({ ok: false, reason: "failed" }));
      ghMemo = { mark, read };
      record(read.ok ? (isClassicGitHubToken(read.token) ? "classic_token" : "ok") : read.reason);
      deps.logger.info("provider_login.gh_read", { result: choice.read!.result });
    }
    if (read.ok && !isClassicGitHubToken(read.token)) contents.set(GH_TOKEN_PART, Buffer.from(read.token));
    else contents.set(GH_READ_PART, Buffer.from(read.ok ? "classic_token" : read.reason));
  }

  /** The gh login's memo from the marks file, when the last read was a token, hosts.yml is unchanged, and this computer pushed it. */
  function restoreGhMemo(bundle: CarryBundle, marks: FileMark[], state: ProviderLoginStateFile, origin12: string): BundleObservation | null {
    const read = state.ghCli?.read;
    if (!read || read.result !== "ok" || read.mark !== JSON.stringify(marks)) return null;
    const key = providerLoginKey("copilot", origin12, "gh");
    const pushed = state.pushed[key];
    if (!pushed) return null;
    const login: LoginMemo = {
      slot: "gh",
      key,
      contentHash: pushed.pushedHash,
      familyHash: pushed.familyHash,
      class: "fixed",
      expiresAt: null,
      account: read.user ? { email: null, id: read.user } : null,
    };
    state.bundles[bundle.id] = { files: marks };
    bundleMemos.set(bundle.id, { logins: [login], skipped: [] });
    return { kind: "parsed", logins: [{ memo: login, full: null }], skipped: [] };
  }

  type PushDecision = { push: false; state: ProviderLoginLocalState; writeBack?: true } | { push: true };

  /**
   * The copy here is of the sign-in this item holds: its family, an earlier
   * one the lineage lists, the family a takeover started from (`takenFrom`,
   * never evicted: step 3c), or the very copy a write-back put here.
   */
  function ofSameSignIn(
    meta: { familyHash: string; lineage: string[]; takenFrom: string | null },
    login: LoginMemo,
    state: ProviderLoginStateFile,
  ): boolean {
    if (meta.familyHash === login.familyHash || meta.lineage.includes(login.familyHash)) return true;
    if (meta.takenFrom === login.familyHash) return true;
    return state.writtenBack?.[login.key]?.contentHash === login.contentHash;
  }

  /** `later` is a later expiry than `than`; false when either is unknown. */
  const laterExpiry = (later: number | null, than: number | null): boolean => later != null && than != null && later > than;

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
    const meta = metaFor(vault, row);
    // The copy the write-back wrote here: never pushed back (no echo). Once the file changes, the normal rules apply.
    const back = state.writtenBack?.[login.key];
    if (back) {
      if (back.contentHash === login.contentHash) {
        // The cloud computer renewed it again since: write that copy back too (writeBack checks every limit).
        const again = meta != null
          && meta.contentHash !== (back.accountHash ?? back.contentHash)
          && meta.origin.deviceId === machine.deviceId
          && Boolean(row.refreshOwner) && row.refreshOwner !== machine.deviceId;
        return again ? { push: false, state: "written_back", writeBack: true } : { push: false, state: "written_back" };
      }
      delete state.writtenBack![login.key];
    }
    // What this computer last pushed, and the account still holds it. (A write that lost to a newer one is not "captured".)
    if (pushed?.pushedHash === login.contentHash && meta?.contentHash === login.contentHash) return { push: false, state: "captured" };
    if (meta?.contentHash === login.contentHash) {
      state.pushed[login.key] = { pushedHash: login.contentHash, familyHash: login.familyHash, pushedAt: now(), absentSince: null, absentPasses: 0 };
      return { push: false, state: "captured" };
    }
    if (login.class === "renewing" && row.refreshOwner && row.refreshOwner !== machine.deviceId && meta) {
      // Another computer renews this sign-in now. A copy of its family (the
      // same family, or an earlier one of the same sign-in) never goes over
      // that computer's copy, with two exceptions on the origin after a
      // cloud computer took the renewal over (design §3.4, step 3b).
      const ofFamily = ofSameSignIn(meta, login, state);
      // The local file is the very copy this computer last put in the account: nothing new here.
      const unchanged = pushed?.pushedHash === login.contentHash;
      const originAfterTakeover = !deps.cloudComputer
        && meta.origin.deviceId === machine.deviceId
        && row.refreshOwner !== meta.origin.deviceId;
      if (ofFamily) {
        // §3.4 row 3: the CLI here renewed by itself to a later expiry. It holds the newest family: push and own it again.
        if (originAfterTakeover && !unchanged && laterExpiry(login.expiresAt, meta.expiresAt)) return { push: true };
        // The write-back: the account holds a newer copy of this very sign-in, and the file here is unchanged since capture.
        if (originAfterTakeover && unchanged) return { push: false, state: "other_owner_newer", writeBack: true };
        return { push: false, state: "other_owner_newer" };
      }
      // An old copy this computer pushed before, whose family the account no longer lists: never pushed again.
      if (unchanged) return { push: false, state: "other_owner_newer" };
    }
    // A new family here is a new sign-in (§3.4 row 1): it goes up, and names this computer the owner.
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
    takeover: { place: string } | null = null,
  ): ProviderLoginLocalState {
    const row = rows.get(memo.key);
    const previous = row && !row.deleted
      ? readProviderLoginMeta(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, memo.key))
      : null;
    const payload = buildProviderLoginPayload({
      provider,
      login,
      machine,
      previous,
      now: now(),
      // A cloud computer that took the renewal over pushes into the origin's key: the origin stays, and the lineage grows.
      ...(takeover ? { renewal: { cloud: deps.cloudComputer } } : {}),
    });
    const value = JSON.stringify(payload);
    if (value.length > PROVIDER_LOGIN_MAX_CHARS) {
      deps.logger.warn("provider_login.capture_too_large", { provider, slot: memo.slot, chars: value.length });
      return "too_large";
    }
    // Every write names the owner: the store would clear it otherwise (P4 §4).
    // A cloud computer names itself only for a sign-in it took the renewal
    // over for (step 3b); a sign-in made on it renews nowhere (no owner).
    const owner = login.class === "renewing" && (!deps.cloudComputer || takeover) ? machine.deviceId : null;
    const written = vault.set(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, memo.key, value, { refreshOwner: owner });
    if (!written) {
      deps.logger.warn("provider_login.capture_write_refused", { provider, slot: memo.slot });
      return "not_checked";
    }
    state.pushed[memo.key] = { pushedHash: memo.contentHash, familyHash: memo.familyHash, pushedAt: now(), absentSince: null, absentPasses: 0 };
    if (state.signedOut?.[memo.key]) delete state.signedOut[memo.key];
    deps.logger.info("provider_login.captured", {
      provider,
      slot: memo.slot,
      class: login.class,
      chars: value.length,
      ...(takeover ? { takeover: true } : {}),
    });
    if (takeover) noteOwnedCopy(takeover.place, memo, payload.expiresAt);
    return "captured";
  }

  async function runPass(providers: Set<ProviderLoginProvider> | null): Promise<void> {
    const off = await captureOffReason();
    lastPassAt = now();
    // Capture off for any reason: no renewal ahead, and no timer for one.
    if (off) {
      planGeneration += 1;
      ownerRenewal?.plan([]);
    }
    // The account lost ADE Cloud or signed out between two answers: stop riding the ticks.
    if (off === "no_ade_cloud" || off === "signed_out") leaveTicks();
    if (off === "all_off") {
      // Nothing is captured. On a cloud computer the switched-off sign-ins
      // leave and its saved keys stay managed (the switch covers sign-ins only).
      const vault = deps.vault();
      const machine = deps.machine();
      const accountUserId = deps.accountUserId();
      if (vault && machine && accountUserId) {
        if (deps.cloudComputer) {
          await runApply(vault, accountUserId, originId(machine.machineKey), machine.deviceId, providers, false);
          checkArmed();
        }
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
    const writeBacks: Array<{ provider: ProviderLoginProvider; memo: LoginMemo; slotId: string; bundleId: string }> = [];
    const removedThisPass = new Set<string>();

    for (const row of PROVIDER_LOGIN_CARRY) {
      if (row.carry !== "carried" || !row.locate || !row.parse) continue;
      if (providers && !providers.has(row.provider)) continue;
      localStates.set(row.provider, new Map());
      if (row.provider === "copilot" && (deps.cloudComputer || !state.ghCli)) {
        // The GitHub CLI login is read only after the person turns it on here
        // (G1); never on a cloud computer. Not looked at, so not "signed in":
        // a copy pushed before the person turned it off leaves by the absence rule.
        if (deps.cloudComputer) uncertain.add(row.provider);
        continue;
      }
      const bundles = row.locate(ctx);
      // Not looked at here (Antigravity on a Mac, read only on the person's
      // Allow): its sign-in is not "gone from this computer".
      if (!bundles.length) uncertain.add(row.provider);
      for (const bundle of bundles) {
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
        // gh is missing, timed out or failed: the login may still be there, so it does not leave the account.
        if (bundle.id === GH_BUNDLE_ID && observation.skipped.some((skipped) => skipped.state === "unreadable")) uncertain.add(row.provider);
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
        for (const { memo: observed, full } of observation.logins) {
          if (deps.cloudComputer && appliedLoginHashes.has(observed.contentHash)) {
            // The account's sign-in that apply wrote here: never captured back, and
            // the sign-in it replaced (made here) is not "signed out here".
            setLocal(row.provider, `${bundle.id}:${observed.slot}`, "from_account", null);
            uncertain.add(row.provider);
            continue;
          }
          // A sign-in this cloud computer took the renewal over for, renewed here
          // (by ADE or by its CLI): it goes back into that sign-in's own key, never
          // into a new one, and only while this computer still owns it (step 3b).
          const takeover = deps.cloudComputer ? ownedPlaceFor(row.provider, observed) : null;
          const memo = takeover ? { ...observed, key: takeover.source } : observed;
          if (takeover) {
            uncertain.add(row.provider);
            const ownedRow = rows.get(takeover.source);
            if (!ownedRow || ownedRow.deleted || ownedRow.refreshOwner !== machine.deviceId) {
              // The person removed it, or the origin claimed it back: never pushed from here.
              setLocal(row.provider, `${bundle.id}:${memo.slot}`, "from_account", null);
              continue;
            }
          } else {
            seenKeys.add(memo.key);
          }
          const pushed = state.pushed[memo.key];
          if (pushed) {
            pushed.absentSince = null;
            pushed.absentPasses = 0;
          }
          const decision = decide(memo, vault, rows, state, machine);
          if (!decision.push && decision.writeBack) {
            writeBacks.push({ provider: row.provider, memo, slotId: `${bundle.id}:${memo.slot}`, bundleId: bundle.id });
          }
          let local: ProviderLoginLocalState = decision.push && full
            ? push(row.provider, full, memo, vault, rows, state, machine, takeover ? { place: takeover.place } : null)
            : decision.push ? "settling" : decision.state;
          if (decision.push && full && local === "captured") accountChanged = true;
          // Written here, but the account service will not take it: say so, never "in your account".
          if (local === "captured" && parked.has(memo.key)) local = "account_refused";
          setLocal(row.provider, `${bundle.id}:${memo.slot}`, local, memo.key);
        }
      }
    }

    // The write-back (step 3b): the newer copy of this computer's own sign-in, into its login file.
    for (const candidate of writeBacks) {
      if (await writeBack(candidate, vault, rows, state, machine)) setLocal(candidate.provider, candidate.slotId, "written_back", candidate.memo.key);
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
      if (state.writtenBack?.[key]) delete state.writtenBack[key];
      // Kept, so a copy that comes back into the account while the person is still signed out here leaves again.
      state.signedOut = { ...(state.signedOut ?? {}), [key]: now() };
      removedThisPass.add(key);
    }

    // A sign-in the person signed out of here that is back in the account (a
    // cloud computer's write that crossed the removal): removed again, while
    // the person is still signed out here. A new sign-in here clears the mark.
    for (const key of Object.keys(state.signedOut ?? {})) {
      const parsedKey = parseProviderLoginKey(key);
      if (!parsedKey || parsedKey.origin12 !== origin12 || seenKeys.has(key)) {
        delete state.signedOut![key];
        continue;
      }
      if ((providers && !providers.has(parsedKey.provider)) || uncertain.has(parsedKey.provider) || removedThisPass.has(key)) continue;
      const row = rows.get(key);
      if (row && !row.deleted && vault.remove(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key)) {
        accountChanged = true;
        deps.logger.info("provider_login.removed", { provider: parsedKey.provider, slot: parsedKey.slot, reason: "signed_out_at_origin_again" });
      }
    }

    if (JSON.stringify(state) !== before) {
      try {
        writeProviderLoginState(deps.adeDir, state);
      } catch (error) {
        deps.logger.warn("provider_login.state_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
      }
    }
    if (accountChanged) notifyProviderLoginsChanged();
    if (deps.cloudComputer) {
      await runApply(vault, accountUserId, origin12, machine.deviceId, providers, true);
      checkArmed();
    }
    await planRenewals(vault, machine, origin12, state);
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

  function signInsFromVault(vault: ProviderLoginVault | null, origin12: string | null, setting: CloudSetting, deviceId: string | null = null): ProviderLoginSignIn[] {
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
        renewedByCloud: meta.renewedBy?.cloud === true,
        renewsNow: renewsNowOf(row, meta, deviceId),
        expiresAt: iso(meta.expiresAt),
        onForCloud: !setting.off.includes(row.key),
        inUseOnCloud: false,
      });
    }
    // In use on ADE Cloud: the person's choice, else the newest switched-on sign-in.
    // Copilot with no pick and a saved key uses the key (G1 Q2), as apply does.
    const savedCopilotKey = vault.list(ACCOUNT_SCOPE_ALL).some((row) => row.kind === "integration" && row.key === "cloud-key-copilot" && !row.deleted);
    const byProvider = new Map<string, ProviderLoginSignIn[]>();
    for (const signIn of signIns) {
      const place = cloudChoiceKey(signIn.provider, signIn.slot);
      byProvider.set(place, [...(byProvider.get(place) ?? []), signIn]);
    }
    for (const [place, list] of byProvider) {
      const chosen = setting.inUse[place];
      if (chosen === "key") continue;
      if (place === "copilot" && chosen === undefined && savedCopilotKey) continue;
      const on = list.filter((signIn) => signIn.onForCloud);
      const pick = on.find((signIn) => signIn.key === chosen)
        ?? [...on].sort((left, right) => (right.renewedAt ?? right.capturedAt ?? "").localeCompare(left.renewedAt ?? left.capturedAt ?? ""))[0];
      if (pick && setting.enabled) pick.inUseOnCloud = true;
    }
    return signIns.sort((left, right) => left.key.localeCompare(right.key));
  }

  /** Who renews a sign-in now (the vault's owner), for the status (step 3b). */
  function renewsNowOf(
    row: VaultRow,
    meta: NonNullable<ReturnType<typeof readProviderLoginMeta>>,
    deviceId: string | null,
  ): ProviderLoginSignIn["renewsNow"] {
    const owner = row.refreshOwner;
    if (!owner || meta.class !== "renewing") return null;
    const thisComputer = Boolean(deviceId && owner === deviceId);
    if (owner === meta.origin.deviceId) return { label: meta.origin.label, cloudComputer: false, thisComputer };
    if (thisComputer) return { label: deps.machine()?.label ?? meta.renewedBy?.label ?? "", cloudComputer: deps.cloudComputer, thisComputer };
    if (meta.renewedBy && meta.renewedBy.machineKey !== meta.origin.machineKey) {
      return { label: meta.renewedBy.label, cloudComputer: meta.renewedBy.cloud === true, thisComputer };
    }
    // Claimed, and not renewed yet by its new owner: the name is not in the item yet.
    return { label: "another computer", cloudComputer: false, thisComputer };
  }

  async function status(provider?: ProviderLoginProvider | null): Promise<ProviderLoginStatus> {
    const off = await captureOffReason();
    const vault = deps.staticOff ? null : deps.vault();
    const machine = deps.staticOff ? null : deps.machine();
    const setting = cloudSetting();
    const origin12 = machine ? originId(machine.machineKey) : null;
    const signIns = signInsFromVault(deps.accountUserId() ? vault : null, origin12, setting, machine?.deviceId ?? null)
      .filter((signIn) => !provider || signIn.provider === provider);
    const accountUserId = deps.staticOff ? null : deps.accountUserId();
    const writtenBack = accountUserId ? loadState(accountUserId).writtenBack ?? {} : {};
    const ghCli = !provider || provider === "copilot" ? await ghCliStatus(off) : null;
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
        let message = row.carry === "carried" && best.state !== "not_checked" ? LOCAL_MESSAGES[best.state] : row.message;
        const back = best.state === "written_back" && best.key ? writtenBack[best.key] ?? null : null;
        if (back) message = `Renewed by ${back.renewedBy}. ADE wrote the newer copy into the login file here.`;
        const keychain = keychainStatus(row.provider, off, vault);
        if (keychain?.key && !off) {
          best = { state: "captured", key: keychain.key };
          message = keychain.part.message;
        }
        if (row.provider === "copilot" && ghCli) message = ghCliMessage(ghCli, off, message);
        return {
          provider: row.provider,
          carry: row.carry,
          message,
          local: {
            state: best.state,
            key: best.key,
            ...(back ? { writtenBack: { at: new Date(back.at).toISOString(), renewedBy: back.renewedBy } } : {}),
          },
          ...(keychain ? { keychain: keychain.part } : {}),
          ...(row.provider === "copilot" && ghCli ? { ghCli } : {}),
        };
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
      cloud: { enabled: setting.enabled, inUse: { ...setting.inUse }, claude: { smartBalance: setting.smartBalance } },
      signIns,
      providers,
      applied: deps.cloudComputer && !deps.staticOff ? appliedStatus(provider ?? null) : null,
      // Fields other packages add (P6: `claudePasses`), never the sync's own.
      ...(deps.staticOff ? {} : await readProviderLoginStatusParts(provider ?? null)),
    };
  }

  /**
   * This computer's GitHub CLI login for Copilot (G1), on a person's own
   * computer only. `present` and `user` are from hosts.yml (a file read, no
   * process, no keychain); the rest is the person's choice and the last read.
   */
  async function ghCliStatus(off: ProviderLoginCaptureOffReason | null): Promise<ProviderLoginGhCliStatus | null> {
    if (deps.cloudComputer || deps.staticOff) return null;
    const accountUserId = deps.accountUserId();
    const choice = accountUserId ? loadState(accountUserId).ghCli ?? null : null;
    const hostsPath = carryRow("copilot").locate!(ctx)[0]!.files[0]!.abs;
    let raw: string | null = null;
    try {
      raw = await fs.promises.readFile(hostsPath, "utf8");
    } catch {
      // No hosts.yml: gh is not signed in here.
    }
    const host = readGhHostsGithubCom(raw);
    const read = choice?.read ?? null;
    const failed = read && (read.result === "not_installed" || read.result === "timeout" || read.result === "failed") ? read.result : null;
    return {
      present: Boolean(host.user || host.token),
      user: host.user,
      allowed: Boolean(choice),
      canAllow: Boolean(accountUserId) && (!off || GH_ALLOW_WHILE_OFF.has(off)),
      ...(choice && read?.result === "classic_token" ? { unsupported: "classic_token" as const } : {}),
      ...(choice && failed ? { lastError: GH_READ_MESSAGES[failed] } : {}),
      ...(choice && read ? { lastReadAt: new Date(read.at).toISOString() } : {}),
    };
  }

  function ghCliMessage(gh: ProviderLoginGhCliStatus, off: ProviderLoginCaptureOffReason | null, fallback: string): string {
    if (!gh.allowed) {
      return gh.present
        ? "Off on this computer. Turn it on to copy this computer's GitHub CLI login for Copilot on ADE Cloud."
        : "The GitHub CLI on this computer is not signed in to github.com. Run `gh auth login`, then turn this on.";
    }
    if (gh.unsupported === "classic_token") return "This GitHub CLI login uses a classic token (ghp_). Copilot does not take it, so ADE does not copy it.";
    if (gh.lastError) return gh.lastError;
    if (off === "all_off") return "On for this computer. Nothing leaves this computer while sign-ins for ADE Cloud are switched off.";
    return fallback;
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
          ownerOff: ownerOff.has(place) ? { ownerLabel: ownerOff.get(place)!.ownerLabel, at: new Date(ownerOff.get(place)!.at).toISOString() } : null,
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
  async function saveSetting(next: CloudSetting, dropKey: string | null = null, claude: Record<string, unknown> | null = null): Promise<ProviderLoginStatus> {
    const { vault, settings } = await writableStores();
    const live = liveSignInKeys(vault);
    const keep = (key: string) => key !== dropKey && (isClaudePassKey(key) || live.has(key));
    const inUse = Object.fromEntries(Object.entries(next.inUse).filter(([, key]) => key === "key" || keep(key)));
    const off = [...new Set(next.off.filter(keep))].sort();
    const raw = settings.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGINS_CLOUD_SETTING);
    const unknownFields = isRecord(raw) ? raw : {};
    const fields = { ...unknownFields, v: 1, enabled: next.enabled, inUse, off, ...(claude ? { claude } : {}) };
    if (!settings.set(ACCOUNT_SCOPE_ALL, PROVIDER_LOGINS_CLOUD_SETTING, fields)) {
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
    /**
     * Claude's smart balance on ADE Cloud: `claude.smartBalance` in the account
     * setting, the other fields of `claude` kept. One switch for ADE Cloud,
     * apart from each own computer's switch; nothing syncs between them.
     * P6's reconcile reads it.
     */
    async setCloudBalance(args: { provider: "claude"; on: boolean }): Promise<ProviderLoginStatus> {
      if (args.provider !== "claude") throw new Error("Only Claude has a smart balance on ADE Cloud.");
      const { settings } = await writableStores();
      const raw = settings.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGINS_CLOUD_SETTING);
      const claude = isRecord(raw) && isRecord(raw.claude) ? raw.claude : {};
      return await saveSetting(cloudSetting(), null, { ...claude, smartBalance: args.on });
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
    | {
      kind: "signin";
      place: string;
      provider: ProviderLoginProvider;
      slot: string;
      key: string;
      contentHash: string;
      class: ParsedLogin["class"];
      own: boolean;
      /** This cloud computer owns the renewal (it took it over): the full copy goes here (step 3b). */
      owned: boolean;
    }
    | { kind: "key"; place: string; provider: ProviderLoginProvider; id: string; token: string; contentHash: string };

  let appliedCache: AppliedStateFile | null = null;
  /** What the first apply took out of the env (fix B1); null until then. Values stay in memory only. */
  let envTaken: Readonly<Record<string, string>> | null = null;
  const applyStates = new Map<string, { state: ProviderLoginApplyState; key: string | null }>();
  /** The last turn whose short wait ended without a fresh copy, by place (cleared when a new copy applies). */
  const ownerOff = new Map<string, { ownerLabel: string; at: number }>();
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
    // Copilot's token lives only in the launch helper (G1).
    setCopilotCarriedToken(null);
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
    // Files apply only adds a part to (Kimi's config, Antigravity's settings) are left out.
    const kimiConfigs = new Set(entries.flatMap((entry) => [entry.kimiConfig?.path, entry.antigravity?.path].filter((abs): abs is string => Boolean(abs))));
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

  function afterApplyChange(provider: string, switched?: ProviderLoginRestartOptions["switched"]): void {
    noteProviderLoginChanged(provider);
    restartProviderRuntimesWhenIdle(provider, switched ? { switched } : undefined);
  }

  /** The words for a pick in "Switched to <label>." (step 3d): the account's email, else the computer the sign-in came from. */
  function pickLabel(vault: ProviderLoginVault, key: string): string {
    if (key === "key") return "your saved key";
    const row = vault.list(ACCOUNT_SCOPE_ALL).find((entry) => entry.kind === PROVIDER_LOGIN_VAULT_KIND && entry.key === key);
    const meta = row && !row.deleted ? metaFor(vault, row) : null;
    const email = meta?.account?.email?.trim();
    if (email) return email;
    return meta?.origin.label ? `Sign-in from ${meta.origin.label}` : "an earlier sign-in";
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
  function desiredPlaces(vault: ProviderLoginVault, setting: CloudSetting, origin12: string, deviceId: string): Map<string, Want> {
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
      // Copilot with no pick: a saved key goes before a carried GitHub CLI login (G1 Q2).
      const keyFirst = chosen === "key" || (chosen === undefined && list[0]!.provider === "copilot");
      const savedToken = saved && keyFirst ? savedKeyToken(saved.id, vault) : null;
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
        owned: pick.meta.class === "renewing" && parsedKey.origin12 !== origin12 && pick.row.refreshOwner === deviceId,
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

  function saveApplied(): void {
    if (!appliedCache) return;
    rememberAppliedHashes(appliedCache);
    try {
      writeAppliedState(deps.adeDir, appliedCache);
    } catch (error) {
      deps.logger.warn("provider_login.applied_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
    }
  }

  /**
   * The place of a sign-in this cloud computer took the renewal over for,
   * when `login` (read here, not the copy apply wrote) is that sign-in renewed
   * here: the same provider and slot, and the same account. Its files are
   * then recorded as ADE's again, so they still leave when the sign-in
   * leaves the account (step 3b).
   */
  function ownedPlaceFor(provider: ProviderLoginProvider, login: LoginMemo): { place: string; source: string } | null {
    const place = cloudChoiceKey(provider, login.slot);
    const entry = appliedCache?.applied[place];
    if (!entry?.owned || entry.provider !== provider || login.class !== "renewing") return null;
    if (entry.accountHash && entry.accountHash !== accountHash(login.account)) return null;
    let changed = false;
    for (const file of entry.files) {
      try {
        const hash = shortHash(fs.readFileSync(file.abs));
        if (hash !== file.hash) {
          file.hash = hash;
          changed = true;
        }
      } catch {
        // Gone: removal has nothing to take.
      }
    }
    if (entry.pi) {
      try {
        const current = JSON.parse(fs.readFileSync(entry.pi.authPath, "utf8")) as unknown;
        const value = isRecord(current) ? current[entry.pi.slot] : undefined;
        const hash = value === undefined ? null : shortHash(JSON.stringify(value));
        if (hash && hash !== entry.pi.entryHash) {
          entry.pi.entryHash = hash;
          changed = true;
        }
      } catch {
        // Unreadable now: the next pass looks again.
      }
    }
    if (changed) saveApplied();
    return { place, source: entry.source };
  }

  /** After a takeover's push: the applied entry is that copy, so apply leaves it and capture skips it. */
  function noteOwnedCopy(place: string, memo: LoginMemo, expiresAt: number | null): void {
    const entry = appliedCache?.applied[place];
    if (!entry?.owned) return;
    entry.contentHash = memo.contentHash;
    entry.loginHashes = [memo.contentHash];
    entry.expiresAt = expiresAt;
    ownerOff.delete(place);
    saveApplied();
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

  /**
   * Copilot's place on a cloud computer (G1): no file and no env variable.
   * The token in use (a carried GitHub CLI login, or the saved key) goes into
   * the launch helper, which gives it only to Copilot processes at start.
   * The applied entry keeps the source and hash only. True when the token in
   * use here changed (Copilot restarts when idle).
   */
  function applyCopilot(
    vault: ProviderLoginVault,
    state: AppliedStateFile,
    place: string,
    want: Want | null,
    have: AppliedEntry | null,
    pickedBefore: string | null,
    noteSwitch: (provider: string, before: string | null, after: string) => void,
  ): boolean {
    const token = want?.kind === "key" ? want.token : want ? copilotTokenOf(vault, want.key) : null;
    if (!want || !token) {
      applyStates.set(place, { state: want ? "failed" : "none", key: want ? (want.kind === "key" ? "key" : want.key) : null });
      if (want) deps.logger.warn("provider_login.apply_failed", { provider: "copilot", place, reason: "nothing_to_write", code: null });
      const hadToken = copilotCarriedHash() != null;
      setCopilotCarriedToken(null);
      if (have) {
        delete state.applied[place];
        deps.logger.info("provider_login.removed", { provider: "copilot", place, reason: "not_in_use" });
      }
      return hadToken || Boolean(have);
    }
    const pick = want.kind === "key" ? "key" : want.key;
    const source = want.kind === "key" ? `key:${want.id}` : want.key;
    applyStates.set(place, { state: want.kind === "key" ? "key" : "applied", key: pick });
    const fresh = copilotCarriedHash() !== want.contentHash;
    if (!fresh && have?.source === source && have.contentHash === want.contentHash) return false;
    setCopilotCarriedToken({ token, hash: want.contentHash });
    state.applied[place] = { provider: "copilot", source, contentHash: want.contentHash, accessOnly: false, renewalSafe: true, files: [], loginHashes: [], appliedAt: now() };
    ownerOff.delete(place);
    noteSwitch("copilot", pickedBefore, pick);
    deps.logger.info("provider_login.applied", { provider: "copilot", place, key: pick, accessOnly: false, renewalSafe: true });
    return fresh;
  }

  /** The GitHub token a carried Copilot sign-in holds (`parts.githubToken`), or null. Never logged. */
  function copilotTokenOf(vault: ProviderLoginVault, key: string): string | null {
    const payload = readProviderLoginPayload(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key));
    const token = payload?.provider === "copilot" ? payload.parts?.githubToken : null;
    return typeof token === "string" && token ? token : null;
  }

  async function runApply(
    vault: ProviderLoginVault,
    accountUserId: string,
    origin12: string,
    deviceId: string,
    providers: Set<ProviderLoginProvider> | null,
    captureRan: boolean,
  ): Promise<void> {
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
    const wants = desiredPlaces(vault, setting, origin12, deviceId);
    const changed = new Set<string>();
    // ADE Cloud's pick changed for a provider (not a renewal, not the first pick here): its open chats say so (step 3d).
    const switches = new Map<string, NonNullable<ProviderLoginRestartOptions["switched"]>>();
    const noteSwitch = (provider: string, before: string | null, after: string): void => {
      if (!before || before === after || switches.has(provider)) return;
      switches.set(provider, { from: { key: before, label: pickLabel(vault, before) }, to: { key: after, label: pickLabel(vault, after) } });
    };
    const places = new Set([...wants.keys(), ...Object.keys(state.applied)]);
    for (const place of places) {
      const provider = (place.startsWith("pi:") ? "pi" : place) as ProviderLoginProvider;
      if (providers && !providers.has(provider)) continue;
      const want = wants.get(place) ?? null;
      const have = state.applied[place] ?? null;
      const pickedBefore = applyStates.get(place)?.key ?? (have ? (have.source.startsWith("key:") ? "key" : have.source) : null);
      if (provider === "copilot") {
        if (applyCopilot(vault, state, place, want, have, pickedBefore, noteSwitch)) changed.add(provider);
        continue;
      }
      const fileLess = want?.kind === "key" && want.provider !== "codex";
      if (!want || fileLess) {
        applyStates.set(place, { state: want ? "key" : "none", key: want ? "key" : null });
        if (!have) continue;
        await removeApplied(have);
        delete state.applied[place];
        localStates.get(provider)?.delete(`applied:${place}`);
        changed.add(provider);
        if (want) noteSwitch(provider, pickedBefore, "key");
        deps.logger.info("provider_login.removed", { provider, place, reason: want ? "key_in_use" : "not_in_use" });
        continue;
      }
      const source = want.kind === "key" ? `key:${want.id}` : want.key;
      const owned = want.kind === "signin" && want.owned;
      // The same copy, and the same owner: nothing to do. A change of owner (a takeover, or the origin's claim back) writes again.
      if (have && have.source === source && have.contentHash === want.contentHash && Boolean(have.owned) === owned) {
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
            expiresAt: payload.expiresAt,
            full: owned,
          }, have, ctx, now())
          : { ok: false, reason: "nothing_to_write" };
        if (result.ok && owned) result.entry.accountHash = accountHash(payload?.account ?? null);
      }
      if (!result.ok) {
        applyStates.set(place, { state: "failed", key: want.kind === "key" ? "key" : want.key });
        deps.logger.warn("provider_login.apply_failed", { provider, place, reason: result.reason, code: result.code ?? null });
        continue;
      }
      state.applied[place] = result.entry;
      ownerOff.delete(place);
      applyStates.set(place, { state: want.kind === "key" ? "key" : "applied", key: want.kind === "key" ? "key" : want.key });
      // Until the next pass reads the file back, the status says whose it is.
      if (want.kind === "signin") setLocal(provider, `applied:${place}`, "from_account", null);
      changed.add(provider);
      noteSwitch(provider, pickedBefore, want.kind === "key" ? "key" : want.key);
      deps.logger.info("provider_login.applied", {
        provider,
        place,
        key: want.kind === "key" ? "key" : want.key,
        accessOnly: result.entry.accessOnly,
        renewalSafe: result.entry.renewalSafe,
        ...(owned ? { owned: true } : {}),
      });
    }

    // Env keys: a saved key is in its variable only while it is in use, so it never outranks a carried sign-in.
    // The pass that took the boot variables puts back every one the account still has, whatever `providers` says.
    const envProviders = takeover ? null : providers;
    if (!envProviders || SAVED_KEYS.some((spec) => spec.provider && envProviders.has(spec.provider))) {
      for (const spec of SAVED_KEYS) {
        if (envProviders && (!spec.provider || !envProviders.has(spec.provider))) continue;
        const want = spec.provider ? wants.get(spec.provider) : null;
        // Copilot's key never goes into the brain's env: the launch helper gives it to Copilot processes only (G1 Q3).
        // An old value apply set here leaves.
        const token = spec.id === "copilot" ? null
          : spec.provider
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
    for (const provider of changed) afterApplyChange(provider, switches.get(provider));
    if (changed.size) notifyProviderLoginsChanged();
  }

  /**
   * The gate before a turn or a CLI start, on a cloud computer: a fresh vault,
   * then this provider applied. When the copy here is about to expire, the
   * short wait (§5.3): pull now; while the owner may be renewing (up to 60 s
   * past expiry), pull every 5 s for up to 20 s; then, the owner being off,
   * take the renewal over (step 3b). The whole gate stays under 45 s; then
   * `owner_off` with the owner's name, and the turn goes ahead.
   */
  async function gate(provider: string, options: ProviderLoginGateOptions = {}): Promise<ProviderLoginGateOutcome> {
    // A new cloud computer's first turn can come while the ADE Cloud answer is still being read.
    if (!ticks.length && accessPending) await Promise.race([accessPending, new Promise((resolve) => setTimeout(resolve, GATE_LIMIT_MS).unref?.())]);
    if (!ticks.length) return { result: "ok" };
    const providerId = provider.trim().toLowerCase();
    const gated = PROVIDER_LOGIN_CARRY.some((row) => row.provider === providerId && row.carry === "carried")
      || SAVED_KEYS.some((spec) => spec.provider === providerId);
    if (!gated) return { result: "ok" };
    const started = now();
    const limit = <T>(promise: Promise<T> | undefined, budgetMs = GATE_LIMIT_MS): Promise<T | "timeout" | undefined> => {
      if (!promise) return Promise.resolve(undefined);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, budgetMs - (now() - started)));
        timer.unref?.();
      });
      return Promise.race([promise.catch(() => undefined), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };
    const synced = await limit(deps.vault()?.sync?.({ maxAgeMs: GATE_MAX_AGE_MS }));
    const applied = synced === "timeout" ? "timeout" : await limit(pass([providerId as ProviderLoginProvider]));
    let outcome: ProviderLoginGateOutcome = synced === "timeout" || applied === "timeout" ? { result: "timeout" } : { result: "ok" };
    // A takeover running here (armed, or a turn's that went on) holds the turn too: its CLI must not renew the same copy.
    const expiring = outcome.result === "ok" ? expiringCopy(providerId) ?? takeoverCopy(providerId) : null;
    if (expiring) outcome = await shortWait(providerId as ProviderLoginProvider, expiring, started, limit, options);
    // The lines for the chat of this turn (step 3d); a terminal logs them only.
    const notices: ProviderLoginChatNotice[] = [];
    const first = options.firstCloudChat ? firstCloudChatNotice(providerId) : null;
    if (first) notices.push(first);
    if (outcome.result === "owner_off") {
      const { provider: offProvider, ownerLabel } = outcome;
      notices.push({
        severity: "warning",
        status: "provider_login_owner_off",
        message: `${ownerLabel} didn't renew the ${PROVIDER_NAMES[offProvider] ?? offProvider} sign-in in time.`,
        providerLogin: { kind: "owner_off", provider: offProvider, ownerLabel },
      });
    }
    if (notices.length) outcome = { ...outcome, notices };
    const waitedMs = now() - started;
    if (waitedMs >= 100 || outcome.result !== "ok") {
      deps.logger.info("provider_login.gate", {
        provider: providerId,
        waitedMs,
        result: outcome.result,
        shortWait: Boolean(expiring),
        ...(outcome.result === "ok" && outcome.renewedHere ? { renewedHere: true } : {}),
      });
    }
    return outcome;
  }

  /**
   * The first cloud chat line (step 3d): one time per cloud computer and
   * account (the mark is in the applied state file), on a turn of a provider
   * whose sign-in this computer took from the account.
   */
  function firstCloudChatNotice(provider: string): ProviderLoginChatNotice | null {
    const state = appliedCache;
    const vault = deps.vault();
    if (!deps.cloudComputer || !state || state.firstChatAt || !vault) return null;
    const fromAccount = Object.values(state.applied).filter((entry) => !entry.source.startsWith("key:") && (entry.files.length || entry.pi || entry.qwen));
    if (!fromAccount.some((entry) => entry.provider === provider)) return null;
    const origins = [...new Set(fromAccount.map((entry) => {
      const row = vault.list(ACCOUNT_SCOPE_ALL).find((candidate) => candidate.kind === PROVIDER_LOGIN_VAULT_KIND && candidate.key === entry.source);
      return row && !row.deleted ? metaFor(vault, row)?.origin.label ?? "" : "";
    }).filter(Boolean))];
    if (!origins.length) return null;
    state.firstChatAt = new Date(now()).toISOString();
    try {
      writeAppliedState(deps.adeDir, state);
    } catch (error) {
      deps.logger.warn("provider_login.applied_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
    }
    const from = origins.length === 1 ? origins[0] : origins.length === 2 ? `${origins[0]} and ${origins[1]}` : `${origins.length} computers`;
    return {
      severity: "info",
      status: "provider_login_first_cloud_chat",
      message: `ADE Cloud uses your sign-ins from ${from}.`,
      providerLogin: { kind: "first_cloud_chat", origins },
    };
  }

  /** The applied copy of this provider that renews elsewhere and has less than 60 s left, if any. */
  function expiringCopy(provider: string): { place: string; entry: AppliedEntry } | null {
    for (const [place, entry] of Object.entries(appliedCache?.applied ?? {})) {
      if (entry.provider !== provider || !entry.accessOnly || entry.expiresAt == null) continue;
      if (entry.expiresAt - now() < SHORT_WAIT_LEFT_MS) return { place, entry };
    }
    return null;
  }

  /** The applied copy of this provider whose renewal a takeover here runs now, if any. */
  function takeoverCopy(provider: string): { place: string; entry: AppliedEntry } | null {
    for (const [place, entry] of Object.entries(appliedCache?.applied ?? {})) {
      if (entry.provider === provider && takeovers.has(entry.source)) return { place, entry };
    }
    return null;
  }

  async function shortWait(
    provider: ProviderLoginProvider,
    expiring: { place: string; entry: AppliedEntry },
    started: number,
    limit: <T>(promise: Promise<T> | undefined, budgetMs?: number) => Promise<T | "timeout" | undefined>,
    options: ProviderLoginGateOptions,
  ): Promise<ProviderLoginGateOutcome> {
    const pullAndApply = async (): Promise<boolean> => {
      const pulled = await limit(deps.vault()?.sync?.(), SHORT_WAIT_GATE_LIMIT_MS);
      if (pulled === "timeout") return false;
      if ((await limit(pass([provider]), SHORT_WAIT_GATE_LIMIT_MS)) === "timeout") return false;
      return !expiringCopy(provider);
    };
    const key = expiring.entry.source;
    const running = takeovers.get(key);
    // A turn moments after one that waited in vain does not wait again: the 30 s tick still pulls.
    const recent = ownerOff.get(expiring.place);
    if (!running && recent && now() - recent.at < GATE_MAX_AGE_MS) return { result: "owner_off", provider, ownerLabel: recent.ownerLabel };
    const ownerLabel = ownerLabelOf(key);
    // One line per turn, and a true one: this computer's while it renews (or is
    // about to: the owner's time is over), else the owner's (step 3d).
    const claimFrom = TAKEOVER_HOW[provider] ? claimAt(key) : null;
    const renewingHere = Boolean(running) || (claimFrom != null && claimFrom <= now());
    const name = PROVIDER_NAMES[provider] ?? provider;
    try {
      if (renewingHere) {
        options.onWait?.(`This cloud computer is renewing the ${name} sign-in…`, { kind: "renewing", provider, byLabel: deps.machine()?.label || "this cloud computer" });
      } else {
        options.onWait?.(`Getting a fresh ${name} sign-in from ${ownerLabel}…`);
      }
    } catch {
      // The line is for the person; a caller's failure never holds the turn.
    }
    if (!running) {
      // Step 1: a newer copy may already be in the account.
      if (await pullAndApply()) return { result: "ok" };
      // Step 2: the owner may be renewing now (Grok renews 200 s before expiry), until 60 s past expiry.
      const expiresAt = expiring.entry.expiresAt ?? 0;
      if (now() < expiresAt + SHORT_WAIT_RENEWING_MS) {
        const pollEnd = Math.min(
          now() + SHORT_WAIT_POLL_LIMIT_MS,
          expiresAt + SHORT_WAIT_RENEWING_MS,
          started + SHORT_WAIT_GATE_LIMIT_MS - SHORT_WAIT_POLL_MS,
        );
        while (now() < pollEnd) {
          await delay(Math.min(SHORT_WAIT_POLL_MS, pollEnd - now()));
          if (await pullAndApply()) return { result: "ok" };
        }
      }
    }
    // Steps 3 and 4: the owner did not renew. Take the renewal over (only past
    // expiry + 60 s), within what is left of the 45 s. A takeover that needs
    // longer goes on after the turn, and the next turn gets its copy.
    const took = await limit(takeover(provider, expiring.place, key), SHORT_WAIT_GATE_LIMIT_MS);
    if (took === "renewed") return { result: "ok", renewedHere: true };
    if (took === "fresh") return { result: "ok" };
    ownerOff.set(expiring.place, { ownerLabel, at: now() });
    // Too early to claim (the owner had until expiry + 60 s): one takeover at that moment, so the retry finds a fresh copy.
    if (took !== "timeout") armTakeover(provider, expiring.place, key);
    return { result: "owner_off", provider, ownerLabel };
  }

  // ── The takeover by a cloud computer (step 3b, §5.3 steps 3 and 4) ───

  type TakeoverResult = "renewed" | "fresh" | "none";
  /** One takeover per sign-in at a time; a second turn waits on the same one. */
  const takeovers = new Map<string, Promise<TakeoverResult>>();

  /**
   * The takeover armed by a turn that ended `owner_off` before the claim was
   * allowed (step 3c): ONE unref timer per sign-in, at expiry + 60 s (and the
   * last write + 60 s). Only a turn arms it ("no renewals for nobody"); it
   * goes at stop, when the copy here is no longer the expiring one (a new
   * copy, a sign-out, the sign-in switched off or not in use), and after it
   * runs once.
   */
  const armed = new Map<string, { place: string; provider: ProviderLoginProvider; timer: ReturnType<typeof setTimeout> }>();

  function armTakeover(provider: ProviderLoginProvider, place: string, key: string): void {
    if (!deps.cloudComputer || !ticks.length || armed.has(key) || takeovers.has(key) || !TAKEOVER_HOW[provider]) return;
    const claimFrom = claimAt(key);
    if (claimFrom == null) return;
    const at = claimFrom + 1_000;
    // Past that moment the turn already tried the claim; it failed for another reason, and nothing is armed.
    if (at <= now()) return;
    const timer = setTimeout(() => {
      if (armed.get(key)?.timer !== timer) return;
      armed.delete(key);
      if (!ticks.length || !stillExpiring(place, key)) return;
      void takeover(provider, place, key);
    }, at - now());
    timer.unref?.();
    armed.set(key, { place, provider, timer });
    deps.logger.info("provider_login.takeover_armed", { provider, inMs: at - now() });
  }

  /** When a cloud computer may claim the renewal of `key`: past expiry + 60 s and the last write + 60 s. Null when not known. */
  function claimAt(key: string): number | null {
    const vault = deps.vault();
    const row = vault?.list(ACCOUNT_SCOPE_ALL).find((entry) => entry.kind === PROVIDER_LOGIN_VAULT_KIND && entry.key === key);
    const meta = vault && row && !row.deleted ? metaFor(vault, row) : null;
    if (!row || meta?.expiresAt == null) return null;
    const updatedAt = Date.parse(row.updatedAt);
    return Math.max(meta.expiresAt, Number.isFinite(updatedAt) ? updatedAt : 0) + TAKEOVER_GRACE_MS;
  }

  function disarm(key: string, reason: string): void {
    const entry = armed.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    armed.delete(key);
    deps.logger.info("provider_login.takeover_disarmed", { provider: entry.provider, reason });
  }

  /** The copy applied at `place` is still `key`'s access-only copy, with less than 60 s left. */
  function stillExpiring(place: string, key: string): boolean {
    const entry = appliedCache?.applied[place];
    return Boolean(entry && entry.source === key && entry.accessOnly && entry.expiresAt != null && entry.expiresAt - now() < SHORT_WAIT_LEFT_MS);
  }

  /** After each apply: an armed takeover whose copy changed (a new copy, a sign-out, switched off) goes. */
  function checkArmed(): void {
    for (const [key, entry] of [...armed]) if (!stillExpiring(entry.place, key)) disarm(key, "copy_changed");
  }

  function takeover(provider: ProviderLoginProvider, place: string, key: string): Promise<TakeoverResult> {
    const running = takeovers.get(key);
    if (running) return running;
    const next = runTakeover(provider, place, key)
      .catch((error): TakeoverResult => {
        deps.logger.warn("provider_login.takeover_failed", { provider, name: error instanceof Error ? error.name : "unknown" });
        return "none";
      })
      .finally(() => {
        if (takeovers.get(key) === next) takeovers.delete(key);
      });
    takeovers.set(key, next);
    return next;
  }

  /**
   * Claim the renewal of one sign-in with the 60 s grace, wait the 30 s claim
   * settle, check again, then get the full copy here (apply sees the new
   * owner) and renew it: ADE's renew call for Codex and Grok (one CLI
   * process), the CLI itself on start for Kimi and Pi. Capture then pushes
   * the renewed copy into the same key, with this computer as the owner.
   * "No renewals for nobody": only a sign-in that is on and in use for ADE
   * Cloud, and only when a turn here waits for it.
   */
  async function runTakeover(provider: ProviderLoginProvider, place: string, key: string): Promise<TakeoverResult> {
    const started = now();
    const vault = deps.vault();
    const machine = deps.machine();
    const rotating = deps.rotatingVault?.() ?? null;
    const how = TAKEOVER_HOW[provider];
    const finish = (result: TakeoverResult, step: string): TakeoverResult => {
      deps.logger.info("provider_login.takeover", { provider, step, result, ms: now() - started });
      return result;
    };
    if (!vault || !machine || !rotating || !how) return finish("none", "unsupported");
    if (how === "renew" && !deps.renewer?.aheadMs[provider]) return finish("none", "unsupported");
    const signIn = signInsFromVault(vault, originId(machine.machineKey), cloudSetting(), machine.deviceId).find((entry) => entry.key === key);
    if (!signIn || signIn.class !== "renewing" || !signIn.onForCloud || !signIn.inUseOnCloud) return finish("none", "not_in_use");
    const ref = { scope: ACCOUNT_SCOPE_ALL, kind: PROVIDER_LOGIN_VAULT_KIND, key };
    const decideOnce = (): Promise<RotatingRenewalVerdict> | null => {
      const row = vault.list(ACCOUNT_SCOPE_ALL).find((entry) => entry.kind === PROVIDER_LOGIN_VAULT_KIND && entry.key === key);
      const meta = row && !row.deleted ? metaFor(vault, row) : null;
      const value = row && !row.deleted ? vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key) : null;
      if (!row || !meta || !value || meta.expiresAt == null) return null;
      // Not past expiry + 60 s (and the last write + 60 s): the owner may still send it; nothing to claim.
      const role = rotatingRenewalRole({
        deviceId: machine.deviceId,
        owner: row.refreshOwner,
        expiresAtMs: meta.expiresAt,
        updatedAtMs: Date.parse(row.updatedAt),
        nowMs: now(),
        graceMs: TAKEOVER_GRACE_MS,
      });
      if (role === "read") return Promise.resolve({ renew: false, reason: "other_owner" });
      return decideRotatingRenewal({
        vault: rotating,
        deviceId: machine.deviceId,
        ref,
        expiresAtMs: meta.expiresAt,
        currentValue: value,
        nowMs: now(),
        graceMs: TAKEOVER_GRACE_MS,
        logger: deps.logger,
        logContext: { provider },
      });
    };
    let verdict = await decideOnce();
    if (!verdict) return finish("none", "no_copy");
    const claimed = !verdict.renew && (verdict.reason === "claimed" || verdict.reason === "claim_settling");
    // A claim stands only after the settle: a second claimant's later write wins, and this one then reads instead.
    for (let check = 0; check < 3 && !verdict.renew && (verdict.reason === "claimed" || verdict.reason === "claim_settling"); check += 1) {
      if (check === 0) {
        claimedAt.set(key, now());
        deps.logger.info("provider_login.takeover_claimed", { provider, reason: verdict.reason });
      }
      await delay(ROTATING_CLAIM_SETTLE_MS + 250);
      verdict = (await decideOnce()) ?? { renew: false, reason: "claim_failed" };
    }
    if (!verdict.renew) {
      // Another computer renews it (another claimant stood, or the owner sent a
      // copy): take what the account has. After a claim that lost, the claimant
      // that stood renews in the next seconds, so pull a few times (the gate's
      // limit still ends the turn's wait).
      for (let pull = 0; ; pull += 1) {
        await vault.sync?.().catch(() => undefined);
        await pass([provider]);
        if (!expiringCopy(provider)) return finish("fresh", verdict.reason);
        if (!claimed || pull >= 3) return finish("none", verdict.reason);
        await delay(SHORT_WAIT_POLL_MS);
      }
    }
    // This computer owns the renewal now: the full copy here.
    await pass([provider]);
    const entry = appliedCache?.applied[place];
    if (!entry?.owned || entry.source !== key) return finish("none", "no_full_copy");
    if (how === "cli") return finish("renewed", "full_copy");
    const answer = await deps.renewer!.renew(provider).catch(() => false);
    if (!answer) return finish("none", answer === null ? "renew_busy" : "renew_failed");
    // The renewed file is read once it is stable; capture pushes it into the same key, this computer the owner.
    await delay(STABLE_AGE_MS + 250);
    await pass([provider]);
    return finish("renewed", "renewed");
  }

  // ── The write-back on the origin (step 3b) ───────────────────────────

  /**
   * Write the newer copy of this computer's own sign-in into its login file,
   * after a cloud computer renewed it. Every limit, again, on the whole item:
   * this computer made it (the same key and the same device), it is a
   * renewing sign-in, another computer owns it now and renewed it, the copy
   * here is of the same sign-in (its family is the item's, or one the item
   * lists as earlier), the account is the same, the item's expiry is later,
   * and the file here is still the copy capture last put in the account.
   * `writeBackSignIn` checks the file again just before the rename.
   */
  async function writeBack(
    candidate: { provider: ProviderLoginProvider; memo: LoginMemo; bundleId: string },
    vault: ProviderLoginVault,
    rows: Map<string, VaultRow>,
    state: ProviderLoginStateFile,
    machine: ProviderLoginMachine,
  ): Promise<boolean> {
    const { provider, memo } = candidate;
    const row = rows.get(memo.key);
    const payload = row && !row.deleted ? readProviderLoginPayload(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, memo.key)) : null;
    const parsedKey = parseProviderLoginKey(memo.key);
    const refused = (reason: string): false => {
      deps.logger.info("provider_login.write_back_skipped", { provider, slot: memo.slot, reason });
      return false;
    };
    if (deps.cloudComputer || !row || !payload || !parsedKey) return refused("no_item");
    if (parsedKey.origin12 !== originId(machine.machineKey) || payload.origin.deviceId !== machine.deviceId) return refused("not_origin");
    if (payload.provider !== provider || payload.slot !== memo.slot || payload.class !== "renewing" || memo.class !== "renewing") return refused("not_renewing");
    if (provider === "pi" && memo.slot === "anthropic") return refused("not_carried");
    if (!row.refreshOwner || row.refreshOwner === machine.deviceId) return refused("own_owner");
    if (!payload.renewedBy || payload.renewedAt == null || payload.renewedBy.machineKey === machine.machineKey) return refused("not_renewed_elsewhere");
    if (!ofSameSignIn(payload, memo, state)) return refused("other_family");
    if (!sameAccount(payload.account, memo.account)) return refused("other_account");
    if (!laterExpiry(payload.expiresAt, memo.expiresAt)) return refused("not_newer");
    if (state.pushed[memo.key]?.pushedHash !== memo.contentHash) return refused("local_changed");
    const write = () => writeBackSignIn({ provider, slot: memo.slot, files: payload.files, parts: payload.parts, expectHash: memo.contentHash }, ctx);
    // Under ADE's machine lock, so ADE's own keeper never renews this file at the same moment.
    const result = deps.renewer?.withLock ? await deps.renewer.withLock(write) : await write();
    if (!result) return refused("lock_busy");
    if (!result.ok) return refused(result.reason === "write_failed" && result.code === "ELOCKED" ? "lock_busy" : result.reason);
    const readBack = result.loginHashes[0] ?? payload.contentHash;
    const renewedBy = payload.renewedBy.label || "another computer";
    state.pushed[memo.key] = { pushedHash: readBack, familyHash: payload.familyHash, pushedAt: now(), absentSince: null, absentPasses: 0 };
    state.writtenBack = {
      ...(state.writtenBack ?? {}),
      [memo.key]: { contentHash: readBack, familyHash: payload.familyHash, at: now(), renewedBy, accountHash: payload.contentHash },
    };
    // The marks moved: the next pass reads the file again and finds this copy.
    bundleMemos.delete(candidate.bundleId);
    deps.logger.info("provider_login.written_back", { provider, slot: memo.slot, renewedByCloud: payload.renewedBy.cloud === true });
    noteProviderLoginChanged(provider);
    return true;
  }

  /** The name of the computer that renews this sign-in: its origin unless another computer renewed it last. */
  function ownerLabelOf(key: string): string {
    const vault = deps.vault();
    const row = vault?.list(ACCOUNT_SCOPE_ALL).find((entry) => entry.kind === PROVIDER_LOGIN_VAULT_KIND && entry.key === key);
    const meta = vault && row ? metaFor(vault, row) : null;
    if (!meta) return "the computer that made this sign-in";
    if (row?.refreshOwner && row.refreshOwner === meta.origin.deviceId) return meta.origin.label || "the computer that made this sign-in";
    return meta.renewedBy?.label || meta.origin.label || "the computer that made this sign-in";
  }

  // ── Renewal ahead on the owner computer (step 3a) ────────────────────
  // On a cloud computer only for a sign-in it took the renewal over for
  // (step 3b): it owns it then and holds the full copy. It stops when the
  // origin claims the renewal back.

  const ownerRenewal = deps.renewer
    ? createOwnerRenewal({
      renewer: deps.renewer,
      now,
      logger: deps.logger,
      onRenewed: (target, outcome) => {
        // The keeper renewing it (busy) changes the file too. Either way the
        // file is read once it is stable, and the pass pushes it.
        if (outcome === "failed" || !ticks.length) return;
        const id = `renew:${target.provider}`;
        clearTimeout(settleTimers.get(id));
        const timer = setTimeout(() => {
          settleTimers.delete(id);
          void pass([target.provider]);
        }, STABLE_AGE_MS + 250);
        timer.unref?.();
        settleTimers.set(id, timer);
      },
    })
    : null;
  /** Bumped by each plan, so an answer that comes late never undoes a newer plan. */
  let planGeneration = 0;

  /** Claims this computer made (a takeover, or a claim back), by key: no renewal until the 30 s settle passes. */
  const claimedAt = new Map<string, number>();
  const claimBacks = new Set<string>();

  /**
   * The sign-ins this computer renews ahead, and only when all hold: capture
   * is on (this runs at the end of a capture pass), this computer is the
   * owner, the sign-in is on and in use for ADE Cloud, ADE can make its CLI
   * renew, and the account has a cloud computer. The owner is the origin, or
   * a cloud computer that took the renewal over and holds the full copy
   * (step 3b). On the origin, a sign-in another computer owns is claimed back
   * by the normal rule (10 min past expiry) when the file here holds the
   * account's newest copy.
   */
  async function planRenewals(vault: ProviderLoginVault, machine: ProviderLoginMachine, origin12: string, state: ProviderLoginStateFile): Promise<void> {
    const rows = new Map<string, VaultRow>();
    for (const row of vault.list(ACCOUNT_SCOPE_ALL)) {
      if (row.kind === PROVIDER_LOGIN_VAULT_KIND && !row.deleted) rows.set(row.key, row);
    }
    // Owner only once the account service took this computer's write: a
    // queued write can still lose to the owner's newer one (the stale rule).
    const pending = new Set(vault.pendingKeys?.(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND) ?? []);
    const targets: OwnerRenewTarget[] = [];
    for (const signIn of signInsFromVault(vault, origin12, cloudSetting(), machine.deviceId)) {
      if (signIn.class !== "renewing" || !signIn.onForCloud || !signIn.inUseOnCloud) continue;
      const row = rows.get(signIn.key);
      if (!row || pending.has(signIn.key)) continue;
      if (deps.cloudComputer) {
        // A cloud computer renews only a sign-in it took over, while it holds the full copy.
        const entry = appliedCache?.applied[cloudChoiceKey(signIn.provider, signIn.slot)];
        if (signIn.origin.thisComputer || !entry?.owned || entry.source !== signIn.key) continue;
      } else if (!signIn.origin.thisComputer) {
        continue;
      }
      if (row.refreshOwner !== machine.deviceId) {
        if (!deps.cloudComputer) maybeClaimBack(row, vault, machine, state);
        continue;
      }
      // A takeover renews it now; the planner takes over from the copy it pushes.
      if (takeovers.has(signIn.key)) continue;
      const claimed = claimedAt.get(signIn.key);
      if (claimed != null && now() - claimed < ROTATING_CLAIM_SETTLE_MS) continue;
      if (!deps.renewer?.aheadMs[signIn.provider]) continue;
      const expiresAt = signIn.expiresAt ? Date.parse(signIn.expiresAt) : Number.NaN;
      if (Number.isFinite(expiresAt)) targets.push({ key: signIn.key, provider: signIn.provider, expiresAt });
    }
    if (!ownerRenewal) return;
    const generation = ++planGeneration;
    if (!targets.length) {
      ownerRenewal.plan([]);
      return;
    }
    // Asked only now, when a sign-in is otherwise due. The pass never waits on
    // it: a read can take seconds, and a later pass's plan wins. A cloud
    // computer is one, so it does not ask.
    const answer = deps.cloudComputer
      ? Promise.resolve(true)
      : deps.cloudComputerExists ? deps.cloudComputerExists().catch(() => null) : Promise.resolve(null);
    void answer.then((exists) => {
      if (generation === planGeneration) ownerRenewal.plan(exists === true ? targets : []);
    });
  }

  /**
   * The origin claims the renewal of its own sign-in back (§5.2): only by the
   * normal rule (the owner sent nothing for 10 min past expiry), only when the
   * file here holds the account's newest copy (captured, or written back), and
   * never in the pass's path (the claim reads the vault and waits for it).
   */
  function maybeClaimBack(row: VaultRow, vault: ProviderLoginVault, machine: ProviderLoginMachine, state: ProviderLoginStateFile): void {
    const key = row.key;
    if (!row.refreshOwner || claimBacks.has(key)) return;
    const meta = metaFor(vault, row);
    if (!meta || meta.origin.deviceId !== machine.deviceId || meta.expiresAt == null) return;
    const back = state.writtenBack?.[key];
    const inStep = back ? back.familyHash === meta.familyHash : state.pushed[key]?.pushedHash === meta.contentHash;
    if (!inStep) return;
    const role = rotatingRenewalRole({
      deviceId: machine.deviceId,
      owner: row.refreshOwner,
      expiresAtMs: meta.expiresAt,
      updatedAtMs: Date.parse(row.updatedAt),
      nowMs: now(),
    });
    if (role !== "claim") return;
    const rotating = deps.rotatingVault?.() ?? null;
    const value = vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key);
    if (!rotating || !value) return;
    claimBacks.add(key);
    const provider = meta.provider;
    // The claim drops `takenFrom`: the takeover it marked ends here (step 3c).
    const claimValue = withoutTakenFrom(value);
    void decideRotatingRenewal({
      vault: rotating,
      deviceId: machine.deviceId,
      ref: { scope: ACCOUNT_SCOPE_ALL, kind: PROVIDER_LOGIN_VAULT_KIND, key },
      expiresAtMs: meta.expiresAt,
      currentValue: value,
      ...(claimValue ? { claimValue } : {}),
      nowMs: now(),
      logger: deps.logger,
      logContext: { provider },
    })
      .then((verdict) => {
        const claimed = !verdict.renew && verdict.reason === "claimed";
        if (claimed) claimedAt.set(key, now());
        deps.logger.info("provider_login.claim_back", { provider, result: verdict.renew ? "owner" : verdict.reason });
      })
      .catch(() => undefined)
      .finally(() => claimBacks.delete(key));
  }

  // ── The person's Keychain read on a Mac (§3.7) ──────────────────────

  /**
   * Copy Antigravity's sign-in from this Mac's Keychain into the account:
   * one `security` read, which macOS asks the person about. Behind the same
   * gates as capture. Never runs in a pass or on a timer.
   */
  async function allowKeychain(args: { provider: ProviderLoginProvider; slot?: AntigravityKeychainSlot | null }): Promise<ProviderLoginStatus> {
    if (args.provider !== "antigravity") throw new Error("Only Antigravity's sign-in is copied from the Keychain.");
    if (platform !== "darwin" || deps.cloudComputer) throw new Error("ADE copies a sign-in from the Keychain only on a Mac.");
    const off = await captureOffReason();
    if (off) throw new Error(OFF_MESSAGES[off]);
    // The method the agent saved says which of its two items is the sign-in (no prompt: a plain file).
    let slot: AntigravityKeychainSlot = args.slot ?? "personal";
    if (!args.slot) {
      try {
        const settings = parseAntigravitySettings(fs.readFileSync(antigravityBundle(ctx, "personal").files[1]!.abs, "utf8"));
        if (isRecord(settings?.auth) && settings.auth.type === "oauth-business") slot = "business";
      } catch {
        // No settings: the Google-account sign-in.
      }
    }
    const read = await readKeychainSecret({
      account: antigravityKeychainAccount(slot),
      ...(deps.keychainCommand ? { command: deps.keychainCommand } : {}),
    });
    deps.logger.info("provider_login.keychain_read", { provider: "antigravity", slot, result: read.ok ? "ok" : read.reason });
    if (!read.ok) {
      throw new Error(
        read.reason === "not_found" ? "This Mac's Keychain has no Antigravity sign-in. Sign in to Antigravity first, then allow again."
          : read.reason === "denied" ? "macOS did not let ADE read it. Allow again, and choose Allow when macOS asks."
            : read.reason === "timeout" ? "macOS asked, but there was no answer in 2 minutes. Allow again."
              : "ADE couldn't read the Keychain. Try again.",
      );
    }
    const token = decodeKeychainSecret(read.data);
    if (!token) throw new Error("ADE found the Keychain item but could not read a sign-in from it.");
    // Behind the pass in flight, so the marks file has one writer.
    while (inFlight) await inFlight.catch(() => undefined);
    const vault = deps.vault();
    const machine = deps.machine();
    const accountUserId = deps.accountUserId();
    if (!vault || !machine || !accountUserId) throw new Error(OFF_MESSAGES.vault_unavailable);
    const bundle = antigravityBundle(ctx, slot);
    const contents = new Map<string, Buffer>([[bundle.files[0]!.rel, token]]);
    try {
      contents.set(ANTIGRAVITY_SETTINGS_REL, fs.readFileSync(bundle.files[1]!.abs));
    } catch {
      // No agent settings on this Mac: the slot says which method it is.
    }
    const row = carryRow("antigravity");
    const parsed = row.parse!(bundle, contents, ctx);
    if ("unreadable" in parsed || !parsed.logins.length) throw new Error("ADE found the Keychain item but could not read a sign-in from it.");
    const origin12 = originId(machine.machineKey);
    const state = loadState(accountUserId);
    const rows = new Map<string, VaultRow>();
    for (const vaultRow of vault.list(ACCOUNT_SCOPE_ALL)) {
      if (vaultRow.kind === PROVIDER_LOGIN_VAULT_KIND) rows.set(vaultRow.key, vaultRow);
    }
    let local: ProviderLoginLocalState = "not_checked";
    let key: string | null = null;
    for (const login of parsed.logins) {
      const memo: LoginMemo = {
        slot: login.slot,
        key: providerLoginKey("antigravity", origin12, login.slot),
        contentHash: loginContentHash(login),
        familyHash: shortHash(login.familySecret),
        class: login.class,
        expiresAt: login.expiresAt,
        account: login.account,
      };
      const decision = decide(memo, vault, rows, state, machine);
      local = decision.push ? push("antigravity", login, memo, vault, rows, state, machine) : decision.state;
      key = memo.key;
    }
    if (local === "removed_from_account") {
      throw new Error("You removed this sign-in from your account. Sign in to Antigravity again on this Mac, then allow again.");
    }
    if (local !== "captured" || !key) throw new Error("ADE couldn't put the sign-in in your account. Try again in a moment.");
    state.keychain = { ...(state.keychain ?? {}), antigravity: { allowedAt: now(), slot, key } };
    try {
      writeProviderLoginState(deps.adeDir, state);
    } catch (error) {
      deps.logger.warn("provider_login.state_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
    }
    notifyProviderLoginsChanged();
    return await status("antigravity");
  }

  function saveState(state: ProviderLoginStateFile): void {
    try {
      writeProviderLoginState(deps.adeDir, state);
    } catch (error) {
      deps.logger.warn("provider_login.state_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
    }
  }

  /**
   * The person's switch for Copilot's GitHub CLI login on this computer (G1).
   * Off at the start, and again after a sign-out of ADE (the choice is in the
   * per-account marks file).
   *
   * - ON: the choice is kept, and the one read runs at once (it can show a
   *   keychain or keyring prompt on this computer). With capture on, it is a
   *   pass for Copilot, so the login goes into the account now. With the off
   *   switch for all (or a vault that has not synced yet), only the read runs;
   *   nothing leaves this computer until capture is on. ON again reads again.
   * - OFF: no read from now on, and this computer's copy leaves the account
   *   (each cloud computer drops it at its next pass). If the vault cannot
   *   take the removal now, the absence rule removes it at a later pass.
   *
   * Never on a cloud computer. The status says what happened.
   */
  async function allowGitHubCli(args: { on: boolean }): Promise<ProviderLoginStatus> {
    if (typeof args?.on !== "boolean") throw new Error("Say whether to turn it on or off.");
    if (deps.cloudComputer) throw new Error("A cloud computer does not copy a GitHub CLI login. Turn this on on your own computer.");
    if (deps.staticOff) throw new Error(OFF_MESSAGES[deps.staticOff]);
    const accountUserId = deps.accountUserId();
    if (!accountUserId) throw new Error(OFF_MESSAGES.signed_out);
    const off = args.on ? await captureOffReason() : null;
    if (off && !GH_ALLOW_WHILE_OFF.has(off)) throw new Error(OFF_MESSAGES[off]);
    // Behind the pass in flight, so the marks file has one writer.
    while (inFlight) await inFlight.catch(() => undefined);
    const state = loadState(accountUserId);
    // Either way the next read starts over: ON reads again, OFF reads nothing.
    ghMemo = null;
    bundleMemos.delete(GH_BUNDLE_ID);
    if (args.on) {
      state.ghCli = { allowedAt: state.ghCli?.allowedAt ?? now() };
      saveState(state);
      deps.logger.info("provider_login.gh_allowed", { on: true });
      ghForce = true;
      try {
        if (!off) await pass(["copilot"]);
        else await readGhWithoutCapture(state);
      } finally {
        ghForce = false;
      }
      notifyProviderLoginsChanged();
      return await status("copilot");
    }
    delete state.ghCli;
    delete state.bundles[GH_BUNDLE_ID];
    localStates.delete("copilot");
    deps.logger.info("provider_login.gh_allowed", { on: false });
    const machine = deps.machine();
    const vault = deps.vault();
    let removed: string | null = null;
    if (machine) {
      const key = providerLoginKey("copilot", originId(machine.machineKey), "gh");
      if (vault && liveSignInKeys(vault).has(key) && vault.remove(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key)) {
        removed = key;
        deps.logger.info("provider_login.removed", { provider: "copilot", slot: "gh", reason: "gh_cli_off" });
      }
      // Removed now, or never pushed: forget it. Otherwise the absence rule takes it at a later pass.
      if (removed || !vault || !liveSignInKeys(vault).has(key)) delete state.pushed[key];
      if (state.writtenBack?.[key]) delete state.writtenBack[key];
    }
    saveState(state);
    if (removed) {
      try {
        // The normal remove path: the setting drops its entries for that key.
        return await saveSetting(cloudSetting(), removed);
      } catch {
        // Capture is off for a reason that keeps the setting; the item is gone anyway.
      }
    }
    notifyProviderLoginsChanged();
    return await status("copilot");
  }

  /** ON while capture is off for all (or the vault is not ready): the one read, so the status says what it found; no push. */
  async function readGhWithoutCapture(state: ProviderLoginStateFile): Promise<void> {
    const bundle = carryRow("copilot").locate!(ctx)[0]!;
    const marks = await statBundle(bundle);
    const contents = "missing" in marks[0]! ? new Map<string, Buffer>() : await stableRead(bundle, marks);
    // Just changed: the next pass reads it.
    if (!contents) return;
    await ghTokenStep(contents, JSON.stringify(marks), state);
    saveState(state);
  }

  /** The Keychain part of a provider's status, on a Mac only, and the key the last Allow wrote while it is in the account. */
  function keychainStatus(
    provider: ProviderLoginProvider,
    off: ProviderLoginCaptureOffReason | null,
    vault: ProviderLoginVault | null,
  ): { part: NonNullable<ProviderLoginProviderStatus["keychain"]>; key: string | null } | null {
    if (provider !== "antigravity" || platform !== "darwin" || deps.cloudComputer || deps.staticOff) return null;
    const accountUserId = deps.accountUserId();
    const allowed = accountUserId ? loadState(accountUserId).keychain?.antigravity ?? null : null;
    const stillThere = Boolean(allowed && vault?.list(ACCOUNT_SCOPE_ALL).some((row) =>
      row.kind === PROVIDER_LOGIN_VAULT_KIND && row.key === allowed.key && !row.deleted));
    const allowedAt = allowed && stillThere ? new Date(allowed.allowedAt) : null;
    return {
      part: {
        canAllow: !off,
        allowedAt: allowedAt ? allowedAt.toISOString() : null,
        message: allowedAt
          ? `Copied from this Mac on ${allowedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. Allow again to update.`
          : "On a Mac this sign-in is in the Keychain. Allow ADE to copy it once; macOS asks you first.",
      },
      key: allowedAt ? allowed!.key : null,
    };
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
    planGeneration += 1;
    ownerRenewal?.stop();
    for (const key of [...armed.keys()]) disarm(key, "stopped");
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
    allowKeychain,
    allowGitHubCli,
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
      // The GitHub CLI choice leaves with the marks file: another account starts with it off.
      ghMemo = null;
      ghForce = false;
      setCopilotCarriedToken(null);
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
