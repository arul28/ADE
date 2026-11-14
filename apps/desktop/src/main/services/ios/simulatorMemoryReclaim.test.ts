import { describe, expect, it } from "vitest";
import {
  classifySimulatorForMemoryReclaim,
  type SimulatorReclaimContext,
  type SimulatorReclaimDevice,
} from "./simulatorMemoryReclaim";

const NOW = Date.parse("2026-11-13T20:00:00Z");
const HOUR = 60 * 60_000;
const UDID = "7615407B-2F0E-4C55-9D7B-0A1B2C3D4E5F";
const OTHER_UDID = "11111111-2222-3333-4444-555555555555";
const SIMULATOR_APP = "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator";
/** The device's own processes, which name it for as long as it is booted. */
const OWN_PROCESSES = [
  `/Library/Developer/CoreSimulator/Volumes/iOS_22A/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.0.simruntime/Contents/Resources/RuntimeRoot/sbin/launchd_sim /Users/dev/Library/Developer/CoreSimulator/Devices/${UDID}/data/var/run/launchd_bootstrap.plist`,
  `/Users/dev/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Bundle/Application/AAAA/App.app/App`,
].join("\n");

/** An ADE lane device that nothing has touched for five hours. */
const quiet: SimulatorReclaimDevice = {
  udid: UDID,
  name: "ADE lane 12",
  state: "Booted",
  lastBootedAtMs: NOW - 5 * HOUR,
  adeOwned: true,
  busyHere: false,
  lastAdeActivityMs: NOW - 5 * HOUR,
  lastInstallChangeMs: 0,
};

function verdict(device: Partial<SimulatorReclaimDevice>, context: Partial<SimulatorReclaimContext>) {
  return classifySimulatorForMemoryReclaim(
    { ...quiet, ...device },
    { nowMs: NOW, psOutput: OWN_PROCESSES, ...context },
  );
}

describe("classifySimulatorForMemoryReclaim", () => {
  it("shuts down a device only its own processes name, and one beside a busy device", () => {
    expect(verdict({}, {})).toEqual({ idle: true });
    expect(verdict({}, { psOutput: `${OWN_PROCESSES}\nxcodebuild test -destination id=${OTHER_UDID}` })).toEqual({ idle: true });
    expect(verdict({ adeOwned: false, lastAdeActivityMs: 0 }, {})).toEqual({ idle: true });
  });

  it.each<[string, Partial<SimulatorReclaimDevice>, Partial<SimulatorReclaimContext>]>([
    ["the process list could not be read", {}, { psOutput: null }],
    ["ADE streams, records or tests on it", { busyHere: true }, {}],
    ["ADE used it a few minutes ago", { lastAdeActivityMs: NOW - 5 * 60_000 }, {}],
    ["an app was installed a few minutes ago", { lastInstallChangeMs: NOW - 5 * 60_000 }, {}],
    ["it booted a few minutes ago", { lastBootedAtMs: NOW - 5 * 60_000 }, {}],
    ["its boot time is unknown", { lastBootedAtMs: null }, {}],
    ["its boot time is unknown and ADE did not make it", { lastBootedAtMs: null, adeOwned: false, lastAdeActivityMs: 0 }, {}],
    ["ADE did not make it and it booted an hour ago", { adeOwned: false, lastBootedAtMs: NOW - HOUR, lastAdeActivityMs: 0 }, {}],
    ["xcodebuild names it", {}, { psOutput: `xcodebuild test -scheme App -destination platform=iOS Simulator,id=${UDID}` }],
    ["a tool names it in lower case", {}, { psOutput: `xcrun simctl io ${UDID.toLowerCase()} recordVideo out.mov` }],
    ["a tool that is not Apple's names it", {}, { psOutput: `node /opt/appium/main.js --udid ${UDID}` }],
    ["xcodebuild names it by its name", {}, { psOutput: "xcodebuild test -destination platform=iOS Simulator,name=ADE lane 12" }],
    ["simctl works on whatever is booted", {}, { psOutput: "xcrun simctl io booted recordVideo out.mov" }],
    ["a test run names no device", {}, { psOutput: "xcodebuild test -scheme App" }],
    ["Simulator.app shows it", {}, { psOutput: SIMULATOR_APP, simulatorAppDeviceUdid: UDID.toLowerCase() }],
    ["Simulator.app is open and it was used an hour ago", { lastAdeActivityMs: NOW - HOUR }, { psOutput: SIMULATOR_APP, simulatorAppDeviceUdid: OTHER_UDID }],
  ])("keeps a device on when %s", (_label, device, context) => {
    expect(verdict(device, context).idle).toBe(false);
  });
});
