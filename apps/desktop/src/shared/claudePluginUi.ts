/**
 * Claude mod UI: what Claude Code plugins with a hooks module ("mods") draw for
 * a chat. A mod draws status lines (`$.ui.status`), toasts (`$.ui.toast`), a
 * band above the prompt and panes (`ui.render` hooks).
 *
 * A headless Claude session still sends that UI to its host. The channel is
 * private to Claude Code (untyped in the Agent SDK, early access), so every
 * shape here is read defensively: the host sanitizes each tree into the types
 * below before any client sees it, and a client draws only what it knows.
 *
 * Everything here is pure so the host, the renderer and the tests share it.
 */

/** The mod UI actions, in every list that must name them (policy, preload, RPC guard, mobile). */
export const CLAUDE_PLUGIN_UI_ACTION_NAMES = [
  "getClaudePluginUi",
  "actOnClaudePluginUi",
] as const;

/** Terminal columns the band is laid out for; clients scale the font to fit. */
export const CLAUDE_PLUGIN_UI_BAND_COLUMNS = 100;
export const CLAUDE_PLUGIN_UI_BAND_ROWS = 12;
/** Terminal columns and rows a pane is laid out for. ADE seats a pane above the prompt. */
export const CLAUDE_PLUGIN_UI_PANE_COLUMNS = 100;
export const CLAUDE_PLUGIN_UI_PANE_ROWS = 20;

export const MAX_CLAUDE_PLUGIN_UI_STATUSES = 8;
export const MAX_CLAUDE_PLUGIN_UI_PANES = 4;
export const MAX_CLAUDE_PLUGIN_UI_TEXT_CHARS = 2_000;
export const MAX_CLAUDE_PLUGIN_UI_INPUT_CHARS = 16_384;
const MAX_TREE_NODES = 1_500;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_CHARS = 40_000;
const MAX_NAME_CHARS = 128;
const MAX_HREF_CHARS = 2_048;
const MAX_SELECT_OPTIONS = 64;

/** Where an element's handler lives, as Claude Code stamped it. An action names it back. */
export type ClaudePluginUiTarget = { plugin: string; handle: number };

export type ClaudePluginUiElementType =
  | "Box"
  | "Text"
  | "Button"
  | "Link"
  | "Code"
  | "Markdown"
  | "Input"
  | "Select";

export type ClaudePluginUiPropValue =
  | string
  | number
  | boolean
  | Array<{ value: string; label: string }>;

export type ClaudePluginUiElement = {
  type: ClaudePluginUiElementType;
  props: Record<string, ClaudePluginUiPropValue>;
  /** Present on a Button, Input or Select the user may act on. */
  target?: ClaudePluginUiTarget;
  children?: ClaudePluginUiNode[];
};

export type ClaudePluginUiNode = string | ClaudePluginUiElement;

export type ClaudePluginUiStatus = { plugin: string; text: string };

export type ClaudePluginUiToast = { id: string; plugin: string; text: string; timeoutMs: number };

export type ClaudePluginUiPane = {
  id: string;
  title: string;
  plugin: string;
  tree: ClaudePluginUiElement | null;
};

export type ClaudePluginUiSnapshot = {
  /** False once the Claude process that drew this is gone: shown, but nothing can be pressed. */
  live: boolean;
  /** One per Claude process. An action must name the generation that drew its control. */
  generation: number;
  /** Bumped on every change, so a slow read cannot overwrite a newer push. */
  revision: number;
  statuses: ClaudePluginUiStatus[];
  /** The latest toast; clients show each `id` once. */
  toast: ClaudePluginUiToast | null;
  band: ClaudePluginUiElement | null;
  panes: ClaudePluginUiPane[];
};

export const EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT: ClaudePluginUiSnapshot = {
  live: false,
  generation: 0,
  revision: 0,
  statuses: [],
  toast: null,
  band: null,
  panes: [],
};

export type ClaudePluginUiGetArgs = { sessionId: string };

