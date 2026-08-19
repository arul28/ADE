import { describe, expect, it } from "vitest";
import type { AdeAccountMachine } from "./types/account";
import type { RemoteRuntimeConnectionStatus } from "./types/remoteRuntime";
import {
  accountMachinePresence,
  connectedMachineIds,
  isMachineConnected,
  machineActionLabel,
  machinePowerPhrase,
  machineStatusLine,
} from "./machinePresence";

const NOW = 1_800_000_000_000;

function machine(overrides: Partial<AdeAccountMachine> = {}): AdeAccountMachine {
  return {
    machineKey: "mk-1",
    deviceId: "dev-1",
    name: "Machine",
    customName: null,
    platform: "darwin",
    deviceType: "desktop",
    pubkey: null,
    reachableEndpoints: [],
    lastSeenAt: NOW - 10_000,
    online: true,
    ...overrides,
  };
}

describe("machineStatusLine", () => {
  it("says only the power for a connected machine with no battery", () => {
    // The row's own status chip already says CONNECTED; repeating it here
    // would spend the second line on nothing.
    const line = machineStatusLine(
      machine({ power: { onExternalPower: true } }),
      { connected: true, now: NOW },
    );
    expect(line).toBe("Plugged in");
  });

  it("renders no battery slot at all for a machine with no battery", () => {
    // A Mac Studio showing "0% battery" is a lie about hardware that does not
    // exist, so the absence has to survive all the way to the line.
    const line = machineStatusLine(
      machine({ online: true, power: { onExternalPower: true } }),
      { now: NOW },
    );
    expect(line).toBe("Online · plugged in");
    expect(line).not.toContain("%");
  });

  it("carries the battery percentage for a machine that has one", () => {
    const line = machineStatusLine(
      machine({ online: true, power: { onExternalPower: false, battery: { percent: 97, charging: false } } }),
      { now: NOW },
    );
    expect(line).toBe("Online · 97% battery");
  });

  it("says asleep, with its battery, for a machine that announced a suspend", () => {
    const line = machineStatusLine(
      machine({
        online: true,
        sleepState: "asleep",
        sleepStateAt: NOW - 60_000,
        power: { onExternalPower: false, battery: { percent: 82, charging: false } },
      }),
      { connected: true, now: NOW },
    );
    // An announced suspend outranks a connection flag that has not yet noticed.
    expect(line).toBe("Asleep · 82% battery");
  });

  it("says only the presence when the machine never reported power", () => {
    expect(machineStatusLine(machine({ online: true }), { now: NOW })).toBe("Online");
    // No power AND nothing to add: a lone separator would be worse than silence.
    expect(machineStatusLine(machine(), { connected: true, now: NOW })).toBeNull();
  });

  it("calls a long-silent machine offline", () => {
    const line = machineStatusLine(
      machine({ online: false, lastSeenAt: NOW - 60 * 60_000, power: { onExternalPower: true } }),
      { now: NOW },
    );
    expect(line).toBe("Offline · plugged in");
  });
});

describe("accountMachinePresence", () => {
  it("prefers a stated suspend over a live connection", () => {
    expect(
      accountMachinePresence(
        machine({ sleepState: "asleep", sleepStateAt: NOW - 60_000 }),
        { connected: true, now: NOW },
      ),
    ).toBe("asleep");
  });

  it("infers sleep from recent silence, and gives up after the window", () => {
    expect(
      accountMachinePresence(machine({ online: false, lastSeenAt: NOW - 120_000 }), { now: NOW }),
    ).toBe("asleep");
    expect(
      accountMachinePresence(machine({ online: false, lastSeenAt: NOW - 60 * 60_000 }), { now: NOW }),
    ).toBe("offline");
  });
});

describe("machinePowerPhrase", () => {
  it("keeps the battery reading on a laptop that is plugged in", () => {
    // The normative rule, stated in the header of shared/types/power.ts and
    // implemented once here: a battery reading is never suppressed by wall
    // power. "Plugged in" answers a question nobody asked about a laptop —
    // "82% battery" is what says how long it has if the cable comes out.
    expect(machinePowerPhrase({ onExternalPower: true, battery: { percent: 82, charging: true } }))
      .toBe("82% battery");
    // Only a machine with no battery has nothing better to say.
    expect(machinePowerPhrase({ onExternalPower: true })).toBe("plugged in");
  });

  it("prefers the battery reading, then wall power", () => {
    expect(machinePowerPhrase({ onExternalPower: true, battery: { percent: 50, charging: true } }))
      .toBe("50% battery");
    expect(machinePowerPhrase({ onExternalPower: true })).toBe("plugged in");
    expect(machinePowerPhrase({ onExternalPower: false })).toBe("on battery");
    expect(machinePowerPhrase(null)).toBeNull();
  });
});

