// ade-graph — ADE's Graph product as a plugin, built out of public parts.
//
// The compiled Graph tab is a desktop React Flow page over lanes, conflicts,
// PRs and graph_state. This package is the same product as vocabulary panels
// every client draws:
//
//   * desktop mounts that compiled page through `canvas` / `workspace`;
//   * phone and terminal list the same bound lane rows;
//   * a lane detail panel is the way out of a row on those clients.
//
// The host brain stays. This child only shapes rows and reads `sdk.lanes`.
// `official: true` marks the bundled package; it buys no extra SDK.

"use strict";

const {
  COLLECTION_LANES,
  PANEL_GRAPH,
  PANEL_LANE,
  laneRow,
  laneRowKey,
  readString,
} = require("./format");
const { build } = require("./panels");

const PUBLISH_ATTEMPTS = 5;
const PUBLISH_RETRY_MS = 3_000;

let sdk = null;
let disposed = false;
const subscriptions = [];
let cache = {
  lanes: [],
  currentLane: null,
};
let currentLaneId = null;

function log(level, message, fields) {
  sdk?.log(level, message, fields);
}

function failureMessage(error, fallback) {
  return error?.message ?? (typeof error === "string" ? error : fallback);
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

function viewFor(panelId) {
  if (panelId === PANEL_GRAPH) return { lanes: cache.lanes };
  if (panelId === PANEL_LANE) return { lane: cache.currentLane };
  return {};
}

async function publish(panelId) {
  const schema = build(panelId, viewFor(panelId));
  if (!schema) return;
  await publishSchema(panelId, schema);
}

async function replaceCollection(collection, wanted) {
  for (const [key, value] of wanted) {
    try {
      await sdk.collections.put(collection, key, value, { ifFull: "evictOldest" });
    } catch (error) {
      log("warn", `Could not store ${collection} row ${key}: ${error?.message ?? error}`);
    }
  }
  const existing = await sdk.collections.list(collection, { limit: 800 }).catch(() => []);
  for (const row of existing) {
    if (wanted.has(row.key)) continue;
    await sdk.collections.delete(collection, row.key).catch(() => {});
  }
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.lanes)) return value.lanes;
  return [];
}

async function refreshGraph() {
  if (!sdk || disposed) return { lanes: [] };
  try {
    const listed = await sdk.lanes.list();
    cache.lanes = asList(listed).map((lane) => ({
      ...lane,
      id: readString(lane.id),
      name: readString(lane.name) ?? readString(lane.id),
    })).filter((lane) => lane.id);
    const wanted = new Map();
    for (const lane of cache.lanes) {
      const row = laneRow(lane);
      if (row) wanted.set(laneRowKey(lane.id), row);
    }
    await replaceCollection(COLLECTION_LANES, wanted);
    if (!currentLaneId && cache.lanes[0]) currentLaneId = cache.lanes[0].id;
    await publish(PANEL_GRAPH);
    return { lanes: cache.lanes };
  } catch (error) {
    await publishSchema(PANEL_GRAPH, build(PANEL_GRAPH, {
      state: "error",
      error: failureMessage(error, "Could not load lanes."),
    }));
    return { lanes: [], error: failureMessage(error, "Could not load lanes.") };
  }
}

async function refreshLane(args = {}) {
  const laneId = readString(args.laneId) ?? readString(args.id) ?? currentLaneId;
  if (!laneId) return { navigate: { panelId: PANEL_GRAPH } };
  currentLaneId = laneId;
  try {
    const detail = await sdk.lanes.get(laneId);
    cache.currentLane = detail ?? cache.lanes.find((lane) => lane.id === laneId) ?? null;
    if (!cache.currentLane) {
      await publishSchema(PANEL_LANE, build(PANEL_LANE, { error: "That lane is not in this project." }));
      return { navigate: { panelId: PANEL_LANE, context: { laneId } } };
    }
    await publish(PANEL_LANE);
    return { navigate: { panelId: PANEL_LANE, context: { laneId } } };
  } catch (error) {
    await publishSchema(PANEL_LANE, build(PANEL_LANE, {
      error: failureMessage(error, "Could not load this lane."),
    }));
    return { navigate: { panelId: PANEL_LANE, context: { laneId } }, ok: false };
  }
}

exports.activate = async (ade) => {
  sdk = ade;
  disposed = false;
  subscriptions.push(sdk.events.on("lane.changed", () => {
    void refreshGraph().catch((error) => {
      log("debug", `Lane-change graph refresh failed: ${error?.message ?? error}`);
    });
  }));
  await publishSchema(PANEL_GRAPH, build(PANEL_GRAPH, { lanes: [] }));
  await refreshGraph().catch((error) => {
    log("warn", `The first graph read failed: ${error?.message ?? error}`);
  });
};

exports.deactivate = async () => {
  disposed = true;
  while (subscriptions.length) {
    try {
      subscriptions.pop()?.();
    } catch { /* unsubscribe on the way out is not worth a crash */ }
  }
  sdk = null;
};

exports.actions = {
  async refreshGraph() {
    const result = await refreshGraph();
    if (result.error) return { message: result.error, ok: false };
    return { message: `${result.lanes.length} lane${result.lanes.length === 1 ? "" : "s"}.` };
  },

  async openGraph() {
    const result = await refreshGraph();
    if (result.error) return { message: result.error, ok: false, navigate: { panelId: PANEL_GRAPH } };
    return { navigate: { panelId: PANEL_GRAPH } };
  },

  async openLane(args) {
    return await refreshLane(args);
  },

  async listLanesTool() {
    const listed = await sdk.lanes.list();
    return { lanes: asList(listed) };
  },

  async getLaneTool(args) {
    const laneId = readString(args?.laneId) ?? readString(args?.id);
    if (!laneId) return { message: "Name a lane id.", ok: false };
    return await sdk.lanes.get(laneId);
  },
};

exports.__internals = {
  viewFor,
  publish,
  refreshGraph,
  cacheRef: () => cache,
  setCache(next) {
    cache = { ...cache, ...next };
  },
};
