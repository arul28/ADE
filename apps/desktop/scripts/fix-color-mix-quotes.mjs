#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../src/renderer");

const MIX = "color-mix\\(in srgb, var\\([^)]+\\) \\d+%, transparent\\)";

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

let nFiles = 0;
for (const file of walk(root)) {
  let s = fs.readFileSync(file, "utf8");
  const orig = s;
  for (let i = 0; i < 12; i++) {
    s = s.replace(new RegExp("`'(" + MIX + ")'`", "g"), '"$1"');
    s = s.replace(new RegExp("1px solid '(" + MIX + ")'", "g"), '"1px solid $1"');
    s = s.replace(new RegExp("2px solid '(" + MIX + ")'", "g"), '"2px solid $1"');
    s = s.replace(new RegExp("borderColor: `'(" + MIX + ")'`", "g"), 'borderColor: "$1"');
    s = s.replace(new RegExp("\\? `'(" + MIX + ")'`", "g"), '? "$1"');
    s = s.replace(new RegExp(": `'(" + MIX + ")'`", "g"), ': "$1"');
    s = s.replace(new RegExp(", `'(" + MIX + ")'`", "g"), ', "$1"');
  }
  if (s !== orig) {
    fs.writeFileSync(file, s);
    nFiles++;
  }
}
console.log(`fixed quotes in ${nFiles} files`);
