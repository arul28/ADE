/**
 * `ade browser attach`: a chat drives one tab of the user's own, signed-in
 * Chromium browser over the Chrome DevTools Protocol.
 *
 * ADE's own browser stays the default for web work. An agent attaches only
 * when the user asked it to look at or use their browser; the user's request
 * is the consent, and Chrome's own "Allow remote debugging?" prompt on connect
 * is Chrome's. This service runs on the chat's runtime host — the machine the
 * agent runs on — so it works headless and on remote runtimes alike, with no
 * desktop renderer involved.
 *
 * While a chat is attached, the runtime routes that chat's ordinary
 * `ade browser` page commands here instead of to ADE's browser. The actions
 * themselves are App Control's agent action engine (`observe` with element
 * handles, `click` / `fill` / `type` / `press` / `scroll` / `hover` / `wait`
 * with `hit:` / `effect:` reporting, traces), driven over a flattened target
 * session on one browser-level CDP connection.
 *
 * Attachment is per chat. It drops when the browser disconnects, the tab
 * closes, or it sits unused; the next command says so and the chat is back on
 * ADE's browser.
 *
 * @module userBrowser/userBrowserAttachService
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  AppControlAgentPressArgs,
  AppControlAgentTypeArgs,
  AppControlConsoleDiagnostic,
  AppControlDiagnostics,
  AppControlNetworkDiagnostic,
  AppControlSession,
} from "../../../shared/types";
import { createAppControlAgentActions, type AppControlAgentActions } from "../appControl/appControlAgentActions";
import {
  MAX_APP_CONTROL_CONSOLE_DIAGNOSTICS,
  MAX_APP_CONTROL_NETWORK_DIAGNOSTICS,
} from "../appControl/appControlObservations";
import type { Logger } from "../logging/logger";
import { CdpClient, type CdpCommandChannel } from "../shared/cdpClient";
import { imageDimensions } from "../shared/imageDimensions";
import { nowIso } from "../shared/utils";
import {
  discoverUserBrowsers,
  isUserBrowserId,
  userBrowserLabel,
  type DiscoveredUserBrowser,
  type UserBrowserId,
} from "./userBrowserDiscovery";

/** Long enough for the user to read and answer Chrome's "Allow remote debugging?" prompt. */
const CONNECT_TIMEOUT_MS = 60_000;
/** One visibility probe per tab while picking the tab the user is looking at. */
const TAB_PROBE_TIMEOUT_MS = 1_500;
const MAX_PROBED_TABS = 40;
/** An attachment nobody used for this long is dropped, closing the connection. */
const IDLE_TIMEOUT_MS = 30 * 60_000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const TAB_CLOSE_SETTLE_MS = 500;
const MAX_PENDING_REQUESTS = 500;
const OBSERVATION_CACHE_DIR = path.join(".ade", "cache", "user-browser-observations");

/** The first line of a successful attach; the transcript keys on it. */
export const USER_BROWSER_ATTACHED_PREFIX = "attached:";
export const USER_BROWSER_DETACHED_PREFIX = "detached:";

export class UserBrowserAttachError extends Error {}

type PageTarget = { targetId: string; title: string; url: string };

export type UserBrowserTab = { targetId: string; title: string; url: string };

export type UserBrowserAttachInput = {
  chatSessionId?: string | null;
  browser?: string | null;
  /** A title or URL substring naming the tab; the user's visible tab when absent. */
  tab?: string | null;
  /** One profile directory instead of the default ones (a browser started with `--user-data-dir`). */
  userDataDir?: string | null;
};

export type UserBrowserAttachResult = {
  attached: true;
  message: string;
  browser: UserBrowserId;
  browserLabel: string;
  machine: string;
  tab: UserBrowserTab;
  notes: string[];
  userBrowserTarget: string;
};

export type UserBrowserDetachResult = {
  detached: boolean;
  message: string;
};

export type UserBrowserStatus = {
  attached: boolean;
  machine: string;
  browser: UserBrowserId | null;
  browserLabel: string | null;
  tab: UserBrowserTab | null;
  attachedAt: string | null;
  /** Set once the attachment dropped; reported on the next command, then cleared. */
  lostReason: string | null;
  /** What the port files say, read without connecting. */
  available: Array<{ id: UserBrowserId; label: string; remoteDebugging: boolean; inspectUrl: string }>;
};

type PendingRequest = { url: string; method: string | null; resourceType: string | null; startedAt: string; startedAtMs: number };

type Attachment = {
  chatSessionId: string;
  browser: UserBrowserId;
  browserLabel: string;
  machine: string;
  client: CdpClient;
  page: CdpCommandChannel;
  targetId: string;
  cdpSessionId: string;
  title: string;
  url: string;
  attachedAt: string;
  lostReason: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  session: AppControlSession;
  actions: AppControlAgentActions;
  pageEnabled: boolean;
  console: AppControlConsoleDiagnostic[];
  network: AppControlNetworkDiagnostic[];
  pendingRequests: Map<string, PendingRequest>;
  lastNetworkActivityAtMs: number;
};

