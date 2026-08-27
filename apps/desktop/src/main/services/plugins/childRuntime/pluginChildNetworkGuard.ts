/**
 * The declared-network guard, installed inside the plugin child.
 *
 * ## Where this runs, and when
 *
 * In the child process, from `handleHello`, BEFORE the plugin's entry module is
 * required. Before is the whole point: a dependency that opens a socket at
 * import time is exactly the case a guard installed afterwards would miss.
 *
 * ## What it covers
 *
 * Four doors, chosen because between them they carry every ordinary outbound
 * request a Node plugin makes:
 *
 * 1. `globalThis.fetch` — the default for anything modern, and the door Node's
 *    own bundled undici sits behind.
 * 2. `globalThis.WebSocket` — the other global that dials on construction.
 * 3. `node:http` / `node:https` `request` and `get` — what a plugin streaming a
 *    large file reaches for, and what `ade-voice` uses to download its model.
 * 4. `node:net` / `node:tls` `connect` and `createConnection` — the backstop
 *    under all of the above, so a plugin that bundles its OWN http client does
 *    not walk around the other three. Unix-domain sockets are exempt: they name
 *    a path on this machine, not a host, and refusing them would break local
 *    IPC that has nothing to do with the network.
 *
 * Core modules are singletons per process, and the plugin's `createRequire` is
 * anchored inside the plugin directory but still resolves `node:https` to the
 * same object this file patched. A plugin using `import { request } from
 * "node:https"` snapshots the binding and slips past doors 3 — which is why
 * door 4 exists under it.
 *
 * ## What it is not
 *
 * Not a sandbox. `pluginChildBootstrap.ts` says the child "assumes the plugin
 * is buggy, not malicious-proof", and that is still true: `child_process` is
 * right there, and a plugin that wants to shell out to `curl` can. The guard
 * makes the declaration real for ordinary code, makes an undeclared call fail
 * loudly with the fix in the message, and writes every refusal to the plugin's
 * own log where `ade plugin logs` and `ade plugin doctor` show it.
 *
 * ## Windows
 *
 * Nothing here is platform-specific: it patches JavaScript bindings on Node
 * core modules and reads hostnames out of arguments. There is no macOS-only or
 * POSIX-only API in the file.
 */

import {
  normalizePluginNetworkHost,
  pluginNetworkHostAllowed,
  pluginNetworkRefusalMessage,
  PLUGIN_NETWORK_REFUSAL_LOG_CODE,
} from "../../../../shared/plugins/network";
import { PluginSdkError } from "../../../../shared/plugins/sdk";

/** What the guard patches. Injected whole so a test never touches the real ones. */
export type PluginNetworkGuardTargets = {
  /** Usually `globalThis`. */
  globals: Record<string, unknown>;
  /** Keyed by the name that appears in a refusal log: `http`, `https`, … */
  modules: Record<string, Record<string, unknown>>;
};

export type PluginNetworkGuardOptions = {
  pluginId: string;
  /** The manifest's declared hosts. Empty means no outbound network at all. */
  hosts: readonly string[];
  /** Write one audited line. The child passes its `emitLog`. */
  onRefused: (message: string, fields: Record<string, unknown>) => void;
  /** Test seam. Production patches the real globals and core modules. */
  targets?: PluginNetworkGuardTargets;
};

/**
 * A host string that was present but is not a hostname — a bracketed IPv6
 * literal, say. Named rather than blank so the log line is readable.
 */
const UNREADABLE_HOST = "an address it did not name";

/** Node's own default when `http.request({ path })` names no host. */
const IMPLIED_HOST = "localhost";

function hostFromUrlLike(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof URL)) return null;
  try {
    return new URL(String(value)).hostname;
  } catch {
    return null;
  }
}

/** `example.com:443` and `[::1]:443` reduced to the host part. */
function hostFromHostHeader(value: string): string {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * The host one `http.request`/`https.request` call is for.
 *
 * Returns `null` when a URL was given and could not be read, which the caller
 * refuses — a request whose destination nobody can name is not one to allow.
 */
function hostFromHttpArgs(args: readonly unknown[]): string | null {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) return hostFromUrlLike(first);
  for (const arg of args.slice(0, 2)) {
    if (!arg || typeof arg !== "object") continue;
    const options = arg as Record<string, unknown>;
    const hostname = options.hostname ?? options.host;
    if (typeof hostname === "string" && hostname.trim().length > 0) {
      return hostFromHostHeader(hostname.trim());
    }
  }
  // No host anywhere: Node dials localhost. Named explicitly so the refusal
  // says which host was refused instead of leaving the reader to guess.
  return IMPLIED_HOST;
}

/**
 * The host one `net.connect`/`tls.connect` call is for, or `null` when the call
 * is not a TCP connection this guard has an opinion about.
 *
 * `net.connect(path)` and `net.connect({ path })` are unix-domain sockets: a
 * file on this machine, not a host. `net.connect(port, host)` and
 * `net.connect({ host, port })` are the ones that leave.
 */
