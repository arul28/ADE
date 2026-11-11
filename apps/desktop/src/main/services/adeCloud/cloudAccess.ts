/**
 * How ADE reaches ADE Cloud, and the one place that picks it: ADE's server,
 * called with the signed-in account's token. The server holds the provider's
 * key, so nothing here ever has one.
 */

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { cloudStatusAwake, type CloudStatus } from "../../../shared/adeCloud";
import { setAdeCloudSkillVisible, setAgentSkillAccessRefresh } from "../../../shared/agentSkillRoots";
import type { AccountVaultResult } from "../../../shared/types/accountVault";
import { getSignedInAccountAccessToken, type AccountAuthService } from "../../../../../ade-cli/src/services/account/accountAuthService";
import { resolveSelectedUpdateTrack } from "../../../../../ade-cli/src/services/runtime/updateTrackStore";
import { readCloudComputerIdAsync } from "../../../../../ade-cli/src/services/account/hardwareAnchor";
import { isAdeCloudComputer } from "./cloudComputerRules";
import { getErrorMessage } from "../shared/utils";
import { CLOUD_ACCESS_REFUSED, CloudProviderError, type CloudProvider } from "./cloudProvider";
import { createCloudServerProvider, type CloudComputerSignal } from "./cloudServerProvider";
import { CLOUD_COMPUTER_UNREADABLE } from "../../../../../account-directory/src/cloud/contract";

export const CLOUD_VAULT_KIND = "integration";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One account vault item. `ok: false` means unreachable, not empty. */
export type CloudVault = {
  get(): Promise<{ ok: true; value: string | null } | { ok: false }>;
  set(value: string): Promise<boolean>;
  remove(): Promise<boolean>;
};

export type CloudAccessDeps = {
  signedIn: () => boolean;
  /** The signed-in account, so a cached access answer never outlives the person. */
  accountId: () => string | null;
  accessToken: () => Promise<string | null>;
  /** The account directory; `ADE_ACCOUNT_DIRECTORY_URL` points a dev build at a local server. */
  directoryBaseUrl: () => string | null;
  /** Names this computer in the server's delete log. */
  deviceName?: () => string | null;
  /** This machine's update track: a computer it makes follows the same channel. */
  updateChannel?: () => "stable" | "beta" | null;
  /** This computer's id for the free plan (`cloudFreePlanComputer`); left out on an ADE Cloud computer. */
  computer?: () => Promise<CloudComputerSignal | null>;
  fetch?: FetchLike;
  logger?: { warn(event: string, meta?: Record<string, unknown>): void };
};

/** The access deps every process builds from its account service and its directory URL. */
export function cloudAccessDepsFor(args: {
  account: () => Pick<AccountAuthService, "getStatus" | "getAccessToken"> | null | undefined;
  directoryBaseUrl: () => string;
  deviceName?: () => string | null;
  /** The ADE version this process runs, for its update track when none was saved. Default: `ADE_CLI_VERSION`. */
  runningVersion?: () => string | null;
  logger?: CloudAccessDeps["logger"];
  onDirectoryUnavailable?: (error: unknown) => void;
}): CloudAccessDeps {
  return {
    signedIn: () => args.account()?.getStatus().signedIn === true,
    accountId: () => args.account()?.getStatus().userId ?? null,
    accessToken: async () => {
      const account = args.account();
      return account ? await getSignedInAccountAccessToken(account) : null;
    },
    directoryBaseUrl: () => {
      try {
        return args.directoryBaseUrl() || null;
      } catch (error) {
        args.onDirectoryUnavailable?.(error);
        return null;
      }
    },
    deviceName: args.deviceName,
    // The machine's saved track (one file the app, brain and CLI share), else
    // the track of this build. An Alpha build makes Beta computers.
    updateChannel: () => {
      const version = args.runningVersion?.() ?? process.env.ADE_CLI_VERSION?.trim() ?? null;
      return /-alpha\b/i.test(version ?? "") ? "beta" : resolveSelectedUpdateTrack(version);
    },
    computer: cloudFreePlanComputer,
    logger: args.logger,
  };
}

