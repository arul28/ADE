#!/usr/bin/env node
// ADE tool-use eval: does a cheap agent, given ADE's prompt text and skills,
// reach for the right `ade` command?
//
//   node scripts/agent-evals/ade-tool-use/run.mjs
//        [--providers claude,codex,cursor,droid,copilot,opencode,pi,qwen]   (alias --models)
//        [--arms A,B,C,D] [--cases id,id] [--runs 1] [--concurrency 3]
//        [--model claude=claude-haiku-5-5,codex=gpt-6-luna] [--out dir]
//        [--allow-hook-guard droid] [--list]
//   node scripts/agent-evals/ade-tool-use/run.mjs --rescore <dir>   (score saved runs again, no model calls)
//
// Arms (the prompt variant under test; the folder is ./arms):
//   A  today's prompt, rendered from this checkout by render-prompt.ts
//   B  a short stub: arms/B/prompt.md ({{cwd}} and {{skillRoots}} filled in)
//   C  B plus the redirect rules in arms/C/rules.json, enforced by the
//      provider's pre-tool hook (Claude, Codex, OpenCode; others are skipped)
//   D  B plus a one-line topic hint per matching rule in arms/D/hints.json,
//      put in front of the user's message, as ADE would write it into the turn
//   C and D use their own prompt.md when the folder has one.
//
// Safety. Every case runs in a throwaway folder with stand-ins for `ade`,
// `gh`, `screencapture`, `osascript`, `cliclick`, `xcrun`, `xcodebuild` and
// `open` first on PATH, and a bare environment (no ADE_* variables from the
// shell that started the eval). PATH alone does not hold: a login shell runs
// path_helper and puts /usr/sbin first, and an agent can type
// /usr/sbin/screencapture or find ~/.local/bin/ade (both happened while this
// harness was written). So on macOS the whole agent process tree runs inside
// guard.sb (sandbox-exec), which refuses to exec the real screen tools, `gh`
// and every real `ade`, and refuses the live brain's sockets. The harness
// tests the guard before the first case and refuses to run if it does not
// hold. A provider that cannot run inside a seatbelt (Droid) is refused unless
// --allow-hook-guard names it; it then gets a pre-tool hook that rewrites
// screen tools to the stand-ins, which fails open if the hook crashes. Off
// macOS there is no seatbelt and the harness refuses to start.
//
// Forbidden calls are read twice: from the stand-in log (it ran) and from the
// command text in the transcript (it was attempted, maybe past the stand-in).
// The text check (match.mjs) looks at command positions only (after `;`, `&&`,
// `|`, `$(`, `env`, `sudo`, `xargs`, `sh -c '…'`, an alias value, with any path
// prefix) and first blanks quoted text and heredoc bodies that the shell does
// not run, so `grep 'screencapture' log` or a PR body that names `gh` is not a
// call. Text that hides the name (`${s}capture`, base64 into sh) gets past the
// text check; guard.sb still stops it from running.
//
// --rescore <dir> scores saved runs again with the current cases and
// matchers, so a matcher change costs no model calls.
//
// Cost: each provider's cheapest model by default; each case stops after 10
// turns (Claude) or 240 s.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";
import { adeInvocations, executableText, isHelpCall, normalizeAdeCall, transcriptPattern } from "./match.mjs";
import { PROVIDERS } from "./providers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const skillRoot = path.join(repoRoot, "apps/desktop/resources/agent-skills");
const home = os.homedir();
const guardProfile = path.join(here, "guard.sb");

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith("--")) acc.push([arg.slice(2), all[i + 1]?.startsWith("--") ? "true" : all[i + 1] ?? "true"]);
  return acc;
}, []));
const providerIds = (args.providers ?? args.models ?? "claude,codex").split(",");
const arms = (args.arms ?? "A").split(",");
const caseIds = args.cases ? new Set(args.cases.split(",")) : null;
const runs = Number(args.runs ?? 1);
const concurrency = Number(args.concurrency ?? 3);
const allowHookGuard = new Set((args["allow-hook-guard"] ?? "").split(",").filter(Boolean));
const modelOverrides = Object.fromEntries((args.model ?? "").split(",").filter(Boolean).map((pair) => pair.split("=")));
// The ADE dev Macs keep scratch output on the Dev drive; elsewhere, the temp dir.
const scratchRoot = fs.existsSync("/Volumes/Dev/scratch") ? "/Volumes/Dev/scratch" : os.tmpdir();
const outDir = path.resolve(args.out ?? path.join(scratchRoot, "ade-tool-eval", new Date().toISOString().replace(/[:.]/g, "-")));
const TIMEOUT_MS = 240_000;

