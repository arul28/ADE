import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Globe, WarningCircle } from "@phosphor-icons/react";

import { sceneThemeSignature } from "../../../shared/chatScene";
import {
  MCP_APP_ERROR_METHOD_NOT_FOUND,
  MCP_APP_ERROR_REFUSED,
  MCP_APP_LIMITS,
  MCP_APP_PROTOCOL_VERSION,
  mcpAppItemIdFromCardId,
  mcpAppThemeContext,
  parseMcpAppFrameMessage,
  readMcpAppHeight,
  readMcpAppMessageText,
  readMcpAppOpenLinkUrl,
  type McpAppDocument,
  type McpAppGetResult,
  type McpAppRequestResult,
} from "../../../shared/mcpApp";
import type { AdeCardPayload } from "../../../shared/adeCard";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { isWebClientMode } from "../../lib/webClientMode";
import { COLORS } from "../lanes/laneDesignTokens";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { SceneReplyContext } from "./SceneFrame";
import { useSceneTheme } from "./sceneTheme";
import { useSceneOnScreen } from "./useSceneOnScreen";

/**
 * Host for an MCP App: the page an MCP server ships with one of its tools.
 *
 * The page is third-party code. It runs where a scene runs: a frame with
 * `sandbox="allow-scripts"` and never `allow-same-origin`, an opaque origin of
 * its own, loaded from `ade-scene://app/<id>` with a policy the main process
 * built from the origins the resource declared (`shared/mcpApp.ts`). A page
 * that declared none cannot reach the network at all.
 *
 * It talks to this component in JSON-RPC over `postMessage`, and this is all
 * it can do with that:
 *
 *   - learn the tool call it belongs to, ADE's theme and its own width;
 *   - report its height;
 *   - ask to open a web page, or to put text in the prompt box. Both only
 *     right after a real click or key press inside the frame, and the text is
 *     a draft the reader sends themselves;
 *   - ask for a tool call or a resource read. The request carries no server
 *     name: the brain routes it to the server this app came from, through the
 *     chat's live session, and asks the user first unless the tool is marked
 *     read-only.
 *
 * The row always says what it is and where it came from, because a page can
 * draw anything, including something that looks like ADE.
 */

/** The least time between two links, and between two drafts, one app may send. */
const OPEN_MIN_INTERVAL_MS = 800;
const MESSAGE_MIN_INTERVAL_MS = 150;
/** Requests one frame may have with the brain at once; the brain has its own cap. */
const MAX_FORWARDED_REQUESTS = 8;
/** A page that has not said `ui/initialize` by now is not going to. */
const INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_HEIGHT = 220;

/** True where this build can host an app at all: the desktop app. */
export function canHostMcpApps(): boolean {
  return typeof window !== "undefined"
    && !isWebClientMode()
    && typeof window.ade?.scene?.prepareApp === "function"
    && typeof window.ade?.agentChat?.getMcpApp === "function";
}

/*
 * Loaded apps and their prepared URLs, by chat and tool call. A row remounts
 * every time it scrolls back, and a page can be megabytes: it crosses IPC once.
 * Small on purpose, since each entry holds a whole page.
 */
const APP_CACHE_CAPACITY = 6;
const appCache = new Map<string, { app: McpAppDocument; url: string | null }>();
const heightCache = new Map<string, number>();

function rememberApp(key: string, entry: { app: McpAppDocument; url: string | null }): void {
  appCache.delete(key);
  appCache.set(key, entry);
  while (appCache.size > APP_CACHE_CAPACITY) {
    const oldest = appCache.keys().next();
    if (oldest.done) break;
    appCache.delete(oldest.value);
  }
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; app: McpAppDocument; url: string }
  | { status: "unavailable"; reason: string };

