// cd apps/ade-cli && npx tsx ../../scripts/perf/service/brain-db-steps.bench.mts --project <copy root> [--runs 5] [--settle-ms 20000]
// F2 and F2b against an outside target: how long the brain's event loop is held by one database step while a phone
// reconnects and the lane list is read, and how long a point read waits beside that load.
//   F2   the longest single statement or transaction on the event loop (thread 0) in the window, from
//        scripts/perf/net/sql-trace.cjs preloaded into the brain. Outside target: 12.7 ms.
//        The load is P4's: a legacy phone's reconnect (phone-sync.bench.mts reconnect, which
//        first makes one cold connect) and 5 lane-list reads (`list_lanes`) in a row beside it.
//   F2b  a probe loop beside the load: a `ping` request every 10 ms, round trip each; the worst wait in
//        the window. The brain answers every request on its one event loop, so a point read issued then
//        waits as long as the ping does before it runs (a point read itself is well under 1 ms).
//        Outside target: 0.26 s worst point-read wait (3 heavy + 4 point-read loops, a 2.2 GB database).
// Starts its own isolated measurement brain (measure-brain.mjs: own HOME, sync ON on loopback, the port
// guard) on <copy root>, which must be a make-real-load-copy copy; pairs a headless phone with a test PIN.
// Prints each run and the median of the runs with the worst.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectBrain, prepareCopyForBrain, startMeasureBrain, stopMeasureBrain, type BrainClient } from "../net/brain-rpc.mts";
import { flag, median, requireCopyRoot } from "./bench-kit.mts";

const projectRoot = requireCopyRoot(flag("--project"));
const runs = Number(flag("--runs") ?? 5);
// --cli <built cli.cjs>: measure another build (A/B against a saved perfdist-*/cli.cjs).
const cli = flag("--cli");
const settleMs = Number(flag("--settle-ms") ?? 20_000);
const here = import.meta.dirname;
const phoneBench = path.resolve(here, "../net/phone-sync.bench.mts");
const sqlTrace = path.resolve(here, "../net/sql-trace.cjs");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ade-brain-db-steps-"));
const traceFile = path.join(scratch, "sql.jsonl");
const phoneState = path.join(scratch, "phone.json");
const brain = { dir: scratch, n: "f2" };
await prepareCopyForBrain(projectRoot);
const record = startMeasureBrain({ ...brain, cli, preloads: [sqlTrace], env: { ADE_PERF_SQLTRACE_FILE: traceFile } });
if (!record.syncPort) throw new Error("the measurement brain has no sync port");

// The phone bench runs through tsx, as this bench does (process.execArgv carries tsx's loader).
const phone = (args: string[]) => [...process.execArgv, phoneBench, ...args, "--target", `127.0.0.1:${record.syncPort}`, "--state", phoneState];

type SqlRow = { at: number; thread: number; kind: string; ms: number; sql: string | null };
const rows: Array<Record<string, unknown> & { f2Ms: number; f2bMs: number }> = [];
let client: BrainClient | null = null;
try {
  client = await connectBrain(record.socket, "brain-db-steps-bench");
  await client.addProject(projectRoot);
  fs.mkdirSync(path.join(record.home, ".ade", "secrets"), { recursive: true });
  fs.writeFileSync(path.join(record.home, ".ade", "secrets", "sync-pin.json"), JSON.stringify({ pin: "424242", updatedAt: "2026-01-01T00:00:00.000Z" }));
  const paired = spawnSync(process.execPath, phone(["pair", "--pin", "424242"]), { encoding: "utf8" });
  if (paired.status !== 0) throw new Error(`pairing failed: ${paired.stderr}`);
  const phoneProject = (JSON.parse(paired.stdout.trim().split("\n").pop()!) as { projects: Array<{ id: string }> }).projects[0]!.id;
  // Brain start-up work (catalog, caches, the first lane refresh) is not part of the window.
  await sleep(settleMs);
  // The probe's own round trip with nothing else running, so F2b's waits can be read against it.
  const idle: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    await client.request("ping");
    idle.push(performance.now() - started);
    await sleep(10);
  }
  console.log(JSON.stringify({ idleProbeMs: { median: +median(idle).toFixed(1), max: +Math.max(...idle).toFixed(1) } }));

  for (let run = 1; run <= runs; run++) {
    const t0 = Date.now();
    const phoneRun = spawn(process.execPath, phone(["reconnect", "--phone", "legacy", "--profile", "lan", "--runs", "1", "--project", phoneProject]), { stdio: ["ignore", "ignore", "pipe"] });
    let phoneErr = "";
    phoneRun.stderr!.on("data", (chunk) => { phoneErr += String(chunk); });
    const phoneDone = new Promise<number>((resolve) => phoneRun.on("exit", (code) => resolve(code ?? 1)));
    let loadDone = false;
    const waits: number[] = [];
    const probe = (async () => {
      while (!loadDone) {
        const started = performance.now();
        await client!.request("ping");
        waits.push(performance.now() - started);
        await sleep(10);
      }
    })();
    // On a failed run the client closes under an in-flight ping; that rejection is not the error to report.
    probe.catch(() => {});
    let phoneExit: number;
    try {
      const lanes = (async () => {
        for (let i = 0; i < 5; i++) await client!.action("list_lanes", { includeArchived: false });
      })();
      [phoneExit] = await Promise.all([phoneDone, lanes]);
    } finally {
      // A failed lane read ends the run: stop the probe and the phone, so neither outlives the bench.
      loadDone = true;
      if (phoneRun.exitCode === null && phoneRun.signalCode === null) phoneRun.kill();
    }
    await probe;
    const t1 = Date.now();
    await sleep(1_500); // the trace flushes once a second
    if (phoneExit !== 0) throw new Error(`phone reconnect failed (exit ${phoneExit}): ${phoneErr.slice(-800)}`);
    const sql = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as SqlRow)
      .filter((row) => row.at >= t0 && row.at <= t1 && row.thread === 0);
    const longest = sql.reduce<SqlRow | null>((best, row) => (!best || row.ms > best.ms ? row : best), null);
    const sortedWaits = [...waits].sort((a, b) => a - b);
    rows.push({
      run,
      windowMs: t1 - t0,
      f2Ms: longest?.ms ?? 0,
      f2Kind: longest?.kind ?? null,
      f2Sql: longest?.sql?.slice(0, 90) ?? null,
      stepsOver16Ms: sql.filter((row) => row.ms >= 16).length,
      f2bMs: +(sortedWaits.at(-1) ?? 0).toFixed(1),
      f2bP50Ms: +(sortedWaits[Math.floor(sortedWaits.length / 2)] ?? 0).toFixed(1),
      probes: waits.length,
    });
    console.log(JSON.stringify(rows.at(-1)));
    await sleep(3_000);
  }
} finally {
  client?.close();
  stopMeasureBrain(brain);
}
console.log(JSON.stringify({
  bench: "brain-db-steps",
  platform: process.platform,
  project: projectRoot,
  runs: rows.length,
  f2Ms: { median: median(rows.map((row) => row.f2Ms)), worst: Math.max(...rows.map((row) => row.f2Ms)) },
  f2bMs: { median: median(rows.map((row) => row.f2bMs)), worst: Math.max(...rows.map((row) => row.f2bMs)) },
}));
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(0);
