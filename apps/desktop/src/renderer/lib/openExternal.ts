import type { AppNavigationTarget, OpenProjectBinding } from "../../shared/types/core";
import type { BrowserLinkOpenMode } from "../../shared/types/config";
import { parseLoopbackUrl } from "../../shared/remoteLoopbackUrl";
import { completeBrowserUrl } from "./browserUrl";
import { isMacRuntimeTarget } from "./platform";
import { resolveLinkOpenTarget, type LinkOpenModifiers } from "./linkOpenTarget";
import { holdBrowserLinkOpen } from "./pendingBrowserLinkOpens";

export const ADE_OPEN_BUILT_IN_BROWSER_EVENT = "ade:open-built-in-browser";

export type OpenBuiltInBrowserDetail = {
  url: string;
  /**
   * The machine the link came from (a chat's pin). Null means the window's
   * own machine. A pane that opens the event uses it to decide what
   * `localhost` means.
   */
  runtimePin?: OpenProjectBinding | null;
};

/** Where a link was clicked, for the cases where that changes what it means. */
export type LinkOpenContext = {
  /** The pin of the chat or terminal the link is in. Omit for the window's machine. */
  runtimePin?: OpenProjectBinding | null;
};

/**
 * The machine the active project tab is bound to. Kept here, not read from the
 * app store, because this module is imported almost everywhere and the store
 * is not. `App` keeps it current.
 */
let windowRuntimeBinding: OpenProjectBinding | null = null;

export function setWindowRuntimeBinding(binding: OpenProjectBinding | null): void {
  windowRuntimeBinding = binding;
}

/**
 * The remote machine a loopback link belongs to, or null when it is not a
 * loopback link or belongs to this computer.
 *
 * A chat on another machine that prints `http://localhost:4180` is talking
 * about that machine's port 4180. Opening it here, in this computer's browser or
 * the system browser, reaches this computer's port 4180, which is nothing.
 */
export function remoteMachineForLoopbackLink(
  url: string,
  context?: LinkOpenContext | null,
): Extract<OpenProjectBinding, { kind: "remote" }> | null {
  if (!parseLoopbackUrl(url)) return null;
  const pin = context?.runtimePin ?? windowRuntimeBinding;
  return pin?.kind === "remote" ? pin : null;
}

type BuiltInBrowserNavigationOptions = {
  newTab: boolean;
  projectRoot?: string | null;
  tabCollection?: "personal";
};

type BuiltInBrowserNavigationFailureOptions = {
  fallbackToExternal?: boolean;
  onFailure?: () => void;
};

// Renderer-local event that routes an in-app `ade://` deeplink through ADE's
// internal navigation. App.tsx listens for this, parses the URL, and dispatches
// the resulting target through the same handler that inbound OS/CLI deeplinks
// use — so an `ade://artifact/<id>` (or lane/session/pr/…) opens the right ADE
// surface instead of being handed to the external-URL IPC (which rejects every
// non-http(s) scheme, swallowing the click).
export const ADE_OPEN_DEEPLINK_EVENT = "ade:open-deeplink";

export type OpenDeeplinkDetail = {
  url: string;
};

// Same internal navigation as `ADE_OPEN_DEEPLINK_EVENT`, entered one step later:
// with an already-resolved `AppNavigationTarget` instead of a URL to parse. Chat
// surfaces that carry a structured target (`ade_card.navTarget`) use this so they
// do not have to round-trip through a string only for App.tsx to parse it back.
export const ADE_NAVIGATE_TARGET_EVENT = "ade:navigate-target";

export type NavigateTargetDetail = {
  target: AppNavigationTarget;
};

export function navigateToAppTarget(target: AppNavigationTarget | null | undefined): void {
  if (!target || typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<NavigateTargetDetail>(ADE_NAVIGATE_TARGET_EVENT, { detail: { target } }),
    );
  } catch {
    /* no-op */
  }
}

export function openAdeDeeplink(url: string | undefined | null): void {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return;
  if (typeof window === "undefined") {
    // No renderer to route through — fall back to the external opener, which is
    // a no-op for ade:// but preserves prior behavior for any http(s) caller.
    openExternalUrl(trimmed);
    return;
  }
  window.dispatchEvent(
    new CustomEvent<OpenDeeplinkDetail>(ADE_OPEN_DEEPLINK_EVENT, {
      detail: { url: trimmed },
    }),
  );
}

/**
 * "127.0.0.1:8080" → "http://127.0.0.1:8080", and anything already complete
 * straight through. The completion rules themselves live in `lib/browserUrl`,
 * shared with the omnibox and the clipboard chip.
 */
export function normalizeBrowserUrlInput(url: string | undefined | null): string | null {
  return completeBrowserUrl(url, { fallback: "passthrough" });
}

export function canOpenInAdeBrowser(url: string | undefined | null): boolean {
  const normalized = normalizeBrowserUrlInput(url);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:"
      || parsed.protocol === "https:"
      // Local HTML specs produced inside a lane worktree.
      || parsed.protocol === "file:"
      || parsed.href === "about:blank";
  } catch {
    return false;
  }
}

