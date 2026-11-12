/**
 * The sign-in sync's shared parts: its limits, words and types, and the one
 * state object every job of the sync reads (`createSyncShared`). Each job
 * (capture, apply, the gate, the takeover, the person's writes, the
 * Keychain and GitHub CLI reads, the ticks) is its own file and takes this
 * object; `providerLoginSync.ts` builds them and returns the service.
 *
 * Never logs a value, a hash or a file's content: events carry the provider,
 * the slot, sizes and reason codes.
 */

import os from "node:os";

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type {
  ProviderLoginApplyState,
  ProviderLoginCaptureOffReason,
  ProviderLoginGhCliStatus,
  ProviderLoginLocalState,
  ProviderLoginProvider,
  ProviderLoginProviderStatus,
  ProviderLoginSignIn,
  ProviderLoginStatus,
} from "../../../shared/types/providerLogins";
import { CLOUD_SIGN_INS } from "../../../shared/cloudSignIns";
import {
  PROVIDER_LOGINS_CLOUD_SETTING,
  cloudChoiceKey,
  readCloudSetting,
  type ProviderLoginsCloudSetting,
} from "../../../shared/providerLoginsCloudSetting";
import { isRecord } from "../shared/utils";
import type { RotatingCredentialVault } from "../account/rotatingCredentialOwner";
import { carryRow, type CarryBundle, type CarryContext, type ParsedLogin } from "./providerLoginCarry";
import type { ProviderLoginRenewer } from "./providerLoginRenew";
import type { GhTokenRead, GhTokenRunner } from "./providerLoginGhCli";
import type { AppliedEntry, AppliedStateFile } from "./providerLoginApply";
import {
  PROVIDER_LOGIN_VAULT_KIND,
  parseProviderLoginKey,
  readProviderLoginMeta,
  shortHash,
  type ProviderLoginMachine,
} from "./providerLoginPayload";
import {
  readProviderLoginState,
  writeProviderLoginState,
  type FileMark,
  type ProviderLoginStateFile,
} from "./providerLoginState";

/** A file younger than this may still be in the middle of a write. */
export const STABLE_AGE_MS = 2_000;
/** A login file gone this long (and on two passes) means the person signed out there. */
export const ABSENT_REMOVE_MS = 60_000;
/** Wait after a sign-in here, so the CLI finishes its write first. */
export const DEFAULT_SETTLE_MS = 2_000;
/** When the ADE Cloud answer could not be read: the first re-check, then double, up to the cap. */
export const ACCESS_RECHECK_MIN_MS = 60_000;
export const ACCESS_RECHECK_MAX_MS = 30 * 60_000;
/** The gate before a turn: a vault pull only when the last one is older than this. */
export const GATE_MAX_AGE_MS = 30_000;
/** The gate never holds a turn longer than this. */
export const GATE_LIMIT_MS = 5_000;
/** A copy here with less than this left makes a turn wait for a fresh one (§5.3 steps 1 and 2). */
export const SHORT_WAIT_LEFT_MS = 60_000;
/** The owner may be renewing right now while the copy is no more than this past its expiry. */
export const SHORT_WAIT_RENEWING_MS = 60_000;
export const SHORT_WAIT_POLL_MS = 5_000;
export const SHORT_WAIT_POLL_LIMIT_MS = 20_000;
/** The whole gate, with the short wait and a takeover, never passes this. Then the turn goes ahead (`owner_off`). */
export const SHORT_WAIT_GATE_LIMIT_MS = 45_000;
/** A cloud computer takes the renewal over only this long past the copy's expiry (and its last write), P5 §5.2. */
export const TAKEOVER_GRACE_MS = 60_000;

/**
 * The providers a cloud computer can take the renewal over for, and how it
 * renews: "renew" by ADE's renew call (the provider's CLI, one process),
 * "cli" by the provider's own CLI when the turn starts on the full copy.
 * Droid has no expiry ADE can read, so no turn ever waits for it. Pi's
 * Anthropic login is never carried. Every other carried provider is Fixed.
 */
