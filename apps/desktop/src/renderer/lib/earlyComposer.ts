import { COMPOSER_DRAFT_STORAGE_KEY_PREFIX, storedDraftHasContent } from "../state/composerDraftPresenceStore";

/*
 * The early prompt box: typing on a cold start before the Work page's code
 * has loaded.
 *
 * While the Work chunk loads, the Work route shows a fallback. When the view
 * that Work will restore is an empty new chat on this computer, the fallback
 * draws a copy of the new-chat screen as it looked on the last launch, with a
 * real text box where the prompt box was (`EarlyWorkComposer`). The text, the
 * caret, the focus and an Enter pressed early live in this module. When the
 * real composer mounts and has read its own saved draft, it takes them over
 * (`useEarlyComposerHandoff`): the text goes through the composer's own draft
 * path, so it is saved like any typed text, and an early Enter is replayed into
 * the real composer, which decides what it means.
 *
 * Every unclear case keeps the old fallback, which takes no input: a chat or a
 * grid in front, a CLI draft, a remote tab or a draft on another machine or a
 * cloud, a saved draft with content, no lanes yet, or no recorded layout that
 * matches this window, theme and font size.
 *
 * This module is in the shell: it must not import chat or Work code.
 */

// ── The recorded new-chat screen ──────────────────────────────────────────

export const EARLY_COMPOSER_LAYOUT_STORAGE_KEY = "ade.earlyComposer.layout.v1";
const LAYOUT_VERSION = 2;
/** A piece bigger than this is not recorded (the composer is a few KB). */
const MAX_PIECE_HTML_CHARS = 150_000;

export type EarlyComposerRect = { left: number; top: number; width: number; height: number };

/** One part of the screen, as static markup at its place in the Work route. */
export type EarlyComposerPiece = {
  rect: EarlyComposerRect;
  html: string;
  /** `data-*` attributes of the ancestors up to the route, for CSS that reads them. */
  scopeAttributes: Record<string, string>;
  /** Custom properties of the ancestors, and the inherited text styles of the parent. */
  scopeStyle: Record<string, string>;
};

/**
 * How the new-chat column sits in its area, so the early screen can place the
 * prompt box at another route height by the rule the real screen uses.
 *
 * The real screen (`AgentChatPane` empty state) centres a column (wordmark,
 * prompt box, shelf) in an area that fills the route's height below the pills.
 * Chrome above the route (notice banners) changes only the area's height. The
 * column is centred while it fits; when it does not, it starts at the area's
 * top and the wordmark, its one flexible row, gives up height down to a floor.
 */
export type EarlyComposerStack = {
  /** The content height of the area that centres the column, at record time. */
  areaHeight: number;
  /** The column's height without the wordmark: the prompt box, the gaps, the shelf. */
  fixed: number;
  /** The wordmark's full height and its floor; both 0 when it has no box (scene picture). */
  wordmarkNatural: number;
  wordmarkMin: number;
};

export type EarlyComposerLayout = {
  version: typeof LAYOUT_VERSION;
  projectRoot: string;
  /** `data-theme` plus a hash of the root's inline theme variables. */
  themeKey: string;
  chatFontSize: string;
  devicePixelRatio: number;
  route: { width: number; height: number };
  /**
   * The column rule. Null (or missing, in a record from an older build) when
   * the screen did not match the rule: only the same route height is served.
   */
  stack?: EarlyComposerStack | null;
  routeBackground: string;
  /** The new-chat surface, where the early screen draws the backdrop. */
  surface: EarlyComposerRect;
  /**
   * What was behind the screen: the scene picture (the window's current one is
   * drawn, not the recorded one: shuffle picks again each launch), or the flat
   * gradient (the first paint of the mesh). The two lay out differently (a
   * picture hides the wordmark), so a layout only serves the same kind.
   */
  scene: "image" | "flat";
  /** The prompt box with everything under `[data-chat-composer-dock]`; the text field is a slot. */
  composer: EarlyComposerPiece;
  wordmark: EarlyComposerPiece | null;
  pills: EarlyComposerPiece | null;
  /** The real text field, so the early one has the same box and text. */
  text: {
    className: string;
    style: string;
    placeholder: string;
    attributes: Record<string, string>;
    height: number;
  };
};

