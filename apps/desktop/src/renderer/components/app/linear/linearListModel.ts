import type {
  CtoLinearProject,
  LinearCatalogLabel,
  LinearCatalogState,
  LinearCatalogUser,
  LinearDisplayPreferences,
  LinearIssueGrouping,
  LinearIssueOrdering,
  LinearIssueRef,
} from "../../../../shared/types";
import { isClosedLinearStateType, LINEAR_LIST_CHILDREN_PAGE_SIZE, LINEAR_STATE_TYPE_ORDER } from "../../../../shared/linearIssueNormalize";
import type { LinearIssuePrefill } from "../../../lib/issueCreateRequests";
import { isNormalizedIssue, issueLabelEntries, PRIORITY_CHOICES, type BrowserIssue } from "../linearIssueBrowserModel";

/**
 * The issue list's shape, in one pure pass: loaded issues + display
 * preferences + the workspace catalog -> the rows the virtual list draws.
 *
 * Groups (and an optional sub-group) follow Linear's order, issues are ordered
 * inside each group, and sub-issues nest under a parent that sits in the same
 * group. A sub-issue whose parent is not in its group (another page, another
 * group, or filtered out) hangs under a muted "context" row for that parent,
 * the way Linear shows it. Everything here is cheap and allocation-light so
 * 2,000 issues group in a few milliseconds.
 */

export type LinearListPreferences = Pick<
  LinearDisplayPreferences,
  "grouping" | "subGrouping" | "ordering" | "orderingDirection" | "nesting" | "showEmptyGroups" | "showCompletedIssues" | "hiddenGroups"
>;

export type LinearListCatalog = {
  states: LinearCatalogState[];
  users: LinearCatalogUser[];
  projects: CtoLinearProject[];
  labels: LinearCatalogLabel[];
  teams: Array<{ id: string; key: string; name: string; color?: string | null }>;
  cycles?: Array<{ id: string; number: number; name: string | null; startsAt: string; teamKey: string }>;
  viewerId: string | null;
};

export type LinearGroupIcon =
  | { kind: "state"; stateType: string }
  | { kind: "priority"; priority: number }
  | { kind: "user"; name: string; avatarUrl: string | null }
  | { kind: "no-user" }
  | { kind: "project"; icon: string | null; color: string | null; name: string }
  | { kind: "label"; color: string | null }
  | { kind: "cycle" }
  | { kind: "milestone" }
  | { kind: "team"; key: string; color: string | null }
  | { kind: "none" };

export type LinearListGroup = {
  key: string;
  grouping: LinearIssueGrouping;
  label: string;
  icon: LinearGroupIcon;
  /** Linear ids this group stands for (state ids of every merged team, a user id, ...). */
  ids: string[];
  prefill: LinearIssuePrefill;
  /** Sort rank: primary number, then text. */
  rank: number;
  rankText: string;
};

export type LinearListGroupRow = {
  kind: "group";
  key: string;
  /** `group` or `group/subgroup`; the collapse key is `g:<path>`. */
  path: string;
  depth: 0 | 1;
  group: LinearListGroup;
  count: number;
  collapsed: boolean;
};

export type LinearListIssueRow = {
  kind: "issue";
  key: string;
  issue: BrowserIssue;
  groupPath: string;
  /** 0 = top level; children of a parent (or a context row) are 1+. */
  depth: number;
  /** For each ancestor level 1..depth-1: does that level's line continue below this row? */
  guides: boolean[];
  /** Last child among its siblings (the tree line ends at this row). */
  last: boolean;
  /** Loaded children nested under this row in this group. */
  childCount: number;
  childrenCollapsed: boolean;
  /** Flat lists only: the parent, shown as a muted hint before the title. */
  parentHint: LinearIssueRef | null;
};

export type LinearListContextRow = {
  kind: "context";
  key: string;
  groupPath: string;
  ref: { id: string; identifier: string; title: string; stateType: string };
  childCount: number;
  childrenCollapsed: boolean;
};

export type LinearListRow = LinearListGroupRow | LinearListIssueRow | LinearListContextRow;

export type LinearListModel = {
  rows: LinearListRow[];
  /** Top-level groups in order, with how many issues each holds. */
  groups: Array<{ group: LinearListGroup; count: number }>;
  /** Row indices of top-level group headers (sticky headers). */
  headerIndices: number[];
  /** Row indices of issue rows, top to bottom (keyboard order). */
  navigable: number[];
  /** Longest identifier, in characters, so the id column lines up. */
  identifierChars: number;
  /** Issues in the shown groups (after the completed filter and hidden groups), once each, in load order. Folded groups count. */
  issueIds: string[];
  /** `issueIds.length`. */
  issueCount: number;
};

