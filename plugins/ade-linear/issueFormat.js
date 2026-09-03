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

// The tone table and the priority scale live in `panels/contract.js`, imported
// rather than restated. Both were spelled twice — once here for the data half
// and once in `panels/common.js` for the panel half — with identical output and
// two different sets of words explaining the same choices. Two copies of one
// table is a table that eventually disagrees, in a way neither half's tests
// can see.
const { priorityLabel, stateTone } = require("./panels/contract");

/**
 * Group order for the issue list.
 *
 * Byte-for-byte the built-in's `STATE_GROUP_ORDER`
 * (`app/LinearIssueBrowser.tsx:77`), not alphabetical and not Linear's board
 * order: work in flight sits at the top of the list, because that is the
 * section a reader opens the tab to look at. Todo follows it, then the two
 * queues nobody is working yet, then the two closed states.
 *
 * The built-in names a seventh type, `duplicate`, in last place. It is absent
 * here on purpose — `UNKNOWN_STATE_RANK` already sorts it last, which is the
 * same slot, so naming it would buy a row in this table and nothing else.
 *
 * The rank rides on every row so a client sorts by one integer instead of
 * carrying this table itself.
 */
const STATE_RANKS = {
  started: 0,
  unstarted: 1,
  backlog: 2,
  triage: 3,
  completed: 4,
  canceled: 5,
};
/** Anything Linear adds after this build. Sorted last rather than dropped. */
const UNKNOWN_STATE_RANK = 6;

function stateRank(stateType) {
  const rank = STATE_RANKS[stateType];
  return typeof rank === "number" ? rank : UNKNOWN_STATE_RANK;
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

  // The issues standing in this one's way.
  //
  // A Linear relation of type `blocks` reads "`issue` blocks `relatedIssue`",
  // so the ones where THIS issue is blocked are its INVERSE relations, and
  // `issue` on each of those is the blocker. A blocker still open is one whose
  // state is neither `completed` nor `canceled` — the same two terminal types
  // every other reading of "done" in this plugin uses.
  const blockers = (Array.isArray(node?.inverseRelations?.nodes) ? node.inverseRelations.nodes : [])
    .filter((relation) => text(relation?.type) === "blocks" && text(relation?.issue?.id))
    .map((relation) => ({
      id: text(relation.issue.id) ?? "",
      identifier: text(relation.issue?.identifier),
      stateType: text(relation.issue?.state?.type),
    }));

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
    // Linear's own slug, not one derived from the name. Null when the workspace
    // schema answered no `slugId`, which the page reads as "derive it".
    projectSlug: text(node?.project?.slugId),
    assigneeId: text(node?.assignee?.id),
    assigneeName: personName(node?.assignee),
    creatorName: personName(node?.creator),
    labels,
    labelNames: labels.map((label) => label.name).filter(Boolean).join(", "),
    dueDate: text(node?.dueDate),
    estimate: typeof node?.estimate === "number" ? node.estimate : null,
    archivedAt: text(node?.archivedAt),
    startedAt: text(node?.startedAt),
    completedAt: text(node?.completedAt),
    canceledAt: text(node?.canceledAt),
    // A cycle that Linear left unnamed is still a cycle the reader knows by
    // its number, and "Cycle 14" is the words their Linear shows them.
    cycleId: text(node?.cycle?.id),
    cycleName: text(node?.cycle?.name)
      ?? (Number.isInteger(node?.cycle?.number) ? `Cycle ${node.cycle.number}` : null),
    createdAt: text(node?.createdAt),
    updatedAt: text(node?.updatedAt),
    branchName: issueBranchName({ identifier, title }),
    subIssues,
    blockers,
    blockerIssueIds: blockers.map((blocker) => blocker.id).filter(Boolean),
    hasOpenBlockers: blockers.some(
      (blocker) => blocker.stateType !== "completed" && blocker.stateType !== "canceled",
    ),
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
  return {
    id: text(node?.id) ?? "",
    key,
    name,
    title: name,
    subtitle: key,
    // Four cosmetic fields the page's team card draws and no panel has room
    // for. Null rather than a default when the wide selection was refused:
    // "this workspace did not answer" and "this team has no colour" are
    // different facts, and a card that invented one would be lying quietly.
    color: text(node?.color),
    issueCount: Number.isInteger(node?.issueCount) ? node.issueCount : null,
    cyclesEnabled: typeof node?.cyclesEnabled === "boolean" ? node.cyclesEnabled : null,
    private: typeof node?.private === "boolean" ? node.private : null,
  };
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
