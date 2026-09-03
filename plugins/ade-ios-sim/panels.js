// The iOS Sim Control panel schema, built on this machine.
//
// This panel is the FALLBACK tier, not the product. Desktop and web draw the
// plugin's own page (`page/`, built into `dist/`), which the manifest's `sim`
// webview surface names and both sockets point at. The panel is what a client
// that cannot host a page draws instead: the phone and the terminal.
//
// So it says one honest thing rather than pretending. Driving a simulator is
// simctl, xcodebuild and idb against a booted device, all on a Mac — there is
// no phone-shaped version of that, and a tap control on a phone would be a
// button that cannot work. The status row says whether the Mac has a simulator
// running; the fallback line says where to go to drive it.

"use strict";

const { COLLECTION_STATUS, DEEPLINK_SIM, PRODUCT_NAME } = require("./format");

/** The one line every non-Mac client gets. See the note above. */
const NEEDS_A_MAC = "Driving a simulator needs a Mac. Open iOS Sim Control on the attached Mac.";

function fallback(title, text, deeplink) {
  return { title, text, deeplink };
}

function buildMainPanel(input = {}) {
  if (input.state === "error") {
    return {
      v: 1,
      title: PRODUCT_NAME,
      fallback: fallback(PRODUCT_NAME, input.error ?? "Could not read the simulator.", DEEPLINK_SIM),
      body: [{
        component: "emptyState",
        title: "Could not read the simulator",
        description: input.error ?? "The host did not answer.",
        icon: "device-mobile",
        action: { label: "Try again", onPress: { action: "refreshStatus" } },
      }],
    };
  }

  return {
    v: 1,
    title: PRODUCT_NAME,
    fallback: fallback(PRODUCT_NAME, NEEDS_A_MAC, DEEPLINK_SIM),
    body: [
      // The status row, bound so the phone and the terminal list the same fact
      // the page's header shows: which device is live, or that none is.
      {
        component: "list",
        bind: {
          collection: COLLECTION_STATUS,
          limit: 8,
        },
        emptyText: NEEDS_A_MAC,
      },
      // And the sentence, once, under it. A client that draws this panel is a
      // client that cannot drive the simulator, and saying so beats a control
      // that would refuse.
      {
        component: "text",
        text: NEEDS_A_MAC,
        tone: "muted",
      },
    ],
  };
}

function build(panelId, input = {}) {
  if (panelId === "main") return buildMainPanel(input);
  return null;
}

module.exports = { NEEDS_A_MAC, build, buildMainPanel };