// Matched against what actually ran (the stand-ins log every call), and as
// transcript patterns against the command text.
const GLOBAL_FORBID_RUN = [/^(screencapture|osascript|cliclick)\b/];
// Matched against the command text the agent wrote.
const GLOBAL_FORBID = [
  /ADE\.app\/Contents/,
  /\.local\/bin\/ade\b/,
  /\bmcp__computer_use\b/,
];
const AUTH_FAILURE = /not logged in|authentication failed|please (log|sign) in|run .*login|unauthorized|invalid api key/i;

const tsx = [path.join(repoRoot, "apps/ade-cli/node_modules/.bin/tsx"), path.join(repoRoot, "apps/desktop/node_modules/.bin/tsx"), path.join(repoRoot, "node_modules/.bin/tsx")]
  .find((candidate) => fs.existsSync(candidate));

// ---------------------------------------------------------------- guard

/**
 * Proves guard.sb holds before any agent runs: each real tool must fail to
 * start inside it, also through a login shell, `env` and an absolute path.
 */
function checkGuard() {
  if (process.platform !== "darwin") {
    return "The guard needs macOS sandbox-exec. Off macOS a login shell or an absolute path reaches the real tools, so the eval does not run.";
  }
  if (!fs.existsSync("/usr/bin/sandbox-exec")) return "/usr/bin/sandbox-exec is missing.";
  const probes = [
    "screencapture -h",
    "env screencapture -h",
    "/usr/sbin/screencapture -h",
    "/usr/bin/osascript -e 1",
    ...["/opt/homebrew/bin/gh", "/usr/local/bin/gh", path.join(home, ".local/bin/ade"), "/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade"]
      .filter((bin) => fs.existsSync(bin)).map((bin) => `${bin} --version`),
  ];
  for (const probe of probes) {
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", guardProfile, "/bin/zsh", "-lc", probe], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    if (!/operation not permitted/i.test(`${result.stderr}${result.stdout}`)) return `guard.sb did not stop \`${probe}\` (exit ${result.status}).`;
  }
  const socket = path.join(home, ".ade/sock/ade.sock");
  if (fs.existsSync(socket)) {
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", guardProfile, process.execPath, "-e",
      `require("net").connect(${JSON.stringify(socket)}).on("connect",()=>{console.log("CONNECTED");process.exit(0)}).on("error",(e)=>{console.log(e.code);process.exit(0)})`], { encoding: "utf8" });
    if (/CONNECTED/.test(result.stdout)) return "guard.sb did not stop a connection to the live brain socket.";
  }
  return null;
}

/** The command line for one agent process, inside guard.sb when the provider allows it. */
function guarded(provider, cmd, argv) {
  return provider.guard === "seatbelt" ? ["/usr/bin/sandbox-exec", ["-f", guardProfile, cmd, ...argv]] : [cmd, argv];
}

// ---------------------------------------------------------------- sandbox

