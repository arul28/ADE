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
      name: "Mac Studio",
      hostname: "100.75.20.63",
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
      name: "Mac Studio",
      hostname: "studio.tailnet.ts.net",
      sshUser: "admin",
      port: null,
      sshKeyPath: null,
      routes: [
        {
          hostname: "studio.tailnet.ts.net",
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
        hostname: "studio.tailnet.ts.net",
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
});
