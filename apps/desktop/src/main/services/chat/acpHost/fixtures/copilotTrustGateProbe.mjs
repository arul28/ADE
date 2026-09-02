#!/usr/bin/env node
/**
 * Copilot trust-gate vs per-tool permission experiment.
 *
 * Run C first (neither --add-dir nor trusted_folders) so deadlock-avoidance
 * is not changed on unproven ground. Tiny throwaway git repo as cwd.
 *
 * Usage: node copilotTrustGateProbe.mjs
 */
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: "ade", title: "ADE", version: "1" };
const SESSION_NEW_DEADLOCK_MS = 12_000;
const PROMPT_MS = 90_000;
const WRITE_PROMPT =
  "Create a file named acp-trust-write.txt in the current working directory containing only the word ping. Use a file-write or create-file tool, not a shell. Do nothing else.";

class AcpClient {
  constructor({ args, cwd, env }) {
    this.pending = new Map();
    this.nextId = 1;
    this.updates = [];
    this.permissions = [];
    this.reverseRequests = [];
    this.stderrTail = "";
    this.stdoutNonProtocol = [];
    this.exited = null;
    this.permissionPolicy = "allow_after_record";
    this.child = spawn("copilot", args, {
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
    if (!trimmed.startsWith("{")) {
      this.stdoutNonProtocol.push(trimmed.slice(0, 240));
      return;
    }
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      this.stdoutNonProtocol.push(trimmed.slice(0, 240));
      return;
    }
    const id = frame.id;
    const method = typeof frame.method === "string" ? frame.method : null;
    if (method && id !== undefined && id !== null) {
      this.reverseRequests.push({ method, id });
      if (method === "session/request_permission") {
        this.permissions.push(summarizePermission(frame.params));
        const outcome = this.#permissionOutcome(frame.params);
        this.#write({ jsonrpc: "2.0", id, result: { outcome } });
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
      const update = frame.params?.update ?? {};
      this.updates.push({
        method,
        sessionUpdate: update.sessionUpdate ?? null,
        toolKind: update.kind ?? update.toolCall?.kind ?? null,
        title: update.title ?? update.toolCall?.title ?? null,
        text: typeof update.content?.text === "string" ? update.content.text : null,
      });
      return;
    }
    if (id === undefined || id === null) return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message ?? "rpc error"), { rpc: frame.error }));
    else waiter.resolve(frame.result);
  }

  #permissionOutcome(params) {
    const options = Array.isArray(params?.options) ? params.options : [];
    if (this.permissionPolicy === "hold") {
      return { outcome: "cancelled" };
    }
    const allow = options.find((option) => option.kind === "allow_once") ?? options[0];
    return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
  }

  #write(frame) {
    if (!this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    return true;
  }

  request(method, params, timeoutMs) {
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

  text() {
    return this.updates
      .filter((entry) => entry.sessionUpdate === "agent_message_chunk" && entry.text)
      .map((entry) => entry.text)
      .join("");
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
    setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // gone
      }
    }, 1_200).unref?.();
  }
}

function summarizePermission(params) {
  const toolCall = params?.toolCall ?? {};
  return {
    title: toolCall.title ?? null,
    kind: toolCall.kind ?? null,
    status: toolCall.status ?? null,
    optionKinds: Array.isArray(params?.options) ? params.options.map((option) => option.kind ?? null) : [],
  };
}

function summarizeConfigOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option) => ({
    id: option.id ?? null,
    currentValue: option.currentValue ?? option.value ?? null,
  }));
}

function copilotHome() {
  const configured = process.env.COPILOT_HOME?.trim();
  return configured?.length ? path.resolve(configured) : path.join(os.homedir(), ".copilot");
}

function parseJsonc(raw) {
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(stripped);
}

