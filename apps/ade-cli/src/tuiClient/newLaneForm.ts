import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";

/**
 * Pure model for the /new lane form — mirrors the desktop CreateLaneDialog's
 * "Start from" modes (primary base branch / child of an existing lane /
 * import an existing branch) plus the runtime placement choice, adapted to
 * the TUI's right-pane form system. The form's field list is rebuilt when the
 * start mode cycles so each mode only shows the inputs it actually uses.
 */

export type NewLaneStart = "primary" | "child" | "import";
export type NewLaneRuntime = "local" | "macos-vm";

const NEW_LANE_STARTS: NewLaneStart[] = ["primary", "child", "import"];

export function normalizeNewLaneStart(value: string | null | undefined): NewLaneStart {
  return value === "child" || value === "import" ? value : "primary";
}

export function cycleNewLaneStart(value: string | null | undefined, delta: number): NewLaneStart {
  const current = normalizeNewLaneStart(value);
  const index = NEW_LANE_STARTS.indexOf(current);
  const next = (index + delta + NEW_LANE_STARTS.length) % NEW_LANE_STARTS.length;
  return NEW_LANE_STARTS[next] ?? "primary";
}

export function normalizeNewLaneRuntime(value: string | null | undefined): NewLaneRuntime {
  return value === "macos-vm" ? "macos-vm" : "local";
}

export function toggleNewLaneRuntime(value: string | null | undefined): NewLaneRuntime {
  return normalizeNewLaneRuntime(value) === "local" ? "macos-vm" : "local";
}

export const NEW_LANE_START_LABEL: Record<NewLaneStart, string> = {
  primary: "base branch",
  child: "child of lane",
  import: "import branch",
};

export const NEW_LANE_START_HINT: Record<NewLaneStart, string> = {
  primary: "new branch off the project base",
  child: "stack on top of another lane",
  import: "adopt an existing local/remote branch",
};

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
    fields.push({ name: "branch", label: "Branch to import", required: true, placeholder: "origin/feature-x" });
    fields.push({ name: "baseBranch", label: "Base branch", placeholder: "default" });
  } else {
    fields.push({ name: "baseBranch", label: "Base branch", placeholder: "default" });
  }
  if (start !== "import") {
    fields.push({ name: "runtime", label: "Runtime", initialValue: "local" });
  }
  return fields;
}

/**
 * Content-row offset of each field's LABEL line inside NewLaneFormPane,
 * in field order. Every block renders marginTop(1) + label(1) + value(1),
 * except the start block which adds a hint line (4 rows total). Used by the
 * right-pane mouse hit-testing so clicks land on the right field.
 */
export function newLaneFormFieldRowOffsets(fields: ReadonlyArray<{ name: string }>): number[] {
  const offsets: number[] = [];
  let row = 0;
  for (const field of fields) {
    offsets.push(row + 1);
    row += field.name === "start" ? 4 : 3;
  }
  return offsets;
}

/** Map a click X offset on the start-chip row onto the chosen start mode. */
export function newLaneStartForClickX(relX: number): NewLaneStart {
  // Row text: `  [base branch] child of lane  import branch`
  if (relX < 16) return "primary";
  if (relX < 31) return "child";
  return "import";
}

export type NewLaneSubmission =
  | { kind: "create"; payload: { name: string; baseBranch?: string; runtimePlacement?: NewLaneRuntime } }
  | {
      kind: "createChild";
      payload: { name: string; parentLaneId: string; baseBranchRef?: string; runtimePlacement?: NewLaneRuntime };
    }
  | { kind: "importBranch"; payload: { branchRef: string; name: string; baseBranch?: string } }
  | { kind: "error"; message: string };

export function buildNewLaneSubmission(args: {
  values: Record<string, string | undefined>;
  lanes: LaneSummary[];
  activeLaneId: string | null;
}): NewLaneSubmission {
  const start = normalizeNewLaneStart(args.values.start);
  const name = args.values.name?.trim() ?? "";
  if (!name) return { kind: "error", message: "Name is required." };
  const baseBranch = args.values.baseBranch?.trim() || undefined;
  const runtimePlacement = normalizeNewLaneRuntime(args.values.runtime);

  if (start === "import") {
    const branchRef = args.values.branch?.trim() ?? "";
    if (!branchRef) return { kind: "error", message: "Branch to import is required." };
    return {
      kind: "importBranch",
      payload: { branchRef, name, ...(baseBranch ? { baseBranch } : {}) },
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
        ...(runtimePlacement === "macos-vm" ? { runtimePlacement } : {}),
      },
    };
  }

  return {
    kind: "create",
    payload: {
      name,
      ...(baseBranch ? { baseBranch } : {}),
      ...(runtimePlacement === "macos-vm" ? { runtimePlacement } : {}),
    },
  };
}
