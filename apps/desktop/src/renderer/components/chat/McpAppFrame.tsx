import React, { useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { AppWindow, Globe, WarningCircle } from "@phosphor-icons/react";

import { sceneThemeSignature } from "../../../shared/chatScene";
import {
  MCP_APP_ERROR_METHOD_NOT_FOUND,
  MCP_APP_ERROR_REFUSED,
  MCP_APP_LIMITS,
  MCP_APP_PROTOCOL_VERSION,
  MCP_APP_SESSION_NOT_RUNNING,
  mcpAppItemIdFromCardId,
  mcpAppThemeContext,
  parseMcpAppFrameMessage,
  readMcpAppHeight,
  readMcpAppMessageText,
  readMcpAppOpenLinkUrl,
  type McpAppDocument,
  type McpAppFrameMessage,
  type McpAppGetResult,
  type McpAppRequestResult,
  type McpAppToolResult,
} from "../../../shared/mcpApp";
import type { AdeCardPayload } from "../../../shared/adeCard";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { isWebClientMode } from "../../lib/webClientMode";
import { COLORS } from "../lanes/laneDesignTokens";
import { Banner } from "../ui/notice";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { SceneReplyContext } from "./SceneFrame";
import {
  FRAME_OPEN_MIN_INTERVAL_MS,
  FRAME_REPLY_MIN_INTERVAL_MS,
  frameJustPressed,
  passFrameGate,
  postToOpaqueFrame,
  watchOutsidePresses,
} from "./sandboxedFrame";
import { knownSceneHeight, rememberSceneHeight } from "./sceneDocumentCache";
import { useSceneTheme } from "./sceneTheme";
import { useSceneOnScreen } from "./useSceneOnScreen";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { withChatPin } from "./chatMachinePin";
import { BRAND } from "../../../shared/brand";

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

/** Requests one frame may have with the brain at once; the brain has its own cap. */
const MAX_FORWARDED_REQUESTS = 8;
/**
 * A page that has not finished the handshake by now is not going to (its
 * policy blocked its own code, say). The row then folds to the tool's result.
 */
const INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_HEIGHT = 220;

/** True where this build can host an app at all: the desktop app. */
export function canHostMcpApps(): boolean {
  return typeof window !== "undefined"
    && !isWebClientMode()
    && isAdeAvailable(window.ade?.scene?.prepareApp)
    && isAdeAvailable(window.ade?.agentChat?.getMcpApp);
}

/*
 * Loaded apps and their prepared URLs, by chat and tool call. A row remounts
 * every time it scrolls back, and a page can be megabytes: it crosses IPC once.
 * Small on purpose, since each entry holds a whole page.
 */
const APP_CACHE_CAPACITY = 6;
const appCache = new Map<string, { app: McpAppDocument; url: string | null }>();

function rememberApp(key: string, entry: { app: McpAppDocument; url: string | null }): void {
  appCache.delete(key);
  appCache.set(key, entry);
  while (appCache.size > APP_CACHE_CAPACITY) {
    const oldest = appCache.keys().next();
    if (oldest.done) break;
    appCache.delete(oldest.value);
  }
}

/*
 * Apps whose page did not answer, by chat and tool call. A row that scrolls
 * back stays folded instead of drawing an empty frame for another ten
 * seconds; "Reload preview" takes it off this list.
 */
const STALLED_CAPACITY = 64;
const stalledApps = new Set<string>();

function rememberStalled(key: string | null): void {
  if (!key) return;
  stalledApps.delete(key);
  stalledApps.add(key);
  while (stalledApps.size > STALLED_CAPACITY) {
    const oldest = stalledApps.values().next();
    if (oldest.done) break;
    stalledApps.delete(oldest.value);
  }
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; app: McpAppDocument; url: string }
  | { status: "unavailable"; reason: string };

type RuntimePin = ReturnType<typeof useChatRuntimeScope>["pin"];

/**
 * One app's page and the URL its frame loads: read from the brain and prepared
 * in the main process once `wanted`, then kept (`appCache`) across remounts.
 * `reload` drops the kept copy and reads it again.
 */
function useMcpAppDocument(
  sessionId: string | null | undefined,
  itemId: string | null,
  pin: RuntimePin,
  wanted: boolean,
): { load: LoadState; reload: () => void } {
  const cacheKey = sessionId && itemId ? `${sessionId}:${itemId}` : null;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!cacheKey || !sessionId || !itemId || !wanted) return;
    let cancelled = false;
    const cached = appCache.get(cacheKey);
    const prepare = async (app: McpAppDocument): Promise<string> => {
      const url = await window.ade.scene?.prepareApp({ html: app.html, csp: app.csp });
      if (typeof url !== "string" || !url.length) throw new Error(`${BRAND.NAME} could not prepare this app.`);
      return url;
    };
    setLoad({ status: "loading" });
    void (async () => {
      try {
        let app = cached?.app ?? null;
        let url = cached?.url ?? null;
        if (!app) {
          const result: McpAppGetResult = await withChatPin(pin, (chatPin) => window.ade.agentChat.getMcpApp({ sessionId, itemId }, chatPin));
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
  const reload = useCallback(() => {
    if (cacheKey) appCache.delete(cacheKey);
    setAttempt((value) => value + 1);
  }, [cacheKey]);
  return { load, reload };
}

/**
 * The tools the user always allows for this app's server, so they can be taken
 * back on the row. Read when the app loads; `refresh` reads them again.
 */
function useMcpAppGrants(
  appRef: MutableRefObject<McpAppDocument | null>,
  pin: RuntimePin,
  appLoaded: boolean,
): { alwaysAllowed: string[]; refresh: () => void; stopAllowing: (tool: string) => void } {
  const [alwaysAllowed, setAlwaysAllowed] = useState<string[]>([]);
  const refresh = useCallback(() => {
    const current = appRef.current;
    const list = window.ade?.agentChat?.listMcpAppGrants;
    if (!current || !isAdeAvailable(list)) return;
    void withChatPin(pin, (chatPin) => list({ sessionId: current.sessionId, itemId: current.itemId }, chatPin))
      .then((result) => setAlwaysAllowed(Array.isArray(result?.tools) ? result.tools : []))
      .catch(() => { /* the row keeps what it last knew */ });
  }, [appRef, pin]);
  useEffect(() => { if (appLoaded) refresh(); }, [appLoaded, refresh]);
  const stopAllowing = useCallback((tool: string) => {
    const current = appRef.current;
    if (!current) return;
    void withChatPin(pin, (chatPin) => window.ade.agentChat
      .revokeMcpAppGrant({ sessionId: current.sessionId, itemId: current.itemId, tool }, chatPin))
      .then((result) => setAlwaysAllowed(Array.isArray(result?.tools) ? result.tools : []))
      .catch(() => { /* still allowed; the row still says so */ });
  }, [appRef, pin]);
  return { alwaysAllowed, refresh, stopAllowing };
}

/** What answering one request from an app's frame needs from the row that hosts it. */
type AppRequestContext = {
  app: McpAppDocument;
  frame: HTMLIFrameElement | null;
  pin: RuntimePin;
  post: (message: Record<string, unknown>) => void;
  hostContext: () => Record<string, unknown>;
  /** How a draft reaches the prompt box, or null in a view with none. */
  replyToComposer: ((text: string, sourceKey: string) => void) | null;
  replySourceKey: string;
  lastOpenRef: { current: number };
  lastMessageRef: { current: number };
  forward: (id: string | number, method: "tools/call" | "resources/read", params: Record<string, unknown>) => void;
};

/** Answer one JSON-RPC request from an app's frame. Every branch posts exactly one answer, or forwards. */
function answerAppRequest(message: Extract<McpAppFrameMessage, { kind: "request" }>, ctx: AppRequestContext): void {
  const { id, method, params } = message;
  const { post } = ctx;
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
            sandbox: { csp: ctx.app.csp },
          },
          hostContext: ctx.hostContext(),
        },
      });
      return;
    case "ping":
      post({ id, result: {} });
      return;
    case "ui/open-link": {
      const url = readMcpAppOpenLinkUrl(params);
      if (!url) { refuse("An app can open web pages (http or https) only."); return; }
      if (!passFrameGate(ctx.frame, ctx.lastOpenRef, FRAME_OPEN_MIN_INTERVAL_MS)) {
        refuse("An app opens a link only in answer to a click or a key press.");
        return;
      }
      openUrlInAdeBrowser(url, { runtimePin: ctx.pin });
      post({ id, result: {} });
      return;
    }
    case "ui/message": {
      const text = readMcpAppMessageText(params);
      if (!text) { refuse("A message needs text, as the user."); return; }
      if (!ctx.replyToComposer) { refuse("This view has no prompt box to put a message in."); return; }
      if (!passFrameGate(ctx.frame, ctx.lastMessageRef, FRAME_REPLY_MIN_INTERVAL_MS)) {
        refuse("An app adds a message only in answer to a click or a key press.");
        return;
      }
      // A draft in the prompt box. Nothing is sent: the reader sends it.
      ctx.replyToComposer(text, ctx.replySourceKey);
      post({ id, result: {} });
      return;
    }
    case "ui/request-display-mode":
      post({ id, result: { mode: "inline" } });
      return;
    case "tools/call":
    case "resources/read":
      ctx.forward(id, method, params);
      return;
    default:
      refuse(`${BRAND.NAME} does not support this request from an app.`, MCP_APP_ERROR_METHOD_NOT_FOUND);
  }
}

