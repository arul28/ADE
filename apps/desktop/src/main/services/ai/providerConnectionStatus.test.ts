import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProviderConnections } from "../../../shared/types";
import type { CliAuthStatus } from "./authDetector";

const mockState = vi.hoisted(() => ({
  readClaudeCredentials: vi.fn(),
  readCodexCredentials: vi.fn(),
  isCodexTokenStale: vi.fn(),
  getProviderRuntimeHealth: vi.fn(),
}));

vi.mock("./providerCredentialSources", () => ({
  readClaudeCredentials: (...args: unknown[]) => mockState.readClaudeCredentials(...args),
  readCodexCredentials: (...args: unknown[]) => mockState.readCodexCredentials(...args),
  isCodexTokenStale: (...args: unknown[]) => mockState.isCodexTokenStale(...args),
}));

vi.mock("./providerRuntimeHealth", () => ({
  getProviderRuntimeHealth: (...args: unknown[]) => mockState.getProviderRuntimeHealth(...args),
}));

let buildProviderConnections: (cliStatuses: CliAuthStatus[]) => Promise<AiProviderConnections>;

/** buildProviderConnections expects all CLIs; tests historically passed only claude/codex. */
function mergeCliStatuses(overrides: CliAuthStatus[]): CliAuthStatus[] {
  const defaults: CliAuthStatus[] = [
    { cli: "claude", installed: false, path: null, authenticated: false, verified: false },
    { cli: "codex", installed: false, path: null, authenticated: false, verified: false },
    { cli: "cursor", installed: false, path: null, authenticated: false, verified: false },
  ];
  const map = new Map(defaults.map((s) => [s.cli, { ...s }]));
  for (const o of overrides) {
    map.set(o.cli, o);
  }
  return Array.from(map.values());
}

beforeEach(async () => {
  vi.resetModules();
  mockState.readClaudeCredentials.mockReset();
  mockState.readCodexCredentials.mockReset();
  mockState.isCodexTokenStale.mockReset();
  mockState.getProviderRuntimeHealth.mockReset();

  mockState.readClaudeCredentials.mockResolvedValue(null);
  mockState.readCodexCredentials.mockResolvedValue(null);
  mockState.isCodexTokenStale.mockReturnValue(false);
  mockState.getProviderRuntimeHealth.mockReturnValue(null);

  ({ buildProviderConnections } = await import("./providerConnectionStatus"));
});

