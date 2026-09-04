import {
  PLUGIN_CHAT_PERMISSION_FAMILIES,
  pluginChatModelCapabilities,
  pluginChatProviderCapabilities,
  type PluginChatPermissionFamily,
} from "../../../../shared/plugins/chatCapabilities";

export const PLUGIN_WEBVIEW_PICKER_VERBS = [
  "ui.pickModel",
  "ui.pickLane",
  "ui.pickPermissionMode",
  "ui.pickReasoningEffort",
  "ui.pickProvider",
] as const;

export type PluginWebviewPickerVerb = (typeof PLUGIN_WEBVIEW_PICKER_VERBS)[number];

export function isPluginWebviewPickerVerb(value: unknown): value is PluginWebviewPickerVerb {
  return PLUGIN_WEBVIEW_PICKER_VERBS.some((verb) => verb === value);
}

/**
 * Map a page's `provider` onto ADE's permission family.
 *
 * Pages may send either the permission-group name (`claude`) or the model
 * registry family (`anthropic`). Both name the same pill, and refusing one
 * because of the other would make `chat.capabilities()` and `ui.pickPermissionMode`
 * disagree about a provider the reader just picked.
 */
export function resolvePluginWebviewPermissionFamily(
  provider: unknown,
): PluginChatPermissionFamily | null {
  if (typeof provider !== "string") return null;
  const key = provider.trim().toLowerCase();
  if (!key) return null;
  if (key === "anthropic" || key === "claude") return "claude";
  if (key === "openai" || key === "codex") return "codex";
  if (key === "factory" || key === "droid") return "droid";
  return PLUGIN_CHAT_PERMISSION_FAMILIES.find((family) => family === key) ?? null;
}

/**
 * A sentence the page hears instead of `null` when this client cannot ask.
 *
 * `null` is "the reader walked away". These are "nobody was asked".
 */
export function refusePluginWebviewPicker(
  verb: PluginWebviewPickerVerb,
  args: Record<string, unknown>,
): string | null {
  switch (verb) {
    case "ui.pickPermissionMode":
      return resolvePluginWebviewPermissionFamily(args.provider)
        ? null
        : "ADE doesn’t have a permission control for that provider.";
    case "ui.pickReasoningEffort":
      return typeof args.model === "string" && args.model.trim().length > 0
        ? null
        : "ADE needs a model to open that reasoning control.";
    case "ui.pickModel":
    case "ui.pickLane":
    case "ui.pickProvider":
      return null;
    default: {
      const unknown: never = verb;
      return `This window can’t do “${String(unknown)}”.`;
    }
  }
}

/**
 * True when the contract answers null without drawing a control.
 *
 * A model with no reasoning ladder must not open an empty picker. Unknown
 * models still open ADE's own control: the runtime catalog may know a ladder
 * this process's static table does not.
 */
export function pluginWebviewPickerImmediateNull(
  verb: PluginWebviewPickerVerb,
  args: Record<string, unknown>,
): boolean {
  if (verb !== "ui.pickReasoningEffort") return false;
  const modelId = typeof args.model === "string" ? args.model.trim() : "";
  if (!modelId) return false;
  const capability = pluginChatModelCapabilities().find((entry) => entry.id === modelId);
  return Boolean(capability && capability.reasoningEfforts.length === 0);
}

export function pluginWebviewPermissionField(family: PluginChatPermissionFamily): string {
  return pluginChatProviderCapabilities().find((entry) => entry.provider === family)?.permissionField
    ?? family;
}
