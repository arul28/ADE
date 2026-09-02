import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCommandLine } from "../../../shared/shell";
import {
  buildPtyContinuationLaunchFields,
  buildOpenCodeReplayResumeLaunchCommand,
  buildTrackedCliLaunchCommand,
  buildTrackedCliResumeLaunchCommand,
  buildTrackedCliResumeCommand,
  buildTrackedCliStartupCommand,
  buildOpenCodeReplayResumeCommand,
  defaultTrackedCliStartupCommand,
  deriveTrackedCliInitialInputSessionMeta,
  mergeContinuationLaunch,
  resolveCleanShellLaunchFields,
  resolvePiCliModelForLaunch,
  piThinkingFlags,
  piSdkToolPolicyForPermissionMode,
  piToolsForPermissionMode,
  piToolFlags,
  validateLaunchProfilePermissionMode,
  withOpenCodeAdeInstructions,
  resolveTrackedCliResumeCommand,
  withClaudeSessionIdInCommandLine,
  withCodexNoAltScreen,
} from "./cliLaunch";
import { ADE_CLI_AGENT_GUIDANCE } from "../../../shared/adeCliGuidance";
import { ADE_AGENT_SKILLS_DIRS_ENV } from "../../../shared/agentSkillRoots";
import { GROK_CLAUDE_MARKER_OVERRIDE_ENV } from "../../../shared/grokSupervision";
import type { AgentChatPermissionMode, TerminalSessionSummary } from "../../../shared/types";

const originalPlatform = process.platform;

function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const previousPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: previousPlatform, configurable: true });
  }
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

describe("buildPtyContinuationLaunchFields", () => {
  it("forwards trimmed continuation controls and preserves explicit false fast mode", () => {
    expect(buildPtyContinuationLaunchFields({
      model: "  openai/gpt-5.4  ",
      reasoningEffort: " high ",
      fastMode: false,
      codexFastMode: true,
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    })).toEqual({
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      fastMode: false,
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    });
  });

  it("uses the legacy fast-mode field and omits empty continuation controls", () => {
    expect(buildPtyContinuationLaunchFields({
      model: "  ",
      reasoningEffort: null,
      fastMode: null,
      codexFastMode: true,
      permissionMode: null,
      codexApprovalPolicy: null,
      codexSandbox: null,
      codexConfigSource: null,
    })).toEqual({ fastMode: true });
    expect(buildPtyContinuationLaunchFields(null)).toEqual({});
  });
});

describe("mergeContinuationLaunch", () => {
  it("prefers stored launch choices while filling missing exact controls", () => {
    expect(mergeContinuationLaunch({
      model: "recovered-model",
      reasoningEffort: "high",
      fastMode: true,
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    }, {
      model: " stored-model ",
      reasoningEffort: null,
      fastMode: false,
      permissionMode: null,
      codexApprovalPolicy: null,
      codexSandbox: null,
      codexConfigSource: null,
    })).toMatchObject({
      model: "stored-model",
      reasoningEffort: "high",
      fastMode: false,
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });
  });

  it("does not mix recovered granular Codex controls with a stored coarse permission", () => {
    expect(mergeContinuationLaunch({
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    }, {
      permissionMode: "full-auto",
    })).toMatchObject({
      permissionMode: "full-auto",
      codexApprovalPolicy: null,
      codexSandbox: null,
      codexConfigSource: null,
    });
  });
});

describe("recoverImportedContinuationLaunch", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function loadRecoveryWith(
    list: ReturnType<typeof vi.fn>,
  ): Promise<typeof import("./cliLaunch").recoverImportedContinuationLaunch> {
    vi.stubGlobal("window", {
      ade: {
        externalSessions: { list },
      },
    });
    const module = await import("./cliLaunch");
    return module.recoverImportedContinuationLaunch;
  }

  it("deduplicates concurrent lookups and reuses the result within the TTL", async () => {
    let resolveLookup!: (sessions: Array<{ id: string; launch: { model: string } }>) => void;
    const list = vi.fn(() => new Promise<Array<{ id: string; launch: { model: string } }>>((resolve) => {
      resolveLookup = resolve;
    }));
    const recover = await loadRecoveryWith(list);

    const first = recover("codex", "codex", "session-dedup");
    const concurrent = recover("codex", "codex", "session-dedup");
    expect(concurrent).toBe(first);
    expect(list).toHaveBeenCalledTimes(1);

    resolveLookup([{ id: "session-dedup", launch: { model: "gpt-5.6-sol" } }]);
    await expect(first).resolves.toMatchObject({ model: "gpt-5.6-sol" });
    vi.advanceTimersByTime(59_999);

    const withinTtl = recover("codex", "codex", "session-dedup");
    expect(withinTtl).toBe(first);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("starts a new lookup after the cached entry expires", async () => {
    const list = vi.fn(async () => []);
    const recover = await loadRecoveryWith(list);

    const first = recover("codex", "codex", "session-expired");
    vi.advanceTimersByTime(60_000);
    const refreshed = recover("codex", "codex", "session-expired");

    expect(refreshed).not.toBe(first);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recently-used lookup when the cache reaches its bound", async () => {
    const list = vi.fn(async ({ sessionId }: { sessionId: string }) => [{
      id: sessionId,
      launch: null,
    }]);
    const recover = await loadRecoveryWith(list);

    for (let index = 0; index < 101; index += 1) {
      recover("codex", "codex", `session-${index}`);
    }
    expect(list).toHaveBeenCalledTimes(101);

    recover("codex", "codex", "session-1");
    expect(list).toHaveBeenCalledTimes(101);
    recover("codex", "codex", "session-0");
    expect(list).toHaveBeenCalledTimes(102);
  });

  it("does not let an expired request rejection delete its newer replacement", async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (sessions: Array<{ id: string; launch: { model: string } }>) => void;
    const list = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => {
        rejectFirst = reject;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecond = resolve;
      }));
    const recover = await loadRecoveryWith(list);

    const stale = recover("codex", "codex", "session-race");
    vi.advanceTimersByTime(60_000);
    const current = recover("codex", "codex", "session-race");
    expect(current).not.toBe(stale);
    expect(list).toHaveBeenCalledTimes(2);

    rejectFirst(new Error("stale lookup failed"));
    await expect(stale).rejects.toThrow("stale lookup failed");

    expect(recover("codex", "codex", "session-race")).toBe(current);
    expect(list).toHaveBeenCalledTimes(2);
    resolveSecond([{ id: "session-race", launch: { model: "newer-model" } }]);
    await expect(current).resolves.toMatchObject({ model: "newer-model" });
  });

  it("evicts the current failed lookup so the next call retries", async () => {
    let rejectLookup!: (error: Error) => void;
    const list = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => {
        rejectLookup = reject;
      }))
      .mockResolvedValueOnce([]);
    const recover = await loadRecoveryWith(list);

    const failed = recover("codex", "codex", "session-retry");
    rejectLookup(new Error("current lookup failed"));
    await expect(failed).rejects.toThrow("current lookup failed");

    const retry = recover("codex", "codex", "session-retry");
    expect(retry).not.toBe(failed);
    expect(list).toHaveBeenCalledTimes(2);
    await expect(retry).resolves.toBeNull();
  });
});

describe("withCodexNoAltScreen", () => {
  it("returns non-codex commands unchanged", () => {
    expect(withCodexNoAltScreen("claude")).toBe("claude");
    expect(withCodexNoAltScreen("  claude --help  ")).toBe("claude --help");
  });

  it("adds --no-alt-screen to bare 'codex'", () => {
    expect(withCodexNoAltScreen("codex")).toBe("codex --no-alt-screen");
  });

  it("adds --no-alt-screen to 'codex' with arguments", () => {
    expect(withCodexNoAltScreen("codex --sandbox workspace-write")).toBe("codex --no-alt-screen --sandbox workspace-write");
  });

  it("does not add flag if already present", () => {
    expect(withCodexNoAltScreen("codex --no-alt-screen")).toBe("codex --no-alt-screen");
    expect(withCodexNoAltScreen("codex --no-alt-screen --sandbox workspace-write")).toBe("codex --no-alt-screen --sandbox workspace-write");
  });

  it("trims whitespace from input", () => {
    expect(withCodexNoAltScreen("  codex  ")).toBe("codex --no-alt-screen");
  });

  it("does not match codex as a substring", () => {
    expect(withCodexNoAltScreen("mycodex")).toBe("mycodex");
    expect(withCodexNoAltScreen("codex-fork --arg")).toBe("codex-fork --arg");
  });
});

