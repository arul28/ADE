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
//
// ## Which half answers an id in `ACTIONS`
//
// `index.js` merges its own handlers in AFTER `panelActions.js`'s, so an id
// both halves define reaches the DATA half. Rather than keep a list of those
// ids here — which drifted, naming verbs no panel dispatches and one that had
// been renamed — the split is enforced where it is real: `panelActions.js`
// simply does not define them, and its own test asserts that.
//
// The one thing a schema author has to know is the payload. `openIssue` and
// `openInLinear` are the data half's and both resolve from a STORED issue row,
// so a button passes `{issueId}` and never a `url`. A link that is not an
// issue names `openExternal` instead.

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
 * The workspace's issue labels.
 *
 * No panel binds it either. It exists so the Automations trigger tile's LABEL
 * filter can be a picker over this workspace's own labels rather than a text
 * box a reader has to spell a label into — the same reason `projects` and
 * `people` exist for the two filters above.
 */
const COLLECTION_LABELS = "labels";

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
 * The cost is one duplicate row per issue. At the vocabulary's 1000-row ceiling
 * that is 2000 bound rows plus the canonical copy, and a dressed row measures a
 * few hundred bytes — bound rows live in `plugin_collections` and never touch
 * `maxSchemaBytes`.
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
 * The `sockets[]` id of the settings section this plugin mounts on ADE's own
 * Settings page.
 *
 * Named here because two things have to agree on it and neither can see the
 * other: `plugin.json` declares the socket, and `panelActions.openSettings`
 * answers `{openSettings: {socketId}}` with it so desktop and the web client
 * open the page that section landed on. A typo is a gear that opens nothing,
 * so the manifest test asserts this string against the manifest.
 */
const SETTINGS_SECTION_SOCKET_ID = "connection";

/**
 * The Settings TAB the section asks for.
 *
 * `resolvePluginSettingsTab` accepts a tab id, and an unnamed section lands on
 * General — which is where a Linear connection is not. Asserted against the
 * manifest for the same reason as the id above.
 */
const SETTINGS_SECTION_TAB = "integrations";

/**
 * The launch form: the phone's `LinearLaunchScreen`, as a panel.
 *
 * Declared in `plugin.json`, built by `panels/launch.js`, and navigated to by
 * `panelActions.openLaunch`. `flows.openLaunch` remains the switch for a HOST
 * that cannot draw it — its absence means the two launch buttons do the work
 * directly with the plugin's defaults rather than sending the reader to a panel
 * id nothing can resolve.
 */
const PANEL_LAUNCH = "launch";

/* ── Panel state keys ───────────────────────────────────────────────────── */

/**
 * Seven of the vocabulary's eight per-panel state keys, spent on the issue list.
 *
 * `group` costs none — a folded section is client-local and never enters this
 * table — which is what leaves the whole filter budget for filters. Search
 * spends the eighth key (`chrome.search`), so a ninth axis would fail the panel.
 */
const STATE_PRESET = "state";
const STATE_PROJECT = "project";
const STATE_ASSIGNEE = "assignee";
const STATE_PRIORITY = "priority";
const STATE_SORT = "sort";
const STATE_TEAM = "team";
const STATE_UPDATED = "updated";
const STATE_VIEW = "view";
/** The nav-bar search field. Short on purpose: it is also a `$state` key. */
const STATE_SEARCH = "q";

/** The selection key every grouped list's ticks live under. */
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

/* ── State and priority, for BOTH halves ─────────────────────────────────── */

/**
 * Badge tone per state type.
 *
 * Here rather than in `panels/common.js` or `issueFormat.js` because it was in
 * BOTH, spelled twice with identical output — and a table duplicated between
 * the two halves of this plugin is a table that will eventually disagree, in a
 * way no test on either side can see.
 *
 * The vocabulary has five tones (`VocabTone`): `neutral`, `accent`,
 * `success`, `warning`, `destructive`. Anything else is coerced to the fallback, so a tone
 * invented here would not fail — it would silently render flat, which is the
 * worst of both outcomes. `started` is
 * the one a reader scans for, so it takes `accent`; `completed` is the only
 * settled-and-good state, so it takes `success`; `triage` is the only one that
 * wants attention, so it takes `warning`. `canceled` reads neutral rather than
 * loud on purpose — cancelled is closed, not a warning. Destructive is reserved
 * for Urgent priority, not for a workflow state.
 */
