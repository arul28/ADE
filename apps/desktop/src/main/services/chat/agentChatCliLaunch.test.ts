import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatLaunchCliArgs } from "../../../shared/types/chat";
import type { PtyCreateArgs } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
  resolveCodexComputerUseMcpConfig: vi.fn(async (): Promise<{
    command: string;
    args: ["mcp"];
    enabled: true;
  } | null> => null),
}));

vi.mock("../../utils/codexComputerUse", () => ({
  resolveCodexComputerUseMcpConfig: mocks.resolveCodexComputerUseMcpConfig,
}));

import { launchAgentChatCli, type AgentChatCliLaunchDeps } from "./agentChatCliLaunch";

type LaneBaseAndBranch =
  AgentChatCliLaunchDeps["laneService"]["getLaneBaseAndBranch"] extends (
    laneId: string,
  ) => infer R
    ? R
    : never;

/**
 * Builds deps whose pty `create` echoes back a deterministic session result.
 * `getLaneWorktreePath` resolves by default; tests override it to exercise the
 * worktree-path resolution fallbacks. The lane-row mock only needs to surface a
 * `worktreePath`; the launch path ignores the other lane-row fields, so a
 * partial row is cast to the full return shape rather than fabricating dummies.
 */
function makeDeps(
  overrides: {
    getLaneWorktreePath?: () => string;
    getLaneBaseAndBranch?: () => Partial<LaneBaseAndBranch> | undefined;
  } = {},
): AgentChatCliLaunchDeps & { create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (args: PtyCreateArgs) => ({
    sessionId: args.sessionId ?? "session-1",
    ptyId: "pty-1",
    pid: 4242,
  }));
  const getLaneBaseAndBranch = (overrides.getLaneBaseAndBranch ??
    vi.fn(() => undefined)) as () => LaneBaseAndBranch;
  return {
    laneService: {
      getLaneWorktreePath:
        overrides.getLaneWorktreePath ?? vi.fn(() => "/repo/.ade/worktrees/lane-1"),
      getLaneBaseAndBranch,
    },
    ptyService: { create },
    create,
  };
}

function makeArgs(overrides: Partial<AgentChatLaunchCliArgs> = {}): AgentChatLaunchCliArgs {
  return {
    laneId: "lane-1",
    provider: "codex",
    kickoffPrompt: "Resolve the attached issue",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.resolveCodexComputerUseMcpConfig.mockReset();
  mocks.resolveCodexComputerUseMcpConfig.mockResolvedValue(null);
});

