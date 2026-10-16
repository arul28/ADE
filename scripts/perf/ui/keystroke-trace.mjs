// node scripts/perf/ui/keystroke-trace.mjs [keys]
// Trace N keystrokes in the composer; report style/layout element counts per event.
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((x) => x.type === "page" && x.url.includes(process.env.CDP_TARGET_URL ?? "//localhost:"));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 1; const pend = new Map(); const events = []; let done;
const complete = new Promise((r) => (done = r));
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? {}); pend.delete(m.id); } else if (m.method === "Tracing.dataCollected") events.push(...(m.params.value ?? [])); else if (m.method === "Tracing.tracingComplete") done(); };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
await ev(`(() => { const ta=[...document.querySelectorAll('textarea')].filter(e=>e.offsetParent).pop(); ta.focus(); return 1 })()`);
await send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink"] } });
const n = Number(process.argv[2] ?? 10);
for (let i = 0; i < n; i++) { await send("Input.dispatchKeyEvent", { type: "keyDown", text: "a", key: "a", unmodifiedText: "a" }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a" }); await new Promise((r) => setTimeout(r, 150)); }
await send("Tracing.end"); await complete;
await ev(`(() => { const ta=[...document.querySelectorAll('textarea')].filter(e=>e.offsetParent).pop(); ta.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return 1 })()`);
ws.close();
const by = new Map();
for (const e of events) {
  if (e.ph !== "X") continue;
  if (!["UpdateLayoutTree", "Layout", "Paint", "PrePaint", "Layerize", "RasterTask", "FunctionCall", "EventDispatch", "Commit"].includes(e.name)) continue;
  const x = by.get(e.name) ?? { n: 0, ms: 0, elements: 0, layoutObjects: 0 };
  x.n++; x.ms += (e.dur ?? 0) / 1000;
  x.elements += e.args?.elementCount ?? 0;
  x.layoutObjects += e.args?.beginData?.dirtyObjects ?? 0;
  by.set(e.name, x);
}
for (const [k, v] of by) console.log(`${k.padEnd(16)} n=${String(v.n).padStart(4)} ms/key=${(v.ms / n).toFixed(2).padStart(6)}  elements/key=${(v.elements / n).toFixed(0)} dirtyLayoutObjs/key=${(v.layoutObjects / n).toFixed(0)}`);
