#!/usr/bin/env node
// CPU % and memory of each ADE dev process over a window (cross-platform
// counterpart of process-cpu.sh, which is macOS-only).
// usage: node scripts/perf/ui/process-cpu.mjs <seconds> <runtime-socket>
// Samples the dev Electron main (the one started with
// --remote-debugging-port=<CDP_PORT, default 9222>), its GPU, renderer and
// utility helpers, and the dev brain (`cli.cjs serve --socket <socket>`).
// The installed ADE is never matched: it has no remote-debugging port and its
// brain serves another socket. CPU % is of one core (like `ps`), so 100% is
// one core fully busy. RSS is the working set on Windows; on Windows the
// private bytes (commit) are printed too.
import { execFileSync } from "node:child_process";

const [secsArg, socket] = process.argv.slice(2);
if (!secsArg || !socket) {
  console.error("usage: process-cpu.mjs <seconds> <runtime-socket>");
  process.exit(2);
}
const secs = Number(secsArg);
const port = process.env.CDP_PORT ?? "9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -> Map<pid, { ppid, cmd, cpuS, rssMB, privMB }>
function snapshot() {
  if (process.platform === "win32") {
    const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress";
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const rows = JSON.parse(out);
    return new Map(rows.map((r) => [r.ProcessId, {
      ppid: r.ParentProcessId,
      cmd: r.CommandLine ?? "",
      cpuS: (Number(r.KernelModeTime ?? 0) + Number(r.UserModeTime ?? 0)) / 1e7,
      rssMB: Number(r.WorkingSetSize ?? 0) / 1048576,
      privMB: Number(r.PrivatePageCount ?? 0) / 1048576,
    }]));
  }
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,time=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const map = new Map();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const cpuS = m[3].replace("-", ":").split(":").reduce((s, x) => s * 60 + Number(x), 0);
    map.set(Number(m[1]), { ppid: Number(m[2]), cmd: m[5], cpuS, rssMB: Number(m[4]) / 1024, privMB: null });
  }
  return map;
}

function pick(snap) {
  const procs = [];
  const main = [...snap].find(([, p]) => p.cmd.includes(`--remote-debugging-port=${port}`) && !p.cmd.includes("--type="));
  if (!main) throw new Error(`no Electron main with --remote-debugging-port=${port}`);
  procs.push(["main", main[0]]);
  for (const [pid, p] of snap) {
    if (p.ppid !== main[0]) continue;
    if (p.cmd.includes("--type=gpu-process")) procs.push(["gpu", pid]);
    else if (p.cmd.includes("--type=renderer")) procs.push([`renderer${pid}`, pid]);
    else if (p.cmd.includes("--type=utility")) procs.push([`utility${pid}`, pid]);
  }
  const brain = [...snap].find(([, p]) => /cli\.cjs"?\s+serve\b/.test(p.cmd) && p.cmd.includes(socket));
  if (brain) {
    procs.push(["brain", brain[0]]);
    for (const [pid, p] of snap) if (p.ppid === brain[0]) procs.push([`brainChild${pid}`, pid]);
  }
  return procs;
}

const s0 = snapshot(); const t0 = Date.now();
const procs = pick(s0);
await sleep(secs * 1000);
const s1 = snapshot(); const wall = (Date.now() - t0) / 1000;
const result = {};
for (const [name, pid] of procs) {
  const a = s0.get(pid); const b = s1.get(pid);
  if (!a || !b) { result[name] = "exited"; continue; }
  result[name] = {
    pid,
    cpuPct: +(((b.cpuS - a.cpuS) / wall) * 100).toFixed(1),
    rssMB: Math.round(b.rssMB),
    ...(b.privMB != null ? { privateMB: Math.round(b.privMB) } : {}),
    ...(name.startsWith("brainChild") ? { cmd: b.cmd.slice(0, 120) } : {}),
  };
}
for (const [k, v] of Object.entries(result)) console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
