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

/** The mod UI actions, in every list that must name them (policy, preload, RPC guard). */
export const CLAUDE_PLUGIN_UI_ACTION_NAMES = [
  "getClaudePluginUi",
  "actOnClaudePluginUi",
] as const;

/** Terminal columns and rows the band is laid out for; clients scale the font to fit. */
export const CLAUDE_PLUGIN_UI_BAND_COLUMNS = 100;
export const CLAUDE_PLUGIN_UI_BAND_ROWS = 12;
/** Terminal columns and rows a pane is laid out for. ADE seats a pane above the prompt. */
export const CLAUDE_PLUGIN_UI_PANE_COLUMNS = 100;
export const CLAUDE_PLUGIN_UI_PANE_ROWS = 20;

export const MAX_CLAUDE_PLUGIN_UI_STATUSES = 8;
export const MAX_CLAUDE_PLUGIN_UI_PANES = 4;
export const MAX_CLAUDE_PLUGIN_UI_INPUT_CHARS = 16_384;
const MAX_TEXT_CHARS = 2_000;
const MAX_TREE_NODES = 1_500;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_CHARS = 40_000;
const MAX_NAME_CHARS = 128;
const MAX_HREF_CHARS = 2_048;
const MAX_SELECT_OPTIONS = 64;

/** Where an element's handler lives, as Claude Code stamped it. An action names it back. */
export type ClaudePluginUiTarget = { plugin: string; handle: number };

type ElementType = "Box" | "Text" | "Button" | "Link" | "Code" | "Markdown" | "Input" | "Select";

export type ClaudePluginUiPropValue =
  | string
  | number
  | boolean
  | Array<{ value: string; label: string }>;

export type ClaudePluginUiElement = {
  type: ElementType;
  props: Record<string, ClaudePluginUiPropValue>;
  /** Present on a Button, Input or Select the user may act on. */
  target?: ClaudePluginUiTarget;
  children?: ClaudePluginUiNode[];
};

export type ClaudePluginUiNode = string | ClaudePluginUiElement;

type Status = { plugin: string; text: string };

type Toast = { id: string; plugin: string; text: string; timeoutMs: number };

type Pane = {
  id: string;
  title: string;
  plugin: string;
  tree: ClaudePluginUiElement | null;
};

