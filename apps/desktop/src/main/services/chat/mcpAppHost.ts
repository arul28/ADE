import {
  claudeMcpToolName,
  isMcpAppResourceUri,
  MCP_APP_CARD_VARIANT,
  MCP_APP_ERROR_INVALID_PARAMS,
  MCP_APP_ERROR_METHOD_NOT_FOUND,
  MCP_APP_LIMITS,
  MCP_APP_NEEDS_CLICK,
  MCP_APP_RESOURCE_MIME_TYPE,
  MCP_APP_SESSION_NOT_RUNNING,
  MCP_APP_TOOL_CALL_METADATA_KEY,
  mcpAppCardId,
  mcpAppMayCallTool,
  mcpAppRefusal,
  sanitizeMcpAppCsp,
  toMcpAppToolResult,
  type McpAppDocument,
  type McpAppGetArgs,
  type McpAppGetResult,
  type McpAppGrantsArgs,
  type McpAppGrantsResult,
  type McpAppRequestArgs,
  type McpAppRevokeGrantArgs,
  type McpAppRequestResult,
  type McpAppToolDescriptor,
  type McpAppToolResult,
} from "../../../shared/mcpApp";
import type { AdeCardPayload } from "../../../shared/adeCard";
import type { AgentChatEvent } from "../../../shared/types";
import type { McpAppGrantStore } from "./mcpAppGrants";
import type { McpAppStore } from "./mcpAppStore";

/**
 * The brain's half of MCP Apps: notice a tool call that has an app, read the
 * app's page through the chat's own provider session, keep it with the chat,
 * and route what the app later asks for.
 *
 * Three rules hold everywhere in this file:
 *
 * 1. **The live session or nothing.** Every read and every call goes through
 *    `linkFor(sessionId)`, which answers only for a chat whose provider
 *    session is up right now. Nothing here starts, resumes or wakes one. An
 *    app in a chat that has ended still shows (its page is on disk) and its
 *    calls are answered {@link MCP_APP_SESSION_NOT_RUNNING}.
 * 2. **The app never names a server.** A request carries the chat and the tool
 *    call the app came from. The server is read from the record this file
 *    stored when it fetched the page, so an app can reach the server it came
 *    from and no other.
 * 3. **A call that may change something needs the user.** Only a tool the
 *    server itself marks read-only runs unasked; no annotations means not
 *    read-only. Any other tool runs only when the client hosting the frame saw
 *    a real click or key press in it just before, and the first time an app
 *    calls it the user is asked in the chat's own card: once, always (for
 *    this tool of this server, in this project), or no. A tool the server hid
 *    from apps is refused before any of that.
 */

/** A chat's live provider session, as far as MCP Apps need it. */
export type McpAppProviderLink = {
  provider: "claude" | "codex";
  /** Every tool of every connected MCP server of this session. */
  listTools(): Promise<McpAppToolDescriptor[]>;
  /** `resources/read` on one server. Resolves the raw result (`{ contents }`). */
  readResource(server: string, uri: string): Promise<unknown>;
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<McpAppToolResult>;
};

export type McpAppHostDeps = {
  store: McpAppStore;
  /** The chat's live provider session, or null. Must never start one. */
  linkFor(sessionId: string): McpAppProviderLink | null;
  emitCard(sessionId: string, card: AdeCardPayload): void;
  /** The chat's native pending-input card. Rejects when the chat cannot show one. */
  requestChatInput(input: {
    chatSessionId: string;
    title: string;
    body: string;
    timeoutMs?: number;
    questions: Array<{
      id: string;
      header: string;
      question: string;
      options: Array<{ label: string; value: string; description?: string; recommended?: boolean }>;
      allowsFreeform: boolean;
    }>;
    providerMetadata: Record<string, unknown>;
    eventDescription: string;
    eventDetail: Record<string, unknown>;
  }): Promise<{ decision: string; answers: Record<string, string[]> }>;
  /** The project's "always allow" answers. */
  grants: McpAppGrantStore;
  log(level: "info" | "warn", event: string, detail: Record<string, unknown>): void;
  now?: () => number;
};