describe("withClaudeSessionIdInCommandLine", () => {
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";

  it("injects the flag for a bare claude token", () => {
    expect(withClaudeSessionIdInCommandLine("claude --model sonnet", sessionId))
      .toBe(`claude --session-id ${sessionId} --model sonnet`);
  });

  it("injects the flag after env-var prefixes", () => {
    expect(withClaudeSessionIdInCommandLine("FOO=1 claude --model sonnet", sessionId))
      .toBe(`FOO=1 claude --session-id ${sessionId} --model sonnet`);
  });

  // resolveDirectProviderCommand hands callers an absolute executable, so the
  // startup line and argv must both accept path-shaped invocations or they
  // disagree about the assigned id.
  it("injects the flag for an absolute claude path", () => {
    expect(withClaudeSessionIdInCommandLine("/usr/local/bin/claude --model sonnet", sessionId))
      .toBe(`/usr/local/bin/claude --session-id ${sessionId} --model sonnet`);
  });

  it("injects the flag for a quoted path with spaces", () => {
    expect(withClaudeSessionIdInCommandLine("'/Users/me/my tools/claude' --model sonnet", sessionId))
      .toBe(`'/Users/me/my tools/claude' --session-id ${sessionId} --model sonnet`);
  });

  it("injects the flag for a quoted Windows claude.exe path", () => {
    expect(withClaudeSessionIdInCommandLine("\"C:\\Users\\me\\claude.exe\" --model sonnet", sessionId))
      .toBe(`"C:\\Users\\me\\claude.exe" --session-id ${sessionId} --model sonnet`);
  });

  it("leaves an already-assigned id and non-claude lines alone", () => {
    expect(withClaudeSessionIdInCommandLine(`claude --session-id ${sessionId}`, sessionId))
      .toBe(`claude --session-id ${sessionId}`);
    expect(withClaudeSessionIdInCommandLine("codex --model gpt", sessionId)).toBe("codex --model gpt");
  });
});

describe("defaultTrackedCliStartupCommand", () => {
  it("returns 'claude' for claude provider", () => {
    expect(defaultTrackedCliStartupCommand("claude")).toBe("claude");
  });

  it("returns 'codex --no-alt-screen' for codex provider", () => {
    expect(defaultTrackedCliStartupCommand("codex")).toBe("codex --no-alt-screen");
  });

  it("returns launch binaries for the other tracked CLI providers", () => {
    expect(defaultTrackedCliStartupCommand("cursor")).toBe("cursor-agent --model auto");
    expect(defaultTrackedCliStartupCommand("droid")).toBe("droid");
    expect(defaultTrackedCliStartupCommand("opencode")).toBe("opencode");
    expect(defaultTrackedCliStartupCommand("pi")).toBe("pi");
  });

  it("returns launch binaries for the ACP providers", () => {
    expect(defaultTrackedCliStartupCommand("qwen")).toBe("qwen");
    expect(defaultTrackedCliStartupCommand("kimi")).toBe("kimi");
    expect(defaultTrackedCliStartupCommand("grok")).toBe("grok --no-alt-screen");
    expect(defaultTrackedCliStartupCommand("copilot")).toBe("copilot --no-alt-screen");
  });
});