/** An `unreadable` id is sent for this long, then read again. */
const COMPUTER_ID_RETRY_MS = 10 * 60_000;

/**
 * The id ADE Cloud's free plan is given once for (one per physical computer,
 * `freePlan.ts` on the server), read once per process off the event loop. An
 * ADE Cloud computer sends none: it never claims a free plan. `unreadable`
 * is not kept for the process's life: a probe that timed out once (a slow
 * `reg query`) is read again after a while, so the computer can still claim.
 */
let freePlanComputer: Promise<CloudComputerSignal> | null = null;
/** When an `unreadable` answer may be read again; null while the read is pending or found an id. */
let freePlanRetryAt: number | null = null;
export function cloudFreePlanComputer(): Promise<CloudComputerSignal | null> {
  if (isAdeCloudComputer()) return Promise.resolve(null);
  if (freePlanComputer && (freePlanRetryAt === null || Date.now() < freePlanRetryAt)) return freePlanComputer;
  freePlanRetryAt = null;
  freePlanComputer = readCloudComputerIdAsync()
    .catch(() => CLOUD_COMPUTER_UNREADABLE)
    .then((id) => {
      if (id === CLOUD_COMPUTER_UNREADABLE) freePlanRetryAt = Date.now() + COMPUTER_ID_RETRY_MS;
      return { id, platform: process.platform };
    });
  return freePlanComputer;
}

type CloudVaultBridge = {
  get(scope: string, kind: string, key: string): Promise<AccountVaultResult<string | null>>;
  set(scope: string, kind: string, key: string, value: string): Promise<AccountVaultResult<null>>;
  remove(scope: string, kind: string, key: string): Promise<AccountVaultResult<null>>;
};

/** Desktop main: one account-wide item in the brain's vault over `accountVaultBridge`. */
export function cloudVaultFromBridge(bridge: CloudVaultBridge, key: string): CloudVault {
  return {
    async get() {
      const result = await bridge.get(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key);
      return result.ok ? { ok: true, value: result.value } : { ok: false };
    },
    async set(value) {
      return (await bridge.set(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key, value)).ok;
    },
    async remove() {
      return (await bridge.remove(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key)).ok;
    },
  };
}

/** The brain: one account-wide item in its own vault store. */
export function cloudVaultFromStore(store: {
  get(scope: string, kind: "integration", key: string): string | null;
  set(scope: string, kind: "integration", key: string, value: string): boolean;
  remove(scope: string, kind: "integration", key: string): boolean;
}, key: string): CloudVault {
  return {
    async get() {
      return { ok: true, value: store.get(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key) };
    },
    async set(value) {
      return store.set(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key, value);
    },
    async remove() {
      return store.remove(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key);
    },
  };
}

type CloudAccess =
  | { state: "ready"; provider: CloudProvider }
  | { state: "no_access" | "signed_out" | "unreadable" };

/** Why ADE Cloud can't be used from here, one sentence per reason (`cloud.status` names the reason by these). */
export const NO_PROVIDER_SENTENCE: Readonly<Record<Exclude<CloudAccess["state"], "ready">, string>> = {
  no_access: "ADE Cloud isn't available on this account yet.",
  signed_out: "Sign in to ADE to use ADE Cloud.",
  unreadable: "ADE couldn't check this account's ADE Cloud access. Try again in a moment.",
};

/** `/cloud/access` is asked at most this often per account. */
const ACCESS_TTL_MS = 10 * 60_000;
/** After a failed ask, how long the next ones wait, so an unreachable server can't slow every caller. */
const ACCESS_FAILURE_TTL_MS = 60_000;

