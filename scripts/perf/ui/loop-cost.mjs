#!/usr/bin/env node
// What a looping CSS animation costs while nothing else moves, with the
// renderer's step clock (lib/steppedLoopClock.ts) and as plain CSS.
// usage: node scripts/perf/ui/loop-cost.mjs <case>[,<case>...] [seconds] [runtime-socket]
// cases: header-pulse working-set dots duty-pulse breathe svg-spinner shimmer lane-spin thinking thinking3
//
// Each case puts the app's own loop markup on the page (its real classes and
// keyframes), lets it start, and traces the whole browser for <seconds>:
// compositor ticks, frames drawn, style recalcs and timers per second. "css"
// gives the loops a ten-million iteration count, which the step clock never
// adopts, so they run as plain CSS in the same page. With a runtime socket the
// main, GPU and renderer CPU (process-cpu.mjs) are sampled over the same window.
// Run on the dev app with the debug flags of docs/perf/macos-baseline.md (a
// covered window that is not drawing measures nothing) and with no other loop
// on screen: the top-bar activity pulse runs whenever any agent is live.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp-client.mjs";
import { findPage, positionalArgs } from "./target.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.CDP_PORT ?? 9222);
const [casesArg = "working-set", secsArg = "10", socket] = positionalArgs();
const secs = Number(secsArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dot = (delay) => `<span class="ade-thinking-pulse inline-block h-[5px] w-[5px] rounded-full bg-emerald-300/70" style="animation-delay:${delay}s"></span>`;
const dots = `<span class="inline-flex items-center gap-1.5">${dot(0)}${dot(0.18)}${dot(0.36)}</span>`;
const dutyPulse = '<span class="inline-flex motion-safe:animate-pulse"><span class="h-2 w-2 rounded-full bg-violet-400"></span></span>';
const breathe = '<span class="motion-safe:animate-[ade-session-working-breathe_2600ms_step-end_infinite]">Working</span>';
const svgSpinner = '<svg class="animate-spin" width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="20 20"/></svg>';
// The chat's working indicator (components/ui/ThinkingIndicator.tsx): glyph
// spin and morph, twinkle and label sheen, all stepped at 30/s.
const thinking = (id) => `<span class="ade-thinking-indicator inline-flex items-center gap-[0.5em] text-violet-300/80"><span class="relative inline-block h-[1.3em] w-[1.3em]"><span class="ade-thinking-glyph absolute inset-0"><svg viewBox="0 0 24 24" class="h-full w-full" fill="none"><defs><linearGradient id="lc-thinking-${id}" gradientUnits="userSpaceOnUse" x1="5" x2="20" y1="4" y2="20"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0.4"/></linearGradient></defs><path class="ade-thinking-glyph-shape" d="M 12 3 C 12.9 7.4 16.6 11.1 21 12 C 16.6 12.9 12.9 16.6 12 21 C 11.1 16.6 7.4 12.9 3 12 C 7.4 11.1 11.1 7.4 12 3 Z" fill="url(#lc-thinking-${id})"/></svg></span><span class="ade-thinking-twinkle absolute inset-0"><svg viewBox="0 0 24 24" class="h-full w-full" fill="none"><path d="M 19 2.5 C 19.18 4.32 19.68 4.82 21.5 5 C 19.68 5.18 19.18 5.68 19 7.5 C 18.82 5.68 18.32 5.18 16.5 5 C 18.32 4.82 18.82 4.32 19 2.5 Z" fill="currentColor"/></svg></span></span><span class="ade-thinking-label font-medium">Working</span></span>`;
const CASES = {
  "header-pulse": '<span style="display:inline-block;width:6px;height:6px;border-radius:3px;background:#3c3;animation:activity-hdr-pulse 3s step-end infinite"></span>',
  // What a chat shows while its agent works: the thinking dots, a pulsing dot,
  // the Work list's "Working" label and the top-bar pulse.
  "working-set": `${dots}${dutyPulse}${breathe}<span style="display:inline-block;width:6px;height:6px;background:#3c3;animation:activity-hdr-pulse 3s step-end infinite"></span>`,
  dots,
  "duty-pulse": dutyPulse,
  breathe: `${breathe}${breathe}${breathe}`,
  "svg-spinner": svgSpinner,
  shimmer: '<span class="ade-thinking-shimmer font-medium">Claude is thinking</span>',
  // One running chat, and three side by side (split view).
  thinking: thinking(0),
  thinking3: `${thinking(1)}${thinking(2)}${thinking(3)}`,
  "lane-spin": `<span class="inline-flex motion-safe:animate-[spin_3s_steps(180)_infinite]">${svgSpinner.replace(' class="animate-spin"', "")}</span>`,
};
const AS_CSS = "<style>#ade-loop-cost *, #ade-loop-cost *::before, #ade-loop-cost *::after { animation-iteration-count: 10000000 !important; }</style>";

const page = await connect(findPage(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).webSocketDebuggerUrl);
const browser = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
const events = [];
browser.on("Tracing.dataCollected", ({ value = [] }) => events.push(...value));
const evaluate = async (expression) => (await page.send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;

const COUNTED = {
  ticks: "ProxyImpl::ScheduledActionDraw",
  draws: "Display::DrawAndSwap",
  style: "UpdateLayoutTree",
  timers: "TimerFire",
};

async function measure(name, mode) {
  const html = (mode === "css" ? AS_CSS : "") + CASES[name];
  await evaluate(`(() => { document.getElementById("ade-loop-cost")?.remove(); const d = document.createElement("div"); d.id = "ade-loop-cost";
    d.style.cssText = "position:fixed;left:360px;top:300px;z-index:99999;display:flex;gap:16px;align-items:center;padding:12px;background:var(--color-bg);color:var(--color-fg);font-size:13px";
    d.innerHTML = ${JSON.stringify(html)}; document.body.appendChild(d); return 1 })()`);
  await sleep(3000);
  const adopted = await evaluate(`document.getAnimations().filter((a) => a.effect?.target?.closest?.("#ade-loop-cost") && a.playbackRate === 0).length`);
  events.length = 0;
  let offTraceComplete;
  const done = new Promise((resolve) => { offTraceComplete = browser.on("Tracing.tracingComplete", resolve); });
  await browser.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink", "cc", "viz"] } });
  const cpu = socket
    ? new Promise((resolve) => {
      let out = "";
      const child = spawn(process.execPath, [join(here, "process-cpu.mjs"), String(secs), socket], { env: process.env });
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", () => resolve(out.split("\n")
        .map((line) => /^(main|gpu|renderer\w*): (\{.*\})$/.exec(line))
        .filter(Boolean)
        .map(([, name, json]) => `${name.replace(/\d+$/, "")} ${JSON.parse(json).cpuPct}%`)
        .join("  ")));
    })
    : Promise.resolve("");
  await sleep(secs * 1000);
  await browser.send("Tracing.end");
  await done;
  offTraceComplete();
  const counts = Object.fromEntries(Object.entries(COUNTED).map(([key, event]) => [key, Math.round(events.filter((e) => e.name === event && (e.ph === "X" || e.ph === "x")).length / secs)]));
  await evaluate(`document.getElementById("ade-loop-cost")?.remove(), 1`);
  console.log(`${name.padEnd(12)} ${mode.padEnd(5)} adopted ${adopted}  ticks ${counts.ticks}/s  draws ${counts.draws}/s  style ${counts.style}/s  timers ${counts.timers}/s  ${await cpu}`);
}

for (const name of casesArg.split(",")) {
  if (!CASES[name]) { console.error(`unknown case ${name}; cases: ${Object.keys(CASES).join(" ")}`); process.exit(2); }
  await measure(name, "css");
  await measure(name, "clock");
}
page.close();
browser.close();
