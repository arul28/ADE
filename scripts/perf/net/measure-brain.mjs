// Start or stop an isolated sync-ON measurement brain, for the phone and remote benches.
//
//   node scripts/perf/net/measure-brain.mjs start --dir <scratch dir> [--n 1]
//   node scripts/perf/net/measure-brain.mjs stop  --dir <scratch dir> [--n 1]
//   node scripts/perf/net/measure-brain.mjs cli   --dir ... [--n 1] [--cwd <project>] -- <ade args>
//
// Isolation, all of it needed (scripts/perf/net/README.md explains each):
//   - its own HOME (<dir>/home) and ADE_HOME=<dir>/home/.ade: sync only turns on in $HOME/.ade, so a
//     fake HOME is the only way to get sync ON without sharing the machine's home;
//   - its own socket (/tmp/ade-measure-<dir hash>-<n>.sock) and `--role cto` (phones need a cto brain);
//   - ADE_SYNC_BIND_HOST=127.0.0.1: no LAN listener, no Bonjour advertising;
//   - guard-sync-port.cjs preloaded: never binds 8787, never sees or signals other processes, never
//     touches the tailnet config, never resolves ADE's cloud hosts.
// Writes <dir>/brain-<n>.json with { pid, socket, syncPort, log } once the sync listener is up.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const guard = path.join(here, "guard-sync-port.cjs");
// ADE_PERF_LOOP_DELAY_FILE=<file.jsonl> also preloads the event-loop stall probe, and
// ADE_PERF_EXTRA_REQUIRE=<file.cjs>[<path delimiter><file.cjs>...] any other preloads (spawn-trace.cjs,
// a statement timer).
const loopProbe = path.join(here, "loop-delay-preload.cjs");

const [command, ...rest] = process.argv.slice(2);
const dashdash = rest.indexOf("--");
const own = dashdash >= 0 ? rest.slice(0, dashdash) : rest;
const passthrough = dashdash >= 0 ? rest.slice(dashdash + 1) : [];
const read = (name, fallback = null) => {
  const index = own.indexOf(name);
  return index >= 0 ? own[index + 1] : fallback;
};
// --cli <built cli.cjs> measures another branch's build with this branch's isolation (guard, lease, socket).
const cli = path.resolve(read("--cli") ?? path.join(repo, "apps/ade-cli/dist/cli.cjs"));
const dir = read("--dir");
if (!dir) throw new Error("--dir <scratch dir> is required");
const n = read("--n", "1");
const root = path.resolve(dir);
const realHome = os.homedir();
// Windows and macOS paths are case-insensitive, so the check is too (this plain-node script cannot load
// pathCompare.ts).
const foldCase = (value) => (process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value);
const realAde = foldCase(path.join(realHome, ".ade"));
if (foldCase(root) === foldCase(realHome) || foldCase(root) === realAde || foldCase(root).startsWith(`${realAde}${path.sep}`)) {
  throw new Error("Refusing to use the real home");
}
const home = path.join(root, "home");
const adeHome = path.join(home, ".ade");
// The socket name carries a hash of the scratch dir: two lanes that both use the default --n 1 must not
// replace each other's brain (a new brain takes over a socket path and the old one exits).
const tag = `${createHash("sha256").update(root).digest("hex").slice(0, 8)}-${n}`;
const socket = process.platform === "win32" ? `\\\\.\\pipe\\ade-measure-${tag}` : `/tmp/ade-measure-${tag}.sock`;
const recordPath = path.join(root, `brain-${n}.json`);
const logPath = path.join(root, `brain-${n}.log`);

