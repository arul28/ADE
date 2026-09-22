import { describe, expect, it } from "vitest";
import {
  accountMachineAdoptionRoutes,
  accountMachineDisplayName,
  accountMachineRecentActivityWarning,
  accountMachineRemovalConfirmBody,
  accountMachineRowLabel,
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

describe("account machine install label", () => {
  const row = (fields: Record<string, unknown>) =>
    parseAccountMachine({ machineKey: "mk", reachableEndpoints: [], ...fields })!;

  it("tells two installs on one Mac apart", () => {
    expect(accountMachineRowLabel(row({ name: "MacBook Pro · Alpha", channel: "alpha" }))).toBe("MacBook Pro · ADE Alpha");
    expect(accountMachineRowLabel(row({ name: "MacBook Pro", channel: "stable" }))).toBe("MacBook Pro · ADE");
    expect(accountMachineRowLabel(row({ name: "MacBook Pro · Beta", channel: "beta" }))).toBe("MacBook Pro · ADE Beta");
    // A custom home has no channel; its home names it instead.
    expect(accountMachineRowLabel(row({ name: "MacBook Pro", adeHome: "~/lanes/ade-dev" }))).toBe("MacBook Pro · ~/lanes/ade-dev");
    // A person's own name is kept as typed.
    expect(accountMachineRowLabel(row({ name: "MacBook Pro · Alpha", customName: "Work laptop", channel: "alpha" }))).toBe("Work laptop · ADE Alpha");
  });

  it("degrades to the plain name when the directory does not store the install", () => {
    const machine = row({ name: "MacBook Pro · Alpha", channel: "nightly", adeHome: 42 });
    expect(machine.channel).toBeUndefined();
    expect(machine.adeHome).toBeUndefined();
    expect(accountMachineRowLabel(machine)).toBe("MacBook Pro · Alpha");
    // Rename fields keep the bare name.
    expect(accountMachineDisplayName(row({ name: "MacBook Pro", channel: "alpha" }))).toBe("MacBook Pro");
  });
});

describe("account machine removal warning", () => {
  const now = Date.parse("2026-09-22T12:00:00.000Z");
  const seen = (msAgo: number | null) =>
    parseAccountMachine({ machineKey: "mk", reachableEndpoints: [], lastSeenAt: msAgo == null ? null : now - msAgo })!;

  it("warns only for a machine seen in the last five minutes", () => {
    expect(accountMachineRecentActivityWarning(seen(20_000), now)).toBe(
      "It was active less than a minute ago. Removing it disconnects it from your account until someone confirms it on that computer.",
    );
    expect(accountMachineRecentActivityWarning(seen(60_000), now)).toMatch(/^It was active 1 minute ago\./);
    expect(accountMachineRecentActivityWarning(seen(4 * 60_000 + 59_000), now)).toMatch(/^It was active 4 minutes ago\./);
    expect(accountMachineRecentActivityWarning(seen(5 * 60_000), now)).toBeNull();
    expect(accountMachineRecentActivityWarning(seen(null), now)).toBeNull();
  });

  it("puts the warning first and names the way back without \"sign in\"", () => {
    const body = accountMachineRemovalConfirmBody(seen(2 * 60_000), now);
    expect(body.startsWith("It was active 2 minutes ago.")).toBe(true);
    expect(body).toContain("choose Reconnect this computer");
    expect(body).not.toMatch(/sign(ing)? in/i);
  });
});
