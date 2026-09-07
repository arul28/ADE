/**
 * Pure helpers shared by ADE's agent-driveable surfaces (the built-in browser
 * and App Control). Everything here must stay dependency-free — no Electron,
 * no node built-ins — so both the Electron-hosted browser service and the
 * Electron-free App Control service (which also runs inside the headless
 * `ade` daemon) can import it.
 */

/** Every observation id starts with this prefix, which handles encode. */
export const AGENT_OBSERVATION_ID_PREFIX = "obs-";

/** Handles look like `obs-<timestamp>-<uuid>:e:<1-based index>`. */
const AGENT_ELEMENT_HANDLE_RE = /^(obs-[^:]+):e:(\d+)$/;

/**
 * Collapse a value into a filesystem-safe path segment. Observation ids and
 * session ids both flow into cache directory names, so this doubles as the
 * validator that keeps a handle from escaping its observation directory.
 */
export function sanitizeObservationPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "unknown";
}

/** Stable element handle for an observation element index (1-based). */
export function formatObservationElementHandle(observationId: string, index: number): string {
  return `${observationId}:e:${index}`;
}

/**
 * Parse a stable element handle back into its observation id and element
 * index. Returns null for anything that is not a well-formed, path-safe handle.
 */
export function parseObservationElementHandle(
  handle: string,
): { observationId: string; index: number } | null {
  const match = AGENT_ELEMENT_HANDLE_RE.exec(handle.trim());
  if (!match) return null;
  const observationId = match[1] ?? "";
  if (sanitizeObservationPathSegment(observationId) !== observationId) return null;
  const index = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(index) || index < 1) return null;
  return { observationId, index };
}

/** Clamp a caller-supplied integer into [min, max], falling back to `fallback`. */
export function clampObservationInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, raw));
}

/**
 * CDP `Input.dispatchKeyEvent` payload for a key name or single character.
 * Mirrors the built-in browser's key mapping so `press Enter` behaves the same
 * in an app as it does on a page.
 */
export function keyEventForAgentInput(input: string): Record<string, unknown> {
  const normalized = input.length === 1 ? input : input.trim();
  const named: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  };
  const special = named[normalized];
  if (special) return special;
  const char = normalized.slice(0, 1);
  const upper = char.toUpperCase();
  return {
    key: char,
    code: /^[a-z]$/i.test(char) ? `Key${upper}` : char,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    text: char,
    unmodifiedText: char,
  };
}

/**
 * In-page element collector. Evaluated through CDP `Runtime.evaluate` in the
 * target page (a browser tab, or an Electron renderer under App Control).
 *
 * It returns a bounded, stably ordered list of interactive elements with
 * `framePath` / `shadowPath` context so a caller can re-locate an element in a
 * later evaluation, plus an optional `locate` mode that resolves, scrolls into
 * view, focuses, selects, or clears a single target.
 */
