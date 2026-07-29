/**
 * Chip filters for the Work sidebar.
 *
 * Four independent axes. Within an axis the selections are OR-ed (picking
 * "Running" and "Your move" shows both); across axes they are AND-ed (adding
 * "Claude" narrows both to Claude). That is the behaviour every issue tracker
 * uses, and the only one that makes multi-select within an axis useful.
 *
 * Pure by design: the sidebar hands over the session plus the two lane lookups
 * it can answer, so the matching rules are unit-testable without a store.
 */
import type { TerminalSessionSummary, TerminalToolType } from "../../../shared/types";
import { sessionFilingBucket, type SessionFilingBucket } from "../../lib/terminalAttention";

/**
 * Chip-level tool identity. Several `toolType` values are the same tool wearing
 * a different hat (`claude`, `claude-chat`, `claude-orchestrated`), and a user
 * picking "Claude" means all of them.
 */
export type WorkToolFamily =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "opencode"
  | "shell"
  | "other";

export const WORK_TOOL_FAMILIES: readonly WorkToolFamily[] = [
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
  "shell",
];

const TOOL_FAMILY_LABELS: Record<WorkToolFamily, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  shell: "Shell",
  other: "Other",
};

export function workToolFamily(toolType: TerminalToolType | null | undefined): WorkToolFamily {
  switch (toolType) {
    case "claude":
    case "claude-chat":
    case "claude-orchestrated":
      return "claude";
    case "codex":
    case "codex-chat":
    case "codex-orchestrated":
      return "codex";
    case "cursor":
    case "cursor-cli":
      return "cursor";
    case "droid":
    case "droid-chat":
      return "droid";
    case "opencode":
    case "opencode-chat":
    case "opencode-orchestrated":
      return "opencode";
    case "shell":
      return "shell";
    default:
      return "other";
  }
}

export const WORK_STATUS_FILTERS: readonly SessionFilingBucket[] = [
  "awaiting-input",
  "running",
  "ended",
  "settled",
  "snoozed",
];

const STATUS_LABELS: Record<SessionFilingBucket, string> = {
  "awaiting-input": "Your move",
  running: "Running",
  ended: "Ended",
  settled: "Settled",
  snoozed: "Snoozed",
};

export function workStatusFilterLabel(bucket: SessionFilingBucket): string {
  return STATUS_LABELS[bucket];
}

export function workToolFamilyLabel(family: WorkToolFamily): string {
  return TOOL_FAMILY_LABELS[family];
}

export type WorkSessionFilters = {
  status: SessionFilingBucket[];
  tool: WorkToolFamily[];
  /** Only sessions in a lane with an open pull request. */
  hasPr: boolean;
  /** Only sessions in a lane with uncommitted changes. */
  dirtyLane: boolean;
};

export const EMPTY_WORK_SESSION_FILTERS: WorkSessionFilters = {
  status: [],
  tool: [],
  hasPr: false,
  dirtyLane: false,
};

export function isWorkSessionFilterEmpty(filters: WorkSessionFilters): boolean {
  return filters.status.length === 0
    && filters.tool.length === 0
    && !filters.hasPr
    && !filters.dirtyLane;
}

export function normalizeWorkSessionFilters(value: unknown): WorkSessionFilters {
  if (!value || typeof value !== "object") return EMPTY_WORK_SESSION_FILTERS;
  const candidate = value as Partial<WorkSessionFilters>;
  const status = Array.isArray(candidate.status)
    ? WORK_STATUS_FILTERS.filter((bucket) => candidate.status!.includes(bucket))
    : [];
  const tool = Array.isArray(candidate.tool)
    ? WORK_TOOL_FAMILIES.filter((family) => candidate.tool!.includes(family))
    : [];
  return {
    status,
    tool,
    hasPr: candidate.hasPr === true,
    dirtyLane: candidate.dirtyLane === true,
  };
}

export type WorkSessionFilterContext = {
  nowMs: number;
  laneHasPr: (laneId: string) => boolean;
  laneIsDirty: (laneId: string) => boolean;
};

export function matchesWorkSessionFilters(
  session: TerminalSessionSummary,
  filters: WorkSessionFilters,
  ctx: WorkSessionFilterContext,
): boolean {
  // "Your move" deliberately maps to the `awaiting-input` filing bucket rather
  // than the loud `sessionNeedsYou` tier, so the chip and the sidebar's existing
  // "Your move" section always agree about which rows they mean.
  if (
    filters.status.length > 0
    && !filters.status.includes(sessionFilingBucket(session, ctx.nowMs))
  ) return false;

  if (
    filters.tool.length > 0
    && !filters.tool.includes(workToolFamily(session.toolType))
  ) return false;

  if (filters.hasPr && !ctx.laneHasPr(session.laneId)) return false;
  if (filters.dirtyLane && !ctx.laneIsDirty(session.laneId)) return false;

  return true;
}

/** Human labels for whatever is active — powers the filtered empty state. */
export function activeWorkSessionFilterLabels(filters: WorkSessionFilters): string[] {
  const labels: string[] = [];
  for (const bucket of WORK_STATUS_FILTERS) {
    if (filters.status.includes(bucket)) labels.push(workStatusFilterLabel(bucket));
  }
  for (const family of WORK_TOOL_FAMILIES) {
    if (filters.tool.includes(family)) labels.push(workToolFamilyLabel(family));
  }
  if (filters.hasPr) labels.push("Has PR");
  if (filters.dirtyLane) labels.push("Dirty");
  return labels;
}
