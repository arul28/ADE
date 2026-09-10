import fs from "node:fs";
import path from "node:path";
import { resolvePathWithinRoot } from "../../../../desktop/src/main/services/shared/utils";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AppControlStatus } from "../../../../desktop/src/shared/types";
import type { BuiltInBrowserRuntimeStatus } from "../../../../desktop/src/shared/types/builtInBrowserRuntimeStatus";
// Shared, not main: this is a plain Node process, and a value-import of an
// Electron-main module would pull `electron` into it.
import { BUILT_IN_BROWSER_PRESENCE_EXPIRY_MS } from "../../../../desktop/src/shared/types/builtInBrowser";
import { DesktopBridgeUnavailableError } from "../builtInBrowser/desktopBridgeClient";
import {
  isWorkToolId,
  type WorkToolId,
  type WorkToolsAgentBrowserPresence,
  type WorkToolsAppControlState,
  type WorkToolsGetLaneStateArgs,
  type WorkToolsReadObservationPreviewArgs,
  type WorkToolsSetActiveToolArgs,
  type WorkToolsBrowserState,
  type WorkToolsLaneState,
  type WorkToolsObservation,
  type WorkToolsObservationPreview,
} from "../../../../desktop/src/shared/types/workTools";

/**
 * Aggregates the Work tools pane's state for one lane so read-only clients
 * (iOS, hosted web) can see what the desktop is doing without being able to
 * drive it.
 *
 * Three different owners feed this, and the difference matters:
 *
 * - `activeTool` and `openTools` are **published by the desktop renderer**.
 *   Nothing else knows which tabs the pane has or which one is showing — it is
 *   renderer UI state, not runtime state. They are
 *   held in memory only: a lost desktop must not leave the phone claiming a
 *   pane is open, and the desktop re-publishes on reconnect. Deliberately NOT a
 *   cr-sqlite table, because a replicated row would outlive the desktop that
 *   meant it and would make an ephemeral view preference permanent, per-device
 *   state that then has to be reconciled across machines.
 * - `browser` is **pulled from the desktop bridge**. The browser lives in the
 *   desktop's Electron main process; the daemon proxies `built_in_browser.*`
 *   over a socket, scoped to THIS daemon's project. No desktop attached means no
 *   browser to describe — that is `browser: null` with
 *   `browserUnavailable: "desktop_not_attached"`, an ordinary state, not an
 *   error. A desktop that is attached but has no window open for this project
 *   is `"desktop_not_attached_for_project"`, and one that HAS this project open
 *   but has never used its Browser pane is `"browser_pane_not_opened"`: both
 *   ordinary, both deliberately not answered out of another project's window
 *   collection, and worded apart because only the first means "open something".
 * - `appControl` is **read in-process** from the daemon's own App Control
 *   service, which is why it survives a desktop that has quit.
 *
 * Screenshots never travel with the state. Observations are written to disk by
 * the desktop already; this service reports the newest one's path and lets a
 * client fetch bytes through `readObservationPreview`, so neither the change
 * event nor a routine state poll carries an image.
 */

/** Roots the desktop writes observations into, relative to the project root. */
const BROWSER_OBSERVATION_CACHE_DIR = path.join(".ade", "cache", "browser-observations");
const APP_CONTROL_OBSERVATION_CACHE_DIR = path.join(".ade", "cache", "app-control-observations");

/**
 * How deep to walk an observation root. The browser nests
 * `<collectionKey>/<tabId>/<obs>.json` and App Control nests `<sessionId>/`, so
 * three levels covers both with room to spare while keeping a corrupted or
 * user-created tree from turning a state read into a filesystem crawl.
 */
const OBSERVATION_SCAN_MAX_DEPTH = 3;
/** Hard ceiling on files examined per root, for the same reason. */
const OBSERVATION_SCAN_MAX_ENTRIES = 400;

/** Matches the computer-use artifact preview cap: a preview, not a download. */
const OBSERVATION_PREVIEW_SIZE_CAP = 10 * 1024 * 1024;

const OBSERVATION_PREVIEW_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Coalescing window for `work_tools_state_changed`. Tab switching is a
 * keyboard-speed action — a user flicking through the picker would otherwise
 * emit one event per keystroke to every pinned phone and browser. The trailing
 * edge wins so the event always describes the tool the user landed on.
 */
export const WORK_TOOLS_STATE_EVENT_DEBOUNCE_MS = 250;

