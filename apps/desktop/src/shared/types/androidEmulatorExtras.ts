/**
 * The Android emulator contract, extra devices: a lane can hold more AVDs
 * beside its own one, as an Apple lane holds extra simulators. Re-exported
 * from `androidEmulator.ts`; import from there.
 *
 * The lane's own device stays "the lane device": it streams, records, runs
 * the tests, and every verb without `device` acts on it. An extra is an AVD
 * ADE made for the lane (`device-create --extra`). It boots beside the lane
 * device, takes an install or a launch with `--device <avd>`, and can become
 * the lane device (`device-promote`). ADE deletes it with the lane.
 */

import type {
  AndroidAvd,
  AndroidEmulatorError,
  AndroidLaneArgs,
  AndroidLaneDevice,
  AndroidLaneDeviceStatus,
} from "./androidEmulator";
import type { AndroidPowerOffRecord } from "./androidEmulatorControl";

/**
 * How many extra devices one lane may hold beside its own by default.
 * `ADE_ANDROID_LANE_EXTRA_DEVICES` in ADE's environment raises it, up to
 * `ANDROID_LANE_EXTRA_DEVICE_MAX`. Each booted one holds 2 to 5 GB of RAM.
 */
export const ANDROID_LANE_EXTRA_DEVICE_LIMIT = 2;
export const ANDROID_LANE_EXTRA_DEVICE_MAX = 8;

/** One extra device of the lane, as `status` and the picker read it. */
export type AndroidLaneExtraStatus = {
  /** The row: `extra` is true and `origin` is always `created`. */
  device: AndroidLaneDevice;
  /** The AVD on disk, or null when its folder is gone. */
  avd: AndroidAvd | null;
  state: "off" | "starting" | "booted" | "stopping" | "crashed";
  /** Set when `state` is `crashed` or its last start failed. */
  error: AndroidEmulatorError | null;
  /** Why ADE powered it off (the idle timer), until its next start. */
  poweredOff?: AndroidPowerOffRecord | null;
};

/**
 * `devicePromote`: one of the lane's extra devices becomes the lane's own
 * device (the one that streams, records, launches builds and runs tests).
 *
 * The lane's old device is kept: an AVD ADE made becomes an extra in the
 * promoted one's place (the extra count does not change), and the user's
 * own AVD is released back to them (stopped if ADE started it, never
 * deleted). Refused with `ANDROID_LANE_DEVICE_BUSY` while the old device
 * starts or stops, streams to a viewer, records, runs tests, installs or
 * launches an app, or another holder has the lane's lease. A running extra
 * stays running and becomes the lane's running device.
 */
export type AndroidDevicePromoteArgs = AndroidLaneArgs & {
  /** The AVD name or the shown name of one of the lane's extra devices. */
  device: string;
  /** The caller's chat, set by the RPC server for an agent: its own lease is no refusal. */
  chatSessionId?: string | null;
};

export type AndroidDevicePromoteResult = {
  /** The lane's device now. */
  device: AndroidLaneDevice;
  /** The lane's device before, or null when the lane had none. */
  previous: AndroidLaneDevice | null;
  /** What became of `previous`: an extra of this lane, released to the user, or nothing. */
  previousKeptAs: "extra" | "detached" | null;
  /** The lane's status after the swap, extras included. */
  lane: AndroidLaneDeviceStatus;
};

/** Which device an install, launch, start or stop went to, when the caller named one. */
export type AndroidTargetDevice = { avdName: string; extra: boolean };

/** The service methods this section adds. */
export type AndroidEmulatorExtrasServiceApi = {
  devicePromote(args: AndroidDevicePromoteArgs): Promise<AndroidDevicePromoteResult>;
};

/** The agent actions this section adds (`ANDROID_AGENT_ACTIONS` spreads it). */
export const ANDROID_EXTRA_DEVICE_ACTIONS = ["devicePromote"] as const;
export type AndroidExtraDeviceAction = (typeof ANDROID_EXTRA_DEVICE_ACTIONS)[number];
