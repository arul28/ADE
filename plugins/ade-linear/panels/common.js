// Words, tokens and measurements every Linear panel shares.
//
// The copy is ported from the built-in panes — `LinearIssueBrowser.tsx` on the
// desktop, `LinearIssueListScreen.swift` / `LinearIssueDetailScreen.swift` /
// `LinearConnectionScreen.swift` on the phone — so replacing the compiled
// integration with this plugin does not quietly reword the product. Where the
// two built-ins disagree (the desktop's "Has lane" against the phone's
// "has lane") the desktop spelling wins, because it is the one a badge draws.
//
// Nothing here renders. It is strings, two lookup tables and the three
// measurements a builder needs to stay inside `VOCAB_LIMITS`.

"use strict";

// `stateTone` and `priorityLabel` are RE-EXPORTED below rather than defined
// here. Both existed twice — once in this file for the panel half and once in
// `issueFormat.js` for the data half — with identical output and two sets of
// words explaining why. One table, imported by both, is the only shape those
// two cannot drift apart in.
const {
  PANEL_ISSUE,
  PANEL_ISSUES,
  PANEL_LAUNCH,
  PANEL_SETTINGS,
  STATE_TONES,
  priorityLabel,
  stateTone,
} = require("./contract");

/* ── Deeplinks ──────────────────────────────────────────────────────────── */

const PLUGIN_ID = "ade-linear";

/** `ade://plugin/ade-linear/<panelId>` — the destination a fallback card offers. */
function deeplink(panelId) {
  return `ade://plugin/${PLUGIN_ID}/${panelId}`;
}

const DEEPLINK_ISSUES = deeplink(PANEL_ISSUES);
const DEEPLINK_ISSUE = deeplink(PANEL_ISSUE);
const DEEPLINK_LAUNCH = deeplink(PANEL_LAUNCH);
const DEEPLINK_SETTINGS = deeplink(PANEL_SETTINGS);

/**
 * Rule 2 of the stability promise: every panel declares one, and it is what a
 * client that cannot render the body draws instead of nothing.
 *
 * The deeplink is not optional in practice even though the type allows it — a
 * surface that cannot draw the panel should still be able to get the reader to
 * a surface that can.
 */
function fallback(text, link) {
  return { title: "Linear", text, deeplink: link };
}

/* ── Measurements ───────────────────────────────────────────────────────── */

/**
 * The vocabulary's own ceilings, restated here because a plugin child is
 * CommonJS and cannot import ADE's TypeScript. Kept in one place so a builder
 * never spells a number inline.
 *
 * Pinned against the real `VOCAB_LIMITS` by
 * `apps/desktop/src/renderer/components/plugins/linearPluginPanels.test.tsx`,
 * which is the only test that can see both tables. A drift here is not a
 * failure in this package's own tests — it is a panel measuring itself against
 * a ceiling the parser no longer enforces, refused whole at publish time.
 */
const LIMITS = {
  maxNodes: 200,
  maxSchemaBytes: 65_536,
  maxListItems: 1000,
  maxKeyValueRows: 60,
  maxFormFields: 24,
  maxTextChars: 4_000,
  maxMarkdownChars: 16_000,
  maxLabelChars: 200,
  maxValueChars: 1_000,
  maxStateOptions: 8,
  maxBoundStateOptions: 50,
  maxSelectOptions: 80,
  maxListItemActions: 3,
  maxBulkActions: 4,
  maxSelectedRows: 100,
};

/**
 * How many bytes a panel may spend before this plugin stops adding to it.
 *
 * Under `maxSchemaBytes` on purpose. The ceiling refuses the whole panel, and a
 * panel refused because its last comment was 200 bytes too long is a blank
 * screen where there was a working issue — so the builders stop at the soft
 * bound and say what they dropped, which is the behaviour every other budget in
 * this platform asks for.
 */
const SOFT_SCHEMA_BYTES = 56 * 1024;

