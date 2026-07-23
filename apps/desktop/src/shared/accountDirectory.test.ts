import { describe, expect, it } from "vitest";
import {
  accountMachineAdoptionRoutes,
} from "./accountDirectory";
import type { AdeAccountMachine } from "./types/account";

describe("accountMachineAdoptionRoutes", () => {
  it("orders validated relay, tailnet, and LAN routes", () => {
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
          endpoint: "wss://relay.example/connect/machine-studio",
          kind: "relay",
        },
        {
          endpoint: "ws://100.75.20.63:8787/",
          kind: "tailnet",
        },
        {
          endpoint: "ws://studio.local:8787/",
          kind: "lan",
        },
      ]);
  });
});
