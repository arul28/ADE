export const ADE_OPEN_BUILT_IN_BROWSER_EVENT = "ade:open-built-in-browser";

export type OpenBuiltInBrowserDetail = {
  url: string;
};

// Coordination flag used by ChatBuiltInBrowserPanel to suppress the empty-state
// default-tab creation when a link-click navigation is racing the panel mount.
// Set synchronously here BEFORE the navigate IPC fires, then consumed (cleared)
// by the panel's default-tab effect on the next render. Without this, the panel
// can mount, observe getStatus() returning tabs: [], and create a Google tab
// before the link-click's navigate IPC arrives — yielding two tabs.
let pendingBuiltInBrowserNavigation = false;

export function markPendingBuiltInBrowserNavigation(): void {
  pendingBuiltInBrowserNavigation = true;
}

export function consumePendingBuiltInBrowserNavigation(): boolean {
  if (!pendingBuiltInBrowserNavigation) return false;
  pendingBuiltInBrowserNavigation = false;
  return true;
}

export function normalizeBrowserUrlInput(url: string | undefined | null): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[^\s/]+\.[^\s]+/.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export function canOpenInAdeBrowser(url: string | undefined | null): boolean {
  const normalized = normalizeBrowserUrlInput(url);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.href === "about:blank";
  } catch {
    return false;
  }
}

export function openUrlInAdeBrowser(url: string | undefined | null): void {
  const normalized = normalizeBrowserUrlInput(url);
  if (!normalized || !canOpenInAdeBrowser(normalized)) {
    openExternalUrl(url);
    return;
  }

  if (typeof window === "undefined") {
    openExternalUrl(normalized);
    return;
  }

  // Mark the navigation as pending BEFORE dispatching the event so the panel —
  // which the event causes to mount via TerminalsPage — sees the flag in its
  // first default-tab effect and skips creating a Google tab.
  markPendingBuiltInBrowserNavigation();
  window.dispatchEvent(new CustomEvent<OpenBuiltInBrowserDetail>(ADE_OPEN_BUILT_IN_BROWSER_EVENT, {
    detail: { url: normalized },
  }));
  const browser = window.ade?.builtInBrowser;
  if (browser) {
    void browser.navigate({ url: normalized, newTab: true }).catch(() => {
      // Navigation failed: clear the flag so a subsequent panel open can still
      // surface the default tab.
      consumePendingBuiltInBrowserNavigation();
      openExternalUrl(normalized);
    });
    return;
  }
  // No bridge — clear the flag we just set since no IPC navigation will arrive.
  consumePendingBuiltInBrowserNavigation();
  openExternalUrl(normalized);
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
