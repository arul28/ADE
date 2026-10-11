#!/usr/bin/env node
// node scripts/perf/ui/press-to-paint.mjs chats|tabs|projects [rounds]
// node scripts/perf/ui/press-to-paint.mjs rapid [runs]
// What a switch costs from the hand, not from the click handler: real mouse
// input (CDP Input.dispatchMouseEvent: move, press, a held button, release)
// and the time from the PRESS to the first frame that shows the new content.
// interaction.mjs starts its clock inside the click handler, so it cannot see
// the 60-120 ms a button is held. See docs/perf/macos-baseline.md.
//   chats     round-robin over the visible Work chat rows (opens the Work tab)
//   tabs      round-robin over the project sidebar tabs
//   projects  round-robin over the open project tabs in the top bar
//   rapid     presses CHATS rows INTERVAL_MS apart (opens the Work tab);
//             reports the time from the last press to the last chat's content,
//             which earlier chats painted on the way, and the main-thread work
//             of the whole burst
// Env: CDP_PORT (9222), CDP_TARGET_URL, HOVER_MS (250), HOLD_MS (90),
//      CHATS (6), INTERVAL_MS (120), RAPID_HOLD_MS (40), GAP_MS (700)
// Round 1 is the cold visit; the summary reports the warm rounds.
import os from "node:os";

const [mode = "chats", roundsArg] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 4);
const HOVER_MS = Number(process.env.HOVER_MS ?? 250);
const HOLD_MS = Number(process.env.HOLD_MS ?? 90);
const GAP_MS = Number(process.env.GAP_MS ?? 700);
const CHATS = Number(process.env.CHATS ?? 6);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 120);
const RAPID_HOLD_MS = Number(process.env.RAPID_HOLD_MS ?? 40);

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
// The dev build does not always acknowledge an input event, so never wait on one.
const mouse = (type, x, y, extra = {}) => { void send("Input.dispatchMouseEvent", { type, x, y, pointerType: "mouse", ...extra }); };
const load1 = () => os.loadavg()[0].toFixed(1);

