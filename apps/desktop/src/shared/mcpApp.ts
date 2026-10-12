/**
 * MCP Apps (SEP-1865) — the parts every side shares.
 *
 * An MCP tool can declare a `ui://` resource. When the agent calls that tool,
 * ADE reads the resource (an HTML page) through the chat's own provider
 * session and shows it in the transcript, in a frame, talking JSON-RPC over
 * `postMessage`.
 *
 * The page is THIRD-PARTY code: the MCP server wrote it, not ADE and not the
 * agent. Everything here is written for that:
 *
 *   - it runs in the scene sandbox (`sandbox="allow-scripts"`, never
 *     `allow-same-origin`, an opaque origin of its own);
 *   - its Content-Security-Policy is built HERE, from the origins the resource
 *     declared, and from nothing else. No declaration means no network. See
 *     {@link buildMcpAppContentSecurityPolicy};
 *   - the frame names no server. A call it makes goes to the server its own
 *     stored record names, through the live chat session, or nowhere;
 *   - a call to a tool that is not marked read-only asks the user first, in
 *     the chat's native approval card;
 *   - `ui/message` only drafts text in the prompt box, and `ui/open-link` only
 *     opens a web page, both only right after a real click in the frame.
 *
 * Pure: no React, no Electron, no Node built-ins. The renderer, the main
 * process and the brain all import it.
 */

import type { SceneTheme } from "./chatScene";

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
export const MCP_APP_URI_SCHEME = "ui://";
/** The `ade_card` variant an app's transcript row carries. */
export const MCP_APP_CARD_VARIANT = "mcp_app";
/** `providerMetadata` key on the approval card for an app's tool call. */
export const MCP_APP_TOOL_CALL_METADATA_KEY = "mcpAppToolCall" as const;
/** What an app is told when its chat has no live session. */
export const MCP_APP_SESSION_NOT_RUNNING = "The chat that created this app is not running.";

export const MCP_APP_LIMITS = {
  /** Bytes of HTML one app may be. Bundled single-file apps run 200 KB to a few MB. */
  maxDocumentBytes: 4_000_000,
  /** Bytes of tool input or tool result kept with an app and replayed to it. */
  maxPayloadBytes: 512_000,
  /** Apps one chat keeps on disk; the oldest is dropped past this. */
  maxAppsPerChat: 40,
  /** Bytes of arguments an app may send with one tool call. */
  maxCallArgumentBytes: 256_000,
  /** Bytes of result one tool call or resource read may hand back to an app. */
  maxCallResultBytes: 2_000_000,
  /** Calls one app may have in flight at once. */
  maxConcurrentCalls: 4,
  /** How long the approval card waits before the call is refused. */
  approvalTimeoutMs: 180_000,
  /** Longest text `ui/message` may put in the prompt box. */
  maxMessageChars: 4_000,
  maxUrlChars: 2_048,
  /** Origins kept per CSP list. */
  maxCspDomains: 24,
  minHeight: 80,
  maxHeight: 800,
} as const;

/* ── Identity ── */

const CARD_ID_PREFIX = "mcp-app:";

/** The `ade_card` id for the app a tool call produced. */
export function mcpAppCardId(itemId: string): string {
  return `${CARD_ID_PREFIX}${itemId}`;
}

export function mcpAppItemIdFromCardId(cardId: string | null | undefined): string | null {
  if (typeof cardId !== "string" || !cardId.startsWith(CARD_ID_PREFIX)) return null;
  const itemId = cardId.slice(CARD_ID_PREFIX.length);
  return itemId.length ? itemId : null;
}

export function isMcpAppResourceUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(MCP_APP_URI_SCHEME) && value.length <= 2_048;
}

/**
 * Claude Code names an MCP tool `mcp__<server>__<tool>`, with every character
 * outside `[a-zA-Z0-9_-]` in the server's name turned into `_`.
 */