function brainEnv() {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ADE_HOME: adeHome,
    ADE_SYNC_BIND_HOST: "127.0.0.1",
    ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
    // The sync host lease is otherwise one machine-wide file in the OS temp dir, shared with the
    // installed brain and every other lane's measurement brain. Its own file keeps this brain from
    // reading or writing theirs (and from refusing to host because another measurement brain runs).
    ADE_SYNC_HOST_LOCK_PATH: path.join(root, "sync-host-lock.json"),
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) if (key.startsWith("ADE_PERF_")) env[key] = process.env[key];
  if (process.env.ADE_SPAWN_TRACE_DIR) env.ADE_SPAWN_TRACE_DIR = process.env.ADE_SPAWN_TRACE_DIR;
  // ADE_DISABLE_OFF_THREAD_SPAWN=1: Windows spawns run on the event loop again, so spawn-trace.cjs records
  // each process's real caller instead of the off-thread worker (attribution runs only, not timing).
  if (process.env.ADE_DISABLE_OFF_THREAD_SPAWN) env.ADE_DISABLE_OFF_THREAD_SPAWN = process.env.ADE_DISABLE_OFF_THREAD_SPAWN;
  return env;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function syncPort() {
  try {
    const out = execFileSync(process.execPath, [cli, "--socket", socket, "sync", "status", "--json"], {
      cwd: read("--cwd") ?? root,
      env: brainEnv(),
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const port = JSON.parse(out)?.localDevice?.lastPort;
    return Number.isInteger(port) && port !== 8787 ? port : null;
  } catch {
    return null;
  }
}

async function start() {
  if (!fs.existsSync(cli)) throw new Error(`Missing ${cli}; run npm --prefix apps/ade-cli run build first.`);
  if (!fs.existsSync(guard)) throw new Error(`Missing ${guard}; refusing to start a sync brain without the port guard.`);
  // An older build ignores ADE_SYNC_HOST_LOCK_PATH and would share the machine's sync host lease.
  if (!fs.readFileSync(cli, "utf8").includes("ADE_SYNC_HOST_LOCK_PATH")) {
    throw new Error(`${cli} does not read ADE_SYNC_HOST_LOCK_PATH; refusing to start it without its own sync host lease.`);
  }
  if (fs.existsSync(recordPath)) {
    const old = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (alive(old.pid)) throw new Error(`brain ${n} is already running (pid ${old.pid}); stop it first`);
  }
  fs.mkdirSync(adeHome, { recursive: true });
  if (process.platform !== "win32") fs.rmSync(socket, { force: true });
  const log = fs.openSync(logPath, "a");
  const extra = (process.env.ADE_PERF_EXTRA_REQUIRE ?? "").split(path.delimiter).filter(Boolean).map((file) => path.resolve(file));
  const preloads = ["--require", guard, ...(process.env.ADE_PERF_LOOP_DELAY_FILE ? ["--require", loopProbe] : []), ...extra.flatMap((file) => ["--require", file])];
  const child = spawn(process.execPath, [...preloads, cli, "--role", "cto", "serve", "--socket", socket], {
    cwd: root,
    env: brainEnv(),
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  child.unref();
  const record = { pid: child.pid, socket, syncPort: null, log: logPath, home, startedAt: new Date().toISOString() };
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (!alive(child.pid)) throw new Error(`brain exited during start; see ${logPath}`);
    const port = syncPort();
    if (port) {
      record.syncPort = port;
      fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      console.log(JSON.stringify(record));
      return;
    }
  }
  throw new Error(`sync listener did not come up in 60 s; see ${logPath} (pid ${child.pid} left running: stop it)`);
}

async function stop() {
  if (!fs.existsSync(recordPath)) return console.log(JSON.stringify({ stopped: false, reason: "no record" }));
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  // Only the pid this script started, and only while it still serves this script's socket.
  if (alive(record.pid)) {
    process.kill(record.pid, "SIGTERM");
    for (let i = 0; i < 30 && alive(record.pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (alive(record.pid)) process.kill(record.pid, "SIGKILL");
  }
  fs.rmSync(recordPath, { force: true });
  console.log(JSON.stringify({ stopped: true, pid: record.pid, stillAlive: alive(record.pid) }));
}

// A make-real-load-copy copy made before that script ended the copied chats still holds the source's
// running chats, and the brain resumes them once the project is added (it did, on a Mac and on Windows).
// Refuse to add one until they are ended.
async function refuseCopyWithRunningChats() {
  const at = passthrough.findIndex((arg, index) => arg === "projects" && passthrough[index + 1] === "add");
  const target = at >= 0 ? passthrough[at + 2] : undefined;
  if (!target) return;
  const projectAde = path.join(path.resolve(read("--cwd") ?? root, target), ".ade");
  if (!fs.existsSync(path.join(projectAde, "real-load-copy.json"))) return;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(projectAde, "ade.db"), { readOnly: true });
  let running = 0;
  try {
    running = Number(db.prepare("select count(*) as n from terminal_sessions where status = 'running'").get()?.n ?? 0);
  } finally {
    db.close();
  }
  if (running > 0) {
    throw new Error(
      `${path.dirname(projectAde)} still has ${running} running chat(s) from its source, and this brain would resume them. ` +
      `End them first: cd apps/ade-cli && npx tsx ../../scripts/perf/net/brain-rpc.mts --prepare ${path.dirname(projectAde)}`,
    );
  }
}

async function runCli() {
  await refuseCopyWithRunningChats();
  const result = spawn(process.execPath, [cli, "--socket", socket, ...passthrough], {
    cwd: read("--cwd") ?? root,
    env: brainEnv(),
    stdio: "inherit",
  });
  result.on("exit", (code) => process.exit(code ?? 1));
}

if (command === "start") await start();
else if (command === "stop") await stop();
else if (command === "cli") await runCli();
else throw new Error("usage: measure-brain.mjs start|stop|cli --dir <scratch dir> [--n 1]");
