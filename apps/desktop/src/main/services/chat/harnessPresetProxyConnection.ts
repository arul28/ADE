import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import type {
  ProxySubscriptionProvider,
} from "../../../../../ade-cli/src/services/proxy/proxyEnv";
import {
  PROXY_HEALTH_MAX_AGE_MS,
  ownedAuthDir,
  probeProxyHealthSync,
} from "../../../../../ade-cli/src/services/proxy/cliProxyApiSupervisor";
import {
  readCliProxyApiState,
  writeCliProxyApiState,
} from "../../../../../ade-cli/src/services/proxy/cliProxyApiConfig";

export type ProxySubscriptionConnectionParts = {
  port: number;
  apiKey: string;
  prefix: string;
};

export type ProxySubscriptionConnectionUnavailable = {
  reason: "proxy-stopped";
};

/**
 * Read the proxy's connection for one provider straight off this machine.
 *
 * A persisted PID is only a process-existence hint. The supervisor records a
 * recent successful health response as well, which prevents PID reuse or a
 * hung process from receiving provider credentials. Tests can inject a live
 * health check for a state that has not yet received its first timestamp.
 */
export function defaultReadProxyConnection(
  adeHome: string,
  options: { healthCheck?: (port: number) => boolean } = {},
): (provider: ProxySubscriptionProvider) => ProxySubscriptionConnectionParts | ProxySubscriptionConnectionUnavailable | null {
  const isLivePid = (pid: unknown): boolean => {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };

  return (provider) => {
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

    let apiKey: string | null = null;
    let authDir = path.join(proxyDir, "auth");
    try {
      const config = parseYaml(fs.readFileSync(path.join(proxyDir, "config.yaml"), "utf8")) as {
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

    let entries: string[];
    try {
      entries = fs.readdirSync(authDir).filter((name) => name.toLowerCase().endsWith(".json"));
    } catch {
      return null;
    }
    for (const entry of entries) {
      try {
        const file = JSON.parse(fs.readFileSync(path.join(authDir, entry), "utf8")) as {
          provider?: unknown;
          prefix?: unknown;
          disabled?: unknown;
        };
        if (file.provider !== provider) continue;
        if (file.disabled === true) continue;
        const prefix = typeof file.prefix === "string" ? file.prefix.trim() : "";
        if (!prefix) continue;
        return { port, apiKey, prefix };
      } catch {
        // One unreadable auth file must not hide the others.
      }
    }
    return null;
  };
}
