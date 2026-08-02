import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAgentCliError } from "./agentRegistry";

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => setPlatform(originalPlatform));

describe("classifyAgentCliError", () => {
  it("classifies missing agent CLIs with POSIX install/auth commands", async () => {
    setPlatform("linux");
    vi.resetModules();
    const { classifyAgentCliError: classifyForLinux } = await import("./agentRegistry");
    expect(classifyForLinux("spawn codex ENOENT")).toMatchObject({
      agent: "codex",
      displayName: "Codex CLI",
      category: "missing",
      installCommand: process.platform === "win32"
        ? "npm install -g @openai/codex"
        : 'mkdir -p "$HOME/.npm-global" "$HOME/.local/bin" && NPM_CONFIG_PREFIX="$HOME/.npm-global" npm install -g @openai/codex',
      authCommand: "codex login",
    });
  });

  it("uses Windows-native recovery commands without POSIX shell setup", async () => {
    setPlatform("win32");
    vi.resetModules();
    const { classifyAgentCliError: classifyForWindows } = await import("./agentRegistry");
    expect(classifyForWindows("spawn codex ENOENT")).toMatchObject({
      agent: "codex",
      category: "missing",
      installCommand: "npm install -g @openai/codex",
      authCommand: "codex login",
    });
    expect(classifyForWindows("spawn cursor-agent ENOENT", "cursor")).toMatchObject({
      agent: "cursor",
      category: "missing",
      installCommand: `powershell.exe -NoProfile -Command "irm 'https://cursor.com/install?win32=true' | iex"`,
      authCommand: "cursor-agent login",
    });
    expect(classifyForWindows("'droid.cmd' is not recognized as an internal or external command")).toMatchObject({
      agent: "droid",
      displayName: "Factory Droid",
      category: "missing",
      installCommand: "npm install -g droid",
      authCommand: "droid",
    });
  });

  it("classifies unauthenticated agent CLIs with auth commands", () => {
    expect(classifyAgentCliError("codex failed: login required")).toMatchObject({
      agent: "codex",
      displayName: "Codex CLI",
      category: "unauthenticated",
      authCommand: "codex login",
    });
  });

  it("uses the preferred provider for generic auth failures", () => {
    expect(classifyAgentCliError("401 unauthorized", "claude")).toMatchObject({
      agent: "claude",
      displayName: "Claude Code",
      category: "unauthenticated",
      authCommand: "claude auth login",
    });
  });

  it("provides Factory Droid install and interactive authentication recovery", () => {
    expect(classifyAgentCliError("spawn droid ENOENT")).toMatchObject({
      agent: "droid",
      displayName: "Factory Droid",
      category: "missing",
      authCommand: "droid",
    });
    expect(classifyAgentCliError("Factory Droid authentication failed: login required")).toMatchObject({
      agent: "droid",
      displayName: "Factory Droid",
      category: "unauthenticated",
      authCommand: "droid",
    });
    expect(classifyAgentCliError("No Factory API key was found", "droid")).toMatchObject({
      agent: "droid",
      category: "unauthenticated",
      authCommand: "droid",
    });
    expect(classifyAgentCliError("Factory Droid completed successfully", "droid")).toBeNull();
  });

  it("uses the installed legacy Cursor alias for authentication recovery", () => {
    expect(classifyAgentCliError("agent failed: login required", "cursor")).toMatchObject({
      agent: "cursor",
      category: "unauthenticated",
      authCommand: "agent login",
    });
    expect(classifyAgentCliError("Cursor agent failed: login required", "cursor")).toMatchObject({
      agent: "cursor",
      category: "unauthenticated",
      authCommand: "cursor-agent login",
    });
  });

  it("classifies legacy Claude login hints", () => {
    expect(classifyAgentCliError("Please run 'claude /login'", "claude")).toMatchObject({
      agent: "claude",
      category: "unauthenticated",
      authCommand: "claude auth login",
    });
    expect(classifyAgentCliError("Please run /login · API Error: 401 Invalid authentication credentials", "claude")).toMatchObject({
      agent: "claude",
      category: "unauthenticated",
      authCommand: "claude auth login",
    });
  });

  it("does not mistake Cursor SDK agent resume misses for a missing Cursor CLI", () => {
    expect(classifyAgentCliError(
      "Cursor SDK init failed: Agent agent-5db8305e-086a-4f01-adff-5bfb8420ce32 not found (operation=Agent.resume)",
      "cursor",
    )).toBeNull();
  });
});
