#!/usr/bin/env node
// CDP probe for a running ADE dev renderer (see docs/perf/macos-baseline.md).
// Usage:
//   node cdp.mjs eval '<expr>'
//   node cdp.mjs metrics <seconds>        -> Performance.getMetrics delta (renderer)
//   node cdp.mjs profile <seconds> [out]  -> CPU profile, top self-time functions
//   node cdp.mjs shot <out.png>
//   node cdp.mjs anim
// Env: CDP_PORT (default 9222), CDP_TARGET_URL substring (default "//localhost:", the dev renderer page), CDP_WS (direct ws url, e.g. node inspector)
import { writeFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT ?? 9222);
const [cmd, ...rest] = process.argv.slice(2);

async function targetWs() {
  if (process.env.CDP_WS) return process.env.CDP_WS;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const want = process.env.CDP_TARGET_URL ?? "//localhost:";
  const t = list.find((x) => x.type === "page" && x.url.includes(want)) ?? list.find((x) => x.type === "node") ?? list[0];
  return t.webSocketDebuggerUrl;
}

class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.p = new Map(); this.listeners = []; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result ?? {}); }
      else if (m.method) for (const l of this.listeners) l(m);
    };
  }
  send(method, params = {}) { const id = this.id++; return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalExpr(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}

function summarizeProfile(profile, top = 40) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas; const samples = profile.samples;
  const total = (profile.endTime - profile.startTime) / 1000;
  for (let i = 0; i < samples.length; i++) {
    const n = nodes.get(samples[i]);
    const cf = n.callFrame;
    const url = (cf.url || "").replace(/^.*\/(src|node_modules)\//, "$1/").replace(/\?.*$/, "");
    const key = `${cf.functionName || "(anon)"}  ${url}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  }
  // by file
  const byFile = new Map();
  for (const [k, v] of self) { const f = k.split("  ")[1]?.replace(/:\d+$/, "") ?? k; byFile.set(f, (byFile.get(f) ?? 0) + v); }
  const idle = [...self].filter(([k]) => /^\((idle|program|garbage collector)\)/.test(k)).map(([k, v]) => `${k.split("  ")[0]}=${v.toFixed(0)}ms`).join(" ");
  console.log(`window ${total.toFixed(0)}ms  ${idle}`);
  console.log("-- top self functions");
  for (const [k, v] of [...self].filter(([k]) => !/^\((idle|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${v.toFixed(1).padStart(8)}ms  ${k}`);
  console.log("-- top files");
  for (const [k, v] of [...byFile].filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${v.toFixed(1).padStart(8)}ms  ${k}`);
}

const c = new Cdp(await targetWs());
await c.open();
try {
  if (cmd === "eval") {
    const v = await evalExpr(c, rest.join(" "));
    console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  } else if (cmd === "metrics") {
    const secs = Number(rest[0] ?? 10);
    await c.send("Performance.enable", { timeDomain: "threadTicks" });
    const get = async () => Object.fromEntries((await c.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const a = await get(); await sleep(secs * 1000); const b = await get();
    const keys = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount", "JSHeapUsedSize", "Nodes", "JSEventListeners", "Documents", "Frames"];
    const out = {};
    for (const k of keys) {
      if (/Duration/.test(k)) out[k] = `${(((b[k] - a[k]) / secs) * 1000).toFixed(1)} ms/s`;
      else if (/Count/.test(k)) out[k] = `${((b[k] - a[k]) / secs).toFixed(1)} /s`;
      else if (k === "JSHeapUsedSize") out[k] = `${(b[k] / 1048576).toFixed(0)} MB`;
      else out[k] = b[k];
    }
    console.log(JSON.stringify(out));
  } else if (cmd === "profile") {
    const secs = Number(rest[0] ?? 10);
    await c.send("Profiler.enable");
    await c.send("Profiler.setSamplingInterval", { interval: 500 });
    await c.send("Profiler.start");
    await sleep(secs * 1000);
    const { profile } = await c.send("Profiler.stop");
    if (rest[1]) writeFileSync(rest[1], JSON.stringify(profile));
    summarizeProfile(profile, Number(process.env.TOP ?? 40));
  } else if (cmd === "shot") {
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(rest[0], Buffer.from(r.data, "base64"));
    console.log(rest[0]);
  } else if (cmd === "anim") {
    const v = await evalExpr(c, `JSON.stringify(document.getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>({name:a.animationName||a.constructor.name, iter:a.effect?.getTiming?.().iterations, el:(a.effect?.target?.tagName||'')+'.'+String(a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? '').slice(0,90), hidden: !!a.effect?.target?.closest?.('[data-ade-surface-hidden]')})))`);
    const arr = JSON.parse(v);
    console.log(`running animations: ${arr.length}`);
    for (const a of arr) console.log(JSON.stringify(a));
  } else {
    console.log("unknown cmd");
  }
} finally { c.close(); }