export type LinearListInput = {
  issues: BrowserIssue[];
  prefs: LinearListPreferences;
  catalog: LinearListCatalog;
  /** Collapse keys: `g:<groupPath>` for groups, `p:<issueId>` for a parent's children. */
  collapsed: ReadonlySet<string>;
  /** State types the current tab lists; empty groups only for these. Null = all. */
  allowedStateTypes?: readonly string[] | null;
  /** Teams in scope, for empty status/label groups. Null = every team. */
  teamKeys?: readonly string[] | null;
};

/**
 * Closed issues show when Display asks for them, or when the tab asks only for
 * closed types (the search keeps those types on purpose; see applyCompletedFilter).
 */
function showsClosedIssues(input: Pick<LinearListInput, "prefs" | "allowedStateTypes">): boolean {
  if (input.prefs.showCompletedIssues) return true;
  const allowed = input.allowedStateTypes;
  return Boolean(allowed && allowed.length > 0 && allowed.every((type) => isClosedLinearStateType(type)));
}

const STATE_TYPE_RANK: ReadonlyMap<string, number> = new Map(LINEAR_STATE_TYPE_ORDER.map((type, index) => [type, index]));
/** Priority groups in Linear's order: Urgent first, "No priority" last. */
export const LINEAR_PRIORITY_GROUP_ORDER: ReadonlyArray<{ value: number; label: string }> = [
  ...PRIORITY_CHOICES.filter((choice) => choice.value > 0),
  ...PRIORITY_CHOICES.filter((choice) => choice.value === 0),
];
// Above any real rank (cycle groups rank by start time in ms), so "No …" groups sort last.
const NONE_RANK = 9e15;
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function stateTypeRank(stateType: string): number {
  return STATE_TYPE_RANK.get(stateType) ?? LINEAR_STATE_TYPE_ORDER.length;
}

/**
 * Done + canceled over all sub-issues. Linear's list read stops at
 * `LINEAR_LIST_CHILDREN_PAGE_SIZE` children, so a full page is "capped": more may exist.
 */
export function subIssueProgress(issue: BrowserIssue): { done: number; total: number; capped: boolean } | null {
  if (!isNormalizedIssue(issue)) return null;
  const children = issue.childIssues;
  if (!children || children.length === 0) return null;
  let done = 0;
  for (const child of children) if (isClosedLinearStateType(child.stateType)) done += 1;
  return { done, total: children.length, capped: children.length >= LINEAR_LIST_CHILDREN_PAGE_SIZE };
}

/* ------------------------------------------------------------------ */
/* Group keys                                                          */
/* ------------------------------------------------------------------ */

type Ctx = {
  stateOrder: Map<string, number>;
  usersById: Map<string, LinearCatalogUser>;
  projectsById: Map<string, CtoLinearProject>;
  labels: LinearCatalogLabel[];
  labelsById: Map<string, LinearCatalogLabel>;
  teamsByKey: Map<string, { id: string; key: string; name: string; color?: string | null }>;
  cyclesById: Map<string, { id: string; number: number; name: string | null; startsAt: string }>;
  viewerId: string | null;
};

function buildCtx(catalog: LinearListCatalog): Ctx {
  const stateOrder = new Map<string, number>();
  // Within one type Linear lists later workflow steps first (In Review above
  // In Progress). Without `position` the catalog's own order stands in.
  catalog.states.forEach((state, index) => {
    const position = typeof state.position === "number" ? state.position : index;
    stateOrder.set(state.id, position);
  });
  return {
    stateOrder,
    usersById: new Map(catalog.users.map((user) => [user.id, user])),
    projectsById: new Map(catalog.projects.map((project) => [project.id, project])),
    labels: catalog.labels,
    labelsById: new Map(catalog.labels.map((label) => [label.id, label])),
    teamsByKey: new Map(catalog.teams.map((team) => [team.key, team])),
    cyclesById: new Map((catalog.cycles ?? []).map((cycle) => [cycle.id, cycle])),
    viewerId: catalog.viewerId,
  };
}

function stateGroup(stateType: string, stateName: string, stateId: string | null, teamKey: string | null, ctx: Ctx): LinearListGroup {
  // Cross-team lists merge states that share a name and type (Linear's own
  // "My issues" does the same), so "In Progress" is one group, not one per team.
  const name = stateName.trim() || "No status";
  const position = stateId ? ctx.stateOrder.get(stateId) ?? 0 : 0;
  const reverse = stateType === "started" || stateType === "unstarted" || stateType === "triage";
  return {
    key: `state:${stateType}:${name.toLowerCase()}`,
    grouping: "workflowState",
    label: name,
    icon: { kind: "state", stateType },
    ids: stateId ? [stateId] : [],
    prefill: { stateId, teamKey },
    rank: stateTypeRank(stateType) * 1e6 + (reverse ? -position : position),
    rankText: name,
  };
}

