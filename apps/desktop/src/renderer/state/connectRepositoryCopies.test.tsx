// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdeAccountMachine } from "../../shared/types";
import { adeCloudBinding } from "../../shared/adeCloud/binding";
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
  const answer = async (machineKey: string): Promise<
    | { ok: true; machineKey: string }
    | { ok: false; reason: "unreachable" | "no_room"; machineKey: string; message: string }
  > =>
    gammaUp
      ? { ok: true as const, machineKey }
      : { ok: false as const, reason: "unreachable" as const, machineKey, message: "no answer" };
  const connect = vi.fn(answer);
  const listMachines = vi.fn(async () => ({ state: "ok" as const, machines: [gammaRow(true)], message: null }));

  beforeEach(() => {
    vi.useFakeTimers();
    day += 1;
    vi.setSystemTime(Date.UTC(2030, 0, day));
    gammaUp = false;
    connect.mockReset();
    connect.mockImplementation(answer);
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
    useAppStore.setState({ projectBinding: null });
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

  it("keeps trying the copies of a tab bound to ADE Cloud in front", async () => {
    useAppStore.setState({
      projectBinding: adeCloudBinding({ accountProjectId: "ap_atlas", displayName: "atlas", gitOriginUrl: "https://github.com/demo-org/atlas" }),
    });
    renderHook(() => useConnectRepositoryCopies());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    gammaUp = true;
    connect.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(connect).toHaveBeenCalledWith(GAMMA, { background: true });
  });

  it("joins a computer left out for room once a connection frees up, with no focus or change", async () => {
    let room = false;
    connect.mockImplementation(async (machineKey: string) =>
      room
        ? { ok: true as const, machineKey }
        : { ok: false as const, reason: "no_room" as const, machineKey, message: "full" });
    renderHook(() => useConnectRepositoryCopies());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(connect).toHaveBeenCalledTimes(1);
    room = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(connect).toHaveBeenCalledTimes(2);
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
