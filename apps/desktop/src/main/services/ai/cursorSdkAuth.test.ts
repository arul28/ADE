import { afterEach, describe, expect, it, vi } from "vitest";
import type { CursorSdkModule } from "./cursorSdkLoader";
import type { CursorSdkAuthEvent } from "../../../shared/types/config";
import {
  __resetCursorSdkAuthForTests,
  __setCursorSdkAuthHooksForTests,
  addCursorSdkAuthStatusListener,
  cancelCursorSdkLogin,
  getCursorSdkAuthSnapshot,
  getCursorSdkAuthStatus,
  loginCursorSdk,
  logoutCursorSdk,
} from "./cursorSdkAuth";

type StoredCreds = { apiKey?: string; email?: string; apiKeyExpiresAtMs?: number };

function createFakeSdk(options?: {
  login?: () => Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs: number }>;
  logout?: () => Promise<void>;
  status?: () => Promise<{ status: "logged-in"; email?: string; backendUrl: string; apiKeyExpiresAtMs?: number } | { status: "logged-out" }>;
  stored?: StoredCreds | undefined;
}): CursorSdkModule {
  const login = options?.login ?? (async () => ({
    apiKey: "crsr_minted",
    email: "ada@cursor.com",
    apiKeyExpiresAtMs: 1_700_000_000_000,
  }));
  const logout = options?.logout ?? (async () => undefined);
  const status = options?.status ?? (async () => ({ status: "logged-out" as const }));
  const stored = options?.stored;
  return {
    Cursor: {
      auth: { login, logout, status },
    },
    FileCredentialStore: class {
      async load() {
        return stored;
      }
    },
  } as unknown as CursorSdkModule;
}

afterEach(() => {
  __resetCursorSdkAuthForTests();
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_ADMIN_API_KEY;
});

