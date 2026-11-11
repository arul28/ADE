#!/usr/bin/env node
// Tests one build of ADE's cloud template on a real computer and, when asked,
// moves the version ADE's server creates and updates computers to.
//
//   AGENT37_API_KEY=sk_live_... node infra/ade-cloud/promote-template.mjs 9
//   AGENT37_API_KEY=sk_live_... node infra/ade-cloud/promote-template.mjs 9 --move --channel beta --expect-version v1.2.130-beta.1 --env production
//   AGENT37_API_KEY=sk_live_... node infra/ade-cloud/promote-template.mjs --move-back 8 --channel stable --env production
//
// --channel is the update channel whose image moves: `beta` writes
// template_version_beta, `stable` writes template_version_stable and the older
// template_version. Each also writes auto_update_<channel>, which lets that
// channel's computers update themselves to it when idle or asleep (the server's
// src/cloud/updates.ts). Stable never moves to a prerelease build.
// --expect-version vX.Y.Z fails the test unless the computer runs exactly that
// ADE (the release the image was built from).
// --env is production, development or local (the `wrangler dev` database).
// --min-version vX.Y.Z creates the test computer with ADE_MIN_VERSION set, to
// time the first-start install. The test clones a small public repository,
// opens it as a project, reads and creates lanes and runs a command in a
// terminal before the sleep and stop checks. The computer is tagged
// created_by: ade-template-check, is always deleted (also on Ctrl-C), and the
// whole test gives up after 20 minutes.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.agent37.com/v1";
const SANDBOX = "https://sandbox.agent37.app/v1";
const TEMPLATE = "ade";
const DATABASES = { production: "ade-account-directory-production", development: "ade-account-directory", local: "ade-account-directory" };
const DIRECTORY_APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "account-directory");
/** A tiny public repository: the test's project. No private data. */
const CHECK_REPO = "https://github.com/octocat/Hello-World.git";
const TEST_TIMEOUT_MS = 20 * 60_000;
const CHANNELS = new Set(["stable", "beta"]);

const key = (process.env.AGENT37_API_KEY ?? "").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => { console.error(`promote-template: ${message}`); process.exit(1); };

function parseArgs(argv) {
  const args = { build: null, move: false, moveBack: null, env: null, minVersion: null, channel: null, expectVersion: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--move") args.move = true;
    else if (arg === "--move-back") args.moveBack = argv[++i];
    else if (arg === "--env") args.env = argv[++i];
    else if (arg === "--min-version") args.minVersion = argv[++i];
    else if (arg === "--channel") args.channel = argv[++i];
    else if (arg === "--expect-version") args.expectVersion = argv[++i];
    else if (/^\d+$/.test(arg)) args.build = Number(arg);
    else fail(`unknown argument "${arg}".`);
  }
  return args;
}

async function call(url, init, timeoutMs = 20_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!response.ok) {
    const code = body?.error?.code ?? body?.error ?? `http_${response.status}`;
    throw Object.assign(new Error(`${init.method} ${new URL(url).pathname}: ${response.status} ${code}`), { status: response.status, code });
  }
  return body;
}

const api = (method, path, body, timeoutMs) => call(`${API}${path}`, {
  method,
  headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
}, timeoutMs);

const exec = (id, command, timeoutMs = 40_000) => call(`${SANDBOX}/instances/${id}/exec`, {
  method: "POST",
  headers: { "x-agent37-key": key, "content-type": "application/json" },
  body: JSON.stringify({ command }),
}, timeoutMs);

