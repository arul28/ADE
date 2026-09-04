// Display helpers, computed on this machine so every client only draws.
//
// Mosaic's law: a phone, a browser and the TUI render the row the plugin
// already shaped. Ported from the renderer's own helpers so the wording does
// not drift from what ADE showed before the extraction:
//   apps/desktop/src/renderer/lib/cursorCloudUtils.ts
//   apps/desktop/src/shared/cursorCloudFleetStatus.ts

"use strict";

/** Every status a fleet row can wear, after the latest run refines the agent. */
const RUN_STATUSES = ["creating", "running", "finished", "error", "cancelled", "expired"];

/**
 * The vocabulary's four tones. There is no red: a failure is `warning`, which
 * is the house rule stated at the top of `shared/adeCard.ts`.
 */
function statusTone(status) {
  switch (status) {
    case "running":
    case "creating":
      return "accent";
    case "finished":
      return "success";
    case "error":
    case "expired":
      return "warning";
    default:
      return "neutral";
  }
}

/** Normalize whatever Cursor said a run is doing. Unknown reads as absent. */
function normalizeRunStatus(value) {
  const lower = typeof value === "string" ? value.trim().toLowerCase() : "";
  return RUN_STATUSES.includes(lower) ? lower : undefined;
}

/**
 * The latest run refines the coarse agent-list status; an unknown run status on
 * a live agent reads as `creating` — the agent exists and has finished nothing.
 */
function fleetRunStatus(entry) {
  if (entry.runStatus) return entry.runStatus;
  const lower = typeof entry.agent.status === "string" ? entry.agent.status.toLowerCase() : "";
  if (lower === "running" || lower === "active") return "running";
  if (lower === "finished") return "finished";
  if (lower === "error") return "error";
  if (lower === "creating") return "creating";
  return "creating";
}

/** Archived wins over run state, because that is what the reader is asking. */
function fleetDisplayStatus(entry) {
  return entry.agent.archived ? "archived" : fleetRunStatus(entry);
}

function isFleetEntryActive(entry) {
  if (entry.agent.archived) return false;
  const status = fleetRunStatus(entry);
  return status === "creating" || status === "running";
}

/**
 * How long ago, in the shape the fleet has always used. `null` for a timestamp
 * that is missing, unparseable or in the future — a row then shows no age chip
 * rather than a wrong one.
 */
function formatAge(value, now = Date.now()) {
  const ts = typeof value === "number"
    ? value
    : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const delta = now - ts;
  if (delta < 0) return null;
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Cents to a dollar chip. `null` when nothing was billed or nothing is known. */
function formatCost(cents) {
  if (cents == null || !Number.isFinite(cents)) return null;
  if (cents <= 0) return "$0";
  return `$${(cents / 100).toFixed(2)}`;
}

/** The agent's page on cursor.com. `null` for an id that is not one. */
function agentWebUrl(agentId) {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id) return null;
  return `https://cursor.com/agents?id=${encodeURIComponent(id)}`;
}

/** Every agent, for the footer link. */
const ALL_AGENTS_URL = "https://cursor.com/agents";

/** Shorten an opaque id for a mono line the reader compares, never copies. */
function shortId(value, length = 14) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return "";
  return id.length > length ? `${id.slice(0, length)}…` : id;
}

module.exports = {
  ALL_AGENTS_URL,
  RUN_STATUSES,
  agentWebUrl,
  fleetDisplayStatus,
  fleetRunStatus,
  formatAge,
  formatCost,
  isFleetEntryActive,
  normalizeRunStatus,
  shortId,
  statusTone,
};
