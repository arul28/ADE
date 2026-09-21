import { describe, expect, it } from "vitest";
import { APPLE_GENERIC_ERROR_SENTENCE, describeAppleError, stripIpcPrefix } from "./appleErrors";

const IPC = (message: string) => new Error(`Error invoking remote method 'ade.iosSimulator.startStream': Error: ${message}`);

function words(sentence: string): number {
  return sentence.trim().split(/\s+/).length;
}

describe("describeAppleError", () => {
  const cases: Array<[unknown, string, string | undefined]> = [
    // helper
    [new Error("Device not booted (state: Shutdown)"), "The device is off.", "start"],
    [new Error("Unable to boot device in current state: Shutdown"), "The device is off.", "start"],
    [Object.assign(new Error("The simulator helper binary is missing at /x"), { code: "APPLE_HELPER_UNAVAILABLE" }), "ADE's simulator helper is missing from this install.", "reinstall"],
    [new Error("APPLE_HELPER_UNAVAILABLE: this runtime cannot start a device."), "ADE's simulator helper is missing from this install.", "reinstall"],
    [new Error("The simulator helper client has been disposed."), "ADE's simulator helper is missing from this install.", "reinstall"],
    [new Error("The simulator helper is not running yet. Try again in a moment."), "The simulator helper is still starting.", "reconnect"],
    [new Error("The simulator helper did not answer `capture-start` within 20s."), "The simulator helper stopped answering.", "reconnect"],
    [Object.assign(new Error("No simulator with UDID X is in the default device set."), { code: "unknown-device" }), "That simulator is no longer installed.", undefined],
    [new Error("Device ABC not found"), "That simulator is no longer installed.", undefined],
    [new Error("No framebuffer display descriptor found"), "The simulator screen could not be read.", "reconnect"],
    [new Error("Failed to get device IO"), "The simulator screen could not be read.", "reconnect"],
    [new Error("No IO client"), "The simulator screen could not be read.", "reconnect"],
    [new Error("Failed to get IO ports"), "The simulator screen could not be read.", "reconnect"],
    [new Error("Descriptor doesn't support registerScreenCallbacks"), "The simulator screen could not be read.", "reconnect"],
    [Object.assign(new Error("The screenshot could not be written."), { code: "screenshot-failed" }), "The screenshot could not be saved.", undefined],
    [new Error("The captured frame could not be decoded."), "The screenshot could not be saved.", undefined],
    [Object.assign(new Error("x"), { code: "already-recording" }), "A recording is already running.", undefined],
    [Object.assign(new Error("x"), { code: "not-recording" }), "No recording is running.", undefined],
    [Object.assign(new Error("x"), { code: "record-no-frames" }), "The recording captured no frames.", undefined],
    [Object.assign(new Error("x"), { code: "record-write-failed" }), "The recording could not be written.", undefined],
    [Object.assign(new Error("x"), { code: "not-capturing" }), "Video stopped.", "reconnect"],
    [Object.assign(new Error("x"), { code: "unsupported-button" }), "This device has no such button.", undefined],
    // brain
    [new Error("This local release build output cannot start the ADE brain directly. Install the channel app into /Applications and relaunch ADE."), "Install ADE into Applications, then relaunch.", "reinstall"],
    // stream
    [new Error("APPLE_STREAM_NOT_RUNNING: no live view is running on lane x."), "Video stopped.", "reconnect"],
    [new Error("The simulator helper started a capture but reported no stream address."), "Video stopped.", "reconnect"],
    [new Error("The live view returned no address."), "Video stopped.", "reconnect"],
    [new Error("APPLE_BUTTON_UNSUPPORTED: shake"), "This device has no such button.", undefined],
    [new Error("APPLE_RECORDING_PINNED: cannot delete"), "Pinned recordings cannot be deleted.", undefined],
    // registry
    [new Error("APPLE_NO_INSTALLED_SIMULATORS: no iOS Simulator runtime is installed"), "No iOS simulators are installed.", undefined],
    [new Error("No available iOS Simulator devices were found."), "No iOS simulators are installed.", undefined],
    [new Error("APPLE_DEVICE_EXISTS: lane x already has iPhone (udid)."), "This lane already has a device.", undefined],
    [new Error("APPLE_DEVICE_ATTACHED_NOT_DELETABLE: iPhone was attached"), "ADE only detaches a simulator it did not create.", undefined],
    [new Error("No installed simulator matches iPhone 99."), "That simulator is not installed.", undefined],
    [new Error("Apple devices belong to a lane. Pass --lane."), "Open the Apple tab from a lane first.", undefined],
    [new Error("A laneId is required: an Apple device belongs to exactly one lane."), "Open the Apple tab from a lane first.", undefined],
    [new Error("The lane has no Apple device yet. Pass a simulator udid to attach."), "Open the Apple tab from a lane first.", undefined],
    [new Error("Lane x owns simulator iPhone (udid), which is no longer available."), "That simulator is no longer installed.", undefined],
    [new Error("Simulator device X is not available."), "That simulator is no longer installed.", undefined],
    [new Error("Simulator iPhone did not become ready within 90s. CoreSimulator may be stuck"), "The simulator is taking too long to start.", "start"],
    [new Error("simctl clone did not report a udid for X."), "The simulator could not be cloned.", undefined],
    // launch / ownership
    [new Error("IOS_SIMULATOR_OWNED_BY_OTHER_SESSION: chat x owns it"), "Another chat is driving this device.", undefined],
    [new Error("IOS_SIMULATOR_LAUNCH_IN_PROGRESS: wait"), "A launch is already in progress.", undefined],
    [new Error("IOS_SIMULATOR_NO_BUILDABLE_TARGET: none"), "No iOS app to build was found.", undefined],
    [new Error("IOS_SIMULATOR_TARGET_ROOT_MISMATCH: x"), "That app belongs to another checkout.", undefined],
    [new Error("IOS_SIMULATOR_LANE_NOT_RESOLVED: x"), "This lane's worktree could not be found.", undefined],
    [new Error("IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT: x"), "That path is outside the project.", undefined],
    [new Error("This iOS simulator launch was superseded before it finished."), "The simulator was reset. Try again.", undefined],
    [new Error("iOS simulator service has been disposed."), "The simulator was reset. Try again.", undefined],
    // platform
    [new Error("Apple device control is only available on macOS."), "Apple simulators need a Mac runtime.", undefined],
    [new Error("The Apple device environment isn't available on the connected ADE host."), "This ADE host has no Apple device support.", undefined],
    [new Error("The Apple device stream relay is not available in this runtime."), "This ADE host has no Apple device support.", undefined],
    [new Error("The live view needs a connection to the ADE machine that owns the device."), "Not connected to the machine that owns the device.", "reconnect"],
    [new Error("The ADE connection has no usable address."), "Not connected to the machine that owns the device.", "reconnect"],
    // preview lab
    [new Error("xcrun mcpbridge is not installed"), "Xcode's preview bridge is not available.", undefined],
    [new Error("Choose a #Preview before rendering."), "No SwiftUI preview was found for this file.", undefined],
    // timeouts
    [new Error("Timed out installing the app on iPhone after 120s."), "The simulator did not answer in time.", "reconnect"],
    // unknown
    [new Error("kaboom"), APPLE_GENERIC_ERROR_SENTENCE, undefined],
    ["a string", APPLE_GENERIC_ERROR_SENTENCE, undefined],
    [null, APPLE_GENERIC_ERROR_SENTENCE, undefined],
    [{ message: 42 }, APPLE_GENERIC_ERROR_SENTENCE, undefined],
  ];

  it.each(cases)("maps %s", (error, sentence, action) => {
    const described = describeAppleError(error);
    expect(described.sentence).toBe(sentence);
    expect(described.action).toBe(action);
  });

  it("keeps every sentence at twelve words or fewer", () => {
    for (const [error] of cases) {
      const { sentence } = describeAppleError(error);
      expect(sentence.length).toBeGreaterThan(0);
      expect(words(sentence)).toBeLessThanOrEqual(12);
    }
  });

  it("maps through Electron's IPC wrapper and keeps the raw text only in detail", () => {
    const described = describeAppleError(IPC("Device not booted (state: Shutdown)"));
    expect(described.sentence).toBe("The device is off.");
    expect(described.action).toBe("start");
    expect(described.sentence).not.toMatch(/Error invoking remote method/);
    expect(described.detail).toMatch(/^Error invoking remote method/);
  });

  it("prefers the device-off rule over the helper rule when both appear", () => {
    const error = Object.assign(new Error("Device not booted (state: Shutdown)"), { code: "APPLE_HELPER_UNAVAILABLE" });
    expect(describeAppleError(error).sentence).toBe("The device is off.");
  });

  it("strips the IPC prefix with and without the inner error name", () => {
    expect(stripIpcPrefix("Error invoking remote method 'x': Error: boom")).toBe("boom");
    expect(stripIpcPrefix("Error invoking remote method 'x': SimHelperError: boom")).toBe("boom");
    expect(stripIpcPrefix("Error invoking remote method 'x': boom")).toBe("boom");
    expect(stripIpcPrefix("boom")).toBe("boom");
  });

  it("carries a string or non-Error object's message into detail", () => {
    expect(describeAppleError("APPLE_STREAM_NOT_RUNNING: gone").detail).toBe("APPLE_STREAM_NOT_RUNNING: gone");
    expect(describeAppleError({ message: "Video stopped: APPLE_STREAM_NOT_RUNNING" }).sentence).toBe("Video stopped.");
    expect(describeAppleError(undefined).detail).toBe("");
  });
});
