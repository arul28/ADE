import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPrReadInFlightForTest,
  getGitHubSnapshotCoalesced,
  invalidatePrListCache,
  listPrsCached,
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

  it("does not let two projects share one unpinned in-flight PR read", async () => {
    // With no pin and no projectRoot, `projectKey` answers the literal
    // "active", which every project shares. A read still in flight when the
    // user switched projects was joined by the new project and answered with
    // the old one's rows. Callers must key by their own root.
    const projectA = deferred<any[]>();
    listAll
      .mockReturnValueOnce(projectA.promise)
      .mockResolvedValueOnce([{ id: "pr-from-b" }]);

    const a = listPrsCoalesced({ projectRoot: "/repo-a" });
    const b = listPrsCoalesced({ projectRoot: "/repo-b" });

    expect(listAll).toHaveBeenCalledTimes(2);
    projectA.resolve([{ id: "pr-from-a" }]);
    await expect(a).resolves.toEqual([{ id: "pr-from-a" }]);
    await expect(b).resolves.toEqual([{ id: "pr-from-b" }]);
  });

  it("keeps each machine's settled PR list to itself and lets a PR event supersede a read in flight", async () => {
    const listAllConditional = vi.fn();
    (window as any).ade.prs.listAllConditional = listAllConditional;

    // Same root, two machines: the second must ask its own machine.
    listAllConditional
      .mockResolvedValueOnce({ signature: "a1", prs: [{ id: "pr-on-a" }] })
      .mockResolvedValueOnce({ signature: "b1", prs: [{ id: "pr-on-b" }] });
    await expect(listPrsCached({ projectRoot: "/repo", bindingKey: "machine-a" })).resolves.toEqual([{ id: "pr-on-a" }]);
    await expect(listPrsCached({ projectRoot: "/repo", bindingKey: "machine-b" })).resolves.toEqual([{ id: "pr-on-b" }]);
    expect(listAllConditional).toHaveBeenCalledTimes(2);

    // A read is under way when a PR event lands. The read after the event
    // does not join it, and the older answer is not kept as fresh.
    const scope = { projectRoot: "/repo", bindingKey: "machine-a" };
    invalidatePrListCache(scope);
    const beforeEvent = deferred<any>();
    listAllConditional
      .mockReturnValueOnce(beforeEvent.promise)
      .mockResolvedValueOnce({ signature: "a3", prs: [{ id: "pr-on-a" }, { id: "pr-new" }] });
    const early = listPrsCached(scope);
    invalidatePrListCache(scope);
    const late = listPrsCached(scope);
    expect(listAllConditional).toHaveBeenCalledTimes(4);
    await expect(late).resolves.toEqual([{ id: "pr-on-a" }, { id: "pr-new" }]);
    beforeEvent.resolve({ signature: "a2", prs: [{ id: "pr-on-a" }] });
    await expect(early).resolves.toEqual([{ id: "pr-on-a" }]);
    await expect(listPrsCached(scope)).resolves.toEqual([{ id: "pr-on-a" }, { id: "pr-new" }]);
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

  it("keeps each machine's GitHub snapshot reads and auth refusals to itself", async () => {
    const snapshotB = {
      repoPullRequests: [{ id: "pr-b" }],
      externalPullRequests: [],
      repo: null,
      viewerLogin: "b",
      syncedAt: "now",
    };
    let rejectA!: (error: unknown) => void;
    const machineARejects = new Promise<never>((_resolve, reject) => {
      rejectA = reject;
    });
    getGitHubSnapshot.mockResolvedValue(snapshotB);
    getGitHubSnapshot.mockReturnValueOnce(machineARejects);
    const refused = new Error("GitHub auth missing on this machine.");

    // The same checkout path on two machines is two credential stores and two
    // databases; the window's binding is what tells them apart.
    const first = getGitHubSnapshotCoalesced({}, { projectRoot: "/repo", bindingKey: "remote:env-a:project-1" });
    const firstOutcome = expect(first).rejects.toThrow(/auth missing/);
    const second = getGitHubSnapshotCoalesced({}, { projectRoot: "/repo", bindingKey: "remote:env-b:project-1" });
    expect(getGitHubSnapshot).toHaveBeenCalledTimes(2);

    rejectA(refused);
    await firstOutcome;
    await expect(second).resolves.toMatchObject({ viewerLogin: "b" });

    // A's refusal is remembered for A alone: B's next automatic read still asks.
    await getGitHubSnapshotCoalesced(
      { automaticRefresh: true },
      { projectRoot: "/repo", bindingKey: "remote:env-b:project-1" },
    );
    expect(getGitHubSnapshot).toHaveBeenCalledTimes(3);
    await expect(getGitHubSnapshotCoalesced(
      { automaticRefresh: true },
      { projectRoot: "/repo", bindingKey: "remote:env-a:project-1" },
    )).rejects.toThrow(/auth missing/);
    expect(getGitHubSnapshot).toHaveBeenCalledTimes(3);
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
