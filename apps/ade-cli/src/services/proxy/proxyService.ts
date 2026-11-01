import { randomBytes } from "node:crypto";
import path from "node:path";

import type {
  SubscriptionProxyLogin,
  SubscriptionProxyMutationResult,
  SubscriptionProxyProvider,
  SubscriptionProxySetDisabledArgs,
  SubscriptionProxySignInArgs,
  SubscriptionProxySignInResult,
  SubscriptionProxySignOutArgs,
  SubscriptionProxyStatus,
} from "../../../../desktop/src/shared/types/subscriptionProxy";
import {
  CliProxyApiManagementClient,
  createCliProxyApiManagementClient,
  type CliProxyApiAuthFile,
  type CliProxyApiAuthStatusResponse,
  type CliProxyApiAuthUrlResponse,
  type CliProxyApiProvider,
} from "./cliProxyApiManagement";
import {
  createCliProxyApiSupervisor,
  type CliProxyApiSupervisor,
  type CliProxyApiSupervisorStatus,
} from "./cliProxyApiSupervisor";
import {
  cliLoginBorrowableAccounts,
  hasBorrowedLogins,
  isBorrowedLoginFileName,
  nextBorrowRenewalAt,
  syncBorrowedLogins,
  writeBorrowedModelCache,
  type BorrowableAccount,
  type BorrowedLoginOutcome,
} from "./borrowedLogins";
import { captureError } from "../../../../desktop/src/shared/sentry/capture";
import { isHarnessPresetAccountProvider, type HarnessPresetAccountProvider } from "../../../../desktop/src/shared/harnessPresets";
import { getMachineProviderInstanceStore } from "../providerInstances/providerInstanceStore";
import {
  captureFeatureUsedAnalytics,
  type FeatureAnalytics,
} from "../../../../desktop/src/main/services/analytics/featureProductAnalytics";

export const PROXY_AUTH_TIMEOUT_MS = 5 * 60_000;
export const PROXY_AUTH_POLL_INTERVAL_MS = 1_000;
/**
 * The longest a running proxy waits between passes that re-lend this machine's
 * logins. Each pass reads a file per Codex account and one Keychain item per
 * Claude account. The next pass is aimed earlier when a lent token enters its
 * renew window first (Claude Code renews only in its last ~2 minutes).
 */
export const PROXY_BORROW_KEEPER_INTERVAL_MS = 10 * 60_000;
const PROXY_BORROW_KEEPER_MIN_DELAY_MS = 5_000;
/**
 * After a pass that left a token still due (offline, a refresh error, the
 * pinned CLI still downloading), the next pass waits this long, doubling up to
 * the regular interval: retrying at the floor would spawn the provider's CLI
 * every few seconds for as long as the failure lasts (Codex's window is a day).
 * 30 s still lands two tries inside Claude Code's ~110 s renew window.
 */
const PROXY_BORROW_KEEPER_RETRY_MS = 30_000;

/**
 * Which service keeps each auth folder's lent logins. Every project runtime in
 * the brain makes its own service for the one machine-level proxy, and one
 * keeper per folder is enough. The others wait in `keeperWaiters`; when the
 * keeper's service is disposed, the first one waiting takes over.
 */
const keeperOwners = new Map<string, symbol>();
const keeperWaiters = new Map<string, Map<symbol, () => void>>();

type ProxyManagementClient = Pick<
  CliProxyApiManagementClient,
  | "listAuthFiles"
  | "getAuthUrl"
  | "getAuthStatus"
  | "deleteAuthFile"
  | "patchAuthFileFields"
  | "setAuthFileStatus"
>;

type ProxySupervisor = Pick<CliProxyApiSupervisor, "getStatus" | "ensureRunning" | "stop">;

export type ProxyServiceOptions = {
  adeHome?: string;
  supervisor?: ProxySupervisor;
  managementClientFactory?: (status: CliProxyApiSupervisorStatus) => ProxyManagementClient;
  openExternal?: (url: string) => Promise<void> | void;
  print?: (message: string) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  authTimeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * Main/brain-owned product analytics, read at capture time. The accessor form
   * is the only form: a caller that builds the proxy service lazily, before its
   * analytics service exists, would otherwise capture the `null` that was in
   * scope at wiring time. Omitted in isolated CLI tests.
   */
  getAnalytics?: () => FeatureAnalytics | null | undefined;
  /** The Claude and Codex accounts whose logins the proxy may borrow. */
  listBorrowableAccounts?: () => BorrowableAccount[];
  /** Replaces the login sync in tests. */
  syncLogins?: typeof syncBorrowedLogins;
  /** The proxy's `/v1/models` list; the default asks the running proxy. */
  fetchModels?: ((port: number, apiKey: string) => Promise<Array<{ id?: unknown; owned_by?: unknown }>>) | null;
  keeperIntervalMs?: number;
};