function writeStub(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

function fillTemplate(text, repo) {
  return text.split("{{cwd}}").join(repo).split("{{skillRoots}}").join(skillRoot);
}

/** The arm's prompt file and hint lines, or a reason the arm cannot run here. */
function armPrompt(arm, providerId, repo) {
  if (arm === "A") {
    const template = fs.readFileSync(path.join(outDir, `prompt-${providerId}.md`), "utf8");
    return { text: template.split(path.join(outDir, "repo")).join(repo) };
  }
  const own = path.join(here, "arms", arm, "prompt.md");
  const stub = fs.existsSync(own) ? own : path.join(here, "arms/B/prompt.md");
  return { text: fillTemplate(fs.readFileSync(stub, "utf8"), repo) };
}

function hintsFor(testCase) {
  const file = path.join(here, "arms/D/hints.json");
  const hints = JSON.parse(fs.readFileSync(file, "utf8")).hints ?? [];
  return hints.filter((hint) => new RegExp(hint.match, "i").test(testCase.prompt)).map((hint) => `[ADE hint] ${hint.hint}`);
}

function makeSandbox(caseDir, providerId, arm, testCase) {
  const shims = path.join(caseDir, "shims");
  const repo = path.join(caseDir, "repo");
  fs.mkdirSync(shims, { recursive: true });
  fs.mkdirSync(path.join(caseDir, "zdot"), { recursive: true });
  fs.mkdirSync(path.join(caseDir, "adehome"), { recursive: true });
  fs.cpSync(path.join(here, "fixture"), repo, { recursive: true });
  const git = (...gitArgs) => spawnSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.com", ...gitArgs], { cwd: repo });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  if (testCase.git === "feature") {
    // A pushable origin and a branch with one commit on it, so a PR is a real ask.
    spawnSync("git", ["init", "-q", "--bare", path.join(caseDir, "origin.git")]);
    git("remote", "add", "origin", path.join(caseDir, "origin.git"));
    git("push", "-q", "origin", "main");
    git("checkout", "-q", "-b", "eval/math-helpers");
    fs.appendFileSync(path.join(repo, "src/math.ts"), "\nexport const square = (n: number): number => n * n;\n");
    git("commit", "-qam", "Add square helper");
  }

  const log = path.join(caseDir, "calls.log");
  const promptFile = path.join(caseDir, "prompt.md");
  fs.writeFileSync(promptFile, armPrompt(arm, providerId, repo).text);

  writeStub(path.join(shims, "ade"), [
    `LOG=${quote(log)}`,
    `CASE_DIR=${quote(caseDir)}`,
    `SKILL_ROOT=${quote(skillRoot)}`,
    // Help comes from this checkout's CLI, so help text edits count.
    `TSX=${quote(tsx)}`,
    `CLI_SRC=${quote(path.join(repoRoot, "apps/ade-cli/src/cli.ts"))}`,
    fs.readFileSync(path.join(here, "stub-ade.sh"), "utf8"),
  ].join("\n"));
  for (const name of ["screencapture", "osascript", "cliclick", "xcrun", "xcodebuild", "open"]) {
    writeStub(path.join(shims, name), `printf '%s\\n' "${name} $*" >> ${quote(log)}\necho ok`);
  }
  writeStub(path.join(shims, "gh"), [
    `printf '%s\\n' "gh $*" >> ${quote(log)}`,
    'case " $* " in',
    '  *" pr create "*) echo "https://github.com/eval/fixture/pull/43" ;;',
    '  *" pr edit "*) echo "https://github.com/eval/fixture/pull/42" ;;',
    '  *" pr list "*) printf "42\\tAdd math helpers\\teval/math-helpers\\tOPEN\\n" ;;',
    '  *" auth status "*) echo "github.com: Logged in to github.com account eval" ;;',
    '  *" repo view "*) echo "eval/fixture" ;;',
    "  *) echo ok ;;",
    "esac",
  ].join("\n"));

  const env = {
    HOME: home,
    USER: process.env.USER ?? "",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    ZDOTDIR: path.join(caseDir, "zdot"),
    PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
    ADE_CLI_PATH: path.join(shims, "ade"),
    ADE_CHAT_SESSION_ID: "eval-session",
    ADE_LANE_ID: "eval-lane",
    ADE_AGENT_SKILLS_DIRS: skillRoot,
    // Even the real CLI, if an agent finds it, sees an empty home and a
    // socket with nothing behind it (and guard.sb refuses to run it).
    ADE_HOME: path.join(caseDir, "adehome"),
    ADE_RUNTIME_SOCKET_PATH: path.join(caseDir, "adehome", "none.sock"),
  };

  const sandbox = { repo, env, log, caseDir, shims, promptFile, skillRoot };
  const hook = path.join(here, "hooks/redirect-hook.mjs");
  const hookArgs = [`--state ${quote(path.join(caseDir, "hook-state.json"))}`, `--log ${quote(path.join(caseDir, "hook.log"))}`];
  if (arm === "C") {
    sandbox.rulesFile = path.join(here, "arms/C/rules.json");
    sandbox.hookState = path.join(caseDir, "hook-state.json");
    sandbox.hookLog = path.join(caseDir, "hook.log");
    sandbox.hookCommand = [quote(process.execPath), quote(hook), `--rules ${quote(sandbox.rulesFile)}`, ...hookArgs].join(" ");
  }
  sandbox.guardHookCommand = [quote(process.execPath), quote(hook), `--guard-shims ${quote(shims)}`, ...hookArgs,
    ...(sandbox.rulesFile ? [`--rules ${quote(sandbox.rulesFile)}`] : [])].join(" ");
  return sandbox;
}

