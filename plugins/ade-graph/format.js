// Labels, tones, and collection keys for ade-graph.
//
// Rows arrive in render shape. A client compares top-level string fields for
// `where`; it never formats a date. Everything a reader sees is spelled here
// so four clients draw the same words.

"use strict";

const COLLECTION_LANES = "lanes";
const PANEL_GRAPH = "graph";
const PANEL_LANE = "lane";

const DEEPLINK_GRAPH = "ade://plugin/ade-graph/graph";
const DEEPLINK_LANE = "ade://plugin/ade-graph/lane";

const LANE_ROW_ACTIONS = ["openLane"];

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusTone(status) {
  switch (status) {
    case "dirty":
    case "conflict":
      return "warning";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

function statusLabel(status) {
  const text = readString(status);
  if (!text) return "Idle";
  return text.replaceAll("_", " ");
}

function laneRowKey(id) {
  return id;
}

function laneRow(lane) {
  const id = readString(lane?.id);
  if (!id) return null;
  const name = readString(lane.name) ?? id;
  const branch = readString(lane.branchRef) ?? readString(lane.baseRef);
  const status = readString(lane.status) ?? "idle";
  const subtitleParts = [branch, statusLabel(status)].filter(Boolean);
  return {
    title: name,
    subtitle: subtitleParts.join(" · "),
    badge: { text: statusLabel(status).toUpperCase(), tone: statusTone(status) },
    onPress: { action: "openLane", args: { id, laneId: id } },
    id,
    name,
    laneId: id,
    status,
    branchRef: branch ?? "",
    parentLaneId: readString(lane.parentLaneId) ?? "",
    laneType: readString(lane.laneType) ?? "worktree",
  };
}

module.exports = {
  COLLECTION_LANES,
  DEEPLINK_GRAPH,
  DEEPLINK_LANE,
  LANE_ROW_ACTIONS,
  PANEL_GRAPH,
  PANEL_LANE,
  laneRow,
  laneRowKey,
  readString,
  statusLabel,
  statusTone,
};
