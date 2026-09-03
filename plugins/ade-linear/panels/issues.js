// The issue list — the panel the pane opens on.
//
// It is the built-in browser's middle column: a filter strip, issues grouped by
// their workflow state in the built-in's fixed rank order, and a batch. What it
// is NOT is the built-in's three-column layout — the vocabulary has no
// independently scrolling split, so the detail is a second panel the reader
// navigates to and the host gives them the way back. See `issue.js`.
//
// ## Where each filter is decided
//
// Four of the controls filter on the CLIENT, against rows already in memory, so
// moving them costs no round trip and no fetch: project, assignee, priority and
// recency are top-level fields of every issue row and the binding's `where`
// compares them to the live value of a `segmented` control.
//
// Three cannot be, and are round trips through `applyFilters` / `searchIssues`:
//
// - **The state preset** (All / Active / Backlog) decides which GROUPS exist. A
//   `where` hides rows inside a section; it cannot remove the section, so a
//   locally filtered "Active" would draw an empty "Done" heading. The built-in
//   sends `stateTypes` to Linear for the same reason.
// - **Sort** is the order rows are written in. `collections.list` orders by key
//   and the client never re-sorts (rule 3), so a new sort is new keys.
// - **Search** is Linear's own text match, not a client `contains`. The nav-bar
//   field (`chrome.search`) commits on blur and Enter; four `where` clauses is
//   already the ceiling, so the query cannot also ride as a fifth predicate.
//
// ## Grouping and a batch, together
//
// Every state group's list declares the same `selectable` key. The host unions
// ticks across those lists into one bar, so grouping and a cross-group batch
// are both on screen — the same picture the compiled desktop and the phone
// already draw. There is no flat-list toggle.

"use strict";

const {
  ACTIONS,
  COLLECTION_ISSUES,
  COLLECTION_PEOPLE,
  COLLECTION_PROJECTS,
  COLLECTION_TEAMS,
  FIELD_ASSIGNEE,
  FIELD_PRIORITY,
  FIELD_PROJECT,
  FIELD_UPDATED,
  ISSUE_ROW_ACTIONS,
  STATE_ASSIGNEE,
  STATE_BATCH,
  STATE_PRESET,
  STATE_PRIORITY,
  STATE_PROJECT,
  STATE_SEARCH,
  STATE_SORT,
  STATE_TEAM,
  STATE_UPDATED,
  groupKeyPrefix,
} = require("./contract");

const {
  COPY,
  DEEPLINK_ISSUES,
  LIMITS,
  PRIORITIES,
  fallback,
  label,
  prose,
  stateIcon,
  value,
} = require("./common");

/**
 * The vocabulary's ceiling on distinct `segmented` keys in one panel.
 *
 * Spelled here rather than only in `LIMITS` because this panel is the one that
 * can actually reach it. Search spends a state key of its own in `chrome.search`,
 * so the strip keeps seven segmented axes and slices a ninth. {@link filterStrip}
 * builds in importance order and cuts the tail.
 */
const MAX_FILTER_CONTROLS = 8;

/**
 * How many state sections this panel draws.
 *
 * Two nodes per group, and `VOCAB_LIMITS.maxNodes` is 200 for the whole panel —
 * which the filter strip, the search row and the footer also spend from. Groups
 * are one per distinct state id across up to 1000 issues, and every Linear TEAM
 * has its own state ids, so a sixteen-team workspace reaches ninety-odd. The
 * parser fails the whole panel on overflow rather than truncating, so the
 * ceiling has to be enforced here or the reader gets a fallback card instead of
 * their issues.
 */
const MAX_STATE_GROUPS = 40;

/** The three presets the built-in's state tabs offer, in its order. */
const STATE_PRESETS = [
  { value: "all", label: COPY.stateAll },
  { value: "active", label: COPY.stateActive },
  { value: "backlog", label: COPY.stateBacklog },
];

