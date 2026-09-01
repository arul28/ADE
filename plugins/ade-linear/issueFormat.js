// Shaping a Linear issue into the row every client draws, and into the branch
// name git gets.
//
// Two rules govern this file.
//
// 1. **The plugin shapes rows; no client reshapes them.** A vocabulary `list`
//    binding reads `{title, subtitle, ...}` straight off a collection row, so
//    everything a panel shows — the state badge's tone, the priority's word,
//    the joined label names — is computed here, once, on the machine that holds
//    the credential. The phone, the web client and the TUI then draw the same
//    row without knowing what Linear is.
// 2. **The branch name is byte-identical to the built-in's.** Linear matches a
//    branch to an issue by name. A plugin that derived `ade-14-fix` where core
//    derived `ade-14-fix-oauth` would silently break "Open in coding tool" and
//    Linear's own branch linking, and nothing would report it. So
//    `issueBranchName` is a direct port of `shared/linearIssueBranch.ts`,
//    proven byte-for-byte by `test/issueFormat.test.js` rather than by reading.

"use strict";

/**
 * Group order for the issue list.
 *
 * Linear's own board order, not alphabetical. The rank rides on every row so a
 * client sorts by one integer instead of carrying this table itself.
 */
const STATE_RANKS = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
};
/** Anything Linear adds after this build. Sorted last rather than dropped. */
const UNKNOWN_STATE_RANK = 6;

/** Linear's priority scale. 0 is "none", and 1 is the URGENT end, not the low one. */
const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"];

/**
 * Badge tone per state type.
 *
 * The vocabulary has exactly four (`VocabTone` in `vocabularyNodes.ts:191`):
 * `neutral`, `accent`, `success`, `warning`. Anything else is coerced to the
 * fallback, so a tone this table invented would not fail — it would silently
 * render flat, which is the worst of both outcomes. `started` is `accent`
 * rather than the `info` this table used to name, because `info` is not one of
 * the four and every in-progress issue was drawing without its emphasis.
 *
 * `canceled` reads neutral rather than loud on purpose: there is no red, so the
 * only louder tone is `warning`, and a cancelled issue is not a warning — it is
 * a closed one.
 */
const STATE_TONES = {
  triage: "warning",
  backlog: "neutral",
  unstarted: "neutral",
  started: "accent",
  completed: "success",
  canceled: "neutral",
};

function stateRank(stateType) {
  const rank = STATE_RANKS[stateType];
  return typeof rank === "number" ? rank : UNKNOWN_STATE_RANK;
}

function priorityLabel(priority) {
  return PRIORITY_LABELS[priority] ?? PRIORITY_LABELS[0];
}

function stateTone(stateType) {
  return STATE_TONES[stateType] ?? "neutral";
}

/**
 * Make a branch name git will accept.
 *
 * A direct port of `sanitizeLinearIssueBranchName`. The step order matters and
 * is not obvious: collapsing `//` before stripping `/.` would leave a `/.`
 * that the earlier rule was meant to catch, so the sequence is preserved
 * exactly rather than tidied into something that reads better.
 */
