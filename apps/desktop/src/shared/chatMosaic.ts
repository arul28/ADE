/**
 * Mosaic v1 — agent-emitted interactive cards.
 *
 * An agent can emit a fenced ```mosaic code block whose body is a strict,
 * versioned JSON description of a small form-like card. ADE renders it as a
 * native transcript card (desktop first); submitting serializes the user's
 * selections into a structured reply sent through the normal chat send path.
 *
 * The artifact is data, never code: no expressions, no eval, no host actions.
 * Parsing is strict — unknown version, malformed JSON, or unknown element
 * types make `parseMosaicCard` return null, and callers fall back to
 * rendering the plain code fence exactly as before.
 */

export const MOSAIC_FENCE_LANGUAGE = "mosaic";
export const MOSAIC_VERSION = 1;

export const MOSAIC_LIMITS = {
  maxElements: 24,
  maxOptions: 40,
  maxTableRows: 50,
  maxTextChars: 4000,
  maxLabelChars: 200,
  maxValueChars: 1000,
  maxSourceChars: 65536,
} as const;

export type MosaicOption = {
  value: string;
  label?: string;
};

export type MosaicTextElement = { type: "text"; text: string };
export type MosaicSelectElement = {
  type: "select";
  id: string;
  label?: string;
  options: MosaicOption[];
  /** Pre-selected option value. */
  value?: string;
};
export type MosaicMultiselectElement = {
  type: "multiselect";
  id: string;
  label?: string;
  options: MosaicOption[];
  /** Pre-selected option values. */
  values?: string[];
};
export type MosaicNumberElement = {
  type: "number";
  id: string;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  value?: number;
};
export type MosaicInputElement = {
  type: "input";
  id: string;
  label?: string;
  placeholder?: string;
  value?: string;
  maxLength?: number;
};
export type MosaicApprovalElement = {
  type: "approval";
  id: string;
  label?: string;
  approveLabel?: string;
  denyLabel?: string;
};
export type MosaicTableElement = {
  type: "table";
  rows: { key: string; value: string }[];
};

export type MosaicElement =
  | MosaicTextElement
  | MosaicSelectElement
  | MosaicMultiselectElement
  | MosaicNumberElement
  | MosaicInputElement
  | MosaicApprovalElement
  | MosaicTableElement;

export type MosaicInteractiveElement =
  | MosaicSelectElement
  | MosaicMultiselectElement
  | MosaicNumberElement
  | MosaicInputElement
  | MosaicApprovalElement;

export type MosaicCardSpec = {
  v: typeof MOSAIC_VERSION;
  title?: string;
  submitLabel?: string;
  elements: MosaicElement[];
};

/** User-entered values keyed by element id. Approval values are "approve" | "deny". */
export type MosaicValues = Record<string, string | string[] | number>;

function cleanString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOptions(raw: unknown): MosaicOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MOSAIC_LIMITS.maxOptions) return null;
  const seen = new Set<string>();
  const options: MosaicOption[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const value = cleanString(record.value, MOSAIC_LIMITS.maxValueChars);
    if (value === undefined || seen.has(value)) return null;
    seen.add(value);
    const label = cleanString(record.label, MOSAIC_LIMITS.maxLabelChars);
    options.push(label !== undefined ? { value, label } : { value });
  }
  return options;
}

