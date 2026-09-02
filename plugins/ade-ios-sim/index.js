// ade-ios-sim — ADE's iOS Simulator product as a plugin.
//
// The compiled pane is a Mac-only simctl/idb inspector. This package is the
// same product as a vocabulary panel every client draws:
//
//   * desktop mounts that compiled pane through `canvas` / `simulator`;
//   * the Work rail contributes a `work-rail-pane` that the host wires to the
//     same pane, so chat context insertion stays identical to compiled;
//   * phone and terminal list the bound status row.
//
// The host brain stays. This child only shapes a status row and reads
// `ios_simulator.getStatus`. `official: true` marks the bundled package; it
// buys no extra SDK.

"use strict";

const {
  COLLECTION_STATUS,
  PANEL_MAIN,
  STATUS_ROW_KEY,
  statusRow,
} = require("./format");
const { build } = require("./panels");

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

exports.actions = {
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
  refreshStatus,
  cacheRef: () => cache,
  setCache(next) {
    cache = { ...cache, ...next };
  },
};