export type ProxyService = {
  status(): Promise<SubscriptionProxyStatus>;
  ensureRunning(): Promise<SubscriptionProxyStatus>;
  stop(): Promise<SubscriptionProxyMutationResult>;
  signIn(args: SubscriptionProxySignInArgs): Promise<SubscriptionProxySignInResult>;
  signOut(args: SubscriptionProxySignOutArgs): Promise<SubscriptionProxyMutationResult>;
  setDisabled(args: SubscriptionProxySetDisabledArgs): Promise<SubscriptionProxyMutationResult>;
  /** Lend this machine's current logins to a running proxy, renewing near-expiry ones. */
  borrowLogins(): Promise<BorrowedLoginOutcome[]>;
  dispose(): Promise<void>;
};

export type ProxyActionDomainService = {
  status(): Promise<SubscriptionProxyStatus>;
  ensureRunning(): Promise<SubscriptionProxyStatus>;
  stop(): Promise<SubscriptionProxyMutationResult>;
  signIn(args: unknown): Promise<SubscriptionProxySignInResult>;
  signOut(args: unknown): Promise<SubscriptionProxyMutationResult>;
  setDisabled(args: unknown): Promise<SubscriptionProxyMutationResult>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireProvider(value: unknown): SubscriptionProxyProvider {
  if (value !== "claude" && value !== "codex") {
    throw new Error('Proxy provider must be "claude" or "codex".');
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Proxy ${field} is required.`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Proxy ${field} must be a boolean.`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function authFilePrefix(file: CliProxyApiAuthFile): string | null {
  return optionalString(file.prefix);
}

function authFilePlan(file: CliProxyApiAuthFile): string | null {
  return optionalString(file.plan)
    ?? optionalString(file.id_token?.chatgpt_plan_type)
    ?? optionalString(file.quota?.signals?.plan)
    ?? optionalString(file.quota?.signals?.plan_type);
}

function summarizeLogin(file: CliProxyApiAuthFile): SubscriptionProxyLogin {
  const borrowed = isBorrowedLoginFileName(file.id);
  return {
    loginId: file.id,
    provider: borrowed && typeof file.ade_provider === "string" ? file.ade_provider : file.provider,
    email: optionalString(file.email),
    plan: authFilePlan(file),
    prefix: authFilePrefix(file),
    disabled: file.disabled === true,
    ...(borrowed ? { borrowed: true } : {}),
  };
}

function isSuccessStatus(status: string): boolean {
  return ["ok", "success", "authorized", "complete", "completed"].includes(status.toLowerCase());
}

function isErrorStatus(status: string): boolean {
  return ["error", "failed", "failure", "denied", "cancelled", "canceled"].includes(status.toLowerCase());
}

function errorMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

async function defaultOpenExternal(url: string, print: (message: string) => void): Promise<void> {
  if (process.versions.electron) {
    try {
      const electron = await import("electron");
      await electron.shell.openExternal(url);
      return;
    } catch {
      // A headless or partially initialized Electron host falls through to
      // the same explicit URL output used by the CLI.
    }
  }
  print(url);
}

function defaultBorrowableAccounts(): BorrowableAccount[] {
  return [...providerInstanceAccounts(), ...cliLoginBorrowableAccounts()];
}

/**
 * The Claude and Codex accounts, or nothing when the registry cannot be read:
 * the lend pass then keeps those providers' lent files as they are rather than
 * sweeping them as gone (`syncBorrowedLogins` only sweeps providers it was given).
 */
function providerInstanceAccounts(): BorrowableAccount[] {
  try {
    return getMachineProviderInstanceStore()
      .list()
      .filter((instance): instance is typeof instance & { provider: HarnessPresetAccountProvider } =>
        isHarnessPresetAccountProvider(instance.provider) && Boolean(instance.configHome?.trim()))
      .map((instance) => ({
        id: instance.id,
        provider: instance.provider,
        configHome: instance.configHome,
        isDefault: instance.isDefault,
      }));
  } catch (error) {
    captureError(error, { tags: { feature: "proxy", stage: "borrow_list_accounts" } });
    return [];
  }
}

async function fetchProxyModels(port: number, apiKey: string): Promise<Array<{ id?: unknown; owned_by?: unknown }>> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return [];
  const body = await response.json() as { data?: unknown };
  return Array.isArray(body.data) ? body.data as Array<{ id?: unknown; owned_by?: unknown }> : [];
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createProxyService(options: ProxyServiceOptions = {}): ProxyService {
  const supervisor = options.supervisor ?? createCliProxyApiSupervisor({ adeHome: options.adeHome });
  const managementClientFactory = options.managementClientFactory ?? ((status: CliProxyApiSupervisorStatus) => {
    if (status.port === null || status.managementKey === null) {
      throw new Error("The subscription proxy is missing its management connection.");
    }
    return createCliProxyApiManagementClient({
      port: status.port,
      managementKey: status.managementKey,
    });
  });
  const print = options.print ?? ((message: string) => console.log(message));
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const authTimeoutMs = options.authTimeoutMs ?? PROXY_AUTH_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? PROXY_AUTH_POLL_INTERVAL_MS;
  const captureProxy = (
    action: "sign_in" | "start" | "stop",
    outcome: "success" | "completed",
    provider?: SubscriptionProxyProvider,
  ): void => {
    captureFeatureUsedAnalytics({
      analytics: options.getAnalytics?.(),
      surface: "api",
      feature: "proxy",
      action,
      outcome,
      ...(provider ? { provider } : {}),
    });
  };
  let managementClient: ProxyManagementClient | null = null;
  let managementConnection: string | null = null;
  const listBorrowableAccounts = options.listBorrowableAccounts ?? defaultBorrowableAccounts;
  const syncLogins = options.syncLogins ?? syncBorrowedLogins;
  const keeperIntervalMs = options.keeperIntervalMs ?? PROXY_BORROW_KEEPER_INTERVAL_MS;
  let borrowing: Promise<BorrowedLoginOutcome[]> | null = null;
  let keeper: ReturnType<typeof setTimeout> | null = null;
  const keeperIdentity = Symbol("proxy-borrow-keeper");
  let keeperAuthDir: string | null = null;
  let keeperRetryMs = PROXY_BORROW_KEEPER_RETRY_MS;
  let disposed = false;

  // The proxy's auth folder sits beside its config (`pathsFor`).
  const authDirFor = (status: CliProxyApiSupervisorStatus): string => path.join(path.dirname(status.configPath), "auth");

  /** Re-read the models the proxy serves, for the source lists (best effort). */
  const refreshModelCache = async (status: CliProxyApiSupervisorStatus): Promise<void> => {
    const fetchModels = options.fetchModels === undefined ? fetchProxyModels : options.fetchModels;
    if (status.port === null || status.apiKey === null || !fetchModels) return;
    const listed = await fetchModels(status.port, status.apiKey).catch(() => null);
    if (listed) writeBorrowedModelCache(path.dirname(status.configPath), listed);
  };

  /** One pass at a time; a launch that arrives mid-pass waits for it. */
  const borrowOnce = (status: CliProxyApiSupervisorStatus): Promise<BorrowedLoginOutcome[]> => {
    borrowing ??= syncLogins({ authDir: authDirFor(status), accounts: listBorrowableAccounts(), renew: true })
      .then(async (outcomes) => {
        if (outcomes.some((outcome) => outcome.status !== "unchanged")) await refreshModelCache(status);
        return outcomes;
      })
      .catch((error: unknown) => {
        captureError(error, { tags: { feature: "proxy", stage: "borrow_sync" } });
        return [] as BorrowedLoginOutcome[];
      })
      .finally(() => {
        borrowing = null;
      });
    return borrowing;
  };

  const stopKeeper = (): void => {
    if (keeper) clearTimeout(keeper);
    keeper = null;
  };

  const releaseKeeper = (): void => {
    stopKeeper();
    const authDir = keeperAuthDir;
    keeperAuthDir = null;
    if (!authDir || keeperOwners.get(authDir) !== keeperIdentity) return;
    keeperOwners.delete(authDir);
    // Hand the folder to a service that was waiting for it.
    const waiting = keeperWaiters.get(authDir);
    const next = waiting?.entries().next().value;
    if (waiting && next) {
      waiting.delete(next[0]);
      next[1]();
    }
  };

  // Runs only while the proxy runs and holds a lent login, so a machine that
  // never borrows pays nothing. Each pass reschedules itself: at the soonest
  // lent token's renew window, or the regular interval, whichever is first.
  const scheduleKeeper = (status: CliProxyApiSupervisorStatus): void => {
    stopKeeper();
    if (disposed) return;
    const authDir = authDirFor(status);
    const owner = keeperOwners.get(authDir);
    if (owner && owner !== keeperIdentity) {
      const waiting = keeperWaiters.get(authDir) ?? new Map<symbol, () => void>();
      waiting.set(keeperIdentity, () => scheduleKeeper(status));
      keeperWaiters.set(authDir, waiting);
      return;
    }
    if (!hasBorrowedLogins(authDir)) {
      releaseKeeper();
      return;
    }
    keeperOwners.set(authDir, keeperIdentity);
    keeperWaiters.get(authDir)?.delete(keeperIdentity);
    keeperAuthDir = authDir;
    const at = now();
    // A token still past its renew time after a pass (its renewal failed) is
    // retried on a backoff; every other token keeps its own renew time, so one
    // stuck login never delays another's short window (Claude's is ~50 s).
    const soonestDue = nextBorrowRenewalAt(authDir);
    const overdue = soonestDue !== null && soonestDue <= at;
    const nextDue = overdue ? nextBorrowRenewalAt(authDir, { after: at }) : soonestDue;
    const delay = Math.max(
      PROXY_BORROW_KEEPER_MIN_DELAY_MS,
      Math.min(keeperIntervalMs, overdue ? keeperRetryMs : keeperIntervalMs, nextDue === null ? keeperIntervalMs : nextDue - at),
    );
    keeperRetryMs = overdue ? Math.min(keeperIntervalMs, keeperRetryMs * 2) : PROXY_BORROW_KEEPER_RETRY_MS;
    keeper = setTimeout(() => {
      keeper = null;
      const current = supervisor.getStatus();
      if (!current.running) {
        releaseKeeper();
        return;
      }
      void borrowOnce(current).then(() => scheduleKeeper(current));
    }, delay);
    keeper.unref?.();
  };

  const clientFor = (status: CliProxyApiSupervisorStatus): ProxyManagementClient => {
    if (status.port === null || status.managementKey === null) {
      throw new Error("The subscription proxy is missing its management connection.");
    }
    const connection = `${status.port}:${status.managementKey}`;
    if (!managementClient || managementConnection !== connection) {
      managementClient = managementClientFactory(status);
      managementConnection = connection;
    }
    return managementClient;
  };

  const readLogins = async (status: CliProxyApiSupervisorStatus): Promise<SubscriptionProxyLogin[]> => {
    if (!status.running) return [];
    const files = await clientFor(status).listAuthFiles();
    return files.map(summarizeLogin);
  };

  const publicStatus = async (status: CliProxyApiSupervisorStatus): Promise<SubscriptionProxyStatus> => ({
    installed: status.installed,
    running: status.running,
    port: status.port,
    version: status.version || null,
    logins: await readLogins(status),
  });

  const ensureRunningStatus = async (): Promise<CliProxyApiSupervisorStatus> => {
    const before = supervisor.getStatus();
    const after = await supervisor.ensureRunning();
    if (!before.running && after.running) captureProxy("start", "completed");
    return after;
  };

  const findLogin = async (
    status: CliProxyApiSupervisorStatus,
    loginId: string,
  ): Promise<{ client: ProxyManagementClient; file: CliProxyApiAuthFile }> => {
    const client = clientFor(status);
    const file = (await client.listAuthFiles()).find((candidate) => candidate.id === loginId);
    if (!file) throw new Error(`Proxy login not found: ${loginId}`);
    return { client, file };
  };

  const createUniquePrefix = (files: readonly CliProxyApiAuthFile[]): string => {
    const used = new Set(files.map(authFilePrefix).filter((value): value is string => value !== null));
    let prefix = "";
    do {
      prefix = `sub-${randomBytes(4).toString("hex")}`;
    } while (used.has(prefix));
    return prefix;
  };

  const service: ProxyService = {
    async status() {
      return publicStatus(supervisor.getStatus());
    },

    async ensureRunning() {
      const status = await ensureRunningStatus();
      if (status.running) {
        await borrowOnce(status);
        scheduleKeeper(status);
      }
      return publicStatus(status);
    },

    async borrowLogins() {
      const status = supervisor.getStatus();
      if (!status.running) return [];
      const outcomes = await borrowOnce(status);
      scheduleKeeper(status);
      return outcomes;
    },

    async stop() {
      releaseKeeper();
      managementClient = null;
      managementConnection = null;
      await supervisor.stop();
      captureProxy("stop", "completed");
      return { ok: true };
    },

    async signIn(args) {
      const provider = requireProvider(args?.provider);
      const status = await ensureRunningStatus();
      const client = clientFor(status);
      const before = await client.listAuthFiles();
      const auth: CliProxyApiAuthUrlResponse = await client.getAuthUrl(provider as CliProxyApiProvider);
      const authStatus = auth.status?.toLowerCase() ?? "";
      if (isErrorStatus(authStatus)) {
        return { status: "error", error: errorMessage(auth.error, "Proxy sign-in could not start.") };
      }
      const url = optionalString(auth.url);
      const state = optionalString(auth.state);
      if (!url || !state) {
        return { status: "error", error: "Proxy sign-in did not return an authorization URL." };
      }
      if (options.openExternal) await options.openExternal(url);
      else await defaultOpenExternal(url, print);

      const deadline = now() + Math.max(0, authTimeoutMs);
      let lastStatus: CliProxyApiAuthStatusResponse | null = null;
      for (;;) {
        lastStatus = await client.getAuthStatus(state);
        const polledStatus = lastStatus.status?.toLowerCase() ?? "";
        if (isSuccessStatus(polledStatus)) break;
        if (isErrorStatus(polledStatus)) {
          return { status: "error", error: errorMessage(lastStatus.error, "Proxy sign-in failed.") };
        }
        const remaining = deadline - now();
        if (remaining <= 0) {
          return { status: "timeout", error: "Proxy sign-in timed out after five minutes." };
        }
        await sleep(Math.min(pollIntervalMs, remaining));
      }

      const after = await client.listAuthFiles();
      const beforeIds = new Set(before.map((file) => file.id));
      const login = after.find((file) => file.provider === provider && !beforeIds.has(file.id))
        ?? [...after].reverse().find((file) => file.provider === provider);
      if (!login) {
        return { status: "error", error: "Proxy sign-in completed without creating a login." };
      }
      const prefix = createUniquePrefix(after);
      await client.patchAuthFileFields({ name: login.id, prefix });
      captureProxy("sign_in", "success", provider);
      return {
        status: "ok",
        login: summarizeLogin({ ...login, prefix }),
      };
    },

    async signOut(args) {
      const loginId = requireNonEmptyString(args?.loginId, "loginId");
      requireOwnLogin(loginId);
      const status = await ensureRunningStatus();
      const { client } = await findLogin(status, loginId);
      await client.deleteAuthFile(loginId);
      return { ok: true };
    },

    async setDisabled(args) {
      const loginId = requireNonEmptyString(args?.loginId, "loginId");
      const disabled = requireBoolean(args?.disabled, "disabled");
      requireOwnLogin(loginId);
      const status = await ensureRunningStatus();
      const { client, file } = await findLogin(status, loginId);
      await client.setAuthFileStatus({ name: loginId, disabled });
      return { ok: true, login: summarizeLogin({ ...file, disabled }) };
    },

    async dispose() {
      disposed = true;
      for (const waiting of keeperWaiters.values()) waiting.delete(keeperIdentity);
      releaseKeeper();
      managementClient = null;
      managementConnection = null;
      await supervisor.stop();
    },
  };

  return service;
}

/**
 * A lent login belongs to its provider's own CLI, and every lend pass writes it
 * back as it is there (enabled, current token). Removing or disabling it in the
 * proxy would last only until the next pass, so it is refused with where to go.
 */
function requireOwnLogin(loginId: string): void {
  if (!isBorrowedLoginFileName(loginId)) return;
  throw new Error(
    "This sign-in is lent to the proxy from your own provider login and comes back on the next pass. Sign out of that provider (Settings › Providers) to stop it.",
  );
}

export function createProxyActionDomainService(service: ProxyService): ProxyActionDomainService {
  return {
    status: () => service.status(),
    ensureRunning: () => service.ensureRunning(),
    stop: () => service.stop(),
    signIn: (args) => service.signIn({ provider: requireProvider(isRecord(args) ? args.provider : undefined) }),
    signOut: (args) => service.signOut({ loginId: requireNonEmptyString(isRecord(args) ? args.loginId : undefined, "loginId") }),
    setDisabled: (args) => service.setDisabled({
      loginId: requireNonEmptyString(isRecord(args) ? args.loginId : undefined, "loginId"),
      disabled: requireBoolean(isRecord(args) ? args.disabled : undefined, "disabled"),
    }),
  };
}
