#!/usr/bin/env node
/**
 * Unauthenticated Qwen + Kimi verification.
 *
 * Config homes and scratch cwds live under os.tmpdir() only. Does not write
 * ~/.qwen, ~/.kimi-code (beyond the installer), ~/.claude, ~/.grok, or
 * ~/.copilot. Does not run login or spend API keys.
 *
 * Usage: node qwenKimiUnauthProbe.mjs
 */
import { spawn, spawnSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient, errInfo, summarizeCaps } from "./liveBinaryProbe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const STRIP_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
];

function isolateEnv(overrides = {}) {
  const env = { ...process.env, NO_COLOR: "1", ...overrides };
  for (const key of STRIP_ENV_KEYS) delete env[key];
  return env;
}

function capture(command, args, env, timeoutMs = 15_000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal ?? null,
    stdout: (result.stdout ?? "").slice(0, 8_000),
    stderr: (result.stderr ?? "").slice(0, 8_000),
    error: result.error ? result.error.message : null,
  };
}

function firstLine(text) {
  return (text ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "";
}

function listRel(dir) {
  if (!existsSync(dir)) return { exists: false, entries: [] };
  const entries = [];
  const walk = (current, prefix = "") => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full, rel);
        else entries.push({ path: rel, bytes: st.size });
      } catch {
        entries.push({ path: rel, bytes: null });
      }
    }
  };
  walk(dir);
  return { exists: true, entries };
}

function makeGitCwd(parent) {
  const cwd = path.join(parent, "repo");
  mkdirSync(cwd, { recursive: true });
  execSync("git init -q", { cwd });
  writeFileSync(path.join(cwd, "README.md"), "ade acp unauth probe\n");
  return cwd;
}

async function waitMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnUntil(command, args, env, ms) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 500);
    }, ms);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: code,
        signal,
        stdout: stdout.slice(0, 4_000),
        stderr: stderr.slice(0, 4_000),
        timedOut: signal === "SIGTERM" || signal === "SIGKILL",
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr, error: error.message, timedOut: false });
    });
  });
}

function qwenCliChecks(env) {
  const help = capture("qwen", ["--help"], env);
  const fullHelp = capture("qwen", ["--yolo", "--approval-mode=default", "-p", "ping"], env);
  const combined = `${help.stdout}\n${help.stderr}`;
  const full = `${fullHelp.stdout}\n${fullHelp.stderr}`;
  const presentInDefaultHelp = {
    "-i": / -i, --prompt-interactive/.test(combined),
    "-m": / -m, --model/.test(combined),
    "--approval-mode": /--approval-mode/.test(combined),
    "--session-id": /--session-id/.test(combined),
    "--resume": / -r, --resume/.test(combined),
    "--continue": / -c, --continue/.test(combined),
    "--yolo": / -y, --yolo/.test(combined),
    "--append-system-prompt": /--append-system-prompt/.test(combined),
    "--acp": /--acp/.test(combined),
  };
  const presentInErrorHelp = {
    "-i": / -i, --prompt-interactive/.test(full),
    "-m": / -m, --model/.test(full),
    "--approval-mode": /--approval-mode/.test(full),
    "--session-id": /--session-id/.test(full),
    "--resume": / -r, --resume/.test(full),
    "--continue": / -c, --continue/.test(full),
    "--yolo": / -y, --yolo/.test(full),
    "--append-system-prompt": /--append-system-prompt/.test(full),
    "--acp": /--acp/.test(full),
    approvalChoices: /choices: "plan", "default", "auto-edit", "auto", "yolo"/.test(full),
  };
  return {
    version: firstLine(capture("qwen", ["--version"], env).stdout),
    defaultHelpOmitsLoadBearingFlags: Object.entries(presentInDefaultHelp)
      .filter(([, ok]) => !ok)
      .map(([flag]) => flag),
    errorHelpFlags: presentInErrorHelp,
    yoloPlusApproval: {
      status: fullHelp.status,
      firstLine: firstLine(full),
      expected: "Cannot use both --yolo (-y) and --approval-mode together",
      matched: /Cannot use both --yolo/.test(full),
    },
    sessionIdPlusResume: capture(
      "qwen",
      ["--session-id", UUID, "--resume", UUID, "-p", "ping"],
      env,
    ),
    sessionIdPlusContinue: capture(
      "qwen",
      ["--session-id", UUID, "--continue", "-p", "ping"],
      env,
    ),
    approvalModeBogus: capture("qwen", ["--approval-mode", "bogus", "-p", "ping"], env),
    authSubcommand: capture("qwen", ["auth", "--help"], env),
  };
}

