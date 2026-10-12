import {
  CLAUDE_PLUGIN_UI_BAND_COLUMNS,
  CLAUDE_PLUGIN_UI_BAND_ROWS,
  CLAUDE_PLUGIN_UI_PANE_COLUMNS,
  CLAUDE_PLUGIN_UI_PANE_ROWS,
  EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT,
  MAX_CLAUDE_PLUGIN_UI_INPUT_CHARS,
  MAX_CLAUDE_PLUGIN_UI_PANES,
  MAX_CLAUDE_PLUGIN_UI_STATUSES,
  claudePluginUiHasContent,
  cleanClaudePluginUiText,
  normalizeClaudePluginUiTarget,
  sanitizeClaudePluginUiTree,
  type ClaudePluginUiActResult,
  type ClaudePluginUiElement,
  type ClaudePluginUiSnapshot,
  type ClaudePluginUiStatus,
  type ClaudePluginUiTarget,
  type ClaudePluginUiToast,
} from "../../../shared/claudePluginUi";

/**
 * Claude mod UI, per chat: the status lines, the latest toast, the band above
 * the prompt and the panes that Claude Code plugins ("mods") draw.
 *
 * A headless Claude session pushes `system` messages (`ui_status`, `ui_toast`,
 * `ui_panes`, `ui_invalidate`) and draws a band or a pane only when asked with
 * a `ui_render` control request. The chat service hands every message of a
 * query to `ingest` and names the query with `attach`; this service asks for
 * the trees and publishes one snapshot per chat. Nothing is persisted.
 *
 * The protocol is private to Claude Code: untyped in the Agent SDK and marked
 * early access. So every failure here is logged at debug level and leaves the
 * chat without mod UI. It never affects a turn.
 */

type ControlRequest = (body: Record<string, unknown>) => Promise<unknown>;

type Logger = { debug: (event: string, data?: Record<string, unknown>) => void };

type Snapshot = ClaudePluginUiSnapshot;

/** What clients show, kept between publishes. A toast is not kept: it rides the one publish that raised it. */
type Shown = Omit<Snapshot, "toast">;

