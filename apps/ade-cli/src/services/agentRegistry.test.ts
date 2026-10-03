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
    // Factory ships a Windows installer; the POSIX `curl … | sh` line is a dead
    // end there, and `npm install -g droid` is not Factory's documented install.
    expect(classifyForWindows("'droid.cmd' is not recognized as an internal or external command")).toMatchObject({
      agent: "droid",
      displayName: "Factory Droid",
      category: "missing",
      installCommand: `powershell.exe -NoProfile -Command "irm https://app.factory.ai/cli/windows | iex"`,
      authCommand: "droid",
    });
    expect(classifyForWindows("spawn claude ENOENT")).toMatchObject({
      agent: "claude",
      category: "missing",
      installCommand: `powershell.exe -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"`,
      authCommand: "claude auth login",
    });
  });

  it("takes every shipped provider's commands from the one remediation table", async () => {
    // `providerRemediation.ts` owns the vendor strings; this registry only wraps
    // them for the shell it hands them to. A row that drifts from the table is
    // the bug this test exists to catch — a Windows user was told to run
    // `npm install -g @anthropic-ai/claude-code` on one screen and Anthropic's
    // PowerShell installer on another.
    for (const platform of ["darwin", "win32"] as const) {
      setPlatform(platform);
      vi.resetModules();
      const [{ AGENT_CLI_REGISTRY }, { resolveProviderRemediation }] = await Promise.all([
        import("./agentRegistry"),
        import("../../../desktop/src/shared/providerRemediation"),
      ]);
      for (const provider of ["claude", "codex", "cursor", "droid", "opencode", "pi"] as const) {
        const row = AGENT_CLI_REGISTRY.find((entry) => entry.agent === provider);
        const shared = resolveProviderRemediation(provider, platform);
        expect(row?.authCommand).toBe(shared.loginCommand);
        expect(row?.installCommand).toContain(shared.installCommand ?? "");
      }
    }
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

  it("recognizes Pi provider credential failures and keeps its native login command", () => {
    expect(classifyAgentCliError("No API key found for openai", "pi")).toMatchObject({
      agent: "pi",
      displayName: "Pi",
      category: "unauthenticated",
      authCommand: "pi",
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

  // A missing CLI is the binary itself failing to start. The harness's own
  // "not found" for a slash command, a session, a model or a file, and a bare
  // 403, must never send the user to reinstall or sign in again.
  it.each([
    ["opencode", "Command not found: ship"],
    ["opencode", "OpenCode: model not found"],
    ["opencode", "ENOENT: no such file or directory, open '/tmp/lane/notes.md'"],
    ["pi", "Pi session \"abc\" was not found in the authorized session directory."],
    ["opencode", "403 Forbidden: insufficient balance"],
    ["codex", "Error on line 401 of the config"],
    // A harness that answers an unknown slash command named like the binary,
    // a foreign executable, and a bare non-command "not found" are not missing
    // CLIs and must not send the user to reinstall.
    ["opencode", "Command not found: opencode"],
    ["opencode", "spawn git ENOENT"],
    ["opencode", "git is not recognized as an internal or external command"],
  ])("does not classify %s's %j as a CLI problem", (agent, message) => {
    expect(classifyAgentCliError(message, agent)).toBeNull();
  });

  it.each([
    ["opencode", "zsh: command not found: opencode"],
    ["opencode", "/bin/sh: opencode: command not found"],
    ["opencode", "spawn /opt/homebrew/bin/opencode ENOENT"],
    ["opencode", "OpenCode: not-installed: OpenCode binary could not be found. Install OpenCode or ensure it is on your PATH."],
    ["opencode", 'exec: "opencode": executable file not found in $PATH'],
    ["opencode", "spawn /Users/me/bin/my-opencode-wrapper ENOENT"],
    ["opencode", "spawn C:\\Program Files\\OpenCode\\opencode.exe ENOENT"],
    ["opencode", "'opencode' is not recognized as an internal or external command"],
    ["grok", "Grok was not found on this machine."],
    ["codex", "codex executable not found"],
  ])("classifies %s's %j as a missing CLI", (agent, message) => {
    expect(classifyAgentCliError(message, agent)).toMatchObject({ agent, category: "missing" });
  });

  it("does not mistake Cursor SDK agent resume misses for a missing Cursor CLI", () => {
    expect(classifyAgentCliError(
      "Cursor SDK init failed: Agent agent-5db8305e-086a-4f01-adff-5bfb8420ce32 not found (operation=Agent.resume)",
      "cursor",
    )).toBeNull();
  });
});