/** The five sort orders of `SORT_OPTIONS`, in its order. */
const SORT_ORDERS = [
  { value: "updated_desc", label: COPY.sortUpdated },
  { value: "created_desc", label: COPY.sortCreated },
  { value: "priority", label: COPY.sortPriority },
  { value: "due_soon", label: COPY.sortDue },
  { value: "identifier_asc", label: COPY.sortIdentifier },
];

/**
 * Recency, as offsets the client resolves against its own clock.
 *
 * The built-in has no such filter — it is the one axis this panel adds — and it
 * is free: `{"$rel": "-7d"}` is read at render time, so no row carries a
 * `today` field that would be false by morning. It re-reads when the panel
 * re-renders, never on a timer, which is why the panel declares a
 * `refreshAction`: pulling to refresh is how a reader forces the boundary to
 * move.
 */
const UPDATED_RANGES = [
  { value: "", label: COPY.updatedAny },
  { value: "-24h", label: COPY.updatedDay },
  { value: "-7d", label: COPY.updatedWeek },
  { value: "-30d", label: COPY.updatedMonth },
];

/**
 * The predicate every issue list carries.
 *
 * Four top-level clauses, which is exactly `maxWhereClauses`, ANDed. Each goes
 * inactive on its own when its control sits on the unset option, so a reader
 * who has touched nothing sees every row and a reader who has touched one axis
 * pays for one string compare per row.
 */
function issueWhere() {
  return [
    { field: FIELD_PROJECT, equals: { $state: STATE_PROJECT } },
    { field: FIELD_ASSIGNEE, equals: { $state: STATE_ASSIGNEE } },
    { field: FIELD_PRIORITY, equals: { $state: STATE_PRIORITY } },
    { field: FIELD_UPDATED, since: { $state: STATE_UPDATED } },
  ];
}

/** Told on every change, so the plugin can widen the fetch behind the filter. */
function onFilterChange() {
  return { action: ACTIONS.applyFilters };
}

/**
 * The state-preset control. The one filter the built-in draws as tabs.
 */
function presetControl(input) {
  return {
    component: "segmented",
    stateKey: STATE_PRESET,
    label: COPY.filterState,
    default: input.statePreset ?? "all",
    options: STATE_PRESETS,
    onChange: onFilterChange(),
  };
}

/**
 * The project control, bound to the plugin's own `projects` rows.
 *
 * A control with one real option is a filter stuck where the author left it. A
 * BOUND control is exempt from the two-option floor because its second option is
 * data that has not arrived, so it is drawn as soon as the plugin has any
 * projects at all — and omitted entirely when it has none. Past eight options
 * every client draws it as a menu, which is what the phone's nested filter menu
 * already looked like.
 */
function projectControl() {
  return {
    component: "segmented",
    stateKey: STATE_PROJECT,
    label: COPY.filterProject,
    default: "",
    options: [{ value: "", label: COPY.allProjects }],
    optionsFrom: { collection: COLLECTION_PROJECTS, valueField: "id", labelField: "name" },
    onChange: onFilterChange(),
  };
}

/**
 * The assignee control: the phone's "Assigned to me" chip and the desktop's
 * dropdown, as one axis.
 *
 * `Me` is a LITERAL option carrying the viewer's own id, declared before the
 * bound ones. That ordering is what makes the phone's one-tap filter survive the
 * translation: a reader who wants their own issues presses one pill rather than
 * hunting their own name in a menu of eighty, and the control still opens
 * instantly because a literal option needs no rows to have arrived.
 */
function assigneeControl(input) {
  const options = [{ value: "", label: COPY.anyone }];
  if (input.viewerId) options.push({ value: String(input.viewerId), label: COPY.assignedToMe });
  return {
    component: "segmented",
    stateKey: STATE_ASSIGNEE,
    label: COPY.filterAssignee,
    default: "",
    options,
    optionsFrom: { collection: COLLECTION_PEOPLE, valueField: "id", labelField: "name" },
    onChange: onFilterChange(),
  };
}

