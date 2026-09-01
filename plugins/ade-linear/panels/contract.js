// The one seam between the panel builders and the rest of the plugin.
//
// Every collection name, key shape, row field and action id a panel schema
// names lives here. The builders import from here and nowhere else, so when the
// data half of the plugin changes a name, exactly one file changes and no
// schema goes on naming a collection nobody writes.
//
// The collection names below are the ones `plugin.json` declares. That is not a
// style rule: `pluginSdkServer.ts:801` REFUSES a write to an undeclared
// collection, so a name invented here would be a panel bound to rows the plugin
// is not allowed to store — an empty list with no error anywhere.
//
// Two rules the shapes below follow, both from `shared/plugins/vocabulary.ts`:
//
// 1. **Rows arrive in render shape.** A `list` binding reads `{title, subtitle,
//    …}` and the renderer reshapes nothing, so the plugin materializes the row
//    it wants drawn on its own machine. The filter fields ride on the same row
//    because a client-side `where` compares top-level fields of it.
// 2. **A bound row's key is its identity.** A tick in a `selectable` list
//    carries the row's `key`, so every row declares the bare issue id rather
//    than letting the collection key (which encodes sort order) become the
//    thing a batch handler has to parse.

"use strict";

/* ── Collections ────────────────────────────────────────────────────────── */

/**
 * The five collections `plugin.json` declares that a panel reads.
 *
 * `deliveries` is declared too and is deliberately absent: it is the webhook
 * drain's own log and no panel binds it.
 */
const COLLECTION_ISSUES = "issues";
const COLLECTION_COMMENTS = "comments";
const COLLECTION_TEAMS = "teams";
const COLLECTION_STATES = "states";
const COLLECTION_VIEWER = "viewer";

/**
 * Two collections the panels bind ONLY when the model says they exist.
 *
 * The project and assignee filters want `optionsFrom`, which reads a
 * collection: a real workspace has thirty projects and eighty people, and
 * `maxStateOptions` is 8, so literal options cannot express either. Whether
 * those rows exist is the data half's decision — the builders draw the bound
 * control when `model.filters.hasProjects` / `hasPeople` says so and draw
 * nothing when it does not, which is why naming them here costs nothing if the
 * manifest never declares them.
 */
const COLLECTION_PROJECTS = "projects";
const COLLECTION_PEOPLE = "people";

/**
 * One issue is written under two key spaces.
 *
 * `collections.list` orders by key and nothing else, so the order a list draws
 * in IS the order its keys sort in. The grouped view wants issues ordered
 * within their state; the flat view wants them in the reader's chosen sort.
 * Those are different orders over the same rows, and a second key space is the
 * only way to have both — the alternative is re-sorting on the client, which
 * rule 3 forbids and which no client could do anyway.
 *
 * The cost is one duplicate row per issue. At the vocabulary's 250-row ceiling
 * that is 500 rows, and a dressed row measures a few hundred bytes — bound rows
 * live in `plugin_collections` and never touch `maxSchemaBytes`.
 */
const ISSUE_KEY_FLAT = "flat:";
const ISSUE_KEY_GROUP = "group:";

/** Six digits, because a workspace can hand back more issues than five would order. */
function rankSegment(rank) {
  const value = Number.isFinite(rank) && rank > 0 ? Math.trunc(rank) : 0;
  return String(Math.min(value, 999_999)).padStart(6, "0");
}

/** `flat:000012:<issueId>` — the reader's chosen sort, across every state. */
function flatIssueKey(rank, issueId) {
  return `${ISSUE_KEY_FLAT}${rankSegment(rank)}:${issueId}`;
}

/** `group:<stateId>:000003:<issueId>` — one contiguous run per state group. */
function groupIssueKey(stateId, rank, issueId) {
  return `${ISSUE_KEY_GROUP}${stateId}:${rankSegment(rank)}:${issueId}`;
}

/** The prefix one state group's `list` binds. Must match {@link groupIssueKey}. */
function groupKeyPrefix(stateId) {
  return `${ISSUE_KEY_GROUP}${stateId}:`;
}

/** The prefix the flat, selectable list binds. */
function flatKeyPrefix() {
  return ISSUE_KEY_FLAT;
}

