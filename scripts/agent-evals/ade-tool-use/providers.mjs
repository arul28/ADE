// Provider adapters for the ADE tool-use eval. Each one knows how to find its
// CLI, tell whether it can run here, build one non-interactive run, and read
// the run's output back into { calls, reply, usage }.
//
//   error  set when the provider itself failed (no route, rate limit, API
//          error); a run with an error and no calls is not scored
//   calls  every shell command (or `tool:<name> …`) the agent issued, in order
//   usage  { firstInput, firstCacheWrite, totalInput, costUsd, note }, with
//          null where the CLI does not report a number
//
// guard: "seatbelt" means the whole process tree runs inside guard.sb. "hook"
// means the CLI cannot run inside a seatbelt (Droid sandboxes its own commands
// and macOS forbids a nested sandbox), so the only guard is a pre-tool hook
// that points screen tools at the stand-ins. Hooks fail open, so run.mjs
// refuses those providers unless --allow-hook-guard names them.
//
// armC: true when arm C can install the redirect rules (a pre-tool hook or
// a plugin); run.mjs skips arm C for the others.
//
// runtimeKind: the ADE runtime whose prompt arm A renders for this provider
// (render-prompt.ts), or null for the generic text.
//
// prepare({ bin, outDir, runGuarded }): optional one-time setup before the
// first case; returns a skip reason or null.
// beforeRun({ arm, bin, built, sandbox, guarded }): optional per-case setup
// after build(); returns a skip reason for this case or null.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const home = os.homedir();
const toolsDir = path.join(home, ".ade/tools");

function versions(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
}
/** Newest `<dir>/<version>/<leaf>` that exists. */
function newest(dir, leaf) {
  for (const version of versions(dir)) {
    const candidate = path.join(dir, version, leaf);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
function onPath(name) {
  const found = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
}
function jsonLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try { out.push(JSON.parse(line)); } catch { /* not JSON */ }
  }
  return out;
}
function link(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (!fs.existsSync(linkPath)) fs.symlinkSync(target, linkPath);
}
function linkSkills(skillRoot, intoDir) {
  for (const skill of fs.readdirSync(skillRoot)) {
    if (fs.existsSync(path.join(skillRoot, skill, "SKILL.md"))) link(path.join(skillRoot, skill), path.join(intoDir, skill));
  }
}
// Probes run outside the eval sandbox, so they get a bare environment: an
// agent shell's ADE_* variables would point a CLI at the live brain.
const probeEnv = () => ({ HOME: home, USER: process.env.USER ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" });
/** An empty folder for a probe run, so the probe sees no project files. */
const probeDir = () => fs.mkdtempSync(path.join(fs.existsSync("/Volumes/Dev/scratch") ? "/Volumes/Dev/scratch" : os.tmpdir(), "ade-eval-probe-"));
const emptyUsage = (note) => ({ firstInput: null, firstCacheWrite: null, totalInput: null, costUsd: null, note });
/** One tool call as a `calls` entry: the shell tool's command, or `tool:<name> <input JSON>`. */
const callText = (name, shellName, input) => (name === shellName ? String(input?.command ?? "") : `tool:${name} ${JSON.stringify(input)}`);

// ------------------------------------------------------------------ Claude

const claude = {
  label: "Claude (Agent SDK CLI)",
  defaultModel: "claude-haiku-5-5",
  guard: "seatbelt",
  armC: true,
  runtimeKind: "claude-agent-sdk-query",
  bin: () => process.env.ADE_EVAL_CLAUDE_BIN ?? newest(path.join(toolsDir, "@anthropic-ai/claude-agent-sdk-darwin-arm64"), "claude"),
  detect(bin) {
    return bin ? { ok: true } : { ok: false, reason: "Claude SDK binary not found under ~/.ade/tools (set ADE_EVAL_CLAUDE_BIN)" };
  },
  build({ bin, job, sandbox, model }) {
    const argv = [
      "-p", job.userPrompt,
      "--model", model, "--effort", "low",
      "--output-format", "stream-json", "--verbose",
      "--setting-sources", "", "--strict-mcp-config",
      "--permission-mode", "bypassPermissions", "--max-turns", "10",
      "--append-system-prompt-file", sandbox.promptFile,
      "--plugin-dir", sandbox.skillRoot,
    ];
    if (sandbox.hookCommand) {
      const settings = path.join(sandbox.caseDir, "claude-settings.json");
      fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: sandbox.hookCommand, timeout: 10 }] }] } }));
      argv.push("--settings", settings);
    }
    return { cmd: bin, argv };
  },
  parse(stdout) {
    const calls = [];
    let reply = "";
    let error = null;
    const usage = emptyUsage(null);
    for (const event of jsonLines(stdout)) {
      if (event.type === "assistant") {
        const u = event.message?.usage;
        if (u && usage.firstInput == null) {
          usage.firstInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          usage.firstCacheWrite = u.cache_creation_input_tokens ?? 0;
        }
        for (const block of event.message?.content ?? []) {
          if (block.type !== "tool_use") continue;
          calls.push(callText(block.name, "Bash", block.input));
        }
      }
      if (event.type === "result") {
        reply = String(event.result ?? "");
        if (event.is_error) error = reply || String(event.subtype ?? "error");
        const u = event.usage ?? {};
        usage.totalInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        usage.costUsd = event.total_cost_usd ?? null;
        usage.turns = event.num_turns;
      }
    }
    return { calls, reply, usage, error };
  },
};