export const TAKEOVER_HOW: Partial<Record<ProviderLoginProvider, "renew" | "cli">> = {
  codex: "renew",
  grok: "renew",
  kimi: "cli",
  pi: "cli",
};

export const PROVIDER_NAMES: Partial<Record<ProviderLoginProvider, string>> = {
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  pi: "Pi",
  droid: "Droid",
};

/**
 * The saved ADE Cloud keys (`integration/cloud-key-<id>`) by the provider they
 * sign in. Claude's token is P6's and is not here. A key several providers
 * share (OpenRouter: OpenCode and Pi) has no one place: it is always in its
 * env variable when saved. A single provider's key is there only when ADE
 * Cloud uses the key for it.
 */
export const SAVED_KEYS: ReadonlyArray<{ id: string; env: string; provider: ProviderLoginProvider | null }> = CLOUD_SIGN_INS
  .filter((spec) => spec.method === "key")
  .map((spec) => ({
    id: spec.id,
    env: spec.env,
    provider: spec.providers.length === 1 ? spec.providers[0]! : null,
  }));

/** A saved key's token from its vault value (`integration/cloud-key-<id>`), or null. */
export function savedKeyTokenOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) && parsed.v === 1 && typeof parsed.token === "string" && parsed.token ? parsed.token : null;
  } catch {
    return null;
  }
}

/** The vault key a saved ADE Cloud key lives under (kind `integration`). */
export function savedKeyVaultKey(id: string): string {
  return `cloud-key-${id}`;
}

/** The account a copy is for: its email (any case), else the provider's id; null when the login names neither. */
export function accountIdentityOf(account: { email: string | null; id: string | null } | null | undefined): string | null {
  const email = account?.email?.trim().toLowerCase();
  if (email) return `email:${email}`;
  const id = account?.id?.trim();
  return id ? `id:${id}` : null;
}

/** One carried sign-in that is on for ADE Cloud, as the pick rule sees it. */
export type CloudPlaceCandidate<R> = { row: R; meta: NonNullable<LoginMeta>; provider: ProviderLoginProvider; slot: string };
/** A place's pick: the saved key, or one of its sign-ins. */
export type CloudPlacePick<R> = { provider: ProviderLoginProvider } & ({ savedKey: { id: string; token: string } } | { signIn: CloudPlaceCandidate<R> });

/**
 * What ADE Cloud uses for each place (P5 §4.2), the one rule the apply pass
 * and the end warning both read, so the warning names only what ADE Cloud
 * carries. Each caller reads its rows its own way (`usable`, `meta`).
 *
 * A place's candidates are its carried `provider_login` sign-ins that are
 * usable, not deleted, not switched off and have readable meta; none while
 * ADE Cloud's sign-ins are off. The saved key wins when the person picked it,
 * or for Copilot with no pick (a saved key goes before a carried GitHub CLI
 * login, G1 Q2), if one is saved. Otherwise the picked sign-in (the
 * freshest usable copy of the picked account, when the same account came
 * from several computers), else the newest (`renewedAt`, else `capturedAt`).
 * A copy that stops being usable drops out, so the next copy takes over.
 */
