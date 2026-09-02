#!/usr/bin/env node
/**
 * Dummy session/close after initialize — no auth, no prompt.
 * Distinguishes "method exists" from "not implemented".
 */
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { AcpClient, errInfo } from "./liveBinaryProbe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function isolateEnv(overrides = {}) {
  const env = { ...process.env, NO_COLOR: "1", ...overrides };
  for (const key of [
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "DASHSCOPE_API_KEY", "QWEN_API_KEY",
    "MOONSHOT_API_KEY", "KIMI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
  ]) delete env[key];
  return env;
}

async function probe(label, command, args, env, cwd) {
  const client = new AcpClient({ command, args, cwd, env, label });
  const steps = [];
  try {
    const init = await client.initialize();
    steps.push({
      step: "initialize",
      ok: true,
      closeAdvertised: Boolean(init?.agentCapabilities?.sessionCapabilities && Object.prototype.hasOwnProperty.call(init.agentCapabilities.sessionCapabilities, "close")),
      sessionCapabilities: init?.agentCapabilities?.sessionCapabilities ?? null,
    });
    try {
      const result = await client.request("session/close", { sessionId: "00000000-0000-4000-8000-000000000000" }, 8_000);
      steps.push({ step: "session/close dummy id", ok: true, unexpected: result });
    } catch (error) {
      steps.push({ step: "session/close dummy id", ok: false, ...errInfo(error) });
    }
    if (label === "qwen") {
      try {
        const auth = await client.request("authenticate", { methodId: "openai" }, 8_000);
        steps.push({ step: "authenticate openai", ok: true, result: auth ?? null });
      } catch (error) {
        steps.push({ step: "authenticate openai", ok: false, ...errInfo(error) });
      }
    }
  } catch (error) {
    steps.push({ step: "fatal", ok: false, ...errInfo(error) });
  } finally {
    client.dispose();
  }
  return { provider: label, steps };
}

const root = mkdtempSync(path.join(os.tmpdir(), "ade-close-probe-"));
const cwd = path.join(root, "repo");
mkdirSync(cwd, { recursive: true });
execSync("git init -q", { cwd });
writeFileSync(path.join(cwd, "README.md"), "probe\n");
const fakeHome = path.join(root, "home");
mkdirSync(fakeHome, { recursive: true });
const env = isolateEnv({
  HOME: fakeHome,
  PATH: `${path.join(os.homedir(), ".kimi-code", "bin")}:${process.env.PATH ?? ""}`,
  QWEN_HOME: path.join(root, "qwen-home"),
  KIMI_CODE_HOME: path.join(root, "kimi-home"),
});
mkdirSync(env.QWEN_HOME, { recursive: true });
mkdirSync(env.KIMI_CODE_HOME, { recursive: true });

const report = {
  qwen: await probe("qwen", "qwen", ["--acp"], env, cwd),
  kimi: await probe("kimi", "kimi", ["acp"], env, cwd),
};
writeFileSync(path.join(here, "qwen-kimi-close-probe.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