function parseElement(raw: unknown): MosaicElement | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const type = record.type;
  switch (type) {
    case "text": {
      const text = cleanString(record.text, MOSAIC_LIMITS.maxTextChars);
      return text !== undefined ? { type, text } : null;
    }
    case "select":
    case "multiselect": {
      const id = cleanString(record.id, MOSAIC_LIMITS.maxLabelChars);
      const options = parseOptions(record.options);
      if (id === undefined || options === null) return null;
      const label = cleanString(record.label, MOSAIC_LIMITS.maxLabelChars);
      if (type === "select") {
        const value = cleanString(record.value, MOSAIC_LIMITS.maxValueChars);
        return {
          type,
          id,
          options,
          ...(label !== undefined ? { label } : {}),
          ...(value !== undefined && options.some((o) => o.value === value) ? { value } : {}),
        };
      }
      const values = Array.isArray(record.values)
        ? record.values
            .map((v) => cleanString(v, MOSAIC_LIMITS.maxValueChars))
            .filter((v): v is string => v !== undefined && options.some((o) => o.value === v))
        : undefined;
      return {
        type,
        id,
        options,
        ...(label !== undefined ? { label } : {}),
        ...(values && values.length > 0 ? { values } : {}),
      };
    }
    case "number": {
      const id = cleanString(record.id, MOSAIC_LIMITS.maxLabelChars);
      if (id === undefined) return null;
      const label = cleanString(record.label, MOSAIC_LIMITS.maxLabelChars);
      const min = finiteNumber(record.min);
      const max = finiteNumber(record.max);
      const step = finiteNumber(record.step);
      const value = finiteNumber(record.value);
      if (min !== undefined && max !== undefined && min >= max) return null;
      if (step !== undefined && step <= 0) return null;
      return {
        type,
        id,
        ...(label !== undefined ? { label } : {}),
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(value !== undefined ? { value } : {}),
      };
    }
    case "input": {
      const id = cleanString(record.id, MOSAIC_LIMITS.maxLabelChars);
      if (id === undefined) return null;
      const label = cleanString(record.label, MOSAIC_LIMITS.maxLabelChars);
      const placeholder = cleanString(record.placeholder, MOSAIC_LIMITS.maxLabelChars);
      const value = cleanString(record.value, MOSAIC_LIMITS.maxValueChars);
      const maxLength = finiteNumber(record.maxLength);
      return {
        type,
        id,
        ...(label !== undefined ? { label } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(maxLength !== undefined && maxLength > 0
          ? { maxLength: Math.min(Math.floor(maxLength), MOSAIC_LIMITS.maxValueChars) }
          : {}),
      };
    }
    case "approval": {
      const id = cleanString(record.id, MOSAIC_LIMITS.maxLabelChars);
      if (id === undefined) return null;
      const label = cleanString(record.label, MOSAIC_LIMITS.maxLabelChars);
      const approveLabel = cleanString(record.approveLabel, MOSAIC_LIMITS.maxLabelChars);
      const denyLabel = cleanString(record.denyLabel, MOSAIC_LIMITS.maxLabelChars);
      return {
        type,
        id,
        ...(label !== undefined ? { label } : {}),
        ...(approveLabel !== undefined ? { approveLabel } : {}),
        ...(denyLabel !== undefined ? { denyLabel } : {}),
      };
    }
    case "table": {
      if (!Array.isArray(record.rows) || record.rows.length === 0 || record.rows.length > MOSAIC_LIMITS.maxTableRows) {
        return null;
      }
      const rows: { key: string; value: string }[] = [];
      for (const entry of record.rows) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
        const row = entry as Record<string, unknown>;
        const key = cleanString(row.key, MOSAIC_LIMITS.maxLabelChars);
        const value = cleanString(row.value, MOSAIC_LIMITS.maxValueChars) ?? "";
        if (key === undefined) return null;
        rows.push({ key, value });
      }
      return { type, rows };
    }
    default:
      // Unknown element type — the whole card is invalid so the transcript
      // falls back to the plain code fence rather than silently dropping UI.
      return null;
  }
}

export function isMosaicInteractiveElement(element: MosaicElement): element is MosaicInteractiveElement {
  return element.type !== "text" && element.type !== "table";
}

/**
 * Strictly parse a ```mosaic fence body. Returns null on ANY deviation from
 * the v1 schema — callers must then render the original fence unchanged.
 */
