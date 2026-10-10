#!/usr/bin/env node
// node scripts/perf/ui/interaction.mjs tabs|chats|projects [rounds]
// What a switch costs the reader: the time from the click to the first frame
// that shows a change, the time until the page stops changing, and how long the
// main thread was busy in between. Finer than long tasks alone, which miss
// every frame under 50 ms. See docs/perf/macos-baseline.md.
//   tabs   round-robin over the app's tabs (history navigation)
//   chats  round-robin over the visible Work chat cards
//   projects  round-robin over the open project tabs in the top bar
// Round 1 is the cold visit; the summary reports it apart from the warm rounds.
const [mode = "tabs", roundsArg] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 4);
const list = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/list`)).json();
const page = list.find((x) => x.type === "page" && x.url.includes(process.env.CDP_TARGET_URL ?? "//localhost:"));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 1; const pend = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? {}); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs `action` in the page and watches until the DOM has been quiet for
// `quietMs` (a background cross-fade that ends 350 ms later is not content). A frame counts once the rAF after a mutation batch has run and a
// task posted from it has started, which is when that frame's work is done.
await ev(`(() => {
  window.__adeInteraction = (action, quietMs = 150, capMs = 6000) => new Promise((resolve) => {
    const busy = [];
    let po = null;
    try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) busy.push([e.startTime, e.duration]); }); po.observe({ type: "long-animation-frame" }); } catch {}
    let firstFrameAt = null, lastChangeAt = null, pendingFrame = false, mutations = 0;
    const mo = new MutationObserver((records) => {
      mutations += records.length;
      if (pendingFrame) return;
      pendingFrame = true;
      requestAnimationFrame(() => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          pendingFrame = false;
          const now = performance.now();
          if (firstFrameAt === null) firstFrameAt = now;
          lastChangeAt = now;
        };
        ch.port2.postMessage(0);
      });
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const t0 = performance.now();
    const ok = action();
    const syncMs = performance.now() - t0;
    const poll = () => {
      const now = performance.now();
      const since = now - (lastChangeAt ?? t0);
      if ((lastChangeAt !== null && !pendingFrame && since >= quietMs) || now - t0 > capMs) {
        mo.disconnect();
        try { po?.disconnect(); } catch {}
        const end = lastChangeAt ?? now;
        const busyMs = busy.filter(([s]) => s >= t0 - 1 && s <= end).reduce((a, [, d]) => a + d, 0);
        resolve({ ok: ok !== false, syncMs, firstFrameMs: firstFrameAt === null ? null : firstFrameAt - t0, settledMs: end - t0, longFrameMs: busyMs, mutations, nodes: document.querySelectorAll("*").length });
        return;
      }
      setTimeout(poll, 25);
    };
    setTimeout(poll, 25);
  });
  return 1;
})()`);

const measure = (actionSource) => ev(`window.__adeInteraction(() => { ${actionSource} })`);
const navigate = (route) => `history.pushState({}, "", ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent("popstate"));`;

let targets;
if (mode === "tabs") {
  targets = (process.env.ROUTES ?? "/work,/lanes,/files,/prs,/automations,/settings,/cto,/history").split(",").map((route) => ({ name: route, action: navigate(route) }));
} else if (mode === "chats") {
  await ev(`(() => { ${navigate("/work")} return 1 })()`);
  await sleep(1500);
  const ids = JSON.parse(await ev(`JSON.stringify([...new Set([...document.querySelectorAll("[data-session-id]")].filter((e) => e.offsetParent).map((e) => e.getAttribute("data-session-id")))].slice(0, ${Number(process.env.CHATS ?? 6)}))`));
  targets = ids.map((sid) => ({
    name: sid.slice(0, 8),
    action: `const el = [...document.querySelectorAll('[data-session-id="${sid}"]')].find((e) => e.offsetParent); const t = el && (el.querySelector('[aria-label][class*="cursor-pointer"]') || el.querySelector('[aria-label]') || el); if (!t) return false; t.click();`,
  }));
} else if (mode === "projects") {
  const keys = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll("[data-project-tab-key]")].filter((e) => e.offsetParent).map((e) => [e.getAttribute("data-project-tab-key"), e.innerText.trim()]))`));
  targets = keys.map(([key, name]) => ({
    name: name.slice(0, 13) || key.slice(-13),
    action: `const t = [...document.querySelectorAll("[data-project-tab-key]")].find((e) => e.getAttribute("data-project-tab-key") === ${JSON.stringify(key)}); if (!t) return false; t.click();`,
  }));
} else {
  console.error("mode must be tabs, chats or projects");
  process.exit(2);
}
if (targets.length < 2) { console.error(`need two or more targets, found ${targets.length}`); process.exit(1); }

const rows = [];
for (let round = 0; round < rounds; round++) {
  for (const target of targets) {
    const r = await measure(target.action);
    rows.push({ round, name: target.name, ...r });
    await sleep(500);
  }
}
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const fmt = (x) => (x == null ? "-" : x.toFixed(0));
const summary = [];
for (const target of targets) {
  const mine = rows.filter((r) => r.name === target.name);
  const cold = mine.find((r) => r.round === 0);
  const warm = mine.filter((r) => r.round > 0);
  const row = {
    name: target.name,
    coldFirstFrameMs: cold?.firstFrameMs ?? null, coldSettledMs: cold?.settledMs ?? null, coldLongFrameMs: cold?.longFrameMs ?? null,
    warmFirstFrameMs: med(warm.map((r) => r.firstFrameMs)), warmSettledMs: med(warm.map((r) => r.settledMs)),
    warmLongFrameMs: med(warm.map((r) => r.longFrameMs)), warmSyncMs: med(warm.map((r) => r.syncMs)), nodes: mine.at(-1)?.nodes ?? null,
  };
  summary.push(row);
  console.log(`${row.name.padEnd(13)} cold first ${fmt(row.coldFirstFrameMs).padStart(5)} settled ${fmt(row.coldSettledMs).padStart(5)} long ${fmt(row.coldLongFrameMs).padStart(5)} | warm first ${fmt(row.warmFirstFrameMs).padStart(4)} settled ${fmt(row.warmSettledMs).padStart(5)} long ${fmt(row.warmLongFrameMs).padStart(4)} sync ${fmt(row.warmSyncMs).padStart(3)} | nodes ${row.nodes}`);
}
const all = (k) => med(summary.map((r) => r[k]));
console.log(JSON.stringify({ mode, rounds, medianWarmFirstFrameMs: all("warmFirstFrameMs"), medianWarmSettledMs: all("warmSettledMs"), worstWarmSettledMs: Math.max(...summary.map((r) => r.warmSettledMs ?? 0)), worstWarmLongFrameMs: Math.max(...summary.map((r) => r.warmLongFrameMs ?? 0)), rows: summary }));
ws.close();
process.exit(0);
