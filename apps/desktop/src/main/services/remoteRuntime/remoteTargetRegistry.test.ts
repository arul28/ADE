import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteTargetRegistry } from "./remoteTargetRegistry";

const originalAdeHome = process.env.ADE_HOME;

afterEach(() => {
  if (originalAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = originalAdeHome;
});

describe("RemoteTargetRegistry", () => {
  it("stores targets under the active ADE_HOME", () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-targets-"));
    process.env.ADE_HOME = adeHome;

    const registry = new RemoteTargetRegistry();
    const target = registry.save({
      name: "Build Server",
      hostname: "203.0.113.10",
      sshUser: "admin",
      port: null,
      sshKeyPath: null,
    });

    expect(registry.path).toBe(path.join(adeHome, "secrets", "remote-machines.json"));
    expect(JSON.parse(fs.readFileSync(registry.path, "utf8"))).toMatchObject({
      version: 1,
      targets: [target],
    });
  });

  it("persists discovered route fallbacks with a normalized primary route", () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-targets-"));
    process.env.ADE_HOME = adeHome;

    const registry = new RemoteTargetRegistry();
    const target = registry.save({
      name: "Build Server",
      hostname: "studio.tailnet.example",
      sshUser: "admin",
      port: null,
      sshKeyPath: null,
      routes: [
        {
          hostname: "studio.tailnet.example",
          port: null,
          source: "tailscale",
          lastSucceededAt: null,
        },
        {
          hostname: "192.168.1.42",
          port: null,
          source: "bonjour",
          lastSucceededAt: null,
        },
      ],
    });

    expect(target.routes).toEqual([
      {
        hostname: "studio.tailnet.example",
        port: null,
        source: "tailscale",
        lastSucceededAt: null,
      },
      {
        hostname: "192.168.1.42",
        port: null,
        source: "bonjour",
        lastSucceededAt: null,
      },
    ]);
    expect(registry.list()[0]?.routes).toEqual(target.routes);
  });

  it("round-trips the manual disconnect marker", () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-targets-"));
    process.env.ADE_HOME = adeHome;

    const registry = new RemoteTargetRegistry();
    const target = registry.save({
      name: "Build Server",
      hostname: "203.0.113.10",
      sshUser: "admin",
      port: 22,
      sshKeyPath: null,
    });

    registry.update(target.id, {
      lastConnectedAt: 1_700_000_000,
      manuallyDisconnectedAt: 1_700_000_100,
    });

    const restored = new RemoteTargetRegistry().get(target.id);
    expect(restored).toMatchObject({
      lastConnectedAt: 1_700_000_000,
      autoConnect: false,
      manuallyDisconnectedAt: 1_700_000_100,
    });
  });

  it("migrates legacy successful targets to auto-connect and leaves new targets off", () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-targets-"));
    process.env.ADE_HOME = adeHome;
    const registry = new RemoteTargetRegistry();
    const target = registry.save({ hostname: "legacy.example.test" });
    expect(target.autoConnect).toBe(false);

    registry.update(target.id, {
      lastConnectedAt: 1_700_000_000,
      autoConnect: undefined,
    });
    expect(new RemoteTargetRegistry().get(target.id)?.autoConnect).toBe(true);
  });

  it("round-trips paired targets with SSH fallback credentials preserved", () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-targets-"));
    process.env.ADE_HOME = adeHome;

    const registry = new RemoteTargetRegistry();
    const target = registry.save({
      name: "Studio",
      hostname: "studio.local",
      transport: "paired",
      pairedMachine: {
        hostIdentity: "host-device-1",
        machineKey: "relay-machine-1",
      },
      sshUser: "admin",
      port: 22,
      sshKeyPath: "/Users/admin/.ssh/id_ed25519",
      routes: [{
        hostname: "studio.local",
        port: null,
        source: "bonjour",
        lastSucceededAt: null,
      }],
    });

    expect(target).toMatchObject({
      transport: "paired",
      pairedMachine: {
        hostIdentity: "host-device-1",
        machineKey: "relay-machine-1",
      },
      sshUser: "admin",
      port: 22,
      sshKeyPath: "/Users/admin/.ssh/id_ed25519",
    });
    expect(new RemoteTargetRegistry().get(target.id)).toEqual(target);
  });

  it("does not synthesize an SSH route for a relay-only paired target", () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-targets-"));
    process.env.ADE_HOME = adeHome;

    const registry = new RemoteTargetRegistry();
    const target = registry.save({
      name: "Relay-only Studio",
      hostname: "relay.example.test",
      transport: "paired",
      pairedMachine: {
        hostIdentity: "host-device-relay",
        machineKey: "relay-machine-only",
      },
      routes: [],
    });

    expect(target.routes).toEqual([]);
    expect(new RemoteTargetRegistry().get(target.id)?.routes).toEqual([]);
  });

  it("removes only targets created by the account that signed out", () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-account-targets-"));
    process.env.ADE_HOME = adeHome;
    const registry = new RemoteTargetRegistry();
    const manual = registry.save({
      hostname: "manual.example.test",
      sshUser: "admin",
    });
    const owned = registry.save({
      hostname: "account-a.example.test",
      accountOwnerUserId: "account-a",
    });
    const other = registry.save({
      hostname: "account-b.example.test",
      accountOwnerUserId: "account-b",
    });

    expect(registry.removeAccountOwned("account-a")).toEqual([owned]);
    expect(registry.list().map((target) => target.id)).toEqual([
      other.id,
      manual.id,
    ]);
    expect(registry.pruneAccountOwned("account-b")).toEqual([]);
    expect(registry.pruneAccountOwned(null)).toEqual([other]);
    expect(registry.list()).toEqual([manual]);
  });

  it("does not turn an existing user-paired target into account-owned data", () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-manual-target-"));
    process.env.ADE_HOME = adeHome;
    const registry = new RemoteTargetRegistry();
    const manual = registry.save({ hostname: "studio.example.test" });

    const revisitedThroughAccount = registry.save({
      hostname: "studio.example.test",
      accountOwnerUserId: "account-a",
    });

    expect(revisitedThroughAccount.id).toBe(manual.id);
    expect(revisitedThroughAccount.accountOwnerUserId).toBeNull();
    expect(registry.removeAccountOwned("account-a")).toEqual([]);
  });

  it("lets an explicit manual pairing declassify an account-owned target", () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-manual-repair-target-"));
    process.env.ADE_HOME = adeHome;
    const registry = new RemoteTargetRegistry();
    const accountTarget = registry.save({
      hostname: "studio.example.test",
      accountOwnerUserId: "account-a",
    });

    const manuallyRepaired = registry.save({
      hostname: "studio.example.test",
      accountOwnerUserId: null,
    });

    expect(manuallyRepaired.id).toBe(accountTarget.id);
    expect(manuallyRepaired.accountOwnerUserId).toBeNull();
    expect(registry.removeAccountOwned("account-a")).toEqual([]);
    expect(registry.get(accountTarget.id)).toEqual(manuallyRepaired);
  });
});