function hostFromSocketArgs(args: readonly unknown[]): string | null {
  const first = args[0];
  // `connect(path)` / `connect("/tmp/x.sock", cb)` — a path, never a host.
  if (typeof first === "string") return null;
  if (typeof first === "number") {
    const second = args[1];
    return typeof second === "string" && second.trim().length > 0
      ? hostFromHostHeader(second.trim())
      : IMPLIED_HOST;
  }
  if (!first || typeof first !== "object") return null;
  const options = first as Record<string, unknown>;
  if (typeof options.path === "string" && options.path.length > 0) return null;
  const hostname = options.hostname ?? options.host;
  if (typeof hostname === "string" && hostname.trim().length > 0) {
    return hostFromHostHeader(hostname.trim());
  }
  // An options object with a port and no host is a localhost dial.
  if (options.port !== undefined) return IMPLIED_HOST;
  return null;
}

function defaultTargets(): PluginNetworkGuardTargets {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return {
    globals: globalThis as unknown as Record<string, unknown>,
    modules: {
      http: require("node:http") as Record<string, unknown>,
      https: require("node:https") as Record<string, unknown>,
      net: require("node:net") as Record<string, unknown>,
      tls: require("node:tls") as Record<string, unknown>,
    },
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

/**
 * Patch the child's outbound doors. Returns a `check` a test can call directly.
 *
 * Idempotent per process in practice because `handleHello` runs once, and
 * harmless if it did not: a second install wraps the first, and the first
 * already answers the same way.
 */
export function installPluginNetworkGuard(options: PluginNetworkGuardOptions): {
  /** Throws the refusal when `host` is not declared. Exported for the tests. */
  check(host: string | null, door: string): void;
} {
  const { pluginId, hosts, onRefused } = options;
  const declared = [...hosts];
  const targets = options.targets ?? defaultTargets();

  const refuse = (host: string | null, door: string): PluginSdkError => {
    const named = normalizePluginNetworkHost(host) ?? UNREADABLE_HOST;
    const message = pluginNetworkRefusalMessage({ pluginId, host: named, declared });
    // Audited on the plugin's own log ring, which is what `ade plugin logs`
    // prints and what `plugin.get` carries to the doctor. The code is a field
    // rather than a prefix on the message so a reader can count refusals
    // without matching prose.
    onRefused(message, { code: PLUGIN_NETWORK_REFUSAL_LOG_CODE, host: named, via: door });
    return new PluginSdkError("network_host_not_declared", message);
  };

  const check = (host: string | null, door: string): void => {
    if (host !== null && pluginNetworkHostAllowed(host, declared)) return;
    throw refuse(host, door);
  };

  /* ── fetch ─────────────────────────────────────────────────────────────── */

  const originalFetch = targets.globals.fetch;
  if (typeof originalFetch === "function") {
    const fetchFn = originalFetch as (...args: unknown[]) => Promise<unknown>;
    targets.globals.fetch = function guardedFetch(this: unknown, ...args: unknown[]) {
      // Rejected rather than thrown: `fetch` returns a promise, and a caller
      // with a `.catch` should not need a `try` as well.
      try {
        const input = args[0];
        const host = input && typeof input === "object" && "url" in input
          ? hostFromUrlLike((input as { url: unknown }).url)
          : hostFromUrlLike(input);
        check(host, "fetch");
      } catch (error) {
        return Promise.reject(error);
      }
      return fetchFn.apply(this, args);
    };
  }

  /* ── WebSocket ─────────────────────────────────────────────────────────── */

  const originalWebSocket = targets.globals.WebSocket;
  if (typeof originalWebSocket === "function") {
    const WebSocketCtor = originalWebSocket as new (...args: unknown[]) => unknown;
    const guardedWebSocket = function GuardedWebSocket(...args: unknown[]): unknown {
      check(hostFromUrlLike(args[0]), "WebSocket");
      return new WebSocketCtor(...args);
    } as unknown as Record<string, unknown>;
    // Keeps `WebSocket.OPEN` and friends working; a plugin reading a readyState
    // constant off the constructor must not get `undefined` from the guard.
    Object.setPrototypeOf(guardedWebSocket, WebSocketCtor);
    guardedWebSocket.prototype = (WebSocketCtor as unknown as { prototype: unknown }).prototype;
    targets.globals.WebSocket = guardedWebSocket;
  }

  /* ── http / https / net / tls ──────────────────────────────────────────── */

  const patch = (
    moduleName: string,
    methods: readonly string[],
    hostOf: (args: readonly unknown[]) => string | null,
    /** `net.connect(path)` yields null and is allowed through untouched. */
    nullMeansExempt: boolean,
  ): void => {
    const mod = targets.modules[moduleName];
    if (!mod) return;
    for (const method of methods) {
      const original = mod[method];
      if (typeof original !== "function") continue;
      const originalFn = original as (...args: unknown[]) => unknown;
      mod[method] = function guarded(this: unknown, ...args: unknown[]) {
        const host = hostOf(args);
        // Thrown, not returned as an error event: these are synchronous
        // factories, and a refusal is a programming fact — the manifest does
        // not declare this host — rather than a transport failure to retry.
        if (!(nullMeansExempt && host === null)) check(host, `${moduleName}.${method}`);
        return originalFn.apply(this, args);
      };
    }
  };

  patch("http", ["request", "get"], hostFromHttpArgs, false);
  patch("https", ["request", "get"], hostFromHttpArgs, false);
  patch("net", ["connect", "createConnection"], hostFromSocketArgs, true);
  patch("tls", ["connect"], hostFromSocketArgs, true);

  return { check };
}
