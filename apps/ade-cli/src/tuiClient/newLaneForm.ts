import type { LaneLinearIssue, LaneSummary } from "../../../desktop/src/shared/types/lanes";
import { LANE_COLOR_PALETTE } from "../../../desktop/src/shared/laneColorPalette";
import { linearIssueBranchName } from "../../../desktop/src/shared/linearIssueBranch";

/**
 * Pure model for the /new lane form — mirrors the desktop CreateLaneDialog's
 * "Start from" modes (primary base branch / start from an existing branch /
 * child of an existing lane) plus the color picker, adapted to the TUI's
 * right-pane form system. The form's field list
 * is rebuilt when the start mode cycles so each mode only shows the inputs it
 * actually uses.
 */

export type NewLaneStart = "primary" | "child" | "import";
export type NewLaneBranchSource = "remote" | "local";

/**
 * Display + cycle order of the vertical "Start from" option list. The
 * internal "import" mode value is kept for payload stability but renders as
 * "branch" (desktop calls this mode "Branch").
 */
export const NEW_LANE_START_ORDER: readonly NewLaneStart[] = ["primary", "import", "child"];

export function normalizeNewLaneStart(value: string | null | undefined): NewLaneStart {
  return value === "child" || value === "import" ? value : "primary";
}

export function cycleNewLaneStart(value: string | null | undefined, delta: number): NewLaneStart {
  const current = normalizeNewLaneStart(value);
  const index = NEW_LANE_START_ORDER.indexOf(current);
  const next = (index + delta + NEW_LANE_START_ORDER.length) % NEW_LANE_START_ORDER.length;
  return NEW_LANE_START_ORDER[next] ?? "primary";
}

export function normalizeNewLaneBranchSource(value: string | null | undefined): NewLaneBranchSource {
  return value === "local" ? "local" : "remote";
}

export function toggleNewLaneBranchSource(value: string | null | undefined): NewLaneBranchSource {
  return normalizeNewLaneBranchSource(value) === "remote" ? "local" : "remote";
}

export const NEW_LANE_START_LABEL: Record<NewLaneStart, string> = {
  primary: "primary",
  import: "branch",
  child: "child",
};

/** One-line option descriptions; each must fit next to its label at 44 cols. */
export const NEW_LANE_START_HINT: Record<NewLaneStart, string> = {
  primary: "new lane off the base branch",
  import: "start from existing branch",
  child: "stack on another lane",
};

// ---------------------------------------------------------------------------
// Color picker (desktop parity)
// ---------------------------------------------------------------------------

export type NewLaneColorOption = { hex: string | null; name: string };

/**
 * Auto (no explicit color — the lane allocator picks) plus the desktop lane
 * palette (apps/desktop/src/shared/laneColorPalette.ts, the same list
 * LaneColorPicker renders).
 */
export const NEW_LANE_COLOR_OPTIONS: readonly NewLaneColorOption[] = [
  { hex: null, name: "auto" },
  ...LANE_COLOR_PALETTE.map((entry) => ({ hex: entry.hex, name: entry.name.toLowerCase() })),
];

export function newLaneColorIndex(value: string | null | undefined): number {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return 0;
  const index = NEW_LANE_COLOR_OPTIONS.findIndex((option) => option.hex?.toLowerCase() === normalized);
  return index >= 0 ? index : 0;
}

