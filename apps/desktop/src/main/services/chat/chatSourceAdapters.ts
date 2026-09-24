/**
 * Provider-native source shapes → ADE's `ChatSourceRef`.
 *
 * Every adapter is pure and additive: it returns refs for a `tool_result`'s
 * optional `sources` field or for a data-only `sources` event, and returns []
 * for anything it does not recognise. Shapes are taken from the installed
 * SDK typings (see docs/features/chat/transcript-and-turns.md → Sources).
 */
import {
  boundChatSourceRefs,
  httpUrl,
  webSourceRefsFromValue,
} from "../../../shared/chatSources";
import type { ChatSourceRef } from "../../../shared/types";
import { fileURLToPath } from "node:url";

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function readInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function toolKey(name: string): string {
  return name.trim().split(/__|\./).pop()!.replace(/[^a-z]/gi, "").toLowerCase();
}

/** `webSearch` / `WebSearch` / `web_search` / `websearch` (optionally namespaced). */
export function isWebSearchToolName(name: string | null | undefined): boolean {
  return Boolean(name) && toolKey(name!) === "websearch";
}

/** `webFetch` / `WebFetch` / `web_fetch` / `webfetch` / Droid `FetchUrl`. */
export function isWebFetchToolName(name: string | null | undefined): boolean {
  if (!name) return false;
  const key = toolKey(name);
  return key === "webfetch" || key === "fetchurl";
}

// ── Codex ────────────────────────────────────────────────────────────────

/**
 * Codex app-server v2 `agentMessage.memoryCitation`:
 * `{ entries: { path, lineStart, lineEnd, note }[], threadIds: string[] }`.
 * Each entry is a memory file the answer cites.
 */
export function codexMemoryCitationSourceRefs(value: unknown): ChatSourceRef[] {
  const citation = readRecord(value);
  const entries = Array.isArray(citation?.entries) ? citation.entries : [];
  const refs: ChatSourceRef[] = [];
  for (const entry of entries) {
    const record = readRecord(entry);
    const path = readString(record?.path);
    if (!record || !path) continue;
    const lineStart = readInt(record.lineStart);
    const lineEnd = readInt(record.lineEnd);
    const note = readString(record.note);
    refs.push({
      kind: "file",
      path,
      cited: true,
      ...(lineStart !== undefined ? { lineStart } : {}),
      ...(lineEnd !== undefined ? { lineEnd } : {}),
      ...(note ? { snippet: note } : {}),
    });
  }
  return boundChatSourceRefs(refs);
}

// ── Claude ───────────────────────────────────────────────────────────────

/**
 * Claude `TextBlock.citations` (and `citations_delta.citation`). Only the two
 * location kinds that name a web source become refs:
 * `web_search_result_location { url, title, cited_text }` and
 * `search_result_location { source, title, cited_text }` when `source` is a URL.
 * Document locations (char/page/content_block) point into user-supplied
 * documents with no URL or path, so they are skipped.
 */
export function claudeCitationSourceRefs(citations: unknown): ChatSourceRef[] {
  const list = Array.isArray(citations) ? citations : citations ? [citations] : [];
  const refs: ChatSourceRef[] = [];
  for (const entry of list) {
    const record = readRecord(entry);
    if (!record) continue;
    const type = readString(record.type);
    const url = type === "web_search_result_location"
      ? readString(record.url)
      : type === "search_result_location" ? readString(record.source) : null;
    if (!url || !httpUrl(url)) continue;
    const title = readString(record.title);
    const citedText = readString(record.cited_text);
    refs.push({
      kind: "citation",
      url,
      cited: true,
      ...(title ? { title } : {}),
      ...(citedText ? { snippet: citedText } : {}),
    });
  }
  return boundChatSourceRefs(refs);
}

/** Citation refs for every text block of a Claude assistant message. */
export function claudeMessageCitationSourceRefs(content: unknown): ChatSourceRef[] {
  if (!Array.isArray(content)) return [];
  const refs: ChatSourceRef[] = [];
  for (const block of content) {
    const record = readRecord(block);
    if (record?.type !== "text") continue;
    refs.push(...claudeCitationSourceRefs(record.citations));
  }
  return boundChatSourceRefs(refs);
}

