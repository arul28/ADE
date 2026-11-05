import type {
  AndroidElementMatch,
  AndroidElementQuery,
  AndroidUiBounds,
  AndroidUiElement,
} from "../../../shared/types/androidEmulator";

/*
 * The UI tree of the lane's emulator, as elements an agent can name.
 *
 * Two sources give the same element shape:
 * - `uiautomator dump` (on every image; no install on the device). It writes
 *   an XML tree of `<node>` elements with the accessibility attributes.
 * - Google's Android CLI (`android layout`), when it is installed. It prints
 *   JSON. Its field names are read loosely, and an answer with no element is
 *   treated as a failure, so the caller falls back to `uiautomator`.
 *
 * The query matcher takes `ade apple`'s query shape (`ref`, `identifier`,
 * `label`, `text`, `role`, `index`) and maps it onto Android's attributes:
 * `resource-id`, `content-desc`, `text` and the class name.
 *
 * Pure: no adb, no timers. Node built-ins and relative imports only, so it
 * runs under `tsx`.
 */

/** One parsed element before refs are given out. */
type RawElement = Omit<AndroidUiElement, "ref">;

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** The attributes of one tag's text (`a="1" b="x"`). */
function readAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([\w:-]+)="([^"]*)"/gu;
  for (let match = pattern.exec(tag); match; match = pattern.exec(tag)) {
    attributes.set(match[1]!, decodeXml(match[2]!));
  }
  return attributes;
}

/** `[0,63][1080,210]` into a box; null when it does not parse or has no area. */
export function parseUiautomatorBounds(value: string | null | undefined): AndroidUiBounds | null {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u.exec(value?.trim() ?? "");
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1, 5).map(Number) as [number, number, number, number];
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? value! : null;
}

function shortClassName(className: string | null): string | null {
  if (!className) return null;
  const dot = className.lastIndexOf(".");
  return dot >= 0 ? className.slice(dot + 1) : className;
}

/** `com.example:id/submit` → `submit`. */
function identifierOf(resourceId: string | null): string | null {
  if (!resourceId) return null;
  const slash = resourceId.indexOf(":id/");
  return slash >= 0 ? resourceId.slice(slash + 4) : resourceId;
}

function makeElement(input: {
  path: string;
  resourceId: string | null;
  label: string | null;
  text: string | null;
  className: string | null;
  packageName: string | null;
  bounds: AndroidUiBounds;
  flags: Partial<Pick<RawElement, "clickable" | "longClickable" | "scrollable" | "focusable" | "focused" | "enabled" | "selected" | "password">>;
  checked: boolean | null;
}): RawElement {
  const { bounds } = input;
  return {
    path: input.path,
    resourceId: input.resourceId,
    identifier: identifierOf(input.resourceId),
    label: input.label,
    text: input.text,
    role: shortClassName(input.className),
    className: input.className,
    packageName: input.packageName,
    bounds,
    center: { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) },
    clickable: input.flags.clickable ?? false,
    longClickable: input.flags.longClickable ?? false,
    scrollable: input.flags.scrollable ?? false,
    focusable: input.flags.focusable ?? false,
    focused: input.flags.focused ?? false,
    enabled: input.flags.enabled ?? true,
    checked: input.checked,
    selected: input.flags.selected ?? false,
    password: input.flags.password ?? false,
  };
}

export type ParsedUiTree = {
  elements: AndroidUiElement[];
  /** The screen in device pixels (the root node's box), when it has one. */
  width: number | null;
  height: number | null;
};

/**
 * Parses `uiautomator dump` XML. Every `<node>` with a box on screen becomes
 * an element, in document order, so a parent comes before its children. A
 * node with no area (gone, or scrolled away) is left out: it cannot be tapped.
 */