type ToolEvent = Extract<AgentChatEvent, { type: "tool_call" | "tool_result" }>;

type OpenCall = {
  provider: "claude" | "codex";
  /** Codex names the server, the tool and the page on the call itself. */
  server?: string;
  tool?: string;
  resourceUri?: string;
  /** Claude names only `mcp__<server>__<tool>`; the catalog resolves the rest. */
  claudeToolName?: string;
  args: Record<string, unknown>;
  turnId: string | null;
};

type SessionState = {
  openCalls: Map<string, OpenCall>;
  /** Tool calls whose page is being read right now, by item id. */
  capturing: Map<string, Promise<void>>;
  catalog: { tools: McpAppToolDescriptor[]; at: number } | null;
  catalogPending: Promise<McpAppToolDescriptor[]> | null;
  /** Calls in flight per app, by item id. */
  inFlight: Map<string, number>;
  /** Apps with an approval card up, by item id. */
  asking: Set<string>;
};

const MAX_OPEN_CALLS = 64;
/**
 * How long a session's tool list is trusted before it is read again.
 *
 * Minutes, not seconds, because the read is not free: Codex starts a second
 * copy of every MCP server to answer it. What rides on the list is the
 * server's OWN claims about a tool (read-only, hidden from apps), so a stale
 * list lets an app do nothing the server did not say itself a moment ago.
 */
const CATALOG_MAX_AGE_MS = 5 * 60_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** The arguments as the approval card shows them: real JSON, cut to a readable length. */
function previewArguments(args: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    text = "{}";
  }
  if (text === "{}") return "no arguments";
  return text.length > 1_200 ? `${text.slice(0, 1_200)}\n… (${text.length - 1_200} more characters)` : text;
}

/** A provider error as a refusal. "Not running" stays the one plain sentence it is. */
function failure(error: unknown, what: string): McpAppRequestResult {
  const text = errorText(error);
  return mcpAppRefusal(text === MCP_APP_SESSION_NOT_RUNNING ? text : `${what}: ${text}`);
}

export type McpAppHost = ReturnType<typeof createMcpAppHost>;

