/**
 * Sources: what a chat drew on — web results, fetched pages, citations in the
 * answer, files, and connected apps — derived from the transcript for EVERY
 * provider. A view over events, never a second persistence channel.
 *
 * Inputs (all optional on the wire, so older transcripts still work):
 * - `web_search` events: `results`, URL `actions` (open/find page). Queries
 *   are metadata on the sources they produced, never items of their own.
 * - `tool_result.sources`: provider web tools (Claude WebSearch/WebFetch,
 *   Cursor, OpenCode, Droid, ACP fetch/search).
 * - `sources` events: answer citations (Claude text citations, Codex memory
 *   citations, ACP resource links).
 * - MCP tool calls (connected apps) and URLs found in MCP JSON results.
 * - User attachments and Linear issue context.
 * - Assistant `text`: a source whose URL the answer links to (markdown link,
 *   autolink, or bare URL) is marked cited. Text never adds a source.
 *
 * Adapters in the main process use {@link boundChatSourceRefs} and
 * {@link webSourceRefsFromValue} so every provider emits the same bounded shape.
 */
import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatMcpToolSource,
  ChatSourceRef,
  ChatSourceRefKind,
} from "./types";

export type ChatSourceKind = ChatSourceRefKind | "tool";

export type ChatSourceGroup = "cited" | "web" | "files" | "apps";

export type ChatSource = {
  id: string;
  /** Openable http(s) URL, as the provider reported it. */
  url?: string;
  /** Dedupe key for {@link url} (see {@link normalizeSourceUrl}). */
  normalizedUrl?: string;
  /**
   * Host without `www.`. The renderer resolves its favicon through the brain's
   * `chat.resolveSourceFavicons` action (first-party fetch, never a third
   * party) and draws the domain initial until one arrives.
   */
  domain?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  title: string;
  snippet?: string;
  /** Connected apps: the actions used, comma separated. */
  detail?: string;
  kinds: ChatSourceKind[];
  queries: string[];
  provider: string | null;
  turnIds: string[];
  itemIds: string[];
  cited: boolean;
  /** The user attached it; attachments are not counted per turn. */
  attached?: boolean;
  firstSeenAt: string;
};

export type ChatSources = {
  /** Every source, in first-seen order. */
  sources: ChatSource[];
  cited: ChatSource[];
  web: ChatSource[];
  files: ChatSource[];
  apps: ChatSource[];
  total: number;
  /**
   * Per turn: the sources the agent used in that turn (web, citations, files
   * it read). Apps and user attachments are excluded — the chip and the fold
   * count say what the answer drew on, not which connectors ran.
   */
  byTurn: Map<string, ChatSource[]>;
};

// ── Bounds ────────────────────────────────────────────────────────────────

/** Max refs one event carries. Adapters cap; the wire never grows unbounded. */
export const MAX_CHAT_SOURCE_REFS_PER_EVENT = 20;
const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 400;
const MAX_URL_CHARS = 2_048;
const MAX_PATH_CHARS = 1_024;
const MAX_QUERY_CHARS = 300;
const MAX_QUERIES_PER_SOURCE = 5;
const MAX_SOURCES = 500;

const TRACKING_PARAM = /^(?:utm_[a-z0-9_]*|fbclid|gclid|msclkid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|ref_src|ref_url|amp)$/i;
/**
 * `?ref=<site>` is a referral tag (`?ref=aidevstack.dev`), but `?ref=main` or
 * `?ref=v1.2.3` picks a git ref on GitHub's contents API. Only a value shaped
 * like a hostname (ends in an alphabetic TLD) is dropped.
 */
const REFERRAL_HOST_VALUE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
/** Mobile and AMP mirrors of the same page: `m.`, `mobile.`, `amp.`, and Wikipedia's `en.m.`. */
const MIRROR_HOST_PREFIX = /^(?:www|m|mobile|amp)\./;

