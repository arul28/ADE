/**
 * The entry of ADE MCP's one MCP Apps view (`ui://ade/app-….html`), run inside
 * the host's sandboxed iframe: it routes a tool result to its view and runs
 * the handshake. `scripts/generate-remote-mcp-app.mjs` bundles this folder
 * from here (types stripped, minified, one IIFE) into `app.generated.ts`,
 * which `remoteMcpApps.ts` puts in one document with `app.css`. Run
 * `npm run mcp-app:build` after editing any file here; `mcp-app:check` fails
 * when the generated file is stale.
 *
 * The view speaks the MCP Apps postMessage protocol itself (SEP-1865, spec
 * 2026-01-26, `host.ts`), builds every node with textContent, never innerHTML,
 * so nothing in a tool result can run (`dom.ts`), and loads nothing: the only
 * imports from outside this folder are types. Each view reads the one result
 * shape its tool documents in `remoteMcpTools.ts` (the `// result:` comments)
 * or `remoteMcpProtocol.ts` (`machines_list`, `machine: "all"`); `types.ts`
 * names them.
 */
import { viewChatList, viewChatRead } from "./chatViews";
import { h, isObj, mount, rows, str } from "./dom";
import { NO_SCOPE, renderNote, setRenderer, state, viewKv, viewText } from "./frame";
import { PROTOCOL, applyCtx, ctx, hostCaps, notify, reportSize, request, resultText, setNotificationHandler } from "./host";
import { viewInbox } from "./inboxView";
import { viewDiffChanges, viewDiffPatch, viewLanes } from "./laneViews";
import { viewChecks, viewPrList, viewPrShow } from "./prViews";
import type { Envelope, FanOutRow, Json, MachineRef, Scope, ToolResult } from "./types";
import { viewMachines, viewUsage } from "./usageViews";
import { respondLine, sendLine, startLine, viewWrite } from "./writeViews";