export type ClaudePluginUiSnapshot = {
  /** True while the Claude process that drew this lives: only then can a control be pressed. */
  live: boolean;
  /** One per Claude process. An action must name the generation that drew its control. */
  generation: number;
  /** Bumped on every change, so a slow read cannot overwrite a newer push. */
  revision: number;
  statuses: Status[];
  /** The latest toast; clients show each `id` once. */
  toast: Toast | null;
  band: ClaudePluginUiElement | null;
  panes: Pane[];
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

/** The render site a control was drawn in: the band, or one pane by id. */
export type ClaudePluginUiSite = { component: "AbovePrompt" } | { component: "Pane"; paneId: string };

/** What a person did to a control a mod drew. */
export type ClaudePluginUiAction =
  | { kind: "press"; target: ClaudePluginUiTarget; key?: string }
  | { kind: "input"; target: ClaudePluginUiTarget; key?: string; value: string; site: ClaudePluginUiSite }
  | { kind: "select"; target: ClaudePluginUiTarget; key?: string; value: string; site: ClaudePluginUiSite }
  | { kind: "closePane"; paneId: string };

export type ClaudePluginUiActArgs = { sessionId: string; generation: number } & ClaudePluginUiAction;

export type ClaudePluginUiActResult = { handled: boolean };

export function claudePluginUiHasContent(snapshot: ClaudePluginUiSnapshot | null | undefined): boolean {
  return Boolean(snapshot && (snapshot.band || snapshot.statuses.length || snapshot.panes.length));
}

/**
 * True for a `session_meta_updated` event that only carries a mod UI snapshot.
 * It is not chat activity: no recency bump, no roster refresh, no replay.
 */
export function isClaudePluginUiOnlyMetaEvent(event: { type: string }): boolean {
  if (event.type !== "session_meta_updated" || (event as { claudePluginUi?: unknown }).claudePluginUi === undefined) return false;
  return Object.keys(event).every((key) => key === "type" || key === "claudePluginUi");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text without control characters and direction overrides (tabs and newlines stay), cut to `max`. */
export function cleanClaudePluginUiText(value: unknown, max = MAX_TEXT_CHARS): string {
  if (typeof value !== "string") return "";
  // Cut first: a huge string must not be scanned whole. The slack covers removed characters.
  const bounded = value.length > max * 2 ? value.slice(0, max * 2) : value;
  // eslint-disable-next-line no-control-regex
  const cleaned = bounded.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "");
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * The address a mod's `Link` may open, by the rule Claude Code documents for
 * its Desktop app: an `https:` URL or an `http://localhost` URL, with no `@`,
 * spelled the way `new URL(href).href` spells it (a missing `/` after the host
 * is allowed). Any other link draws as plain text.
 */
export function safeClaudePluginUiHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_HREF_CHARS || value.includes("@")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const allowed = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
  if (!allowed || (url.href !== value && url.href !== `${value}/`)) return null;
  return url.href;
}

/** A `{ plugin, handle }` as Claude Code stamps it, or null for anything else. */
export function normalizeClaudePluginUiTarget(value: unknown): ClaudePluginUiTarget | null {
  if (!isRecord(value)) return null;
  const plugin = typeof value.plugin === "string" ? value.plugin : "";
  const handle = value.handle;
  if (!plugin || plugin.length > MAX_NAME_CHARS) return null;
  if (typeof handle !== "number" || !Number.isSafeInteger(handle)) return null;
  return { plugin, handle };
}

/**
 * What a prop may hold. `name` is a short string (an id, a keyword, a colour),
 * `text` a string a person reads or types, `size` a number of cells or a
 * percentage string.
 */
type PropKind = "name" | "text" | "number" | "flag" | "size";

/** Every prop a client may receive, per element. A prop not listed is dropped. */
const ELEMENT_PROPS: Record<ElementType, Record<string, PropKind>> = {
  Box: {
    key: "name", flexDirection: "name", flexWrap: "name", alignItems: "name", alignSelf: "name",
    justifyContent: "name", display: "name", borderStyle: "name", borderColor: "name", backgroundColor: "name",
    width: "size", height: "size", minWidth: "size", minHeight: "number",
    gap: "number", columnGap: "number", rowGap: "number",
    padding: "number", paddingX: "number", paddingY: "number",
    paddingLeft: "number", paddingRight: "number", paddingTop: "number", paddingBottom: "number",
    margin: "number", marginX: "number", marginY: "number",
    marginLeft: "number", marginRight: "number", marginTop: "number", marginBottom: "number",
    flexGrow: "number", flexShrink: "number",
  },
  Text: {
    color: "name", backgroundColor: "name", wrap: "name",
    bold: "flag", italic: "flag", underline: "flag", strikethrough: "flag", dimColor: "flag", inverse: "flag",
  },
  Button: { key: "name", label: "text", variant: "name", role: "name", plain: "flag", dimColor: "flag" },
  Link: { label: "text" },
  Code: { source: "text", language: "name", path: "name", format: "name", startLine: "number", wrap: "flag" },
  Markdown: { key: "name", text: "text", dimColor: "flag" },
  Input: { key: "name", label: "text", placeholder: "text", value: "text", submitLabel: "name" },
  Select: { key: "name", label: "text", value: "text" },
};

/** Element names other surfaces use, with the element this one draws and the props that implies. */
const ELEMENT_ALIASES: Record<string, { type: ElementType; props?: Record<string, ClaudePluginUiPropValue> }> = {
  div: { type: "Box" },
  span: { type: "Text" },
  b: { type: "Text", props: { bold: true } },
};

function isElementType(value: string): value is ElementType {
  return Object.hasOwn(ELEMENT_PROPS, value);
}

type SanitizeBudget = { nodes: number; chars: number; targets: ClaudePluginUiTarget[] };

function sanitizeProps(type: ElementType, raw: Record<string, unknown>, budget: SanitizeBudget): Record<string, ClaudePluginUiPropValue> {
  const props: Record<string, ClaudePluginUiPropValue> = {};
  for (const [name, kind] of Object.entries(ELEMENT_PROPS[type])) {
    const value = raw[name];
    if (kind === "flag") {
      if (value === true) props[name] = true;
    } else if (typeof value === "number") {
      if (kind !== "name" && kind !== "text" && Number.isFinite(value)) props[name] = Math.max(-512, Math.min(512, value));
    } else if (typeof value === "string" && kind !== "number") {
      if (kind === "text") {
        const cleaned = cleanClaudePluginUiText(value, Math.max(0, MAX_TREE_CHARS - budget.chars));
        budget.chars += cleaned.length;
        props[name] = cleaned;
      } else {
        props[name] = cleanClaudePluginUiText(value, MAX_NAME_CHARS);
      }
    }
  }
  if (type === "Link") {
    const href = safeClaudePluginUiHref(raw.href);
    if (href) props.href = href;
  }
  if (type === "Select" && Array.isArray(raw.options)) {
    const options: Array<{ value: string; label: string }> = [];
    for (const option of raw.options.slice(0, MAX_SELECT_OPTIONS)) {
      const value = typeof option === "string" ? option : isRecord(option) ? option.value : undefined;
      if (typeof value !== "string") continue;
      const label = isRecord(option) && typeof option.label === "string" ? option.label : value;
      options.push({
        value: cleanClaudePluginUiText(value, MAX_CLAUDE_PLUGIN_UI_INPUT_CHARS),
        label: cleanClaudePluginUiText(label, MAX_NAME_CHARS),
      });
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
  const rawProps = isRecord(raw.props) ? raw.props : {};
  const alias = Object.hasOwn(ELEMENT_ALIASES, raw.type) ? ELEMENT_ALIASES[raw.type] : undefined;
  const type = alias?.type ?? raw.type;
  if (!isElementType(type)) {
    // Svg, Client, Raster, Image: not drawn. An `alt` is the mod's own stand-in.
    return cleanClaudePluginUiText(rawProps.alt, MAX_NAME_CHARS) || null;
  }
  budget.nodes += 1;
  const element: ClaudePluginUiElement = { type, props: { ...sanitizeProps(type, rawProps, budget), ...alias?.props } };
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
