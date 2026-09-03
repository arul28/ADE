// ade-ios-sim — iOS Sim Control, ADE's simulator product as a plugin.
//
// ADE's compiled simulator pane is a Mac-only simctl/idb inspector. This package
// is the same product in three tiers:
//
//   * desktop and web draw the plugin's OWN page (`page/`, built into `dist/`),
//     which carries all the chrome and reserves a rect the host engine paints
//     the live screen into;
//   * the Work rail contributes a `work-rail-pane` that names that page through
//     `webviewSurfaceId`, so the rail and the palette open the same thing;
//   * phone and terminal list the bound status row from the `main` panel, which
//     is honest about needing a Mac rather than pretending to drive one.
//
// The host keeps the simulator itself. This child shapes the status row, reads
// `ios_simulator.getStatus`, and answers the page's twenty-five actions
// (`pageActions.js`). `official: true` marks the bundled package; it buys no
// extra SDK.

"use strict";

const {
  COLLECTION_STATUS,
  PANEL_MAIN,
  STATUS_ROW_KEY,
  statusRow,
} = require("./format");
const { build } = require("./panels");
const { createPageActions } = require("./pageActions");

const PUBLISH_ATTEMPTS = 5;
const PUBLISH_RETRY_MS = 3_000;

let sdk = null;
let disposed = false;
let cache = { status: null };

function log(level, message, fields) {
  sdk?.log(level, message, fields);
}

function failureMessage(error, fallback) {
  return error?.message ?? (typeof error === "string" ? error : fallback);
}

async function invokeSim(action, args = {}) {
  return sdk.actions.invoke("ios_simulator", action, args);
}

async function publishSchema(panelId, schema, attempt = 1) {
  if (!sdk || disposed) return;
  try {
    await sdk.panels.update(panelId, schema);
  } catch (error) {
    if (attempt >= PUBLISH_ATTEMPTS) {
      log("warn", `Could not publish the ${panelId} panel: ${error?.message ?? error}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    await publishSchema(panelId, schema, attempt + 1);
  }
}

async function publishMain(input = {}) {
  const schema = build(PANEL_MAIN, input);
  if (!schema) return;
  await publishSchema(PANEL_MAIN, schema);
}

async function replaceStatus(row) {
  try {
    await sdk.collections.put(COLLECTION_STATUS, STATUS_ROW_KEY, row, { ifFull: "evictOldest" });
  } catch (error) {
    log("warn", `Could not store the simulator status row: ${error?.message ?? error}`);
  }
  const existing = await sdk.collections.list(COLLECTION_STATUS, { limit: 20 }).catch(() => []);
  for (const entry of existing) {
    if (entry.key === STATUS_ROW_KEY) continue;
    await sdk.collections.delete(COLLECTION_STATUS, entry.key).catch(() => {});
  }
}

async function refreshStatus() {
  if (!sdk || disposed) return { status: null };
  try {
    const status = await invokeSim("getStatus", {});
    cache.status = status ?? null;
    await replaceStatus(statusRow(cache.status));
    await publishMain({ status: cache.status });
    return { status: cache.status };
  } catch (error) {
    await publishMain({
      state: "error",
      error: failureMessage(error, "Could not read the simulator."),
    });
    return { status: null, error: failureMessage(error, "Could not read the simulator.") };
  }
}

/**
 * The page's table, built at LOAD.
 *
 * A page is a webview the reader can open the instant the rail is drawn, which
 * is well before `activate`'s first `getStatus` has settled. A page that got
 * "no such action" there would draw its empty state and stay there — so `deps`
 * is live getters onto the bindings above rather than their values.
 *
 * `invokeSim` is handed over rather than the SDK, because it is the one place
 * the `ios_simulator` domain is named: the host scopes that call to the project
 * this plugin is bound to, so no handler in `pageActions.js` names a build root
 * and no page can send one.
 */
const pageActions = createPageActions({
  get sdk() { return sdk; },
  invokeSim,
  refresh: () => refreshStatus(),
});

exports.activate = async (ade) => {
  sdk = ade;
  disposed = false;
  await publishMain({ status: null });
  await refreshStatus().catch((error) => {
    log("warn", `The first simulator read failed: ${error?.message ?? error}`);
  });
};

exports.deactivate = async () => {
  disposed = true;
  sdk = null;
};

/**
 * The action table the host dispatches into.
 *
 * Seeded at LOAD with this half's own handlers and the page's, so every id the
 * manifest declares and every id the page can invoke resolves before `activate`
 * has run. The two tables are DISJOINT — no id is defined by both, and
 * `test/pageActions.test.js` asserts it — so the merge order below is a belt on
 * a table with no collisions in it rather than the thing that decides which
 * copy runs.
 */
exports.actions = {
  ...pageActions,

  async refreshStatus() {
    const result = await refreshStatus();
    if (result.error) return { message: result.error, ok: false };
    return { message: "Simulator status updated." };
  },

  async openSimulator() {
    const result = await refreshStatus();
    if (result.error) {
      return { message: result.error, ok: false, navigate: { panelId: PANEL_MAIN } };
    }
    return { navigate: { panelId: PANEL_MAIN } };
  },

  async getStatusTool() {
    return await invokeSim("getStatus", {});
  },
};

exports.__internals = {
  pageActions,
  refreshStatus,
  cacheRef: () => cache,
  setCache(next) {
    cache = { ...cache, ...next };
  },
};
