#!/usr/bin/env node
// Opens a project database made by the last stable release with the build that
// is about to be published (T3 #25928, #25840: nightlies passed CI and then
// would not open people's data).
//
//   node apps/desktop/scripts/old-database-launch-check.mjs --app <ADE.app | win-unpacked> [--old v1.2.126]
//
// 1. Downloads the old release's standalone runtime (`ade-<platform>-<arch>`
//    and its native archive), checked against the release's SHA256SUMS.
// 2. In a temporary home, the old runtime starts a brain, adds a git project
//    and lists its lanes: that creates and migrates the project database.
// 3. The new app's own brain (the packaged app binary running its bundled
//    cli.cjs, as the login service does) opens the same project.
//
// It passes when the new brain lists the same lane, records its version in
// the database's compat record, copies the old database first, and logs no
// database failure. `--old` defaults to the latest stable release on GitHub.
// Downloads over HTTPS; GH_TOKEN, when set, only raises the API rate limit.
// Touches nothing outside its temporary folder; the real ~/.ade is never read.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";
const repo = process.env.GITHUB_REPOSITORY || "arul28/ADE";
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};

function fail(message) {
  console.error(`[old-db-check] FAIL: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[old-db-check] ${message}`);
}

const appArg = flag("--app");
if (!appArg) fail("usage: old-database-launch-check.mjs --app <ADE.app | win-unpacked> [--old vX.Y.Z]");
const appPath = path.resolve(appArg);

/** GitHub over HTTPS: release files are public; a token only raises the API rate limit. */
async function github(url) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(url, { headers: token && url.startsWith("https://api.github.com/") ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) fail(`GET ${url} answered ${response.status}`);
  return response;
}

const oldTag = flag("--old") || (await (await github(`https://api.github.com/repos/${repo}/releases/latest`)).json()).tag_name;
const target = isWindows ? "win32-x64" : `darwin-${process.arch}`;
const binaryName = isWindows ? `ade-${target}.exe` : `ade-${target}`;
const archiveName = `ade-${target}.native.tar.gz`;

// Short paths: a Unix socket path must stay under about 100 characters.
const work = fs.mkdtempSync(path.join(isWindows ? os.tmpdir() : "/tmp", "ade-odb-"));
const home = path.join(work, "home");
const project = path.join(work, "project");
const oldRuntime = path.join(work, "old-runtime");
fs.mkdirSync(home);
fs.mkdirSync(project);
fs.mkdirSync(oldRuntime);

const children = new Set();
process.on("exit", () => {
  for (const child of children) child.kill();
  if (process.env.ADE_OLD_DB_CHECK_KEEP) return;
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // Windows can hold a file of a brain that just exited; the runner is thrown away anyway.
  }
});

log(`old release ${oldTag} (${binaryName}); new app ${appPath}; work folder ${work}`);
for (const name of [binaryName, archiveName, "SHA256SUMS"]) {
  const response = await github(`https://github.com/${repo}/releases/download/${oldTag}/${name}`);
  fs.writeFileSync(path.join(work, name), Buffer.from(await response.arrayBuffer()));
}
const sums = new Map(
  fs.readFileSync(path.join(work, "SHA256SUMS"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+\*?/))
    .filter((parts) => parts.length === 2)
    .map(([digest, name]) => [name, digest]),
);
for (const name of [binaryName, archiveName]) {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(work, name))).digest("hex");
  if (sums.get(name) !== digest) fail(`${name} from ${oldTag} does not match its SHA256SUMS entry`);
}
fs.chmodSync(path.join(work, binaryName), 0o755);
// Windows' own bsdtar: Git's GNU tar, when it comes first on PATH, reads "C:" as a remote host.
const tarBinary = isWindows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
const untar = spawnSync(tarBinary, ["-xzf", path.join(work, archiveName), "-C", oldRuntime], { stdio: "inherit" });
if (untar.status !== 0) fail(`could not unpack ${archiveName}`);

const delimiter = isWindows ? ";" : ":";
/** Only what the processes need; no ADE_* variable from the runner leaks in. */
function baseEnv() {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    ADE_HOME: path.join(home, ".ade"),
    TMPDIR: work,
    TEMP: work,
    TMP: work,
  };
  if (isWindows) {
    env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    env.APPDATA = path.join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  }
  return env;
}

const oldCommand = {
  file: path.join(work, binaryName),
  prefix: [],
  env: {
    ...baseEnv(),
    ADE_RUNTIME_ROOT: oldRuntime,
    ADE_RUNTIME_NODE_MODULES: path.join(oldRuntime, "node_modules"),
    NODE_PATH: path.join(oldRuntime, "node_modules"),
  },
};

