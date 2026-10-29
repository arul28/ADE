import { createHash } from "node:crypto";
import { PROVIDER_COLOR_TABLE } from "../../../../desktop/src/shared/providerColors";
import { usageLimitResumeProviderLabel } from "../../../../desktop/src/shared/usageLimitResumePresentation";
import type { AppBootData } from "./remoteMcpApp/types";
import { APP_CSS, APP_JS } from "./remoteMcpApp/app.generated";
import { TOOLS_WITH_VIEWS } from "./remoteMcpTools";

/**
 * ADE MCP's custom UI, per MCP Apps (SEP-1865, extension
 * `io.modelcontextprotocol/ui`, spec version 2026-01-26).
 *
 * One self-contained HTML view serves every tool that has one: hosts that
 * support MCP Apps (Claude, ChatGPT, VS Code Copilot, Goose) read the tool's
 * `_meta.ui.resourceUri`, fetch the resource with `resources/read` and render
 * the tool result in it; every other client ignores `_meta` and keeps today's
 * text and structuredContent. The view picks what to draw from the tool name
 * (host context, else `structuredContent.view`).
 *
 * The view's source is `remoteMcpApp/app.ts` and `app.css`, built into
 * `app.generated.ts` by `npm run mcp-app:build`.
 */

/** MCP Apps' resource MIME type. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * ADE's own provider colours and names, so the view's swatches match the
 * desktop's usage bars. Names cover every provider either colour table knows.
 */
function bootData(): AppBootData {
  const providers = new Set([...Object.keys(PROVIDER_COLOR_TABLE.usage), ...Object.keys(PROVIDER_COLOR_TABLE.group)]);
  return {
    providerColors: PROVIDER_COLOR_TABLE.usage,
    providerColorFallback: PROVIDER_COLOR_TABLE.usageFallback,
    providerLabels: Object.fromEntries([...providers].map((provider) => [provider, usageLimitResumeProviderLabel(provider)])),
  };
}

function buildHtml(): string {
  // `<` escaped so no value can close the script element early.
  const data = JSON.stringify(bootData()).replace(/</g, "\\u003c");
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<meta name=\"color-scheme\" content=\"light dark\"><title>ADE</title>"
    + `<style>${APP_CSS}</style></head><body><div id="app"></div>`
    + `<script type="application/json" id="ade-app-data">${data}</script>`
    + `<script>${APP_JS}</script></body></html>`;
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
  if (!TOOLS_WITH_VIEWS.has(tool.name)) return tool;
  const meta = tool._meta ?? {};
  const ui = meta.ui && typeof meta.ui === "object" ? meta.ui as Record<string, unknown> : {};
  return {
    ...tool,
    _meta: { ...meta, ui: { ...ui, resourceUri: ADE_APP_RESOURCE_URI }, "ui/resourceUri": ADE_APP_RESOURCE_URI },
  };
}
