import type { AppleLaneDevice } from "../../../shared/types/iosSimulator";
import {
  APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE,
  APPLE_DEVICE_EXISTS_CODE,
  APPLE_DEVICE_NOT_LANE_OWNED_CODE,
  APPLE_DEVICE_OWNED_BY_LANE_CODE,
  APPLE_NO_INSTALLED_SIMULATORS_CODE,
  APPLE_RUNTIME_NOT_INSTALLED_CODE,
} from "../../../shared/types/iosSimulator";

/** The typed refusals of the lane-device code. Each message names its code and the next step. */

export class AppleNoInstalledSimulatorsError extends Error {
  readonly code = APPLE_NO_INSTALLED_SIMULATORS_CODE;

  constructor() {
    super(`${APPLE_NO_INSTALLED_SIMULATORS_CODE}: no iOS Simulator runtime is installed, and ADE never downloads one. Install one from Xcode ▸ Settings ▸ Components, then ask again.`);
    this.name = "AppleNoInstalledSimulatorsError";
  }
}

export class AppleRuntimeNotInstalledError extends Error {
  readonly code = APPLE_RUNTIME_NOT_INSTALLED_CODE;

  constructor(what: string, installed: string[]) {
    super(
      `${APPLE_RUNTIME_NOT_INSTALLED_CODE}: ${what} is not installed on this Mac, and ADE never downloads one. `
        + (installed.length ? `Installed: ${installed.join(", ")}.` : "Install one from Xcode ▸ Settings ▸ Components."),
    );
    this.name = "AppleRuntimeNotInstalledError";
  }
}

export class AppleDeviceExistsError extends Error {
  readonly code = APPLE_DEVICE_EXISTS_CODE;

  constructor(readonly device: AppleLaneDevice) {
    super(`${APPLE_DEVICE_EXISTS_CODE}: lane ${device.laneId} already has ${device.name} (${device.udid}). Delete it first to create another.`);
    this.name = "AppleDeviceExistsError";
  }
}

export class AppleDeviceAttachedNotDeletableError extends Error {
  readonly code = APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE;

  constructor(readonly device: AppleLaneDevice) {
    super(`${APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE}: ${device.name} was attached, not created by ADE, so ADE will not delete it. Pass force to detach it from lane ${device.laneId} instead.`);
    this.name = "AppleDeviceAttachedNotDeletableError";
  }
}

export class AppleDeviceOwnedByLaneError extends Error {
  readonly code = APPLE_DEVICE_OWNED_BY_LANE_CODE;

  constructor(readonly device: AppleLaneDevice) {
    super(`${APPLE_DEVICE_OWNED_BY_LANE_CODE}: ${device.name} (${device.udid}) is held by lane ${device.laneId}. That lane gives it up itself; deleting it here would take its live view away with no warning on its screen.`);
    this.name = "AppleDeviceOwnedByLaneError";
  }
}

/** How the refused simulator is in use, which decides the refusal's reason. */
export type AppleDeviceNotLaneOwnedReason =
  | { kind: "other-lane"; laneLabel: string }
  | { kind: "other-project" }
  | { kind: "running" }
  | { kind: "not-created" };

/**
 * An agent asked for a simulator its lane may not use.
 *
 * An agent may attach an installed simulator no lane holds (the user named it),
 * but never one another lane or another project holds. For every other verb it drives only its
 * lane's own device, so a foreign udid is refused and the refusal points at
 * attaching it or at making the lane's own device.
 */
export class AppleDeviceNotLaneOwnedError extends Error {
  readonly code = APPLE_DEVICE_NOT_LANE_OWNED_CODE;

  constructor(readonly simulator: { udid: string; name: string }, readonly reason: AppleDeviceNotLaneOwnedReason) {
    const OWN_DEVICE = "Use this lane's own device: `ade apple device-create` makes one.";
    const ATTACH_FIRST = "If the user named it, attach it first with `ade apple device-attach --simulator <udid>`; "
      + "otherwise use this lane's own device (`ade apple device-create` makes one).";
    const explain: Record<AppleDeviceNotLaneOwnedReason["kind"], [string, string]> = {
      "other-lane": [`belongs to lane ${reason.kind === "other-lane" ? reason.laneLabel : ""}`, OWN_DEVICE],
      "other-project": ["is an ADE device of another project, which may be using it", OWN_DEVICE],
      running: ["is not this lane's device and it is already running; another lane, a test run or the user may be using it", ATTACH_FIRST],
      "not-created": ["is not this lane's device", ATTACH_FIRST],
    };
    const [why, next] = explain[reason.kind];
    super(`${APPLE_DEVICE_NOT_LANE_OWNED_CODE}: Simulator ${simulator.name} (${simulator.udid}) ${why}. ${next}`);
    this.name = "AppleDeviceNotLaneOwnedError";
  }
}
