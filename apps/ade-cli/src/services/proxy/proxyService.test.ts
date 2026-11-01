import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { borrowedLoginFileName, syncBorrowedLogins } from "./borrowedLogins";

import type { CliProxyApiAuthFile } from "./cliProxyApiManagement";
import { createProxyActionDomainService, createProxyService } from "./proxyService";
import type { CliProxyApiSupervisorStatus } from "./cliProxyApiSupervisor";
import {
  CLI_PROXY_API_RELEASE,
  assets,
  resolvePlatformKey,
  version,
} from "./cliProxyApiRelease";
import { proxyEnvForSubscription, type ProxySubscriptionProviderConnection } from "./proxyEnv";

function makeStatus(): CliProxyApiSupervisorStatus {
  return {
    installed: true,
    running: true,
    pid: 1234,
    port: 43123,
    apiKey: "api-key",
    managementKey: "management-key",
    version: "7.3.7",
    platformKey: "linux-amd64",
    binaryPath: "/tmp/proxy/cli-proxy-api",
    configPath: "/tmp/proxy/config.yaml",
    statePath: "/tmp/proxy/state.json",
  };
}

function makeFile(overrides: Partial<CliProxyApiAuthFile> = {}): CliProxyApiAuthFile {
  return {
    id: "claude-login",
    auth_index: "auth-1",
    provider: "claude",
    email: "user@example.test",
    disabled: false,
    ...overrides,
  };
}

const connection: ProxySubscriptionProviderConnection = {
  provider: "claude",
  port: 43123,
  apiKey: "proxy-api-key",
  prefix: "sub-ab12cd34",
  model: "sonnet",
};

/**
 * The proxy feature suite: the release pin the installer trusts, the env each
 * harness receives from a subscription login, and the action handlers over a
 * mocked supervisor and management client. One file per the folder budget; the
 * HTTP-fixture management-client test and the supervisor keep their own files.
 */
describe("proxy action handlers", () => {
  it("reads its analytics sink at capture time, not at wiring time", async () => {
    // The brain builds the proxy lazily, before its analytics service exists.
    // A sink captured when the service was wired would be null forever.
    const captured: Array<Record<string, unknown>> = [];
    let analytics: { captureInternal: (input: unknown) => void } | null = null;
    let running = false;
    const service = createProxyService({
      supervisor: {
        getStatus: () => ({ ...makeStatus(), running }),
        ensureRunning: async () => { running = true; return { ...makeStatus(), running: true }; },
        stop: async () => undefined,
      },
      managementClientFactory: () => ({ listAuthFiles: async () => [] } as never),
      getAnalytics: () => analytics,
    });
    analytics = { captureInternal: (input) => { captured.push(input as Record<string, unknown>); } };
    await service.ensureRunning();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      surface: "api",
      properties: { feature: "proxy", action: "start", outcome: "completed" },
    });
  });

  it("uses the mocked management client for status, OAuth, logout, and disable", async () => {
    let clock = 0;
    let files: CliProxyApiAuthFile[] = [];
    const status = makeStatus();
    const supervisor = {
      getStatus: vi.fn(() => status),
      ensureRunning: vi.fn(async () => status),
      stop: vi.fn(async () => undefined),
    };
    const management = {
      listAuthFiles: vi.fn(async () => files),
      getAuthUrl: vi.fn(async () => ({
        status: "ok",
        url: "https://login.example.test/claude",
        state: "oauth-state",
      })),
      getAuthStatus: vi.fn()
        .mockResolvedValueOnce({ status: "wait" })
        .mockResolvedValueOnce({ status: "ok" }),
      deleteAuthFile: vi.fn(async () => ({ status: "ok" })),
      patchAuthFileFields: vi.fn(async () => ({ status: "ok" })),
      setAuthFileStatus: vi.fn(async () => ({ status: "ok" })),
    };
    const openedUrls: string[] = [];
    const service = createProxyService({
      supervisor,
      managementClientFactory: () => management,
      openExternal: (url) => { openedUrls.push(url); },
      now: () => clock,
      sleep: async () => { clock += 1_000; },
    });
    const actions = createProxyActionDomainService(service);

    expect(await actions.status()).toMatchObject({
      installed: true,
      running: true,
      port: 43123,
      version: "7.3.7",
      logins: [],
    });

    const signedIn = makeFile({ id: "claude-new" });
    files = [signedIn];
    const login = await actions.signIn({ provider: "claude" });
    expect(login.status).toBe("ok");
    expect(login.login?.prefix).toMatch(/^sub-[0-9a-f]{8}$/);
    expect(openedUrls).toEqual(["https://login.example.test/claude"]);
    expect(management.patchAuthFileFields).toHaveBeenCalledWith({
      name: "claude-new",
      prefix: login.login?.prefix,
    });

    const disabled = await actions.setDisabled({ loginId: "claude-new", disabled: true });
    expect(disabled).toMatchObject({ ok: true, login: { loginId: "claude-new", disabled: true } });
    expect(management.setAuthFileStatus).toHaveBeenCalledWith({ name: "claude-new", disabled: true });

    await expect(actions.signOut({ loginId: "claude-new" })).resolves.toEqual({ ok: true });
    expect(management.deleteAuthFile).toHaveBeenCalledWith("claude-new");
    expect(supervisor.ensureRunning).toHaveBeenCalled();

    await expect(actions.stop()).resolves.toEqual({ ok: true });
    expect(supervisor.stop).toHaveBeenCalled();
  });
});