export type UserBrowserAttachServiceDeps = {
  projectRoot: string;
  logger: Logger;
  /** The runtime host's name, as the user knows it ("Arul's Mac Studio"). */
  machineName: () => string | Promise<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

function quoteTitle(title: string): string {
  const trimmed = title.trim() || "(untitled)";
  return `"${trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed}"`;
}

function describeTab(tab: { title: string; url: string }): string {
  return `${quoteTitle(tab.title)} (${tab.url})`;
}

function tabList(tabs: readonly PageTarget[]): string {
  return tabs.slice(0, 15).map((tab) => `  - ${describeTab(tab)}`).join("\n")
    + (tabs.length > 15 ? `\n  - …and ${tabs.length - 15} more` : "");
}

/**
 * The words every command prints first while attached, so neither the agent
 * nor the user can mistake the user's browser for ADE's.
 */
export function userBrowserTargetLabel(browserLabel: string, machine: string): string {
  return `your ${browserLabel} on ${machine}`;
}

/** Schemes an agent may navigate the user's tab to. Never the browser's own settings pages. */
function navigableUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new UserBrowserAttachError("browser open needs a URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    && !/^(localhost|127\.0\.0\.1|\[::1\]):\d/i.test(trimmed)
    ? trimmed
    : /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new UserBrowserAttachError(`"${trimmed}" is not a URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.href !== "about:blank") {
    throw new UserBrowserAttachError(
      `ADE navigates the user's tab only to http(s) pages, not ${parsed.protocol} URLs.`,
    );
  }
  return parsed.href;
}

/** Built-in browser methods that act on the attached tab, by the name the runtime calls. */
const ROUTED_METHODS = new Set([
  "getStatus",
  "observe",
  "click",
  "typeText",
  "fill",
  "clear",
  "dispatchKey",
  "scroll",
  "wait",
  "hover",
  "getTrace",
  "captureScreenshot",
  "navigate",
  "reload",
  "goBack",
  "goForward",
  "stop",
  "startSession",
  "listSessions",
  "endSession",
]);

/**
 * Methods that keep going to ADE's own browser machinery even while attached:
 * they do not act on a page (the dev-server list, a demo step caption).
 */
const PASSTHROUGH_METHODS = new Set(["getDevServers", "noteDemoStep", "acknowledgeRemoteRequest"]);

/** The CLI word for a refused method, so the message names what the agent typed. */
const METHOD_COMMAND_WORDS: Record<string, string> = {
  createTab: "new-tab",
  switchTab: "switch",
  closeTab: "close",
  claim: "claim",
  showPanel: "panel",
  requestOriginAccess: "authorize",
  startHandoff: "handoff",
  waitForHandoff: "handoff",
  setEmulation: "emulate",
  setZoom: "zoom",
  findInPage: "find",
  stopFindInPage: "find-stop",
  setDevTools: "devtools",
  setNetworkLogging: "network",
  getNetworkLog: "network",
  exportHar: "har",
  drag: "drag",
  selectOption: "select-option",
  uploadFile: "upload",
  startRecording: "record start",
  stopRecording: "record stop",
  startInspect: "inspect-start",
  stopInspect: "inspect-stop",
  selectPoint: "select",
  selectCurrent: "select-current",
  clearSelection: "clear-selection",
};

export type UserBrowserAttachService = ReturnType<typeof createUserBrowserAttachService>;

