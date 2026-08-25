// ---------------------------------------------------------------------------
// Cursor SDK sign-in
//
// Drives Cursor.auth.login() from @cursor/sdk: the browser completes a Cursor
// account login, the SDK mints a named user API key (90 days by default), and
// ADE copies that key into the encrypted apiKeyStore ("cursor") so
// getCursorSdkApiKey / Agent.create keep using ADE's store as source of truth.
//
// This is not a cookie bridge. Cursor.auth.login never transfers browser
// cookies; the minted key is the credential.
// ---------------------------------------------------------------------------

import type { SdkAuthStatus, SdkLoginResult } from "@cursor/sdk";
import type { CursorSdkModule } from "./cursorSdkLoader";
import { loadCursorSdk } from "./cursorSdkLoader";
import {
  deleteApiKey,
  getApiKey,
  getCursorApiKeyOrigin,
  markCursorApiKeyOAuthMinted,
  storeApiKey,
} from "./apiKeyStore";
import { openExternalUrl } from "../shared/externalLinks";
import { isCursorAdminApiKey } from "./utils";
import type {
  AiProviderCredentialSource,
  CursorSdkAuthEvent,
  CursorSdkAuthStatus,
  CursorSdkLoginResult,
} from "../../../shared/types/config";

export type { CursorSdkAuthEvent, CursorSdkAuthStatus, CursorSdkLoginResult };

const CURSOR_LOGIN_API_KEY_NAME = "ADE";

export type CursorSdkAuthSnapshot = {
  storeUnavailable: boolean;
  adeKeyPresent: boolean;
  envKeyPresent: boolean;
  adminEnvKeyPresent: boolean;
  credentialSource?: Extract<
    AiProviderCredentialSource,
    "cursor-oauth" | "cursor-api-key-store" | "cursor-env" | "cursor-admin-env"
  >;
  sdkLoggedIn: boolean;
  email?: string;
  apiKeyExpiresAtMs?: number;
};

type StoredSdkCredentialsLike = {
  apiKey?: string;
  email?: string;
  apiKeyExpiresAtMs?: number;
};

type CursorSdkAuthHooks = {
  loadSdk(): Promise<CursorSdkModule>;
  openLoginUrl(url: string): Promise<void>;
  storeKey(provider: string, key: string): void;
  deleteKey(provider: string): void;
  getKey(provider: string): string | null;
  markOAuthMinted(): void;
  getOrigin(): "oauth" | "pasted" | null;
  loadSdkStoredCredentials(sdk: CursorSdkModule): Promise<StoredSdkCredentialsLike | undefined>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  const message = errorMessage(error);
  return name === "AbortError"
    || name === "AuthenticationError"
    || /abort(ed)?/i.test(message)
    || /cancel(led)?/i.test(message);
}

async function defaultLoadSdkStoredCredentials(
  sdk: CursorSdkModule,
): Promise<StoredSdkCredentialsLike | undefined> {
  try {
    const store = new sdk.FileCredentialStore();
    return await store.load();
  } catch {
    return undefined;
  }
}

const defaultHooks: CursorSdkAuthHooks = {
  loadSdk: loadCursorSdk,
  openLoginUrl: openExternalUrl,
  storeKey: storeApiKey,
  deleteKey: deleteApiKey,
  getKey: getApiKey,
  markOAuthMinted: markCursorApiKeyOAuthMinted,
  getOrigin: getCursorApiKeyOrigin,
  loadSdkStoredCredentials: defaultLoadSdkStoredCredentials,
};

let hooks: CursorSdkAuthHooks = { ...defaultHooks };

type StatusListener = (event: CursorSdkAuthEvent) => void;
const statusListeners = new Set<StatusListener>();

type ActiveLogin = {
  abort: AbortController;
  loginUrl?: string;
};
let activeLogin: ActiveLogin | null = null;

