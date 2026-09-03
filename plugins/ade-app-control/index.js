// ade-app-control — ADE's Electron Control product as a plugin.
//
// The compiled pane was a desktop CDP/PTY inspector. This package is the same
// product in two halves:
//
//   * `page/` draws ALL the chrome — the launch and attach rows, the status
//     pill, the window picker, the blockers card, the inspect list and the
//     type-text field — and reserves a rect the HOST paints the live app view
//     into. Both sockets name it through `webviewSurfaceId: "control"`.
//   * this file is the child the page invokes. It holds the SDK binding, the
//     status row every non-page client lists, and `pageActions.js`, which is the
//     only thing that talks to the `app_control` action domain.
//
// The CDP engine stays in the host, and so does the screencast: a page that
// relayed thirty base64 frames a second would pay a structured clone apiece for
// a picture it cannot draw any faster than the host can.
//
// The `main` panel is the FALLBACK now, not the product — the phone and the
// terminal draw it, because no phone is the computer the Electron app is running
// on. `official: true` marks the bundled package; it buys no extra SDK.

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

async function invokeControl(action, args = {}) {
  return sdk.actions.invoke("app_control", action, args);
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
    log("warn", `Could not store the Electron Control status row: ${error?.message ?? error}`);
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
    const status = await invokeControl("getStatus", {});
    cache.status = status ?? null;
    await replaceStatus(statusRow(cache.status));
    await publishMain({ status: cache.status });
    return { status: cache.status };
  } catch (error) {
    await publishMain({
      state: "error",
      error: failureMessage(error, "Could not read Electron Control."),
    });
    return { status: null, error: failureMessage(error, "Could not read Electron Control.") };
  }
}

exports.activate = async (ade) => {
  sdk = ade;
  disposed = false;
  await publishMain({ status: null });
  await refreshStatus().catch((error) => {
    log("warn", `The first Electron Control read failed: ${error?.message ?? error}`);
  });
};

exports.deactivate = async () => {
  disposed = true;
  sdk = null;
};

/**
 * The page's own action table, built at LOAD.
 *
 * A page is a webview the reader can open the instant the rail is drawn, which
 * is well before `activate`'s first `getStatus` has settled. A table built at
 * activate would answer "no such action" there and the page would draw its
 * blockers card and stay in it — so this is built now and reads `sdk` through a
 * getter, which is null until `activate` binds it and which every handler in
 * `pageActions.js` checks.
 */
const pageActions = createPageActions({
  get sdk() { return sdk; },
});

/**
 * The action table the host dispatches into.
 *
 * The two halves are DISJOINT: no id is defined by both, and
 * `test/pageActions.test.js` asserts it. The page's ids are all prefixed
 * `page…` and this half's are not, which is what keeps them apart by
 * construction rather than by merge order.
 */
exports.actions = {
  ...pageActions,

  async refreshStatus() {
    const result = await refreshStatus();
    if (result.error) return { message: result.error, ok: false };
    return { message: "Electron Control status updated." };
  },

  async openControl() {
    const result = await refreshStatus();
    if (result.error) {
      return { message: result.error, ok: false, navigate: { panelId: PANEL_MAIN } };
    }
    return { navigate: { panelId: PANEL_MAIN } };
  },

  async getStatusTool() {
    return await invokeControl("getStatus", {});
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
