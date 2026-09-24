import type { LaneListSnapshot, LaneSummary, TerminalToolType } from "../../../../shared/types";
import { pickPrimaryPr } from "../../../../shared/primaryPr";
import type { LaneAgent } from "../laneAgents";
import type { LaneTabPrTag } from "../lanePageModel";

/** Pixels each stack level indents a row. */
export const LANE_SIDEBAR_INDENT_PX = 12;
/** Deep stacks stop indenting here so names never get pushed out of view. */
export const LANE_SIDEBAR_MAX_INDENT_LEVELS = 2;

export type LaneSidebarTreeRow = {
  lane: LaneSummary;
  /** Real stack depth. Top-level lanes (based on primary) are 0. */
  depth: number;
  /** Depth used for layout, capped at `LANE_SIDEBAR_MAX_INDENT_LEVELS`. */
  indentLevel: number;
  /**
   * Name of the stack parent when the row cannot sit under it (the parent is
   * in another State group). The row shows "↳ parent" instead of indenting.
   */
  parentHint?: string | null;
};

function createdAtMs(lane: Pick<LaneSummary, "createdAt">): number {
  const ts = Date.parse(lane.createdAt);
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * Orders lanes as a tree for the sidebar list.
 *
 * Primary comes first. Lanes based on primary are top-level rows, newest first,
 * the same order the old lane tabs used. A stacked child sits right under its
 * parent, children in the order they were stacked (oldest first). A lane whose
 * parent is missing from `lanes` (filtered out, archived) becomes top-level.
 */
export function buildLaneSidebarRows(lanes: LaneSummary[]): LaneSidebarTreeRow[] {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const primaryId = lanes.find((lane) => lane.laneType === "primary")?.id ?? null;
  const childrenByParent = new Map<string, LaneSummary[]>();
  const roots: LaneSummary[] = [];

  for (const lane of lanes) {
    const parentId = lane.parentLaneId;
    const isStacked = lane.laneType !== "primary"
      && parentId != null
      && parentId !== lane.id
      && parentId !== primaryId
      && laneById.has(parentId);
    if (!isStacked) {
      roots.push(lane);
      continue;
    }
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(lane);
    childrenByParent.set(parentId, siblings);
  }

  roots.sort((a, b) => {
    const aPrimary = a.laneType === "primary" ? 0 : 1;
    const bPrimary = b.laneType === "primary" ? 0 : 1;
    if (aPrimary !== bPrimary) return aPrimary - bPrimary;
    const byCreated = createdAtMs(b) - createdAtMs(a);
    return byCreated !== 0 ? byCreated : a.name.localeCompare(b.name);
  });
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => {
      const byCreated = createdAtMs(a) - createdAtMs(b);
      return byCreated !== 0 ? byCreated : a.name.localeCompare(b.name);
    });
  }

  const rows: LaneSidebarTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (lane: LaneSummary, depth: number) => {
    // A corrupted parent cycle must not loop forever.
    if (seen.has(lane.id)) return;
    seen.add(lane.id);
    rows.push({ lane, depth, indentLevel: Math.min(depth, LANE_SIDEBAR_MAX_INDENT_LEVELS) });
    for (const child of childrenByParent.get(lane.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // Lanes stuck in a parent cycle never hang off a root; keep them visible.
  for (const lane of lanes) {
    if (!seen.has(lane.id)) visit(lane, 0);
  }
  return rows;
}

/** Id of the next selectable row, wrapping at both ends. */
export function stepLaneSidebarSelection(
  laneIds: readonly string[],
  currentLaneId: string | null,
  direction: -1 | 1,
): string | null {
  if (laneIds.length === 0) return null;
  const currentIndex = currentLaneId ? laneIds.indexOf(currentLaneId) : -1;
  if (currentIndex < 0) return direction === 1 ? laneIds[0]! : laneIds[laneIds.length - 1]!;
  return laneIds[(currentIndex + direction + laneIds.length) % laneIds.length] ?? null;
}

/** Lanes between `anchorLaneId` and `laneId` (inclusive), in row order. */
export function laneSidebarRange(laneIds: readonly string[], anchorLaneId: string | null, laneId: string): string[] {
  const end = laneIds.indexOf(laneId);
  if (end < 0) return [];
  const start = anchorLaneId ? laneIds.indexOf(anchorLaneId) : -1;
  if (start < 0) return [laneId];
  const [from, to] = start <= end ? [start, end] : [end, start];
  return laneIds.slice(from, to + 1);
}

export type LaneSidebarAgentTone = "attention" | "working" | "idle";

export type LaneSidebarAgentStatus = {
  tone: LaneSidebarAgentTone;
  /** Live agents shown as avatars, most urgent first. */
  agents: LaneAgent[];
  label: string;
};

type LaneRuntime = Pick<LaneListSnapshot["runtime"], "bucket" | "runningCount" | "awaitingInputCount"> & {
  pendingInputCount?: number;
};

const LIVE_ACTIVITIES = new Set<LaneAgent["activity"]>(["working", "monitoring", "awaiting-input"]);

/**
 * What the row's right side shows: the agents at work in the lane and one
 * status dot. A chat or terminal waiting on the user always wins.
 */
export function laneSidebarAgentStatus(
  agents: readonly LaneAgent[],
  runtime: LaneRuntime | null | undefined,
): LaneSidebarAgentStatus | null {
  const live = agents.filter((agent) => LIVE_ACTIVITIES.has(agent.activity));
  const waiting = live.filter((agent) => agent.activity === "awaiting-input").length;
  const runtimeWaiting = Math.max(runtime?.awaitingInputCount ?? 0, runtime?.pendingInputCount ?? 0);
  const needsUser = waiting > 0 || runtimeWaiting > 0 || runtime?.bucket === "awaiting-input";
  const running = live.length > 0 || runtime?.bucket === "running";
  if (!needsUser && !running) return null;
  const ordered = [...live].sort((a, b) => {
    const rank = (agent: LaneAgent) => (agent.activity === "awaiting-input" ? 0 : 1);
    return rank(a) - rank(b);
  });
  if (needsUser) {
    const count = Math.max(waiting, runtimeWaiting, 1);
    return {
      tone: "attention",
      agents: ordered,
      label: count === 1 ? "Waiting for you" : `${count} waiting for you`,
    };
  }
  const workingCount = Math.max(live.length, runtime?.runningCount ?? 0);
  return {
    tone: "working",
    agents: ordered,
    label: workingCount === 1 ? "1 agent working" : `${workingCount} agents working`,
  };
}

const PROVIDER_TOOL_TYPES: Record<string, TerminalToolType> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  droid: "droid",
  opencode: "opencode",
  pi: "pi",
  qwen: "qwen",
  kimi: "kimi",
  grok: "grok",
  copilot: "copilot",
};

/** Tool type whose logo stands for an agent's provider. */
export function laneAgentToolType(agent: Pick<LaneAgent, "providerLabel">): TerminalToolType | null {
  return PROVIDER_TOOL_TYPES[agent.providerLabel.trim().toLowerCase()] ?? null;
}

/** Newest of the lane's last commit and its agents' last activity. */
export function laneLastActivityAt(
  lane: Pick<LaneSummary, "lastCommitAt" | "status">,
  agents: readonly Pick<LaneAgent, "lastActivityAt">[],
): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  const consider = (iso: string | null | undefined) => {
    if (!iso) return;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms) || ms <= bestMs) return;
    best = iso;
    bestMs = ms;
  };
  consider(lane.status.lastCommitAt ?? lane.lastCommitAt);
  for (const agent of agents) consider(agent.lastActivityAt);
  return best;
}

