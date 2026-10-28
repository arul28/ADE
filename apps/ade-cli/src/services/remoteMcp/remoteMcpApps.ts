import { createHash } from "node:crypto";
import { APP_CSS, APP_JS } from "./remoteMcpAppSource";

/**
 * ADE MCP's custom UI, per MCP Apps (SEP-1865, extension
 * `io.modelcontextprotocol/ui`, spec version 2026-01-26).
 *
 * One self-contained HTML view serves every tool that has one: hosts that
 * support MCP Apps (Claude, ChatGPT, VS Code Copilot, Goose) read the tool's
 * `_meta.ui.resourceUri`, fetch the resource with `resources/read` and render
 * the tool result in it; every other client ignores `_meta` and keeps today's
 * text and structuredContent. The view picks what to draw from the tool name
 * (host context) or the result's shape.
 */

/** MCP Apps' resource MIME type. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The tools whose results the view can draw. */
const UI_TOOL_NAMES = new Set([
  "inbox",
  "chat_list",
  "chat_read",
  "chat_respond",
  "chat_send",
  "chat_start",
  "prs_list",
  "prs_show",
  "prs_checks",
  "lanes_list",
  "diff_changes",
  "diff_patch",
  "usage_limits",
  "machines_list",
]);

function buildHtml(): string {
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<meta name=\"color-scheme\" content=\"light dark\"><title>ADE</title>"
    + `<style>${APP_CSS}</style></head><body><div id="app"></div><script>${APP_JS}</script></body></html>`;
}

const APP_HTML = buildHtml();

/**
 * The resource URI carries a hash of the HTML: hosts may cache a UI resource,
 * so a new ADE version names a new resource rather than serving a stale view.
 * `resources/read` answers any `ui://ade/app…html`, so a host holding an older
 * tool list still gets today's view.
 */
export const ADE_APP_RESOURCE_URI = `ui://ade/app-${createHash("sha256").update(APP_HTML).digest("hex").slice(0, 8)}.html`;

const ADE_APP_URI_PATTERN = /^ui:\/\/ade\/app(?:-[0-9a-f]{8})?\.html$/;

/**
 * `_meta.ui` for the resource. No `csp`: the view loads nothing from the
 * network, so the host's restrictive default applies. No border from the
 * host: the view draws ADE's own card edge.
 */
const RESOURCE_UI_META = { prefersBorder: false };

/** The `resources/list` entry. */
export function adeAppResourceListing() {
  return {
    uri: ADE_APP_RESOURCE_URI,
    name: "ade-app",
    title: "ADE",
    description: "ADE's view for chats, questions and approvals, pull requests, lanes, diffs, usage and computers.",
    mimeType: MCP_APP_MIME_TYPE,
    _meta: { ui: RESOURCE_UI_META },
  };
}

/** The `resources/read` answer for the view, or null when `uri` names something else. */
export function readAdeAppResource(uri: unknown) {
  if (typeof uri !== "string" || !ADE_APP_URI_PATTERN.test(uri)) return null;
  return {
    contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: APP_HTML, _meta: { ui: RESOURCE_UI_META } }],
  };
}

/**
 * A tool definition with the view attached when it has one. Sets both the
 * nested `_meta.ui.resourceUri` and the deprecated flat `_meta["ui/resourceUri"]`
 * that the ext-apps SDK's `registerAppTool` still writes for older hosts.
 */
export function withAppUi<T extends { name: string; _meta?: Record<string, unknown> }>(tool: T): T {
  if (!UI_TOOL_NAMES.has(tool.name)) return tool;
  const meta = tool._meta ?? {};
  const ui = meta.ui && typeof meta.ui === "object" ? meta.ui as Record<string, unknown> : {};
  return {
    ...tool,
    _meta: { ...meta, ui: { ...ui, resourceUri: ADE_APP_RESOURCE_URI }, "ui/resourceUri": ADE_APP_RESOURCE_URI },
  };
}
