#!/usr/bin/env node
// Apple Music library probes against a running, signed-in ADE dev app (docs/perf/macos-baseline.md, "Music").
// Drives the Music tab's own UI (clicks in the page) and reads two CDP targets:
//   the renderer page (CDP_PORT, default 9222) and, for request counts, the Electron main
//   process's inspector (MAIN_WS; start it with `node -e "process._debugProcess(<main pid>)"`
//   and take the ws URL from http://127.0.0.1:9229/json).
// Usage:
//   node music-library.mjs detail "<playlist title>"   -> ms to the first song row and to the full list; IPC and Apple requests
//   node music-library.mjs grid                        -> open Playlists from Search: tiles, IPC/Apple/image requests, long tasks (6 s)
//   node music-library.mjs scroll                      -> scroll the Playlists grid down and back: long tasks, requests
//   node music-library.mjs memory "<t1>|<t2>|..."      -> open each playlist to its full list, back out, GC: renderer JS heap
// The main process caches Apple responses for 60 s: wait that long between cold runs.
const port = Number(process.env.CDP_PORT ?? 9222);
const [cmd, arg] = process.argv.slice(2);

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) for (const l of listeners) l(m);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {})));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  return { send, evaluate, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes(process.env.CDP_TARGET_URL ?? "//localhost:"));
if (!page) throw new Error(`no renderer page on port ${port}`);
const r = await connect(page.webSocketDebuggerUrl);
const main = process.env.MAIN_WS ? await connect(process.env.MAIN_WS) : null;

// Artwork requests the page makes (Apple's image CDN and uploaded playlist covers),
// counted from the Network domain so memory- and disk-cache hits count too.
const ART = /^https:\/\/[^/]*(mzstatic\.com|blobstore\.apple\.com)\//;
let net = { images: 0, fromCache: 0, kb: 0, uploadedKB: 0, uploaded: 0 };
const artIds = new Map();
r.on((m) => {
  if (m.method === "Network.requestWillBeSent" && ART.test(m.params.request.url)) {
    const uploaded = /blobstore\.apple\.com/.test(m.params.request.url);
    net.images += 1;
    if (uploaded) net.uploaded += 1;
    artIds.set(m.params.requestId, uploaded);
  }
  else if (m.method === "Network.requestServedFromCache" && artIds.has(m.params.requestId)) net.fromCache += 1;
  else if (m.method === "Network.loadingFinished" && artIds.has(m.params.requestId)) {
    net.kb += m.params.encodedDataLength / 1024;
    if (artIds.get(m.params.requestId)) net.uploadedKB += m.params.encodedDataLength / 1024;
  }
});
await r.send("Network.enable");
const netReset = () => { net = { images: 0, fromCache: 0, kb: 0, uploadedKB: 0, uploaded: 0 }; artIds.clear(); };
const netRead = () => ({ artRequests: net.images, artFromMemoryCache: net.fromCache, artKB: Math.round(net.kb), uploadedCoverRequests: net.uploaded, uploadedCoverKB: Math.round(net.uploadedKB) });

// Counters in main: calls per ade.music.* IPC channel and requests to api.music.apple.com.
const MAIN_INSTALL = `(() => {
  if (!globalThis.__musicPerf) {
    const perf = (globalThis.__musicPerf = { ipc: {}, apple: 0 });
    const { ipcMain } = process.mainModule.require("electron");
    for (const [channel, fn] of ipcMain._invokeHandlers) {
      if (!channel.startsWith("ade.music.")) continue;
      ipcMain._invokeHandlers.set(channel, (...a) => { perf.ipc[channel] = (perf.ipc[channel] ?? 0) + 1; return fn(...a); });
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (String(input?.url ?? input).startsWith("https://api.music.apple.com/")) perf.apple += 1;
      return realFetch(input, init);
    };
  }
  globalThis.__musicPerf.ipc = {};
  globalThis.__musicPerf.apple = 0;
  return true;
})()`;
const mainReset = async () => (main ? main.evaluate(MAIN_INSTALL) : null);
const mainRead = async () => (main ? main.evaluate("JSON.parse(JSON.stringify(globalThis.__musicPerf))") : null);

