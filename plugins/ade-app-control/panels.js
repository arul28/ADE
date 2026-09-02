// The Electron Control panel schema, built on this machine.
//
// Desktop mounts ADE's compiled Control pane through `canvas` / `electron-control`.
// Phone and terminal list the same bound status row.

"use strict";

const { COLLECTION_STATUS, DEEPLINK_CONTROL } = require("./format");

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
      "Open ADE on the attached computer to drive and inspect an Electron app.",
      DEEPLINK_CONTROL,
    ),
    body: [{
      component: "canvas",
      engine: "electron-control",
      bind: {
        collection: COLLECTION_STATUS,
        limit: 8,
      },
      emptyText: "Open ADE on the attached computer to drive an Electron app.",
    }],
  };
}

function build(panelId, input = {}) {
  if (panelId === "main") return buildMainPanel(input);
  return null;
}

module.exports = { build, buildMainPanel };