/** The element in the composer copy where the early text field goes. */
export const EARLY_COMPOSER_SLOT_ATTRIBUTE = "data-early-composer-slot";
/** The route container that layouts are measured against (App.tsx). */
export const WORK_ROUTE_ATTRIBUTE = "data-ade-work-route";

const STRIPPED_ATTRIBUTES = new Set([
  "id",
  "data-testid",
  "data-onboarding-anchor",
  "data-chat-composer-text",
  "data-draft-depart",
  "data-work-live-card-avoid",
  "autofocus",
]);
/** Markers that code looks up (no stylesheet reads them), so the copy does not carry them. */
const STRIPPED_SCOPE_ATTRIBUTES = new Set([
  "data-testid",
  "data-onboarding-anchor",
  "data-work-draft-surface",
  "data-draft-depart",
  "data-ade-find-scope",
  "data-work-live-card-avoid",
  WORK_ROUTE_ATTRIBUTE,
]);
const TEXT_ATTRIBUTES_NOT_COPIED = new Set([
  "id",
  "class",
  "style",
  "placeholder",
  "data-chat-composer-text",
  "data-testid",
  "data-onboarding-anchor",
  "name",
  "value",
  "disabled",
  "readonly",
  "autofocus",
]);
/** Text styles a piece inherits from where it sat. */
const INHERITED_TEXT_PROPERTIES = [
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "direction",
  "font-feature-settings",
  "font-variation-settings",
  "-webkit-font-smoothing",
] as const;

function hashString(value: string): string {
  // FNV-1a: a short key that changes when the theme variables change.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Root inline variables that move the early box's layout: the interface and
 * code faces (`--font-sans`, `--font-mono`, any other font variable) and the
 * web client's zoom factor.
 */
function movesLayout(name: string): boolean {
  return name.includes("font") || name === "--ade-web-zoom-factor";
}

/**
 * The theme the window paints now, as far as it moves things: `data-theme`
 * plus a hash of the root's inline variables that change the layout (fonts,
 * zoom). A layout from another key is not used.
 *
 * Everything else a theme writes on the root only paints: colours, shadows,
 * gradients, blurs, the backdrop. Those are left out because the copy takes
 * them from the live variables, and with "match app colours" each launch's
 * scene picture tints them all (shadows and gradients carry tinted colours
 * too), later than the early box shows. Hashing them changed the key on every
 * launch, so the box was never used. The route width, the font size and the
 * pixel ratio have checks of their own.
 */
export function currentEarlyComposerThemeKey(): string {
  if (typeof document === "undefined") return "";
  const root = document.documentElement;
  const style = root.style;
  const shape: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    if (movesLayout(name)) shape.push(`${name}:${style.getPropertyValue(name).trim()}`);
  }
  shape.sort();
  return `${root.getAttribute("data-theme") ?? ""}|${hashString(shape.join(";"))}`;
}

function rectWithin(element: Element, container: DOMRect): EarlyComposerRect {
  const rect = element.getBoundingClientRect();
  return {
    left: Math.round((rect.left - container.left) * 100) / 100,
    top: Math.round((rect.top - container.top) * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
    height: Math.round(rect.height * 100) / 100,
  };
}

function isIdentityTransform(value: string): boolean {
  return value === "none" || value === "" || value === "matrix(1, 0, 0, 1, 0, 0)";
}

/**
 * True when the element and its ancestors up to the route are at rest: no
 * transform and full opacity. A copy taken mid-animation would draw a
 * shifted or faded prompt box on the next launch.
 */
function atRest(element: Element, route: Element): boolean {
  for (let node: Element | null = element; node && node !== route; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!isIdentityTransform(style.transform)) return false;
    if (Number.parseFloat(style.opacity || "1") < 1) return false;
  }
  return true;
}