/** Branch name without `refs/heads/`. */
export function laneBranchLabel(branchRef: string | null | undefined): string {
  return (branchRef ?? "").replace(/^refs\/heads\//, "");
}

/* ---- Group by State ---- */

/** How the sidebar list is cut: by what each lane needs, or as the stack tree. */
export type LaneSidebarGroupBy = "state" | "stack";

export type LaneStateGroupId = "needs-you" | "active" | "behind" | "done" | "stale" | "quiet";

/** Top-to-bottom order of the State groups. */
export const LANE_STATE_GROUP_ORDER: readonly LaneStateGroupId[] = [
  "needs-you",
  "active",
  "behind",
  "done",
  "stale",
  "quiet",
];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A lane touched this recently counts as Active even with no agent running. */
export const LANE_ACTIVE_WINDOW_MS = 2 * HOUR_MS;
/** A lane with no activity for longer than this, no open PR and no agent is Stale. */
export const LANE_STALE_AFTER_MS = 14 * DAY_MS;

export type LaneStateInput = {
  lane: Pick<LaneSummary, "laneType" | "status" | "lastCommitAt" | "createdAt">;
  agents: readonly Pick<LaneAgent, "activity" | "lastActivityAt">[];
  runtime: LaneRuntime | null | undefined;
  prs: readonly Pick<LaneTabPrTag, "state" | "githubPrNumber" | "checksStatus" | "reviewStatus" | "mergeConflicts" | "laneRole" | "updatedAt">[] | undefined;
  rebaseSuggestion: Pick<NonNullable<LaneListSnapshot["rebaseSuggestion"]>, "behindCount"> | null | undefined;
  autoRebaseStatus: Pick<NonNullable<LaneListSnapshot["autoRebaseStatus"]>, "state"> | null | undefined;
  nowMs: number;
};

/** Newest known activity: last commit, agent activity, or when the lane was made. */
function laneActivityMs(input: LaneStateInput): number {
  let best = -Infinity;
  const consider = (iso: string | null | undefined) => {
    if (!iso) return;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms) && ms > best) best = ms;
  };
  consider(input.lane.status.lastCommitAt ?? input.lane.lastCommitAt);
  consider(input.lane.createdAt);
  for (const agent of input.agents) consider(agent.lastActivityAt);
  return best;
}

