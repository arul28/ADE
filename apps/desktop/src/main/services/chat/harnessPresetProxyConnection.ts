import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { harnessAccountProviderLabel, harnessBodyLabel, isHarnessPresetAccountProvider } from "../../../shared/harnessPresets";

import type {
  ProxySubscriptionProvider,
} from "../../../../../ade-cli/src/services/proxy/proxyEnv";
import {
  PROXY_HEALTH_MAX_AGE_MS,
  ownedAuthDir,
  probeProxyHealthSync,
} from "../../../../../ade-cli/src/services/proxy/cliProxyApiSupervisor";
import {
  BORROW_MIN_REMAINING_MS,
  borrowedLoginFileName,
  isBorrowedLoginFileName,
} from "../../../../../ade-cli/src/services/proxy/borrowedLogins";
import {
  readCliProxyApiState,
  writeCliProxyApiState,
} from "../../../../../ade-cli/src/services/proxy/cliProxyApiConfig";

export type ProxySubscriptionConnectionParts = {
  port: number;
  apiKey: string;
  prefix: string;
};

/** Why a lent login could not be used, and what to do; one sentence for a launch and a route test. */
export function borrowFailureMessage(provider: string): string {
  // "Claude" and "Codex" for an account; the CLI's own name for the others.
  const label = isHarnessPresetAccountProvider(provider) ? harnessAccountProviderLabel(provider) : harnessBodyLabel(provider);
  return `ADE could not borrow your ${label} sign-in. Sign in to ${label} under Settings › Providers, then try again.`;
}

/**
 * `login-not-lent`: no current login of this provider (or of the named
 * account) is lent to the proxy yet. The launch's async prepare step lends it
 * (`ProxyService.ensureRunning`) and resolves again.
 */
export type ProxySubscriptionConnectionUnavailable = {
  reason: "proxy-stopped" | "login-not-lent";
};

export type ProxyEndpointParts = {
  port: number;
  apiKey: string;
  authDir: string;
  configPath: string;
};

/**
 * The proxy's live endpoint (port + shared client key), independent of any
 * provider login. Routes that ADE translates through the proxy need only this;
 * subscription routes additionally need a login's prefix (below).
 */
export function defaultReadProxyEndpoint(
  adeHome: string,
  options: { healthCheck?: (port: number) => boolean } = {},
): () => ProxyEndpointParts | ProxySubscriptionConnectionUnavailable | null {
  const isLivePid = (pid: unknown): boolean => {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };

  return () => {
    const proxyDir = path.join(adeHome, "proxy");
    let port: number | null = null;
    let pid: number | null = null;
    let healthyAt: number | null = null;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(proxyDir, "state.json"), "utf8")) as {
        port?: unknown;
        pid?: unknown;
        healthyAt?: unknown;
      };
      port = typeof state.port === "number" && Number.isInteger(state.port) && state.port > 0 && state.port <= 65_535
        ? state.port
        : null;
      pid = state.pid === null ? null : typeof state.pid === "number" ? state.pid : null;
      healthyAt = typeof state.healthyAt === "number" && Number.isFinite(state.healthyAt) ? state.healthyAt : null;
    } catch {
      return { reason: "proxy-stopped" };
    }
    const pidIsLive = isLivePid(pid);
    const age = healthyAt === null ? Number.POSITIVE_INFINITY : Date.now() - healthyAt;
    const recentHealth = age >= 0 && age <= PROXY_HEALTH_MAX_AGE_MS;
    let injectedHealth = false;
    if (!recentHealth && port !== null && pid !== null && pidIsLive) {
      try {
        injectedHealth = (options.healthCheck ?? probeProxyHealthSync)(port);
      } catch {
        injectedHealth = false;
      }
      if (injectedHealth) {
        const persisted = readCliProxyApiState(path.join(proxyDir, "state.json"));
        if (persisted && persisted.pid === pid && persisted.port === port) {
          try {
            writeCliProxyApiState(path.join(proxyDir, "state.json"), {
              ...persisted,
              healthyAt: Date.now(),
            });
          } catch {
            // A successful probe is still useful for this launch even if the
            // health stamp cannot be refreshed on a read-only filesystem.
          }
        }
      }
    }
    if (!port || pid === null || !pidIsLive || (!recentHealth && !injectedHealth)) {
      return { reason: "proxy-stopped" };
    }

    const configPath = path.join(proxyDir, "config.yaml");
    let apiKey: string | null = null;
    let authDir = path.join(proxyDir, "auth");
    try {
      const config = parseYaml(fs.readFileSync(configPath, "utf8")) as {
        "api-keys"?: unknown;
        "auth-dir"?: unknown;
      };
      const keys = config?.["api-keys"];
      apiKey = Array.isArray(keys) && typeof keys[0] === "string" && keys[0].trim().length
        ? keys[0].trim()
        : null;
      authDir = ownedAuthDir(config?.["auth-dir"], proxyDir, authDir);
    } catch {
      return null;
    }
    if (!apiKey) return null;
    return { port, apiKey, authDir, configPath };
  };
}

