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

export function resourceLinkDisplayPath(link: AgentChatResourceLink): string | null {
  if (link.path?.trim()) return link.path.trim();
  if (link.uri?.trim()) {
    return displayPathFromUri(link.uri.trim());
  }
  if (link.name?.trim()) return link.name.trim();
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
    const path = resourceLinkDisplayPath(link);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