export function claudeMcpToolName(server: string, tool: string): string {
  const normalize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${normalize(server)}__${normalize(tool)}`;
}

/* ── Tool metadata ── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export type McpAppToolUiMeta = {
  resourceUri: string | null;
  /** Null when the tool declared none, which means model and app both. */
  visibility: Array<"model" | "app"> | null;
};

/**
 * The MCP Apps members of a tool's `_meta`: `ui.resourceUri` (or the
 * deprecated flat `ui/resourceUri`) and `ui.visibility`.
 */
export function readMcpToolUiMeta(meta: unknown): McpAppToolUiMeta {
  const record = asRecord(meta);
  const ui = asRecord(record?.ui);
  const nested = ui?.resourceUri;
  const flat = record?.["ui/resourceUri"];
  const resourceUri = isMcpAppResourceUri(nested) ? nested : isMcpAppResourceUri(flat) ? flat : null;
  const rawVisibility = ui?.visibility;
  const visibility = Array.isArray(rawVisibility)
    ? rawVisibility.filter((entry): entry is "model" | "app" => entry === "model" || entry === "app")
    : null;
  return { resourceUri, visibility };
}

/** One tool of one MCP server, as the live provider session reports it. */
export type McpAppToolDescriptor = {
  server: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  /** True only when the server marked the tool read-only. Absent annotations are not read-only. */
  readOnly: boolean;
  ui: McpAppToolUiMeta;
};

/** May an app call this tool at all? The spec's visibility rule. */
export function mcpAppMayCallTool(tool: McpAppToolDescriptor): boolean {
  return tool.ui.visibility === null || tool.ui.visibility.includes("app");
}

/* ── Content-Security-Policy ── */

export type McpAppCsp = {
  connectDomains: string[];
  resourceDomains: string[];
};

export const MCP_APP_NO_NETWORK_CSP: McpAppCsp = { connectDomains: [], resourceDomains: [] };

/**
 * One declared origin, or null when it is not one ADE will put in a policy.
 *
 * A CSP is a string, and a declared "domain" is text a third party wrote, so
 * this is an allowlist of shape and not a blocklist of bad characters: a
 * scheme from the list, a host of plain DNS labels (the first may be `*`), an
 * optional port, and nothing after it. No path, no query, no quotes, no
 * spaces, no `;`, no keyword such as `'unsafe-eval'`, no bare `*`, no `data:`.
 * Local hosts are refused: a page from a remote server has no business
 * reaching a service on this computer.
 */
export function sanitizeMcpAppCspOrigin(value: unknown, schemes: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  const match = /^([a-z]+):\/\/((?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(:\d{1,5})?\/?$/i
    .exec(value.trim());
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase();
  if (!schemes.includes(scheme)) return null;
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  // An IP literal is all digits and dots; a public origin has a name.
  if (/^[\d.]+$/.test(bare)) return null;
  if (bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".local") || bare.endsWith(".internal")) return null;
  // `*.com` would be every site there is.
  if (host.startsWith("*.") && bare.split(".").length < 2) return null;
  return `${scheme}://${host}${match[3] ?? ""}`;
}

function sanitizeOriginList(value: unknown, schemes: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const entry of value) {
    const origin = sanitizeMcpAppCspOrigin(entry, schemes);
    if (origin) out.add(origin);
    if (out.size >= MCP_APP_LIMITS.maxCspDomains) break;
  }
  return [...out];
}

/**
 * The origins a resource declared, reduced to the ones ADE honours.
 *
 * `connectDomains` and `resourceDomains` only. `frameDomains` and
 * `baseUriDomains` are dropped on purpose: an app here nests no frames and
 * sets no base URI, which the spec allows a host to decide ("MAY further
 * restrict").
 */
export function sanitizeMcpAppCsp(declared: unknown): McpAppCsp {
  const record = asRecord(declared);
  if (!record) return { connectDomains: [], resourceDomains: [] };
  return {
    connectDomains: sanitizeOriginList(record.connectDomains, ["https", "wss"]),
    resourceDomains: sanitizeOriginList(record.resourceDomains, ["https"]),
  };
}

/**
 * The policy an app's document is served with.
 *
 * The spec's construction, with three things left out, each narrower than the
 * spec: `'self'` (the frame's origin is opaque, so it would name nothing),
 * nested frames, and a base URI. There is no `'unsafe-eval'`, no `blob:`, no
 * worker source and no form target. A resource that declared nothing gets
 * `connect-src 'none'` and inline-only script and style: it cannot reach the
 * network at all.
 *
 * Every origin passes through {@link sanitizeMcpAppCsp} again here, so a
 * caller cannot hand this a list it did not sanitize.
 */