function priorityGroup(priority: number): LinearListGroup {
  const index = LINEAR_PRIORITY_GROUP_ORDER.findIndex((entry) => entry.value === priority);
  const entry = LINEAR_PRIORITY_GROUP_ORDER[index] ?? LINEAR_PRIORITY_GROUP_ORDER[LINEAR_PRIORITY_GROUP_ORDER.length - 1]!;
  return {
    key: `priority:${entry.value}`,
    grouping: "priority",
    label: entry.label,
    icon: { kind: "priority", priority: entry.value },
    ids: [String(entry.value)],
    prefill: { priority: entry.value },
    rank: index < 0 ? LINEAR_PRIORITY_GROUP_ORDER.length : index,
    rankText: "",
  };
}

function assigneeGroup(id: string | null, name: string | null, avatarUrl: string | null, ctx: Ctx): LinearListGroup {
  if (!id) {
    return {
      key: "assignee:none",
      grouping: "assignee",
      label: "No assignee",
      icon: { kind: "no-user" },
      ids: [],
      prefill: { assigneeId: null },
      rank: NONE_RANK,
      rankText: "",
    };
  }
  const user = ctx.usersById.get(id);
  const label = user?.displayName || user?.name || name || "Unknown";
  return {
    key: `assignee:${id}`,
    grouping: "assignee",
    label,
    icon: { kind: "user", name: label, avatarUrl: user?.avatarUrl ?? avatarUrl ?? null },
    ids: [id],
    prefill: { assigneeId: id },
    rank: id === ctx.viewerId ? 0 : 1,
    rankText: label,
  };
}

function projectGroup(id: string | null, name: string | null, ctx: Ctx): LinearListGroup {
  if (!id) {
    return {
      key: "project:none",
      grouping: "project",
      label: "No project",
      icon: { kind: "none" },
      ids: [],
      prefill: { projectId: null },
      rank: NONE_RANK,
      rankText: "",
    };
  }
  const project = ctx.projectsById.get(id);
  const label = project?.name || name || "Project";
  return {
    key: `project:${id}`,
    grouping: "project",
    label,
    icon: { kind: "project", icon: project?.icon ?? null, color: project?.color ?? null, name: label },
    ids: [id],
    prefill: { projectId: id },
    rank: 0,
    rankText: label,
  };
}

function labelGroup(id: string | null, name: string | null, color: string | null): LinearListGroup {
  if (!name) {
    return {
      key: "label:none",
      grouping: "label",
      label: "No label",
      icon: { kind: "none" },
      ids: [],
      prefill: {},
      rank: NONE_RANK,
      rankText: "",
    };
  }
  return {
    key: `label:${id ?? name.trim().toLowerCase()}`,
    grouping: "label",
    label: name,
    icon: { kind: "label", color },
    ids: id ? [id] : [],
    prefill: id ? { labelIds: [id] } : {},
    rank: 0,
    rankText: name,
  };
}

function cycleGroup(id: string | null, name: string | null, startsAt: string | null, ctx: Ctx): LinearListGroup {
  if (!id) {
    return {
      key: "cycle:none",
      grouping: "cycle",
      label: "No cycle",
      icon: { kind: "none" },
      ids: [],
      prefill: { cycleId: null },
      rank: NONE_RANK,
      rankText: "",
    };
  }
  const known = ctx.cyclesById.get(id);
  const label = name || known?.name || (known ? `Cycle ${known.number}` : "Cycle");
  const start = Date.parse(startsAt ?? known?.startsAt ?? "");
  return {
    key: `cycle:${id}`,
    grouping: "cycle",
    label,
    icon: { kind: "cycle" },
    ids: [id],
    prefill: { cycleId: id },
    rank: Number.isFinite(start) ? start : NONE_RANK - 1,
    rankText: label,
  };
}

function milestoneGroup(id: string | null, name: string | null, projectId: string | null): LinearListGroup {
  if (!id) {
    return {
      key: "milestone:none",
      grouping: "projectMilestone",
      label: "No milestone",
      icon: { kind: "none" },
      ids: [],
      prefill: {},
      rank: NONE_RANK,
      rankText: "",
    };
  }
  return {
    key: `milestone:${id}`,
    grouping: "projectMilestone",
    label: name || "Milestone",
    icon: { kind: "milestone" },
    ids: [id],
    prefill: { milestoneId: id, projectId },
    rank: 0,
    rankText: name ?? "",
  };
}