/**
 * Which State group a lane belongs to, or "primary" for the pinned Primary
 * lane. First match wins, in `LANE_STATE_GROUP_ORDER`, with one exception:
 * a lane whose PR merged is Done even when it is behind its base, because
 * rebasing finished work is never the next step.
 *
 * Only PRs on the lane's current branch count. PR checks, review and merge
 * conflicts come from the list's PR tags; a lane without that data simply
 * never lands in Needs you for a PR reason.
 */
function currentBranchPrs(input: Pick<LaneStateInput, "prs">) {
  return (input.prs ?? []).filter((pr) => pr.laneRole !== "previous");
}

function isOpenPr(pr: Pick<LaneTabPrTag, "state">): boolean {
  return pr.state === "open" || pr.state === "draft";
}

/**
 * Why a lane needs the user, or null when it does not. Order is the order a
 * person would act on: a waiting agent first, then a broken rebase, then PR
 * trouble. Primary never needs you here; its header has its own notices.
 */
export function laneNeedsYouReason(input: Omit<LaneStateInput, "nowMs">): string | null {
  if (input.lane.laneType === "primary") return null;
  const { agents, runtime } = input;
  const agentWaiting = agents.some((agent) => agent.activity === "awaiting-input")
    || Math.max(runtime?.awaitingInputCount ?? 0, runtime?.pendingInputCount ?? 0) > 0
    || runtime?.bucket === "awaiting-input";
  if (agentWaiting) return "An agent is waiting for you";
  const rebaseState = input.autoRebaseStatus?.state;
  if (rebaseState === "rebaseConflict") return "Rebase hit conflicts";
  if (rebaseState === "rebaseFailed") return "Rebase failed";
  const openPrs = currentBranchPrs(input).filter(isOpenPr);
  if (openPrs.some((pr) => pr.mergeConflicts === true)) return "PR has merge conflicts";
  if (openPrs.some((pr) => pr.checksStatus === "failing")) return "PR checks are failing";
  if (openPrs.some((pr) => pr.reviewStatus === "changes_requested")) return "PR has changes requested";
  return null;
}

/**
 * Which State group a lane belongs to, or "primary" for the pinned Primary
 * lane. First match wins, in `LANE_STATE_GROUP_ORDER`, with one exception:
 * a lane whose PR merged is Done even when it is behind its base, because
 * rebasing finished work is never the next step.
 *
 * Only PRs on the lane's current branch count. PR checks, review and merge
 * conflicts come from the list's PR tags; a lane without that data simply
 * never lands in Needs you for a PR reason.
 */
