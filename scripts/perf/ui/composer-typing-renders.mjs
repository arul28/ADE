#!/usr/bin/env node
/**
 * Component renders while typing into the chat composer, in the browser-mock
 * renderer. Outside target: 20 typed characters cause 166-182 component renders
 * in total (median of 3, production web build).
 *
 * Needs the desktop Vite dev server (`npx vite --port <p> --strictPort` in
 * apps/desktop) and a Chromium with a CDP port pointed at it, e.g.
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
 *     --remote-debugging-port=9561 --user-data-dir=$(mktemp -d) http://localhost:<p>/work
 *
 * Installs scripts/perf/ui/render-hook.js before the page loads, preloads a real
 * transcript into the first mock chat (so the pane is a real chat, not an empty
 * one), opens it, focuses the composer, then per run: clears the draft, waits,
 * counts renders while `--chars` keys are typed `--gap` ms apart, and waits
 * `--settle` ms for trailing renders. Prints each run, the median and the worst,
 * and the components that rendered most in the median run.
 *
 * Usage:
 *   node scripts/perf/ui/composer-typing-renders.mjs --port 9561 --transcript <chat .jsonl[.gz]>
 *     [--chars 20] [--gap 40] [--runs 3] [--history 3000] [--settle 600]
 *     [--top 25] [--detail] [--watch Name1,Name2]
 *
 * --detail also prints, for the median run, the components that started each
 * re-render (cascade roots), and which props changed for the watched
 * components. --watch adds component names whose changed props and changed
 * hook state are recorded (only components whose props did not change get the
 * hook list, so it names the state that made them render on their own).
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(flag("--port", 9561));
const transcript = flag("--transcript");
const chars = Number(flag("--chars", 20));
const gapMs = Number(flag("--gap", 40));
const runs = Number(flag("--runs", 3));
const historyEvents = Number(flag("--history", 3000));
const settleMs = Number(flag("--settle", 600));
const detail = args.includes("--detail");
const topCount = Number(flag("--top", 25));
const watch = String(flag("--watch", "")).split(",").map((n) => n.trim()).filter(Boolean);
if (!transcript) throw new Error("--transcript <chat .jsonl[.gz]> is required");

const raw = readFileSync(transcript);
const envelopes = (transcript.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8").split("\n").flatMap((line) => {
  try {
    const parsed = JSON.parse(line);
    return parsed?.event?.type ? [parsed] : [];
  } catch {
    return [];
  }
}).slice(-historyEvents);

const base = `http://127.0.0.1:${port}`;
const page = (await (await fetch(`${base}/json/list`)).json()).find((t) => t.type === "page" && /localhost/.test(t.url));
if (!page) throw new Error("No renderer page on that CDP port");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  const p = m.id ? pending.get(m.id) : null;
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result ?? {});
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = nextId++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};

await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: readFileSync(new URL("./render-hook.js", import.meta.url), "utf8"),
});
await send("Page.navigate", { url: page.url.replace(/(localhost:\d+).*/, "$1/work") });
for (let i = 0; ; i++) {
  if (await ev("typeof window.__adeMockEmitChatEvent === 'function' && typeof window.__renderCounts === 'function'").catch(() => false)) break;
  if (i > 600) throw new Error("Mock chat emitter or render hook never appeared");
  await delay(100);
}
const sessionId = await ev(`(async () => {
  const rows = await window.ade.sessions.list({});
  return rows.filter((s) => String(s.toolType ?? "").endsWith("-chat")).map((s) => s.sessionId ?? s.id)[0] ?? null;
})()`);
if (!sessionId) throw new Error("No chat session in the mock");
for (let i = 0; i < envelopes.length; i += 400) {
  const batch = envelopes.slice(i, i + 400).map((e) => e.event);
  await ev(`(() => { for (const event of ${JSON.stringify(batch)}) window.__adeMockEmitChatEvent(${JSON.stringify(sessionId)}, event, true); return 1; })()`);
}
await ev(`(() => { history.pushState({}, "", "/work?sessionId=${sessionId}"); dispatchEvent(new PopStateEvent("popstate")); return 1; })()`);
for (let i = 0; ; i++) {
  if (await ev(`document.querySelectorAll(".ade-chat-timeline-pane [data-chat-row-key]").length > 0 && !!document.querySelector("textarea")`)) break;
  if (i > 3000) throw new Error("Chat or composer never rendered");
  await delay(20);
}
await delay(4_000);

const focusComposer = () => ev(`(() => { const t = [...document.querySelectorAll("textarea")].find((x) => x.offsetParent); if (!t) return false; t.focus(); return document.activeElement === t; })()`);
const key = (text) => [
  send("Input.dispatchKeyEvent", { type: "keyDown", text, unmodifiedText: text, key: text, code: `Key${text.toUpperCase()}` }),
  send("Input.dispatchKeyEvent", { type: "keyUp", key: text, code: `Key${text.toUpperCase()}` }),
];
const clearDraft = async () => {
  await focusComposer();
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2, commands: ["selectAll"] });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
};

const text = "the quick brown fox jumps over the lazy dog".replace(/ /g, "x");
const results = [];
for (let run = 0; run < runs; run++) {
  await clearDraft();
  if (!(await focusComposer())) throw new Error("Could not focus the composer");
  await delay(1_500);
  await ev(`(() => { for (const n of ${JSON.stringify(watch)}) { window.__watchNames.add(n); window.__hookWatch.add(n); } window.__renderCountsReset(); window.__renderCountOn = true; return 1; })()`);
  for (let i = 0; i < chars; i++) {
    await Promise.all(key(text[i % text.length]));
    await delay(gapMs);
  }
  await delay(settleMs);
  const counts = await ev("(window.__renderCountOn = false, window.__renderCounts())");
  const tops = detail ? await ev("window.__tops()") : null;
  const draft = await ev(`(document.activeElement && "value" in document.activeElement) ? document.activeElement.value.length : -1`);
  const total = Object.values(counts.renders).reduce((s, n) => s + n, 0);
  results.push({ total, draftChars: draft, top: Object.entries(counts.renders).slice(0, topCount), tops, propDiffs: counts.propDiffs, stateCauses: counts.stateCauses });
  console.log(JSON.stringify({ run: run + 1, totalRenders: total, perKey: +(total / chars).toFixed(1), draftChars: draft }));
}
const sorted = [...results].sort((a, b) => a.total - b.total);
const median = sorted[Math.floor(sorted.length / 2)];
console.log(JSON.stringify({ chars, gapMs, runs, medianRenders: median.total, worstRenders: sorted[sorted.length - 1].total, ceiling: 166, outsideTarget: "166-182" }));
console.log("-- components, median run");
for (const [name, n] of median.top) console.log(`${String(n).padStart(6)} ${name}`);
if (detail) {
  console.log("-- cascade roots, median run");
  for (const [name, n] of Object.entries(median.tops)) console.log(`${String(n).padStart(6)} ${name}`);
  console.log("-- changed props of watched components, median run");
  for (const [name, n] of Object.entries(median.propDiffs)) console.log(`${String(n).padStart(6)} ${name}`);
  console.log("-- changed hook state of watched components (props unchanged), median run");
  for (const [name, n] of Object.entries(median.stateCauses)) console.log(`${String(n).padStart(6)} ${name}`);
}
ws.close();
