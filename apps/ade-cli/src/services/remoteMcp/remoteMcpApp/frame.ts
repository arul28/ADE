/** The view state, drilling and Back, and the card frame every view draws in. */
import { h, isObj, mount } from "./dom";
import { callTool, canCallTools, reportSize } from "./host";
import type { Json, Scope, Shown } from "./types";

/** What is on screen; `stack` holds what Back returns to. */
export const state: Shown & { stack: Shown[] } = { tool: null, args: {}, result: null, title: null, stack: [] };
export const NO_SCOPE: Scope = { projectId: null, projectName: null, projectPath: null, machineKey: null, machineName: null };
/** Draws `state`; `app.ts` sets it. */
let render: () => void = () => {};
export function setRenderer(fn: () => void): void {
  render = fn;
}

/** Tool arguments aimed at `scope`'s project and computer. */
export function scoped(scope: Scope, extra: Json): Json {
  const a: Json = {};
  if (scope.projectId) a.project = scope.projectId;
  if (scope.machineKey) a.machine = scope.machineKey;
  for (const k of Object.keys(extra)) if (extra[k] !== undefined && extra[k] !== null) a[k] = extra[k];
  return a;
}
/** Opens another tool's view in place; Back returns here. `title` names it when its result has none. */
export function drill(name: string, args: Json, label: string, title?: string): void {
  if (!canCallTools()) return;
  state.stack.push({ tool: state.tool, args: state.args, result: state.result, title: state.title });
  renderNote("Loading " + label + "…", true);
  callTool(name, args).then((res) => {
    state.tool = name;
    state.args = args;
    state.result = res;
    state.title = title ?? null;
    render();
  }).catch((e: unknown) => renderNote(e instanceof Error ? e.message : "That did not work.", true, true));
}
function goBack(): void {
  const prev = state.stack.pop();
  if (!prev) return;
  state.tool = prev.tool;
  state.args = prev.args;
  state.result = prev.result;
  state.title = prev.title;
  render();
}

type FrameOpts = { headExtra?: Node | null };
export function frame(scope: Scope, title: string, count: string | number | null, body: Node, opts: FrameOpts = {}): HTMLElement {
  const ctxNodes: Node[] = [];
  if (scope.machineName) ctxNodes.push(h("span", { cls: "chip", title: "Computer" }, scope.machineName));
  if (scope.projectName) ctxNodes.push(h("span", { text: scope.projectName, title: scope.projectPath || scope.projectName }));
  const head = h("div", { cls: "head" },
    state.stack.length ? h("button", { cls: "back", type: "button", "aria-label": "Back", onclick: goBack }, "‹ Back") : null,
    h("span", { cls: "lbl" }, title),
    count !== null ? h("span", { cls: "count" }, String(count)) : null,
    opts.headExtra ?? null,
    ctxNodes.length ? h("span", { cls: "ctx" }, ctxNodes) : null);
  return h("section", { cls: "card", "aria-label": title }, head, body);
}
export function listBody(items: HTMLElement[], limit: number, emptyText: string): HTMLElement {
  const box = h("div", { cls: "body flush", role: "list" });
  if (!items.length) { box.appendChild(h("div", { cls: "empty" }, emptyText)); return box; }
  const shown = Math.min(items.length, limit);
  for (let i = 0; i < shown; i++) box.appendChild(items[i]!);
  if (items.length > shown) {
    const more = h("button", {
      cls: "more", type: "button",
      onclick: () => { more.remove(); for (let j = shown; j < items.length; j++) box.appendChild(items[j]!); reportSize(); },
    }, "Show all " + items.length);
    box.appendChild(more);
  }
  return box;
}

export function renderNote(text: string, keepBack = false, isErr = false): void {
  mount(h("section", { cls: "card" }, h("div", { cls: "head" },
    keepBack && state.stack.length ? h("button", { cls: "back", type: "button", onclick: goBack }, "‹ Back") : null,
    h("span", { cls: isErr ? "err" : "dim", style: "padding:0" }, text))));
}

function kvValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 240 ? s.slice(0, 240) + "…" : s;
  }
  return String(v);
}
/** Any result without a view of its own: a list or a key/value card, never a blank frame. */
export function viewKv(title: string, r: unknown, scope: Scope): HTMLElement {
  if (Array.isArray(r)) {
    const items = r.slice(0, 50).map((x: unknown) => {
      if (!isObj(x)) return h("div", { cls: "row", role: "listitem" }, kvValue(x));
      const keys = Object.keys(x).filter((k) => x[k] !== null && typeof x[k] !== "object").slice(0, 3);
      return h("div", { cls: "row", role: "listitem" }, h("span", { cls: "grow trunc" }, keys.length ? kvValue(x[keys[0]!]) : kvValue(x)),
        keys.slice(1).map((k) => h("span", { cls: "small dim trunc", style: "max-width:40%" }, kvValue(x[k]))));
    });
    return frame(scope, title, r.length, listBody(items, 15, "Nothing here."));
  }
  const dl = h("dl", { cls: "kv" });
  if (isObj(r)) {
    for (const k of Object.keys(r).slice(0, 40)) { dl.appendChild(h("dt", null, k)); dl.appendChild(h("dd", null, kvValue(r[k]))); }
  } else dl.appendChild(h("dd", null, kvValue(r)));
  return frame(scope, title, null, h("div", { cls: "body flush" }, dl));
}
export function viewText(title: string, text: string, isErr: boolean, scope: Scope): HTMLElement {
  return frame(scope, title, null, h("div", { cls: "body flush" }, h("div", { cls: isErr ? "err" : "text" }, text || "(no output)")));
}
