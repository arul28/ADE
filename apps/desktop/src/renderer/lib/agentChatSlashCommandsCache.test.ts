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
});
