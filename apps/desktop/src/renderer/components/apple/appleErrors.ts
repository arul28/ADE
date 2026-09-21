import {
  APPLE_BUTTON_UNSUPPORTED_CODE,
  APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE,
  APPLE_DEVICE_EXISTS_CODE,
  APPLE_HELPER_UNAVAILABLE_CODE,
  APPLE_NO_INSTALLED_SIMULATORS_CODE,
  APPLE_RECORDING_PINNED_CODE,
  APPLE_STREAM_NOT_RUNNING_CODE,
  IOS_SIMULATOR_LANE_NOT_RESOLVED_CODE,
  IOS_SIMULATOR_LAUNCH_IN_PROGRESS_CODE,
  IOS_SIMULATOR_NO_BUILDABLE_TARGET_CODE,
  IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE,
  IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE,
  IOS_SIMULATOR_TARGET_ROOT_MISMATCH_CODE,
} from "../../../shared/types/iosSimulator";

/**
 * Every helper, `simctl`, registry and IPC failure the Apple pane can meet,
 * mapped to one plain sentence.
 *
 * The rule (§6): the sentence is at most twelve words and never the wire
 * text; the wire text — including Electron's `Error invoking remote method
 * '…': Error:` wrapper — survives only in `detail`, behind the strip's
 * `Details` disclosure. `action` names the one button that would help.
 * `String(error)` never reaches JSX from anywhere in the pane.
 */

export type AppleErrorAction = "start" | "reconnect" | "reinstall";

export type AppleErrorDescription = {
  sentence: string;
  detail: string;
  action?: AppleErrorAction;
};

export const APPLE_GENERIC_ERROR_SENTENCE = "Something went wrong with the simulator.";

/** Electron prefixes a rejected `ipcRenderer.invoke` with the channel. */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

