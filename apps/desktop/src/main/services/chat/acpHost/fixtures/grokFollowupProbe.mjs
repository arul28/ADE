#!/usr/bin/env node
/**
 * Cheap Grok follow-up probes. Cwd is a tiny throwaway repo under os.tmpdir()
 * so ADE's worktree is not pulled into the prompt (that was a ~30k-token ping).
 *
 * Usage: node grokFollowupProbe.mjs
 */
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: "ade", title: "ADE", version: "1" };
const GROK_ARGS = [
  "--no-auto-update",
  "--no-plan",
  "--permission-mode",
  "default",
  "agent",
  "--no-leader",
  "stdio",
];

class AcpClient {
  constructor({ command, args, cwd, env, label }) {
    this.label = label;
    this.pending = new Map();
    this.nextId = 1;
    this.notifications = [];
    this.reverseRequests = [];
    this.exited = null;
    this.stderrTail = "";
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pid = this.child.pid ?? null;
    this.child.stdout?.on("data", this.#onStdout());
    this.child.stderr?.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-6_000);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(`${this.label} exited code=${code} signal=${signal}`));
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
      this.reverseRequests.push({ method, id, params: frame.params ?? null });
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
      this.notifications.push({ method, params: frame.params ?? null });
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
        reject(new Error(`${this.label} ${method} timed out after ${timeoutMs}ms`));
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
        reject(new Error(`${this.label} stdin is not writable`));
      }
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  initialize() {
    return this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: CLIENT_INFO,
      _meta: { clientIdentifier: "ade" },
    }, 20_000);
  }

  kill(signal = "SIGTERM") {
    try {
      this.child.kill(signal);
    } catch {
      // already gone
    }
  }

  dispose() {
    try {
      this.child.stdin?.end();
    } catch {
      // already gone
    }
    this.kill("SIGTERM");
  }
}

function textChunks(client) {
  return client.notifications
    .filter((entry) => entry.params?.update?.sessionUpdate === "agent_message_chunk")
    .map((entry) => entry.params.update.content?.text ?? "");
}

function permissionCount(client) {
  return client.reverseRequests.filter((entry) => entry.method === "session/request_permission").length;
}

function usageFromPrompt(result) {
  const meta = result?._meta && typeof result._meta === "object" ? result._meta : {};
  const nested = meta.usage && typeof meta.usage === "object" ? meta.usage : {};
  const ticks = nested.costUsdTicks ?? meta.costUsdTicks ?? null;
  return {
    inputTokens: nested.inputTokens ?? meta.inputTokens ?? null,
    outputTokens: nested.outputTokens ?? meta.outputTokens ?? null,
    cachedReadTokens: nested.cachedReadTokens ?? meta.cachedReadTokens ?? null,
    costUsdTicks: ticks,
    costUsdNano: typeof ticks === "number" ? ticks / 1_000_000_000 : null,
    stopReason: result?.stopReason ?? null,
    rawMeta: meta,
  };
}

async function withClient(cwd, env, fn) {
  const client = new AcpClient({
    command: "grok",
    args: GROK_ARGS,
    cwd,
    env: { ...process.env, NO_COLOR: "1", ...env },
    label: "grok",
  });
  try {
    await client.initialize();
    const created = await client.request("session/new", { cwd, mcpServers: [] }, 45_000);
    return await fn(client, created.sessionId);
  } finally {
    client.dispose();
  }
}

