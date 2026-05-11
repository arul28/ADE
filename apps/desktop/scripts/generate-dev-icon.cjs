#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const inputPath = path.join(projectRoot, "build", "icon.png");
const outputPath = path.join(projectRoot, "build", "icon.dev.png");

const ADE_PURPLE = [127, 65, 238];
const ADE_WHITE = [255, 255, 255];
// Background swap target: matches the renderer's `backgroundColor` (#0F0D14) so
// the dev icon visually ties to the actual app window.
const DEV_BG = [15, 13, 20];

async function main() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`source icon not found: ${inputPath}`);
  }

  if (fs.existsSync(outputPath)) {
    const inputStat = fs.statSync(inputPath);
    const outputStat = fs.statSync(outputPath);
    if (outputStat.mtimeMs >= inputStat.mtimeMs) {
      return;
    }
  }

  const sharp = require("sharp");
  const { data, info } = await sharp(inputPath).raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const out = Buffer.alloc(data.length);

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = channels === 4 ? data[i + 3] : 255;

    if (a < 8) {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      if (channels === 4) out[i + 3] = a;
      continue;
    }

    // Decompose pixel as a non-negative combination of ADE purple, white, and black:
    //   (r, g, b) = wp * PURPLE + ww * WHITE + wd * BLACK
    // Solving with PURPLE = (127, 65, 238), WHITE = (255, 255, 255):
    //   r - g = 62 * wp  →  wp = (r - g) / 62
    //   g     = 65*wp + 255*ww  →  ww = (g - 65*wp) / 255
    let wp = (r - g) / 62;
    if (wp < 0) wp = 0;
    if (wp > 1) wp = 1;
    let ww = (g - 65 * wp) / 255;
    if (ww < 0) ww = 0;
    if (ww > 1) ww = 1;

    // Reproject the original pixel onto the {PURPLE, WHITE, BLACK} subspace and
    // capture any residual so unrelated colors (e.g. shadow tints) survive.
    const projR = wp * ADE_PURPLE[0] + ww * ADE_WHITE[0];
    const projG = wp * ADE_PURPLE[1] + ww * ADE_WHITE[1];
    const projB = wp * ADE_PURPLE[2] + ww * ADE_WHITE[2];
    const resR = r - projR;
    const resG = g - projG;
    const resB = b - projB;

    // Swap purple bg out for the dev bg, and white text out for purple. The
    // black/shadow contribution flows through `res*` so antialiased edges stay
    // smooth (and existing dark-shadow pixels just blend toward the dark bg).
    let nr = wp * DEV_BG[0] + ww * ADE_PURPLE[0] + resR;
    let ng = wp * DEV_BG[1] + ww * ADE_PURPLE[1] + resG;
    let nb = wp * DEV_BG[2] + ww * ADE_PURPLE[2] + resB;

    if (nr < 0) nr = 0;
    else if (nr > 255) nr = 255;
    if (ng < 0) ng = 0;
    else if (ng > 255) ng = 255;
    if (nb < 0) nb = 0;
    else if (nb > 255) nb = 255;

    out[i] = Math.round(nr);
    out[i + 1] = Math.round(ng);
    out[i + 2] = Math.round(nb);
    if (channels === 4) out[i + 3] = a;
  }

  await sharp(out, { raw: info }).png().toFile(outputPath);
  process.stdout.write(`[generate-dev-icon] wrote ${path.relative(projectRoot, outputPath)}\n`);
}

main().catch((err) => {
  process.stderr.write(`[generate-dev-icon] failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
