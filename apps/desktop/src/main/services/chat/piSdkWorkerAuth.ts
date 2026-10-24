import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { toPiSdkJson, type JsonValue, type PiSdkWorkerInit } from "./piSdkProtocol";
import { createPiAuthInteraction, type PiUiBridge } from "./piSdkUiBridge";
import { errorMessage, nonEmpty, record, type Callable, type PiModule } from "./piSdkWorkerValues";

/**
 * Pi sign-in for the chat worker: which providers can be signed into and how
 * (`authInventory`), and Pi's native sign-in itself (`loginProvider`). Its
 * own module so the worker stays under the size rule. The worker hands in
 * what it owns (the model runtime, the Pi module, its init and UI bridge); one
 * sign-in runs at a time.
 */


const PI_LOGIN_REFRESH_TIMEOUT_MS = 15_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `LoginOptions` for `ModelRuntime.login`, with the installation id Pi's
 * "Sign in with ChatGPT" (Pi 0.99+, on the `openai` provider) sends to OpenAI
 * as its agent host id. Pi refuses that sign-in without one.
 *
 * The id is the `deviceId` in the user's global Pi settings, the one the Pi
 * CLI's own /login reads, so ADE and the CLI sign in as one installation. When
 * the profile has none yet, Pi's own settings manager creates it: one field,
 * written under Pi's lock. That is the only settings write the worker makes,
 * and it happens only when a login asks for the id. `flush` waits for it.
 */
function piLoginOptions(sdk: PiModule, init: PiSdkWorkerInit): { options: Record<string, unknown>; flush: () => Promise<void> } {
  let writer: Record<string, unknown> | null = null;
  const getDeviceId = (): string => {
    try {
      const settings = record(JSON.parse(fs.readFileSync(path.join(init.agentDir, "settings.json"), "utf8")));
      const existing = nonEmpty(settings?.deviceId);
      if (existing && UUID_PATTERN.test(existing)) return existing;
    } catch {
      // No readable settings yet; Pi creates the file below.
    }
    const ctor = sdk.SettingsManager as unknown as Record<string, unknown> | undefined;
    if (ctor && typeof ctor.create === "function") {
      writer = record((ctor.create as Callable).call(ctor, init.cwd, init.agentDir, { projectTrusted: false }));
      const created = typeof writer?.getOrCreateDeviceId === "function"
        ? nonEmpty((writer.getOrCreateDeviceId as Callable).call(writer))
        : null;
      if (created) return created;
    }
    // A Pi build that cannot store one still signs in, as a new installation.
    return randomUUID();
  };
  return {
    options: { getDeviceId },
    flush: async () => {
      const flush = writer?.flush;
      if (typeof flush === "function") await Promise.resolve((flush as Callable).call(writer)).catch(() => undefined);
    },
  };
}