export type ClaudePluginUiActArgs = {
  sessionId: string;
  generation: number;
} & (
  | { kind: "press"; target: ClaudePluginUiTarget; key?: string }
  | { kind: "input"; target: ClaudePluginUiTarget; key?: string; value: string; site: ClaudePluginUiSite }
  | { kind: "select"; target: ClaudePluginUiTarget; key?: string; value: string; site: ClaudePluginUiSite }
  | { kind: "closePane"; paneId: string }
);

/** The render site a control was drawn in: the band, or one pane by id. */
export type ClaudePluginUiSite = { component: "AbovePrompt" } | { component: "Pane"; paneId: string };

export type ClaudePluginUiActResult = { handled: boolean };

export function claudePluginUiHasContent(snapshot: ClaudePluginUiSnapshot | null | undefined): boolean {
  return Boolean(snapshot && (snapshot.band || snapshot.statuses.length || snapshot.panes.length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text without control characters (tabs and newlines stay), cut to `max`. */
export function cleanClaudePluginUiText(value: unknown, max = MAX_CLAUDE_PLUGIN_UI_TEXT_CHARS): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "");
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** Only web links open from a mod's tree. */
export function safeClaudePluginUiHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_HREF_CHARS) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeClaudePluginUiTarget(value: unknown): ClaudePluginUiTarget | null {
  if (!isRecord(value)) return null;
  const plugin = typeof value.plugin === "string" ? value.plugin : "";
  const handle = value.handle;
  if (!plugin || plugin.length > MAX_NAME_CHARS) return null;
  if (typeof handle !== "number" || !Number.isSafeInteger(handle)) return null;
  return { plugin, handle };
}

const STRING_PROPS: Record<ClaudePluginUiElementType, readonly string[]> = {
  Box: [
    "key", "flexDirection", "flexWrap", "alignItems", "alignSelf", "justifyContent", "display",
    "borderStyle", "borderColor", "backgroundColor", "width", "height", "minWidth",
  ],
  Text: ["color", "backgroundColor", "wrap"],
  Button: ["key", "label", "variant", "role", "hotkey"],
  Link: ["label"],
  Code: ["source", "language", "path", "format"],
  Markdown: ["key", "text"],
  Input: ["key", "label", "placeholder", "value", "submitLabel"],
  Select: ["key", "label", "value"],
};

const NUMBER_PROPS: Record<ClaudePluginUiElementType, readonly string[]> = {
  Box: [
    "gap", "columnGap", "rowGap", "padding", "paddingX", "paddingY", "paddingLeft", "paddingRight",
    "paddingTop", "paddingBottom", "margin", "marginX", "marginY", "marginLeft", "marginRight",
    "marginTop", "marginBottom", "width", "height", "minWidth", "minHeight", "flexGrow", "flexShrink",
  ],
  Text: [],
  Button: [],
  Link: [],
  Code: ["startLine"],
  Markdown: [],
  Input: [],
  Select: [],
};

const BOOLEAN_PROPS: Record<ClaudePluginUiElementType, readonly string[]> = {
  Box: [],
  Text: ["bold", "italic", "underline", "strikethrough", "dimColor", "inverse"],
  Button: ["plain", "dimColor"],
  Link: [],
  Code: ["wrap"],
  Markdown: ["dimColor"],
  Input: [],
  Select: [],
};

/** Longer text a prop may carry; every other string prop is a short name. */
const LONG_STRING_PROPS = new Set(["source", "text", "value", "label", "placeholder"]);

/** Element names other surfaces use for what this one draws as a Box or Text. */
const TYPE_ALIASES: Record<string, ClaudePluginUiElementType> = { div: "Box", span: "Text", b: "Text" };

type SanitizeBudget = { nodes: number; chars: number; targets: ClaudePluginUiTarget[] };

function sanitizeProps(type: ClaudePluginUiElementType, raw: Record<string, unknown>, budget: SanitizeBudget): Record<string, ClaudePluginUiPropValue> {
  const props: Record<string, ClaudePluginUiPropValue> = {};
  for (const name of STRING_PROPS[type]) {
    const value = raw[name];
    if (typeof value !== "string") continue;
    const long = LONG_STRING_PROPS.has(name);
    const room = Math.max(0, MAX_TREE_CHARS - budget.chars);
    const cleaned = cleanClaudePluginUiText(value, long ? Math.min(room, MAX_TREE_CHARS) : MAX_NAME_CHARS);
    if (long) budget.chars += cleaned.length;
    props[name] = cleaned;
  }
  for (const name of NUMBER_PROPS[type]) {
    const value = raw[name];
    if (typeof value === "number" && Number.isFinite(value)) props[name] = Math.max(-512, Math.min(512, value));
  }
  for (const name of BOOLEAN_PROPS[type]) {
    if (raw[name] === true) props[name] = true;
  }
  if (type === "Link") {
    const href = safeClaudePluginUiHref(raw.href);
    if (href) props.href = href;
  }
  if (type === "Select" && Array.isArray(raw.options)) {
    const options: Array<{ value: string; label: string }> = [];
    for (const option of raw.options.slice(0, MAX_SELECT_OPTIONS)) {
      if (typeof option === "string") {
        options.push({ value: option.slice(0, MAX_NAME_CHARS), label: cleanClaudePluginUiText(option, MAX_NAME_CHARS) });
      } else if (isRecord(option) && typeof option.value === "string") {
        options.push({
          value: option.value.slice(0, MAX_CLAUDE_PLUGIN_UI_INPUT_CHARS),
          label: cleanClaudePluginUiText(typeof option.label === "string" ? option.label : option.value, MAX_NAME_CHARS),
        });
      }
    }
    props.options = options;
  }
  return props;
}

function sanitizeNode(raw: unknown, depth: number, budget: SanitizeBudget): ClaudePluginUiNode | null {
  if (budget.nodes >= MAX_TREE_NODES || budget.chars >= MAX_TREE_CHARS) return null;
  if (typeof raw === "string" || typeof raw === "number") {
    const text = cleanClaudePluginUiText(String(raw), MAX_TREE_CHARS - budget.chars);
    budget.chars += text.length;
    return text;
  }
  if (!isRecord(raw) || typeof raw.type !== "string" || depth > MAX_TREE_DEPTH) return null;
  const type = (TYPE_ALIASES[raw.type] ?? raw.type) as ClaudePluginUiElementType;
  if (!Object.hasOwn(STRING_PROPS, type)) {
    // Svg, Client, Raster, Image: not drawn. An `alt` is the mod's own stand-in.
    const alt = isRecord(raw.props) ? cleanClaudePluginUiText(raw.props.alt, MAX_NAME_CHARS) : "";
    return alt || null;
  }
  budget.nodes += 1;
  const rawProps = isRecord(raw.props) ? raw.props : {};
  const props = sanitizeProps(type, rawProps, budget);
  if (raw.type === "b") props.bold = true;
  const element: ClaudePluginUiElement = { type, props };
  if (type === "Button" || type === "Input" || type === "Select") {
    const target = normalizeClaudePluginUiTarget(raw.press);
    if (target) {
      element.target = target;
      budget.targets.push(target);
    }
  }
  if (Array.isArray(raw.children) && (type === "Box" || type === "Text" || type === "Link")) {
    const children: ClaudePluginUiNode[] = [];
    for (const child of raw.children) {
      const node = sanitizeNode(child, depth + 1, budget);
      if (node !== null && node !== "") children.push(node);
    }
    if (children.length) element.children = children;
  }
  return element;
}

/**
 * A tree a client may draw: known elements and props only, bounded in size,
 * with every actionable control's target listed so the host can refuse an
 * action that names a control it never sent.
 */
export function sanitizeClaudePluginUiTree(raw: unknown): { tree: ClaudePluginUiElement | null; targets: ClaudePluginUiTarget[] } {
  const budget: SanitizeBudget = { nodes: 0, chars: 0, targets: [] };
  const node = sanitizeNode(raw, 0, budget);
  return { tree: node && typeof node !== "string" ? node : null, targets: budget.targets };
}
