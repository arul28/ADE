/**
 * ADE-facing Cursor chat selections and labels.
 *
 * Both AgentChatPane (fallback snapshot) and AgentChatComposer (mode labels)
 * must reference the same set. Import from here instead of hardcoding.
 */

/** The set of Cursor selections exposed to the user in the mode picker. */
export const CURSOR_AVAILABLE_MODE_IDS = ["agent", "ask", "plan", "full-auto"] as const;

export type CursorModeId = (typeof CURSOR_AVAILABLE_MODE_IDS)[number];

/** Human-readable labels for Cursor mode IDs (includes aliases like "default"). */
export const CURSOR_MODE_LABELS: Record<string, string> = {
  agent: "Agent",
  default: "Agent",
  ask: "Ask",
  plan: "Plan",
  "full-auto": "Full auto",
  debug: "Debug",
};

/** The Cursor mode a session runs in when it names none. */
export const CURSOR_DEFAULT_MODE_ID = "agent" satisfies CursorModeId;

/** Format provider-returned Cursor mode ids consistently across every surface. */
export function formatCursorModeLabel(modeId: string): string {
  const normalized = modeId.trim().toLowerCase();
  if (!normalized.length) return CURSOR_MODE_LABELS.agent;
  if (CURSOR_MODE_LABELS[normalized]) return CURSOR_MODE_LABELS[normalized];
  return normalized
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * The ADE-facing Cursor selection a legacy `permissionMode` asks for, or `null` when it
 * asks for nothing Cursor names.
 *
 * `full-auto` and `plan` are ADE selections; the provider SDK still receives
 * its supported execution mode separately. Leaving `cursorModeId` empty made a
 * `--permissions full-auto` child report `agent` in its mode snapshot.
 *
 * `default` and `edit` both run as Cursor `agent`, and `ask` is a deliberate
 * user choice with no legacy spelling. Returning `null` for them keeps absence
 * absent: a materialised `agent` here is read back as a real selection on the
 * next launch and pins the session to it. That is the durable-pin bug the
 * Droid and Claude native controls carry the same warning about.
 */
/**
 * Full Auto and Plan chosen on a Cursor SDK model used to be stored on the
 * OpenCode permission slot. Launch still honors those two values when the
 * Cursor slot itself is empty.
 */
export function cursorPermissionFromMisfiledOpenCode(
  mode: string | null | undefined,
): "full-auto" | "plan" | null {
  if (mode === "full-auto" || mode === "plan") return mode;
  return null;
}

export function legacyPermissionModeToCursorModeId(
  mode: string | null | undefined,
): CursorModeId | null {
  if (mode === "full-auto") return "full-auto";
  if (mode === "plan") return "plan";
  return null;
}

/**
 * The Cursor mode a session presents, resolving the empty case to the default.
 * Use for display and preview; use `legacyPermissionModeToCursorModeId` when
 * deciding what to persist.
 */
export function effectiveCursorModeId(
  cursorModeId: string | null | undefined,
  permissionMode?: string | null,
): string {
  const explicit = typeof cursorModeId === "string" ? cursorModeId.trim() : "";
  if (explicit.length) return explicit;
  return legacyPermissionModeToCursorModeId(permissionMode) ?? CURSOR_DEFAULT_MODE_ID;
}

/**
 * Cursor's Fast toggle, as older builds stored it: a model option
 * (`cursorConfigValues.fast`) rendered as a loose prompt-box control. Fast is
 * now the model's speed tier, carried by the chat's `fastMode` like every other
 * provider's Fast chip.
 */
function isLegacyCursorFastConfigKey(key: string): boolean {
  return /^fast(?:[_-]?mode)?$/i.test(key.trim());
}

function legacyCursorFastConfigBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(normalized)) return true;
  if (["false", "off", "no", "0"].includes(normalized)) return false;
  return null;
}

/**
 * Fold a stored Cursor Fast option into `fastMode`.
 *
 * An explicit stored value wins over `fastMode`: the old Fast chip never showed
 * for these models, so the option was the user's only way to pick. The option
 * key is dropped either way, so it can never again reach Cursor as a config
 * value that overrides the Fast chip. Returns the inputs unchanged when there
 * is no Fast option to fold.
 */
export function foldLegacyCursorFastConfigValue<V>(
  fastMode: boolean | null | undefined,
  configValues: Readonly<Record<string, V>> | null | undefined,
): { fastMode: boolean | null | undefined; configValues: Record<string, V> | null | undefined; folded: boolean } {
  if (!configValues) return { fastMode, configValues: configValues as Record<string, V> | null | undefined, folded: false };
  const keys = Object.keys(configValues).filter(isLegacyCursorFastConfigKey);
  if (!keys.length) return { fastMode, configValues: configValues as Record<string, V>, folded: false };
  let nextFastMode = fastMode;
  const kept: Record<string, V> = {};
  for (const [key, value] of Object.entries(configValues)) {
    if (!isLegacyCursorFastConfigKey(key)) {
      kept[key] = value;
      continue;
    }
    const parsed = legacyCursorFastConfigBoolean(value);
    if (parsed != null) nextFastMode = parsed;
  }
  return {
    fastMode: nextFastMode,
    configValues: Object.keys(kept).length ? kept : undefined,
    folded: true,
  };
}
