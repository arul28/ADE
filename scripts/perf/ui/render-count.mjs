// node scripts/perf/ui/render-count.mjs <seconds> reload
// `reload` installs the hook and reloads the renderer; it is needed once per
// renderer load (later runs may omit it).  — install render hook in the dev Electron page (CDP port 9222), count renders over a window
import { readFileSync } from "node:fs";
const secs = Number(process.argv[2] ?? 10);
const reload = process.argv[3] === "reload";
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((x) => x.type === "page" && x.url.includes(process.env.CDP_TARGET_URL ?? "//localhost:"));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 1; const pend = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? {}); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
if (reload) {
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(new URL("./render-hook.js", import.meta.url), "utf8") });
  await send("Page.reload");
  for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 200)); if (await ev("typeof window.__renderCounts === 'function' && document.querySelectorAll('textarea,[data-session-status]').length > 0").catch(() => false)) break; }
  await new Promise((r) => setTimeout(r, 6000));
}
let commits = 0;
await ev(`(() => { window.__renderCountsReset(); window.__commitN = 0; const h = window.__REACT_DEVTOOLS_GLOBAL_HOOK__; if (!h.__wrapped) { const o = h.onCommitFiberRoot; h.onCommitFiberRoot = function(...a){ if (window.__renderCountOn) window.__commitN++; return o.apply(this, a); }; h.__wrapped = true; } window.__renderCountOn = true; return 1 })()`);
await new Promise((r) => setTimeout(r, secs * 1000));
const out = await ev("(window.__renderCountOn = false, JSON.stringify({ commits: window.__commitN, tops: window.__tops(), ...window.__renderCounts() }))");
const d = JSON.parse(out);
console.log(`commits: ${d.commits} in ${secs}s (${(d.commits / secs).toFixed(1)}/s)`);
console.log("-- cascade tops"); for (const [k, v] of Object.entries(d.tops ?? {})) console.log(`${String(v).padStart(6)} ${k}`);
console.log("-- renders"); for (const [k, v] of Object.entries(d.renders).slice(0, Number(process.env.TOP ?? 40))) console.log(`${String(v).padStart(6)} ${k}`);
console.log("-- prop diffs"); for (const [k, v] of Object.entries(d.propDiffs ?? {})) console.log(`${String(v).padStart(6)} ${k}`);


console.log("-- hook diffs"); for (const [k, v] of Object.entries(d.stateCauses ?? {})) console.log(`${String(v).padStart(6)} ${k}`);
console.log("-- mounts"); for (const [k, v] of Object.entries(d.mounts ?? {}).slice(0, 15)) console.log(`${String(v).padStart(6)} ${k}`);
ws.close();