function teamGroup(key: string, name: string | null, ctx: Ctx): LinearListGroup {
  const team = ctx.teamsByKey.get(key);
  const label = team?.name || name || key || "No team";
  return {
    key: `team:${key}`,
    grouping: "team",
    label,
    icon: { kind: "team", key, color: team?.color ?? null },
    ids: team ? [team.id] : [],
    prefill: { teamKey: key },
    rank: 0,
    rankText: key,
  };
}

const ALL_GROUP: LinearListGroup = {
  key: "all",
  grouping: "none",
  label: "All issues",
  icon: { kind: "none" },
  ids: [],
  prefill: {},
  rank: 0,
  rankText: "",
};

/** Every group an issue belongs to (several for labels). */
function groupsForIssue(issue: BrowserIssue, grouping: LinearIssueGrouping, ctx: Ctx): LinearListGroup[] {
  const normalized = isNormalizedIssue(issue) ? issue : null;
  switch (grouping) {
    case "workflowState":
      return [stateGroup(issue.stateType, issue.stateName, issue.stateId || null, issue.teamKey || null, ctx)];
    case "priority":
      return [priorityGroup(issue.priority)];
    case "assignee":
      return [assigneeGroup(issue.assigneeId, issue.assigneeName, normalized?.assigneeAvatarUrl ?? null, ctx)];
    case "project":
      return [projectGroup(issue.projectId || null, issue.projectName ?? null, ctx)];
    case "label": {
      const labels = issueLabelEntries(issue, ctx.labels);
      if (labels.length === 0) return [labelGroup(null, null, null)];
      // The catalog spells the name the way Linear shows it (a lane copy keeps it lowercase).
      return labels.map((label) => labelGroup(label.id, (label.id ? ctx.labelsById.get(label.id)?.name : null) ?? label.name, label.color));
    }
    case "cycle":
      return [cycleGroup(normalized?.cycleId ?? null, normalized?.cycleName ?? null, normalized?.cycleStartsAt ?? null, ctx)];
    case "projectMilestone":
      return [milestoneGroup(normalized?.projectMilestoneId ?? null, normalized?.projectMilestoneName ?? null, issue.projectId || null)];
    case "team":
      return [teamGroup(issue.teamKey, issue.teamName ?? null, ctx)];
    default:
      return [ALL_GROUP];
  }
}

function emptyGroupsFor(
  grouping: LinearIssueGrouping,
  input: LinearListInput,
  ctx: Ctx,
): LinearListGroup[] {
  const teamFilter = input.teamKeys && input.teamKeys.length > 0 ? new Set(input.teamKeys) : null;
  const allowedTypes = input.allowedStateTypes && input.allowedStateTypes.length > 0 ? new Set(input.allowedStateTypes) : null;
  const { catalog } = input;
  const showClosed = showsClosedIssues(input);
  switch (grouping) {
    case "workflowState":
      return catalog.states
        .filter((state) => (!teamFilter || teamFilter.has(state.teamKey))
          && (!allowedTypes || allowedTypes.has(state.type))
          && (showClosed || !isClosedLinearStateType(state.type)))
        .map((state) => stateGroup(state.type, state.name, state.id, state.teamKey, ctx));
    case "priority":
      return LINEAR_PRIORITY_GROUP_ORDER.map((entry) => priorityGroup(entry.value));
    case "assignee":
      return [
        ...catalog.users.filter((user) => user.active).map((user) => assigneeGroup(user.id, user.displayName ?? user.name, user.avatarUrl ?? null, ctx)),
        assigneeGroup(null, null, null, ctx),
      ];
    case "project":
      return [
        ...catalog.projects
          .filter((project) => !teamFilter || !project.teamKey || teamFilter.has(project.teamKey))
          .map((project) => projectGroup(project.id, project.name, ctx)),
        projectGroup(null, null, ctx),
      ];
    case "label":
      return [
        ...catalog.labels
          .filter((label) => !teamFilter || !label.teamKey || teamFilter.has(label.teamKey))
          .map((label) => labelGroup(label.id, label.name, label.color)),
        labelGroup(null, null, null),
      ];
    case "cycle":
      return [
        ...(catalog.cycles ?? [])
          .filter((cycle) => !teamFilter || teamFilter.has(cycle.teamKey))
          .map((cycle) => cycleGroup(cycle.id, cycle.name, cycle.startsAt, ctx)),
        cycleGroup(null, null, null, ctx),
      ];
    case "team":
      return catalog.teams
        .filter((team) => !teamFilter || teamFilter.has(team.key))
        .map((team) => teamGroup(team.key, team.name, ctx));
    default:
      return [];
  }
}

function compareGroups(left: LinearListGroup, right: LinearListGroup): number {
  return left.rank - right.rank || collator.compare(left.rankText, right.rankText);
}

