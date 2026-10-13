#!/usr/bin/env node
// Apple Music probes against a running ADE dev renderer (docs/perf/macos-baseline.md, "Music").
// Usage:
//   node music.mjs first-play cold|warm   -> ms from a playItems command to the first "playing" push
//                                            (cold unloads the player host first)
//   node music.mjs pushes <seconds>       -> Music state pushes (and home Now Playing pushes) the window receives
// Plays the first five chart songs (30 s previews when signed out). Pair with
// music-host.sh (host CPU and memory) and process-cpu.sh (main, GPU, renderer).
// Env: CDP_PORT (default 9222), CDP_TARGET_URL substring (default "//localhost:").
const port = Number(process.env.CDP_PORT ?? 9222);
const [cmd, arg] = process.argv.slice(2);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const want = process.env.CDP_TARGET_URL ?? "//localhost:";
const target = list.find((t) => t.type === "page" && t.url.includes(want));
if (!target) throw new Error(`no renderer page matching ${want} on port ${port}`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const evaluate = (expression) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, (m) => {
    if (m.error || m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.error ?? m.result.exceptionDetails).slice(0, 400)));
    else resolve(m.result.result.value);
  });
  ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
});

const firstPlay = (mode) => `(async () => {
  const m = window.ade.music;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const charts = await m.charts();
  const ids = charts.songs.slice(0, 5).map((s) => s.id);
  if (${JSON.stringify(mode)} === "cold") {
    await m.unload();
    for (let i = 0; i < 50 && (await m.getState()).host.status === "running"; i++) await wait(200);
  }
  const t0 = performance.now();
  const playing = new Promise((resolve) => {
    const off = m.onState((s) => {
      if (s.playback.isPlaying && s.playback.state === "playing") { off(); resolve(performance.now() - t0); }
    });
  });
  const result = await m.command({ type: "playItems", ids, index: 0 });
  const ms = await Promise.race([playing, wait(60000).then(() => -1)]);
  return { mode: ${JSON.stringify(mode)}, ok: result.ok, error: result.error ?? null, firstPlayingMs: Math.round(ms) };
})()`;

const pushes = (secs) => `new Promise((resolve) => {
  let music = 0, home = 0;
  const offMusic = window.ade.music.onState(() => { music += 1; });
  const offHome = window.ade.home?.nowPlaying?.onChanged?.(() => { home += 1; });
  setTimeout(() => {
    offMusic?.(); offHome?.();
    resolve({ seconds: ${secs}, musicStatePushes: music, perSecond: music / ${secs}, homeNowPlayingPushes: home });
  }, ${secs} * 1000);
})`;

try {
  if (cmd === "first-play") console.log(JSON.stringify(await evaluate(firstPlay(arg === "cold" ? "cold" : "warm"))));
  else if (cmd === "pushes") console.log(JSON.stringify(await evaluate(pushes(Number(arg) || 10))));
  else console.log("usage: music.mjs first-play cold|warm | pushes <seconds>");
} finally {
  ws.close();
}