export function McpAppCard({ card }: { card: AdeCardPayload }) {
  const itemId = mcpAppItemIdFromCardId(card.cardId);
  const { sessionId, pin } = useChatRuntimeScope();
  const cacheKey = sessionId && itemId ? `${sessionId}:${itemId}` : null;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState(() => (cacheKey ? heightCache.get(cacheKey) : undefined) ?? DEFAULT_HEIGHT);
  const [notice, setNotice] = useState<string | null>(null);
  /** Requests this frame has with the brain. The frame stays up while one is out. */
  const [forwarded, setForwarded] = useState(0);
  const forwardedRef = useRef(0);
  const [initialized, setInitialized] = useState(false);

  const theme = useSceneTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const themeKey = sceneThemeSignature(theme);

  // Up while on screen, and while a call it made is still out: an approval can
  // take a minute, and the answer has to have a frame to come back to.
  const onScreen = useSceneOnScreen(wrapperRef, Boolean(cacheKey));
  const wantFrame = onScreen || forwarded > 0;

  // Load the page once the row is first on screen, and keep it. `wanted`
  // latches, so scrolling away mid-load does not cancel the load.
  const [wanted, setWanted] = useState(false);
  useEffect(() => { if (wantFrame) setWanted(true); }, [wantFrame]);
  useEffect(() => {
    if (!cacheKey || !sessionId || !itemId || !wanted) return;
    let cancelled = false;
    const cached = appCache.get(cacheKey);
    const prepare = async (app: McpAppDocument): Promise<string> => {
      const url = await window.ade.scene?.prepareApp({ html: app.html, csp: app.csp });
      if (typeof url !== "string" || !url.length) throw new Error("ADE could not prepare this app.");
      return url;
    };
    setLoad({ status: "loading" });
    void (async () => {
      try {
        let app = cached?.app ?? null;
        let url = cached?.url ?? null;
        if (!app) {
          const result: McpAppGetResult = await window.ade.agentChat.getMcpApp({ sessionId, itemId }, pin);
          if (cancelled) return;
          if (!result || result.status !== "ready") {
            setLoad({ status: "unavailable", reason: result?.reason ?? "This app could not be loaded." });
            return;
          }
          app = result.app;
        }
        url ??= await prepare(app);
        if (cancelled) return;
        rememberApp(cacheKey, { app, url });
        setLoad({ status: "ready", app, url });
      } catch (error) {
        if (!cancelled) setLoad({ status: "unavailable", reason: error instanceof Error ? error.message : "This app could not be loaded." });
      }
    })();
    return () => { cancelled = true; };
  }, [cacheKey, sessionId, itemId, pin, wanted, attempt]);

  const app = load.status === "ready" ? load.app : null;
  const src = load.status === "ready" && wantFrame ? load.url : null;
  const appRef = useRef<McpAppDocument | null>(null);
  appRef.current = app;
  /** Bumped per mounted document, so an answer for the last one is never posted to the next. */
  const generationRef = useRef(0);
  const initializedRef = useRef(false);

  useEffect(() => {
    generationRef.current += 1;
    initializedRef.current = false;
    setInitialized(false);
    forwardedRef.current = 0;
    setForwarded(0);
  }, [src]);

  const post = useCallback((message: Record<string, unknown>) => {
    // The frame's origin is opaque, so "*" is the only target that reaches it.
    try { frameRef.current?.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*"); } catch { /* frame gone */ }
  }, []);

  /** The user just clicked or pressed a key inside this frame. Same rule as a scene. */
  const framePressed = useCallback(() => {
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return frameRef.current !== null
      && document.activeElement === frameRef.current
      && (activation ? activation.isActive : true);
  }, []);

  /** The tools the user always allows for this app's server, so they can be taken back here. */
  const [alwaysAllowed, setAlwaysAllowed] = useState<string[]>([]);
  const refreshGrants = useCallback(() => {
    const current = appRef.current;
    const list = window.ade?.agentChat?.listMcpAppGrants;
    if (!current || typeof list !== "function") return;
    void list({ sessionId: current.sessionId, itemId: current.itemId }, pin)
      .then((result) => setAlwaysAllowed(Array.isArray(result?.tools) ? result.tools : []))
      .catch(() => { /* the row keeps what it last knew */ });
  }, [pin]);
  const appLoaded = app !== null;
  useEffect(() => { if (appLoaded) refreshGrants(); }, [appLoaded, refreshGrants]);
  const stopAllowing = useCallback((tool: string) => {
    const current = appRef.current;
    if (!current) return;
    void window.ade.agentChat
      .revokeMcpAppGrant({ sessionId: current.sessionId, itemId: current.itemId, tool }, pin)
      .then((result) => setAlwaysAllowed(Array.isArray(result?.tools) ? result.tools : []))
      .catch(() => { /* still allowed; the row still says so */ });
  }, [pin]);

  const replyToComposer = useContext(SceneReplyContext);
  const lastOpenRef = useRef(0);
  const lastMessageRef = useRef(0);

  const hostContext = useCallback(() => {
    const current = appRef.current;
    const width = Math.round(frameRef.current?.clientWidth ?? wrapperRef.current?.clientWidth ?? 0);
    return {
      ...(current
        ? {
            toolInfo: {
              id: current.itemId,
              tool: {
                name: current.tool,
                ...(current.toolTitle ? { title: current.toolTitle } : {}),
                ...(current.toolDescription ? { description: current.toolDescription } : {}),
                inputSchema: current.toolInputSchema && typeof current.toolInputSchema === "object"
                  ? current.toolInputSchema
                  : { type: "object" },
              },
            },
          }
        : {}),
      ...mcpAppThemeContext(themeRef.current),
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { ...(width > 0 ? { width } : {}), maxHeight: MCP_APP_LIMITS.maxHeight },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: "ADE",
      platform: "desktop",
      deviceCapabilities: { touch: false, hover: true },
    };
  }, []);

  const forward = useCallback((id: string | number, method: "tools/call" | "resources/read", params: Record<string, unknown>) => {
    const current = appRef.current;
    if (!current) return;
    if (forwardedRef.current >= MAX_FORWARDED_REQUESTS) {
      post({ id, error: { code: MCP_APP_ERROR_REFUSED, message: "This app has too many requests running." } });
      return;
    }
    const generation = generationRef.current;
    forwardedRef.current += 1;
    setForwarded(forwardedRef.current);
    // Read NOW, as the request arrives: the brain runs a tool that may change
    // data only when this is true, and an approval card takes focus later.
    const userActivated = method === "tools/call" && framePressed();
    void window.ade.agentChat
      .mcpAppRequest({ sessionId: current.sessionId, itemId: current.itemId, method, params, userActivated }, pin)
      .catch((error): McpAppRequestResult => ({
        ok: false,
        error: { code: MCP_APP_ERROR_REFUSED, message: error instanceof Error ? error.message : "The request failed." },
      }))
      .then((outcome) => {
        // A different document is in the frame now; the answer is nobody's.
        if (generation !== generationRef.current) return;
        forwardedRef.current = Math.max(0, forwardedRef.current - 1);
        setForwarded(forwardedRef.current);
        if (outcome?.ok) post({ id, result: outcome.result ?? {} });
        else post({ id, error: outcome?.error ?? { code: MCP_APP_ERROR_REFUSED, message: "The request failed." } });
        // The user may just have answered "Always allow".
        if (method === "tools/call") refreshGrants();
      });
  }, [pin, post, framePressed, refreshGrants]);

  // Only messages from this frame's own window are considered, and every one
  // is shape-checked before anything is read from it.
  useEffect(() => {
    if (!src) return;
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = parseMcpAppFrameMessage(event.data);
      const current = appRef.current;
      if (!message || !current || message.kind === "response") return;

      if (message.kind === "notification") {
        if (message.method === "ui/notifications/initialized") {
          if (initializedRef.current) return;
          initializedRef.current = true;
          setInitialized(true);
          // The spec's order: the input, then the result.
          post({ method: "ui/notifications/tool-input", params: { arguments: current.toolInput } });
          if (current.toolResult) post({ method: "ui/notifications/tool-result", params: current.toolResult });
          return;
        }
        if (message.method === "ui/notifications/size-changed") {
          const next = readMcpAppHeight(message.params);
          if (next === null) return;
          setHeight(next);
          if (cacheKey) heightCache.set(cacheKey, next);
        }
        // Log lines and anything else an app announces are dropped.
        return;
      }

      const { id, method, params } = message;
      const refuse = (text: string, code: number = MCP_APP_ERROR_REFUSED) => post({ id, error: { code, message: text } });
      switch (method) {
        case "ui/initialize":
          post({
            id,
            result: {
              protocolVersion: MCP_APP_PROTOCOL_VERSION,
              hostInfo: { name: "ADE", version: "1" },
              hostCapabilities: {
                openLinks: {},
                serverTools: {},
                serverResources: {},
                logging: {},
                // What the sandbox was actually given: these origins, no device permissions.
                sandbox: { csp: current.csp },
              },
              hostContext: hostContext(),
            },
          });
          return;
        case "ping":
          post({ id, result: {} });
          return;
        case "ui/open-link": {
          const url = readMcpAppOpenLinkUrl(params);
          if (!url) { refuse("An app can open web pages (http or https) only."); return; }
          const now = Date.now();
          if (!framePressed() || now - lastOpenRef.current < OPEN_MIN_INTERVAL_MS) {
            refuse("An app opens a link only in answer to a click or a key press.");
            return;
          }
          lastOpenRef.current = now;
          openUrlInAdeBrowser(url, { runtimePin: pin });
          post({ id, result: {} });
          return;
        }
        case "ui/message": {
          const text = readMcpAppMessageText(params);
          if (!text) { refuse("A message needs text, as the user."); return; }
          if (!replyToComposer) { refuse("This view has no prompt box to put a message in."); return; }
          const now = Date.now();
          if (!framePressed() || now - lastMessageRef.current < MESSAGE_MIN_INTERVAL_MS) {
            refuse("An app adds a message only in answer to a click or a key press.");
            return;
          }
          lastMessageRef.current = now;
          // A draft in the prompt box. Nothing is sent: the reader sends it.
          replyToComposer(text);
          post({ id, result: {} });
          return;
        }
        case "ui/request-display-mode":
          post({ id, result: { mode: "inline" } });
          return;
        case "tools/call":
        case "resources/read":
          forward(id, method, params);
          return;
        default:
          refuse("ADE does not support this request from an app.", MCP_APP_ERROR_METHOD_NOT_FOUND);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src, cacheKey, pin, post, framePressed, replyToComposer, hostContext, forward]);

  // Before the frame comes down, tell the page. Best effort: nothing waits on it.
  useEffect(() => {
    if (!src) return;
    const frame = frameRef.current;
    return () => {
      try {
        frame?.contentWindow?.postMessage(
          { jsonrpc: "2.0", id: `ade-teardown-${Date.now()}`, method: "ui/resource-teardown", params: { reason: "The app scrolled out of view." } },
          "*",
        );
      } catch { /* frame gone */ }
    };
  }, [src]);

  // ADE's theme changed while the app is up.
  const sentThemeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized) { sentThemeRef.current = null; return; }
    if (sentThemeRef.current === null) { sentThemeRef.current = themeKey; return; }
    if (sentThemeRef.current === themeKey) return;
    sentThemeRef.current = themeKey;
    post({ method: "ui/notifications/host-context-changed", params: mcpAppThemeContext(themeRef.current) });
  }, [initialized, themeKey, post]);

  // The transcript column changed width while the app is up.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!initialized || !wrapper || typeof ResizeObserver !== "function") return;
    let lastWidth = Math.round(wrapper.clientWidth);
    let timer: number | null = null;
    const observer = new ResizeObserver(() => {
      const width = Math.round(wrapper.clientWidth);
      if (width === lastWidth || width <= 0) return;
      lastWidth = width;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        post({
          method: "ui/notifications/host-context-changed",
          params: { containerDimensions: { width, maxHeight: MCP_APP_LIMITS.maxHeight } },
        });
      }, 150);
    });
    observer.observe(wrapper);
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [initialized, post]);

  // A page that never starts the handshake: say so instead of a silent box.
  useEffect(() => {
    if (!src || initialized) { setNotice(null); return; }
    const timer = window.setTimeout(() => setNotice("This app has not started."), INITIALIZE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src, initialized]);

  const retry = useCallback(() => {
    if (cacheKey) appCache.delete(cacheKey);
    setNotice(null);
    setAttempt((value) => value + 1);
  }, [cacheKey]);

  const network = useMemo(() => {
    if (!app) return [];
    return [...new Set([...app.csp.connectDomains, ...app.csp.resourceDomains])].map((origin) => origin.replace(/^[a-z]+:\/\//, ""));
  }, [app]);

  const title = card.title?.trim() || "App";
  const server = card.subtitle?.trim() || app?.server || "an MCP server";

  return (
    <div ref={wrapperRef} className="my-3 w-screen max-w-full" data-testid="chat-mcp-app" data-mcp-app-status={src ? (initialized ? "running" : "loading") : load.status}>
      {/* Always shown: what this is and whose page it is. A page can draw anything. */}
      <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: COLORS.textMuted }}>
        <AppWindow size={12} weight="bold" style={{ color: COLORS.accent }} />
        <span className="truncate" title={`${title}, an app from the MCP server ${server}. It runs in a sandbox.`}>
          {title}
          <span style={{ color: COLORS.textDim }}> · app from {server}</span>
        </span>
        {network.length ? (
          <span
            className="inline-flex min-w-0 shrink items-center gap-1 truncate"
            style={{ color: COLORS.textDim }}
            title={`This app can reach: ${network.join(", ")}`}
            data-testid="chat-mcp-app-network"
          >
            <Globe size={11} weight="bold" />
            <span className="truncate">can reach {network[0]}{network.length > 1 ? ` +${network.length - 1}` : ""}</span>
          </span>
        ) : null}
        {alwaysAllowed.map((tool) => (
          <span key={tool} className="inline-flex shrink-0 items-center gap-1" style={{ color: COLORS.textDim }} data-testid="chat-mcp-app-grant">
            {tool} is always allowed
            <button
              type="button"
              className="underline"
              style={{ color: COLORS.textMuted }}
              title={`Ask again before an app from ${server} runs ${tool}`}
              onClick={() => stopAllowing(tool)}
            >
              Ask again
            </button>
          </span>
        ))}
        {notice ? (
          <span className="inline-flex shrink-0 items-center gap-1" style={{ color: COLORS.warning }}>
            <WarningCircle size={11} weight="bold" />
            {notice}
            <button type="button" className="underline" onClick={retry}>Reload</button>
          </span>
        ) : null}
      </div>
      {load.status === "unavailable" ? (
        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.textMuted }} data-testid="chat-mcp-app-unavailable">
          <WarningCircle size={11} weight="bold" />
          {load.reason}
        </div>
      ) : (
        <div
          className="relative min-w-0 overflow-hidden rounded-md"
          style={{ border: `1px solid ${COLORS.borderMuted}`, background: theme.bg }}
        >
          {src ? (
            <iframe
              ref={frameRef}
              title={`${title} (app from ${server})`}
              data-testid="chat-mcp-app-frame"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              src={src}
              className="block w-full border-0 bg-transparent"
              style={{ height, colorScheme: theme.scheme }}
            />
          ) : (
            <div aria-hidden style={{ height }} />
          )}
        </div>
      )}
    </div>
  );
}
