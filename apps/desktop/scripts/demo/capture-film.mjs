#!/usr/bin/env node
/**
 * Captures the website's scroll film from the real ADE app.
 *
 * The demo build (`npm run build:demo`, or the dev preview) runs with
 * `?demoFilm=1`: prepared replies wait for this script to move their clock.
 * The script works the app like a person, with the real pointer and keyboard:
 * on the New Chat page it opens the model picker and walks its providers, then
 * types a prompt through the `@` menu and sends it, watches the subagents
 * start, and asks for checks on two other machines with `@` machine mentions.
 * Two more shots film the chats those checks start on the Mac Studio and on
 * the Windows PC. After every step it saves a frame at 2x.
 *
 * Output (`--out`, default /tmp/ade-film): one folder of JPEG frames per shot
 * and `film.json`, which lists each shot's frames with the pointer position,
 * the clicks, the camera targets and named moments. `encode-film.mjs` turns
 * the folders into videos for the website.
 *
 *   node scripts/demo/capture-film.mjs [--url http://localhost:5173/] [--only <shot|stills>]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { launchChrome, pageTools, wait } from "./cdp.mjs";

const W = 1512;
const H = 982;
const SCALE = 2;
const FULL = [0, 0, W, H];

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const BASE = arg("url", "http://localhost:5173/");
const OUT = path.resolve(arg("out", "/tmp/ade-film"));
const ONLY = arg("only", null);

function appUrl({ platform = null, sessionId = null, film = true } = {}) {
  const url = new URL(BASE);
  if (film) url.searchParams.set("demoFilm", "1");
  if (platform) url.searchParams.set("adePlatform", platform);
  const route = sessionId ? `/work?sessionId=${sessionId}` : "/work";
  // The demo build routes by hash; the dev preview by path.
  if (url.pathname.endsWith(".html")) url.hash = route;
  else {
    url.pathname = "/work";
    if (sessionId) url.searchParams.set("sessionId", sessionId);
  }
  return url.toString();
}

/* ── Recording ───────────────────────────────────────────────────────── */

const film = { width: W, height: H, scale: SCALE, shots: [] };
/** One pointer for the whole film, so it never jumps between shots. */
const pointer = { x: W * 0.7, y: H * 0.8, visible: false, click: false, right: false };