/**
 * Hidden groups are Linear's ids for the grouping (a workflow state id, a
 * user id, "0".."4" for priority, ...); "No X" groups have no id and match on
 * their ADE key (`assignee:none`). Checked per issue before merging, so hiding
 * one team's "In Progress" leaves another team's issues in the merged group.
 */
function isHidden(group: LinearListGroup, hidden: ReadonlySet<string>): boolean {
  if (hidden.size === 0) return false;
  if (group.ids.length === 0) return hidden.has(group.key);
  for (const id of group.ids) if (hidden.has(id)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Ordering                                                            */
/* ------------------------------------------------------------------ */

type SortKeys = {
  sortOrder: number;
  subSortOrder: number;
  priority: number;
  updatedAt: number;
  createdAt: number;
  dueDate: number;
  estimate: number;
  number: number;
};

function timestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function issueNumber(issue: BrowserIssue): number {
  if (isNormalizedIssue(issue) && typeof issue.number === "number") return issue.number;
  const match = /-(\d+)$/.exec(issue.identifier);
  return match ? Number(match[1]) : 0;
}

function sortKeysFor(issue: BrowserIssue): SortKeys {
  const normalized = isNormalizedIssue(issue) ? issue : null;
  return {
    sortOrder: typeof normalized?.sortOrder === "number" ? normalized.sortOrder : Number.NaN,
    subSortOrder: typeof normalized?.subIssueSortOrder === "number" ? normalized.subIssueSortOrder : Number.NaN,
    // Higher = more important: Urgent 4 ... Low 1, none 0.
    priority: issue.priority > 0 ? 5 - issue.priority : 0,
    updatedAt: timestamp(issue.updatedAt),
    createdAt: timestamp(issue.createdAt),
    dueDate: timestamp(issue.dueDate ?? null),
    estimate: typeof issue.estimate === "number" ? issue.estimate : Number.NaN,
    number: issueNumber(issue),
  };
}

/** Numbers with "missing" (NaN) always last, whatever the direction. */
function compareNumbers(left: number, right: number, sign: number): number {
  const leftMissing = Number.isNaN(left);
  const rightMissing = Number.isNaN(right);
  if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
  return (left - right) * sign;
}

type Comparator = (left: BrowserIssue, right: BrowserIssue) => number;

function makeComparator(
  ordering: LinearIssueOrdering,
  direction: "asc" | "desc",
  keys: Map<BrowserIssue, SortKeys>,
  children: boolean,
): Comparator {
  const sign = direction === "asc" ? 1 : -1;
  const keyOf = (issue: BrowserIssue): SortKeys => {
    let entry = keys.get(issue);
    if (!entry) {
      entry = sortKeysFor(issue);
      keys.set(issue, entry);
    }
    return entry;
  };
  const tieBreak = (a: SortKeys, b: SortKeys, left: BrowserIssue, right: BrowserIssue) =>
    compareNumbers(a.createdAt, b.createdAt, -1)
    || collator.compare(left.teamKey, right.teamKey)
    || b.number - a.number;
  return (left, right) => {
    const a = keyOf(left);
    const b = keyOf(right);
    let result = 0;
    switch (ordering) {
      case "priority":
        result = (a.priority - b.priority) * sign || compareNumbers(a.sortOrder, b.sortOrder, 1);
        break;
      case "updatedAt":
        result = compareNumbers(a.updatedAt, b.updatedAt, sign);
        break;
      case "createdAt":
        result = compareNumbers(a.createdAt, b.createdAt, sign);
        break;
      case "dueDate":
        result = compareNumbers(a.dueDate, b.dueDate, sign);
        break;
      case "estimate":
        result = compareNumbers(a.estimate, b.estimate, sign);
        break;
      case "title":
        result = collator.compare(left.title, right.title) * sign;
        break;
      default:
        // Manual: Linear's own drag order. Sub-issues keep their order under the parent.
        result = children
          ? compareNumbers(a.subSortOrder, b.subSortOrder, 1) || compareNumbers(a.sortOrder, b.sortOrder, 1)
          : compareNumbers(a.sortOrder, b.sortOrder, 1);
    }
    return result || tieBreak(a, b, left, right);
  };
}

/* ------------------------------------------------------------------ */
/* Nesting                                                             */
/* ------------------------------------------------------------------ */

function parentIdOf(issue: BrowserIssue): string | null {
  return isNormalizedIssue(issue) ? issue.parentIssue?.id ?? null : null;
}

type Bucket = { group: LinearListGroup; issues: BrowserIssue[] };

type EmitState = {
  rows: LinearListRow[];
  navigable: number[];
  collapsed: ReadonlySet<string>;
  nested: boolean;
  compareRoots: Comparator;
  compareChildren: Comparator;
  loadedById: Map<string, BrowserIssue>;
};

/**
 * Rows for one group's issues: roots in order, each followed by its nested
 * children. A parent walk that loops (bad data) is cut, and the issue in the
 * loop shows at the top level instead.
 */
function emitBucketIssues(issues: BrowserIssue[], groupPath: string, state: EmitState): void {
  const { rows, navigable, collapsed } = state;
  if (!state.nested) {
    const sorted = issues.slice().sort(state.compareRoots);
    for (const issue of sorted) {
      navigable.push(rows.length);
      rows.push({
        kind: "issue",
        key: `${groupPath}/${issue.id}`,
        issue,
        groupPath,
        depth: 0,
        guides: [],
        last: true,
        childCount: 0,
        childrenCollapsed: false,
        parentHint: isNormalizedIssue(issue) ? issue.parentIssue ?? null : null,
      });
    }
    return;
  }

  const inBucket = new Map<string, BrowserIssue>();
  for (const issue of issues) inBucket.set(issue.id, issue);
  const childrenOf = new Map<string, BrowserIssue[]>();
  const roots: BrowserIssue[] = [];
  const contexts = new Map<string, { ref: LinearListContextRow["ref"]; issues: BrowserIssue[] }>();

  const loopsBack = (issue: BrowserIssue): boolean => {
    let cursor = parentIdOf(issue);
    let steps = 0;
    while (cursor && steps <= inBucket.size) {
      if (cursor === issue.id) return true;
      const next = inBucket.get(cursor);
      if (!next) return false;
      cursor = parentIdOf(next);
      steps += 1;
    }
    return steps > inBucket.size;
  };

  for (const issue of issues) {
    const parentId = parentIdOf(issue);
    if (parentId && parentId !== issue.id && inBucket.has(parentId) && !loopsBack(issue)) {
      const list = childrenOf.get(parentId);
      if (list) list.push(issue);
      else childrenOf.set(parentId, [issue]);
      continue;
    }
    const parentRef = isNormalizedIssue(issue) ? issue.parentIssue ?? null : null;
    if (parentRef && parentRef.id !== issue.id && !inBucket.has(parentRef.id)) {
      // The parent is elsewhere (another group, another page, filtered out).
      const loaded = state.loadedById.get(parentRef.id);
      const block = contexts.get(parentRef.id);
      if (block) block.issues.push(issue);
      else {
        contexts.set(parentRef.id, {
          ref: {
            id: parentRef.id,
            identifier: loaded?.identifier ?? parentRef.identifier,
            title: loaded?.title ?? parentRef.title,
            stateType: loaded?.stateType ?? parentRef.stateType,
          },
          issues: [issue],
        });
      }
      continue;
    }
    roots.push(issue);
  }

  const visited = new Set<string>();
  // A folded parent hides its whole loaded subtree; mark it placed so the "orphans" sweep skips it.
  const markSubtreePlaced = (start: BrowserIssue[]) => {
    const stack = [...start];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (visited.has(next.id)) continue;
      visited.add(next.id);
      for (const grandchild of childrenOf.get(next.id) ?? []) stack.push(grandchild);
    }
  };
  const emitTree = (issue: BrowserIssue, depth: number, guides: boolean[], last: boolean) => {
    if (visited.has(issue.id)) return;
    visited.add(issue.id);
    const children = childrenOf.get(issue.id) ?? [];
    const childrenCollapsed = children.length > 0 && collapsed.has(`p:${issue.id}`);
    navigable.push(rows.length);
    rows.push({
      kind: "issue",
      key: `${groupPath}/${issue.id}`,
      issue,
      groupPath,
      depth,
      guides,
      last,
      childCount: children.length,
      childrenCollapsed,
      parentHint: null,
    });
    if (children.length === 0) return;
    if (childrenCollapsed) {
      markSubtreePlaced(children);
      return;
    }
    const sorted = children.slice().sort(state.compareChildren);
    const childGuides = depth >= 1 ? [...guides, !last] : guides;
    sorted.forEach((child, index) => emitTree(child, depth + 1, childGuides, index === sorted.length - 1));
  };

  type Entry = { kind: "issue"; issue: BrowserIssue } | { kind: "context"; id: string; lead: BrowserIssue };
  const entries: Entry[] = roots.map((issue) => ({ kind: "issue", issue }));
  for (const [id, block] of contexts) {
    block.issues.sort(state.compareChildren);
    // A context block sits where its best-placed sub-issue would.
    let lead = block.issues[0]!;
    for (const issue of block.issues) if (state.compareRoots(issue, lead) < 0) lead = issue;
    entries.push({ kind: "context", id, lead });
  }
  entries.sort((left, right) => state.compareRoots(
    left.kind === "issue" ? left.issue : left.lead,
    right.kind === "issue" ? right.issue : right.lead,
  ));

  for (const entry of entries) {
    if (entry.kind === "issue") {
      emitTree(entry.issue, 0, [], true);
      continue;
    }
    const block = contexts.get(entry.id)!;
    const childrenCollapsed = collapsed.has(`p:${entry.id}`);
    rows.push({
      kind: "context",
      key: `${groupPath}/ctx:${entry.id}`,
      groupPath,
      ref: block.ref,
      childCount: block.issues.length,
      childrenCollapsed,
    });
    if (childrenCollapsed) {
      markSubtreePlaced(block.issues);
      continue;
    }
    block.issues.forEach((issue, index) => emitTree(issue, 1, [], index === block.issues.length - 1));
  }

  // Anything left is in a parent loop with no way in: show it at the top level.
  for (const issue of issues.slice().sort(state.compareRoots)) {
    if (!visited.has(issue.id)) emitTree(issue, 0, [], true);
  }
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

function bucketize(
  issues: BrowserIssue[],
  grouping: LinearIssueGrouping,
  ctx: Ctx,
  extraGroups: LinearListGroup[],
  hidden: ReadonlySet<string>,
): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const issue of issues) {
    for (const group of groupsForIssue(issue, grouping, ctx)) {
      if (isHidden(group, hidden)) continue;
      let bucket = buckets.get(group.key);
      if (!bucket) {
        bucket = { group, issues: [] };
        buckets.set(group.key, bucket);
      } else if (group.grouping === "workflowState") {
        // Merged state groups remember every team's state id (counts, hidden groups).
        for (const id of group.ids) if (!bucket.group.ids.includes(id)) bucket.group.ids.push(id);
        if (group.rank < bucket.group.rank) bucket.group.rank = group.rank;
      }
      bucket.issues.push(issue);
    }
  }
  for (const group of extraGroups) {
    if (isHidden(group, hidden)) continue;
    const bucket = buckets.get(group.key);
    if (!bucket) buckets.set(group.key, { group, issues: [] });
    else if (group.grouping === "workflowState") {
      for (const id of group.ids) if (!bucket.group.ids.includes(id)) bucket.group.ids.push(id);
    }
  }
  const out = [...buckets.values()];
  out.sort((left, right) => compareGroups(left.group, right.group));
  return out;
}

