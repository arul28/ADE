/**
 * The host-call map, in one file.
 *
 * `ChatAppControlPanel.tsx` (1,540 lines, still in the binary) reaches the host
 * SIXTEEN times: fifteen `window.ade.appControl.*` verbs and one
 * `window.ade.agentChat.*`. Every one has exactly one counterpart here, and the
 * mapping is the whole point of the page tier:
 *
 * | compiled call                          | page action              |
 * |----------------------------------------|--------------------------|
 * | `window.ade.appControl.getStatus`      | `invoke("pageStatus")`   |
 * | `…listTargets`                         | `invoke("pageTargets")`  |
 * | `…attachToTarget`                      | `invoke("pageAttachTarget")` |
 * | `…launchInTerminal`                    | `invoke("pageLaunch")`   |
 * | `…connect`                             | `invoke("pageConnect")`  |
 * | `…stop`                                | `invoke("pageStop")`     |
 * | `…focusWindow`                         | `invoke("pageFocusWindow")` |
 * | `…minimizeWindow`                      | `invoke("pageMinimizeWindow")` |
 * | `…getSnapshot`                         | `invoke("pageSnapshot")` |
 * | `…click`                               | `invoke("pageClick")`    |
 * | `…scroll`                              | `invoke("pageScroll")`   |
 * | `…typeText`                            | `invoke("pageTypeText")` |
 * | `…selectPoint`                         | `invoke("pageSelectPoint")` |
 * | `…inspectPoint`                        | `invoke("pageInspectPoint")` |
 * | `…onEvent` (session-started/updated/stopped) | `events.on("changed")` + `pageStatus` |
 * | `…onEvent` (`frame`)                   | the HOST engine, `hostEngine.place` |
 * | `window.ade.agentChat.saveTempAttachment` | `invoke("pageAttachContext")` |
 * | the `controlDisabledReason` PROP       | `pageStatus().disabledReason` |
 * | `window.sessionStorage` panel state    | `host/uiState.ts`, the `ui-state` collection |
 *
 * The plugin's own child process answers every one of them
 * (`../../pageActions.js`), which is what makes the page work identically on
 * desktop and in the hosted web client: the child holds the CDP session and the
 * runtime pin, and the page holds neither.
 *
 * ## The two rows that are not an invoke
 *
 * `onEvent` split in half. The SESSION half — started, updated, stopped — is a
 * `changed` event on the bridge plus a re-read of `pageStatus`, because a page
 * cannot hold a host subscription across a placement that is destroyed when it
 * hides. The FRAME half does not cross the bridge at all: 30fps base64 PNGs
 * through a structured clone per frame is a cost nothing here would pay, so the
 * live view stays a host engine and this page reserves a rect for it
 * (`host/engine.ts`).
 *
 * ## Why a mutation never throws
 *
 * Every MUTATION below answers `{ok, message}` and the child never rejects for a
 * refusal. A rejected promise reaches the page as an exception beside a form the
 * reader has already filled in, and the page would have to invent the banner
 * itself. Reads may reject, and two of them do — `pageSnapshot` and the two
 * point reads — because an empty snapshot and "the app has no elements" are
 * indistinguishable, and a lie the page cannot detect is worse than a rejection
 * it can retry. `pageStatus` and `pageTargets` degrade instead: the status card
 * has an honest place for a failure to live and an empty target list reads
 * correctly as "no windows".
 */

import { requireBridge } from "../bridge";
import type {
  AppControlCoordinateSpace,
  AppControlContextItem,
  AppControlInspectResult,
  AppControlSelectResult,
  AppControlSnapshot,
  AppControlSession,
  AppControlStatus,
  AppControlTarget,
} from "../types";

/** What every mutating page action answers. Never a throw for a host refusal. */
export type PageActionResult = {
  ok: boolean;
  message?: string | null;
  [key: string]: unknown;
};

export type PageSessionResult = PageActionResult & { session?: AppControlSession | null };