/** Six options, which is under the literal ceiling of eight. */
function priorityControl() {
  return {
    component: "segmented",
    stateKey: STATE_PRIORITY,
    label: COPY.filterPriority,
    default: "",
    options: [
      { value: "", label: COPY.anyPriority },
      ...PRIORITIES.map((entry) => ({ value: entry.value, label: entry.label })),
    ],
  };
}

function sortControl(input) {
  return {
    component: "segmented",
    stateKey: STATE_SORT,
    label: COPY.filterSort,
    default: input.sort ?? "updated_desc",
    options: SORT_ORDERS,
    onChange: onFilterChange(),
  };
}

/** Client-side and free: no `onChange`, because nothing needs refetching. */
function updatedControl() {
  return {
    component: "segmented",
    stateKey: STATE_UPDATED,
    label: COPY.filterUpdated,
    default: "",
    options: UPDATED_RANGES,
  };
}

/**
 * The team control. A round trip, not a client `where`.
 *
 * `valueField: "key"` and not `"id"`: the value this sends back is stored as
 * the `teamKey` filter and reaches Linear as `team: { key: { eq } }`, which is
 * the only shape its `IssueFilter` offers. Binding the id would have sent a
 * uuid where a key belongs and matched nothing.
 *
 * It earns a key only in a workspace with more than one team, and it is LAST in
 * the strip's importance order, so it is the control that goes when the eight
 * keys are spent. A single-team workspace would get a filter that can only ever
 * mean "all", which is the two-option floor the vocabulary refuses anyway.
 */
function teamControl(input = {}) {
  return {
    component: "segmented",
    stateKey: STATE_TEAM,
    label: COPY.filterTeam,
    default: input.teamKey ?? "",
    options: [{ value: "", label: COPY.allTeams }],
    optionsFrom: { collection: COLLECTION_TEAMS, valueField: "key", labelField: "name" },
    onChange: onFilterChange(),
  };
}

/**
 * The filter strip, in importance order, cut to the key budget.
 *
 * Building the list and slicing it is the whole safety story: a ninth
 * `segmented` fails the entire panel, so the strip must never be able to grow
 * past the ceiling however many optional axes the workspace turns on. `wrap` is
 * off so a crowded strip scrolls as a chip row rather than wrapping into a
 * second filter block.
 */
function filterStrip(input = {}) {
  const children = [presetControl(input)];

  if (input.hasProjects) children.push(projectControl());
  if (input.hasPeople || input.viewerId) children.push(assigneeControl(input));
  children.push(priorityControl());
  children.push(sortControl(input));
  children.push(updatedControl());
  if (input.hasTeams) children.push(teamControl(input));

  return {
    component: "stack",
    direction: "horizontal",
    gap: "sm",
    wrap: false,
    align: "center",
    children: children.slice(0, MAX_FILTER_CONTROLS),
  };
}

/**
 * The way back out of a live filter or a persisted search.
 *
 * Typing happens in `chrome.search`. This row is only the visible remainder: a
 * badge when the data layer still has a query (a restored session, or a host
 * whose nav-bar field is empty), and Reset filters, which is the only verb that
 * can move client state.
 */
function searchRow(input = {}) {
  const query = input.query ?? null;
  if (!query && !input.filtersActive) return null;
  const children = [];
  if (query) {
    children.push({ component: "badge", text: label(`“${query}”`), tone: "accent", icon: "tag" });
  }
  children.push({
    component: "button",
    label: COPY.resetFilters,
    kind: "quiet",
    onPress: { action: ACTIONS.clearFilters },
  });
  return { component: "stack", direction: "horizontal", gap: "sm", wrap: true, align: "center", children };
}

/** The binding every state group shares. */
function issueBinding(keyPrefix) {
  return {
    collection: COLLECTION_ISSUES,
    keyPrefix,
    limit: LIMITS.maxListItems,
    allowActions: ISSUE_ROW_ACTIONS,
    where: issueWhere(),
  };
}

