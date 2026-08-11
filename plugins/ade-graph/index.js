// ade-graph — the plugin that owns ADE's Graph tab.
//
// It draws nothing. The graph is an interactive canvas compiled into the
// desktop app, which is why it is *gated* rather than rendered: the manifest's
// `surfaces[0].builtin` says "this plugin owns the tab named graph", and the
// desktop shows or hides its own page with the install. Uninstalling gives back
// a rail slot; the /graph route keeps working either way, so old deeplinks live.
//
// The only thing this file does is publish the panel that clients WITHOUT that
// compiled-in page fall back to — a phone, the TUI, a browser. Without it those
// clients would open the tab onto "this plugin hasn't published this view yet",
// which is true of the plugin and useless to the reader.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Attempts to publish the panel before giving up until the next restart. */
const PUBLISH_ATTEMPTS = 5;
const PUBLISH_RETRY_MS = 3_000;

function readPanel() {
  // `__dirname` is the installed plugin root: the host resolves the manifest
  // entry inside it and refuses anything that escapes, so this is the plugin's
  // own tree and nothing else.
  const file = path.join(__dirname, "panels", "main.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Publish, retrying while the host has no project attached.
 *
 * A panel write is project-scoped, and at cold start the machine-scoped plugin
 * host can be running before any project is open. Throwing out of `activate`
 * would read as a crash and start the supervisor's restart backoff, so the
 * failure is absorbed here and retried instead.
 */
async function publishPanel(ade, schema, attempt = 1) {
  try {
    await ade.panels.update("main", schema);
    return true;
  } catch (error) {
    if (attempt >= PUBLISH_ATTEMPTS) {
      ade.log("warn", `Could not publish the Graph panel: ${error && error.message ? error.message : String(error)}`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    return publishPanel(ade, schema, attempt + 1);
  }
}

exports.activate = async (ade) => {
  let schema;
  try {
    schema = readPanel();
  } catch (error) {
    ade.log("error", `panels/main.json is unreadable: ${error && error.message ? error.message : String(error)}`);
    return;
  }
  await publishPanel(ade, schema);
};
