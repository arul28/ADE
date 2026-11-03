import type { AndroidEmulatorError, AndroidEmulatorErrorCode } from "../../../shared/types/androidEmulator";

/**
 * The one typed refusal of the Android backend. The code is the contract the
 * panel and `ade android` branch on; the message names the next step.
 *
 * Each refusal is an answer, not a fault, so it carries its `adeExpected` kind
 * (`shared/expectedError.ts`): a missing SDK or a busy machine is the
 * machine's set-up, an AVD another lane holds is the user's choice. A crash or
 * a boot that never finished is not marked, so it still reaches Sentry.
 */

const EXPECTED_KIND: Partial<Record<AndroidEmulatorErrorCode, "user" | "environment">> = {
  ANDROID_SDK_NOT_FOUND: "environment",
  ANDROID_TOOL_MISSING: "environment",
  ANDROID_NO_ACCELERATION: "environment",
  ANDROID_NO_SYSTEM_IMAGE: "environment",
  ANDROID_NO_FREE_PORT: "environment",
  ANDROID_AVD_NOT_FOUND: "user",
  ANDROID_AVD_HELD_BY_OTHER_LANE: "user",
  ANDROID_AVD_RUNNING: "user",
  ANDROID_NOT_RUNNING: "user",
};

export class AndroidEmulatorFailure extends Error {
  readonly adeExpected: "user" | "environment" | undefined;

  constructor(
    readonly code: AndroidEmulatorErrorCode,
    message: string,
    readonly logPath: string | null = null,
  ) {
    super(`${code}: ${message}`);
    this.name = "AndroidEmulatorFailure";
    this.adeExpected = EXPECTED_KIND[code];
  }

  /** The panel's shape: the plain sentence without the code prefix. */
  toAndroidEmulatorError(): AndroidEmulatorError {
    const prefix = `${this.code}: `;
    return {
      code: this.code,
      message: this.message.startsWith(prefix) ? this.message.slice(prefix.length) : this.message,
      logPath: this.logPath,
    };
  }
}
