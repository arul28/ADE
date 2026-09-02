#!/usr/bin/env node
/**
 * Drive a real ACP binary over stdio and record what it actually speaks.
 *
 * This is verification, not a test harness: it talks to the installed CLI,
 * writes the initialize response as a fixture, and exercises session/new,
 * prompt, permission, cancel, and close. It never installs packages.
 *
 * Usage: node liveBinaryProbe.mjs [copilot|grok|all]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.ACP_LIVE_OUTPUT_DIR?.trim() || mkdtempSync(path.join(tmpdir(), "ade-acp-live-"));
mkdirSync(outputDir, { recursive: true });
const scratchDir = path.join(outputDir, "live-scratch");
mkdirSync(scratchDir, { recursive: true });

const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: "ade", title: "ADE", version: "1" };
const PING = "Reply with exactly the word ping and nothing else. Do not use tools. Do not read or write files.";
const WRITE_PROBE =
  "Create a file named acp-probe-write.txt in the current working directory containing only the word ping. Use a write tool. Do nothing else.";

export class AcpClient {
  constructor({ command, args, cwd, env, label }) {
    this.label = label;
    this.log = [];
    this.pending = new Map();
    this.nextId = 1;
    this.notifications = [];
    this.reverseRequests = [];
    this.permissionPolicy = "reject";
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
      const text = chunk.toString("utf8");
      this.stderrTail = `${this.stderrTail}${text}`.slice(-8_000);
      this.#note("stderr", text.slice(0, 1_000));
    });
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      this.#note("exit", { code, signal });
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(`${this.label} exited code=${code} signal=${signal}`));
      }
      this.pending.clear();
    });
    this.child.on("error", (error) => {
      this.#note("spawn-error", error.message);
    });
  }

  #note(kind, detail) {
    this.log.push({ t: Date.now(), kind, detail });
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
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      this.#note("stdout-non-protocol", trimmed.slice(0, 400));
      return;
    }
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      this.#note("stdout-unparsable", trimmed.slice(0, 400));
      return;
    }
    if (!frame || typeof frame !== "object") return;

    const id = frame.id;
    const method = typeof frame.method === "string" ? frame.method : null;

    if (method && id !== undefined && id !== null) {
      this.reverseRequests.push({ method, id, params: frame.params ?? null });
      this.#note("reverse-request", { method, id });
      if (method === "session/request_permission") {
        const outcome = this.#permissionOutcome(frame.params);
        this.#write({ jsonrpc: "2.0", id, result: { outcome } });
        this.#note("permission-answered", outcome);
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
      this.#note("notification", {
        method,
        sessionUpdate: frame.params?.update?.sessionUpdate ?? null,
      });
      return;
    }

    if (id === undefined || id === null) return;
    const waiter = this.pending.get(id);
    if (!waiter) {
      this.#note("orphan-response", { id });
      return;
    }
    this.pending.delete(id);
    if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message ?? "rpc error"), { rpc: frame.error }));
    else waiter.resolve(frame.result);
  }

  #permissionOutcome(params) {
    const options = Array.isArray(params?.options) ? params.options : [];
    if (this.permissionPolicy === "allow") {
      const allow = options.find((option) => option.kind === "allow_once") ?? options[0];
      return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
    }
    const reject = options.find((option) => option.kind === "reject_once")
      ?? options.find((option) => option.kind === "reject_always");
    return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
  }

  #write(frame) {
    if (!this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    return true;
  }

  request(method, params, timeoutMs = 20_000) {
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
      this.#note("request", { id, method });
      if (!this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`${this.label} stdin is not writable`));
      }
    });
  }

  notify(method, params) {
    this.#note("notify", { method });
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async initialize(extra = {}) {
    return this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: CLIENT_INFO,
      ...extra,
    }, 20_000);
  }

  dispose() {
    try {
      this.child.stdin?.end();
    } catch {
      // already gone
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 1_500).unref?.();
  }
}

export function errInfo(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    rpc: error?.rpc ?? null,
  };
}

export function summarizeCaps(init) {
  const caps = init?.agentCapabilities ?? {};
  return {
    protocolVersion: init?.protocolVersion ?? null,
    agentInfo: init?.agentInfo ?? null,
    authMethods: (init?.authMethods ?? []).map((method) => ({
      id: method.id,
      name: method.name,
      type: method.type ?? null,
    })),
    loadSession: caps.loadSession === true,
    prompt: caps.promptCapabilities ?? null,
    mcp: caps.mcpCapabilities ?? null,
    session: caps.sessionCapabilities ?? null,
    _meta: init?._meta ?? null,
  };
}

async function probeCopilot() {
  const report = { provider: "copilot", binary: "copilot", version: "1.0.82", steps: [] };
  const client = new AcpClient({
    command: "copilot",
    args: ["--acp", "--add-dir", scratchDir, "--no-auto-update"],
    cwd: scratchDir,
    env: { ...process.env, NO_COLOR: "1" },
    label: "copilot",
  });

  try {
    const init = await client.initialize();
    writeFileSync(path.join(here, "copilot.initialize.json"), `${JSON.stringify(init, null, 2)}\n`);
    report.steps.push({ step: "initialize", ok: true, caps: summarizeCaps(init) });

    const authMethods = init.authMethods ?? [];
    if (authMethods.length) {
      const methodId = authMethods[0].id;
      if (authMethods[0].type === "terminal") {
        report.steps.push({
          step: "authenticate",
          ok: false,
          skipped: true,
          reason: "terminal login method advertised — treating as not signed in over ACP",
          methodId,
        });
      } else {
        try {
          const auth = await client.request("authenticate", { methodId }, 15_000);
          report.steps.push({ step: "authenticate", ok: true, methodId, result: auth ?? null });
        } catch (error) {
          report.steps.push({ step: "authenticate", ok: false, methodId, ...errInfo(error) });
        }
      }
    } else {
      report.steps.push({ step: "authenticate", ok: true, skipped: true, reason: "no authMethods advertised" });
    }

    const created = await client.request("session/new", { cwd: scratchDir, mcpServers: [] }, 45_000);
    report.steps.push({ step: "session/new", ok: true, sessionId: created.sessionId, modes: created.modes ?? null });
    const sessionId = created.sessionId;

    client.permissionPolicy = "reject";
    try {
      const prompt = await client.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: PING }] },
        90_000,
      );
      const textChunks = client.notifications
        .filter((entry) => entry.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((entry) => entry.params.update.content?.text ?? "")
        .join("");
      report.steps.push({
        step: "session/prompt ping",
        ok: true,
        stopReason: prompt.stopReason ?? null,
        usage: prompt.usage ?? null,
        _meta: prompt._meta ?? null,
        text: textChunks.slice(0, 400),
        permissions: client.reverseRequests.filter((entry) => entry.method === "session/request_permission").length,
      });
    } catch (error) {
      report.steps.push({ step: "session/prompt ping", ok: false, ...errInfo(error) });
    }

    const cancelSession = await client.request("session/new", { cwd: scratchDir, mcpServers: [] }, 45_000);
    const cancelId = cancelSession.sessionId;
    const promptPromise = client.request(
      "session/prompt",
      {
        sessionId: cancelId,
        prompt: [{ type: "text", text: "Count slowly from 1 to 200 in words. Do not use tools." }],
      },
      90_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    let cancelAsRequest = null;
    try {
      cancelAsRequest = await client.request("session/cancel", { sessionId: cancelId }, 10_000);
    } catch (error) {
      cancelAsRequest = { error: errInfo(error) };
    }
    let promptAfterCancel = null;
    try {
      promptAfterCancel = await promptPromise;
    } catch (error) {
      promptAfterCancel = { error: errInfo(error) };
    }
    report.steps.push({
      step: "cancel-during-prompt",
      ok: true,
      cancelAsRequest,
      promptResult: promptAfterCancel,
      note: "Copilot is known to report stopReason end_turn after cancel (github/copilot-cli#4561)",
    });

    try {
      await client.request("session/close", { sessionId }, 10_000);
      report.steps.push({ step: "session/close", ok: true });
    } catch (error) {
      report.steps.push({ step: "session/close", ok: false, ...errInfo(error) });
    }
    try {
      await client.request("session/close", { sessionId: cancelId }, 10_000);
    } catch {
      // best effort
    }
  } catch (error) {
    report.steps.push({ step: "fatal", ok: false, ...errInfo(error), stderrTail: client.stderrTail.slice(-1_500) });
  } finally {
    client.dispose();
    report.stderrTail = client.stderrTail.slice(-1_500);
    report.notificationsSample = client.notifications.slice(0, 30).map((entry) => ({
      method: entry.method,
      sessionUpdate: entry.params?.update?.sessionUpdate ?? null,
    }));
    report.permissionRequests = client.reverseRequests
      .filter((entry) => entry.method === "session/request_permission")
      .map((entry) => ({
        tool: entry.params?.toolCall?.title ?? entry.params?.toolCall?.kind ?? null,
        options: (entry.params?.options ?? []).map((option) => ({ id: option.optionId, kind: option.kind, name: option.name })),
      }));
  }
  return report;
}

async function probeGrok() {
  const report = { provider: "grok", binary: "grok", version: "1.0.13", steps: [] };
  const client = new AcpClient({
    command: "grok",
    args: ["--no-auto-update", "--no-plan", "agent", "--no-leader", "stdio"],
    cwd: scratchDir,
    env: { ...process.env, NO_COLOR: "1" },
    label: "grok",
  });

  try {
    const init = await client.initialize({ _meta: { clientIdentifier: "ade" } });
    writeFileSync(path.join(here, "grok.initialize.json"), `${JSON.stringify(init, null, 2)}\n`);
    report.steps.push({ step: "initialize", ok: true, caps: summarizeCaps(init) });

    const created = await client.request("session/new", { cwd: scratchDir, mcpServers: [] }, 45_000);
    report.steps.push({ step: "session/new", ok: true, sessionId: created.sessionId, modes: created.modes ?? null });
    const sessionId = created.sessionId;

    client.notify("x.ai/yolo_mode_changed", { sessionId, auto_mode: false, permission_mode: "ask" });
    report.steps.push({ step: "yolo_mode_changed", ok: true, sentAfterSessionNew: true });

    try {
      const asRequest = await client.request("session/cancel", { sessionId }, 8_000);
      report.steps.push({
        step: "cancel-as-request",
        ok: false,
        unexpectedSuccess: asRequest,
        expected: "-32601 method not found",
      });
    } catch (error) {
      const code = error?.rpc?.code ?? null;
      report.steps.push({
        step: "cancel-as-request",
        ok: code === -32601,
        expectedCode: -32601,
        ...errInfo(error),
      });
    }

    client.permissionPolicy = "reject";
    try {
      const prompt = await client.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: PING }] },
        90_000,
      );
      const textChunks = client.notifications
        .filter((entry) => entry.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((entry) => entry.params.update.content?.text ?? "")
        .join("");
      report.steps.push({
        step: "session/prompt ping",
        ok: true,
        stopReason: prompt.stopReason ?? null,
        usage: prompt.usage ?? null,
        _meta: prompt._meta ?? null,
        text: textChunks.slice(0, 400),
      });
    } catch (error) {
      report.steps.push({ step: "session/prompt ping", ok: false, ...errInfo(error) });
    }

    const permBefore = client.reverseRequests.filter((entry) => entry.method === "session/request_permission").length;
    try {
      const writePrompt = await client.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: WRITE_PROBE }] },
        90_000,
      );
      const permAfter = client.reverseRequests.filter((entry) => entry.method === "session/request_permission").length;
      report.steps.push({
        step: "permission-write-probe",
        ok: true,
        stopReason: writePrompt.stopReason ?? null,
        permissionRequests: permAfter - permBefore,
        permissionOptionIds: client.reverseRequests
          .filter((entry) => entry.method === "session/request_permission")
          .flatMap((entry) => (entry.params?.options ?? []).map((option) => option.optionId)),
        note: "A zero here with a written file means Grok auto-allowed (Claude defaultMode leak). A request means permissions prompted.",
      });
    } catch (error) {
      const permAfter = client.reverseRequests.filter((entry) => entry.method === "session/request_permission").length;
      report.steps.push({
        step: "permission-write-probe",
        ok: false,
        permissionRequests: permAfter - permBefore,
        ...errInfo(error),
      });
    }

    const cancelSession = await client.request("session/new", { cwd: scratchDir, mcpServers: [] }, 45_000);
    const cancelId = cancelSession.sessionId;
    client.notify("x.ai/yolo_mode_changed", { sessionId: cancelId, auto_mode: false, permission_mode: "ask" });
    const promptPromise = client.request(
      "session/prompt",
      {
        sessionId: cancelId,
        prompt: [{ type: "text", text: "Count slowly from 1 to 200 in words. Do not use tools." }],
      },
      90_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    client.notify("session/cancel", { sessionId: cancelId });
    let promptAfterCancel = null;
    try {
      promptAfterCancel = await promptPromise;
    } catch (error) {
      promptAfterCancel = { error: errInfo(error) };
    }
    report.steps.push({
      step: "cancel-as-notification",
      ok: true,
      promptResult: promptAfterCancel,
    });

    try {
      await client.request("session/close", { sessionId }, 10_000);
      report.steps.push({ step: "session/close", ok: true });
    } catch (error) {
      report.steps.push({ step: "session/close", ok: false, ...errInfo(error) });
    }
    try {
      await client.request("session/close", { sessionId: cancelId }, 10_000);
    } catch {
      // best effort
    }
  } catch (error) {
    report.steps.push({ step: "fatal", ok: false, ...errInfo(error), stderrTail: client.stderrTail.slice(-1_500) });
  } finally {
    client.dispose();
    report.stderrTail = client.stderrTail.slice(-1_500);
    report.spinnerHints = client.notifications.filter((entry) => entry.method === "x.ai/session_notification").length;
    report.permissionRequests = client.reverseRequests
      .filter((entry) => entry.method === "session/request_permission")
      .map((entry) => ({
        tool: entry.params?.toolCall?.title ?? entry.params?.toolCall?.kind ?? null,
        options: (entry.params?.options ?? []).map((option) => ({ id: option.optionId, kind: option.kind, name: option.name })),
      }));
  }
  return report;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const target = process.argv[2] ?? "all";
  const reports = {};
  if (target === "all" || target === "copilot") {
    process.stderr.write("probing copilot...\n");
    reports.copilot = await probeCopilot();
  }
  if (target === "all" || target === "grok") {
    process.stderr.write("probing grok...\n");
    reports.grok = await probeGrok();
  }
  writeFileSync(path.join(outputDir, "live-probe-report.json"), `${JSON.stringify(reports, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  const failed = Object.values(reports).some((report) => report.steps.some((step) => step.step === "fatal"));
  process.exit(failed ? 1 : 0);
}