// ------------------------------------------------------------------ Codex

/**
 * Codex skips a user-layer hook until its hash is trusted, with no message.
 * Read the hash the way the app does (`hooks/list` on the app server, no
 * model call) and record it in this case's CODEX_HOME. `guarded(cmd, argv)`
 * wraps the command in guard.sb, as run.mjs does for the case itself.
 */
async function trustCodexHooks(guarded, bin, codexHome, sandbox) {
  const [cmd, argv] = guarded(bin, ["app-server"]);
  const child = spawn(cmd, argv, { cwd: sandbox.repo, env: { ...sandbox.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "ignore"] });
  const lines = readline.createInterface({ input: child.stdout });
  const replies = new Map();
  lines.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) replies.get(msg.id)?.(msg);
    } catch { /* not JSON */ }
  });
  // A reply, or a rejection once the server exits, fails to start, or times out.
  let ended = null;
  const failAll = (reason) => {
    ended ??= reason;
    for (const settle of replies.values()) settle(null);
    replies.clear();
  };
  child.on("error", (error) => failAll(`codex app-server did not start: ${error.message}`));
  child.on("close", (code, signal) => failAll(`codex app-server exited (${signal ?? code}) before it replied`));
  const request = (id, method, params) => new Promise((resolve, reject) => {
    if (ended) { reject(new Error(ended)); return; }
    replies.set(id, (msg) => (msg ? resolve(msg) : reject(new Error(ended ?? "codex app-server stopped"))));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const timer = setTimeout(() => { failAll("codex app-server timed out after 30 s"); child.kill("SIGKILL"); }, 30_000);
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

const codex = {
  label: "Codex (exec)",
  defaultModel: "gpt-6-luna",
  guard: "seatbelt",
  armC: true,
  runtimeKind: "codex-app-server",
  bin: () => process.env.ADE_EVAL_CODEX_BIN
    ?? newest(path.join(toolsDir, "@openai/codex-darwin-arm64"), "vendor/aarch64-apple-darwin/bin/codex"),
  detect(bin) {
    if (!bin) return { ok: false, reason: "Codex binary not found under ~/.ade/tools (set ADE_EVAL_CODEX_BIN)" };
    if (!fs.existsSync(path.join(home, ".codex/auth.json"))) return { ok: false, reason: "not signed in (~/.codex/auth.json missing)" };
    return { ok: true };
  },
  build({ bin, job, sandbox, model }) {
    const codexHome = path.join(sandbox.caseDir, "codexhome");
    // A link, not a copy: the sign-in stays in one place.
    link(path.join(home, ".codex/auth.json"), path.join(codexHome, "auth.json"));
    linkSkills(sandbox.skillRoot, path.join(codexHome, "skills"));
    const lines = [`developer_instructions = ${JSON.stringify(fs.readFileSync(sandbox.promptFile, "utf8"))}`];
    if (sandbox.hookCommand) {
      // A user-layer hook is "untrusted" and Codex skips it without a word;
      // beforeRun records its trusted_hash after a `hooks/list` (see trustCodexHooks).
      lines.push("", "[[hooks.PreToolUse]]", 'matcher = "Bash"', "[[hooks.PreToolUse.hooks]]", 'type = "command"',
        `command = ${JSON.stringify(sandbox.hookCommand)}`, "timeout = 10");
    }
    fs.writeFileSync(path.join(codexHome, "config.toml"), `${lines.join("\n")}\n`);
    return {
      cmd: bin,
      argv: [
        "exec", "--json", "--skip-git-repo-check",
        "-m", model, "-c", "model_reasoning_effort=low", "-c", "allow_login_shell=false",
        "--dangerously-bypass-approvals-and-sandbox",
        job.userPrompt,
      ],
      env: { CODEX_HOME: codexHome },
      codexHome,
    };
  },
  async beforeRun({ arm, bin, built, sandbox, guarded }) {
    if (arm !== "C") return null;
    try {
      await trustCodexHooks(guarded, bin, built.codexHome, sandbox);
      return null;
    } catch (error) {
      return `arm C: could not trust the Codex hook (${error.message})`;
    }
  },
  parse(stdout, sandbox) {
    const calls = [];
    let reply = "";
    let error = null;
    const usage = emptyUsage(null);
    for (const event of jsonLines(stdout)) {
      const item = event.item ?? {};
      if (event.type === "item.completed" && item.type === "command_execution") calls.push(String(item.command ?? ""));
      if (event.type === "item.completed" && item.type === "agent_message") reply = String(item.text ?? "");
      if (event.type === "item.completed" && item.type === "mcp_tool_call") calls.push(`tool:${item.server}.${item.tool}`);
      if (event.type === "error" || event.type === "turn.failed") error = String(event.message ?? event.error?.message ?? "error");
      if (event.type === "turn.completed") {
        usage.totalInput = event.usage?.input_tokens ?? null;
        usage.cachedInput = event.usage?.cached_input_tokens ?? null;
      }
    }
    // `exec --json` only totals the turn; the rollout has each request.
    const rollouts = path.join(sandbox.caseDir, "codexhome", "sessions");
    const files = fs.existsSync(rollouts) ? fs.readdirSync(rollouts, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")) : [];
    for (const file of files) {
      for (const event of jsonLines(fs.readFileSync(path.join(rollouts, String(file)), "utf8"))) {
        const last = event.payload?.type === "token_count" ? event.payload.info?.last_token_usage : null;
        if (last) {
          usage.firstInput = last.input_tokens ?? null;
          usage.firstCacheWrite = last.cache_write_input_tokens ?? null;
          break;
        }
      }
    }
    usage.note = "ChatGPT plan: no $ reported";
    return { calls, reply, usage, error };
  },
};

// ------------------------------------------------------------------ Cursor

const cursor = {
  label: "Cursor (cursor-agent -p)",
  defaultModel: "auto",
  guard: "seatbelt",
  armC: false,
  runtimeKind: "cursor-sdk",
  bin: () => process.env.ADE_EVAL_CURSOR_BIN ?? newest(path.join(toolsDir, "cursor-agent-darwin-arm64"), "cursor-agent") ?? onPath("cursor-agent"),
  detect(bin) {
    if (!bin) return { ok: false, reason: "cursor-agent not found" };
    const status = spawnSync(bin, ["status"], { encoding: "utf8", timeout: 30_000, env: probeEnv() });
    if (/not logged in/i.test(`${status.stdout}${status.stderr}`)) return { ok: false, reason: "not signed in (cursor-agent status: Not logged in)" };
    return { ok: true };
  },
  build({ bin, job, sandbox, model }) {
    // Cursor takes ADE's text in the user turn (no system prompt without
    // account access), as ADE's Cursor SDK path does.
    const text = `${fs.readFileSync(sandbox.promptFile, "utf8")}\n\n---\n\n${job.userPrompt}`;
    return {
      cmd: bin,
      argv: ["-p", "--output-format", "stream-json", "--model", model, "--force", "--trust", "--sandbox", "disabled", "--workspace", sandbox.repo, text],
    };
  },
  parse(stdout) {
    const calls = [];
    let reply = "";
    for (const event of jsonLines(stdout)) {
      if (event.type === "tool_call" && event.subtype === "started") {
        const shell = event.tool_call?.shellToolCall?.args?.command;
        calls.push(shell != null ? String(shell) : `tool:${Object.keys(event.tool_call ?? {})[0] ?? "?"}`);
      }
      if (event.type === "result") reply = String(event.result ?? "");
    }
    return { calls, reply, usage: emptyUsage("parser unverified: Cursor was not signed in when this was written") };
  },
};

// ------------------------------------------------------------------ Droid

const droid = {
  label: "Droid (droid exec)",
  defaultModel: "gpt-6-luna",
  guard: "hook",
  armC: true,
  runtimeKind: "droid-sdk",
  bin: () => process.env.ADE_EVAL_DROID_BIN ?? newest(path.join(toolsDir, "@factory/cli-darwin-arm64"), "bin/droid") ?? onPath("droid"),
  detect(bin, model) {
    if (!bin) return { ok: false, reason: "droid not found" };
    // Read-only autonomy and no tools needed; an unsigned CLI fails at once.
    const dir = probeDir();
    const probe = spawnSync(bin, ["exec", "-m", model, "Reply with the word OK."], { encoding: "utf8", timeout: 60_000, cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: probeEnv() });
    fs.rmSync(dir, { recursive: true, force: true });
    if (/authentication failed|log in|FACTORY_API_KEY/i.test(`${probe.stdout}${probe.stderr}`)) return { ok: false, reason: "not signed in (droid: Authentication failed)" };
    return { ok: true };
  },
  build({ bin, job, sandbox, model }) {
    const settings = path.join(sandbox.caseDir, "droid-settings.json");
    // The guard hook always runs; the arm C rules only in arm C.
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Execute", hooks: [{ type: "command", command: sandbox.guardHookCommand, timeout: 10 }] }] } }));
    return {
      cmd: bin,
      argv: ["exec", "-o", "stream-json", "--auto", "high", "-m", model, "--settings", settings, "--append-system-prompt-file", sandbox.promptFile, "--cwd", sandbox.repo, job.userPrompt],
    };
  },
  parse(stdout) {
    const calls = [];
    let reply = "";
    const usage = emptyUsage(null);
    for (const event of jsonLines(stdout)) {
      if (event.type === "tool_call") calls.push(callText(event.toolName, "Execute", event.parameters));
      if (event.type === "completion") {
        reply = String(event.finalText ?? "");
        usage.totalInput = event.usage?.input_tokens ?? null;
      }
    }
    return { calls, reply, usage };
  },
};

// ------------------------------------------------------------------ Copilot

const copilot = {
  label: "Copilot (copilot -p)",
  // Only the plan's Auto model is allowed on the account this was written on.
  defaultModel: null,
  guard: "seatbelt",
  armC: false,
  runtimeKind: "copilot-sdk",
  bin: () => process.env.ADE_EVAL_COPILOT_BIN ?? newest(path.join(toolsDir, "@github/copilot-darwin-arm64"), "copilot") ?? onPath("copilot"),
  detect(bin) {
    if (!bin) return { ok: false, reason: "copilot not found" };
    // Copilot signs in through `gh`, and guard.sb blocks `gh`. A broad gh
    // token in the agent's environment could reach real repositories with
    // curl, so the eval takes only a token the user made for Copilot alone.
    if (!process.env.ADE_EVAL_COPILOT_GITHUB_TOKEN) {
      return { ok: false, reason: "needs ADE_EVAL_COPILOT_GITHUB_TOKEN: a fine-grained token with only the Copilot Requests permission (Copilot signs in through gh, which guard.sb blocks)" };
    }
    return { ok: true };
  },
  build({ bin, job, sandbox, model }) {
    const copilotHome = path.join(sandbox.caseDir, "copilothome");
    linkSkills(sandbox.skillRoot, path.join(copilotHome, "skills"));
    const instructions = path.join(sandbox.caseDir, "copilot-instructions");
    fs.mkdirSync(instructions, { recursive: true });
    fs.copyFileSync(sandbox.promptFile, path.join(instructions, "AGENTS.md"));
    const argv = ["-p", job.userPrompt, "--output-format", "json", "--allow-all-tools", "--disable-builtin-mcps", "--no-color", "--no-auto-update"];
    if (model) argv.push("--model", model);
    return {
      cmd: bin,
      argv,
      // The built-in GitHub MCP server can write to real repositories: off.
      env: {
        COPILOT_HOME: copilotHome,
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: instructions,
        COPILOT_AUTO_UPDATE: "false",
        COPILOT_GITHUB_TOKEN: process.env.ADE_EVAL_COPILOT_GITHUB_TOKEN,
      },
    };
  },
  parse(stdout) {
    const calls = [];
    let reply = "";
    const usage = emptyUsage(null);
    for (const event of jsonLines(stdout)) {
      const data = event.data ?? {};
      if (event.type === "tool.execution_start") calls.push(callText(data.toolName, "bash", data.arguments));
      if (event.type === "assistant.message" && data.content) reply = String(data.content);
      if (event.type === "session.usage_checkpoint") usage.premiumRequests = data.totalPremiumRequests ?? null;
      if (event.type === "result") usage.premiumRequests = event.usage?.premiumRequests ?? usage.premiumRequests;
    }
    usage.note = "premium requests, no token counts in -p json";
    return { calls, reply, usage };
  },
};

// ------------------------------------------------------------------ OpenCode

const opencode = {
  label: "OpenCode 2.0 (opencode run)",
  defaultModel: "opencode/deepseek-v4.1-flash-free",
  // The free models answer "Model unavailable" to parallel requests.
  maxConcurrency: 1,
  guard: "seatbelt",
  armC: true,
  runtimeKind: "opencode",
  bin: () => process.env.ADE_EVAL_OPENCODE_BIN ?? newest(path.join(toolsDir, "@opencode/cli-darwin-arm64"), "bin/opencode") ?? onPath("opencode"),
  detect(bin) {
    return bin ? { ok: true } : { ok: false, reason: "opencode not found" };
  },
  // A fresh data folder has no model catalog, and every model then fails at
  // once with "Model unavailable". `opencode models` writes the catalog into
  // the data database, so fill one template here and copy it into each case.
  prepare({ bin, outDir, runGuarded }) {
    const scratch = fs.mkdtempSync(path.join(outDir, "opencode-prepare-"));
    const result = runGuarded(bin, ["models", "--standalone"], {
      cwd: scratch,
      env: {
        HOME: home, PATH: "/usr/bin:/bin",
        XDG_DATA_HOME: path.join(outDir, "opencode-data"), XDG_CACHE_HOME: path.join(outDir, "opencode-cache"),
        XDG_STATE_HOME: path.join(scratch, "state"), XDG_CONFIG_HOME: path.join(scratch, "config"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    });
    fs.rmSync(scratch, { recursive: true, force: true });
    if (result.status !== 0) return `opencode models failed: ${String(result.stderr).trim().split("\n").pop()}`;
    return null;
  },
  build({ bin, job, sandbox, model, here, outDir }) {
    const xdg = path.join(sandbox.caseDir, "opencode");
    for (const dir of ["state", "config"]) fs.mkdirSync(path.join(xdg, dir), { recursive: true });
    fs.cpSync(path.join(outDir, "opencode-data"), path.join(xdg, "data"), { recursive: true });
    const config = { instructions: [sandbox.promptFile], skills: [sandbox.skillRoot] };
    const env = {
      XDG_DATA_HOME: path.join(xdg, "data"),
      XDG_STATE_HOME: path.join(xdg, "state"),
      XDG_CACHE_HOME: path.join(outDir, "opencode-cache"),
      XDG_CONFIG_HOME: path.join(xdg, "config"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    };
    if (sandbox.rulesFile) {
      config.plugins = [path.join(here, "hooks/opencode-redirect")];
      Object.assign(env, { ADE_EVAL_RULES: sandbox.rulesFile, ADE_EVAL_HOOK_STATE: sandbox.hookState, ADE_EVAL_HOOK_LOG: sandbox.hookLog });
    }
    const configFile = path.join(sandbox.caseDir, "opencode.json");
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    env.OPENCODE_CONFIG = configFile;
    // --standalone: a private server, never the user's background service.
    return { cmd: bin, argv: ["run", "--standalone", "--auto", "--format", "json", "-m", model, job.userPrompt], env };
  },
  parse(stdout) {
    const calls = [];
    let reply = "";
    const usage = emptyUsage(null);
    let cost = 0;
    let total = 0;
    let error = null;
    for (const event of jsonLines(stdout)) {
      const part = event.part ?? {};
      if (event.type === "tool_use") calls.push(callText(part.tool, "shell", part.state?.input ?? {}));
      if (event.type === "text" && part.text) reply = String(part.text);
      if (event.type === "error") error = String(event.error?.message ?? event.error?.type ?? "error");
      if (event.type === "step_finish") {
        const t = part.tokens ?? {};
        const input = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
        if (usage.firstInput == null) {
          usage.firstInput = input;
          usage.firstCacheWrite = t.cache?.write ?? 0;
        }
        total += input;
        cost += part.cost ?? 0;
      }
    }
    usage.totalInput = total || null;
    usage.costUsd = cost;
    return { calls, reply, usage, error };
  },
};

// ------------------------------------------------------------------ Pi

const pi = {
  label: "Pi (pi -p)",
  defaultModel: "openai-codex/gpt-6-luna",
  guard: "seatbelt",
  armC: false,
  runtimeKind: "pi-sdk",
  bin: () => process.env.ADE_EVAL_PI_BIN ?? onPath("pi"),
  detect(bin, model) {
    if (!bin) return { ok: false, reason: "pi not found" };
    const [provider, id] = model.split("/");
    const list = spawnSync(bin, ["--list-models", id ?? provider], { encoding: "utf8", timeout: 60_000, env: probeEnv() });
    if (!list.stdout.split("\n").some((line) => line.startsWith(`${provider} `) && line.includes(id ?? ""))) {
      return { ok: false, reason: `model ${model} not available (pi --list-models)` };
    }
    return { ok: true };
  },
  build({ bin, job, sandbox, model }) {
    const [provider, id] = model.split("/");
    return {
      cmd: bin,
      argv: ["-p", "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--skill", sandbox.skillRoot,
        "--provider", provider, "--model", id, "--thinking", "low", "--append-system-prompt", sandbox.promptFile, job.userPrompt],
    };
  },
  parse(stdout) {
    const calls = [];
    let reply = "";
    const usage = emptyUsage(null);
    let total = 0;
    let cost = 0;
    for (const event of jsonLines(stdout)) {
      if (event.type === "tool_execution_start") calls.push(callText(event.toolName, "bash", event.args));
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const u = event.message.usage ?? {};
        const input = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        if (usage.firstInput == null) {
          usage.firstInput = input;
          usage.firstCacheWrite = u.cacheWrite ?? 0;
        }
        total += input;
        cost += u.cost?.total ?? 0;
        const text = (event.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
        if (text) reply = text;
      }
    }
    usage.totalInput = total || null;
    usage.costUsd = cost;
    return { calls, reply, usage };
  },
};

// ------------------------------------------------------------------ Qwen

/**
 * A private QWEN_HOME with only the sign-in and model keys of ~/.qwen/settings.json:
 * the user's MCP servers, extensions and memories stay out of the run.
 * The file holds the user's model key, so it is written owner-only.
 */
function qwenHome(dir, skillRoot) {
  fs.mkdirSync(dir, { recursive: true });
  let user = {};
  try { user = JSON.parse(fs.readFileSync(path.join(home, ".qwen/settings.json"), "utf8")); } catch { /* signed out */ }
  const keep = Object.fromEntries(["$version", "env", "security", "model", "modelProviders"].filter((k) => k in user).map((k) => [k, user[k]]));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(keep), { mode: 0o600 });
  if (skillRoot) linkSkills(skillRoot, path.join(dir, "skills"));
  return dir;
}

const qwen = {
  label: "Qwen Code (qwen -y)",
  defaultModel: null,
  guard: "seatbelt",
  armC: false,
  // Qwen runs over ACP and has no runtime kind of its own; it gets the generic
  // text (in ADE it gets the bootstrap in its first user turn).
  runtimeKind: null,
  bin: () => process.env.ADE_EVAL_QWEN_BIN ?? newest(path.join(toolsDir, "qwen-code-darwin-arm64"), "bin/qwen") ?? onPath("qwen"),
  detect(bin) {
    if (!bin) return { ok: false, reason: "qwen not found" };
    const dir = probeDir();
    const probe = spawnSync(bin, ["Reply with the word OK."], { encoding: "utf8", timeout: 150_000, cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...probeEnv(), QWEN_HOME: qwenHome(path.join(dir, "qwenhome")) } });
    fs.rmSync(dir, { recursive: true, force: true });
    if (probe.status !== 0 || !/\bOK\b/.test(probe.stdout)) {
      const lines = `${probe.stderr}\n${probe.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
      if (probe.error?.code === "ETIMEDOUT") lines.push("no answer in 150 s");
      const why = lines.find((l) => /error|refused|fail|denied|timed? ?out/i.test(l) && !/MCP server/i.test(l)) ?? lines.pop() ?? "no output";
      return { ok: false, reason: `not usable: ${why.slice(0, 140)}` };
    }
    return { ok: true };
  },
  build({ bin, job, sandbox, model }) {
    // The OpenAI request log is the source of tool calls; it is plain
    // OpenAI JSON, so it does not depend on Qwen's own event format.
    const logDir = path.join(sandbox.caseDir, "qwen-openai-log");
    fs.mkdirSync(logDir, { recursive: true });
    const argv = ["-y", "--allowed-mcp-server-names", "none", "--openai-logging", "--openai-logging-dir", logDir,
      "--append-system-prompt", fs.readFileSync(sandbox.promptFile, "utf8")];
    if (model) argv.push("-m", model);
    argv.push(job.userPrompt);
    return { cmd: bin, argv, env: { QWEN_HOME: qwenHome(path.join(sandbox.caseDir, "qwenhome"), sandbox.skillRoot) } };
  },
  parse(stdout, sandbox) {
    const calls = [];
    const logDir = path.join(sandbox.caseDir, "qwen-openai-log");
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).sort() : [];
    for (const file of files) {
      let entry;
      try { entry = JSON.parse(fs.readFileSync(path.join(logDir, file), "utf8")); } catch { continue; }
      for (const choice of entry.response?.choices ?? []) {
        for (const call of choice.message?.tool_calls ?? []) {
          let parsed = {};
          try { parsed = JSON.parse(call.function?.arguments ?? "{}"); } catch {}
          calls.push(parsed.command != null ? String(parsed.command) : `tool:${call.function?.name}`);
        }
      }
    }
    return { calls, reply: stdout.trim(), usage: emptyUsage("parser unverified: Qwen was not usable when this was written") };
  },
};

export const PROVIDERS = { claude, codex, cursor, droid, copilot, opencode, pi, qwen };
