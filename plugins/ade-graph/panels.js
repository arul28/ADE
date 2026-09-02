// The two panel schemas, built on this machine.
//
// Desktop mounts ADE's compiled Graph page through `canvas` / `workspace`.
// Phone and terminal list the same bound lane rows. Every sentence a reader
// sees is here rather than in four renderers.

"use strict";

const {
  COLLECTION_LANES,
  DEEPLINK_GRAPH,
  DEEPLINK_LANE,
  LANE_ROW_ACTIONS,
  readString,
  statusLabel,
} = require("./format");

function fallback(title, text, deeplink) {
  return { title, text, deeplink };
}

function buildGraphPanel(input = {}) {
  if (input.state === "error") {
    return {
      v: 1,
      title: "Graph",
      fallback: fallback("Graph", input.error ?? "Could not load lanes.", DEEPLINK_GRAPH),
      body: [{
        component: "emptyState",
        title: "Could not load the graph",
        description: input.error ?? "The host did not answer.",
        icon: "graph",
        action: { label: "Try again", onPress: { action: "refreshGraph" } },
      }],
    };
  }

  return {
    v: 1,
    title: "Graph",
    fallback: fallback(
      "Graph",
      "Open ADE on the computer that holds this plugin to see lanes on one canvas.",
      DEEPLINK_GRAPH,
    ),
    body: [{
      component: "canvas",
      engine: "workspace",
      bind: {
        collection: COLLECTION_LANES,
        limit: 500,
        allowActions: LANE_ROW_ACTIONS,
      },
      emptyText: "Open a project with a lane to see its topology.",
      onSelect: { action: "openLane" },
    }],
  };
}

function lanePairs(lane) {
  if (!lane) return [];
  const pairs = [
    { key: "Name", value: readString(lane.name) ?? readString(lane.id) ?? "—" },
    { key: "Branch", value: readString(lane.branchRef) ?? readString(lane.baseRef) ?? "—" },
    { key: "Status", value: statusLabel(lane.status) },
    { key: "Kind", value: readString(lane.laneType) ?? "—" },
  ];
  const parent = readString(lane.parentLaneId);
  if (parent) pairs.push({ key: "Parent", value: parent });
  return pairs;
}

function buildLanePanel(input = {}) {
  const lane = input.lane;
  if (!lane) {
    return {
      v: 1,
      title: "Lane",
      fallback: fallback("Lane", input.error ?? "That lane is not in this project.", DEEPLINK_LANE),
      body: [{
        component: "emptyState",
        title: input.error ? "Could not load this lane" : "That lane is not here",
        description: input.error ?? "It is not in this project's open lanes.",
        icon: "git-branch",
        action: { label: "Back to Graph", onPress: { action: "openGraph" } },
      }],
    };
  }

  return {
    v: 1,
    title: readString(lane.name) ?? readString(lane.id) ?? "Lane",
    fallback: fallback(
      readString(lane.name) ?? "Lane",
      "Open ADE on the computer that holds this plugin to inspect this lane.",
      DEEPLINK_LANE,
    ),
    chrome: {
      navActions: [
        { action: "openGraph", label: "Graph", icon: "graph" },
      ],
    },
    body: [
      {
        component: "keyValue",
        items: lanePairs(lane),
      },
      {
        component: "stack",
        gap: "sm",
        children: [
          {
            component: "button",
            label: "Back to Graph",
            onPress: { action: "openGraph" },
          },
        ],
      },
    ],
  };
}

function build(panelId, input = {}) {
  if (panelId === "graph") return buildGraphPanel(input);
  if (panelId === "lane") return buildLanePanel(input);
  return null;
}

module.exports = { build, buildGraphPanel, buildLanePanel };