export function parseUiautomatorXml(xml: string): ParsedUiTree {
  const start = xml.indexOf("<hierarchy");
  if (start < 0) throw new Error("The UI dump holds no <hierarchy> element.");
  const raw: RawElement[] = [];
  /** Child counters of the open nodes; the path is the chain of child indexes. */
  const stack: number[] = [];
  let next = 0;
  let width: number | null = null;
  let height: number | null = null;
  const pattern = /<(\/?)node\b([^>]*?)(\/?)>/gu;
  pattern.lastIndex = start;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    const closing = match[1] === "/";
    if (closing) {
      next = (stack.pop() ?? -1) + 1;
      continue;
    }
    const selfClosing = match[3] === "/";
    const attributes = readAttributes(match[2]!);
    const path = [...stack, next].join(".");
    const bounds = parseUiautomatorBounds(attributes.get("bounds"));
    if (bounds && width === null) {
      width = bounds.x + bounds.width;
      height = bounds.y + bounds.height;
    }
    if (bounds) {
      const flag = (name: string) => attributes.get(name) === "true";
      raw.push(makeElement({
        path,
        resourceId: emptyToNull(attributes.get("resource-id")),
        label: emptyToNull(attributes.get("content-desc")),
        text: emptyToNull(attributes.get("text")),
        className: emptyToNull(attributes.get("class")),
        packageName: emptyToNull(attributes.get("package")),
        bounds,
        flags: {
          clickable: flag("clickable"),
          longClickable: flag("long-clickable"),
          scrollable: flag("scrollable"),
          focusable: flag("focusable"),
          focused: flag("focused"),
          enabled: attributes.get("enabled") !== "false",
          selected: flag("selected"),
          password: flag("password"),
        },
        checked: attributes.get("checkable") === "true" ? flag("checked") : null,
      }));
    }
    if (selfClosing) {
      next += 1;
    } else {
      stack.push(next);
      next = 0;
    }
  }
  return { elements: assignRefs(raw), width, height };
}

/* ---------- Android CLI (`android layout`) ---------- */