export function createUserBrowserAttachService(deps: UserBrowserAttachServiceDeps) {
  const attachments = new Map<string, Attachment>();

  const machine = async (): Promise<string> => {
    try {
      const name = (await deps.machineName())?.trim();
      return name || "this computer";
    } catch {
      return "this computer";
    }
  };

  const requireChat = (input: unknown): string => {
    const chatSessionId = isRecord(input) ? stringOrNull(input.chatSessionId) : null;
    if (!chatSessionId) {
      throw new UserBrowserAttachError(
        "Attaching to the user's browser needs a chat: run it from an ADE chat, whose shell carries ADE_CHAT_SESSION_ID.",
      );
    }
    return chatSessionId;
  };

  const closeAttachment = async (attachment: Attachment): Promise<void> => {
    if (attachment.idleTimer) clearTimeout(attachment.idleTimer);
    attachment.idleTimer = null;
    if (!attachment.client.isClosed()) {
      await withTimeout(
        attachment.client.send("Target.detachFromTarget", { sessionId: attachment.cdpSessionId }),
        1_000,
      );
    }
    await withTimeout(attachment.client.close(), 1_000);
  };

  /** Drop the connection but keep the record, so the next command can say why. */
  const markLost = (attachment: Attachment, reason: string): void => {
    if (attachments.get(attachment.chatSessionId) !== attachment || attachment.lostReason) return;
    attachment.lostReason = reason;
    deps.logger.info("user_browser.attachment_lost", {
      chatSessionId: attachment.chatSessionId,
      browser: attachment.browser,
      reason,
    });
    void closeAttachment(attachment);
  };

  const armIdleTimer = (attachment: Attachment): void => {
    if (attachment.idleTimer) clearTimeout(attachment.idleTimer);
    attachment.idleTimer = setTimeout(() => {
      markLost(attachment, `it sat unused for ${Math.round(IDLE_TIMEOUT_MS / 60_000)} minutes`);
    }, IDLE_TIMEOUT_MS);
    attachment.idleTimer.unref?.();
  };

  /** The live attachment, or a thrown explanation of why it is gone. */
  const requireAttachment = (chatSessionId: string): Attachment => {
    const attachment = attachments.get(chatSessionId);
    if (!attachment) {
      throw new UserBrowserAttachError("This chat is not attached to the user's browser.");
    }
    if (attachment.lostReason) {
      attachments.delete(chatSessionId);
      throw new UserBrowserAttachError(
        `${USER_BROWSER_DETACHED_PREFIX} ${attachment.browserLabel} on ${attachment.machine} — ${attachment.lostReason}, so this chat is back on ADE's browser. Run the command again to use ADE's browser, or ask the user before attaching again.`,
      );
    }
    armIdleTimer(attachment);
    return attachment;
  };

  const targetLabelFor = (attachment: Attachment): string =>
    userBrowserTargetLabel(attachment.browserLabel, attachment.machine);

  // ── Picking the browser and the tab ──────────────────────────────────────

  const noDebuggingMessage = (
    host: string,
    candidates: DiscoveredUserBrowser[],
    requested: UserBrowserId | null,
  ): string => {
    const installed = candidates.filter((entry) => entry.installed);
    if (!installed.length) {
      return requested
        ? `${userBrowserLabel(requested)} has no profile on ${host}, so ADE cannot attach to it. Ask the user which browser they use.`
        : `No supported browser (Chrome, Edge, Brave, Arc, Helium, Chromium) has a profile on ${host}, so ADE cannot attach to the user's browser here.`;
    }
    const steps = installed.map((entry) => `${entry.label}: open ${entry.inspectUrl}`).join("; ");
    return `No browser on ${host} has remote debugging on, so ADE cannot reach the user's tabs. Ask the user to turn it on and try again — ${steps}, and turn on remote debugging there. Chrome then asks them once to allow the connection.`;
  };

  const listPageTargets = async (client: CdpClient): Promise<PageTarget[]> => {
    const response = await client.send<{ targetInfos?: unknown[] }>("Target.getTargets");
    const infos = Array.isArray(response?.targetInfos) ? response.targetInfos : [];
    return infos
      .filter(isRecord)
      .filter((info) => info.type === "page")
      .map((info) => ({
        targetId: stringOrNull(info.targetId) ?? "",
        title: typeof info.title === "string" ? info.title : "",
        url: typeof info.url === "string" ? info.url : "",
      }))
      .filter((tab) => tab.targetId && !tab.url.startsWith("devtools://"));
  };

  /** Which tabs are on screen, and which one has focus. Best effort per tab. */
  const probeVisibility = async (
    client: CdpClient,
    tabs: readonly PageTarget[],
  ): Promise<Map<string, { visible: boolean; focused: boolean }>> => {
    const probes = await Promise.all(tabs.slice(0, MAX_PROBED_TABS).map(async (tab) => {
      const attached = await withTimeout(
        client.send<{ sessionId?: string }>("Target.attachToTarget", { targetId: tab.targetId, flatten: true }),
        TAB_PROBE_TIMEOUT_MS,
      );
      const sessionId = stringOrNull(attached?.sessionId);
      if (!sessionId) return [tab.targetId, { visible: false, focused: false }] as const;
      const evaluated = await withTimeout(
        client.session(sessionId).send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
          expression: "({ visible: document.visibilityState === 'visible', focused: document.hasFocus() })",
          returnByValue: true,
        }),
        TAB_PROBE_TIMEOUT_MS,
      );
      void withTimeout(client.send("Target.detachFromTarget", { sessionId }), TAB_PROBE_TIMEOUT_MS);
      const value = isRecord(evaluated?.result?.value) ? evaluated.result.value : {};
      return [tab.targetId, { visible: value.visible === true, focused: value.focused === true }] as const;
    }));
    return new Map(probes);
  };

  const chooseTab = async (
    client: CdpClient,
    query: string | null,
    browserLabel: string,
  ): Promise<{ tab: PageTarget; visible: boolean }> => {
    const tabs = await listPageTargets(client);
    if (!tabs.length) {
      throw new UserBrowserAttachError(`${browserLabel} has no open tabs to attach to.`);
    }
    if (query) {
      const needle = query.toLowerCase();
      const matches = tabs.filter((tab) =>
        tab.title.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle));
      const exact = matches.filter((tab) => tab.title.trim().toLowerCase() === needle);
      const picked = matches.length === 1 ? matches[0] : exact.length === 1 ? exact[0] : null;
      if (picked) {
        const visibility = await probeVisibility(client, [picked]);
        return { tab: picked, visible: visibility.get(picked.targetId)?.visible ?? false };
      }
      if (!matches.length) {
        throw new UserBrowserAttachError(
          `No ${browserLabel} tab matches "${query}". Open tabs:\n${tabList(tabs)}\nPass --tab with part of one title or URL.`,
        );
      }
      throw new UserBrowserAttachError(
        `${matches.length} ${browserLabel} tabs match "${query}":\n${tabList(matches)}\nPass --tab with more of the title or URL.`,
      );
    }
    const visibility = await probeVisibility(client, tabs);
    const focused = tabs.filter((tab) => visibility.get(tab.targetId)?.focused);
    const visible = tabs.filter((tab) => visibility.get(tab.targetId)?.visible);
    const picked = focused.length === 1
      ? focused[0]
      : visible.length === 1
        ? visible[0]
        : tabs.length === 1
          ? tabs[0]
          : null;
    if (picked) return { tab: picked, visible: visibility.get(picked.targetId)?.visible ?? false };
    const plausible = visible.length ? visible : tabs;
    throw new UserBrowserAttachError(
      `${browserLabel} has ${plausible.length} tabs that could be the one the user means:\n${tabList(plausible)}\nAsk the user which one, then pass --tab with part of its title or URL.`,
    );
  };

  // ── Page state the action engine reads ───────────────────────────────────

  const pushBounded = <T,>(list: T[], entry: T, max: number): void => {
    list.push(entry);
    if (list.length > max) list.splice(0, list.length - max);
  };

  const subscribePage = (attachment: Attachment): void => {
    const { page } = attachment;
    const consoleLevel = (value: unknown): AppControlConsoleDiagnostic["level"] =>
      value === "error" || value === "assert" ? "error" : value === "warning" || value === "warn" ? "warning" : value === "debug" ? "debug" : "info";
    page.on("Runtime.consoleAPICalled", (params) => {
      if (!isRecord(params)) return;
      const level = consoleLevel(params.type);
      if (level !== "error" && level !== "warning") return;
      const message = (Array.isArray(params.args) ? params.args : [])
        .map((entry) => (isRecord(entry) ? (typeof entry.value === "string" ? entry.value : stringOrNull(entry.description) ?? "") : ""))
        .filter(Boolean)
        .join(" ")
        .slice(0, 2_000);
      if (!message) return;
      pushBounded(attachment.console, { level, message, sourceId: null, line: null, column: null, timestamp: nowIso() }, MAX_APP_CONTROL_CONSOLE_DIAGNOSTICS);
    });
    page.on("Runtime.exceptionThrown", (params) => {
      const details = isRecord(params) && isRecord(params.exceptionDetails) ? params.exceptionDetails : null;
      if (!details) return;
      const exception = isRecord(details.exception) ? details.exception : null;
      const message = stringOrNull(exception?.description) ?? stringOrNull(details.text) ?? "Uncaught exception";
      pushBounded(attachment.console, {
        level: "error",
        message: message.slice(0, 2_000),
        sourceId: stringOrNull(details.url),
        line: typeof details.lineNumber === "number" ? details.lineNumber + 1 : null,
        column: typeof details.columnNumber === "number" ? details.columnNumber + 1 : null,
        timestamp: nowIso(),
      }, MAX_APP_CONTROL_CONSOLE_DIAGNOSTICS);
    });
    page.on("Network.requestWillBeSent", (params) => {
      if (!isRecord(params)) return;
      const requestId = stringOrNull(params.requestId);
      const request = isRecord(params.request) ? params.request : {};
      const url = stringOrNull(request.url);
      if (!requestId || !url) return;
      attachment.lastNetworkActivityAtMs = Date.now();
      if (attachment.pendingRequests.size >= MAX_PENDING_REQUESTS) {
        const oldest = attachment.pendingRequests.keys().next();
        if (!oldest.done) attachment.pendingRequests.delete(oldest.value);
      }
      attachment.pendingRequests.set(requestId, {
        url,
        method: stringOrNull(request.method),
        resourceType: stringOrNull(params.type),
        startedAt: nowIso(),
        startedAtMs: Date.now(),
      });
    });
    const settle = (params: unknown, failure: { statusCode: number | null; error: string | null } | null): void => {
      attachment.lastNetworkActivityAtMs = Date.now();
      const requestId = isRecord(params) ? stringOrNull(params.requestId) : null;
      const pending = requestId ? attachment.pendingRequests.get(requestId) ?? null : null;
      if (requestId && (failure?.error != null || !failure)) attachment.pendingRequests.delete(requestId);
      if (!failure) return;
      pushBounded(attachment.network, {
        url: pending?.url ?? (isRecord(params) && isRecord(params.response) ? stringOrNull(params.response.url) : null) ?? "about:blank",
        method: pending?.method ?? null,
        resourceType: pending?.resourceType ?? (isRecord(params) ? stringOrNull(params.type) : null),
        statusCode: failure.statusCode,
        error: failure.error,
        startedAt: pending?.startedAt ?? null,
        endedAt: nowIso(),
        durationMs: pending ? Math.max(0, Date.now() - pending.startedAtMs) : null,
      }, MAX_APP_CONTROL_NETWORK_DIAGNOSTICS);
    };
    page.on("Network.responseReceived", (params) => {
      const status = isRecord(params) && isRecord(params.response) ? params.response.status : null;
      if (typeof status === "number" && status >= 400) settle(params, { statusCode: status, error: null });
      else attachment.lastNetworkActivityAtMs = Date.now();
    });
    page.on("Network.loadingFinished", (params) => settle(params, null));
    page.on("Network.loadingFailed", (params) => {
      if (isRecord(params) && params.canceled === true) {
        settle(params, null);
        return;
      }
      settle(params, { statusCode: null, error: (isRecord(params) ? stringOrNull(params.errorText) : null) ?? "Request failed." });
    });
    page.on("Page.frameNavigated", (params) => {
      const frame = isRecord(params) && isRecord(params.frame) ? params.frame : null;
      if (!frame || stringOrNull(frame.parentId)) return;
      attachment.url = stringOrNull(frame.url) ?? attachment.url;
      attachment.console = [];
      attachment.network = [];
      attachment.pendingRequests.clear();
    });
    // Best effort: a page that refuses one still serves input and screenshots.
    void page.send("Runtime.enable").catch(() => {});
    void page.send("Network.enable").catch(() => {});
  };

  const buildActions = (attachment: Attachment): AppControlAgentActions =>
    createAppControlAgentActions({
      logger: deps.logger,
      resolveProjectRoot: () => deps.projectRoot,
      getActiveSession: () => attachment.session,
      updateSession: (patch) => {
        attachment.session = { ...attachment.session, ...patch };
        return attachment.session;
      },
      withCdp: async (fn) => {
        if (attachment.lostReason) requireAttachment(attachment.chatSessionId);
        return await fn(attachment.page, attachment.session);
      },
      enablePageDomain: async (channel) => {
        if (attachment.pageEnabled) return;
        await channel.send("Page.enable").catch(() => {});
        attachment.pageEnabled = true;
      },
      // `ade browser` coordinates are viewport CSS pixels, as in ADE's browser;
      // screenshot-space points divide by the page's own pixel ratio.
      normalizeViewportPoint: async (channel, point) => {
        if (point.coordinateSpace !== "screenshot" && !(typeof point.scale === "number" && point.scale > 0)) {
          return { x: Math.max(0, point.x), y: Math.max(0, point.y) };
        }
        let scale = typeof point.scale === "number" && point.scale > 0 ? point.scale : null;
        if (scale == null) {
          const evaluated = await channel.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
            expression: "window.devicePixelRatio || 1",
            returnByValue: true,
          }).catch(() => null);
          const value = evaluated?.result?.value;
          scale = typeof value === "number" && value > 0 ? value : 1;
        }
        return { x: Math.max(0, point.x / scale), y: Math.max(0, point.y / scale) };
      },
      snapshotDiagnostics: (): AppControlDiagnostics => ({
        capturedAt: nowIso(),
        pendingRequestCount: attachment.pendingRequests.size,
        console: [...attachment.console],
        network: [...attachment.network],
      }),
      isNetworkIdle: (idleMs) =>
        attachment.pendingRequests.size === 0 && Date.now() - attachment.lastNetworkActivityAtMs >= idleMs,
      getLastScreencastFrame: () => null,
      imageDimensions,
      observationCacheDir: OBSERVATION_CACHE_DIR,
    });

  // ── Attach / detach / status ─────────────────────────────────────────────

  const detachChat = async (chatSessionId: string): Promise<Attachment | null> => {
    const existing = attachments.get(chatSessionId) ?? null;
    if (!existing) return null;
    attachments.delete(chatSessionId);
    await closeAttachment(existing);
    return existing;
  };

  const attach = async (input: UserBrowserAttachInput = {}): Promise<UserBrowserAttachResult> => {
    const chatSessionId = requireChat(input);
    const host = await machine();
    const requestedRaw = stringOrNull(input.browser)?.toLowerCase() ?? null;
    if (requestedRaw && !isUserBrowserId(requestedRaw)) {
      throw new UserBrowserAttachError(
        `--browser must be one of chrome, edge, brave, arc, helium or chromium (got "${requestedRaw}").`,
      );
    }
    const requested = requestedRaw as UserBrowserId | null;
    const userDataDir = stringOrNull(input.userDataDir);
    const candidates = discoverUserBrowsers({ browser: requested, userDataDir });
    const debuggable = candidates.filter((entry) => entry.debugging);
    if (!debuggable.length) {
      const explicit = userDataDir ? candidates[0] : null;
      throw new UserBrowserAttachError(
        explicit
          ? explicit.installed
            ? `${explicit.userDataDir} has no DevToolsActivePort file, so the browser using it does not have remote debugging on (or is not running).`
            : `${explicit.userDataDir} is not a browser profile directory on ${host}.`
          : noDebuggingMessage(host, candidates, requested),
      );
    }

    let client: CdpClient | null = null;
    let chosen: DiscoveredUserBrowser | null = null;
    const refused: string[] = [];
    for (const candidate of debuggable) {
      const port = candidate.debugging!;
      const wsUrl = `ws://127.0.0.1:${port.port}${port.browserPath}`;
      try {
        client = await CdpClient.connect(wsUrl, { timeoutMs: CONNECT_TIMEOUT_MS });
        chosen = candidate;
        break;
      } catch (error) {
        const message = errorMessage(error);
        // A port file left behind by a browser that has since quit: nothing
        // listens there. Try the next browser rather than failing on a ghost.
        if (/ECONNREFUSED/i.test(message)) {
          refused.push(`${candidate.label} (port ${port.port} is not listening; it may have quit)`);
          continue;
        }
        throw new UserBrowserAttachError(
          /timed out/i.test(message)
            ? `${candidate.label} on ${host} did not accept the connection within ${CONNECT_TIMEOUT_MS / 1000}s. The user has to click Allow in ${candidate.label}'s "Allow remote debugging?" prompt; ask them, then run attach again.`
            : `${candidate.label} on ${host} refused the connection (${message}). The user may have declined ${candidate.label}'s "Allow remote debugging?" prompt; ask them, then run attach again.`,
        );
      }
    }
    if (!client || !chosen) {
      throw new UserBrowserAttachError(
        `No browser on ${host} answered on its remote-debugging port: ${refused.join("; ")}. Ask the user to open the browser (with remote debugging on) and try again.`,
      );
    }

    try {
      const { tab, visible } = await chooseTab(client, stringOrNull(input.tab), chosen.label);
      const attachedTarget = await client.send<{ sessionId?: string }>("Target.attachToTarget", {
        targetId: tab.targetId,
        flatten: true,
      });
      const cdpSessionId = stringOrNull(attachedTarget?.sessionId);
      if (!cdpSessionId) throw new UserBrowserAttachError(`${chosen.label} did not attach to the tab.`);
      const attachedAt = nowIso();
      const sessionId = `user-browser-${randomUUID()}`;
      const attachment: Attachment = {
        chatSessionId,
        browser: chosen.id,
        browserLabel: chosen.label,
        machine: host,
        client,
        page: client.session(cdpSessionId),
        targetId: tab.targetId,
        cdpSessionId,
        title: tab.title,
        url: tab.url,
        attachedAt,
        lostReason: null,
        idleTimer: null,
        session: {
          id: sessionId,
          appKind: "electron",
          label: `${chosen.label} on ${host}`,
          projectRoot: deps.projectRoot,
          laneId: null,
          cwd: null,
          command: null,
          pid: null,
          terminalSessionId: null,
          terminalPtyId: null,
          cdpPort: chosen.debugging!.port,
          cdpEndpoint: null,
          cdpTargetId: tab.targetId,
          provider: "cdp",
          driver: "cdp",
          chatSessionId,
          startedAt: attachedAt,
          connectedAt: attachedAt,
          status: "connected",
          lastError: null,
          lastObservationId: null,
          lastTraceEntryId: null,
        },
        actions: null as unknown as AppControlAgentActions,
        pageEnabled: false,
        console: [],
        network: [],
        pendingRequests: new Map(),
        lastNetworkActivityAtMs: Date.now(),
      };
      attachment.actions = buildActions(attachment);
      // A fresh attach replaces this chat's old one — only once it succeeded,
      // so a refused re-attach leaves the working attachment alone.
      await detachChat(chatSessionId);
      attachments.set(chatSessionId, attachment);
      subscribePage(attachment);
      // A quitting browser closes its tabs a moment before its socket drops.
      // Wait that moment, so the reason says the browser quit, not the tab.
      const tabClosed = (): void => {
        const timer = setTimeout(() => markLost(attachment, "the attached tab closed"), TAB_CLOSE_SETTLE_MS);
        timer.unref?.();
      };
      client.on("Target.detachedFromTarget", (params) => {
        if (isRecord(params) && params.sessionId === cdpSessionId) tabClosed();
      });
      client.on("Target.targetDestroyed", (params) => {
        if (isRecord(params) && params.targetId === tab.targetId) tabClosed();
      });
      client.onClose(() => {
        markLost(attachment, `${chosen!.label} disconnected (it quit, or remote debugging was turned off)`);
      });
      armIdleTimer(attachment);
      const userBrowserTarget = targetLabelFor(attachment);
      const notes = visible
        ? []
        : ["This tab is in the background. Screenshots can fail or show an old frame until the user brings it forward."];
      deps.logger.info("user_browser.attached", { chatSessionId, browser: chosen.id });
      return {
        attached: true,
        message: `${USER_BROWSER_ATTACHED_PREFIX} ${chosen.label} on ${host}, tab ${describeTab(tab)}`,
        browser: chosen.id,
        browserLabel: chosen.label,
        machine: host,
        tab: { targetId: tab.targetId, title: tab.title, url: tab.url },
        notes,
        userBrowserTarget,
      };
    } catch (error) {
      if (attachments.get(chatSessionId)?.client === client) attachments.delete(chatSessionId);
      await withTimeout(client.close(), 1_000);
      throw error;
    }
  };

  const detach = async (input: { chatSessionId?: string | null } = {}): Promise<UserBrowserDetachResult> => {
    const chatSessionId = requireChat(input);
    const existing = await detachChat(chatSessionId);
    if (!existing) {
      return {
        detached: false,
        message: "not attached: this chat already uses ADE's browser.",
      };
    }
    return {
      detached: true,
      message: `${USER_BROWSER_DETACHED_PREFIX} ${existing.browserLabel} on ${existing.machine}. This chat is back on ADE's browser.`,
    };
  };

  const status = async (input: { chatSessionId?: string | null } = {}): Promise<UserBrowserStatus> => {
    const chatSessionId = isRecord(input) ? stringOrNull(input.chatSessionId) : null;
    const attachment = chatSessionId ? attachments.get(chatSessionId) ?? null : null;
    // File reads only. Connecting is what prompts the user, so status never does.
    const available = discoverUserBrowsers()
      .filter((entry) => entry.installed)
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        remoteDebugging: Boolean(entry.debugging),
        inspectUrl: entry.inspectUrl,
      }));
    return {
      attached: Boolean(attachment && !attachment.lostReason),
      machine: attachment?.machine ?? await machine(),
      browser: attachment?.browser ?? null,
      browserLabel: attachment?.browserLabel ?? null,
      tab: attachment ? { targetId: attachment.targetId, title: attachment.title, url: attachment.url } : null,
      attachedAt: attachment?.attachedAt ?? null,
      lostReason: attachment?.lostReason ?? null,
      available,
    };
  };

  // ── Routing the chat's `ade browser` commands ────────────────────────────

  /** True when this chat's page commands belong to the user's browser (or must report its loss). */
  const routes = (chatSessionId: string | null | undefined, method: string): boolean => {
    if (!chatSessionId || !attachments.has(chatSessionId)) return false;
    return !PASSTHROUGH_METHODS.has(method);
  };

  const engineArgs = (input: Record<string, unknown>): Record<string, unknown> => {
    // Tab, session and routing ids name ADE's browser; the attachment is the target.
    const {
      chatSessionId: _chat,
      laneId: _lane,
      projectRoot: _root,
      tabId: _tab,
      sessionId: _session,
      force: _force,
      leaseTtlMs: _lease,
      requireScreenshot: _require,
      ...rest
    } = input;
    return rest;
  };

  const rememberPage = (attachment: Attachment, result: unknown): void => {
    const observation = isRecord(result) && isRecord(result.observation) ? result.observation : result;
    if (!isRecord(observation)) return;
    attachment.url = stringOrNull(observation.url) ?? attachment.url;
    attachment.title = typeof observation.title === "string" ? observation.title : attachment.title;
  };

  const readPage = async (attachment: Attachment): Promise<{ url: string; title: string }> => {
    const evaluated = await attachment.page.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression: "({ url: location.href, title: document.title })",
      returnByValue: true,
    }).catch(() => null);
    const value = isRecord(evaluated?.result?.value) ? evaluated.result.value : {};
    attachment.url = stringOrNull(value.url) ?? attachment.url;
    attachment.title = typeof value.title === "string" ? value.title : attachment.title;
    return { url: attachment.url, title: attachment.title };
  };

  /** A navigation's answer in the shape `ade browser open` already prints. */
  const tabStatus = async (attachment: Attachment, verb: "navigated" | "status") => {
    const page = await readPage(attachment);
    const tab = {
      id: attachment.targetId,
      url: page.url,
      title: page.title,
      ownerChatSessionId: attachment.chatSessionId,
    };
    return {
      ...(verb === "navigated" ? { targetTabId: attachment.targetId, targetTabCreated: false } : {}),
      activeTabId: attachment.targetId,
      url: page.url,
      title: page.title,
      tabs: [tab],
    };
  };

  const waitForLoad = async (attachment: Attachment, action: () => Promise<unknown>): Promise<void> => {
    let stop: (() => void) | null = null;
    const loaded = new Promise<void>((resolve) => {
      stop = attachment.page.on("Page.loadEventFired", () => resolve());
    });
    try {
      await action();
      await withTimeout(loaded, NAVIGATION_TIMEOUT_MS);
    } finally {
      (stop as (() => void) | null)?.();
    }
  };

  const pseudoSession = (attachment: Attachment) => ({
    id: attachment.session.id,
    tabId: attachment.targetId,
    createdAt: attachment.attachedAt,
    updatedAt: nowIso(),
    ownerChatSessionId: attachment.chatSessionId,
    lastObservationId: attachment.session.lastObservationId,
    lastTraceEntryId: attachment.session.lastTraceEntryId,
  });

  const run = async (attachment: Attachment, method: string, input: Record<string, unknown>): Promise<unknown> => {
    const { actions } = attachment;
    const args = engineArgs(input);
    switch (method) {
      case "observe":
        return { ...(await actions.observe(args)), tabId: attachment.targetId };
      case "click":
        return await actions.agentClick({ coordinateSpace: "viewport", ...args });
      case "hover":
        return await actions.agentHover({ coordinateSpace: "viewport", ...args });
      case "typeText":
        // The engine checks `text` itself and answers with the reason.
        return await actions.agentType(args as AppControlAgentTypeArgs);
      case "fill": {
        // The CLI sends the payload as `text` unless `text` is the element match.
        const value = typeof args.value === "string"
          ? args.value
          : typeof args.text === "string" ? args.text : null;
        const { text: _text, ...rest } = args;
        return await actions.agentFill(typeof args.value === "string" ? args : { ...rest, value });
      }
      case "clear":
        return await actions.agentClear(args);
      case "dispatchKey":
        return await actions.agentPress(args as AppControlAgentPressArgs);
      case "scroll": {
        if (args.x == null || args.y == null) {
          // No point given: wheel at the middle of the viewport, as a person would.
          const metrics = await attachment.page.send<{ cssVisualViewport?: { clientWidth?: number; clientHeight?: number } }>(
            "Page.getLayoutMetrics",
          ).catch(() => null);
          const width = metrics?.cssVisualViewport?.clientWidth ?? 0;
          const height = metrics?.cssVisualViewport?.clientHeight ?? 0;
          return await actions.agentScroll({ ...args, x: width / 2, y: height / 2, coordinateSpace: "viewport" });
        }
        return await actions.agentScroll({ coordinateSpace: "viewport", ...args });
      }
      case "wait":
        return await actions.agentWait(args);
      case "getTrace": {
        const trace = actions.getTrace(args);
        return {
          ...trace,
          entries: trace.entries.map((entry) =>
            entry.error ? { ...entry, error: entry.error.replace(/App Control /g, "") } : entry),
          tabId: attachment.targetId,
        };
      }
      case "captureScreenshot": {
        if (!attachment.pageEnabled) {
          await attachment.page.send("Page.enable").catch(() => {});
          attachment.pageEnabled = true;
        }
        const shot = await attachment.page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
        const dimensions = imageDimensions(Buffer.from(shot.data, "base64")) ?? { width: 0, height: 0 };
        return {
          capturedAt: nowIso(),
          width: dimensions.width,
          height: dimensions.height,
          dataUrl: `data:image/png;base64,${shot.data}`,
        };
      }
      case "navigate": {
        if (input.newTab === true || input.isolated === true || stringOrNull(input.profile)) {
          throw new UserBrowserAttachError(
            "New and isolated tabs open only in ADE's browser. This chat navigates the attached tab; run `ade browser detach` first to use ADE's browser.",
          );
        }
        const url = navigableUrl(stringOrNull(input.url) ?? "");
        await waitForLoad(attachment, async () => {
          const response = await attachment.page.send<{ errorText?: string }>("Page.navigate", { url });
          if (response?.errorText) throw new UserBrowserAttachError(`Navigation failed: ${response.errorText}`);
        });
        return await tabStatus(attachment, "navigated");
      }
      case "reload":
        await waitForLoad(attachment, () => attachment.page.send("Page.reload"));
        return await tabStatus(attachment, "status");
      case "goBack":
      case "goForward": {
        const history = await attachment.page.send<{ currentIndex?: number; entries?: Array<{ id?: number }> }>(
          "Page.getNavigationHistory",
        );
        const index = (history.currentIndex ?? 0) + (method === "goBack" ? -1 : 1);
        const entry = history.entries?.[index];
        if (!entry || typeof entry.id !== "number") {
          throw new UserBrowserAttachError(`The tab has no page to go ${method === "goBack" ? "back" : "forward"} to.`);
        }
        await waitForLoad(attachment, () => attachment.page.send("Page.navigateToHistoryEntry", { entryId: entry.id }));
        return await tabStatus(attachment, "status");
      }
      case "stop":
        await attachment.page.send("Page.stopLoading");
        return await tabStatus(attachment, "status");
      case "startSession":
        return { session: pseudoSession(attachment) };
      case "listSessions":
        return { sessions: [pseudoSession(attachment)] };
      case "endSession":
        // The attachment is the session; `detach` ends it.
        return { session: { ...pseudoSession(attachment), endedAt: null } };
      default:
        throw new UserBrowserAttachError(`Unsupported user-browser method ${method}.`);
    }
  };

  /**
   * Run one `built_in_browser` method for an attached chat. Every answer names
   * the user's browser in `userBrowserTarget`; every failure says where it
   * happened. App Control's engine phrases its own errors for App Control, so
   * that name is taken out of them here.
   */
  const dispatch = async (method: string, input: unknown): Promise<unknown> => {
    const record = isRecord(input) ? input : {};
    const chatSessionId = requireChat(record);
    if (method === "getStatus") {
      const current = attachments.get(chatSessionId);
      if (current?.lostReason) requireAttachment(chatSessionId);
      return { userBrowser: await status({ chatSessionId }) };
    }
    const attachment = requireAttachment(chatSessionId);
    const target = targetLabelFor(attachment);
    if (!ROUTED_METHODS.has(method)) {
      const word = METHOD_COMMAND_WORDS[method] ?? method;
      throw new UserBrowserAttachError(
        `\`ade browser ${word}\` works only in ADE's browser, and this chat is attached to ${target}. Run \`ade browser detach\` first, or do the step with observe/click/fill/type/press/scroll/wait.`,
      );
    }
    try {
      const result = await run(attachment, method, record);
      rememberPage(attachment, result);
      return isRecord(result) ? { ...result, userBrowserTarget: target } : result;
    } catch (error) {
      if (attachment.lostReason) requireAttachment(chatSessionId);
      const message = errorMessage(error).replace(/App Control /g, "");
      throw new UserBrowserAttachError(`${message} (in ${target})`);
    }
  };

  const dispose = (): void => {
    for (const attachment of attachments.values()) void closeAttachment(attachment);
    attachments.clear();
  };

  return {
    attach,
    detach,
    status,
    routes,
    dispatch,
    /** True while the chat has an attachment record, live or lost-but-unreported. */
    isAttached: (chatSessionId: string | null | undefined): boolean =>
      Boolean(chatSessionId && attachments.has(chatSessionId)),
    dispose,
  };
}