/**
 * Four bulk verbs, which is `maxBulkActions`, and the two that create lanes ask
 * first — a mistake here costs eleven lanes, which is the case `confirm` on a
 * batch was added for. The two launch verbs are the built-in's
 * `BATCH_ACTIONS_CONFIG` with its own words; the other two are verbs the
 * built-in does not have on either surface and are marked as additions in the
 * parity report rather than passed off as parity.
 *
 * Every grouped list uses this same key, so ticks in Started and ticks in Todo
 * land on one bar.
 */
function batchSelectable() {
  return {
    stateKey: STATE_BATCH,
    max: LIMITS.maxSelectedRows,
    actions: [
      {
        action: ACTIONS.launchLaneAndAgent,
        label: COPY.launchMany,
        kind: "primary",
        icon: "sparkle",
        confirm: "Create a lane and start an agent for each selected issue?",
      },
      {
        action: ACTIONS.launchLaneOnly,
        label: COPY.laneMany,
        icon: "git-branch",
        confirm: "Create a lane for each selected issue?",
      },
      { action: ACTIONS.assignToMe, label: COPY.assignToMe, icon: "users" },
      { action: ACTIONS.linkToLane, label: COPY.linkToLane, icon: "link" },
    ],
  };
}

/**
 * One collapsible section per workflow state.
 *
 * `groupKey` is the state's id rather than its title, so a plugin republishing
 * its rows every few seconds cannot re-open a section the reader just closed,
 * and renaming a state in Linear does not either. The desktop built-in folds
 * nothing by default and the phone folds `completed`; the plugin decides per
 * group and says so on the row, which is how one panel serves both.
 */
function stateGroups(groups) {
  const drawn = groups.slice(0, MAX_STATE_GROUPS);
  const nodes = drawn.map((group) => ({
    component: "group",
    title: label(group.stateName || group.stateType || "Other"),
    groupKey: String(group.stateId),
    icon: stateIcon(group.stateType),
    ...(group.count != null ? { badge: String(group.count) } : {}),
    defaultOpen: group.defaultOpen !== false,
    children: [
      {
        component: "list",
        bind: issueBinding(groupKeyPrefix(group.stateId)),
        emptyText: COPY.noIssues,
        selectable: batchSelectable(),
      },
    ],
  }));
  // Said out loud, never dropped in silence. `parsePluginPanel` fails the WHOLE
  // panel on `maxNodes` rather than truncating, so an uncapped group list on a
  // multi-team workspace draws the "open ADE on the computer that holds this
  // plugin" fallback ON that computer. Every other list in this plugin caps;
  // this one is the only one whose length is a property of the workspace.
  const dropped = groups.length - drawn.length;
  if (dropped > 0) {
    nodes.push({
      component: "text",
      variant: "caption",
      text: value(
        `${dropped} more workflow ${dropped === 1 ? "state" : "states"} are not shown here.`,
      ),
    });
  }
  return nodes;
}

/**
 * The one-line footer under the list.
 *
 * Pre-formatted, because rule 3 forbids arithmetic in a schema. The list draws
 * its own "Showing 100 of 143" line, so this says what the list cannot: which
 * workspace these issues are from, and how old the reading is.
 */
function issuesFooter(input = {}) {
  const parts = [];
  if (input.workspace) parts.push(input.workspace);
  if (input.age) parts.push(`updated ${input.age}`);
  return parts.join(" · ");
}

function issuesFallback(text) {
  return fallback(
    text ?? "Open ADE on the computer that holds this plugin to browse Linear issues.",
    DEEPLINK_ISSUES,
  );
}

/**
 * The nav bar's trailing verbs, in importance order and inside the cap of four.
 *
 * This is what turns a pane into a page. The verbs a full-width tab needs at
 * the top right are the three that are ABOUT the list rather than about a row —
 * leave for Linear, fetch again, change the connection — and the body is the
 * wrong place for all three: a button above the filter strip pushes the issues
 * down the screen on every client, and the phone's `.searchable` nav bar has
 * the slots sitting empty. Open-in-Linear in the body rather than the nav bar
 * is on the handoff report's reduced list by name.
 *
 * `Refresh` is here as well as in `refreshAction`, and deliberately: the
 * manifest's refresh is a GESTURE — a pull on the phone, `r` in the terminal —
 * and on a wide desktop page a gesture nobody can see is not a control.
 */
