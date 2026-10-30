// cd apps/ade-cli && npx tsx ../../scripts/perf/service/work-list.bench.mts --project <copy root> [--runs 7] [--limit 500]
// The Work list as a client asks for it: `session.list {limit}` through the brain's `run_ade_action` tool,
// on a make-real-load-copy copy (never a live project). Outside target: a work list for 2,923
// chats in ~190 ms with +23 MB heap on the server.
//
// Starts an isolated measurement brain (measure-brain.mjs), registers the copy, waits for the
// brain to settle, then: two warm-up calls, `--runs` timed calls a second apart. Reports the
// round trip (median and worst), the rows and bytes returned, and the brain's RSS growth across
// the timed calls (sampled with ps; RSS, not V8 heap, so it is an upper bound on what one call
// keeps).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connectBrain, prepareCopyForBrain, startMeasureBrain, stopMeasureBrain, type BrainClient } from "../net/brain-rpc.mts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const projectRoot = flag("--project");
if (!projectRoot || !fs.existsSync(path.join(projectRoot, ".ade", "ade.db"))) {
  throw new Error("usage: work-list.bench.mts --project <make-real-load-copy root> [--runs 7] [--limit 500]");
}
const runs = Number(flag("--runs") ?? 7);
const limit = Number(flag("--limit") ?? 500);
const brain = { dir: fs.mkdtempSync(path.join(os.tmpdir(), "ade-work-list-")), n: "wl" };
const rssMb = (pid: number) => {
  try {
    return Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024);
  } catch {
    return null;
  }
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// A copy must not hold running chats or a followed sync record when a brain opens it.
await prepareCopyForBrain(projectRoot);
const record = startMeasureBrain(brain);
let client: BrainClient | null = null;
try {
  client = await connectBrain(record.socket, "work-list-bench");
  await client.addProject(projectRoot);
  await sleep(15_000);
  const call = async () => {
    const result = await client!.action("run_ade_action", { domain: "session", action: "list", args: { limit } });
    if (result?.ok === false) throw new Error(`session.list failed: ${JSON.stringify(result.error)}`);
    return result;
  };
  await call();
  await call();
  const rssBefore = process.platform === "win32" ? null : rssMb(record.pid);
  const ms: number[] = [];
  let rows = 0;
  let bytes = 0;
  for (let run = 0; run < runs; run++) {
    await sleep(1_000);
    const started = performance.now();
    const result = await call();
    ms.push(performance.now() - started);
    const payload = result?.result ?? result;
    const list = Array.isArray(payload) ? payload : [];
    rows = list.length;
    bytes = Buffer.byteLength(JSON.stringify(payload));
  }
  const rssAfter = process.platform === "win32" ? null : rssMb(record.pid);
  console.log(JSON.stringify({
    bench: "work-list",
    platform: process.platform,
    limit,
    rows,
    bytes,
    runs,
    runsMs: ms.map((x) => +x.toFixed(1)),
    medianMs: +median(ms).toFixed(1),
    worstMs: +Math.max(...ms).toFixed(1),
    brainRssMb: { before: rssBefore, after: rssAfter },
    target: "~190 ms, +23 MB heap (2,923 chats)",
  }));
} finally {
  client?.close();
  stopMeasureBrain(brain);
}
