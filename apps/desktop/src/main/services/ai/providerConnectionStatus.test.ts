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

    const result = await buildProviderConnections([
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
    ]);

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

    const result = await buildProviderConnections([
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
    ]);

    expect(result.claude.authAvailable).toBe(true);
    expect(result.claude.runtimeAvailable).toBe(true);
    expect(result.claude.blocker).toBeNull();
  });

  it("applies the same signed-out guard to Codex when local auth artifacts remain on disk", async () => {
    mockState.readCodexCredentials.mockResolvedValue({
      accessToken: "token",
      source: "codex-auth-file",
    });

    const result = await buildProviderConnections([
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
    ]);

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
    mockState.getProviderRuntimeHealth.mockImplementation((provider) => {
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

    const result = await buildProviderConnections([
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
    ]);

    expect(result.claude.authAvailable).toBe(true);
    expect(result.claude.runtimeDetected).toBe(true);
    expect(result.claude.runtimeAvailable).toBe(false);
    expect(result.claude.blocker).toBe("Claude runtime reported that login is still required.");
  });

  it("downgrades Claude runtime availability when runtime health reports a launch failure", async () => {
    mockState.readClaudeCredentials.mockResolvedValue({
      accessToken: "token",
      source: "claude-credentials-file",
    });
    mockState.getProviderRuntimeHealth.mockImplementation((provider) => {
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

    const result = await buildProviderConnections([
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
    ]);

    expect(result.claude.authAvailable).toBe(true);
    expect(result.claude.runtimeDetected).toBe(true);
    expect(result.claude.runtimeAvailable).toBe(false);
    expect(result.claude.blocker).toBe("ADE could not launch the Claude runtime from this packaged app session.");
  });
});
