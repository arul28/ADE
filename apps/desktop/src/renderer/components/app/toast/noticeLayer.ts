/**
 * The notice layer, renderer side: the corner cards' own see-through window
 * for when a live browser page covers the corner (see `shared/noticeLayer.ts`).
 *
 * The window is opened with `window.open`, so it shares this renderer's
 * process and its DOM is ours to write: `ToastViewport` portals the very same
 * cards into its body, with the same React state, handlers and animations.
 * This module builds that document once and keeps it looking like the app:
 * the app's stylesheets and the root element's theme attributes are mirrored
 * into it and kept in step (theme switches, dev hot reloads), and its own
 * background is forced transparent so only the cards show.
 *
 * One layer per renderer, opened on first need and kept (hidden while empty),
 * because opening a window is the expensive part.
 */
import { NOTICE_LAYER_FRAME_NAME } from "../../../../shared/noticeLayer";

export type NoticeLayer = {
  window: Window;
  /** Where the cards go; bottom-anchored, sized by its content. */
  host: HTMLElement;
};

const MIRRORED_ATTR = "data-ade-notice-layer-mirror";
const HOST_ID = "ade-notice-layer-host";

let current: (NoticeLayer & { dispose: () => void }) | null = null;

function mirrorAttributes(source: Element, target: Element): void {
  for (const attr of Array.from(target.attributes)) {
    if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
  }
  for (const attr of Array.from(source.attributes)) {
    if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
  }
}

/** Copy every app stylesheet into the layer, ahead of the layer's own rules. */
function mirrorStyles(source: Document, target: Document, before: Node): void {
  for (const node of Array.from(target.head.querySelectorAll(`[${MIRRORED_ATTR}]`))) node.remove();
  for (const node of Array.from(source.head.querySelectorAll('style, link[rel="stylesheet"]'))) {
    const copy = target.importNode(node, true) as HTMLElement;
    // Resolve against the app's own address, not about:blank's.
    if (copy.tagName === "LINK") copy.setAttribute("href", (node as HTMLLinkElement).href);
    copy.setAttribute(MIRRORED_ATTR, "");
    target.head.insertBefore(copy, before);
  }
}

function buildLayer(child: Window): NoticeLayer & { dispose: () => void } {
  const doc = child.document;
  doc.title = "ADE notices";
  const base = doc.querySelector("base") ?? doc.head.appendChild(doc.createElement("base"));
  base.href = document.baseURI;

  // The layer's own rules come last so a mirrored `body { background }` loses.
  const own = doc.createElement("style");
  own.textContent = [
    "html, body { background: transparent !important; margin: 0 !important; padding: 0 !important;",
    "  width: 100%; height: 100%; overflow: hidden !important; }",
    `#${HOST_ID} { position: absolute; display: flex; flex-direction: column; justify-content: flex-end; }`,
  ].join("\n");
  doc.head.appendChild(own);

  mirrorStyles(document, doc, own);
  mirrorAttributes(document.documentElement, doc.documentElement);
  mirrorAttributes(document.body, doc.body);

  doc.body.replaceChildren();
  const host = doc.createElement("div");
  host.id = HOST_ID;
  doc.body.appendChild(host);

  let stylesQueued = false;
  const headObserver = new MutationObserver(() => {
    if (stylesQueued) return;
    stylesQueued = true;
    queueMicrotask(() => {
      stylesQueued = false;
      if (!child.closed) mirrorStyles(document, doc, own);
    });
  });
  headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  const rootObserver = new MutationObserver(() => {
    if (child.closed) return;
    mirrorAttributes(document.documentElement, doc.documentElement);
    mirrorAttributes(document.body, doc.body);
  });
  rootObserver.observe(document.documentElement, { attributes: true });
  rootObserver.observe(document.body, { attributes: true });

  return {
    window: child,
    host,
    dispose: () => {
      headObserver.disconnect();
      rootObserver.disconnect();
    },
  };
}

/**
 * The layer, opened on first call. Null where there is none to open (the web
 * build, or a refused `window.open`): the caller then draws in its own corner.
 */
export function openNoticeLayer(): NoticeLayer | null {
  if (current && !current.window.closed) return current;
  current?.dispose();
  current = null;
  if (!window.ade?.noticeLayer?.available) return null;
  let child: Window | null = null;
  try {
    // An empty address never navigates a layer that is already open (a dev
    // hot reload of this module); the main process lets this one name through.
    child = window.open("", NOTICE_LAYER_FRAME_NAME);
  } catch {
    return null;
  }
  if (!child) return null;
  try {
    current = buildLayer(child);
  } catch {
    // A layer we cannot write into is no layer at all.
    try {
      child.close();
    } catch {
      // already gone
    }
    return null;
  }
  return current;
}

/** Close the layer (the renderer is going away). */
export function closeNoticeLayer(): void {
  if (!current) return;
  current.dispose();
  try {
    current.window.close();
  } catch {
    // already gone
  }
  current = null;
}
