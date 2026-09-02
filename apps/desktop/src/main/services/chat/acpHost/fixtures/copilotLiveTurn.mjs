#!/usr/bin/env node
/**
 * Copilot ACP live turn: capture assistant text, cancel, and a write.
 * Tiny tmp cwd. Usage: node copilotLiveTurn.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: "ade", title: "ADE", version: "1" };

class AcpClient {
  constructor({ args, cwd }) {
    this.pending = new Map();
    this.nextId = 1;
    this.updates = [];
    this.permissions = [];
    this.stderrTail = "";
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
        this.permissions.push(frame.params ?? null);
        const options = Array.isArray(frame.params?.options) ? frame.params.options : [];
        const allow = options.find((option) => option.kind === "allow_once") ?? options[0];
        this.#write({
          jsonrpc: "2.0",
          id,
          result: {
            outcome: allow
              ? { outcome: "selected", optionId: allow.optionId }
              : { outcome: "cancelled" },
          },
        });
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
      this.updates.push({ method, params: frame.params ?? null });
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

  request(method, params, timeoutMs = 60_000) {
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
      this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  text() {
    return this.updates
      .filter((entry) => entry.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((entry) => entry.params.update.content?.text ?? "")
      .join("");
  }

  updateKinds() {
    return this.updates.map((entry) => entry.params?.update?.sessionUpdate ?? entry.method);
  }

  configUpdates() {
    return this.updates
      .filter((entry) => entry.params?.update?.sessionUpdate === "config_option_update")
      .map((entry) => entry.params.update);
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

async function openSession(cwd, extraArgs = []) {
  const client = new AcpClient({
    args: ["--acp", "--add-dir", cwd, ...extraArgs],
    cwd,
  });
  await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: CLIENT_INFO,
  }, 20_000);
  try {
    await client.request("authenticate", { methodId: "copilot-login" }, 15_000);
  } catch {
    // already in
  }
  const created = await client.request("session/new", { cwd, mcpServers: [] }, 45_000);
  return { client, sessionId: created.sessionId };
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ade-copilot-turn-"));
  execSync("git init", { cwd: tmp, stdio: "ignore" });
  writeFileSync(path.join(tmp, "README.md"), "probe\n");
  const report = { steps: [] };

  try {
    {
      const { client, sessionId } = await openSession(tmp);
      try {
        const result = await client.request(
          "session/prompt",
          { sessionId, prompt: [{ type: "text", text: "Reply with exactly the word ping and nothing else. Do not use tools." }] },
          60_000,
        );
        report.steps.push({
          step: "ping",
          ok: /ping/i.test(client.text()) && result.stopReason === "end_turn",
          text: client.text(),
          stopReason: result.stopReason ?? null,
          usage: result.usage ?? null,
          config: client.configUpdates(),
          kinds: client.updateKinds(),
        });
      } finally {
        client.dispose();
      }
    }

    {
      const { client, sessionId } = await openSession(tmp, ["--model", "gpt-5.4"]);
      try {
        const result = await client.request(
          "session/prompt",
          { sessionId, prompt: [{ type: "text", text: "Reply with exactly the word ping and nothing else. Do not use tools." }] },
          60_000,
        );
        report.steps.push({
          step: "ping-with-model-gpt-5.4",
          ok: true,
          text: client.text(),
          stopReason: result.stopReason ?? null,
          usage: result.usage ?? null,
          config: client.configUpdates(),
        });
      } finally {
        client.dispose();
      }
    }

    {
      const { client, sessionId } = await openSession(tmp);
      try {
        const prompt = client.request(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: "Count slowly from 1 to 80, one integer per line. Do not use tools." }],
          },
          60_000,
        );
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (client.text().length > 0) {
              clearInterval(timer);
              resolve();
            }
          }, 40);
          setTimeout(() => {
            clearInterval(timer);
            resolve();
          }, 8_000);
        });
        client.notify("session/cancel", { sessionId });
        const result = await prompt;
        report.steps.push({
          step: "cancel-mid-prompt",
          ok: true,
          text: client.text().slice(0, 200),
          stopReason: result.stopReason ?? null,
          usage: result.usage ?? null,
        });
      } finally {
        client.dispose();
      }
    }

    {
      const { client, sessionId } = await openSession(tmp);
      try {
        const result = await client.request(
          "session/prompt",
          {
            sessionId,
            prompt: [{
              type: "text",
              text: "Write a file named acp-probe-write.txt in the current working directory containing only the word ping. Use a write tool. Do nothing else.",
            }],
          },
          90_000,
        );
        let wrote = "";
        try {
          wrote = readFileSync(path.join(tmp, "acp-probe-write.txt"), "utf8");
        } catch {
          wrote = "";
        }
        report.steps.push({
          step: "write-probe",
          ok: true,
          text: client.text().slice(0, 400),
          stopReason: result.stopReason ?? null,
          permissionCount: client.permissions.length,
          permissionTitles: client.permissions.map((entry) => entry?.toolCall?.title ?? entry?.toolCall?.kind ?? null),
          kinds: client.updateKinds(),
          wrote,
        });
      } finally {
        client.dispose();
      }
    }
  } catch (error) {
    report.steps.push({
      step: "fatal",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // leave tmp
    }
  }

  writeFileSync(path.join(here, "copilot.live-turn.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
