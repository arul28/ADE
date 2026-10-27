#!/usr/bin/env node
// node scripts/perf/net/rig-scenarios.mjs start|chats --machines <machines.json> [--rounds 5] [--chats a,b,c] [--json out.jsonl]
//
// Scenarios for the three-machine rig (scripts/perf/net/rig.sh): a dev desktop (the "local" laptop)
// connected to two measurement brains ("studio" and "win") through slow proxies.
//   start  Reload the renderer (the remote connections stay up in the main process) and time from the
//          navigation start to the first frame where the Work list holds rows of EVERY machine.
//   chats  A real mouse press on a Work row, then the time to the first frame showing that chat's rows
//          (press-to-paint's method: CDP mouse input, a MutationObserver + rAF frame clock, quiet 150 ms),
//          for each chat in --chats, round-robin; and the bytes each proxy carried during the switch.
// --machines: {"mac":{"ids":[...]},"studio":{"ids":[...],"proxyPid":123,"proxyLog":"…"},"win":{…}}
// Env: CDP_PORT (9470), HOVER_MS (250), HOLD_MS (90), GAP_MS (900).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { findPage, navigateStatement } from "../ui/target.mjs";

const argv = process.argv.slice(2);
const mode = argv[0] ?? "chats";
const read = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? fallback : fallback; };
const machinesPath = read("--machines");
if (!machinesPath) throw new Error("--machines <rig dir>/machines.json is required (written by rig.sh up)");
const machines = JSON.parse(fs.readFileSync(machinesPath, "utf8"));
const rounds = Number(read("--rounds", "5"));
const out = read("--json");
const HOVER_MS = Number(process.env.HOVER_MS ?? 250), HOLD_MS = Number(process.env.HOLD_MS ?? 90), GAP_MS = Number(process.env.GAP_MS ?? 900);
const port = process.env.CDP_PORT ?? "9470";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (row) => { const line = JSON.stringify({ at: new Date().toISOString(), load1: +os.loadavg()[0].toFixed(1), ...row }); console.log(line); if (out) fs.appendFileSync(out, `${line}\n`); };

let ws, nextId = 1; const pend = new Map();
async function connect() {
  const page = findPage(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? {}); pend.delete(m.id); } };
}
const send = (method, params = {}) => new Promise((r) => { const i = nextId++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
const mouse = (type, x, y, extra = {}) => { void send("Input.dispatchMouseEvent", { type, x, y, pointerType: "mouse", ...extra }); };

// Bytes each proxy has carried so far (SIGUSR2 makes slow-proxy print its running totals).
async function proxyTotals() {
  const totals = {};
  for (const [name, m] of Object.entries(machines)) {
    if (!m.proxyPid) continue;
    const before = fs.statSync(m.proxyLog).size;
    // SIGUSR2's default action ends a process: signal the pid only while it is still the rig's slow proxy.
    let command = "";
    try { command = execFileSync("ps", ["-p", String(m.proxyPid), "-o", "command="], { encoding: "utf8" }); } catch { /* gone */ }
    if (!command.includes("slow-proxy.mjs")) { totals[name] = null; continue; }
    process.kill(m.proxyPid, "SIGUSR2");
    for (let i = 0; i < 50 && fs.statSync(m.proxyLog).size === before; i++) await sleep(10);
    const last = fs.readFileSync(m.proxyLog, "utf8").trim().split("\n").reverse().find((l) => l.includes('"totals"'));
    totals[name] = last ? JSON.parse(last).totals : null;
  }
  return totals;
}
const delta = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, { downKB: +(((b[k]?.downBytes ?? 0) - (a[k]?.downBytes ?? 0)) / 1024).toFixed(1), upKB: +(((b[k]?.upBytes ?? 0) - (a[k]?.upBytes ?? 0)) / 1024).toFixed(1) }]));
const machineOf = (sid) => Object.entries(machines).find(([, m]) => m.ids.includes(sid))?.[0] ?? "?";

// First-run "What's new" and similar dialogs cover the Work list; step through them and close them.
async function dismissDialogs() {
  for (let i = 0; i < 20; i++) {
    const left = await ev(`(() => { const d = document.querySelector('[role="dialog"]'); if (!d) return 0;
      const b = [...d.querySelectorAll("button")].find((x) => /^(Next|Done|Got it|Close|Skip|Maybe later|Not now)$/i.test(x.innerText.trim()) || /close/i.test(x.getAttribute("aria-label") || ""));
      if (b) b.click(); else d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1; })()`);
    if (!left) return;
    await sleep(400);
  }
}

