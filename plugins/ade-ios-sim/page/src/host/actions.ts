/**
 * The host-call map, in one file.
 *
 * Every call the compiled iOS simulator pane made into ADE has exactly one
 * counterpart here, and the mapping is the whole point of the page tier.
 *
 * `ChatIosSimulatorPanel.tsx` (3,777 lines) makes **24 distinct
 * `window.ade.iosSimulator.*` calls**. Twenty of them are verbs the plugin's
 * own child can invoke on the `ios_simulator` action domain, and each has a
 * page action below. The other four are the host ENGINE's — the desktop window
 * capture that paints the live screen — and a guest cannot have them: they are
 * answered by `hostEngine.place` / `hostEngine.release` in `host/engine.ts`
 * instead, which is the page's whole side of the stream.
 *
 * | compiled call                                   | page call                             |
 * |-------------------------------------------------|---------------------------------------|
 * | `window.ade.iosSimulator.getStatus`              | `invoke("pageStatus")`                |
 * | `…listDevices`                                   | `invoke("pageDevices")`               |
 * | `…listLaunchTargets`                             | `invoke("pageLaunchTargets")`         |
 * | `…launch`                                        | `invoke("pageLaunch")`                |
 * | `…shutdown`                                      | `invoke("pageShutdown")`              |
 * | `…attachToChatSession`                           | `invoke("pageAttachChat")`            |
 * | `…getScreenSnapshot`                             | `invoke("pageScreenSnapshot")`        |
 * | `…selectPoint`                                   | `invoke("pageSelectPoint")`           |
 * | `…tap`                                           | `invoke("pageTap")`                   |
 * | `…typeText`                                      | `invoke("pageTypeText")`              |
 * | `…drag`                                          | `invoke("pageDrag")`                  |
 * | `…startStream`                                   | `invoke("pageStartStream")`           |
 * | `…stopStream`                                    | `invoke("pageStopStream")`            |
 * | `…getStreamStatus`                               | `invoke("pageStreamStatus")`          |
 * | `…listPreviewTargets`                            | `invoke("pagePreviewTargets")`        |
 * | `…resolvePreviewMatch`                           | `invoke("pageResolvePreviewMatch")`   |
 * | `…ensurePreviewWorkspace`                        | `invoke("pageEnsurePreviewWorkspace")`|
 * | `…renderPreview`                                 | `invoke("pageRenderPreview")`         |
 * | `…renderCurrentPreview`                          | `invoke("pageRenderCurrentPreview")`  |
 * | `…openPreviewWorkspace`                          | `invoke("pageOpenPreviewWorkspace")`  |
 * | `…onEvent`                                       | `events.on("changed")` — the child publishes |
 * | `…getSimulatorWindowState`                       | the host engine's; no page call       |
 * | `…retainWindowParking`                           | `hostEngine.place({engineId:"simulator"})` |
 * | `…releaseWindowParking`                          | `hostEngine.release()`                |
 *
 * Five more page actions have no compiled `window.ade.iosSimulator.*` line
 * because the compiled pane reached them through a sibling module
 * (`iosSimContracts.ts`) or through the inspector overlay, and the page needs
 * them for the same chrome:
 *
 * | what it draws                                    | page call                             |
 * |--------------------------------------------------|---------------------------------------|
 * | a still frame when the stream cannot run         | `invoke("pageScreenshot")`            |
 * | the inspector tree behind Inspect mode           | `invoke("pageInspectorSnapshot")`     |
 * | one element under the pointer                    | `invoke("pageInspectPoint")`          |
 * | the Preview Lab setup card                       | `invoke("pagePreviewCapability")`     |
 * | a hardware swipe                                 | `invoke("pageSwipe")`                 |
 *
 * That is **25 page actions**, and `pageActions.js` answers all of them.
 *
 * The plugin's own child process holds the `ios_simulator` domain handle and
 * the project pin. The page holds neither, which is what makes the same page
 * work on desktop and in the hosted web client.
 */

import { requireBridge } from "../bridge";
import type {
  IosScreenSnapshot,
  IosSimulatorDevice,
  IosSimulatorInspectResult,
  IosSimulatorLaunchTarget,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewMatch,
  IosSimulatorPreviewTarget,
  IosSimulatorRenderPreviewResult,
  IosSimulatorScreenshot,
  IosSimulatorSession,
  IosSimulatorStatus,
  IosSimulatorStreamStatus,
} from "../types";

/**
 * What every MUTATING page action answers.
 *
 * Never a throw for a refusal the machine is entitled to make — a simulator
 * owned by another chat, a target that will not build, an `idb` that is not
 * installed. A rejected promise reaches the page as an exception beside a
 * toolbar the reader has already pressed, and the page would have to invent the
 * banner itself. `{ok:false, message}` is the banner.
 *
 * The reads degrade where a failure has an honest place to live and reject
 * where it does not; `pageActions.js`'s header says which is which and why.
 */
export type PageActionResult = {
  ok: boolean;
  message?: string | null;
  [key: string]: unknown;
};

