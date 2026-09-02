#!/usr/bin/env node
/**
 * Cheap Grok permission check: spawn with --permission-mode default and ask
 * for a write. A permission reverse-RPC means the Claude-settings leak is
 * defeated. A write with zero prompts means it is not.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(here, "live-scratch", "isolated-perm");
rmSync(cwd, { recursive: true, force: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(path.join(cwd, "README"), "isolated grok permission probe\n");
execSync("git init", { cwd, stdio: "ignore" });

const child = spawn(
  "grok",
  ["--no-auto-update", "--no-plan", "--permission-mode", "default", "agent", "--no-leader", "stdio"],
  { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] },
);

let buffer = "";
const pending = new Map();
let nextId = 1;
const permissions = [];
const log = [];

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function request(method, params, timeoutMs = 45_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, "").trim();
    buffer = buffer.slice(index + 1);
    if (line.startsWith("{")) {
      try {
        const frame = JSON.parse(line);
        if (frame.method === "session/request_permission" && frame.id != null) {
          permissions.push(frame.params);
          const reject = (frame.params?.options ?? []).find((option) => option.kind === "reject_once")
            ?? (frame.params?.options ?? [])[0];
          send({
            jsonrpc: "2.0",
            id: frame.id,
            result: reject
              ? { outcome: { outcome: "selected", optionId: reject.optionId } }
              : { outcome: { outcome: "cancelled" } },
          });
        } else if (frame.id != null && pending.has(frame.id)) {
          const waiter = pending.get(frame.id);
          pending.delete(frame.id);
          if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message), { rpc: frame.error }));
          else waiter.resolve(frame.result);
        }
      } catch {
        log.push(["unparsable", line.slice(0, 200)]);
      }
    }
    index = buffer.indexOf("\n");
  }
});

const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));

try {
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "ade", title: "ADE", version: "1" },
    _meta: { clientIdentifier: "ade" },
  }, 20_000);
  const created = await request("session/new", { cwd, mcpServers: [] }, 45_000);
  await request(
    "session/prompt",
    {
      sessionId: created.sessionId,
      prompt: [{
        type: "text",
        text: "Create a file named perm-probe.txt in the current directory containing only the word ping. Use a write tool. Do nothing else.",
      }],
    },
    90_000,
  );
  const wrote = existsSync(path.join(cwd, "perm-probe.txt"));
  const report = {
    permissionRequests: permissions.length,
    optionIds: permissions.flatMap((entry) => (entry.options ?? []).map((option) => option.optionId)),
    toolTitles: permissions.map((entry) => entry.toolCall?.title ?? entry.toolCall?.kind ?? null),
    wrote,
    stderrYolo: stderr.join("").includes("yolo_mode_changed") || stderr.join("").includes("Method not found"),
  };
  writeFileSync(path.join(here, "grok.permission-probe.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  try { child.kill("SIGTERM"); } catch { /* gone */ }
  setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 1500).unref?.();
}
