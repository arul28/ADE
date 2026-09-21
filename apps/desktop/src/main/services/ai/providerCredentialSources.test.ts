import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockState = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockState.spawn(...args),
}));

import {
  cacheClaudeCredentials,
  clearClaudeCredentialCache,
  invalidateCachedClaudeCredentials,
  readClaudeCredentials,
  readClaudeCredentialsWithRefresh,
  readCodexCredentials,
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

describe("readClaudeCredentials", () => {
  it("skips macOS Keychain access for background reads", async () => {
    setPlatform("darwin");
    vi.spyOn(fs.promises, "readFile").mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await expect(readClaudeCredentials({ allowKeychain: false })).resolves.toBeNull();
    expect(mockState.spawn).not.toHaveBeenCalled();
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

describe("per-account credential reads", () => {
  /** A file reader that answers per absolute path, and records what was asked. */
  function fileReader(byPath: Record<string, unknown>) {
    const asked: string[] = [];
    const spy = vi.spyOn(fs.promises, "readFile").mockImplementation(async (file) => {
      const key = String(file);
      asked.push(key);
      const body = byPath[key];
      if (body === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return JSON.stringify(body);
    });
    return { asked, spy };
  }

  function liveClaudeCreds(accessToken: string) {
    return {
      claudeAiOauth: {
        accessToken,
        refreshToken: `${accessToken}-refresh`,
        expiresAt: Date.now() + 8 * 60 * 60_000,
      },
    };
  }

  it("reads a scoped account from its own config home and never the Keychain", async () => {
    setPlatform("darwin");
    const configHome = path.join(os.tmpdir(), "ade-instance-claude-work");
    const { asked } = fileReader({
      [path.join(configHome, ".credentials.json")]: liveClaudeCreds("work-access"),
      [path.join(os.homedir(), ".claude", ".credentials.json")]: liveClaudeCreds("default-access"),
    });

    const creds = await readClaudeCredentials({ configHome });

    expect(creds?.accessToken).toBe("work-access");
    expect(asked).toEqual([path.join(configHome, ".credentials.json")]);
    // The Keychain item is the machine's default login; a scoped account has no
    // per-account equivalent and must never be handed the default's token.
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it("caches each account's token under its own config home", async () => {
    setPlatform("linux");
    const workHome = path.join(os.tmpdir(), "ade-instance-claude-work");
    const { spy } = fileReader({
      [path.join(workHome, ".credentials.json")]: liveClaudeCreds("work-access"),
      [path.join(os.homedir(), ".claude", ".credentials.json")]: liveClaudeCreds("default-access"),
    });
    const logger = createLogger();

    const first = await readClaudeCredentialsWithRefresh(logger, { allowKeychain: false });
    const second = await readClaudeCredentialsWithRefresh(logger, {
      allowKeychain: false,
      configHome: workHome,
    });
    // Both are now cached; neither may answer with the other's token.
    const firstAgain = await readClaudeCredentialsWithRefresh(logger, { allowKeychain: false });
    const secondAgain = await readClaudeCredentialsWithRefresh(logger, {
      allowKeychain: false,
      configHome: workHome,
    });

    expect(first?.accessToken).toBe("default-access");
    expect(second?.accessToken).toBe("work-access");
    expect(firstAgain?.accessToken).toBe("default-access");
    expect(secondAgain?.accessToken).toBe("work-access");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not let one account's missing login suppress another's read", async () => {
    setPlatform("linux");
    const emptyHome = path.join(os.tmpdir(), "ade-instance-claude-empty");
    fileReader({
      [path.join(os.homedir(), ".claude", ".credentials.json")]: liveClaudeCreds("default-access"),
    });
    const logger = createLogger();

    // The scoped account has no credentials file at all: that must record a
    // miss for THAT home only.
    await expect(
      readClaudeCredentialsWithRefresh(logger, { allowKeychain: false, configHome: emptyHome }),
    ).resolves.toBeNull();
    await expect(
      readClaudeCredentialsWithRefresh(logger, { allowKeychain: false }),
    ).resolves.toEqual(expect.objectContaining({ accessToken: "default-access" }));
  });

  it("invalidates and clears per account", async () => {
    const workHome = path.join(os.tmpdir(), "ade-instance-claude-work");
    cacheClaudeCredentials({ accessToken: "default-access" });
    cacheClaudeCredentials({ accessToken: "work-access" }, workHome);
    const logger = createLogger();
    fileReader({});

    invalidateCachedClaudeCredentials(workHome);
    await expect(
      readClaudeCredentialsWithRefresh(logger, { allowKeychain: false, configHome: workHome }),
    ).resolves.toBeNull();
    await expect(
      readClaudeCredentialsWithRefresh(logger, { allowKeychain: false }),
    ).resolves.toEqual(expect.objectContaining({ accessToken: "default-access" }));

    clearClaudeCredentialCache();
    await expect(
      readClaudeCredentialsWithRefresh(logger, { allowKeychain: false }),
    ).resolves.toBeNull();
  });

  it("reads Codex auth from the account's home, outranking CODEX_HOME", async () => {
    const workHome = path.join(os.tmpdir(), "ade-instance-codex-work");
    const envHome = path.join(os.tmpdir(), "ade-env-codex");
    vi.stubEnv("CODEX_HOME", envHome);
    fileReader({
      [path.join(workHome, "auth.json")]: { tokens: { access_token: "work-token" } },
      [path.join(envHome, "auth.json")]: { tokens: { access_token: "env-token" } },
    });

    await expect(readCodexCredentials(workHome)).resolves.toEqual(
      expect.objectContaining({ accessToken: "work-token" }),
    );
    await expect(readCodexCredentials()).resolves.toEqual(
      expect.objectContaining({ accessToken: "env-token" }),
    );
  });
});
