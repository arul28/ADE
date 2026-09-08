/**
 * The headless-machine → attached-desktop browser handoff.
 *
 * `ade browser open` on a machine running only `ade serve` has no browser to
 * open: the built-in browser is a `WebContentsView` owned by an Electron main
 * process. Rather than failing at the desktop-bridge socket, the daemon emits
 * `built_in_browser_remote_request` on the runtime event stream that pinned
 * desktops already subscribe to, and a desktop holding a remote pin for that
 * lane opens the URL in ITS browser through a port-forward.
 */

export const BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT = "built_in_browser_remote_request" as const;

/** Emitted by the daemon; consumed by every desktop pinned to that machine. */
export type BuiltInBrowserRemoteRequest = {
  requestId: string;
  url: string;
  laneId: string | null;
  chatSessionId: string | null;
  openPanel: boolean;
  requestedAt: string;
};

export type BuiltInBrowserRemoteRequestEvent = {
  type: typeof BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT;
  request: BuiltInBrowserRemoteRequest;
};

/** Sent back by the desktop that took the request, over the pinned runtime. */
export type BuiltInBrowserRemoteRequestAck = {
  requestId: string;
  /** Absolute machine name of the desktop that opened it. */
  desktopLabel: string;
  accepted: boolean;
  /**
   * The desktop took the request but is waiting on a human.
   *
   * The first agent use of a (machine, port) pair needs a person to approve the
   * port forward, and nobody answers a prompt inside a 5s ack window — so the
   * desktop acks straight away with this set, the requester prints "waiting for
   * approval" and exits 0, and the navigation happens whenever the human gets
   * to it. `accepted` is true because the request WAS taken; only the page has
   * not loaded yet.
   */
  awaitingApproval?: boolean;
  /** Why it was refused (approval denied, no forward), when `accepted` is false. */
  reason?: string | null;
};

/** What `built_in_browser.navigate` returns instead of a status on a headless box. */
export type BuiltInBrowserForwardedToDesktop = {
  status: "forwarded_to_desktop";
  requestId: string;
  url: string;
  acknowledged: boolean;
  /** A desktop took it and is waiting for a human to approve the port. */
  awaitingApproval?: boolean;
  desktopLabel: string | null;
  reason: string | null;
};

export function isBuiltInBrowserForwardedToDesktop(
  value: unknown,
): value is BuiltInBrowserForwardedToDesktop {
  return Boolean(value)
    && typeof value === "object"
    && (value as { status?: unknown }).status === "forwarded_to_desktop";
}