export function createPiWorkerAuth(deps: {
  getModelRuntime: () => Record<string, unknown> | null;
  getPi: () => PiModule | null;
  getInit: () => PiSdkWorkerInit | null;
  uiBridge: PiUiBridge;
  /** The sign-in may have changed this provider's credential. */
  forgetAccount: (providerId: string) => void;
}): {
  authInventory: () => Promise<JsonValue>;
  loginProvider: (providerId: string, method?: string | null) => Promise<JsonValue>;
  abort: () => void;
} {
  let activeLogin: { providerId: string; controller: AbortController } | null = null;

  async function authInventory(): Promise<JsonValue> {
    const modelRuntime = deps.getModelRuntime();
    if (!modelRuntime) throw new Error("Pi SDK model runtime is not initialized.");
    const runtime = modelRuntime as Record<string, unknown>;
    const providersValue = typeof runtime.getProviders === "function"
      ? await (runtime.getProviders as Callable).call(modelRuntime)
      : [];
    const providers = Array.isArray(providersValue) ? providersValue : [];
    const result: Record<string, JsonValue>[] = [];
    for (const providerValue of providers) {
      const provider = record(providerValue);
      const id = nonEmpty(provider?.id);
      if (!id) continue;
      const auth = record(provider?.auth);
      const oauth = record(auth?.oauth);
      const apiKey = record(auth?.apiKey);
      // An api-key provider with no interactive `login` resolves ambiently (env
      // var, cloud profile), so ADE must not offer to sign into it.
      const authTypes = [
        ...(oauth ? ["oauth"] : []),
        ...(apiKey && typeof apiKey.login === "function" ? ["api_key"] : []),
      ];
      const item: Record<string, JsonValue> = {
        id,
        ...(nonEmpty(provider?.name) ? { name: nonEmpty(provider?.name)! } : {}),
        ...(authTypes.length ? { authTypes } : {}),
        ...(nonEmpty(oauth?.loginLabel) ? { loginLabel: nonEmpty(oauth?.loginLabel)! } : {}),
        ...(oauth?.isSubscription === true ? { isSubscription: true } : {}),
      };
      try {
        const status = typeof runtime.getProviderAuthStatus === "function"
          ? await (runtime.getProviderAuthStatus as Callable).call(modelRuntime, id)
          : typeof runtime.checkAuth === "function"
            ? await (runtime.checkAuth as Callable).call(modelRuntime, id)
            : undefined;
        const statusRecord = record(status);
        if (statusRecord) {
          // Pi 0.84+ reports the authoritative auth state as `configured`, with
          // `source`/`label` describing how the provider was resolved. Keep the
          // older aliases too so ADE can read compatible Pi installations without
          // manufacturing an auth result from the presence of a provider row.
          for (const key of ["configured", "authenticated", "isAuthenticated", "type", "status", "source", "label", "expiresAt"] as const) {
            if (statusRecord[key] !== undefined) item[key] = toPiSdkJson(statusRecord[key]);
          }
        }
      } catch (error) {
        item.error = errorMessage(error);
      }
      result.push(item);
    }
    return result;
  }

  /**
   * Run Pi's native login for one provider.
   *
   * Credentials stay Pi's: `ModelRuntime.login` persists them through Pi's own
   * `AuthStorage`, under its cross-process lock. ADE only renders the prompts and
   * relays what the user typed, and never receives or stores a token.
   */
  async function loginProvider(providerId: string, method?: string | null): Promise<JsonValue> {
    const modelRuntime = deps.getModelRuntime();
    const init = deps.getInit();
    if (!modelRuntime || !init) throw new Error("Pi SDK model runtime is not initialized.");
    const runtime = modelRuntime as Record<string, unknown>;
    const login = runtime.login;
    if (typeof login !== "function") {
      throw new Error("This Pi build does not expose ModelRuntime.login(). Update Pi, or sign in with the Pi CLI.");
    }

    const provider = typeof runtime.getProvider === "function"
      ? record((runtime.getProvider as Callable).call(runtime, providerId))
      : null;
    const auth = record(provider?.auth);
    // Pi only has two login types. An api-key provider without an interactive
    // `login` is ambient-only (env var, cloud profile) and has nothing to run.
    const requested = nonEmpty(method);
    const authType = requested === "api_key" || requested === "oauth"
      ? requested
      : auth?.oauth
        ? "oauth"
        : "api_key";
    if (authType === "oauth" && auth && !auth.oauth) {
      throw new Error(`Pi provider "${providerId}" does not support OAuth sign-in.`);
    }
    if (authType === "api_key" && auth) {
      const apiKeyAuth = record(auth.apiKey);
      if (!apiKeyAuth) throw new Error(`Pi provider "${providerId}" does not support API key sign-in.`);
      if (typeof apiKeyAuth.login !== "function") {
        throw new Error(`Pi provider "${providerId}" reads its API key from the environment, so there is nothing to sign in to.`);
      }
    }

    if (activeLogin) {
      // Aborting the old flow rejects its in-flight prompt, but a card already
      // on screen belongs to the bridge — settle it so the superseded sign-in
      // cannot leave an unanswerable prompt next to the new one.
      activeLogin.controller.abort();
      deps.uiBridge.drain("auth");
    }
    const controller = new AbortController();
    activeLogin = { providerId, controller };
    const loginOptions = piLoginOptions(deps.getPi() ?? {}, init);
    try {
      await (login as Callable).call(
        modelRuntime,
        providerId,
        authType,
        createPiAuthInteraction(deps.uiBridge, providerId, controller.signal),
        loginOptions.options,
      );
    } catch (error) {
      // Credentials were written but Pi could not resync its local snapshot.
      // That is a successful sign-in with a stale catalog, not a failed login.
      if (error instanceof Error && error.name === "CredentialSynchronizationError") {
        deps.uiBridge.notify({
          origin: "auth",
          level: "warn",
          message: "Signed in, but Pi could not refresh its model list. Reopen settings to retry.",
          sourceId: providerId,
        });
      } else {
        throw error;
      }
    } finally {
      if (activeLogin?.controller === controller) activeLogin = null;
      // The sign-in may have changed this provider's credential.
      deps.forgetAccount(providerId);
      await loginOptions.flush();
    }

    // login() settles once local credential state is consistent, but not once
    // remote catalogs are fresh. Refresh so newly unlocked models appear.
    //
    // Bounded: the credential is already written by this point, so a slow
    // network catalog fetch must not keep the sign-in RPC — and the card the
    // user is watching — pending behind it.
    if (typeof runtime.refresh === "function") {
      try {
        // The refresh keeps running after the timeout wins the race, so its
        // rejection has to stay observed — an unhandled one would take down the
        // worker over a catalog fetch the sign-in no longer depends on.
        const refreshed = Promise.resolve(
          (runtime.refresh as Callable).call(modelRuntime, { allowNetwork: true, providers: [providerId] }),
        ).catch(() => undefined);
        await Promise.race([
          refreshed,
          new Promise((resolve) => {
            const timer = setTimeout(resolve, PI_LOGIN_REFRESH_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } catch {
        // Only a synchronous throw from refresh() reaches here; an async
        // rejection is already absorbed above. Either way a stale catalog is
        // reported through the model list, not as a failed sign-in.
      }
    }
    // Deliberately does not return the model inventory: the credential is
    // already written, so letting an inventory read throw here would report a
    // completed sign-in as a failure. `refresh` above owns catalog freshness.
    return toPiSdkJson({ ok: true, providerId, authType });
  }

  return {
    authInventory,
    loginProvider,
    abort: () => {
      activeLogin?.controller.abort();
      activeLogin = null;
    },
  };
}