export type WorkToolsBrowserStatusReader = () => Promise<BuiltInBrowserRuntimeStatus>;
export type WorkToolsAppControlStatusReader = () => AppControlStatus | Promise<AppControlStatus>;

export type WorkToolsStateServiceArgs = {
  projectRoot: string;
  /**
   * Reads `built_in_browser.getStatus` through the desktop bridge. Rejecting
   * (no desktop on this machine) is expected and is reported as absence.
   * Omitted entirely on a runtime with no bridge at all.
   */
  getBrowserStatus?: WorkToolsBrowserStatusReader | null;
  /** The daemon's own App Control service, when it has one. */
  getAppControlStatus?: WorkToolsAppControlStatusReader | null;
  /** Emits `work_tools_state_changed`. Already debounced when it fires. */
  onStateChanged?: (laneId: string) => void;
  debounceMs?: number;
  logger?: Logger | null;
};

/**
 * How long after an agent's last browser command this service keeps EXPECTING
 * presence, so it knows when to tell clients to look again.
 *
 * The same window the desktop expires on, plus a margin: the re-read this
 * schedules must land after the desktop has actually dropped the entry, or
 * every client would refresh once, still see the agent, and then sit on a stale
 * badge until something else moved.
 */
export const WORK_TOOLS_PRESENCE_EVENT_WINDOW_MS = BUILT_IN_BROWSER_PRESENCE_EXPIRY_MS + 500;

export type WorkToolsStateService = {
  setActiveTool(args: WorkToolsSetActiveToolArgs): { ok: true };
  /**
   * An agent-authenticated browser command just passed through this daemon.
   *
   * Event scheduling only — it publishes nothing. The presence STATE is the
   * desktop's (see `agentBrowserPresence` on the lane state, read through the
   * bridge), and this side deliberately keeps no copy of it to disagree with.
   * What the daemon uniquely knows is *when* a client's answer just went stale:
   * it proxies every `ade browser` call, so it can fire the lane-state event the
   * moment an agent starts browsing, and again once the desktop's twenty-second
   * window has elapsed. Without it a phone would learn both edges only on
   * whatever poll happened next.
   */
  noteAgentBrowserActivity(args: { laneId: string | null; chatSessionId: string | null }): void;
  getLaneState(args: WorkToolsGetLaneStateArgs): Promise<WorkToolsLaneState>;
  readObservationPreview(
    args: WorkToolsReadObservationPreviewArgs,
  ): Promise<WorkToolsObservationPreview | null>;
  /** Test/diagnostic hook: flushes a pending debounced event immediately. */
  flushPendingEvents(): void;
  dispose(): void;
};

type ActiveToolEntry = {
  tool: WorkToolId | null;
  /** The lane's open tabs in strip order, `tool` among them. */
  openTools: WorkToolId[];
  updatedAt: string;
};

/**
 * The published tab strip, normalized.
 *
 * Unknown ids are dropped rather than rejected — a newer desktop may know a
 * tool this daemon does not, and a mirror that refuses the whole publish would
 * blank the phone's view of a pane that is perfectly fine. Duplicates are
 * collapsed because the strip is a set with an order, and the active tool is
 * appended when it is missing: a tab is on screen, so it is open by definition.
 *
 * An absent list is the older desktop's publish, which had exactly one tab.
 */
function normalizeOpenTools(
  value: readonly unknown[] | null | undefined,
  activeTool: WorkToolId | null,
): WorkToolId[] {
  if (value == null) return activeTool ? [activeTool] : [];
  const open: WorkToolId[] = [];
  for (const entry of value) {
    if (!isWorkToolId(entry) || open.includes(entry)) continue;
    open.push(entry);
  }
  if (activeTool && !open.includes(activeTool)) open.push(activeTool);
  return open;
}

function sameTools(a: readonly WorkToolId[], b: readonly WorkToolId[]): boolean {
  return a.length === b.length && a.every((tool, index) => tool === b[index]);
}

type ObservationRecord = {
  filePath: string;
  capturedAt: string;
  caption: string | null;
  ownerLaneId: string | null;
};

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function requireLaneId(value: unknown, action: string): string {
  const laneId = trimmedOrNull(value);
  if (!laneId) throw new Error(`${action} requires laneId.`);
  return laneId;
}

/**
 * Builds the one-line caption under a frame. The observation JSON records the
 * page it was taken on, not the action that triggered it, so URL-then-title is
 * the most specific thing actually available; an untitled blank tab gets no
 * caption rather than a misleading one.
 */
function observationCaption(record: Record<string, unknown>): string | null {
  return trimmedOrNull(record.title) ?? trimmedOrNull(record.url);
}

