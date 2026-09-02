// Labels, tones, and collection keys for ade-review.
//
// Rows arrive in render shape. A client compares top-level string fields for
// `where`; it never formats a date or a severity. Everything a reader sees is
// spelled here so four clients draw the same words.

"use strict";

const COLLECTION_RUNS = "runs";
const COLLECTION_FINDINGS = "findings";
const COLLECTION_SUPPRESSIONS = "suppressions";

const PANEL_RUNS = "runs";
const PANEL_RUN = "run";
const PANEL_LAUNCH = "launch";
const PANEL_LEARNINGS = "learnings";

const DEEPLINK_RUNS = "ade://plugin/ade-review/runs";
const DEEPLINK_RUN = "ade://plugin/ade-review/run";
const DEEPLINK_LAUNCH = "ade://plugin/ade-review/launch";
const DEEPLINK_LEARNINGS = "ade://plugin/ade-review/learnings";

const STATE_STATUS = "status";
const STATE_LANE = "lane";

const RUN_ROW_ACTIONS = [
  "openRun",
  "rerun",
  "cancelRun",
  "openChat",
];

const FINDING_ROW_ACTIONS = [
  "acknowledgeFinding",
  "dismissFinding",
  "snoozeFinding",
  "suppressFinding",
  "copyFinding",
];

const SUPPRESSION_ROW_ACTIONS = ["deleteSuppression"];

const TARGET_MODE_LABELS = {
  lane_diff: "Lane diff",
  commit_range: "Commit range",
  working_tree: "Uncommitted changes",
  pr: "Pull request",
};

const STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusTone(status) {
  switch (status) {
    case "completed":
      return "success";
    case "running":
    case "queued":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function severityTone(severity) {
  switch (severity) {
    case "critical":
    case "high":
      return "danger";
    case "medium":
      return "warning";
    default:
      return "neutral";
  }
}

function formatTime(value) {
  const text = readString(value);
  if (!text) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return text;
  return new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function severityCounts(summary) {
  if (!summary || typeof summary !== "object") return null;
  const parts = [];
  for (const key of ["critical", "high", "medium", "low", "info"]) {
    const count = Number(summary[key]) || 0;
    if (count > 0) parts.push(`${count} ${key}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

function targetModeLabel(mode) {
  return TARGET_MODE_LABELS[mode] ?? "Review";
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? (readString(status) ?? "Unknown");
}

function runRowKey(index, runId) {
  return `run:${String(index).padStart(4, "0")}:${runId}`;
}

function findingRowKey(runId, findingId) {
  return `finding:${runId}:${findingId}`;
}

function suppressionRowKey(id) {
  return `suppression:${id}`;
}

function runRow(run, index) {
  const runId = readString(run?.id);
  if (!runId) return null;
  const status = readString(run.status) ?? "queued";
  const live = status === "queued" || status === "running";
  const findings = Number(run.findingCount) || 0;
  const counts = severityCounts(run.severitySummary);
  const when = formatTime(run.updatedAt) ?? formatTime(run.createdAt);
  const subtitleParts = [
    readString(run.targetLabel),
    findings ? `${findings} finding${findings === 1 ? "" : "s"}` : "No findings yet",
    counts,
    when,
  ].filter(Boolean);

  const actions = [];
  if (live) {
    actions.push({
      action: "cancelRun",
      label: "Cancel",
      args: { runId },
      confirm: "Cancel this review run?",
    });
  } else {
    actions.push({ action: "rerun", label: "Rerun", args: { runId } });
  }
  if (readString(run.chatSessionId)) {
    actions.push({ action: "openChat", label: "Open transcript", args: { runId } });
  }

  return {
    title: readString(run.summary) || targetModeLabel(run.target?.mode),
    subtitle: subtitleParts.join(" · "),
    badge: { text: statusLabel(status).toUpperCase(), tone: statusTone(status) },
    tone: statusTone(status),
    onPress: { action: "openRun", args: { runId } },
    actions: actions.slice(0, 3),
    status: live ? "active" : status === "completed" ? "completed" : status === "failed" ? "failed" : "other",
    laneId: readString(run.laneId) ?? "none",
    runId,
  };
}

function findingRow(finding) {
  const findingId = readString(finding?.id);
  if (!findingId) return null;
  const severity = readString(finding.severity) ?? "info";
  const file = readString(finding.filePath);
  const line = Number.isFinite(finding.line) ? `:${finding.line}` : "";
  const subtitleParts = [
    file ? `${file}${line}` : null,
    readString(finding.body),
  ].filter(Boolean);
  const overflow = [
    { action: "acknowledgeFinding", label: "Acknowledge", args: { findingId } },
    {
      action: "dismissFinding",
      label: "Dismiss as not a bug",
      args: { findingId, reason: "not_a_bug" },
      confirm: "Dismiss this finding as not a bug?",
    },
    {
      action: "dismissFinding",
      label: "Dismiss as noise",
      args: { findingId, reason: "low_value_noise" },
      confirm: "Dismiss this finding as noise?",
    },
    { action: "snoozeFinding", label: "Snooze 7 days", args: { findingId } },
    {
      action: "suppressFinding",
      label: "Suppress similar in this repo",
      args: { findingId, scope: "repo" },
      confirm: "Skip similar findings in this repository on future runs?",
    },
    { action: "copyFinding", label: "Copy", args: { findingId } },
  ];
  return {
    title: readString(finding.title) ?? "Finding",
    subtitle: subtitleParts.join(" · ").slice(0, 240),
    badge: { text: severity.toUpperCase(), tone: severityTone(severity) },
    tone: severityTone(severity),
    key: findingId,
    findingId,
    runId: readString(finding.runId),
    overflow: overflow.slice(0, 6),
  };
}

function suppressionRow(item) {
  const id = readString(item?.id);
  if (!id) return null;
  const scope = readString(item.scope) ?? "repo";
  const hits = Number(item.hitCount) || 0;
  return {
    title: readString(item.title) ?? "Suppression",
    subtitle: [scope, readString(item.pathPattern), hits ? `${hits} hits` : null].filter(Boolean).join(" · "),
    key: id,
    suppressionId: id,
    actions: [{
      action: "deleteSuppression",
      label: "Remove",
      args: { suppressionId: id },
      confirm: "Remove this suppression?",
    }],
  };
}

module.exports = {
  COLLECTION_FINDINGS,
  COLLECTION_RUNS,
  COLLECTION_SUPPRESSIONS,
  DEEPLINK_LAUNCH,
  DEEPLINK_LEARNINGS,
  DEEPLINK_RUN,
  DEEPLINK_RUNS,
  FINDING_ROW_ACTIONS,
  PANEL_LAUNCH,
  PANEL_LEARNINGS,
  PANEL_RUN,
  PANEL_RUNS,
  RUN_ROW_ACTIONS,
  STATE_LANE,
  STATE_STATUS,
  SUPPRESSION_ROW_ACTIONS,
  TARGET_MODE_LABELS,
  findingRow,
  findingRowKey,
  formatTime,
  readString,
  runRow,
  runRowKey,
  severityTone,
  statusLabel,
  statusTone,
  suppressionRow,
  suppressionRowKey,
  targetModeLabel,
};
