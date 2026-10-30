// node scripts/perf/ui/chat-switch-renders.mjs <cdp port> [switches]
// Component renders per Work chat switch in a running dev app: reloads the /work page once with
// render-hook.js (if not installed), visits up to 6 visible chat cards once to warm them, then counts
// renders over [switches] round-robin switches 1.5 s apart. Prints renders per switch, the top
// components, the cascade roots (which component started each re-render) and changed props.
// Counts include mounts (a row mounted by the switch is one render), and mounts are listed apart.
// WATCH=Name1,Name2 also lists which hook state changed when those components re-rendered with
// the same props (the "state causes": a hook's state, or a context whose value changed, named by
// the component that renders its provider); a component in the cascade roots is a good name to watch.
// PROPS=Name1,Name2 adds those components to the "changed props" list.
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const [port, n = "8"] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && /\/work/.test(t.url)) ?? list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 1; const pend = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? {}); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
const hook = readFileSync(new URL("./render-hook.js", import.meta.url), "utf8");
// RELOAD=1 reinstalls the hook (after an edit to render-hook.js).
const installed = process.env.RELOAD !== "1" && await ev("typeof window.__renderCounts === 'function'");
if (!installed) {
  await send("Page.enable"); await send("Page.addScriptToEvaluateOnNewDocument", { source: hook }); await send("Page.reload");
  for (let i = 0; i < 300; i++) { await delay(200); if (await ev("typeof window.__renderCounts === 'function' && document.querySelectorAll('[data-session-id]').length > 0").catch(() => false)) break; }
  await delay(8000);
}
const ids = await ev(`JSON.stringify([...new Set([...document.querySelectorAll("[data-session-id]")].filter((e) => e.offsetParent).map((e) => e.getAttribute("data-session-id")))].slice(0, 6))`);
const cards = JSON.parse(ids || "[]");
if (cards.length < 2) { console.log("no chat cards", ids); process.exit(1); }
const clickChat = (sid) => ev(`(() => { const el = [...document.querySelectorAll('[data-session-id="${sid}"]')].find((e) => e.offsetParent); const t = el && (el.querySelector('[aria-label][class*="cursor-pointer"]') || el.querySelector('[aria-label]') || el); t?.click(); return !!t; })()`);
// warm: visit each once
for (const c of cards) { await clickChat(c); await delay(1500); }
const names = (v) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const watch = names(process.env.WATCH);
const props = names(process.env.PROPS);
await ev(`(${JSON.stringify(watch)}.forEach((w) => window.__hookWatch.add(w)), ${JSON.stringify(props)}.forEach((w) => window.__watchNames.add(w)), window.__renderCountsReset(), window.__renderCountOn = true, 1)`);
for (let i = 0; i < Number(n); i++) { await clickChat(cards[i % cards.length]); await delay(1500); }
const d = await ev("(window.__renderCountOn = false, JSON.stringify({ tops: window.__tops(), ...window.__renderCounts() }))");
const out = JSON.parse(d); const total = Object.values(out.renders).reduce((s, x) => s + x, 0);
console.log(`switches ${n}, total renders ${total}, per switch ${(total / Number(n)).toFixed(0)}`);
console.log("-- top renders"); for (const [k, v] of Object.entries(out.renders).slice(0, 40)) console.log(String(v).padStart(6), k);
console.log("-- cascade roots"); for (const [k, v] of Object.entries(out.tops).slice(0, 25)) console.log(String(v).padStart(6), k);
console.log("-- mounts"); for (const [k, v] of Object.entries(out.mounts).slice(0, 20)) console.log(String(v).padStart(6), k);
if (watch.length) { console.log("-- state causes"); for (const [k, v] of Object.entries(out.stateCauses).slice(0, 30)) console.log(String(v).padStart(6), k); }
console.log("-- prop diffs"); for (const [k, v] of Object.entries(out.propDiffs).slice(0, 20)) console.log(String(v).padStart(6), k);
ws.close();