function scopeOf(element: Element, route: Element): Pick<EarlyComposerPiece, "scopeAttributes" | "scopeStyle"> {
  const chain: Element[] = [];
  for (let node = element.parentElement; node && node !== route; node = node.parentElement) chain.push(node);
  const scopeAttributes: Record<string, string> = {};
  const scopeStyle: Record<string, string> = {};
  // Outermost first, so a nearer ancestor wins, as CSS inheritance does.
  for (const node of chain.reverse()) {
    for (const attribute of Array.from(node.attributes)) {
      if (!attribute.name.startsWith("data-") || STRIPPED_SCOPE_ATTRIBUTES.has(attribute.name)) continue;
      scopeAttributes[attribute.name] = attribute.value;
    }
    if (node instanceof HTMLElement) {
      for (let index = 0; index < node.style.length; index += 1) {
        const name = node.style.item(index);
        if (name.startsWith("--")) scopeStyle[name] = node.style.getPropertyValue(name);
      }
    }
  }
  const parent = element.parentElement;
  if (parent) {
    const computed = getComputedStyle(parent);
    for (const name of INHERITED_TEXT_PROPERTIES) {
      const value = computed.getPropertyValue(name);
      if (value) scopeStyle[name] = value;
    }
  }
  return { scopeAttributes, scopeStyle };
}

function sanitizeClone(root: Element): void {
  // A fake frost (`SceneFrost`) holds this launch's picture file, which a user
  // picture names by a blob URL that is gone by the next launch. The copy
  // shows the box's plain tint instead until the real one takes over.
  for (const frost of Array.from(root.querySelectorAll(".ade-scene-frost"))) frost.remove();
  for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attribute of Array.from(node.attributes)) {
      if (STRIPPED_ATTRIBUTES.has(attribute.name) || attribute.name.startsWith("on")) {
        node.removeAttribute(attribute.name);
      }
    }
  }
}

/**
 * Make everything in the copy inert except the path to the text slot: the
 * copy's buttons look the same but take no focus, clicks or screen reader.
 */
function inertAllButPath(root: Element, keep: Element | null): void {
  if (!keep) {
    root.setAttribute("inert", "");
    return;
  }
  for (let node: Element | null = keep; node && node !== root; node = node.parentElement) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== node) sibling.setAttribute("inert", "");
    }
  }
}

