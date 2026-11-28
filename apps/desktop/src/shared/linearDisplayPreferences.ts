/**
 * The Linear issue list's display settings: Linear's defaults, the patch
 * shape a change travels as, and how patches combine. One copy for main, the
 * CLI brain, the ADE Cloud reads, the browser mock and the renderer. Pure: no
 * Node and no DOM.
 */

import { BRAND } from "./brand";
import {
  isLinearIssueGrouping,
  isLinearIssueNesting,
  isLinearIssueOrdering,
  type CtoLinearRailData,
  type CtoUpdateLinearViewPreferencesArgs,
  type CtoUpdateLinearViewPreferencesResult,
  type LinearDisplayPreferences,
  type LinearIssueDisplayFields,
  type LinearIssueOrdering,
} from "./types/cto";

/** A display change: only the keys it sets. */
export type LinearDisplayPatch = CtoUpdateLinearViewPreferencesArgs["patch"];

/**
 * Linear's own quiet default row (no updated date, estimate, cycle or
 * milestone), plus ADE's status column.
 */
export const LINEAR_DEFAULT_DISPLAY_FIELDS: Readonly<LinearIssueDisplayFields> = Object.freeze({
  id: true,
  status: true,
  priority: true,
  assignee: true,
  labels: true,
  project: true,
  cycle: false,
  milestone: false,
  estimate: false,
  dueDate: true,
  pullRequests: true,
  createdAt: true,
  updatedAt: false,
  adeStatus: true,
});

/** Each ordering's natural direction in Linear (`viewOrderingDirection` unset). */
export const LINEAR_ORDERING_NATURAL_DIRECTION: Readonly<Record<LinearIssueOrdering, "asc" | "desc">> = Object.freeze({
  manual: "asc",
  priority: "desc",
  updatedAt: "desc",
  createdAt: "desc",
  dueDate: "asc",
  estimate: "desc",
  title: "asc",
});

/** Linear's defaults when nothing is saved: group by status, nesting on, manual order. */
export function defaultLinearDisplayPreferences(): LinearDisplayPreferences {
  return {
    grouping: "workflowState",
    subGrouping: "none",
    ordering: "manual",
    orderingDirection: "asc",
    nesting: "showAll",
    showEmptyGroups: false,
    showCompletedIssues: true,
    hiddenGroups: [],
    fields: { ...LINEAR_DEFAULT_DISPLAY_FIELDS },
    source: "default",
  };
}

/** Fills anything an older brain left out, so a reader never sees undefined. */
export function normalizeLinearDisplayPreferences(
  value: Partial<LinearDisplayPreferences> | null | undefined,
): LinearDisplayPreferences {
  const defaults = defaultLinearDisplayPreferences();
  if (!value || typeof value !== "object") return defaults;
  return {
    ...defaults,
    ...withoutUndefined(value),
    hiddenGroups: Array.isArray(value.hiddenGroups) ? value.hiddenGroups.filter((entry) => typeof entry === "string") : [],
    fields: { ...defaults.fields, ...withoutUndefined(value.fields ?? {}) },
  };
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

/** The settings with a patch applied. Keys the patch leaves undefined keep their value. */
export function applyLinearDisplayPatch(
  prefs: LinearDisplayPreferences,
  patch: LinearDisplayPatch,
): LinearDisplayPreferences {
  const { fields, ...rest } = patch;
  return {
    ...prefs,
    ...withoutUndefined(rest),
    fields: fields ? { ...prefs.fields, ...withoutUndefined(fields) } : prefs.fields,
  };
}

/** Two patches as one: the later wins key by key, display fields merge, undefined never overwrites. */
export function mergeLinearDisplayPatches(
  left: LinearDisplayPatch | null | undefined,
  right: LinearDisplayPatch | null | undefined,
): LinearDisplayPatch {
  const { fields: leftFields, ...leftRest } = left ?? {};
  const { fields: rightFields, ...rightRest } = right ?? {};
  const merged: LinearDisplayPatch = { ...withoutUndefined(leftRest), ...withoutUndefined(rightRest) };
  if (leftFields || rightFields) {
    merged.fields = { ...withoutUndefined(leftFields ?? {}), ...withoutUndefined(rightFields ?? {}) };
  }
  return merged;
}

const DISPLAY_FIELD_KEYS = Object.keys(LINEAR_DEFAULT_DISPLAY_FIELDS) as Array<keyof LinearIssueDisplayFields>;
const HIDDEN_GROUPS_MAX = 200;

/**
 * A patch as it arrives over IPC or sync: only known keys, only canonical
 * values (enum members, booleans, strings). Anything else is dropped.
 */
export function parseLinearDisplayPatch(value: unknown): LinearDisplayPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const patch: LinearDisplayPatch = {};
  if (Object.hasOwn(raw, "grouping") && isLinearIssueGrouping(raw.grouping)) patch.grouping = raw.grouping;
  if (Object.hasOwn(raw, "subGrouping") && isLinearIssueGrouping(raw.subGrouping)) patch.subGrouping = raw.subGrouping;
  if (Object.hasOwn(raw, "ordering") && isLinearIssueOrdering(raw.ordering)) patch.ordering = raw.ordering;
  if (raw.orderingDirection === "asc" || raw.orderingDirection === "desc") patch.orderingDirection = raw.orderingDirection;
  if (Object.hasOwn(raw, "nesting") && isLinearIssueNesting(raw.nesting)) patch.nesting = raw.nesting;
  if (typeof raw.showEmptyGroups === "boolean") patch.showEmptyGroups = raw.showEmptyGroups;
  if (typeof raw.showCompletedIssues === "boolean") patch.showCompletedIssues = raw.showCompletedIssues;
  if (Array.isArray(raw.hiddenGroups)) {
    patch.hiddenGroups = raw.hiddenGroups
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 200)
      .slice(0, HIDDEN_GROUPS_MAX);
  }
  const rawFields = raw.fields;
  if (rawFields && typeof rawFields === "object" && !Array.isArray(rawFields)) {
    const fields: Partial<LinearIssueDisplayFields> = {};
    for (const key of DISPLAY_FIELD_KEYS) {
      if (!Object.hasOwn(rawFields, key)) continue;
      const flag = (rawFields as Record<string, unknown>)[key];
      if (typeof flag === "boolean") fields[key] = flag;
    }
    if (Object.keys(fields).length > 0) patch.fields = fields;
  }
  return patch;
}

export const LINEAR_NOT_CONNECTED_DISPLAY_REASON = `Linear isn't connected, so ${BRAND.NAME} kept the change here only.`;

/**
 * What a transport answers when it has no Linear tracker to ask (no project
 * open, an older machine, ADE Cloud): Linear's defaults with the change on
 * top, marked as not saved.
 */
export function linearDisplayFallbackUpdate(
  patch: unknown,
  reason: string = LINEAR_NOT_CONNECTED_DISPLAY_REASON,
): CtoUpdateLinearViewPreferencesResult {
  return {
    preferences: applyLinearDisplayPatch(defaultLinearDisplayPreferences(), parseLinearDisplayPatch(patch)),
    savedToLinear: false,
    reason,
  };
}

/** The rail's extra lists when nothing could be read. */
export function emptyLinearRailData(): CtoLinearRailData {
  return { cycles: [], initiatives: [], favorites: [], documents: [] };
}
