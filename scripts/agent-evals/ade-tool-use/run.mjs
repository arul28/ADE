#!/usr/bin/env node
// ADE tool-use eval: does a cheap agent, given ADE's real prompt text and
// skills, reach for the right `ade` command?
//
// Every case runs in a throwaway folder with stand-in `ade`, `screencapture`,
// `osascript`, `cliclick`, `xcrun`, `xcodebuild` and `open` that only log
// their arguments, so nothing reaches the user's brain or screen. `ade help`
// and `ade skill …` pass through to the real CLI with an empty ADE home.
//
//   node scripts/agent-evals/ade-tool-use/run.mjs [--models claude,codex]
//        [--cases id,id] [--concurrency 3] [--out dir]
//
// Cost: Haiku 5.5 low and GPT-6 Luna low only; each case stops after 10 turns
// (Claude) or 240 s.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const skillRoot = path.join(repoRoot, "apps/desktop/resources/agent-skills");
const home = os.homedir();

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith("--")) acc.push([arg.slice(2), all[i + 1]]);
  return acc;
}, []));
const models = (args.models ?? "claude,codex").split(",");
const caseIds = args.cases ? new Set(args.cases.split(",")) : null;
const concurrency = Number(args.concurrency ?? 3);
const outDir = path.resolve(args.out ?? path.join(os.tmpdir(), "ade-tool-eval", new Date().toISOString().replace(/[:.]/g, "-")));
const TIMEOUT_MS = 240_000;

// Matched against what actually ran (the stand-ins log every call).
const GLOBAL_FORBID_RUN = [/^(screencapture|osascript|cliclick)\b/];
// Matched against the command text the agent wrote.
const GLOBAL_FORBID = [
  /ADE\.app\/Contents/,
  /\.local\/bin\/ade\b/,
  /\bmcp__computer_use\b/,
];

function newest(dir, leaf) {
  if (!fs.existsSync(dir)) return null;
  const versions = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const version of versions.reverse()) {
    const candidate = path.join(dir, version, leaf);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
const claudeBin = process.env.ADE_EVAL_CLAUDE_BIN
  ?? newest(path.join(home, ".ade/tools/@anthropic-ai/claude-agent-sdk-darwin-arm64"), "claude");
const codexBin = process.env.ADE_EVAL_CODEX_BIN
  ?? (() => {
    const dir = path.join(home, ".ade/tools/@openai/codex-darwin-arm64");
    const version = fs.existsSync(dir) && fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
    return version ? path.join(dir, version, "vendor/aarch64-apple-darwin/bin/codex") : null;
  })();
const tsx = [path.join(repoRoot, "apps/ade-cli/node_modules/.bin/tsx"), path.join(repoRoot, "apps/desktop/node_modules/.bin/tsx"), path.join(repoRoot, "node_modules/.bin/tsx")]
  .find((candidate) => fs.existsSync(candidate));

// ---------------------------------------------------------------- sandbox


function writeStub(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function makeSandbox(caseDir, provider) {
  const shims = path.join(caseDir, "shims");
  const repo = path.join(caseDir, "repo");
  fs.mkdirSync(shims, { recursive: true });
  fs.mkdirSync(path.join(caseDir, "zdot"), { recursive: true });
  fs.mkdirSync(path.join(caseDir, "adehome"), { recursive: true });
  fs.cpSync(path.join(here, "fixture"), repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "-qm", "fixture"], { cwd: repo });

  const log = path.join(caseDir, "calls.log");
  // The prompt names the worktree the agent is bound to; give each case its own.
  const renderedRepo = path.join(outDir, "repo");
  for (const name of ["claude", "codex"]) {
    const template = fs.readFileSync(path.join(outDir, `prompt-${name}.md`), "utf8");
    fs.writeFileSync(path.join(caseDir, `prompt-${name}.md`), template.split(renderedRepo).join(repo));
  }
  const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
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
    writeStub(path.join(shims, name), `printf '%s\\n' "${name} $*" >> "${log}"\necho ok`);
  }

  const env = {
    HOME: home,
    USER: process.env.USER ?? "",
    TERM: "dumb",
    ZDOTDIR: path.join(caseDir, "zdot"),
    PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
    ADE_CLI_PATH: path.join(shims, "ade"),
    ADE_CHAT_SESSION_ID: "eval-session",
    ADE_LANE_ID: "eval-lane",
    ADE_AGENT_SKILLS_DIRS: skillRoot,
    // Even the real CLI, if an agent finds it, sees an empty home and a
    // socket with nothing behind it, never the user's brain.
    ADE_HOME: path.join(caseDir, "adehome"),
    ADE_RUNTIME_SOCKET_PATH: path.join(caseDir, "adehome", "none.sock"),
  };
  if (provider === "codex") {
    const codexHome = path.join(caseDir, "codexhome");
    fs.mkdirSync(path.join(codexHome, "skills"), { recursive: true });
    // A link, not a copy: the sign-in stays in one place.
    fs.symlinkSync(path.join(home, ".codex/auth.json"), path.join(codexHome, "auth.json"));
    for (const skill of fs.readdirSync(skillRoot)) {
      if (fs.existsSync(path.join(skillRoot, skill, "SKILL.md"))) {
        fs.symlinkSync(path.join(skillRoot, skill), path.join(codexHome, "skills", skill));
      }
    }
    const instructions = fs.readFileSync(path.join(caseDir, "prompt-codex.md"), "utf8");
    fs.writeFileSync(path.join(codexHome, "config.toml"), `developer_instructions = ${JSON.stringify(instructions)}\n`);
    env.CODEX_HOME = codexHome;
  }
  return { repo, env, log, caseDir };
}

