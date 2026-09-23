import type { IosSimulatorDevice } from "../../../shared/types/iosSimulator";

/**
 * The one place ADE turns a simulator on or off.
 *
 * A power change has side effects every path must repeat:
 *
 * - The helper's per-device session is bound to one boot. A session that
 *   outlives the boot answers every tap `ok` and moves nothing, so it is reset
 *   after a boot and before a power-off.
 * - A recording outlives a power-off and then blocks every later
 *   `record-start` on the device, so it is stopped first.
 * - The cached `simctl list` still reports the old state, so it is dropped.
 *
 * The Apple service builds one with all three. The lane-delete cascade runs
 * outside that service, with none of them, and uses
 * {@link bareSimulatorPowerOff}.
 */

type RunCommand = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

export type SimulatorPowerResetReason = "power-off" | "boot" | "delete" | "hub-power";

export type SimulatorPowerDeps = {
  run: RunCommand;
  /** `simctl bootstatus -b`, with the service's timeout and message. */
  waitForBootStatus: (device: Pick<IosSimulatorDevice, "udid" | "name">) => Promise<void>;
  /** Drop the cached `simctl list`. */
  invalidateDeviceList: () => void;
  /** Best effort and never throws. */
  resetHelperDevice: (udid: string, reason: SimulatorPowerResetReason) => Promise<void>;
  /** Best effort and never throws. */
  stopDeviceRecording: (udid: string, reason: "device-off") => Promise<void>;
};

export type SimulatorPower = {
  /**
   * Boot a device and wait until CoreSimulator says it is ready.
   *
   * A device that is already booted skips `simctl boot` and only waits on
   * `bootstatus`, which returns at once. True only when this call booted it,
   * which is also the only case that resets the helper session: a device that
   * was already up keeps the session it has.
   */
  bootDevice(device: Pick<IosSimulatorDevice, "udid" | "name" | "state">): Promise<boolean>;
  /**
   * Stop the device's recording, reset its helper session, and power it off.
   *
   * True when `simctl shutdown` ran. False when the device was already off,
   * which is the result the caller wanted. Any other `simctl` failure throws:
   * a stop that silently did nothing is not a stop.
   */
  powerOffDevice(udid: string, reason: Exclude<SimulatorPowerResetReason, "boot">): Promise<boolean>;
};

const SIMCTL_BOOT_TIMEOUT_MS = 120_000;
const SIMCTL_SHUTDOWN_TIMEOUT_MS = 60_000;

/** `simctl boot` refusing a device another caller already booted. */
const ALREADY_BOOTED = /Unable to boot device in current state|current state: Booted|already booted/i;
/** `simctl shutdown` refusing a device that is already off. */
const ALREADY_OFF = /current state: Shutdown|Unable to shutdown device in current state|not booted|Invalid device state/i;

export function createSimulatorPower(deps: SimulatorPowerDeps): SimulatorPower {
  const bootDevice = async (device: Pick<IosSimulatorDevice, "udid" | "name" | "state">): Promise<boolean> => {
    let booted = false;
    if (device.state !== "Booted") {
      try {
        await deps.run("xcrun", ["simctl", "boot", device.udid], { timeoutMs: SIMCTL_BOOT_TIMEOUT_MS });
        booted = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!ALREADY_BOOTED.test(message)) throw error;
      }
    }
    await deps.waitForBootStatus(device);
    if (booted) {
      deps.invalidateDeviceList();
      await deps.resetHelperDevice(device.udid, "boot");
    }
    return booted;
  };

  const powerOffDevice = async (
    udid: string,
    reason: Exclude<SimulatorPowerResetReason, "boot">,
  ): Promise<boolean> => {
    await deps.stopDeviceRecording(udid, "device-off");
    // After the recording is finished (so the helper has nothing left to
    // write) and before the power goes.
    await deps.resetHelperDevice(udid, reason);
    try {
      await deps.run("xcrun", ["simctl", "shutdown", udid], { timeoutMs: SIMCTL_SHUTDOWN_TIMEOUT_MS });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!ALREADY_OFF.test(message)) throw error;
      return false;
    } finally {
      deps.invalidateDeviceList();
    }
  };

  return { bootDevice, powerOffDevice };
}

/**
 * Power-off for a host with no helper, recorder or device list: the lane-delete
 * cascade. Same `simctl shutdown` and the same already-off tolerance.
 */
export function bareSimulatorPowerOff(run: RunCommand): (udid: string) => Promise<boolean> {
  const power = createSimulatorPower({
    run,
    waitForBootStatus: async () => {},
    invalidateDeviceList: () => {},
    resetHelperDevice: async () => {},
    stopDeviceRecording: async () => {},
  });
  return (udid) => power.powerOffDevice(udid, "delete");
}