export function cloudPlacePicks<R extends { kind: string; key: string; deleted?: boolean }>(
  rows: Iterable<R>,
  setting: CloudSetting,
  deps: { usable(row: R): boolean; meta(row: R): LoginMeta; savedKeyToken(id: string): string | null },
): Map<string, CloudPlacePick<R>> {
  const places = new Map<string, Array<CloudPlaceCandidate<R>>>();
  if (setting.enabled) {
    for (const row of rows) {
      if (row.kind !== PROVIDER_LOGIN_VAULT_KIND || row.deleted || !deps.usable(row) || setting.off.includes(row.key)) continue;
      const parsedKey = parseProviderLoginKey(row.key);
      if (!parsedKey || carryRow(parsedKey.provider).carry !== "carried") continue;
      const meta = deps.meta(row);
      if (!meta) continue;
      const place = cloudChoiceKey(parsedKey.provider, parsedKey.slot);
      places.set(place, [...(places.get(place) ?? []), { row, meta, provider: parsedKey.provider, slot: parsedKey.slot }]);
    }
  }
  const picks = new Map<string, CloudPlacePick<R>>();
  for (const [place, list] of places) {
    const provider = list[0]!.provider;
    const chosen = setting.inUse[place];
    const saved = provider === "pi" ? null : SAVED_KEYS.find((spec) => spec.provider === provider) ?? null;
    const keyFirst = chosen === "key" || (chosen === undefined && provider === "copilot");
    const token = saved && keyFirst ? deps.savedKeyToken(saved.id) : null;
    if (saved && token) {
      picks.set(place, { provider, savedKey: { id: saved.id, token } });
      continue;
    }
    const newestFirst = [...list].sort((left, right) => (right.meta.renewedAt ?? right.meta.capturedAt) - (left.meta.renewedAt ?? left.meta.capturedAt));
    const picked = list.find((entry) => entry.row.key === chosen) ?? null;
    // A pick names one copy of an account; the same account copied from
    // another computer is the same choice (one card per account, B14-5), so
    // the freshest usable copy of it wins. A copy that names no account is
    // only itself.
    const pickedAccount = picked ? accountIdentityOf(picked.meta.account) : null;
    const signIn = (pickedAccount ? newestFirst.find((entry) => accountIdentityOf(entry.meta.account) === pickedAccount) : null)
      ?? picked
      ?? newestFirst[0]!;
    picks.set(place, { provider, signIn });
  }
  return picks;
}

/** Local states under which apply may replace the file here: the login is safe in the account, or is the account's. */
export const OVERWRITE_SAFE: ReadonlySet<ProviderLoginLocalState> = new Set([
  "not_signed_in", "captured", "removed_from_account", "other_owner_newer", "from_account",
]);

export const APPLY_MESSAGES: Record<ProviderLoginApplyState, string> = {
  applied: "The account's sign-in is on this cloud computer.",
  own: "The sign-in in use was made on this cloud computer.",
  key: "The saved ADE Cloud key is in use.",
  none: "No sign-in is in use on ADE Cloud for this provider.",
  kept_local: "A sign-in made on this cloud computer is not in your account yet, so ADE did not replace it.",
  failed: "ADE couldn't write this sign-in here. It tries again on the next pass.",
};

export type CloudAccessState = "ready" | "no_access" | "signed_out" | "unreadable";