function kimiCliChecks(env) {
  const help = capture("kimi", ["--help"], env);
  const text = `${help.stdout}\n${help.stderr}`;
  const acpHelp = capture("kimi", ["acp", "--help"], env);
  const loginHelp = capture("kimi", ["login", "--help"], env);
  return {
    version: firstLine(capture("kimi", ["--version"], env).stdout),
    flags: {
      noPositionalPrompt: !/\[prompt\]|\[query\]/.test(text) && /\[options\] \[command\]/.test(text),
      sessionDashS: / -S, --session/.test(text),
      continueDashC: / -c, --continue/.test(text),
      yolo: / -y, --yolo/.test(text),
      auto: /--auto/.test(text),
      plan: /--plan/.test(text),
      modelAlias: /LLM model alias/.test(text),
      addDir: /--add-dir/.test(text),
      promptNonInteractive: / -p, --prompt/.test(text),
    },
    yoloPlusAutoPrompt: capture("kimi", ["--yolo", "--auto", "-p", "ping"], env),
    yoloPlusPrompt: capture("kimi", ["--yolo", "-p", "ping"], env),
    autoPlusPrompt: capture("kimi", ["--auto", "-p", "ping"], env),
    yoloPlusAutoDoctor: capture("kimi", ["--yolo", "--auto", "doctor"], env),
    acpHelp: `${acpHelp.stdout}\n${acpHelp.stderr}`.slice(0, 2_000),
    loginHelp: `${loginHelp.stdout}\n${loginHelp.stderr}`.slice(0, 2_000),
  };
}

async function probeAcp({ label, command, args, cwd, env, fixtureName }) {
  const report = { provider: label, command, args, steps: [] };
  const client = new AcpClient({ command, args, cwd, env, label });
  try {
    const init = await client.initialize();
    writeFileSync(path.join(here, fixtureName), `${JSON.stringify(init, null, 2)}\n`);
    report.steps.push({ step: "initialize", ok: true, caps: summarizeCaps(init), fixture: fixtureName });

    try {
      const created = await client.request("session/new", { cwd, mcpServers: [] }, 30_000);
      report.steps.push({
        step: "session/new",
        ok: true,
        unexpectedUnauthenticatedSession: true,
        sessionId: created.sessionId ?? null,
        modes: created.modes ?? null,
        configOptions: created.configOptions ?? null,
      });
      try {
        await client.request("session/close", { sessionId: created.sessionId }, 8_000);
        report.steps.push({ step: "session/close", ok: true });
      } catch (error) {
        report.steps.push({ step: "session/close", ok: false, ...errInfo(error) });
      }
    } catch (error) {
      report.steps.push({
        step: "session/new",
        ok: false,
        expectedAuthError: true,
        ...errInfo(error),
      });
    }
  } catch (error) {
    report.steps.push({ step: "fatal", ok: false, ...errInfo(error), stderrTail: client.stderrTail.slice(-2_000) });
  } finally {
    client.dispose();
    report.stderrTail = client.stderrTail.slice(-2_000);
    report.notificationsSample = client.notifications.slice(0, 20).map((entry) => ({
      method: entry.method,
      sessionUpdate: entry.params?.update?.sessionUpdate ?? null,
    }));
  }
  return report;
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ade-qwen-kimi-"));
  const fakeHome = path.join(root, "home");
  const qwenHome = path.join(root, "qwen-home");
  const kimiHome = path.join(root, "kimi-home");
  const scratch = makeGitCwd(root);
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(qwenHome, { recursive: true });
  mkdirSync(kimiHome, { recursive: true });

  const kimiBin = path.join(os.homedir(), ".kimi-code", "bin");
  const baseEnv = isolateEnv({
    HOME: fakeHome,
    PATH: `${kimiBin}:${process.env.PATH ?? ""}`,
    QWEN_HOME: qwenHome,
    KIMI_CODE_HOME: kimiHome,
  });

  const report = {
    tmpRoot: root,
    versions: {
      qwen: firstLine(capture("qwen", ["--version"], baseEnv).stdout),
      kimi: firstLine(capture("kimi", ["--version"], baseEnv).stdout),
    },
    cli: {},
    acp: {},
    configHomes: {},
    kimiYoloAutoTui: null,
  };

  process.stderr.write("cli checks...\n");
  report.cli.qwen = qwenCliChecks(baseEnv);
  report.cli.kimi = kimiCliChecks(baseEnv);

  process.stderr.write("kimi --yolo --auto tui (2s)...\n");
  report.kimiYoloAutoTui = await spawnUntil("kimi", ["--yolo", "--auto"], baseEnv, 2_000);

  process.stderr.write("qwen acp handshake...\n");
  report.acp.qwen = await probeAcp({
    label: "qwen",
    command: "qwen",
    args: ["--acp"],
    cwd: scratch,
    env: baseEnv,
    fixtureName: "qwen.initialize.json",
  });

  process.stderr.write("kimi acp handshake...\n");
  report.acp.kimi = await probeAcp({
    label: "kimi",
    command: "kimi",
    args: ["acp"],
    cwd: scratch,
    env: baseEnv,
    fixtureName: "kimi.initialize.json",
  });

  report.configHomes = {
    qwenHome,
    kimiHome,
    fakeHome,
    qwenHomeListing: listRel(qwenHome),
    kimiHomeListing: listRel(kimiHome),
    fakeHomeListing: listRel(fakeHome),
    kimiDoctor: capture("kimi", ["doctor"], baseEnv),
  };

  writeFileSync(path.join(here, "qwen-kimi-unauth-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // tmp leftover is fine
  }
}

await main();
