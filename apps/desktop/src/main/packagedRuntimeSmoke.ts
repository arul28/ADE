import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { resolveDesktopAdeMcpLaunch } from "./services/runtime/adeMcpLaunch";
import { resolveClaudeCodeExecutable, type ClaudeCodeExecutableResolution } from "./services/ai/claudeCodeExecutable";
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

function probeMcpInitialize(args: {
  command: string;
  cmdArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): {
  ok: boolean;
  response: unknown | null;
  stderr: string | null;
  error: string | null;
} {
  // Keep this as a real MCP initialize round-trip instead of another cheap
  // "--probe" check. We regressed packaged chats by launching the proxy
  // successfully but routing chat MCP through the wrong path, which only
  // showed up once the client attempted the first initialize handshake.
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: {
        name: "packaged-runtime-smoke",
        version: "1.0.0",
      },
      capabilities: {},
    },
  });

  const result = spawnSync(args.command, args.cmdArgs, {
    cwd: args.cwd,
    env: args.env,
    input: `${payload}\n`,
    encoding: "utf8",
    timeout: 5_000,
  });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const error = result.error ? String(result.error.message ?? result.error) : null;

  try {
    return {
      ok: result.status === 0,
      response: stdout ? JSON.parse(stdout) : null,
      stderr: stderr || null,
      error,
    };
  } catch (parseError) {
    return {
      ok: false,
      response: stdout || null,
      stderr: stderr || null,
      error: parseError instanceof Error ? parseError.message : String(parseError),
    };
  }
}

async function main(): Promise<void> {
  const pty = await import("node-pty");
  const claude = await import("@anthropic-ai/claude-agent-sdk");
  const claudeExecutable = resolveClaudeCodeExecutable();
  const packagedPackageJson = typeof process.resourcesPath === "string" && process.resourcesPath.length > 0
    ? path.join(process.resourcesPath, "app.asar", "package.json")
    : "";
  const runtimeRequire = createRequire(fs.existsSync(packagedPackageJson) ? packagedPackageJson : __filename);
  const codexProvider = runtimeRequire("ai-sdk-provider-codex-cli") as Record<string, unknown>;
  const codexFactory = (codexProvider.createCodexCli ?? codexProvider.createCodexCLI) as unknown;
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

  const proxyInitialize = probeMcpInitialize({
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
    codexFactory: typeof codexFactory,
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
