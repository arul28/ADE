// ---------------------------------------------------------------------------
// OpenCode sign-in and provider credentials (OpenCode 2.0)
//
// Sign-in methods and OAuth logins go through OpenCode's integration API on the
// shared ADE server (`integration.*`, `credential.*`); the credential lands in
// ADE's owned store, where every ADE chat reads it.
//
// API keys are different: ADE's encrypted key store is their one source of
// truth. `buildOpenCodeConfig` puts every stored key into the server config,
// which OpenCode hot-reloads, so saving a key never writes a second copy into
// OpenCode's credential table. Removing a provider clears both: ADE's key and
// any OpenCode credential (an OAuth login) for that integration.
// ---------------------------------------------------------------------------

import type { OpenCodeClient } from "@opencode/client";
import type { Logger } from "../logging/logger";
import type { EffectiveProjectConfig, ProjectConfigFile } from "../../../shared/types";
import type {
  OpenCodeOAuthStartResult,
  OpenCodeOAuthStatusEvent,
  OpenCodeProviderAuthMethods,
} from "../../../shared/types/config";
import { isAllowedOpenCodeOAuthUrl } from "../../../shared/opencodeOAuth";
import { deleteApiKey as deleteStoredApiKey, storeApiKey as storeStoredApiKey } from "../ai/apiKeyStore";
import {
  mapOpenCodeIntegrationAuthMethods,
  openCodeAuthMethodsFromIntegrations,
  openCodeFormAnswer,
} from "./openCodeAuthMethods";
import { buildOpenCodeConfig } from "./openCodeConfig";
import { readOpenCodeCredentials } from "./openCodeCredentials";
import {
  clearOpenCodeInventoryCache,
  lastOpenCodeDiscoveredLocalModels,
  peekOpenCodeAuthMethods,
  probeOpenCodeProviderInventory,
} from "./openCodeInventory";
import { acquireOpenCodeServer, peekSharedOpenCodeServerUrl, type OpenCodeServerLease } from "./openCodeServer";

/** OAuth completion poll cadence. */
const POLL_INTERVAL_MS = 2_000;
/** Bound each status request so a stalled server cannot wedge polling. */
const POLL_REQUEST_TIMEOUT_MS = 10_000;
/** Used only when OpenCode does not say when its attempt expires. */
const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export type OpenCodeAuthDeps = {
  projectRoot: string;
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  logger: Logger;
};

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record._tag === "string") return record._tag;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * A lease on the shared server. By default its config only seeds a server that
 * is starting, so taking it never rewrites the config a running chat uses.
 */
async function acquireAuthLease(
  deps: OpenCodeAuthDeps,
  configMode: "if-starting" | "providers" = "if-starting",
): Promise<OpenCodeServerLease> {
  return await acquireOpenCodeServer({
    configMode,
    config: buildOpenCodeConfig({
      projectConfig: deps.projectConfig,
      discoveredLocalModels: lastOpenCodeDiscoveredLocalModels(),
    }),
    ownerKind: "auth",
    ownerId: deps.projectRoot,
    logger: deps.logger,
  });
}

/**
 * Rewrite the running shared server's config after a key change, so the key
 * applies without a restart. This is the one lease that replaces the config.
 * No server is started for it: the next one reads the key store when it starts.
 */
async function refreshRunningServerConfig(deps: OpenCodeAuthDeps): Promise<void> {
  if (!peekSharedOpenCodeServerUrl()) return;
  const lease = await acquireAuthLease(deps, "providers");
  lease.release();
}

type StatusListener = (event: OpenCodeOAuthStatusEvent) => void;
const statusListeners = new Set<StatusListener>();

