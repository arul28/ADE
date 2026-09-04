// The Electron Control panel schema, built on this machine.
//
// This panel is the FALLBACK now, not the product. Every client that can host a
// plugin page draws `page/` instead — both sockets name `webviewSurfaceId:
// "control"` — and this is what the rest get: the phone, the terminal, and any
// host too old to know what a webview surface is.
//
// So it keeps the bound status row and adds the one honest line the phone owes
// its reader: driving an Electron app over CDP happens on the computer the app
// is running on, and no phone is that computer. Saying so is better than a
// blank canvas the reader waits on.

"use strict";

const { COLLECTION_STATUS, DEEPLINK_CONTROL } = require("./format");

/** The one line every non-desktop client gets. */
const NEEDS_DESKTOP =
  "Driving an Electron app needs the desktop it is running on. On a phone this row is the status only.";

function fallback(title, text, deeplink) {
  return { title, text, deeplink };
}

function buildMainPanel(input = {}) {
  if (input.state === "error") {
    return {
      v: 1,
      title: "Electron Control",
      fallback: fallback("Electron Control", input.error ?? "Could not read Electron Control.", DEEPLINK_CONTROL),
      body: [{
        component: "emptyState",
        title: "Could not read Electron Control",
        description: input.error ?? "The host did not answer.",
        icon: "desktop",
        action: { label: "Try again", onPress: { action: "refreshStatus" } },
      }],
    };
  }

  return {
    v: 1,
    title: "Electron Control",
    fallback: fallback(
      "Electron Control",
      NEEDS_DESKTOP,
      DEEPLINK_CONTROL,
    ),
    body: [
      {
        component: "list",
        bind: {
          collection: COLLECTION_STATUS,
          limit: 8,
        },
        emptyText: NEEDS_DESKTOP,
      },
      {
        component: "text",
        variant: "caption",
        tone: "muted",
        text: NEEDS_DESKTOP,
      },
    ],
  };
}

function build(panelId, input = {}) {
  if (panelId === "main") return buildMainPanel(input);
  return null;
}

module.exports = { NEEDS_DESKTOP, build, buildMainPanel };