export function parseMosaicCard(source: string): MosaicCardSpec | null {
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > MOSAIC_LIMITS.maxSourceChars) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.v !== MOSAIC_VERSION) return null;
  if (!Array.isArray(record.elements) || record.elements.length === 0 || record.elements.length > MOSAIC_LIMITS.maxElements) {
    return null;
  }
  const elements: MosaicElement[] = [];
  const ids = new Set<string>();
  for (const rawElement of record.elements) {
    const element = parseElement(rawElement);
    if (element === null) return null;
    if (isMosaicInteractiveElement(element)) {
      if (ids.has(element.id)) return null;
      ids.add(element.id);
    }
    elements.push(element);
  }
  const title = cleanString(record.title, MOSAIC_LIMITS.maxLabelChars);
  const submitLabel = cleanString(record.submitLabel, MOSAIC_LIMITS.maxLabelChars);
  return {
    v: MOSAIC_VERSION,
    ...(title !== undefined ? { title } : {}),
    ...(submitLabel !== undefined ? { submitLabel } : {}),
    elements,
  };
}

function optionLabel(options: MosaicOption[], value: string): string {
  const match = options.find((option) => option.value === value);
  return match?.label !== undefined && match.label !== match.value ? `${match.label} (${value})` : value;
}

function elementDisplayName(element: MosaicInteractiveElement): string {
  return element.label ?? element.id;
}

export type MosaicSubmission = {
  /** Message sent to the model: readable lines + a machine-readable JSON fence. */
  text: string;
  /** What the user bubble shows: readable lines only. */
  displayText: string;
};

/**
 * Serialize submitted values into the structured reply sent through the
 * existing chat send path. Only ids present in the card spec are included.
 */
export function serializeMosaicSubmission(spec: MosaicCardSpec, values: MosaicValues): MosaicSubmission {
  const lines: string[] = [];
  const structured: Record<string, string | string[] | number> = {};
  for (const element of spec.elements) {
    if (!isMosaicInteractiveElement(element)) continue;
    const value = values[element.id];
    if (value === undefined) continue;
    const name = elementDisplayName(element);
    switch (element.type) {
      case "select": {
        if (typeof value !== "string") continue;
        lines.push(`- ${name}: ${optionLabel(element.options, value)}`);
        structured[element.id] = value;
        break;
      }
      case "multiselect": {
        const selected = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
        lines.push(`- ${name}: ${selected.length > 0 ? selected.map((v) => optionLabel(element.options, v)).join(", ") : "(none)"}`);
        structured[element.id] = selected;
        break;
      }
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        lines.push(`- ${name}: ${value}`);
        structured[element.id] = value;
        break;
      }
      case "input": {
        if (typeof value !== "string") continue;
        lines.push(`- ${name}: ${value.trim() || "(empty)"}`);
        structured[element.id] = value.trim();
        break;
      }
      case "approval": {
        if (value !== "approve" && value !== "deny") continue;
        lines.push(`- ${name}: ${value === "approve" ? (element.approveLabel ?? "Approved") : (element.denyLabel ?? "Denied")}`);
        structured[element.id] = value;
        break;
      }
    }
  }
  const heading = `Answered via card${spec.title ? ` — ${spec.title}` : ""}`;
  const displayText = [heading, ...lines].join("\n");
  const machine = JSON.stringify({ mosaic: MOSAIC_VERSION, ...(spec.title ? { card: spec.title } : {}), values: structured });
  const text = `${displayText}\n\n\`\`\`json\n${machine}\n\`\`\``;
  return { text, displayText };
}

/**
 * One-line readable summary for surfaces that don't render the card
 * interactively (TUI); iOS keeps the plain fence.
 */
export function summarizeMosaicCard(spec: MosaicCardSpec): string {
  const interactive = spec.elements.filter(isMosaicInteractiveElement);
  const parts = interactive.slice(0, 4).map((element) => elementDisplayName(element));
  const more = interactive.length > 4 ? ` +${interactive.length - 4} more` : "";
  const fields = interactive.length > 0 ? ` · ${parts.join(", ")}${more}` : "";
  return `Interactive card${spec.title ? `: ${spec.title}` : ""}${fields} (answer on desktop)`;
}
