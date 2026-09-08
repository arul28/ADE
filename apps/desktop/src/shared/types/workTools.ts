/**
 * Read-only "what tool is the desktop using in this lane" state.
 *
 * The Work tools pane (browser, App Control, iOS, terminal, git, files) runs on
 * the desktop: it owns a `WebContentsView`, a CDP connection, and a simulator
 * stream. None of that can exist on a phone or in a browser tab. What CAN cross
 * is the *description* of it — which tool is open, which tabs the browser has,
 * which app App Control is driving, and the last frame either of them captured.
 *
 * So iOS and the hosted web client render this shape and nothing else. There is
 * no control surface here on purpose; see `WORK_TOOLS_CONTROL_HINT`.
 */

/**
 * Mirrors the renderer's `WorkSidebarTab`. It cannot import that union (this
 * file is also compiled into the daemon, which has no renderer), but drift is
 * not silent: `useWorkSidebarTool` passes a `WorkSidebarTab` straight into
 * `setActiveTool`, so a tab added there and not here fails to compile.
 */
export const WORK_TOOL_IDS = [
  "terminal",
  "git",
  "files",
  "ios",
  "app-control",
  "browser",
] as const;

export type WorkToolId = (typeof WORK_TOOL_IDS)[number];

export function isWorkToolId(value: unknown): value is WorkToolId {
  return typeof value === "string" && (WORK_TOOL_IDS as readonly string[]).includes(value);
}

/** Shown wherever a read-only client renders a tool it cannot drive. */
export const WORK_TOOLS_CONTROL_HINT = "Control from the desktop";

/** Empty state when this machine has no desktop attached at all. */
export const WORK_TOOLS_NO_DESKTOP_MESSAGE =
  "Tools run on the desktop. Open ADE on your Mac to see them here.";

/**
 * Why `browser` is null. The browser lives in the desktop's Electron main
 * process and the daemon proxies it over `desktop-bridge.sock`, so "no desktop
 * attached to this machine" is a normal, non-error state that clients must
 * render as absence rather than as a failure.
 *
 * `desktop_not_attached_for_project` is the narrower version of that: a desktop
 * IS running on this machine, it just has no window open for this project. It is
 * a separate reason because "open ADE on your Mac" is the wrong instruction for
 * a user whose ADE is already open — they need to open THIS project.
 *
 * `browser_pane_not_opened` is narrower still: the project IS open in a window,
 * but its Browser pane has never been used, so there is no tab collection to
 * read. The desktop deliberately does not build one to answer a poll (that
 * would restore and load a background project's persisted tabs for a pane
 * nobody opened), so this is a real, permanent-until-you-click state — and
 * telling that user the project is not open would be a lie about something one
 * click away.
 */
export type WorkToolsUnavailableReason =
  | "desktop_not_attached"
  | "desktop_not_attached_for_project"
  | "browser_pane_not_opened"
  | "unsupported"
  | "error";

/**
 * The one place the five reasons become sentences.
 *
 * Every read-only client renders the same absence, so the copy lives with the
 * union rather than with any one view. iOS keeps its own Swift `switch` (it
 * cannot import this file), but it switches on the same strings —
 * `apps/ios/ADE/Views/Work/WorkToolsSheet.swift`.
 *
 * The parameter is deliberately widened with `| string`: the reason arrives as
 * an unvalidated field on a daemon payload, and a phone or web client running
 * an older build must degrade to a sentence rather than render `undefined`. The
 * cost of that tolerance is that this is NOT exhaustive — adding a member to
 * the union above still compiles here and silently lands on the default. When
 * you add one, word it here and in the Swift switch in the same change.
 *
 * An unknown or absent reason falls back to the common case rather than
 * inventing a diagnosis.
 */
export function workToolsUnavailableMessage(
  reason: WorkToolsUnavailableReason | string | null | undefined,
): string {
  switch (reason) {
    case "unsupported":
      return "The browser isn't available on this machine.";
    case "error":
      return "Couldn't read the browser's state.";
    case "desktop_not_attached_for_project":
      // Distinct from the default on purpose: ADE Desktop *is* running, it just
      // doesn't have this project open, so "open ADE on your Mac" would send the
      // user to look at an app that is already in front of them.
      return "ADE Desktop doesn't have this project open. Open it on your Mac to see its tabs.";
    case "browser_pane_not_opened":
      // The project IS open on the desktop; only the Browser pane is unused, so
      // the instruction is one click, not "open the project".
      return "Open the Browser tool on the desktop to see tabs here.";
    default:
      return "The browser runs in ADE Desktop. Open ADE on your Mac to see its tabs.";
  }
}

export type WorkToolsBrowserTab = {
  id: string;
  title: string | null;
  url: string | null;
  ownerChatSessionId: string | null;
  /** True while this tab is capturing a video recording. */
  recording: boolean;
  active: boolean;
  /**
   * Set while the agent has handed this tab to a human to sign in on the
   * desktop. Read-only everywhere this state travels: the phone cannot hand a
   * tab back any more than it can click one, but it must be able to explain why
   * the lane looks stalled.
   */
  handoffReason: string | null;
};

/**
 * A screenshot the desktop already wrote to disk. Only the metadata travels
 * here; bytes are fetched separately through `readObservationPreview` so a
 * state broadcast never carries an image.
 */
export type WorkToolsObservation = {
  /** Host-absolute path. Opaque to clients — pass it back verbatim. */
  path: string;
  capturedAt: string;
  /** One line describing what produced the frame, e.g. "click · Sign in". */
  caption: string | null;
};

export type WorkToolsBrowserState = {
  activeTabId: string | null;
  tabs: WorkToolsBrowserTab[];
  latestObservation: WorkToolsObservation | null;
};

export type WorkToolsAppControlState = {
  appName: string;
  status: string;
  driver: string;
  latestObservation: WorkToolsObservation | null;
};

export type WorkToolsLaneState = {
  laneId: string;
  /** Last tool the desktop published for this lane; null if it never did. */
  activeTool: WorkToolId | null;
  activeToolUpdatedAt: string | null;
  browser: WorkToolsBrowserState | null;
  /** Non-null exactly when `browser` is null. */
  browserUnavailable: WorkToolsUnavailableReason | null;
  appControl: WorkToolsAppControlState | null;
  capturedAt: string;
};

export type WorkToolsSetActiveToolArgs = {
  laneId: string;
  tool: WorkToolId | null;
};

export type WorkToolsGetLaneStateArgs = {
  laneId: string;
};

export type WorkToolsReadObservationPreviewArgs = {
  /** Path taken verbatim from a `WorkToolsObservation`. */
  path: string;
  /**
   * The caller's own lane, injected by `adeRpcServer`'s `work_tools` scoping —
   * never supplied by the caller. The aggregator re-reads the observation's
   * sidecar and refuses one owned by a different lane, because a path is not a
   * permission. Absent for user clients, which are unscoped.
   */
  callerLaneId?: string | null;
};

export type WorkToolsObservationPreview = {
  dataUrl: string;
  mimeType: string;
  byteLength: number;
};

export const WORK_TOOLS_STATE_CHANGED_EVENT = "work_tools_state_changed";

export type WorkToolsStateChangedEvent = {
  type: typeof WORK_TOOLS_STATE_CHANGED_EVENT;
  laneId: string;
};