function call<T>(action: string, args?: Record<string, unknown>): Promise<T> {
  return requireBridge().invoke(action, args ?? {}) as Promise<T>;
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export const getStatus = (): Promise<IosSimulatorStatus | null> => call("pageStatus");

export const listDevices = (): Promise<IosSimulatorDevice[]> => call("pageDevices");

export const listLaunchTargets = (
  deviceUdid?: string | null,
): Promise<IosSimulatorLaunchTarget[]> =>
  call("pageLaunchTargets", deviceUdid ? { deviceUdid } : {});

export const getStreamStatus = (): Promise<IosSimulatorStreamStatus | null> =>
  call("pageStreamStatus");

export const getScreenSnapshot = (args: {
  deviceUdid?: string | null;
  x?: number | null;
  y?: number | null;
}): Promise<IosScreenSnapshot | null> => call("pageScreenSnapshot", args as Record<string, unknown>);

export const getInspectorSnapshot = (
  deviceUdid?: string | null,
): Promise<{ elements: number; generatedAt: string | null } | null> =>
  call("pageInspectorSnapshot", deviceUdid ? { deviceUdid } : {});

export const getScreenshot = (
  deviceUdid?: string | null,
): Promise<IosSimulatorScreenshot | null> => call("pageScreenshot", deviceUdid ? { deviceUdid } : {});

export const getPreviewCapability = (): Promise<IosSimulatorPreviewCapability | null> =>
  call("pagePreviewCapability");

export const listPreviewTargets = (args?: {
  sourceFile?: string | null;
  sourceLine?: number | null;
}): Promise<IosSimulatorPreviewTarget[]> =>
  call("pagePreviewTargets", (args ?? {}) as Record<string, unknown>);

export const resolvePreviewMatch = (args?: {
  sourceFile?: string | null;
  sourceLine?: number | null;
  elementLabel?: string | null;
  componentId?: string | null;
}): Promise<IosSimulatorPreviewMatch | null> =>
  call("pageResolvePreviewMatch", (args ?? {}) as Record<string, unknown>);

/* ── The session ────────────────────────────────────────────────────────── */

export type PageLaunchResult = PageActionResult & {
  session?: IosSimulatorSession | null;
  usedInstalledBinary?: boolean;
  buildRoot?: string | null;
};

export const launch = (args: {
  deviceUdid?: string | null;
  targetId?: string | null;
  previewTargetId?: string | null;
}): Promise<PageLaunchResult> => call("pageLaunch", args as Record<string, unknown>);

export const shutdown = (force?: boolean): Promise<PageActionResult> =>
  call("pageShutdown", force ? { force: true } : {});

/**
 * Take the session over, or attach this page's chat to it.
 *
 * `takeOver: true` is the ownership card's second button and the only way past
 * the single-owner rule; without it the host refuses a caller that is not the
 * owning chat, and the refusal comes back as `{ok:false, message}` rather than
 * as a throw.
 */
export const attachToChatSession = (args: {
  chatSessionId?: string | null;
  takeOver?: boolean;
}): Promise<PageActionResult & { session?: IosSimulatorSession | null }> =>
  call("pageAttachChat", args as Record<string, unknown>);

/* ── The stream (the host paints it; these only start and stop it) ──────── */

export const startStream = (args: {
  deviceUdid?: string | null;
  fps?: number;
}): Promise<PageActionResult & { status?: IosSimulatorStreamStatus | null }> =>
  call("pageStartStream", args as Record<string, unknown>);

export const stopStream = (): Promise<PageActionResult & { status?: IosSimulatorStreamStatus | null }> =>
  call("pageStopStream");

/* ── Control mode ───────────────────────────────────────────────────────── */

export const tap = (args: {
  deviceUdid?: string | null;
  x: number;
  y: number;
}): Promise<PageActionResult> => call("pageTap", args as Record<string, unknown>);

export const typeText = (args: {
  deviceUdid?: string | null;
  text: string;
}): Promise<PageActionResult> => call("pageTypeText", args as Record<string, unknown>);

export const drag = (args: {
  deviceUdid?: string | null;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs?: number;
}): Promise<PageActionResult> => call("pageDrag", args as Record<string, unknown>);

export const swipe = (args: {
  deviceUdid?: string | null;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs?: number;
}): Promise<PageActionResult> => call("pageSwipe", args as Record<string, unknown>);

/* ── Inspect mode ───────────────────────────────────────────────────────── */

export const selectPoint = (args: {
  deviceUdid?: string | null;
  x: number;
  y: number;
}): Promise<PageActionResult & { element?: unknown }> =>
  call("pageSelectPoint", args as Record<string, unknown>);

export const inspectPoint = (args: {
  deviceUdid?: string | null;
  x: number;
  y: number;
}): Promise<PageActionResult & { result?: IosSimulatorInspectResult | null }> =>
  call("pageInspectPoint", args as Record<string, unknown>);

/* ── Preview Lab ────────────────────────────────────────────────────────── */

export const ensurePreviewWorkspace = (args?: {
  sourceFile?: string | null;
  sourceLine?: number | null;
  openIfNeeded?: boolean;
}): Promise<PageActionResult & { capability?: IosSimulatorPreviewCapability | null }> =>
  call("pageEnsurePreviewWorkspace", (args ?? {}) as Record<string, unknown>);

export const renderPreview = (args: {
  sourceFilePath: string;
  previewDefinitionIndexInFile?: number | null;
  tabIdentifier?: string | null;
}): Promise<PageActionResult & { preview?: IosSimulatorRenderPreviewResult | null }> =>
  call("pageRenderPreview", args as Record<string, unknown>);

export const renderCurrentPreview = (args?: {
  tabIdentifier?: string | null;
}): Promise<PageActionResult & { preview?: IosSimulatorRenderPreviewResult | null }> =>
  call("pageRenderCurrentPreview", (args ?? {}) as Record<string, unknown>);

export const openPreviewWorkspace = (): Promise<PageActionResult & { path?: string | null }> =>
  call("pageOpenPreviewWorkspace");