export type VaultRow = {
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

export type Logger = {
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

export const OFF_MESSAGES: Record<ProviderLoginCaptureOffReason, string> = {
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
export const GH_ALLOW_WHILE_OFF: ReadonlySet<ProviderLoginCaptureOffReason> = new Set(["all_off", "vault_unavailable"]);
/** The read on the person's click waits for a keychain or keyring prompt; a read after a file change does not wait as long. */
export const GH_READ_ON_CLICK_MS = 120_000;
export const GH_READ_MS = 20_000;

export const LOCAL_MESSAGES: Record<ProviderLoginLocalState, string> = {
  captured: "In your account.",
  not_signed_in: "Not signed in on this computer.",
  os_store: "The sign-in is in the OS keychain or keyring. ADE does not read it in the background.",
  settling: "The login file just changed. ADE reads it on the next pass.",
  too_large: "This sign-in is too big for your account.",
  unreadable: "ADE found a login file but could not read a sign-in from it.",
  account_unreadable: "ADE couldn't read your account's copy of this sign-in on this computer, so it keeps that copy as it is.",
  removed_from_account: "You removed this sign-in from your account. Sign in again here to add it back.",
  other_owner_newer: "Another computer renews this sign-in, so your account keeps that computer's copy.",
  written_back: "A cloud computer renewed this sign-in while this computer was off. ADE wrote the newer copy into the login file here.",
  from_saved_key: "This file came from a saved ADE Cloud key. It stays a key.",
  from_account: "This is the account's sign-in. ADE wrote it on this cloud computer.",
  account_refused: "Your account service doesn't take sign-ins yet. ADE keeps this one on this computer and tries again every hour.",
  not_checked: "Not checked on this computer.",
};

/** When one provider has several sign-ins (Pi), the state that says the most wins. */
export const LOCAL_STATE_RANK: ProviderLoginLocalState[] = [
  "account_refused", "too_large", "unreadable", "account_unreadable", "settling", "other_owner_newer", "removed_from_account", "written_back", "captured",
  "from_account", "from_saved_key", "os_store", "not_signed_in", "not_checked",
];

/** `smartBalance` is read only for the status; its writes go through `setCloudBalance` (P6 reads it too). */
export type CloudSetting = ProviderLoginsCloudSetting;

export type LoginMemo = {
  slot: string;
  key: string;
  contentHash: string;
  familyHash: string;
  class: ParsedLogin["class"];
  expiresAt: number | null;
  account: ParsedLogin["account"];
};

/** The same account identity: both unknown, or every field either side knows is the same. */
export function sameAccount(left: ParsedLogin["account"], right: ParsedLogin["account"]): boolean {
  if (!left || !right) return !left && !right;
  const fields = ([["email", left.email, right.email], ["id", left.id, right.id]] as const)
    .filter(([, mine, theirs]) => mine != null || theirs != null);
  return fields.length > 0 && fields.every(([, mine, theirs]) => mine === theirs);
}

export const accountHash = (account: ParsedLogin["account"]): string => shortHash(JSON.stringify(account ?? null));

export const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, Math.max(0, ms));
  timer.unref?.();
});
/** `unreadable`: the last read gave no answer (a parse failure); it stays that until the file changes, never "no login". */
export type BundleMemo = { logins: LoginMemo[]; skipped: Array<{ slot: string; state: ProviderLoginLocalState }>; unreadable?: true };

export type BundleObservation =
  | { kind: "absent" }
  | { kind: "settling" }
  | { kind: "unreadable" }
  | { kind: "parsed"; logins: Array<{ memo: LoginMemo; full: ParsedLogin | null }>; skipped: BundleMemo["skipped"] };

/** `later` is a later expiry than `than`; false when either is unknown. */
export const laterExpiry = (later: number | null, than: number | null): boolean => later != null && than != null && later > than;

export type LoginMeta = ReturnType<typeof readProviderLoginMeta>;
export type LocalSlot = { state: ProviderLoginLocalState; key: string | null };
export type PushDecision = { push: false; state: ProviderLoginLocalState; writeBack?: true } | { push: true };
export type TakeoverResult = "renewed" | "fresh" | "none";
export type AppliedCopy = { place: string; entry: AppliedEntry };

/**
 * The calls one job of the sync makes into another. `createProviderLoginSync`
 * fills it once every job is built; a job reads it only when it runs.
 */