const STATE_TONES = Object.freeze({
  triage: "warning",
  backlog: "neutral",
  unstarted: "neutral",
  started: "accent",
  completed: "success",
  canceled: "neutral",
});

function stateTone(stateType) {
  return STATE_TONES[String(stateType ?? "").toLowerCase()] ?? "neutral";
}

/**
 * Linear's priority scale, as the built-in labels it (`linearPriorityLabel`).
 *
 * 0 is "none" and 1 is the URGENT end, not the low one — which is the one thing
 * about this scale that is easy to get backwards. Also here rather than twice.
 */
const PRIORITY_LABELS = Object.freeze(["No priority", "Urgent", "High", "Medium", "Low"]);

function priorityLabel(priority) {
  const index = Number(priority);
  return Number.isInteger(index) ? (PRIORITY_LABELS[index] ?? PRIORITY_LABELS[0]) : PRIORITY_LABELS[0];
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
  backToIssues: "backToIssues",
  openSettings: "openSettings",

  // The list's filters and search.
  applyFilters: "applyFilters",
  clearFilters: "clearFilters",
  searchIssues: "searchIssues",
  clearSearch: "clearSearch",

  // Launching work from an issue.
  openLaunch: "openLaunch",
  launchLaneAndAgent: "launchLaneAndAgent",
  launchLaneOnly: "launchLaneOnly",
  linkToLane: "linkToLane",
  submitLaunch: "submitLaunch",

  // Writing back to Linear.
  //
  // These three ids were briefly a collision: the automation STEPS behind
  // `set_issue_state`, `comment_on_issue` and `assign_issue` used to be handlers
  // of the same names in `index.js`, which merges after this half's table and so
  // won every dispatch — and they read `{issueId, stateId}` and `{issueId, body}`,
  // which is a shape a panel cannot produce. A `segmented` hands its handler the
  // panel's state map, where the new value sits under a key naming the issue, and
  // a comment needs a `{prompt}` round trip that a rule must never have.
  //
  // The data half resolved it by moving its step handlers behind `step*` names,
  // leaving the plain ids to the panel. The saved rule ids did not move, so no
  // stored automation was affected. The lesson is kept rather than the workaround:
  // a panel verb and a rule verb are different shapes even when they are the same
  // sentence, and {@link CORE_OWNED_ACTIONS} is where that boundary is written down.
  assignToMe: "assignToMe",
  setIssueState: "setIssueState",
  setIssuePriority: "setIssuePriority",
  commentOnIssue: "commentOnIssue",
  loadComments: "loadComments",
  openInLinear: "openInLinear",
  openExternal: "openExternal",

  // The connection.
  connectOAuth: "connectOAuth",
  connectApiKey: "connectApiKey",
  disconnect: "disconnect",
  applySettings: "applySettings",
  createAutolink: "createAutolink",
  copyWebhookUrl: "copyWebhookUrl",
  registerWebhook: "registerWebhook",
  unregisterWebhook: "unregisterWebhook",
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

/* ── Prompt ids ─────────────────────────────────────────────────────────── */

/**
 * A `{prompt}` echoes its id back on the re-invocation, so one handler can ask
 * two questions and tell the answers apart without keeping state between the
 * two calls it is made in.
 */
const PROMPT_SEARCH = "search";
const PROMPT_COMMENT = "comment";
const PROMPT_LANE = "lane";

module.exports = {
  ACTIONS,
  COLLECTION_COMMENTS,
  COLLECTION_ISSUES,
  COLLECTION_LABELS,
  COLLECTION_PEOPLE,
  COLLECTION_PROJECTS,
  COLLECTION_STATES,
  COLLECTION_TEAMS,
  COLLECTION_VIEWER,
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
  SETTINGS_SECTION_SOCKET_ID,
  SETTINGS_SECTION_TAB,
  PRIORITY_LABELS,
  PROMPT_COMMENT,
  PROMPT_LANE,
  PROMPT_SEARCH,
  STATE_ASSIGNEE,
  STATE_BATCH,
  STATE_PRESET,
  STATE_PRIORITY,
  STATE_PROJECT,
  STATE_SEARCH,
  STATE_SORT,
  STATE_TEAM,
  STATE_TONES,
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
  priorityLabel,
  rankSegment,
  stateTone,
  statesKeyPrefix,
};
