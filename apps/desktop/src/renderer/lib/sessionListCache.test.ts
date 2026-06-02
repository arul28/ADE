import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/appStore";
import { invalidateSessionListCache, listSessionsCached } from "./sessionListCache";

const listMock = vi.fn();

function makeRows(count: number) {
  return Array.from({ length: count }, (_, idx) => ({
    id: `session-${idx + 1}`,
    laneId: "lane-1",
    laneName: "Lane 1",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude-chat" as const,
    title: `Session ${idx + 1}`,
    status: "running" as const,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    transcriptPath: `/tmp/session-${idx + 1}.log`,
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "running" as const,
    resumeCommand: null,
  }));
}

describe("sessionListCache", () => {
  beforeEach(() => {
    invalidateSessionListCache();
    listMock.mockReset();
    useAppStore.setState({
      project: { rootPath: "/project/a" } as any,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ade: {
          sessions: {
            list: listMock,
          },
        },
      },
    });
  });

  it("reuses a larger cached result for smaller limits", async () => {
    listMock.mockResolvedValueOnce(makeRows(10));

    const full = await listSessionsCached({ limit: 10 });
    const partial = await listSessionsCached({ limit: 5 });

    expect(full).toHaveLength(10);
    expect(partial).toHaveLength(5);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("reuses an unbounded cached result for limited callers", async () => {
    listMock.mockResolvedValueOnce(makeRows(10));

    const full = await listSessionsCached();
    const partial = await listSessionsCached({ limit: 5 });

    expect(full).toHaveLength(10);
    expect(partial).toHaveLength(5);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("refetches when a later caller needs a larger limit", async () => {
    listMock
      .mockResolvedValueOnce(makeRows(5))
      .mockResolvedValueOnce(makeRows(10));

    const partial = await listSessionsCached({ limit: 5 });
    const full = await listSessionsCached({ limit: 10 });

    expect(partial).toHaveLength(5);
    expect(full).toHaveLength(10);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("keeps cache entries isolated per active project", async () => {
    listMock
      .mockResolvedValueOnce(makeRows(3))
      .mockResolvedValueOnce(makeRows(4));

    const projectARows = await listSessionsCached({ limit: 3 });
    useAppStore.setState({
      project: { rootPath: "/project/b" } as any,
    });
    const projectBRows = await listSessionsCached({ limit: 5 });
    useAppStore.setState({
      project: { rootPath: "/project/a" } as any,
    });
    const projectARowsAgain = await listSessionsCached({ limit: 3 });

    expect(projectARows).toHaveLength(3);
    expect(projectBRows).toHaveLength(4);
    expect(projectARowsAgain).toHaveLength(3);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes tool types before fetching and cache keying", async () => {
    listMock.mockResolvedValueOnce(makeRows(2));

    await listSessionsCached({ toolTypes: [" codex-chat ", "", "codex-chat"] as any });
    await listSessionsCached({ toolTypes: ["codex-chat"] });

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith({ toolTypes: ["codex-chat"] });
  });

  it("shares an in-flight request with forced callers", async () => {
    let resolveRows!: (rows: ReturnType<typeof makeRows>) => void;
    listMock.mockImplementationOnce(() => new Promise<ReturnType<typeof makeRows>>((resolve) => {
      resolveRows = resolve;
    }));

    const first = listSessionsCached({ limit: 10 });
    const forced = listSessionsCached({ limit: 5 }, { force: true });

    expect(listMock).toHaveBeenCalledTimes(1);
    resolveRows(makeRows(10));

    await expect(first).resolves.toHaveLength(10);
    await expect(forced).resolves.toHaveLength(5);
  });

  it("keeps in-flight requests coalesced after invalidation", async () => {
    let resolveRows!: (rows: ReturnType<typeof makeRows>) => void;
    listMock.mockImplementationOnce(() => new Promise<ReturnType<typeof makeRows>>((resolve) => {
      resolveRows = resolve;
    }));

    const first = listSessionsCached({ limit: 10 });
    invalidateSessionListCache();
    const second = listSessionsCached({ limit: 5 });

    expect(listMock).toHaveBeenCalledTimes(1);
    resolveRows(makeRows(10));

    await expect(first).resolves.toHaveLength(10);
    await expect(second).resolves.toHaveLength(5);
  });

  it("invalidates only the matching project and lane when scoped", async () => {
    listMock
      .mockResolvedValueOnce(makeRows(2))
      .mockResolvedValueOnce(makeRows(3))
      .mockResolvedValueOnce(makeRows(4));

    await listSessionsCached({ laneId: "lane-1", limit: 2 });
    await listSessionsCached({ laneId: "lane-2", limit: 3 });
    useAppStore.setState({
      project: { rootPath: "/project/b" } as any,
    });
    await listSessionsCached({ laneId: "lane-1", limit: 4 });

    invalidateSessionListCache({ projectRoot: "/project/a", laneId: "lane-1" });

    listMock.mockResolvedValueOnce(makeRows(5));
    useAppStore.setState({
      project: { rootPath: "/project/a" } as any,
    });
    const invalidated = await listSessionsCached({ laneId: "lane-1", limit: 2 });
    const sameProjectOtherLane = await listSessionsCached({ laneId: "lane-2", limit: 3 });
    useAppStore.setState({
      project: { rootPath: "/project/b" } as any,
    });
    const sameLaneOtherProject = await listSessionsCached({ laneId: "lane-1", limit: 4 });

    expect(invalidated).toHaveLength(2);
    expect(sameProjectOtherLane).toHaveLength(3);
    expect(sameLaneOtherProject).toHaveLength(4);
    expect(listMock).toHaveBeenCalledTimes(4);
  });

  it("ignores projectRoot-like cache options that the sessions IPC cannot honor", async () => {
    listMock
      .mockResolvedValueOnce(makeRows(2))
      .mockResolvedValueOnce(makeRows(4));

    await listSessionsCached({ limit: 2 }, { projectRoot: "/project/b" } as any);
    useAppStore.setState({
      project: { rootPath: "/project/b" } as any,
    });
    const projectBRows = await listSessionsCached({ limit: 4 });

    expect(projectBRows).toHaveLength(4);
    expect(listMock).toHaveBeenCalledTimes(2);
  });
});