/** The last answer: per process, so every surface in it shares one check. */
let accessCache: { key: string; enabled: boolean; at: number } | null = null;
let accessAsking: { key: string; answer: Promise<boolean | null> } | null = null;
let accessFailure: { key: string; at: number } | null = null;
const accessAnswerListeners = new Set<() => void>();

/**
 * Hear when the cached answer changes (a new yes or no, or a sign-out that
 * clears it), whoever asked. A listener reads the answer again for free: the
 * cache is fresh when it runs. For work that must not ask on a timer.
 */
export function onCloudAccessAnswerChanged(listener: () => void): () => void {
  accessAnswerListeners.add(listener);
  return () => accessAnswerListeners.delete(listener);
}

function setAccessCache(next: { key: string; enabled: boolean; at: number } | null): void {
  const changed = next?.key !== accessCache?.key || next?.enabled !== accessCache?.enabled;
  accessCache = next;
  if (!changed) return;
  for (const listener of [...accessAnswerListeners]) {
    try {
      listener();
    } catch {
      // A listener's failure is its own; the answer stays cached.
    }
  }
}

const accessKey = (deps: CloudAccessDeps): string => `${deps.directoryBaseUrl() ?? ""}|${deps.accountId() ?? ""}`;

/**
 * Whether ADE Cloud exists for this account here: yes only on the server's yes,
 * or a cached yes riding out a failure. Every surface that hides the product
 * reads this one answer; the TTL behind it is the "at most every 10 minutes".
 */
export async function cloudAccessEnabled(deps: CloudAccessDeps): Promise<boolean> {
  return (await readCloudAccess(deps)).state === "ready";
}

/**
 * The account's ADE Cloud answer as one word, from the same cached ask as
 * `cloudAccessEnabled`: `ready`, `no_access`, `signed_out`, or `unreadable`
 * (the server could not be asked and no earlier yes is cached).
 */
export async function readCloudAccessState(deps: CloudAccessDeps): Promise<CloudAccess["state"]> {
  return (await readCloudAccess(deps)).state;
}

/**
 * Hands the skill roots the account this process serves, so a chat launched
 * after the answer went stale (or the account changed) asks again on its own.
 * Installed once by whatever owns the account here: the brain, the desktop main.
 */
export function watchCloudAccessForSkills(deps: CloudAccessDeps): void {
  setAgentSkillAccessRefresh(() => {
    const fresh = accessCache?.key === accessKey(deps) && Date.now() - accessCache.at < ACCESS_TTL_MS;
    if (fresh || accessAsking) return;
    void cloudAccessEnabled(deps).catch((error: unknown) => {
      deps.logger?.warn("cloud.skill_access_read_failed", { error: getErrorMessage(error) });
    });
  });
}

/** Yes or no from the server, or null when it couldn't be asked; a cached yes rides out a failure. */
async function readAccessFlag(key: string, provider: CloudProvider, deps: CloudAccessDeps): Promise<boolean | null> {
  const now = Date.now();
  if (accessCache?.key === key && now - accessCache.at < ACCESS_TTL_MS) return accessCache.enabled;
  const cachedYes = () => (accessCache?.key === key && accessCache.enabled ? true : null);
  if (accessFailure?.key === key && now - accessFailure.at < ACCESS_FAILURE_TTL_MS) return cachedYes();
  if (accessAsking?.key === key) return await accessAsking.answer;
  const answer = provider.accessEnabled().then(
    (enabled) => {
      setAccessCache({ key, enabled, at: Date.now() });
      accessFailure = null;
      return enabled;
    },
    (error: unknown) => {
      deps.logger?.warn("cloud.access_read_failed", { error: getErrorMessage(error) });
      accessFailure = { key, at: Date.now() };
      return cachedYes();
    },
  );
  accessAsking = { key, answer };
  try {
    return await answer;
  } finally {
    if (accessAsking?.key === key && accessAsking.answer === answer) accessAsking = null;
  }
}

async function readCloudAccess(deps: CloudAccessDeps): Promise<CloudAccess> {
  const access = await askCloudAccess(deps);
  setAdeCloudSkillVisible(access.state === "ready");
  return access;
}

