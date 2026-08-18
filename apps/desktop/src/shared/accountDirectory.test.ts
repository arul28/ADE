import { describe, expect, it } from "vitest";
import {
  accountMachineAdoptionRoutes,
  accountMachineDisplayName,
  parseAccountMachine,
} from "./accountDirectory";
import type { AdeAccountMachine } from "./types/account";

describe("accountMachineAdoptionRoutes", () => {
  it("preserves the hostname and prefers customName only for display", () => {
    const machine = parseAccountMachine({
      machineKey: "machine-studio",
      name: "arul-macbook",
      customName: "Build Mac",
      reachableEndpoints: [],
      online: true,
    });
    expect(machine).toMatchObject({
      name: "arul-macbook",
      customName: "Build Mac",
    });
    expect(accountMachineDisplayName(machine!)).toBe("Build Mac");
  });

  it("orders validated LAN, tailnet, and relay routes", () => {
    const machine: AdeAccountMachine = {
      machineKey: "machine-studio",
      deviceId: "device-studio",
      name: "Studio",
      platform: "macOS",
      deviceType: "desktop",
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "lan", host: "studio.local", port: 8787 },
        { kind: "tailnet", host: "100.75.20.63", port: 8787 },
        {
          kind: "relay",
          url: "wss://relay.example/connect/machine-studio",
        },
        { kind: "tailnet", host: "100.128.0.1", port: 8787 },
        { kind: "lan", url: "wss://public.example/sync" },
      ],
    };

    expect(accountMachineAdoptionRoutes(machine, ["https://relay.example"]))
      .toEqual([
        {
          endpoint: "ws://studio.local:8787/",
          kind: "lan",
        },
        {
          endpoint: "ws://100.75.20.63:8787/",
          kind: "tailnet",
        },
        {
          endpoint: "wss://relay.example/connect/machine-studio",
          kind: "relay",
        },
      ]);
  });
});

describe("parseAccountMachine power", () => {
  it("carries battery, wall power, and a stated suspend through to the renderer", () => {
    const machine = parseAccountMachine({
      machineKey: "machine-laptop",
      name: "MacBook Pro",
      reachableEndpoints: [],
      online: true,
      power: { batteryPercent: 82, charging: false, onExternalPower: false },
      sleepState: "asleep",
      sleepStateAt: 1_800_000_000_000,
    });
    expect(machine?.power).toEqual({
      battery: { percent: 82, charging: false },
      onExternalPower: false,
    });
    expect(machine?.sleepState).toBe("asleep");
    expect(machine?.sleepStateAt).toBe(1_800_000_000_000);
  });

  it("leaves a machine with no battery without one, rather than at zero", () => {
    const machine = parseAccountMachine({
      machineKey: "machine-studio",
      name: "Mac Studio",
      reachableEndpoints: [],
      online: true,
      power: { batteryPercent: null, charging: null, onExternalPower: true },
    });
    expect(machine?.power).toEqual({ onExternalPower: true });
    expect(machine?.power?.battery).toBeUndefined();
  });

  it("omits power entirely for a host too old to report it, and drops malformed values", () => {
    const legacy = parseAccountMachine({
      machineKey: "machine-old",
      name: "Old host",
      reachableEndpoints: [],
      online: true,
    });
    expect(legacy?.power).toBeUndefined();
    expect(legacy?.sleepState).toBeUndefined();

    const malformed = parseAccountMachine({
      machineKey: "machine-bad",
      name: "Bad host",
      reachableEndpoints: [],
      online: true,
      power: { batteryPercent: "97", charging: "yes", onExternalPower: "no" },
      sleepState: "dozing",
      sleepStateAt: "soon",
    });
    // A malformed reading degrades to "unknown", never to a wrong number.
    expect(malformed?.power).toEqual({ onExternalPower: true });
    expect(malformed?.sleepState).toBeUndefined();
    expect(malformed?.sleepStateAt).toBeUndefined();
  });
});