function capturePiece(element: Element, route: Element, routeRect: DOMRect, options?: { textField?: Element }): EarlyComposerPiece | null {
  const clone = element.cloneNode(true) as Element;
  let slot: Element | null = null;
  if (options?.textField) {
    // The same path in the clone as the text field has in the original.
    const path: number[] = [];
    for (let node: Element | null = options.textField; node && node !== element; node = node.parentElement) {
      const parent: Element | null = node.parentElement;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, node));
    }
    let target: Element | null = clone;
    for (const index of path) target = target?.children[index] ?? null;
    if (!target) return null;
    slot = clone.ownerDocument.createElement("div");
    slot.setAttribute(EARLY_COMPOSER_SLOT_ATTRIBUTE, "");
    target.replaceWith(slot);
  }
  sanitizeClone(clone);
  inertAllButPath(clone, slot);
  if (!slot) clone.setAttribute("aria-hidden", "true");
  const html = clone.outerHTML;
  if (html.length > MAX_PIECE_HTML_CHARS) return null;
  return { rect: rectWithin(element, routeRect), html, ...scopeOf(element, route) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Where the column starts in its area, and the wordmark's height, for an area and column height. */
function stackPlacement(stack: EarlyComposerStack, areaHeight: number, fixed: number): { top: number; wordmark: number } {
  const natural = fixed + stack.wordmarkNatural;
  if (areaHeight >= natural) return { top: (areaHeight - natural) / 2, wordmark: stack.wordmarkNatural };
  // Too short: the column fills the area from its top, and the wordmark gives
  // up height down to its floor (past the floor, the column overflows).
  return { top: 0, wordmark: Math.min(stack.wordmarkNatural, Math.max(stack.wordmarkMin, areaHeight - fixed)) };
}

/** `aspect-ratio` as width / height (`560 / 300`, `1.5`, `auto 560 / 300`); null for `auto`. */
function parseAspectRatio(value: string): number | null {
  const pair = /([\d.]+)\s*\/\s*([\d.]+)/.exec(value);
  const ratio = pair ? Number(pair[1]) / Number(pair[2]) : Number(value);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The column rule for this screen, or null when the screen does not follow it
 * (a column that overflows its area, a changed layout). The rule is checked
 * against what the browser laid out: it must give the same column top and
 * wordmark height, or it is not recorded.
 */
function measureStack(wrapper: Element): EarlyComposerStack | null {
  const column = wrapper.parentElement;
  const area = column?.parentElement;
  if (!column || !area) return null;
  const areaStyle = getComputedStyle(area);
  const columnStyle = getComputedStyle(column);
  if (!/flex$/.test(areaStyle.display) || areaStyle.flexDirection !== "row" || areaStyle.alignItems !== "center") return null;
  if (!/flex$/.test(columnStyle.display) || columnStyle.flexDirection !== "column") return null;
  if (!["normal", "flex-start", "start"].includes(columnStyle.justifyContent)) return null;

  const areaRect = area.getBoundingClientRect();
  const contentTop = areaRect.top + px(areaStyle.borderTopWidth) + px(areaStyle.paddingTop);
  const areaHeight = areaRect.height
    - px(areaStyle.borderTopWidth) - px(areaStyle.paddingTop)
    - px(areaStyle.paddingBottom) - px(areaStyle.borderBottomWidth);
  const columnRect = column.getBoundingClientRect();
  if (areaHeight <= 0 || columnRect.height <= 0) return null;

  let wordmarkHeight = 0;
  let wordmarkNatural = 0;
  let wordmarkMin = 0;
  const wordmark = Array.from(column.children).find((child) => child.classList.contains("ade-draft-wordmark"));
  if (wordmark && wordmark.getClientRects().length > 0) {
    const rect = wordmark.getBoundingClientRect();
    const style = getComputedStyle(wordmark);
    const ratio = parseAspectRatio(style.aspectRatio);
    if (!ratio) return null;
    const maxHeight = Number.parseFloat(style.maxHeight);
    wordmarkHeight = rect.height;
    wordmarkNatural = Math.min(rect.width / ratio, Number.isFinite(maxHeight) ? maxHeight : Number.POSITIVE_INFINITY);
    wordmarkMin = px(style.minHeight);
  }
  const stack: EarlyComposerStack = {
    areaHeight: round2(areaHeight),
    fixed: round2(columnRect.height - wordmarkHeight),
    wordmarkNatural: round2(wordmarkNatural),
    wordmarkMin: round2(wordmarkMin),
  };
  // A column as tall as its area, with no wordmark height left to give, may
  // overflow: its box is capped, so its fixed part is not known.
  if (columnRect.height >= areaHeight - 0.5 && wordmarkHeight <= wordmarkMin + 0.5) return null;
  const expected = stackPlacement(stack, stack.areaHeight, stack.fixed);
  if (Math.abs(expected.top - (columnRect.top - contentTop)) > 1 || Math.abs(expected.wordmark - wordmarkHeight) > 1) return null;
  return stack;
}

/** Where the early screen's parts go at this route height, against where they were recorded. */
export type EarlyComposerPlacement = {
  /** Down shift of the prompt box. */
  composerShift: number;
  /** Down shift of the wordmark's top, and the change of its height. */
  wordmarkShift: number;
  wordmarkGrow: number;
  /** Change of the new-chat surface's height (it fills the route's height). */
  surfaceGrow: number;
};

/**
 * Place the early screen at the live route height by the real screen's rule.
 * `composerGrown` is how much taller the early text field is than the recorded
 * one (typed lines), which the centred column also answers to.
 */
export function placeEarlyComposer(layout: EarlyComposerLayout, routeHeight: number, composerGrown: number): EarlyComposerPlacement {
  const delta = routeHeight - layout.route.height;
  const stack = layout.stack;
  if (!stack) {
    // No rule recorded (a record from an older build): the centred column.
    const shift = round2((delta - composerGrown) / 2);
    return { composerShift: shift, wordmarkShift: shift, wordmarkGrow: 0, surfaceGrow: round2(delta) };
  }
  const before = stackPlacement(stack, stack.areaHeight, stack.fixed);
  const after = stackPlacement(stack, stack.areaHeight + delta, stack.fixed + composerGrown);
  const wordmarkShift = after.top - before.top;
  const wordmarkGrow = after.wordmark - before.wordmark;
  return {
    composerShift: round2(wordmarkShift + wordmarkGrow),
    wordmarkShift: round2(wordmarkShift),
    wordmarkGrow: round2(wordmarkGrow),
    surfaceGrow: round2(delta),
  };
}

/**
 * Null when the layout can be drawn at this route height, or the reason it
 * cannot. The same height always fits. Another height needs the column rule,
 * and an area tall enough for the column without overflow.
 */
function earlyComposerHeightRefusal(layout: EarlyComposerLayout, routeHeight: number): string | null {
  const delta = routeHeight - layout.route.height;
  if (Math.abs(delta) <= 0.5) return null;
  const stack = layout.stack;
  if (!stack) return "layout-height-no-rule";
  if (stack.areaHeight + delta < stack.fixed + stack.wordmarkMin - 0.5) return "layout-too-short";
  return null;
}

/**
 * Record the new-chat screen from the real Work page, at the first frame of
 * its draft composer. Returns false when the screen is not at rest or not the
 * plain new-chat layout; the last record then stays.
 */
// The Work page's own background: its CSS variable when it names one, so the
// early screen follows the live theme (a scene tint changes each launch), or
// the colour it computes to.
function routeBackgroundOf(element: Element | null): string {
  if (!element) return "";
  const inline = element instanceof HTMLElement ? element.style.getPropertyValue("background").trim() : "";
  if (/^var\(--[\w-]+\)$/.test(inline)) return inline;
  return getComputedStyle(element).backgroundColor;
}

export function recordEarlyComposerLayout(dock: HTMLElement, projectRoot: string): boolean {
  if (typeof window === "undefined") return false;
  const route = dock.closest(`[${WORK_ROUTE_ATTRIBUTE}]`);
  const surface = dock.closest("[data-work-draft-surface]");
  const emptyState = dock.closest("[data-chat-empty-state]");
  const wrapper = dock.closest("[data-chat-composer-wrapper]");
  const textField = dock.querySelector("[data-chat-composer-text]");
  // Only the inline prompt box of the new-chat screen (no simulator panel beside it).
  if (!route || !surface || !emptyState || !wrapper) return false;
  if (!(textField instanceof HTMLTextAreaElement) || textField.value !== "") return false;
  if (dock.getClientRects().length === 0 || !atRest(dock, route)) return false;
  const backdropKind = surface.querySelector(".ade-tool-picker-backdrop")?.getAttribute("data-backdrop") ?? null;
  // The scene has not settled (shuffle still picks): the layout may change in a moment.
  if (backdropKind === "settling") return false;
  const scene = backdropKind === "scene" ? "image" : "flat";
  // The page and the backdrop must agree (`data-scene` hides the wordmark), or the screen is mid-change.
  if ((document.documentElement.getAttribute("data-scene") === "image") !== (scene === "image")) return false;
  const routeRect = route.getBoundingClientRect();
  if (routeRect.width <= 0 || routeRect.height <= 0) return false;

  const composer = capturePiece(dock, route, routeRect, { textField });
  if (!composer) return false;
  const wordmarkElement = emptyState.querySelector(".ade-draft-wordmark img");
  const pillsElement = surface.querySelector("[data-onboarding-anchor='draft-mode-switch']");
  // On a scene picture the wordmark is hidden (scene.css) and has no box.
  const wordmark = wordmarkElement && wordmarkElement.getClientRects().length > 0 && atRest(wordmarkElement, route)
    ? capturePiece(wordmarkElement, route, routeRect)
    : null;
  const pills = pillsElement && atRest(pillsElement, route)
    ? capturePiece(pillsElement, route, routeRect)
    : null;

  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(textField.attributes)) {
    if (TEXT_ATTRIBUTES_NOT_COPIED.has(attribute.name) || attribute.name.startsWith("on")) continue;
    attributes[attribute.name] = attribute.value;
  }
  const routeChild = route.firstElementChild;
  const layout: EarlyComposerLayout = {
    version: LAYOUT_VERSION,
    projectRoot,
    themeKey: currentEarlyComposerThemeKey(),
    chatFontSize: dock.style.getPropertyValue("--chat-font-size").trim(),
    devicePixelRatio: window.devicePixelRatio || 1,
    route: { width: routeRect.width, height: routeRect.height },
    stack: measureStack(wrapper),
    routeBackground: routeBackgroundOf(routeChild),
    surface: rectWithin(surface, routeRect),
    scene,
    composer,
    wordmark,
    pills,
    text: {
      className: textField.className,
      style: textField.style.cssText,
      placeholder: textField.placeholder,
      attributes,
      height: textField.getBoundingClientRect().height,
    },
  };
  try {
    window.localStorage.setItem(EARLY_COMPOSER_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    return true;
  } catch {
    return false;
  }
}

function isRect(value: unknown): value is EarlyComposerRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return ["left", "top", "width", "height"].every((key) => typeof rect[key] === "number" && Number.isFinite(rect[key]));
}

function isPiece(value: unknown): value is EarlyComposerPiece {
  if (!value || typeof value !== "object") return false;
  const piece = value as Record<string, unknown>;
  return isRect(piece.rect)
    && typeof piece.html === "string"
    && Boolean(piece.scopeAttributes && typeof piece.scopeAttributes === "object")
    && Boolean(piece.scopeStyle && typeof piece.scopeStyle === "object");
}

function isStack(value: unknown): value is EarlyComposerStack {
  if (!value || typeof value !== "object") return false;
  const stack = value as Record<string, unknown>;
  return ["areaHeight", "fixed", "wordmarkNatural", "wordmarkMin"]
    .every((key) => typeof stack[key] === "number" && Number.isFinite(stack[key]) && (stack[key] as number) >= 0);
}

export function readEarlyComposerLayout(): EarlyComposerLayout | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(EARLY_COMPOSER_LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EarlyComposerLayout> | null;
    if (!parsed || parsed.version !== LAYOUT_VERSION) return null;
    if (typeof parsed.projectRoot !== "string" || typeof parsed.themeKey !== "string") return null;
    if (!parsed.route || !isRect(parsed.surface) || !isPiece(parsed.composer)) return null;
    if (parsed.scene !== "image" && parsed.scene !== "flat") return null;
    if (parsed.wordmark != null && !isPiece(parsed.wordmark)) return null;
    if (parsed.pills != null && !isPiece(parsed.pills)) return null;
    if (!parsed.text || typeof parsed.text.className !== "string" || typeof parsed.text.height !== "number") return null;
    if (typeof parsed.route.width !== "number" || typeof parsed.route.height !== "number") return null;
    return { ...parsed, stack: isStack(parsed.stack) ? parsed.stack : null } as EarlyComposerLayout;
  } catch {
    return null;
  }
}

