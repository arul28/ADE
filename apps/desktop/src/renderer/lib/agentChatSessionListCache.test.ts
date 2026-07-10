/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSessionSummary } from "../../shared/types";
import { useAppStore } from "../state/appStore";
import {
  invalidateAgentChatSessionListCache,
  listAgentChatSessionsCached,
} from "./agentChatSessionListCache";

function session(sessionId: string): AgentChatSessionSummary {
  return {
    sessionId,
    laneId: "lane-1",
    provider: "codex",
    title: sessionId,
    status: "idle",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    lastMessageAt: null,
    archivedAt: null,
  } as unknown as AgentChatSessionSummary;
}

describe("agentChatSessionListCache", () => {
  beforeEach(() => {
    invalidateAgentChatSessionListCache();
    useAppStore.setState({
      project: { rootPath: "/tmp/project-a", name: "Project A" } as any,
      projectBinding: {
        kind: "local",
        key: "local:/tmp/project-a",
        rootPath: "/tmp/project-a",
        displayName: "Project A",
      },
    } as any);
    globalThis.window.ade = {
      agentChat: {
        list: vi.fn(),
      },
    } as any;
  });

  afterEach(() => {
    invalidateAgentChatSessionListCache();
    vi.restoreAllMocks();
  });

  it("coalesces identical in-flight lane requests", async () => {
    let resolveRows: (rows: AgentChatSessionSummary[]) => void = () => {};
    const pending = new Promise<AgentChatSessionSummary[]>((resolve) => {
      resolveRows = resolve;
    });
    const list = vi.mocked(window.ade.agentChat.list);
    list.mockReturnValue(pending as any);

    const first = listAgentChatSessionsCached({ laneId: "lane-1" });
    const second = listAgentChatSessionsCached({ laneId: "lane-1" });

    expect(list).toHaveBeenCalledTimes(1);
    resolveRows([session("session-1")]);
    await expect(first).resolves.toEqual([session("session-1")]);
    await expect(second).resolves.toEqual([session("session-1")]);

    await expect(listAgentChatSessionsCached({ laneId: "lane-1" })).resolves.toEqual([session("session-1")]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("lets a forced refresh supersede an in-flight read without stale cache overwrite", async () => {
    let resolveFirst: (rows: AgentChatSessionSummary[]) => void = () => {};
    const firstPending = new Promise<AgentChatSessionSummary[]>((resolve) => {
      resolveFirst = resolve;
    });
    const list = vi.mocked(window.ade.agentChat.list);
    list
      .mockReturnValueOnce(firstPending as any)
      .mockResolvedValueOnce([session("fresh-session")]);

    const first = listAgentChatSessionsCached({ laneId: "lane-1" });
    const refreshed = listAgentChatSessionsCached({ laneId: "lane-1" }, { force: true });

    expect(list).toHaveBeenCalledTimes(2);
    await expect(refreshed).resolves.toEqual([session("fresh-session")]);
    resolveFirst([session("stale-session")]);
    await expect(first).resolves.toEqual([session("stale-session")]);
    await expect(listAgentChatSessionsCached({ laneId: "lane-1" })).resolves.toEqual([session("fresh-session")]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh read after invalidating an in-flight request", async () => {
    let resolveFirst: (rows: AgentChatSessionSummary[]) => void = () => {};
    const firstPending = new Promise<AgentChatSessionSummary[]>((resolve) => {
      resolveFirst = resolve;
    });
    const list = vi.mocked(window.ade.agentChat.list);
    list
      .mockReturnValueOnce(firstPending as any)
      .mockResolvedValueOnce([session("fresh-session")]);

    const first = listAgentChatSessionsCached({ laneId: "lane-1" });
    invalidateAgentChatSessionListCache({ projectRoot: "/tmp/project-a", laneId: "lane-1" });
    const refreshed = listAgentChatSessionsCached({ laneId: "lane-1" });

    await expect(refreshed).resolves.toEqual([session("fresh-session")]);
    resolveFirst([session("stale-session")]);
    await expect(first).resolves.toEqual([session("stale-session")]);
    await expect(listAgentChatSessionsCached({ laneId: "lane-1" })).resolves.toEqual([session("fresh-session")]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("separates project roots and allows scoped invalidation", async () => {
    const list = vi.mocked(window.ade.agentChat.list);
    list
      .mockResolvedValueOnce([session("project-a-session")])
      .mockResolvedValueOnce([session("project-b-session")])
      .mockResolvedValueOnce([session("project-a-new")]);

    await expect(listAgentChatSessionsCached({ laneId: "lane-1" })).resolves.toEqual([session("project-a-session")]);

    useAppStore.setState({
      project: { rootPath: "/tmp/project-b", name: "Project B" } as any,
      projectBinding: {
        kind: "local",
        key: "local:/tmp/project-b",
        rootPath: "/tmp/project-b",
        displayName: "Project B",
      },
    } as any);
    await expect(listAgentChatSessionsCached({ laneId: "lane-1" })).resolves.toEqual([session("project-b-session")]);

    invalidateAgentChatSessionListCache({ projectRoot: "/tmp/project-a", laneId: "lane-1" });
    useAppStore.setState({
      project: { rootPath: "/tmp/project-a", name: "Project A" } as any,
      projectBinding: {
        kind: "local",
        key: "local:/tmp/project-a",
        rootPath: "/tmp/project-a",
        displayName: "Project A",
      },
    } as any);

    await expect(listAgentChatSessionsCached({ laneId: "lane-1" })).resolves.toEqual([session("project-a-new")]);
    expect(list).toHaveBeenCalledTimes(3);
  });
});
