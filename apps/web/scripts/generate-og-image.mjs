#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } =
  (() => {
    try { return require("playwright"); }
    catch { return require("/opt/node22/lib/node_modules/playwright"); }
  })();

const __dirname = dirname(fileURLToPath(import.meta.url));
const [, , sourceArg, outArg] = process.argv;
const htmlPath = resolve(__dirname, sourceArg ?? "og-image.html");
const outPath = outArg
  ? resolve(__dirname, outArg)
  : resolve(__dirname, "../public/og-image.png");

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({
  path: outPath,
  type: "png",
  clip: { x: 0, y: 0, width: 1200, height: 630 },
});
await browser.close();
console.log(`wrote ${outPath}`);