// ── When the early box may take input ─────────────────────────────────────

export type EarlyComposerContext = {
  /** The project surface is the one on screen and the route is exactly `/work`. */
  shown: boolean;
  projectRoot: string | null;
  bindingKind: "local" | "remote" | null;
  view: {
    activeItemId: string | null;
    activeGridSetId: string | null;
    draftKind: "chat" | "cli";
    draftMachineId: string | null;
    draftCloudTarget: unknown;
  };
  laneCount: number;
  chatFontSizePx: number;
  route: { width: number; height: number } | null;
  /** The scene will show a picture once it settles (`sceneWillShowPicture`); null when that is not known yet. */
  sceneShown: boolean | null;
};

export type EarlyComposerDecision =
  | { ok: true; layout: EarlyComposerLayout }
  | { ok: false; reason: string };

/**
 * The saved new-chat draft that the composer will read on mount has no
 * content. Reads every key that the Work draft composer can read for this
 * project (`AgentChatPane` `composerDraftStorageKeys`, with older per-lane
 * keys), so a draft anywhere in them makes the early box stay read-only.
 */
function newChatDraftIsEmpty(projectRoot: string): boolean {
  try {
    const storage = window.localStorage;
    const prefix = `${COMPOSER_DRAFT_STORAGE_KEY_PREFIX}:${encodeURIComponent(projectRoot)}:`;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const [, , companion, surface] = key.split(":");
      const companionKey = companion ? decodeURIComponent(companion) : "";
      if (surface !== "standard") continue;
      if (companionKey !== "draft" && !companionKey.startsWith("draft:")) continue;
      if (storedDraftHasContent(storage.getItem(key))) return false;
    }
    return true;
  } catch {
    // Storage we cannot read: we cannot know the draft.
    return false;
  }
}