export function buildMcpAppContentSecurityPolicy(declared: unknown): string {
  const { connectDomains, resourceDomains } = sanitizeMcpAppCsp(declared);
  const resources = resourceDomains.length ? ` ${resourceDomains.join(" ")}` : "";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${resources}`,
    `style-src 'unsafe-inline'${resources}`,
    `img-src data:${resources}`,
    `media-src data:${resources}`,
    `font-src${resources || " 'none'"}`,
    `connect-src ${connectDomains.length ? connectDomains.join(" ") : "'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/* ── The stored app ── */

/** A tool result in the shape the spec replays to an app (`CallToolResult`). */
export type McpAppToolResult = {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
};

/**
 * A provider's tool result as a `CallToolResult`.
 *
 * Codex hands over the MCP result as the server sent it. Claude hands over
 * `{ content: <text>, structuredContent }`, the text already flattened, so the
 * text becomes one text block.
 */
export function toMcpAppToolResult(value: unknown, isError = false): McpAppToolResult {
  const record = asRecord(value);
  const rawContent = record?.content;
  let content: unknown[] = [];
  if (Array.isArray(rawContent)) content = rawContent;
  else if (typeof rawContent === "string") content = rawContent.length ? [{ type: "text", text: rawContent }] : [];
  else if (typeof value === "string") content = value.length ? [{ type: "text", text: value }] : [];
  const structured = record?.structuredContent;
  return {
    content,
    ...(structured !== undefined && structured !== null ? { structuredContent: structured } : {}),
    ...(isError || record?.isError === true ? { isError: true } : {}),
    ...(record?._meta !== undefined && record._meta !== null ? { _meta: record._meta } : {}),
  };
}

/** Everything a client needs to show one app. Read through `chat.getMcpApp`. */
export type McpAppDocument = {
  sessionId: string;
  /** The tool call that produced the app. */
  itemId: string;
  provider: "claude" | "codex";
  server: string;
  tool: string;
  toolTitle: string | null;
  toolDescription: string | null;
  toolInputSchema: unknown;
  resourceUri: string;
  html: string;
  /** Already sanitized; the policy is still rebuilt where the document is served. */
  csp: McpAppCsp;
  prefersBorder: boolean | null;
  toolInput: Record<string, unknown>;
  /** Null when the result was too large to keep. */
  toolResult: McpAppToolResult | null;
  createdAt: string;
};

export type McpAppGetArgs = { sessionId: string; itemId: string };
export type McpAppGetResult =
  | { status: "ready"; app: McpAppDocument }
  | { status: "unavailable"; reason: string };

export type McpAppRequestMethod = "tools/call" | "resources/read";
export type McpAppRequestArgs = {
  sessionId: string;
  itemId: string;
  method: McpAppRequestMethod;
  params: unknown;
};
/** A JSON-RPC result or error, ready to post back to the frame. */
export type McpAppRequestResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: number; message: string } };

/** JSON-RPC's implementation-defined error, the code the spec uses for a refusal. */
export const MCP_APP_ERROR_REFUSED = -32000;
export const MCP_APP_ERROR_METHOD_NOT_FOUND = -32601;
export const MCP_APP_ERROR_INVALID_PARAMS = -32602;

export function mcpAppRefusal(message: string, code: number = MCP_APP_ERROR_REFUSED): McpAppRequestResult {
  return { ok: false, error: { code, message } };
}

/* ── Frame messages ── */

export type McpAppFrameMessage =
  | { kind: "request"; id: string | number; method: string; params: Record<string, unknown> }
  | { kind: "notification"; method: string; params: Record<string, unknown> }
  | { kind: "response"; id: string | number };

/**
 * Shape-check one message from an app frame. The frame is untrusted: anything
 * that is not a JSON-RPC 2.0 request, notification or response is dropped.
 */
export function parseMcpAppFrameMessage(value: unknown): McpAppFrameMessage | null {
  const record = asRecord(value);
  if (!record || record.jsonrpc !== "2.0") return null;
  const id = typeof record.id === "string" && record.id.length <= 120
    ? record.id
    : typeof record.id === "number" && Number.isFinite(record.id) ? record.id : null;
  if (typeof record.method === "string") {
    const method = record.method;
    if (!method.length || method.length > 120) return null;
    const params = asRecord(record.params) ?? {};
    return id === null ? { kind: "notification", method, params } : { kind: "request", id, method, params };
  }
  if (id !== null && ("result" in record || "error" in record)) return { kind: "response", id };
  return null;
}

/**
 * The text of a `ui/message`. The spec draws `content` as one block and the
 * official SDK sends an array of blocks; both are read, and only text counts.
 */
export function readMcpAppMessageText(params: Record<string, unknown>): string | null {
  if (params.role !== undefined && params.role !== "user") return null;
  const blocks = Array.isArray(params.content) ? params.content : [params.content];
  const text = blocks
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((part) => part.trim().length)
    .join("\n")
    .trim();
  if (!text.length || text.length > MCP_APP_LIMITS.maxMessageChars) return null;
  return text;
}