/**
 * Read the proxy's connection for one provider straight off this machine.
 *
 * With an account id, only that account's lent login answers. Without one (a
 * `subscription` source), a login signed in to the proxy itself wins, then the
 * default account's lent login, then any other lent one.
 *
 * A persisted PID is only a process-existence hint. The supervisor records a
 * recent successful health response as well, which prevents PID reuse or a
 * hung process from receiving provider credentials. Tests can inject a live
 * health check for a state that has not yet received its first timestamp.
 */
export function defaultReadProxyConnection(
  adeHome: string,
  options: { healthCheck?: (port: number) => boolean; now?: () => number } = {},
): (
  provider: ProxySubscriptionProvider,
  instanceId?: string | null,
) => ProxySubscriptionConnectionParts | ProxySubscriptionConnectionUnavailable | null {
  const readEndpoint = defaultReadProxyEndpoint(adeHome, options);
  const now = options.now ?? Date.now;
  type AuthFile = { name: string; body: Record<string, unknown> };
  const readAuthFile = (authDir: string, name: string): AuthFile | null => {
    // The proxy rewrites auth files in place (it adds its own fields), so a read
    // can land mid-write and see a truncated file; read again before giving up.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const body = JSON.parse(fs.readFileSync(path.join(authDir, name), "utf8")) as unknown;
        return body && typeof body === "object" && !Array.isArray(body)
          ? { name, body: body as Record<string, unknown> }
          : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        // One unreadable auth file must not hide the others.
      }
    }
    return null;
  };
  const prefixOf = (file: AuthFile): string => (typeof file.body.prefix === "string" ? file.body.prefix.trim() : "");
  const usable = (file: AuthFile, provider: string): boolean => {
    // A lent login names ADE's provider in `ade_provider` (Grok's proxy type is
    // `xai`); a login signed in to the proxy itself carries its own.
    if ((file.body.ade_provider ?? file.body.provider ?? file.body.type) !== provider) return false;
    if (file.body.disabled === true || !prefixOf(file)) return false;
    if (!isBorrowedLoginFileName(file.name)) return true;
    // A lent token is handed out only while it has time left; the keeper and
    // the launch's prepare step lend a fresh one before it lapses.
    const expires = typeof file.body.expired === "string" ? Date.parse(file.body.expired) : Number.NaN;
    return Number.isNaN(expires) || expires - now() > BORROW_MIN_REMAINING_MS;
  };
  return (provider, instanceId) => {
    const endpoint = readEndpoint();
    if (!endpoint || "reason" in endpoint) return endpoint;
    const { port, apiKey, authDir } = endpoint;
    const connect = (file: AuthFile) => ({ port, apiKey, prefix: prefixOf(file) });

    const account = instanceId?.trim();
    if (account) {
      const file = readAuthFile(authDir, borrowedLoginFileName(provider, account));
      return file && usable(file, provider) ? connect(file) : { reason: "login-not-lent" };
    }

    let names: string[];
    try {
      names = fs.readdirSync(authDir).filter((name) => name.toLowerCase().endsWith(".json"));
    } catch {
      return { reason: "login-not-lent" };
    }
    const files = names
      .map((name) => readAuthFile(authDir, name))
      .filter((file): file is AuthFile => file !== null && usable(file, provider));
    const signedIn = files.find((file) => !isBorrowedLoginFileName(file.name));
    const lent = files
      .filter((file) => isBorrowedLoginFileName(file.name))
      .sort((a, b) => Number(b.body.ade_default === true) - Number(a.body.ade_default === true));
    const chosen = signedIn ?? lent[0];
    return chosen ? connect(chosen) : { reason: "login-not-lent" };
  };
}
