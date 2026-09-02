// The iOS Simulator panel schema, built on this machine.
//
// Desktop mounts ADE's compiled Simulator pane through `canvas` / `simulator`.
// Phone and terminal list the same bound status row.

"use strict";

const { COLLECTION_STATUS, DEEPLINK_SIM } = require("./format");

function fallback(title, text, deeplink) {
  return { title, text, deeplink };
}

function buildMainPanel(input = {}) {
  if (input.state === "error") {
    return {
      v: 1,
      title: "iOS Simulator",
      fallback: fallback("iOS Simulator", input.error ?? "Could not read the simulator.", DEEPLINK_SIM),
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
    title: "iOS Simulator",
    fallback: fallback(
      "iOS Simulator",
      "Open ADE on the attached Mac to drive a simulator.",
      DEEPLINK_SIM,
    ),
    body: [{
      component: "canvas",
      engine: "simulator",
      bind: {
        collection: COLLECTION_STATUS,
        limit: 8,
      },
      emptyText: "Open ADE on the attached Mac to drive a simulator.",
    }],
  };
}

function build(panelId, input = {}) {
  if (panelId === "main") return buildMainPanel(input);
  return null;
}

module.exports = { build, buildMainPanel };