/** Cycle the color value; "" means auto (no explicit color). */
export function cycleNewLaneColor(value: string | null | undefined, delta: number): string {
  const index = newLaneColorIndex(value);
  const next = (index + delta + NEW_LANE_COLOR_OPTIONS.length) % NEW_LANE_COLOR_OPTIONS.length;
  return NEW_LANE_COLOR_OPTIONS[next]?.hex ?? "";
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export type NewLaneFormField = {
  name: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  initialValue?: string;
};

export function newLaneFormFields(
  start: NewLaneStart,
  options: { activeLaneName?: string | null } = {},
): NewLaneFormField[] {
  const fields: NewLaneFormField[] = [
    { name: "name", label: "Name", required: true, placeholder: "feature-name" },
    { name: "color", label: "Color", initialValue: "" },
    { name: "start", label: "Start from", initialValue: start },
  ];
  if (start === "child") {
    fields.push({
      name: "parent",
      label: "Parent lane",
      placeholder: options.activeLaneName ?? "active lane",
    });
    fields.push({ name: "baseBranch", label: "Base override", placeholder: "parent branch" });
  } else if (start === "import") {
    fields.push({ name: "branchSource", label: "Source", initialValue: "remote" });
    fields.push({ name: "branch", label: "Branch", required: true, placeholder: "origin/feature-x" });
    fields.push({ name: "baseBranch", label: "Base branch", placeholder: "default" });
  } else {
    fields.push({ name: "baseBranch", label: "Base branch", placeholder: "default" });
  }
  fields.push({ name: "linearIssue", label: "Linear issue", placeholder: "ADE-123 or issue id" });
  fields.push({ name: "templateId", label: "Setup template", placeholder: "default" });
  fields.push({ name: "create", label: "Create" });
  return fields;
}

// ---------------------------------------------------------------------------
// Branch typeahead
// ---------------------------------------------------------------------------

/** Fixed number of reserved typeahead rows under the typeahead field. */
export const NEW_LANE_TYPEAHEAD_ROWS = 4;

/**
 * Which field (if any) shows the branch typeahead for the given mode:
 * the branch field in branch/import mode, the base-branch field in primary
 * mode (remote branches). Child mode has none.
 */
export function newLaneTypeaheadField(fields: ReadonlyArray<{ name: string }>): "branch" | "baseBranch" | null {
  if (fields.some((field) => field.name === "branch")) return "branch";
  if (fields.some((field) => field.name === "parent")) return null;
  return fields.some((field) => field.name === "baseBranch") ? "baseBranch" : null;
}

/**
 * Rank branch names against the typed query: prefix matches first (also
 * ignoring the "<remote>/" prefix on remote refs), then substring matches.
 * The top match is what ↹ autocompletes into the field.
 */
export function filterNewLaneBranchMatches(args: {
  branches: ReadonlyArray<{ name: string; remote: boolean }> | undefined;
  query: string;
  remote: boolean;
  limit?: number;
}): string[] {
  const limit = args.limit ?? NEW_LANE_TYPEAHEAD_ROWS;
  const query = args.query.trim().toLowerCase();
  const pool = (args.branches ?? []).filter((branch) => branch.remote === args.remote);
  if (!query) return pool.slice(0, limit).map((branch) => branch.name);
  const prefix: string[] = [];
  const substring: string[] = [];
  for (const branch of pool) {
    const name = branch.name.toLowerCase();
    const bare = branch.remote ? name.replace(/^[^/]+\//, "") : name;
    if (name.startsWith(query) || bare.startsWith(query)) prefix.push(branch.name);
    else if (name.includes(query)) substring.push(branch.name);
  }
  return [...prefix, ...substring].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Row geometry (single source of truth for NewLaneFormPane + mouse targets)
// ---------------------------------------------------------------------------

/**
 * Content-row offset of each field's LABEL line inside NewLaneFormPane, in
 * field order. Block heights: marginTop(1) + label(1) + value(1) = 3 for most
 * fields; the start block renders 3 vertical option rows under its label
 * (5 rows); the typeahead field reserves NEW_LANE_TYPEAHEAD_ROWS extra rows
 * under its value; the create block is marginTop(1) + button row (2 rows, the
 * offset points at the button). Used by the right-pane mouse hit-testing so
 * clicks land on the right field.
 */
export function newLaneFormFieldRowOffsets(fields: ReadonlyArray<{ name: string }>): number[] {
  const typeahead = newLaneTypeaheadField(fields);
  const offsets: number[] = [];
  let row = 0;
  for (const field of fields) {
    offsets.push(row + 1);
    let height = field.name === "start" ? 5 : field.name === "create" ? 2 : 3;
    if (field.name === typeahead) height += NEW_LANE_TYPEAHEAD_ROWS;
    row += height;
  }
  return offsets;
}

/**
 * Map a click row offset inside the start block (0 = label, 1..3 = options in
 * NEW_LANE_START_ORDER) onto the chosen start mode; null = no option hit.
 */
export function newLaneStartForClickRow(relY: number): NewLaneStart | null {
  return relY >= 1 && relY <= NEW_LANE_START_ORDER.length
    ? NEW_LANE_START_ORDER[relY - 1] ?? null
    : null;
}

// ---------------------------------------------------------------------------
// Create button
// ---------------------------------------------------------------------------

export type NewLaneCreateAction = {
  label: string;
  enabled: boolean;
  /** Why the button is disabled (e.g. "name required"); null when enabled. */
  reason: string | null;
};

/** Desktop-parity create button copy: "create from <resolved base>" when determinable. */
export function newLaneCreateAction(args: {
  values: Record<string, string | undefined>;
  fields: ReadonlyArray<{ name: string; placeholder?: string }>;
}): NewLaneCreateAction {
  const start = normalizeNewLaneStart(args.values.start);
  const name = args.values.name?.trim() ?? "";
  if (!name) return { label: "create lane", enabled: false, reason: "name required" };
  if (start === "import") {
    const branch = args.values.branch?.trim() ?? "";
    if (!branch) return { label: "import branch", enabled: false, reason: "branch required" };
    return { label: `import ${branch}`, enabled: true, reason: null };
  }
  if (start === "child") {
    const parent = args.values.parent?.trim()
      || args.fields.find((field) => field.name === "parent")?.placeholder
      || "";
    return { label: parent ? `create from lane ${parent}` : "create lane", enabled: true, reason: null };
  }
  const base = args.values.baseBranch?.trim() ?? "";
  return { label: base ? `create from ${base}` : "create lane", enabled: true, reason: null };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export type NewLaneSubmission =
  | {
      kind: "create";
      payload: { name: string; baseBranch?: string; branchName?: string; linearIssue?: LaneLinearIssue | null };
      color?: string;
      templateId?: string;
    }
  | {
      kind: "createChild";
      payload: {
        name: string;
        parentLaneId: string;
        baseBranchRef?: string;
        branchName?: string;
        linearIssue?: LaneLinearIssue | null;
      };
      color?: string;
      templateId?: string;
    }
  | {
      kind: "importBranch";
      payload: { branchRef: string; name: string; baseBranch?: string };
      color?: string;
      templateId?: string;
    }
  | { kind: "error"; message: string };

export function buildNewLaneSubmission(args: {
  values: Record<string, string | undefined>;
  lanes: LaneSummary[];
  activeLaneId: string | null;
  linearIssue?: LaneLinearIssue | null;
}): NewLaneSubmission {
  const start = normalizeNewLaneStart(args.values.start);
  const name = args.values.name?.trim() ?? "";
  if (!name) return { kind: "error", message: "Name is required." };
  const baseBranch = args.values.baseBranch?.trim() || undefined;
  const color = args.values.color?.trim() || undefined;
  const withColor = color ? { color } : {};
  const templateId = args.values.templateId?.trim() || undefined;
  const withTemplate = templateId ? { templateId } : {};
  const linearIssueInput = args.values.linearIssue?.trim() ?? "";
  const withLinearIssue = args.linearIssue
    ? {
        linearIssue: args.linearIssue,
        branchName: linearIssueBranchName(args.linearIssue) ?? undefined,
      }
    : {};

  if (start === "import") {
    if (linearIssueInput) {
      return {
        kind: "error",
        message: "Linear issue attachment is not supported when importing an existing branch.",
      };
    }
    // branchRef passes through as typed/picked: lane.importBranch accepts both
    // local names and remote refs ("origin/x" — and resolves bare names against
    // origin + all remotes via resolveImportBranchTarget), and listBranches
    // already returns remote branches in "<remote>/<name>" form.
    const branchRef = args.values.branch?.trim() ?? "";
    if (!branchRef) return { kind: "error", message: "Branch is required." };
    return {
      kind: "importBranch",
      payload: { branchRef, name, ...(baseBranch ? { baseBranch } : {}) },
      ...withColor,
      ...withTemplate,
    };
  }

  if (start === "child") {
    const parentInput = args.values.parent?.trim() ?? "";
    const parent = parentInput
      ? args.lanes.find((lane) => lane.id === parentInput)
        ?? args.lanes.find((lane) => lane.name.toLowerCase() === parentInput.toLowerCase())
      : args.lanes.find((lane) => lane.id === args.activeLaneId);
    if (!parent) {
      return {
        kind: "error",
        message: parentInput
          ? `No lane named "${parentInput}".`
          : "No parent lane — select a lane first or name one.",
      };
    }
    return {
      kind: "createChild",
      payload: {
        name,
        parentLaneId: parent.id,
        ...(baseBranch ? { baseBranchRef: baseBranch } : {}),
        ...withLinearIssue,
      },
      ...withColor,
      ...withTemplate,
    };
  }

  return {
    kind: "create",
    payload: {
      name,
      ...(baseBranch ? { baseBranch } : {}),
      ...withLinearIssue,
    },
    ...withColor,
    ...withTemplate,
  };
}