describe("CLIProxyAPI release pin", () => {
  it("pins a checksum and a download of the pinned version for every platform", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CLI_PROXY_API_RELEASE.version).toBe(version);
    expect(Object.keys(assets)).toEqual([
      "darwin-arm64",
      "darwin-amd64",
      "linux-amd64",
      "linux-arm64",
      "windows-amd64",
      "windows-arm64",
    ]);
    for (const asset of Object.values(assets)) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.url).toContain(`/releases/download/v${version}/`);
      expect(asset.binaryName).toMatch(/^cli-proxy-api(?:\.exe)?$/);
    }
    expect(assets["darwin-arm64"].url).toContain("darwin_aarch64.tar.gz");
    expect(assets["linux-arm64"].url).toContain("linux_aarch64.tar.gz");
    expect(assets["windows-arm64"].url).toContain("windows_aarch64.zip");
  });

  it("resolves supported Node platform and architecture pairs", () => {
    expect(resolvePlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(resolvePlatformKey("darwin", "x64")).toBe("darwin-amd64");
    expect(resolvePlatformKey("linux", "x64")).toBe("linux-amd64");
    expect(resolvePlatformKey("linux", "arm64")).toBe("linux-arm64");
    expect(resolvePlatformKey("win32", "x64")).toBe("windows-amd64");
    expect(resolvePlatformKey("win32", "arm64")).toBe("windows-arm64");
    expect(() => resolvePlatformKey("freebsd", "x64")).toThrow(/does not support platform/);
    expect(() => resolvePlatformKey("linux", "arm")).toThrow(/does not support architecture/);
  });
});

describe("proxyEnvForSubscription", () => {
  it("builds Claude gateway environment with a prefixed model", () => {
    expect(proxyEnvForSubscription(connection, "claude")).toEqual({
      model: "sub-ab12cd34/sonnet",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:43123",
        ANTHROPIC_AUTH_TOKEN: "proxy-api-key",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_MODEL: "sub-ab12cd34/sonnet",
      },
    });
  });

  it("builds the Codex responses provider fragment", () => {
    const result = proxyEnvForSubscription(connection, "codex");
    expect(result.model).toBe("sub-ab12cd34/sonnet");
    expect(result.codexConfigToml).toContain("[model_providers.ade-proxy]");
    expect(result.codexConfigToml).toContain('base_url = "http://127.0.0.1:43123/v1"');
    expect(result.codexConfigToml).toContain('wire_api = "responses"');
    expect(result.codexConfigToml).toContain('experimental_bearer_token = "proxy-api-key"');
    expect(result.codexConfigToml).toContain("requires_openai_auth = true");
  });

  it("builds the OpenCode provider block", () => {
    expect(proxyEnvForSubscription(connection, "opencode")).toMatchObject({
      model: "sub-ab12cd34/sonnet",
      opencodeProvider: {
        baseURL: "http://127.0.0.1:43123/v1",
        apiKey: "proxy-api-key",
        model: "sub-ab12cd34/sonnet",
      },
    });
  });
});

