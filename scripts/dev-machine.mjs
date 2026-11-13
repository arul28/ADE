#!/usr/bin/env node
/**
 * A dev test machine: this checkout's brain running on this computer as its
 * OWN machine on your account, with sync on, beside the installed ADE.
 *
 * `npm run dev:desktop` covers changes you can see from this computer: its
 * brain runs `--no-sync`, so nothing else can reach it. A change other machines
 * call into (a cloud box asking this Mac for a simulator, the phone, another
 * computer's desktop connecting) needs a branch brain that IS reachable. That
 * is this. It has its own ADE home, so its own machine key, device id, sign-in
 * and account row; it takes no lease, port or Tailscale entry from the
 * installed brain, and refuses any project the installed ADE uses (see
 * apps/ade-cli/src/services/sync/devTestMachine.ts).
 *
 *   npm run dev:machine -- start  [--name <n>] [--skip-build]
 *   npm run dev:machine -- login  [--name <n>]     sign it in once (prints a code)
 *   npm run dev:machine -- project --clone | <path> [--name <n>]
 *   npm run dev:machine -- status [--name <n>]
 *   npm run dev:machine -- stop   [--name <n>]
 *   npm run dev:machine -- remove [--name <n>]     sign out (drops its account row) and stop
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRuntimeCli,
  canConnectToSocket,
  cliPath,
  isRuntimeCliBuildFresh,
  repoRoot,
  resolveDevAppVersion,
  resolvePrimaryProjectRoot,
  sanitizeParentEnvForDevRuntime,
  shutdownRuntime,
  spawnWithHiddenConsole,
  waitForSocket,
} from "./dev-shared.mjs";

const COMMANDS = ["start", "login", "project", "status", "stop", "remove"];

function usage() {
  return [
    "Usage: npm run dev:machine -- <command> [--name <n>]",
    "",
    "Runs this checkout's brain as its own machine on your ADE account, sync on,",
    "beside the installed ADE. Other machines reach it over the relay or the LAN.",
    "",
    "Commands:",
    "  start            Build the CLI if needed and start the test machine's brain.",
    "  login            Sign it in once: prints a code to approve, then names the machine.",
    "  project --clone  Give it a clone of this repo (on this branch) to work in.",
    "  project <path>   Register a folder (never one the installed ADE uses).",
    "  status           Socket, sign-in and log.",
    "  stop             Stop its brain. Its home and sign-in stay.",
    "  remove           Sign it out (its account row goes) and stop it. Starts it first if it is stopped.",
    "",
    "Options:",
    "  --name <n>       Which test machine (default: dev). Each has its own home.",
    "  --skip-build     start: use the CLI build as it is.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { command: null, name: "dev", skipBuild: false, clone: false, projectPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--name") {
      options.name = argv[++i] ?? "";
      continue;
    }
    if (arg.startsWith("--name=")) {
      options.name = arg.slice("--name=".length);
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--clone") {
      options.clone = true;
      continue;
    }
    if (!options.command && COMMANDS.includes(arg)) {
      options.command = arg;
      continue;
    }
    if (options.command === "project" && !options.projectPath && !arg.startsWith("-")) {
      options.projectPath = path.resolve(arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  if (!options.command) throw new Error(usage());
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(options.name)) {
    throw new Error("--name takes letters, digits, '-' and '_' (up to 32).");
  }
  return options;
}

/**
 * Windows named pipes share one namespace for every user on the computer,
 * while each user's home is their own, so the pipe carries the user too.
 */
function windowsUserTag() {
  let user = "";
  try {
    user = os.userInfo().username.trim();
  } catch (error) {
    process.stderr.write(`[ade] couldn't read this user's name (${error instanceof Error ? error.message : String(error)}); using USERNAME.\n`);
  }
  if (!user) user = process.env.USERNAME?.trim() ?? "";
  const tag = user.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "user";
  // Two accounts can share a name (another domain) or sanitize to one: the
  // profile folder is unique per account on this computer, so it breaks ties.
  const profile = createHash("sha256").update(os.homedir().toLowerCase()).digest("hex").slice(0, 8);
  return `${tag}-${profile}`;
}