export type SyncJobs = {
  // capture (providerLoginCapture.ts)
  pass(providers?: ProviderLoginProvider[] | null): Promise<void>;
  decide(login: LoginMemo, vault: ProviderLoginVault, rows: Map<string, VaultRow>, state: ProviderLoginStateFile, machine: ProviderLoginMachine): PushDecision;
  push(
    provider: ProviderLoginProvider,
    login: ParsedLogin,
    memo: LoginMemo,
    vault: ProviderLoginVault,
    rows: Map<string, VaultRow>,
    state: ProviderLoginStateFile,
    machine: ProviderLoginMachine,
    takeover?: { place: string } | null,
  ): ProviderLoginLocalState;
  statBundle(bundle: CarryBundle): Promise<FileMark[] | "unreadable">;
  stableRead(bundle: CarryBundle, marks: FileMark[]): Promise<Map<string, Buffer> | "unreadable" | null>;
  ghTokenStep(contents: Map<string, Buffer>, mark: string, state: ProviderLoginStateFile): Promise<void>;
  ofSameSignIn(meta: { familyHash: string; lineage: string[]; takenFrom: string | null }, login: LoginMemo, state: ProviderLoginStateFile): boolean;
  // status and the person's writes (providerLoginStatus.ts, providerLoginWrites.ts)
  status(provider?: ProviderLoginProvider | null): Promise<ProviderLoginStatus>;
  saveSetting(next: CloudSetting, dropKey?: string | null, claude?: Record<string, unknown> | null): Promise<ProviderLoginStatus>;
  // apply on a cloud computer (providerLoginApplyPass.ts)
  runApply(
    vault: ProviderLoginVault,
    accountUserId: string,
    origin12: string,
    deviceId: string,
    providers: Set<ProviderLoginProvider> | null,
    captureRan: boolean,
  ): Promise<void>;
  loadApplied(accountUserId: string): Promise<AppliedStateFile>;
  isAppliedBundle(provider: ProviderLoginProvider, bundle: CarryBundle): boolean;
  ownedPlaceFor(provider: ProviderLoginProvider, login: LoginMemo): { place: string; source: string } | null;
  noteOwnedCopy(place: string, memo: LoginMemo, expiresAt: number | null): void;
  // takeover, write-back and renewal (providerLoginTakeover.ts)
  checkArmed(): void;
  writeBack(
    candidate: { provider: ProviderLoginProvider; memo: LoginMemo; bundleId: string },
    vault: ProviderLoginVault,
    rows: Map<string, VaultRow>,
    state: ProviderLoginStateFile,
    machine: ProviderLoginMachine,
  ): Promise<boolean>;
  planRenewals(vault: ProviderLoginVault, machine: ProviderLoginMachine, origin12: string, state: ProviderLoginStateFile): Promise<void>;
  /** No renewal ahead and no timer for one (capture is off). */
  cancelRenewalPlan(): void;
  /** The renewal planner stops (the ticks are left). */
  stopRenewals(): void;
  /** Every armed takeover goes (the ticks are left). */
  disarmAll(): void;
  expiringCopy(provider: string): AppliedCopy | null;
  takeoverCopy(provider: string): AppliedCopy | null;
  takeover(provider: ProviderLoginProvider, place: string, key: string): Promise<TakeoverResult>;
  /** A takeover of `key` runs here now. */
  takeoverRunning(key: string): boolean;
  armTakeover(provider: ProviderLoginProvider, place: string, key: string): void;
  claimAt(key: string): number | null;
  ownerLabelOf(key: string): string;
  // the Keychain and GitHub CLI parts of the status (providerLoginAllow.ts)
  keychainStatus(
    provider: ProviderLoginProvider,
    off: ProviderLoginCaptureOffReason | null,
    vault: ProviderLoginVault | null,
  ): { part: NonNullable<ProviderLoginProviderStatus["keychain"]>; key: string | null } | null;
  ghCliStatus(off: ProviderLoginCaptureOffReason | null): Promise<ProviderLoginGhCliStatus | null>;
  ghCliMessage(gh: ProviderLoginGhCliStatus, off: ProviderLoginCaptureOffReason | null, fallback: string): string;
  // the ticks (providerLoginAccess.ts)
  leaveTicks(): void;
};

/**
 * The state every job of the sync shares, and the small reads they all use.
 * Maps and arrays are shared by reference; a field that is set again (the
 * caches, the pass in flight) is read through this object, never copied.
 */
