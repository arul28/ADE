// The four panel schemas, built on this machine.
//
// Every sentence a reader sees is here rather than in four renderers. The copy
// is ported from the compiled History tab (`HistoryPage.tsx`,
// `CommitHistoryView.tsx`, `EventDetailPanel.tsx`).

"use strict";

const {
  COLLECTION_COMMITS,
  COLLECTION_FILES,
  COLLECTION_OPERATIONS,
  COMMIT_ROW_ACTIONS,
  DEEPLINK_ACTIVITY,
  DEEPLINK_COMMIT,
  DEEPLINK_COMMITS,
  DEEPLINK_EVENT,
  FILE_ROW_ACTIONS,
  OPERATION_ROW_ACTIONS,
  formatTime,
  readString,
  statusLabel,
  statusTone,
} = require("./format");

function fallback(title, text, deeplink) {
  return { title, text, deeplink };
}

function commitsWhere() {
  return [{ field: "laneId", in: { $state: "lane" } }];
}

function operationsWhere() {
  return [
    { field: "status", in: { $state: "status" } },
    { field: "laneId", in: { $state: "lane" } },
  ];
}

function laneFilter(lanes) {
  const options = Array.isArray(lanes) ? lanes : [];
  if (options.length < 1) return null;
  return {
    component: "segmented",
    stateKey: "lane",
    label: "Lane",
    default: options[0].id,
    options: options.slice(0, 8).map((lane) => ({
      value: lane.id,
      label: lane.name ?? lane.id,
    })),
  };
}

function buildCommitsPanel(input = {}) {
  if (input.state === "error") {
    return {
      v: 1,
      title: "History",
      fallback: fallback("History", input.error ?? "Could not load commits.", DEEPLINK_COMMITS),
      body: [{
        component: "emptyState",
        title: "Could not load commits",
        description: input.error ?? "The host did not answer.",
        icon: "clock-counter-clockwise",
        action: { label: "Try again", onPress: { action: "refreshCommits" } },
      }],
    };
  }

  const lanes = Array.isArray(input.lanes) ? input.lanes : [];
  const body = [];
  const filter = laneFilter(lanes);
  if (filter) body.push(filter);
  body.push({
    component: "canvas",
    engine: "git-dag",
    bind: {
      collection: COLLECTION_COMMITS,
      keyPrefix: "commit:",
      limit: 500,
      allowActions: COMMIT_ROW_ACTIONS,
      where: commitsWhere(),
    },
    emptyText: lanes.length
      ? "No commits on this lane yet."
      : "Open a project with a lane to see its commit graph.",
    onSelect: { action: "openCommit" },
  });

  return {
    v: 1,
    title: "History",
    fallback: fallback(
      "History",
      "Open ADE on the computer that holds this plugin to browse commits.",
      DEEPLINK_COMMITS,
    ),
    chrome: {
      navActions: [
        { action: "openActivity", label: "Activity", icon: "list" },
      ],
    },
    body,
  };
}

function buildCommitPanel(input = {}) {
  const commit = input.commit;
  if (!commit) {
    return {
      v: 1,
      title: "Commit",
      fallback: fallback("Commit", input.error ?? "That commit is not in this project.", DEEPLINK_COMMIT),
      body: [{
        component: "emptyState",
        title: input.error ? "Could not load this commit" : "That commit is not here",
        description: input.error ?? "It is not in this lane's recent history.",
        icon: "git-commit",
        action: { label: "Back to commits", onPress: { action: "openCommits" } },
      }],
    };
  }

  const sha = readString(commit.sha);
  const laneId = readString(commit.laneId) ?? readString(input.laneId);
  const shortSha = readString(commit.shortSha) ?? (sha ? sha.slice(0, 7) : "");
  const rows = [
    { key: "SHA", value: sha ?? "" },
    { key: "Author", value: readString(commit.authorName) ?? "Unknown" },
  ];
  const when = formatTime(commit.authoredAt);
  if (when) rows.push({ key: "Authored", value: when });
  rows.push({ key: "Pushed", value: commit.pushed === true ? "Yes" : "Not on the upstream yet" });
  if (Array.isArray(commit.refs) && commit.refs.length) {
    rows.push({ key: "Refs", value: commit.refs.join(", ") });
  }

  const message = readString(input.message) ?? readString(commit.subject) ?? "";
  const args = { sha, laneId };

  return {
    v: 1,
    title: readString(commit.subject) || shortSha || "Commit",
    fallback: fallback("Commit", "Open ADE on the computer that holds this plugin to inspect this commit.", DEEPLINK_COMMIT),
    chrome: {
      navActions: [
        { action: "openCommits", label: "Commits" },
        { action: "copySha", label: "Copy SHA", args: { sha } },
        { action: "openOnGitHub", label: "GitHub", args },
      ],
    },
    body: [
      { component: "keyValue", rows },
      ...(message
        ? [{ component: "markdown", text: message.slice(0, 4000) }]
        : []),
      { component: "divider", label: "Changed files" },
      {
        component: "list",
        bind: {
          collection: COLLECTION_FILES,
          keyPrefix: `file:${sha}:`,
          limit: 200,
          allowActions: FILE_ROW_ACTIONS,
        },
        emptyText: "No files listed for this commit.",
      },
      { component: "divider", label: "Git" },
      {
        component: "stack",
        direction: "horizontal",
        gap: "sm",
        wrap: true,
        children: [
          { component: "button", label: "Cherry-pick", onPress: { action: "cherryPick", args, confirm: `Cherry-pick ${shortSha} onto this lane?` } },
          { component: "button", label: "Revert", onPress: { action: "revertCommit", args, confirm: `Revert ${shortSha} on this lane?` } },
          { component: "button", label: "Create branch", onPress: { action: "createBranch", args } },
          { component: "button", label: "Create lane", onPress: { action: "createLane", args } },
          { component: "button", label: "Create tag", onPress: { action: "createTag", args } },
          { component: "button", label: "Copy link", onPress: { action: "copyCommitLink", args } },
          { component: "button", label: "Copy subject", onPress: { action: "copySubject", args } },
          {
            component: "button",
            label: "Mixed reset",
            onPress: {
              action: "resetToCommit",
              args: { ...args, mode: "mixed" },
              confirm: `Mixed-reset this lane to ${shortSha}? Uncommitted files stay.`,
            },
          },
          {
            component: "button",
            label: "Hard reset",
            onPress: {
              action: "resetToCommit",
              args: { ...args, mode: "hard" },
              confirm: `Hard-reset this lane to ${shortSha}? Uncommitted work is discarded.`,
            },
          },
        ],
      },
    ],
  };
}