/** A web link an app may ask to open: http(s) only, bounded. */
export function readMcpAppOpenLinkUrl(params: Record<string, unknown>): string | null {
  const url = typeof params.url === "string" ? params.url.trim() : "";
  if (!url.length || url.length > MCP_APP_LIMITS.maxUrlChars) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** A size report from the frame, clamped. */
export function readMcpAppHeight(params: Record<string, unknown>): number | null {
  const height = params.height;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
  return Math.max(MCP_APP_LIMITS.minHeight, Math.min(MCP_APP_LIMITS.maxHeight, Math.round(height)));
}

/* ── Theme ── */

/**
 * ADE's theme as the spec's standard CSS variables.
 *
 * Resolved values only: the frame is another origin and cannot read ADE's
 * stylesheet. `color-mix` over resolved colors is fine, it means the same
 * thing on the other side.
 */
export function mcpAppStyleVariables(theme: SceneTheme): Record<string, string> {
  const tint = (color: string) => `color-mix(in srgb, ${color} 14%, ${theme.bg})`;
  const size = theme.fontSize;
  const px = (value: number) => `${Math.round(value * 10) / 10}px`;
  return {
    "--color-background-primary": theme.bg,
    "--color-background-secondary": theme.surface,
    "--color-background-tertiary": `color-mix(in srgb, ${theme.fg} 8%, transparent)`,
    "--color-background-inverse": theme.fg,
    "--color-background-ghost": "transparent",
    "--color-background-info": tint(theme.accent),
    "--color-background-danger": tint(theme.danger),
    "--color-background-success": tint(theme.success),
    "--color-background-warning": tint(theme.warning),
    "--color-background-disabled": theme.surface,
    "--color-text-primary": theme.fg,
    "--color-text-secondary": theme.fgMuted,
    "--color-text-tertiary": theme.fgMuted,
    "--color-text-inverse": theme.bg,
    "--color-text-info": theme.accent,
    "--color-text-danger": theme.danger,
    "--color-text-success": theme.success,
    "--color-text-warning": theme.warning,
    "--color-text-disabled": theme.fgMuted,
    "--color-text-ghost": theme.fgMuted,
    "--color-border-primary": theme.border,
    "--color-border-secondary": theme.border,
    "--color-border-tertiary": theme.border,
    "--color-border-inverse": theme.fg,
    "--color-border-ghost": "transparent",
    "--color-border-info": theme.accent,
    "--color-border-danger": theme.danger,
    "--color-border-success": theme.success,
    "--color-border-warning": theme.warning,
    "--color-border-disabled": theme.border,
    "--color-ring-primary": theme.accent,
    "--color-ring-secondary": theme.border,
    "--color-ring-inverse": theme.fg,
    "--color-ring-info": theme.accent,
    "--color-ring-danger": theme.danger,
    "--color-ring-success": theme.success,
    "--color-ring-warning": theme.warning,
    "--font-sans": theme.fontSans,
    "--font-mono": theme.fontMono,
    "--font-weight-normal": "400",
    "--font-weight-medium": "500",
    "--font-weight-semibold": "600",
    "--font-weight-bold": "700",
    "--font-text-xs-size": px(size - 2),
    "--font-text-sm-size": px(size - 1),
    "--font-text-md-size": px(size),
    "--font-text-lg-size": px(size + 2),
    "--font-heading-xs-size": px(size),
    "--font-heading-sm-size": px(size + 1),
    "--font-heading-md-size": px(size + 3),
    "--font-heading-lg-size": px(size + 5),
    "--font-heading-xl-size": px(size + 8),
    "--font-heading-2xl-size": px(size + 12),
    "--font-heading-3xl-size": px(size + 17),
    "--font-text-xs-line-height": "1.4",
    "--font-text-sm-line-height": "1.45",
    "--font-text-md-line-height": "1.5",
    "--font-text-lg-line-height": "1.5",
    "--font-heading-xs-line-height": "1.35",
    "--font-heading-sm-line-height": "1.35",
    "--font-heading-md-line-height": "1.3",
    "--font-heading-lg-line-height": "1.25",
    "--font-heading-xl-line-height": "1.2",
    "--font-heading-2xl-line-height": "1.15",
    "--font-heading-3xl-line-height": "1.1",
    "--border-radius-xs": "2px",
    "--border-radius-sm": "4px",
    "--border-radius-md": "6px",
    "--border-radius-lg": "8px",
    "--border-radius-xl": "12px",
    "--border-radius-full": "9999px",
    "--border-width-regular": "1px",
    "--shadow-hairline": `0 0 0 1px ${theme.border}`,
    "--shadow-sm": "0 1px 2px rgba(0,0,0,0.12)",
    "--shadow-md": "0 4px 12px rgba(0,0,0,0.16)",
    "--shadow-lg": "0 12px 32px rgba(0,0,0,0.22)",
  };
}

/** The part of the host context that follows ADE's theme. */
export function mcpAppThemeContext(theme: SceneTheme): { theme: "light" | "dark"; styles: { variables: Record<string, string> } } {
  return { theme: theme.scheme, styles: { variables: mcpAppStyleVariables(theme) } };
}
