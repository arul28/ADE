// Labels and collection keys for ade-ios-sim.
//
// Rows arrive in render shape. Phone and terminal list them; desktop mounts
// ADE's compiled iOS Simulator pane through `canvas` / `simulator`.

"use strict";

const COLLECTION_STATUS = "status";
const PANEL_MAIN = "main";
const STATUS_ROW_KEY = "simulator";

const DEEPLINK_SIM = "ade://plugin/ade-ios-sim/main";

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusRow(status) {
  const session = status && typeof status === "object" ? status.activeSession : null;
  const platform = readString(status?.platform);
  const supported = status?.supported === true || platform === "darwin";
  const live = Boolean(session);
  const device = readString(session?.deviceName) ?? readString(session?.udid);
  const title = !supported
    ? "Needs a Mac"
    : live
      ? (device ?? "Simulator running")
      : "Idle";
  const subtitle = !supported
    ? "Simulator control runs on the attached Mac."
    : live
      ? (device ? `Running on ${device}.` : "A simulator session is live.")
      : "Boot a simulator from the desktop pane.";
  return {
    title,
    subtitle,
    badge: {
      text: !supported ? "MAC ONLY" : live ? "LIVE" : "IDLE",
      tone: !supported ? "warning" : live ? "success" : "neutral",
    },
    supported: supported ? "yes" : "no",
    live: live ? "yes" : "no",
  };
}

module.exports = {
  COLLECTION_STATUS,
  DEEPLINK_SIM,
  PANEL_MAIN,
  STATUS_ROW_KEY,
  readString,
  statusRow,
};