export const AGENT_DOM_COLLECTOR_FUNCTION = String.raw`
function(inputArg) {
  const input = inputArg && typeof inputArg === "object" ? inputArg : {};
  const maxElements = Math.max(1, Math.min(200, Number(input.maxElements) || 80));
  const locate = input.locate && typeof input.locate === "object" ? input.locate : null;
  const shouldFocus = input.focus === true;
  const shouldSelect = input.select === true;
  const shouldClear = input.clear === true;
  const editableRequired = input.editableRequired === true;
  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[contenteditable='true']",
    "[role='button']",
    "[role='link']",
    "[role='menuitem']",
    "[role='tab']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[tabindex]:not([tabindex='-1'])",
    "[onclick]"
  ].join(",");
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const lowerText = (value) => normalizeText(value).toLowerCase();
  const arrayEquals = (left, right) => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => entry === right[index]);
  };
  const numberPath = (value) => Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry >= 0).map((entry) => Math.floor(entry))
    : null;
  const stringPath = (value) => Array.isArray(value)
    ? value.map((entry) => normalizeText(entry)).filter(Boolean)
    : null;
  const escapeIdent = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const quoteAttr = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const selectorFor = (node) => {
    const parts = [];
    let current = node;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = current.localName || current.tagName.toLowerCase();
      const testId = current.getAttribute("data-testid")
        || current.getAttribute("data-test-id")
        || current.getAttribute("data-cy");
      if (current.id) {
        part += "#" + escapeIdent(current.id);
        parts.unshift(part);
        break;
      }
      if (testId) {
        part += "[data-testid=\"" + quoteAttr(testId) + "\"]";
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((candidate) => candidate.localName === current.localName);
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const rectFor = (node, ctx) => {
    const rect = node && typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
    if (!rect) return null;
    return {
      x: rect.x + ctx.offsetX,
      y: rect.y + ctx.offsetY,
      left: rect.left + ctx.offsetX,
      top: rect.top + ctx.offsetY,
      right: rect.right + ctx.offsetX,
      bottom: rect.bottom + ctx.offsetY,
      width: rect.width,
      height: rect.height
    };
  };
  const isDisplayed = (node, ctx) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE || typeof node.getBoundingClientRect !== "function") return false;
    const rect = rectFor(node, ctx);
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = (ctx.win || window).getComputedStyle(node);
    if (!style || style.display === "none" || style.visibility === "hidden") return false;
    if (style.pointerEvents === "none") return false;
    return Number(style.opacity || "1") > 0.01;
  };
  const intersectsViewport = (node, ctx) => {
    const rect = rectFor(node, ctx);
    if (!rect) return false;
    return rect.right >= 0 && rect.bottom >= 0 && rect.left <= window.innerWidth && rect.top <= window.innerHeight;
  };
  const labelledByText = (node) => {
    const ids = normalizeText(node.getAttribute("aria-labelledby"));
    if (!ids) return "";
    const doc = node.ownerDocument || document;
    return ids
      .split(/\s+/)
      .map((id) => normalizeText(doc.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
  };
  const labelFor = (node) => {
    const id = node.getAttribute("id");
    const doc = node.ownerDocument || document;
    const explicitLabel = id
      ? normalizeText(doc.querySelector("label[for=\"" + quoteAttr(id) + "\"]")?.textContent)
      : "";
    const implicitLabel = normalizeText(node.closest("label")?.textContent);
    return normalizeText(
      node.getAttribute("aria-label")
      || labelledByText(node)
      || explicitLabel
      || implicitLabel
      || node.getAttribute("placeholder")
      || node.getAttribute("title")
      || node.getAttribute("alt")
      || node.getAttribute("name")
      || node.innerText
      || node.textContent
    ).slice(0, 300) || null;
  };
  const testIdFor = (node) => node.getAttribute("data-testid")
    || node.getAttribute("data-test-id")
    || node.getAttribute("data-cy")
    || null;
  const valueFor = (node) => {
    const tag = node && node.tagName ? node.tagName.toLowerCase() : "";
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return null;
    if (tag === "input" && String(node.type || "").toLowerCase() === "password") return null;
    return String(node.value || "").slice(0, 300) || null;
  };
  const disabledFor = (node) => "disabled" in node ? Boolean(node.disabled) : null;
  const describe = (node, index, ctx) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    const rect = rectFor(node, ctx);
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const text = normalizeText(node.innerText || node.textContent).slice(0, 300) || null;
    const label = labelFor(node);
    const tagName = node.tagName ? node.tagName.toLowerCase() : null;
    return {
      index,
      framePath: ctx.framePath.length ? ctx.framePath : undefined,
      shadowPath: ctx.shadowPath.length ? ctx.shadowPath : undefined,
      tagName,
      role: node.getAttribute("role"),
      label,
      text,
      value: valueFor(node),
      placeholder: normalizeText(node.getAttribute("placeholder")).slice(0, 300) || null,
      selector: selectorFor(node),
      testId: testIdFor(node),
      href: tagName === "a" ? node.href : null,
      disabled: disabledFor(node),
      frame: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    };
  };
  const actionableElement = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    return node.matches(interactiveSelector) ? node : node.closest(interactiveSelector) || node;
  };
  const contexts = [];
  const collectContexts = (root, doc, win, offsetX, offsetY, framePath, shadowPath, depth) => {
    if (!root || typeof root.querySelectorAll !== "function" || depth > 4) return;
    const ctx = { root, doc, win, offsetX, offsetY, framePath, shadowPath };
    contexts.push(ctx);
    for (const host of Array.from(root.querySelectorAll("*"))) {
      if (host.shadowRoot) {
        collectContexts(host.shadowRoot, host.ownerDocument || doc, win, offsetX, offsetY, framePath, shadowPath.concat(selectorFor(host)), depth + 1);
      }
    }
    const frames = Array.from(root.querySelectorAll("iframe,frame,webview"));
    frames.forEach((frameElement, index) => {
      let childDocument = null;
      try {
        childDocument = frameElement.contentDocument;
      } catch {
        childDocument = null;
      }
      if (!childDocument || !childDocument.documentElement) return;
      if (!isDisplayed(frameElement, ctx) || !intersectsViewport(frameElement, ctx)) return;
      const frameRect = rectFor(frameElement, ctx);
      if (!frameRect) return;
      collectContexts(
        childDocument,
        childDocument,
        childDocument.defaultView || win,
        frameRect.x,
        frameRect.y,
        framePath.concat(index),
        shadowPath,
        depth + 1
      );
    });
  };
  collectContexts(document, document, window, 0, 0, [], [], 0);
  const locateFramePath = locate ? numberPath(locate.framePath) : null;
  const locateShadowPath = locate ? stringPath(locate.shadowPath) : null;
  const contextMatches = (ctx) => {
    if (locateFramePath && !arrayEquals(ctx.framePath, locateFramePath)) return false;
    if (locateShadowPath && !arrayEquals(ctx.shadowPath, locateShadowPath)) return false;
    return true;
  };
  const stableElements = () => {
    const seen = new Set();
    const elements = [];
    for (const ctx of contexts) {
      for (const raw of Array.from(ctx.root.querySelectorAll(interactiveSelector))) {
        const node = actionableElement(raw);
        if (!node || seen.has(node) || !isDisplayed(node, ctx) || !intersectsViewport(node, ctx)) continue;
        seen.add(node);
        elements.push({ node, ctx });
      }
    }
    elements.sort((a, b) => {
      const ar = rectFor(a.node, a.ctx);
      const br = rectFor(b.node, b.ctx);
      if (!ar || !br) return 0;
      return ar.top - br.top || ar.left - br.left || ar.width * ar.height - br.width * br.height;
    });
    return elements;
  };
  const stable = stableElements();
  const elements = stable
    .slice(0, maxElements)
    .map((entry, index) => describe(entry.node, index + 1, entry.ctx))
    .filter(Boolean);
  const snapshot = {
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    elementCount: stable.length,
    elements
  };

  const findBySelector = (selector) => {
    let invalidSelector = false;
    for (const ctx of contexts) {
      if (!contextMatches(ctx)) continue;
      try {
        const found = ctx.root.querySelector(selector);
        if (found) return { node: actionableElement(found), ctx };
      } catch (error) {
        invalidSelector = true;
      }
    }
    return invalidSelector ? { error: "Invalid element selector: " + String(selector) } : null;
  };
  const findByTestId = (testId) => {
    const quoted = quoteAttr(testId);
    const selector = "[data-testid=\"" + quoted + "\"],[data-test-id=\"" + quoted + "\"],[data-cy=\"" + quoted + "\"]";
    for (const ctx of contexts) {
      if (!contextMatches(ctx)) continue;
      const found = ctx.root.querySelector(selector);
      if (found) return { node: actionableElement(found), ctx };
    }
    return null;
  };
  const searchableText = (node) => lowerText([
    labelFor(node),
    node.getAttribute("placeholder"),
    node.getAttribute("title"),
    node.getAttribute("alt"),
    node.getAttribute("name"),
    node.innerText,
    node.textContent,
    valueFor(node)
  ].filter(Boolean).join(" "));
  const findByText = (text) => {
    const needle = lowerText(text);
    if (!needle) return null;
    const candidates = [];
    const seen = new Set();
    for (const ctx of contexts) {
      if (!contextMatches(ctx)) continue;
      for (const raw of Array.from(ctx.root.querySelectorAll(interactiveSelector))) {
        const node = actionableElement(raw);
        if (!node || seen.has(node) || !isDisplayed(node, ctx)) continue;
        seen.add(node);
        candidates.push({ node, ctx });
      }
    }
    const exact = candidates.find((entry) => searchableText(entry.node) === needle);
    return exact || candidates.find((entry) => searchableText(entry.node).includes(needle)) || null;
  };
  const targetFromLocate = () => {
    if (!locate) return null;
    if (typeof locate.selector === "string" && locate.selector.trim()) return findBySelector(locate.selector.trim());
    if (typeof locate.testId === "string" && locate.testId.trim()) return findByTestId(locate.testId.trim());
    if (typeof locate.text === "string" && locate.text.trim()) return findByText(locate.text.trim());
    if (Number.isFinite(Number(locate.elementIndex))) {
      const index = Math.max(1, Math.floor(Number(locate.elementIndex)));
      const entry = stable[index - 1];
      if (!entry) return { error: "No element exists at index " + index + "." };
      return entry;
    }
    return null;
  };
  const rawTarget = targetFromLocate();
  if (rawTarget && rawTarget.error) return { snapshot, target: null, error: rawTarget.error };
  let target = rawTarget && rawTarget.node && rawTarget.node.nodeType === Node.ELEMENT_NODE ? rawTarget.node : null;
  const targetContext = rawTarget && rawTarget.ctx ? rawTarget.ctx : contexts[0];
  if (target && typeof target.scrollIntoView === "function" && !intersectsViewport(target, targetContext)) {
    target.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  }
  if (target && !isDisplayed(target, targetContext)) target = null;
  if (target && shouldFocus) {
    const tagName = target.tagName ? target.tagName.toLowerCase() : "";
    const editable = target.isContentEditable
      || tagName === "input"
      || tagName === "textarea"
      || tagName === "select";
    const readOnly = "readOnly" in target ? Boolean(target.readOnly) : false;
    const disabled = "disabled" in target ? Boolean(target.disabled) : false;
    if (editableRequired && (!editable || readOnly || disabled)) {
      return { snapshot, target: null, error: "Matching element is not editable." };
    }
    if (typeof target.focus === "function") target.focus({ preventScroll: true });
    if (shouldSelect && typeof target.select === "function") target.select();
    if (shouldClear) {
      if ("value" in target) {
        target.value = "";
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (target.isContentEditable) {
        target.textContent = "";
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
    }
  }
  const describedTarget = target ? describe(target, 0, targetContext) : null;
  return {
    readyState: document.readyState,
    snapshot,
    target: describedTarget,
    error: locate && !describedTarget ? "No matching element was found." : null
  };
}
`;