type Entry = {
  /** The query that owns this entry. Messages and answers from any other query are dropped. */
  query: object | null;
  /** The query's control-request sender; null when this SDK build has none. */
  request: ControlRequest | null;
  snapshot: Shown;
  /** The controls of each tree in the snapshot, by render site. An action must name one. */
  targetsBySite: Map<string, ClaudePluginUiTarget[]>;
  rendering: boolean;
  renderAgain: boolean;
  lastRenderAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type DrawnSite = { tree: ClaudePluginUiElement | null; targets: ClaudePluginUiTarget[] };

const BAND_SITE = "above-prompt";
const paneSite = (paneId: string) => `pane:${paneId}`;
const CLIENT_ID = "ade";
/** A mod may ask for ten redraws a second; clients get at most this many. */
const MIN_RENDER_INTERVAL_MS = 200;
const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_TOAST_MS = 4_000;
/** The longest toast Claude Code accepts from a mod: its docs give `timeoutMs` as 1 to 60000. */
const MAX_TOAST_MS = 60_000;
const PANE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The props Claude Code's own surfaces pass to the two render sites. A mod
 * sizes its tree to `bodyColumns`; `maxRows` and `scroll.bodyRows` are the
 * rows the site shows before it scrolls.
 */
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: CLAUDE_PLUGIN_UI_BAND_ROWS,
  bodyColumns: CLAUDE_PLUGIN_UI_BAND_COLUMNS,
  scroll: { offset: 0, bodyRows: CLAUDE_PLUGIN_UI_BAND_ROWS },
};
const panePropsFor = (title: string) => ({
  title,
  isFocused: false,
  bodyColumns: CLAUDE_PLUGIN_UI_PANE_COLUMNS,
  // ADE seats a pane above the prompt, which Claude Code calls `inline`.
  placement: "inline",
  scroll: { offset: 0, bodyRows: CLAUDE_PLUGIN_UI_PANE_ROWS },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The SDK `Query`'s control-request sender, when this SDK build has one. */
function controlRequestOf(query: object): ControlRequest | null {
  const request = (query as { request?: unknown }).request;
  if (typeof request !== "function") return null;
  return (body) => (request as (body: Record<string, unknown>) => Promise<unknown>).call(query, body);
}

/** The SDK resolves a control request with `{ subtype, request_id, response }`. */
function responseOf(envelope: unknown): Record<string, unknown> | null {
  if (!isRecord(envelope)) return null;
  return isRecord(envelope.response) ? envelope.response : null;
}

function sameTarget(left: ClaudePluginUiTarget, right: ClaudePluginUiTarget): boolean {
  return left.plugin === right.plugin && left.handle === right.handle;
}

/** The status lines after a `ui_status` message (an empty text clears that mod's line); null for no change. */
function statusesAfter(statuses: ClaudePluginUiStatus[], message: Record<string, unknown>): ClaudePluginUiStatus[] | null {
  const plugin = cleanClaudePluginUiText(message.plugin, 128);
  if (!plugin) return null;
  const text = cleanClaudePluginUiText(message.text);
  const others = statuses.filter((status) => status.plugin !== plugin);
  if (!text && others.length === statuses.length) return null;
  return (text ? [...others, { plugin, text }] : others).slice(-MAX_CLAUDE_PLUGIN_UI_STATUSES);
}

function toastFrom(message: Record<string, unknown>, fallbackId: () => string): ClaudePluginUiToast | null {
  const plugin = cleanClaudePluginUiText(message.plugin, 128);
  const text = cleanClaudePluginUiText(message.text);
  if (!plugin || !text) return null;
  const timeoutMs = typeof message.timeout_ms === "number" && Number.isFinite(message.timeout_ms)
    ? Math.max(1_000, Math.min(MAX_TOAST_MS, message.timeout_ms))
    : DEFAULT_TOAST_MS;
  const id = typeof message.uuid === "string" && message.uuid && message.uuid.length <= 128 ? message.uuid : fallbackId();
  return { id, plugin, text, timeoutMs };
}

/** The open panes a `ui_panes` message lists, each keeping the tree already drawn for it. */
function panesFrom(snapshot: Shown, message: Record<string, unknown>): Snapshot["panes"] {
  const drawn = new Map(snapshot.panes.map((pane) => [pane.id, pane.tree]));
  const panes: Snapshot["panes"] = [];
  for (const raw of Array.isArray(message.panes) ? message.panes : []) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !PANE_ID.test(raw.id)) continue;
    if (panes.some((pane) => pane.id === raw.id)) continue;
    panes.push({
      id: raw.id,
      title: cleanClaudePluginUiText(raw.title, 128) || raw.id,
      plugin: cleanClaudePluginUiText(raw.plugin, 128),
      tree: drawn.get(raw.id) ?? null,
    });
    if (panes.length >= MAX_CLAUDE_PLUGIN_UI_PANES) break;
  }
  return panes;
}

