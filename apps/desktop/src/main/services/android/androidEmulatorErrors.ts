import {
  isAndroidEmulatorErrorCode,
  type AndroidEmulatorError,
  type AndroidErrorCode,
} from "../../../shared/types/androidEmulator";

/**
 * The one typed refusal of the Android backend. The code is the contract the
 * panel and `ade android` branch on; the message names the next step.
 *
 * Each refusal is an answer, not a fault, so it carries its `adeExpected` kind
 * (`shared/expectedError.ts`): a missing SDK or a busy machine is the
 * machine's set-up, an AVD another lane holds is the user's choice. A crash or
 * a boot that never finished is not marked, so it still reaches Sentry.
 */

const EXPECTED_KIND: Partial<Record<AndroidErrorCode, "user" | "environment">> = {
  ANDROID_SDK_NOT_FOUND: "environment",
  ANDROID_TOOL_MISSING: "environment",
  ANDROID_NO_ACCELERATION: "environment",
  ANDROID_NO_SYSTEM_IMAGE: "environment",
  ANDROID_NO_FREE_PORT: "environment",
  ANDROID_AVD_NOT_FOUND: "user",
  ANDROID_AVD_HELD_BY_OTHER_LANE: "user",
  ANDROID_LANE_HAS_DEVICE: "user",
  ANDROID_AVD_RUNNING: "user",
  ANDROID_NOT_RUNNING: "user",
  ANDROID_PATH_OUTSIDE_LANE: "user",
  // P1 agent suite: a missing element, a build error in the user's code, an app
  // that is not installed are answers about the app, not faults of ADE.
  ANDROID_ELEMENT_NOT_FOUND: "user",
  ANDROID_WAIT_TIMEOUT: "user",
  ANDROID_APP_NOT_FOUND: "user",
  ANDROID_BUILD_FAILED: "user",
  ANDROID_INSTALL_FAILED: "user",
  ANDROID_PACKAGE_NOT_ADE_INSTALLED: "user",
  ANDROID_RECORDING_ACTIVE: "user",
  ANDROID_RECORDING_NOT_FOUND: "user",
  // P3: an image AVDs use, or a test run that already runs, is the person's state.
  ANDROID_SYSTEM_IMAGE_IN_USE: "user",
  ANDROID_TESTS_RUNNING: "user",
};

export class AndroidEmulatorFailure extends Error {
  readonly adeExpected: "user" | "environment" | undefined;

  constructor(
    readonly code: AndroidErrorCode,
    message: string,
    readonly logPath: string | null = null,
  ) {
    super(`${code}: ${message}`);
    this.name = "AndroidEmulatorFailure";
    this.adeExpected = EXPECTED_KIND[code];
  }

  /**
   * The panel's shape: the plain sentence without the code prefix. The panel
   * knows the lifecycle codes only; an agent-suite code (which the panel never
   * shows as a device state) reads as the emulator's generic failure there.
   */
  toAndroidEmulatorError(): AndroidEmulatorError {
    const prefix = `${this.code}: `;
    return {
      code: isAndroidEmulatorErrorCode(this.code) ? this.code : "ANDROID_EMULATOR_EXITED",
      message: this.message.startsWith(prefix) ? this.message.slice(prefix.length) : this.message,
      logPath: this.logPath,
    };
  }
}

/** The lane id every lane call takes, trimmed, or a plain refusal. */
export function requireLaneId(laneId: unknown): string {
  const trimmed = typeof laneId === "string" ? laneId.trim() : "";
  if (!trimmed) throw new Error("laneId is required.");
  return trimmed;
}