export function classifyLaneState(input: LaneStateInput): LaneStateGroupId | "primary" {
  const { lane, agents, runtime, nowMs } = input;
  if (lane.laneType === "primary") return "primary";
  if (laneNeedsYouReason(input)) return "needs-you";

  const activityMs = laneActivityMs(input);
  const agentWorking = agents.some((agent) => LIVE_ACTIVITIES.has(agent.activity))
    || runtime?.bucket === "running"
    || (runtime?.runningCount ?? 0) > 0;
  if (agentWorking || nowMs - activityMs <= LANE_ACTIVE_WINDOW_MS) return "active";

  const prs = currentBranchPrs(input);
  const merged = pickPrimaryPr(prs)?.state === "merged";
  const behind = lane.status.behind > 0 || (input.rebaseSuggestion?.behindCount ?? 0) > 0;
  if (behind && !merged) return "behind";
  if (merged) return "done";

  if (!prs.some(isOpenPr) && nowMs - activityMs > LANE_STALE_AFTER_MS) return "stale";
  return "quiet";
}

export type LaneSidebarGroup = {
  id: LaneStateGroupId;
  rows: LaneSidebarTreeRow[];
};

export type LaneSidebarLayout =
  | { groupBy: "stack"; rows: LaneSidebarTreeRow[] }
  | { groupBy: "state"; pinned: LaneSidebarTreeRow[]; groups: LaneSidebarGroup[] };

/** Id used to persist a State group's collapsed state. */
export function laneStateGroupSectionId(id: LaneStateGroupId): string {
  return `lanes-state:${id}`;
}

/**
 * Lays out the sidebar list. Stack mode is the plain tree. State mode pins
 * Primary on top, then one group per non-empty state. Inside a group, a
 * stacked child stays indented under its parent only when the parent is in
 * the same group; otherwise it is a top-level row with a parent hint.
 */
export function buildLaneSidebarLayout(args: {
  lanes: LaneSummary[];
  groupBy: LaneSidebarGroupBy;
  stateByLaneId: ReadonlyMap<string, LaneStateGroupId | "primary">;
  /** Every lane, so a hint can name a parent the filter hides. */
  lanesById: ReadonlyMap<string, LaneSummary>;
}): LaneSidebarLayout {
  const { lanes, groupBy, stateByLaneId, lanesById } = args;
  if (groupBy === "stack") return { groupBy, rows: buildLaneSidebarRows(lanes) };

  const pinnedLanes: LaneSummary[] = [];
  const lanesByGroup = new Map<LaneStateGroupId, LaneSummary[]>();
  for (const lane of lanes) {
    const state = stateByLaneId.get(lane.id) ?? (lane.laneType === "primary" ? "primary" : "quiet");
    if (state === "primary") {
      pinnedLanes.push(lane);
      continue;
    }
    const bucket = lanesByGroup.get(state) ?? [];
    bucket.push(lane);
    lanesByGroup.set(state, bucket);
  }

  const groups: LaneSidebarGroup[] = [];
  for (const id of LANE_STATE_GROUP_ORDER) {
    const groupLanes = lanesByGroup.get(id);
    if (!groupLanes || groupLanes.length === 0) continue;
    const rows = buildLaneSidebarRows(groupLanes).map((row) => {
      if (row.depth > 0) return row;
      const parent = row.lane.parentLaneId ? lanesById.get(row.lane.parentLaneId) : undefined;
      if (!parent || parent.id === row.lane.id || parent.laneType === "primary") return row;
      return { ...row, parentHint: parent.name };
    });
    groups.push({ id, rows });
  }
  return { groupBy, pinned: buildLaneSidebarRows(pinnedLanes), groups };
}

/** Lane ids in on-screen order, skipping collapsed groups. Drives J/K and Shift-click. */
export function laneSidebarVisibleLaneIds(
  layout: LaneSidebarLayout,
  collapsed: ReadonlySet<string>,
): string[] {
  if (layout.groupBy === "stack") return layout.rows.map((row) => row.lane.id);
  const ids = layout.pinned.map((row) => row.lane.id);
  for (const group of layout.groups) {
    if (collapsed.has(laneStateGroupSectionId(group.id))) continue;
    for (const row of group.rows) ids.push(row.lane.id);
  }
  return ids;
}

/** What a group header's "…" menu offers. */
export type LaneGroupBulkAction = "archive" | "rebase" | "delete";

export function laneGroupBulkActions(id: LaneStateGroupId): LaneGroupBulkAction[] {
  switch (id) {
    case "done": return ["archive"];
    case "behind": return ["rebase"];
    case "stale": return ["archive", "delete"];
    default: return [];
  }
}
