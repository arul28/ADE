/** The MCP Apps postMessage transport, the host context (theme, styles, size) and calls through the host. */
import { isObj } from "./dom";
import type { HostContext, Json, RpcMessage, ToolResult } from "./types";

export const PROTOCOL = "2026-01-26";
const parentWin = window.parent;
let nextId = 1;
const pending: Record<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = {};
/** The host context (`ui/initialize`, then `host-context-changed`). */
export const ctx: HostContext = {};
/** The host's capabilities from `ui/initialize`. */
export const hostCaps: Json = {};
/** Where notifications go; `app.ts` sets it. */
let onNotification: (method: string, params: Json) => void = () => {};
export function setNotificationHandler(handler: (method: string, params: Json) => void): void {
  onNotification = handler;
}

function post(msg: Json): void {
  try { parentWin.postMessage(msg, "*"); } catch { /* the host went away */ }
}
export function request(method: string, params: Json, timeoutMs: number): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { delete pending[id]; reject(new Error("The host did not answer.")); }, timeoutMs);
    pending[id] = {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    };
    post({ jsonrpc: "2.0", id, method, params });
  });
}
export function notify(method: string, params: Json): void {
  post({ jsonrpc: "2.0", method, params });
}
window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== parentWin) return;
  const m = ev.data as RpcMessage | null;
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
  if (m.method === undefined && typeof m.id === "number") {
    const p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.error) p.reject(new Error(m.error.message || "Request failed"));
    else p.resolve(m.result);
    return;
  }
  if (typeof m.method !== "string") return;
  if (m.id !== undefined && m.id !== null) {
    if (m.method === "ping" || m.method === "ui/resource-teardown") post({ jsonrpc: "2.0", id: m.id, result: {} });
    else post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: " + m.method } });
    return;
  }
  onNotification(m.method, m.params ?? {});
});

let fontsApplied = false;
export function currentTheme(): "light" | "dark" {
  if (ctx.theme === "light" || ctx.theme === "dark") return ctx.theme;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
export function applyCtx(): void {
  const de = document.documentElement;
  const theme = currentTheme();
  de.setAttribute("data-theme", theme);
  de.style.colorScheme = theme;
  const vars = ctx.styles?.variables;
  if (isObj(vars)) {
    for (const k of Object.keys(vars)) {
      const v = vars[k];
      if (/^--[a-z0-9-]+$/.test(k) && typeof v === "string") de.style.setProperty(k, v);
    }
  }
  const fonts = ctx.styles?.css?.fonts;
  if (typeof fonts === "string" && fonts && !fontsApplied) {
    const st = document.createElement("style");
    st.textContent = fonts;
    document.head.appendChild(st);
    fontsApplied = true;
  }
  const cd = ctx.containerDimensions ?? {};
  const fixed = typeof cd.height === "number";
  de.style.height = fixed ? "100vh" : "";
  de.style.maxHeight = typeof cd.maxHeight === "number" ? cd.maxHeight + "px" : "";
  document.body.style.overflow = fixed ? "auto" : "";
  if (fixed) document.body.style.height = "100vh";
}
let lastW = 0;
let lastH = 0;
let sizeQueued = false;
export function reportSize(): void {
  if (sizeQueued) return;
  sizeQueued = true;
  requestAnimationFrame(() => {
    sizeQueued = false;
    const de = document.documentElement;
    const old = de.style.height;
    de.style.height = "max-content";
    const height = Math.ceil(de.getBoundingClientRect().height);
    de.style.height = old;
    const width = Math.ceil(window.innerWidth);
    if (width !== lastW || height !== lastH) {
      lastW = width;
      lastH = height;
      notify("ui/notifications/size-changed", { width, height });
    }
  });
}
if (typeof ResizeObserver === "function") {
  const ro = new ResizeObserver(reportSize);
  ro.observe(document.documentElement);
  ro.observe(document.body);
}

export function canCallTools(): boolean {
  return !!hostCaps.serverTools;
}
export function callTool(name: string, args: Json): Promise<ToolResult | null> {
  return request("tools/call", { name, arguments: args }, 180000) as Promise<ToolResult | null>;
}
export function openLink(url: string): void {
  if (!/^(https?:|ade:)/i.test(url)) return;
  request("ui/open-link", { url }, 15000).catch(() => { /* the host refused */ });
}
export function resultText(res: ToolResult | null): string {
  const content = res && Array.isArray(res.content) ? res.content : [];
  return content.filter((x) => x && x.type === "text").map((x) => x.text ?? "").join("\n")
    .replace(/^(\[(project|projects|machine):[^\]\n]*\]\n?)+/, "").trim();
}