/** Longest result text the folded row shows; the full result is in the tool call row. */
const FALLBACK_TEXT_CHARS = 1_500;
const FALLBACK_MAX_LINKS = 4;

/** A URL as prose ends it: drop trailing punctuation and a `)` that closes nothing in the URL. */
function trimProseUrl(value: string): string {
  let url = value.replace(/[.,;:!?]+$/, "");
  while (url.endsWith(")") && url.split("(").length < url.split(")").length) url = url.slice(0, -1);
  return url;
}

/** Every string inside a JSON value, depth-first, bounded. */
function jsonStrings(value: unknown, out: string[], depth = 0): void {
  if (out.length >= 200 || depth > 8) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) jsonStrings(entry, out, depth + 1);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) jsonStrings(entry, out, depth + 1);
}

/**
 * What the folded row shows of a tool's stored result: its text (JSON laid
 * out), cut short, and the first few web links in it. A JSON result's links
 * are its whole string values; free text is split on white space and quotes.
 */
function mcpAppResultPreview(result: McpAppToolResult | null): { text: string; links: string[] } {
  if (!result) return { text: "", links: [] };
  const parts: string[] = [];
  const links = new Set<string>();
  const addLink = (value: unknown) => {
    if (links.size >= FALLBACK_MAX_LINKS || typeof value !== "string") return;
    const url = readMcpAppOpenLinkUrl({ url: value });
    if (url) links.add(url);
  };
  for (const block of result.content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    else if (record.type === "resource_link") addLink(record.uri);
  }
  let text = parts.join("\n").trim();
  let parsed: unknown;
  if (text.length <= 20_000 && /^[[{]/.test(text)) {
    try { parsed = JSON.parse(text); } catch { /* not JSON: shown as it came */ }
  } else if (!text && result.structuredContent !== undefined) {
    // A result that is only structured data is shown as that data.
    parsed = result.structuredContent;
  }
  if (parsed !== undefined) {
    const strings: string[] = [];
    jsonStrings(parsed, strings);
    for (const value of strings) if (/^https?:\/\/\S+$/.test(value)) addLink(value);
    text = JSON.stringify(parsed, null, 2);
  } else {
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>`]+/g)) addLink(trimProseUrl(match[0]));
  }
  if (text.length > FALLBACK_TEXT_CHARS) text = `${text.slice(0, FALLBACK_TEXT_CHARS)}\n…`;
  return { text, links: [...links] };
}

/**
 * The row an app folds to when its page did not answer: it says the preview
 * did not load (the tool itself ran; this is never a tool failure), shows the
 * tool's result, and offers "Reload preview", which loads the page again and
 * never runs the tool.
 */
function McpAppResultFallback({ app, server, pin, onReload }: {
  app: McpAppDocument;
  server: string;
  pin: RuntimePin;
  onReload: () => void;
}) {
  const { text, links } = useMemo(() => mcpAppResultPreview(app.toolResult), [app.toolResult]);
  const extra = text || links.length ? (
    <>
      {text ? (
        <pre
          className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-snug"
          style={{ color: COLORS.textSecondary }}
        >
          {text}
        </pre>
      ) : null}
      {links.length ? (
        <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          {links.map((url) => (
            <button
              key={url}
              type="button"
              className="min-w-0 max-w-full truncate underline"
              style={{ color: COLORS.accent }}
              title={url}
              onClick={() => openUrlInAdeBrowser(url, { runtimePin: pin })}
            >
              {url.replace(/^https?:\/\//, "")}
            </button>
          ))}
        </div>
      ) : null}
    </>
  ) : undefined;
  return (
    <Banner
      layout="inline"
      testId="chat-mcp-app-stalled"
      model={{
        id: `mcp-app-stalled-${app.sessionId}:${app.itemId}`,
        tone: "warning",
        title: `Preview from ${server} did not load`,
        detail: app.toolResult?.isError ? "The tool call returned an error." : "The tool call finished.",
        extra,
        actions: [{
          label: "Reload preview",
          variant: "secondary",
          title: "Load the preview page again. The tool is not run again.",
          onClick: onReload,
        }],
      }}
    />
  );
}

export function McpAppCard({ card }: { card: AdeCardPayload }) {
  const itemId = mcpAppItemIdFromCardId(card.cardId);
  const { sessionId, pin } = useChatRuntimeScope();
  const cacheKey = sessionId && itemId ? `${sessionId}:${itemId}` : null;
  /** Where this app's last height is kept, apart from any scene's. */
  const heightKey = cacheKey ? `mcp-app:${cacheKey}` : null;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(() => knownSceneHeight(heightKey) ?? DEFAULT_HEIGHT);
  /** The page never finished the handshake. Latched until it does, or until "Reload preview". */
  const [stalled, setStalled] = useState(() => (cacheKey ? stalledApps.has(cacheKey) : false));
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
  const { load, reload } = useMcpAppDocument(sessionId, itemId, pin, wanted);

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
    postToOpaqueFrame(frameRef.current, { jsonrpc: "2.0", ...message });
  }, []);

  // A link, a draft and a tool that may change data all need a click or a key
  // press inside this frame. Same rule as a scene: `frameJustPressed`.
  useEffect(() => watchOutsidePresses(), []);

  const { alwaysAllowed, refresh: refreshGrants, stopAllowing } = useMcpAppGrants(appRef, pin, app !== null);

  const replyToComposer = useContext(SceneReplyContext);
  const lastOpenRef = useRef(0);
  const lastMessageRef = useRef(0);

  const hostContext = useCallback((): Record<string, unknown> => {
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
    const userActivated = method === "tools/call" && frameJustPressed(frameRef.current);
    void withChatPin(pin, (chatPin) => window.ade.agentChat
      .mcpAppRequest({ sessionId: current.sessionId, itemId: current.itemId, method, params, userActivated }, chatPin))
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
  }, [pin, post, refreshGrants]);

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
          // A page that answers late unfolds.
          if (cacheKey) stalledApps.delete(cacheKey);
          setStalled(false);
          // The spec's order: the input, then the result.
          post({ method: "ui/notifications/tool-input", params: { arguments: current.toolInput } });
          if (current.toolResult) post({ method: "ui/notifications/tool-result", params: current.toolResult });
          return;
        }
        if (message.method === "ui/notifications/size-changed") {
          const next = readMcpAppHeight(message.params);
          if (next === null) return;
          setHeight(next);
          rememberSceneHeight(heightKey, next);
        }
        // Log lines and anything else an app announces are dropped.
        return;
      }

      answerAppRequest(message, {
        app: current,
        frame: frameRef.current,
        pin,
        post,
        hostContext,
        replyToComposer,
        replySourceKey: `app:${cacheKey}`,
        lastOpenRef,
        lastMessageRef,
        forward,
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src, cacheKey, heightKey, pin, post, replyToComposer, hostContext, forward]);

  // Before the frame comes down, tell the page. Best effort: nothing waits on it.
  useEffect(() => {
    if (!src) return;
    const frame = frameRef.current;
    return () => {
      postToOpaqueFrame(frame, {
        jsonrpc: "2.0",
        id: `ade-teardown-${Date.now()}`,
        method: "ui/resource-teardown",
        params: { reason: "The app scrolled out of view." },
      });
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

  // A page that never finishes the handshake: fold to the tool's result
  // instead of leaving an empty frame. The frame stays mounted, out of sight,
  // so a page that answers late still unfolds.
  useEffect(() => {
    if (!src || initialized || stalled) return;
    const timer = window.setTimeout(() => {
      rememberStalled(cacheKey);
      setStalled(true);
    }, INITIALIZE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src, initialized, stalled, cacheKey]);

  // Loads the page again: reads the stored app and mounts a fresh frame. It
  // never runs the tool again. The tool already ran (it may have cost money),
  // and its result is stored with the app.
  const reloadPreview = useCallback(() => {
    if (cacheKey) stalledApps.delete(cacheKey);
    setStalled(false);
    reload();
  }, [cacheKey, reload]);

  const network = useMemo(() => {
    if (!app) return [];
    return [...new Set([...app.csp.connectDomains, ...app.csp.resourceDomains])].map((origin) => origin.replace(/^[a-z]+:\/\//, ""));
  }, [app]);

  const title = card.title?.trim() || "App";
  const server = card.subtitle?.trim() || app?.server || "an MCP server";

  return (
    <div ref={wrapperRef} className="my-3 w-screen max-w-full" data-testid="chat-mcp-app" data-mcp-app-status={stalled ? "stalled" : src ? (initialized ? "running" : "loading") : load.status}>
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
      </div>
      {load.status === "unavailable" ? (
        load.reason === MCP_APP_SESSION_NOT_RUNNING ? (
          // Not a failure: the chat has stopped, and trying again changes nothing.
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.textMuted }} data-testid="chat-mcp-app-unavailable">
            <WarningCircle size={11} weight="bold" />
            {load.reason}
          </div>
        ) : (
          <div data-testid="chat-mcp-app-unavailable">
            <Banner
              layout="inline"
              model={{
                id: `mcp-app-unavailable-${cacheKey ?? "anon"}`,
                tone: "warning",
                title: `${title} could not be shown`,
                detail: load.reason,
                actions: [{ label: "Reload preview", onClick: reloadPreview }],
              }}
            />
          </div>
        )
      ) : (
        <>
          {/* Folded: the stored app (and with it the result) may still be on its way in. */}
          {stalled && app ? <McpAppResultFallback app={app} server={server} pin={pin} onReload={reloadPreview} /> : null}
          <div
            className="relative min-w-0 overflow-hidden rounded-md"
            style={{ border: `1px solid ${COLORS.borderMuted}`, background: theme.bg, display: stalled ? "none" : undefined }}
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
        </>
      )}
    </div>
  );
}