/** Serialized size of a value as the writer will measure it. */
function schemaBytes(value) {
  try {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof json !== "string") return Number.POSITIVE_INFINITY;
    return Buffer.byteLength(json, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Cut a string to a ceiling, saying so.
 *
 * The ellipsis is part of the budget rather than added past it, because a
 * "clamp" that returns one character more than the limit is not a clamp.
 */
function clamp(text, max) {
  const value = typeof text === "string" ? text.trim() : "";
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, Math.max(0, max));
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** A label — a heading, a button, a badge. */
function label(text) {
  return clamp(text, LIMITS.maxLabelChars);
}

/** A `keyValue` value or a row's `meta`. */
function value(text) {
  return clamp(text, LIMITS.maxValueChars);
}

/** A `text` or `markdown` node's body. */
function prose(text) {
  return clamp(text, LIMITS.maxTextChars);
}

/* ── Tones and icons ────────────────────────────────────────────────────── */

/**
 * The same six as icon TOKENS.
 *
 * Node-level icons name tokens, never artwork, so Linear's hand-drawn state
 * rings — a dashed circle, a quarter-swept ring, a filled disc with a check —
 * become the nearest thing in the closed generic list. The Linear mark itself
 * is `brand:linear`, shipped as `icons/linear.svg` in this package.
 */
const STATE_ICONS = {
  triage: "flag",
  backlog: "list",
  unstarted: "kanban",
  started: "play",
  completed: "list-checks",
  canceled: "clock-counter-clockwise",
};

function stateIcon(stateType) {
  return STATE_ICONS[String(stateType ?? "").toLowerCase()] ?? "kanban";
}

// No group-order table here. There was one, named after the built-in's
// `STATE_GROUP_ORDER` and claiming parity with it — but nothing outside a test
// ever called it, and it DISAGREED with the order the product actually draws.
// The live order is `issueFormat.js:STATE_RANKS` (started, unstarted, backlog,
// triage, completed, canceled), stamped onto every row as `stateRank` by
// `normalizeIssue` and sorted on in `data.js:buildGroups`. Two orders, one of
// them dead, is how a panel ends up drawing sections in an order no one chose.

/**
 * Priority as the built-in labels it (`linearPriorityLabel`), plus a token.
 *
 * Linear draws priority as a bar histogram — four bars with four, three, two or
 * one filled. The vocabulary's `priority-*` tokens are that histogram, so each
 * level is a distinct glyph rather than a shared `chart-bar`. Urgent is the
 * one the reader must not miss, so it takes the destructive tone.
 */
const PRIORITIES = [
  { value: "1", label: "Urgent", icon: "priority-urgent", tone: "destructive" },
  { value: "2", label: "High", icon: "priority-high", tone: "warning" },
  { value: "3", label: "Medium", icon: "priority-medium", tone: "neutral" },
  { value: "4", label: "Low", icon: "priority-low", tone: "neutral" },
  { value: "0", label: "No priority", icon: "priority-none", tone: "neutral" },
];

function priorityEntry(priority) {
  const key = String(priority ?? "");
  return PRIORITIES.find((entry) => entry.value === key) ?? null;
}

/* ── Copy ───────────────────────────────────────────────────────────────── */

/**
 * Every sentence a reader sees, in one table.
 *
 * Ported from the built-in panes rather than rewritten. A string that has no
 * built-in counterpart — the ones the plugin says because the plugin holds its
 * own credential — is marked as such where it is used.
 */
const COPY = {
  // Filter controls — `LinearIssueBrowser.tsx:70`, `:101`, `:110`, `:914`,
  // `LinearIssueListScreen.swift:260`, `:314`.
  stateAll: "All issues",
  stateActive: "Active",
  stateBacklog: "Backlog",
  anyPriority: "Any priority",
  anyone: "Anyone",
  assignedToMe: "Assigned to me",
  allProjects: "All projects",
  allTeams: "All teams",
  filterState: "State",
  filterProject: "Project",
  filterTeam: "Team",
  filterAssignee: "Assignee",
  filterPriority: "Priority",
  filterSort: "Sort",
  filterUpdated: "Updated",
  resetFilters: "Reset filters",

  sortUpdated: "Recently updated",
  sortCreated: "Recently created",
  sortPriority: "Priority",
  sortDue: "Due soon",
  sortIdentifier: "Issue key",

  updatedAny: "Any time",
  updatedDay: "Today",
  updatedWeek: "This week",
  updatedMonth: "This month",

  // Search. The built-in has a live text field in the toolbar; this panel
  // uses the same words on `chrome.search`.
  search: "Search issues…",
  searchTitle: "Search issues",
  searchPlaceholder: "Title, identifier, or description",
  searchSubmit: "Search",
  clearSearch: "Clear search",

  // List states — `LinearIssueBrowser.tsx:1199`, `:644`,
  // `LinearIssueListScreen.swift:157`, `:173`.
  noIssuesTitle: "No issues",
  noIssues: "No Linear issues match these filters.",
  noIssuesAssigned:
    "Nothing assigned to you matches these filters. Turn off “Assigned to me” to widen the search.",
  loadFailedTitle: "Couldn’t load Linear",
  loadFailedBody: "Unable to load Linear.",
  machineSilent: "The machine didn’t answer. Pull to retry.",
  retry: "Retry",
  loadingTitle: "Loading Linear issues…",
  loadingBody: "Reading your workspace.",

  // Connection gate — `LinearPaneSheet.swift:76`, `LinearSection.tsx:611`.
  connectTitle: "Connect Linear",
  connectBody:
    "Sign in to browse and launch Linear issues from ADE. The token stays on this machine.",
  connectAction: "Sign in with Linear",
  connectOauthBody: "Connects the workspace currently selected in Linear.",
  connectWaiting: "Waiting for Linear…",
  openSettings: "Open Linear settings",
  // The nav-bar verb. Named separately from `retry`, which is the error card's
  // word for the same action and reads wrong on a list that loaded fine.
  refresh: "Refresh",

  // Row and detail chrome.
  hasLane: "Has lane",
  hasAgent: "Has agent",
  unassigned: "Unassigned",
  unknownCreator: "Unknown",
  updatedRecently: "Updated recently",
  notAvailable: "n/a",
  noDescription: "No description.",
  subIssues: "Sub-issues",
  comments: "Comments",
  noComments: "No comments yet.",
  commentsLoading: "Loading comments…",
  commentsFailed: "Couldn’t load comments.",
  earlierComments: "Show earlier comments",
  someone: "Someone",
  branch: "Branch",
  openInLinear: "Open in Linear",
  comment: "Comment",
  commentTitle: "Add a comment",
  commentPlaceholder: "One line",
  commentSubmit: "Comment",
  linkLaneTitle: "Link to a lane",
  linkLanePlaceholder: "Choose a lane",
  linkLaneSubmit: "Link",
  assignToMe: "Assign to me",

  // Property labels — `IssueProperties`, in the built-in's order.
  propStatus: "Status",
  propPriority: "Priority",
  propAssignee: "Assignee",
  propProject: "Project",
  propTeam: "Team",
  propCycle: "Cycle",
  propCreator: "Creator",
  propEstimate: "Estimate",
  propDue: "Due",
  propCreated: "Created",
  propUpdated: "Updated",
  propStarted: "Started",
  propCompleted: "Completed",
  propCanceled: "Canceled",

  // Launch — `SINGLE_LAUNCH_ACTIONS` and `BATCH_ACTIONS_CONFIG`.
  launchOne: "Launch lane + agent",
  launchOneBody: "New lane with this issue linked, plus an agent kicked off on it.",
  laneOne: "Create lane only",
  laneOneBody: "New lane with this issue linked. Start an agent later.",
  launchMany: "Launch lanes + agents",
  launchManyBody: "A lane and an agent kicked off per issue",
  laneMany: "Create lanes only",
  laneManyBody: "A lane per issue, start agents later",
  linkToLane: "Link to a lane",

  // The connection card — `LinearSection.tsx:472`, `:514`, `:668`,
  // `LinearConnectionScreen.swift:77`, `:312`.
  connectedTitle: "Connected to Linear",
  reconnect: "Reconnect current workspace",
  disconnect: "Disconnect",
  disconnectConfirm:
    "This clears Linear for the whole machine. Every ADE surface on it will need to reconnect.",
  workspace: "Workspace",
  workspaceKey: "Workspace key",
  signedInAs: "Signed in as",
  signInMethod: "Sign-in method",
  token: "Token",
  switchWorkspace:
    "To connect a different workspace, switch workspaces in Linear first, then reconnect here.",
  apiKeyHeading: "API key",
  apiKeyBody: "Paste a personal API key from your Linear settings. Good if OAuth isn’t working.",
  apiKeyLabel: "Linear API key",
  apiKeyPlaceholder: "lin_api_...",
  apiKeyHelp:
    "Stored in this machine’s keychain, namespaced to this plugin. No other plugin can read it.",
  apiKeyRejected: "That API key didn’t work. Check it and try again.",
  connect: "Connect",
  createKey: "Create a key on linear.app",

  // GitHub autolinks — `LinearSection.tsx:738`.
  autolinksHeading: "GitHub reference links",
  autolinksBody:
    "GitHub autolinks make Linear issue keys (like ENG-123) and ADE PR refs clickable wherever they appear in PRs, commits, and comments — no full URLs needed. Applies to the repo below for this project.",
  autolinksRepo: "Repository",
  autolinksNoRepo: "No GitHub origin detected",
  autolinksCreate: "Create",
  autolinksConfigured: "Configured",
  autolinksEmpty:
    "Connect Linear and load projects to add team-key references such as TEAM-123 for this workspace.",
};

module.exports = {
  COPY,
  DEEPLINK_ISSUE,
  DEEPLINK_ISSUES,
  DEEPLINK_LAUNCH,
  DEEPLINK_SETTINGS,
  LIMITS,
  PLUGIN_ID,
  PRIORITIES,
  SOFT_SCHEMA_BYTES,
  STATE_ICONS,
  STATE_TONES,
  clamp,
  deeplink,
  fallback,
  label,
  priorityEntry,
  priorityLabel,
  prose,
  schemaBytes,
  stateIcon,
  stateTone,
  value,
};
