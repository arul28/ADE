// Spinner cost per strategy from a Chromium trace, so paint, layerize and the
// compositor are counted and not just renderer main-thread script.
//
//   node scripts/perf-animation-lab/trace.mjs --count 3 --seconds 8 css layer smooth
//
// See README.md: read the compositor-draw column and its event count, and never
// measure this with process CPU.
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const lab = path.dirname(fileURLToPath(import.meta.url));
const electron = path.resolve(lab, "../../apps/desktop/node_modules/electron/dist/electron.exe");

const argv = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const count = Number(readFlag("count", 3));
const seconds = Number(readFlag("seconds", 8));
const settle = Number(readFlag("settle", 4));
const port = Number(readFlag("port", 9344));
const strategies = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

// The events that carry the per-frame rendering cost round 1 attributed the
// spinner to, plus the compositor's own work.
const INTERESTING = new Set([
  "Paint",
  "PaintImage",
  "UpdateLayerTree",
  "UpdateLayer",
  "CompositeLayers",
  "RasterTask",
  "Layerize",
  "UpdateLayoutTree",
  "Layout",
  "PrePaint",
  "Commit",
  "ProxyImpl::ScheduledActionDraw",
  "DrawFrame",
  "FunctionCall",
  "TimerFire",
]);

async function findBrowserTarget() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch {}
    await delay(400);
  }
  throw new Error("no browser target");
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method) {
      for (const fn of listeners.get(message.method) ?? []) fn(message.params);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result ?? {});
  });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("cdp socket error")), { once: true });
  });
  return {
    open,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close: () => ws.close(),
  };
}

async function run(strategy) {
  const child = spawn(
    electron,
    [lab, `--strategy=${strategy}`, `--count=${count}`, `--remote-debugging-port=${port}`],
    { stdio: "ignore", windowsHide: false },
  );
  try {
    const cdp = connect(await findBrowserTarget());
    await cdp.open;
    await delay(settle * 1000);

    const events = [];
    cdp.on("Tracing.dataCollected", (params) => events.push(...(params.value ?? [])));
    const complete = new Promise((resolve) => cdp.on("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        includedCategories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.frame",
          "blink",
          "cc",
        ],
      },
    });
    await delay(seconds * 1000);
    await cdp.send("Tracing.end");
    await complete;
    cdp.close();

    const byName = new Map();
    for (const event of events) {
      if (event.ph !== "X" && event.ph !== "x") continue;
      const name = event.name;
      if (!INTERESTING.has(name)) continue;
      const entry = byName.get(name) ?? { ms: 0, n: 0 };
      entry.ms += (event.dur ?? 0) / 1000;
      entry.n += 1;
      byName.set(name, entry);
    }
    const total = [...byName.values()].reduce((sum, e) => sum + e.ms, 0);
    return { strategy, total, byName, events: events.length };
  } finally {
    child.kill();
    await delay(1200);
  }
}

const rows = [];
for (const strategy of strategies) rows.push(await run(strategy));

const names = [...new Set(rows.flatMap((r) => [...r.byName.keys()]))]
  .sort((a, b) => {
    const sum = (n) => rows.reduce((s, r) => s + (r.byName.get(n)?.ms ?? 0), 0);
    return sum(b) - sum(a);
  })
  .slice(0, 8);

console.log(`\n${seconds}s trace per run, ${count} spinner(s). ms of work, (event count).\n`);
console.log(["strategy".padEnd(13), "total".padStart(8), ...names.map((n) => n.slice(0, 15).padStart(17))].join(""));
for (const r of rows) {
  const cells = names.map((n) => {
    const e = r.byName.get(n);
    return (e ? `${e.ms.toFixed(0)} (${e.n})` : "-").padStart(17);
  });
  console.log([r.strategy.padEnd(13), r.total.toFixed(0).padStart(8), ...cells].join(""));
}