function stringFolders(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function withoutPath(folders, cwd) {
  const resolved = path.resolve(cwd);
  return folders.filter((entry) => path.resolve(entry) !== resolved);
}

function trustMembership(config, cwd) {
  const snake = stringFolders(config.trusted_folders);
  const camel = stringFolders(config.trustedFolders);
  const resolved = path.resolve(cwd);
  const tmp = path.resolve(os.tmpdir());
  const isPrefix = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
  const combined = [...snake, ...camel];
  return {
    snakeCount: snake.length,
    camelCount: camel.length,
    cwdInSnake: snake.some((folder) => path.resolve(folder) === resolved),
    cwdInCamel: camel.some((folder) => path.resolve(folder) === resolved),
    cwdUnderTrustedAncestor: combined.some((folder) => isPrefix(path.resolve(folder), resolved)),
    tmpUnderTrustedAncestor: combined.some((folder) => isPrefix(path.resolve(folder), tmp)),
  };
}

function makeThrowawayCwd(kind) {
  if (kind === "nested") {
    const cwd = path.join(here, `_trust-cwd-${process.pid}-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    execSync("git init", { cwd, stdio: "ignore" });
    writeFileSync(path.join(cwd, "README.md"), "trust-gate probe\n");
    return cwd;
  }
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ade-copilot-trust-cwd-"));
  execSync("git init", { cwd, stdio: "ignore" });
  writeFileSync(path.join(cwd, "README.md"), "trust-gate probe\n");
  return cwd;
}

function readConfigOriginal(configPath) {
  try {
    return { existed: true, text: readFileSync(configPath, "utf8") };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { existed: false, text: null };
    }
    throw error;
  }
}

async function withSeededTrust(cwd, seedMode, fn) {
  const home = copilotHome();
  const configPath = path.join(home, "config.json");
  if (!seedMode) {
    const original = readConfigOriginal(configPath);
    const parsed = original.text ? parseJsonc(original.text) : {};
    return fn({ home, membership: trustMembership(parsed, cwd) });
  }
  const original = readConfigOriginal(configPath);
  let parsed = {};
  if (original.text) {
    parsed = parseJsonc(original.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${configPath} did not parse as a JSONC object`);
    }
  }
  parsed.trusted_folders = withoutPath(stringFolders(parsed.trusted_folders), cwd);
  parsed.trustedFolders = withoutPath(stringFolders(parsed.trustedFolders), cwd);
  if (seedMode === "snake") parsed.trusted_folders = [...parsed.trusted_folders, cwd];
  if (seedMode === "camel") parsed.trustedFolders = [...parsed.trustedFolders, cwd];
  if (parsed.trusted_folders.length === 0) delete parsed.trusted_folders;
  mkdirSync(home, { recursive: true });
  const commentHeader = original.text?.match(/^(?:\/\/.*\n)*/)?.[0] ?? "";
  writeFileSync(configPath, `${commentHeader}${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  const membership = trustMembership(parsed, cwd);
  try {
    return await fn({ home, membership });
  } finally {
    try {
      if (original.existed && original.text != null) {
        writeFileSync(configPath, original.text, "utf8");
      } else {
        rmSync(configPath, { force: true });
      }
    } catch (error) {
      process.stderr.write(
        `failed to restore ${configPath}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

async function runCase(spec) {
  const cwd = makeThrowawayCwd(spec.cwdKind ?? "tmp");
  try {
    return await withSeededTrust(cwd, spec.seedMode ?? false, async ({ home, membership }) => {
      const args = ["--acp"];
      if (spec.addDir) args.push("--add-dir", cwd);
      if (spec.disallowTempDir) args.push("--disallow-temp-dir");
      const env = { ...process.env, NO_COLOR: "1" };
      delete env.COPILOT_ALLOW_ALL;
      const client = new AcpClient({ args, cwd, env });
      const started = Date.now();
      const result = {
        run: spec.run,
        description: spec.description,
        addDir: spec.addDir,
        seedTrusted: Boolean(spec.seedMode),
        seedMode: spec.seedMode ?? false,
        disallowTempDir: Boolean(spec.disallowTempDir),
        cwdKind: spec.cwdKind ?? "tmp",
        cwd,
        copilotHome: home,
        args,
        membership,
        opened: false,
        deadlock: false,
        permissionCount: 0,
        permissions: [],
        wrote: null,
        stopReason: null,
        allowAll: null,
        configOptions: [],
        updateKinds: [],
        stderrTrustHint: false,
        error: null,
        elapsedMs: 0,
      };

      try {
        await client.request(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: CLIENT_INFO,
          },
          20_000,
        );
        try {
          await client.request("authenticate", { methodId: "copilot-login" }, 15_000);
        } catch (error) {
          result.authError = error instanceof Error ? error.message : String(error);
        }

        try {
          const created = await client.request("session/new", { cwd, mcpServers: [] }, SESSION_NEW_DEADLOCK_MS);
          result.opened = true;
          result.sessionId = created.sessionId;
          result.configOptions = summarizeConfigOptions(created.configOptions);
          result.allowAll = result.configOptions.find((option) => option.id === "allow_all")?.currentValue ?? null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.error = message;
          result.deadlock = /timed out/i.test(message) && client.exited == null;
          result.stderrTrustHint = /trust/i.test(client.stderrTail);
          result.stderrTail = client.stderrTail.slice(-1_200);
          result.stdoutNonProtocol = client.stdoutNonProtocol.slice(0, 8);
          result.alive = client.exited == null;
          return result;
        }

        const promptResult = await client.request(
          "session/prompt",
          { sessionId: result.sessionId, prompt: [{ type: "text", text: WRITE_PROMPT }] },
          PROMPT_MS,
        );
        result.stopReason = promptResult.stopReason ?? null;
        result.text = client.text().slice(0, 400);
        result.permissionCount = client.permissions.length;
        result.permissions = client.permissions;
        result.updateKinds = client.updates.map((entry) => entry.sessionUpdate ?? entry.method);
        result.toolCalls = client.updates
          .filter((entry) => entry.sessionUpdate === "tool_call" || entry.sessionUpdate === "tool_call_update")
          .map((entry) => ({ sessionUpdate: entry.sessionUpdate, kind: entry.toolKind, title: entry.title }));
        result.reverseRequestMethods = client.reverseRequests.map((entry) => entry.method);
        try {
          result.wrote = readFileSync(path.join(cwd, "acp-trust-write.txt"), "utf8");
        } catch {
          result.wrote = null;
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        result.permissionCount = client.permissions.length;
        result.permissions = client.permissions;
        result.updateKinds = client.updates.map((entry) => entry.sessionUpdate ?? entry.method);
        result.stderrTail = client.stderrTail.slice(-1_200);
      } finally {
        result.elapsedMs = Date.now() - started;
        client.dispose();
      }
      return result;
    });
  } finally {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // leave
    }
  }
}

async function main() {
  const report = {
    capturedAt: new Date().toISOString(),
    binary: "copilot",
    note: "C and B do not touch config.json. A writes JSONC with the original comment header preserved. Previous rewrites of config.json (auth/state file) made every prompt return No model available.",
    runs: [],
  };

  report.runs.push(
    await runCase({
      run: "C",
      description: "neither --add-dir nor trusted folder keys (tmp cwd)",
      addDir: false,
      seedMode: false,
      cwdKind: "tmp",
    }),
  );
  report.runs.push(
    await runCase({
      run: "A",
      description: "trusted_folders snake_case only, no --add-dir (tmp cwd)",
      addDir: false,
      seedMode: "snake",
      cwdKind: "tmp",
    }),
  );
  report.runs.push(
    await runCase({
      run: "A-camel",
      description: "trustedFolders camelCase only, no --add-dir (tmp cwd)",
      addDir: false,
      seedMode: "camel",
      cwdKind: "tmp",
    }),
  );
  report.runs.push(
    await runCase({
      run: "B",
      description: "--add-dir as today, cwd not in either trust key (tmp cwd)",
      addDir: true,
      seedMode: false,
      cwdKind: "tmp",
    }),
  );

  const c = report.runs.find((entry) => entry.run === "C");
  const modelWorked = Boolean(c?.opened) && !/no model available/i.test(c?.text ?? "");
  if (c?.opened && modelWorked) {
    report.note +=
      " Run C opened on a tmp cwd; repeating C/A/B on a nested independent git repo under fixtures so system-temp auto-access cannot explain the result.";
    report.runs.push(
      await runCase({
        run: "C-nested",
        description: "neither (nested git cwd under fixtures)",
        addDir: false,
        seedMode: false,
        cwdKind: "nested",
      }),
    );
    report.runs.push(
      await runCase({
        run: "A-nested",
        description: "trusted_folders snake_case only (nested git cwd)",
        addDir: false,
        seedMode: "snake",
        cwdKind: "nested",
      }),
    );
    report.runs.push(
      await runCase({
        run: "B-nested",
        description: "--add-dir (nested git cwd)",
        addDir: true,
        seedMode: false,
        cwdKind: "nested",
      }),
    );
  }

  writeFileSync(path.join(here, "copilot.trust-gate.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
