// cd apps/ade-cli && npx tsx ../../scripts/perf/service/brain-start.bench.mts [runs=7]
// Brain cold start: spawn of `cli.cjs serve` until "ADE brain listening on" prints, the ready line
// the desktop's handover waits to see. Compares no compile cache with Node's compile cache at the
// path the service definition uses (<ADE_HOME>/cache/node-compile). Each pair runs back to back and
// the order flips every pair. Everything runs against one throwaway ADE home and cwd under /tmp
// (the OS temp folder on Windows), with sync off (--no-sync) and a per-run socket
// /tmp/ade-bench-brain-<n>.sock (on Windows a named pipe, ade-bench-brain-<pid>-<n>). The bench never
// touches ~/.ade, the installed brain (com.ade.runtime), or a socket it did not create.
// Each run stops the brain the orderly way (its own `shutdown` RPC, the same call `ade brain stop`
// makes), because Node writes the compile cache only on a graceful exit. Signals are the fallback.
// Untimed first: a priming run (no cache) and a cache-fill run, whose exit must write the cache.
// Prints one JSON row per run, then a summary per variant. Build the CLI first: npm --prefix apps/ade-cli run build.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const runs = Math.max(1, Number(process.argv[2] ?? 7));
const cliPath = path.resolve(import.meta.dirname, "../../../apps/ade-cli/dist/cli.cjs");
const READY = "ADE brain listening on";
const r1 = (x: number) => Math.round(x * 10) / 10;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

type Variant = "no-cache" | "compile-cache";
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Timed = {
  readyMs: number;
  socketAcceptsConnect: boolean;
  stopMethod: "rpc" | "none" | "sigterm" | "sigkill";
  stopMs: number;
  exit: Exit | null;
  graceful: boolean;
};

if (!fs.existsSync(cliPath)) throw new Error(`Missing ${cliPath}; run npm --prefix apps/ade-cli run build first.`);

const isWindows = process.platform === "win32";
const tempRoot = isWindows ? os.tmpdir() : "/tmp";
const root = fs.mkdtempSync(path.join(tempRoot, "ade-bench-brain-root-"));
const adeHome = path.join(root, "ade-home");
const fakeHome = path.join(root, "home");
const runCwd = path.join(root, "cwd");
const cacheDir = path.join(adeHome, "cache", "node-compile");
const realAdeHome = path.join(fs.realpathSync(os.homedir()), ".ade");
if (!root.startsWith(tempRoot + path.sep) || adeHome.startsWith(realAdeHome)) throw new Error("Refusing to run outside a throwaway home in the temp folder.");
const socketFor = (n: number) => (isWindows ? `\\\\.\\pipe\\ade-bench-brain-${process.pid}-${n}` :`/tmp/ade-bench-brain-${n}.sock`);
for (const dir of [adeHome, fakeHome, runCwd]) fs.mkdirSync(dir, { recursive: true });

function envFor(variant: Variant): NodeJS.ProcessEnv {
  // Built from scratch so no NODE_COMPILE_CACHE / NODE_DISABLE_COMPILE_CACHE leaks in from the caller.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: fakeHome,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ADE_HOME: adeHome,
    ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
  };
  if (isWindows) {
    // The home the brain sees on Windows, and what Windows processes need to start at all.
    env.USERPROFILE = fakeHome;
    for (const key of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  }
  if (variant === "compile-cache") env.NODE_COMPILE_CACHE = cacheDir;
  return env;
}

function countCache(): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else { files++; bytes += fs.statSync(full).size; }
    }
  };
  walk(cacheDir);
  return { files, bytes };
}

function canConnect(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sock);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

function waitForExit(child: ChildProcess, ms: number): Promise<Exit | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => { clearTimeout(timer); resolve({ code, signal }); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(null); }, ms);
    child.once("exit", onExit);
  });
}

// The orderly exit the CLI's own stop uses: ade/initialize (checks the pid), ade/initialized, then
// `shutdown`, which runs the same finish() the SIGTERM handler runs. The brain refuses anything
// before ade/initialize, so this does the handshake itself.
function requestOrderlyShutdown(pid: number, sock: string): Promise<{ requested: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sock);
    let buffer = "";
    let stage: "initialize" | "shutdown" = "initialize";
    const done = (result: { requested: boolean; reason?: string }) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ requested: false, reason: "no answer in 5 s" }), 5_000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ade/initialize", params: { clientName: "ade-bench-brain-start", protocolVersion: "2025-06-18" } })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: number; result?: { runtimeInfo?: { pid?: unknown } }; error?: unknown };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && stage === "initialize") {
          const reportedPid = Number(message.result?.runtimeInfo?.pid);
          if (reportedPid !== pid) return done({ requested: false, reason: `served by pid ${reportedPid}, not ${pid}` });
          stage = "shutdown";
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "ade/initialized" })}\n`);
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "shutdown" })}\n`);
          continue;
        }
        if (message.id === 2 && stage === "shutdown") {
          return done(message.error ? { requested: false, reason: JSON.stringify(message.error) } : { requested: true });
        }
      }
    });
    socket.on("close", () => done(stage === "shutdown" ? { requested: true } : { requested: false, reason: "closed before shutdown was sent" }));
    socket.on("error", (error: Error) => done({ requested: false, reason: error.message }));
  });
}

