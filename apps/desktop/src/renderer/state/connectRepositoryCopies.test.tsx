// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdeAccountMachine } from "../../shared/types";
import { useAppStore } from "./appStore";
import { useConnectRepositoryCopies } from "./connectRepositoryCopies";
import { publishAccountProjectList } from "./useRepositoryCopies";

const GAMMA = "gamma-machine-key";
const ORIGIN = "https://github.com/demo-org/atlas.git";

function gammaRow(online: boolean): AdeAccountMachine {
  return {
    machineKey: GAMMA,
    deviceId: null,
    name: "Gamma",
    platform: "darwin",
    deviceType: "desktop",
    reachableEndpoints: [],
    lastSeenAt: Date.now() - (online ? 5_000 : 3_600_000),
    online,
  };
}

describe("useConnectRepositoryCopies", () => {
  let gammaUp = false;
  // Each test starts a day after the last, so no cached directory read carries over.
  let day = 0;
  const connect = vi.fn(async (machineKey: string) =>
    gammaUp
      ? { ok: true as const, machineKey }
      : { ok: false as const, reason: "unreachable" as const, machineKey, message: "no answer" });
  const listMachines = vi.fn(async () => ({ state: "ok" as const, machines: [gammaRow(true)], message: null }));

  beforeEach(() => {
    vi.useFakeTimers();
    day += 1;
    vi.setSystemTime(Date.UTC(2030, 0, day));
    gammaUp = false;
    connect.mockClear();
    listMachines.mockClear();
    (window as unknown as { ade: unknown }).ade = {
      machines: { connect },
      account: { listMachines },
    };
    useAppStore.setState({
      projectBinding: { kind: "local", key: "/work/atlas", rootPath: "/work/atlas", displayName: "atlas", gitOriginUrl: ORIGIN },
    });
    publishAccountProjectList({
      state: "ready",
      projects: [{
        id: "ap_atlas",
        host: "github.com",
        repoId: 1,
        repoKey: "repo:github.com/demo-org/atlas",
        owner: "demo-org",
        name: "atlas",
        defaultBranch: "main",
        addedAt: 1,
        removedAt: null,
        mergedInto: null,
        aliases: ["repo:github.com/demo-org/atlas"],
        copies: [{ projectId: "ap_atlas", machineKey: GAMMA, checkoutId: "c1", rootPath: "/gamma/atlas", isMain: true, lastSeenAt: 1 }],
      }],
    });
  });

  afterEach(() => {
    cleanup();
    publishAccountProjectList(null);
    vi.useRealTimers();
  });

  it.each([
    ["online but not answering", true],
    ["listed as off by the account", false],
  ])("keeps trying a computer that is %s for ten minutes, and joins it within a minute of its return without a focus", async (_label, listedOnline) => {
    listMachines.mockImplementation(async () => ({ state: "ok" as const, machines: [gammaRow(listedOnline)], message: null }));
    renderHook(() => useConnectRepositoryCopies());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    const directoryReadsBefore = listMachines.mock.calls.length;
    // Still checking in the tenth minute: it never gave up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(listMachines.mock.calls.length).toBeGreaterThan(directoryReadsBefore);

    // The computer comes back: the next timed try reaches it, no window focus needed.
    gammaUp = true;
    listMachines.mockImplementation(async () => ({ state: "ok" as const, machines: [gammaRow(true)], message: null }));
    connect.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(connect).toHaveBeenCalledWith(GAMMA, { background: true });
  });

  it("dials nothing while the page is hidden", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    renderHook(() => useConnectRepositoryCopies());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(connect).not.toHaveBeenCalled();
    expect(listMachines).not.toHaveBeenCalled();
    visibility.mockRestore();
  });
});