async function until(what, deadlineMs, attempt, pollMs = 1_000) {
  const deadline = Date.now() + deadlineMs;
  let last = null;
  for (;;) {
    try {
      const result = await attempt();
      if (result) return result;
    } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time${last ? ` (${last.message})` : ""}.`);
    await sleep(pollMs);
  }
}

const untilStatus = (id, status) => until(`status ${status}`, 240_000, async () =>
  (await api("GET", `/instances/${id}`)).status === status);

// `ade auth status` answers only through the brain, signed in or not.
const untilBrain = (id, deadlineMs = 300_000) => until("ADE's brain answering", deadlineMs, async () => {
  const result = await exec(id, "timeout 20 ade auth status --json 2>/dev/null");
  return result.exit_code === 0 && result.stdout.includes("{");
}, 2_000);

async function verifyFile(id, path, token) {
  const read = await until("reading the file", 60_000, () => exec(id, `cat ${path}`));
  if (read.stdout.trim() !== token) throw new Error(`the file in the home folder changed: "${read.stdout.trim()}"`);
}

/** Every value stored under `key` anywhere in a JSON answer. */
function valuesOf(value, key, found = []) {
  if (Array.isArray(value)) for (const item of value) valuesOf(item, key, found);
  else if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) {
      if (name === key && typeof item === "string") found.push(item);
      else valuesOf(item, key, found);
    }
  }
  return found;
}

/** `ade lanes list --json` in the project, parsed; throws with what ADE said. */
async function listLanes(id, dir) {
  const lanes = await exec(id, `cd ${dir} && timeout 60 ade lanes list --json`, 90_000);
  let body = null;
  try { body = JSON.parse(lanes.stdout); } catch { /* not JSON */ }
  if (lanes.exit_code !== 0 || !body) throw new Error(`listing lanes failed: ${(lanes.stderr || lanes.stdout).trim()}`);
  return body;
}

/**
 * What a person does first: open a real repository as a project, see its
 * lanes, make a lane, run a command in a terminal. A brain can answer
 * `ade auth status` and still fail these (the terminal module built for a
 * newer Linux than the computer runs, 2026-11-09).
 */
async function realUse(id) {
  const dir = "/home/node/ade-template-check-project";
  const made = await exec(id, [
    `rm -rf ${dir}`,
    `timeout 120 git clone -q --depth 1 ${CHECK_REPO} ${dir}`,
    `cd ${dir}`,
    `ade projects add ${dir}`,
  ].join(" && "), 180_000);
  if (made.exit_code !== 0) throw new Error(`cloning and adding a project failed: ${(made.stderr || made.stdout).trim()}`);

  const before = await listLanes(id, dir);
  console.log(`project opened, ${valuesOf(before, "branchRef").length} lane(s)`);

  const laneName = `check-${randomBytes(3).toString("hex")}`;
  const created = await exec(id, `cd ${dir} && timeout 120 ade lanes create --name ${laneName} --json`, 150_000);
  if (created.exit_code !== 0) throw new Error(`creating a lane failed: ${(created.stderr || created.stdout).trim()}`);
  const after = await listLanes(id, dir);
  if (!valuesOf(after, "name").includes(laneName)) throw new Error(`the new lane ${laneName} is not in the lane list`);
  console.log(`lane ${laneName} created`);

  // The output differs from the typed text (the quotes go), so the echo of
  // the input alone can't pass.
  const [head, tail] = [`pty-${randomBytes(4).toString("hex")}`, randomBytes(4).toString("hex")];
  const marker = `${head}-${tail}`;
  const started = await exec(id, `cd ${dir} && timeout 60 ade --role cto shell start --json -c 'echo ${head}"-"${tail}'`, 90_000);
  let startedBody = null;
  try { startedBody = JSON.parse(started.stdout); } catch { /* not JSON */ }
  const ptyId = startedBody ? valuesOf(startedBody, "ptyId")[0] : null;
  if (started.exit_code !== 0 || !ptyId) throw new Error(`starting a terminal failed: ${(started.stderr || started.stdout).trim()}`);
  // Read back from the terminal itself, so the marker shows only if a pty
  // started. `--role cto`: a person's terminal; the default role may only
  // touch its own session's.
  await until("the terminal's output", 60_000, async () => {
    const read = await exec(id, `cd ${dir} && timeout 20 ade --role cto terminal read --pty ${ptyId} --text`);
    return read.exit_code === 0 && read.stdout.includes(marker);
  }, 2_000);
  console.log("terminal ran a command");
}

/** Retries a power call while the provider answers `409 try_again` (a sleep save in progress). */
async function power(id, action) {
  for (let i = 0; ; i += 1) {
    try { return await api("POST", `/instances/${id}/${action}`, undefined, 180_000); } catch (error) {
      if (error.status !== 409 || i >= 20) throw error;
      await sleep(3_000);
    }
  }
}

/** This run's tag on its test computer: cleanup finds it by that, never by id. */
const run = randomBytes(4).toString("hex");
const tagged = (instance) => instance.metadata?.created_by === "ade-template-check" && instance.metadata?.template_check_run === run;

async function cleanup() {
  // By tag, not by id: a create that timed out may still have made a computer.
  const list = await api("GET", "/instances").then((body) => body.data ?? []);
  for (const instance of list.filter(tagged)) {
    await api("DELETE", `/instances/${instance.id}`).catch((error) => { if (error.status !== 404) throw error; });
    await until("delete", 90_000, () => api("GET", `/instances/${instance.id}`).then(
      () => false,
      (error) => { if (error.status === 404) return true; throw error; },
    ));
    console.log(`deleted ${instance.id}`);
  }
}

/** `ade 1.2.130-beta.1` or `v1.2.130-beta.1` → `1.2.130-beta.1`. */
const bareVersion = (value) => String(value ?? "").trim().replace(/^ade\s+/, "").replace(/^v/, "");
const isPrerelease = (value) => bareVersion(value).includes("-");

async function test(build, minVersion, expectVersion) {
  const timings = {};
  const lap = (name, since) => { timings[name] = Date.now() - since; };
  const interrupted = async () => { await cleanup().catch((error) => console.error(error.message)); process.exit(130); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  // The whole test, create to delete. A hung step must not hold a computer (or the CI job) for hours.
  const timeout = setTimeout(() => {
    console.error(`promote-template: ${TEMPLATE}@${build} failed: the test took longer than ${TEST_TIMEOUT_MS / 60_000} minutes.`);
    void cleanup().catch((error) => console.error(error.message)).finally(() => process.exit(1));
  }, TEST_TIMEOUT_MS);

  try {
    const start = Date.now();
    const instance = await api("POST", "/instances", {
      template: `${TEMPLATE}@${build}`,
      name: `ade-template-check-${run}`,
      type: "default",
      resources: { cpu: 2, memory: 4, disk: 4 },
      auto_sleep: false,
      metadata: { created_by: "ade-template-check", template_check_run: run },
      ...(minVersion ? { env: { ADE_MIN_VERSION: minVersion } } : {}),
    }, 360_000);
    lap("create_answered", start);
    const id = instance.id;
    console.log(`computer ${id} (${instance.status}, template ${instance.template} revision ${instance.template_revision})`);

    await until("first command", 120_000, async () => (await exec(id, "true")).exit_code === 0);
    lap("first_command", start);

    const version = await until("ADE on the computer", 120_000, async () => {
      const out = await exec(id, "ade --version");
      return out.exit_code === 0 && out.stdout.trim();
    });
    lap("ade_version", start);
    console.log(`ADE: ${version}`);
    // The image installs the release of its tag, never "the newest stable".
    if (expectVersion && bareVersion(version) !== bareVersion(expectVersion)) {
      throw new Error(`the computer runs ${version}, not ${bareVersion(expectVersion)}`);
    }

    await untilBrain(id);
    lap("brain_answers", start);
    if (minVersion) {
      const installed = await exec(id, "tail -n 40 /home/node/.ade/logs/brain-entrypoint.log | grep -E 'installing|starting the brain'; /home/node/.ade/bin/ade --version");
      console.log(`first-start install:\n${installed.stdout.trim()}`);
    }

    const terminal = await exec(id, `sh -c 'cd "$HOME" && echo terminal-$(whoami) && uname -s'`);
    if (terminal.exit_code !== 0 || !terminal.stdout.includes("terminal-")) throw new Error(`terminal command failed: ${terminal.stderr}`);
    console.log(`terminal: ${terminal.stdout.trim().replace(/\n/g, " ")}`);

    await realUse(id);
    lap("project_and_terminal", start);

    const token = randomBytes(8).toString("hex");
    const path = "/home/node/ade-template-check-file";
    await exec(id, `printf %s ${token} > ${path}`);

    let mark = Date.now();
    await power(id, "sleep");
    await untilStatus(id, "sleeping");
    lap("sleep", mark);
    mark = Date.now();
    await power(id, "start");
    await untilStatus(id, "running");
    await untilBrain(id);
    lap("wake_to_brain", mark);
    await verifyFile(id, path, token);
    console.log("file survived sleep and wake");

    mark = Date.now();
    await power(id, "stop");
    await untilStatus(id, "stopped");
    lap("stop", mark);
    mark = Date.now();
    await power(id, "start");
    await untilStatus(id, "running");
    await untilBrain(id);
    lap("start_to_brain", mark);
    await verifyFile(id, path, token);
    console.log("file survived stop and start");

    return { timings, version };
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await cleanup();
  }
}

// `cloud_settings` holds the server's settings (apps/account-directory/src/cloud/).
// The channel's image key, and auto_update_<channel>: the image a passed check
// lets that channel's computers update to on their own. Stable also writes
// template_version, the one setting older Workers read.
function setVersion(env, build, channel) {
  const database = DATABASES[env];
  if (!database) fail("--env must be production, development or local.");
  const version = `${TEMPLATE}@${build}`;
  const keys = channel === "stable"
    ? ["template_version_stable", "template_version", "auto_update_stable"]
    : ["template_version_beta", "auto_update_beta"];
  const now = Date.now();
  const sql = keys.map((name) => `INSERT INTO cloud_settings (key, value, updated_at) VALUES ('${name}', '${version}', ${now}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`).join(" ");
  const location = env === "local" ? "--local" : "--remote";
  execFileSync("npx", ["--yes", "wrangler", "d1", "execute", database, location, "--command", sql, ...(env === "production" ? ["--env", "production"] : [])], {
    cwd: DIRECTORY_APP,
    stdio: "inherit",
  });
  console.log(`${env}: ${keys.join(", ")} now ${version}`);
}

const args = parseArgs(process.argv.slice(2));
if (!key) fail("set AGENT37_API_KEY.");
if (args.channel != null && !CHANNELS.has(args.channel)) fail("--channel must be stable or beta.");
if ((args.move || args.moveBack != null) && !args.channel) fail("--move and --move-back need --channel stable|beta.");
if (args.channel === "stable" && args.expectVersion && isPrerelease(args.expectVersion)) {
  fail(`${args.expectVersion} is a prerelease; stable never moves to one.`);
}

if (args.moveBack != null) {
  const build = Number(args.moveBack);
  if (!Number.isInteger(build) || build < 1) fail("--move-back needs a build number.");
  if (!args.env) fail("--move-back needs --env.");
  const template = await api("GET", `/templates/${TEMPLATE}`);
  if (!(template.revisions ?? []).some((revision) => revision.revision === build)) fail(`${TEMPLATE}@${build} does not exist.`);
  setVersion(args.env, build, args.channel);
} else {
  if (args.build == null) fail("give a build number, or --move-back N.");
  if (args.move && !args.env) fail("--move needs --env.");
  let version;
  try {
    const result = await test(args.build, args.minVersion, args.expectVersion);
    version = result.version;
    console.log(JSON.stringify({ template: `${TEMPLATE}@${args.build}`, version, passed: true, timings_ms: result.timings }, null, 2));
  } catch (error) {
    fail(`${TEMPLATE}@${args.build} failed: ${error.message}`);
  }
  if (args.move) {
    // What the computer really ran, too: a build of a prerelease never becomes stable.
    if (args.channel === "stable" && isPrerelease(version)) fail(`${TEMPLATE}@${args.build} runs ${version}, a prerelease; stable never moves to one.`);
    setVersion(args.env, args.build, args.channel);
  }
}