function createShot(name, client, tools) {
  const dir = path.join(OUT, name);
  const shot = { name, frames: 0, cursor: [], cams: [], marks: {} };
  film.shots.push(shot);
  let lastFile = null;

  function record() {
    shot.cursor.push([Math.round(pointer.x), Math.round(pointer.y), (pointer.visible ? 1 : 0) | (pointer.click ? 2 : 0) | (pointer.right ? 4 : 0)]);
    pointer.click = false;
    pointer.right = false;
    shot.frames += 1;
  }

  const s = {
    shot,
    async start() {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
    },
    async frame() {
      const { data } = await client.send("Page.captureScreenshot", { format: "jpeg", quality: 92, optimizeForSpeed: true });
      const file = path.join(dir, `${String(shot.frames).padStart(4, "0")}.jpg`);
      await fs.writeFile(file, Buffer.from(data, "base64"));
      lastFile = file;
      record();
    },
    /** Frames with nothing new in the app: repeats of the last one, so the scroll has room for a camera move. */
    async hold(count) {
      for (let i = 0; i < count; i += 1) {
        await fs.copyFile(lastFile, path.join(dir, `${String(shot.frames).padStart(4, "0")}.jpg`));
        record();
      }
    },
    /** A few frames in a row, while the app animates. */
    async frames(count, gapMs = 40) {
      for (let i = 0; i < count; i += 1) {
        await s.frame();
        if (gapMs) await wait(gapMs);
      }
    },
    /** Where the camera should look from this frame on: a rect in app pixels. */
    cam(rect, ease = 16) {
      shot.cams.push({ f: shot.frames, rect: rect.map(Math.round), ease });
    },
    /** A named moment, with any rects the website needs to line its own pictures up with the app. */
    mark(label, data = null) {
      shot.marks[label] = data ? { f: shot.frames, ...data } : { f: shot.frames };
    },
    /**
     * Glides the pointer to (x, y). The website draws the pointer from these
     * positions; the app gets one real move at the end, so rows it passes on
     * the way do not open their submenus.
     */
    async moveTo(x, y, steps = 10) {
      pointer.visible = true;
      const from = { x: pointer.x, y: pointer.y };
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        pointer.x = from.x + (x - from.x) * eased;
        pointer.y = from.y + (y - from.y) * eased;
        if (i < steps && lastFile) {
          await s.hold(1);
          continue;
        }
        await tools.mouse("mouseMoved", pointer.x, pointer.y);
        await wait(40);
        await s.frame();
      }
    },
    async click({ right = false } = {}) {
      const button = right ? "right" : "left";
      await tools.mouse("mousePressed", pointer.x, pointer.y, { button, clickCount: 1 });
      await tools.mouse("mouseReleased", pointer.x, pointer.y, { button, clickCount: 1 });
      pointer.click = true;
      pointer.right = right;
    },
    async type(text, { perFrame = 1 } = {}) {
      let n = 0;
      for (const char of text) {
        await tools.typeChar(char);
        n += 1;
        if (n % perFrame === 0) {
          await wait(16);
          await s.frame();
        }
      }
      await wait(30);
      await s.frame();
    },
    async key(name, settleFrames = 2) {
      await tools.press(name);
      await wait(60);
      await s.frames(settleFrames, 30);
    },
    /** Moves a prepared reply's clock one step per frame until it is done (or `until` says stop). */
    async play({ stepMs = 140, max = 400, until = null, onFrame = null } = {}) {
      let steps = 0;
      let pending = await tools.evaluate("window.__adeDemoFilm.pending()");
      while (pending > 0 && steps < max) {
        pending = await tools.evaluate(`window.__adeDemoFilm.advance(${stepMs})`);
        await wait(70);
        await s.frame();
        steps += 1;
        if (onFrame) await onFrame(steps);
        if (until && (await until(steps))) break;
      }
      return pending;
    },
  };
  return s;
}

/* ── Finding things in the app ───────────────────────────────────────── */

