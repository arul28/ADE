#!/usr/bin/env node
/**
 * Migrates `${COLORS.key}NN` → color-mix(in srgb, var(--...) NN%, transparent)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../src/renderer");

const KEY_TO_VAR = {
  accent: "--color-accent",
  success: "--color-success",
  danger: "--color-error",
  warning: "--color-warning",
  info: "--color-info",
  textDim: "--color-muted-fg",
  textMuted: "--color-muted-fg",
  border: "--color-border",
  cardBg: "--color-card",
  textSecondary: "--color-secondary-fg",
  outlineBorder: "--color-border",
  pageBg: "--color-bg",
  textPrimary: "--color-fg",
  recessedBg: "--color-muted",
  cardBgSolid: "--color-card",
};

const pat = /\$\{COLORS\.(\w+)\}(\d{2})/g;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

let filesChanged = 0;
for (const file of walk(root)) {
  const orig = fs.readFileSync(file, "utf8");
  const s = orig.replace(pat, (_, key, digits) => {
    const v = KEY_TO_VAR[key];
    if (!v) {
      console.error(`Unknown COLORS.${key} in ${file}`);
      process.exit(1);
    }
    const pct = parseInt(digits, 10);
    return `'color-mix(in srgb, var(${v}) ${pct}%, transparent)'`;
  });
  if (s !== orig) {
    fs.writeFileSync(file, s);
    filesChanged++;
    console.log("updated", path.relative(path.join(__dirname, ".."), file));
  }
}
console.log(`Done. ${filesChanged} files modified.`);
