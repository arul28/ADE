import type {
  AgentChatEvent,
  AgentChatMcpToolSource,
  CodexWebSearchAction,
} from "../../../shared/types";

type ClaudeWebRequest = {
  kind: "web_search" | "web_fetch";
  query: string;
  url?: string;
};

export type ClaudeStructuredActivityState = {
  webByToolUseId: Map<string, ClaudeWebRequest>;
  mcpByToolUseId: Map<string, AgentChatMcpToolSource>;
  mcpInputSignatureByToolUseId: Map<string, string>;
  emittedStarts: Set<string>;
  emittedResults: Set<string>;
};

export function createClaudeStructuredActivityState(): ClaudeStructuredActivityState {
  return {
    webByToolUseId: new Map(),
    mcpByToolUseId: new Map(),
    mcpInputSignatureByToolUseId: new Map(),
    emittedStarts: new Set(),
    emittedResults: new Set(),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = readString(entry);
    return text ? [text] : [];
  });
}

function readWebRequest(name: "web_search" | "web_fetch", input: unknown): ClaudeWebRequest {
  const record = readRecord(input) ?? {};
  const queries = readStringArray(record.queries);
  const query = readString(record.query) ?? queries[0] ?? null;
  const url = readString(record.url);
  return {
    kind: name,
    query: name === "web_fetch"
      ? (url ?? query ?? "Web page")
      : (query ?? "Web search"),
    ...(url ? { url } : {}),
  };
}

function webStartActions(request: ClaudeWebRequest, input: unknown): CodexWebSearchAction[] {
  const record = readRecord(input) ?? {};
  if (request.kind === "web_fetch") {
    return request.url
      ? [{ type: "open_page", status: "running", url: request.url }]
      : [];
  }
  const queries = readStringArray(record.queries);
  return [{
    type: "search_query",
    status: "running",
    query: request.query,
    ...(queries.length ? { queries } : {}),
  }];
}

function webResultActions(content: unknown): CodexWebSearchAction[] {
  const values = Array.isArray(content) ? content : [content];
  return values.flatMap((value) => {
    const record = readRecord(value);
    if (!record) return [];
    const url = readString(record.url);
    if (!url) return [];
    return [{
      type: record.type === "web_fetch_result" ? "open_page" : "search_result",
      status: "completed" as const,
      url,
      ...(readString(record.title) ? { title: readString(record.title)! } : {}),
    }];
  });
}

function webResultError(content: unknown): string | null {
  const record = readRecord(content);
  const type = readString(record?.type);
  if (type !== "web_search_tool_result_error" && type !== "web_fetch_tool_result_error") {
    return null;
  }
  return readString(record?.error_code) ?? "request_failed";
}

function mcpResultContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const text = content
    .map((entry) => readString(readRecord(entry)?.text))
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
  return text || content;
}