async function askCloudAccess(deps: CloudAccessDeps): Promise<CloudAccess> {
  if (!deps.signedIn()) {
    // Not a fact about any account: the next sign-in asks again, even the same one.
    setAccessCache(null);
    accessFailure = null;
    return { state: "signed_out" };
  }
  const baseUrl = deps.directoryBaseUrl();
  if (!baseUrl) return { state: "unreadable" };
  const provider = serverProviderFor(deps);
  const enabled = await readAccessFlag(accessKey(deps), provider, deps);
  if (enabled == null) return { state: "unreadable" };
  return enabled ? { state: "ready", provider } : { state: "no_access" };
}

function serverProviderFor(deps: CloudAccessDeps): CloudProvider {
  return createCloudServerProvider({
    accessToken: deps.accessToken,
    baseUrl: deps.directoryBaseUrl,
    deviceName: deps.deviceName,
    updateChannel: deps.updateChannel,
    computer: deps.computer,
    fetch: deps.fetch,
    logger: deps.logger,
  });
}

/** ADE Cloud for this account, or null when it can't be used from here right now. */
export async function getCloudProvider(deps: CloudAccessDeps): Promise<CloudProvider | null> {
  const access = await readCloudAccess(deps);
  return access.state === "ready" ? access.provider : null;
}

/** ADE Cloud if the last answer for this account was yes, without asking the server: for work on a timer. */
export function knownCloudProvider(deps: CloudAccessDeps): CloudProvider | null {
  if (!deps.signedIn() || accessCache?.key !== accessKey(deps) || !accessCache.enabled) return null;
  return serverProviderFor(deps);
}

/** ADE's server for this account whatever its access answer, for routes that say so themselves. Null when signed out. */
export function cloudServerFor(deps: CloudAccessDeps): CloudProvider | null {
  return deps.signedIn() && deps.directoryBaseUrl() ? serverProviderFor(deps) : null;
}

/** Why this computer has no ADE Cloud right now, or null when it has it. */
export async function cloudNoProviderSentence(deps: CloudAccessDeps): Promise<string | null> {
  const access = await readCloudAccess(deps);
  return access.state === "ready" ? null : NO_PROVIDER_SENTENCE[access.state];
}

/** ADE Cloud for this account; throws a plain sentence when there is none. */
export async function requireCloudProvider(deps: CloudAccessDeps): Promise<CloudProvider> {
  const access = await readCloudAccess(deps);
  if (access.state !== "ready") throw new Error(NO_PROVIDER_SENTENCE[access.state]);
  return access.provider;
}

const NO_ACCESS: CloudStatus = { connected: false, signedOut: false, instanceCount: null, runningCount: null, error: null };

export async function readCloudStatus(deps: CloudAccessDeps): Promise<CloudStatus> {
  const access = await readCloudAccess(deps);
  if (access.state !== "ready") {
    if (access.state === "no_access") return NO_ACCESS;
    if (access.state === "signed_out") return { ...NO_ACCESS, signedOut: true };
    // Not a fact about the account, so the surfaces show it as a failed check.
    return { ...NO_ACCESS, connected: true, error: NO_PROVIDER_SENTENCE.unreadable };
  }
  try {
    const instances = await access.provider.listInstances();
    return {
      connected: true,
      signedOut: false,
      instanceCount: instances.filter((instance) => instance.status !== "deleted" && instance.status !== "failed").length,
      runningCount: instances.filter((instance) => cloudStatusAwake(instance.status)).length,
      error: null,
    };
  } catch (error) {
    const refused = error instanceof CloudProviderError && error.code === CLOUD_ACCESS_REFUSED;
    // Refused is no access; one that could not be reached still is.
    return { ...NO_ACCESS, connected: !refused, error: error instanceof Error ? error.message : "Couldn't reach ADE Cloud." };
  }
}
