import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLaneReadInFlightForTest,
  getKeybindingsCoalesced,
  listLaneSnapshotsCoalesced,
  listLanesCoalesced,
} from "./laneReadCache";

const lanesList = vi.fn();
const listSnapshots = vi.fn();
const keybindingsGet = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("laneReadCache", () => {
  beforeEach(() => {
    clearLaneReadInFlightForTest();
    lanesList.mockReset();
    listSnapshots.mockReset();
    keybindingsGet.mockReset();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ade: {
          lanes: {
            list: lanesList,
            listSnapshots,
          },
          keybindings: {
            get: keybindingsGet,
          },
        },
      },
    });
  });

  it("coalesces concurrent lane list reads for the same project and args", async () => {
    const request = deferred<any[]>();
    lanesList.mockReturnValueOnce(request.promise);

    const first = listLanesCoalesced({ includeArchived: false, includeStatus: false }, { projectRoot: "/repo" });
    const second = listLanesCoalesced({ includeStatus: false }, { projectRoot: "/repo" });

    expect(lanesList).toHaveBeenCalledTimes(1);
    request.resolve([{ id: "lane-1" }]);

    await expect(first).resolves.toEqual([{ id: "lane-1" }]);
    await expect(second).resolves.toEqual([{ id: "lane-1" }]);
  });

  it("does not reuse completed lane list reads", async () => {
    lanesList
      .mockResolvedValueOnce([{ id: "lane-1" }])
      .mockResolvedValueOnce([{ id: "lane-2" }]);

    await expect(listLanesCoalesced({ includeStatus: false }, { projectRoot: "/repo" })).resolves.toEqual([{ id: "lane-1" }]);
    await expect(listLanesCoalesced({ includeStatus: false }, { projectRoot: "/repo" })).resolves.toEqual([{ id: "lane-2" }]);

    expect(lanesList).toHaveBeenCalledTimes(2);
  });

  it("keeps lane snapshot reads isolated by requested freshness flags", async () => {
    const fast = deferred<any[]>();
    const decorated = deferred<any[]>();
    listSnapshots
      .mockReturnValueOnce(fast.promise)
      .mockReturnValueOnce(decorated.promise);

    const first = listLaneSnapshotsCoalesced({ includeStatus: false }, { projectRoot: "/repo" });
    const second = listLaneSnapshotsCoalesced({ includeStatus: true }, { projectRoot: "/repo" });

    expect(listSnapshots).toHaveBeenCalledTimes(2);
    fast.resolve([{ lane: { id: "fast" } }]);
    decorated.resolve([{ lane: { id: "decorated" } }]);

    await expect(first).resolves.toEqual([{ lane: { id: "fast" } }]);
    await expect(second).resolves.toEqual([{ lane: { id: "decorated" } }]);
  });

  it("coalesces concurrent keybinding reads per project", async () => {
    const request = deferred<any>();
    keybindingsGet.mockReturnValueOnce(request.promise);

    const first = getKeybindingsCoalesced({ projectRoot: "/repo" });
    const second = getKeybindingsCoalesced({ projectRoot: "/repo" });

    expect(keybindingsGet).toHaveBeenCalledTimes(1);
    request.resolve({ definitions: [], overrides: [] });

    await expect(first).resolves.toEqual({ definitions: [], overrides: [] });
    await expect(second).resolves.toEqual({ definitions: [], overrides: [] });
  });
});