async function readObservationJson(filePath: string): Promise<ObservationRecord | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const imagePath = trimmedOrNull(record.filePath);
  const capturedAt = trimmedOrNull(record.capturedAt);
  if (!imagePath || !capturedAt) return null;
  return {
    filePath: imagePath,
    capturedAt,
    caption: observationCaption(record),
    ownerLaneId: trimmedOrNull(record.ownerLaneId),
  };
}

/** Bounded breadth-first sweep for `*.json` observation sidecars. */
async function listObservationJsonPaths(root: string): Promise<string[]> {
  const found: string[] = [];
  let queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length && found.length < OBSERVATION_SCAN_MAX_ENTRIES) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of queue) {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (found.length >= OBSERVATION_SCAN_MAX_ENTRIES) break;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < OBSERVATION_SCAN_MAX_DEPTH) next.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".json")) found.push(full);
      }
    }
    queue = next;
  }
  return found;
}

/**
 * Newest observation under `root`, optionally restricted to one lane.
 *
 * Lane filtering is opportunistic on purpose: the browser stamps
 * `ownerLaneId` on an observation only when a chat claimed the tab, so an
 * unclaimed tab's frame has none. Dropping those would leave the most common
 * case — a user browsing in the pane by hand — with no frame at all, so an
 * unowned observation is treated as belonging to whoever asks.
 */
async function findLatestObservation(
  root: string,
  laneId: string,
): Promise<WorkToolsObservation | null> {
  const jsonPaths = await listObservationJsonPaths(root);
  let best: ObservationRecord | null = null;
  for (const jsonPath of jsonPaths) {
    const record = await readObservationJson(jsonPath);
    if (!record) continue;
    if (record.ownerLaneId && record.ownerLaneId !== laneId) continue;
    if (!best || record.capturedAt > best.capturedAt) best = record;
  }
  if (!best) return null;
  return {
    path: best.filePath,
    capturedAt: best.capturedAt,
    caption: best.caption,
  };
}

function summarizeBrowser(
  status: BuiltInBrowserRuntimeStatus,
  laneId: string,
): WorkToolsBrowserState {
  // A tab claimed by ANOTHER lane belongs to that lane's pane, not this one.
  // Unclaimed tabs are shared browsing and stay visible everywhere.
  // A handed-off tab has no lease — it is the human's until they hand it back —
  // so fall back to the lane whose lease is waiting to be restored. Otherwise
  // the tab the lane is actually blocked on would leak into every other pane.
  const tabs = status.tabs
    .map((tab) => ({ tab, laneOwner: tab.ownerLaneId ?? tab.handoff?.previousOwner.laneId ?? null }))
    .filter(({ laneOwner }) => !laneOwner || laneOwner === laneId)
    .map(({ tab }) => ({
      id: tab.id,
      title: trimmedOrNull(tab.title),
      url: trimmedOrNull(tab.url),
      ownerChatSessionId: trimmedOrNull(tab.ownerChatSessionId)
        ?? trimmedOrNull(tab.handoff?.previousOwner.chatSessionId),
      recording: tab.recording,
      active: tab.id === status.activeTabId,
      handoffReason: trimmedOrNull(tab.handoff?.reason),
    }));
  return {
    activeTabId: tabs.some((tab) => tab.active) ? status.activeTabId : null,
    tabs,
    latestObservation: null,
  };
}

/**
 * Which chats in THIS lane are driving the browser right now.
 *
 * The desktop scopes its answer to the project; the lane is this side's cut,
 * and it follows the tab rule exactly: an entry stamped with another lane
 * belongs to that lane's pane, and one with no lane at all (a personal chat) is
 * shared browsing that stays visible. A phone showing lane A must not light up
 * because a chat in lane B opened a page.
 *
 * `status.presence` is optional on the wire — a desktop older than this field
 * simply cannot say — and an absent list reads as "nobody", never as an error.
 */
function summarizeAgentPresence(
  status: BuiltInBrowserRuntimeStatus,
  laneId: string,
): WorkToolsAgentBrowserPresence[] {
  return (status.presence ?? [])
    .filter((entry) => {
      const entryLane = trimmedOrNull(entry?.laneId);
      return !entryLane || entryLane === laneId;
    })
    .flatMap((entry) => {
      const chatSessionId = trimmedOrNull(entry?.chatSessionId);
      const since = trimmedOrNull(entry?.since);
      const lastActivityAt = trimmedOrNull(entry?.lastActivityAt);
      if (!chatSessionId || !since || !lastActivityAt) return [];
      return [{ chatSessionId, tabId: trimmedOrNull(entry?.tabId), since, lastActivityAt }];
    });
}

