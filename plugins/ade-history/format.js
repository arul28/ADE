// Labels, tones, and collection keys for ade-history.
//
// Rows arrive in render shape. A client compares top-level string fields for
// `where`; it never formats a date. Everything a reader sees is spelled here
// so four clients draw the same words.

"use strict";

const COLLECTION_COMMITS = "commits";
const COLLECTION_OPERATIONS = "operations";
const COLLECTION_FILES = "files";
const COLLECTION_LANES = "lanes";

const PANEL_COMMITS = "commits";
const PANEL_COMMIT = "commit";
const PANEL_ACTIVITY = "activity";
const PANEL_EVENT = "event";

const DEEPLINK_COMMITS = "ade://plugin/ade-history/commits";
const DEEPLINK_COMMIT = "ade://plugin/ade-history/commit";
const DEEPLINK_ACTIVITY = "ade://plugin/ade-history/activity";
const DEEPLINK_EVENT = "ade://plugin/ade-history/event";

const STATE_LANE = "lane";
const STATE_STATUS = "status";

const COMMIT_ROW_ACTIONS = [
  "openCommit",
  "copySha",
  "cherryPick",
  "revertCommit",
];

const OPERATION_ROW_ACTIONS = ["openEvent"];

const FILE_ROW_ACTIONS = [];

const STATUS_LABELS = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusTone(status) {
  switch (status) {
    case "succeeded":
      return "success";
    case "running":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? (readString(status) ?? "Unknown");
}

function formatTime(value) {
  const text = readString(value);
  if (!text) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return text;
  return new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function commitRowKey(laneId, sha) {
  return `commit:${laneId}:${sha}`;
}

function operationRowKey(id) {
  return `operation:${id}`;
}

function fileRowKey(sha, path) {
  return `file:${sha}:${path}`;
}

function commitRow(commit, laneId) {
  const sha = readString(commit?.sha);
  const lane = readString(laneId) ?? readString(commit?.laneId);
  if (!sha || !lane) return null;
  const shortSha = readString(commit.shortSha) ?? sha.slice(0, 7);
  const subject = readString(commit.subject) ?? shortSha;
  const refs = Array.isArray(commit.refs)
    ? commit.refs.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const when = formatTime(commit.authoredAt);
  const subtitleParts = [
    shortSha,
    readString(commit.authorName),
    when,
    refs.length ? refs.slice(0, 4).join(" ") : null,
  ].filter(Boolean);

  return {
    title: subject,
    subtitle: subtitleParts.join(" · "),
    badge: commit.pushed === true
      ? { text: "PUSHED", tone: "success" }
      : { text: "LOCAL", tone: "warning" },
    onPress: { action: "openCommit", args: { sha, laneId: lane } },
    actions: [
      { action: "copySha", label: "Copy SHA", args: { sha } },
      {
        action: "cherryPick",
        label: "Cherry-pick",
        args: { sha, laneId: lane },
        confirm: `Cherry-pick ${shortSha} onto this lane?`,
      },
      {
        action: "revertCommit",
        label: "Revert",
        args: { sha, laneId: lane },
        confirm: `Revert ${shortSha} on this lane?`,
      },
    ],
    sha,
    shortSha,
    parents: Array.isArray(commit.parents)
      ? commit.parents.filter((entry) => typeof entry === "string" && entry.length > 0)
      : [],
    authorName: readString(commit.authorName) ?? "",
    authoredAt: readString(commit.authoredAt) ?? "",
    subject,
    pushed: commit.pushed === true,
    refs,
    laneId: lane,
  };
}

function operationRow(operation) {
  const id = readString(operation?.id);
  if (!id) return null;
  const status = readString(operation.status) ?? "succeeded";
  const kind = readString(operation.kind) ?? "operation";
  const when = formatTime(operation.startedAt) ?? formatTime(operation.endedAt);
  const subtitleParts = [
    readString(operation.laneName) ?? readString(operation.laneId),
    kind.replaceAll("_", " "),
    when,
  ].filter(Boolean);

  return {
    title: kind.replaceAll("_", " "),
    subtitle: subtitleParts.join(" · "),
    badge: { text: statusLabel(status).toUpperCase(), tone: statusTone(status) },
    tone: statusTone(status),
    onPress: { action: "openEvent", args: { operationId: id } },
    status,
    laneId: readString(operation.laneId) ?? "none",
    kind,
    operationId: id,
  };
}

function fileRow(path, sha) {
  const filePath = readString(path);
  const commitSha = readString(sha);
  if (!filePath || !commitSha) return null;
  return {
    title: filePath,
    sha: commitSha,
    path: filePath,
  };
}

function laneRow(lane) {
  const id = readString(lane?.id);
  if (!id) return null;
  return {
    title: readString(lane.name) ?? id,
    id,
    name: readString(lane.name) ?? id,
  };
}

function githubCommitUrl(remoteUrl, commitSha) {
  const url = readString(remoteUrl);
  const sha = readString(commitSha);
  if (!url || !sha) return null;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+)$/
    .exec(url.trim().replace(/\.git$/, ""));
  return match ? `https://github.com/${match[1]}/${match[2]}/commit/${sha}` : null;
}

function defaultBranchNameForCommit(commit) {
  const shortSha = readString(commit?.shortSha) ?? readString(commit?.sha)?.slice(0, 7) ?? "commit";
  const subjectSlug = (readString(commit?.subject) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/[-/]+$/g, "");
  return `history/${shortSha}${subjectSlug ? `-${subjectSlug}` : ""}`;
}

function validateBranchName(name) {
  const text = readString(name);
  if (!text) return "Name a branch.";
  if (text.startsWith("-")) return "A branch name cannot start with a dash.";
  if (/\s/.test(text)) return "A branch name cannot contain spaces.";
  if (/[~^:?*[\\]/.test(text)) return "That branch name has a character git refuses.";
  if (text.includes("..")) return "A branch name cannot contain '..'.";
  if (text.includes("@{")) return "A branch name cannot contain '@{'.";
  if (text.startsWith("/") || text.endsWith("/")) return "A branch name cannot start or end with '/'.";
  if (text.endsWith(".") || text.endsWith(".lock")) return "A branch name cannot end with '.' or '.lock'.";
  if (text.includes("//")) return "A branch name cannot contain '//'.";
  return null;
}

module.exports = {
  COLLECTION_COMMITS,
  COLLECTION_FILES,
  COLLECTION_LANES,
  COLLECTION_OPERATIONS,
  COMMIT_ROW_ACTIONS,
  DEEPLINK_ACTIVITY,
  DEEPLINK_COMMIT,
  DEEPLINK_COMMITS,
  DEEPLINK_EVENT,
  FILE_ROW_ACTIONS,
  OPERATION_ROW_ACTIONS,
  PANEL_ACTIVITY,
  PANEL_COMMIT,
  PANEL_COMMITS,
  PANEL_EVENT,
  STATE_LANE,
  STATE_STATUS,
  commitRow,
  commitRowKey,
  defaultBranchNameForCommit,
  fileRow,
  fileRowKey,
  formatTime,
  githubCommitUrl,
  laneRow,
  operationRow,
  operationRowKey,
  readString,
  statusLabel,
  statusTone,
  validateBranchName,
};