export function createMcpAppHost(deps: McpAppHostDeps) {
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, SessionState>();

  const stateFor = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { openCalls: new Map(), capturing: new Map(), catalog: null, catalogPending: null, inFlight: new Map(), asking: new Set() };
      sessions.set(sessionId, state);
    }
    return state;
  };

  /** The session's tools, read again when older than `maxAgeMs`. One read at a time. */
  const catalog = async (sessionId: string, link: McpAppProviderLink, maxAgeMs: number): Promise<McpAppToolDescriptor[]> => {
    const state = stateFor(sessionId);
    if (state.catalog && now() - state.catalog.at <= maxAgeMs) return state.catalog.tools;
    if (state.catalogPending) return state.catalogPending;
    const pending = link.listTools()
      .then((tools) => {
        state.catalog = { tools, at: now() };
        return tools;
      })
      .finally(() => {
        if (state.catalogPending === pending) state.catalogPending = null;
      });
    state.catalogPending = pending;
    return pending;
  };

  const capture = async (sessionId: string, itemId: string, call: OpenCall, rawResult: unknown): Promise<void> => {
    if (deps.store.readRecord(sessionId, itemId)) return;
    const link = deps.linkFor(sessionId);
    if (!link) return;
    const state = stateFor(sessionId);
    const lookUp = (tools: readonly McpAppToolDescriptor[]) => call.claudeToolName
      ? tools.find((tool) => claudeMcpToolName(tool.server, tool.name) === call.claudeToolName)
      : tools.find((tool) => tool.server === call.server && tool.name === call.tool);
    let descriptor = lookUp(state.catalog?.tools ?? []);
    // Claude names only the tool, so the list has to say whether it has a page
    // and on which server: read it when the list in hand does not know the
    // tool. Codex said both on the call itself, so its list is never read here.
    if (!descriptor && call.claudeToolName) {
      descriptor = lookUp(await catalog(sessionId, link, 0).catch((error) => {
        deps.log("warn", "agent_chat.mcp_app_catalog_failed", { sessionId, error: errorText(error) });
        return [] as McpAppToolDescriptor[];
      }));
    }
    const server = call.server ?? descriptor?.server;
    const toolName = call.tool ?? descriptor?.name;
    const resourceUri = call.resourceUri ?? descriptor?.ui.resourceUri ?? null;
    // An ordinary tool: no page declared, nothing to show.
    if (!server || !toolName || !isMcpAppResourceUri(resourceUri)) return;

    let read: unknown;
    try {
      read = await link.readResource(server, resourceUri);
    } catch (error) {
      deps.log("warn", "agent_chat.mcp_app_read_failed", { sessionId, server, resourceUri, error: errorText(error) });
      return;
    }
    const contents = Array.isArray(asRecord(read)?.contents) ? asRecord(read)!.contents as unknown[] : [];
    const page = contents.map(asRecord).find((entry) => entry?.uri === resourceUri) ?? asRecord(contents[0]);
    const mimeType = typeof page?.mimeType === "string" ? page.mimeType.replace(/\s+/g, "").toLowerCase() : "";
    if (!page || mimeType !== MCP_APP_RESOURCE_MIME_TYPE) {
      deps.log("warn", "agent_chat.mcp_app_not_html", { sessionId, server, resourceUri, mimeType });
      return;
    }
    let html = "";
    if (typeof page.text === "string") html = page.text;
    else if (typeof page.blob === "string") html = Buffer.from(page.blob, "base64").toString("utf8");
    if (!html.trim().length || Buffer.byteLength(html, "utf8") > MCP_APP_LIMITS.maxDocumentBytes) {
      deps.log("warn", "agent_chat.mcp_app_document_rejected", { sessionId, server, resourceUri, bytes: Buffer.byteLength(html, "utf8") });
      return;
    }
    const ui = asRecord(asRecord(page._meta)?.ui);
    const csp = sanitizeMcpAppCsp(ui?.csp);
    const toolResult = toMcpAppToolResult(rawResult);
    const app: McpAppDocument = {
      sessionId,
      itemId,
      provider: link.provider,
      server,
      tool: toolName,
      toolTitle: descriptor?.title ?? null,
      toolDescription: descriptor?.description ?? null,
      toolInputSchema: descriptor?.inputSchema ?? { type: "object" },
      resourceUri,
      html,
      csp,
      prefersBorder: typeof ui?.prefersBorder === "boolean" ? ui.prefersBorder : null,
      toolInput: jsonBytes(call.args) <= MCP_APP_LIMITS.maxPayloadBytes ? call.args : {},
      toolResult: jsonBytes(toolResult) <= MCP_APP_LIMITS.maxPayloadBytes ? toolResult : null,
      createdAt: new Date(now()).toISOString(),
    };
    if (!deps.store.write(app)) {
      deps.log("warn", "agent_chat.mcp_app_not_stored", { sessionId, server, resourceUri });
      return;
    }
    // The audit trail the spec asks for: which page, from which server, with which network.
    deps.log("info", "agent_chat.mcp_app_captured", {
      sessionId,
      provider: link.provider,
      server,
      tool: toolName,
      resourceUri,
      bytes: Buffer.byteLength(html, "utf8"),
      connectDomains: csp.connectDomains,
      resourceDomains: csp.resourceDomains,
    });
    const title = descriptor?.title?.trim() || toolName;
    deps.emitCard(sessionId, {
      cardId: mcpAppCardId(itemId),
      variant: MCP_APP_CARD_VARIANT,
      state: "terminal",
      title,
      subtitle: server,
      // What a surface that cannot run an app shows instead.
      fallbackText: `${server} showed an app for ${title}. Apps from MCP servers run in ADE on desktop, in Claude and Codex chats.`,
      ...(call.turnId ? { turnId: call.turnId } : {}),
    });
  };

  /**
   * Watch a chat's tool events for a call that has an app.
   *
   * Cheap and synchronous for every event that is not an MCP tool call: this
   * sits on the chat's event path. The read itself runs after, on its own.
   */
  const observe = (sessionId: string, provider: string | null | undefined, event: AgentChatEvent): void => {
    if (event.type !== "tool_call" && event.type !== "tool_result") return;
    if (provider !== "claude" && provider !== "codex") return;
    const toolEvent = event as ToolEvent;
    // A subagent's own tool calls draw in its transcript, not this one.
    if (toolEvent.parentItemId || !toolEvent.itemId) return;
    const isCodexApp = provider === "codex" && isMcpAppResourceUri(toolEvent.mcp?.resourceUri);
    const isClaudeMcp = provider === "claude" && toolEvent.tool.startsWith("mcp__");
    if (!isCodexApp && !isClaudeMcp) return;
    const state = stateFor(sessionId);

    if (toolEvent.type === "tool_call") {
      const args = asRecord(toolEvent.args) ?? {};
      state.openCalls.delete(toolEvent.itemId);
      state.openCalls.set(toolEvent.itemId, isCodexApp
        ? { provider: "codex", server: toolEvent.mcp!.server, tool: toolEvent.mcp!.tool, resourceUri: toolEvent.mcp!.resourceUri, args, turnId: toolEvent.turnId ?? null }
        : { provider: "claude", claudeToolName: toolEvent.tool, args, turnId: toolEvent.turnId ?? null });
      while (state.openCalls.size > MAX_OPEN_CALLS) {
        const oldest = state.openCalls.keys().next();
        if (oldest.done) break;
        state.openCalls.delete(oldest.value);
      }
      return;
    }

    const call = state.openCalls.get(toolEvent.itemId);
    state.openCalls.delete(toolEvent.itemId);
    if (!call || toolEvent.status !== "completed" || state.capturing.has(toolEvent.itemId)) return;
    const itemId = toolEvent.itemId;
    // Claude keeps the MCP result's structured half beside the flattened text.
    const rawResult = (toolEvent as { structured?: unknown }).structured ?? toolEvent.result;
    const run = capture(sessionId, itemId, call, rawResult)
      .catch((error) => deps.log("warn", "agent_chat.mcp_app_capture_failed", { sessionId, error: errorText(error) }))
      .finally(() => { state.capturing.delete(itemId); });
    state.capturing.set(itemId, run);
  };

  const get = async (args: McpAppGetArgs): Promise<McpAppGetResult> => {
    const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    const itemId = typeof args?.itemId === "string" ? args.itemId.trim() : "";
    if (!sessionId || !itemId) return { status: "unavailable", reason: "This app has no chat to load from." };
    await sessions.get(sessionId)?.capturing.get(itemId);
    const app = deps.store.read(sessionId, itemId);
    if (app) return { status: "ready", app };
    return { status: "unavailable", reason: "This app was not saved with the chat, so it cannot be shown again." };
  };

  /**
   * Ask the user, in the chat, whether an app may run one tool. The call runs
   * only on one of the two allow buttons; anything else is a no.
   */
  const askAllow = async (app: Omit<McpAppDocument, "html">, tool: McpAppToolDescriptor, args: Record<string, unknown>): Promise<"allow" | "always" | "deny" | "unasked"> => {
    const what = `The ${app.server} app wants to run ${tool.name}`;
    const metadata = {
      [MCP_APP_TOOL_CALL_METADATA_KEY]: true,
      server: app.server,
      tool: tool.name,
      appItemId: app.itemId,
    };
    try {
      const response = await deps.requestChatInput({
        chatSessionId: app.sessionId,
        title: "App wants to run a tool",
        body: `${what}.`,
        timeoutMs: MCP_APP_LIMITS.approvalTimeoutMs,
        questions: [{
          id: "mcp_app_tool_call",
          header: "App tool call",
          question: `${what}. The server does not mark this tool as read-only, so it may change something.\n\nArguments:\n${previewArguments(args)}`,
          options: [
            { label: "Allow once", value: "allow", description: `Run ${tool.name} on ${app.server} once, with these arguments.` },
            {
              label: "Always allow",
              value: "always",
              description: `Run it, and stop asking when an app from ${app.server} calls ${tool.name} in this project. Each call still needs your click in the app.`,
            },
            { label: "Don't allow", value: "deny" },
          ],
          allowsFreeform: false,
        }],
        providerMetadata: metadata,
        eventDescription: `${what}.`,
        eventDetail: metadata,
      });
      if (response.decision === "decline" || response.decision === "cancel") return "deny";
      const picked = (response.answers?.mcp_app_tool_call ?? []).map((value) => value.trim().toLowerCase());
      // Exactly one answer, and it has to be one of the two allow buttons.
      if (picked.length !== 1) return "deny";
      return picked[0] === "allow" ? "allow" : picked[0] === "always" ? "always" : "deny";
    } catch (error) {
      deps.log("warn", "agent_chat.mcp_app_approval_unasked", { sessionId: app.sessionId, error: errorText(error) });
      return "unasked";
    }
  };

  const callTool = async (
    app: Omit<McpAppDocument, "html">,
    link: McpAppProviderLink,
    params: Record<string, unknown>,
    userActivated: boolean,
  ): Promise<McpAppRequestResult> => {
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name.length || name.length > 200) return mcpAppRefusal("A tool call needs the tool's name.", MCP_APP_ERROR_INVALID_PARAMS);
    const args = params.arguments === undefined || params.arguments === null ? {} : asRecord(params.arguments);
    if (!args) return mcpAppRefusal("A tool call's arguments must be an object.", MCP_APP_ERROR_INVALID_PARAMS);
    if (jsonBytes(args) > MCP_APP_LIMITS.maxCallArgumentBytes) return mcpAppRefusal("These arguments are too large.", MCP_APP_ERROR_INVALID_PARAMS);

    let tools: McpAppToolDescriptor[];
    try {
      tools = await catalog(app.sessionId, link, CATALOG_MAX_AGE_MS);
    } catch (error) {
      return failure(error, `ADE could not read the tools of ${app.server}`);
    }
    // The server comes from the stored record, so this is the app's own server or nothing.
    const tool = tools.find((entry) => entry.server === app.server && entry.name === name);
    if (!tool) return mcpAppRefusal(`${app.server} has no tool named ${name}.`);
    if (!mcpAppMayCallTool(tool)) return mcpAppRefusal(`${name} is not open to apps.`);

    const state = stateFor(app.sessionId);
    const inFlight = state.inFlight.get(app.itemId) ?? 0;
    if (inFlight >= MCP_APP_LIMITS.maxConcurrentCalls) return mcpAppRefusal("This app has too many calls running. Try again when one finishes.");
    state.inFlight.set(app.itemId, inFlight + 1);
    try {
      if (!tool.readOnly) {
        // The click comes first: no card is raised for a call nobody made.
        if (!userActivated) return mcpAppRefusal(MCP_APP_NEEDS_CLICK);
        const fingerprint = tool.serverFingerprint ?? null;
        if (!deps.grants.has(app.server, name, fingerprint)) {
          if (state.asking.has(app.itemId)) return mcpAppRefusal("Another call from this app is waiting for your answer.");
          state.asking.add(app.itemId);
          let outcome: "allow" | "always" | "deny" | "unasked";
          try {
            outcome = await askAllow(app, tool, args);
          } finally {
            state.asking.delete(app.itemId);
          }
          deps.log("info", "agent_chat.mcp_app_tool_call_decided", { sessionId: app.sessionId, server: app.server, tool: name, outcome });
          if (outcome === "unasked") return mcpAppRefusal("ADE could not ask you about this call, so it did not run.");
          if (outcome === "deny") return mcpAppRefusal("You did not allow this call.");
          if (outcome === "always") deps.grants.add(app.server, name, fingerprint);
          // The answer can take minutes. The session that was live then may be gone now.
          const linkNow = deps.linkFor(app.sessionId);
          if (!linkNow) return mcpAppRefusal(MCP_APP_SESSION_NOT_RUNNING);
          link = linkNow;
        }
      }
      deps.log("info", "agent_chat.mcp_app_tool_call", { sessionId: app.sessionId, server: app.server, tool: name, readOnly: tool.readOnly });
      const result = await link.callTool(app.server, name, args);
      if (jsonBytes(result) > MCP_APP_LIMITS.maxCallResultBytes) return mcpAppRefusal("The result is too large to hand to the app.");
      return { ok: true, result };
    } catch (error) {
      return failure(error, `${name} failed`);
    } finally {
      const left = (state.inFlight.get(app.itemId) ?? 1) - 1;
      if (left > 0) state.inFlight.set(app.itemId, left);
      else state.inFlight.delete(app.itemId);
    }
  };

  const readResource = async (
    app: Omit<McpAppDocument, "html">,
    link: McpAppProviderLink,
    params: Record<string, unknown>,
  ): Promise<McpAppRequestResult> => {
    const uri = typeof params.uri === "string" ? params.uri.trim() : "";
    if (!uri.length || uri.length > 2_048) return mcpAppRefusal("A resource read needs a URI.", MCP_APP_ERROR_INVALID_PARAMS);
    try {
      const result = await link.readResource(app.server, uri);
      if (jsonBytes(result) > MCP_APP_LIMITS.maxCallResultBytes) return mcpAppRefusal("The resource is too large to hand to the app.");
      return { ok: true, result };
    } catch (error) {
      return failure(error, `Reading ${uri} failed`);
    }
  };

  /** One request from an app's frame, for the server the app came from. */
  const request = async (args: McpAppRequestArgs): Promise<McpAppRequestResult> => {
    const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    const itemId = typeof args?.itemId === "string" ? args.itemId.trim() : "";
    const app = sessionId && itemId ? deps.store.readRecord(sessionId, itemId) : null;
    if (!app) return mcpAppRefusal("ADE does not know this app.");
    const params = asRecord(args.params) ?? {};
    if (args.method !== "tools/call" && args.method !== "resources/read") {
      return mcpAppRefusal("ADE does not pass this request on to the server.", MCP_APP_ERROR_METHOD_NOT_FOUND);
    }
    const link = deps.linkFor(sessionId);
    if (!link) return mcpAppRefusal(MCP_APP_SESSION_NOT_RUNNING);
    return args.method === "tools/call"
      ? callTool(app, link, params, args.userActivated === true)
      : readResource(app, link, params);
  };

  /** The tools the user always allows for the server this app came from. */
  const grants = (args: McpAppGrantsArgs): McpAppGrantsResult => {
    const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    const itemId = typeof args?.itemId === "string" ? args.itemId.trim() : "";
    const app = sessionId && itemId ? deps.store.readRecord(sessionId, itemId) : null;
    if (!app) return { server: null, tools: [] };
    // When this chat's session has said how the server is defined, only the
    // grants for that definition count: a grant made for another server of
    // the same name does not apply here, so the row must not claim it.
    const known = sessions.get(sessionId)?.catalog?.tools.find((tool) => tool.server === app.server);
    const all = deps.grants.list(app.server);
    const applying = known ? all.filter((grant) => grant.fingerprint === (known.serverFingerprint ?? null)) : all;
    return { server: app.server, tools: [...new Set(applying.map((grant) => grant.tool))] };
  };

  /** Take one "always allow" back. The server is the app's own, as everywhere here. */
  const revokeGrant = (args: McpAppRevokeGrantArgs): McpAppGrantsResult => {
    const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    const itemId = typeof args?.itemId === "string" ? args.itemId.trim() : "";
    const tool = typeof args?.tool === "string" ? args.tool.trim() : "";
    const app = sessionId && itemId ? deps.store.readRecord(sessionId, itemId) : null;
    if (app && tool && deps.grants.remove(app.server, tool)) {
      deps.log("info", "agent_chat.mcp_app_grant_removed", { sessionId, server: app.server, tool });
    }
    return grants({ sessionId, itemId });
  };

  return {
    observe,
    get,
    request,
    grants,
    revokeGrant,
    /** Drop the stored apps of chats that are gone. See `McpAppStore.sweepOrphans`. */
    sweepOrphans(isKnownSession: (sessionId: string) => boolean): number {
      return deps.store.sweepOrphans(isKnownSession);
    },
    /** The chat is being deleted: its apps go with it. */
    deleteSession(sessionId: string): void {
      sessions.delete(sessionId);
      deps.store.deleteSession(sessionId);
    },
  };
}