// In the page: `__adePressArm(isContent)` starts watching and resolves once the
// page has been quiet after `isContent()` turned true. The clock starts at the
// first pointerdown (its event timestamp, so time the event spent queued behind
// a busy main thread counts). A frame counts once the rAF after a mutation
// batch has run and a task posted from it has started.
await ev(`(() => {
  window.__adePressArm = (isContent, opts = {}) => {
    const quietMs = opts.quietMs ?? 150, capMs = opts.capMs ?? 5000, presses = opts.presses ?? 1;
    const busy = [];
    let po = null;
    try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) busy.push([e.startTime, e.duration]); }); po.observe({ type: "long-animation-frame" }); } catch {}
    const downs = [];
    let handlerAt = null, clickAt = null, firstFrameAt = null, contentAt = null, lastChangeAt = null, pendingFrame = false;
    const seen = [];
    const onDown = (e) => { downs.push(e.timeStamp); if (handlerAt === null) handlerAt = performance.now(); };
    const onClick = () => { clickAt = performance.now(); };
    addEventListener("pointerdown", onDown, true);
    addEventListener("click", onClick, true);
    const mo = new MutationObserver(() => {
      if (!downs.length || pendingFrame) return;
      pendingFrame = true;
      requestAnimationFrame(() => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          pendingFrame = false;
          const now = performance.now();
          if (firstFrameAt === null) firstFrameAt = now;
          lastChangeAt = now;
          if (opts.track) { const what = opts.track(); if (what && seen.at(-1)?.[0] !== what) seen.push([what, now]); }
          if (contentAt === null && downs.length >= presses && isContent()) contentAt = now;
        };
        ch.port2.postMessage(0);
      });
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const armedAt = performance.now();
    window.__adePressResult = new Promise((resolve) => {
      const poll = () => {
        const now = performance.now();
        const done = contentAt !== null && !pendingFrame && now - (lastChangeAt ?? now) >= quietMs;
        if (done || now - armedAt > capMs) {
          mo.disconnect();
          try { po?.disconnect(); } catch {}
          removeEventListener("pointerdown", onDown, true);
          removeEventListener("click", onClick, true);
          const t0 = downs[0] ?? null, tLast = downs.at(-1) ?? null, end = lastChangeAt ?? now;
          const rel = (t, from = t0) => (t === null || from === null ? null : t - from);
          resolve({
            presses: downs.length, inputDelayMs: rel(handlerAt), pressToClickMs: rel(clickAt, tLast),
            pressToFirstFrameMs: rel(firstFrameAt), pressToContentMs: rel(contentAt, tLast), clickToContentMs: clickAt === null || contentAt === null ? null : contentAt - clickAt,
            firstPressToContentMs: rel(contentAt), settledMs: rel(end, tLast),
            longFrameMs: t0 === null ? 0 : busy.filter(([s]) => s >= t0 - 1 && s <= end).reduce((a, [, d]) => a + d, 0),
            worstFrameMs: t0 === null ? 0 : Math.max(0, ...busy.filter(([s]) => s >= t0 - 1 && s <= end).map(([, d]) => d)),
            seen: seen.map(([what, at]) => [what, rel(at)]),
          });
          return;
        }
        setTimeout(poll, 20);
      };
      setTimeout(poll, 20);
    });
    return 1;
  };
  // The chat whose rows are on screen (row keys start with the session id).
  window.__adeShownChat = () => {
    for (const row of document.querySelectorAll("[data-chat-row-key]")) {
      if (row.closest("[data-ade-surface-hidden]") || !row.offsetParent) continue;
      return row.getAttribute("data-chat-row-key").slice(0, 36);
    }
    return null;
  };
  // The page shown in the visible project: Work and Lanes stay mounted and are
  // parked, the other pages mount in one shared wrapper.
  const nodeIds = new WeakMap(); let nextNodeId = 1;
  const nodeId = (node) => { if (!node) return 0; if (!nodeIds.has(node)) nodeIds.set(node, nextNodeId++); return nodeIds.get(node); };
  window.__adeShownPage = () => {
    const main = [...document.querySelectorAll(".ade-project-main")].find((e) => !e.closest("[data-ade-surface-hidden]"));
    const shown = main && [...main.children].find((e) => !e.hasAttribute("data-ade-surface-hidden"));
    return shown ? nodeId(shown) + ":" + nodeId(shown.firstElementChild) : null;
  };
  // The tab strip of the visible project (a parked project keeps its own).
  window.__adeSidebarTabs = () => [...document.querySelectorAll(".ade-project-sidebar-tab")].filter((e) => !e.closest("[data-ade-surface-hidden]"));
  window.__adeCenter = (el) => {
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + Math.min(r.width / 2, 60)), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, ok: !!hit && (el.contains(hit) || hit.contains(el)) };
  };
  return 1;
})()`);

const navigate = (route) => ev(`(() => { history.pushState({}, "", ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent("popstate")); return 1 })()`);
const chatRow = (sid) => `[...document.querySelectorAll('[data-session-row][data-session-id="${sid}"]')].find((e) => e.offsetParent && !e.closest("[data-ade-surface-hidden]"))`;
const chatContent = (sid) => `() => window.__adeShownChat() === ${JSON.stringify(sid)}`;
const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

async function chatIds() {
  await navigate("/work");
  await sleep(1500);
  return JSON.parse(await ev(`JSON.stringify([...new Set([...document.querySelectorAll("[data-session-row]")].filter((e) => e.offsetParent && !e.closest("[data-ade-surface-hidden]")).map((e) => e.getAttribute("data-session-id")))].slice(0, ${CHATS}))`));
}

