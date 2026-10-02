import type { AgentChatResourceLink } from "./types/chat";

export type { AgentChatResourceLink };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Housekeeping Claude tasks must never surface or count as activity. */
export function isClaudeHousekeepingTask(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return record.skip_transcript === true || record.ambient === true;
}

export function readClaudeSpawnDepth(value: unknown): number | undefined {
  const record = asRecord(value);
  const raw = record?.spawn_depth ?? record?.spawnDepth;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const depth = Math.floor(raw);
  return depth >= 0 ? depth : undefined;
}

function readResourceLink(value: unknown): AgentChatResourceLink | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? { path: trimmed, uri: trimmed } : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const uri = typeof record.uri === "string" && record.uri.trim() ? record.uri.trim() : undefined;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
  const path = typeof record.path === "string" && record.path.trim()
    ? record.path.trim()
    : typeof record.filePath === "string" && record.filePath.trim()
      ? record.filePath.trim()
      : undefined;
  if (!uri && !name && !path) return null;
  return { ...(uri ? { uri } : {}), ...(name ? { name } : {}), ...(path ? { path } : {}) };
}

function readResourceLinkList(raw: unknown): AgentChatResourceLink[] {
  if (!Array.isArray(raw)) return [];
  const links: AgentChatResourceLink[] = [];
  for (const entry of raw) {
    const link = readResourceLink(entry);
    if (link) links.push(link);
  }
  return links;
}

/** Files a backgrounded MCP task returned (`resource_links` / `resourceLinks`). */
export function parseClaudeResourceLinks(value: unknown): AgentChatResourceLink[] {
  const record = asRecord(value);
  if (!record) return [];
  const direct = readResourceLinkList(record.resource_links ?? record.resourceLinks);
  if (direct.length) return direct;
  const toolResult = asRecord(record.tool_use_result) ?? asRecord(record.toolUseResult);
  if (!toolResult) return [];
  return readResourceLinkList(toolResult.resource_links ?? toolResult.resourceLinks);
}

/** Path or URI remainder. Name-only links are labels, not copyable paths. */
export function resourceLinkCopyPath(link: AgentChatResourceLink): string | null {
  if (link.path?.trim()) return link.path.trim();
  if (link.uri?.trim()) return displayPathFromUri(link.uri.trim());
  return null;
}

function displayPathFromUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let rest = uri.slice("file://".length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Keep the raw remainder when it is not valid percent-encoding.
  }
  // file:///C:/Users/... (Windows drive-letter URLs).
  if (/^\/[A-Za-z]:[\\/]/.test(rest)) return rest.slice(1);
  return rest;
}

export function resourceLinkCopyPaths(links: readonly AgentChatResourceLink[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const path = resourceLinkCopyPath(link);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/** More than any real tool result carries; a runaway list stays out of the transcript. */
const MAX_RESULT_RESOURCE_LINKS = 50;

/**
 * MCP `resource_link` items in a tool result, as structured links.
 *
 * Two shapes, one per provider, both measured live on 2026-09-28:
 * - Codex (app-server 0.156.1) hands over the MCP `CallToolResult` itself, so
 *   the links are `{ type: "resource_link", uri, … }` items in `content`.
 * - Claude (Agent SDK 0.3.280) turns each link into a `[Resource link: …]` text
 *   block in the model-facing content, and keeps the structured list on the
 *   message's `tool_use_result.resourceLinks` — `{ uri, name, title, mimeType }`.
 *
 * Accepts either (or a bare content array), keeps only items with a `uri`, and
 * dedupes by `uri`. Everything else in the result is left to `result` itself.
 */
export function parseMcpResultResourceLinks(result: unknown): AgentChatResourceLink[] {
  const record = asRecord(result);
  const candidates: unknown[] = [];
  if (record && Array.isArray(record.resourceLinks)) candidates.push(...record.resourceLinks);
  const content = Array.isArray(result) ? result : record?.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (asRecord(entry)?.type === "resource_link") candidates.push(entry);
    }
  }
  const links: AgentChatResourceLink[] = [];
  const seen = new Set<string>();
  for (const entry of candidates) {
    const item = asRecord(entry);
    if (!item) continue;
    const uri = typeof item.uri === "string" ? item.uri.trim() : "";
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const text = (key: "name" | "title" | "mimeType"): string | undefined => {
      const value = item[key];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    const name = text("name");
    const title = text("title");
    const mimeType = text("mimeType");
    links.push({
      uri,
      ...(name ? { name } : {}),
      ...(title ? { title } : {}),
      ...(mimeType ? { mimeType } : {}),
    });
    if (links.length >= MAX_RESULT_RESOURCE_LINKS) break;
  }
  return links;
}

/**
 * `tool_use_result` of a WebFetch or WebSearch call that stepped aside for a
 * person's "now" message (Agent SDK 0.3.287+). The call is still running; its
 * real result reaches the model later, in a `<task-notification>` that names
 * the same tool_use_id, and never as a stream message of its own.
 */
export function isClaudeDetachedToolCallResult(value: unknown): boolean {
  return asRecord(value)?.detachedToolCall === true;
}

export type ClaudeToolCallNotification = {
  toolUseId: string;
  status: "completed" | "failed" | "interrupted";
  result: string;
};

function messageContentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.length ? parts.join("\n") : null;
}

/** `body` tags take the LAST close, because their content (a fetched page) can hold the close tag itself. */
function notificationTag(text: string, tag: string, body = false): string | null {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const close = `</${tag}>`;
  const end = body ? text.lastIndexOf(close) : text.indexOf(close, start + open.length);
  if (end < start + open.length) return null;
  return text.slice(start + open.length, end).trim();
}

/**
 * Reads the `<task-notification>` that delivers a detached tool call's result
 * from a Claude session transcript message's content. Returns null for any
 * other content, including task notifications about shells and agents.
 */
export function parseClaudeToolCallNotification(content: unknown): ClaudeToolCallNotification | null {
  const text = messageContentText(content);
  if (!text || !text.trimStart().startsWith("<task-notification>")) return null;
  if (notificationTag(text, "task-type") !== "tool_call") return null;
  const toolUseId = notificationTag(text, "tool-use-id");
  if (!toolUseId) return null;
  const rawStatus = notificationTag(text, "status")?.toLowerCase() ?? "completed";
  const status = rawStatus === "completed"
    ? "completed"
    : rawStatus === "stopped" || rawStatus === "killed" || rawStatus === "cancelled"
      ? "interrupted"
      : "failed";
  return {
    toolUseId,
    status,
    result: notificationTag(text, "result", true) ?? notificationTag(text, "summary") ?? "",
  };
}
