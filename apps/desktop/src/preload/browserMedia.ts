import { contextBridge, ipcRenderer } from "electron";
import { BUILT_IN_BROWSER_LOGIN_SUBMITTED_CHANNEL, type BuiltInBrowserLoginSubmission } from "../shared/types/builtInBrowserLoginCapture";

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

/**
 * "Save to Passwords?" after the person signs in by hand.
 *
 * This preload runs in the isolated world, which shares the page's DOM but
 * not its scripts, so a page can't see or fake these listeners' reads. When a
 * login form is sent (a submit, a click on its button, or Enter in its
 * password field), it reads the username and password and hands them to the
 * main process, which checks the tab's own URL and frame before offering to
 * save. A username-only step (the first page of a two-step sign-in) sends the
 * username alone. Fields ADE filled from Passwords are skipped: there is
 * nothing new to save.
 */
function installLoginCapture(): void {
  const MAX = 1024;
  const USERNAME_HINT = /user|email|login|account|identifier/i;
  let lastSentAt = 0;
  const filled = (input: HTMLInputElement) => input.hasAttribute("data-ade-vault-filled");
  const isTextual = (input: HTMLInputElement) => ["text", "email", "tel", ""].includes(input.type.toLowerCase());
  const visible = (input: HTMLInputElement) => !input.disabled && input.getClientRects().length > 0;
  const scopeFor = (node: Element | null): ParentNode => node?.closest("form") ?? document;
  const usernameIn = (scope: ParentNode, before: Element | null, hintedOnly = false): string | null => {
    const inputs = Array.from(scope.querySelectorAll("input")).filter((input) => isTextual(input) && visible(input) && input.value.trim());
    const preceding = before
      ? inputs.filter((input) => input.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_FOLLOWING)
      : inputs;
    const hinted = preceding.find((input) => {
      const autocomplete = (input.getAttribute("autocomplete") ?? "").toLowerCase();
      return autocomplete.includes("username") || autocomplete.includes("email") || input.type === "email"
        || USERNAME_HINT.test(`${input.name} ${input.id} ${input.getAttribute("aria-label") ?? ""}`);
    });
    const pick = hinted ?? (hintedOnly ? null : preceding[preceding.length - 1] ?? null);
    return pick ? pick.value.trim().slice(0, MAX) : null;
  };
  const capture = (origin: Element | null) => {
    const now = Date.now();
    if (now - lastSentAt < 1500) return;
    const scope = scopeFor(origin);
    const passwords = Array.from(scope.querySelectorAll<HTMLInputElement>("input[type=password]"))
      .filter((input) => visible(input) && input.value);
    let submission: BuiltInBrowserLoginSubmission | null = null;
    if (passwords.length > 0) {
      if (passwords.every(filled)) return;
      // Two different values: a change-password form; the new one is last.
      const distinct = new Set(passwords.map((input) => input.value));
      const chosen = distinct.size > 1 ? passwords[passwords.length - 1]! : passwords[0]!;
      submission = { username: usernameIn(scope, chosen), password: chosen.value.slice(0, MAX) };
    } else if (scope !== document) {
      // Only a real username or email field: never a search box's text.
      const username = usernameIn(scope, null, true);
      if (username) submission = { username, password: null };
    }
    if (!submission) return;
    lastSentAt = now;
    ipcRenderer.send(BUILT_IN_BROWSER_LOGIN_SUBMITTED_CHANNEL, submission);
  };
  window.addEventListener("submit", (event) => {
    if (event.target instanceof HTMLFormElement) capture(event.target);
  }, true);
  window.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button, input[type=submit], [role=button]") : null;
    if (!target) return;
    const scope = scopeFor(target);
    // Only a button next to a filled password field (or in a login form) counts.
    if (scope.querySelector("input[type=password]") || target.closest("form")) capture(target);
  }, true);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
    if (event.target.type === "password" || event.target.closest("form")) capture(event.target);
  }, true);
}

try {
  installLoginCapture();
} catch {
  // No DOM to watch (a blank frame); nothing to offer.
}