function rectOf(tools, script) {
  return tools.evaluate(`(() => { const el = (${script})(); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
}

const byText = (selector, pattern, { last = false, maxLen = 80 } = {}) => `() => {
  const re = new RegExp(${JSON.stringify(pattern)});
  const all = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => {
    const t = (el.textContent || "").trim();
    const r = el.getBoundingClientRect();
    return re.test(t) && t.length <= ${maxLen} && r.width > 0 && r.height > 0;
  });
  return ${last ? "all[all.length - 1]" : "all[0]"} ?? null;
}`;

async function need(tools, label, script, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const rect = await rectOf(tools, script);
    if (rect) return rect;
    await wait(100);
  }
  throw new Error(`not found: ${label}`);
}

const rectList = (r) => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)];
const COMPOSER = `() => document.querySelector("textarea[placeholder^='Type to']") ?? document.querySelector("[contenteditable=true]")`;
const PICKER = `() => document.querySelector("[data-model-picker-content]")`;

async function pickerRail(tools) {
  return tools.evaluate(`(() => {
    const picker = document.querySelector("[data-model-picker-content]");
    const box = picker.getBoundingClientRect();
    return [...picker.querySelectorAll("button[aria-label]")]
      .map((b) => ({ label: b.getAttribute("aria-label"), r: b.getBoundingClientRect() }))
      .filter((b) => b.label && b.r.width > 30 && b.r.width < 50 && b.r.y > box.y && b.r.bottom < box.bottom)
      .map((b) => ({ label: b.label, x: b.r.x, y: b.r.y, w: b.r.width, h: b.r.height, cx: b.r.x + b.r.width / 2, cy: b.r.y + b.r.height / 2 }));
  })()`);
}

/* ── The shots ───────────────────────────────────────────────────────── */

/** Act 1, on the New Chat page: the model picker, its providers, the Custom tab, then Claude Opus 5.5. */
async function shotStart(s, tools) {
  s.cam(FULL, 0);
  await s.frames(2, 0);
  const select = await need(tools, "Select model", byText("button", "^Select model", { maxLen: 30 }));
  s.mark("idle", { button: rectList(select) });
  await s.hold(6);
  await s.moveTo(select.cx, select.cy, 12);
  await s.click();
  await wait(160);
  await s.frames(3, 40);
  const picker = await need(tools, "picker", PICKER);
  const rail = await pickerRail(tools);
  s.mark("picker-open", { picker: rectList(picker), rail: Object.fromEntries(rail.map((b) => [b.label, [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)]])) });
  s.cam([picker.x - 60, picker.y - 230, picker.w + 120, picker.h + 270], 14);
  await s.moveTo(picker.x + picker.w * 0.62, picker.y + picker.h * 0.55, 8);
  await s.hold(8);
  s.mark("rail-full");

  const visit = async (label, steps = 5, holdFrames = 3) => {
    const item = (await pickerRail(tools)).find((b) => b.label === label);
    if (!item) return;
    await s.moveTo(item.cx, item.cy, steps);
    await s.click();
    await wait(90);
    await s.frames(2, 30);
    await s.hold(holdFrames);
  };
  s.mark("tour");
  await visit("Anthropic");
  await visit("OpenAI");
  await visit("OpenCode");
  const railX = (await pickerRail(tools))[0].cx;
  for (let i = 0; i < 5; i += 1) {
    await tools.wheel(railX, pointer.y, 60);
    await wait(40);
    await s.frame();
  }
  await visit("Grok");
  for (let i = 0; i < 5; i += 1) {
    await tools.wheel(railX, pointer.y, -80);
    await wait(40);
    await s.frame();
  }
  await visit("Custom", 6, 0);
  const row = await need(tools, "custom row", byText("[data-model-picker-content] button, [data-model-picker-content] [role=option]", "DeepSeek V4\\.1 Flash in Claude Code", { maxLen: 160 }));
  const pickerNow = await need(tools, "picker", PICKER);
  // Room on the right for the website's diagram of what a custom provider is made of.
  s.cam([pickerNow.x - 40, pickerNow.y - 40, pickerNow.w + 80 + 620, pickerNow.h + 80], 12);
  await s.moveTo(row.x + row.w * 0.4, row.cy, 8);
  s.mark("custom", { picker: rectList(pickerNow), row: rectList(row) });
  await s.hold(30);
  s.mark("custom-end");

  await visit("Anthropic", 8, 2);
  // The Claude Opus 5.5 row on screen inside the picker (the list keeps other tabs' rows mounted off screen).
  const opus = await need(tools, "Claude Opus 5.5", `() => {
    const picker = document.querySelector("[data-model-picker-content]");
    const box = picker.getBoundingClientRect();
    const rows = [...picker.querySelectorAll("*")].filter((el) => {
      const r = el.getBoundingClientRect();
      return /^Claude Opus 5\\.5/.test((el.textContent || "").trim()) && r.height > 24 && r.height < 70 && r.y > box.y && r.bottom < box.bottom && r.x > box.x;
    });
    return rows.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] ?? null;
  }`);
  s.cam([picker.x - 60, picker.y - 230, picker.w + 120, picker.h + 270], 12);
  await s.moveTo(opus.x + 60, opus.cy, 8);
  await s.click();
  await wait(200);
  await s.frames(3, 50);
  s.mark("picked");
}

/** Act 2: type the prompt through the `@` menu, send it, and watch the subagents. */
async function shotCompose(s, tools) {
  const box = await need(tools, "composer", COMPOSER);
  s.cam([box.x - 90, box.y - 60, box.w + 180, 520], 16);
  await s.frames(1, 0);
  s.mark("start", { composer: rectList(box) });
  await s.moveTo(box.x + 160, box.cy, 10);
  await s.click();
  await wait(80);
  await s.frame();

  async function mention(query, { down = 0, effortDown = 1 } = {}) {
    await s.type(query);
    await wait(250);
    await s.frames(2, 40);
    for (let i = 0; i < down; i += 1) await s.key("ArrowDown", 1);
    await s.hold(2);
    await s.key("Enter", 2);
    for (let i = 0; i < effortDown; i += 1) await s.key("ArrowDown", 1);
    await s.key("Enter", 1);
  }

  s.mark("typing");
  await s.type("Use ", { perFrame: 2 });
  await mention("@luna", { down: 1 });
  await s.type(" to fix the checkout total, ", { perFrame: 3 });
  await mention("@haiku");
  await s.type(" to review the app, and ", { perFrame: 3 });
  await mention("@deepseek");
  await s.type(" to write the tests.", { perFrame: 3 });
  s.mark("typed");
  await s.hold(4);
  // Pull back to the whole app before sending, so the chat that opens is in view.
  s.cam(FULL, 12);
  await s.hold(12);

  const send = await need(tools, "send button", `() => { const bs = [...document.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === "Send"); return bs[bs.length - 1] ?? null; }`);
  await s.moveTo(send.cx, send.cy, 10);
  s.mark("send");
  await s.click();
  await wait(300);
  await s.frames(2, 80);
  await s.moveTo(1020, 560, 8);

  // The chat opens with the message in it. Move the reply's clock one step per frame.
  s.mark("sent");
  let drawerOpen = false;
  await s.play({
    onFrame: async () => {
      if (drawerOpen) return;
      // The subagents that run as their own chats show under this chat in the
      // Work list. Open that group, as a person would.
      const drawer = await rectOf(tools, byText("button,[role=button]", "^\\d+ subagents", { maxLen: 30 }));
      if (!drawer) return;
      drawerOpen = true;
      s.mark("children");
      await s.hold(4);
      await s.moveTo(drawer.x + 40, drawer.cy, 12);
      await s.click();
      await wait(150);
      await s.frames(3, 40);
      await s.moveTo(980, 700, 10);
    },
  });
  s.mark("done");
  await s.frames(2, 60);
  await s.hold(4);
}

/** Act 3: ask for checks on two other machines with `@` machine mentions. Ends while they run. */
async function shotMachines(s, tools) {
  const box = await need(tools, "composer", COMPOSER);
  s.cam([box.x - 60, box.y - 330, box.w + 120, 330 + box.h + 50], 16);
  await s.frames(1, 0);
  await s.moveTo(box.x + 160, box.cy, 10);
  await s.click();
  await wait(80);
  await s.frame();
  s.mark("typing");

  async function machine(query) {
    await s.type(query);
    await wait(300);
    await s.frames(2, 40);
    await s.hold(2);
    await s.key("Enter", 2);
  }
  await s.type("Now check it on ", { perFrame: 2 });
  await machine("@mac st");
  await s.type(" and ", { perFrame: 2 });
  await machine("@windows");
  await s.type(".", { perFrame: 1 });
  s.mark("typed");
  await s.hold(3);
  const send = await need(tools, "send button", `() => { const bs = [...document.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === "Send"); return bs[bs.length - 1] ?? null; }`);
  await s.moveTo(send.cx, send.cy, 8);
  await s.click();
  await wait(200);
  await s.frames(2, 60);
  await s.moveTo(1020, 520, 8);
  s.cam(FULL, 16);
  s.mark("sent");
  // Play until both checks have started and run a little; the website then pulls back to the machines.
  await s.play({ until: async (steps) => steps >= 34 });
  s.mark("away");
}

/** The chat a check starts on another machine, filmed on that machine. */
function shotCheck(platform) {
  return async (s, tools, client) => {
    await openApp(client, tools, { platform });
    if (platform === "win32") {
      // The Windows beta notice opens on first launch; close it as a person would.
      await tools.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Dismiss")?.click()`);
      await wait(400);
    }
    const id = await tools.evaluate(`window.ade.agentChat.create({ laneId: "lane-checkout", provider: "claude", model: "claude-sonnet-5-5", modelId: "anthropic/claude-sonnet-5-5", title: ${JSON.stringify(platform === "win32" ? "Check checkout-fix on Windows" : "Check checkout-fix on this Mac")} }).then((chat) => chat.id)`);
    // Open it from its row in the Work list. The list settles after the new row
    // arrives, so the row is clicked in the page rather than at a measured point.
    const title = platform === "win32" ? "Check checkout-fix on Windows" : "Check checkout-fix on this Mac";
    await wait(1500);
    const row = await need(tools, "check chat row", `() => [...document.querySelectorAll("span")].find((el) => el.textContent.trim() === ${JSON.stringify(title)} && el.children.length === 0) ?? null`);
    await tools.mouse("mouseMoved", row.cx, row.cy);
    await tools.mouse("mousePressed", row.cx, row.cy, { button: "left", clickCount: 1 });
    await tools.mouse("mouseReleased", row.cx, row.cy, { button: "left", clickCount: 1 });
    await wait(300);
    await tools.mouse("mouseMoved", W * 0.7, H * 0.85);
    await wait(900);
    s.cam(FULL, 0);
    await s.frames(1, 0);
    await tools.evaluate(`window.ade.agentChat.send({ sessionId: ${JSON.stringify(id)}, text: ${JSON.stringify(platform === "win32" ? "Check out checkout-fix, build it, and run the checkout tests on this Windows PC." : "Check out checkout-fix, build it, and run the checkout tests on this Mac.")} })`);
    await wait(200);
    await s.frame();
    await s.play({ stepMs: 160 });
    await s.frames(2, 60);
  };
}

