/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LaneSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
} from "../../shared/types";
import { useAppStore, type CrossMachineMachineLanes } from "../state/appStore";
import { THIS_MACHINE_ID } from "../../shared/machineIdentity";
import {
  OTHER_MACHINES_LOOKUP_MS,
  findOnOtherMachines,
  readOtherMachines,
  type OtherMachines,
} from "./otherMachineNavigation";

const LANE_ID = "25f280a4-9c1b-4f2e-8a77-1d5c0b3e6a44";
const FOREIGN_LANE_ID = "6f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";
const FOREIGN_SESSION_ID = "8b1f0c2e-33aa-4b7d-9f10-6d2a51c7e004";

const LOCAL_BINDING: OpenProjectBinding = {
  kind: "local",
  key: "local:/repo",
  rootPath: "/repo",
  displayName: "repo",
  gitOriginUrl: null,
};

const REMOTE_BINDING: OpenProjectBinding = {
  kind: "remote",
  key: "remote:macbook:/repo",
  targetId: "macbook",
  runtimeName: "MacBook Pro (97)",
  projectId: "p1",
  rootPath: "/repo",
  displayName: "repo",
};

const LOCAL_LANES = [{ id: LANE_ID, name: "Local lane", branchRef: "ade/local" } as LaneSummary];

function foreignMachine(overrides: Partial<CrossMachineMachineLanes> = {}): CrossMachineMachineLanes {
  return {
    machineId: "macbook",
    machineName: "MacBook Pro (97)",
    targetId: "macbook",
    projectId: "p1",
    binding: REMOTE_BINDING,
    online: true,
    lanes: [
      { id: LANE_ID, name: "Remote lane", branchRef: "ade/remote" } as LaneSummary,
      { id: FOREIGN_LANE_ID, name: "Only remote", branchRef: "ade/only-remote" } as LaneSummary,
    ],
    sessions: [
      { id: FOREIGN_SESSION_ID, laneId: FOREIGN_LANE_ID } as TerminalSessionSummary,
    ],
    prs: [],
    lastSyncedAtMs: null,
    lanesSyncedAtMs: null,
    error: null,
    ...overrides,
  };
}

function read(): OtherMachines {
  return readOtherMachines(LOCAL_BINDING, LOCAL_LANES);
}

afterEach(() => {
  useAppStore.setState({ crossMachineLanesByMachineId: {} });
  delete (window as unknown as { ade?: unknown }).ade;
  vi.restoreAllMocks();
});

describe("readOtherMachines", () => {
  it("routes a lane, chat and machine that only another machine holds", () => {
    useAppStore.setState({ crossMachineLanesByMachineId: { macbook: foreignMachine() } });
    const other = read();

    // A lane absent from this tab's list resolves to the machine that lists it.
    expect(other.machineIdForLane(FOREIGN_LANE_ID)).toBe("macbook");
    expect(other.hasSession(FOREIGN_SESSION_ID)).toBe(true);
    expect(other.hasSession("no-such-session")).toBe(false);
    expect(other.isActiveMachine("macbook")).toBe(false);
    expect(other.isActiveMachine(THIS_MACHINE_ID)).toBe(true);
  });

  it("lets an explicit machineId beat a local lane with the same id", () => {
    // Lane ids are unique per machine, not globally: the tab and the remote
    // machine can both hold LANE_ID. Without an explicit machineId the tab's
    // copy wins; with one, that machine's copy is the target.
    useAppStore.setState({ crossMachineLanesByMachineId: { macbook: foreignMachine() } });
    const other = read();

    expect(other.machineIdForLane(LANE_ID)).toBeNull();
    expect(other.machineIdForLane(LANE_ID, "macbook")).toBe("macbook");
  });

  it("returns null for a lane no connected machine holds", () => {
    useAppStore.setState({ crossMachineLanesByMachineId: {} });
    expect(read().machineIdForLane(FOREIGN_LANE_ID)).toBeNull();
  });
});

describe("findOnOtherMachines", () => {
  it("returns a match without waiting when the union already holds it", async () => {
    useAppStore.setState({ crossMachineLanesByMachineId: { macbook: foreignMachine() } });
    const getConnectionSnapshot = vi.fn();
    (window as unknown as { ade: unknown }).ade = { remoteRuntime: { getConnectionSnapshot } };
    const onWaitChange = vi.fn();

    await expect(
      findOnOtherMachines(read, (other) => other.machineIdForLane(FOREIGN_LANE_ID), onWaitChange),
    ).resolves.toBe("macbook");

    expect(onWaitChange).not.toHaveBeenCalled();
    expect(getConnectionSnapshot).not.toHaveBeenCalled();
  });

  it("waits for the union when a connected machine may still report the target", async () => {
    let releaseSnapshot: ((value: unknown) => void) | undefined;
    const snapshot = new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
    (window as unknown as { ade: unknown }).ade = {
      remoteRuntime: { getConnectionSnapshot: () => snapshot },
    };
    const waits: boolean[] = [];

    const pending = findOnOtherMachines(
      read,
      (other) => other.machineIdForLane(FOREIGN_LANE_ID),
      (waiting) => waits.push(waiting),
    );

    // Let the miss reach the connection-snapshot await, then report a machine
    // online so the union subscription is installed.
    await Promise.resolve();
    releaseSnapshot?.({ connections: [{ state: "connected", target: { id: "macbook" } }] });
    await Promise.resolve();

    // The union arrives after the wait started; the subscription resolves it.
    useAppStore.setState({ crossMachineLanesByMachineId: { macbook: foreignMachine() } });

    await expect(pending).resolves.toBe("macbook");
    expect(waits).toEqual([true, false]);
  });

  it("gives up without waiting when no machine is online", async () => {
    (window as unknown as { ade: unknown }).ade = {
      remoteRuntime: {
        getConnectionSnapshot: vi.fn().mockResolvedValue({ connections: [{ state: "error", target: { id: "macbook" } }] }),
      },
    };
    const onWaitChange = vi.fn();

    await expect(
      findOnOtherMachines(read, (other) => other.machineIdForLane(FOREIGN_LANE_ID), onWaitChange),
    ).resolves.toBeNull();

    expect(onWaitChange).not.toHaveBeenCalled();
    expect(OTHER_MACHINES_LOOKUP_MS).toBeGreaterThan(0);
  });
});