export function decideEarlyComposer(context: EarlyComposerContext): EarlyComposerDecision {
  if (state.retired) return { ok: false, reason: "used" };
  if (!context.shown) return { ok: false, reason: "not-shown" };
  if (!context.projectRoot) return { ok: false, reason: "no-project" };
  if (context.bindingKind !== "local") return { ok: false, reason: "remote-tab" };
  const view = context.view;
  if (view.activeItemId != null || view.activeGridSetId != null) return { ok: false, reason: "session-in-front" };
  if (view.draftKind !== "chat") return { ok: false, reason: "cli-draft" };
  if (view.draftMachineId != null || view.draftCloudTarget != null) return { ok: false, reason: "draft-elsewhere" };
  if (context.laneCount === 0) return { ok: false, reason: "no-lanes" };
  // The first render, before the layout effect measured the route. It never
  // paints: the measure re-renders before the frame.
  if (!context.route) return { ok: false, reason: "measuring" };
  const layout = readEarlyComposerLayout();
  if (!layout) return { ok: false, reason: "no-layout" };
  if (layout.projectRoot !== context.projectRoot) return { ok: false, reason: "layout-project" };
  if (layout.themeKey !== currentEarlyComposerThemeKey()) return { ok: false, reason: "layout-theme" };
  if (layout.chatFontSize !== `${context.chatFontSizePx}px`) return { ok: false, reason: "layout-font" };
  if (layout.devicePixelRatio !== (window.devicePixelRatio || 1)) return { ok: false, reason: "layout-scale" };
  // The width sets the column's width and every line break: it must match.
  // The height changes with chrome above the route (notice banners that come
  // and go), and the column rule places the prompt box for it.
  if (Math.abs(layout.route.width - context.route.width) > 0.5) return { ok: false, reason: "layout-width" };
  const heightRefusal = earlyComposerHeightRefusal(layout, context.route.height);
  if (heightRefusal) return { ok: false, reason: heightRefusal };
  if (context.sceneShown === null) return { ok: false, reason: "scene-unknown" };
  if (layout.scene !== (context.sceneShown ? "image" : "flat")) return { ok: false, reason: "layout-scene" };
  if (!newChatDraftIsEmpty(context.projectRoot)) return { ok: false, reason: "saved-draft" };
  return { ok: true, layout };
}