/**
 * Codex skips a user-layer hook until its hash is trusted, with no message.
 * Read the hash the way the app does (`hooks/list` on the app server, no
 * model call) and record it in this case's CODEX_HOME.
 */
async function trustCodexHooks(provider, bin, codexHome, sandbox) {
  const [cmd, argv] = guarded(provider, bin, ["app-server"]);
  const child = spawn(cmd, argv, { cwd: sandbox.repo, env: { ...sandbox.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "ignore"] });
  const lines = readline.createInterface({ input: child.stdout });
  const replies = new Map();
  lines.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) replies.get(msg.id)?.(msg);
    } catch { /* not JSON */ }
  });
  const request = (id, method, params) => new Promise((resolve) => {
    replies.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    await request(1, "initialize", { clientInfo: { name: "ade_tool_eval", title: "ADE tool eval", version: "0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const listed = await request(2, "hooks/list", { cwds: [sandbox.repo] });
    const hooks = (listed.result?.data ?? []).flatMap((entry) => entry.hooks ?? []);
    const trust = hooks.filter((hook) => hook.trustStatus !== "trusted" && hook.trustStatus !== "managed")
      .map((hook) => `\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`);
    if (!hooks.length) throw new Error("Codex listed no hooks");
    fs.appendFileSync(path.join(codexHome, "config.toml"), trust.join(""));
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

// ---------------------------------------------------------------- runner

function runProcess(cmd, argv, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------- scoring

function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

function score(testCase, outcome, sandbox) {
  const ran = readLines(sandbox.log);
  const adeRan = ran.filter((line) => line.startsWith("ade ")).map(normalizeAdeCall);
  const adeWritten = outcome.calls.flatMap(adeInvocations);
  const adeCalls = [...new Set([...adeRan, ...adeWritten])];
  // Help calls never satisfy an expectation: `ade prs create --help` is not a PR.
  const adeActions = adeCalls.filter((call) => !isHelpCall(call));
  const ranActions = ran.filter((line) => !isHelpCall(line));
  const failures = [];
  const forbiddenSeen = [];

  for (const pattern of testCase.expect ?? []) {
    if (!adeActions.some((call) => pattern.test(call))) failures.push(`missing ${pattern}`);
  }
  if (testCase.expectAny?.length) {
    const pool = [...adeActions, ...outcome.calls.filter((call) => !isHelpCall(call))];
    if (!testCase.expectAny.some((pattern) => pool.some((call) => pattern.test(call)))) {
      failures.push(`none of ${testCase.expectAny.join(" | ")}`);
    }
  }
  for (const pattern of testCase.expectRun ?? []) {
    if (!ranActions.some((line) => pattern.test(line))) failures.push(`never ran ${pattern}`);
  }
  for (const pattern of [...GLOBAL_FORBID_RUN, ...(testCase.forbidRun ?? [])]) {
    const standin = ran.find((call) => pattern.test(call));
    const text = transcriptPattern(pattern);
    const written = outcome.calls.find((call) => text.test(executableText(call)));
    if (standin) forbiddenSeen.push({ source: "stand-in", pattern: String(pattern), text: standin.slice(0, 160) });
    if (written) forbiddenSeen.push({ source: "transcript", pattern: String(pattern), text: written.slice(0, 160) });
    if (standin || written) failures.push(`${standin ? "ran" : "attempted"} ${pattern}: ${(standin ?? written).slice(0, 120)}`);
  }
  for (const pattern of [...GLOBAL_FORBID, ...(testCase.forbid ?? [])]) {
    const hit = outcome.calls.find((call) => pattern.test(call));
    if (hit) {
      forbiddenSeen.push({ source: "transcript", pattern: String(pattern), text: hit.slice(0, 160) });
      failures.push(`forbidden ${pattern}: ${hit.slice(0, 120)}`);
    }
  }
  for (const pattern of testCase.reply ?? []) {
    if (!pattern.test(outcome.reply)) failures.push(`reply lacks ${pattern}`);
  }
  for (const pattern of testCase.replyNot ?? []) {
    if (pattern.test(outcome.reply)) failures.push(`reply has ${pattern}`);
  }

  // Tool calls up to and including the first one that does what the case wants.
  // Judged per shell segment, so `gh pr create --help | head` is not a PR.
  const correctSegment = (segment) => {
    if (isHelpCall(segment)) return false;
    const ade = adeInvocations(segment);
    return (testCase.expect ?? []).some((p) => ade.some((c) => p.test(c)))
      || (testCase.expectAny ?? []).some((p) => p.test(segment) || ade.some((c) => p.test(c)))
      || (testCase.expectRun ?? []).some((p) => transcriptPattern(p).test(segment));
  };
  const correct = (call) => executableText(call).split(/&&|\|\||[;\n|]/).some(correctSegment);

  const firstCorrect = outcome.calls.findIndex(correct);
  const hookLog = readLines(path.join(sandbox.caseDir, "hook.log")).map((line) => JSON.parse(line));
  // A run that hit the time limit still counts when its checks passed: a
  // ScheduleWakeup in print mode holds the process open.
  return {
    pass: failures.length === 0,
    failures,
    adeCalls,
    adeRanCount: adeRan.length,
    forbiddenSeen,
    callsToFirstCorrect: firstCorrect >= 0 ? firstCorrect + 1 : null,
    hookDenies: hookLog.filter((entry) => entry.decision === "deny").length,
    guardBlocked: /operation not permitted/i.test(`${outcome.raw.stdout}${outcome.raw.stderr}`),
    timedOut: Boolean(outcome.raw.signal),
  };
}

// ---------------------------------------------------------------- main

function pad(value, width) {
  const text = value == null ? "-" : String(value);
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

async function main() {
  if (args.rescore) {
    rescore(path.resolve(args.rescore));
    return;
  }
  if (!tsx) throw new Error("tsx not found; run npm install in apps/ade-cli or apps/desktop");
  const unknownArm = arms.find((arm) => !["A", "B", "C", "D"].includes(arm));
  if (unknownArm) throw new Error(`unknown arm ${unknownArm}; use A, B, C or D`);

  // Which providers can run here, and why not when they cannot.
  const ready = new Map();
  const skipped = [];
  for (const id of providerIds) {
    const provider = PROVIDERS[id];
    if (!provider) throw new Error(`unknown provider ${id}; known: ${Object.keys(PROVIDERS).join(", ")}`);
    const model = modelOverrides[id] ?? provider.defaultModel;
    if (provider.guard === "hook" && !allowHookGuard.has(id)) {
      skipped.push({ provider: id, reason: "cannot run inside guard.sb; only a fail-open hook would guard it (pass --allow-hook-guard to accept that)" });
      continue;
    }
    const bin = provider.bin();
    const detected = provider.detect(bin, model);
    if (!detected.ok) skipped.push({ provider: id, reason: detected.reason });
    else ready.set(id, { provider, bin, model });
  }
  for (const skip of skipped) console.log(`SKIP  ${pad(skip.provider, 9)} ${skip.reason}`);
  if (args.list) {
    for (const [id, { provider, bin, model }] of ready) console.log(`READY ${pad(id, 9)} ${provider.label}  model=${model ?? "(plan default)"}  ${bin}`);
    return;
  }
  if (!ready.size) throw new Error("no provider can run");

  const guardProblem = checkGuard();
  if (guardProblem) {
    console.error(`Refusing to run: ${guardProblem}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const rendered = spawnSync(tsx, [path.join(here, "render-prompt.ts"), outDir, repoRoot], { cwd: path.join(repoRoot, "apps/desktop"), encoding: "utf8" });
  if (rendered.status !== 0) throw new Error(`render-prompt failed: ${rendered.stderr}`);

  // One-time setup a provider needs before its first case, inside the guard.
  for (const [id, entry] of [...ready]) {
    if (!entry.provider.prepare) continue;
    const runGuarded = (cmd, argv, opts) => {
      const [c, a] = guarded(entry.provider, cmd, argv);
      return spawnSync(c, a, { ...opts, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    };
    const problem = entry.provider.prepare({ bin: entry.bin, outDir, runGuarded });
    if (problem) {
      console.log(`SKIP  ${pad(id, 9)} ${problem}`);
      skipped.push({ provider: id, reason: problem });
      ready.delete(id);
    }
  }

  const jobs = [];
  for (const testCase of CASES.filter((c) => !caseIds || caseIds.has(c.id))) {
    for (const [providerId] of ready) {
      for (const arm of arms) {
        for (let n = 1; n <= runs; n++) jobs.push({ testCase, providerId, arm, n });
      }
    }
  }
  const results = [];
  const authFailed = new Set();
  // A provider may cap its own parallel runs (free tiers refuse parallel calls).
  const running = new Map();
  const waiting = new Map();
  const acquire = async (id, limit) => {
    while ((running.get(id) ?? 0) >= limit) await new Promise((resolve) => waiting.set(id, [...(waiting.get(id) ?? []), resolve]));
    running.set(id, (running.get(id) ?? 0) + 1);
  };
  const release = (id) => {
    running.set(id, running.get(id) - 1);
    const queue = waiting.get(id) ?? [];
    waiting.set(id, queue.slice(1));
    queue[0]?.();
  };
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const { testCase, providerId, arm, n } = job;
      const { provider, bin, model } = ready.get(providerId);
      const base = { id: testCase.id, provider: providerId, arm, run: n };
      const report = (result) => {
        results.push({ ...base, ...result });
        const status = result.skipped ? "SKIP" : result.error ? "ERROR" : result.pass ? "PASS" : "FAIL";
        const detail = result.skipped ? `  — ${result.skipped}` : result.error ? `  — provider error: ${result.error}`
          : result.pass ? "" : `  — ${result.failures.join("; ")}`;
        process.stdout.write(`${status}  ${pad(providerId, 8)} ${arm}  ${testCase.id}${runs > 1 ? ` #${n}` : ""}${detail}\n`);
      };
      if (authFailed.has(providerId)) { report({ skipped: "provider not signed in" }); continue; }
      if (arm === "C" && !provider.hooks) { report({ skipped: "arm C: no pre-tool hook wired for this provider" }); continue; }

      const caseDir = path.join(outDir, providerId, arm, testCase.id, `run-${n}`);
      const sandbox = makeSandbox(caseDir, providerId, arm, testCase);
      const hints = arm === "D" ? hintsFor(testCase) : [];
      const userPrompt = hints.length ? `${hints.join("\n")}\n\n${testCase.prompt}` : testCase.prompt;
      const built = provider.build({ bin, job: { ...job, userPrompt }, sandbox, model, here, outDir });
      if (arm === "C" && provider.hooks === "codex-config") {
        try {
          await trustCodexHooks(provider, bin, built.codexHome, sandbox);
        } catch (error) {
          report({ skipped: `arm C: could not trust the Codex hook (${error.message})` });
          continue;
        }
      }
      const [cmd, argv] = guarded(provider, built.cmd, built.argv);
      await acquire(providerId, provider.maxConcurrency ?? Infinity);
      const raw = await runProcess(cmd, argv, { cwd: sandbox.repo, env: { ...sandbox.env, ...(built.env ?? {}) } })
        .finally(() => release(providerId));
      fs.writeFileSync(path.join(caseDir, "stdout.txt"), raw.stdout);
      const outcome = { ...provider.parse(raw.stdout, sandbox), raw };
      if (!outcome.calls.length && AUTH_FAILURE.test(`${raw.stdout}\n${raw.stderr}`.slice(-4000))) {
        authFailed.add(providerId);
        report({ skipped: "provider not signed in (seen in its output)" });
        continue;
      }
      if (!outcome.calls.length && outcome.error) {
        report({ error: outcome.error.slice(0, 200) });
        continue;
      }
      const verdict = score(testCase, outcome, sandbox);
      fs.writeFileSync(path.join(caseDir, "result.json"), JSON.stringify({
        ...base, model, ...verdict, calls: outcome.calls, reply: outcome.reply, usage: outcome.usage,
        stderrTail: raw.stderr.slice(-2000),
      }, null, 2));
      report({ ...verdict, usage: outcome.usage });
    }
  }));

  printSummary(results);
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ skipped, results }, null, 2));
  console.log(`results: ${outDir}`);
}

function printSummary(results) {
  console.log("");
  console.log(`${pad("provider", 9)}${pad("arm", 4)}${pad("case", 24)}${pad("pass", 6)}${pad("forbid s/t", 11)}${pad("1st ok", 7)}${pad("1st in", 8)}${pad("1st cw", 8)}${pad("cost $", 8)}`);
  const groups = new Map();
  for (const r of results) {
    const key = `${r.provider}|${r.arm}|${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const avg = (values) => {
    const nums = values.filter((v) => typeof v === "number");
    return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  };
  for (const [key, rows] of groups) {
    const [provider, arm, id] = key.split("|");
    const scored = rows.filter((r) => !r.skipped && !r.error);
    if (!scored.length) {
      console.log(`${pad(provider, 9)}${pad(arm, 4)}${pad(id, 24)}${rows[0].skipped ? `skipped: ${rows[0].skipped}` : `provider error: ${rows[0].error}`}`);
      continue;
    }
    const standin = scored.reduce((t, r) => t + r.forbiddenSeen.filter((f) => f.source === "stand-in").length, 0);
    const transcript = scored.reduce((t, r) => t + r.forbiddenSeen.filter((f) => f.source === "transcript").length, 0);
    const cost = scored.reduce((t, r) => t + (r.usage?.costUsd ?? 0), 0);
    console.log(`${pad(provider, 9)}${pad(arm, 4)}${pad(id, 24)}${pad(`${scored.filter((r) => r.pass).length}/${scored.length}`, 6)}${pad(`${standin}/${transcript}`, 11)}`
      + `${pad(avg(scored.map((r) => r.callsToFirstCorrect)), 7)}${pad(avg(scored.map((r) => r.usage?.firstInput)), 8)}${pad(avg(scored.map((r) => r.usage?.firstCacheWrite)), 8)}${pad(cost ? cost.toFixed(4) : null, 8)}`);
  }
  console.log("");
  for (const providerId of [...new Set(results.map((r) => r.provider))]) {
    for (const arm of [...new Set(results.map((r) => r.arm))]) {
      const mine = results.filter((r) => r.provider === providerId && r.arm === arm && !r.skipped && !r.error);
      const errors = results.filter((r) => r.provider === providerId && r.arm === arm && r.error).length;
      if (!mine.length) continue;
      const cost = mine.reduce((t, r) => t + (r.usage?.costUsd ?? 0), 0);
      const premium = mine.reduce((t, r) => t + (r.usage?.premiumRequests ?? 0), 0);
      console.log(`${providerId} ${arm}: ${mine.filter((r) => r.pass).length}/${mine.length} follow-rate`
        + `${cost ? `, list-price cost $${cost.toFixed(3)}` : ""}${premium ? `, ${premium} premium requests` : ""}${errors ? `, ${errors} provider errors (not scored)` : ""}`);
    }
  }
}

/**
 * --rescore <dir>: score saved runs again with the current cases and
 * matchers, from each run's stdout.txt and stand-in log. No model calls.
 */
function rescore(dir) {
  const results = [];
  for (const providerId of fs.readdirSync(dir).filter((name) => PROVIDERS[name])) {
    const provider = PROVIDERS[providerId];
    for (const arm of fs.readdirSync(path.join(dir, providerId))) {
      for (const id of fs.readdirSync(path.join(dir, providerId, arm))) {
        const testCase = CASES.find((c) => c.id === id);
        if (!testCase) continue;
        for (const runName of fs.readdirSync(path.join(dir, providerId, arm, id))) {
          const caseDir = path.join(dir, providerId, arm, id, runName);
          const resultFile = path.join(caseDir, "result.json");
          if (!fs.existsSync(path.join(caseDir, "stdout.txt")) || !fs.existsSync(resultFile)) continue;
          const saved = JSON.parse(fs.readFileSync(resultFile, "utf8"));
          const sandbox = { caseDir, log: path.join(caseDir, "calls.log") };
          const stdout = fs.readFileSync(path.join(caseDir, "stdout.txt"), "utf8");
          const outcome = { ...provider.parse(stdout, sandbox), raw: { stdout, stderr: saved.stderrTail ?? "", signal: saved.timedOut ? "SIGKILL" : null } };
          const verdict = score(testCase, outcome, sandbox);
          const base = { id, provider: providerId, arm, run: saved.run };
          fs.writeFileSync(resultFile, JSON.stringify({ ...saved, ...verdict, calls: outcome.calls, reply: outcome.reply, usage: outcome.usage }, null, 2));
          results.push({ ...base, ...verdict, usage: outcome.usage });
          const changed = saved.pass !== verdict.pass ? `  (was ${saved.pass ? "PASS" : "FAIL"})` : "";
          console.log(`${verdict.pass ? "PASS" : "FAIL"}  ${pad(providerId, 8)} ${arm}  ${id} ${runName}${changed}${verdict.pass ? "" : `  — ${verdict.failures.join("; ")}`}`);
        }
      }
    }
  }
  printSummary(results);
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ skipped: [], results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
