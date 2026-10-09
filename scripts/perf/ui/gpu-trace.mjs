// node scripts/perf/ui/gpu-trace.mjs <seconds> — browser-wide CDP trace; prints draw count + main-thread rendering ms
const secs = Number(process.argv[2] ?? 8);
const info = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const ws = new WebSocket(info.webSocketDebuggerUrl); let id = 1; const pend = new Map(); const events = []; let done;
const complete = new Promise((r) => (done = r));
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } else if (m.method === "Tracing.dataCollected") events.push(...(m.params.value ?? [])); else if (m.method === "Tracing.tracingComplete") done(); };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink", "cc", "viz"] } });
await new Promise((r) => setTimeout(r, secs * 1000));
await send("Tracing.end"); await complete; ws.close();
const want = ["ProxyImpl::ScheduledActionDraw", "DrawFrame", "Commit", "UpdateLayoutTree", "Layout", "Paint", "PrePaint", "Layerize", "RasterTask", "UpdateLayer", "CompositeLayers", "FunctionCall", "TimerFire", "Display::DrawAndSwap", "SkiaOutputSurfaceImplOnGpu::SwapBuffers"];
const by = new Map();
for (const e of events) { if (e.ph !== "X" && e.ph !== "x") continue; if (!want.includes(e.name)) continue; const x = by.get(e.name) ?? { ms: 0, n: 0 }; x.ms += (e.dur ?? 0) / 1000; x.n++; by.set(e.name, x); }
const o = {}; for (const k of want) if (by.has(k)) o[k] = `${(by.get(k).n / secs).toFixed(0)}/s ${(by.get(k).ms / secs).toFixed(1)}ms/s`;
console.log(JSON.stringify(o));