// ── What the early box holds ──────────────────────────────────────────────

/** An Enter (or ⌘/Ctrl+Enter) pressed before the hand-over, for the real composer to answer. */
export type EarlyComposerPendingKey = { metaKey: boolean; ctrlKey: boolean };

type EarlyComposerState = {
  /** The project whose draft composer takes the text; null until the box takes input. */
  projectRoot: string | null;
  text: string;
  selectionStart: number;
  selectionEnd: number;
  /** The keyboard is in the early box (or was, when it unmounted). */
  focused: boolean;
  composing: boolean;
  pendingKey: EarlyComposerPendingKey | null;
  /** The text was handed over, or the box can no longer take input this window. */
  retired: boolean;
};

const state: EarlyComposerState = {
  projectRoot: null,
  text: "",
  selectionStart: 0,
  selectionEnd: 0,
  focused: false,
  composing: false,
  pendingKey: null,
  retired: false,
};

/** The box takes input for this project. Called when it mounts. */
export function activateEarlyComposer(projectRoot: string): void {
  if (state.retired) return;
  state.projectRoot = projectRoot;
}

export function earlyComposerIsActive(): boolean {
  return !state.retired && state.projectRoot != null;
}

export function noteEarlyComposerText(text: string, selectionStart: number, selectionEnd: number): void {
  if (state.retired) return;
  state.text = text;
  state.selectionStart = selectionStart;
  state.selectionEnd = selectionEnd;
}

export function noteEarlyComposerSelection(selectionStart: number, selectionEnd: number): void {
  if (state.retired) return;
  state.selectionStart = selectionStart;
  state.selectionEnd = selectionEnd;
}

export function noteEarlyComposerFocus(focused: boolean): void {
  if (state.retired) return;
  state.focused = focused;
}

export function noteEarlyComposerPendingKey(key: EarlyComposerPendingKey): void {
  if (state.retired) return;
  state.pendingKey = key;
}

export function earlyComposerPendingKey(): EarlyComposerPendingKey | null {
  return state.pendingKey;
}

// ── The IME gate ──────────────────────────────────────────────────────────

/** A composition left open this long no longer holds the Work page back. */
const COMPOSITION_WAIT_MAX_MS = 4_000;
const settledWaiters = new Set<() => void>();

export function noteEarlyComposerComposing(composing: boolean): void {
  state.composing = composing && !state.retired;
  if (state.composing) return;
  for (const resolve of Array.from(settledWaiters)) resolve();
}

/**
 * Resolves when no IME composition is open in the early box. The Work route
 * waits on it before it renders, so a word being composed is never split by
 * the hand-over: the composition ends in the early box, then the text moves.
 */