const TITLES: Record<string, string> = {
  inbox: "Needs you", chat_list: "Chats", chat_read: "Chat", chat_respond: "Answer", chat_send: "Message", chat_start: "New chat",
  prs_list: "Pull requests", prs_show: "Pull request", prs_checks: "Checks", lanes_list: "Lanes", diff_changes: "Changes",
  diff_patch: "Diff", usage_limits: "Usage limits", machines_list: "Computers",
};
/** One view per tool, each reading that tool's `result`. */
const VIEWS: Record<string, (r: unknown, scope: Scope) => HTMLElement> = {
  inbox: viewInbox,
  chat_list: viewChatList,
  chat_read: viewChatRead,
  prs_checks: viewChecks,
  prs_list: viewPrList,
  prs_show: viewPrShow,
  lanes_list: viewLanes,
  diff_changes: viewDiffChanges,
  diff_patch: viewDiffPatch,
  usage_limits: viewUsage,
  chat_respond: (r, scope) => viewWrite(respondLine(isObj(r) ? r : {}), scope),
  chat_send: (r, scope) => viewWrite(sendLine(isObj(r) ? r : {}), scope),
  chat_start: (r, scope) => viewWrite(startLine(isObj(r) ? r : {}), scope),
};
function scopeOf(env: Partial<Envelope>, machine?: MachineRef): Scope {
  const p = isObj(env.project) ? env.project : null;
  const m = isObj(env.machine) ? env.machine : machine ?? null;
  return {
    projectId: str(p?.id), projectName: str(p?.name), projectPath: str(p?.path),
    machineKey: str(m?.key), machineName: str(m?.name) ?? str(m?.key),
  };
}
/** A typed tool's Envelope in its tool's view; any other result in the key/value card. */
function viewEnvelope(tool: string | null, env: Partial<Envelope>, machine?: MachineRef): HTMLElement {
  const scope = scopeOf(env, machine);
  const view = tool ? VIEWS[tool] : undefined;
  if (view && "result" in env) return view(env.result ?? null, scope);
  return viewKv((tool && TITLES[tool]) || "Result", "result" in env ? env.result : env, scope);
}
/** `machine: "all"`: one group per computer, each in the tool's own view. */
function viewFanOut(tool: string | null, sc: Json): HTMLElement {
  const wrap = h("div");
  for (const row of rows<FanOutRow>(sc.machines)) {
    const machine: MachineRef = isObj(row.machine) ? row.machine : { key: "", name: "" };
    const group = h("div", { cls: "mgroup" });
    if (row.ok && isObj(row.result)) group.appendChild(viewEnvelope(tool, row.result, machine));
    else {
      group.appendChild(h("section", { cls: "card" },
        h("div", { cls: "head" }, h("span", { cls: "dot", "data-s": "crit" }), h("span", { cls: "lbl" }, str(machine.name) || "Computer")),
        h("div", { cls: "err", style: "padding:0 14px 12px" }, str(row.error) || "No answer from this computer.")));
    }
    wrap.appendChild(group);
  }
  return wrap;
}
/** The tool on screen: the one drilled into, else the host's, else the result's own `view`. */
function currentTool(sc: unknown): string | null {
  if (state.tool) return state.tool;
  const hostTool = ctx.toolInfo?.tool?.name;
  if (typeof hostTool === "string" && hostTool) return hostTool;
  return isObj(sc) && typeof sc.view === "string" ? sc.view : null;
}
function render(): void {
  const res: ToolResult = state.result ?? {};
  const sc = res.structuredContent;
  const tool = currentTool(sc);
  const title = (tool && TITLES[tool]) || "ADE";
  try {
    if (res.isError) mount(viewText(title, resultText(res) || "That did not work.", true, isObj(sc) ? scopeOf(sc) : NO_SCOPE));
    else if (!isObj(sc)) mount(viewText(title, resultText(res), false, NO_SCOPE));
    else if (tool === "machines_list") mount(viewMachines(sc));
    // Only a fan-out answers with `machines` and no `result`.
    else if (Array.isArray(sc.machines) && !("result" in sc)) mount(viewFanOut(tool, sc));
    else mount(viewEnvelope(tool, sc));
  } catch (e) {
    mount(viewText("ADE", resultText(res) || String(e instanceof Error ? e.message : e), false, NO_SCOPE));
  }
}
function renderLoading(): void {
  const t = ctx.toolInfo?.tool?.name;
  const label = typeof t === "string" ? TITLES[t] : undefined;
  mount(h("section", { cls: "card" }, h("div", { cls: "muted-load" }, (label ? label + ": " : "") + "Asking ADE…")));
}


/* ---------- notifications and handshake ---------- */

setNotificationHandler((method, params) => {
  if (method === "ui/notifications/tool-input") {
    state.args = isObj(params.arguments) ? params.arguments : {};
    if (!state.result) renderLoading();
  } else if (method === "ui/notifications/tool-result") {
    state.result = params as ToolResult;
    state.tool = null;
    state.title = null;
    state.stack = [];
    render();
  } else if (method === "ui/notifications/tool-cancelled") {
    if (!state.result) renderNote("Cancelled.");
  } else if (method === "ui/notifications/host-context-changed") {
    Object.assign(ctx, params);
    applyCtx();
  }
});
setRenderer(render);
applyCtx();
request("ui/initialize", { appInfo: { name: "ade", version: "1" }, appCapabilities: { availableDisplayModes: ["inline"] }, protocolVersion: PROTOCOL }, 30000)
  .then((value) => {
    const init = isObj(value) ? value : {};
    if (isObj(init.hostContext)) Object.assign(ctx, init.hostContext);
    if (isObj(init.hostCapabilities)) Object.assign(hostCaps, init.hostCapabilities);
    applyCtx();
    notify("ui/notifications/initialized", {});
    if (state.result) render();
    reportSize();
  })
  .catch(() => { applyCtx(); reportSize(); });