/**
 * Numbered element-map overlay. Painted just before a screenshot so an agent
 * can point at "element 12" instead of guessing coordinates, then removed
 * again with `{ clear: true }`.
 */
export const AGENT_ELEMENT_MAP_OVERLAY_FUNCTION = String.raw`
function(inputArg) {
  const input = inputArg && typeof inputArg === "object" ? inputArg : {};
  const overlayId = "__ade_agent_element_map_overlay__";
  const existing = document.getElementById(overlayId);
  if (existing) existing.remove();
  if (input.clear === true) return { ok: true, cleared: true };
  const elements = Array.isArray(input.elements) ? input.elements : [];
  if (!elements.length || !document.body) return { ok: true, count: 0 };
  const root = document.createElement("div");
  root.id = overlayId;
  root.setAttribute("aria-hidden", "true");
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    font: "12px/1.2 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    color: "#f8fafc",
  });
  const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  let count = 0;
  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    const frame = element.frame && typeof element.frame === "object" ? element.frame : {};
    const x = clamp(number(frame.x), 0, viewportWidth);
    const y = clamp(number(frame.y), 0, viewportHeight);
    const right = clamp(number(frame.x) + number(frame.width), 0, viewportWidth);
    const bottom = clamp(number(frame.y) + number(frame.height), 0, viewportHeight);
    const width = Math.max(1, right - x);
    const height = Math.max(1, bottom - y);
    if (width <= 1 || height <= 1) continue;
    const index = String(element.index || count + 1);
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      left: x + "px",
      top: y + "px",
      width: width + "px",
      height: height + "px",
      zIndex: "1",
      boxSizing: "border-box",
      border: "2px solid #0ea5e9",
      background: "rgba(14, 165, 233, 0.12)",
      boxShadow: "0 0 0 1px rgba(15, 23, 42, 0.88), 0 0 0 4px rgba(14, 165, 233, 0.18)",
      borderRadius: "4px",
    });
    const label = document.createElement("div");
    label.textContent = index;
    Object.assign(label.style, {
      position: "fixed",
      left: clamp(x, 0, viewportWidth - 28) + "px",
      top: clamp(y - 18, 0, viewportHeight - 18) + "px",
      zIndex: "2",
      minWidth: "18px",
      height: "18px",
      padding: "0 5px",
      boxSizing: "border-box",
      borderRadius: "9px",
      background: "#0284c7",
      color: "white",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontWeight: "700",
      letterSpacing: "0",
      boxShadow: "0 1px 5px rgba(15, 23, 42, 0.5)",
    });
    root.appendChild(box);
    root.appendChild(label);
    count += 1;
  }
  document.body.appendChild(root);
  return { ok: true, count };
}
`;
