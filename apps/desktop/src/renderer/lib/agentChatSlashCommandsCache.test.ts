/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSlashCommand } from "../../shared/types";
import {
  getAgentChatSlashCommandsCached,
  invalidateAgentChatSlashCommandsCache,
} from "./agentChatSlashCommandsCache";

function command(name: string): AgentChatSlashCommand {
  return {
    name,
    description: `${name} command`,
    source: "sdk",
  };
}

describe("agentChatSlashCommandsCache", () => {
  beforeEach(() => {
    invalidateAgentChatSlashCommandsCache();
    globalThis.window.ade = {
      agentChat: {
        slashCommands: vi.fn(),
      },
    } as any;
  });

  afterEach(() => {
    invalidateAgentChatSlashCommandsCache();
    vi.restoreAllMocks();
  });

  it("coalesces identical in-flight session requests", async () => {
    let resolveCommands: (commands: AgentChatSlashCommand[]) => void = () => {};
    const pending = new Promise<AgentChatSlashCommand[]>((resolve) => {
      resolveCommands = resolve;
    });
    const slashCommands = vi.mocked(window.ade.agentChat.slashCommands);
    slashCommands.mockReturnValue(pending as any);

    const first = getAgentChatSlashCommandsCached({ sessionId: "session-1" });
    const second = getAgentChatSlashCommandsCached({ sessionId: "session-1" });

    expect(slashCommands).toHaveBeenCalledTimes(1);
    resolveCommands([command("/plan")]);
    await expect(first).resolves.toEqual([command("/plan")]);
    await expect(second).resolves.toEqual([command("/plan")]);

    await expect(getAgentChatSlashCommandsCached({ sessionId: "session-1" })).resolves.toEqual([command("/plan")]);
    expect(slashCommands).toHaveBeenCalledTimes(1);
  });

  it("keeps lane/provider keys separate and supports forced refresh", async () => {
    const slashCommands = vi.mocked(window.ade.agentChat.slashCommands);
    slashCommands
      .mockResolvedValueOnce([command("/codex")])
      .mockResolvedValueOnce([command("/claude")])
      .mockResolvedValueOnce([command("/codex-new")]);

    await expect(getAgentChatSlashCommandsCached({ laneId: "lane-1", provider: "codex" })).resolves.toEqual([command("/codex")]);
    await expect(getAgentChatSlashCommandsCached({ laneId: "lane-1", provider: "claude" })).resolves.toEqual([command("/claude")]);
    await expect(getAgentChatSlashCommandsCached({ laneId: "lane-1", provider: "codex" })).resolves.toEqual([command("/codex")]);

    await expect(
      getAgentChatSlashCommandsCached({ laneId: "lane-1", provider: "codex" }, { force: true }),
    ).resolves.toEqual([command("/codex-new")]);

    expect(slashCommands).toHaveBeenCalledTimes(3);
  });

  it("keeps matching session and lane keys separate across project roots", async () => {
    const slashCommands = vi.mocked(window.ade.agentChat.slashCommands);
    slashCommands
      .mockResolvedValueOnce([command("/local")])
      .mockResolvedValueOnce([command("/remote")])
      .mockResolvedValueOnce([command("/lane-local")])
      .mockResolvedValueOnce([command("/lane-remote")]);

    await expect(
      getAgentChatSlashCommandsCached({ sessionId: "session-1", projectRoot: "/local/repo" }),
    ).resolves.toEqual([command("/local")]);
    await expect(
      getAgentChatSlashCommandsCached({ sessionId: "session-1", projectRoot: "/remote/repo" }),
    ).resolves.toEqual([command("/remote")]);
    await expect(
      getAgentChatSlashCommandsCached({ laneId: "lane-1", provider: "codex", projectRoot: "/local/repo" }),
    ).resolves.toEqual([command("/lane-local")]);
    await expect(
      getAgentChatSlashCommandsCached({ laneId: "lane-1", provider: "codex", projectRoot: "/remote/repo" }),
    ).resolves.toEqual([command("/lane-remote")]);

    expect(slashCommands).toHaveBeenCalledTimes(4);
  });

  it("keeps matching session keys separate across bindings and invalidates them together", async () => {
    const machineB = {
      kind: "remote" as const,
      key: "remote:target-b:project-b",
      targetId: "target-b",
      runtimeName: "machine-b",
      projectId: "project-b",
      rootPath: "/repo-b",
      displayName: "Machine B",
    };
    const slashCommands = vi.mocked(window.ade.agentChat.slashCommands);
    slashCommands
      .mockResolvedValueOnce([command("/local")])
      .mockResolvedValueOnce([command("/remote")])
      .mockResolvedValueOnce([command("/local-new")])
      .mockResolvedValueOnce([command("/remote-new")]);
    const args = { sessionId: "session-1", projectRoot: "/repo" };

    await expect(getAgentChatSlashCommandsCached(args)).resolves.toEqual([command("/local")]);
    await expect(getAgentChatSlashCommandsCached(args, { pin: machineB })).resolves.toEqual([command("/remote")]);
    expect(slashCommands).toHaveBeenNthCalledWith(1, args);
    expect(slashCommands).toHaveBeenNthCalledWith(2, args, machineB);

    invalidateAgentChatSlashCommandsCache(args);

    await expect(getAgentChatSlashCommandsCached(args)).resolves.toEqual([command("/local-new")]);
    await expect(getAgentChatSlashCommandsCached(args, { pin: machineB })).resolves.toEqual([command("/remote-new")]);
    expect(slashCommands).toHaveBeenCalledTimes(4);
  });

  it("does not repopulate an invalidated key from a stale in-flight request", async () => {
    let resolveStale: (commands: AgentChatSlashCommand[]) => void = () => {};
    const stale = new Promise<AgentChatSlashCommand[]>((resolve) => {
      resolveStale = resolve;
    });
    const slashCommands = vi.mocked(window.ade.agentChat.slashCommands);
    slashCommands
      .mockReturnValueOnce(stale as any)
      .mockResolvedValueOnce([command("/fresh")]);

    const pending = getAgentChatSlashCommandsCached({ sessionId: "session-1" });
    invalidateAgentChatSlashCommandsCache({ sessionId: "session-1" });
    resolveStale([command("/stale")]);

    await expect(pending).resolves.toEqual([command("/stale")]);
    await expect(getAgentChatSlashCommandsCached({ sessionId: "session-1" }))
      .resolves.toEqual([command("/fresh")]);
    expect(slashCommands).toHaveBeenCalledTimes(2);
  });
});