describe("launchAgentChatCli provider validation", () => {
  it("rejects an unknown provider at the runtime boundary", async () => {
    const deps = makeDeps();
    await expect(
      launchAgentChatCli(
        makeArgs({ provider: "gemini" as AgentChatLaunchCliArgs["provider"] }),
        deps,
      ),
    ).rejects.toThrow("agentChat.launchCli: unsupported provider 'gemini'.");
    // The guard must fire before any process spawn.
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("rejects the 'shell' launch profile (a profile, not an agent provider)", async () => {
    // "shell" passes isLaunchProfile but is not an agent provider, so it must be
    // rejected too — otherwise a shell session would spawn with an agent toolType.
    const deps = makeDeps();
    await expect(
      launchAgentChatCli(
        makeArgs({ provider: "shell" as AgentChatLaunchCliArgs["provider"] }),
        deps,
      ),
    ).rejects.toThrow("agentChat.launchCli: unsupported provider 'shell'.");
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("requires a laneId, a provider, and a non-blank kickoff prompt", async () => {
    const deps = makeDeps();
    await expect(
      launchAgentChatCli(makeArgs({ laneId: "  " }), deps),
    ).rejects.toThrow("requires a laneId");
    await expect(
      launchAgentChatCli(
        makeArgs({ provider: undefined as unknown as AgentChatLaunchCliArgs["provider"] }),
        deps,
      ),
    ).rejects.toThrow("requires a provider");
    await expect(
      launchAgentChatCli(makeArgs({ kickoffPrompt: "   " }), deps),
    ).rejects.toThrow("requires a kickoff prompt");
    expect(deps.create).not.toHaveBeenCalled();
  });
});

describe("launchAgentChatCli worktree-path resolution", () => {
  it("falls back to the lane row snapshot when getLaneWorktreePath throws", async () => {
    const getLaneWorktreePath = vi.fn(() => {
      throw new Error("lane not registered in-process");
    });
    const getLaneBaseAndBranch = vi.fn(() => ({ worktreePath: "/imported/lane/path" }));
    const deps = makeDeps({ getLaneWorktreePath, getLaneBaseAndBranch });

    const result = await launchAgentChatCli(makeArgs(), deps);

    // The throw was swallowed and the row-snapshot fallback supplied the path,
    // so the launch proceeded instead of erroring out.
    expect(getLaneBaseAndBranch).toHaveBeenCalledWith("lane-1");
    expect(deps.create).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe(
      (deps.create.mock.calls[0]?.[0] as { sessionId: string }).sessionId,
    );
  });

  it("throws a clear error when neither source yields a worktree path", async () => {
    const deps = makeDeps({
      getLaneWorktreePath: vi.fn(() => "   "),
      getLaneBaseAndBranch: vi.fn(() => undefined),
    });
    await expect(launchAgentChatCli(makeArgs(), deps)).rejects.toThrow(
      "Unable to resolve worktree path for lane 'lane-1'.",
    );
    expect(deps.create).not.toHaveBeenCalled();
  });
});

describe("launchAgentChatCli orchestration policy", () => {
  it("lets an orchestration role override stricter requested CLI permissions", async () => {
    const deps = makeDeps();

    await launchAgentChatCli(
      makeArgs({ permissionMode: "plan", orchestrationRole: "worker" }),
      deps,
    );

    const createArg = deps.create.mock.calls[0]?.[0] as PtyCreateArgs;
    expect(createArg.args).toEqual(expect.arrayContaining(["--dangerously-bypass-approvals-and-sandbox"]));
    expect(createArg.args).not.toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
  });
});

describe("launchAgentChatCli Codex fast mode", () => {
  it("includes the asynchronously resolved Computer Use MCP config", async () => {
    const deps = makeDeps();
    const command = "/Applications/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient";
    mocks.resolveCodexComputerUseMcpConfig.mockResolvedValueOnce({
      command,
      args: ["mcp"],
      enabled: true,
    });

    await launchAgentChatCli(makeArgs({ provider: "codex" }), deps);

    const createArg = deps.create.mock.calls[0]?.[0] as PtyCreateArgs;
    expect(createArg.args).toEqual(expect.arrayContaining([
      "-c",
      `mcp_servers.computer_use.command=${JSON.stringify(command)}`,
      "-c",
      'mcp_servers.computer_use.args=["mcp"]',
      "-c",
      "mcp_servers.computer_use.enabled=true",
    ]));
  });

  it("passes explicit service tier flags to Codex CLI launches", async () => {
    const deps = makeDeps();

    await launchAgentChatCli(
      makeArgs({ provider: "codex", fastMode: false }),
      deps,
    );

    let createArg = deps.create.mock.calls[0]?.[0] as PtyCreateArgs;
    expect(createArg.args).toEqual(expect.arrayContaining([
      "-c",
      "service_tier=\"default\"",
    ]));

    await launchAgentChatCli(
      makeArgs({ provider: "codex", fastMode: true }),
      deps,
    );

    createArg = deps.create.mock.calls[1]?.[0] as PtyCreateArgs;
    expect(createArg.args).toEqual(expect.arrayContaining([
      "-c",
      "service_tier=\"fast\"",
      "-c",
      "features.fast_mode=true",
    ]));
  });

  it("honors the deprecated codexFastMode alias when fastMode is absent", async () => {
    const deps = makeDeps();

    await launchAgentChatCli(
      makeArgs({ provider: "codex", codexFastMode: true }),
      deps,
    );

    const createArg = deps.create.mock.calls[0]?.[0] as PtyCreateArgs;
    expect(createArg.args).toEqual(expect.arrayContaining([
      "-c",
      "service_tier=\"fast\"",
      "-c",
      "features.fast_mode=true",
    ]));
  });
});

describe("launchAgentChatCli Claude fast mode", () => {
  it("passes explicit fast settings to Claude CLI launches", async () => {
    const deps = makeDeps();

    await launchAgentChatCli(
      makeArgs({
        provider: "claude",
        model: "anthropic/claude-opus-4-8",
        fastMode: true,
      }),
      deps,
    );

    const createArg = deps.create.mock.calls[0]?.[0] as PtyCreateArgs;
    expect(createArg.args).toEqual(expect.arrayContaining([
      "--settings",
      JSON.stringify({ fastMode: true }),
    ]));
    expect(createArg.startupCommand).toContain("fastMode");
  });
});

describe("launchAgentChatCli OpenCode fast mode", () => {
  it("passes fast mode as an OpenCode CLI variant", async () => {
    const deps = makeDeps();

    await launchAgentChatCli(
      makeArgs({
        provider: "opencode",
        model: "opencode/openai/gpt-5.4",
        fastMode: true,
      }),
      deps,
    );

    const createArg = deps.create.mock.calls[0]?.[0] as PtyCreateArgs;
    expect(createArg.command).toBe("opencode");
    expect(createArg.args).toEqual(expect.arrayContaining([
      "run",
      "--interactive",
      "--model",
      "openai/gpt-5.4",
      "--variant",
      "fast",
    ]));
    expect(createArg.startupCommand).toContain("--variant fast");
  });
});

describe("launchAgentChatCli attached issue ids", () => {
  it("returns the durable terminal session before delayed kickoff input readiness", async () => {
    const deps = makeDeps();
    const result = await launchAgentChatCli(makeArgs(), deps);

    const createArg = deps.create.mock.calls[0]?.[0] as PtyCreateArgs;
    expect(createArg.initialInput).toContain("Resolve the attached issue");
    expect(createArg).not.toHaveProperty("awaitInitialInput");
    expect(createArg).not.toHaveProperty("initialInputReadyTimeoutMs");
    expect(result.sessionId).toBe(createArg.sessionId);
  });

  it("returns only well-formed attached issue ids and drops malformed entries", async () => {
    const deps = makeDeps();
    const result = await launchAgentChatCli(
      makeArgs({
        linearIssues: [
          { id: "issue-good" } as never,
          { id: "" } as never,
          { id: null } as never,
          {} as never,
        ],
      }),
      deps,
    );

    expect(result.attachedLinearIssueIds).toEqual(["issue-good"]);
    expect(result).toMatchObject({ ptyId: "pty-1", pid: 4242 });
    // The full issue list (including malformed shapes) is still forwarded to the
    // pty so persistence can decide; only the returned id summary is filtered.
    const createArg = deps.create.mock.calls[0]?.[0] as { linearIssues: unknown[] };
    expect(createArg.linearIssues).toHaveLength(4);
  });
});