const HELPERS = `(() => {
  window.__rigArm = (sid, opts = {}) => {
    const quietMs = opts.quietMs ?? 150, capMs = opts.capMs ?? 15000;
    let downAt = null, firstFrameAt = null, contentAt = null, lastChangeAt = null, pending = false;
    const shown = () => { for (const row of document.querySelectorAll("[data-chat-row-key]")) { if (row.closest("[data-ade-surface-hidden]") || !row.offsetParent) continue; const key = row.getAttribute("data-chat-row-key"); if (/^[0-9a-f]{8}-[0-9a-f-]{27}:/.test(key)) return key.slice(0, 36); } return null; };
    const onDown = (e) => { if (downAt === null) downAt = e.timeStamp; };
    addEventListener("pointerdown", onDown, true);
    const mo = new MutationObserver(() => {
      if (downAt === null || pending) return;
      pending = true;
      requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => {
        pending = false; const now = performance.now();
        if (firstFrameAt === null) firstFrameAt = now;
        lastChangeAt = now;
        if (contentAt === null && shown() === sid) contentAt = now;
      }; ch.port2.postMessage(0); });
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const armedAt = performance.now();
    window.__rigResult = new Promise((resolve) => {
      const poll = () => {
        const now = performance.now();
        if ((contentAt !== null && !pending && now - (lastChangeAt ?? now) >= quietMs) || now - armedAt > capMs) {
          mo.disconnect(); removeEventListener("pointerdown", onDown, true);
          const rel = (t) => (t === null || downAt === null ? null : Math.round(t - downAt));
          resolve({ pressToFirstFrameMs: rel(firstFrameAt), pressToContentMs: rel(contentAt), settledMs: rel(lastChangeAt), timedOut: contentAt === null });
          return;
        }
        setTimeout(poll, 20);
      };
      setTimeout(poll, 20);
    });
    return 1;
  };
  window.__rigCenter = (sid) => {
    const el = [...document.querySelectorAll('[data-session-row][data-session-id="' + sid + '"]')].find((e) => !e.closest("[data-ade-surface-hidden]"));
    if (!el) return { ok: false, why: "no row" };
    el.scrollIntoView({ block: "center" });
    const target = el.querySelector('[role="button"]') ?? el;
    const r = target.getBoundingClientRect();
    const x = Math.round(r.left + Math.min(r.width / 2, 60)), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, ok: !!hit && (target.contains(hit) || hit.contains(target)) };
  };
  return 1;
})()`;