function newAppCommand() {
  const resources = isWindows ? path.join(appPath, "resources") : path.join(appPath, "Contents", "Resources");
  const executable = isWindows ? path.join(appPath, "ADE.exe") : path.join(appPath, "Contents", "MacOS", "ADE");
  const cli = path.join(resources, "ade-cli", "cli.cjs");
  for (const required of [executable, cli]) if (!fs.existsSync(required)) fail(`the new app has no ${required}`);
  const archive = isWindows ? "x64" : process.arch;
  const nodePath = [`app-${archive}.asar.unpacked`, "app.asar.unpacked", `app-${archive}.asar`, "app.asar"]
    .map((name) => path.join(resources, name, "node_modules"))
    .filter((dir) => fs.existsSync(path.dirname(dir)))
    .join(delimiter);
  return { file: executable, prefix: [cli], env: { ...baseEnv(), ELECTRON_RUN_AS_NODE: "1", NODE_PATH: nodePath } };
}

function run(command, cliArgs) {
  const result = spawnSync(command.file, [...command.prefix, ...cliArgs], { env: command.env, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) {
    fail(`ade ${cliArgs.join(" ")} exited ${result.status ?? result.signal}:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** Starts `runtime run` and waits for its "listening" line. */
async function startBrain(command, socket, logFile) {
  const out = fs.openSync(logFile, "w");
  const child = spawn(command.file, [...command.prefix, "runtime", "run", "--socket", socket], {
    env: command.env,
    stdio: ["ignore", out, out],
  });
  children.add(child);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`the brain exited ${child.exitCode} before it listened:\n${fs.readFileSync(logFile, "utf8")}`);
    if (fs.readFileSync(logFile, "utf8").includes("ADE brain listening on")) return child;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`the brain did not listen within 120 s:\n${fs.readFileSync(logFile, "utf8")}`);
}

async function stopBrain(child) {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  children.delete(child);
}

function socketFor(name) {
  return isWindows ? `\\\\.\\pipe\\ade-odb-${process.pid}-${name}` : path.join(work, `${name}.sock`);
}

function primaryLaneId(text) {
  const id = /\(id: ([0-9a-f-]{36})\)/.exec(text)?.[1];
  if (!id) fail(`no lane in the lane list:\n${text}`);
  return id;
}

const git = (gitArgs) => spawnSync("git", ["-C", project, ...gitArgs], { stdio: "ignore" }).status === 0;
if (!git(["init", "-q"]) || !git(["-c", "user.email=ci@ade.invalid", "-c", "user.name=ADE CI", "commit", "-q", "--allow-empty", "-m", "init"])) {
  fail("could not create the test git project");
}

// The old release makes the database.
const oldVersion = run(oldCommand, ["--version"]).trim().replace(/^ade\s+/, "");
const oldSocket = socketFor("old");
const oldBrain = await startBrain(oldCommand, oldSocket, path.join(work, "old-brain.log"));
run(oldCommand, ["--socket", oldSocket, "init", project]);
const laneBefore = primaryLaneId(run(oldCommand, ["--socket", oldSocket, "lanes", "list", "--project-root", project, "--text"]));
await stopBrain(oldBrain);
const dbPath = path.join(project, ".ade", "ade.db");
if (!fs.existsSync(dbPath)) fail(`${oldVersion} made no project database at ${dbPath}`);
log(`${oldVersion} made ${dbPath} (${fs.statSync(dbPath).size} bytes), lane ${laneBefore}`);

// The new build opens it.
const newCommand = newAppCommand();
const newVersion = run(newCommand, ["--version"]).trim().replace(/^ade\s+/, "");
const newSocket = socketFor("new");
const newLog = path.join(work, "new-brain.log");
const newBrain = await startBrain(newCommand, newSocket, newLog);
const laneAfter = primaryLaneId(run(newCommand, ["--socket", newSocket, "lanes", "list", "--project-root", project, "--text"]));
await stopBrain(newBrain);

const problems = [];
if (laneAfter !== laneBefore) problems.push(`the lane changed: ${laneBefore} before, ${laneAfter} after`);
const brainLog = fs.readFileSync(newLog, "utf8");
const dbFailures = brainLog.split(/\r?\n/).filter((line) => /"?db\.[a-z_]*(fail|error)[a-z_]*"?/i.test(line) || /\bmigration[a-z_]*_failed\b/i.test(line));
if (dbFailures.length > 0) problems.push(`the new brain logged database failures:\n  ${dbFailures.join("\n  ")}`);
const recordPath = `${dbPath}.compat.json`;
let record = null;
try {
  record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
} catch {
  problems.push(`no readable compat record at ${recordPath}`);
}
if (record && record.lastOpenedVersion !== newVersion) {
  problems.push(`the compat record names ${record.lastOpenedVersion}, not ${newVersion}`);
}
const copies = fs.readdirSync(path.dirname(dbPath)).filter((name) => name.startsWith(`ade.db.pre-${newVersion}-from-`) && name.endsWith(".bak"));
if (oldVersion !== newVersion && copies.length === 0) {
  problems.push(`no copy of the old database (ade.db.pre-${newVersion}-from-*.bak)`);
}

if (problems.length > 0) {
  console.error(`[old-db-check] new brain log:\n${brainLog}`);
  fail(`${newVersion} did not open the database ${oldVersion} made:\n- ${problems.join("\n- ")}`);
}
log(`PASS: ${newVersion} opened the project database ${oldVersion} made (lane ${laneAfter}, copy ${copies[0] ?? "not needed"}).`);
