import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorSdkModule } from "./cursorSdkLoader";
import type { CursorSdkAuthEvent } from "../../../shared/types/config";
import { isCursorProviderSupported } from "../../../shared/providerPlatformSupport";
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
  stored?: StoredCreds | undefined;
}): CursorSdkModule {
  const login = options?.login ?? (async () => ({
    apiKey: "crsr_minted",
    email: "ada@cursor.com",
    apiKeyExpiresAtMs: 1_700_000_000_000,
  }));
  const logout = options?.logout ?? (async () => undefined);
  const stored = options?.stored;
  return {
    Cursor: {
      auth: { login, logout },
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
      readStoredCredentials: async () => ({
        apiKey: "crsr_minted",
        email: "ada@cursor.com",
        apiKeyExpiresAtMs: 4_102_444_800_000,
      }),
      getKey: () => "crsr_minted",
      getOrigin: () => "oauth",
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
      readStoredCredentials: async () => undefined,
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

// Only the user home lookup is replaced. The reader reads ~/.cursor/sdk/auth.json
// through os.homedir(), and process.env writes do not reach it in vitest's worker
// threads. The auth file, the SDK and the reader are all real.
const testHome = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<{ homedir: () => string }>();
  return { ...actual, homedir: () => testHome.dir || actual.homedir() };
});

// Fixed clock: expiry rows are exact instants, so the boundary is tested and not timing-dependent.
const NOW_MS = Date.parse("2027-06-01T00:00:00.000Z");
const PAST_MS = Date.parse("2023-11-14T00:00:00.000Z");
const FUTURE_MS = Date.parse("2100-01-01T00:00:00.000Z");

const SDK_RECORD = {
  version: 1,
  backendUrl: "https://api2.cursor.sh",
  apiKey: "crsr_minted",
  createdAtMs: PAST_MS,
};

// One row per ~/.cursor/sdk/auth.json the SDK may leave behind. The last column
// is the SDK's answer for that file (signed in or out), pinned so a fixture that
// stops reaching the rule fails too.
const AUTH_FILE_CASES: Array<[string, string | null, boolean]> = [
  ["missing file", null, false],
  ["empty file", "", false],
  ["invalid JSON", "{not json", false],
  ["JSON null", "null", false],
  ["JSON array", "[]", false],
  ["UTF-8 BOM before a valid record", `${String.fromCharCode(0xfeff)}${JSON.stringify({ ...SDK_RECORD, apiKeyExpiresAtMs: FUTURE_MS })}`, false],
  ["valid, no expiry", JSON.stringify(SDK_RECORD), true],
  ["valid, later expiry, padded email", JSON.stringify({ ...SDK_RECORD, email: " ada@cursor.com ", apiKeyExpiresAtMs: FUTURE_MS }), true],
  ["valid, blank email", JSON.stringify({ ...SDK_RECORD, email: "   ", apiKeyExpiresAtMs: FUTURE_MS }), true],
  ["whitespace-only apiKey", JSON.stringify({ ...SDK_RECORD, apiKey: "   ", apiKeyExpiresAtMs: FUTURE_MS }), true],
  ["extra fields", JSON.stringify({ ...SDK_RECORD, apiKeyExpiresAtMs: FUTURE_MS, extra: 1 }), true],
  ["expired", JSON.stringify({ ...SDK_RECORD, apiKeyExpiresAtMs: PAST_MS }), false],
  ["expiry exactly now", JSON.stringify({ ...SDK_RECORD, apiKeyExpiresAtMs: NOW_MS }), false],
  ["version 2", JSON.stringify({ ...SDK_RECORD, version: 2, apiKeyExpiresAtMs: FUTURE_MS }), false],
  ["apiKey missing", JSON.stringify({ ...SDK_RECORD, apiKey: undefined, apiKeyExpiresAtMs: FUTURE_MS }), false],
  ["apiKey a number", JSON.stringify({ ...SDK_RECORD, apiKey: 5, apiKeyExpiresAtMs: FUTURE_MS }), false],
  ["backendUrl missing", JSON.stringify({ ...SDK_RECORD, backendUrl: undefined, apiKeyExpiresAtMs: FUTURE_MS }), false],
  ["createdAtMs missing", JSON.stringify({ ...SDK_RECORD, createdAtMs: undefined, apiKeyExpiresAtMs: FUTURE_MS }), false],
  ["expiry null", JSON.stringify({ ...SDK_RECORD, apiKeyExpiresAtMs: null }), false],
  ["expiry a string", JSON.stringify({ ...SDK_RECORD, apiKeyExpiresAtMs: String(FUTURE_MS) }), false],
  ["email a number", JSON.stringify({ ...SDK_RECORD, email: 7, apiKeyExpiresAtMs: FUTURE_MS }), false],
];

// The reader replicates the SDK's file rules without importing the SDK, so it is
// compared with the real @cursor/sdk over the same home directory. On win32/arm64
// the reader reads signed out by its platform gate before any file is read.
describe.skipIf(!isCursorProviderSupported(process.platform, process.arch))(
  "cursorSdkAuth file reader parity with @cursor/sdk",
  () => {
    let home = "";

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "ade-cursor-parity-"));
      testHome.dir = home;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW_MS);
      // ADE's encrypted key store is out of scope here; only the SDK's file is compared.
      __setCursorSdkAuthHooksForTests({ getKey: () => null, getOrigin: () => null });
    });

    afterEach(() => {
      vi.useRealTimers();
      testHome.dir = "";
      rmSync(home, { recursive: true, force: true });
    });

    it.each(AUTH_FILE_CASES)("%s: reader matches the SDK", async (_name, text, signedIn) => {
      if (text !== null) {
        mkdirSync(join(home, ".cursor", "sdk"), { recursive: true });
        writeFileSync(join(home, ".cursor", "sdk", "auth.json"), text, "utf8");
      }
      const sdk: CursorSdkModule = await import("@cursor/sdk");
      // An explicit store keeps the SDK's answer in this temp home (its default is the real home).
      const sdkStatus = await sdk.Cursor.auth.status({
        store: new sdk.FileCredentialStore(join(home, ".cursor", "sdk", "auth.json")),
      });
      expect(sdkStatus.status).toBe(signedIn ? "logged-in" : "logged-out");

      const expected = sdkStatus.status === "logged-in"
        ? {
          sdkLoggedIn: true,
          email: sdkStatus.email?.trim() || undefined,
          apiKeyExpiresAtMs: sdkStatus.apiKeyExpiresAtMs,
        }
        : { sdkLoggedIn: false, email: undefined, apiKeyExpiresAtMs: undefined };
      const snapshot = await getCursorSdkAuthSnapshot();
      expect({
        sdkLoggedIn: snapshot.sdkLoggedIn,
        email: snapshot.email,
        apiKeyExpiresAtMs: snapshot.apiKeyExpiresAtMs,
      }).toEqual(expected);
    });

    // The rows above write the file where the reader looks. This pins where the
    // SDK's own default store lives, so an SDK that moves its store fails here
    // instead of the reader quietly reading a file the SDK no longer uses.
    it("the SDK's default store is the file the reader reads", async () => {
      const sdk: CursorSdkModule = await import("@cursor/sdk");
      const realOs = await vi.importActual<{ homedir: () => string }>("node:os");
      expect(sdk.getDefaultSdkAuthPath()).toBe(join(realOs.homedir(), ".cursor", "sdk", "auth.json"));
    });
  },
);