export function buildLinearListModel(input: LinearListInput): LinearListModel {
  const { prefs, collapsed } = input;
  const ctx = buildCtx(input.catalog);
  const issues = showsClosedIssues(input)
    ? input.issues
    : input.issues.filter((issue) => !isClosedLinearStateType(issue.stateType));

  const loadedById = new Map<string, BrowserIssue>();
  let identifierChars = 0;
  for (const issue of input.issues) {
    loadedById.set(issue.id, issue);
    if (issue.identifier.length > identifierChars) identifierChars = issue.identifier.length;
  }

  const grouping: LinearIssueGrouping = prefs.grouping;
  const subGrouping: LinearIssueGrouping = grouping === "none" || prefs.subGrouping === grouping ? "none" : prefs.subGrouping;
  const hidden = new Set(prefs.hiddenGroups);
  const sortKeys = new Map<BrowserIssue, SortKeys>();
  const state: EmitState = {
    rows: [],
    navigable: [],
    collapsed,
    nested: prefs.nesting !== "none",
    compareRoots: makeComparator(prefs.ordering, prefs.orderingDirection, sortKeys, false),
    compareChildren: makeComparator(prefs.ordering, prefs.orderingDirection, sortKeys, true),
    loadedById,
  };
  const headerIndices: number[] = [];
  const groups: LinearListModel["groups"] = [];

  if (grouping === "none") {
    emitBucketIssues(issues, "all", state);
    const issueIds = issues.map((issue) => issue.id);
    return { rows: state.rows, groups, headerIndices, navigable: state.navigable, identifierChars, issueIds, issueCount: issueIds.length };
  }

  // Label grouping lists an issue once per label; the ids are counted once.
  const shownIds = new Set<string>();
  const markShown = (list: BrowserIssue[]) => {
    for (const issue of list) shownIds.add(issue.id);
  };

  const extra = prefs.showEmptyGroups ? emptyGroupsFor(grouping, input, ctx) : [];
  for (const bucket of bucketize(issues, grouping, ctx, extra, hidden)) {
    const path = bucket.group.key;
    const groupCollapsed = collapsed.has(`g:${path}`);
    groups.push({ group: bucket.group, count: bucket.issues.length });
    headerIndices.push(state.rows.length);
    state.rows.push({ kind: "group", key: `g:${path}`, path, depth: 0, group: bucket.group, count: bucket.issues.length, collapsed: groupCollapsed });
    if (bucket.issues.length === 0) continue;
    if (subGrouping === "none") {
      markShown(bucket.issues);
      if (!groupCollapsed) emitBucketIssues(bucket.issues, path, state);
      continue;
    }
    for (const sub of bucketize(bucket.issues, subGrouping, ctx, [], hidden)) {
      markShown(sub.issues);
      if (groupCollapsed) continue;
      const subPath = `${path}/${sub.group.key}`;
      const subCollapsed = collapsed.has(`g:${subPath}`);
      state.rows.push({ kind: "group", key: `g:${subPath}`, path: subPath, depth: 1, group: sub.group, count: sub.issues.length, collapsed: subCollapsed });
      if (!subCollapsed) emitBucketIssues(sub.issues, subPath, state);
    }
  }

  const issueIds = issues.filter((issue) => shownIds.has(issue.id)).map((issue) => issue.id);
  return { rows: state.rows, groups, headerIndices, navigable: state.navigable, identifierChars, issueIds, issueCount: issueIds.length };
}

