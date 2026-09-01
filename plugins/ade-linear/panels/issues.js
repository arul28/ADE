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
// Three cannot be, and are round trips through `applyFilters`:
//
// - **The state preset** (All / Active / Backlog) decides which GROUPS exist. A
//   `where` hides rows inside a section; it cannot remove the section, so a
//   locally filtered "Active" would draw an empty "Done" heading. The built-in
//   sends `stateTypes` to Linear for the same reason.
// - **Sort** is the order rows are written in. `collections.list` orders by key
//   and the client never re-sorts (rule 3), so a new sort is new keys.
// - **View** switches the node tree between grouped sections and one flat
//   selectable list, and a predicate cannot change a tree.
//
// ## Why the view control exists at all
//
// A bulk bar is computed per LIST, against the keys that list can see. Seven
// grouped lists sharing one selection key would therefore draw seven bars, each
// counting and acting on its own section — so grouping and a cross-group batch
// cannot both be on screen in vocabulary v1. Rather than pick one, the panel
// offers both and says which it is showing: grouped is the default and matches
// the phone's built-in, flat is where the desktop's multi-select lives.

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
  STATE_SORT,
  STATE_TEAM,
  STATE_UPDATED,
  STATE_VIEW,
  flatKeyPrefix,
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
  value,
} = require("./common");

/**
 * The vocabulary's ceiling on distinct `segmented` keys in one panel.
 *
 * Spelled here rather than only in `LIMITS` because this panel is the one that
 * can actually reach it: eight controls is every axis the built-in has plus the
 * two this panel adds, and a ninth would fail the WHOLE panel rather than drop
 * one control. {@link filterStrip} builds in importance order and cuts the tail,
 * so the axis that goes is the one the built-in never had.
 */
const MAX_FILTER_CONTROLS = 8;

/**
 * How many state sections this panel draws.
 *
 * Two nodes per group, and `VOCAB_LIMITS.maxNodes` is 200 for the whole panel —
 * which the filter strip, the search row and the footer also spend from. Groups
 * are one per distinct state id across up to 250 issues, and every Linear TEAM
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

const VIEWS = [
  { value: "grouped", label: COPY.viewGrouped },
  { value: "flat", label: COPY.viewFlat },
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

function viewControl(input) {
  return {
    component: "segmented",
    stateKey: STATE_VIEW,
    label: COPY.filterView,
    style: "toggle",
    default: input.view === "flat" ? "flat" : "grouped",
    options: VIEWS,
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
 * The team control — the one axis the built-in does not have.
 *
 * It earns a key only in a workspace with more than one team, and it is LAST in
 * the strip's importance order, so it is the control that goes when the eight
 * keys are spent. A single-team workspace would get a filter that can only ever
 * mean "all", which is the two-option floor the vocabulary refuses anyway.
 */
/**
 * The team control. A round trip, not a client `where`.
 *
 * `valueField: "key"` and not `"id"`: the value this sends back is stored as
 * the `teamKey` filter and reaches Linear as `team: { key: { eq } }`, which is
 * the only shape its `IssueFilter` offers. Binding the id would have sent a
 * uuid where a key belongs and matched nothing.
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
 * past the ceiling however many optional axes the workspace turns on.
 */
function filterStrip(input = {}) {
  const children = [presetControl(input)];

  if (input.hasProjects) children.push(projectControl());
  if (input.hasPeople || input.viewerId) children.push(assigneeControl(input));
  children.push(priorityControl());
  children.push(sortControl(input));
  children.push(viewControl(input));
  children.push(updatedControl());
  if (input.hasTeams) children.push(teamControl(input));

  return {
    component: "stack",
    direction: "horizontal",
    gap: "sm",
    wrap: true,
    align: "center",
    children: children.slice(0, MAX_FILTER_CONTROLS),
  };
}

