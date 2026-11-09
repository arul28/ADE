import { describe, expect, it } from "vitest";
import type { CloudMachine } from "../../../shared/adeCloud";
import type { AdeAccountMachine } from "../../../shared/types/account";
import { isDeletedCloudRow, matchCloudBoxes } from "./cloudMachineModel";

function box(instanceId: string, machineKey: string | null): CloudMachine {
  return {
    instanceId,
    name: null,
    status: "running",
    state: "running",
    type: "box",
    resources: { cpu: 2, memoryGb: 4, diskGb: 20 },
    shapeId: "2x4",
    region: null,
    hoursRate: 1,
    pastDue: false,
    failure: null,
    machineKey,
    createdAtMs: null,
    ready: null,
    sleep: { state: "auto" },
    diskFull: null,
  };
}

function row(machineKey: string, name: string): AdeAccountMachine {
  return { machineKey, name, deviceId: `${machineKey}-device`, platform: "linux", deviceType: "desktop", reachableEndpoints: [], lastSeenAt: null, online: false } as AdeAccountMachine;
}

describe("matchCloudBoxes", () => {
  // A row's "Delete box" deletes the box it matched, so a wrong match deletes
  // someone's other box.
  it("matches a row to its box by the recorded machine key first, then by hostname, and never gives one box to two rows", () => {
    const keyed = box("aaaa0000", "key-a");
    const unkeyed = box("bbbb1111", null);
    const staleKey = box("cccc2222", "key-gone");
    const matches = matchCloudBoxes([keyed, unkeyed, staleKey], [
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

describe("isDeletedCloudRow", () => {
  // The row offers Remove from ADE, so a match on a computer that still
  // exists invites removing it from the account.
  const deleted = ["m7hz9v8tk6", "f9nldrmkoz"];
  it.each([
    { label: "an offline row named by a deleted instance", machine: row("k1", "m7hz9v8tk6"), want: true },
    { label: "the same hostname in another case", machine: row("k2", "F9NLDRMKOZ"), want: true },
    { label: "an online row (the box came back)", machine: { ...row("k3", "m7hz9v8tk6"), online: true }, want: false },
    { label: "a Mac with that name", machine: { ...row("k4", "m7hz9v8tk6"), platform: "macOS" }, want: false },
    { label: "a Linux computer named like an instance id that never was one", machine: row("k5", "ubuntu2204"), want: false },
    { label: "a row with no name", machine: { ...row("k6", ""), name: null }, want: false },
  ])("$label → $want", ({ machine, want }) => {
    expect(isDeletedCloudRow(machine, deleted)).toBe(want);
    // Without a list that was read, nothing is marked.
    expect(isDeletedCloudRow(machine, [])).toBe(false);
  });
});
