// ---------------------------------------------------------------------------
// OpenCode subscription/OAuth auth service
//
// Drives the OpenCode server's auth API to (a) enumerate the auth methods each
// provider supports, (b) run a subscription OAuth flow (open the browser, then
// poll provider.list() until the provider reports connected), and (c) seed a
// plain API key (PUT /auth) while mirroring it into ADE's key store so the key
// is re-injected on future server launches.
//
// All server access reuses the shared managed OpenCode server lease (the same
// server the inventory probe uses) — we never spawn our own process.
// ---------------------------------------------------------------------------

import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Logger } from "../logging/logger";
import type { EffectiveProjectConfig, ProjectConfigFile } from "../../../shared/types";
import type {
  OpenCodeOAuthStartResult,
  OpenCodeOAuthStatusEvent,
  OpenCodeProviderAuthMethods,
} from "../../../shared/types/config";
import { buildOpenCodeMergedConfig, buildSharedOpenCodeServerKey } from "./openCodeRuntime";
import { acquireSharedOpenCodeServer } from "./openCodeServerManager";
import { probeOpenCodeProviderInventory } from "./openCodeInventory";
import { storeApiKey as storeStoredApiKey } from "../ai/apiKeyStore";

/** How long an OAuth flow's shared lease stays alive between poll ticks. */
const OAUTH_LEASE_IDLE_TTL_MS = 10_000;
/** OAuth completion poll cadence. */
const POLL_INTERVAL_MS = 2_000;
/** Give up on an OAuth flow after this long without the provider connecting. */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export type OpenCodeAuthDeps = {
  projectRoot: string;
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  logger: Logger;
};

type SharedLease = { url: string; release: () => void };

type HttpJsonResult = { ok: boolean; status: number; body: unknown };

type OpenCodeAuthHooks = {
  acquireLease(deps: OpenCodeAuthDeps): Promise<SharedLease>;
  httpJson(url: string, init?: RequestInit): Promise<HttpJsonResult>;
  listConnectedProviders(baseUrl: string, directory: string): Promise<string[]>;
  openExternal(url: string): Promise<void>;
  probeInventory(deps: OpenCodeAuthDeps): Promise<void>;
  storeApiKey(providerId: string, key: string): void;
  now(): number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultHooks: OpenCodeAuthHooks = {
  async acquireLease(deps) {
    const config = buildOpenCodeMergedConfig({ projectConfig: deps.projectConfig });
    const lease = await acquireSharedOpenCodeServer({
      config,
      key: buildSharedOpenCodeServerKey(config),
      ownerKind: "inventory",
      ownerId: deps.projectRoot,
      idleTtlMs: OAUTH_LEASE_IDLE_TTL_MS,
      logger: deps.logger,
    });
    return { url: lease.url, release: () => lease.release("handle_close") };
  },
  async httpJson(url, init) {
    const res = await fetch(url, init);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  },
  async listConnectedProviders(baseUrl, directory) {
    const client = createOpencodeClient({ baseUrl, directory });
    const listed = await client.provider.list({ query: { directory }, throwOnError: true });
    const data = listed.data as { connected?: string[] } | undefined;
    return Array.isArray(data?.connected) ? data.connected : [];
  },
  async openExternal(url) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require("electron") as { shell: { openExternal(u: string): Promise<void> } };
    await shell.openExternal(url);
  },
  async probeInventory(deps) {
    await probeOpenCodeProviderInventory({
      projectRoot: deps.projectRoot,
      projectConfig: deps.projectConfig,
      logger: deps.logger,
      force: true,
    });
  },
  storeApiKey(providerId, key) {
    storeStoredApiKey(providerId, key);
  },
  now() {
    return Date.now();
  },
};

let hooks: OpenCodeAuthHooks = { ...defaultHooks };
type StatusListener = (event: OpenCodeOAuthStatusEvent) => void;
const statusListeners = new Set<StatusListener>();

type ActiveFlow = {
  release: () => void;
  timer: ReturnType<typeof setInterval>;
};
const activeFlows = new Map<string, ActiveFlow>();

/**
 * Subscribe a sink to OAuth status transitions. Multiple sinks may coexist so
 * the same transition can fan out to renderer windows (desktop) and the runtime
 * event buffer (remote/web clients). Returns an unsubscribe function.
 */