describe("cursorSdkAuth", () => {
  it("persists the minted key into ADE's store and marks it OAuth-minted", async () => {
    const storedKeys = new Map<string, string>();
    let origin: "oauth" | "pasted" | null = null;
    const events: CursorSdkAuthEvent[] = [];
    addCursorSdkAuthStatusListener((event) => events.push(event));

    let capturedOnLoginUrl: ((url: string) => void) | undefined;
    const login = vi.fn(async (opts?: { onLoginUrl?: (url: string) => void }) => {
      capturedOnLoginUrl = opts?.onLoginUrl;
      capturedOnLoginUrl?.("https://cursor.com/loginDeepControl?uuid=abc");
      return {
        apiKey: " crsr_minted ",
        email: "ada@cursor.com",
        apiKeyExpiresAtMs: 1_700_000_000_000,
      };
    });

    __setCursorSdkAuthHooksForTests({
      loadSdk: async () => createFakeSdk({ login }),
      openLoginUrl: vi.fn(async () => undefined),
      storeKey: (provider, key) => {
        storedKeys.set(provider, key);
        origin = "pasted";
      },
      deleteKey: (provider) => {
        storedKeys.delete(provider);
        origin = null;
      },
      getKey: (provider) => storedKeys.get(provider) ?? null,
      markOAuthMinted: () => {
        origin = storedKeys.get("cursor") ? "oauth" : null;
      },
      getOrigin: () => origin,
    });

    const result = await loginCursorSdk();
    expect(result).toEqual({
      ok: true,
      email: "ada@cursor.com",
      apiKeyExpiresAtMs: 1_700_000_000_000,
    });
    expect(storedKeys.get("cursor")).toBe("crsr_minted");
    expect(origin).toBe("oauth");
    expect(events.some((event) => event.state === "pending" && event.url?.includes("loginDeepControl"))).toBe(true);
    expect(events.some((event) => event.state === "success" && event.email === "ada@cursor.com")).toBe(true);
    expect(events.every((event) => !("apiKey" in event))).toBe(true);
  });

  it("does not return or emit the minted API key", async () => {
    __setCursorSdkAuthHooksForTests({
      loadSdk: async () => createFakeSdk(),
      storeKey: vi.fn(),
      markOAuthMinted: vi.fn(),
      getOrigin: () => "oauth",
      getKey: () => "crsr_minted",
    });
    const result = await loginCursorSdk();
    expect(JSON.stringify(result)).not.toContain("crsr_minted");
  });

  it("logout deletes an OAuth-minted ADE key and keeps a key pasted afterwards", async () => {
    const storedKeys = new Map<string, string>([["cursor", "crsr_minted"]]);
    let origin: "oauth" | "pasted" | null = "oauth";
    const logout = vi.fn(async () => undefined);

    __setCursorSdkAuthHooksForTests({
      loadSdk: async () => createFakeSdk({
        logout,
        stored: { apiKey: "crsr_minted" },
      }),
      storeKey: (provider, key) => {
        storedKeys.set(provider, key);
        origin = "pasted";
      },
      deleteKey: (provider) => {
        storedKeys.delete(provider);
        origin = null;
      },
      getKey: (provider) => storedKeys.get(provider) ?? null,
      getOrigin: () => origin,
      loadSdkStoredCredentials: async () => ({ apiKey: "crsr_minted" }),
    });

    expect(await logoutCursorSdk()).toEqual({ ok: true });
    expect(logout).toHaveBeenCalledTimes(1);
    expect(storedKeys.has("cursor")).toBe(false);

    storedKeys.set("cursor", "crsr_pasted");
    origin = "pasted";
    expect(await logoutCursorSdk()).toEqual({ ok: true });
    expect(storedKeys.get("cursor")).toBe("crsr_pasted");
  });

  it("treats an ADE-stored OAuth key as connected even when CURSOR_API_KEY is unset", async () => {
    __setCursorSdkAuthHooksForTests({
      loadSdk: async () => createFakeSdk({
        status: async () => ({
          status: "logged-in",
          backendUrl: "https://api2.cursor.sh",
          email: "ada@cursor.com",
          apiKeyExpiresAtMs: 1_700_000_000_000,
        }),
        stored: { apiKey: "crsr_minted" },
      }),
      getKey: () => "crsr_minted",
      getOrigin: () => "oauth",
      loadSdkStoredCredentials: async () => ({ apiKey: "crsr_minted" }),
    });

    const snapshot = await getCursorSdkAuthSnapshot();
    expect(snapshot.adeKeyPresent).toBe(true);
    expect(snapshot.envKeyPresent).toBe(false);
    expect(snapshot.sdkLoggedIn).toBe(true);
    expect(snapshot.credentialSource).toBe("cursor-oauth");
    expect(snapshot.email).toBe("ada@cursor.com");

    const status = await getCursorSdkAuthStatus();
    expect(status.sdkStatus).toBe("logged-in");
    expect(status.email).toBe("ada@cursor.com");
    expect(status.adeKeyPresent).toBe(true);
  });

  it("prefers ADE store over env when labeling the credential source", async () => {
    process.env.CURSOR_API_KEY = "crsr_env";
    __setCursorSdkAuthHooksForTests({
      loadSdk: async () => createFakeSdk({
        status: async () => ({ status: "logged-out" }),
      }),
      getKey: () => "crsr_pasted",
      getOrigin: () => "pasted",
    });
    const snapshot = await getCursorSdkAuthSnapshot();
    expect(snapshot.credentialSource).toBe("cursor-api-key-store");
    expect(snapshot.envKeyPresent).toBe(true);
  });

  it("cancels an in-flight login via AbortSignal", async () => {
    let abortSeen = false;
    const login = vi.fn(async (opts?: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          abortSeen = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      return { apiKey: "crsr_minted", apiKeyExpiresAtMs: 0 };
    });
    __setCursorSdkAuthHooksForTests({
      loadSdk: async () => createFakeSdk({ login }),
      storeKey: vi.fn(),
      markOAuthMinted: vi.fn(),
      getOrigin: () => null,
      getKey: () => null,
    });

    const pending = loginCursorSdk();
    await vi.waitFor(() => expect(login).toHaveBeenCalled());
    cancelCursorSdkLogin();
    const result = await pending;
    expect(abortSeen).toBe(true);
    expect(result).toEqual({ ok: false, error: "Cursor sign-in was cancelled." });
  });
});