async function main() {
  const report = { steps: [] };
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ade-grok-probe-"));
  const cwd = path.join(tmpRoot, "repo");
  const claudeHome = path.join(tmpRoot, "claude-empty");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(path.join(claudeHome, "settings.json"), `${JSON.stringify({ permissions: { defaultMode: "default" } }, null, 2)}\n`);
  execSync("git init", { cwd, stdio: "ignore" });
  writeFileSync(path.join(cwd, "README.md"), "probe\n");

  try {
    report.steps.push(await (async () => {
      const client = new AcpClient({
        command: "grok",
        args: GROK_ARGS,
        cwd,
        env: { ...process.env, NO_COLOR: "1" },
        label: "grok-ping",
      });
      try {
        await client.initialize();
        const created = await client.request("session/new", { cwd, mcpServers: [] }, 45_000);
        const sessionId = created.sessionId;
        const result = await client.request(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: "Reply with exactly the word ping and nothing else. Do not use tools." }],
          },
          60_000,
        );
        const usage = usageFromPrompt(result);
        usage.text = textChunks(client).join("");
        try {
          await client.request("session/close", { sessionId }, 10_000);
        } catch {
          // close is best-effort
        }
        return { step: "cheap-ping", ok: true, usage, chunkCount: textChunks(client).length, sessionId };
      } finally {
        client.dispose();
      }
    })());

    report.steps.push(await (async () => {
      return withClient(cwd, {}, async (client, sessionId) => {
        const before = client.notifications.length;
        const result = await client.request(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: "Count from 1 to 8 inclusive, one integer per line, nothing else. Do not use tools." }],
          },
          60_000,
        );
        const chunks = client.notifications
          .slice(before)
          .filter((entry) => entry.params?.update?.sessionUpdate === "agent_message_chunk")
          .map((entry) => entry.params.update.content?.text ?? "");
        const updates = client.notifications.slice(before).map((entry) => entry.params?.update?.sessionUpdate ?? entry.method);
        return {
          step: "stream-chunks",
          ok: true,
          chunkCount: chunks.length,
          joined: chunks.join(""),
          updateOrder: updates.slice(0, 40),
          stopReason: result.stopReason ?? null,
          usage: usageFromPrompt(result),
        };
      });
    })());

    report.steps.push(await (async () => {
      return withClient(cwd, { CLAUDE_CONFIG_DIR: claudeHome }, async (client, sessionId) => {
        writeFileSync(path.join(cwd, "acp-probe-write.txt"), "");
        const result = await client.request(
          "session/prompt",
          {
            sessionId,
            prompt: [{
              type: "text",
              text: "Overwrite acp-probe-write.txt in the current working directory with only the word ping. Use a write tool. Do nothing else.",
            }],
          },
          60_000,
        );
        return {
          step: "permission-with-empty-claude-config-dir",
          ok: true,
          permissionRequests: permissionCount(client),
          stopReason: result.stopReason ?? null,
          claudeConfigDir: claudeHome,
          note: "A zero here means Grok still auto-allowed even with CLAUDE_CONFIG_DIR pointed at an empty home.",
        };
      });
    })());

    report.steps.push(await (async () => {
      let sessionId = null;
      {
        const client = new AcpClient({
          command: "grok",
          args: GROK_ARGS,
          cwd,
          env: { ...process.env, NO_COLOR: "1" },
          label: "grok-resume-a",
        });
        try {
          await client.initialize();
          const created = await client.request("session/new", { cwd, mcpServers: [] }, 45_000);
          sessionId = created.sessionId;
          await client.request(
            "session/prompt",
            {
              sessionId,
              prompt: [{ type: "text", text: "Reply with exactly the word alpha and nothing else. Do not use tools." }],
            },
            60_000,
          );
          try {
            await client.request("session/close", { sessionId }, 10_000);
          } catch {
            // close is best-effort
          }
        } finally {
          client.dispose();
        }
      }
      const client = new AcpClient({
        command: "grok",
        args: GROK_ARGS,
        cwd,
        env: { ...process.env, NO_COLOR: "1" },
        label: "grok-resume-b",
      });
      try {
        await client.initialize();
        let resumeOk = false;
        let resumeError = null;
        try {
          await client.request("session/resume", { sessionId, cwd, mcpServers: [] }, 45_000);
          resumeOk = true;
        } catch (error) {
          resumeError = error instanceof Error ? error.message : String(error);
        }
        let loadOk = false;
        let loadError = null;
        if (!resumeOk) {
          try {
            await client.request("session/load", { sessionId, cwd, mcpServers: [] }, 45_000);
            loadOk = true;
          } catch (error) {
            loadError = error instanceof Error ? error.message : String(error);
          }
        }
        const result = await client.request(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: "Reply with exactly the word beta and nothing else. Do not use tools." }],
          },
          60_000,
        );
        return {
          step: "resume-after-close",
          ok: resumeOk || loadOk,
          sessionId,
          resumeOk,
          resumeError,
          loadOk,
          loadError,
          followupText: textChunks(client).join(""),
          stopReason: result.stopReason ?? null,
        };
      } finally {
        client.dispose();
      }
    })());

    report.steps.push(await (async () => {
      const client = new AcpClient({
        command: "grok",
        args: GROK_ARGS,
        cwd,
        env: { ...process.env, NO_COLOR: "1" },
        label: "grok-kill",
      });
      try {
        await client.initialize();
        const created = await client.request("session/new", { cwd, mcpServers: [] }, 45_000);
        const sessionId = created.sessionId;
        const prompt = client.request(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: "Count slowly from 1 to 200, one integer per line. Do not use tools." }],
          },
          60_000,
        );
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (client.notifications.some((entry) => entry.params?.update?.sessionUpdate === "agent_message_chunk")) {
              clearInterval(timer);
              resolve();
            }
          }, 50);
          setTimeout(() => {
            clearInterval(timer);
            resolve();
          }, 8_000);
        });
        client.kill("SIGTERM");
        let promptOutcome = "unknown";
        try {
          const result = await prompt;
          promptOutcome = `resolved:${result.stopReason ?? "none"}`;
        } catch (error) {
          promptOutcome = `rejected:${error instanceof Error ? error.message : String(error)}`;
        }
        return {
          step: "kill-mid-prompt",
          ok: promptOutcome.startsWith("rejected") || promptOutcome.includes("cancelled"),
          promptOutcome,
          exited: client.exited,
          chunksBeforeKill: textChunks(client).length,
        };
      } finally {
        client.dispose();
      }
    })());

    report.steps.push(await (async () => {
      const spawnOne = async (modelId) => {
        const client = new AcpClient({
          command: "grok",
          args: ["--no-auto-update", "--no-plan", "--permission-mode", "default", "-m", modelId, "agent", "--no-leader", "stdio"],
          cwd,
          env: { ...process.env, NO_COLOR: "1" },
          label: `grok-${modelId}`,
        });
        await client.initialize();
        const created = await client.request("session/new", { cwd, mcpServers: [] }, 45_000);
        return { client, pid: client.pid, sessionId: created.sessionId, modelId };
      };
      const first = await spawnOne("grok-4.6");
      const second = await spawnOne("grok-4.5");
      const pidsDiffer = first.pid !== second.pid;
      first.client.dispose();
      second.client.dispose();
      return {
        step: "two-models-two-pids",
        ok: pidsDiffer,
        first: { pid: first.pid, modelId: first.modelId },
        second: { pid: second.pid, modelId: second.modelId },
      };
    })());
  } catch (error) {
    report.steps.push({
      step: "fatal",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // leave the tmp dir if cleanup fails
    }
  }

  writeFileSync(path.join(here, "grok.followup-probe.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