describe("connectedMachineIds", () => {
  function connection(
    overrides: Partial<RemoteRuntimeConnectionStatus["target"]> & {
      state?: RemoteRuntimeConnectionStatus["state"];
    } = {},
  ): RemoteRuntimeConnectionStatus {
    const { state = "connected", ...target } = overrides;
    return {
      target: {
        id: "t-1",
        name: "Machine",
        hostname: "machine.local",
        sshUser: null,
        port: null,
        sshKeyPath: null,
        lastSeenArch: null,
        runtimeBinaryVersion: null,
        lastConnectedAt: null,
        ...target,
      },
      state,
      arch: null,
      version: null,
      projects: [],
      lastError: null,
      lastAttemptedAt: null,
      connectedAt: null,
    };
  }

  it("matches a live channel by machine key or by device id", () => {
    // A target carries whichever id it was created with, so both have to count
    // — otherwise a machine we are actively talking to reads as merely online.
    const ids = connectedMachineIds([
      connection({ pairedMachine: { hostIdentity: "dev-1" } }),
      connection({ id: "t-2", pairedMachine: { hostIdentity: "dev-2", machineKey: "mk-2" } }),
    ]);
    expect(isMachineConnected(machine({ machineKey: "mk-x", deviceId: "dev-1" }), ids)).toBe(true);
    expect(isMachineConnected(machine({ machineKey: "mk-2", deviceId: null }), ids)).toBe(true);
    expect(isMachineConnected(machine({ machineKey: "mk-3", deviceId: "dev-3" }), ids)).toBe(false);
  });

  it("ignores targets that are not connected right now", () => {
    const ids = connectedMachineIds([
      connection({ state: "connecting", pairedMachine: { hostIdentity: "dev-1" } }),
      connection({ id: "t-2", state: "error", pairedMachine: { hostIdentity: "dev-2" } }),
    ]);
    expect(ids.machineKeys.size).toBe(0);
    expect(ids.deviceIds.size).toBe(0);
    expect(isMachineConnected(machine({ deviceId: "dev-1" }), ids)).toBe(false);
  });

  it("never matches one namespace's id against the other's", () => {
    // `device_id` carries no unique constraint — the machines table is keyed on
    // (user_id, machine_key) alone — so a reinstall can leave two rows sharing
    // a deviceId, and a machineKey can equal some other row's deviceId. Merged
    // into one set, a single live channel marked BOTH rows Connected.
    const ids = connectedMachineIds([
      connection({ pairedMachine: { hostIdentity: "", machineKey: "shared-id" } }),
    ]);
    expect(isMachineConnected(machine({ machineKey: "shared-id", deviceId: null }), ids))
      .toBe(true);
    expect(isMachineConnected(machine({ machineKey: "mk-other", deviceId: "shared-id" }), ids))
      .toBe(false);
  });

  it("keeps a device-id channel from claiming a like-named machine key", () => {
    const ids = connectedMachineIds([
      connection({ pairedMachine: { hostIdentity: "shared-id" } }),
    ]);
    expect(isMachineConnected(machine({ machineKey: "mk-other", deviceId: "shared-id" }), ids))
      .toBe(true);
    expect(isMachineConnected(machine({ machineKey: "shared-id", deviceId: null }), ids))
      .toBe(false);
  });

  it("reports a machine that announced a suspend as asleep even while connected", () => {
    // The whole thesis: a channel to a sleeping machine does not report itself
    // closed, so the machine's own announcement outranks it.
    expect(
      accountMachinePresence(
        machine({ sleepState: "asleep", sleepStateAt: NOW - 60_000 }),
        { connected: true, now: NOW },
      ),
    ).toBe("asleep");
    expect(accountMachinePresence(machine(), { connected: true, now: NOW })).toBe("connected");
  });

  it("ignores a sleep announcement that arrived with no stamp to age it by", () => {
    // Matches Swift's `syncSleepAnnouncementIsStale`, which has always read an
    // undated announcement as stale. An `asleep` nothing can age out would
    // outrank `connected` forever, with no way back for the user.
    expect(
      accountMachinePresence(machine({ sleepState: "asleep" }), { connected: true, now: NOW }),
    ).toBe("connected");
  });

  it("stops believing a sleep announcement the directory can never clear", () => {
    // `sleep_state` is coalesced forward on every heartbeat, so a machine
    // downgraded to a build that omits `sleepState` keeps its stored `asleep`
    // forever — and `asleep` outranks `connected`. Aging the announcement is
    // the only way back for a machine that is demonstrably heartbeating.
    const stuck = machine({
      sleepState: "asleep",
      sleepStateAt: NOW - (11 * 60_000),
      lastSeenAt: NOW - 5_000,
      online: true,
    });
    expect(accountMachinePresence(stuck, { connected: true, now: NOW })).toBe("connected");
    expect(accountMachinePresence(stuck, { now: NOW })).toBe("online");
  });

  it("still trusts a sleep announcement inside the window", () => {
    const napping = machine({
      sleepState: "asleep",
      sleepStateAt: NOW - 60_000,
      online: true,
    });
    expect(accountMachinePresence(napping, { connected: true, now: NOW })).toBe("asleep");
  });
});

describe("machineActionLabel", () => {
  it("says Wake for a sleeping machine, because connecting is what wakes it", () => {
    expect(machineActionLabel("asleep")).toBe("Wake");
    expect(machineActionLabel("online")).toBe("Connect");
    expect(machineActionLabel("offline")).toBe("Connect");
  });
});
