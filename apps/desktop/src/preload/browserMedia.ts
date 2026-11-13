import { contextBridge } from "electron";

/**
 * The built-in browser's media hook, a session preload for every browser tab.
 *
 * The web has no way to press a page's media session buttons from outside:
 * `navigator.mediaSession.setActionHandler` stores the handlers, and nothing
 * reads them back. So before the page's own scripts run, this wraps that one
 * method (and `HTMLMediaElement.prototype.play`, to know which element plays
 * even when it is not in the document) in the page's main world. ADE's Now
 * Playing reader then asks over two synchronous window events:
 *
 * - `__ade_media_query` with an object `detail`: the hook fills in `actions`
 *   (the registered action names) and `element` (the last element that played).
 * - `__ade_media_action` with `{ action }`: the hook calls that handler and
 *   sets `handled`.
 *
 * Nothing is exposed as a global and no page data leaves the page; ADE's main
 * process runs the asking script in the tab (`browserMediaSessions.ts`).
 */
function installAdeMediaHook(): void {
  const w = window as Window & { MediaSession?: { prototype: MediaSession } };
  const handlers = new Map<string, (details: { action: string }) => void>();
  const proto = w.MediaSession?.prototype;
  if (proto && typeof proto.setActionHandler === "function") {
    const original = proto.setActionHandler;
    proto.setActionHandler = function setActionHandler(this: MediaSession, action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
      if (typeof handler === "function") handlers.set(action, handler as (details: { action: string }) => void);
      else handlers.delete(action);
      return original.call(this, action, handler);
    };
  }
  let last: WeakRef<HTMLMediaElement> | null = null;
  const remember = (element: unknown) => {
    if (element instanceof HTMLMediaElement) last = new WeakRef(element);
  };
  const mediaProto = typeof HTMLMediaElement === "function" ? HTMLMediaElement.prototype : null;
  if (mediaProto && typeof mediaProto.play === "function") {
    const play = mediaProto.play;
    mediaProto.play = function playMedia(this: HTMLMediaElement) {
      remember(this);
      return play.call(this);
    };
  }
  // `play` does not bubble; capture sees it for elements in the document.
  w.addEventListener("play", (event) => remember(event.target), true);
  w.addEventListener("__ade_media_query", (event) => {
    const detail = (event as CustomEvent).detail as { actions?: string[]; element?: HTMLMediaElement | null } | null;
    if (!detail || typeof detail !== "object") return;
    detail.actions = Array.from(handlers.keys());
    detail.element = last?.deref() ?? null;
  });
  w.addEventListener("__ade_media_action", (event) => {
    const detail = (event as CustomEvent).detail as { action?: string; handled?: boolean } | null;
    const action = detail && typeof detail.action === "string" ? detail.action : null;
    const handler = action ? handlers.get(action) : undefined;
    if (!detail || !action || !handler) return;
    try {
      handler({ action });
      detail.handled = true;
    } catch {
      // The page's own handler threw; nothing ADE can do about it.
    }
  });
}

/**
 * Chrome's brand in `navigator.userAgentData`, to match the headers.
 *
 * The main process sends Chrome's identity on every request
 * (`builtInBrowserChromeIdentity.ts`); a page that reads the same facts from
 * script must see the same answer, or the disagreement is itself the tell.
 * Electron's list has Chromium and the GREASE brand but not "Google Chrome",
 * so this adds it to `brands` and to the high-entropy `brands` and
 * `fullVersionList`, with Chromium's version. Nothing else changes, and a page
 * without `userAgentData` (an insecure origin) is left alone, as in Chrome.
 */
function installChromeBrandHook(): void {
  type Brand = { brand: string; version: string };
  const w = window as Window & { NavigatorUAData?: { prototype: object } };
  const proto = w.NavigatorUAData?.prototype as {
    brands?: Brand[];
    getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
  } | undefined;
  if (!proto) return;
  const withChrome = (list: unknown, full = false): unknown => {
    if (!Array.isArray(list)) return list;
    const brands = list as Brand[];
    // Read at use, not at install: a device preset changes the UA later, and a
    // non-Chrome one (Safari on iPhone and iPad) must keep its own list.
    const fullVersion = /Chrome\/(\d+(?:\.\d+)*)/.exec(navigator.userAgent)?.[1] ?? null;
    if (!fullVersion) return brands;
    if (brands.some((entry) => entry?.brand === "Google Chrome")) return brands;
    const chromium = brands.find((entry) => entry?.brand === "Chromium");
    if (!chromium) {
      // An overridden UA can leave the list empty; build Chrome's own.
      const version = full ? fullVersion : fullVersion.split(".")[0]!;
      return Object.freeze([
        { brand: "Not?A_Brand", version: full ? "24.0.0.0" : "24" },
        { brand: "Chromium", version },
        { brand: "Google Chrome", version },
      ].map((entry) => Object.freeze(entry)));
    }
    const next = brands.slice();
    next.splice(next.indexOf(chromium) + 1, 0, { brand: "Google Chrome", version: chromium.version });
    return Object.freeze(next.map((entry) => Object.freeze({ ...entry })));
  };
  const brandsDescriptor = Object.getOwnPropertyDescriptor(proto, "brands");
  const brandsGetter = brandsDescriptor?.get;
  if (brandsDescriptor && brandsGetter) {
    Object.defineProperty(proto, "brands", {
      ...brandsDescriptor,
      get(this: unknown) {
        return withChrome(brandsGetter.call(this));
      },
    });
  }
  const highEntropy = proto.getHighEntropyValues;
  if (typeof highEntropy === "function") {
    Object.defineProperty(proto, "getHighEntropyValues", {
      configurable: true,
      writable: true,
      value: function getHighEntropyValues(this: unknown, hints: string[]) {
        return highEntropy.call(this, hints).then((values) => {
          const result = { ...values };
          if ("brands" in result) result.brands = withChrome(result.brands);
          if ("fullVersionList" in result) result.fullVersionList = withChrome(result.fullVersionList, true);
          return result;
        });
      },
    });
  }
}

try {
  contextBridge.executeInMainWorld({ func: installAdeMediaHook });
} catch {
  // A page where the main world is not reachable: Now Playing falls back to the page's media elements.
}
try {
  contextBridge.executeInMainWorld({ func: installChromeBrandHook });
} catch {
  // Main world unreachable: the request headers still carry Chrome's identity.
}
