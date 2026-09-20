import { randomBytes } from "node:crypto";

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
  captureFeatureUsedAnalytics,
  type FeatureAnalytics,
} from "../../../../desktop/src/main/services/analytics/featureProductAnalytics";

export const PROXY_AUTH_TIMEOUT_MS = 5 * 60_000;
export const PROXY_AUTH_POLL_INTERVAL_MS = 1_000;

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
};

export type ProxyService = {
  status(): Promise<SubscriptionProxyStatus>;
  ensureRunning(): Promise<SubscriptionProxyStatus>;
  stop(): Promise<SubscriptionProxyMutationResult>;
  signIn(args: SubscriptionProxySignInArgs): Promise<SubscriptionProxySignInResult>;
  signOut(args: SubscriptionProxySignOutArgs): Promise<SubscriptionProxyMutationResult>;
  setDisabled(args: SubscriptionProxySetDisabledArgs): Promise<SubscriptionProxyMutationResult>;
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
  return {
    loginId: file.id,
    provider: file.provider,
    email: optionalString(file.email),
    plan: authFilePlan(file),
    prefix: authFilePrefix(file),
    disabled: file.disabled === true,
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
      return publicStatus(await ensureRunningStatus());
    },

    async stop() {
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
      const status = await ensureRunningStatus();
      const { client } = await findLogin(status, loginId);
      await client.deleteAuthFile(loginId);
      return { ok: true };
    },

    async setDisabled(args) {
      const loginId = requireNonEmptyString(args?.loginId, "loginId");
      const disabled = requireBoolean(args?.disabled, "disabled");
      const status = await ensureRunningStatus();
      const { client, file } = await findLogin(status, loginId);
      await client.setAuthFileStatus({ name: loginId, disabled });
      return { ok: true, login: summarizeLogin({ ...file, disabled }) };
    },

    async dispose() {
      managementClient = null;
      managementConnection = null;
      await supervisor.stop();
    },
  };

  return service;
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