function issuesNavActions(input = {}) {
  const actions = [];
  if (input.workspaceUrl) {
    actions.push({
      action: ACTIONS.openExternal,
      args: { url: String(input.workspaceUrl) },
      label: COPY.openInLinear,
      icon: "brand:linear",
    });
  }
  actions.push({ action: ACTIONS.refreshIssues, label: COPY.refresh, icon: "clock-counter-clockwise" });
  actions.push({ action: ACTIONS.openSettings, label: COPY.openSettings, icon: "gear" });
  return actions;
}

function issuesChrome(input = {}) {
  const footer = issuesFooter(input);
  return {
    search: {
      stateKey: STATE_SEARCH,
      placeholder: COPY.search,
      onChange: { action: ACTIONS.searchIssues },
    },
    navActions: issuesNavActions(input),
    ...(footer
      ? { footer: [{ component: "text", variant: "caption", text: value(footer) }] }
      : {}),
  };
}

/**
 * The issue list panel.
 *
 * `state` decides which of five bodies renders — `loading`, `disconnected`,
 * `error`, `empty` or the list — the same five the built-in browser draws, and
 * each one is a whole panel rather than a banner over an empty list, because a
 * reader who is not connected has no use for a filter strip.
 */
function buildIssuesPanel(input = {}) {
  const { state = "list", error = null, groups = [], title = "Linear" } = input;

  if (state === "loading") {
    return {
      v: 1,
      title,
      fallback: issuesFallback(),
      body: [
        {
          component: "emptyState",
          title: COPY.loadingTitle,
          description: COPY.loadingBody,
          icon: "kanban",
        },
      ],
    };
  }

  if (state === "disconnected") {
    return {
      v: 1,
      title,
      fallback: issuesFallback("Connect Linear in ADE to browse issues here."),
      body: [
        {
          component: "emptyState",
          title: COPY.connectTitle,
          description: COPY.connectBody,
          icon: "plug",
          action: { label: COPY.connectAction, onPress: { action: ACTIONS.connectOAuth } },
        },
        {
          component: "button",
          label: COPY.openSettings,
          kind: "quiet",
          icon: "gear",
          onPress: { action: ACTIONS.openSettings },
        },
      ],
    };
  }

  if (state === "error") {
    return {
      v: 1,
      title,
      fallback: issuesFallback(),
      body: [
        {
          component: "emptyState",
          title: COPY.loadFailedTitle,
          description: prose(error ?? COPY.machineSilent),
          icon: "cloud",
          action: { label: COPY.retry, onPress: { action: ACTIONS.refreshIssues } },
        },
        {
          component: "button",
          label: COPY.openSettings,
          kind: "quiet",
          icon: "gear",
          onPress: { action: ACTIONS.openSettings },
        },
      ],
    };
  }

  const filters = searchRow(input);
  const body = [filterStrip(input), ...(filters ? [filters] : [])];

  if (state === "empty" || groups.length === 0) {
    body.push({
      component: "emptyState",
      title: COPY.noIssuesTitle,
      description: input.assignedToMe ? COPY.noIssuesAssigned : COPY.noIssues,
      icon: "kanban",
      action: { label: COPY.resetFilters, onPress: { action: ACTIONS.clearFilters } },
    });
  } else {
    body.push(...stateGroups(groups));
  }

  return {
    v: 1,
    title,
    fallback: issuesFallback(),
    chrome: issuesChrome(input),
    body,
  };
}

module.exports = {
  MAX_FILTER_CONTROLS,
  SORT_ORDERS,
  STATE_PRESETS,
  UPDATED_RANGES,
  buildIssuesPanel,
  filterStrip,
  issueBinding,
  issueWhere,
  issuesFooter,
  searchRow,
  stateGroups,
};
