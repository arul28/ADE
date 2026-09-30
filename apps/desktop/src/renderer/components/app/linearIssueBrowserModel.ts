import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearIssueCount,
  CtoUpdateLinearIssueArgs,
  LaneLinearIssue,
  LinearCatalogLabel,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { toLaneLinearIssue } from "../lanes/linearIssueDisplay";

/** A row in the browser: a fresh Linear read, or a lane's stored copy (featured issue). */
export type BrowserIssue = NormalizedLinearIssue | LaneLinearIssue;

export type LinearIssueEdit = Omit<CtoUpdateLinearIssueArgs, "issueId">;

export const STATE_GROUP_ORDER = ["started", "unstarted", "backlog", "triage", "completed", "canceled", "duplicate"] as const;

export const PRIORITY_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "No priority" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
];

const PRIORITY_LABELS: Record<number, NormalizedLinearIssue["priorityLabel"]> = {
  0: "none",
  1: "urgent",
  2: "high",
  3: "normal",
  4: "low",
};

export function isNormalizedIssue(issue: BrowserIssue): issue is NormalizedLinearIssue {
  return "raw" in issue;
}

export function linearBrowserIssueToLaneIssue(issue: BrowserIssue): LaneLinearIssue {
  return isNormalizedIssue(issue) ? toLaneLinearIssue(issue) : issue;
}

export function stateGroupRank(stateType: string): number {
  const index = STATE_GROUP_ORDER.indexOf(stateType as typeof STATE_GROUP_ORDER[number]);
  return index === -1 ? 99 : index;
}

/** `null` while unknown, `"1,000+"` for a capped count. */
export function formatLinearCount(count: CtoLinearIssueCount | null | undefined): string | null {
  if (!count) return null;
  const formatted = count.count.toLocaleString();
  return count.capped ? `${formatted}+` : formatted;
}

/** Labels of an issue with their catalog ids, when either side knows them. */
export function issueLabelEntries(
  issue: BrowserIssue,
  catalogLabels: LinearCatalogLabel[] | undefined,
): Array<{ id: string | null; name: string; color: string | null }> {
  const fromIssue = isNormalizedIssue(issue) && issue.labelColors
    ? issue.labelColors.map((label) => ({ id: label.id ?? null, name: label.name, color: label.color }))
    : issue.labels.map((name) => ({ id: null as string | null, name, color: null as string | null }));
  return fromIssue.map((label) => {
    if (label.id && label.color) return label;
    const match = findCatalogLabel(catalogLabels, issue, label.name, label.id);
    return {
      id: label.id ?? match?.id ?? null,
      name: label.name,
      color: label.color ?? match?.color ?? null,
    };
  });
}

function findCatalogLabel(
  catalogLabels: LinearCatalogLabel[] | undefined,
  issue: BrowserIssue,
  name: string,
  id: string | null,
): LinearCatalogLabel | null {
  if (!catalogLabels) return null;
  if (id) return catalogLabels.find((label) => label.id === id) ?? null;
  const lower = name.trim().toLowerCase();
  const candidates = catalogLabels.filter((label) => label.name.trim().toLowerCase() === lower);
  return candidates.find((label) => label.teamId === issue.teamId)
    ?? candidates.find((label) => !label.teamId)
    ?? candidates[0]
    ?? null;
}

/** Labels an issue can take: its team's plus workspace-wide ones. */
export function labelsForIssueTeam(catalogLabels: LinearCatalogLabel[] | undefined, issue: BrowserIssue): LinearCatalogLabel[] {
  return (catalogLabels ?? []).filter((label) => !label.teamId || label.teamId === issue.teamId || label.teamKey === issue.teamKey);
}

/**
 * The optimistic version of an edit, applied before Linear answers. Only the
 * fields the pane shows move; the server's copy replaces it on success.
 */
export function applyIssueEdit<T extends BrowserIssue>(
  issue: T,
  edit: LinearIssueEdit,
  catalog: CtoGetLinearIssuePickerDataResult,
): T {
  let next: T = { ...issue, updatedAt: new Date().toISOString() };
  if (edit.stateId) {
    const state = catalog.states.find((entry) => entry.id === edit.stateId);
    if (state) next = { ...next, stateId: state.id, stateName: state.name, stateType: state.type };
  }
  if (edit.assigneeId !== undefined) {
    const user = edit.assigneeId ? catalog.users.find((entry) => entry.id === edit.assigneeId) : null;
    next = {
      ...next,
      assigneeId: edit.assigneeId ?? null,
      assigneeName: user ? (user.displayName ?? user.name) : null,
      ...(isNormalizedIssue(next) ? { assigneeAvatarUrl: user?.avatarUrl ?? null } : {}),
    };
  }
  if (typeof edit.priority === "number") {
    next = { ...next, priority: edit.priority, priorityLabel: PRIORITY_LABELS[edit.priority] ?? "none" };
  }
  const added = edit.addedLabelIds ?? [];
  const removed = new Set(edit.removedLabelIds ?? []);
  if (added.length > 0 || removed.size > 0) {
    const current = issueLabelEntries(issue, catalog.labels);
    const kept = current.filter((label) => !(label.id && removed.has(label.id)));
    const addedEntries = added
      .map((id) => catalog.labels?.find((label) => label.id === id))
      .filter((label): label is LinearCatalogLabel => label != null)
      .filter((label) => !kept.some((entry) => entry.id === label.id))
      .map((label) => ({ id: label.id, name: label.name, color: label.color }));
    const labels = [...kept, ...addedEntries];
    next = {
      ...next,
      labels: labels.map((label) => label.name.toLowerCase()),
      ...(isNormalizedIssue(next)
        ? { labelColors: labels.map((label) => ({ ...(label.id ? { id: label.id } : {}), name: label.name, color: label.color })) }
        : {}),
    };
  }
  return next;
}

export function initialsFor(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ""}${words[words.length - 1]![0] ?? ""}`.toUpperCase();
}
