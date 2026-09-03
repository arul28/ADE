// The collection writer: Linear's answers become the rows every client draws.
//
// This is the half of the plugin that decides what is ON SCREEN, and it runs on
// the machine that holds the credential. The phone, the web client and the TUI
// then draw rows that are already shaped — no client knows what Linear is, and
// none of them can, because none of them can reach `api.linear.app`.
//
// ## Why one issue is written three times
//
// `collections.list` orders by key and offers no sort. So the ORDER a list
// draws in is the order its keys sort in, and the panel wants three different
// orders over the same issues:
//
//   * `issue:<id>` — the canonical row, addressed by id. Everything that holds
//     an issue id and wants the row (a tool, a flow, the detail panel, a
//     webhook) reads this one, and reads it with a single `get`.
//   * `flat:<rank>:<id>` — the reader's chosen sort, across every state.
//   * `group:<stateId>:<rank>:<id>` — one contiguous run per state group.
//
// The key spaces are `panels/contract.js`'s, imported rather than repeated:
// the panel schemas bind those prefixes, and a second spelling of them here is
// a bug that renders as an empty list rather than as an error.
//
// Three copies of 250 issues is 750 rows against a budget of 4,000
// (`PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN`) and a few hundred KiB against
// 2 MiB. The alternative — re-sorting client-side — is not available: a
// vocabulary binding has a `where` predicate and no comparator.
//
// ## Why the description is clamped and the row is not
//
// A single collection value is capped at 64 KiB
// (`PLUGIN_COLLECTION_VALUE_MAX_BYTES`) and a Linear description has no
// ceiling. An issue whose description blew the cap would fail its `put` and
// vanish from the list entirely — the reader would lose the ROW because of the
// BODY. So the description is clamped here, and the detail panel says it was.

"use strict";

const {
  COLLECTION_COMMENTS,
  COLLECTION_ISSUES,
  COLLECTION_LABELS,
  COLLECTION_PEOPLE,
  COLLECTION_PROJECTS,
  COLLECTION_STATES,
  COLLECTION_TEAMS,
  COLLECTION_VIEWER,
  VIEWER_KEY_CONNECTION,
  VIEWER_KEY_FILTERS,
  commentKey,
  commentKeyPrefix,
  flatIssueKey,
  groupIssueKey,
  rankSegment,
  statesKeyPrefix,
} = require("./panels/contract");
const { commentListRow, issueListRow } = require("./panels/rows");
const {
  issueRefFromRow,
  normalizeComment,
  normalizeIssue,
  normalizeState,
  normalizeTeam,
} = require("./issueFormat");

/** The canonical, id-addressed key space inside `issues`. */
const ISSUE_KEY_CANONICAL = "issue:";

/** The flat key space, as `panels/contract.js` builds it. Matched, never rebuilt. */
const ISSUE_KEY_FLAT = "flat:";

/**
 * The most rows one `collections.list` can return, whatever limit it is asked
 * for. The host clamps silently, so a caller that wants more than this has to
 * ask more than once — see {@link replacePrefix}.
 */
const LIST_PAGE_SIZE = 1_000;

/** How many times a sweep will re-read before leaving the rest to the next one. */
const SWEEP_PASSES = 4;

/** The group key space, as `panels/contract.js` builds it. Matched, never rebuilt. */
const ISSUE_KEY_GROUP = "group:";

/**
 * How many issues one refresh materializes.
 *
 * The vocabulary draws at most 1000 list items (`maxListItems`) and pages past
 * that, so fetching more would spend Linear's rate limit on rows no reader can
 * reach. The built-in's own ceiling is 500 with an opt-in button
 * (`LinearIssueBrowser.tsx:90`); 1000 is the phone's scroll-loaded ceiling and
 * the vocabulary's.
 */
const MAX_ISSUES = 1000;

/** Longest description carried on a row. Matches `maxMarkdownChars`. */
const MAX_DESCRIPTION_CHARS = 16_000;

/** Comments kept per issue. The detail panel pages within this. */
const MAX_COMMENTS_PER_ISSUE = 50;

/** The three state presets, ported from `LinearIssueBrowser.tsx:70`. */
const STATE_PRESETS = {
  all: null,
  active: ["backlog", "unstarted", "started"],
  backlog: ["backlog", "triage"],
};

/**
 * The five sorts the built-in offers (`LinearIssueBrowser.tsx:110`).
 *
 * Each returns a comparator, and the row's position in the sorted array becomes
 * its key rank. Sorting HERE rather than in the client is not a preference: a
 * binding compares fields and cannot order by one.
 */
