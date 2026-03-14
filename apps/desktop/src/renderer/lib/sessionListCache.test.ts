import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
