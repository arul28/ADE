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

import { isRecord, stringOrNull } from "../../../shared/agentObservationNormalizers";
import type {
  AppControlAgentPressArgs,
  AppControlAgentTypeArgs,
  AppControlConsoleDiagnostic,
  AppControlDiagnostics,
  AppControlNetworkDiagnostic,
  AppControlSession,
} from "../../../shared/types";
import {
  USER_BROWSER_ATTACHED_PREFIX,
  USER_BROWSER_DETACHED_PREFIX,
  userBrowserTargetLabel,
} from "../../../shared/userBrowserLabels";
import { createAppControlAgentActions, type AppControlAgentActions } from "../appControl/appControlAgentActions";
import {
  MAX_APP_CONTROL_CONSOLE_DIAGNOSTICS,
  MAX_APP_CONTROL_NETWORK_DIAGNOSTICS,
} from "../appControl/appControlObservations";
import type { Logger } from "../logging/logger";
import { CdpClient, type CdpCommandChannel } from "../shared/cdpClient";
import { subscribeCdpPageDiagnostics, type CdpPendingRequest } from "../shared/cdpPageDiagnostics";
import { imageDimensions } from "../shared/imageDimensions";
import { withTimeout } from "../shared/withTimeout";
import { nowIso } from "../shared/utils";
import {
  UserBrowserAttachError,
  chooseUserBrowserTab,
  describeTab,
  discoverUserBrowsers,
  isUserBrowserId,
  userBrowserLabel,
  type DiscoveredUserBrowser,
  type UserBrowserId,
} from "./userBrowserDiscovery";

export { UserBrowserAttachError };

/** Long enough for the user to read and answer Chrome's "Allow remote debugging?" prompt. */
const CONNECT_TIMEOUT_MS = 60_000;
/** An attachment nobody used for this long is dropped, closing the connection. */
const IDLE_TIMEOUT_MS = 30 * 60_000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const TAB_CLOSE_SETTLE_MS = 500;
const MAX_PENDING_REQUESTS = 500;
const OBSERVATION_CACHE_DIR = path.join(".ade", "cache", "user-browser-observations");

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
  pendingRequests: Map<string, CdpPendingRequest>;
  lastNetworkActivityAtMs: number;
};