// In the page: long tasks and mzstatic image requests since the mark.
const PAGE_MARK = `(() => {
  const w = window;
  w.__mlp?.obs?.disconnect();
  const s = { longMs: 0, longMax: 0, longCount: 0, t0: performance.now() };
  s.obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { s.longMs += e.duration; s.longMax = Math.max(s.longMax, e.duration); s.longCount += 1; } });
  s.obs.observe({ type: "longtask" });
  w.__mlp = s;
  return true;
})()`;
const PAGE_READ = `(() => {
  const s = window.__mlp;
  return { longTaskMs: Math.round(s.longMs), longestTaskMs: Math.round(s.longMax), longTasks: s.longCount };
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clickNav = (label) => r.evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const tileCount = () => r.evaluate(`document.querySelectorAll('[data-testid="music-library-playlists"] [data-testid="music-tile"]').length`);

async function toPlaylists() {
  await clickNav("Search");
  await sleep(800);
  await clickNav("Playlists");
  for (let i = 0; i < 100 && (await tileCount()) === 0; i++) await sleep(100);
}

// Open a playlist from the grid; resolve when its song count has not changed for 4 s.
const OPEN_DETAIL = (title) => `new Promise((resolve) => {
  const t0 = performance.now();
  const b = document.querySelector('[data-testid="music-library-playlists"] button[aria-label=' + JSON.stringify("Open " + ${JSON.stringify(title)}) + ']');
  if (!b) { resolve({ error: "no tile" }); return; }
  let firstRow = null, lastCount = 0, lastChange = t0, counts = [];
  const tick = () => {
    const view = document.querySelector('[data-testid="music-detail"]');
    const rows = view ? view.querySelectorAll('[data-testid="music-song-row"]').length : 0;
    if (rows && firstRow === null) firstRow = performance.now() - t0;
    const meta = view?.querySelector(".ade-music-hero-meta")?.textContent ?? "";
    const n = Number((/([\\d,]+) songs/.exec(meta) || [0, "0"])[1].replace(/,/g, ""));
    const now = performance.now();
    if (n !== lastCount) { lastCount = n; lastChange = now; counts.push([Math.round(now - t0), n]); }
    if (firstRow !== null && now - lastChange > 4000) { resolve({ firstRowMs: Math.round(firstRow), fullListMs: Math.round(lastChange - t0), songs: lastCount, countSteps: counts.length, domRows: rows }); return; }
    if (now - t0 > 60000) { resolve({ error: "timeout", firstRowMs: firstRow, songs: lastCount }); return; }
    requestAnimationFrame(tick);
  };
  b.click();
  requestAnimationFrame(tick);
})`;
const back = () => r.evaluate(`(() => { const b = document.querySelector(".ade-music-back"); if (b) b.click(); return !!b; })()`);

try {
  if (cmd === "detail") {
    await toPlaylists();
    await sleep(1500);
    await mainReset();
    netReset();
    await r.evaluate(PAGE_MARK);
    const result = await r.evaluate(OPEN_DETAIL(arg));
    console.log(JSON.stringify({ playlist: arg, ...result, ...(await r.evaluate(PAGE_READ)), ...netRead(), main: await mainRead() }));
    await back();
  } else if (cmd === "grid") {
    await clickNav("Search");
    await sleep(1500);
    await mainReset();
    netReset();
    await r.evaluate(PAGE_MARK);
    const t0 = Date.now();
    await clickNav("Playlists");
    let tiles = 0;
    for (let i = 0; i < 100 && (tiles = await tileCount()) === 0; i++) await sleep(50);
    const tilesMs = Date.now() - t0;
    await sleep(6000);
    const mosaics = await r.evaluate(`document.querySelectorAll('[data-testid="music-library-playlists"] .ade-music-cover-grid').length`);
    console.log(JSON.stringify({ tiles, tilesMs, mosaics, ...(await r.evaluate(PAGE_READ)), ...netRead(), main: await mainRead() }));
  } else if (cmd === "scroll") {
    await toPlaylists();
    await sleep(3000);
    await mainReset();
    netReset();
    await r.evaluate(PAGE_MARK);
    await r.evaluate(`new Promise((resolve) => {
      const el = document.querySelector('[data-testid="music-library-playlists"] .ade-music-scroll');
      const max = el.scrollHeight - el.clientHeight;
      let f = 0; const frames = 90;
      const step = () => { f += 1; const p = f <= frames ? f / frames : 2 - f / frames; el.scrollTop = Math.round(max * p); if (f < frames * 2) requestAnimationFrame(step); else resolve(max); };
      requestAnimationFrame(step);
    })`);
    await sleep(2500);
    console.log(JSON.stringify({ ...(await r.evaluate(PAGE_READ)), ...netRead(), main: await mainRead() }));
  } else if (cmd === "memory") {
    const titles = String(arg).split("|");
    await toPlaylists();
    const opened = [];
    for (const title of titles) {
      await sleep(800);
      const result = await r.evaluate(OPEN_DETAIL(title));
      opened.push([title, result.songs, result.error ?? null]);
      await back();
      for (let i = 0; i < 50 && (await tileCount()) === 0; i++) await sleep(100);
    }
    await sleep(1000);
    await r.send("HeapProfiler.collectGarbage");
    await sleep(500);
    await r.send("HeapProfiler.collectGarbage");
    const heap = await r.send("Runtime.getHeapUsage");
    const nodes = await r.evaluate("document.getElementsByTagName('*').length");
    console.log(JSON.stringify({ opened, heapUsedMB: Math.round(heap.usedSize / 1048576 * 10) / 10, domNodes: nodes }));
  } else {
    console.log('usage: music-library.mjs detail "<title>" | grid | scroll | memory "<t1>|<t2>"');
  }
} finally {
  r.close();
  main?.close();
}
