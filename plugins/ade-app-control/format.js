// Labels and collection keys for ade-app-control.
//
// Rows arrive in render shape. Phone and terminal list them; desktop mounts
// ADE's compiled Electron Control pane through `canvas` / `electron-control`.

"use strict";

const COLLECTION_STATUS = "status";
const PANEL_MAIN = "main";
const STATUS_ROW_KEY = "control";

const DEEPLINK_CONTROL = "ade://plugin/ade-app-control/main";

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusRow(status) {
  const session = status && typeof status === "object" ? status.activeSession : null;
  const supported = status?.supported !== false;
  const live = Boolean(session);
  const title = !supported
    ? "Not available on this machine"
    : live
      ? "Attached"
      : "Idle";
  const subtitle = !supported
    ? "Electron Control drives an app on the computer this project is attached to."
    : live
      ? (readString(session?.title) ?? readString(session?.url) ?? "An Electron renderer is attached.")
      : "Launch or attach to an Electron app from the desktop pane.";
  return {
    title,
    subtitle,
    badge: {
      text: !supported ? "UNAVAILABLE" : live ? "LIVE" : "IDLE",
      tone: !supported ? "warning" : live ? "success" : "neutral",
    },
    supported: supported ? "yes" : "no",
    live: live ? "yes" : "no",
  };
}

module.exports = {
  COLLECTION_STATUS,
  DEEPLINK_CONTROL,
  PANEL_MAIN,
  STATUS_ROW_KEY,
  readString,
  statusRow,
};
