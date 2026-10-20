#!/usr/bin/env node
// Summarizes spawn-trace.cjs logs over a time window (see docs/perf/macos-baseline.md).
// Usage: node spawn-report.mjs <trace-dir> <fromEpochMs> <toEpochMs> [frames]
// Prints the child processes started in the window, grouped by command and by
// the innermost named frames of the stack that started them.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [dir, fromRaw, toRaw, framesRaw] = process.argv.slice(2);
if (!dir || !fromRaw || !toRaw) {
  console.error("usage: node spawn-report.mjs <trace-dir> <fromEpochMs> <toEpochMs> [frames]");
  process.exit(1);
}
const from = Number(fromRaw);
const to = Number(toRaw);
const frameCount = Number(framesRaw ?? 6);
const byCommand = new Map();
const byStack = new Map();
let total = 0;
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

for (const file of readdirSync(dir).filter((name) => /^spawns-\d+\.log$/.test(name))) {
  for (const line of readFileSync(path.join(dir, file), "utf8").split("\n")) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.at < from || entry.at > to) continue;
    total += 1;
    const base = path.basename(entry.cmd);
    const command = base === "git" || base === "gh" ? `${base} ${entry.args.slice(0, 2).join(" ")}` : base;
    bump(byCommand, command);
    const named = entry.stack
      .map((frame) => frame.replace(/ \(.*$/, ""))
      .filter((frame) => frame && !frame.startsWith("(") && !frame.startsWith("/") && frame !== "new Promise" && frame !== "async Promise.all");
    bump(byStack, `${command}\n      ${named.slice(0, frameCount).join(" <- ")}`);
  }
}

const minutes = (to - from) / 60_000;
console.log(`${total} child processes in ${minutes.toFixed(1)} min (${(total / minutes).toFixed(1)}/min)`);
for (const [command, count] of [...byCommand].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`${String(count).padStart(5)} ${command}`);
}
console.log("\nby call site:");
for (const [key, count] of [...byStack].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`${String(count).padStart(5)} ${key}`);
}
