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
  claudeKeychainServiceName,
  clearClaudeCredentialCache,
  invalidateCachedClaudeCredentials,
  readClaudeCredentials,
  readClaudeLogin,
  readCodexCredentials,
} from "./providerCredentialSources";

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

describe("claudeKeychainServiceName", () => {
  it("uses the bare service for the machine default and the CLI's suffix for a scoped home", () => {
    expect(claudeKeychainServiceName()).toBe("Claude Code-credentials");
    // Claude Code appends the first 8 hex characters of the SHA-256 of the
    // resolved config directory. Fixed vector so a hash/format change here is a
    // failing test rather than a silently invisible account.
    expect(claudeKeychainServiceName("/tmp/ade-claude-account"))
      .toBe("Claude Code-credentials-9a35bdb5");
  });
});

describe("readClaudeLogin", () => {
  it("reports a live file token as ok", async () => {
    setPlatform("linux");
    vi.spyOn(fs.promises, "readFile").mockResolvedValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: "file-access",
        refreshToken: "file-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
      },
    }));

    await expect(readClaudeLogin({ allowKeychain: false })).resolves.toEqual({
      state: "ok",
      credentials: expect.objectContaining({ accessToken: "file-access" }),
    });
  });

  it("reports an expired token as expired when the CLI can still refresh it", async () => {
    setPlatform("linux");
    vi.spyOn(fs.promises, "readFile").mockResolvedValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: "expired-access",
        refreshToken: "live-refresh",
        expiresAt: Date.now() - 60 * 60_000,
      },
    }));

    // ADE never spends the refresh token itself; the CLI does on its next run.
    await expect(readClaudeLogin({ allowKeychain: false })).resolves.toEqual({ state: "expired" });
  });

  it("reports an expired token with no refresh token as signed out", async () => {
    setPlatform("linux");
    vi.spyOn(fs.promises, "readFile").mockResolvedValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: "expired-access",
        expiresAt: Date.now() - 60 * 60_000,
      },
    }));

    await expect(readClaudeLogin({ allowKeychain: false })).resolves.toEqual({ state: "signed_out" });
  });

  it("reports a missing login as signed out and caches the miss for background reads", async () => {
    setPlatform("linux");
    const readFileSpy = vi.spyOn(fs.promises, "readFile").mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await expect(readClaudeLogin({ allowKeychain: false })).resolves.toEqual({ state: "signed_out" });
    // A background poll reuses the miss instead of re-probing on every tick.
    await expect(readClaudeLogin({ allowKeychain: false })).resolves.toEqual({ state: "signed_out" });
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  it("reports unreadable when the Keychain read fails and no file token exists", async () => {
    setPlatform("darwin");
    mockState.spawn.mockImplementation(() => fakeShellChild("", 1));
    vi.spyOn(fs.promises, "readFile").mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    // A failed Keychain read proves nothing about the login; it is not a miss.
    await expect(readClaudeLogin()).resolves.toEqual({ state: "unreadable" });
  });

  it("falls back to a usable file token when the Keychain read fails", async () => {
    setPlatform("darwin");
    mockState.spawn.mockImplementation(() => fakeShellChild("", 1));
    vi.spyOn(fs.promises, "readFile").mockResolvedValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: "file-access",
        refreshToken: "file-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
      },
    }));

    await expect(readClaudeLogin()).resolves.toEqual({
      state: "ok",
      credentials: expect.objectContaining({ accessToken: "file-access", source: "claude-credentials-file" }),
    });
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
    await expect(readClaudeLogin()).resolves.toEqual({
      state: "ok",
      credentials: expect.objectContaining({ accessToken: "live-access", source: "macos-keychain" }),
    });

    // A background poll (Keychain forbidden) must reuse the cached login
    // rather than falling back to the (missing/stale) credentials file.
    await expect(readClaudeLogin({ allowKeychain: false })).resolves.toEqual({
      state: "ok",
      credentials: expect.objectContaining({ accessToken: "live-access" }),
    });
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

  it("reads a scoped account's own Keychain item, never the default account's", async () => {
    setPlatform("darwin");
    const configHome = path.join(os.tmpdir(), "ade-instance-claude-work");
    const scopedService = claudeKeychainServiceName(configHome);
    mockState.spawn.mockImplementation(() => fakeShellChild(JSON.stringify(liveClaudeCreds("work-access"))));
    fileReader({});

    const login = await readClaudeLogin({ configHome });

    expect(login).toEqual({
      state: "ok",
      credentials: expect.objectContaining({ accessToken: "work-access", source: "macos-keychain" }),
    });
    const command = String(mockState.spawn.mock.calls[0]?.[1]?.[1] ?? "");
    expect(command).toContain(`-s '${scopedService}'`);
    expect(command).not.toContain("Claude Code-credentials'");
  });

  it("never touches the Keychain for a scoped background read", async () => {
    setPlatform("darwin");
    const configHome = path.join(os.tmpdir(), "ade-instance-claude-work");
    fileReader({
      [path.join(configHome, ".credentials.json")]: liveClaudeCreds("work-access"),
    });

    const login = await readClaudeLogin({ allowKeychain: false, configHome });

    expect(login).toEqual({
      state: "ok",
      credentials: expect.objectContaining({ accessToken: "work-access" }),
    });
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it("caches a scoped Keychain read under that account, so background polls reuse it", async () => {
    setPlatform("darwin");
    const configHome = path.join(os.tmpdir(), "ade-instance-claude-work");
    mockState.spawn.mockImplementation(() => fakeShellChild(JSON.stringify(liveClaudeCreds("work-access"))));
    const readFileSpy = vi.spyOn(fs.promises, "readFile").mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await expect(readClaudeLogin({ configHome })).resolves.toEqual({
      state: "ok",
      credentials: expect.objectContaining({ accessToken: "work-access" }),
    });
    const background = await readClaudeLogin({ allowKeychain: false, configHome });

    expect(background).toEqual({
      state: "ok",
      credentials: expect.objectContaining({ accessToken: "work-access" }),
    });
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("caches each account's token under its own config home", async () => {
    setPlatform("linux");
    const workHome = path.join(os.tmpdir(), "ade-instance-claude-work");
    const { spy } = fileReader({
      [path.join(workHome, ".credentials.json")]: liveClaudeCreds("work-access"),
      [path.join(os.homedir(), ".claude", ".credentials.json")]: liveClaudeCreds("default-access"),
    });

    const first = await readClaudeLogin({ allowKeychain: false });
    const second = await readClaudeLogin({ allowKeychain: false, configHome: workHome });
    // Both are now cached; neither may answer with the other's token.
    const firstAgain = await readClaudeLogin({ allowKeychain: false });
    const secondAgain = await readClaudeLogin({ allowKeychain: false, configHome: workHome });

    expect(first).toEqual({ state: "ok", credentials: expect.objectContaining({ accessToken: "default-access" }) });
    expect(second).toEqual({ state: "ok", credentials: expect.objectContaining({ accessToken: "work-access" }) });
    expect(firstAgain).toEqual({ state: "ok", credentials: expect.objectContaining({ accessToken: "default-access" }) });
    expect(secondAgain).toEqual({ state: "ok", credentials: expect.objectContaining({ accessToken: "work-access" }) });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not let one account's missing login suppress another's read", async () => {
    setPlatform("linux");
    const emptyHome = path.join(os.tmpdir(), "ade-instance-claude-empty");
    fileReader({
      [path.join(os.homedir(), ".claude", ".credentials.json")]: liveClaudeCreds("default-access"),
    });

    // The scoped account has no credentials file at all: that must record a
    // miss for THAT home only.
    await expect(
      readClaudeLogin({ allowKeychain: false, configHome: emptyHome }),
    ).resolves.toEqual({ state: "signed_out" });
    await expect(
      readClaudeLogin({ allowKeychain: false }),
    ).resolves.toEqual({ state: "ok", credentials: expect.objectContaining({ accessToken: "default-access" }) });
  });

  it("invalidates and clears per account", async () => {
    const workHome = path.join(os.tmpdir(), "ade-instance-claude-work");
    cacheClaudeCredentials({ accessToken: "default-access" });
    cacheClaudeCredentials({ accessToken: "work-access" }, workHome);
    fileReader({});

    invalidateCachedClaudeCredentials(workHome);
    await expect(
      readClaudeLogin({ allowKeychain: false, configHome: workHome }),
    ).resolves.toEqual({ state: "signed_out" });
    await expect(
      readClaudeLogin({ allowKeychain: false }),
    ).resolves.toEqual({ state: "ok", credentials: expect.objectContaining({ accessToken: "default-access" }) });

    clearClaudeCredentialCache();
    await expect(
      readClaudeLogin({ allowKeychain: false }),
    ).resolves.toEqual({ state: "signed_out" });
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
