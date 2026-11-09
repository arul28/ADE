#!/usr/bin/env node
// Tests one build of ADE's cloud template on a real computer and, when asked,
// moves the version ADE's server creates computers from.
//
//   AGENT37_API_KEY=sk_live_... node infra/ade-cloud/promote-template.mjs 9
//   AGENT37_API_KEY=sk_live_... node infra/ade-cloud/promote-template.mjs 9 --move --env production
//   AGENT37_API_KEY=sk_live_... node infra/ade-cloud/promote-template.mjs --move-back 8 --env production
//
// --env is production, development or local (the `wrangler dev` database).
// --min-version vX.Y.Z creates the test computer with ADE_MIN_VERSION set, to
// time the first-start install. The computer is tagged created_by: ade-template-check and
// is always deleted, including on Ctrl-C.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.agent37.com/v1";
const SANDBOX = "https://sandbox.agent37.app/v1";
const TEMPLATE = "ade";
const DATABASES = { production: "ade-account-directory-production", development: "ade-account-directory", local: "ade-account-directory" };
const DIRECTORY_APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "account-directory");

const key = (process.env.AGENT37_API_KEY ?? "").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => { console.error(`promote-template: ${message}`); process.exit(1); };

function parseArgs(argv) {
  const args = { build: null, move: false, moveBack: null, env: null, minVersion: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--move") args.move = true;
    else if (arg === "--move-back") args.moveBack = argv[++i];
    else if (arg === "--env") args.env = argv[++i];
    else if (arg === "--min-version") args.minVersion = argv[++i];
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

/** Retries a power call while the provider answers `409 try_again` (a sleep save in progress). */
async function power(id, action) {
  for (let i = 0; ; i += 1) {
    try { return await api("POST", `/instances/${id}/${action}`, undefined, 180_000); } catch (error) {
      if (error.status !== 409 || i >= 20) throw error;
      await sleep(3_000);
    }
  }
}

async function test(build, minVersion) {
  const timings = {};
  const lap = (name, since) => { timings[name] = Date.now() - since; };
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
  const interrupted = async () => { await cleanup().catch((error) => console.error(error.message)); process.exit(130); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);

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

    await untilBrain(id);
    lap("brain_answers", start);
    if (minVersion) {
      const installed = await exec(id, "tail -n 40 /home/node/.ade/logs/brain-entrypoint.log | grep -E 'installing|starting the brain'; /home/node/.ade/bin/ade --version");
      console.log(`first-start install:\n${installed.stdout.trim()}`);
    }

    const terminal = await exec(id, `sh -c 'cd "$HOME" && echo terminal-$(whoami) && uname -s'`);
    if (terminal.exit_code !== 0 || !terminal.stdout.includes("terminal-")) throw new Error(`terminal command failed: ${terminal.stderr}`);
    console.log(`terminal: ${terminal.stdout.trim().replace(/\n/g, " ")}`);

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
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await cleanup();
  }
}

// `cloud_settings` is the server's one row of settings (apps/account-directory/src/cloud/).
function setVersion(env, build) {
  const database = DATABASES[env];
  if (!database) fail("--env must be production, development or local.");
  const version = `${TEMPLATE}@${build}`;
  const sql = `INSERT INTO cloud_settings (key, value, updated_at) VALUES ('template_version', '${version}', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`;
  const location = env === "local" ? "--local" : "--remote";
  execFileSync("npx", ["--yes", "wrangler", "d1", "execute", database, location, "--command", sql, ...(env === "production" ? ["--env", "production"] : [])], {
    cwd: DIRECTORY_APP,
    stdio: "inherit",
  });
  console.log(`${env}: template_version is now ${version}`);
}

const args = parseArgs(process.argv.slice(2));
if (!key) fail("set AGENT37_API_KEY.");

if (args.moveBack != null) {
  const build = Number(args.moveBack);
  if (!Number.isInteger(build) || build < 1) fail("--move-back needs a build number.");
  if (!args.env) fail("--move-back needs --env.");
  const template = await api("GET", `/templates/${TEMPLATE}`);
  if (!(template.revisions ?? []).some((revision) => revision.revision === build)) fail(`${TEMPLATE}@${build} does not exist.`);
  setVersion(args.env, build);
} else {
  if (args.build == null) fail("give a build number, or --move-back N.");
  if (args.move && !args.env) fail("--move needs --env.");
  try {
    const { timings, version } = await test(args.build, args.minVersion);
    console.log(JSON.stringify({ template: `${TEMPLATE}@${args.build}`, version, passed: true, timings_ms: timings }, null, 2));
  } catch (error) {
    fail(`${TEMPLATE}@${args.build} failed: ${error.message}`);
  }
  if (args.move) setVersion(args.env, args.build);
}