/**
 * An http(s) URL in prose: a markdown link target, an autolink, or a bare URL.
 * Balanced parentheses stay part of the URL (`/wiki/Foo_(bar)`); an unmatched
 * `)` ends it, which is how a markdown link target closes.
 */
const PROSE_URL = /https?:\/\/(?:[^\s<>()[\]{}"'`|\\^]|\([^\s()<>]*\))+/gi;
/** Sentence punctuation and emphasis markers that end a bare URL, not part of it. */
const PROSE_URL_TRAILING = /[.,;:!?*_~]+$/;

/** Every http(s) URL an assistant message links to or names, normalized. */
export function linkedSourceUrls(prose: string): Set<string> {
  const urls = new Set<string>();
  if (!prose.includes("://")) return urls;
  for (const match of prose.matchAll(PROSE_URL)) {
    const normalized = normalizeSourceUrl(match[0].replace(PROSE_URL_TRAILING, ""));
    if (normalized) urls.add(normalized);
  }
  return urls;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** An http(s) URL, or null. Everything else (file:, javascript:, data:) is not a web source. */
export function httpUrl(value: unknown): URL | null {
  const raw = text(value);
  if (!raw || raw.length > MAX_URL_CHARS) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function decodeQueryPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // Keep the raw text when it is not valid percent-encoding.
    return value;
  }
}

/**
 * Dedupe key for a web URL. One page reached several ways gets one key:
 * - `http:` and `https:` are the same page (the key is always `https:`);
 * - host is lowercased without `www.`, `m.`, `mobile.`, `amp.` (and `en.m.` →
 *   `en.`), credentials, or a default port;
 * - no `#fragment`, no trailing slash, no trailing `/amp` segment;
 * - tracking params (`utm_*`, `fbclid`, `gclid`, …, `?ref=<hostname>`) are
 *   dropped and the rest are sorted, so query order does not matter.
 * Path and query values keep their case — paths are case-sensitive.
 */
export function normalizeSourceUrl(value: unknown): string | null {
  const parsed = httpUrl(value);
  if (!parsed) return null;
  let host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  // Strip a mirror prefix only while a registrable name remains (`m.co` stays).
  const unmirrored = host.replace(MIRROR_HOST_PREFIX, "").replace(/^([a-z]{2,3}(?:-[a-z]+)?)\.m\./, "$1.");
  if (unmirrored.includes(".")) host = unmirrored;
  const defaultPort = parsed.port === "" || parsed.port === "80" || parsed.port === "443";
  let path = parsed.pathname.replace(/\/+$/, "").replace(/\/amp$/i, "");
  if (path === "/") path = "";
  const query = parsed.search
    .slice(1)
    .split("&")
    .filter((pair) => {
      if (!pair) return false;
      const [rawKey = "", rawValue = ""] = pair.split("=");
      const key = decodeQueryPart(rawKey);
      if (TRACKING_PARAM.test(key)) return false;
      return !(key.toLowerCase() === "ref" && REFERRAL_HOST_VALUE.test(decodeQueryPart(rawValue)));
    })
    .sort((left, right) => {
      const leftKey = left.split("=")[0] ?? "";
      const rightKey = right.split("=")[0] ?? "";
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .join("&");
  return `https://${host}${defaultPort ? "" : `:${parsed.port}`}${path}${query ? `?${query}` : ""}`;
}

export function sourceDomain(value: unknown): string | null {
  const parsed = httpUrl(value);
  return parsed ? parsed.hostname.toLowerCase().replace(/^www\./, "") : null;
}

function fileName(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || value;
}

/**
 * Title for a page the provider reported without one: the domain and path
 * (`anthropic.com/research`), or just the domain for a site root. It names the
 * domain itself, so the row shows no separate domain for it
 * ({@link chatSourceSubtitle}).
 */
function urlFallbackTitle(url: URL): string {
  const domain = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") return domain;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }
  return clip(`${domain}${decoded}`, MAX_TITLE_CHARS);
}

/**
 * Clean one adapter-built ref: http(s) URLs only, trimmed and clipped strings,
 * and at least a URL or a path. Returns null for anything unusable.
 */
export function boundChatSourceRef(ref: ChatSourceRef): ChatSourceRef | null {
  const parsedUrl = httpUrl(ref.url);
  // Provider source URLs are shared as links and may be copied or opened from
  // another device. Never let embedded basic-auth credentials cross that
  // boundary.
  const url = parsedUrl && !parsedUrl.username && !parsedUrl.password ? text(ref.url) : null;
  const path = text(ref.path);
  if (!url && !path) return null;
  const title = text(ref.title);
  const snippet = text(ref.snippet);
  const query = text(ref.query);
  const lineStart = positiveInt(ref.lineStart);
  const lineEnd = positiveInt(ref.lineEnd);
  return {
    kind: ref.kind,
    ...(url ? { url: text(ref.url)! } : {}),
    ...(path ? { path: clip(path, MAX_PATH_CHARS) } : {}),
    ...(title ? { title: clip(title, MAX_TITLE_CHARS) } : {}),
    ...(snippet ? { snippet: clip(snippet, MAX_SNIPPET_CHARS) } : {}),
    ...(query ? { query: clip(query, MAX_QUERY_CHARS) } : {}),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
    ...(ref.cited ? { cited: true } : {}),
  };
}

/** {@link boundChatSourceRef} over a list, deduped by URL/path, capped per event. */
export function boundChatSourceRefs(
  refs: readonly ChatSourceRef[],
  max = MAX_CHAT_SOURCE_REFS_PER_EVENT,
): ChatSourceRef[] {
  const out: ChatSourceRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (out.length >= max) break;
    const bounded = boundChatSourceRef(ref);
    if (!bounded) continue;
    const key = normalizeSourceUrl(bounded.url) ?? `path:${bounded.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bounded);
  }
  return out;
}

function snippetOf(record: Record<string, unknown>): string | null {
  // `chunk` is Cursor's WebSearchReference excerpt; `cited_text` is Claude's.
  return text(record.snippet) ?? text(record.description) ?? text(record.summary)
    ?? text(record.chunk) ?? text(record.cited_text);
}

/**
 * Pull `{ url, title, snippet }` records out of a provider web-tool payload of
 * unknown shape: arrays of results, `{ results | links | sources | content }`
 * wrappers, and JSON strings of those. Only records with an http(s) `url`
 * (or `link`/`href`) become refs; prose is never scanned for URLs.
 */
export function webSourceRefsFromValue(
  value: unknown,
  kind: ChatSourceRefKind,
  options: { query?: string | null; max?: number } = {},
): ChatSourceRef[] {
  const refs: ChatSourceRef[] = [];
  const max = options.max ?? MAX_CHAT_SOURCE_REFS_PER_EVENT;
  const seen = new Set<object>();
  const visit = (node: unknown, depth: number): void => {
    if (refs.length >= max || depth > 6) return;
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed.length > 1 && trimmed.length < 200_000 && /^[[{]/.test(trimmed)) {
        try {
          visit(JSON.parse(trimmed), depth + 1);
        } catch {
          // Ordinary tool text; only valid JSON is traversed.
        }
      }
      return;
    }
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const url = text(record.url) ?? text(record.link) ?? text(record.href);
    if (url && httpUrl(url)) {
      refs.push({
        kind,
        url,
        ...(text(record.title) ?? text(record.name) ? { title: text(record.title) ?? text(record.name)! } : {}),
        ...(snippetOf(record) ? { snippet: snippetOf(record)! } : {}),
        ...(options.query ? { query: options.query } : {}),
      });
      return;
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(value, 0);
  return boundChatSourceRefs(refs, max);
}

// ── Derivation ────────────────────────────────────────────────────────────

type Contribution = {
  key: string;
  kind: ChatSourceKind;
  url?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  title?: string;
  snippet?: string;
  detail?: string;
  queries?: readonly string[];
  cited?: boolean;
  attached?: boolean;
  /** Counts toward the turn chip / fold count. */
  countsTowardTurn: boolean;
};

function refContribution(ref: ChatSourceRef, queries: readonly string[] = []): Contribution | null {
  const safeRef = boundChatSourceRef(ref);
  if (!safeRef) return null;
  const normalizedUrl = normalizeSourceUrl(safeRef.url);
  const path = text(safeRef.path);
  if (!normalizedUrl && !path) return null;
  const allQueries = safeRef.query ? [safeRef.query, ...queries] : queries;
  return {
    key: normalizedUrl ? `url:${normalizedUrl}` : `file:${path}`,
    kind: safeRef.kind,
    ...(normalizedUrl ? { url: safeRef.url! } : {}),
    ...(path ? { path } : {}),
    ...(safeRef.lineStart !== undefined ? { lineStart: safeRef.lineStart } : {}),
    ...(safeRef.lineEnd !== undefined ? { lineEnd: safeRef.lineEnd } : {}),
    ...(text(safeRef.title) ? { title: text(safeRef.title)! } : {}),
    ...(text(safeRef.snippet) ? { snippet: text(safeRef.snippet)! } : {}),
    ...(allQueries.length ? { queries: allQueries } : {}),
    ...(ref.cited ? { cited: true } : {}),
    countsTowardTurn: true,
  };
}

function legacyMcpSource(toolLabel: string): AgentChatMcpToolSource | null {
  const separator = toolLabel.indexOf(":");
  if (separator <= 0 || separator >= toolLabel.length - 1) return null;
  // `a:b` with whitespace or a path separator is prose or a path, not `server:tool`.
  if (/[\s/\\]/.test(toolLabel)) return null;
  return { server: toolLabel.slice(0, separator), tool: toolLabel.slice(separator + 1) };
}

function toolSourceKey(mcp: AgentChatMcpToolSource): string {
  return mcp.appContext?.connectorId ?? mcp.pluginId ?? mcp.server;
}

/**
 * URL records in an MCP tool result. Cached per event object: results can be
 * large JSON, and the transcript is re-derived on every streaming delta.
 */
const mcpResultUrlCache = new WeakMap<object, ChatSourceRef[]>();

function mcpResultUrlRefs(event: Extract<AgentChatEvent, { type: "tool_result" }>): ChatSourceRef[] {
  const cached = mcpResultUrlCache.get(event);
  if (cached) return cached;
  const refs = webSourceRefsFromValue(event.result, "web_search_result", { max: 100 });
  mcpResultUrlCache.set(event, refs);
  return refs;
}

function webSearchQueries(event: Extract<AgentChatEvent, { type: "web_search" }>): string[] {
  const queries = new Set<string>();
  const add = (value: unknown) => {
    const query = text(value);
    // A fetch uses its URL as the "query"; that is not a search.
    if (query && !httpUrl(query)) queries.add(clip(query, MAX_QUERY_CHARS));
  };
  add(event.query);
  for (const action of event.actions ?? []) {
    add(action.query);
    for (const query of action.queries ?? []) add(query);
  }
  return [...queries];
}

function isPageAction(type: string): boolean {
  return /open|find|fetch|page/i.test(type);
}

function titleIsFallback(source: Pick<ChatSource, "url" | "domain" | "normalizedUrl" | "path">, title: string): boolean {
  if (source.url && (title === source.url || title === source.normalizedUrl || title === source.domain)) return true;
  const parsed = httpUrl(source.url);
  if (parsed && title === urlFallbackTitle(parsed)) return true;
  if (source.path && (title === source.path || title === fileName(source.path))) return true;
  return false;
}

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

export function deriveChatSources(
  events: readonly AgentChatEventEnvelope[],
  options: { provider?: string | null } = {},
): ChatSources {
  const provider = options.provider ?? null;
  const byKey = new Map<string, ChatSource>();
  const turnCounted = new Map<string, Set<string>>();
  const mcpByItemId = new Map<string, AgentChatMcpToolSource>();

  const add = (
    contribution: Contribution,
    context: { timestamp: string; turnId?: string | null; itemId?: string | null },
  ): void => {
    let source = byKey.get(contribution.key);
    if (!source) {
      if (byKey.size >= MAX_SOURCES) return;
      const parsedUrl = contribution.url ? httpUrl(contribution.url) : null;
      const normalizedUrl = contribution.url ? normalizeSourceUrl(contribution.url) ?? undefined : undefined;
      const domain = parsedUrl ? parsedUrl.hostname.toLowerCase().replace(/^www\./, "") : undefined;
      source = {
        id: contribution.key,
        ...(contribution.url ? { url: contribution.url } : {}),
        ...(normalizedUrl ? { normalizedUrl } : {}),
        ...(domain ? { domain } : {}),
        ...(contribution.path ? { path: contribution.path } : {}),
        ...(contribution.lineStart !== undefined ? { lineStart: contribution.lineStart } : {}),
        ...(contribution.lineEnd !== undefined ? { lineEnd: contribution.lineEnd } : {}),
        title: contribution.title
          ?? (parsedUrl ? urlFallbackTitle(parsedUrl) : contribution.path ? fileName(contribution.path) : contribution.key),
        ...(contribution.snippet ? { snippet: contribution.snippet } : {}),
        ...(contribution.detail ? { detail: contribution.detail } : {}),
        kinds: [],
        queries: [],
        provider,
        turnIds: [],
        itemIds: [],
        cited: false,
        ...(contribution.attached ? { attached: true } : {}),
        firstSeenAt: context.timestamp,
      };
      byKey.set(contribution.key, source);
    } else {
      // Richest title wins: a real title beats a URL/file-name fallback, and a
      // longer real title beats a shorter one.
      if (contribution.title && contribution.title !== source.title) {
        const currentFallback = titleIsFallback(source, source.title);
        const incomingFallback = titleIsFallback(source, contribution.title);
        if (
          (currentFallback && !incomingFallback)
          || (currentFallback === incomingFallback && contribution.title.length > source.title.length)
        ) {
          source.title = contribution.title;
        }
      }
      if (contribution.snippet && (!source.snippet || contribution.snippet.length > source.snippet.length)) {
        source.snippet = contribution.snippet;
      }
      if (contribution.detail) source.detail = contribution.detail;
      if (source.lineStart === undefined && contribution.lineStart !== undefined) {
        source.lineStart = contribution.lineStart;
        if (contribution.lineEnd !== undefined) source.lineEnd = contribution.lineEnd;
      }
      if (!source.url && contribution.url) {
        source.url = contribution.url;
        source.normalizedUrl = normalizeSourceUrl(contribution.url) ?? undefined;
        source.domain = sourceDomain(contribution.url) ?? undefined;
      }
      if (!contribution.attached) delete source.attached;
    }
    pushUnique(source.kinds, contribution.kind);
    for (const query of contribution.queries ?? []) {
      if (source.queries.length >= MAX_QUERIES_PER_SOURCE) break;
      pushUnique(source.queries, query);
    }
    if (contribution.cited) source.cited = true;
    const turnId = text(context.turnId);
    const itemId = text(context.itemId);
    if (itemId) pushUnique(source.itemIds, itemId);
    if (turnId) {
      pushUnique(source.turnIds, turnId);
      if (contribution.countsTowardTurn) {
        let keys = turnCounted.get(turnId);
        if (!keys) {
          keys = new Set();
          turnCounted.set(turnId, keys);
        }
        keys.add(contribution.key);
      }
    }
  };

  // Assistant prose, one entry per message: fragments of a message join in
  // order, so a URL streamed across two fragments is whole again.
  const assistantProse = new Map<string, string[]>();

  for (const envelope of events) {
    const event = envelope.event;
    const timestamp = envelope.timestamp;

    if (event.type === "text") {
      if (!event.text) continue;
      const messageKey = text(event.messageId)
        ?? `${text(event.turnId) ?? ""}:${text(event.itemId) ?? ""}`;
      const fragments = assistantProse.get(messageKey);
      if (fragments) fragments.push(event.text);
      else assistantProse.set(messageKey, [event.text]);
      continue;
    }

    if (event.type === "user_message") {
      for (const attachment of event.attachments ?? []) {
        if (attachment.type === "image-url") {
          const normalizedUrl = normalizeSourceUrl(attachment.url);
          if (!normalizedUrl) continue;
          add({
            key: `url:${normalizedUrl}`,
            kind: "file",
            url: attachment.url.trim(),
            title: fileName(attachment.path) || undefined,
            attached: true,
            countsTowardTurn: false,
          }, { timestamp });
          continue;
        }
        const path = text(attachment.path);
        if (!path) continue;
        add({ key: `file:${path}`, kind: "file", path, attached: true, countsTowardTurn: false }, { timestamp });
      }
      for (const context of event.contextAttachments ?? []) {
        if (context.type !== "linear_issue") continue;
        const normalizedUrl = normalizeSourceUrl(context.issue.url);
        if (!normalizedUrl) continue;
        add({
          key: `url:${normalizedUrl}`,
          kind: "file",
          url: context.issue.url!.trim(),
          title: `${context.issue.identifier}: ${context.issue.title}`,
          attached: true,
          countsTowardTurn: false,
        }, { timestamp });
      }
      continue;
    }

    if (event.type === "web_search") {
      if (event.status === "failed") continue;
      const queries = webSearchQueries(event);
      const ctx = { timestamp, turnId: event.turnId, itemId: event.itemId };
      for (const action of event.actions ?? []) {
        const contribution = refContribution({
          kind: isPageAction(action.type) ? "fetched_url" : "web_search_result",
          ...(action.url ? { url: action.url } : {}),
          ...(action.title ? { title: action.title } : {}),
          ...(action.snippet ? { snippet: action.snippet } : {}),
        }, queries);
        if (contribution) add(contribution, ctx);
      }
      for (const result of event.results ?? []) {
        const contribution = refContribution({
          kind: "web_search_result",
          ...(result.url ? { url: result.url } : {}),
          ...(result.title ? { title: result.title } : {}),
          ...(result.snippet ? { snippet: result.snippet } : {}),
        }, queries);
        if (contribution) add(contribution, ctx);
      }
      continue;
    }

    if (event.type === "sources") {
      for (const ref of event.sources ?? []) {
        const contribution = refContribution(ref);
        if (contribution) add(contribution, { timestamp, turnId: event.turnId, itemId: event.itemId });
      }
      continue;
    }

    if (event.type !== "tool_call" && event.type !== "tool_result") continue;
    const ctx = { timestamp, turnId: event.turnId, itemId: event.itemId };
    if (event.type === "tool_result" && event.status !== "failed") {
      for (const ref of event.sources ?? []) {
        const contribution = refContribution(ref);
        if (contribution) add(contribution, ctx);
      }
    }
    const mcp = event.mcp ?? mcpByItemId.get(event.itemId) ?? legacyMcpSource(event.tool);
    if (!mcp) continue;
    mcpByItemId.set(event.itemId, mcp);
    // Codex treats its internal JavaScript execution host as transcript
    // plumbing, not a user-facing source or connected app.
    if (mcp.server.trim().toLowerCase() === "node_repl") continue;
    const appKey = `tool:${toolSourceKey(mcp)}`;
    const action = mcp.appContext?.actionName ?? mcp.tool;
    const existingApp = byKey.get(appKey);
    const actions = existingApp?.detail ? existingApp.detail.split(", ") : [];
    if (!actions.includes(action)) actions.push(action);
    add({
      key: appKey,
      kind: "tool",
      title: mcp.appContext?.appName ?? mcp.pluginId ?? mcp.server,
      detail: actions.join(", "),
      countsTowardTurn: false,
    }, ctx);
    const resourceUrl = normalizeSourceUrl(mcp.resourceUri);
    if (resourceUrl) {
      add({
        key: `url:${resourceUrl}`,
        kind: "tool",
        url: mcp.resourceUri!.trim(),
        title: mcp.appContext?.appName ?? mcp.pluginId ?? mcp.server,
        countsTowardTurn: true,
      }, ctx);
    }
    if (event.type === "tool_result" && event.status !== "failed") {
      for (const ref of mcpResultUrlRefs(event)) {
        const contribution = refContribution(ref);
        if (contribution) add({ ...contribution, kind: "tool" }, ctx);
      }
    }
  }

  // An answer that links to a source cites it, whatever the provider: only a
  // few send structured citations, but every model writes markdown links.
  // Links mark sources already in the list; a link alone never adds one.
  if (byKey.size > 0) {
    for (const fragments of assistantProse.values()) {
      for (const normalizedUrl of linkedSourceUrls(fragments.join(""))) {
        const source = byKey.get(`url:${normalizedUrl}`);
        if (source) source.cited = true;
      }
    }
  }

  const sources = [...byKey.values()];
  const cited: ChatSource[] = [];
  const web: ChatSource[] = [];
  const files: ChatSource[] = [];
  const apps: ChatSource[] = [];
  for (const source of sources) {
    const group = chatSourceGroup(source);
    if (group === "cited") cited.push(source);
    else if (group === "files") files.push(source);
    else if (group === "web") web.push(source);
    else apps.push(source);
  }
  const byTurn = new Map<string, ChatSource[]>();
  for (const [turnId, keys] of turnCounted) {
    const list: ChatSource[] = [];
    for (const key of keys) {
      const source = byKey.get(key);
      if (source && chatSourceGroup(source) !== "apps") list.push(source);
    }
    if (list.length) byTurn.set(turnId, list);
  }
  return { sources, cited, web, files, apps, total: sources.length, byTurn };
}

/** Which Sources section a source belongs to. Cited always comes first. */
export function chatSourceGroup(source: Pick<ChatSource, "cited" | "kinds" | "url" | "path">): ChatSourceGroup {
  if (source.cited) return "cited";
  if (source.kinds.includes("file") || (!source.url && source.path)) return "files";
  if (source.url) return "web";
  return "apps";
}

/** The letter drawn when there is no favicon: first letter of the domain or file name. */
export function chatSourceInitial(source: Pick<ChatSource, "domain" | "title" | "path">): string {
  const basis = source.domain ?? (source.path ? fileName(source.path) : source.title);
  const match = basis.match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? "•").toUpperCase();
}

/**
 * Whether a row's title already names its domain: a page reported without a
 * title falls back to `domain` or `domain/path`, and a provider may use the
 * bare host as the title. Printing the domain again under it is the "every
 * link twice" row.
 */
function titleNamesDomain(title: string, domain: string): boolean {
  const normalized = title.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  return normalized === domain || normalized.startsWith(`${domain}/`);
}

/**
 * Readable secondary text for a source row: domain, path:lines, or app
 * actions. Null when there is nothing the title does not already say.
 */
export function chatSourceSubtitle(source: ChatSource): string | null {
  if (source.domain) return titleNamesDomain(source.title, source.domain) ? null : source.domain;
  if (source.path) {
    if (source.lineStart !== undefined) {
      const range = source.lineEnd !== undefined && source.lineEnd !== source.lineStart
        ? `${source.lineStart}-${source.lineEnd}`
        : `${source.lineStart}`;
      return `${source.path}:${range}`;
    }
    return source.path;
  }
  return source.detail ?? null;
}
