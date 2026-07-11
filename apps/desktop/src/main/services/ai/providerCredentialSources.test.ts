import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";

const mockState = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockState.spawn(...args),
}));

import {
  clearClaudeCredentialCache,
  readClaudeCredentials,
  readClaudeCredentialsWithRefresh,
  refreshClaudeCredentials,
} from "./providerCredentialSources";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function fakeShellChild(stdout: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 1234;
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout, "utf8"));
    child.emit("exit", exitCode);
  });
  return child;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const originalPlatform = process.platform;

beforeEach(() => {
  clearClaudeCredentialCache();
  mockState.spawn.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setPlatform(originalPlatform);
  clearClaudeCredentialCache();
});

describe("refreshClaudeCredentials", () => {
  it("stops retrying a refresh token the endpoint rejected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshClaudeCredentials("dead-token")).resolves.toBeNull();
    await expect(refreshClaudeCredentials("dead-token")).resolves.toBeNull();
    await expect(refreshClaudeCredentials("dead-token")).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not block a different refresh token after one is rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: "invalid_grant" }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "fresh", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshClaudeCredentials("dead-token")).resolves.toBeNull();
    const refreshed = await refreshClaudeCredentials("new-token");

    expect(refreshed?.accessToken).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off after a transient network failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshClaudeCredentials("token")).resolves.toBeNull();
    await expect(refreshClaudeCredentials("token")).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a token-endpoint 429 as transient, not a 24h rejection", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate_limited" }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(refreshClaudeCredentials("token")).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Still blocked inside the 10-minute transient window…
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await expect(refreshClaudeCredentials("token")).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // …but retried once the transient window has passed.
      vi.setSystemTime(Date.now() + 6 * 60_000);
      await expect(refreshClaudeCredentials("token")).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a rejected (4xx) token blocked past the transient window", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(refreshClaudeCredentials("token")).resolves.toBeNull();
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await expect(refreshClaudeCredentials("token")).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readClaudeCredentialsWithRefresh", () => {
  it("returns null instead of expired credentials when refresh fails", async () => {
    setPlatform("darwin");
    const expired = {
      claudeAiOauth: {
        accessToken: "expired-access",
        refreshToken: "dead-refresh",
        expiresAt: Date.now() - 60 * 60_000,
      },
    };
    vi.spyOn(fs.promises, "readFile").mockResolvedValue(JSON.stringify(expired));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
    vi.stubGlobal("fetch", fetchMock);

    const logger = createLogger();
    await expect(
      readClaudeCredentialsWithRefresh(logger, { allowKeychain: false }),
    ).resolves.toBeNull();

    // A second background poll must not attempt the refresh again.
    await expect(
      readClaudeCredentialsWithRefresh(logger, { allowKeychain: false }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it("falls back to a usable file token when the Keychain read fails on a user-initiated read", async () => {
    setPlatform("darwin");
    mockState.spawn.mockImplementation(() => fakeShellChild("", 1));
    const fileCreds = {
      claudeAiOauth: {
        accessToken: "file-access",
        refreshToken: "file-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
      },
    };
    vi.spyOn(fs.promises, "readFile").mockResolvedValue(JSON.stringify(fileCreds));

    const creds = await readClaudeCredentials();
    expect(creds?.accessToken).toBe("file-access");
    expect(creds?.source).toBe("claude-credentials-file");
  });

  it("lets background polls reuse credentials cached from a Keychain read", async () => {
    setPlatform("darwin");
    const keychainPayload = JSON.stringify({
      claudeAiOauth: {
        accessToken: "live-access",
        refreshToken: "live-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
      },
    });
    mockState.spawn.mockImplementation(() => fakeShellChild(keychainPayload));
    const readFileSpy = vi.spyOn(fs.promises, "readFile").mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    // A user-initiated read (Settings, provider status) hits the Keychain.
    const fromKeychain = await readClaudeCredentials();
    expect(fromKeychain?.accessToken).toBe("live-access");
    expect(fromKeychain?.source).toBe("macos-keychain");

    // A background poll (Keychain forbidden) must reuse the cached login
    // rather than falling back to the (missing/stale) credentials file.
    const logger = createLogger();
    const background = await readClaudeCredentialsWithRefresh(logger, { allowKeychain: false });
    expect(background?.accessToken).toBe("live-access");
    expect(readFileSpy).not.toHaveBeenCalled();
  });
});
