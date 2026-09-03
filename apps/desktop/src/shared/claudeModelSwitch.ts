/**
 * Quiet model-switch divider copy and PostModelSwitch additionalContext.
 * Replaces the inference that PR #1197 fought (alias forwarding clobbering
 * the session model).
 */

export type ClaudeModelSwitchArgs = {
  fromModel?: string | null;
  toModel?: string | null;
  requestedModel?: string | null;
};

function compact(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length ? text : null;
}

export function claudeModelSwitchDividerMessage(args: ClaudeModelSwitchArgs): string {
  const toModel = compact(args.toModel) ?? "the incoming model";
  const requested = compact(args.requestedModel);
  return requested
    ? `switched to ${toModel} · requested "${requested}"`
    : `switched to ${toModel}`;
}

export function claudeModelSwitchAdditionalContext(args: ClaudeModelSwitchArgs): string {
  const fromModel = compact(args.fromModel);
  const requested = compact(args.requestedModel);
  const inherited = fromModel
    ? `You inherited this conversation from ${fromModel}.`
    : "You inherited this conversation.";
  const request = requested
    ? ` The user requested ${requested}.`
    : "";
  return `${inherited}${request} Continue from the existing thread; do not restart completed work.`;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Reads snake_case or camelCase PostModelSwitch payload fields. */
export function parseClaudeModelSwitchArgs(input: unknown): ClaudeModelSwitchArgs {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  return {
    fromModel: stringField(record, "from_model", "fromModel"),
    toModel: stringField(record, "to_model", "toModel"),
    requestedModel: stringField(record, "requested_model", "requestedModel"),
  };
}