function pickString(node: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function pickBoolean(node: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

/** A box as the CLI writes it: `[l,t][r,b]`, `{left,top,right,bottom}`, `{x,y,width,height}` or `[l,t,r,b]`. */
function readCliBounds(value: unknown): AndroidUiBounds | null {
  if (typeof value === "string") return parseUiautomatorBounds(value);
  if (Array.isArray(value) && value.length === 4 && value.every((entry) => typeof entry === "number")) {
    const [left, top, right, bottom] = value as [number, number, number, number];
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }
  if (value && typeof value === "object") {
    const box = value as Record<string, unknown>;
    const num = (key: string) => (typeof box[key] === "number" ? (box[key] as number) : null);
    const left = num("left") ?? num("x");
    const top = num("top") ?? num("y");
    const right = num("right") ?? (left !== null && num("width") !== null ? left + num("width")! : null);
    const bottom = num("bottom") ?? (top !== null && num("height") !== null ? top + num("height")! : null);
    if (left === null || top === null || right === null || bottom === null) return null;
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }
  return null;
}

/** The CLI's `interactions` list (`["CLICKABLE", "SCROLLABLE"]`) as flags, read loosely. */
function readInteractions(node: Record<string, unknown>): Set<string> {
  const list = node.interactions ?? node.actions;
  return new Set(Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.toUpperCase()) : []);
}

/**
 * Parses `android layout` JSON. Measured with CLI 1.1 (2026-11): a list of
 * windows (`window-title`, `type`, `focused`, `bounds`, `content`), each
 * `content` a tree of nodes with `class`, `resource-id`, `text`,
 * `content-desc`, `bounds` (`[l,t][r,b]`), `interactions` (`CLICKABLE`,
 * `LONG_CLICKABLE`, `SCROLLABLE`, `FOCUSABLE`) and `children`. The focused
 * window's elements come first, so `--index 0` and document order favour the
 * app over the status bar. Other field names (camelCase, a bare tree) are
 * read too. Throws when nothing reads as an element, so the caller falls
 * back to `uiautomator` rather than answer an empty screen.
 */
export function parseAndroidCliLayout(stdout: string): ParsedUiTree {
  // The first call on a device prints "Installing layout instrumentation
  // server..." before the JSON: start at the first line that opens it.
  const start = stdout.search(/^[ \t]*[[{]/mu);
  const parsed = JSON.parse(start > 0 ? stdout.slice(start) : stdout) as unknown;
  const raw: RawElement[] = [];
  let width: number | null = null;
  let height: number | null = null;
  const grow = (bounds: AndroidUiBounds) => {
    width = Math.max(width ?? 0, bounds.x + bounds.width);
    height = Math.max(height ?? 0, bounds.y + bounds.height);
  };
  const visitNode = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visitNode(entry, path ? `${path}.${index}` : String(index)));
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    const bounds = readCliBounds(node.bounds ?? node.boundsInScreen ?? node.rect ?? node.frame);
    if (bounds) {
      grow(bounds);
      const interactions = readInteractions(node);
      const has = (name: string) => (interactions.has(name) ? true : undefined);
      const checkable = pickBoolean(node, ["checkable", "isCheckable"]) ?? has("CHECKABLE");
      raw.push(makeElement({
        path: path || "0",
        resourceId: pickString(node, ["resource-id", "resourceId", "resourceName", "viewIdResourceName"]),
        label: pickString(node, ["content-desc", "contentDescription", "contentDesc", "description"]),
        text: pickString(node, ["text"]),
        className: pickString(node, ["class", "className"]),
        packageName: pickString(node, ["package", "packageName"]),
        bounds,
        flags: {
          clickable: pickBoolean(node, ["clickable", "isClickable"]) ?? has("CLICKABLE"),
          longClickable: pickBoolean(node, ["long-clickable", "longClickable", "isLongClickable"]) ?? has("LONG_CLICKABLE"),
          scrollable: pickBoolean(node, ["scrollable", "isScrollable"]) ?? has("SCROLLABLE"),
          focusable: pickBoolean(node, ["focusable", "isFocusable"]) ?? has("FOCUSABLE"),
          focused: pickBoolean(node, ["focused", "isFocused"]) ?? has("FOCUSED"),
          enabled: pickBoolean(node, ["enabled", "isEnabled"]) ?? (interactions.has("DISABLED") ? false : undefined),
          selected: pickBoolean(node, ["selected", "isSelected"]) ?? has("SELECTED"),
          password: pickBoolean(node, ["password", "isPassword"]) ?? has("PASSWORD"),
        },
        checked: checkable ? pickBoolean(node, ["checked", "isChecked"]) ?? interactions.has("CHECKED") : null,
      }));
    }
    for (const key of ["children", "nodes", "elements"]) {
      if (Array.isArray(node[key])) {
        (node[key] as unknown[]).forEach((child, index) => visitNode(child, `${path || "0"}.${index}`));
      }
    }
  };
  const isWindow = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).content));
  if (Array.isArray(parsed) && parsed.some(isWindow)) {
    const windows = parsed.map((window, index) => ({ window, index })).filter((entry) => isWindow(entry.window));
    // The focused window first; then the rest in the CLI's order.
    windows.sort((a, b) => Number((b.window as Record<string, unknown>).focused === true) - Number((a.window as Record<string, unknown>).focused === true));
    for (const { window, index } of windows) {
      const box = readCliBounds((window as Record<string, unknown>).bounds);
      if (box) grow(box);
      ((window as Record<string, unknown>).content as unknown[]).forEach((node, child) => visitNode(node, `w${index}.${child}`));
    }
  } else {
    visitNode(parsed, "");
  }
  if (raw.length === 0) throw new Error("The Android CLI's layout held no element with bounds.");
  return { elements: assignRefs(raw), width, height };
}

/* ---------- refs ---------- */

/** A ref-safe slug of a label or a text: lower case, words joined by `-`, at most 40 characters. */
function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
}

/**
 * Gives each element a ref built from what the app says about it, so the ref
 * stays the same between snapshots while the tree path moves with the layout:
 * `id:submit`, `label:sign-in`, `text:continue`, else the role and the tree
 * path. The first name that is unique on the screen wins, so a resource id
 * that every row shares (`android:id/title` in Settings) gives way to the
 * row's text. When no name is unique, the one fewest elements share gets
 * `#2`, `#3` in document order; an element with no name at all gets the role and path.
 */
function assignRefs(elements: readonly RawElement[]): AndroidUiElement[] {
  const candidatesOf = (element: RawElement): string[] => {
    const out: string[] = [];
    if (element.identifier) out.push(`id:${element.identifier}`);
    const label = element.label ? slug(element.label) : "";
    if (label) out.push(`label:${label}`);
    const text = element.text ? slug(element.text) : "";
    if (text) out.push(`text:${text}`);
    out.push(`${(element.role ?? "node").toLowerCase()}@${element.path}`);
    return out;
  };
  const candidates = elements.map(candidatesOf);
  const uses = new Map<string, number>();
  for (const list of candidates) for (const candidate of list) uses.set(candidate, (uses.get(candidate) ?? 0) + 1);
  const seen = new Map<string, number>();
  return elements.map((element, index) => {
    const list = candidates[index]!;
    // The role-and-path ref is always unique; it is the last resort, after a
    // repeated name with its `#n`.
    const named = list.slice(0, -1);
    // The name fewest elements share wins (a unique one first); a tie keeps id, label, text order.
    const base = [...named].sort((x, y) => (uses.get(x) ?? 0) - (uses.get(y) ?? 0))[0] ?? list.at(-1)!;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { ...element, ref: count === 1 ? base : `${base}#${count}` };
  });
}