describe("buildProviderConnections", () => {
  it("does not mark Claude runtime as connected when the CLI explicitly reports signed out", async () => {
    mockState.readClaudeCredentials.mockResolvedValue({
      accessToken: "token",
      source: "claude-credentials-file",
    });

    const result = await buildProviderConnections(
      mergeCliStatuses([
        {
          cli: "claude",
          installed: true,
          path: "/Users/arul/.local/bin/claude",
          authenticated: false,
          verified: true,
        },
        {
          cli: "codex",
          installed: false,
          path: null,
          authenticated: false,
          verified: false,
        },
      ]),
    );

    expect(result.claude.authAvailable).toBe(true);
    expect(result.claude.runtimeDetected).toBe(true);
    expect(result.claude.runtimeAvailable).toBe(false);
    expect(result.claude.blocker).toContain("Claude CLI reports no active login");
    expect(result.claude.blocker).toContain("claude auth login");
  });

  it("keeps the optimistic local-credentials fallback when CLI auth could not be verified", async () => {
    mockState.readClaudeCredentials.mockResolvedValue({
      accessToken: "token",
      source: "claude-credentials-file",
    });

    const result = await buildProviderConnections(
      mergeCliStatuses([
        {
          cli: "claude",
          installed: true,
          path: "/Users/arul/.local/bin/claude",
          authenticated: false,
          verified: false,
        },
        {
          cli: "codex",
          installed: false,
          path: null,
          authenticated: false,
          verified: false,
        },
      ]),
    );

    expect(result.claude.authAvailable).toBe(true);
    expect(result.claude.runtimeAvailable).toBe(true);
    expect(result.claude.blocker).toBeNull();
  });

  it("applies the same signed-out guard to Codex when local auth artifacts remain on disk", async () => {
    mockState.readCodexCredentials.mockResolvedValue({
      accessToken: "token",
      source: "codex-auth-file",
    });

    const result = await buildProviderConnections(
      mergeCliStatuses([
        {
          cli: "claude",
          installed: false,
          path: null,
          authenticated: false,
          verified: false,
        },
        {
          cli: "codex",
          installed: true,
          path: "/Users/arul/.local/bin/codex",
          authenticated: false,
          verified: true,
        },
      ]),
    );

    expect(result.codex.authAvailable).toBe(true);
    expect(result.codex.runtimeDetected).toBe(true);
    expect(result.codex.runtimeAvailable).toBe(false);
    expect(result.codex.blocker).toContain("Codex CLI reports no active login");
    expect(result.codex.blocker).toContain("codex login");
  });

  it("downgrades Claude runtime availability when runtime health reports auth-failed", async () => {
    mockState.readClaudeCredentials.mockResolvedValue({
      accessToken: "token",
      source: "claude-credentials-file",
    });
    mockState.getProviderRuntimeHealth.mockImplementation((provider: string) => {
      if (provider === "claude") {
        return {
          provider: "claude",
          state: "auth-failed",
          message: "Claude runtime reported that login is still required.",
          checkedAt: "2026-03-17T19:00:00.000Z",
        };
      }
      return null;
    });

    const result = await buildProviderConnections(
      mergeCliStatuses([
        {
          cli: "claude",
          installed: true,
          path: "/Users/arul/.local/bin/claude",
          authenticated: true,
          verified: true,
        },
        {
          cli: "codex",
          installed: false,
          path: null,
          authenticated: false,
          verified: false,
        },
      ]),
    );

    expect(result.claude.authAvailable).toBe(true);
    expect(result.claude.runtimeDetected).toBe(true);
    expect(result.claude.runtimeAvailable).toBe(false);
    expect(result.claude.blocker).toBe("Claude runtime reported that login is still required.");
  });

  it("treats runtime probe failures as launch blockers", async () => {
    mockState.readClaudeCredentials.mockResolvedValue({
      accessToken: "token",
      source: "claude-credentials-file",
    });
    mockState.getProviderRuntimeHealth.mockImplementation((provider: string) => {
      if (provider === "claude") {
        return {
          provider: "claude",
          state: "runtime-failed",
          message: "ADE could not launch the Claude runtime from this packaged app session.",
          checkedAt: "2026-03-17T19:00:00.000Z",
        };
      }
      return null;
    });

    const result = await buildProviderConnections(
      mergeCliStatuses([
        {
          cli: "claude",
          installed: true,
          path: "/Users/arul/.local/bin/claude",
          authenticated: true,
          verified: true,
        },
        {
          cli: "codex",
          installed: false,
          path: null,
          authenticated: false,
          verified: false,
        },
      ]),
    );

    expect(result.claude.authAvailable).toBe(true);
    expect(result.claude.runtimeDetected).toBe(true);
    expect(result.claude.runtimeAvailable).toBe(false);
    expect(result.claude.blocker).toBe("ADE could not launch the Claude runtime from this packaged app session.");
  });

  it("requires Cursor SDK readiness before marking runtime available for an env API key", async () => {
    const prevKey = process.env.CURSOR_API_KEY;
    const prevAdminKey = process.env.CURSOR_ADMIN_API_KEY;
    process.env.CURSOR_API_KEY = "test-key";
    delete process.env.CURSOR_ADMIN_API_KEY;
    try {
      const result = await buildProviderConnections(
        mergeCliStatuses([
          {
            cli: "cursor",
            installed: false,
            path: null,
            authenticated: false,
            verified: false,
          },
        ]),
      );
      expect(result.cursor.authAvailable).toBe(true);
      expect(result.cursor.runtimeDetected).toBe(true);
      expect(result.cursor.runtimeAvailable).toBe(false);
      expect(result.cursor.usageAvailable).toBe(false);
      expect(result.cursor.path).toBe("@cursor/sdk");
      expect(result.cursor.blocker).toBe("Verify the Cursor API key to enable Cursor chat.");
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevKey;
      if (prevAdminKey === undefined) delete process.env.CURSOR_ADMIN_API_KEY;
      else process.env.CURSOR_ADMIN_API_KEY = prevAdminKey;
    }
  });

  it("marks Cursor runtime available after the SDK probe reports ready", async () => {
    const prevKey = process.env.CURSOR_API_KEY;
    const prevAdminKey = process.env.CURSOR_ADMIN_API_KEY;
    process.env.CURSOR_API_KEY = "test-key";
    delete process.env.CURSOR_ADMIN_API_KEY;
    mockState.getProviderRuntimeHealth.mockImplementation((provider: string) => {
      if (provider === "cursor") {
        return {
          provider: "cursor",
          state: "ready",
          message: null,
          checkedAt: "2026-05-01T12:00:00.000Z",
        };
      }
      return null;
    });
    try {
      const result = await buildProviderConnections(mergeCliStatuses([]));
      expect(result.cursor.authAvailable).toBe(true);
      expect(result.cursor.runtimeDetected).toBe(true);
      expect(result.cursor.runtimeAvailable).toBe(true);
      expect(result.cursor.blocker).toBeNull();
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevKey;
      if (prevAdminKey === undefined) delete process.env.CURSOR_ADMIN_API_KEY;
      else process.env.CURSOR_ADMIN_API_KEY = prevAdminKey;
    }
  });

  it("marks Cursor usage available only for Admin API-shaped keys", async () => {
    const prevKey = process.env.CURSOR_API_KEY;
    const prevAdminKey = process.env.CURSOR_ADMIN_API_KEY;
    process.env.CURSOR_API_KEY = "key_cursor_admin_test";
    delete process.env.CURSOR_ADMIN_API_KEY;
    try {
      const result = await buildProviderConnections(mergeCliStatuses([]));
      expect(result.cursor.authAvailable).toBe(true);
      expect(result.cursor.runtimeAvailable).toBe(false);
      expect(result.cursor.usageAvailable).toBe(true);
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevKey;
      if (prevAdminKey === undefined) delete process.env.CURSOR_ADMIN_API_KEY;
      else process.env.CURSOR_ADMIN_API_KEY = prevAdminKey;
    }
  });

  it("downgrades Cursor runtime availability when SDK model access rejects the key", async () => {
    const prevKey = process.env.CURSOR_API_KEY;
    const prevAdminKey = process.env.CURSOR_ADMIN_API_KEY;
    process.env.CURSOR_API_KEY = "test-key";
    delete process.env.CURSOR_ADMIN_API_KEY;
    mockState.getProviderRuntimeHealth.mockImplementation((provider: string) => {
      if (provider === "cursor") {
        return {
          provider: "cursor",
          state: "auth-failed",
          message: "Cursor rejected the configured API key for agent/model access.",
          checkedAt: "2026-05-01T12:00:00.000Z",
        };
      }
      return null;
    });
    try {
      const result = await buildProviderConnections(mergeCliStatuses([]));
      expect(result.cursor.authAvailable).toBe(true);
      expect(result.cursor.runtimeDetected).toBe(true);
      expect(result.cursor.runtimeAvailable).toBe(false);
      expect(result.cursor.blocker).toBe("Cursor rejected the configured API key for agent/model access.");
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevKey;
      if (prevAdminKey === undefined) delete process.env.CURSOR_ADMIN_API_KEY;
      else process.env.CURSOR_ADMIN_API_KEY = prevAdminKey;
    }
  });

  it("preserves Cursor usage availability when SDK auth fails but an admin key is configured", async () => {
    const prevKey = process.env.CURSOR_API_KEY;
    const prevAdminKey = process.env.CURSOR_ADMIN_API_KEY;
    process.env.CURSOR_API_KEY = "test-key";
    process.env.CURSOR_ADMIN_API_KEY = "key_cursor_admin_test";
    mockState.getProviderRuntimeHealth.mockImplementation((provider: string) => {
      if (provider === "cursor") {
        return {
          provider: "cursor",
          state: "auth-failed",
          message: "Cursor rejected the configured API key for agent/model access.",
          checkedAt: "2026-05-01T12:00:00.000Z",
        };
      }
      return null;
    });
    try {
      const result = await buildProviderConnections(mergeCliStatuses([]));
      expect(result.cursor.authAvailable).toBe(true);
      expect(result.cursor.runtimeAvailable).toBe(false);
      expect(result.cursor.usageAvailable).toBe(true);
      expect(result.cursor.blocker).toBe("Cursor rejected the configured API key for agent/model access.");
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevKey;
      if (prevAdminKey === undefined) delete process.env.CURSOR_ADMIN_API_KEY;
      else process.env.CURSOR_ADMIN_API_KEY = prevAdminKey;
    }
  });
  // Cursor is gated out of Windows on ARM because @cursor/sdk publishes no
  // win32-arm64 runtime. Platform/arch are forced here rather than read from the
  // host, so these assertions run identically on every CI runner — no platform
  // gate, no baseline entry needed.
  describe("Cursor on Windows on ARM", () => {
    async function withTarget<T>(
      platform: string,
      arch: string,
      run: () => Promise<T>,
    ): Promise<T> {
      const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const prevArch = Object.getOwnPropertyDescriptor(process, "arch")!;
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      Object.defineProperty(process, "arch", { value: arch, configurable: true });
      try {
        // Must await inside the override: buildProviderConnections reads
        // process.arch after its first await point.
        return await run();
      } finally {
        Object.defineProperty(process, "platform", prevPlatform);
        Object.defineProperty(process, "arch", prevArch);
      }
    }

    it("reports Cursor as hard unavailable on win32-arm64 even with a verified key and a ready runtime", async () => {
      const prevKey = process.env.CURSOR_API_KEY;
      process.env.CURSOR_API_KEY = "key_live_cursor_agent";
      mockState.getProviderRuntimeHealth.mockImplementation((provider: string) =>
        provider === "cursor"
          ? { state: "ready", message: null, checkedAt: "2026-05-01T12:00:00.000Z" }
          : null,
      );
      try {
        const result = await withTarget("win32", "arm64", () =>
          buildProviderConnections(mergeCliStatuses([])),
        );
        expect(result.cursor.runtimeAvailable).toBe(false);
        expect(result.cursor.runtimeDetected).toBe(false);
        expect(result.cursor.authAvailable).toBe(false);
        expect(result.cursor.usageAvailable).toBe(false);
        expect(result.cursor.path).toBeNull();
        expect(result.cursor.sources).toEqual([]);
        expect(result.cursor.blocker).toMatch(/win32-arm64/);
      } finally {
        if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
        else process.env.CURSOR_API_KEY = prevKey;
      }
    });

    it("leaves Cursor available on win32-x64 and darwin-arm64 with the same inputs", async () => {
      const prevKey = process.env.CURSOR_API_KEY;
      process.env.CURSOR_API_KEY = "key_live_cursor_agent";
      mockState.getProviderRuntimeHealth.mockImplementation((provider: string) =>
        provider === "cursor"
          ? { state: "ready", message: null, checkedAt: "2026-05-01T12:00:00.000Z" }
          : null,
      );
      try {
        for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"]]) {
          const result = await withTarget(platform!, arch!, () =>
            buildProviderConnections(mergeCliStatuses([])),
          );
          expect(result.cursor.runtimeAvailable, `${platform}-${arch}`).toBe(true);
          expect(result.cursor.runtimeDetected, `${platform}-${arch}`).toBe(true);
          expect(result.cursor.path, `${platform}-${arch}`).toBe("@cursor/sdk");
          expect(result.cursor.blocker, `${platform}-${arch}`).toBeNull();
        }
      } finally {
        if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
        else process.env.CURSOR_API_KEY = prevKey;
      }
    });

    it("does not touch Claude, Codex or Droid on win32-arm64", async () => {
      const result = await withTarget("win32", "arm64", () =>
        buildProviderConnections(
          mergeCliStatuses([
            { cli: "claude", installed: true, path: "claude", authenticated: true, verified: true },
            { cli: "codex", installed: true, path: "codex", authenticated: true, verified: true },
            { cli: "droid", installed: true, path: "droid", authenticated: true, verified: true },
          ]),
        ),
      );
      expect(result.claude.runtimeAvailable).toBe(true);
      expect(result.codex.runtimeAvailable).toBe(true);
      expect(result.droid.runtimeAvailable).toBe(true);
    });
  });
});