export function openUrlInAdeBrowser(
  url: string | undefined | null,
  context?: LinkOpenContext | null,
): void {
  const normalized = normalizeBrowserUrlInput(url);
  if (!normalized || !canOpenInAdeBrowser(normalized)) {
    openExternalUrl(url);
    return;
  }

  if (typeof window === "undefined") {
    openExternalUrl(normalized);
    return;
  }

  const runtimePin = context?.runtimePin ?? null;
  const openEvent = new CustomEvent<OpenBuiltInBrowserDetail>(ADE_OPEN_BUILT_IN_BROWSER_EVENT, {
    detail: { url: normalized, runtimePin },
    cancelable: true,
  });
  const handledBySurface = !window.dispatchEvent(openEvent);
  if (handledBySurface) return;
  const remoteMachine = remoteMachineForLoopbackLink(normalized, context);
  if (remoteMachine) {
    // The event just revealed the Browser pane; let it open the link once it
    // mounts, so the URL bar shows the address that was clicked.
    holdBrowserLinkOpen({ url: normalized, runtimePin }, (link) => {
      navigateUrlInAdeBrowser(
        link.url,
        { newTab: true },
        // This computer's browser would load this computer's port: never fall back to it.
        { fallbackToExternal: false },
        link.runtimePin ?? remoteMachine,
      );
    });
    return;
  }
  navigateUrlInAdeBrowser(normalized, { newTab: true }, {}, runtimePin);
}

export function navigateUrlInAdeBrowser(
  url: string,
  options: BuiltInBrowserNavigationOptions,
  failureOptions: BuiltInBrowserNavigationFailureOptions = {},
  runtimePin: OpenProjectBinding | null = null,
): void {
  const browser = typeof window !== "undefined" ? window.ade?.builtInBrowser : undefined;
  if (!browser) {
    failureOptions.onFailure?.();
    if (failureOptions.fallbackToExternal !== false) openExternalUrl(url);
    return;
  }

  const navigation = runtimePin
    ? browser.navigate({ url, ...options }, runtimePin)
    : browser.navigate({ url, ...options });
  void navigation.catch(() => {
    failureOptions.onFailure?.();
    if (failureOptions.fallbackToExternal !== false) openExternalUrl(url);
  });
}

/* ── Link routing preference ──────────────────────────────────────────────── */

/**
 * The machine-local `browser.linkOpenMode` value, cached here rather than in the
 * app store.
 *
 * A link click has to answer "in-app or external" synchronously — there is no
 * await between mousedown and the window opening — so the preference has to be
 * in hand before the click, not fetched during it. It is read once per renderer
 * and refreshed by the Settings control that changes it.
 */
let linkOpenMode: BrowserLinkOpenMode = "in-app";
let linkOpenModeLoad: Promise<void> | null = null;

export function getLinkOpenMode(): BrowserLinkOpenMode {
  return linkOpenMode;
}

export function setLinkOpenMode(mode: BrowserLinkOpenMode): void {
  linkOpenMode = mode;
}

/** Loads the stored preference once. Safe to call from anywhere, repeatedly. */
export function refreshLinkOpenMode(force = false): Promise<void> {
  if (linkOpenModeLoad && !force) return linkOpenModeLoad;
  const config = typeof window !== "undefined" ? window.ade?.projectConfig : undefined;
  if (!config) return Promise.resolve();
  linkOpenModeLoad = config
    .get()
    .then((snapshot) => {
      setLinkOpenMode(snapshot.effective.browser?.linkOpenMode ?? "in-app");
    })
    .catch(() => {
      // An unreadable config is not worth a visible failure; the default holds.
    });
  return linkOpenModeLoad;
}

/**
 * Opens a link the user clicked inside ADE, honouring the preference and the
 * Mod/Shift overrides.
 *
 * Every in-content link click routes through here so the rule lives in one
 * place. Buttons that deliberately hand off to an external service (a provider's
 * docs, a GitHub App install page) keep calling `openExternalUrl` directly —
 * those are not "a link the user clicked", they are a specific destination the
 * product chose.
 */
export function openLinkFromUi(
  url: string | undefined | null,
  modifiers?: LinkOpenModifiers | null,
  context?: LinkOpenContext | null,
): void {
  if (!url) return;
  // Normalize once, for both branches. A terminal link is often written the way
  // a dev server prints it — `127.0.0.1:8080`, `[::1]:5173` — and handing that
  // raw to the OS opener made `new URL(...)` throw in main, which the renderer
  // then swallowed: the click did nothing at all, with no error, for every
  // scheme-less link once the preference was "In system browser".
  const normalized = completeBrowserUrl(url, { fallback: "passthrough" }) ?? url;
  const target = resolveLinkOpenTarget({
    mode: linkOpenMode,
    modifiers,
    isMac: isMacRuntimeTarget(),
  });
  if (!canOpenInAdeBrowser(normalized)) {
    openExternalUrl(normalized);
    return;
  }
  // Another machine's `localhost` only exists through ADE's tunnel, so it
  // always opens in the ADE browser, whatever the link preference says.
  if (target === "external" && !remoteMachineForLoopbackLink(normalized, context)) {
    openExternalUrl(normalized);
    return;
  }
  openUrlInAdeBrowser(normalized, context);
}

export function openExternalUrl(url: string | undefined | null): void {
  if (!url) return;
  const bridge =
    typeof window !== "undefined" ? window.ade?.app?.openExternal : undefined;
  if (bridge) {
    void bridge(url).catch(() => {});
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * `openExternalUrl`, but the caller learns whether the handoff worked.
 *
 * A sign-in flow that starts the browser has to know: with the browser open the
 * in-app prompt is a confirmation, and with it closed the prompt has to carry
 * the URL itself. `openExternalUrl` deliberately swallows a failed handoff,
 * which is right for a clicked link and wrong here.
 */
export async function tryOpenExternalUrl(url: string | undefined | null): Promise<boolean> {
  if (!url) return false;
  const bridge =
    typeof window !== "undefined" ? window.ade?.app?.openExternal : undefined;
  if (bridge) {
    try {
      await bridge(url);
      return true;
    } catch {
      return false;
    }
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  }
  return false;
}

// Warm the preference as soon as the renderer loads, so the first link click
// already has the right answer rather than the default.
if (typeof window !== "undefined") {
  void refreshLinkOpenMode();
}
