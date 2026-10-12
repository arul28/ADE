import {
  CLAUDE_PLUGIN_UI_BAND_COLUMNS,
  CLAUDE_PLUGIN_UI_BAND_ROWS,
  CLAUDE_PLUGIN_UI_PANE_COLUMNS,
  CLAUDE_PLUGIN_UI_PANE_ROWS,
  EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT,
  MAX_CLAUDE_PLUGIN_UI_INPUT_CHARS,
  MAX_CLAUDE_PLUGIN_UI_PANES,
  MAX_CLAUDE_PLUGIN_UI_STATUSES,
  cleanClaudePluginUiText,
  sanitizeClaudePluginUiTree,
  type ClaudePluginUiActArgs,
  type ClaudePluginUiActResult,
  type ClaudePluginUiSnapshot,
  type ClaudePluginUiTarget,
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

type PaneEntry = { id: string; title: string; plugin: string };

type Entry = {
  /** The query that owns this entry. Messages and answers from any other query are dropped. */
  query: object | null;
  request: ControlRequest | null;
  snapshot: ClaudePluginUiSnapshot;
  /** `plugin:handle` of every control in the trees last sent to clients. */
  targets: Set<string>;
  /** Targets per render site, so one site's redraw replaces only its own. */
  targetsBySite: Map<string, ClaudePluginUiTarget[]>;
  rendering: boolean;
  renderAgain: boolean;
  lastRenderAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const BAND_INSTANCE_ID = "above-prompt";
const CLIENT_ID = "ade";
/** A mod may ask for ten redraws a second; clients get at most this many. */
const MIN_RENDER_INTERVAL_MS = 200;
const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_TOAST_MS = 4_000;
const MAX_TOAST_MS = 30_000;

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

function targetKey(target: ClaudePluginUiTarget): string {
  return `${target.plugin}:${target.handle}`;
}

export function createClaudePluginUiService(deps: {
  isEnabled: () => boolean;
  publish: (sessionId: string, snapshot: ClaudePluginUiSnapshot) => void;
  logger: Logger;
}) {
  const entries = new Map<string, Entry>();
  let generationCounter = 0;
  let toastCounter = 0;

  const update = (sessionId: string, entry: Entry, patch: Partial<ClaudePluginUiSnapshot>): void => {
    if (entries.get(sessionId) !== entry) return;
    entry.snapshot = { ...entry.snapshot, ...patch, revision: entry.snapshot.revision + 1 };
    deps.publish(sessionId, entry.snapshot);
  };

  const setSiteTargets = (entry: Entry, site: string, targets: ClaudePluginUiTarget[] | null): void => {
    if (targets) entry.targetsBySite.set(site, targets);
    else entry.targetsBySite.delete(site);
    entry.targets = new Set([...entry.targetsBySite.values()].flat().map(targetKey));
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

  /** A tree the mods drew, not Claude Code's own placeholder. */
  const renderSite = async (
    request: ControlRequest,
    component: "AbovePrompt" | "Pane",
    instanceId: string,
    props: Record<string, unknown>,
  ) => {
    const response = await send(request, {
      subtype: "ui_render",
      surface: "desktop",
      component,
      instance_id: instanceId,
      client_id: CLIENT_ID,
      props,
    });
    if (!response || response.hooked !== true) return { tree: null, targets: [] };
    if (isRecord(response.tree) && response.tree.type === "engine") return { tree: null, targets: [] };
    return sanitizeClaudePluginUiTree(response.tree);
  };

  const renderAll = async (sessionId: string, entry: Entry): Promise<void> => {
    const request = entry.request;
    const query = entry.query;
    if (!request || !query) return;
    const current = () => entries.get(sessionId) === entry && entry.query === query;
    try {
      const band = await renderSite(request, "AbovePrompt", BAND_INSTANCE_ID, {
        hasSurvey: false,
        isWorking: false,
        maxRows: CLAUDE_PLUGIN_UI_BAND_ROWS,
        bodyColumns: CLAUDE_PLUGIN_UI_BAND_COLUMNS,
        scroll: { offset: 0, bodyRows: CLAUDE_PLUGIN_UI_BAND_ROWS },
      });
      // The query may have closed, or been replaced, while the render was out.
      if (!current()) return;
      setSiteTargets(entry, BAND_INSTANCE_ID, band.targets);
      const panes = [];
      for (const pane of entry.snapshot.panes) {
        const drawn = await renderSite(request, "Pane", pane.id, {
          title: pane.title,
          isFocused: false,
          bodyColumns: CLAUDE_PLUGIN_UI_PANE_COLUMNS,
          placement: "inline",
          scroll: { offset: 0, bodyRows: CLAUDE_PLUGIN_UI_PANE_ROWS },
        });
        if (!current()) return;
        setSiteTargets(entry, `pane:${pane.id}`, drawn.targets);
        panes.push({ ...pane, tree: drawn.tree });
      }
      // A pane that closed during the render stays closed.
      const open = new Set(entry.snapshot.panes.map((pane) => pane.id));
      update(sessionId, entry, { band: band.tree, panes: panes.filter((pane) => open.has(pane.id)) });
    } catch (error) {
      deps.logger.debug("agent_chat.claude_plugin_ui_render_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  /** Names the live query of a chat and asks it for its trees. */
  const attach = (sessionId: string, query: object): void => {
    const previous = entries.get(sessionId);
    if (previous?.timer) clearTimeout(previous.timer);
    if (!deps.isEnabled()) {
      if (previous) {
        entries.delete(sessionId);
        deps.publish(sessionId, EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT);
      }
      return;
    }
    const request = controlRequestOf(query);
    const entry: Entry = {
      query,
      request,
      // The band and the panes of the last process stay on screen, not
      // pressable, until this process draws its own: no flicker on a restart.
      // Status lines belong to the process that set them.
      snapshot: {
        ...(previous?.snapshot ?? EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT),
        live: request !== null,
        generation: ++generationCounter,
        revision: (previous?.snapshot.revision ?? 0) + 1,
        statuses: [],
        toast: null,
      },
      targets: new Set(),
      targetsBySite: new Map(),
      rendering: false,
      renderAgain: false,
      lastRenderAt: 0,
      timer: null,
    };
    entries.set(sessionId, entry);
    if (previous) deps.publish(sessionId, entry.snapshot);
    requestRender(sessionId, entry);
  };

  /** Marks a chat's mod UI as no longer pressable once its query is gone. */
  const detach = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.query = null;
    entry.request = null;
    entry.targets = new Set();
    entry.targetsBySite = new Map();
    const { band, panes } = entry.snapshot;
    if (!band && !panes.length) {
      const hadContent = entry.snapshot.statuses.length > 0;
      entries.delete(sessionId);
      if (hadContent) deps.publish(sessionId, EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT);
      return;
    }
    update(sessionId, entry, { live: false, statuses: [], toast: null });
  };

  /** Drops a chat's mod UI for good (the chat ended or was deleted). */
  const forget = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entries.delete(sessionId);
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
    if (!query) return isUi;
    let entry = entries.get(sessionId);
    if (!deps.isEnabled()) {
      // Turned off while this chat was drawing: take the drawing down.
      if (entry) {
        forget(sessionId);
        deps.publish(sessionId, EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT);
      }
      return isUi;
    }
    if (!entry || entry.query !== query) {
      // Turned on after this query started, so it was never named.
      attach(sessionId, query);
      entry = entries.get(sessionId);
      if (!entry) return isUi;
    }
    if (subtype === "init") {
      // Plugins are loaded by now; a render asked before that drew nothing.
      requestRender(sessionId, entry);
      return false;
    }
    switch (subtype) {
      case "ui_status": {
        const plugin = cleanClaudePluginUiText(message.plugin, 128);
        if (!plugin) return true;
        const text = cleanClaudePluginUiText(message.text);
        const others = entry.snapshot.statuses.filter((status) => status.plugin !== plugin);
        if (!text && others.length === entry.snapshot.statuses.length) return true;
        const statuses = text ? [...others, { plugin, text }] : others;
        update(sessionId, entry, { statuses: statuses.slice(-MAX_CLAUDE_PLUGIN_UI_STATUSES) });
        return true;
      }
      case "ui_toast": {
        const plugin = cleanClaudePluginUiText(message.plugin, 128);
        const text = cleanClaudePluginUiText(message.text);
        if (!plugin || !text) return true;
        const timeoutMs = typeof message.timeout_ms === "number" && Number.isFinite(message.timeout_ms)
          ? Math.max(1_000, Math.min(MAX_TOAST_MS, message.timeout_ms))
          : DEFAULT_TOAST_MS;
        const id = typeof message.uuid === "string" && message.uuid ? message.uuid : `toast-${++toastCounter}`;
        update(sessionId, entry, { toast: { id, plugin, text, timeoutMs } });
        return true;
      }
      case "ui_panes": {
        const listed: PaneEntry[] = [];
        for (const raw of Array.isArray(message.panes) ? message.panes : []) {
          if (!isRecord(raw) || typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) continue;
          listed.push({
            id: raw.id,
            title: cleanClaudePluginUiText(raw.title, 128) || raw.id,
            plugin: cleanClaudePluginUiText(raw.plugin, 128),
          });
          if (listed.length >= MAX_CLAUDE_PLUGIN_UI_PANES) break;
        }
        const drawn = new Map(entry.snapshot.panes.map((pane) => [pane.id, pane]));
        for (const id of drawn.keys()) {
          if (!listed.some((pane) => pane.id === id)) setSiteTargets(entry, `pane:${id}`, null);
        }
        update(sessionId, entry, {
          panes: listed.map((pane) => ({ ...pane, tree: drawn.get(pane.id)?.tree ?? null })),
        });
        requestRender(sessionId, entry);
        return true;
      }
      case "ui_invalidate":
        requestRender(sessionId, entry);
        return true;
      default:
        // ui_log and the rest: debug output, or UI this host does not draw.
        return true;
    }
  };

  const get = (sessionId: string): ClaudePluginUiSnapshot =>
    (deps.isEnabled() ? entries.get(sessionId)?.snapshot : null) ?? EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT;

  /** Forwards a press, a typed value, a pick or a pane close to the chat's live query. */
  const act = async (args: ClaudePluginUiActArgs): Promise<ClaudePluginUiActResult> => {
    const sessionId = typeof args?.sessionId === "string" ? args.sessionId : "";
    const entry = entries.get(sessionId);
    const request = entry?.request;
    // A control drawn by an earlier process is not this process's control.
    if (!entry || !request || !deps.isEnabled() || entry.snapshot.generation !== args.generation) {
      return { handled: false };
    }
    try {
      if (args.kind === "closePane") {
        if (!entry.snapshot.panes.some((pane) => pane.id === args.paneId)) return { handled: false };
        const response = await send(request, { subtype: "ui_close", id: args.paneId });
        return { handled: response?.closed === true };
      }
      const target = args.target;
      // Only a control this host sent to clients may be acted on.
      if (!target || !entry.targets.has(targetKey(target))) return { handled: false };
      const key = typeof args.key === "string" && args.key.length <= 256 ? { key: args.key } : {};
      if (args.kind === "press") {
        const response = await send(request, {
          subtype: "ui_press",
          plugin: target.plugin,
          handle: target.handle,
          surface: "desktop",
          ...key,
        });
        return { handled: response?.handled === true };
      }
      if (typeof args.value !== "string" || args.value.length > MAX_CLAUDE_PLUGIN_UI_INPUT_CHARS) return { handled: false };
      const site = args.site?.component === "Pane"
        ? { component: "Pane", instance_id: args.site.paneId }
        : { component: "AbovePrompt", instance_id: BAND_INSTANCE_ID };
      const response = await send(request, {
        subtype: args.kind === "input" ? "ui_input" : "ui_select",
        plugin: target.plugin,
        handle: target.handle,
        surface: "desktop",
        value: args.value,
        ...(args.kind === "input" ? { kind: "submit" } : {}),
        ...key,
        ...site,
      });
      return { handled: response?.handled === true };
    } catch (error) {
      deps.logger.debug("agent_chat.claude_plugin_ui_action_failed", {
        sessionId,
        kind: args.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return { handled: false };
    }
  };

  return { attach, detach, forget, ingest, get, act };
}

export type ClaudePluginUiService = ReturnType<typeof createClaudePluginUiService>;
