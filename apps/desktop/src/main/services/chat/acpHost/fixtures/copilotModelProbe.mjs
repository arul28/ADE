#!/usr/bin/env node
/**
 * Copilot model-availability probe. Tries --model on both -p and --acp
 * from a tiny tmp cwd. Does not install packages.
 *
 * Usage: node copilotModelProbe.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const PING = "Reply with exactly the word ping and nothing else. Do not use tools.";
const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: "ade", title: "ADE", version: "1" };

class AcpClient {
  constructor({ args, cwd }) {
    this.pending = new Map();
    this.nextId = 1;
    this.notifications = [];
    this.stderrTail = "";
    this.exited = null;
    this.child = spawn("copilot", args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout?.on("data", this.#onStdout());
    this.child.stderr?.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-4_000);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(`copilot exited code=${code} signal=${signal}`));
      }
      this.pending.clear();
    });
  }

  #onStdout() {
    let buffer = "";
    return (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.trim()) this.#handleLine(line);
        index = buffer.indexOf("\n");
      }
    };
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      return;
    }
    const id = frame.id;
    const method = typeof frame.method === "string" ? frame.method : null;
    if (method && id !== undefined && id !== null) {
      if (method === "session/request_permission") {
        this.#write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      this.#write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `probe does not implement ${method}` },
      });
      return;
    }
    if (method) {
      this.notifications.push({ method, update: frame.params?.update?.sessionUpdate ?? null });
      return;
    }
    if (id === undefined || id === null) return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message ?? "rpc error"), { rpc: frame.error }));
    else waiter.resolve(frame.result);
  }

  #write(frame) {
    if (!this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    return true;
  }

  request(method, params, timeoutMs = 45_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (!this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("stdin is not writable"));
      }
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  dispose() {
    try {
      this.child.stdin?.end();
    } catch {
      // gone
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // gone
    }
  }
}

function promptText(result, client) {
  const chunks = client.notifications
    .filter((entry) => entry.update === "agent_message_chunk")
    .map((entry) => entry);
  const metaText = typeof result?._meta === "object" ? JSON.stringify(result._meta).slice(0, 400) : null;
  return { stopReason: result?.stopReason ?? null, metaText, notifications: client.notifications.slice(0, 20) };
}

async function probeAcp(cwd, extraArgs) {
  const client = new AcpClient({
    args: ["--acp", "--add-dir", cwd, "--no-custom-instructions", ...extraArgs],
    cwd,
  });
  try {
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: CLIENT_INFO,
    }, 20_000);
    try {
      await client.request("authenticate", { methodId: "copilot-login" }, 15_000);
    } catch {
      // already authenticated
    }
    const created = await client.request("session/new", { cwd, mcpServers: [] }, 45_000);
    const result = await client.request(
      "session/prompt",
      { sessionId: created.sessionId, prompt: [{ type: "text", text: PING }] },
      60_000,
    );
    const text = client.notifications
      .filter((entry) => entry.update === "agent_message_chunk");
    return {
      ok: true,
      extraArgs,
      sessionId: created.sessionId,
      stopReason: result.stopReason ?? null,
      usage: result.usage ?? null,
      textHint: JSON.stringify(result).slice(0, 800),
      notificationUpdates: client.notifications.map((entry) => entry.update ?? entry.method).slice(0, 30),
      stderrTail: client.stderrTail.slice(-800),
    };
  } catch (error) {
    return {
      ok: false,
      extraArgs,
      error: error instanceof Error ? error.message : String(error),
      stderrTail: client.stderrTail.slice(-800),
    };
  } finally {
    client.dispose();
  }
}

function probePrompt(cwd, extraArgs) {
  const args = [
    "-p",
    PING,
    "-s",
    "--allow-all-tools",
    "--add-dir",
    cwd,
    "--no-custom-instructions",
    ...extraArgs,
  ];
  try {
    const stdout = execSync(`copilot ${args.map((arg) => JSON.stringify(arg)).join(" ")}`, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, extraArgs, stdout: stdout.slice(0, 1_200) };
  } catch (error) {
    const err = error;
    return {
      ok: false,
      extraArgs,
      status: err.status ?? null,
      stdout: String(err.stdout ?? "").slice(0, 800),
      stderr: String(err.stderr ?? "").slice(0, 800),
    };
  }
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ade-copilot-probe-"));
  execSync("git init", { cwd: tmp, stdio: "ignore" });
  writeFileSync(path.join(tmp, "README.md"), "probe\n");
  const report = { steps: [] };
  try {
    report.steps.push({ step: "prompt-default", ...probePrompt(tmp, []) });
    report.steps.push({ step: "prompt-model-auto", ...probePrompt(tmp, ["--model", "auto"]) });
    report.steps.push({ step: "prompt-model-gpt-5.4", ...probePrompt(tmp, ["--model", "gpt-5.4"]) });
    report.steps.push({ step: "acp-default", ...(await probeAcp(tmp, [])) });
    report.steps.push({ step: "acp-model-auto", ...(await probeAcp(tmp, ["--model", "auto"])) });
    report.steps.push({ step: "acp-model-gpt-5.4", ...(await probeAcp(tmp, ["--model", "gpt-5.4"])) });
    report.steps.push({
      step: "acp-model-claude-sonnet-4.6",
      ...(await probeAcp(tmp, ["--model", "claude-sonnet-4.6"])),
    });
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // leave tmp
    }
  }
  writeFileSync(path.join(here, "copilot.model-probe.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