type ActiveFlow = {
  lease: OpenCodeServerLease;
  location: { directory: string };
  integrationId: string;
  attemptId: string;
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

/**
 * Tear down an active flow (stop polling, cancel the attempt unless it
 * finished, release the lease) and emit `state`.
 */
function finishFlow(providerId: string, state: OpenCodeOAuthStatusEvent["state"], error?: string): void {
  const flow = activeFlows.get(providerId);
  if (!flow) return;
  activeFlows.delete(providerId);
  if (flow.timer) clearTimeout(flow.timer);
  flow.requestController?.abort(new Error("OpenCode OAuth polling stopped."));
  const release = () => flow.lease.release();
  if (state === "connected") {
    release();
  } else {
    // The attempt may hold a local callback listener (ChatGPT browser login);
    // cancelling frees it. Release only after, so the server stays up for it.
    void flow.lease.client.integration.oauth
      .cancel({ integrationID: flow.integrationId, attemptID: flow.attemptId, location: flow.location })
      .catch(() => {})
      .finally(release);
  }
  emit({ providerId, state, ...(error ? { error } : {}) });
}

/**
 * The sign-in methods per provider. A list the last inventory probe saw is
 * answered without any server; otherwise the shared server is asked.
 */
export async function listAuthMethods(deps: OpenCodeAuthDeps): Promise<{ methods: OpenCodeProviderAuthMethods }> {
  const cached = peekOpenCodeAuthMethods(deps.projectRoot);
  if (cached) return { methods: cached };
  const lease = await acquireAuthLease(deps);
  try {
    const listed = await lease.client.integration.list({ location: { directory: deps.projectRoot } });
    return { methods: openCodeAuthMethodsFromIntegrations(listed.data) };
  } finally {
    lease.release();
  }
}

async function pollStatus(
  providerId: string,
  flow: ActiveFlow,
  deps: OpenCodeAuthDeps,
  deadline: number,
): Promise<void> {
  if (activeFlows.get(providerId) !== flow) return;
  if (Date.now() >= deadline) {
    finishFlow(providerId, "timeout");
    return;
  }
  const controller = new AbortController();
  flow.requestController = controller;
  const requestTimeout = setTimeout(
    () => controller.abort(new Error("OpenCode sign-in status request timed out.")),
    Math.min(POLL_REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
  );
  if (requestTimeout.unref) requestTimeout.unref();
  try {
    const status = await flow.lease.client.integration.oauth.status(
      { integrationID: flow.integrationId, attemptID: flow.attemptId, location: flow.location },
      { signal: controller.signal },
    );
    if (activeFlows.get(providerId) !== flow) return;
    const state = status.data;
    if (state.status === "complete") {
      finishFlow(providerId, "connected");
      void probeOpenCodeProviderInventory({
        projectRoot: deps.projectRoot,
        projectConfig: deps.projectConfig,
        logger: deps.logger,
        force: true,
        discoveredLocalModels: lastOpenCodeDiscoveredLocalModels(),
      }).catch((err) => {
        deps.logger.warn("opencode.oauth_post_connect_probe_failed", { providerId, error: errorMessage(err) });
      });
      return;
    }
    if (state.status === "failed") {
      finishFlow(providerId, "failed", state.message || "Sign-in failed.");
      return;
    }
    if (state.status === "expired") {
      finishFlow(providerId, "timeout");
      return;
    }
  } catch (err) {
    if (activeFlows.get(providerId) !== flow) return;
    deps.logger.warn("opencode.oauth_poll_failed", { providerId, error: errorMessage(err) });
  } finally {
    clearTimeout(requestTimeout);
    if (activeFlows.get(providerId) === flow) flow.requestController = null;
  }
  if (activeFlows.get(providerId) !== flow) return;
  flow.timer = setTimeout(() => void pollStatus(providerId, flow, deps, deadline), POLL_INTERVAL_MS);
  if (flow.timer.unref) flow.timer.unref();
}

/**
 * Start an OAuth login: create the attempt, return its safe URL, then poll
 * until OpenCode reports it complete, failed, or expired. Only one flow per
 * provider is active at a time — starting a new one cancels the prior flow.
 */
export async function startOAuth(
  deps: OpenCodeAuthDeps,
  args: { providerId: string; methodIndex: number; inputs?: Record<string, string> },
): Promise<OpenCodeOAuthStartResult> {
  const { providerId, methodIndex, inputs } = args;
  cancelOAuth({ providerId });

  const lease = await acquireAuthLease(deps);
  const location = { directory: deps.projectRoot };
  let handedOff = false;
  try {
    // `integration.list` waits until this location's catalog has loaded;
    // `integration.get` does not, and just after a start it reports a real
    // provider as missing.
    const listed = await lease.client.integration.list({ location });
    const integration = listed.data.find((entry) => entry.id === providerId);
    if (!integration) throw new Error(`OpenCode does not offer a sign-in for ${providerId}.`);
    const selected = mapOpenCodeIntegrationAuthMethods(integration)[methodIndex];
    if (!selected || selected.source.type !== "oauth") {
      throw new Error("That sign-in method is no longer offered by OpenCode. Reopen the provider and try again.");
    }
    const answer = openCodeFormAnswer(selected.source, inputs);
    const attempt = (await lease.client.integration.oauth.connect({
      integrationID: providerId,
      methodID: selected.source.id,
      location,
      ...(answer ? { answer } : {}),
    })).data;
    const cancelAttempt = () =>
      lease.client.integration.oauth.cancel({ integrationID: providerId, attemptID: attempt.attemptID, location }).catch(() => {});
    if (attempt.url && !isAllowedOpenCodeOAuthUrl(attempt.url)) {
      await cancelAttempt();
      throw new Error("OpenCode returned an unsafe OAuth URL.");
    }
    if (attempt.mode === "code") {
      // Completing this mode needs a pasted authorization code, and the
      // sign-in dialog has no field for one.
      await cancelAttempt();
      throw new Error("This sign-in method needs a pasted authorization code, which ADE does not support. Use another method or an API key.");
    }

    emit({ providerId, state: "pending" });
    const expires = attempt.time?.expires;
    const deadline = typeof expires === "number" && expires > Date.now() ? expires : Date.now() + DEFAULT_OAUTH_TIMEOUT_MS;
    const flow: ActiveFlow = {
      lease,
      location,
      integrationId: providerId,
      attemptId: attempt.attemptID,
      timer: null,
      requestController: null,
    };
    activeFlows.set(providerId, flow);
    flow.timer = setTimeout(() => void pollStatus(providerId, flow, deps, deadline), POLL_INTERVAL_MS);
    if (flow.timer.unref) flow.timer.unref();
    handedOff = true;
    return { url: attempt.url, method: "auto", instructions: attempt.instructions ?? "" };
  } catch (err) {
    emit({ providerId, state: "failed", error: errorMessage(err) });
    throw err instanceof Error ? err : new Error(errorMessage(err));
  } finally {
    if (!handedOff) lease.release();
  }
}

/** Cancel an in-flight OAuth flow (if any), stopping the poller and emitting `cancelled`. */
export function cancelOAuth(args: { providerId: string }): void {
  finishFlow(args.providerId, "cancelled");
}

/**
 * Save a provider API key in ADE's key store, the one place ADE keeps keys.
 * The shared server, when running, reloads its config with the key.
 */
export async function setProviderKey(
  deps: OpenCodeAuthDeps,
  args: { providerId: string; key: string },
): Promise<{ ok: boolean; error?: string }> {
  const providerId = args.providerId.trim();
  const key = args.key.trim();
  if (!providerId) return { ok: false, error: "Provider ID is required." };
  if (!key) return { ok: false, error: "Provider key is required." };
  try {
    storeStoredApiKey(providerId, key);
  } catch (err) {
    const error = errorMessage(err);
    deps.logger.warn("opencode.provider_key_store_failed", { providerId, error });
    return { ok: false, error: `ADE could not store the key: ${error}` };
  }
  clearOpenCodeInventoryCache();
  try {
    await refreshRunningServerConfig(deps);
  } catch (err) {
    // The key is saved; the next server start reads it.
    deps.logger.warn("opencode.provider_key_config_refresh_failed", { providerId, error: errorMessage(err) });
  }
  return { ok: true };
}

async function removeCredentials(client: OpenCodeClient, credentialIds: readonly string[]): Promise<void> {
  for (const credentialID of credentialIds) {
    await client.credential.remove({ credentialID });
  }
}

/**
 * Disconnect a provider: remove ADE's stored key and every OpenCode credential
 * for the integration. The store is read first, so a provider with no
 * OpenCode credential never starts a server.
 */
export async function clearProviderKey(
  deps: OpenCodeAuthDeps,
  args: { providerId: string },
): Promise<{ ok: boolean; error?: string }> {
  const providerId = args.providerId.trim();
  if (!providerId) return { ok: false, error: "Provider ID is required." };
  try {
    deleteStoredApiKey(providerId);
  } catch (err) {
    const error = errorMessage(err);
    deps.logger.warn("opencode.provider_key_delete_failed", { providerId, error });
    return { ok: false, error: `ADE could not delete its stored key: ${error}` };
  }
  clearOpenCodeInventoryCache();
  const credentialIds = readOpenCodeCredentials()
    .filter((credential) => credential.integrationId === providerId)
    .map((credential) => credential.id);
  try {
    if (!credentialIds.length) {
      await refreshRunningServerConfig(deps);
      return { ok: true };
    }
    const lease = await acquireAuthLease(deps);
    try {
      await removeCredentials(lease.client, credentialIds);
    } finally {
      lease.release();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `OpenCode could not remove the ${providerId} sign-in: ${errorMessage(err)}` };
  }
}