// ---------------------------------------------------------------- runners

function run(cmd, argv, opts) {
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

async function runClaude(testCase, sandbox) {
  const result = await run(claudeBin, [
    "-p", testCase.prompt,
    "--model", "claude-haiku-5-5", "--effort", "low",
    "--output-format", "stream-json", "--verbose",
    "--setting-sources", "", "--strict-mcp-config",
    "--permission-mode", "bypassPermissions", "--max-turns", "10",
    "--append-system-prompt-file", path.join(sandbox.caseDir, "prompt-claude.md"),
    "--plugin-dir", skillRoot,
  ], { cwd: sandbox.repo, env: sandbox.env });
  const calls = [];
  let reply = "";
  let usage = null;
  for (const line of result.stdout.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type !== "tool_use") continue;
        calls.push(block.name === "Bash" ? String(block.input?.command ?? "") : `tool:${block.name} ${JSON.stringify(block.input)}`);
      }
    }
    if (event.type === "result") {
      reply = String(event.result ?? "");
      usage = { turns: event.num_turns, costUsd: event.total_cost_usd };
    }
  }
  return { calls, reply, usage, raw: result };
}

async function runCodex(testCase, sandbox) {
  const result = await run(codexBin, [
    "exec", "--json", "--skip-git-repo-check",
    "-m", "gpt-6-luna", "-c", "model_reasoning_effort=low", "-c", "allow_login_shell=false",
    "--dangerously-bypass-approvals-and-sandbox",
    testCase.prompt,
  ], { cwd: sandbox.repo, env: sandbox.env });
  const calls = [];
  let reply = "";
  let usage = null;
  for (const line of result.stdout.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event.item ?? {};
    if (event.type === "item.completed" && item.type === "command_execution") calls.push(String(item.command ?? ""));
    if (event.type === "item.completed" && item.type === "agent_message") reply = String(item.text ?? "");
    if (event.type === "item.completed" && item.type === "mcp_tool_call") calls.push(`tool:${item.server}.${item.tool}`);
    if (event.type === "turn.completed") usage = event.usage;
  }
  return { calls, reply, usage, raw: result };
}

// ---------------------------------------------------------------- scoring

/** `ade --socket /x browser open …` → `ade browser open …`, as the CLI reads it. */
function normalizeAdeCall(line) {
  const words = line.split(/\s+/).slice(1);
  while (words.length) {
    if (words[0] === "--socket") {
      words.shift();
      if (words[0]?.startsWith("/")) words.shift();
    } else if (["--text", "--json", "--quiet"].includes(words[0])) {
      words.shift();
    } else {
      break;
    }
  }
  return `ade ${words.join(" ")}`;
}