/**
 * What a group's "+" fills in: the scope's fields, the parent group's, then
 * the group's own, for one team. The team is the group's (a status or team
 * group), else one its issues share, else the scope's or workspace's only
 * team, else the team a picked state, cycle or label belongs to. Team-bound
 * ids from another team are swapped for the chosen team's match (a status of
 * the same name and type) or left out, so the form never mixes teams.
 */
export function groupCreatePrefill({
  rows,
  index,
  catalog,
  scopePrefill,
  scopeTeamKeys,
}: {
  rows: readonly LinearListRow[];
  index: number;
  catalog: LinearListCatalog;
  scopePrefill: LinearIssuePrefill;
  scopeTeamKeys: readonly string[] | null;
}): LinearIssuePrefill | null {
  const row = rows[index];
  if (!row || row.kind !== "group") return null;
  let parent: LinearListGroupRow | null = null;
  if (row.depth === 1) {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = rows[cursor];
      if (candidate?.kind === "group" && candidate.depth === 0) { parent = candidate; break; }
    }
  }
  const prefill: LinearIssuePrefill = { ...scopePrefill, ...(parent?.group.prefill ?? {}), ...row.group.prefill };
  const statesById = new Map(catalog.states.map((state) => [state.id, state]));
  const cyclesById = new Map((catalog.cycles ?? []).map((cycle) => [cycle.id, cycle]));
  const labelsById = new Map(catalog.labels.map((label) => [label.id, label]));

  let teamKey = prefill.teamKey ?? null;
  if (!teamKey) {
    for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
      const candidate = rows[cursor];
      if (!candidate || (candidate.kind === "group" && candidate.depth <= row.depth)) break;
      if (candidate.kind === "issue" && candidate.issue.teamKey) { teamKey = candidate.issue.teamKey; break; }
    }
  }
  if (!teamKey && scopeTeamKeys?.length === 1) teamKey = scopeTeamKeys[0]!;
  if (!teamKey && catalog.teams.length === 1) teamKey = catalog.teams[0]!.key;
  if (!teamKey) {
    teamKey = (prefill.stateId ? statesById.get(prefill.stateId)?.teamKey : null)
      ?? (prefill.cycleId ? cyclesById.get(prefill.cycleId)?.teamKey : null)
      ?? (prefill.labelIds ?? []).map((id) => labelsById.get(id)?.teamKey).find((key): key is string => Boolean(key))
      ?? null;
  }
  prefill.teamKey = teamKey;
  if (!teamKey) return prefill;

  if (prefill.stateId) {
    // An id the catalog does not know stays: only a known other team's status is swapped.
    const state = statesById.get(prefill.stateId);
    if (state && state.teamKey !== teamKey) {
      const lower = state.name.trim().toLowerCase();
      const match = catalog.states.find((entry) => entry.teamKey === teamKey && entry.type === state.type && entry.name.trim().toLowerCase() === lower);
      if (match) prefill.stateId = match.id;
      else delete prefill.stateId;
    }
  }
  if (prefill.cycleId) {
    const cycle = cyclesById.get(prefill.cycleId);
    if (cycle && cycle.teamKey !== teamKey) delete prefill.cycleId;
  }
  if (prefill.labelIds) {
    // Workspace labels (no team) fit any team; a label the catalog does not know stays.
    prefill.labelIds = prefill.labelIds.filter((id) => {
      const label = labelsById.get(id);
      return !label || !label.teamId || label.teamKey === teamKey;
    });
  }
  return prefill;
}