function buildActivityPanel(input = {}) {
  if (input.state === "error") {
    return {
      v: 1,
      title: "Activity",
      fallback: fallback("Activity", input.error ?? "Could not load operations.", DEEPLINK_ACTIVITY),
      body: [{
        component: "emptyState",
        title: "Could not load activity",
        description: input.error ?? "The host did not answer.",
        icon: "clock-counter-clockwise",
        action: { label: "Try again", onPress: { action: "refreshActivity" } },
      }],
    };
  }

  const lanes = Array.isArray(input.lanes) ? input.lanes : [];
  const children = [
    {
      component: "segmented",
      stateKey: "status",
      label: "Status",
      default: "",
      options: [
        { value: "", label: "All" },
        { value: "running", label: "Running" },
        { value: "succeeded", label: "Succeeded" },
        { value: "failed", label: "Failed" },
        { value: "canceled", label: "Canceled" },
      ],
    },
  ];
  const filter = laneFilter(lanes);
  if (filter) {
    children.push({
      ...filter,
      options: [{ value: "", label: "All lanes" }, ...filter.options],
      default: "",
    });
  }

  return {
    v: 1,
    title: "Activity",
    fallback: fallback(
      "Activity",
      "Open ADE on the computer that holds this plugin to read lane operations.",
      DEEPLINK_ACTIVITY,
    ),
    chrome: {
      navActions: [
        { action: "openCommits", label: "Commits", icon: "git-commit" },
      ],
    },
    body: [
      { component: "stack", direction: "horizontal", gap: "sm", wrap: true, children },
      {
        component: "list",
        bind: {
          collection: COLLECTION_OPERATIONS,
          keyPrefix: "operation:",
          limit: 250,
          allowActions: OPERATION_ROW_ACTIONS,
          where: operationsWhere(),
        },
        emptyText: "No lane operations recorded yet.",
      },
    ],
  };
}

function buildEventPanel(input = {}) {
  const operation = input.operation;
  if (!operation) {
    return {
      v: 1,
      title: "Operation",
      fallback: fallback("Operation", input.error ?? "That operation is not in this project.", DEEPLINK_EVENT),
      body: [{
        component: "emptyState",
        title: input.error ? "Could not load this operation" : "That operation is not here",
        description: input.error ?? "It is not in this project's operation log.",
        icon: "clock-counter-clockwise",
        action: { label: "Back to activity", onPress: { action: "openActivity" } },
      }],
    };
  }

  const status = readString(operation.status) ?? "succeeded";
  const rows = [
    { key: "Kind", value: (readString(operation.kind) ?? "operation").replaceAll("_", " ") },
    { key: "Status", value: statusLabel(status), tone: statusTone(status) },
    { key: "Lane", value: readString(operation.laneName) ?? readString(operation.laneId) ?? "—" },
  ];
  const started = formatTime(operation.startedAt);
  const ended = formatTime(operation.endedAt);
  if (started) rows.push({ key: "Started", value: started });
  if (ended) rows.push({ key: "Ended", value: ended });
  if (readString(operation.preHeadSha)) rows.push({ key: "Before", value: operation.preHeadSha.slice(0, 12) });
  if (readString(operation.postHeadSha)) rows.push({ key: "After", value: operation.postHeadSha.slice(0, 12) });

  return {
    v: 1,
    title: (readString(operation.kind) ?? "Operation").replaceAll("_", " "),
    fallback: fallback("Operation", "Open ADE on the computer that holds this plugin to read this operation.", DEEPLINK_EVENT),
    chrome: {
      navActions: [{ action: "openActivity", label: "Activity" }],
    },
    body: [{ component: "keyValue", rows }],
  };
}

function build(panelId, view = {}) {
  switch (panelId) {
    case "commits":
      return buildCommitsPanel(view);
    case "commit":
      return buildCommitPanel(view);
    case "activity":
      return buildActivityPanel(view);
    case "event":
      return buildEventPanel(view);
    default:
      return null;
  }
}

module.exports = {
  build,
  buildActivityPanel,
  buildCommitPanel,
  buildCommitsPanel,
  buildEventPanel,
  commitsWhere,
  operationsWhere,
};