/**
 * The search affordance, and the way back out of every filter.
 *
 * The built-in has a live text field — `.searchable` in the phone's nav bar, an
 * input in the desktop toolbar — and the vocabulary has no search node, so this
 * is a button that answers `{prompt}`: the client asks the question in its own
 * chrome (a popover on desktop, an alert on the phone, an inline field in the
 * terminal) and invokes the same action again with the answer.
 *
 * When a search is live the strip says so and offers the way out, because a
 * filtered list with no visible filter is the thing a reader files a bug about.
 * `Reset filters` is the desktop's own button and clears the CONTROLS as well as
 * the query — a handler answering `{resetState: [...]}` is the only thing that
 * can, since panel state belongs to the client.
 */
function searchRow(input = {}) {
  const query = input.query ?? null;
  const children = [
    {
      component: "button",
      label: COPY.search,
      kind: "quiet",
      onPress: { action: ACTIONS.searchIssues },
    },
  ];
  if (query) {
    children.unshift({ component: "badge", text: label(`“${query}”`), tone: "accent", icon: "tag" });
    children.push({
      component: "button",
      label: COPY.clearSearch,
      kind: "quiet",
      onPress: { action: ACTIONS.clearSearch },
    });
  }
  if (query || input.filtersActive) {
    children.push({
      component: "button",
      label: COPY.resetFilters,
      kind: "quiet",
      onPress: { action: ACTIONS.clearFilters },
    });
  }
  return { component: "stack", direction: "horizontal", gap: "sm", wrap: true, align: "center", children };
}

/** The binding both views share, differing only in which keys they read. */
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
    ...(group.count != null ? { badge: String(group.count) } : {}),
    defaultOpen: group.defaultOpen !== false,
    children: [
      {
        component: "list",
        bind: issueBinding(groupKeyPrefix(group.stateId)),
        emptyText: COPY.noIssues,
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
        `${dropped} more workflow ${dropped === 1 ? "state" : "states"} are not shown here.`
        + " Switch to the flat view to see every issue in one list.",
      ),
    });
  }
  return nodes;
}

/**
 * The flat list, and the only list in this panel that ticks.
 *
 * Four bulk verbs, which is `maxBulkActions`, and the two that create lanes ask
 * first — a mistake here costs eleven lanes, which is the case `confirm` on a
 * batch was added for. The two launch verbs are the built-in's
 * `BATCH_ACTIONS_CONFIG` with its own words; the other two are verbs the
 * built-in does not have on either surface and are marked as additions in the
 * parity report rather than passed off as parity.
 */
function flatList() {
  return {
    component: "list",
    bind: issueBinding(flatKeyPrefix()),
    emptyText: COPY.noIssues,
    selectable: {
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
    },
  };
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
 * The issue list panel.
 *
 * `state` decides which of five bodies renders — `loading`, `disconnected`,
 * `error`, `empty` or the list — the same five the built-in browser draws, and
 * each one is a whole panel rather than a banner over an empty list, because a
 * reader who is not connected has no use for a filter strip.
 */
function buildIssuesPanel(input = {}) {
  const { state = "list", error = null, groups = [], query = null, title = "Linear" } = input;

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

  const body = [filterStrip(input), searchRow(input)];

  if (state === "empty" || (input.view !== "flat" && groups.length === 0)) {
    body.push({
      component: "emptyState",
      title: COPY.noIssuesTitle,
      description: input.assignedToMe ? COPY.noIssuesAssigned : COPY.noIssues,
      icon: "kanban",
      action: { label: COPY.resetFilters, onPress: { action: ACTIONS.clearFilters } },
    });
  } else if (input.view === "flat") {
    body.push(flatList());
  } else {
    body.push(...stateGroups(groups));
  }

  const footer = issuesFooter(input);
  if (footer) {
    body.push({ component: "divider" });
    body.push({ component: "text", variant: "caption", text: value(footer) });
  }

  return { v: 1, title, fallback: issuesFallback(), body };
}

module.exports = {
  MAX_FILTER_CONTROLS,
  SORT_ORDERS,
  STATE_PRESETS,
  UPDATED_RANGES,
  VIEWS,
  buildIssuesPanel,
  filterStrip,
  flatList,
  issueBinding,
  issueWhere,
  issuesFooter,
  searchRow,
  stateGroups,
};