async function stopBrain(child: ChildProcess, sock: string): Promise<Pick<Timed, "stopMethod" | "stopMs" | "exit" | "graceful">> {
  const t = performance.now();
  const rpc = await requestOrderlyShutdown(child.pid!, sock);
  if (!rpc.requested) console.error(`orderly shutdown not requested (pid ${child.pid}): ${rpc.reason}`);
  let stopMethod: Timed["stopMethod"] = rpc.requested ? "rpc" : "none";
  let exit = await waitForExit(child, 20_000);
  if (!exit) {
    stopMethod = "sigterm";
    child.kill("SIGTERM");
    exit = await waitForExit(child, 10_000);
  }
  if (!exit) {
    stopMethod = "sigkill";
    child.kill("SIGKILL");
    exit = await waitForExit(child, 10_000);
  }
  return {
    stopMethod,
    stopMs: performance.now() - t,
    exit,
    graceful: exit?.code === 0 && exit.signal === null,
  };
}

async function timeOne(n: number, variant: Variant): Promise<Timed> {
  const sock = socketFor(n);
  if (!isWindows) fs.rmSync(sock, { force: true });
  const t0 = performance.now();
  const child = spawn(process.execPath, [cliPath, "serve", "--socket", sock, "--no-sync"], {
    cwd: runCwd,
    env: envFor(variant),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  try {
    const readyMs = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "${READY}" line in 60 s: ${stderr.slice(-400)}`)), 60_000);
      child.stderr!.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.includes(READY)) { clearTimeout(timer); resolve(performance.now() - t0); }
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`brain exited before ready (code ${code}, signal ${signal}): ${stderr.slice(-400)}`));
      });
    });
    const socketAcceptsConnect = await canConnect(sock);
    return { readyMs, socketAcceptsConnect, ...(await stopBrain(child, sock)) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (!isWindows) fs.rmSync(sock, { force: true });
  }
}

const started = os.loadavg()[0]!;
try {
  // Untimed: prime the throwaway home and the OS file cache, then fill the compile cache.
  const prime = await timeOne(0, "no-cache");
  const fill = await timeOne(1, "compile-cache");
  const afterFill = countCache();
  if (!fill.graceful || afterFill.files === 0) {
    throw new Error(`cache fill did not exit gracefully (graceful=${fill.graceful}, exit=${JSON.stringify(fill.exit)}, cacheFiles=${afterFill.files}); the warm numbers would be meaningless`);
  }
  console.log(JSON.stringify({ row: "prime (untimed, no cache)", readyMs: r1(prime.readyMs), stopMethod: prime.stopMethod }));
  console.log(JSON.stringify({ row: "cache fill (untimed, first run with cache)", readyMs: r1(fill.readyMs), cacheFiles: afterFill.files, cacheBytes: afterFill.bytes }));

  const rows: Array<{ variant: Variant; run: number } & Timed> = [];
  let n = 2;
  for (let i = 1; i <= runs; i++) {
    const order: Variant[] = i % 2 ? ["no-cache", "compile-cache"] : ["compile-cache", "no-cache"];
    for (const variant of order) {
      const timed = await timeOne(n++, variant);
      rows.push({ variant, run: i, ...timed });
      console.log(JSON.stringify({ variant, run: i, readyMs: r1(timed.readyMs), socketAcceptsConnect: timed.socketAcceptsConnect, stopMethod: timed.stopMethod, stopMs: r1(timed.stopMs), graceful: timed.graceful }));
    }
  }

  const summary = (variant: Variant) => {
    const ms = rows.filter((r) => r.variant === variant).map((r) => r.readyMs);
    return { variant, n: ms.length, medianMs: r1(median(ms)), minMs: r1(Math.min(...ms)), maxMs: r1(Math.max(...ms)), spreadMs: r1(Math.max(...ms) - Math.min(...ms)) };
  };
  const base = summary("no-cache");
  const cached = summary("compile-cache");
  console.log(JSON.stringify({
    summary: [base, cached],
    deltaMedianMs: r1(cached.medianMs - base.medianMs),
    deltaPct: r1(((cached.medianMs - base.medianMs) / base.medianMs) * 100),
    rangesSeparate: cached.maxMs < base.minMs,
    allSocketsAccepted: rows.every((r) => r.socketAcceptsConnect),
    nonGracefulRuns: rows.filter((r) => !r.graceful).length,
    cache: countCache(),
    loadavgStart: r1(started),
    loadavgEnd: r1(os.loadavg()[0]!),
    node: process.version,
    cli: path.relative(process.cwd(), cliPath),
    cliBytes: fs.statSync(cliPath).size,
  }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  if (!isWindows) for (let n = 0; n < 200; n++) fs.rmSync(socketFor(n), { force: true });
}
