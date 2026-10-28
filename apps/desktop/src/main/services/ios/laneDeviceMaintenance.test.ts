import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppleLaneDevice } from "../../../shared/types/iosSimulator";
import { APPLE_DEVICE_ACTIVITY_FILE, createLaneDeviceMaintenance } from "./laneDeviceMaintenance";
import type { LaneDeviceRegistry } from "./laneDeviceRegistry";

/**
 * Idle power-off must not power off a device someone is using outside ADE:
 * a raw `simctl boot` (CoreSimulator's last-boot time), a boot still running,
 * or a raw `simctl install` (the device's app folder changes). Only the
 * process boundary is faked: `simctl`/`ps` answers and the device folder.
 */
describe("lane device idle power-off", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const UDID = "11111111-2222-3333-4444-555555555555";
  const T0 = Date.parse("2026-10-27T10:00:00Z");
  const HOUR = 60 * 60_000;

  it.each([
    { name: "a device everything says is idle is powered off", state: "Booted", lastBootedAt: T0 - 3 * HOUR, installedAt: null, off: true },
    { name: "a boot outside ADE five minutes ago keeps it on", state: "Booted", lastBootedAt: T0 + 2 * HOUR - 5 * 60_000, installedAt: null, off: false },
    { name: "a device still booting is never idle", state: "Booting", lastBootedAt: T0 - 3 * HOUR, installedAt: null, off: false },
    { name: "an app installed outside ADE ten minutes ago keeps it on", state: "Booted", lastBootedAt: T0 - 3 * HOUR, installedAt: T0 + 2 * HOUR - 10 * 60_000, off: false },
  ])("$name", async ({ state, lastBootedAt, installedAt, off }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-idle-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, UDID), { recursive: true });
    const activity = path.join(root, UDID, APPLE_DEVICE_ACTIVITY_FILE);
    fs.writeFileSync(activity, "old");
    fs.utimesSync(activity, new Date(T0 - 3 * HOUR), new Date(T0 - 3 * HOUR));
    const bundles = path.join(root, UDID, "data", "Containers", "Bundle", "Application");
    fs.mkdirSync(bundles, { recursive: true });
    const bundlesAt = new Date(installedAt ?? T0 - 3 * HOUR);
    fs.utimesSync(bundles, bundlesAt, bundlesAt);

    let clock = T0;
    const device: AppleLaneDevice = {
      laneId: "lane", udid: UDID, name: "iPad extra", origin: "created", family: "ipad", runtime: "iOS 27.0", createdAt: new Date(T0 - 4 * HOUR).toISOString(), extra: true,
    };
    const powerOffDevice = vi.fn(async () => undefined);
    const maintenance = createLaneDeviceMaintenance({
      laneDevices: { list: () => [device] } as unknown as LaneDeviceRegistry,
      run: async (command) => {
        if (command === "ps") return { stdout: "", stderr: "" };
        return {
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
                { udid: UDID, name: "iPad extra", state, isAvailable: true, lastBootedAt: new Date(lastBootedAt).toISOString() },
              ],
            },
          }),
          stderr: "",
        };
      },
      powerOffDevice,
      isBusyHere: () => false,
      deviceDataRoot: root,
      idleMs: 30 * 60_000,
      now: () => clock,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    });
    // Two hours after the service started.
    clock = T0 + 2 * HOUR;
    const result = await maintenance.runIdlePass();
    expect(powerOffDevice).toHaveBeenCalledTimes(off ? 1 : 0);
    expect(result.poweredOff.map((entry) => entry.udid)).toEqual(off ? [UDID] : []);
  });
});