/**
 * One issue's comments. The key sorts oldest first, so the list reads as a
 * thread rather than as a bag — see {@link commentKey}.
 */
function commentKeyPrefix(issueId) {
  return `comment:${issueId}:`;
}

/**
 * `comment:<issueId>:000004:<commentId>` — a thread in the order it was written.
 *
 * The rank segment is what makes it a thread. A raw comment id sorts
 * lexicographically, which is a random order for a UUID and reverse-chronological
 * for some id schemes, and neither is the order somebody wrote the words in.
 */
function commentKey(issueId, rank, commentId) {
  return `${commentKeyPrefix(issueId)}${rankSegment(rank)}:${commentId}`;
}

/** Workflow states are read per team, so one control offers one team's states. */
function statesKeyPrefix(teamKey) {
  return `team:${teamKey}:`;
}

/** The two `viewer` rows: the connection as it stands, and the stored filters. */
const VIEWER_KEY_CONNECTION = "connection:current";
const VIEWER_KEY_FILTERS = "prefs:filters";

/* ── Row fields a client-side `where` compares ──────────────────────────── */

/**
 * The four filter axes that cost no round trip.
 *
 * Each is a top-level field of the issue row, compared against the live value
 * of a `segmented` control. The plugin writes them once when it materializes
 * the row; changing a control re-runs a string compare and nothing else.
 *
 * `stateType` and `stateId` are on the row too, but no `where` reads them: the
 * state preset changes which GROUPS exist, and a predicate can hide rows but
 * cannot remove a section. That filter is a round trip on purpose — see
 * `issues.js`.
 */
const FIELD_PROJECT = "projectId";
const FIELD_ASSIGNEE = "assigneeId";
const FIELD_PRIORITY = "priority";
const FIELD_UPDATED = "updatedAt";

/* ── Panel ids ──────────────────────────────────────────────────────────── */

const PANEL_MAIN = "main";
const PANEL_ISSUES = "issues";
const PANEL_ISSUE = "issue";
const PANEL_SETTINGS = "settings";

/**
 * The launch panel is NOT declared in `plugin.json` today.
 *
 * `launch.js` builds it and `panels.js` exports it, because the phone's
 * `LinearLaunchScreen` — the model picker, the permission mode, the kickoff
 * prompt — is five parity rows (M22–M26) and the builder for it is written. It
 * is inert until the manifest declares a `launch` panel; `panelActions.js`
 * therefore never navigates to it unless the host offers `flows.openLaunch`.
 */
const PANEL_LAUNCH = "launch";

/* ── Panel state keys ───────────────────────────────────────────────────── */

/**
 * Seven of the vocabulary's eight per-panel state keys, spent on the issue list.
 *
 * `group` costs none — a folded section is client-local and never enters this
 * table — which is what leaves the whole filter budget for filters. The eighth
 * key is deliberately unspent, so one more axis costs no redesign.
 */
const STATE_PRESET = "state";
const STATE_PROJECT = "project";
const STATE_ASSIGNEE = "assignee";
const STATE_PRIORITY = "priority";
const STATE_SORT = "sort";
const STATE_TEAM = "team";
const STATE_UPDATED = "updated";
const STATE_VIEW = "view";

/** The selection key the flat list's ticks live under. */
const STATE_BATCH = "batch";

/**
 * The detail panel's inline controls are keyed PER ISSUE.
 *
 * Panel state survives a re-publish of the same controls, and the detail panel
 * is one panel that draws every issue — so a shared key would carry the state
 * the reader picked on ADE-122 onto ADE-140 the moment they navigated. A key
 * naming the issue changes the panel's state signature, which is exactly the
 * "the controls themselves changed" case the lifecycle resets on.
 */
function issueStateKey(identifier) {
  return `issueState:${identifier}`;
}

function issuePriorityKey(identifier) {
  return `issuePriority:${identifier}`;
}

/* ── Action ids ─────────────────────────────────────────────────────────── */

/**
 * Every action a panel of this plugin can dispatch.
 *
 * A binding's `allowActions` is an allowlist over these, so a stored row can
 * only ever press a verb the panel itself declared. Naming them once here is
 * what keeps the allowlist and the handler table from disagreeing.
 *
 * The three refresh ids belong to the data half — a panel's `refreshAction` in
 * `plugin.json` names them and `panelActions.js` never defines them. They are
 * listed because a schema still has to spell them on a Retry button.
 */
