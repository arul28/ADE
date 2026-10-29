/** Building nodes (textContent only), reading values, and ADE's provider colours and names. */
import { currentTheme, reportSize } from "./host";
import type { AppBootData, Json } from "./types";

const root = document.getElementById("app")!;

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, string | number | boolean | null | undefined | ((ev: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "cls") el.className = String(v);
      else if (k === "text") el.textContent = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children) add(el, c);
  return el;
}
/** A list row you can press: the list item wraps a real button, so it reads as one. */
export function listButton(props: Props, ...children: Child[]): HTMLDivElement {
  return h("div", { role: "listitem" }, h("button", { type: "button", ...props }, ...children));
}
function add(el: Node, c: Child): void {
  if (c === undefined || c === null || c === false) return;
  if (Array.isArray(c)) { for (const x of c) add(el, x); return; }
  el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
}
export function mount(node: Node): void {
  root.textContent = "";
  root.appendChild(node);
  reportSize();
}

export function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
/** A trimmed non-empty string, or a finite number as text; null otherwise. */
export function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  return typeof v === "number" && Number.isFinite(v) ? String(v) : null;
}
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/** The object rows of a list the shape says is an array. */
export function rows<T>(v: unknown): T[] {
  return Array.isArray(v) ? v.filter(isObj) as T[] : [];
}
export function plural(n: number, word: string): string {
  return n + " " + word + (n === 1 ? "" : "s");
}
export function rel(iso: unknown): string {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 86400 * 30) return Math.floor(s / 86400) + "d";
  return new Date(t).toLocaleDateString();
}
export function dur(min: number | null): string {
  if (min === null) return "";
  const m = Math.max(0, Math.round(min));
  const d = Math.floor(m / 1440);
  const hh = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return d + "d " + hh + "h";
  if (hh) return hh + "h " + mm + "m";
  return mm + "m";
}
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function modelName(m: unknown): string {
  const s = str(m);
  if (!s) return "";
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}
export function safeLink(v: unknown): string | null {
  const u = str(v);
  return u && /^(https?:|ade:)/i.test(u) ? u : null;
}

const BOOT = readBootData();
function readBootData(): AppBootData {
  try {
    const v: unknown = JSON.parse(document.getElementById("ade-app-data")?.textContent ?? "");
    if (isObj(v) && isObj(v.providerColors) && Array.isArray(v.providerColorFallback) && isObj(v.providerLabels)) return v as AppBootData;
  } catch { /* fall through to no colours */ }
  return { providerColors: {}, providerColorFallback: [], providerLabels: {} };
}
/** Same pick as the desktop's `providerColor` (renderer/components/usage/providerColors.ts). */
export function providerColor(provider: string): string {
  const key = provider.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const fallback = BOOT.providerColorFallback;
  const pair = BOOT.providerColors[key] ?? (fallback.length ? fallback[hash % fallback.length] : undefined);
  if (!pair) return "var(--fill)";
  return currentTheme() === "light" ? pair.light : pair.dark;
}
export function providerName(provider: string): string {
  const key = provider.trim().toLowerCase();
  return BOOT.providerLabels[key] ?? (key ? capitalize(key) : "Other");
}
