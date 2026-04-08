import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { resolveDesktopAdeMcpLaunch } from "./services/runtime/adeMcpLaunch";
import { resolveClaudeCodeExecutable, type ClaudeCodeExecutableResolution } from "./services/ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "./services/ai/codexExecutable";
import {
  classifyClaudeStartupFailure,
  type ClaudeStartupProbeResult,
} from "./packagedRuntimeSmokeShared";

const execFileAsync = promisify(execFile);
const PTY_PROBE_TIMEOUT_MS = 4_000;
const CLAUDE_PROBE_TIMEOUT_MS = 20_000;

async function probePty(): Promise<{ ok: true; output: string }> {
  const pty = await import("node-pty");
  return new Promise((resolve, reject) => {
    let output = "";
    const term = pty.spawn("/bin/sh", ["-lc", 'printf "ADE_PTY_OK\\n"'], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env },
    });

    const timeout = setTimeout(() => {
      try {
        term.kill();
      } catch {
        // ignore best-effort cleanup
      }
      reject(new Error("PTY probe timed out"));
    }, PTY_PROBE_TIMEOUT_MS);

    term.onData((chunk) => {
      output += chunk;
    });
    term.onExit((event) => {
      clearTimeout(timeout);
      if (!output.includes("ADE_PTY_OK")) {
        reject(new Error(`PTY probe exited without expected output (exit=${event.exitCode ?? "null"})`));
        return;
      }
      resolve({ ok: true, output });
    });
  });
}

async function probeClaudeStartup(
  claudeExecutable: ClaudeCodeExecutableResolution,
): Promise<ClaudeStartupProbeResult> {
  const claude = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CLAUDE_PROBE_TIMEOUT_MS);
  const stream = claude.query({
    prompt: "System initialization check. Respond with only the word READY.",
    options: {
      cwd: process.cwd(),
      permissionMode: "plan",
      tools: [],
      pathToClaudeCodeExecutable: claudeExecutable.path,
      abortController,
    },
  });

  try {
    for await (const message of stream) {
      if (message.type === "auth_status" && message.error) {
        return { state: "auth-failed", message: message.error };
      }
      if (message.type === "assistant" && message.error === "authentication_failed") {
        return { state: "auth-failed", message: "authentication_failed" };
      }
      if (message.type !== "result") continue;
      if (!message.is_error) {
        return { state: "ready", message: null };
      }
      const errors =
        "errors" in message && Array.isArray(message.errors)
          ? message.errors.filter(Boolean).join(" ")
          : "";
      return classifyClaudeStartupFailure(errors || "Claude startup probe returned an error result.", claudeExecutable.source);
    }

    return {
      state: "runtime-failed",
      message: "Claude startup probe completed without a terminal result.",
    };
  } catch (error) {
    return classifyClaudeStartupFailure(error, claudeExecutable.source);
  } finally {
    clearTimeout(timeout);
    try {
      stream.close();
    } catch {
      // ignore best-effort cleanup
    }
  }
}

async function probeMcpInitialize(args: {
  command: string;
  cmdArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  ok: boolean;
  response: unknown | null;
  stderr: string | null;
  error: string | null;
}> {
  // Keep this as a real MCP initialize round-trip instead of another cheap
  // "--probe" check. We regressed packaged chats by launching the proxy
  // successfully but routing chat MCP through the wrong path, which only
  // showed up once the client attempted the first initialize handshake.
  //
  // The proxy is a relay that connects to a Unix socket served by the ADE
  // desktop backend. In CI there is no backend, so we stand up a lightweight
  // mock MCP server on a short-path temp socket (macOS limits Unix socket
  // paths to 104 chars which packaged-app temp dirs typically exceed).
  // We must use async spawn (not spawnSync) so the event loop stays free
  // for the mock server to handle the proxy's connection.
  const sockPath = path.join(os.tmpdir(), `ade-smoke-${process.pid}.sock`);
  try { fs.unlinkSync(sockPath); } catch { /* ignore */ }

  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      try {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          conn.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "ade-mcp-server", version: "smoke-test" },
            },
          }) + "\n");
        }
      } catch { /* ignore malformed input */ }
      conn.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(sockPath, resolve));

  try {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "packaged-runtime-smoke", version: "1.0.0" },
        capabilities: {},
      },
    });

    const child = spawn(args.command, args.cmdArgs, {
      cwd: args.cwd,
      env: { ...args.env, ADE_MCP_SOCKET_PATH: sockPath },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin!.write(`${payload}\n`);
    child.stdin!.end();

    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const killTimer = setTimeout(() => { child.kill(); }, 5_000);
    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => { clearTimeout(killTimer); resolve(code ?? 1); });
    });

    stdout = stdout.trim();
    stderr = stderr.trim();

    try {
      return {
        ok: exitCode === 0,
        response: stdout ? JSON.parse(stdout) : null,
        stderr: stderr || null,
        error: null,
      };
    } catch (parseError) {
      return {
        ok: false,
        response: stdout || null,
        stderr: stderr || null,
        error: parseError instanceof Error ? parseError.message : String(parseError),
      };
    }
  } finally {
    server.close();
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
  }
}

async function main(): Promise<void> {
  const pty = await import("node-pty");
  const claude = await import("@anthropic-ai/claude-agent-sdk");
  const claudeExecutable = resolveClaudeCodeExecutable();
  const cwd = process.cwd();
  const launch = resolveDesktopAdeMcpLaunch({
    projectRoot: cwd,
    workspaceRoot: cwd,
  });
  const ptyProbe = await probePty();
  const claudeStartup = await probeClaudeStartup(claudeExecutable);

  const proxyProbe = await execFileAsync(launch.command, [...launch.cmdArgs, "--probe"], {
    cwd,
    env: {
      ...process.env,
      ...launch.env,
    },
  });

  const proxyProbeStdout = proxyProbe.stdout.trim();
  let proxyProbeResult: unknown = null;
  try {
    proxyProbeResult = proxyProbeStdout ? JSON.parse(proxyProbeStdout) : null;
  } catch {
    proxyProbeResult = proxyProbeStdout;
  }

  const proxyInitialize = await probeMcpInitialize({
    command: launch.command,
    cmdArgs: launch.cmdArgs,
    cwd,
    env: {
      ...process.env,
      ...launch.env,
    },
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    nodePty: typeof pty.spawn,
    claudeQuery: typeof claude.query,
    claudeExecutablePath: claudeExecutable.path,
    claudeExecutableSource: claudeExecutable.source,
    claudeStartup,
    codexExecutable: typeof resolveCodexExecutable,
    ptyProbe,
    launchMode: launch.mode,
    launchCommand: launch.command,
    launchEntryPath: launch.entryPath,
    launchSocketPath: launch.socketPath,
    proxyProbe: proxyProbeResult,
    proxyInitialize,
  }));
}

void main().catch((error) => {
  process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