function payloadSignature(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalize Claude API-owned server tools into ADE's provider-neutral activity
 * events. These blocks are distinct from client `tool_use` blocks and were
 * previously ignored by both Claude transcript paths.
 */
export function mapClaudeStructuredActivityBlock(args: {
  block: unknown;
  turnId: string;
  fallbackItemId: string;
  state: ClaudeStructuredActivityState;
}): AgentChatEvent[] {
  const block = readRecord(args.block);
  const type = readString(block?.type);
  if (!block || !type) return [];

  if (type === "server_tool_use") {
    const name = readString(block.name);
    if (name !== "web_search" && name !== "web_fetch") return [];
    const itemId = readString(block.id) ?? args.fallbackItemId;
    const request = readWebRequest(name, block.input);
    const previousRequest = args.state.webByToolUseId.get(itemId);
    args.state.webByToolUseId.set(itemId, request);
    if (
      args.state.emittedStarts.has(itemId)
      && previousRequest?.query === request.query
      && previousRequest.url === request.url
    ) return [];
    args.state.emittedStarts.add(itemId);
    const actions = webStartActions(request, block.input);
    return [{
      type: "web_search",
      query: request.query,
      action: name === "web_fetch" ? "Fetching page" : "Searching",
      ...(actions.length ? { actions } : {}),
      itemId,
      turnId: args.turnId,
      status: "running",
    }];
  }

  if (type === "web_search_tool_result" || type === "web_fetch_tool_result") {
    const itemId = readString(block.tool_use_id) ?? args.fallbackItemId;
    if (args.state.emittedResults.has(itemId)) return [];
    args.state.emittedResults.add(itemId);
    const inferredKind = type === "web_fetch_tool_result" ? "web_fetch" : "web_search";
    const actions = webResultActions(block.content);
    const firstUrl = actions.find((action) => action.url)?.url;
    const request = args.state.webByToolUseId.get(itemId) ?? {
      kind: inferredKind,
      query: firstUrl ?? (inferredKind === "web_fetch" ? "Web page" : "Web search"),
      ...(firstUrl ? { url: firstUrl } : {}),
    };
    const error = webResultError(block.content);
    return [{
      type: "web_search",
      query: request.query,
      action: error
        ? error.replace(/_/g, " ")
        : inferredKind === "web_fetch" ? "Page fetched" : "Search complete",
      ...(actions.length ? { actions } : {}),
      itemId,
      turnId: args.turnId,
      status: error ? "failed" : "completed",
    }];
  }

  if (type === "mcp_tool_use") {
    const itemId = readString(block.id) ?? args.fallbackItemId;
    const source: AgentChatMcpToolSource = {
      server: readString(block.server_name) ?? "mcp",
      tool: readString(block.name) ?? "tool",
    };
    const input = block.input ?? {};
    const inputSignature = payloadSignature(input);
    const previousInputSignature = args.state.mcpInputSignatureByToolUseId.get(itemId);
    args.state.mcpByToolUseId.set(itemId, source);
    args.state.mcpInputSignatureByToolUseId.set(itemId, inputSignature);
    if (args.state.emittedStarts.has(itemId) && previousInputSignature === inputSignature) return [];
    args.state.emittedStarts.add(itemId);
    return [{
      type: "tool_call",
      tool: `${source.server}:${source.tool}`,
      args: input,
      mcp: source,
      itemId,
      turnId: args.turnId,
    }];
  }

  if (type === "mcp_tool_result") {
    const itemId = readString(block.tool_use_id) ?? args.fallbackItemId;
    if (args.state.emittedResults.has(itemId)) return [];
    args.state.emittedResults.add(itemId);
    const source = args.state.mcpByToolUseId.get(itemId) ?? { server: "mcp", tool: "tool" };
    return [{
      type: "tool_result",
      tool: `${source.server}:${source.tool}`,
      result: mcpResultContent(block.content),
      mcp: source,
      itemId,
      turnId: args.turnId,
      status: block.is_error === true ? "failed" : "completed",
    }];
  }

  return [];
}

export function finalizeClaudeStructuredActivities(
  state: ClaudeStructuredActivityState,
  turnId: string,
  status: "completed" | "failed" | "interrupted",
): AgentChatEvent[] {
  const events: AgentChatEvent[] = [];
  for (const [itemId, request] of state.webByToolUseId) {
    if (state.emittedResults.has(itemId)) continue;
    state.emittedResults.add(itemId);
    events.push({
      type: "web_search",
      query: request.query,
      action: status === "completed" ? "Finished" : status === "interrupted" ? "Interrupted" : "Failed",
      ...(request.url ? { actions: [{ type: "open_page", url: request.url }] } : {}),
      itemId,
      turnId,
      status: status === "completed" ? "completed" : "failed",
    });
  }
  for (const [itemId, source] of state.mcpByToolUseId) {
    if (state.emittedResults.has(itemId)) continue;
    state.emittedResults.add(itemId);
    events.push({
      type: "tool_result",
      tool: `${source.server}:${source.tool}`,
      result: {
        synthetic: true,
        source: "claude_turn_finalization",
        finalTurnStatus: status,
      },
      mcp: source,
      itemId,
      turnId,
      status,
    });
  }
  return events;
}
