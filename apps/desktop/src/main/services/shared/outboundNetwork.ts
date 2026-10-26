import http from "node:http";
import tls from "node:tls";
import { Worker } from "node:worker_threads";
import type { Logger } from "../logging/logger";

/**
 * Outbound HTTPS from ADE's own Node code (the desktop main process and the
 * `ade` CLI, the brain included) on company networks: a proxy named in the
 * environment, and a company root CA the OS trusts. Node's `fetch` and
 * `https` honour neither by default. Electron's `net.fetch` already follows
 * the OS for both; this covers the global `fetch` and `http`/`https`. The
 * `ws` WebSockets (paired machines, the relay) open their own sockets and
 * are not proxied, as before.
 *
 * Child processes are left alone: they inherit `HTTPS_PROXY` and friends as
 * they always did, and nothing here adds an environment variable they would
 * pick up.
 */

type NetworkLogger = Pick<Logger, "info" | "warn">;

const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

/**
 * Always direct. ADE talks to its own servers, local providers and MCP
 * endpoints over loopback, and Node sends those through the proxy when
 * `NO_PROXY` does not name them. Node matches IPv6 only as `[::1]`.
 */
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * The proxy API is Node 24.14+, the system CA read 24 and 22.19+. ADE's Electron
 * and its bundled runtime ship Node 24; the `ade` CLI on an older Node keeps
 * working without them, as it did before.
 */
function systemCaApiAvailable(): boolean {
  return typeof tls.getCACertificates === "function" && typeof tls.setDefaultCACertificates === "function";
}

/** `NO_PROXY` as the user set it, plus loopback, without duplicates. */
function outboundNoProxy(env: NodeJS.ProcessEnv): string {
  const entries = `${env.NO_PROXY ?? ""},${env.no_proxy ?? ""}`
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.includes("*")) return "*";
  return [...new Set([...entries, ...LOOPBACK_NO_PROXY])].join(",");
}

/**
 * Routes this process's `fetch`, `http` and `https` through the proxy the
 * environment names. A no-op without a proxy variable, and on a Node without
 * `http.setGlobalProxyFromEnv` (before 24.14), which logs a warning instead.
 * Returns whether a proxy is now in effect.
 */
export function configureOutboundProxyFromEnv(env: NodeJS.ProcessEnv, logger?: NetworkLogger): boolean {
  const proxyEnv: NodeJS.ProcessEnv = {};
  for (const key of PROXY_KEYS) {
    const value = env[key]?.trim();
    if (value) proxyEnv[key] = value;
  }
  if (Object.keys(proxyEnv).length === 0) return false;
  if (typeof http.setGlobalProxyFromEnv !== "function") {
    logger?.warn("network.proxy_unsupported", { node: process.versions.node });
    return false;
  }
  try {
    const noProxy = outboundNoProxy(env);
    http.setGlobalProxyFromEnv({ ...proxyEnv, NO_PROXY: noProxy, no_proxy: noProxy });
    logger?.info("network.proxy_configured", {
      https: Boolean(proxyEnv.HTTPS_PROXY ?? proxyEnv.https_proxy),
      http: Boolean(proxyEnv.HTTP_PROXY ?? proxyEnv.http_proxy),
    });
    return true;
  } catch (error) {
    logger?.warn("network.proxy_configure_failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** Reads the OS trust store off the calling thread: it takes ~140 ms on macOS. */
const SYSTEM_CA_WORKER_SOURCE = String.raw`
  const { parentPort } = require("node:worker_threads");
  const tls = require("node:tls");
  try {
    parentPort.postMessage({ ok: true, certificates: tls.getCACertificates("system") });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String(error && error.message || error) });
  }
`;

let systemTrust: Promise<number> | null = null;

/**
 * Adds the certificates the OS trusts (a company root CA, a TLS-inspecting
 * proxy's CA) to what this process's TLS accepts, keeping the bundled set.
 * Resolves with how many were added; later calls share the first one's
 * result. A Node without the API, or a store that cannot be read, leaves TLS
 * as it was.
 */
export function trustSystemCertificates(logger?: NetworkLogger): Promise<number> {
  systemTrust ??= addSystemCertificates(logger);
  return systemTrust;
}

async function addSystemCertificates(logger?: NetworkLogger): Promise<number> {
  if (!systemCaApiAvailable()) return 0;
  try {
    const system = await readSystemCertificatesOffThread();
    const current = tls.getCACertificates("default");
    const known = new Set(current);
    const added = system.filter((certificate) => !known.has(certificate));
    if (added.length > 0) tls.setDefaultCACertificates([...current, ...added]);
    logger?.info("network.system_ca_trusted", { added: added.length });
    return added.length;
  } catch (error) {
    logger?.warn("network.system_ca_failed", { error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}

function readSystemCertificatesOffThread(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // Referenced on purpose: a short CLI command awaits this read, and an
    // unref'd worker would let the process exit before the command runs. The
    // worker ends itself once it has posted.
    const worker = new Worker(SYSTEM_CA_WORKER_SOURCE, { eval: true });
    worker.once("message", (message: { ok: boolean; certificates?: string[]; error?: string }) => {
      void worker.terminate();
      if (message.ok) resolve(message.certificates ?? []);
      else reject(new Error(message.error ?? "system CA read failed"));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`system CA reader exited with code ${code}`));
    });
  });
}