export function addOpenCodeOAuthStatusListener(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function emit(event: OpenCodeOAuthStatusEvent): void {
  for (const listener of statusListeners) {
    try {
      listener(event);
    } catch {
      // A broken sink must not break the flow or starve other listeners.
    }
  }
}

/** Tear down an active flow (clear the poll timer, release the lease) and emit `state`. */
function finishFlow(providerId: string, state: OpenCodeOAuthStatusEvent["state"], error?: string): void {
  const flow = activeFlows.get(providerId);
  if (!flow) return;
  clearInterval(flow.timer);
  flow.release();
  activeFlows.delete(providerId);
  emit({ providerId, state, ...(error ? { error } : {}) });
}

/** List the auth methods each provider supports (GET /provider/auth). */
export async function listAuthMethods(deps: OpenCodeAuthDeps): Promise<{ methods: OpenCodeProviderAuthMethods }> {
  const lease = await hooks.acquireLease(deps);
  try {
    const res = await hooks.httpJson(`${lease.url}/provider/auth`, { method: "GET" });
    if (!res.ok) {
      throw new Error(`OpenCode GET /provider/auth failed (${res.status}).`);
    }
    const methods = (res.body ?? {}) as OpenCodeProviderAuthMethods;
    return { methods };
  } finally {
    lease.release();
  }
}

/**
 * Start an OAuth flow: authorize, open the returned URL, then poll until the
 * provider reports connected (or timeout). Only one flow per providerId is
 * active at a time — starting a new one cancels the prior flow.
 */
export async function startOAuth(
  deps: OpenCodeAuthDeps,
  args: { providerId: string; methodIndex: number; inputs?: Record<string, string> },
): Promise<OpenCodeOAuthStartResult> {
  const { providerId, methodIndex, inputs } = args;
  // Supersede any in-flight flow for this provider.
  cancelOAuth({ providerId });

  const lease = await hooks.acquireLease(deps);
  let handedOff = false;
  try {
    const res = await hooks.httpJson(
      `${lease.url}/provider/${encodeURIComponent(providerId)}/oauth/authorize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: methodIndex, ...(inputs ? { inputs } : {}) }),
      },
    );
    if (!res.ok) {
      throw new Error(`OpenCode oauth/authorize failed (${res.status}).`);
    }
    const body = (res.body ?? {}) as { url?: unknown; method?: unknown; instructions?: unknown };
    const url = typeof body.url === "string" ? body.url : "";
    const method: OpenCodeOAuthStartResult["method"] = body.method === "code" ? "code" : "auto";
    const instructions = typeof body.instructions === "string" ? body.instructions : "";

    if (url) {
      void hooks.openExternal(url).catch((err) => {
        deps.logger.warn("opencode.oauth_open_external_failed", { providerId, error: errorMessage(err) });
      });
    }

    emit({ providerId, state: "pending" });
    const startedAt = hooks.now();
    const timer = setInterval(() => {
      void (async () => {
        try {
          if (hooks.now() - startedAt >= OAUTH_TIMEOUT_MS) {
            finishFlow(providerId, "timeout");
            return;
          }
          const connected = await hooks.listConnectedProviders(lease.url, deps.projectRoot);
          if (!activeFlows.has(providerId)) return; // cancelled while awaiting
          if (connected.includes(providerId)) {
            finishFlow(providerId, "connected");
            void hooks.probeInventory(deps).catch((err) => {
              deps.logger.warn("opencode.oauth_post_connect_probe_failed", {
                providerId,
                error: errorMessage(err),
              });
            });
          }
        } catch (err) {
          deps.logger.warn("opencode.oauth_poll_failed", { providerId, error: errorMessage(err) });
        }
      })();
    }, POLL_INTERVAL_MS);
    if (timer.unref) timer.unref();

    activeFlows.set(providerId, { release: () => lease.release(), timer });
    handedOff = true;
    return { url, method, instructions };
  } catch (err) {
    emit({ providerId, state: "failed", error: errorMessage(err) });
    throw err;
  } finally {
    // If we never handed the lease to an active flow, release it now.
    if (!handedOff) lease.release();
  }
}

/** Cancel an in-flight OAuth flow (if any), stopping the poller and emitting `cancelled`. */
export function cancelOAuth(args: { providerId: string }): void {
  finishFlow(args.providerId, "cancelled");
}

/**
 * Seed a plain API key for a provider: PUT /auth/{id} on the OpenCode server and
 * mirror the key into ADE's key store so it is re-injected on future launches.
 */
export async function setProviderKey(
  deps: OpenCodeAuthDeps,
  args: { providerId: string; key: string },
): Promise<{ ok: boolean; error?: string }> {
  const { providerId, key } = args;
  const lease = await hooks.acquireLease(deps);
  try {
    const res = await hooks.httpJson(`${lease.url}/auth/${encodeURIComponent(providerId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "api", key }),
    });
    if (!res.ok) {
      return { ok: false, error: `OpenCode PUT /auth failed (${res.status}).` };
    }
    try {
      hooks.storeApiKey(providerId, key);
    } catch (err) {
      deps.logger.warn("opencode.oauth_key_mirror_failed", { providerId, error: errorMessage(err) });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    lease.release();
  }
}

// --- Test hooks ------------------------------------------------------------

export function __setOpenCodeAuthHooksForTests(partial: Partial<OpenCodeAuthHooks>): void {
  hooks = { ...hooks, ...partial };
}

export function __resetOpenCodeAuthServiceForTests(): void {
  for (const providerId of [...activeFlows.keys()]) {
    const flow = activeFlows.get(providerId);
    if (flow) {
      clearInterval(flow.timer);
      flow.release();
    }
    activeFlows.delete(providerId);
  }
  hooks = { ...defaultHooks };
  statusListeners.clear();
}

export function __getActiveOAuthProviderIdsForTests(): string[] {
  return [...activeFlows.keys()];
}
