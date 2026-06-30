import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPrReadInFlightForTest,
  getGitHubSnapshotCoalesced,
  listPrsCoalesced,
  refreshLinkedPrCoalesced,
  refreshPrsCoalesced,
} from "./prReadCache";

const listAll = vi.fn();
const getGitHubSnapshot = vi.fn();
const refresh = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("prReadCache", () => {
  beforeEach(() => {
    clearPrReadInFlightForTest();
    listAll.mockReset();
    getGitHubSnapshot.mockReset();
    refresh.mockReset();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ade: {
          prs: {
            listAll,
            getGitHubSnapshot,
            refresh,
          },
        },
      },
    });
  });

  it("coalesces concurrent PR list reads without caching completed results", async () => {
    const firstRequest = deferred<any[]>();
    listAll
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce([{ id: "pr-2" }]);

    const first = listPrsCoalesced({ projectRoot: "/repo" });
    const second = listPrsCoalesced({ projectRoot: "/repo" });

    expect(listAll).toHaveBeenCalledTimes(1);
    firstRequest.resolve([{ id: "pr-1" }]);

    await expect(first).resolves.toEqual([{ id: "pr-1" }]);
    await expect(second).resolves.toEqual([{ id: "pr-1" }]);
    await expect(listPrsCoalesced({ projectRoot: "/repo" })).resolves.toEqual([{ id: "pr-2" }]);
    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it("keeps forced and non-forced GitHub snapshots isolated", async () => {
    const normal = deferred<any>();
    const forced = deferred<any>();
    getGitHubSnapshot
      .mockReturnValueOnce(normal.promise)
      .mockReturnValueOnce(forced.promise);

    const first = getGitHubSnapshotCoalesced({ force: false }, { projectRoot: "/repo" });
    const second = getGitHubSnapshotCoalesced({ force: true }, { projectRoot: "/repo" });

    expect(getGitHubSnapshot).toHaveBeenCalledTimes(2);
    normal.resolve({ repoPullRequests: [], externalPullRequests: [], repo: null, viewerLogin: null, syncedAt: "now" });
    forced.resolve({ repoPullRequests: [{ id: "fresh" }], externalPullRequests: [], repo: null, viewerLogin: null, syncedAt: "now" });

    await expect(first).resolves.toMatchObject({ repoPullRequests: [] });
    await expect(second).resolves.toMatchObject({ repoPullRequests: [{ id: "fresh" }] });
  });

  it("coalesces PR refreshes with the same id set regardless of order", async () => {
    const request = deferred<any[]>();
    refresh.mockReturnValueOnce(request.promise);

    const first = refreshPrsCoalesced({ prIds: ["pr-2", "pr-1"] }, { projectRoot: "/repo" });
    const second = refreshPrsCoalesced({ prIds: ["pr-1", "pr-2"] }, { projectRoot: "/repo" });

    expect(refresh).toHaveBeenCalledTimes(1);
    request.resolve([{ id: "pr-1" }, { id: "pr-2" }]);

    await expect(first).resolves.toEqual([{ id: "pr-1" }, { id: "pr-2" }]);
    await expect(second).resolves.toEqual([{ id: "pr-1" }, { id: "pr-2" }]);
  });

  it("throttles repeated linked PR refreshes after a fresh result", async () => {
    const stalePr = { id: "pr-1", laneId: "lane-1", state: "open" };
    const freshPr = { ...stalePr, state: "merged" };
    refresh.mockResolvedValueOnce([freshPr]);

    await expect(
      refreshLinkedPrCoalesced(stalePr as any, { projectRoot: "/repo" }),
    ).resolves.toEqual(freshPr);
    await expect(
      refreshLinkedPrCoalesced(stalePr as any, { projectRoot: "/repo" }),
    ).resolves.toEqual(freshPr);

    expect(refresh).toHaveBeenCalledTimes(1);

    refresh.mockResolvedValueOnce([{ ...freshPr, title: "forced" }]);
    await expect(
      refreshLinkedPrCoalesced(stalePr as any, { projectRoot: "/repo", force: true }),
    ).resolves.toMatchObject({ title: "forced" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("preserves missing linked PR refreshes as null during the cooldown", async () => {
    const stalePr = { id: "pr-1", laneId: "lane-1", state: "open" };
    refresh.mockResolvedValueOnce([]);

    await expect(
      refreshLinkedPrCoalesced(stalePr as any, { projectRoot: "/repo" }),
    ).resolves.toBeNull();
    await expect(
      refreshLinkedPrCoalesced(stalePr as any, { projectRoot: "/repo" }),
    ).resolves.toBeNull();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not replace a fresher linked PR row during the cooldown", async () => {
    const stalePr = {
      id: "pr-1",
      laneId: "lane-1",
      state: "open",
      updatedAt: "2026-06-29T14:00:00.000Z",
      lastSyncedAt: "2026-06-29T14:00:00.000Z",
    };
    const fresherPr = {
      ...stalePr,
      state: "merged",
      updatedAt: "2026-06-29T14:01:00.000Z",
      lastSyncedAt: "2026-06-29T14:01:00.000Z",
    };
    refresh.mockResolvedValueOnce([stalePr]);

    await expect(
      refreshLinkedPrCoalesced(stalePr as any, { projectRoot: "/repo" }),
    ).resolves.toEqual(stalePr);
    await expect(
      refreshLinkedPrCoalesced(fresherPr as any, { projectRoot: "/repo" }),
    ).resolves.toEqual(fresherPr);

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