export type SyncShared = {
  deps: ProviderLoginSyncDeps;
  now: () => number;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  ctx: CarryContext;
  settleMs: number;
  jobs: SyncJobs;
  bundleMemos: Map<string, BundleMemo>;
  localStates: Map<ProviderLoginProvider, Map<string, LocalSlot>>;
  metaMemo: Map<string, { updatedAt: string; meta: LoginMeta }>;
  /** Apply's state by place, for the status (cloud computers). */
  applyStates: Map<string, { state: ProviderLoginApplyState; key: string | null }>;
  /** The last turn whose short wait ended without a fresh copy, by place (cleared when a new copy applies). */
  ownerOff: Map<string, { ownerLabel: string; at: number }>;
  settleTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** The shared vault and settings ticks this service rides, while the account has ADE Cloud. */
  ticks: Array<() => void>;
  lastPassAt: number | null;
  /** The marks file, read once per account and written only when it changed. */
  stateCache: ProviderLoginStateFile | null;
  inFlight: Promise<void> | null;
  /**
   * Copilot's GitHub CLI login (G1): the last read by the marks of hosts.yml
   * (memory only; it holds the token so a forced re-read never runs gh
   * again), and the person's click that forces the next read.
   */
  ghMemo: { mark: string; read: GhTokenRead } | null;
  ghForce: boolean;
  /** What apply wrote here, for this account (cloud computers). */
  appliedCache: AppliedStateFile | null;
  appliedLoginHashes: Set<string>;
  /** The ADE Cloud answer being read now, if any. */
  accessPending: Promise<CloudAccessState | null> | null;
  cloudSetting(): CloudSetting;
  captureOffReason(): Promise<ProviderLoginCaptureOffReason | null>;
  setLocal(provider: ProviderLoginProvider, slotId: string, state: ProviderLoginLocalState, key: string | null): void;
  loadState(accountUserId: string): ProviderLoginStateFile;
  saveState(state: ProviderLoginStateFile): void;
  metaFor(vault: ProviderLoginVault, row: VaultRow): LoginMeta;
  signInsFromVault(vault: ProviderLoginVault | null, origin12: string | null, setting: CloudSetting, deviceId?: string | null): ProviderLoginSignIn[];
  liveSignInKeys(vault: ProviderLoginVault): Set<string>;
};

export function createSyncShared(deps: ProviderLoginSyncDeps): SyncShared {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const ctx: CarryContext = { env, homeDir, platform, cloudComputer: deps.cloudComputer };
  const metaMemo: SyncShared["metaMemo"] = new Map();
  const localStates: SyncShared["localStates"] = new Map();

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

  function saveState(state: ProviderLoginStateFile): void {
    try {
      writeProviderLoginState(deps.adeDir, state);
    } catch (error) {
      deps.logger.warn("provider_login.state_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
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
        origin: {
          label: meta.origin.label,
          ...(meta.origin.machineKey ? { machineKey: meta.origin.machineKey } : {}),
          platform: meta.origin.platform,
          thisComputer: parsedKey.origin12 === origin12,
        },
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
      const newestFirst = [...on].sort((left, right) => (right.renewedAt ?? right.capturedAt ?? "").localeCompare(left.renewedAt ?? left.capturedAt ?? ""));
      const picked = on.find((signIn) => signIn.key === chosen) ?? null;
      // The same rule as `cloudPlacePicks`: the picked account's freshest copy.
      const pickedAccount = picked ? accountIdentityOf(picked.account) : null;
      const pick = (pickedAccount ? newestFirst.find((signIn) => accountIdentityOf(signIn.account) === pickedAccount) : null)
        ?? picked
        ?? newestFirst[0];
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

  function liveSignInKeys(vault: ProviderLoginVault): Set<string> {
    return new Set(vault.list(ACCOUNT_SCOPE_ALL)
      .filter((row) => row.kind === PROVIDER_LOGIN_VAULT_KIND && !row.deleted)
      .map((row) => row.key));
  }

  const s: SyncShared = {
    deps,
    now,
    env,
    platform,
    ctx,
    settleMs: deps.settleMs ?? DEFAULT_SETTLE_MS,
    jobs: {} as SyncJobs,
    bundleMemos: new Map(),
    localStates,
    metaMemo,
    applyStates: new Map(),
    ownerOff: new Map(),
    settleTimers: new Map(),
    ticks: [],
    lastPassAt: null,
    stateCache: null,
    inFlight: null,
    ghMemo: null,
    ghForce: false,
    appliedCache: null,
    appliedLoginHashes: new Set(),
    accessPending: null,
    cloudSetting,
    captureOffReason,
    setLocal,
    loadState: (accountUserId) => {
      if (s.stateCache?.accountUserId !== accountUserId) s.stateCache = readProviderLoginState(deps.adeDir, accountUserId);
      return s.stateCache;
    },
    saveState,
    metaFor,
    signInsFromVault,
    liveSignInKeys,
  };
  return s;
}