/**
 * Claude Agent SDK client tools (`sdk-tools.d.ts`), read from
 * `SDKUserMessage.tool_use_result`:
 * - `WebSearchOutput { query, results: ({ tool_use_id, content: { title, url }[] } | string)[] }`
 * - `WebFetchOutput { url, code, codeText, result, bytes, durationMs }`
 */
export function claudeWebToolSourceRefs(toolName: string, toolUseResult: unknown): ChatSourceRef[] {
  const record = readRecord(toolUseResult);
  if (!record) return [];
  if (isWebSearchToolName(toolName)) {
    const query = readString(record.query);
    const results = Array.isArray(record.results) ? record.results : [];
    const refs: ChatSourceRef[] = [];
    for (const result of results) {
      const content = readRecord(result)?.content;
      if (!Array.isArray(content)) continue;
      for (const hit of content) {
        const hitRecord = readRecord(hit);
        const url = readString(hitRecord?.url);
        if (!url) continue;
        const title = readString(hitRecord?.title);
        refs.push({
          kind: "web_search_result",
          url,
          ...(title ? { title } : {}),
          ...(query ? { query } : {}),
        });
      }
    }
    return boundChatSourceRefs(refs);
  }
  if (isWebFetchToolName(toolName)) {
    const url = readString(record.url);
    const code = readInt(record.code);
    if (!url || (code !== undefined && code >= 400)) return [];
    return boundChatSourceRefs([{ kind: "fetched_url", url }]);
  }
  return [];
}

// ── Cursor ───────────────────────────────────────────────────────────────

/**
 * Cursor `webSearch` / `webFetch` (`ToolName` in `@cursor/sdk` agent/options).
 * The SDK publishes no JSON types for them; the agent protobuf defines
 * `WebSearchArgs { searchTerm }`, `WebSearchResult.success.references
 * { title, url, chunk }[]`, `WebFetchArgs { url }`, and
 * `WebFetchResult.success { url, markdown }`. The SDK wraps results as
 * `{ status, value }`, so the walker looks through any wrapper.
 */
export function cursorWebToolSourceRefs(toolName: string, args: unknown, result: unknown): ChatSourceRef[] {
  const input = readRecord(args);
  if (isWebSearchToolName(toolName)) {
    const query = readString(input?.searchTerm) ?? readString(input?.search_term) ?? readString(input?.query);
    return webSourceRefsFromValue(result, "web_search_result", { query });
  }
  if (isWebFetchToolName(toolName)) {
    const fromResult = webSourceRefsFromValue(result, "fetched_url");
    if (fromResult.length) return fromResult;
    const url = readString(input?.url);
    const outcome = readRecord(result);
    const value = readRecord(outcome?.value);
    const failed = Boolean(
      outcome?.status === "error"
      || outcome?.error || outcome?.rejected
      || value?.error || value?.rejected,
    );
    return url && !failed ? boundChatSourceRefs([{ kind: "fetched_url", url }]) : [];
  }
  return [];
}

// ── OpenCode ─────────────────────────────────────────────────────────────

/**
 * OpenCode `webfetch` / `websearch` tool parts. `ToolStateCompleted` is
 * `{ input: Record<string, unknown>, output: string, title, metadata }`; the
 * SDK does not type the input, so only `url` / `query` are read, and the output
 * is scanned only when it is JSON.
 */
export function openCodeWebToolSourceRefs(
  toolName: string,
  input: unknown,
  output: unknown,
  title?: string | null,
): ChatSourceRef[] {
  const record = readRecord(input);
  if (isWebFetchToolName(toolName)) {
    const url = readString(record?.url);
    if (!url) return [];
    const cleanTitle = readString(title);
    return boundChatSourceRefs([{
      kind: "fetched_url",
      url,
      ...(cleanTitle && cleanTitle !== url ? { title: cleanTitle } : {}),
    }]);
  }
  if (isWebSearchToolName(toolName)) {
    const query = readString(record?.query);
    return webSourceRefsFromValue(output, "web_search_result", { query });
  }
  return [];
}