await connect();
if (mode === "start") {
  // Per-machine readiness, measured inside the new document from its own navigation start.
  const sets = Object.fromEntries(Object.entries(machines).map(([k, m]) => [k, m.ids]));
  await send("Page.enable");
  const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const sets = ${JSON.stringify(sets)}; window.__rigReady = {};
    const tick = () => {
      const present = new Set([...document.querySelectorAll("[data-session-row][data-session-id]")].filter((e) => !e.closest("[data-ade-surface-hidden]")).map((e) => e.getAttribute("data-session-id")));
      for (const [m, ids] of Object.entries(sets)) if (window.__rigReady[m] == null && ids.some((id) => present.has(id))) window.__rigReady[m] = Math.round(performance.now());
      if (Object.keys(window.__rigReady).length < Object.keys(sets).length && performance.now() < 60000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()` });
  for (let round = 1; round <= rounds; round++) {
    // Page.reload returns once the reload starts, so the old document can still answer: only a document
    // with a new navigation origin counts.
    const previousOrigin = await ev("performance.timeOrigin");
    const before = await proxyTotals();
    await send("Page.reload", { ignoreCache: false });
    let ready = {};
    for (let i = 0; i < 600; i++) {
      await sleep(100);
      let read = null;
      try { read = await ev("({ origin: performance.timeOrigin, ready: window.__rigReady ?? null })"); } catch { read = null; }
      if (!read || read.origin === previousOrigin || !read.ready) { ready = {}; continue; }
      ready = read.ready;
      if (Object.keys(ready).length >= Object.keys(sets).length) break;
    }
    const after = await proxyTotals();
    const all = Object.keys(ready).length === Object.keys(sets).length ? Math.max(...Object.values(ready)) : null;
    emit({ scenario: "start-reload", round, allMachinesMs: all, perMachineMs: ready, bytes: delta(before, after) });
    await sleep(3000);
  }
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
} else if (mode === "chats") {
  const chats = (read("--chats") ?? "").split(",").filter(Boolean);
  if (chats.length < 2) throw new Error("--chats needs two or more session ids");
  await ev(`(() => { ${navigateStatement("/work", false)} return 1 })()`);
  await sleep(2500);
  await ev(HELPERS);
  await dismissDialogs();
  for (let round = 1; round <= rounds; round++) {
    for (const sid of chats) {
      const at = await ev(`window.__rigCenter(${JSON.stringify(sid)})`);
      if (!at?.ok) { emit({ scenario: "chat-switch", round, sid, machine: machineOf(sid), error: at?.why ?? "row not clickable" }); continue; }
      mouse("mouseMoved", at.x, at.y);
      await sleep(HOVER_MS);
      const before = await proxyTotals();
      await ev(`window.__rigArm(${JSON.stringify(sid)})`);
      mouse("mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1 });
      await sleep(HOLD_MS);
      mouse("mouseReleased", at.x, at.y, { button: "left", buttons: 0, clickCount: 1 });
      const result = await ev("window.__rigResult");
      const after = await proxyTotals();
      emit({ scenario: "chat-switch", round, sid, machine: machineOf(sid), ...result, bytes: delta(before, after) });
      await sleep(GAP_MS);
    }
  }
} else if (mode === "projects") {
  // Open each remote machine's project once (the app's own switchRemoteProject, as Connections does),
  // then switch with real presses on the top-bar tabs, round-robin, timed to the first frame where the
  // shown project surface is the pressed tab's binding (press-to-paint's projects check).
  await ev(`window.ade.remoteRuntime.getConnectionSnapshot().then(async (t) => { const m = await import("/state/appStore.ts"); for (const c of t.connections) for (const p of c.projects || []) await m.useAppStore.getState().switchRemoteProject(c.target.id, p.projectId); return 1; })`);
  await sleep(4000);
  await dismissDialogs();
  const tabs = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll("[data-project-tab-key]")].filter((e) => e.offsetParent).map((e) => [e.getAttribute("data-project-tab-key"), e.innerText.trim().slice(0, 40)]))`));
  emit({ scenario: "project-tabs", tabs: tabs.map(([, name]) => name) });
  if (tabs.length < 2) throw new Error("fewer than two project tabs are open");
  await ev(HELPERS);
  await ev(`(() => { window.__rigArmProject = (key) => {
    const isShown = () => { const shown = [...document.querySelectorAll("[data-project-binding-key]")].filter((e) => !e.hasAttribute("data-ade-surface-hidden") && !e.closest("[data-ade-surface-hidden]")); return shown.length === 1 && (shown[0].getAttribute("data-project-binding-key") === key || shown[0].getAttribute("data-project-root") === key); };
    let downAt = null, contentAt = null, lastChangeAt = null, pending = false;
    const onDown = (e) => { if (downAt === null) downAt = e.timeStamp; };
    addEventListener("pointerdown", onDown, true);
    const mo = new MutationObserver(() => { if (downAt === null || pending) return; pending = true; requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => { pending = false; const now = performance.now(); lastChangeAt = now; if (contentAt === null && isShown()) contentAt = now; }; ch.port2.postMessage(0); }); });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const armedAt = performance.now();
    window.__rigResult = new Promise((resolve) => { const poll = () => { const now = performance.now();
      if ((contentAt !== null && !pending && now - (lastChangeAt ?? now) >= 150) || now - armedAt > 15000) { mo.disconnect(); removeEventListener("pointerdown", onDown, true); const rel = (t) => (t === null || downAt === null ? null : Math.round(t - downAt)); resolve({ pressToContentMs: rel(contentAt), settledMs: rel(lastChangeAt), timedOut: contentAt === null }); return; }
      setTimeout(poll, 20); }; setTimeout(poll, 20); });
    return 1; }; return 1; })()`);
  for (let round = 1; round <= rounds; round++) {
    for (const [key, name] of tabs) {
      const at = await ev(`(() => { const el = [...document.querySelectorAll("[data-project-tab-key]")].find((e) => e.getAttribute("data-project-tab-key") === ${JSON.stringify(key)}); if (!el) return { ok: false }; const r = el.getBoundingClientRect(); return { ok: true, x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!at?.ok) { emit({ scenario: "project-switch", round, tab: name, error: "tab not found" }); continue; }
      mouse("mouseMoved", at.x, at.y);
      await sleep(HOVER_MS);
      const before = await proxyTotals();
      await ev(`window.__rigArmProject(${JSON.stringify(key)})`);
      mouse("mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1 });
      await sleep(HOLD_MS);
      mouse("mouseReleased", at.x, at.y, { button: "left", buttons: 0, clickCount: 1 });
      const result = await ev("window.__rigResult");
      const after = await proxyTotals();
      emit({ scenario: "project-switch", round, tab: name, ...result, bytes: delta(before, after) });
      await sleep(GAP_MS);
    }
  }
}
ws.close();
process.exit(0);
