// node scripts/perf/ui/typing.mjs <n chars> — types into the focused chat composer via CDP key events; reports Event Timing durations
const port = 9222;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const t = list.find((x) => x.type === "page" && x.url.includes(process.env.CDP_TARGET_URL ?? "//localhost:"));
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 1; const pend = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
console.log(await ev(`(() => { const ta=[...document.querySelectorAll('textarea,[contenteditable=true]')].filter(e=>e.offsetParent).pop(); if(!ta) return 'no composer'; ta.focus(); window.__evt=[]; new PerformanceObserver(l=>{for(const e of l.getEntries()) if(e.name==='keydown'||e.name==='keypress'||e.name==='keyup'||e.name==='input'||e.name==='beforeinput') window.__evt.push({n:e.name,d:e.duration,p:e.processingEnd-e.processingStart,delay:e.processingStart-e.startTime})}).observe({type:'event',durationThreshold:16,buffered:false}); return 'focused '+ta.tagName })()`));
const n = Number(process.argv[2] ?? 40);
const text = "the quick brown fox jumps over the lazy dog ";
for (let i = 0; i < n; i++) {
  const ch = text[i % text.length];
  await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  await new Promise((r) => setTimeout(r, 60));
}
await new Promise((r) => setTimeout(r, 500));
const evts = await ev(`JSON.stringify(window.__evt)`);
const arr = JSON.parse(evts).filter((e) => e.n === "keydown" || e.n === "keypress");
const ds = arr.map((e) => e.d).sort((a, b) => a - b);
const q = (p) => ds.length ? ds[Math.min(ds.length - 1, Math.floor(p * ds.length))] : 0;
console.log(JSON.stringify({ keys: n, slowEvents: arr.length, p50: q(0.5), p90: q(0.9), max: ds[ds.length - 1] ?? 0, avgProcessing: arr.length ? (arr.reduce((s, e) => s + e.p, 0) / arr.length).toFixed(1) : 0 }));
// clear composer
await ev(`(() => { const ta=[...document.querySelectorAll('textarea,[contenteditable=true]')].filter(e=>e.offsetParent).pop(); ta.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return 1 })()`);
ws.close();
