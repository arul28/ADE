// node scripts/perf/ui/gpu-trace.mjs <seconds> — browser-wide CDP trace; prints draw count + main-thread rendering ms
import { connect } from "./cdp-client.mjs";

const secs = Number(process.argv[2] ?? 8);
const info = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const cdp = await connect(info.webSocketDebuggerUrl);
const events = [];
cdp.on("Tracing.dataCollected", ({ value = [] }) => events.push(...value));
const complete = new Promise((resolve) => cdp.on("Tracing.tracingComplete", resolve));
await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink", "cc", "viz"] } });
await new Promise((r) => setTimeout(r, secs * 1000));
await cdp.send("Tracing.end"); await complete; cdp.close();
const want = ["ProxyImpl::ScheduledActionDraw", "DrawFrame", "Commit", "UpdateLayoutTree", "Layout", "Paint", "PrePaint", "Layerize", "RasterTask", "UpdateLayer", "CompositeLayers", "FunctionCall", "TimerFire", "Display::DrawAndSwap", "SkiaOutputSurfaceImplOnGpu::SwapBuffers"];
const by = new Map();
for (const e of events) { if (e.ph !== "X" && e.ph !== "x") continue; if (!want.includes(e.name)) continue; const x = by.get(e.name) ?? { ms: 0, n: 0 }; x.ms += (e.dur ?? 0) / 1000; x.n++; by.set(e.name, x); }
const o = {}; for (const k of want) if (by.has(k)) o[k] = `${(by.get(k).n / secs).toFixed(0)}/s ${(by.get(k).ms / secs).toFixed(1)}ms/s`;
console.log(JSON.stringify(o));
