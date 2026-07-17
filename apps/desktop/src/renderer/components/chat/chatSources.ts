import type {
  AgentChatEventEnvelope,
  AgentChatMcpToolSource,
} from "../../../shared/types";

export type ChatSourceKind = "file" | "web" | "tool" | "external";

export type ChatSource = {
  id: string;
  kind: ChatSourceKind;
  title: string;
  detail?: string;
  url?: string;
  path?: string;
};

export type ChatSources = {
  files: ChatSource[];
  tools: ChatSource[];
  web: ChatSource[];
  external: ChatSource[];
  total: number;
};

type ToolGroup = {
  source: ChatSource;
  actions: Set<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function fileName(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || value;
}

function canonicalHttpUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function sourceLabelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.replace(/\/$/, "").split("/").filter(Boolean).pop();
    return tail ? decodeURIComponent(tail) : parsed.hostname;
  } catch {
    return url;
  }
}

function addPreferred(map: Map<string, ChatSource>, key: string, incoming: ChatSource): void {
  const current = map.get(key);
  if (!current) {
    map.set(key, incoming);
    return;
  }
  const currentUsesUrlFallback = Boolean(
    current.url
    && (current.title === current.url || current.title === sourceLabelFromUrl(current.url)),
  );
  const currentDetailUsesUrlFallback = Boolean(current.url && current.detail === current.url);
  map.set(key, {
    ...current,
    title: currentUsesUrlFallback && incoming.title !== incoming.url
      ? incoming.title
      : current.title,
    detail: !current.detail || currentDetailUsesUrlFallback
      ? incoming.detail ?? current.detail
      : current.detail,
    url: current.url ?? incoming.url,
    path: current.path ?? incoming.path,
  });
}

function legacyMcpSource(toolLabel: string): AgentChatMcpToolSource | null {
  const separator = toolLabel.indexOf(":");
  if (separator <= 0 || separator >= toolLabel.length - 1) return null;
  return {
    server: toolLabel.slice(0, separator),
    tool: toolLabel.slice(separator + 1),
  };
}

function toolSourceKey(mcp: AgentChatMcpToolSource): string {
  return mcp.appContext?.connectorId
    ?? mcp.pluginId
    ?? mcp.server;
}

function addToolSource(groups: Map<string, ToolGroup>, mcp: AgentChatMcpToolSource): void {
  const key = toolSourceKey(mcp);
  const action = mcp.appContext?.actionName ?? mcp.tool;
  const existing = groups.get(key);
  if (existing) {
    existing.actions.add(action);
    return;
  }
  groups.set(key, {
    source: {
      id: `tool:${key}`,
      kind: "tool",
      title: mcp.appContext?.appName ?? mcp.pluginId ?? mcp.server,
    },
    actions: new Set([action]),
  });
}

function addExternalResource(
  map: Map<string, ChatSource>,
  urlValue: unknown,
  titleValue?: unknown,
): void {
  const url = canonicalHttpUrl(urlValue);
  if (!url) return;
  const title = stringValue(titleValue) ?? sourceLabelFromUrl(url);
  addPreferred(map, url.toLowerCase(), {
    id: `external:${url.toLowerCase()}`,
    kind: "external",
    title,
    detail: url,
    url,
  });
}