function sanitizeBranchName(value) {
  let text = String(value ?? "").trim();
  text = text.replace(/^refs\/heads\//, "");
  text = text.replace(/^origin\//, "");
  text = text.replace(/@\{/g, "-");
  text = text.replace(/[\\~^:?*[\]\s]+/g, "-");
  text = text.replace(/\/+/g, "/");
  text = text.replace(/\/\.+/g, "/");
  text = text.replace(/\.+\//g, "/");
  text = text.replace(/\.\.+/g, "-");
  text = text.replace(/\.+$/g, "");
  text = text.replace(/\.lock$/i, "");
  text = text.replace(/^-+|-+$/g, "");
  text = text.replace(/\/$/, "");
  text = text.replace(/^\//, "");
  text = text.replace(/-{2,}/g, "-");
  return text || "linear-issue";
}

/** `ENG-431` + `Fix OAuth refresh!` becomes `eng-431-fix-oauth-refresh`. */
function issueBranchName(issue) {
  const identifier = String(issue?.identifier ?? "").trim().toLowerCase();
  const titleSlug = String(issue?.title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const branch = [identifier, titleSlug].filter(Boolean).join("-");
  return sanitizeBranchName(branch || identifier || "linear-issue");
}

/** The lane's display name: `ENG-431 Fix OAuth refresh`. */
function issueLaneName(issue) {
  return `${String(issue?.identifier ?? "").trim()} ${String(issue?.title ?? "").trim()}`.trim();
}

function text(value) {
  return typeof value === "string" ? value : null;
}

function personName(person) {
  if (!person) return null;
  return text(person.displayName) ?? text(person.name) ?? null;
}

/**
 * Turn one Linear GraphQL issue node into the row this plugin stores.
 *
 * Every field is present on every row, `null` where Linear had nothing. A row
 * with holes in it would make a binding's `where` clause behave differently for
 * two issues that differ only in whether someone filled in a due date.
 */
function normalizeIssue(node) {
  const state = node?.state ?? null;
  const stateType = text(state?.type) ?? "backlog";
  const stateName = text(state?.name) ?? "Unknown";
  const identifier = text(node?.identifier) ?? "";
  const title = text(node?.title) ?? "";
  const priority = Number.isInteger(node?.priority) ? node.priority : 0;
  const labels = Array.isArray(node?.labels?.nodes)
    ? node.labels.nodes.map((label) => ({
      id: text(label?.id) ?? "",
      name: text(label?.name) ?? "",
      color: text(label?.color) ?? null,
    }))
    : [];
  const subIssues = Array.isArray(node?.children?.nodes)
    ? node.children.nodes.map((child) => ({
      id: text(child?.id) ?? "",
      identifier: text(child?.identifier) ?? "",
      title: text(child?.title) ?? "",
      stateName: text(child?.state?.name) ?? null,
      stateType: text(child?.state?.type) ?? null,
    }))
    : [];

  return {
    id: text(node?.id) ?? "",
    identifier,
    description: text(node?.description),
    url: text(node?.url),
    priority,
    priorityLabel: priorityLabel(priority),
    stateId: text(state?.id),
    stateName,
    stateType,
    stateRank: stateRank(stateType),
    teamId: text(node?.team?.id),
    teamKey: text(node?.team?.key),
    teamName: text(node?.team?.name),
    projectId: text(node?.project?.id),
    projectName: text(node?.project?.name),
    assigneeId: text(node?.assignee?.id),
    assigneeName: personName(node?.assignee),
    creatorName: personName(node?.creator),
    labels,
    labelNames: labels.map((label) => label.name).filter(Boolean).join(", "),
    dueDate: text(node?.dueDate),
    estimate: typeof node?.estimate === "number" ? node.estimate : null,
    archivedAt: text(node?.archivedAt),
    completedAt: text(node?.completedAt),
    createdAt: text(node?.createdAt),
    updatedAt: text(node?.updatedAt),
    branchName: issueBranchName({ identifier, title }),
    subIssues,
    // Filled in by `data.js` from `ade.lanes.list()`; never from Linear.
    hasLane: false,
    laneId: null,
    laneName: null,
    // Display-ready fields, so a `list` binding needs no reshaping. `title` is
    // declared ONCE, here: an issue with no title falls back to its identifier
    // rather than drawing a blank row, and a second earlier `title` key would
    // make which of the two wins depend on the order of the literal.
    title: title || identifier,
    subtitle: `${identifier} · ${stateName}`,
    title2: `${identifier} · ${stateName}`,
    badgeText: stateName,
    badgeTone: stateTone(stateType),
  };
}

/** The comment row the detail panel's list binds to. */
function normalizeComment(issueId, node) {
  const userName = personName(node?.user) ?? "Someone";
  const body = text(node?.body) ?? "";
  return {
    id: text(node?.id) ?? "",
    issueId,
    body,
    createdAt: text(node?.createdAt),
    userName: text(node?.user?.name) ?? userName,
    userDisplayName: userName,
    title: userName,
    // The vocabulary has no markdown node, so a comment body is shown as the
    // plain text it already is. See the gap list: this is the one place the
    // built-in renders formatting the plugin cannot.
    subtitle: body.replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

/** A team row, for the team list and the state lookup. */
function normalizeTeam(node) {
  const key = text(node?.key) ?? "";
  const name = text(node?.name) ?? key;
  return { id: text(node?.id) ?? "", key, name, title: name, subtitle: key };
}

/** A workflow state row, carrying its team so a per-team lookup needs no join. */
function normalizeState(teamId, teamKey, node) {
  const name = text(node?.name) ?? "";
  const type = text(node?.type) ?? "backlog";
  return {
    id: text(node?.id) ?? "",
    name,
    type,
    rank: stateRank(type),
    teamId,
    teamKey,
    title: name,
    subtitle: teamKey ? `${teamKey} · ${type}` : type,
  };
}

/**
 * The `IssueRef` shape `ade.lanes.linkIssue` takes.
 *
 * `pluginId` is deliberately absent: the host stamps it from the child
 * connection that asked, and it is what `unlinkIssue` checks ownership against.
 * Sending one would be refused, and a ref that carried someone else's id would
 * be a link this plugin could never remove.
 */
function issueRefFromRow(row) {
  return {
    provider: "linear",
    issueId: row.id,
    key: row.identifier,
    title: row.title,
    url: row.url,
    state: { id: row.stateId, name: row.stateName, category: row.stateType },
    container: { id: row.teamId, key: row.teamKey, name: row.teamName },
    branchName: row.branchName,
    assignee: row.assigneeId ? { id: row.assigneeId, name: row.assigneeName } : null,
    priority: { rank: row.priority, label: row.priorityLabel },
    labels: row.labels.map((label) => label.name).filter(Boolean),
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    extra: { projectId: row.projectId, projectName: row.projectName },
  };
}

module.exports = {
  PRIORITY_LABELS,
  STATE_RANKS,
  UNKNOWN_STATE_RANK,
  issueBranchName,
  issueLaneName,
  issueRefFromRow,
  normalizeComment,
  normalizeIssue,
  normalizeState,
  normalizeTeam,
  priorityLabel,
  sanitizeBranchName,
  stateRank,
  stateTone,
};