const ACTIONS = {
  // Owned by index.js, named by a schema.
  refreshIssues: "refreshIssues",
  refreshIssue: "refreshIssue",
  refreshConnection: "refreshConnection",

  // Navigation.
  openIssue: "openIssue",
  openSubIssue: "openSubIssue",
  backToIssues: "backToIssues",
  openSettings: "openSettings",

  // The list's filters and search.
  applyFilters: "applyFilters",
  clearFilters: "clearFilters",
  searchIssues: "searchIssues",
  clearSearch: "clearSearch",

  // Launching work from an issue.
  launchLaneAndAgent: "launchLaneAndAgent",
  launchLaneOnly: "launchLaneOnly",
  linkToLane: "linkToLane",
  submitLaunch: "submitLaunch",

  // Writing back to Linear.
  assignToMe: "assignToMe",
  setIssueState: "setIssueState",
  setIssuePriority: "setIssuePriority",
  commentOnIssue: "commentOnIssue",
  loadComments: "loadComments",
  openInLinear: "openInLinear",

  // The connection.
  connectOAuth: "connectOAuth",
  connectApiKey: "connectApiKey",
  adoptHandoff: "adoptHandoff",
  disconnect: "disconnect",
  applySettings: "applySettings",
  createAutolink: "createAutolink",
  copyWebhookUrl: "copyWebhookUrl",
};

/**
 * The ids a bound issue row may name, on any of its three action slots.
 *
 * Deliberately short. A row that could press `disconnect` because a collection
 * said so is the failure `allowActions` exists to prevent, and the list is the
 * audit — 16 is the ceiling and this is well under it.
 */
const ISSUE_ROW_ACTIONS = [
  ACTIONS.openIssue,
  ACTIONS.launchLaneAndAgent,
  ACTIONS.launchLaneOnly,
  ACTIONS.assignToMe,
  ACTIONS.linkToLane,
  ACTIONS.openInLinear,
];

/**
 * The ids a bound COMMENT row may name.
 *
 * One verb, and it is not a write: a comment row offers the way to the thread
 * in Linear and nothing else, because every write this panel can do to a
 * comment is a write it cannot show the result of.
 */
const COMMENT_ROW_ACTIONS = [ACTIONS.openInLinear];

/* ── Prompt ids ─────────────────────────────────────────────────────────── */

/**
 * A `{prompt}` echoes its id back on the re-invocation, so one handler can ask
 * two questions and tell the answers apart without keeping state between the
 * two calls it is made in.
 */
const PROMPT_SEARCH = "search";
const PROMPT_COMMENT = "comment";
const PROMPT_API_KEY = "apikey";

module.exports = {
  ACTIONS,
  COLLECTION_COMMENTS,
  COLLECTION_ISSUES,
  COLLECTION_PEOPLE,
  COLLECTION_PROJECTS,
  COLLECTION_STATES,
  COLLECTION_TEAMS,
  COLLECTION_VIEWER,
  COMMENT_ROW_ACTIONS,
  FIELD_ASSIGNEE,
  FIELD_PRIORITY,
  FIELD_PROJECT,
  FIELD_UPDATED,
  ISSUE_ROW_ACTIONS,
  PANEL_ISSUE,
  PANEL_ISSUES,
  PANEL_LAUNCH,
  PANEL_MAIN,
  PANEL_SETTINGS,
  PROMPT_API_KEY,
  PROMPT_COMMENT,
  PROMPT_SEARCH,
  STATE_ASSIGNEE,
  STATE_BATCH,
  STATE_PRESET,
  STATE_PRIORITY,
  STATE_PROJECT,
  STATE_SORT,
  STATE_TEAM,
  STATE_UPDATED,
  STATE_VIEW,
  VIEWER_KEY_CONNECTION,
  VIEWER_KEY_FILTERS,
  commentKey,
  commentKeyPrefix,
  flatIssueKey,
  flatKeyPrefix,
  groupIssueKey,
  groupKeyPrefix,
  issuePriorityKey,
  issueStateKey,
  rankSegment,
  statesKeyPrefix,
};
