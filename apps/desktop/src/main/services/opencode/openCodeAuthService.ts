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
import { isAllowedOpenCodeOAuthUrl } from "../../../shared/opencodeOAuth";
import { buildOpenCodeMergedConfig, buildSharedOpenCodeServerKey } from "./openCodeRuntime";
import { acquireSharedOpenCodeServer } from "./openCodeServerManager";
import { probeOpenCodeProviderInventory } from "./openCodeInventory";
import {
  deleteApiKey as deleteStoredApiKey,
  storeApiKey as storeStoredApiKey,
} from "../ai/apiKeyStore";

/** How long an OAuth flow's shared lease stays alive between poll ticks. */
const OAUTH_LEASE_IDLE_TTL_MS = 10_000;
/** OAuth completion poll cadence. */
const POLL_INTERVAL_MS = 2_000;
/** Bound each provider-list request so a stalled server cannot wedge polling. */
const POLL_REQUEST_TIMEOUT_MS = 10_000;
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
  listConnectedProviders(baseUrl: string, directory: string, signal?: AbortSignal): Promise<string[]>;
  openExternal(url: string): Promise<void>;
  probeInventory(deps: OpenCodeAuthDeps): Promise<void>;
  storeApiKey(providerId: string, key: string): void;
  deleteApiKey(providerId: string): void;
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
  async listConnectedProviders(baseUrl, directory, signal) {
    const client = createOpencodeClient({ baseUrl, directory });
    const listed = await client.provider.list({ query: { directory }, throwOnError: true, signal });
    const data = listed.data as { connected?: string[] } | undefined;
    return Array.isArray(data?.connected) ? data.connected : [];
  },
  async openExternal(url) {
    if (!isAllowedOpenCodeOAuthUrl(url)) {
      throw new Error("OpenCode returned an unsafe OAuth URL.");
    }
    // try/catch keeps esbuild treating this as a runtime-optional require so
    // the ade-cli static runtime (no electron) can bundle this module; there
    // the OAuth URL is still surfaced to the caller, just not auto-opened.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { shell } = require("electron") as { shell: { openExternal(u: string): Promise<void> } };
      await shell.openExternal(url);
    } catch {
      // Not running inside Electron — caller shows the URL instead.
    }
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
  deleteApiKey(providerId) {
    deleteStoredApiKey(providerId);
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
  timer: ReturnType<typeof setTimeout> | null;
  requestController: AbortController | null;
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

/** Tear down an active flow (clear/abort polling, release the lease) and emit `state`. */
function finishFlow(providerId: string, state: OpenCodeOAuthStatusEvent["state"], error?: string): void {
  const flow = activeFlows.get(providerId);
  if (!flow) return;
  activeFlows.delete(providerId);
  if (flow.timer) clearTimeout(flow.timer);
  flow.requestController?.abort(new Error("OpenCode OAuth polling stopped."));
  flow.release();
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
    const flow: ActiveFlow = {
      release: () => lease.release(),
      timer: null,
      requestController: null,
    };
    const scheduleNextPoll = () => {
      flow.timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      if (flow.timer.unref) flow.timer.unref();
    };
    const poll = async (): Promise<void> => {
      if (activeFlows.get(providerId) !== flow) return;
      const elapsed = hooks.now() - startedAt;
      if (elapsed >= OAUTH_TIMEOUT_MS) {
        finishFlow(providerId, "timeout");
        return;
      }

      const controller = new AbortController();
      flow.requestController = controller;
      const requestTimeout = setTimeout(
        () => controller.abort(new Error("OpenCode provider list request timed out.")),
        Math.min(POLL_REQUEST_TIMEOUT_MS, OAUTH_TIMEOUT_MS - elapsed),
      );
      if (requestTimeout.unref) requestTimeout.unref();
      try {
        const connected = await hooks.listConnectedProviders(lease.url, deps.projectRoot, controller.signal);
        if (activeFlows.get(providerId) !== flow) return;
        if (connected.includes(providerId)) {
          finishFlow(providerId, "connected");
          void hooks.probeInventory(deps).catch((err) => {
            deps.logger.warn("opencode.oauth_post_connect_probe_failed", {
              providerId,
              error: errorMessage(err),
            });
          });
          return;
        }
      } catch (err) {
        if (activeFlows.get(providerId) !== flow) return;
        deps.logger.warn("opencode.oauth_poll_failed", { providerId, error: errorMessage(err) });
      } finally {
        clearTimeout(requestTimeout);
        if (activeFlows.get(providerId) === flow) flow.requestController = null;
      }

      if (hooks.now() - startedAt >= OAUTH_TIMEOUT_MS) {
        finishFlow(providerId, "timeout");
        return;
      }
      scheduleNextPoll();
    };

    activeFlows.set(providerId, flow);
    scheduleNextPoll();
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
  const providerId = args.providerId.trim();
  const key = args.key.trim();
  if (!providerId) return { ok: false, error: "Provider ID is required." };
  if (!key) return { ok: false, error: "Provider key is required." };

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
      const error = errorMessage(err);
      deps.logger.warn("opencode.oauth_key_mirror_failed", { providerId, error });
      return {
        ok: false,
        error: `OpenCode accepted the key, but ADE could not store it durably: ${error}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    lease.release();
  }
}

/** Remove a provider credential from the managed OpenCode server. */
export async function clearProviderKey(
  deps: OpenCodeAuthDeps,
  args: { providerId: string },
): Promise<{ ok: boolean; error?: string }> {
  const providerId = args.providerId.trim();
  if (!providerId) return { ok: false, error: "Provider ID is required." };

  const lease = await hooks.acquireLease(deps);
  try {
    const res = await hooks.httpJson(`${lease.url}/auth/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      return { ok: false, error: `OpenCode DELETE /auth failed (${res.status}).` };
    }
    try {
      hooks.deleteApiKey(providerId);
    } catch (err) {
      const error = errorMessage(err);
      deps.logger.warn("opencode.oauth_key_delete_failed", { providerId, error });
      return {
        ok: false,
        error: `OpenCode removed the key, but ADE could not delete its durable copy: ${error}`,
      };
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
      if (flow.timer) clearTimeout(flow.timer);
      flow.requestController?.abort(new Error("OpenCode OAuth service reset."));
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

export function __isAllowedOAuthExternalUrlForTests(url: string): boolean {
  return isAllowedOpenCodeOAuthUrl(url);
}