function summarizeAppControl(status: AppControlStatus): WorkToolsAppControlState | null {
  const session = status.activeSession;
  if (!session) return null;
  return {
    appName: trimmedOrNull(session.label) ?? session.appKind,
    status: session.status,
    driver: session.driver,
    latestObservation: null,
  };
}

export function createWorkToolsStateService(
  args: WorkToolsStateServiceArgs,
): WorkToolsStateService {
  const projectRoot = path.resolve(args.projectRoot);
  const debounceMs = args.debounceMs ?? WORK_TOOLS_STATE_EVENT_DEBOUNCE_MS;
  const activeToolByLane = new Map<string, ActiveToolEntry>();
  const pendingEventTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // One timer per browsing chat, holding nothing but "expect this to be gone by
  // then". See `noteAgentBrowserActivity`: presence itself belongs to the
  // desktop, and a second copy here would be a second answer to disagree with.
  const presenceWindowTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const browserObservationRoot = path.join(projectRoot, BROWSER_OBSERVATION_CACHE_DIR);
  const appControlObservationRoot = path.join(projectRoot, APP_CONTROL_OBSERVATION_CACHE_DIR);

  const emitStateChanged = (laneId: string): void => {
    if (disposed) return;
    const existing = pendingEventTimers.get(laneId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingEventTimers.delete(laneId);
      if (disposed) return;
      args.onStateChanged?.(laneId);
    }, debounceMs);
    // A pending UI-state event must never hold the process open.
    timer.unref?.();
    pendingEventTimers.set(laneId, timer);
  };

  const readBrowser = async (
    laneId: string,
  ): Promise<{
    browser: WorkToolsBrowserState | null;
    unavailable: WorkToolsLaneState["browserUnavailable"];
    presence: WorkToolsAgentBrowserPresence[];
  }> => {
    const reader = args.getBrowserStatus;
    if (!reader) return { browser: null, unavailable: "desktop_not_attached", presence: [] };
    let status: BuiltInBrowserRuntimeStatus;
    try {
      status = await reader();
    } catch (error) {
      // The bridge throws `DesktopBridgeUnavailableError` when no desktop is
      // listening on this machine, which is the normal headless state — not
      // something to log as a fault. ANY other failure means a desktop IS
      // there and refused us, which is a real fault: it renders as the same
      // "no desktop attached" empty state on every phone and web client, so a
      // debug-level line would make it invisible (it did — a `policyDenied`
      // from calling `getStatus` without a capability was silent for the whole
      // life of this surface).
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof DesktopBridgeUnavailableError) {
        args.logger?.debug("work_tools.browser_status_unavailable", { err: reason });
      } else {
        args.logger?.warn("work_tools.browser_status_failed", { err: reason });
      }
      return { browser: null, unavailable: "desktop_not_attached", presence: [] };
    }
    // A desktop answered, but it has no window open for this daemon's project.
    // Deliberately NOT falling back to whatever else that desktop has open: the
    // tabs would belong to another project.
    if (status.unavailable) {
      return { browser: null, unavailable: status.unavailable, presence: [] };
    }
    const browser = summarizeBrowser(status, laneId);
    browser.latestObservation = await findLatestObservation(browserObservationRoot, laneId);
    return { browser, unavailable: null, presence: summarizeAgentPresence(status, laneId) };
  };

  const readAppControl = async (laneId: string): Promise<WorkToolsAppControlState | null> => {
    const reader = args.getAppControlStatus;
    if (!reader) return null;
    let status: AppControlStatus;
    try {
      status = await reader();
    } catch (error) {
      args.logger?.debug("work_tools.app_control_status_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const appControl = summarizeAppControl(status);
    if (!appControl) return null;
    appControl.latestObservation = await findLatestObservation(appControlObservationRoot, laneId);
    return appControl;
  };

  return {
    noteAgentBrowserActivity(input) {
      const laneId = trimmedOrNull(input?.laneId);
      const chatSessionId = trimmedOrNull(input?.chatSessionId);
      // A lane-less caller (a personal chat) has no lane state to invalidate,
      // and a call with no chat cannot be an agent's.
      if (!laneId || !chatSessionId || disposed) return;
      const key = `${laneId}\u0000${chatSessionId}`;
      const existing = presenceWindowTimers.get(key) ?? null;
      // Only the edges are news. A busy agent lands here many times a second,
      // and every one of those would otherwise wake every phone pinned to the
      // lane to re-read a state that has not changed since the last command.
      if (existing) clearTimeout(existing);
      else emitStateChanged(laneId);
      const timer = setTimeout(() => {
        presenceWindowTimers.delete(key);
        if (disposed) return;
        emitStateChanged(laneId);
      }, WORK_TOOLS_PRESENCE_EVENT_WINDOW_MS);
      timer.unref?.();
      presenceWindowTimers.set(key, timer);
    },

    setActiveTool(input) {
      const laneId = requireLaneId(input?.laneId, "work_tools.setActiveTool");
      const tool = input?.tool ?? null;
      if (tool !== null && !isWorkToolId(tool)) {
        throw new Error(`work_tools.setActiveTool got an unknown tool "${String(tool)}".`);
      }
      const openTools = normalizeOpenTools(
        Array.isArray(input?.openTools) ? input.openTools : null,
        tool,
      );
      const previous = activeToolByLane.get(laneId);
      if (previous && previous.tool === tool && sameTools(previous.openTools, openTools)) {
        return { ok: true };
      }
      activeToolByLane.set(laneId, { tool, openTools, updatedAt: new Date().toISOString() });
      emitStateChanged(laneId);
      return { ok: true };
    },

    async getLaneState(input) {
      const laneId = requireLaneId(input?.laneId, "work_tools.getLaneState");
      const active = activeToolByLane.get(laneId) ?? null;
      const [{ browser, unavailable, presence }, appControl] = await Promise.all([
        readBrowser(laneId),
        readAppControl(laneId),
      ]);
      return {
        laneId,
        activeTool: active?.tool ?? null,
        openTools: active?.openTools ?? [],
        activeToolUpdatedAt: active?.updatedAt ?? null,
        browser,
        browserUnavailable: unavailable,
        agentBrowserPresence: presence,
        appControl,
        capturedAt: new Date().toISOString(),
      };
    },

    async readObservationPreview(input) {
      const requested = trimmedOrNull(input?.path);
      if (!requested) return null;
      // Clients hand back a path this service gave them, but the request still
      // crosses a trust boundary — a paired viewer could send any string. Both
      // observation roots are checked so neither becomes an arbitrary file read.
      let canonical: string | null = null;
      for (const root of [browserObservationRoot, appControlObservationRoot]) {
        try {
          canonical = resolvePathWithinRoot(root, path.resolve(requested));
          break;
        } catch {
          canonical = null;
        }
      }
      if (!canonical) return null;
      // Ownership re-check. `findLatestObservation` already refuses another
      // lane's observation, but a caller can hand back any path inside the
      // roots — including one it learned before the sidecar was written, or one
      // it guessed. The sidecar is the authority on who owns the frame, so read
      // it again here rather than trusting that the path came from us.
      // `callerLaneId` is injected by `adeRpcServer`'s `work_tools` scoping from
      // the caller's own chat session; a user client sends none and is unscoped.
      const callerLaneId = trimmedOrNull(input?.callerLaneId);
      if (callerLaneId) {
        const sidecarPath = `${canonical.slice(0, canonical.length - path.extname(canonical).length)}.json`;
        const sidecar = await readObservationJson(sidecarPath);
        if (sidecar?.ownerLaneId && sidecar.ownerLaneId !== callerLaneId) return null;
      }
      const ext = path.extname(canonical).replace(/^\./, "").toLowerCase();
      const mimeType = OBSERVATION_PREVIEW_MIME_BY_EXTENSION[ext];
      if (!mimeType) return null;
      try {
        const stat = await fs.promises.stat(canonical);
        if (!stat.isFile() || stat.size > OBSERVATION_PREVIEW_SIZE_CAP) return null;
        const buffer = await fs.promises.readFile(canonical);
        return {
          dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
          mimeType,
          byteLength: buffer.byteLength,
        };
      } catch {
        return null;
      }
    },

    flushPendingEvents() {
      for (const [laneId, timer] of [...pendingEventTimers]) {
        clearTimeout(timer);
        pendingEventTimers.delete(laneId);
        if (!disposed) args.onStateChanged?.(laneId);
      }
    },

    dispose() {
      disposed = true;
      for (const timer of pendingEventTimers.values()) clearTimeout(timer);
      pendingEventTimers.clear();
      for (const timer of presenceWindowTimers.values()) clearTimeout(timer);
      presenceWindowTimers.clear();
      activeToolByLane.clear();
    },
  };
}