export function addCursorSdkAuthStatusListener(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function emit(event: CursorSdkAuthEvent): void {
  for (const listener of statusListeners) {
    try {
      listener(event);
    } catch {
      // A broken sink must not break the flow or starve other listeners.
    }
  }
}

function readAdeCursorKey(): string | null {
  try {
    const stored = hooks.getKey("cursor")?.trim();
    return stored || null;
  } catch {
    return null;
  }
}

function credentialSourceFrom(
  adeKeyPresent: boolean,
  origin: "oauth" | "pasted" | null,
  sdkLoggedIn: boolean,
  sdkKeyMatchesAde: boolean,
  envKeyPresent: boolean,
  adminEnvKeyPresent: boolean,
): CursorSdkAuthSnapshot["credentialSource"] {
  if (adeKeyPresent) {
    if (origin === "oauth" || (origin !== "pasted" && sdkLoggedIn && sdkKeyMatchesAde)) {
      return "cursor-oauth";
    }
    return "cursor-api-key-store";
  }
  if (envKeyPresent) return "cursor-env";
  if (adminEnvKeyPresent) return "cursor-admin-env";
  return undefined;
}

/**
 * Combine Cursor.auth.status() with ADE's encrypted store. Agent.create still
 * resolves the key from ADE store then CURSOR_API_KEY — never from
 * ~/.cursor/sdk/auth.json alone.
 */
export async function getCursorSdkAuthSnapshot(): Promise<CursorSdkAuthSnapshot> {
  let storeUnavailable = false;
  let adeKey: string | null = null;
  try {
    adeKey = readAdeCursorKey();
  } catch {
    storeUnavailable = true;
  }
  const envKey = process.env.CURSOR_API_KEY?.trim() ?? "";
  const adminEnvKey = process.env.CURSOR_ADMIN_API_KEY?.trim() ?? "";
  const envKeyPresent = Boolean(envKey);
  const adminEnvKeyPresent = Boolean(adminEnvKey);

  let sdkStatus: SdkAuthStatus = { status: "logged-out" };
  let sdkStoredKey: string | undefined;
  try {
    const sdk = await hooks.loadSdk();
    sdkStatus = await sdk.Cursor.auth.status();
    const stored = await hooks.loadSdkStoredCredentials(sdk);
    sdkStoredKey = stored?.apiKey?.trim() || undefined;
  } catch {
    // Missing SDK, unsupported platform, or unread auth file: ADE store/env
    // still decide whether chat can run.
  }

  const sdkLoggedIn = sdkStatus.status === "logged-in";
  const adeKeyPresent = Boolean(adeKey);
  const sdkKeyMatchesAde = Boolean(adeKey && sdkStoredKey && adeKey === sdkStoredKey);
  const origin = hooks.getOrigin();
  const email = sdkStatus.status === "logged-in" ? sdkStatus.email?.trim() || undefined : undefined;
  const apiKeyExpiresAtMs = sdkStatus.status === "logged-in"
    ? sdkStatus.apiKeyExpiresAtMs
    : undefined;

  return {
    storeUnavailable,
    adeKeyPresent,
    envKeyPresent,
    adminEnvKeyPresent,
    credentialSource: credentialSourceFrom(
      adeKeyPresent,
      origin,
      sdkLoggedIn,
      sdkKeyMatchesAde,
      envKeyPresent,
      adminEnvKeyPresent && isCursorAdminApiKey(adminEnvKey),
    ),
    sdkLoggedIn,
    ...(email ? { email } : {}),
    ...(apiKeyExpiresAtMs != null ? { apiKeyExpiresAtMs } : {}),
  };
}

export async function getCursorSdkAuthStatus(): Promise<CursorSdkAuthStatus> {
  const snapshot = await getCursorSdkAuthSnapshot();
  return {
    sdkStatus: snapshot.sdkLoggedIn ? "logged-in" : "logged-out",
    ...(snapshot.email ? { email: snapshot.email } : {}),
    ...(snapshot.apiKeyExpiresAtMs != null ? { apiKeyExpiresAtMs: snapshot.apiKeyExpiresAtMs } : {}),
    adeKeyPresent: snapshot.adeKeyPresent,
    ...(snapshot.credentialSource ? { credentialSource: snapshot.credentialSource } : {}),
    loginInProgress: activeLogin != null,
    ...(activeLogin?.loginUrl ? { loginUrl: activeLogin.loginUrl } : {}),
  };
}

function persistMintedKey(result: SdkLoginResult): void {
  const minted = result.apiKey.trim();
  if (!minted) {
    throw new Error("Cursor sign-in did not return an API key.");
  }
  hooks.storeKey("cursor", minted);
  hooks.markOAuthMinted();
}

export async function loginCursorSdk(): Promise<CursorSdkLoginResult> {
  if (activeLogin) {
    activeLogin.abort.abort();
    activeLogin = null;
  }

  const abort = new AbortController();
  const flow: ActiveLogin = { abort };
  activeLogin = flow;
  emit({ providerId: "cursor", state: "pending" });

  try {
    const sdk = await hooks.loadSdk();
    const result = await sdk.Cursor.auth.login({
      apiKeyName: CURSOR_LOGIN_API_KEY_NAME,
      signal: abort.signal,
      // Electron's opener (Launch Services on macOS, shell.openExternal on
      // Windows/Linux) rather than the SDK's process-spawn default, so SSH
      // sessions and Windows hosts open the same way ADE opens other URLs.
      openBrowser: (url) => {
        void hooks.openLoginUrl(url).catch(() => {
          // URL is still delivered via onLoginUrl / the renderer event.
        });
      },
      onLoginUrl: (url) => {
        const trimmed = url.trim();
        if (!trimmed) return;
        flow.loginUrl = trimmed;
        emit({ providerId: "cursor", state: "pending", url: trimmed });
      },
    });
    if (activeLogin !== flow) {
      return { ok: false, error: "Cursor sign-in was replaced by a newer attempt." };
    }
    persistMintedKey(result);
    const email = result.email?.trim() || undefined;
    emit({
      providerId: "cursor",
      state: "success",
      ...(email ? { email } : {}),
    });
    return {
      ok: true,
      ...(email ? { email } : {}),
      apiKeyExpiresAtMs: result.apiKeyExpiresAtMs,
    };
  } catch (error) {
    if (activeLogin !== flow) {
      return { ok: false, error: "Cursor sign-in was replaced by a newer attempt." };
    }
    if (abort.signal.aborted || isAbortError(error)) {
      emit({ providerId: "cursor", state: "cancelled" });
      return { ok: false, error: "Cursor sign-in was cancelled." };
    }
    const message = errorMessage(error) || "Cursor sign-in failed.";
    emit({ providerId: "cursor", state: "error", error: message });
    return { ok: false, error: message };
  } finally {
    if (activeLogin === flow) activeLogin = null;
  }
}

export function cancelCursorSdkLogin(): void {
  if (!activeLogin) return;
  activeLogin.abort.abort();
}

/**
 * Cursor.auth.logout() plus ADE store cleanup: delete the stored cursor key
 * only when it is the OAuth-minted one. A key the user pasted afterwards is kept.
 */
export async function logoutCursorSdk(): Promise<{ ok: true } | { ok: false; error: string }> {
  cancelCursorSdkLogin();
  const adeKey = readAdeCursorKey();
  const origin = hooks.getOrigin();
  let sdkStoredKey: string | undefined;
  try {
    const sdk = await hooks.loadSdk();
    const stored = await hooks.loadSdkStoredCredentials(sdk);
    sdkStoredKey = stored?.apiKey?.trim() || undefined;
    await sdk.Cursor.auth.logout();
  } catch (error) {
    const message = errorMessage(error) || "Cursor sign-out failed.";
    emit({ providerId: "cursor", state: "error", error: message });
    return { ok: false, error: message };
  }

  const sdkKeyMatchesAde = Boolean(adeKey && sdkStoredKey && adeKey === sdkStoredKey);
  const deleteAdeKey = Boolean(adeKey) && (
    origin === "oauth"
    || (origin !== "pasted" && sdkKeyMatchesAde)
  );
  if (deleteAdeKey) {
    try {
      hooks.deleteKey("cursor");
    } catch (error) {
      const message = errorMessage(error) || "Could not remove the Cursor API key from ADE.";
      emit({ providerId: "cursor", state: "error", error: message });
      return { ok: false, error: message };
    }
  }
  emit({ providerId: "cursor", state: "logged-out" });
  return { ok: true };
}

export function __setCursorSdkAuthHooksForTests(next: Partial<CursorSdkAuthHooks>): void {
  hooks = { ...defaultHooks, ...next };
}

export function __resetCursorSdkAuthForTests(): void {
  hooks = { ...defaultHooks };
  activeLogin = null;
  statusListeners.clear();
}