describe("ACP CLI providers", () => {
  it("assigns a Qwen session id and keeps --yolo off the approval-mode flag", () => {
    const launch = withProcessPlatform("darwin", () => buildTrackedCliLaunchCommand({
      provider: "qwen",
      permissionMode: "full-auto",
      sessionId: "11111111-2222-3333-4444-555555555555",
      model: "qwen/qwen3-coder-plus",
      initialPrompt: "Fix the failing test.",
    }));
    expect(launch.command).toBe("qwen");
    expect(launch.assignedSessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(launch.args).toContain("--session-id");
    expect(launch.args).toEqual(expect.arrayContaining(["-m", "qwen3-coder-plus"]));
    expect(launch.args).toEqual(expect.arrayContaining(["--approval-mode", "yolo"]));
    expect(launch.args).not.toContain("--yolo");
    // POSIX keeps the prompt in argv; the guidance blob stays off the shell line.
    expect(launch.args).toEqual(expect.arrayContaining(["-i", "Fix the failing test."]));
    expect(launch.startupCommand).not.toContain("--append-system-prompt");
    expect(launch.initialInput).toBeUndefined();
  });

  it("moves the Qwen prompt onto the PTY on Windows", () => {
    const launch = withProcessPlatform("win32", () => buildTrackedCliLaunchCommand({
      provider: "qwen",
      permissionMode: "default",
      initialPrompt: "Fix the failing test.",
    }));
    expect(launch.args).not.toContain("-i");
    expect(launch.initialInput).toBe("Fix the failing test.");
    expect(launch.initialInputDelayMs).toBe(750);
  });

  it("gives Kimi no argv prompt and no assigned session id", () => {
    const launch = withProcessPlatform("darwin", () => buildTrackedCliLaunchCommand({
      provider: "kimi",
      permissionMode: "plan",
      sessionId: "11111111-2222-3333-4444-555555555555",
      model: "moonshot/k3",
      initialPrompt: "Review this lane.",
    }));
    expect(launch.command).toBe("kimi");
    // `-m` takes a namespaced alias, so the registry prefix is replaced, not dropped.
    expect(launch.args).toEqual(["-m", "kimi-code/k3", "--plan"]);
    expect(launch.assignedSessionId).toBeUndefined();
    expect(launch.startupCommand).not.toContain("Review this lane.");
    expect(launch.initialInput).toBe("Review this lane.");
    expect(launch.initialInputDelayMs).toBe(750);
  });

  it("assigns a Grok session with -s and never passes --worktree", () => {
    const launch = withProcessPlatform("darwin", () => buildTrackedCliLaunchCommand({
      provider: "grok",
      permissionMode: "edit",
      sessionId: "11111111-2222-3333-4444-555555555555",
      model: "xai/grok-4-6",
      reasoningEffort: "ultracode",
      initialPrompt: "Ship it.",
    }));
    expect(launch.command).toBe("grok");
    expect(launch.args).toEqual(expect.arrayContaining(["-s", "11111111-2222-3333-4444-555555555555"]));
    expect(launch.args).toEqual(expect.arrayContaining(["-m", "grok-4-6"]));
    // ADE's ladder runs past Grok's, so `ultracode` lands on its top tier.
    expect(launch.args).toEqual(expect.arrayContaining(["--reasoning-effort", "xhigh"]));
    expect(launch.args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
    expect(launch.args).not.toContain("-w");
    expect(launch.args).not.toContain("--worktree");
    expect(launch.args.at(-1)).toBe("Ship it.");
    expect(launch.startupCommand).not.toContain("--rules");
    // Both halves of the neutralization, on the tracked CLI too: the flag only
    // overrides `~/.grok/config.toml`, and the marker only cancels the Claude
    // settings import. Neither works alone.
    expect(launch.env?.[GROK_CLAUDE_MARKER_OVERRIDE_ENV]).toBe("1");
    expect(launch.args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
  });

  it("carries the Grok claude-import kill switch on resume as well as on launch", () => {
    // A resumed TUI re-reads the user's Claude settings on start, so a resume
    // that dropped the variable would change the chat's posture on reattach.
    const resumed = buildTrackedCliResumeLaunchCommand({
      provider: "grok",
      targetKind: "session",
      targetId: "11111111-2222-3333-4444-555555555555",
      launch: { permissionMode: "default" },
    });
    expect(resumed.env?.[GROK_CLAUDE_MARKER_OVERRIDE_ENV]).toBe("1");
    expect(resumed.args).toEqual(expect.arrayContaining(["--permission-mode", "default"]));
  });

  it("assigns a Copilot session through --resume and maps plan to tool denials", () => {
    const launch = withProcessPlatform("darwin", () => buildTrackedCliLaunchCommand({
      provider: "copilot",
      permissionMode: "plan",
      sessionId: "11111111-2222-3333-4444-555555555555",
      model: "github-copilot/gpt-5.4",
      initialPrompt: "Plan the change.",
    }));
    expect(launch.command).toBe("copilot");
    expect(launch.assignedSessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(launch.args).toContain("--resume=11111111-2222-3333-4444-555555555555");
    expect(launch.args).toEqual(expect.arrayContaining(["--model", "gpt-5.4"]));
    expect(launch.args).toEqual(expect.arrayContaining(["--deny-tool=write", "--deny-tool=shell"]));
    expect(launch.args).toEqual(expect.arrayContaining(["-i", "Plan the change."]));
  });

  it("rejects the permission modes each ACP provider has no mapping for", () => {
    expect(() => validateLaunchProfilePermissionMode("copilot", "auto")).toThrow(/GitHub Copilot/u);
    expect(() => validateLaunchProfilePermissionMode("kimi", "auto")).toThrow(/Kimi/u);
    expect(() => validateLaunchProfilePermissionMode("qwen", "config-toml")).toThrow(/qwen/u);
    expect(() => validateLaunchProfilePermissionMode("grok", "config-toml")).toThrow(/grok/u);
    // Both providers with a native auto tier accept it.
    expect(() => validateLaunchProfilePermissionMode("qwen", "auto")).not.toThrow();
    expect(() => validateLaunchProfilePermissionMode("grok", "auto")).not.toThrow();
  });

  it("never emits an assign-at-launch session id on an ACP resume", () => {
    const resumeMetadata = (provider: "qwen" | "kimi" | "grok" | "copilot") => ({
      provider,
      targetKind: "session" as const,
      targetId: "11111111-2222-3333-4444-555555555555",
      launch: { permissionMode: "default" as const },
    });
    const qwen = buildTrackedCliResumeLaunchCommand(resumeMetadata("qwen"));
    expect(qwen.args).not.toContain("--session-id");
    expect(qwen.args).toEqual(expect.arrayContaining(["--resume", "11111111-2222-3333-4444-555555555555"]));

    const kimi = buildTrackedCliResumeLaunchCommand(resumeMetadata("kimi"));
    expect(kimi.args).toEqual(expect.arrayContaining(["-S", "11111111-2222-3333-4444-555555555555"]));

    const grok = buildTrackedCliResumeLaunchCommand(resumeMetadata("grok"));
    expect(grok.args).not.toContain("-s");
    expect(grok.args).toEqual(expect.arrayContaining(["--resume", "11111111-2222-3333-4444-555555555555"]));

    const copilot = buildTrackedCliResumeLaunchCommand(resumeMetadata("copilot"));
    expect(copilot.args).toContain("--resume=11111111-2222-3333-4444-555555555555");
  });

  it("continues the most recent ACP session when no target id was captured", () => {
    for (const provider of ["qwen", "grok", "copilot"] as const) {
      const launch = buildTrackedCliResumeLaunchCommand({
        provider,
        targetKind: "session",
        targetId: null,
        launch: { permissionMode: "default" },
      });
      expect(launch.args).toContain("--continue");
    }
    const kimi = buildTrackedCliResumeLaunchCommand({
      provider: "kimi",
      targetKind: "session",
      targetId: null,
      launch: { permissionMode: "default" },
    });
    // Kimi spells continue with a lowercase short flag, not `--continue`.
    expect(kimi.args).toContain("-c");
  });
});

describe("orchestration CLI launch policy", () => {
  it("forces orchestration roles to full-auto for every tracked CLI runtime", () => {
    const claude = buildTrackedCliLaunchCommand({
      provider: "claude",
      permissionMode: "plan",
      orchestrationRole: "worker",
    });
    expect(claude.args).toContain("--dangerously-skip-permissions");
    expect(claude.args).not.toEqual(expect.arrayContaining(["--permission-mode", "plan"]));

    const codex = buildTrackedCliLaunchCommand({
      provider: "codex",
      permissionMode: "plan",
      orchestrationRole: "worker",
    });
    expect(codex.args).toEqual(expect.arrayContaining(["--dangerously-bypass-approvals-and-sandbox"]));
    expect(codex.args).not.toEqual(expect.arrayContaining(["--sandbox", "read-only"]));

    const cursor = buildTrackedCliLaunchCommand({
      provider: "cursor",
      permissionMode: "plan",
      orchestrationRole: "validator",
    });
    expect(cursor.args).toContain("--force");
    expect(cursor.args).not.toEqual(expect.arrayContaining(["--mode", "plan"]));

    const droid = buildTrackedCliLaunchCommand({
      provider: "droid",
      permissionMode: "plan",
      orchestrationRole: "worker",
    });
    expect(droid.startupCommand).toContain('\\"autonomyLevel\\":\\"high\\"');
    expect(droid.startupCommand).not.toContain('\\"interactionMode\\":\\"spec\\"');

    const opencode = buildTrackedCliLaunchCommand({
      provider: "opencode",
      permissionMode: "plan",
      orchestrationRole: "validator",
    });
    expect(opencode.args).not.toEqual(expect.arrayContaining(["--agent", "plan"]));
    expect(opencode.env?.OPENCODE_CONFIG_CONTENT).toContain('"permission":"allow"');
  });
});

describe("resolveCleanShellLaunchFields", () => {
  it("starts zsh without reading user startup files", () => {
    expect(resolveCleanShellLaunchFields({ platform: "darwin", shell: "/bin/zsh" })).toEqual({
      command: "/bin/zsh",
      args: ["-f"],
      env: { ZDOTDIR: "/var/empty" },
    });
  });

  it("starts bash without profile or rc files", () => {
    expect(resolveCleanShellLaunchFields({ platform: "linux", shell: "/bin/bash" })).toEqual({
      command: "/bin/bash",
      args: ["--noprofile", "--norc"],
      env: { BASH_ENV: "" },
    });
  });

  it("starts Windows PowerShell without profile scripts", () => {
    expect(resolveCleanShellLaunchFields({ platform: "win32", comSpec: "cmd.exe" })).toEqual({
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile"],
    });
  });

  it("honors native PowerShell 7, cmd, and Git Bash shell selections", () => {
    expect(resolveCleanShellLaunchFields({
      platform: "win32",
      shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    })).toEqual({
      command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      args: ["-NoLogo", "-NoProfile"],
    });
    expect(resolveCleanShellLaunchFields({ platform: "win32", shell: "cmd.exe" })).toEqual({
      command: "cmd.exe",
      args: ["/d"],
    });
    expect(resolveCleanShellLaunchFields({
      platform: "win32",
      shell: '"C:\\Program Files\\Git\\bin\\bash.exe"',
    })).toEqual({
      command: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--noprofile", "--norc"],
      env: { BASH_ENV: "" },
    });
    expect(resolveCleanShellLaunchFields({
      platform: "win32",
      shell: "D:\\PortableGit\\usr\\bin\\bash.exe",
    })).toEqual({
      command: "D:\\PortableGit\\usr\\bin\\bash.exe",
      args: ["--noprofile", "--norc"],
      env: { BASH_ENV: "" },
    });
  });

  it("does not treat WSL or an ambiguous bash alias as a native Windows shell", () => {
    expect(resolveCleanShellLaunchFields({ platform: "win32", shell: "wsl.exe" })).toEqual({
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile"],
    });
    expect(resolveCleanShellLaunchFields({ platform: "win32", shell: "bash.exe" })).toEqual({
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile"],
    });
    for (const shell of [
      "\\\\wsl$\\Ubuntu\\usr\\bin\\bash.exe",
      "\\\\wsl.localhost\\Ubuntu\\usr\\bin\\bash.exe",
    ]) {
      expect(resolveCleanShellLaunchFields({ platform: "win32", shell })).toEqual({
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile"],
      });
    }
  });
});

describe("piSdkToolPolicyForPermissionMode", () => {
  it("keeps plan mode read-only and states it, rather than leaving it inferred", () => {
    const plan = piSdkToolPolicyForPermissionMode("plan");
    expect(plan.tools).toEqual(["read"]);
    expect(plan.approvalTools).toEqual([]);
    // Chat gates real capabilities (extension loading) on this flag, so it must
    // not be re-derived from the tool list.
    expect(plan.readOnly).toBe(true);
  });

  it("offers the write tools behind an approval card for the ask-first modes", () => {
    for (const mode of ["default", "auto", "config-toml"] as const) {
      const policy = piSdkToolPolicyForPermissionMode(mode);
      expect(policy.tools).toEqual(["read", "bash", "edit", "write"]);
      expect(policy.approvalTools).toEqual(["bash", "edit", "write"]);
      expect(policy.readOnly).toBe(false);
    }
  });

  it("pre-approves the modes the user already widened, and never gates a tool it withholds", () => {
    expect(piSdkToolPolicyForPermissionMode("full-auto")).toMatchObject({ approvalTools: [], readOnly: false });
    expect(piSdkToolPolicyForPermissionMode("edit")).toMatchObject({
      tools: ["read", "edit", "write"],
      approvalTools: [],
    });
    for (const mode of ["default", "auto", "config-toml", "edit", "plan", "full-auto"] as const) {
      const policy = piSdkToolPolicyForPermissionMode(mode);
      expect(policy.approvalTools.every((tool) => policy.tools.includes(tool))).toBe(true);
    }
  });

  it("lets a Pi terminal defer to Pi's own settings, which the picker already offers", () => {
    // The picker lists config-toml for Pi, so rejecting it here made a listed
    // mode fail the launch.
    expect(() => validateLaunchProfilePermissionMode("pi", "config-toml")).not.toThrow();
    expect(piToolFlags("config-toml")).toEqual([]);
    expect(piToolFlags("full-auto")).toEqual(["--tools", "read,bash,edit,write"]);
    // Pi has no equivalent of Claude's auto, so that one still fails loudly.
    expect(() => validateLaunchProfilePermissionMode("pi", "auto")).toThrow(/not supported for Pi/u);
  });

  it("marks exactly the modes that may load extensions, since extension tools cannot be gated", () => {
    // Chat loads Pi extensions only where the mode grants its tools outright.
    // A read-only or ask-first mode makes a promise an ungated extension tool
    // would break, so those must stay identifiable from the policy alone.
    const grantsOutright = (mode: Parameters<typeof piSdkToolPolicyForPermissionMode>[0]) => {
      const policy = piSdkToolPolicyForPermissionMode(mode);
      return !policy.readOnly && policy.approvalTools.length === 0;
    };
    expect(grantsOutright("edit")).toBe(true);
    expect(grantsOutright("full-auto")).toBe(true);
    expect(grantsOutright("plan")).toBe(false);
    for (const mode of ["default", "auto", "config-toml"] as const) {
      expect(grantsOutright(mode)).toBe(false);
    }
  });

  it("leaves the tracked-terminal mapping stricter, because a CLI has no approval gate", () => {
    expect(piToolsForPermissionMode("default")).toEqual(["read"]);
    expect(piSdkToolPolicyForPermissionMode("default").tools).toContain("bash");
  });
});

describe("buildTrackedCliStartupCommand", () => {
  it("preserves Pi's native max thinking level", () => {
    expect(piThinkingFlags("max")).toEqual(["--thinking", "max"]);
    expect(piThinkingFlags("ultracode")).toEqual(["--thinking", "xhigh"]);
  });

  describe("claude provider", () => {
    it("adds --dangerously-skip-permissions for full-auto", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "full-auto" });
      expect(command).toContain("--dangerously-skip-permissions");
      expect(command).not.toContain("--append-system-prompt");
    });

    it("adds --permission-mode acceptEdits for edit", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "edit" });
      expect(command).toContain("--permission-mode acceptEdits");
      expect(command).not.toContain("--append-system-prompt");
    });

    it("adds --permission-mode default for default", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "default" });
      expect(command).toContain("--permission-mode default");
      expect(command).not.toContain("--append-system-prompt");
    });

    it("adds --permission-mode auto for Claude auto", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "auto" });
      expect(command).toContain("--permission-mode auto");
      expect(command).not.toContain("--append-system-prompt");
    });

    it("adds --permission-mode plan for plan (else branch)", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "plan" });
      expect(command).toContain("--permission-mode plan");
      expect(command).not.toContain("--append-system-prompt");
    });

    it("rejects config-toml before building unsupported Claude commands", () => {
      expect(() => buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "config-toml" })).toThrow(
        "config-toml is only supported for Codex",
      );
    });

    it("uses Claude's system-prompt hook for ADE guidance", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
      });
      expect(launch.command).toBe("claude");
      expect(launch.args).toEqual(expect.arrayContaining([
        "--session-id",
        "00000000-0000-0000-0000-000000000001",
        "--append-system-prompt",
        ADE_CLI_AGENT_GUIDANCE,
        "--permission-mode",
        "default",
      ]));
      expect(launch.startupCommand).not.toContain("--append-system-prompt");
      expect(launch.args).toContain("--append-system-prompt");
      expect(launch.args).toContain(ADE_CLI_AGENT_GUIDANCE);
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]).toContain("agent-skills");
    });

    it("keeps the Claude prompt in argv on POSIX and off the command line on Windows", () => {
      const args = {
        provider: "claude" as const,
        permissionMode: "default" as const,
        initialPrompt: "Ship the %USERPROFILE% fix\nand explain it",
      };

      withProcessPlatform("darwin", () => {
        const launch = buildTrackedCliLaunchCommand(args);
        expect(launch.args).toContain(args.initialPrompt);
        expect(launch.initialInput).toBeUndefined();
      });

      // On Windows a bare `claude` that resolves to a shim is spawned through
      // `cmd.exe /d /s /c "…"`, which expands `%USERPROFILE%`, flattens the
      // newline to a space, and hard-fails past 8191 characters. The ~2KB
      // guidance blob already eats a quarter of that budget.
      withProcessPlatform("win32", () => {
        const launch = buildTrackedCliLaunchCommand(args);
        expect(launch.args).not.toContain(args.initialPrompt);
        expect(launch.startupCommand).not.toContain("Ship the");
        expect(launch.initialInput).toBe(args.initialPrompt);
        expect(launch.initialInputDelayMs).toBe(750);
      });
    });

    it("keeps Claude Code in interactive TUI mode", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
      });
      expect(launch.command).toBe("claude");
      expect(launch.args).not.toContain("--print");
      expect(launch.args).not.toContain("-p");
      expect(launch.args).not.toContain("--output-format");
      expect(launch.args).not.toContain("stream-json");
      expect(launch.startupCommand).not.toContain("--print");
      expect(launch.startupCommand).not.toContain("--output-format");
      expect(launch.startupCommand).not.toContain("stream-json");
    });

    it("passes an optional Claude Code model alias for fresh launches", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
        model: "anthropic/claude-opus-4-8",
      });
      expect(launch.args).toEqual(expect.arrayContaining(["--model", "claude-opus-4-8"]));
      expect(launch.startupCommand).toContain("--model");
      expect(launch.startupCommand).toContain("claude-opus-4-8");
    });

    it("launches Claude Opus 5 with its supported effort and fast-mode settings", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
        model: "anthropic/claude-opus-5",
        reasoningEffort: "high",
        fastMode: true,
      });

      expect(launch.args).toEqual(expect.arrayContaining([
        "--model",
        "claude-opus-5",
        "--effort",
        "high",
      ]));
      const settingsIndex = launch.args.indexOf("--settings");
      expect(launch.args.slice(settingsIndex, settingsIndex + 2)).toEqual([
        "--settings",
        JSON.stringify({ fastMode: true }),
      ]);
      expect(launch.startupCommand).toContain("--model claude-opus-5");
      expect(launch.startupCommand).toContain("--effort high");
      expect(launch.startupCommand).toContain('--settings "{\\"fastMode\\":true}"');
    });

    it("passes Claude fast mode as per-session settings for fresh launches", () => {
      const fastLaunch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
        model: "anthropic/claude-opus-4-8",
        fastMode: true,
      });
      expect(fastLaunch.args).toEqual(expect.arrayContaining([
        "--settings",
        JSON.stringify({ fastMode: true }),
      ]));
      expect(fastLaunch.startupCommand).toContain("fastMode");
      expect(fastLaunch.startupCommand).toContain("true");

      const standardLaunch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
        model: "anthropic/claude-opus-4-8",
        fastMode: false,
      });
      expect(standardLaunch.args).toEqual(expect.arrayContaining([
        "--settings",
        JSON.stringify({ fastMode: false }),
      ]));
      expect(standardLaunch.startupCommand).toContain("fastMode");
      expect(standardLaunch.startupCommand).toContain("false");
    });

    it("translates Claude ultracode to xhigh effort plus per-session settings", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
        model: "anthropic/claude-fable-5-1",
        reasoningEffort: "ultracode",
        fastMode: true,
      });

      expect(launch.args).toEqual(expect.arrayContaining([
        "--model",
        "claude-fable-5-1",
        "--effort",
        "xhigh",
        "--settings",
        JSON.stringify({ fastMode: true, ultracode: true }),
      ]));
      expect(launch.args).not.toEqual(expect.arrayContaining(["--effort", "ultracode"]));
      expect(launch.startupCommand).toContain("--model claude-fable-5-1");
      expect(launch.startupCommand).toContain("--effort xhigh");
      expect(launch.startupCommand).toContain("ultracode");
    });
  });

  describe("codex provider", () => {
    it("adds the dangerous bypass flag for full-auto", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "full-auto" });
      expect(command).toContain("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox");
      expect(command).not.toContain("control plane for ADE state");
    });

    it("adds supported workspace-write defaults for default", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "default" });
      expect(command).toContain("codex --no-alt-screen --sandbox workspace-write --ask-for-approval on-request");
      expect(command).not.toContain("mcp_servers.linear");
      expect(command).not.toContain("control plane for ADE state");
    });

    it("does not synthesize Codex MCP server config for any permission preset", () => {
      const modes = ["default", "plan", "edit", "full-auto", "config-toml"] as const;
      for (const permissionMode of modes) {
        const launch = buildTrackedCliLaunchCommand({ provider: "codex", permissionMode });
        expect(launch.args.join("\n")).not.toContain("mcp_servers.");
        expect(launch.startupCommand).not.toContain("mcp_servers.");
      }
    });

    it("injects the signed Computer Use MCP client only when main selects it", () => {
      const command = "/Users/test/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
      const launch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
        codexComputerUse: { command, args: ["mcp"] },
      });
      expect(launch.args).toEqual(expect.arrayContaining([
        "-c",
        `mcp_servers.computer_use.command=${JSON.stringify(command)}`,
        "-c",
        'mcp_servers.computer_use.args=["mcp"]',
        "-c",
        "mcp_servers.computer_use.enabled=true",
      ]));
      expect(launch.startupCommand).toContain("mcp_servers.computer_use.command");
      expect(launch.startupCommand).not.toContain("mcp_servers.computer-use");

      const resumed = buildTrackedCliResumeCommand({
        provider: "codex",
        targetKind: "thread",
        targetId: "thread-cu",
        launch: { permissionMode: "default" },
      }, { codexComputerUse: { command, args: ["mcp"] } });
      expect(resumed).toContain("mcp_servers.computer_use.command");
      expect(resumed).toContain("resume thread-cu");
    });

    it("keeps empty Codex CLI launches waiting for the next user task", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "codex", permissionMode: "default" });

      expect(launch.initialInput).toContain("ADE session guidance");
      expect(launch.initialInput).toContain("wait for the user's next instruction before taking action");
      expect(launch.initialInput).not.toContain("User prompt:");
    });

    it("passes no extra flags for config-toml", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "config-toml" });
      expect(command).toContain("codex --no-alt-screen");
      expect(command).not.toContain("--full-auto");
      expect(command).not.toContain("mcp_servers.linear");
      expect(command).not.toContain("control plane for ADE state");
    });

    it("adds untrusted approval and workspace-write sandbox for edit", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "edit" });
      expect(command).toContain("codex --no-alt-screen --sandbox workspace-write --ask-for-approval untrusted");
      expect(command).not.toContain("control plane for ADE state");
    });

    it("adds on-request approval and read-only sandbox for plan", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "plan" });
      expect(command).toContain("codex --no-alt-screen --sandbox read-only --ask-for-approval on-request");
      expect(command).not.toContain("control plane for ADE state");
    });

    it("uses the selected lane worktree to seed skill roots", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
        initialPrompt: "Check this lane.",
        laneWorktreePath: "/repo/.ade/worktrees/chat-lane",
      });

      expect(launch.initialInput).toContain("/repo/.ade/worktrees/chat-lane/.claude/skills");
      expect(launch.initialInput).toContain("/repo/.ade/worktrees/chat-lane/.agents/skills");
      expect(launch.initialInput).toContain("/repo/.ade/worktrees/chat-lane/apps/desktop/resources/agent-skills");
      expect(launch.startupCommand).not.toContain("/repo/.ade/worktrees/chat-lane/.claude/skills");
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]?.startsWith(
        "/repo/.ade/worktrees/chat-lane/.cursor/skills",
      )).toBe(true);
    });

    it("submits the first user prompt without dropping ADE guidance, model, or reasoning effort", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "plan",
        model: "gpt-5.4",
        reasoningEffort: "medium",
        initialPrompt: "Fix the failing Work tests.",
      });
      expect(launch.args).toEqual(expect.arrayContaining([
        "--model",
        "gpt-5.4",
        "-c",
        "model_reasoning_effort=\"medium\"",
      ]));
      expect(launch.args.join("\n")).not.toContain("ADE session guidance");
      expect(launch.initialInput).toContain("ADE session guidance");
      expect(launch.initialInput).toContain("Start working on that user prompt immediately.");
      expect(launch.initialInput).not.toContain("wait for the user's next instruction before taking action");
      expect(launch.initialInput).toContain("User prompt:");
      expect(launch.initialInput).toContain("Fix the failing Work tests.");
      expect(launch.startupCommand).toContain("model_reasoning_effort");
      expect(launch.startupCommand).not.toContain("Fix the failing Work tests.");
    });

    it("derives initial metadata from the user task inside ADE guidance", () => {
      const meta = deriveTrackedCliInitialInputSessionMeta({
        provider: "codex",
        title: "Codex",
        initialInput: [
          "ADE session guidance. Treat this as operating guidance for the CLI session.",
          "Start working on that user prompt immediately.",
          "",
          "User prompt:",
          "You are working in ADE lane:",
          "/repo/.ade/worktrees/context-iphone-17-simulator",
          "",
          "Edits and mutating commands must stay inside that worktree.",
          "",
          "The user is debugging the ADE iOS Work chat scroll/layout bugs.",
        ].join("\n"),
      });

      expect(meta.goal).toBe("The user is debugging the ADE iOS Work chat scroll/layout bugs.");
      expect(meta.title).toBe("The user is debugging the ADE iOS Work chat scroll/layout bugs");
      expect(meta.promptTitle).toBe("The user is debugging the ADE iOS Work chat scroll/layout bugs");
    });

    it("derives metadata from ADE lane guidance without a blank separator", () => {
      const meta = deriveTrackedCliInitialInputSessionMeta({
        provider: "codex",
        title: "Codex",
        initialInput: [
          "You are working in ADE lane:",
          "/repo/.ade/worktrees/context-iphone-17-simulator",
          "Redesign the ADE mobile project hub.",
        ].join("\n"),
      });

      expect(meta.goal).toBe("Redesign the ADE mobile project hub.");
      expect(meta.title).toBe("Redesign the ADE mobile project hub");
      expect(meta.promptTitle).toBe("Redesign the ADE mobile project hub");
    });

    it("does not unwrap ordinary prompts that mention ADE guidance text", () => {
      const meta = deriveTrackedCliInitialInputSessionMeta({
        provider: "codex",
        title: "Codex",
        initialInput: "Explain why docs say Start working on that user prompt immediately.",
      });

      expect(meta.goal).toBe("Explain why docs say Start working on that user prompt immediately.");
      expect(meta.title).toBe("Explain why docs say Start working on that user prompt immediately");
      expect(meta.promptTitle).toBe("Explain why docs say Start working on that user prompt immediately");
    });

    it("passes explicit Codex service tier overrides for fast mode", () => {
      const fastLaunch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
        fastMode: true,
      });
      expect(fastLaunch.args).toEqual(expect.arrayContaining([
        "-c",
        "service_tier=\"fast\"",
        "-c",
        "features.fast_mode=true",
      ]));
      expect(fastLaunch.startupCommand).toContain("service_tier");
      expect(fastLaunch.startupCommand).toContain("features.fast_mode");

      const defaultLaunch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
        fastMode: false,
      });
      expect(defaultLaunch.args).toEqual(expect.arrayContaining([
        "-c",
        "service_tier=\"default\"",
      ]));
      expect(defaultLaunch.args).not.toContain("features.fast_mode=true");

      const inheritedLaunch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
      });
      expect(inheritedLaunch.args.join("\n")).not.toContain("service_tier");
    });

    it("keeps legacy Codex migration-prompt models on the argv prompt path", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
        model: "gpt-5.3-codex",
        initialPrompt: "Use the legacy model.",
      });
      expect(launch.args.at(-1)).toContain("Use the legacy model.");
      expect(launch.initialInput).toBeUndefined();
    });
  });

  describe("additional CLI providers", () => {
    it("launches Cursor with initial prompts submitted through PTY input", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "plan", model: "cursor-fast", initialPrompt: "Review this lane." });
      expect(launch.command).toBe("cursor-agent");
      expect(launch.args).toEqual(["--mode", "plan", "--model", "cursor-fast"]);
      expect(launch.startupCommand).toContain("cursor-agent --mode plan --model cursor-fast");
      expect(launch.startupCommand).not.toContain("Review this lane.");
      expect(launch.startupCommand).not.toContain("ADE session guidance");
      expect(launch.startupCommand).not.toContain("cursor-agent create-chat");
      expect(launch.startupCommand).not.toContain("--resume");
      expect(launch.initialInput).toContain("ADE session guidance");
      expect(launch.initialInput).toContain("Review this lane.");
      expect(launch.initialInputDelayMs).toBe(750);
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]).toContain("agent-skills");
    });

    it("keeps empty Cursor launches idle instead of submitting ADE guidance as work", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "default", model: "cursor-fast" });
      expect(launch.command).toBe("cursor-agent");
      expect(launch.args).toEqual(["--model", "cursor-fast"]);
      expect(launch.startupCommand).toBe("cursor-agent --model cursor-fast");
      expect(launch.initialInput).toBeUndefined();
      expect(launch.initialInputDelayMs).toBeUndefined();
    });

    it("launches Cursor edit and Ask through Cursor --mode ask", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "edit", model: "cursor-fast" });
      expect(launch.command).toBe("cursor-agent");
      expect(launch.args).toEqual(["--mode", "ask", "--model", "cursor-fast"]);
      expect(launch.startupCommand).toBe("cursor-agent --mode ask --model cursor-fast");
    });

    it("rejects Cursor permissionMode auto rather than passing --mode auto", () => {
      expect(() => validateLaunchProfilePermissionMode("cursor", "auto")).toThrow(
        /permissionMode auto is only supported for Claude/u,
      );
      expect(() => buildTrackedCliLaunchCommand({
        provider: "cursor",
        permissionMode: "auto",
        model: "cursor-fast",
      })).toThrow(/permissionMode auto is only supported for Claude/u);
    });

    it("normalizes Cursor registry model ids and forces full-auto interactive workspaces", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "cursor",
        permissionMode: "full-auto",
        model: "cursor/composer-2.5",
        initialPrompt: "Review this lane.",
      });

      expect(launch.startupCommand).toContain("cursor-agent --force --model composer-2.5");
      expect(launch.startupCommand).not.toContain("--trust");
      expect(launch.startupCommand).not.toContain("--model cursor/composer-2.5");
      expect(launch.args).toEqual(expect.arrayContaining(["--force", "--model", "composer-2.5"]));
      expect(launch.args).not.toContain("--trust");
      expect(launch.args).not.toContain(expect.stringContaining("Review this lane."));
      expect(launch.initialInput).toContain("Review this lane.");
    });

    it("keeps Cursor launch direct on Windows", () => {
      withProcessPlatform("win32", () => {
        const launch = buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "plan", model: "cursor-fast", initialPrompt: "Review this lane." });
        expect(launch.command).toBe("cursor-agent");
        expect(launch.args).toEqual(["--mode", "plan", "--model", "cursor-fast"]);
        expect(launch.initialInput).toContain("Review this lane.");
        expect(launch.initialInputDelayMs).toBe(750);
      });
    });

    // `--continue` means "the most recent session for this directory". Since
    // chat and the tracked CLI share one native Pi store, that could be another
    // terminal's session or an ADE chat's — terminals were silently reopening
    // days-old transcripts. With no captured id, start fresh instead.
    it("resumes Pi only by captured session id, never by --continue", () => {
      const withId = buildTrackedCliResumeLaunchCommand({
        provider: "pi",
        targetKind: "session",
        targetId: "019fecac-13b8-7a10-9f24-c9f3afa33120",
        launch: { permissionMode: "full-auto", model: "pi/xai/grok-4.5" },
      });
      expect(withId.args).toContain("--session");
      expect(withId.args).toContain("019fecac-13b8-7a10-9f24-c9f3afa33120");
      expect(withId.args).not.toContain("--continue");

      const withoutId = buildTrackedCliResumeLaunchCommand({
        provider: "pi",
        targetKind: "session",
        targetId: null,
        launch: { permissionMode: "full-auto", model: "pi/xai/grok-4.5" },
      });
      expect(withoutId.args).not.toContain("--continue");
      expect(withoutId.args).not.toContain("--session");
    });

    it("launches Pi with safe model/thinking argv, ADE guidance, and skill environment", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "pi",
        permissionMode: "full-auto",
        model: "pi/openai/gpt-5.4",
        reasoningEffort: "high",
        initialPrompt: "Run the Pi path.",
      });
      expect(launch).toMatchObject({
        command: "pi",
        initialInputDelayMs: 750,
      });
      expect(launch.args).toEqual(expect.arrayContaining([
        "--model", "openai/gpt-5.4", "--thinking", "high", "--append-system-prompt",
      ]));
      expect(launch.args.join("\n")).toContain(ADE_CLI_AGENT_GUIDANCE);
      expect(launch.startupCommand).toBe("pi --model \"openai/gpt-5.4\" --thinking high --tools read,bash,edit,write");
      expect(launch.initialInput).toBe("Run the Pi path.");
      expect(launch.args.join("\n")).toContain("ADE permission policy for this Pi session: full-auto");
      expect(launch.initialInput).not.toContain("--dangerously");
      expect(launch.args).not.toEqual(expect.arrayContaining(["--permission-mode", "full-auto"]));
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]).toContain("agent-skills");
    });

    it("keeps Pi launches direct on Windows and preserves encoded model ids", () => {
      expect(resolvePiCliModelForLaunch(`pi/openrouter/${encodeURIComponent("org/model")}`)).toBe("openrouter/org%2Fmodel");
      withProcessPlatform("win32", () => {
        const launch = buildTrackedCliLaunchCommand({
          provider: "pi",
          permissionMode: "plan",
          model: `pi/openrouter/${encodeURIComponent("org/model")}`,
          reasoningEffort: "medium",
          initialPrompt: "Continue in C:\\Program Files\\ADE's $lane %TEMP% & café",
        });
        expect(launch.command).toBe("pi");
        expect(launch.args.slice(0, 4)).toEqual(["--model", "openrouter/org%2Fmodel", "--thinking", "medium"]);
        expect(launch.args).toContain("--append-system-prompt");
        expect(launch.startupCommand).not.toContain("C:\\Program Files");
        expect(launch.initialInput).toContain("C:\\Program Files\\ADE's $lane %TEMP% & café");
      });
    });

    it("launches Droid as an interactive CLI with model, reasoning, autonomy, guidance, and prompt", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "droid",
        permissionMode: "edit",
        model: "droid/claude-sonnet-5",
        reasoningEffort: "high",
        initialPrompt: "Run the Droid path.",
      });
      expect(launch.command).toBe("/bin/bash");
      expect(launch.args).toEqual(["-lc", launch.startupCommand]);
      expect(launch.startupCommand).toContain("droid --settings \"$ADE_DROID_SETTINGS\"");
      expect(launch.startupCommand).toContain("Run the Droid path.");
      expect(launch.startupCommand).toContain("ADE session guidance");
      expect(launch.startupCommand).toContain("\\\"model\\\":\\\"claude-sonnet-5\\\"");
      expect(launch.startupCommand).toContain("\\\"reasoningEffort\\\":\\\"high\\\"");
      expect(launch.startupCommand).toContain("\\\"autonomyLevel\\\":\\\"low\\\"");
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]).toContain("agent-skills");
      // POSIX carries the prompt in argv, where it round-trips intact.
      expect(launch.initialInput).toBeUndefined();
    });

    it("launches Droid through PowerShell on Windows with the prompt off the command line", () => {
      withProcessPlatform("win32", () => {
        const launch = buildTrackedCliLaunchCommand({
          provider: "droid",
          permissionMode: "edit",
          model: "droid/claude-sonnet-5",
          reasoningEffort: "high",
          initialPrompt: "Run the Droid path.",
        });
        expect(launch.command).toBe("powershell.exe");
        expect(launch.args).toEqual(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", launch.startupCommand]);
        expect(launch.startupCommand).toContain("$env:ADE_DROID_SETTINGS");
        expect(launch.startupCommand).toContain(
          "[System.IO.File]::WriteAllText($env:ADE_DROID_SETTINGS",
        );
        expect(launch.startupCommand).toContain(
          "[System.Text.UTF8Encoding]::new($false)",
        );
        expect(launch.startupCommand).not.toContain("Set-Content");
        expect(launch.startupCommand).toContain("& 'droid' '--settings' $env:ADE_DROID_SETTINGS");
        expect(launch.startupCommand).toContain("\"model\":\"claude-sonnet-5\"");
        // `& 'droid' … '<multi-line>'` reaches a droid.cmd shim truncated at the
        // first newline, and the ADE preamble is always multi-line, so the whole
        // prompt used to be lost. It rides the PTY instead now.
        expect(launch.startupCommand).not.toContain("Run the Droid path.");
        expect(launch.startupCommand).not.toContain("ADE session guidance");
        expect(launch.initialInput).toContain("Run the Droid path.");
        expect(launch.initialInput).toContain("ADE session guidance");
        expect(launch.initialInput).toContain("\n");
        expect(launch.initialInputDelayMs).toBe(750);
      });
    });

    it("launches OpenCode with inline permission config", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "full-auto",
        model: "github-copilot/gpt-5.4",
        initialPrompt: "Use OpenCode.",
      });
      expect(launch.command).toBe("opencode");
      expect(launch.args).toEqual(expect.arrayContaining(["--model", "github-copilot/gpt-5.4", "--prompt"]));
      expect(launch.env?.OPENCODE_CONFIG_CONTENT).toBe("{\"permission\":\"allow\"}");
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]).toContain("agent-skills");
      expect(launch.startupCommand).toContain("OPENCODE_CONFIG_CONTENT=");
      expect(launch.startupCommand).toContain("Use OpenCode.");
    });

    it("launches OpenCode fast mode through the interactive run variant flag", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "full-auto",
        model: "opencode/openai/gpt-5.4",
        reasoningEffort: "high",
        fastMode: true,
        initialPrompt: "Use OpenCode fast mode.",
      });
      expect(launch.command).toBe("opencode");
      // The root TUI is the only launch surface now: `run --interactive`'s
      // bare split-footer read as "a plain terminal with no UI", and the root
      // command has no --variant flag to branch on.
      expect(launch.args).toEqual(expect.arrayContaining([
        "--model",
        "openai/gpt-5.4",
      ]));
      expect(launch.args).not.toContain("--variant");
      // The root command takes the kickoff through --prompt (the positional
      // slot belongs to the project path); the prompt value carries ADE's
      // session-guidance preamble with the user's text inside it.
      expect(launch.args).toContain("--prompt");
      expect(launch.startupCommand).not.toContain("run --interactive");
      expect(launch.startupCommand).toContain("Use OpenCode fast mode.");
    });

    it("keeps reasoning effort out of OpenCode CLI launches (root TUI has no --variant)", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "full-auto",
        model: "opencode/openai/gpt-5.4",
        reasoningEffort: "high",
        fastMode: false,
        initialPrompt: "Use OpenCode high reasoning.",
      });
      // The root command silently drops unknown args, so passing --variant
      // there would be a lie; reasoning effort stays a chat-runtime feature.
      expect(launch.args).not.toContain("--variant");
      expect(launch.startupCommand).not.toContain("run --interactive");
    });

    it("normalizes ADE OpenCode registry model ids before launching the CLI", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "full-auto",
        model: "opencode/opencode/big-pickle",
        initialPrompt: "Use OpenCode.",
      });
      expect(launch.args).toEqual(expect.arrayContaining(["--model", "opencode/big-pickle"]));
      expect(launch.startupCommand).toContain("--model \"opencode/big-pickle\"");
      expect(launch.startupCommand).not.toContain("opencode/opencode/big-pickle");

      const encoded = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "full-auto",
        model: `opencode/lmstudio/${encodeURIComponent("openai/gpt-oss-20b")}`,
        initialPrompt: "Use OpenCode.",
      });
      expect(encoded.args).toEqual(expect.arrayContaining(["--model", "lmstudio/openai/gpt-oss-20b"]));
    });

    it("launches OpenCode config mode without inline permission config", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "config-toml",
        model: "github-copilot/gpt-5.4",
        initialPrompt: "Use OpenCode config.",
      });
      expect(launch.args).toEqual(expect.arrayContaining(["--model", "github-copilot/gpt-5.4", "--prompt"]));
      expect(launch.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(launch.startupCommand).not.toContain("OPENCODE_CONFIG_CONTENT=");
    });

    it("rejects config-toml for providers that do not support it", () => {
      expect(() => buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "config-toml" })).toThrow(
        "config-toml is only supported for Codex and OpenCode",
      );
      expect(() => buildTrackedCliLaunchCommand({ provider: "droid", permissionMode: "config-toml" })).toThrow(
        "config-toml is only supported for Codex and OpenCode",
      );
    });

    it("rejects auto for non-Claude CLI providers", () => {
      expect(() => buildTrackedCliLaunchCommand({ provider: "codex", permissionMode: "auto" })).toThrow(
        "auto is only supported for Claude",
      );
      expect(() => buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "auto" })).toThrow(
        "auto is only supported for Claude",
      );
      expect(() => buildTrackedCliLaunchCommand({ provider: "droid", permissionMode: "auto" })).toThrow(
        "auto is only supported for Claude",
      );
      expect(() => buildTrackedCliLaunchCommand({ provider: "opencode", permissionMode: "auto" })).toThrow(
        "auto is only supported for Claude",
      );
    });
  });

  it("covers supported AgentChatPermissionMode values for each provider", () => {
    const modes = ["default", "auto", "plan", "edit", "full-auto", "config-toml"] as const satisfies readonly AgentChatPermissionMode[];
    for (const mode of modes) {
      if (mode === "auto") {
        expect(buildTrackedCliStartupCommand({ provider: "claude", permissionMode: mode }).length).toBeGreaterThan(0);
        continue;
      }
      const codex = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: mode });
      expect(codex.length).toBeGreaterThan(0);
      if (mode !== "config-toml") {
        expect(buildTrackedCliStartupCommand({ provider: "claude", permissionMode: mode }).length).toBeGreaterThan(0);
        expect(buildTrackedCliStartupCommand({ provider: "cursor", permissionMode: mode }).length).toBeGreaterThan(0);
        expect(buildTrackedCliStartupCommand({ provider: "droid", permissionMode: mode }).length).toBeGreaterThan(0);
      }
      expect(buildTrackedCliStartupCommand({ provider: "opencode", permissionMode: mode }).length).toBeGreaterThan(0);
    }
  });
});