const SORTS = {
  updated_desc: (a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
  created_desc: (a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  priority: (a, b) => priorityOrder(a.priority) - priorityOrder(b.priority)
    || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
  due_soon: (a, b) => dueOrder(a.dueDate) - dueOrder(b.dueDate)
    || String(a.identifier ?? "").localeCompare(String(b.identifier ?? "")),
  identifier_asc: (a, b) => String(a.identifier ?? "").localeCompare(String(b.identifier ?? ""), undefined, {
    numeric: true,
  }),
};

const DEFAULT_SORT = "updated_desc";

/**
 * Linear's priority scale sorts wrong.
 *
 * `0` means "no priority" and `1` means URGENT, so a plain ascending sort puts
 * the unprioritized issues above the urgent ones. This maps 0 to the bottom
 * and leaves 1..4 in their natural order, which is what "sort by priority"
 * means to a reader.
 */
function priorityOrder(priority) {
  const value = Number.isInteger(priority) ? priority : 0;
  return value === 0 ? 99 : value;
}

/** An issue with no due date sorts after every issue that has one. */
function dueOrder(dueDate) {
  if (!dueDate) return Number.MAX_SAFE_INTEGER;
  const at = Date.parse(String(dueDate));
  return Number.isNaN(at) ? Number.MAX_SAFE_INTEGER : at;
}

function clampText(value, max) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= max) return { text: text || null, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

/** The default filter set, byte-identical to `DEFAULT_FILTERS` in the built-in. */
function defaultFilters() {
  return {
    stateTab: "all",
    projectId: "",
    assigneeId: "",
    priority: "",
    sort: DEFAULT_SORT,
    text: "",
    // Stored rather than left to panel state, because panel state is per-viewer
    // and session-scoped (`vocabularyState.ts`). `view` is a leftover of the
    // grouped/flat toggle; the panel always draws grouped lists with a shared
    // batch key. The field still round-trips so an older prefs blob does not
    // fail `normalizeFilters`.
    view: "grouped",
    updated: "",
    // The TEAM, by key rather than by id, because that is what Linear's
    // `IssueFilter` matches on (`team: { key: { eq } }`) and what the stored
    // team rows carry beside their name.
    teamKey: "",
  };
}

/** Coerce a stored or submitted filter set into the shape every reader assumes. */
function normalizeFilters(raw) {
  const base = defaultFilters();
  if (!raw || typeof raw !== "object") return base;
  const stateTab = typeof raw.stateTab === "string" && raw.stateTab in STATE_PRESETS ? raw.stateTab : base.stateTab;
  const sort = typeof raw.sort === "string" && raw.sort in SORTS ? raw.sort : base.sort;
  const priority = raw.priority === 0 || raw.priority ? String(raw.priority) : "";
  return {
    stateTab,
    projectId: typeof raw.projectId === "string" ? raw.projectId : "",
    assigneeId: typeof raw.assigneeId === "string" ? raw.assigneeId : "",
    priority: /^[0-4]$/.test(priority) ? priority : "",
    sort,
    text: typeof raw.text === "string" ? raw.text : "",
    view: raw.view === "flat" ? "flat" : "grouped",
    updated: typeof raw.updated === "string" ? raw.updated : "",
    teamKey: typeof raw.teamKey === "string" ? raw.teamKey : "",
  };
}

/** Turn a filter set into the query `linearApi.searchAllIssues` takes. */
function filtersToQuery(filters) {
  const priority = filters.priority === "" ? null : Number(filters.priority);
  return {
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
    ...(Number.isInteger(priority) ? { priority } : {}),
    ...(filters.text ? { query: filters.text } : {}),
    // Server-side, not a client `where`: the team decides which GROUPS exist,
    // and a predicate hides rows inside a section without removing the section.
    ...(filters.teamKey ? { teamKey: filters.teamKey } : {}),
    ...(STATE_PRESETS[filters.stateTab] ? { stateTypes: STATE_PRESETS[filters.stateTab] } : {}),
  };
}

/**
 * The row a BOUND LIST reads, as opposed to the row this plugin reads.
 *
 * `readListItem` (`shared/plugins/vocabularyNodes.ts`) looks at the row fields
 * a bound list actually draws — title, key, subtitle, meta, tone, icon, mono,
 * badge, onPress, actions, overflow, preview, markdown, avatar — and IGNORES
 * everything else. A stored row carrying
 * `badgeText` and `badgeTone` therefore draws as a bare title with no chip and
 * no press, and a row with no `key` lets a tick inherit the COLLECTION key
 * (`flat:000012:<uuid>`), which is a sort rank standing in for an issue id.
 *
 * `issueListRow` makes those fields. The axes merged back on top are what a
 * binding's `where` compares, and dropping them would make every filter a
 * silent no-op.
 *
 * The CANONICAL row (`issue:<id>`) is deliberately NOT dressed. The detail
 * panel, the nine agent tools and the flows read `description`, `labels`,
 * `subIssues`, `branchName` and `teamKey` off it, and the dresser keeps none of
 * them. Dressed rows are for the two ordered key spaces a list binds, and
 * nothing else reads them.
 */
function boundIssueRow(row) {
  return {
    ...issueListRow(row),
    projectId: row.projectId,
    assigneeId: row.assigneeId,
    // A `where` compares text and `vocabPredicateFieldText` coerces a number,
    // so a string is the shape that cannot surprise either side.
    priority: String(row.priority ?? ""),
    // ISO-8601 with a zone, which is what `vocabTimeValue` accepts. Linear's
    // own `updatedAt` already is one; a spelling outside that silently drops
    // the recency clause rather than failing.
    updatedAt: row.updatedAt,
    stateId: row.stateId,
    stateType: row.stateType,
    hasLane: row.hasLane === true,
    laneId: row.laneId,
    laneName: row.laneName,
  };
}

/**
 * Build the data layer.
 *
 * Every dependency is injected — `sdk`, `api`, `now`, `log` — so the whole
 * module is testable against a fake collection store and a fake Linear.
 */
function createData(options = {}) {
  const { sdk, api, log = () => {}, now = () => Date.now() } = options;
  if (!sdk) throw new TypeError("createData needs the ade sdk");
  if (!api) throw new TypeError("createData needs a Linear api client");

  /** The last shaped model, so an action that needs it does not refetch. */
  let model = {
    connection: null,
    counts: { issues: 0, teams: 0 },
    lanes: [],
    models: [],
    error: null,
    updatedAt: null,
  };

  /* ── Small wrappers over the collection budget ────────────────────────── */

  /**
   * Store one row, never failing the caller.
   *
   * `evictOldest` asks the host to make room in THIS collection rather than
   * refusing, and a row that still could not be written is one row missing from
   * a list — never a refresh that reports failure and leaves the reader with
   * the previous, staler screen.
   */
  async function put(collection, key, value) {
    try {
      await sdk.collections.put(collection, key, value, { ifFull: "evictOldest" });
      return true;
    } catch (error) {
      log("warn", `Could not store ${collection}/${key}: ${error?.message ?? error}`);
      return false;
    }
  }

  async function del(collection, key) {
    await sdk.collections.delete(collection, key).catch(() => {});
  }

  async function list(collection, listOptions) {
    return await sdk.collections.list(collection, listOptions).catch(() => []);
  }

/**
   * Replace every row under a prefix with a new set.
   *
   * The delete half runs AFTER the write half and is never budget-checked, so
   * the worst outcome of a full store is a stale row rather than an empty
   * panel. A row for an issue that has left the filter would otherwise keep
   * rendering, and the reader has no way to tell it from a live one.
   *
   * ## Why it lists more than once
   *
   * `collections.list` CLAMPS any limit above `LIST_PAGE_SIZE` without saying
   * so (`pluginDataStore.ts:PLUGIN_COLLECTION_LIST_MAX_LIMIT`) and offers no
   * cursor — it orders by key and returns the first page, full stop. A single
   * read therefore cannot see past the first thousand keys, which is how stale
   * canonical issue rows survived every sweep: `flat:` and `group:` sort before
   * `issue:` and filled the page on their own.
   *
   * Deleting IS the cursor. Each pass removes the unwanted rows it can see, so
   * the next read starts further in. `SWEEP_PASSES` bounds it: a pass that
   * deletes nothing, or a page that was not full, means there is nothing behind
   * it, and a store somehow deeper than that converges over the next refresh
   * rather than looping here.
   */
  async function replacePrefix(collection, prefix, wanted) {
    for (const [key, value] of wanted) await put(collection, key, value);
    for (let pass = 0; pass < SWEEP_PASSES; pass += 1) {
      const page = await list(collection, { keyPrefix: prefix, limit: LIST_PAGE_SIZE });
      let deleted = 0;
      for (const row of page) {
        if (wanted.has(row.key)) continue;
        await del(collection, row.key);
        deleted += 1;
      }
      if (deleted === 0 || page.length < LIST_PAGE_SIZE) return;
    }
  }

  /* ── Lanes ───────────────────────────────────────────────────────────── */

  /**
   * Which Linear issue each lane already carries.
   *
   * Read from ADE, never from Linear: the link lives on the lane
   * (`PluginLaneSummary.primaryIssue` and `.issueLinks`), and an issue's
   * `hasLane` badge is the answer to "does this project already have work
   * open on it", which Linear cannot know.
   *
   * Links from ANY provider are read, not just this plugin's own. A lane the
   * built-in Linear integration attached is still a lane the reader must be
   * warned about before they open a second one — the whole point of the badge
   * is to stop a duplicate, and filtering by owner would hide exactly the
   * duplicates that exist today while the built-in still runs.
   */
  async function laneIndex() {
    let lanes = [];
    try {
      lanes = await sdk.lanes.list();
    } catch (error) {
      log("warn", `Could not read the lanes: ${error?.message ?? error}`);
      return { byIssueId: new Map(), rows: [] };
    }
    const byIssueId = new Map();
    const rows = [];
    for (const lane of Array.isArray(lanes) ? lanes : []) {
      const links = [
        ...(lane.primaryIssue ? [lane.primaryIssue] : []),
        ...(Array.isArray(lane.issueLinks) ? lane.issueLinks.map((link) => link?.issue).filter(Boolean) : []),
      ];
      for (const issue of links) {
        if (issue?.provider !== "linear" || !issue?.issueId) continue;
        if (!byIssueId.has(issue.issueId)) {
          byIssueId.set(issue.issueId, { laneId: lane.id, laneName: lane.name });
        }
        rows.push({
          laneId: lane.id,
          laneName: lane.name,
          issueId: issue.issueId,
          issueKey: issue.key ?? null,
        });
      }
    }
    return { byIssueId, rows };
  }

  /** Stamp `hasLane` / `laneId` / `laneName` onto a row. Mutates and returns it. */
  function applyLane(row, byIssueId) {
    const lane = byIssueId.get(row.id) ?? null;
    row.hasLane = Boolean(lane);
    row.laneId = lane?.laneId ?? null;
    row.laneName = lane?.laneName ?? null;
    return row;
  }

  /* ── Issues ──────────────────────────────────────────────────────────── */

  /** The stored row for one issue, or `null`. One `get`, never a scan. */
  async function issueRow(issueId) {
    if (!issueId) return null;
    const row = await sdk.collections.get(COLLECTION_ISSUES, `${ISSUE_KEY_CANONICAL}${issueId}`).catch(() => null);
    return row ?? null;
  }

  /**
   * Every stored issue, once each.
   *
   * Read from the canonical key space rather than the ordered ones, because
   * those hold the same issue two more times and a caller counting rows would
   * count each issue three times over.
   */
  async function issueRows() {
    const rows = await list(COLLECTION_ISSUES, { keyPrefix: ISSUE_KEY_CANONICAL, limit: MAX_ISSUES });
    return rows.map((row) => row.value).filter(Boolean);
  }

  /**
   * Find a stored row by issue id OR by identifier (`ENG-431`).
   *
   * Everything a user types names the identifier and everything Linear sends
   * names the id, so a lookup that only did one would work in the UI and fail
   * from a webhook, or the reverse.
   */
  async function findIssueRow(idOrIdentifier) {
    const direct = await issueRow(idOrIdentifier);
    if (direct) return direct;
    const wanted = String(idOrIdentifier ?? "").trim().toUpperCase();
    if (!wanted) return null;
    const rows = await list(COLLECTION_ISSUES, { keyPrefix: ISSUE_KEY_CANONICAL, limit: MAX_ISSUES });
    for (const row of rows) {
      if (String(row?.value?.identifier ?? "").toUpperCase() === wanted) return row.value;
    }
    return null;
  }

  /** Clamp the row's long text and record that it was clamped. */
  function dressRow(row) {
    const description = clampText(row.description, MAX_DESCRIPTION_CHARS);
    row.description = description.text;
    row.descriptionTruncated = description.truncated;
    return row;
  }

  /**
   * The whole issue read: Linear, then the lanes, then the rows, then the model.
   *
   * One function rather than four, because every entry point wants all of it —
   * the panel's refresh gesture, the CLI word, the automation step, the webhook
   * that just changed one issue, and the `activate` with nothing on screen.
   */
  async function refreshIssues(input = {}) {
    const filters = normalizeFilters(input.filters ?? (await readFilters()));
    let nodes;
    try {
      nodes = await api.searchAllIssues(filtersToQuery(filters), Math.min(MAX_ISSUES, input.limit ?? MAX_ISSUES));
    } catch (error) {
      model = { ...model, error: error?.message ?? String(error), updatedAt: new Date(now()).toISOString() };
      return { state: error?.code === "no_token" ? "no-token" : "error", error: model.error, filters };
    }

    const { byIssueId, rows: laneRows } = await laneIndex();
    const issues = nodes.map((node) => applyLane(dressRow(normalizeIssue(node)), byIssueId));

    const sort = SORTS[filters.sort] ?? SORTS[DEFAULT_SORT];
    const sorted = [...issues].sort(sort);

    // The grouped order is the state rank first, then the reader's sort inside
    // each state — so folding a group open shows the same order those rows
    // would have in a single list.
    const groupCounts = new Map();
    const wanted = new Map();
    sorted.forEach((row, index) => {
      const groupRank = (groupCounts.get(row.stateId) ?? 0) + 1;
      groupCounts.set(row.stateId, groupRank);
      const bound = boundIssueRow(row);
      wanted.set(`${ISSUE_KEY_CANONICAL}${row.id}`, row);
      wanted.set(flatIssueKey(index + 1, row.id), bound);
      if (row.stateId) wanted.set(groupIssueKey(row.stateId, groupRank, row.id), bound);
    });

    // One sweep per key space rather than one over the whole collection. Three
    // prefixes is three paged reads instead of one truncated one, and it is the
    // same `replacePrefix` every other collection here uses.
    for (const prefix of [ISSUE_KEY_CANONICAL, ISSUE_KEY_FLAT, ISSUE_KEY_GROUP]) {
      const scoped = new Map([...wanted].filter(([key]) => key.startsWith(prefix)));
      await replacePrefix(COLLECTION_ISSUES, prefix, scoped);
    }

    // Comments are pruned per ISSUE when a thread is re-read, and nothing
    // removed the threads of issues that left the view entirely. Sixty opened
    // issues at fifty comments each exhausts the plugin's whole row budget, and
    // after that every issue write can only make room by evicting ISSUE rows —
    // so the list quietly empties, one warn line at a time.
    await pruneComments(new Set(sorted.map((row) => row.id)));

    const facets = await writeFacets(sorted);
    await writeFilters(filters);

    model = {
      ...model,
      counts: { ...model.counts, issues: sorted.length },
      groups: buildGroups(sorted),
      filters: { ...filters, hasProjects: facets.projects > 0, hasPeople: facets.people > 0 },
      lanes: laneRows,
      error: null,
      updatedAt: new Date(now()).toISOString(),
    };
    return { state: sorted.length === 0 ? "empty" : "list", count: sorted.length, filters, issues: sorted };
  }

  /**
   * The state groups the panel draws a section for.
   *
   * Returned in the MODEL rather than written to a collection. A section is a
   * `stack` in a published schema — the builder emits one per group and binds
   * `groupKeyPrefix(stateId)` inside it — so what the panel needs is the LIST
   * of groups at schema-build time, not rows it would then have to read.
   *
   * A state with no issues in the current filter has no group and no section,
   * which is why the state preset is a round trip rather than a `where`: a
   * predicate hides rows and cannot remove a section.
   */
  function buildGroups(issues) {
    const groups = new Map();
    for (const row of issues) {
      if (!row.stateId) continue;
      const existing = groups.get(row.stateId);
      if (existing) {
        existing.count += 1;
        continue;
      }
      groups.set(row.stateId, {
        stateId: row.stateId,
        stateName: row.stateName,
        stateType: row.stateType,
        rank: row.stateRank,
        badgeTone: row.badgeTone,
        count: 1,
        // The phone folds Done and Cancelled and the desktop folds nothing.
        // The phone's is the better default on every surface: a workspace's
        // completed column is its longest and its least useful open.
        defaultOpen: row.stateType !== "completed" && row.stateType !== "canceled",
      });
    }
    return [...groups.values()].sort((a, b) => a.rank - b.rank || a.stateName.localeCompare(b.stateName));
  }

  /**
   * Project and assignee rows, derived from the issues on screen.
   *
   * Derived rather than fetched on purpose: `projects` and `users` are two more
   * round trips against a rate limit the reader can watch run down, and a filter
   * offering a project that none of the visible issues belong to is a filter
   * whose every option returns nothing. `refreshCatalog` fetches the full lists
   * for the cases that genuinely need them.
   *
   * The count comes back so `model.filters.hasProjects` / `hasPeople` can say
   * whether the bound control has anything to offer. A `segmented` whose
   * `optionsFrom` reads an empty collection draws an empty control, which reads
   * as broken rather than as absent.
   */
  async function writeFacets(issues) {
    const projects = new Map();
    const people = new Map();
    for (const row of issues) {
      if (row.projectId && !projects.has(row.projectId)) {
        projects.set(`project:${row.projectId}`, {
          id: row.projectId,
          name: row.projectName,
          title: row.projectName ?? row.projectId,
          subtitle: null,
          value: row.projectId,
          label: row.projectName ?? row.projectId,
        });
      }
      if (row.assigneeId && !people.has(row.assigneeId)) {
        people.set(`user:${row.assigneeId}`, {
          id: row.assigneeId,
          name: row.assigneeName,
          title: row.assigneeName ?? row.assigneeId,
          subtitle: null,
          value: row.assigneeId,
          label: row.assigneeName ?? row.assigneeId,
        });
      }
    }
    await replacePrefix(COLLECTION_PROJECTS, "project:", projects);
    await replacePrefix(COLLECTION_PEOPLE, "user:", people);
    return { projects: projects.size, people: people.size };
  }

  /**
   * One issue, refetched and rewritten in place.
   *
   * Used by the detail panel's refresh, by every write that changed the issue,
   * and by the webhook — all four want "this one issue is now different", and
   * none of them should cost a whole list read.
   *
   * The three key spaces are updated in place: the canonical row is rewritten
   * by id, and the two ordered rows are found by scanning for the id suffix
   * rather than recomputed, because the rank depends on the whole set and this
   * function has one issue.
   */
  async function refreshIssue(issueId, options = {}) {
    let node;
    try {
      node = await api.fetchIssueById(issueId);
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error), code: error?.code ?? null };
    }
    if (!node) return { ok: false, error: "Linear has no issue with that id.", code: "not_found" };

    const { byIssueId } = await laneIndex();
    const row = applyLane(dressRow(normalizeIssue(node)), byIssueId);

    const bound = boundIssueRow(row);
    await put(COLLECTION_ISSUES, `${ISSUE_KEY_CANONICAL}${row.id}`, row);

    const ordered = await list(COLLECTION_ISSUES, { limit: 1_500 });
    const wantedGroupPrefix = row.stateId ? `${ISSUE_KEY_GROUP}${row.stateId}:` : null;
    let inRightGroup = false;
    let wasListed = false;

    for (const stored of ordered) {
      if (stored.key.startsWith(ISSUE_KEY_CANONICAL)) continue;
      if (!stored.key.endsWith(`:${row.id}`)) continue;
      wasListed = true;
      if (stored.key.startsWith(ISSUE_KEY_GROUP)) {
        // A state change MOVES the row between groups. The old key is deleted
        // rather than rewritten — otherwise the issue draws in both sections.
        if (!wantedGroupPrefix || !stored.key.startsWith(wantedGroupPrefix)) {
          await del(COLLECTION_ISSUES, stored.key);
          continue;
        }
        inRightGroup = true;
      }
      await put(COLLECTION_ISSUES, stored.key, bound);
    }

    // The other half of that move, and the half whose absence made the issue
    // disappear from every section: an issue whose state changed has no key in
    // its NEW group until one is written. It is appended to the end of that
    // group, because the exact rank within a group depends on the whole set and
    // this function has one issue — the next full refresh puts it in place.
    if (wasListed && wantedGroupPrefix && !inRightGroup) {
      const siblings = await list(COLLECTION_ISSUES, { keyPrefix: wantedGroupPrefix, limit: 1_000 });
      await put(COLLECTION_ISSUES, groupIssueKey(row.stateId, siblings.length + 1, row.id), bound);
    }

    if (options.comments !== false) await refreshComments(row.id);
    return { ok: true, issue: row };
  }

  /* ── Comments ────────────────────────────────────────────────────────── */

  /**
   * One issue's comments.
   *
   * Kept in a collection that does NOT sync (`"comments": {"sync": false}`).
   * A comment thread is read where it is read and is worth a round trip; the
   * alternative is replicating every workspace conversation to every device
   * the user owns, against a 2 MiB budget the issue rows also live in.
   */
  async function refreshComments(issueId) {
    let nodes;
    try {
      nodes = await api.fetchIssueComments(issueId);
    } catch (error) {
      log("warn", `Could not read comments for ${issueId}: ${error?.message ?? error}`);
      return { ok: false, error: error?.message ?? String(error) };
    }
    const wanted = new Map();
    nodes.slice(0, MAX_COMMENTS_PER_ISSUE).forEach((node, index) => {
      const comment = normalizeComment(issueId, node);
      comment.rank = index + 1;
      // Dressed for the same reason the issue rows are, and merged over rather
      // than replacing: `buildIssuePanel` reads the raw `body` for its markdown
      // node while the bound list reads the eleven names the dresser makes.
      wanted.set(commentKey(issueId, index + 1, comment.id), { ...comment, ...commentListRow(comment) });
    });
    await replacePrefix(COLLECTION_COMMENTS, commentKeyPrefix(issueId), wanted);
    return { ok: true, count: wanted.size };
  }

  /**
   * Drop the comment threads of issues no longer in the reader's view.
   *
   * Keyed on the issue id, which is the first segment of every comment key
   * (`comment:<issueId>:<rank>:<id>`), so one list over the collection is
   * enough to decide the whole sweep.
   */
  async function pruneComments(liveIssueIds) {
    const rows = await list(COLLECTION_COMMENTS, { limit: LIST_PAGE_SIZE });
    for (const row of rows) {
      const issueId = String(row.key).split(":")[1] ?? "";
      if (!issueId || liveIssueIds.has(issueId)) continue;
      await del(COLLECTION_COMMENTS, row.key);
    }
  }

  /* ── Teams, states and the connection ────────────────────────────────── */

  /**
   * Teams and their workflow states, in one round trip.
   *
   * Both are near-static and both are needed before a reader can move an issue,
   * so they are fetched together and stored together rather than lazily: a
   * state picker that has to fetch before it can open is a picker that is empty
   * for the first second every time.
   */
  async function refreshCatalog(teamKey = null) {
    let teams;
    try {
      teams = await api.listTeamsAndStates(teamKey);
    } catch (error) {
      log("warn", `Could not read the Linear teams: ${error?.message ?? error}`);
      return { ok: false, error: error?.message ?? String(error) };
    }
    // A ONE-TEAM read may only replace that one team's rows.
    //
    // `listTeamsAndStates(teamKey)` filters to a single team, and the sweep
    // below replaces a whole prefix — so a filtered read used to delete every
    // OTHER team's states, and a key Linear does not have (an agent calling
    // `list_states({teamKey: "NOPE"})`) answered with an empty list and wiped
    // the catalog outright. With no states stored, `pickCompletedStateId` and
    // `pickStartedStateId` return null and the merge and launch transitions
    // stop silently until the next unfiltered read on activate.
    const scoped = teamKey !== null;
    const teamRows = new Map();
    const stateRows = new Map();
    for (const team of teams) {
      const row = normalizeTeam(team);
      teamRows.set(`team:${row.id}`, row);
      const states = Array.isArray(team?.states?.nodes) ? team.states.nodes : [];
      const ordered = [...states].map((node) => normalizeState(row.id, row.key, node))
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
      ordered.forEach((state, index) => {
        state.value = state.id;
        state.label = state.name;
        stateRows.set(`${statesKeyPrefix(row.key)}${rankSegment(index + 1)}:${state.id}`, state);
      });
    }
    if (scoped) {
      // Write what arrived and sweep only the states of the teams that arrived.
      // Nothing is deleted for a team this read never asked about, and a key
      // that matched no team deletes nothing at all.
      for (const [key, value] of teamRows) await put(COLLECTION_TEAMS, key, value);
      for (const team of teamRows.values()) {
        const prefix = statesKeyPrefix(team.key);
        const mine = new Map([...stateRows].filter(([key]) => key.startsWith(prefix)));
        await replacePrefix(COLLECTION_STATES, prefix, mine);
      }
      // The stored count is the whole catalog's, which a one-team read has not
      // seen — so it is left alone rather than set to 1.
      return { ok: true, teams: teamRows.size, states: stateRows.size, scoped: true };
    }

    await replacePrefix(COLLECTION_TEAMS, "team:", teamRows);
    await replacePrefix(COLLECTION_STATES, "team:", stateRows);
    // Only on the UNFILTERED read, for the reason the sweep above is scoped:
    // labels are a workspace-wide list, and a one-team read has not seen them.
    // Awaited but never fatal — the teams and states are the half a reader is
    // blocked without.
    await refreshLabels().catch(() => {});
    model = { ...model, counts: { ...model.counts, teams: teamRows.size } };
    return { ok: true, teams: teamRows.size, states: stateRows.size, scoped: false };
  }

  /**
   * The workspace's issue labels, stored for the Automations label filter.
   *
   * Read with the catalog rather than lazily, and swept the same way: a filter
   * whose options arrive a round trip after the picker opens is a picker that
   * is empty every first time it is used. Sorted by name so the stored order is
   * the order a picker draws, because `collections.list` orders by KEY and
   * nothing else.
   *
   * A refusal leaves the stored rows alone. Labels change rarely and a
   * rate-limited read is not evidence that the workspace has none — wiping them
   * would empty a filter the reader had already set.
   */
  async function refreshLabels() {
    let nodes;
    try {
      nodes = await api.listLabels(null);
    } catch (error) {
      log("warn", `Could not read the Linear labels: ${error?.message ?? error}`);
      return { ok: false, error: error?.message ?? String(error) };
    }
    const rows = new Map();
    const ordered = (Array.isArray(nodes) ? nodes : [])
      .filter((node) => node && typeof node.id === "string" && typeof node.name === "string")
      .sort((a, b) => a.name.localeCompare(b.name));
    ordered.forEach((node, index) => {
      const row = {
        id: node.id,
        name: node.name,
        // `value` and `label` are the two field names every bound picker reads,
        // here for the same reason `refreshCatalog` stamps them onto a state.
        value: node.name,
        label: node.name,
        title: node.name,
        color: typeof node.color === "string" ? node.color : null,
        teamKey: typeof node?.team?.key === "string" ? node.team.key : null,
      };
      rows.set(`label:${rankSegment(index + 1)}:${node.id}`, row);
    });
    await replacePrefix(COLLECTION_LABELS, "label:", rows);
    return { ok: true, labels: rows.size };
  }

  /** Every stored label. */
  async function labels() {
    const rows = await list(COLLECTION_LABELS, { keyPrefix: "label:", limit: 500 });
    return rows.map((row) => row.value).filter(Boolean);
  }

  /** Every stored workflow state, optionally for one team. */
  async function states(teamKeyFilter = null) {
    const prefix = teamKeyFilter ? statesKeyPrefix(teamKeyFilter) : "team:";
    const rows = await list(COLLECTION_STATES, { keyPrefix: prefix, limit: 500 });
    return rows.map((row) => row.value).filter(Boolean);
  }

  /** Every stored team. */
  async function teams() {
    const rows = await list(COLLECTION_TEAMS, { keyPrefix: "team:", limit: 200 });
    return rows.map((row) => row.value).filter(Boolean);
  }

  /**
   * Who this credential is, written as the one row every connection view binds.
   *
   * Never carries a token, an expiry the token could be derived from, or a
   * refresh token — only the boolean `refreshTokenStored`. A `viewer` row syncs
   * to every device the user owns, and a synced credential is a credential
   * outside the machine keychain that holds it.
   */
  async function refreshConnection() {
    const credential = await api.readCredential().catch(() => ({ token: null, authMode: null }));
    const base = {
      connected: false,
      authMode: credential.authMode ?? null,
      viewerId: null,
      viewerName: null,
      organizationId: null,
      organizationName: null,
      organizationUrlKey: null,
      organizationLogoUrl: null,
      tokenExpiresAt: credential.expiresAt ?? null,
      refreshTokenStored: Boolean(credential.refreshToken),
      webhookUrl: null,
      lastError: null,
      lastSyncAt: new Date(now()).toISOString(),
      issueCount: model.counts.issues,
    };

    try {
      base.webhookUrl = await sdk.webhooks.url("linear");
    } catch {
      // A host with no ingress drain draws the panel without the paste box.
      base.webhookUrl = null;
    }

    if (!credential.token) {
      model = { ...model, connection: base, updatedAt: base.lastSyncAt };
      await put(COLLECTION_VIEWER, VIEWER_KEY_CONNECTION, base);
      return base;
    }

    try {
      const identity = await api.getConnectionIdentity();
      Object.assign(base, identity, { connected: true });
    } catch (error) {
      base.lastError = error?.message ?? String(error);
      // `unauthorized` is the one failure that means the stored credential is
      // no longer a credential. Everything else — a timeout, a 500, a rate
      // limit — leaves the connection intact and is reported beside it.
      base.connected = error?.code !== "unauthorized" && error?.code !== "no_token";
    }

    model = { ...model, connection: base, updatedAt: base.lastSyncAt };
    await put(COLLECTION_VIEWER, VIEWER_KEY_CONNECTION, base);
    return base;
  }

  /** The connection row as last written, without a round trip. */
  async function connection() {
    return (await sdk.collections.get(COLLECTION_VIEWER, VIEWER_KEY_CONNECTION).catch(() => null)) ?? model.connection;
  }

  /* ── Filters ─────────────────────────────────────────────────────────── */

  /**
   * The reader's filter set, in a synced row.
   *
   * The built-in keeps this in `localStorage` per project root
   * (`LinearIssueBrowser.tsx:78`), which means the phone never sees what the
   * desktop chose. A synced collection row is the same persistence with the
   * property the built-in could not have.
   */
  async function readFilters() {
    const raw = await sdk.collections.get(COLLECTION_VIEWER, VIEWER_KEY_FILTERS).catch(() => null);
    return normalizeFilters(raw);
  }

  async function writeFilters(filters) {
    await put(COLLECTION_VIEWER, VIEWER_KEY_FILTERS, normalizeFilters(filters));
  }

  /** Merge a partial change into the stored filters and answer the result. */
  async function updateFilters(patch) {
    const next = normalizeFilters({ ...(await readFilters()), ...(patch ?? {}) });
    await writeFilters(next);
    return next;
  }

  /* ── Autolinks ───────────────────────────────────────────────────────── */

  /**
   * The GitHub autolinks the settings panel offers to create.
   *
   * One per team, because an autolink is `<TEAMKEY>-<number>` →
   * `https://linear.app/<org>/issue/<TEAMKEY>-<number>`. Built into the MODEL
   * rather than into a collection: there are as many as the workspace has teams
   * (a handful), the settings panel draws them as literal rows in a schema it
   * publishes anyway, and a collection nothing else reads would spend a
   * declaration and a sync channel on a list of six strings.
   *
   * This function only SHAPES them; creating one is a `github` action and lives
   * in `flows.js`.
   */
  async function buildAutolinks(urlKey) {
    const rows = [];
    for (const team of await teams()) {
      if (!team?.key) continue;
      rows.push({
        id: team.key,
        teamKey: team.key,
        teamName: team.name,
        keyPrefix: `${team.key}-`,
        urlTemplate: urlKey ? `https://linear.app/${urlKey}/issue/${team.key}-<num>` : null,
        title: `${team.key}-<num>`,
        subtitle: team.name,
      });
    }
    model = { ...model, autolinks: rows };
    return rows;
  }

  /* ── The model ───────────────────────────────────────────────────────── */

  /**
   * Everything the panel builders need that is not a collection row.
   *
   * A plain snapshot, rebuilt by the refreshes above. The builders read it
   * synchronously so that drawing a panel is never itself a round trip.
   */
  function currentModel() {
    return {
      connection: model.connection,
      counts: { ...model.counts },
      filters: model.filters ?? { ...defaultFilters(), hasProjects: false, hasPeople: false },
      groups: [...(model.groups ?? [])],
      autolinks: [...(model.autolinks ?? [])],
      lanes: [...model.lanes],
      models: [...model.models],
      error: model.error,
      updatedAt: model.updatedAt,
    };
  }

  /** Record the chat models this project offers, for the launch form's picker. */
  function setModels(models) {
    model = { ...model, models: Array.isArray(models) ? models : [] };
  }

  return {
    COLLECTION_COMMENTS,
    COLLECTION_TEAMS,
    COLLECTION_VIEWER,
    ISSUE_KEY_CANONICAL,
    VIEWER_KEY_CONNECTION,
    VIEWER_KEY_FILTERS,
    boundIssueRow,
    buildGroups,
    connection,
    currentModel,
    defaultFilters,
    findIssueRow,
    issueRef: issueRefFromRow,
    issueRow,
    labels,
    issueRows,
    laneIndex,
    normalizeFilters,
    readFilters,
    refreshCatalog,
    refreshComments,
    refreshConnection,
    refreshIssue,
    refreshLabels,
    refreshIssues,
    setModels,
    states,
    teams,
    updateFilters,
    buildAutolinks,
    writeFilters,
  };
}

module.exports = {
  DEFAULT_SORT,
  MAX_COMMENTS_PER_ISSUE,
  MAX_DESCRIPTION_CHARS,
  MAX_ISSUES,
  SORTS,
  STATE_PRESETS,
  createData,
  defaultFilters,
  dueOrder,
  filtersToQuery,
  normalizeFilters,
  priorityOrder,
};