function score(testCase, outcome, log) {
  const ran = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  const adeCalls = ran.filter((line) => line.startsWith("ade ")).map(normalizeAdeCall);
  const failures = [];
  for (const pattern of testCase.expect ?? []) {
    if (!adeCalls.some((call) => pattern.test(call))) failures.push(`missing ${pattern}`);
  }
  if (testCase.expectAny?.length) {
    const pool = [...adeCalls, ...outcome.calls];
    if (!testCase.expectAny.some((pattern) => pool.some((call) => pattern.test(call)))) {
      failures.push(`none of ${testCase.expectAny.join(" | ")}`);
    }
  }
  for (const pattern of [...GLOBAL_FORBID_RUN, ...(testCase.forbidRun ?? [])]) {
    const hit = ran.find((call) => pattern.test(call));
    if (hit) failures.push(`ran ${pattern}: ${hit.slice(0, 120)}`);
  }
  for (const pattern of [...GLOBAL_FORBID, ...(testCase.forbid ?? [])]) {
    const hit = outcome.calls.find((call) => pattern.test(call));
    if (hit) failures.push(`forbidden ${pattern}: ${hit.slice(0, 120)}`);
  }
  for (const pattern of testCase.reply ?? []) {
    if (!pattern.test(outcome.reply)) failures.push(`reply lacks ${pattern}`);
  }
  for (const pattern of testCase.replyNot ?? []) {
    if (pattern.test(outcome.reply)) failures.push(`reply has ${pattern}`);
  }
  // A run that hit the time limit still counts when its checks passed: a
  // ScheduleWakeup in print mode holds the process open.
  return { pass: failures.length === 0, failures, adeCalls, timedOut: Boolean(outcome.raw.signal) };
}

// ---------------------------------------------------------------- main

async function main() {
  if (!tsx) throw new Error("tsx not found; run npm install in apps/desktop");
  if (models.includes("claude") && !claudeBin) throw new Error("Claude SDK binary not found under ~/.ade/tools");
  if (models.includes("codex") && !codexBin) throw new Error("Codex binary not found under ~/.ade/tools");
  fs.mkdirSync(outDir, { recursive: true });
  const rendered = spawnSync(tsx, [path.join(here, "render-prompt.ts"), outDir, repoRoot], { cwd: path.join(repoRoot, "apps/desktop"), encoding: "utf8" });
  if (rendered.status !== 0) throw new Error(`render-prompt failed: ${rendered.stderr}`);

  const jobs = [];
  for (const testCase of CASES.filter((c) => !caseIds || caseIds.has(c.id))) {
    for (const provider of models) jobs.push({ testCase, provider });
  }
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const { testCase, provider } = jobs[next++];
      const caseDir = path.join(outDir, provider, testCase.id);
      const sandbox = makeSandbox(caseDir, provider);
      const outcome = provider === "claude" ? await runClaude(testCase, sandbox) : await runCodex(testCase, sandbox);
      const verdict = score(testCase, outcome, sandbox.log);
      fs.writeFileSync(path.join(caseDir, "result.json"), JSON.stringify({
        id: testCase.id, provider, ...verdict, calls: outcome.calls, reply: outcome.reply, usage: outcome.usage,
        stderrTail: outcome.raw.stderr.slice(-2000),
      }, null, 2));
      results.push({ id: testCase.id, provider, ...verdict, usage: outcome.usage });
      process.stdout.write(`${verdict.pass ? "PASS" : "FAIL"}  ${provider.padEnd(6)} ${testCase.id}${verdict.pass ? "" : `  — ${verdict.failures.join("; ")}`}\n`);
    }
  }));

  console.log("");
  for (const provider of models) {
    const mine = results.filter((r) => r.provider === provider);
    console.log(`${provider}: ${mine.filter((r) => r.pass).length}/${mine.length}`);
  }
  const claudeCost = results.reduce((total, r) => total + (r.provider === "claude" ? r.usage?.costUsd ?? 0 : 0), 0);
  if (claudeCost) console.log(`claude list-price cost: $${claudeCost.toFixed(3)}`);
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(results, null, 2));
  console.log(`results: ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