/** One real press on `locate`; `isContent` is the page function that sees the result. Both are page expressions. */
async function press(locate, isContent) {
  const at = await ev(`window.__adeCenter(${locate})`);
  if (!at?.ok) return null;
  mouse("mouseMoved", at.x, at.y);
  await sleep(HOVER_MS);
  await ev(`window.__adePressArm(${isContent})`);
  mouse("mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1 });
  await sleep(HOLD_MS);
  mouse("mouseReleased", at.x, at.y, { button: "left", buttons: 0, clickCount: 1 });
  return ev("window.__adePressResult");
}

const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const fmt = (x) => (x == null ? "-" : x.toFixed(0));

if (mode === "rapid") {
  await send("Performance.enable", { timeDomain: "threadTicks" });
  const ids = await chatIds();
  if (ids.length < 3) { console.error(`need three or more chats, found ${ids.length}`); process.exit(1); }
  const runs = [];
  for (let run = 0; run < rounds; run++) {
    // Each run walks the list from a different start, so the last chat differs.
    const order = ids.map((_, i) => ids[(i + run) % ids.length]);
    const last = order.at(-1);
    const points = [];
    for (const sid of order) points.push(await ev(`window.__adeCenter(${chatRow(sid)})`));
    if (points.some((p) => !p?.ok)) { console.error("a chat row is not clickable"); process.exit(1); }
    const before = await metrics();
    await ev(`window.__adePressArm(${chatContent(last)}, { presses: ${order.length}, track: window.__adeShownChat, capMs: 8000 })`);
    for (const p of points) {
      mouse("mouseMoved", p.x, p.y);
      mouse("mousePressed", p.x, p.y, { button: "left", buttons: 1, clickCount: 1 });
      await sleep(RAPID_HOLD_MS);
      mouse("mouseReleased", p.x, p.y, { button: "left", buttons: 0, clickCount: 1 });
      await sleep(Math.max(0, INTERVAL_MS - RAPID_HOLD_MS));
    }
    const r = await ev("window.__adePressResult");
    const after = await metrics();
    const ms = (k) => (after[k] - before[k]) * 1000;
    const painted = r.seen.map(([sid]) => sid).filter((sid) => sid !== last && order.includes(sid));
    const row = { run, load1: load1(), presses: r.presses, lastPressToContentMs: r.pressToContentMs, firstPressToContentMs: r.firstPressToContentMs, settledMs: r.settledMs, staleChatsPainted: new Set(painted).size, longFrameMs: r.longFrameMs, worstFrameMs: r.worstFrameMs, taskMs: ms("TaskDuration"), scriptMs: ms("ScriptDuration"), layoutMs: ms("LayoutDuration"), styleMs: ms("RecalcStyleDuration") };
    runs.push(row);
    console.log(`run ${run} load ${row.load1} | presses ${row.presses} last press->content ${fmt(row.lastPressToContentMs).padStart(4)} first press->content ${fmt(row.firstPressToContentMs).padStart(5)} | stale chats painted ${row.staleChatsPainted} | long frames ${fmt(row.longFrameMs).padStart(4)} worst ${fmt(row.worstFrameMs).padStart(4)} | task ${fmt(row.taskMs).padStart(5)} script ${fmt(row.scriptMs).padStart(5)}`);
    await sleep(GAP_MS + 600);
  }
  const warm = runs.slice(1).length ? runs.slice(1) : runs;
  const all = (k) => med(warm.map((r) => r[k]));
  console.log(JSON.stringify({ mode, chats: ids.length, intervalMs: INTERVAL_MS, holdMs: RAPID_HOLD_MS, medianLastPressToContentMs: all("lastPressToContentMs"), medianStaleChatsPainted: all("staleChatsPainted"), medianLongFrameMs: all("longFrameMs"), medianTaskMs: all("taskMs"), medianScriptMs: all("scriptMs"), runs }));
  ws.close();
  process.exit(0);
}

let targets;
if (mode === "chats") {
  const ids = await chatIds();
  targets = ids.map((sid) => ({ name: sid.slice(0, 8), locate: `(${chatRow(sid)})?.querySelector('[role="button"]')`, content: chatContent(sid) }));
} else if (mode === "tabs") {
  const tabs = JSON.parse(await ev(`JSON.stringify(window.__adeSidebarTabs().map((e) => e.getAttribute("aria-label")))`));
  // The tab strip marks its tab on the press, before the page mounts. The page
  // is on screen when the element shown in the page area is a different one.
  targets = tabs.map((label) => ({
    name: label,
    locate: `window.__adeSidebarTabs().find((e) => e.getAttribute("aria-label") === ${JSON.stringify(label)})`,
    content: `(() => { const before = window.__adeShownPage(); return () => { const tab = window.__adeSidebarTabs().find((e) => e.getAttribute("aria-label") === ${JSON.stringify(label)}); return tab?.getAttribute("aria-current") === "page" && window.__adeShownPage() !== before; }; })()`,
  }));
} else if (mode === "projects") {
  const keys = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll("[data-project-tab-key]")].filter((e) => e.offsetParent).map((e) => [e.getAttribute("data-project-tab-key"), e.innerText.trim()]))`));
  targets = keys.map(([key, name]) => ({
    name: name.slice(0, 13) || key.slice(-13),
    locate: `[...document.querySelectorAll("[data-project-tab-key]")].find((e) => e.getAttribute("data-project-tab-key") === ${JSON.stringify(key)})`,
    // The surface of this project, and only that one, is on screen.
    content: `() => { const shown = [...document.querySelectorAll("[data-project-binding-key]")].filter((e) => !e.hasAttribute("data-ade-surface-hidden")); return shown.length === 1 && (shown[0].getAttribute("data-project-binding-key") === ${JSON.stringify(key)} || shown[0].getAttribute("data-project-root") === ${JSON.stringify(key)}); }`,
  }));
} else {
  console.error("mode must be chats, tabs, projects or rapid");
  process.exit(2);
}
if (targets.length < 2) { console.error(`need two or more targets, found ${targets.length}`); process.exit(1); }

const rows = [];
for (let round = 0; round < rounds; round++) {
  for (const target of targets) {
    const r = await press(target.locate, target.content);
    // A target that could not be pressed counts as a miss, not as nothing.
    rows.push({ round, name: target.name, load1: load1(), ...(r ?? { pressToContentMs: null }) });
    await sleep(GAP_MS);
  }
}
const summary = [];
for (const target of targets) {
  const mine = rows.filter((r) => r.name === target.name);
  const warm = mine.filter((r) => r.round > 0);
  const pick = (k) => med(warm.map((r) => r[k]));
  const row = { name: target.name, coldPressToContentMs: mine.find((r) => r.round === 0)?.pressToContentMs ?? null, pressToFirstFrameMs: pick("pressToFirstFrameMs"), pressToContentMs: pick("pressToContentMs"), pressToClickMs: pick("pressToClickMs"), clickToContentMs: pick("clickToContentMs"), settledMs: pick("settledMs"), longFrameMs: pick("longFrameMs"), inputDelayMs: pick("inputDelayMs"), missed: warm.filter((r) => r.pressToContentMs == null).length };
  summary.push(row);
  console.log(`${row.name.padEnd(13)} cold press->content ${fmt(row.coldPressToContentMs).padStart(5)} | warm press->first frame ${fmt(row.pressToFirstFrameMs).padStart(4)} press->content ${fmt(row.pressToContentMs).padStart(4)} (press->click ${fmt(row.pressToClickMs).padStart(3)}, click->content ${fmt(row.clickToContentMs).padStart(4)}) settled ${fmt(row.settledMs).padStart(5)} long ${fmt(row.longFrameMs).padStart(4)} input delay ${fmt(row.inputDelayMs).padStart(3)} missed ${row.missed}`);
}
const all = (k) => med(summary.map((r) => r[k]));
console.log(JSON.stringify({ mode, rounds, holdMs: HOLD_MS, hoverMs: HOVER_MS, load1: load1(), medianPressToContentMs: all("pressToContentMs"), medianPressToFirstFrameMs: all("pressToFirstFrameMs"), medianClickToContentMs: all("clickToContentMs"), medianSettledMs: all("settledMs"), worstPressToContentMs: Math.max(...summary.map((r) => r.pressToContentMs ?? 0)), rows: summary }));
ws.close();
process.exit(0);
