import { describe, expect, it } from "vitest";
import type { Agent37Machine } from "../../../shared/agent37";
import type { AdeAccountMachine } from "../../../shared/types/account";
import { matchAgent37Boxes } from "./agent37MachineModel";

function box(instanceId: string, machineKey: string | null): Agent37Machine {
  return {
    instanceId,
    name: null,
    status: "running",
    state: "running",
    type: "box",
    resources: { cpu: 2, memoryGb: 4, diskGb: 20 },
    shapeId: "2x4",
    region: null,
    runningHourlyUsd: 0.008,
    idleHourlyUsd: 0.001,
    spentUsd: null,
    spentSinceMs: null,
    spentIsLifetime: false,
    pastDue: false,
    failure: null,
    machineKey,
    madeByAde: true,
    createdAtMs: null,
    ready: null,
  };
}

function row(machineKey: string, name: string): AdeAccountMachine {
  return { machineKey, name, deviceId: `${machineKey}-device`, platform: "linux", deviceType: "desktop", reachableEndpoints: [], lastSeenAt: null, online: false } as AdeAccountMachine;
}

describe("matchAgent37Boxes", () => {
  // A row's "Delete box" deletes the box it matched, so a wrong match deletes
  // someone's other box.
  it("matches a row to its box by the recorded machine key first, then by hostname, and never gives one box to two rows", () => {
    const keyed = box("aaaa0000", "key-a");
    const unkeyed = box("bbbb1111", null);
    const staleKey = box("cccc2222", "key-gone");
    const matches = matchAgent37Boxes([keyed, unkeyed, staleKey], [
      // Its hostname is another box's id, but its own box recorded its key.
      row("key-a", "cccc2222"),
      row("key-b", "BBBB1111"),
      row("key-c", "cccc2222"),
      // Names a box that already belongs to key-a.
      row("key-x", "aaaa0000"),
      row("key-y", "my-laptop"),
    ]);

    expect(matches.get("key-a")?.instanceId).toBe("aaaa0000");
    expect(matches.get("key-b")?.instanceId).toBe("bbbb1111");
    expect(matches.get("key-c")?.instanceId).toBe("cccc2222");
    expect(matches.has("key-x")).toBe(false);
    expect(matches.has("key-y")).toBe(false);
    expect(matches.size).toBe(3);
  });
});
