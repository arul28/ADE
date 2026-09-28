import type { PendingInputQuestion } from "../../../shared/types";

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function enumOptions(property: Record<string, unknown>): Array<{ label: string; value: string }> {
  const directValues = Array.isArray(property.enum) ? property.enum : [];
  const directLabels = Array.isArray(property.enumNames) ? property.enumNames : [];
  if (directValues.length) {
    return directValues.flatMap((value, index) => {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return [];
      return [{
        label: readString(directLabels[index]) ?? String(value),
        value: String(value),
      }];
    });
  }

  const itemSchema = readRecord(property.items);
  const alternatives = Array.isArray(property.oneOf)
    ? property.oneOf
    : Array.isArray(itemSchema?.anyOf)
      ? itemSchema.anyOf
      : Array.isArray(itemSchema?.oneOf)
        ? itemSchema.oneOf
        : null;
  if (alternatives) {
    return alternatives.flatMap((entry) => {
      const option = readRecord(entry);
      const value = option?.const;
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return [];
      return [{ label: readString(option?.title) ?? String(value), value: String(value) }];
    });
  }

  const itemValues = Array.isArray(itemSchema?.enum) ? itemSchema.enum : [];
  return itemValues.flatMap((value) => (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [{ label: String(value), value: String(value) }]
      : []
  ));
}

export function mcpElicitationAllowsAlways(meta: unknown): boolean {
  const persist = readRecord(meta)?.persist;
  return persist === "always"
    || (Array.isArray(persist) && persist.some((value) => value === "always"));
}

function mcpElicitationOffersPersist(meta: unknown, scope: "session" | "always"): boolean {
  const persist = readRecord(meta)?.persist;
  return persist === scope
    || (Array.isArray(persist) && persist.some((value) => value === scope));
}

/**
 * What an "allow for this session" answer sends back as `_meta.persist`.
 *
 * Codex offers the scopes it will honor in the request's `_meta.persist`.
 * Its MCP tool approvals offer both, `["session", "always"]`, and `"always"`
 * writes the approval into the user's config.toml for every future chat — far
 * more than a session-scoped answer asked for. So `"session"` wins whenever it
 * is offered. `"always"` is used only when it is the one scope on offer (the
 * Computer Use per-app prompt), because remembering nothing would make the
 * session-scoped button behave exactly like a one-time allow.
 */
export function mcpElicitationSessionPersistScope(...metas: unknown[]): "session" | "always" | null {
  if (metas.some((meta) => mcpElicitationOffersPersist(meta, "session"))) return "session";
  if (metas.some((meta) => mcpElicitationOffersPersist(meta, "always"))) return "always";
  return null;
}

/** `Allow the <server> MCP server to run tool "<tool>"?` — Codex 0.156.1's wording. */
const CODEX_MCP_TOOL_APPROVAL_MESSAGE = /\brun tool "(.+)"\?\s*$/s;

/**
 * Recognize Codex's own MCP tool-call approval among its elicitations, and
 * name the tool it is about.
 *
 * Codex 0.156.1 asks before an MCP tool call by sending
 * `mcpServer/elicitation/request` with `_meta.codex_approval_kind:
 * "mcp_tool_call"` and an empty form schema (measured against a live
 * app-server). The payload carries `tool_title`, `tool_description`, and
 * `tool_params`, but not the tool's NAME — the title is display text a server
 * chooses freely, so it is never matched against a policy. The name is in the
 * message, `Allow the <server> MCP server to run tool "<name>"?`, and that is
 * where it is read from. A `tool_name` key is honored first in case a later
 * Codex adds one.
 *
 * Returns null for any other elicitation (a server's own form, a URL auth
 * prompt). `toolName` is null when the kind matched but the name could not be
 * read — an app connector's approval uses different wording — and the caller
 * then judges the request on its server alone.
 */
export function codexMcpToolApproval(params: unknown): { toolName: string | null } | null {
  const record = readRecord(params);
  const meta = readRecord(record?._meta) ?? readRecord(record?.meta);
  if (readString(meta?.codex_approval_kind) !== "mcp_tool_call") return null;
  const explicit = readString(meta?.tool_name);
  if (explicit) return { toolName: explicit };
  const message = typeof record?.message === "string" ? record.message : "";
  const quoted = CODEX_MCP_TOOL_APPROVAL_MESSAGE.exec(message)?.[1]?.trim();
  return { toolName: quoted && quoted.length ? quoted : null };
}

export function mcpElicitationQuestions(schemaValue: unknown): PendingInputQuestion[] {
  const schema = readRecord(schemaValue);
  const properties = readRecord(schema?.properties);
  if (!properties) return [];
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  return Object.entries(properties).flatMap(([id, propertyValue]) => {
    const property = readRecord(propertyValue);
    if (!property) return [];
    const title = readString(property.title) ?? id;
    const description = readString(property.description);
    const propertyOptions = enumOptions(property);
    const options = propertyOptions.length
      ? propertyOptions
      : property.type === "boolean"
        ? [
            { label: "Yes", value: "true" },
            { label: "No", value: "false" },
          ]
        : null;
    return [{
      id,
      header: title,
      question: description ?? title,
      ...(options ? { options } : {}),
      ...(property.type === "array" ? { multiSelect: true } : {}),
      allowsFreeform: options == null,
      isSecret: property.format === "password",
      impact: required.has(id) ? "Required" : null,
    } satisfies PendingInputQuestion];
  });
}

function coerceMcpElicitationValue(value: string, property: Record<string, unknown> | null): unknown {
  if (property?.type === "boolean") return value.toLowerCase() === "true";
  if (property?.type === "integer") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (property?.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (property?.type === "object" || property?.type === "array") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function mcpElicitationContent(
  schemaValue: Record<string, unknown> | null | undefined,
  answers: Record<string, string | string[]> | undefined,
  responseText: string | null | undefined,
): Record<string, unknown> {
  const properties = readRecord(schemaValue?.properties) ?? {};
  const entries = Object.entries(properties);
  const content: Record<string, unknown> = {};
  for (const [id, propertyValue] of entries) {
    const raw = answers?.[id];
    const property = readRecord(propertyValue);
    if (property?.type === "array") {
      const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : null;
      if (values) {
        const itemSchema = readRecord(property.items);
        content[id] = values
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .map((value) => coerceMcpElicitationValue(value, itemSchema));
      }
      continue;
    }
    const value = Array.isArray(raw) ? raw.at(-1) : raw;
    if (typeof value !== "string") continue;
    content[id] = coerceMcpElicitationValue(value, property);
  }
  if (entries.length === 1 && Object.keys(content).length === 0 && responseText?.trim()) {
    const [id, propertyValue] = entries[0]!;
    content[id] = coerceMcpElicitationValue(responseText.trim(), readRecord(propertyValue));
  }
  return content;
}