/** Stills: the hero's loading picture. */
async function stills(client, tools) {
  const dir = path.join(OUT, "stills");
  await fs.mkdir(dir, { recursive: true });
  await openApp(client, tools, { film: false, sessionId: "demo-chat-checkout" });
  const { data } = await client.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
  await fs.writeFile(path.join(dir, "hero.jpg"), Buffer.from(data, "base64"));
}

/* ── Main ────────────────────────────────────────────────────────────── */

async function openApp(client, tools, options = {}) {
  await client.send("Page.navigate", { url: appUrl(options) });
  for (let i = 0; i < 100; i += 1) {
    await wait(200);
    const ready = await tools.evaluate(`Boolean(document.querySelector("button[aria-label='Start a new chat']") && (window.__adeDemoFilm || ${options.film === false}))`).catch(() => false);
    if (ready) break;
  }
  // Let fonts, logos and the window picture settle.
  await wait(1800);
}

async function openNewChat(client, tools) {
  await openApp(client, tools);
  await tools.evaluate(`document.querySelector("button[aria-label='Start a new chat']").click()`);
  await wait(600);
  // Park the real pointer where it hovers nothing.
  await tools.mouse("mouseMoved", W * 0.7, H * 0.8);
  await wait(400);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const chrome = await launchChrome({ width: W, height: H });
  const { client } = chrome;
  const tools = pageTools(client);
  const run = async (name, fn) => {
    if (ONLY && ONLY !== name) return;
    const s = createShot(name, client, tools);
    await s.start();
    const started = Date.now();
    await fn(s, tools, client);
    console.log(`[film] ${name}: ${s.shot.frames} frames in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  };
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
    // The story runs in one page from start to finish, so each shot starts where the last one ended.
    const story = !ONLY || ["start", "compose", "machines"].includes(ONLY);
    if (story) {
      await openNewChat(client, tools);
      await run("start", shotStart);
      await run("compose", shotCompose);
      await run("machines", shotMachines);
    }
    await run("studio", shotCheck("darwin"));
    await run("windows", shotCheck("win32"));
    if (!ONLY || ONLY === "stills") await stills(client, tools);
    // A partial run (`--only <shot>`) keeps the other shots' data.
    if (ONLY) {
      const previous = JSON.parse(await fs.readFile(path.join(OUT, "film.json"), "utf8").catch(() => "{\"shots\":[]}"));
      const order = ["start", "compose", "machines", "studio", "windows"];
      const byName = new Map([...previous.shots, ...film.shots].map((shot) => [shot.name, shot]));
      film.shots = order.map((name) => byName.get(name)).filter(Boolean);
    }
    await fs.writeFile(path.join(OUT, "film.json"), JSON.stringify(film) + "\n");
    console.log(`[film] wrote ${OUT}/film.json`);
  } finally {
    await chrome.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