function collectExternalResources(
  value: unknown,
  map: Map<string, ChatSource>,
  depth = 0,
  seen: Set<object> = new Set(),
): void {
  if (depth > 6 || map.size >= 100) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 1 && trimmed.length < 100_000 && /^[{[]/.test(trimmed)) {
      try {
        collectExternalResources(JSON.parse(trimmed), map, depth + 1, seen);
      } catch {
        // Tool text is often ordinary prose; only valid JSON is traversed.
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectExternalResources(entry, map, depth + 1, seen);
    return;
  }

  const record = value as Record<string, unknown>;
  const title = record.title ?? record.name ?? record.label;
  for (const key of ["url", "href", "link", "resourceUrl", "resource_url", "uri"]) {
    if (key in record) addExternalResource(map, record[key], title);
  }
  for (const nested of Object.values(record)) {
    collectExternalResources(nested, map, depth + 1, seen);
  }
}

export function deriveChatSources(events: AgentChatEventEnvelope[]): ChatSources {
  const files = new Map<string, ChatSource>();
  const web = new Map<string, ChatSource>();
  const tools = new Map<string, ToolGroup>();
  const external = new Map<string, ChatSource>();
  const mcpByItemId = new Map<string, AgentChatMcpToolSource>();

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "user_message") {
      for (const attachment of event.attachments ?? []) {
        const key = attachment.type === "image-url"
          ? canonicalHttpUrl(attachment.url) ?? attachment.url.trim()
          : attachment.path.trim();
        if (!key) continue;
        addPreferred(files, key.toLowerCase(), {
          id: `file:${key.toLowerCase()}`,
          kind: "file",
          title: fileName(attachment.path) || (attachment.type === "image-url" ? sourceLabelFromUrl(attachment.url) : key),
          detail: attachment.type === "image-url" ? attachment.url : attachment.path,
          ...(attachment.type === "image-url" && canonicalHttpUrl(attachment.url)
            ? { url: canonicalHttpUrl(attachment.url) as string }
            : { path: attachment.path }),
        });
      }
      for (const context of event.contextAttachments ?? []) {
        if (context.type !== "linear_issue") continue;
        addExternalResource(
          external,
          context.issue.url,
          `${context.issue.identifier}: ${context.issue.title}`,
        );
      }
      continue;
    }

    if (event.type === "web_search") {
      if (event.status === "failed") continue;
      const queries = new Set<string>();
      if (event.query.trim()) queries.add(event.query.trim());
      for (const action of event.actions ?? []) {
        if (action.query?.trim()) queries.add(action.query.trim());
        for (const query of action.queries ?? []) {
          if (query.trim()) queries.add(query.trim());
        }
        const url = canonicalHttpUrl(action.url);
        if (!url) continue;
        addPreferred(web, `url:${url.toLowerCase()}`, {
          id: `web:${url.toLowerCase()}`,
          kind: "web",
          title: action.title?.trim() || sourceLabelFromUrl(url),
          detail: action.snippet?.trim() || url,
          url,
        });
      }
      for (const result of event.results ?? []) {
        const url = canonicalHttpUrl(result.url);
        if (!url) continue;
        addPreferred(web, `url:${url.toLowerCase()}`, {
          id: `web:${url.toLowerCase()}`,
          kind: "web",
          title: result.title?.trim() || sourceLabelFromUrl(url),
          detail: result.snippet?.trim() || url,
          url,
        });
      }
      for (const query of queries) {
        const key = query.toLocaleLowerCase();
        addPreferred(web, `query:${key}`, {
          id: `web-query:${key}`,
          kind: "web",
          title: query,
          detail: "Web search",
        });
      }
      continue;
    }

    if (event.type !== "tool_call" && event.type !== "tool_result") continue;
    const mcp = event.mcp
      ?? mcpByItemId.get(event.itemId)
      ?? legacyMcpSource(event.tool);
    if (!mcp) continue;
    mcpByItemId.set(event.itemId, mcp);
    // Codex treats its internal JavaScript execution host as transcript
    // plumbing, not a user-facing source or connected app.
    if (mcp.server.trim().toLowerCase() === "node_repl") continue;
    addToolSource(tools, mcp);
    if (mcp.resourceUri) {
      addExternalResource(
        external,
        mcp.resourceUri,
        mcp.appContext?.appName ?? mcp.pluginId ?? mcp.server,
      );
    }
    if (event.type === "tool_result") {
      collectExternalResources(event.result, external);
    }
  }

  const toolSources = [...tools.values()].map(({ source, actions }) => ({
    ...source,
    detail: [...actions].join(", "),
  }));
  const result = {
    files: [...files.values()],
    tools: toolSources,
    web: [...web.values()],
    external: [...external.values()],
  };
  return {
    ...result,
    total: result.files.length + result.tools.length + result.web.length + result.external.length,
  };
}
