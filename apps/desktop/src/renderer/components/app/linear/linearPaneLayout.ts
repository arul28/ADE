import type { LinearIssueDisplayFields } from "../../../../shared/types";

/** Hides low-value chips first as the list column narrows; the title never wraps. */
export function fieldsForWidth(fields: LinearIssueDisplayFields, width: number): LinearIssueDisplayFields {
  if (width <= 0 || width >= 980) return fields;
  const next = { ...fields };
  if (width < 980) next.estimate = false;
  if (width < 880) { next.milestone = false; next.cycle = false; }
  if (width < 820) next.project = false;
  if (width < 660) { next.labels = false; next.updatedAt = false; next.dueDate = false; }
  if (width < 560) next.createdAt = false;
  if (width < 480) { next.pullRequests = false; next.adeStatus = false; }
  return next;
}

/** Column widths for the window: rail, list, details. Narrow windows show the list alone. */
export function paneColumns(width: number): { rail: number; detail: number; narrow: boolean } {
  if (width > 0 && width < 760) return { rail: 0, detail: 0, narrow: true };
  if (width < 1100) return { rail: 200, detail: 380, narrow: false };
  if (width < 1400) return { rail: 224, detail: 420, narrow: false };
  if (width < 1700) return { rail: 240, detail: 480, narrow: false };
  return { rail: 256, detail: 540, narrow: false };
}
