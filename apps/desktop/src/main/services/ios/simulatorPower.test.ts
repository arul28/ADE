import { describe, expect, it } from "vitest";

import { createSimulatorPower } from "./simulatorPower";

/** Every step in the order it ran, as one readable line each. */
function harness(options: { bootError?: string; shutdownError?: string } = {}) {
  const steps: string[] = [];
  const power = createSimulatorPower({
    run: async (file, args) => {
      steps.push(`${file} ${args.join(" ")}`);
      if (args[1] === "boot" && options.bootError) throw new Error(options.bootError);
      if (args[1] === "shutdown" && options.shutdownError) throw new Error(options.shutdownError);
      return { stdout: "", stderr: "" };
    },
    waitForBootStatus: async (device) => {
      steps.push(`bootstatus ${device.udid}`);
    },
    invalidateDeviceList: () => {
      steps.push("invalidate");
    },
    resetHelperDevice: async (udid, reason) => {
      steps.push(`reset ${udid} ${reason}`);
    },
    stopDeviceRecording: async (udid, reason) => {
      steps.push(`stop-recording ${udid} ${reason}`);
    },
  });
  return { power, steps };
}

const device = { udid: "D1", name: "iPhone 17", state: "Shutdown" };

describe("simulatorPower", () => {
  it("boots, waits for bootstatus, then drops the device list and the helper session", async () => {
    const { power, steps } = harness();

    await expect(power.bootDevice(device)).resolves.toBe(true);

    expect(steps).toEqual(["xcrun simctl boot D1", "bootstatus D1", "invalidate", "reset D1 boot"]);
  });

  it("only waits for a device that is already booted, and keeps its helper session", async () => {
    const { power, steps } = harness();

    await expect(power.bootDevice({ ...device, state: "Booted" })).resolves.toBe(false);

    expect(steps).toEqual(["bootstatus D1"]);
  });

  it("treats simctl's already-booted refusal as a device someone else booted", async () => {
    const { power, steps } = harness({ bootError: "Unable to boot device in current state: Booted" });

    await expect(power.bootDevice(device)).resolves.toBe(false);

    expect(steps).toEqual(["xcrun simctl boot D1", "bootstatus D1"]);
  });

  it("stops the recording and resets the helper before it powers off, then drops the device list", async () => {
    const { power, steps } = harness();

    await expect(power.powerOffDevice("D1", "hub-power")).resolves.toBe(true);

    expect(steps).toEqual([
      "stop-recording D1 device-off",
      "reset D1 hub-power",
      "xcrun simctl shutdown D1",
      "invalidate",
    ]);
  });

  it("answers false for a device that is already off, and throws any other failure", async () => {
    const off = harness({ shutdownError: "Unable to shutdown device in current state: Shutdown" });
    await expect(off.power.powerOffDevice("D1", "power-off")).resolves.toBe(false);

    const broken = harness({ shutdownError: "CoreSimulator is not responding" });
    await expect(broken.power.powerOffDevice("D1", "power-off")).rejects.toThrow(/not responding/);
    // The cached list is dropped either way.
    expect(broken.steps.at(-1)).toBe("invalidate");
  });
});