export function createClaudePluginUiService(deps: {
  isEnabled: () => boolean;
  publish: (sessionId: string, snapshot: Snapshot) => void;
  logger: Logger;
}) {
  const entries = new Map<string, Entry>();
  // Starts at the clock, so a restarted host does not reuse a generation a
  // window still holds a snapshot of (it would need more attaches than
  // milliseconds since it started).
  let generationCounter = Date.now();
  let toastCounter = 0;

  /** Applies a change and tells clients. A toast is news once: it rides this publish and is not kept. */
  const update = (
    sessionId: string,
    entry: Entry,
    patch: Partial<Shown>,
    toast: ClaudePluginUiToast | null = null,
  ): void => {
    if (entries.get(sessionId) !== entry) return;
    entry.snapshot = { ...entry.snapshot, ...patch, revision: entry.snapshot.revision + 1 };
    deps.publish(sessionId, { ...entry.snapshot, toast });
  };

  const send = async (request: ControlRequest, body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CONTROL_REQUEST_TIMEOUT_MS);
        timer.unref?.();
      });
      return responseOf(await Promise.race([request(body), timeout]));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * One site's tree as the mods drew it, or null when the request failed: the
   * site then keeps what it shows, so its controls stay the ones on screen.
   */
  const renderSite = async (
    sessionId: string,
    request: ControlRequest,
    component: "AbovePrompt" | "Pane",
    instanceId: string,
    props: Record<string, unknown>,
  ): Promise<DrawnSite | null> => {
    try {
      const response = await send(request, {
        subtype: "ui_render",
        surface: "desktop",
        component,
        instance_id: instanceId,
        client_id: CLIENT_ID,
        props,
      });
      // Claude Code always says whether a mod drew (`hooked`). A reply that
      // does not is no answer: the site keeps what it shows.
      if (typeof response?.hooked !== "boolean") return null;
      // `hooked: false`, or a tree of type `engine`, is Claude Code's own placeholder.
      if (!response.hooked) return { tree: null, targets: [] };
      if (isRecord(response.tree) && response.tree.type === "engine") return { tree: null, targets: [] };
      return sanitizeClaudePluginUiTree(response.tree);
    } catch (error) {
      deps.logger.debug("agent_chat.claude_plugin_ui_render_failed", {
        sessionId,
        component,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const renderAll = async (sessionId: string, entry: Entry): Promise<void> => {
    const request = entry.request;
    const query = entry.query;
    if (!request || !query) return;
    const band = await renderSite(sessionId, request, "AbovePrompt", BAND_SITE, BAND_PROPS);
    const panes = new Map<string, DrawnSite | null>();
    for (const pane of entry.snapshot.panes) {
      panes.set(pane.id, await renderSite(sessionId, request, "Pane", pane.id, panePropsFor(pane.title)));
    }
    // The query may have closed, or been replaced, while the renders were out.
    if (entries.get(sessionId) !== entry || entry.query !== query) return;
    // Trees and their controls change together, in one publish. A pane that
    // closed during the render is no longer in the snapshot and stays closed.
    if (band) entry.targetsBySite.set(BAND_SITE, band.targets);
    const drawnPanes = entry.snapshot.panes.map((pane) => {
      const drawn = panes.get(pane.id);
      if (!drawn) return pane;
      entry.targetsBySite.set(paneSite(pane.id), drawn.targets);
      return { ...pane, tree: drawn.tree };
    });
    // A render that answered makes this process's controls the ones on screen.
    // While none has, the last process's trees stay dimmed.
    const answered = band !== null || [...panes.values()].some((drawn) => drawn !== null);
    const next = {
      live: entry.snapshot.live || answered,
      band: band ? band.tree : entry.snapshot.band,
      panes: drawnPanes,
    };
    // A mod may ask for a redraw that draws the same thing; clients need no
    // word of it. Compared with what clients show now, so a pane that was
    // listed again without its tree still gets one.
    const { live, band: shownBand, panes: shownPanes } = entry.snapshot;
    if (JSON.stringify(next) === JSON.stringify({ live, band: shownBand, panes: shownPanes })) return;
    update(sessionId, entry, next);
  };

  /** Asks for the trees; requests that land during a render fold into one more. */
  const requestRender = (sessionId: string, entry: Entry): void => {
    if (!entry.request || entries.get(sessionId) !== entry) return;
    if (entry.rendering) {
      entry.renderAgain = true;
      return;
    }
    if (entry.timer) return;
    const wait = Math.max(0, entry.lastRenderAt + MIN_RENDER_INTERVAL_MS - Date.now());
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.rendering = true;
      entry.renderAgain = false;
      entry.lastRenderAt = Date.now();
      void renderAll(sessionId, entry).finally(() => {
        entry.rendering = false;
        if (entry.renderAgain) requestRender(sessionId, entry);
      });
    }, wait);
    entry.timer.unref?.();
  };

  /**
   * Ends a chat's mod UI: drops what the host holds, and tells clients that
   * show some to take it down. For a chat that ended, or the setting turned off.
   */
  const end = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entries.delete(sessionId);
    if (claudePluginUiHasContent(entry.snapshot)) deps.publish(sessionId, EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT);
  };

  /** Names the live query of a chat and asks it for its trees. */
  const attach = (sessionId: string, query: object): void => {
    if (!deps.isEnabled()) {
      end(sessionId);
      return;
    }
    const previous = entries.get(sessionId);
    if (previous?.timer) clearTimeout(previous.timer);
    const entry: Entry = {
      query,
      request: controlRequestOf(query),
      // The band of the last process stays on screen, not pressable, until
      // this process draws its own: no flicker on a restart. Status lines are
      // gone with the process that set them. So are panes: which panes are
      // open is this process's list (`ui_panes`), and it starts with none.
      snapshot: {
        live: false,
        generation: ++generationCounter,
        revision: 1,
        statuses: [],
        band: previous?.snapshot.band ?? null,
        panes: [],
      },
      targetsBySite: new Map(),
      rendering: false,
      renderAgain: false,
      lastRenderAt: 0,
      timer: null,
    };
    entries.set(sessionId, entry);
    if (previous) deps.publish(sessionId, { ...entry.snapshot, toast: null });
    requestRender(sessionId, entry);
  };

  /** Marks a chat's mod UI as no longer pressable once its query is gone. */
  const detach = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (!entry) return;
    const { band, panes } = entry.snapshot;
    if (!band && !panes.length) {
      // Nothing worth keeping on screen.
      end(sessionId);
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.query = null;
    entry.request = null;
    entry.targetsBySite = new Map();
    update(sessionId, entry, { live: false, statuses: [] });
  };

  const applyMessage = (sessionId: string, entry: Entry, subtype: string, message: Record<string, unknown>): void => {
    switch (subtype) {
      case "ui_status": {
        const statuses = statusesAfter(entry.snapshot.statuses, message);
        if (statuses) update(sessionId, entry, { statuses });
        return;
      }
      case "ui_toast": {
        const toast = toastFrom(message, () => `toast-${++toastCounter}`);
        if (toast) update(sessionId, entry, {}, toast);
        return;
      }
      case "ui_panes": {
        const panes = panesFrom(entry.snapshot, message);
        // A site exists exactly for each pane this process lists. A new one
        // has no controls until its render answers.
        const listedSites = new Set(panes.map((pane) => paneSite(pane.id)));
        for (const site of [...entry.targetsBySite.keys()]) {
          if (site !== BAND_SITE && !listedSites.has(site)) entry.targetsBySite.delete(site);
        }
        for (const site of listedSites) {
          if (!entry.targetsBySite.has(site)) entry.targetsBySite.set(site, []);
        }
        update(sessionId, entry, { panes });
        requestRender(sessionId, entry);
        return;
      }
      case "init":
        // Plugins are loaded by now; a render asked before that drew nothing.
      case "ui_invalidate":
        requestRender(sessionId, entry);
        return;
      default:
        // ui_log and the rest: debug output, or UI this host does not draw.
    }
  };

  /**
   * Applies one message of a chat's query. Returns true for a mod UI message,
   * which is then no part of the turn: it must not count as model activity.
   */
  const ingest = (sessionId: string, query: object | null, message: unknown): boolean => {
    if (!isRecord(message) || message.type !== "system" || typeof message.subtype !== "string") return false;
    const subtype = message.subtype;
    const isUi = subtype.startsWith("ui_");
    if (!isUi && subtype !== "init") return false;
    try {
      if (!query) return isUi;
      if (!deps.isEnabled()) {
        // Turned off while this chat was drawing: take the drawing down.
        end(sessionId);
        return isUi;
      }
      // No entry: the setting was turned on after this query started, so it was never named.
      if (!entries.has(sessionId)) attach(sessionId, query);
      const entry = entries.get(sessionId);
      // A late message of a replaced or closed query must not draw over the current one.
      if (entry?.query === query) applyMessage(sessionId, entry, subtype, message);
    } catch (error) {
      deps.logger.debug("agent_chat.claude_plugin_ui_ingest_failed", {
        sessionId,
        subtype,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return isUi;
  };

  const get = (sessionId: unknown): Snapshot => {
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    const shown = deps.isEnabled() ? entries.get(id)?.snapshot : null;
    return shown ? { ...shown, toast: null } : EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT;
  };

  /**
   * Forwards a press, a typed value, a pick or a pane close to the chat's live
   * query. The arguments come from a client as untyped JSON (shaped like
   * `ClaudePluginUiActArgs`), so each one is checked here: the action must
   * name the generation of the process that drew the control, and a control
   * this host sent for the site it names.
   */
  const act = async (args: unknown): Promise<ClaudePluginUiActResult> => {
    const refused = { handled: false };
    const raw: Record<string, unknown> = isRecord(args) ? args : {};
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
    const entry = entries.get(sessionId);
    const request = entry?.request;
    if (!entry || !request || !deps.isEnabled() || entry.snapshot.generation !== raw.generation) return refused;
    try {
      if (raw.kind === "closePane") {
        // Only a pane this process lists has a site, so only that pane can be closed.
        if (typeof raw.paneId !== "string" || !entry.targetsBySite.has(paneSite(raw.paneId))) return refused;
        const response = await send(request, { subtype: "ui_close", id: raw.paneId });
        return { handled: response?.closed === true };
      }
      if (raw.kind !== "press" && raw.kind !== "input" && raw.kind !== "select") return refused;
      const target = normalizeClaudePluginUiTarget(raw.target);
      if (!target) return refused;
      const key = typeof raw.key === "string" && raw.key.length <= 256 ? { key: raw.key } : {};
      const address = { plugin: target.plugin, handle: target.handle, surface: "desktop", ...key };
      if (raw.kind === "press") {
        if (![...entry.targetsBySite.values()].some((targets) => targets.some((sent) => sameTarget(sent, target)))) return refused;
        const response = await send(request, { subtype: "ui_press", ...address });
        return { handled: response?.handled === true };
      }
      if (typeof raw.value !== "string" || raw.value.length > MAX_CLAUDE_PLUGIN_UI_INPUT_CHARS) return refused;
      const site = isRecord(raw.site) ? raw.site : {};
      const inPane = site.component === "Pane" && typeof site.paneId === "string";
      if (!inPane && site.component !== "AbovePrompt") return refused;
      const siteKey = inPane ? paneSite(site.paneId as string) : BAND_SITE;
      if (!entry.targetsBySite.get(siteKey)?.some((sent) => sameTarget(sent, target))) return refused;
      const response = await send(request, {
        subtype: raw.kind === "input" ? "ui_input" : "ui_select",
        ...address,
        value: raw.value,
        ...(raw.kind === "input" ? { kind: "submit" } : {}),
        component: inPane ? "Pane" : "AbovePrompt",
        instance_id: inPane ? site.paneId : BAND_SITE,
      });
      return { handled: response?.handled === true };
    } catch (error) {
      deps.logger.debug("agent_chat.claude_plugin_ui_action_failed", {
        sessionId,
        kind: typeof raw.kind === "string" ? raw.kind : "unknown",
        error: error instanceof Error ? error.message : String(error),
      });
      // Sent, with no answer (a timeout, a closed process): the mod may have run it.
      return { handled: false, unanswered: true };
    }
  };

  return { attach, detach, end, ingest, get, act };
}