function call<T>(action: string, args?: Record<string, unknown>): Promise<T> {
  return requireBridge().invoke(action, args ?? {}) as Promise<T>;
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

/**
 * The status, plus the reason this host refuses to drive.
 *
 * `disabledReason` is the one field with no compiled counterpart in the panel
 * itself: it was a PROP the chat or the rail handed down. A page has no props,
 * so the child answers it beside the status and the blockers card reads it from
 * exactly one place.
 */
export const getStatus = (): Promise<AppControlStatus> => call("pageStatus");

export const listTargets = (): Promise<AppControlTarget[]> => call("pageTargets");

export const getSnapshot = (args?: { projectRoot?: string | null }): Promise<AppControlSnapshot> =>
  call("pageSnapshot", (args ?? {}) as Record<string, unknown>);

/* ── The session ────────────────────────────────────────────────────────── */

export type PageLaunchArgs = {
  projectRoot?: string | null;
  laneId?: string | null;
  command: string;
  cwd?: string | null;
  chatSessionId?: string | null;
};

/**
 * Launch a command in ADE's terminal and wait for its CDP port.
 *
 * The compiled call passed `force: true` unconditionally, and so does the
 * child: the reader pressed Run with a session already showing, which is a
 * deliberate replacement rather than a race.
 */
export const launchInTerminal = (args: PageLaunchArgs): Promise<PageSessionResult> =>
  call("pageLaunch", args as unknown as Record<string, unknown>);

export const connectToPort = (args: {
  projectRoot?: string | null;
  laneId?: string | null;
  cdpPort: number;
  chatSessionId?: string | null;
}): Promise<PageSessionResult> => call("pageConnect", args as Record<string, unknown>);

export const stopSession = (): Promise<PageActionResult> => call("pageStop");

export const attachToTarget = (targetId: string): Promise<PageSessionResult> =>
  call("pageAttachTarget", { targetId });

export const focusWindow = (): Promise<PageActionResult> => call("pageFocusWindow");

export const minimizeWindow = (): Promise<PageActionResult> => call("pageMinimizeWindow");

/* ── Driving the app ────────────────────────────────────────────────────── */

export type PagePointArgs = {
  x: number;
  y: number;
  coordinateSpace?: AppControlCoordinateSpace;
};

export const click = (args: PagePointArgs): Promise<PageActionResult> =>
  call("pageClick", { coordinateSpace: "viewport", ...args });

export const scroll = (args: PagePointArgs & { deltaX: number; deltaY: number }): Promise<PageActionResult> =>
  call("pageScroll", { coordinateSpace: "viewport", ...args });

export const typeText = (text: string): Promise<PageActionResult> => call("pageTypeText", { text });

/* ── Inspecting ─────────────────────────────────────────────────────────── */

/**
 * Read what is at a point, WITHOUT selecting it.
 *
 * The compiled pane called this on a debounced hover to draw the outline the
 * cursor was over. The page has no cursor over the live view — the host paints
 * it — so this is the read behind the explicit Inspect press, and it is the one
 * that fills the inspect list.
 */
export const inspectPoint = (args: {
  projectRoot?: string | null;
  x: number;
  y: number;
  coordinateSpace?: AppControlCoordinateSpace;
}): Promise<AppControlInspectResult> =>
  call("pageInspectPoint", { coordinateSpace: "viewport", includeScreenshot: false, ...args });

/** Read what is at a point AND make it the selection the chat can be handed. */
export const selectPoint = (args: {
  projectRoot?: string | null;
  x: number;
  y: number;
  coordinateSpace?: AppControlCoordinateSpace;
}): Promise<AppControlSelectResult> =>
  call("pageSelectPoint", { coordinateSpace: "viewport", includeScreenshot: false, ...args });

/**
 * Hand a selected element to the chat as context.
 *
 * The compiled pane did this in the RENDERER: it cropped the screenshot on a
 * canvas, called `agentChat.saveTempAttachment` with the base64, and invoked two
 * props (`onAddContext`, `onAddAttachment`) that the chat had passed down. A
 * page has neither the screenshot nor the props, so the whole step is one call
 * and the child does the crop and the attach on the side that already holds the
 * frame.
 */
export const attachContext = (item: AppControlContextItem): Promise<PageActionResult> =>
  call("pageAttachContext", { item: item as unknown as Record<string, unknown> });