export type UserBrowserAttachServiceDeps = {
  projectRoot: string;
  logger: Logger;
  /** The runtime host's name, as the user knows it ("Arul's Mac Studio"). */
  machineName: () => string | Promise<string>;
  /**
   * Coarse usage analytics, called once per successful attach. Injected so
   * this file owns the transition but cannot reach the analytics service or
   * any id itself. Optional, so a wiring without analytics keeps working.
   */
  captureAttached?: (() => void) | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Schemes an agent may navigate the user's tab to. Never the browser's own settings pages. */
function navigableUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new UserBrowserAttachError("browser open needs a URL.");
  // A scheme is a word and a colon NOT followed by a port: `example.com:8080`
  // and `localhost:5173` are hosts, `https://…` and `about:blank` are schemes.
  const withScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)
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

  // ── Page state the action engine reads ───────────────────────────────────

  const pushBounded = <T,>(list: T[], entry: T, max: number): void => {
    list.push(entry);
    if (list.length > max) list.splice(0, list.length - max);
  };

  /** Errors and warnings only: what an agent acting in someone else's tab needs to see. */
  const KEPT_CONSOLE_LEVELS: ReadonlySet<AppControlConsoleDiagnostic["level"]> = new Set(["error", "warning"]);

  const subscribePage = (attachment: Attachment): void => {
    subscribeCdpPageDiagnostics(attachment.page, {
      pushConsole: (entry) => pushBounded(attachment.console, entry, MAX_APP_CONTROL_CONSOLE_DIAGNOSTICS),
      pushNetwork: (entry: AppControlNetworkDiagnostic) =>
        pushBounded(attachment.network, entry, MAX_APP_CONTROL_NETWORK_DIAGNOSTICS),
      pendingRequests: attachment.pendingRequests,
      noteNetworkActivity: () => { attachment.lastNetworkActivityAtMs = Date.now(); },
      onMainFrameNavigated: (frame) => {
        attachment.url = frame.url ?? attachment.url;
        attachment.console = [];
        attachment.network = [];
        attachment.pendingRequests.clear();
      },
    }, {
      consoleLevels: KEPT_CONSOLE_LEVELS,
      consoleValues: "description",
      logEntries: false,
      exceptions: true,
      failedRequestFields: "request-first",
      httpErrorIsActivity: true,
      maxPendingRequests: MAX_PENDING_REQUESTS,
    });
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

  /**
   * The attach each chat is waiting on, if any. An attach waits on the user's
   * "Allow remote debugging?" prompt; a detach, a newer attach or `dispose`
   * removes or replaces its entry, which supersedes it and aborts its
   * connect. Tokens come from one counter for the whole service, so a later
   * attach can never reuse an old one, and an entry lives only while its
   * attach is pending.
   */
  type PendingAttach = { token: number; abort: AbortController };
  const pendingAttaches = new Map<string, PendingAttach>();
  let attachTokens = 0;
  const cancelPendingAttach = (chatSessionId: string): boolean => {
    const pending = pendingAttaches.get(chatSessionId);
    if (!pending) return false;
    pendingAttaches.delete(chatSessionId);
    pending.abort.abort();
    return true;
  };
  /** Set by `dispose`: every pending attach is superseded and no new one starts. */
  let disposed = false;

  const detachChat = async (chatSessionId: string): Promise<Attachment | null> => {
    const existing = attachments.get(chatSessionId) ?? null;
    if (!existing) return null;
    attachments.delete(chatSessionId);
    await closeAttachment(existing);
    return existing;
  };

  const attach = async (input: UserBrowserAttachInput = {}): Promise<UserBrowserAttachResult> => {
    const chatSessionId = requireChat(input);
    if (disposed) {
      throw new UserBrowserAttachError("ADE's runtime is shutting down, so it cannot attach to the user's browser.");
    }
    cancelPendingAttach(chatSessionId);
    const mine: PendingAttach = { token: ++attachTokens, abort: new AbortController() };
    pendingAttaches.set(chatSessionId, mine);
    const superseded = (): boolean => disposed || pendingAttaches.get(chatSessionId)?.token !== mine.token;
    try {
      return await attachChat(chatSessionId, input, superseded, mine.abort.signal);
    } finally {
      if (pendingAttaches.get(chatSessionId)?.token === mine.token) pendingAttaches.delete(chatSessionId);
    }
  };

  const attachChat = async (
    chatSessionId: string,
    input: UserBrowserAttachInput,
    superseded: () => boolean,
    signal: AbortSignal,
  ): Promise<UserBrowserAttachResult> => {
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
        client = await CdpClient.connect(wsUrl, { timeoutMs: CONNECT_TIMEOUT_MS, signal });
        chosen = candidate;
        break;
      } catch (error) {
        if (superseded()) {
          throw new UserBrowserAttachError(
            "This attach was cancelled: the chat detached (or attached again) while it waited. This chat stays on ADE's browser.",
          );
        }
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
      const { tab, visible } = await chooseUserBrowserTab(client, stringOrNull(input.tab), chosen.label);
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
      if (superseded()) {
        throw new UserBrowserAttachError(
          "This attach was cancelled: the chat detached (or attached again) while it waited. This chat stays on ADE's browser.",
        );
      }
      // A fresh attach replaces this chat's old one — only once it succeeded,
      // so a refused re-attach leaves the working attachment alone.
      await detachChat(chatSessionId);
      // Closing the old attachment awaited; a detach may have run meanwhile.
      if (superseded()) {
        throw new UserBrowserAttachError(
          "This attach was cancelled: the chat detached (or attached again) while it waited. This chat stays on ADE's browser.",
        );
      }
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
      try {
        deps.captureAttached?.();
      } catch {
        // Analytics never fails an attach.
      }
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
    // Cancel an attach still waiting on the browser's prompt. A chat that
    // never attached has no generation and nothing to cancel; leave it out of
    // the map so detaching every ending chat stays free.
    const cancelledPending = cancelPendingAttach(chatSessionId);
    const existing = await detachChat(chatSessionId);
    if (!existing) {
      if (cancelledPending) {
        return {
          detached: true,
          message: `${USER_BROWSER_DETACHED_PREFIX} cancelled the attach that was waiting. This chat stays on ADE's browser.`,
        };
      }
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

  /** `Page` events (load, screenshots) need the domain on; attach turns on only `Runtime` and `Network`. */
  const ensurePageEnabled = async (attachment: Attachment): Promise<void> => {
    if (attachment.pageEnabled) return;
    await attachment.page.send("Page.enable").catch(() => {});
    attachment.pageEnabled = true;
  };

  const waitForLoad = async (attachment: Attachment, action: () => Promise<unknown>): Promise<void> => {
    // Without `Page.enable`, `Page.loadEventFired` never arrives and every
    // first navigation waits out the whole timeout.
    await ensurePageEnabled(attachment);
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

  /**
   * The viewport in CSS pixels: the layout metrics, else the page's own
   * `innerWidth` / `innerHeight`. Never 0×0 — a wheel at the origin scrolls
   * whatever sits in the corner, not the page.
   */
  const viewportSize = async (attachment: Attachment): Promise<{ width: number; height: number }> => {
    const positive = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    await ensurePageEnabled(attachment);
    const metrics = await attachment.page.send<{ cssVisualViewport?: { clientWidth?: number; clientHeight?: number } }>(
      "Page.getLayoutMetrics",
    ).catch(() => null);
    let width = positive(metrics?.cssVisualViewport?.clientWidth);
    let height = positive(metrics?.cssVisualViewport?.clientHeight);
    if (width == null || height == null) {
      const evaluated = await attachment.page.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "({ width: window.innerWidth, height: window.innerHeight })",
        returnByValue: true,
      }).catch(() => null);
      const value = isRecord(evaluated?.result?.value) ? evaluated.result.value : {};
      width = positive(value.width);
      height = positive(value.height);
    }
    if (width == null || height == null) {
      throw new UserBrowserAttachError(
        "Could not read the tab's viewport size to scroll at its center. Pass --x and --y to scroll at a point.",
      );
    }
    return { width, height };
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

  const history = async (attachment: Attachment, step: -1 | 1) => {
    const entries = await attachment.page.send<{ currentIndex?: number; entries?: Array<{ id?: number }> }>(
      "Page.getNavigationHistory",
    );
    const entry = entries.entries?.[(entries.currentIndex ?? 0) + step];
    if (!entry || typeof entry.id !== "number") {
      throw new UserBrowserAttachError(`The tab has no page to go ${step < 0 ? "back" : "forward"} to.`);
    }
    await waitForLoad(attachment, () => attachment.page.send("Page.navigateToHistoryEntry", { entryId: entry.id }));
    return await tabStatus(attachment, "status");
  };

  /**
   * The built-in browser methods that act on the attached tab, by the name the
   * runtime calls. `args` has ADE's-browser routing ids taken out; `input` is
   * the call as sent. `getStatus` is answered by `dispatch` itself.
   */
  type RoutedHandler = (attachment: Attachment, args: Record<string, unknown>, input: Record<string, unknown>) => Promise<unknown>;
  const ROUTED_HANDLERS: Readonly<Record<string, RoutedHandler>> = {
    observe: async (attachment, args) => ({ ...(await attachment.actions.observe(args)), tabId: attachment.targetId }),
    click: (attachment, args) => attachment.actions.agentClick({ coordinateSpace: "viewport", ...args }),
    hover: (attachment, args) => attachment.actions.agentHover({ coordinateSpace: "viewport", ...args }),
    // The engine checks `text` itself and answers with the reason.
    typeText: (attachment, args) => attachment.actions.agentType(args as AppControlAgentTypeArgs),
    fill: (attachment, args) => {
      // The CLI sends the payload as `text` unless `text` is the element match.
      const value = typeof args.value === "string"
        ? args.value
        : typeof args.text === "string" ? args.text : null;
      const { text: _text, ...rest } = args;
      return attachment.actions.agentFill(typeof args.value === "string" ? args : { ...rest, value });
    },
    clear: (attachment, args) => attachment.actions.agentClear(args),
    dispatchKey: (attachment, args) => attachment.actions.agentPress(args as AppControlAgentPressArgs),
    scroll: async (attachment, args) => {
      if (args.x == null || args.y == null) {
        // No point given: wheel at the middle of the viewport, as a person would.
        const { width, height } = await viewportSize(attachment);
        return await attachment.actions.agentScroll({ ...args, x: width / 2, y: height / 2, coordinateSpace: "viewport" });
      }
      return await attachment.actions.agentScroll({ coordinateSpace: "viewport", ...args });
    },
    wait: (attachment, args) => attachment.actions.agentWait(args),
    getTrace: async (attachment, args) => {
      const trace = attachment.actions.getTrace(args);
      return {
        ...trace,
        entries: trace.entries.map((entry) =>
          entry.error ? { ...entry, error: entry.error.replace(/App Control /g, "") } : entry),
        tabId: attachment.targetId,
      };
    },
    captureScreenshot: async (attachment) => {
      await ensurePageEnabled(attachment);
      const shot = await attachment.page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      const dimensions = imageDimensions(Buffer.from(shot.data, "base64")) ?? { width: 0, height: 0 };
      return {
        capturedAt: nowIso(),
        width: dimensions.width,
        height: dimensions.height,
        dataUrl: `data:image/png;base64,${shot.data}`,
      };
    },
    navigate: async (attachment, _args, input) => {
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
    },
    reload: async (attachment) => {
      await waitForLoad(attachment, () => attachment.page.send("Page.reload"));
      return await tabStatus(attachment, "status");
    },
    goBack: (attachment) => history(attachment, -1),
    goForward: (attachment) => history(attachment, 1),
    stop: async (attachment) => {
      await attachment.page.send("Page.stopLoading");
      return await tabStatus(attachment, "status");
    },
    startSession: async (attachment) => ({ session: pseudoSession(attachment) }),
    listSessions: async (attachment) => ({ sessions: [pseudoSession(attachment)] }),
    // The attachment is the session; `detach` ends it.
    endSession: async (attachment) => ({ session: { ...pseudoSession(attachment), endedAt: null } }),
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
    const handler = Object.hasOwn(ROUTED_HANDLERS, method) ? ROUTED_HANDLERS[method] : null;
    if (!handler) {
      const word = METHOD_COMMAND_WORDS[method] ?? method;
      throw new UserBrowserAttachError(
        `\`ade browser ${word}\` works only in ADE's browser, and this chat is attached to ${target}. Run \`ade browser detach\` first, or do the step with observe/click/fill/type/press/scroll/wait.`,
      );
    }
    try {
      const result = await handler(attachment, engineArgs(record), record);
      rememberPage(attachment, result);
      return isRecord(result) ? { ...result, userBrowserTarget: target } : result;
    } catch (error) {
      if (attachment.lostReason) requireAttachment(chatSessionId);
      const message = errorMessage(error).replace(/App Control /g, "");
      throw new UserBrowserAttachError(`${message} (in ${target})`);
    }
  };

  const dispose = (): void => {
    // An attach still waiting on the browser's prompt sees itself superseded
    // and closes its connection instead of storing it on a disposed service.
    disposed = true;
    for (const chatSessionId of [...pendingAttaches.keys()]) cancelPendingAttach(chatSessionId);
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