/* ---------- queries ---------- */

/** True when the query names at least one field to match on. */
export function hasElementQuery(query: AndroidElementQuery | null | undefined): boolean {
  return Boolean(query && (query.ref || query.identifier || query.label || query.text || query.role));
}

const lower = (value: string | null | undefined) => value?.toLowerCase() ?? null;

/**
 * The elements a query matches, best first, and a note when the match was a
 * fallback (a label prefix). Each named field must match:
 * - `ref`: exact; a tree path (`0.1.2`) also works while the layout holds.
 * - `identifier`: the resource id, with or without its `package:id/` prefix.
 * - `label`: the content description, case-insensitive; with no exact match,
 *   the labels that start with it ("Work" finds "Work, 3 need you").
 * - `text`: a case-insensitive substring of the text or the content
 *   description.
 * - `role`: the class's short name or the full class name, case-insensitive.
 * Among several matches, a clickable one comes before one that is not, then
 * document order. `index` picks one of them (0-based).
 */
export function matchElements(
  elements: readonly AndroidUiElement[],
  query: AndroidElementQuery,
): { matches: AndroidUiElement[]; note: string | null } {
  const ref = query.ref?.trim() || null;
  const identifier = query.identifier?.trim() || null;
  const label = lower(query.label?.trim() || null);
  const text = lower(query.text?.trim() || null);
  const role = lower(query.role?.trim() || null);

  const others = (element: AndroidUiElement): boolean => {
    if (ref && element.ref !== ref && element.path !== ref) return false;
    if (identifier && element.resourceId !== identifier && element.identifier !== identifier) return false;
    if (text && !(lower(element.text)?.includes(text) || lower(element.label)?.includes(text))) return false;
    if (role && lower(element.role) !== role && lower(element.className) !== role) return false;
    return true;
  };

  let note: string | null = null;
  let matches = elements.filter((element) => others(element) && (!label || lower(element.label) === label));
  if (label && matches.length === 0) {
    // A label that names the start of a longer one, as Apple's matcher does.
    matches = elements.filter((element) => others(element) && Boolean(lower(element.label)?.startsWith(label)));
    if (matches.length > 0) note = `No label is exactly "${query.label}"; matched the label that starts with it.`;
    else {
      // Android apps often put the words in `text`, not `content-desc`.
      matches = elements.filter((element) => others(element) && lower(element.text) === label);
      if (matches.length > 0) note = `No content description is "${query.label}"; matched an element whose text is. Use --text next time.`;
    }
  }
  const ranked = [...matches].sort((a, b) => Number(b.clickable) - Number(a.clickable));
  return { matches: ranked, note };
}

/** The match `index` picks, or null; with the count and note. */
export function pickElement(
  elements: readonly AndroidUiElement[],
  query: AndroidElementQuery,
): { match: AndroidElementMatch | null; matches: AndroidUiElement[] } {
  const { matches, note } = matchElements(elements, query);
  const index = typeof query.index === "number" && Number.isInteger(query.index) && query.index >= 0 ? query.index : 0;
  const element = matches[index] ?? null;
  return {
    match: element ? { ref: element.ref, element, matchCount: matches.length, ...(note ? { note } : {}) } : null,
    matches,
  };
}

/** One line naming the query, for refusals: `--label "Sign in" --role Button`. */
export function describeElementQuery(query: AndroidElementQuery): string {
  const parts: string[] = [];
  const add = (flag: string, value: string | null | undefined) => {
    if (value) parts.push(`${flag} ${JSON.stringify(value)}`);
  };
  add("--ref", query.ref);
  add("--identifier", query.identifier);
  add("--label", query.label);
  add("--text", query.text);
  add("--role", query.role);
  if (typeof query.index === "number") parts.push(`--index ${query.index}`);
  return parts.join(" ") || "(empty query)";
}