describe("tracked CLI resume helpers", () => {
  it("builds Windows resumes as direct argv and env instead of POSIX shell commands", () => {
    const prompt = "Continue in C:\\Program Files\\ADE's $lane %TEMP% & café";
    const openCode = buildTrackedCliResumeLaunchCommand({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_99",
      launch: { permissionMode: "plan", model: "opencode/openai/gpt-5.4" },
    }, { prompt }, { platform: "win32" });

    expect(openCode).toMatchObject({
      command: "opencode",
      args: [
        "--agent",
        "plan",
        "--model",
        "openai/gpt-5.4",
        "--session",
        "ses_99",
        "--prompt",
        prompt,
      ],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { "*": "ask", edit: "deny", bash: "deny", question: "allow" },
        }),
      },
    });
    expect(openCode.args).not.toContain(expect.stringContaining("OPENCODE_CONFIG_CONTENT="));

    const replay = buildOpenCodeReplayResumeLaunchCommand({
      permissionMode: "plan",
      model: "opencode/openai/gpt-5.4",
      resumeTarget: "ses_99",
      prompt,
    });
    expect(replay.command).toBe("opencode");
    expect(replay.args).toEqual(expect.arrayContaining([
      "--mini",
      "--session",
      "ses_99",
      "--replay-limit",
      "40",
      "--prompt",
      prompt,
    ]));
    expect(replay.args).not.toContain("--replay");
    expect(replay.env?.OPENCODE_CONFIG_CONTENT).toBeTruthy();
  });

  it("keeps the prompt out of the Windows Droid resume command line", () => {
    const prompt = "Continue in C:\\Program Files\\ADE's $lane %TEMP% & café\nsecond line";
    const launch = buildTrackedCliResumeLaunchCommand({
      provider: "droid",
      targetKind: "session",
      targetId: "droid-session-1",
      launch: { permissionMode: "edit", model: "droid/claude-sonnet-5" },
    }, { prompt }, { platform: "win32" });

    expect(launch.command).toBe("powershell.exe");
    expect(launch.args.slice(0, 5)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
    // Quoting was never the problem: PowerShell hands argv to a droid.cmd shim
    // that truncates the value at the first newline and expands %TEMP% on the
    // way through. The resume path re-sends the text over the PTY instead.
    expect(launch.startupCommand).not.toContain("Continue in");
    expect(launch.startupCommand).not.toContain("%TEMP%");
    expect(launch.initialInput).toBe(prompt);
    expect(launch.startupCommand).toContain("& 'droid' '--settings' $env:ADE_DROID_SETTINGS '--resume' 'droid-session-1'");
    expect(launch.startupCommand).toContain("[System.Text.UTF8Encoding]::new($false)");
    expect(launch.startupCommand).not.toContain("Set-Content");
    expect(launch.startupCommand).not.toContain("$(mktemp");
    expect(launch.startupCommand).not.toContain("ADE_DROID_SETTINGS=\"");
  });

  it("keeps Pi resume launches direct while moving the prompt off Windows argv", () => {
    const prompt = "Continue in C:\\Program Files\\ADE's $lane %TEMP% & café";
    const launch = buildTrackedCliResumeLaunchCommand({
      provider: "pi",
      targetKind: "session",
      targetId: "pi-session-1",
      launch: { permissionMode: "plan", model: "pi/openai/gpt-5.4", reasoningEffort: "medium" },
    }, { prompt }, { platform: "win32" });

    expect(launch.command).toBe("pi");
    expect(launch.args).toEqual([
      "--model", "openai/gpt-5.4",
      "--thinking", "medium",
      "--tools", "read",
      "--session", "pi-session-1",
    ]);
    expect(launch.initialInput).toBe(prompt);
    expect(launch.initialInputDelayMs).toBe(750);
    expect(launch.startupCommand).toContain("pi --model \"openai/gpt-5.4\" --thinking medium --tools read --session pi-session-1");
    expect(launch.startupCommand).not.toContain("Continue in");
    expect(launch.startupCommand).not.toContain("%TEMP%");
    expect(launch.startupCommand).not.toContain("powershell");
    expect(launch.startupCommand).not.toContain("-lc");
  });

  it("keeps the Pi resume prompt in argv on POSIX", () => {
    const prompt = "Continue in /repo's $lane\nsecond line";
    const launch = buildTrackedCliResumeLaunchCommand({
      provider: "pi",
      targetKind: "session",
      targetId: "pi-session-1",
      launch: { permissionMode: "plan", model: "pi/openai/gpt-5.4", reasoningEffort: "medium" },
    }, { prompt }, { platform: "darwin" });

    expect(launch.args.at(-1)).toBe(prompt);
    expect(launch.initialInput).toBeUndefined();
    expect(launch.initialInputDelayMs).toBeUndefined();
  });

  it("keeps the POSIX Droid resume prompt in argv", () => {
    const prompt = "Continue in /repo's $lane\nsecond line";
    const launch = buildTrackedCliResumeLaunchCommand({
      provider: "droid",
      targetKind: "session",
      targetId: "droid-session-1",
      launch: { permissionMode: "edit", model: "droid/claude-sonnet-5" },
    }, { prompt }, { platform: "darwin" });

    expect(launch.command).toBe("/bin/bash");
    expect(launch.startupCommand).toContain("Continue in /repo");
    expect(launch.startupCommand).toContain("second line");
    expect(launch.initialInput).toBeUndefined();
  });

  it("rebuilds permission-aware resume commands from metadata", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "default" },
    })).toBe("claude --permission-mode default --resume claude-session-1");

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit" },
    })).toBe("codex --no-alt-screen --sandbox workspace-write --ask-for-approval untrusted resume thread-99");

    expect(buildTrackedCliResumeCommand({
      provider: "cursor",
      targetKind: "session",
      targetId: "chat-99",
      launch: { permissionMode: "edit" },
    })).toBe("cursor-agent --mode ask --resume chat-99");

    expect(buildTrackedCliResumeCommand({
      provider: "cursor",
      targetKind: "session",
      targetId: "chat-99",
      launch: { permissionMode: "full-auto" },
    })).toBe("cursor-agent --force --resume chat-99");

    expect(buildTrackedCliResumeCommand({
      provider: "cursor",
      targetKind: "session",
      targetId: "chat-99",
      launch: { permissionMode: "default", model: "cursor/composer-2.5" },
    })).toBe("cursor-agent --model composer-2.5 --resume chat-99");

    expect(buildTrackedCliResumeCommand({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_99",
      launch: { permissionMode: "plan" },
    }, { model: "opencode/opencode/big-pickle" })).toContain("--agent plan --model \"opencode/big-pickle\" --session ses_99");

    expect(buildTrackedCliResumeCommand({
      provider: "pi",
      targetKind: "session",
      targetId: "pi-session-1",
      launch: { permissionMode: "full-auto", model: "pi/anthropic/claude-sonnet-5", reasoningEffort: "high" },
    })).toBe("pi --model \"anthropic/claude-sonnet-5\" --thinking high --tools read,bash,edit,write --session pi-session-1");
  });

  it("preserves Codex native approval and sandbox pairs without escalating access", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-danger-on-request",
      launch: {
        permissionMode: "full-auto",
        codexApprovalPolicy: "on-request",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      },
    })).toBe(
      "codex --no-alt-screen --sandbox danger-full-access --ask-for-approval on-request resume thread-danger-on-request",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-workspace-on-request",
      launch: {
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      },
    })).toBe(
      "codex --no-alt-screen --sandbox workspace-write --ask-for-approval on-request resume thread-workspace-on-request",
    );
  });

  it("adds provider model overrides to resumable CLI commands", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "default" },
    }, { model: "anthropic/claude-haiku-4-5", reasoningEffort: "low", permissionMode: "auto" })).toBe(
      "claude --permission-mode auto --model claude-haiku-4-5 --effort low --resume claude-session-1",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "default", model: "anthropic/claude-opus-4-8", fastMode: true },
    })).toBe(
      "claude --permission-mode default --model claude-opus-4-8 --settings \"{\\\"fastMode\\\":true}\" --resume claude-session-1",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "default", model: "anthropic/claude-opus-4-8", fastMode: false },
    })).toBe(
      "claude --permission-mode default --model claude-opus-4-8 --settings \"{\\\"fastMode\\\":false}\" --resume claude-session-1",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: {
        permissionMode: "default",
        model: "anthropic/claude-fable-5-1",
        reasoningEffort: "ultracode",
      },
    })).toBe(
      "claude --permission-mode default --model claude-fable-5-1 --effort xhigh --settings \"{\\\"ultracode\\\":true}\" --resume claude-session-1",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit" },
    }, { model: "gpt-5.4", reasoningEffort: "high", permissionMode: "plan" })).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c \"model_reasoning_effort=\\\"high\\\"\" --sandbox read-only --ask-for-approval on-request resume thread-99",
    );

    const droidResume = buildTrackedCliResumeCommand({
      provider: "droid",
      targetKind: "session",
      targetId: "droid-session-1",
      launch: { permissionMode: "default" },
    }, { model: "droid/gpt-5.4", reasoningEffort: "xhigh", permissionMode: "full-auto" });
    expect(droidResume).toContain("droid --settings \"$ADE_DROID_SETTINGS\" --resume droid-session-1");
    expect(droidResume).toContain("\\\"model\\\":\\\"gpt-5.4\\\"");
    expect(droidResume).toContain("\\\"reasoningEffort\\\":\\\"xhigh\\\"");
    expect(droidResume).toContain("\\\"autonomyLevel\\\":\\\"high\\\"");
  });

  it("adds provider prompt overrides to resumable CLI commands", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "plan" },
    }, { prompt: "fix failing tests" })).toBe(
      "codex --no-alt-screen --sandbox read-only --ask-for-approval on-request resume thread-99 \"fix failing tests\"",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_99",
      launch: { permissionMode: "default" },
    }, { prompt: "continue from here" })).toContain("--session ses_99 --prompt \"continue from here\"");
  });

  it("preserves stored model and reasoning when resuming tracked CLI sessions without overrides", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit", model: "gpt-5.4", reasoningEffort: "medium", fastMode: true },
    })).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c \"model_reasoning_effort=\\\"medium\\\"\" -c \"service_tier=\\\"fast\\\"\" -c features.fast_mode=true --sandbox workspace-write --ask-for-approval untrusted resume thread-99",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit", model: "gpt-5.4", reasoningEffort: "medium", fastMode: false },
    })).toContain("-c \"service_tier=\\\"default\\\"\"");

    expect(buildTrackedCliResumeCommand({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_99",
      launch: { permissionMode: "plan", model: "opencode/openai/gpt-5.4", fastMode: true },
    })).toContain("opencode --agent plan --model \"openai/gpt-5.4\" --session ses_99");
  });

  it("builds OpenCode interactive replay resume commands for freeze-frame continuation", () => {
    const command = buildOpenCodeReplayResumeCommand({
      permissionMode: "plan",
      model: `opencode/openai/${encodeURIComponent("gpt-5.4")}`,
      resumeTarget: "ses_99",
      prompt: "continue from the snapshot",
      replayLimit: 12,
    });

    expect(command).toContain("OPENCODE_CONFIG_CONTENT=");
    expect(command).toContain("opencode --mini --agent plan --model \"openai/gpt-5.4\" --session ses_99 --replay-limit 12 --prompt");
    expect(command).toContain("continue from the snapshot");
    expect(command).toContain("\\\"question\\\":\\\"allow\\\"");
  });

  it("falls back to the provider resume picker when the concrete target is missing", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: null,
      launch: { permissionMode: "default" },
    })).toBe("claude --permission-mode default --resume");

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: null,
      launch: { permissionMode: "full-auto" },
    })).toBe("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume");

    expect(buildTrackedCliResumeCommand({
      provider: "cursor",
      targetKind: "session",
      targetId: null,
      launch: { permissionMode: "plan" },
    })).toBe("cursor-agent --mode plan --continue");

    expect(buildTrackedCliResumeCommand({
      provider: "droid",
      targetKind: "session",
      targetId: null,
      launch: { permissionMode: "default" },
    })).toContain("droid --settings \"$ADE_DROID_SETTINGS\" --resume");
  });

  it("rejects unsupported resume permission/provider combinations", () => {
    expect(() => buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "config-toml" },
    })).toThrow("config-toml is only supported for Codex");
  });

  it("prefers structured metadata over the legacy resume command string", () => {
    const session = {
      resumeCommand: "codex resume picker",
      resumeMetadata: {
        provider: "codex",
        targetKind: "thread",
        targetId: "thread-99",
        launch: { permissionMode: "full-auto" },
      },
    } satisfies Pick<TerminalSessionSummary, "resumeCommand" | "resumeMetadata">;

    expect(resolveTrackedCliResumeCommand(session)).toBe("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume thread-99");
  });

  describe("OpenCode prompt boundary", () => {
    // The reported failure: launching a tracked OpenCode CLI showed ADE's
    // instructions to the user. `--prompt` is submitted as a real user message
    // and rendered in the TUI, so anything ADE prepended to the user's text was
    // displayed verbatim — and reached the model as user content rather than as
    // system instructions.
    it("puts only the user's text on --prompt, never ADE's instructions", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "edit",
        initialPrompt: "Fix the failing test.",
        laneWorktreePath: "/repo/.ade/worktrees/lane-1",
      });

      const promptIndex = launch.args.indexOf("--prompt");
      expect(promptIndex).toBeGreaterThanOrEqual(0);
      expect(launch.args[promptIndex + 1]).toBe("Fix the failing test.");

      const everything = [launch.startupCommand, ...launch.args, launch.initialInput ?? ""].join("\n");
      expect(everything).not.toContain("ADE session guidance");
      expect(everything).not.toContain("User prompt:");
      expect(everything).not.toContain("ADE is a local-first dev environment");
      // Nor may it be smuggled in through the post-launch PTY write instead.
      expect(launch.initialInput ?? "").not.toContain("ADE session guidance");
    });

    it("omits --prompt entirely when the user typed nothing", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "edit",
        laneWorktreePath: "/repo/.ade/worktrees/lane-1",
      });

      expect(launch.args).not.toContain("--prompt");
      expect(launch.startupCommand).not.toContain("ADE session guidance");
    });

    it("adds ADE's instruction file to the config env without dropping the user's", () => {
      const applied = withOpenCodeAdeInstructions(
        { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ["./AGENTS.local.md"], permission: { edit: "allow" } }) } },
        "/cache/ade/instructions.md",
      );

      const config = JSON.parse(applied?.env?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
        instructions?: string[];
        permission?: Record<string, string>;
      };
      // Verified against opencode 1.18.21: config layers union `instructions`
      // rather than overwriting, so the user's own files must survive.
      expect(config.instructions).toEqual(["./AGENTS.local.md", "/cache/ade/instructions.md"]);
      expect(config.permission).toEqual({ edit: "allow" });
    });

    it("rewrites the inline config assignment on the startup command too", () => {
      // A shell assignment on the command line overrides the process
      // environment for that child, so patching only `env` would silently drop
      // the instructions on every launch that goes through the typed-command
      // fallback instead of a direct spawn.
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "edit",
        initialPrompt: "Fix the failing test.",
        laneWorktreePath: "/repo/.ade/worktrees/lane-1",
      });
      const applied = withOpenCodeAdeInstructions(launch, "/cache/ade/instructions.md");

      expect(applied?.startupCommand).toBeDefined();
      const [assignment] = parseCommandLine(applied!.startupCommand!, { platform: "linux" });
      expect(assignment?.startsWith("OPENCODE_CONFIG_CONTENT=")).toBe(true);
      const inline = JSON.parse(assignment!.slice("OPENCODE_CONFIG_CONTENT=".length)) as {
        instructions?: string[];
        permission?: unknown;
      };
      expect(inline.instructions).toEqual(["/cache/ade/instructions.md"]);
      // The permission policy the launch already carried must survive.
      expect(inline.permission).toEqual(
        JSON.parse(applied!.env!.OPENCODE_CONFIG_CONTENT!).permission,
      );
      expect(applied!.startupCommand).toContain("Fix the failing test.");
    });

    it("creates the config env when a launch had none, and stays idempotent", () => {
      const first = withOpenCodeAdeInstructions({}, "/cache/ade/instructions.md");
      expect(JSON.parse(first?.env?.OPENCODE_CONFIG_CONTENT ?? "{}")).toEqual({
        instructions: ["/cache/ade/instructions.md"],
      });

      expect(withOpenCodeAdeInstructions({ env: first!.env }, "/cache/ade/instructions.md")).toBeNull();
    });

    it("leaves a config value it cannot parse untouched", () => {
      const env = { OPENCODE_CONFIG_CONTENT: "{not json" };
      expect(withOpenCodeAdeInstructions({ env }, "/cache/ade/instructions.md")).toBeNull();
      expect(withOpenCodeAdeInstructions({ env }, "   ")).toBeNull();
    });
  });
});