function machinePaths(name) {
  const home = path.join(os.homedir(), `.ade-dev-machine-${name}`);
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\ade-runtime-machine-${windowsUserTag()}-${name}`
    : path.join(os.tmpdir(), `ade-runtime-machine-${name}.sock`);
  return { home, socketPath, logPath: path.join(home, "logs", "dev-machine.out.log") };
}

/** The env every command runs with: the sanitized shell, pointed at the test machine. */
function machineEnv(paths) {
  const env = {
    ...sanitizeParentEnvForDevRuntime(process.env),
    ADE_HOME: paths.home,
    ADE_RUNTIME_SOCKET_PATH: paths.socketPath,
    ADE_RPC_SOCKET_PATH: paths.socketPath,
    ADE_CLI_VERSION: resolveDevAppVersion(),
    // Development to Sentry, PostHog and automatic reports (`sentry/brainBuild.ts`).
    ADE_DEV_BRAIN: "1",
    ADE_DEFAULT_ROLE: "cto",
    ADE_SYNC_HOST_LOCK_PATH: path.join(paths.home, "sync-host-lock.json"),
    // A checkout's bundle copied outside apps/(ade-cli|desktop)/(src|dist)/
    // would mark itself packaged (packagedRuntimeFlag.ts) and refuse the
    // development Clerk settings. A test machine is never a packaged build.
    ADE_RUNTIME_PACKAGED: "0",
  };
  // A test machine runs for as long as you use it; it never idles out.
  delete env.ADE_RUNTIME_IDLE_EXIT_MS;
  delete env.ADE_RUNTIME_PARENT_PID;
  delete env.ADE_PROJECT_ROOT;
  delete env.ADE_WORKSPACE_ROOT;
  return env;
}

/** Runs this checkout's `ade` against the test machine and returns its output. */
function ade(paths, args, { inherit = false } = {}) {
  const result = spawnSync(process.execPath, [cliPath(), ...args], {
    env: machineEnv(paths),
    cwd: paths.home,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    windowsHide: true,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function authState(paths) {
  const out = ade(paths, ["auth", "status", "--json"]);
  try {
    return JSON.parse(out.stdout).sessionState ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function start(paths, options) {
  if (await canConnectToSocket(paths.socketPath)) {
    process.stdout.write(`[ade] test machine "${options.name}" is already running at ${paths.socketPath}\n`);
    return report(paths, options);
  }
  await startBrain(paths, options);
  report(paths, options);
}

/**
 * Marks the home as a dev test machine's (apps/ade-cli/src/services/sync/devTestMachine.ts).
 * Before anything else touches it: every `ade` command on it, not only the
 * brain, then refuses the installed ADE's projects.
 */
function markHome(paths) {
  fs.mkdirSync(paths.home, { recursive: true });
  const marker = path.join(paths.home, "dev-test-machine.json");
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, `${JSON.stringify({ markedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** Starts the test machine's brain and waits for its socket. */
async function startBrain(paths, options) {
  if (!options.skipBuild && !isRuntimeCliBuildFresh()) await buildRuntimeCli(false);
  fs.mkdirSync(path.dirname(paths.logPath), { recursive: true });
  markHome(paths);
  const args = [cliPath(), "--role", "cto", "serve", "--dev-test-machine", "--socket", paths.socketPath];
  const env = machineEnv(paths);
  let child;
  if (process.platform === "win32") {
    child = spawnWithHiddenConsole(process.execPath, args, { logPath: paths.logPath, cwd: paths.home, env });
  } else {
    const fd = fs.openSync(paths.logPath, "a");
    child = spawn(process.execPath, args, { cwd: paths.home, env, detached: true, stdio: ["ignore", fd, fd] });
    fs.closeSync(fd);
  }
  child.unref();
  try {
    await waitForSocket(paths.socketPath, 60_000);
  } catch {
    throw new Error(`The test machine's brain did not open ${paths.socketPath}. See ${paths.logPath}.`);
  }
}

function report(paths, options) {
  const state = authState(paths);
  const lines = [
    `[ade] dev test machine "${options.name}"`,
    `[ade]   home     : ${paths.home} (its own machine: own key, device id, sign-in)`,
    `[ade]   socket   : ${paths.socketPath}`,
    `[ade]   sync     : ON, relay + LAN; no Tailscale entry; own lease`,
    `[ade]   sign-in  : ${state}`,
    `[ade]   log      : ${paths.logPath}`,
    "[ade]   installed brain: untouched (its lease, port, Tailscale entry and projects)",
  ];
  if (state !== "active") lines.push(`[ade] next: npm run dev:machine -- login${options.name === "dev" ? "" : ` --name ${options.name}`}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** The name people know this computer by: the Mac's Computer Name, else the hostname. */
function computerName() {
  if (process.platform === "darwin") {
    const name = spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", windowsHide: true }).stdout?.trim();
    if (name) return name;
  }
  return os.hostname().replace(/\.(local|lan)$/i, "");
}

async function login(paths, options) {
  if (!(await canConnectToSocket(paths.socketPath))) throw new Error("Start it first: npm run dev:machine -- start");
  if (authState(paths) !== "active") {
    process.stdout.write("[ade] Approve this code in a browser signed in to your ADE account.\n");
    const result = ade(paths, ["login", "--headless", "--max-wait", "600"], { inherit: true });
    if (result.status !== 0) throw new Error("Sign-in did not finish.");
  }
  // Its row would otherwise carry this computer's own name, next to the
  // installed ADE's row with the same name.
  const label = `${computerName()} (${options.name === "dev" ? "dev" : `dev ${options.name}`})`;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const listed = ade(paths, ["machines", "list", "--json"]);
    let machines = [];
    try {
      const parsed = JSON.parse(listed.stdout);
      machines = Array.isArray(parsed) ? parsed : parsed.machines ?? [];
    } catch {
      machines = [];
    }
    // `isThisMachine` in one output shape, the home the row reports in the
    // other. The whole path: every computer's test machine has a home with
    // the same folder name, and matching on it renamed another computer's row.
    const self = machines.find((machine) => machine.isThisMachine
      || (typeof machine.adeHome === "string" && path.resolve(machine.adeHome) === path.resolve(paths.home)));
    if (self?.machineKey) {
      if (self.name !== label) ade(paths, ["machines", "rename", self.machineKey, label]);
      process.stdout.write(`[ade] signed in and published as "${label}" (${self.machineKey})\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  process.stdout.write("[ade] signed in; its account row has not appeared yet. Check: npm run dev:machine -- status\n");
}

function project(paths, options) {
  // Before `ade init` below: without the marker that command would register an
  // installed ADE's project here, and the dev brain would then open it.
  markHome(paths);
  let target = options.projectPath;
  if (options.clone) {
    const source = resolvePrimaryProjectRoot(repoRoot);
    const branch = spawnSync("git", ["-C", repoRoot, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    target = path.join(paths.home, "projects", path.basename(source));
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // --shared borrows the source's objects: seconds, not a full copy.
      const cloned = spawnSync("git", ["clone", "--shared", ...(branch ? ["--branch", branch] : []), source, target], { stdio: "inherit", windowsHide: true });
      if (cloned.status !== 0) throw new Error("git clone failed.");
    }
    // Machines match a repository by its origin. A clone's origin is the local
    // folder it came from; give it the real one, so `--machine` finds it.
    const origin = spawnSync("git", ["-C", source, "remote", "get-url", "origin"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    if (origin) spawnSync("git", ["-C", target, "remote", "set-url", "origin", origin], { stdio: "inherit", windowsHide: true });
  }
  if (!target) throw new Error("project takes --clone or a folder path.");
  // The brain refuses a project the installed ADE uses; this says so first.
  const result = ade(paths, ["init", target], { inherit: true });
  if (result.status !== 0) throw new Error(`Could not register ${target}.`);
}

async function stop(paths, { quiet = false } = {}) {
  if (!(await canConnectToSocket(paths.socketPath))) {
    if (!quiet) process.stdout.write("[ade] the test machine is not running.\n");
    return;
  }
  await shutdownRuntime(paths.socketPath);
  if (!quiet) process.stdout.write("[ade] stopped. Its home and sign-in are kept.\n");
}

/**
 * Signs the test machine out (which drops its account row) and stops it. Sign-out
 * goes through its brain, so a stopped one is started for it. Success is
 * reported only once `auth status` says signed_out.
 */
async function remove(paths, options) {
  const nameFlag = options.name === "dev" ? "" : ` --name ${options.name}`;
  if (!fs.existsSync(paths.home)) {
    process.stdout.write(`[ade] there is no test machine "${options.name}" on this computer (${paths.home}); nothing to remove.\n`);
    return;
  }
  const wasRunning = await canConnectToSocket(paths.socketPath);
  if (!wasRunning) {
    process.stdout.write(`[ade] starting test machine "${options.name}" to sign it out…\n`);
    await startBrain(paths, options);
  }
  const before = authState(paths);
  let after = before;
  let logoutStatus = 0;
  if (before !== "signed_out") {
    logoutStatus = ade(paths, ["logout"], { inherit: true }).status;
    after = authState(paths);
  }
  if (after !== "signed_out") {
    // Leave it as it was found, so a retry starts from the same place.
    if (!wasRunning) await stop(paths, { quiet: true });
    throw new Error(
      `the test machine is still ${after === "unknown" ? "in a sign-in state ADE couldn't read" : after} after sign-out`
        + `${logoutStatus !== 0 ? ` (ade logout exited ${logoutStatus})` : ""}, so its account row may still be on your account. `
        + `Run npm run dev:machine -- remove${nameFlag} again; if it keeps failing, remove it from Your computers in ADE. `
        + `Its log: ${paths.logPath}`,
    );
  }
  await stop(paths, { quiet: true });
  if (before === "expired") {
    // An expired session can't tell the account to drop the row.
    process.stdout.write(`[ade] signed out and stopped. Its sign-in had expired, so its row may still be on your account: remove it from Your computers in ADE. Delete ${paths.home} too if you no longer need its files.\n`);
    return;
  }
  process.stdout.write(`[ade] signed out and stopped; its account row is gone. Delete ${paths.home} too if you no longer need its files.\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = machinePaths(options.name);
  if (options.command === "start") return start(paths, options);
  if (options.command === "login") return login(paths, options);
  if (options.command === "project") return project(paths, options);
  if (options.command === "status") return report(paths, options);
  if (options.command === "stop") return stop(paths);
  return remove(paths, options);
}

main().catch((error) => {
  process.stderr.write(`[ade] dev:machine failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