// ── Droid ────────────────────────────────────────────────────────────────

/**
 * Droid (Factory) web tools. `@factory/droid-sdk` types every tool as a generic
 * `ToolUse { name, input }` / `ToolResult { content }` and names no web tools,
 * so this is an allowlist of web tool names: `WebSearch` and `FetchUrl`
 * (plus the generic aliases). Other tools never produce sources.
 */
export function droidWebToolSourceRefs(toolName: string, input: unknown, content: unknown): ChatSourceRef[] {
  const record = readRecord(input);
  if (isWebSearchToolName(toolName)) {
    const query = readString(record?.query);
    return webSourceRefsFromValue(content, "web_search_result", { query });
  }
  if (isWebFetchToolName(toolName)) {
    const url = readString(record?.url);
    return url ? boundChatSourceRefs([{ kind: "fetched_url", url }]) : [];
  }
  return [];
}

// ── ACP ──────────────────────────────────────────────────────────────────

/**
 * ACP `resource_link { uri, name, title?, description? }` content block: an
 * http(s) URI is a cited web page, a file:// URI (or bare path) is a cited
 * file. Anything else (custom schemes) is not a source.
 */
export function acpResourceLinkSourceRef(block: unknown): ChatSourceRef | null {
  const record = readRecord(block);
  if (!record || record.type !== "resource_link") return null;
  const uri = readString(record.uri);
  if (!uri) return null;
  const title = readString(record.title) ?? readString(record.name);
  const description = readString(record.description);
  const extra = {
    cited: true,
    ...(title ? { title } : {}),
    ...(description ? { snippet: description } : {}),
  };
  if (httpUrl(uri)) return boundChatSourceRefs([{ kind: "citation", url: uri, ...extra }])[0] ?? null;
  let path: string | null = null;
  if (uri.startsWith("file://")) {
    try {
      // Keep platform-specific drive and UNC semantics intact on Windows.
      const fileUrl = new URL(uri);
      const windowsUrl = Boolean(fileUrl.hostname) || /^\/[a-zA-Z]:\//.test(fileUrl.pathname);
      path = fileURLToPath(fileUrl, windowsUrl ? { windows: true } : undefined);
    } catch {
      path = null;
    }
  } else if (uri.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(uri)) {
    path = uri;
  }
  return path ? boundChatSourceRefs([{ kind: "file", path, ...extra }])[0] ?? null : null;
}

/**
 * ACP tool calls. `kind: "fetch"` with `rawInput.url` is a fetched page.
 * `kind: "search"` is ALSO what agents use for grep/glob, so it only counts as a
 * web search when its input has no path/pattern-over-files shape and its
 * output carries http(s) URL records; a local search never becomes a source.
 */
export function acpToolSourceRefs(args: {
  kind: string | null | undefined;
  rawInput: unknown;
  rawOutput: unknown;
  locations?: unknown;
}): ChatSourceRef[] {
  const input = readRecord(args.rawInput);
  if (args.kind === "fetch") {
    const url = readString(input?.url) ?? readString(input?.uri);
    if (url && httpUrl(url)) {
      const title = readString(input?.title);
      return boundChatSourceRefs([{ kind: "fetched_url", url, ...(title ? { title } : {}) }]);
    }
    return webSourceRefsFromValue(args.rawOutput, "fetched_url");
  }
  if (args.kind === "search") {
    const hasLocalShape = Boolean(
      readString(input?.path)
      || readString(input?.glob)
      || readString(input?.include)
      || readString(input?.cwd)
      || readString(input?.directory)
      || (Array.isArray(args.locations) && args.locations.length > 0),
    );
    if (hasLocalShape) return [];
    const query = readString(input?.query) ?? readString(input?.q);
    if (!query) return [];
    return webSourceRefsFromValue(args.rawOutput, "web_search_result", { query });
  }
  return [];
}