function rawMessage(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

/** The raw message with Electron's IPC wrapper removed. */
export function stripIpcPrefix(message: string): string {
  return message.replace(IPC_PREFIX, "").trim();
}

type Rule = {
  test: (haystack: string) => boolean;
  sentence: string;
  action?: AppleErrorAction;
};

const includes = (needle: string) => (haystack: string) => haystack.includes(needle);
const matches = (pattern: RegExp) => (haystack: string) => pattern.test(haystack);

/**
 * First match wins, so the specific rules sit above the broad ones: a helper
 * "Device not booted" answer must not read as the helper being missing.
 */
const RULES: readonly Rule[] = [
  // The device is off (helper `DeviceSession` refusal, or `simctl` on a shut-down device).
  { test: matches(/Device not booted|current state: Shutdown|is not booted|Unable to boot device/i), sentence: "The device is off.", action: "start" },
  // The helper.
  { test: includes(APPLE_HELPER_UNAVAILABLE_CODE), sentence: "ADE's simulator helper is missing from this install.", action: "reinstall" },
  { test: matches(/simulator helper binary is missing|simulator helper (client )?has been disposed|simulator helper exited/i), sentence: "ADE's simulator helper is missing from this install.", action: "reinstall" },
  { test: matches(/simulator helper is not running yet/i), sentence: "The simulator helper is still starting.", action: "reconnect" },
  { test: matches(/simulator helper did not answer/i), sentence: "The simulator helper stopped answering.", action: "reconnect" },
  // A dev/local build that cannot boot the brain.
  { test: includes("cannot start the ADE brain directly"), sentence: "Install ADE into Applications, then relaunch.", action: "reinstall" },
  // The stream.
  { test: includes(APPLE_STREAM_NOT_RUNNING_CODE), sentence: "Video stopped.", action: "reconnect" },
  { test: matches(/reported no stream address|live view returned no address/i), sentence: "Video stopped.", action: "reconnect" },
  { test: matches(/not-capturing/i), sentence: "Video stopped.", action: "reconnect" },
  // Helper `code`s that are never a user action.
  { test: includes(APPLE_BUTTON_UNSUPPORTED_CODE), sentence: "This device has no such button." },
  { test: matches(/unsupported-button/i), sentence: "This device has no such button." },
  { test: matches(/unknown-device|No simulator with UDID|Simulator device .* is not available|Device \S+ not found/i), sentence: "That simulator is no longer installed." },
  { test: matches(/which is no longer available/i), sentence: "That simulator is no longer installed." },
  { test: matches(/No framebuffer display descriptor|Failed to get device IO|No IO client|Failed to get IO ports|registerScreenCallbacks/i), sentence: "The simulator screen could not be read.", action: "reconnect" },
  { test: matches(/screenshot-failed|screenshot could not be written|screenshot path could not be opened|captured frame could not be decoded/i), sentence: "The screenshot could not be saved." },
  { test: matches(/already-recording/i), sentence: "A recording is already running." },
  { test: matches(/not-recording/i), sentence: "No recording is running." },
  { test: matches(/record-no-frames/i), sentence: "The recording captured no frames." },
  { test: matches(/record-write-failed/i), sentence: "The recording could not be written." },
  { test: includes(APPLE_RECORDING_PINNED_CODE), sentence: "Pinned recordings cannot be deleted." },
  // The per-lane device registry.
  { test: includes(APPLE_NO_INSTALLED_SIMULATORS_CODE), sentence: "No iOS simulators are installed." },
  { test: includes(APPLE_DEVICE_EXISTS_CODE), sentence: "This lane already has a device." },
  { test: includes(APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE), sentence: "ADE only detaches a simulator it did not create." },
  { test: matches(/No installed simulator matches/i), sentence: "That simulator is not installed." },
  { test: matches(/Apple devices belong to a lane|laneId is required|no Apple device yet/i), sentence: "Open the Apple tab from a lane first." },
  { test: matches(/did not become ready within|CoreSimulator may be stuck/i), sentence: "The simulator is taking too long to start.", action: "start" },
  { test: matches(/simctl clone did not report a udid/i), sentence: "The simulator could not be cloned." },
  // Launch and ownership.
  { test: includes(IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE), sentence: "Another chat is driving this device." },
  { test: includes(IOS_SIMULATOR_LAUNCH_IN_PROGRESS_CODE), sentence: "A launch is already in progress." },
  { test: includes(IOS_SIMULATOR_NO_BUILDABLE_TARGET_CODE), sentence: "No iOS app to build was found." },
  { test: includes(IOS_SIMULATOR_TARGET_ROOT_MISMATCH_CODE), sentence: "That app belongs to another checkout." },
  { test: includes(IOS_SIMULATOR_LANE_NOT_RESOLVED_CODE), sentence: "This lane's worktree could not be found." },
  { test: includes(IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE), sentence: "That path is outside the project." },
  { test: matches(/launch was superseded|service has been disposed/i), sentence: "The simulator was reset. Try again." },
  // Platform.
  { test: matches(/only available on macOS|only supported on macOS|need a Mac|macOS is required/i), sentence: "Apple simulators need a Mac runtime." },
  { test: matches(/isn't available on the connected ADE host|not available in this runtime/i), sentence: "This ADE host has no Apple device support." },
  { test: matches(/needs a connection to the ADE machine|has no usable address/i), sentence: "Not connected to the machine that owns the device.", action: "reconnect" },
  { test: matches(/No available iOS Simulator devices/i), sentence: "No iOS simulators are installed." },
  // Preview Lab.
  { test: matches(/mcpbridge|Xcode MCP/i), sentence: "Xcode's preview bridge is not available." },
  { test: matches(/Choose a #Preview|no nearby #Preview|No #Preview/i), sentence: "No SwiftUI preview was found for this file." },
  { test: matches(/timed out|timeout/i), sentence: "The simulator did not answer in time.", action: "reconnect" },
];

/**
 * One sentence for the strip, the raw text for `Details`, and the button that
 * would help. Never throws and never returns an empty sentence.
 */
export function describeAppleError(error: unknown): AppleErrorDescription {
  const detail = rawMessage(error);
  const stripped = stripIpcPrefix(detail);
  const haystack = `${codeOf(error)} ${stripped}`;
  for (const rule of RULES) {
    if (rule.test(haystack)) {
      return { sentence: rule.sentence, detail, ...(rule.action ? { action: rule.action } : {}) };
    }
  }
  return { sentence: APPLE_GENERIC_ERROR_SENTENCE, detail };
}