/**
 * Lent logins: what each lend pass keeps, which account's login it lends, and
 * how often the keeper re-runs a pass. Real files in a scratch auth folder; the
 * provider CLIs are never started (no renewal, or an injected pass).
 */
describe("lent logins", () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "ade-lent-"));
  const jwt = (claims: Record<string, unknown>) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  const writeCodexLogin = (home: string, accessToken: string) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: accessToken } }));
  };

  it("keeps Claude and Codex logins when the account list could not be read, but drops a signed-out CLI login", async () => {
    const authDir = scratch();
    const lentClaude = path.join(authDir, borrowedLoginFileName("claude", "claude"));
    const lentGrok = path.join(authDir, borrowedLoginFileName("grok", "grok"));
    const proxyOwnLogin = path.join(authDir, "claude-user@example.test.json");
    for (const file of [lentClaude, lentGrok, proxyOwnLogin]) fs.writeFileSync(file, "{}");

    // No accounts: the registry read failed, and no Grok login is on disk.
    const outcomes = await syncBorrowedLogins({ authDir, accounts: [], renew: false });

    expect(outcomes).toEqual([]);
    expect(fs.existsSync(lentClaude)).toBe(true);
    expect(fs.existsSync(lentGrok)).toBe(false);
    expect(fs.existsSync(proxyOwnLogin)).toBe(true);
  });

  it("lends each Codex account its own login, whichever one the user made the default", async () => {
    const root = scratch();
    const authDir = path.join(root, "auth");
    const baseHome = path.join(root, "codex-base");
    const workHome = path.join(root, "codex-work");
    const exp = Math.floor(Date.now() / 1000) + 3_600;
    writeCodexLogin(baseHome, jwt({ exp, who: "base" }));
    writeCodexLogin(workHome, jwt({ exp, who: "work" }));

    await syncBorrowedLogins({
      authDir,
      renew: false,
      env: { ...process.env, CODEX_HOME: baseHome },
      accounts: [
        // "work" is the user's default for new chats; "codex" is the machine's own login.
        { id: "codex", provider: "codex", configHome: path.join(root, "unused"), isDefault: false },
        { id: "work", provider: "codex", configHome: workHome, isDefault: true },
      ],
    });

    const lent = (id: string) =>
      JSON.parse(fs.readFileSync(path.join(authDir, borrowedLoginFileName("codex", id)), "utf8")) as { access_token: string };
    expect(lent("work").access_token).toBe(jwt({ exp, who: "work" }));
    expect(lent("codex").access_token).toBe(jwt({ exp, who: "base" }));
    expect(lent("work").access_token).not.toBe(lent("codex").access_token);
  });

  it("backs off a login whose renewal keeps failing without missing another login's renew window", async () => {
    vi.useFakeTimers();
    try {
      const root = scratch();
      const authDir = path.join(root, "auth");
      fs.mkdirSync(authDir);
      const now = Date.now();
      const lend = (provider: "codex" | "claude", expiresInMs: number) =>
        fs.writeFileSync(
          path.join(authDir, borrowedLoginFileName(provider, provider)),
          JSON.stringify({ ade_provider: provider, expired: new Date(now + expiresInMs).toISOString() }),
        );
      lend("codex", 60 * 60_000); // inside Codex's day-long renew window: overdue, and its renewal fails
      lend("claude", 145_000); // Claude's renew time is 100 s before expiry: 45 s from now
      const syncLogins = vi.fn(async () => []);
      const service = createProxyService({
        supervisor: {
          getStatus: () => ({ ...makeStatus(), configPath: path.join(root, "config.yaml") }),
          ensureRunning: async () => ({ ...makeStatus(), configPath: path.join(root, "config.yaml") }),
          stop: async () => undefined,
        },
        managementClientFactory: () => ({ listAuthFiles: async () => [] } as never),
        listBorrowableAccounts: () => [],
        syncLogins,
        fetchModels: null,
      });

      await service.ensureRunning();
      expect(syncLogins).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_000);
      // A failing renewal is retried on a backoff, not every few seconds.
      expect(syncLogins).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(21_000);
      // The retry at 30 s, then Claude's own renew time at 45 s, despite the backoff.
      expect(syncLogins).toHaveBeenCalledTimes(3);
      await service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