export function whenEarlyComposerSettled(): Promise<void> {
  if (!state.composing) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      settledWaiters.delete(done);
      window.clearTimeout(timer);
      resolve();
    };
    settledWaiters.add(done);
    timer = window.setTimeout(done, COMPOSITION_WAIT_MAX_MS);
  });
}

// ── Keys between the early box and the real one ───────────────────────────

/**
 * Between the frame that removes the early box and the effect that hands the
 * text over, the page has no text field. Keys typed then would be lost, so
 * they are kept here: characters, Backspace and line breaks edit the held
 * text at its caret, and Enter is held as the pending key. The buffer stops at
 * the hand-over, when the keyboard moves to a field, or after this long.
 */
const KEY_BUFFER_MAX_MS = 2_000;
let stopKeyBuffer: (() => void) | null = null;

function insertAtCaret(insert: string): void {
  const start = Math.min(state.selectionStart, state.selectionEnd, state.text.length);
  const end = Math.min(Math.max(state.selectionStart, state.selectionEnd), state.text.length);
  state.text = state.text.slice(0, start) + insert + state.text.slice(end);
  state.selectionStart = state.selectionEnd = start + insert.length;
}

function deleteBackward(): void {
  const start = Math.min(state.selectionStart, state.selectionEnd, state.text.length);
  const end = Math.min(Math.max(state.selectionStart, state.selectionEnd), state.text.length);
  if (start !== end) {
    state.text = state.text.slice(0, start) + state.text.slice(end);
    state.selectionStart = state.selectionEnd = start;
    return;
  }
  if (start === 0) return;
  // One UTF-16 unit, or the whole surrogate pair before the caret.
  const code = state.text.charCodeAt(start - 1);
  const width = start >= 2 && code >= 0xdc00 && code <= 0xdfff ? 2 : 1;
  state.text = state.text.slice(0, start - width) + state.text.slice(start);
  state.selectionStart = state.selectionEnd = start - width;
}

export function startEarlyComposerKeyBuffer(): void {
  if (stopKeyBuffer || state.retired || state.projectRoot == null) return;
  const onKeyDown = (event: KeyboardEvent) => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) {
      // The keyboard is in a field again (the real composer, or one the person clicked).
      stop();
      return;
    }
    if (event.isComposing || event.keyCode === 229 || event.altKey) return;
    if (state.pendingKey) return;
    if (event.key === "Enter") {
      if (event.shiftKey) insertAtCaret("\n");
      else state.pendingKey = { metaKey: event.metaKey, ctrlKey: event.ctrlKey };
    } else if (event.metaKey || event.ctrlKey) {
      return;
    } else if (event.key === "Backspace") {
      deleteBackward();
    } else if (event.key.length === 1 || (event.key.length === 2 && /[\uD800-\uDBFF]/.test(event.key[0] ?? ""))) {
      insertAtCaret(event.key);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const timer = window.setTimeout(() => stop(), KEY_BUFFER_MAX_MS);
  const stop = () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.clearTimeout(timer);
    stopKeyBuffer = null;
  };
  window.addEventListener("keydown", onKeyDown, true);
  stopKeyBuffer = stop;
}

// ── The hand-over ─────────────────────────────────────────────────────────

export type EarlyComposerClaim = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  /** Give the real composer the keyboard: the early box had it at the hand-over. */
  focus: boolean;
  pendingKey: EarlyComposerPendingKey | null;
};

/**
 * Take what the early box holds, once. Null when the box never took input in
 * this window, or took it for another project (the text then stays for that
 * project's draft composer).
 */
export function claimEarlyComposer(projectRoot: string | null): EarlyComposerClaim | null {
  if (state.retired || state.projectRoot == null || state.projectRoot !== projectRoot) return null;
  state.retired = true;
  stopKeyBuffer?.();
  noteEarlyComposerComposing(false);
  return {
    text: state.text,
    selectionStart: Math.min(state.selectionStart, state.text.length),
    selectionEnd: Math.min(state.selectionEnd, state.text.length),
    focus: state.focused,
    pendingKey: state.pendingKey,
  };
}

/** The real draft composer mounted with nothing to take: the box cannot take input after this. */
export function retireEarlyComposer(): void {
  if (state.projectRoot != null) return;
  state.retired = true;
}
