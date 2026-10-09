// node scripts/perf/ui/chat-switch.mjs [rounds]
// Click through N chat session cards in the Work sidebar; measure time-to-content and long tasks per switch.
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((x) => x.type === "page" && x.url.includes(process.env.CDP_TARGET_URL ?? "//localhost:"));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 1; const pend = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? {}); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await ev(`(() => { history.pushState({}, "", "/work"); dispatchEvent(new PopStateEvent("popstate")); return 1 })()`);
await sleep(2000);
await ev(`(() => { window.__lt2 = []; if (!window.__lt2Obs) { window.__lt2Obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt2.push({ s: e.startTime, d: e.duration }); }); window.__lt2Obs.observe({ type: "longtask" }); } return 1 })()`);
const cards = await ev(`JSON.stringify([...document.querySelectorAll("[data-session-id]")].filter(e=>e.offsetParent && true).map(e=>e.getAttribute("data-session-id")).slice(0, 8))`);
let ids = JSON.parse(cards || "[]");
if (!ids.length) {
  const alt = await ev(`JSON.stringify([...document.querySelectorAll("[data-session-id]")].filter(e=>e.offsetParent).map(e=>e.getAttribute("data-session-id")).slice(0, 8))`);
  ids = JSON.parse(alt || "[]");
}
console.log(`cards: ${ids.length}`);
const rounds = Number(process.argv[2] ?? 2);
const results = [];
for (let r = 0; r < rounds; r++) {
  for (const sid of ids.slice(0, 5)) {
    const t0 = await ev("performance.now()");
    await ev(`(() => { const el=[...document.querySelectorAll('[data-session-id="${sid}"]')].find(e=>e.offsetParent); const t = el && (el.querySelector('[aria-label][class*="cursor-pointer"]') || el.querySelector('[aria-label]')); t?.click(); return !!t })()`);
    // wait until the transcript scroller has content and stops growing
    const res = await ev(`new Promise((resolve) => { const start = performance.now(); let last = -1, stable = 0; const tick = () => { const sc = [...document.querySelectorAll('.ade-chat-timeline-pane')].find(e=>e.offsetParent) ; const h = sc ? sc.scrollHeight : document.body.scrollHeight; if (h > 50 && sc && sc.innerText.length > 20 && h === last) stable++; else stable = 0; last = h; if (stable >= 4 || performance.now() - start > 4000) resolve({ settledMs: performance.now() - start }); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`);
    const lt = JSON.parse(await ev(`JSON.stringify(window.__lt2.filter(e=>e.s>=${t0}))`));
    results.push({ sid: sid.slice(0, 8), settledMs: Math.round(res.settledMs), longTaskMs: Math.round(lt.reduce((s, e) => s + e.d, 0)), worst: Math.round(Math.max(0, ...lt.map((e) => e.d))) });
    await sleep(600);
  }
}
for (const r of results) console.log(JSON.stringify(r));
const avg = (k) => (results.reduce((s, r) => s + r[k], 0) / results.length).toFixed(0);
console.log(`avg settled ${avg("settledMs")}ms, avg longtask ${avg("longTaskMs")}ms, worst ${Math.max(...results.map((r) => r.worst))}ms`);
ws.close();
